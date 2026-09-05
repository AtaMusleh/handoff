/**
 * Handoff REST routes.
 *
 *   POST /tasks/:id/transfer     propose a handoff
 *   GET  /tasks/:id/handoffs     transfer history for a task
 *   GET  /handoffs/:id           status, plus the AI brief when ready
 *   POST /handoffs/:id/accept    recipient takes ownership
 *   POST /handoffs/:id/decline   recipient refuses; task stays put
 *
 * Transfer and accept each touch two aggregates, so both run inside one
 * transaction via `inUnitOfWork`: a task can never be left TRANSFERRED with no
 * handoff row, nor a handoff ACCEPTED without ownership actually moving.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { HandoffAggregate, HandoffStatus } from '@handoff/domain';
import {
  HandoffBriefRepository,
  HandoffRepository,
  NotFoundError,
  inUnitOfWork,
  type PoolLike,
} from '../repositories/EventStore';
import {
  ApiErrorCode,
  HttpError,
  asyncHandler,
  requireActor,
  sendData,
  serializeTask,
  type HandoffDetailResponse,
} from '../http/api';

// =============================================================================
// Schemas
// =============================================================================

const uuid = z.uuid({ message: 'Must be a UUID.' });

export const transferSchema = z.object({
  toUserId: uuid,
  reason: z.string().trim().min(1).max(2000).nullish(),
  /** Echoed from a prior task response; rejects a stale client view. */
  expectedVersion: z.number().int().nonnegative().optional(),
});

export const acceptHandoffSchema = z.object({
  userId: uuid,
  note: z.string().trim().min(1).max(2000).optional(),
});

export const declineHandoffSchema = z.object({
  userId: uuid,
  reason: z.string().trim().min(1).max(2000).optional(),
});

export const handoffIdParamSchema = z.object({ id: uuid });
export const taskIdParamSchema = z.object({ id: uuid });

export type TransferBody = z.infer<typeof transferSchema>;
export type DeclineHandoffBody = z.infer<typeof declineHandoffSchema>;

// =============================================================================
// Router
// =============================================================================

export interface HandoffRouterDeps {
  pool: PoolLike;
  handoffs?: HandoffRepository;
  briefs?: HandoffBriefRepository;
}

/**
 * Handoff endpoints.
 *
 * ```ts
 * app.use('/api', new HandoffRouter({ pool }).router);
 * ```
 */
export class HandoffRouter {
  readonly router: Router;
  private readonly pool: PoolLike;
  private readonly handoffs: HandoffRepository;
  private readonly briefs: HandoffBriefRepository;

  constructor(deps: HandoffRouterDeps) {
    this.pool = deps.pool;
    this.handoffs = deps.handoffs ?? new HandoffRepository(deps.pool);
    this.briefs = deps.briefs ?? new HandoffBriefRepository(deps.pool);
    this.router = Router();
    this.mount();
  }

  private mount(): void {
    const r = this.router;
    r.post('/tasks/:id/transfer', asyncHandler(this.transfer));
    r.get('/tasks/:id/handoffs', asyncHandler(this.listForTask));
    r.get('/handoffs/:id', asyncHandler(this.detail));
    r.post('/handoffs/:id/accept', asyncHandler(this.accept));
    r.post('/handoffs/:id/decline', asyncHandler(this.decline));
  }

  // --- writes ---------------------------------------------------------------

  /**
   * Propose a handoff.
   *
   * Marks the task TRANSFERRED and records the proposal atomically. Ownership
   * does not move here — it moves when the recipient accepts, so a declined
   * proposal still leaves the work with someone.
   */
  private readonly transfer = async (req: Request, res: Response) => {
    const actor = requireActor(req);
    const { id: taskId } = taskIdParamSchema.parse(req.params);
    const body = transferSchema.parse(req.body);

    const result = await inUnitOfWork(this.pool, async ({ tasks, handoffs }) => {
      const task = await tasks.requireById(taskId);

      if (body.expectedVersion !== undefined && task.state.version !== body.expectedVersion) {
        throw new HttpError(
          409,
          ApiErrorCode.CONFLICT,
          `Task ${taskId} has moved on: expected version ${body.expectedVersion}, ` +
            `found ${task.state.version}. Reload the task and retry.`,
          { expectedVersion: body.expectedVersion, actualVersion: task.state.version },
        );
      }

      // One open proposal at a time. The partial unique index enforces this too,
      // but catching it here yields a far clearer message than a 23505.
      const open = await handoffs.getPendingByTask(taskId);
      if (open) {
        throw new HttpError(
          409,
          ApiErrorCode.CONFLICT,
          `Task ${taskId} already has a pending handoff to ${open.state.toUserId}. ` +
            'It must be accepted or declined first.',
          { pendingHandoffId: open.state.id },
        );
      }

      const reason = body.reason ?? null;
      const handoff = HandoffAggregate.initiate(
        taskId,
        task.state.ownerId,
        body.toUserId,
        reason,
      );

      // Pass the handoff id so the TaskTransferred event points at the row.
      const transferred = task.transfer(body.toUserId, reason, actor, handoff.state.id);

      const savedTask = await tasks.saveAndReturn(transferred);
      await handoffs.save(handoff);

      return { handoff: handoff.state, task: savedTask };
    });

    res.setHeader('Location', `/handoffs/${result.handoff.id}`);
    sendData(res, 201, {
      handoff: result.handoff,
      task: serializeTask(result.task),
    });
  };

  /**
   * Recipient accepts: the handoff is resolved and ownership moves to them, in
   * one transaction.
   */
  private readonly accept = async (req: Request, res: Response) => {
    const actor = requireActor(req);
    const { id: handoffId } = handoffIdParamSchema.parse(req.params);
    const body = acceptHandoffSchema.parse(req.body);

    assertActingAsSelf(actor.userId, body.userId, actor.isAdmin);

    const result = await inUnitOfWork(this.pool, async ({ tasks, handoffs }) => {
      const handoff = await requireHandoff(handoffs, handoffId);

      const outcome = handoff.accept(body.userId, { note: body.note });
      if (!outcome.success) throw handoffFailure(outcome.error, outcome.code);

      await handoffs.save(handoff);

      // TRANSFERRED -> ASSIGNED. The matrix permits a non-owner here, which is
      // exactly the recipient taking over.
      const task = await tasks.requireById(handoff.state.taskId);
      const assigned = await tasks.saveAndReturn(
        task.assign(body.userId, { userId: body.userId, isAdmin: actor.isAdmin }),
      );

      return { handoff: handoff.state, task: assigned };
    });

    sendData(res, 200, {
      handoff: result.handoff,
      task: serializeTask(result.task),
    });
  };

  /**
   * Recipient declines. The task stays TRANSFERRED with its previous owner; the
   * sender is expected to reassign or propose to someone else.
   */
  private readonly decline = async (req: Request, res: Response) => {
    const actor = requireActor(req);
    const { id: handoffId } = handoffIdParamSchema.parse(req.params);
    const body = declineHandoffSchema.parse(req.body);

    assertActingAsSelf(actor.userId, body.userId, actor.isAdmin);

    const handoff = await requireHandoff(this.handoffs, handoffId);
    const outcome = handoff.decline(body.userId, { note: body.reason });
    if (!outcome.success) throw handoffFailure(outcome.error, outcome.code);

    await this.handoffs.save(handoff);
    sendData(res, 200, handoff.state);
  };

  // --- reads ----------------------------------------------------------------

  /** Status plus the AI brief, which is null until the worker produces one. */
  private readonly detail = async (req: Request, res: Response) => {
    requireActor(req);
    const { id } = handoffIdParamSchema.parse(req.params);

    const handoff = await requireHandoff(this.handoffs, id);
    const brief = await this.briefs.getByHandoffId(id);

    const body: HandoffDetailResponse = { ...handoff.state, brief };
    sendData(res, 200, body, { briefReady: brief !== null });
  };

  private readonly listForTask = async (req: Request, res: Response) => {
    requireActor(req);
    const { id: taskId } = taskIdParamSchema.parse(req.params);

    const found = await this.handoffs.listByTask(taskId);
    sendData(
      res,
      200,
      found.map((h) => h.state),
      {
        count: found.length,
        pendingCount: found.filter((h) => h.getStatus() === HandoffStatus.PENDING)
          .length,
      },
    );
  };
}

// =============================================================================
// Helpers
// =============================================================================

async function requireHandoff(
  repo: HandoffRepository,
  handoffId: string,
): Promise<HandoffAggregate> {
  const found = await repo.getById(handoffId);
  if (!found) throw new NotFoundError('Handoff', handoffId);
  return found;
}

/**
 * A caller may only accept or decline on their own behalf.
 *
 * The aggregate also checks that `userId` is the intended recipient; this guard
 * is about the *authenticated* user not acting for someone else.
 */
function assertActingAsSelf(
  actorId: string,
  bodyUserId: string,
  isAdmin?: boolean,
): void {
  if (isAdmin || actorId === bodyUserId) return;
  throw new HttpError(
    403,
    ApiErrorCode.FORBIDDEN,
    'You may only accept or decline a handoff addressed to you.',
  );
}

/**
 * Turn a {@link HandoffActionResult} failure into the right HTTP error.
 *
 * The aggregate reports a wrong recipient as a permission problem (403) and an
 * already-resolved handoff as an invalid transition (409 — it is a conflict
 * with the row's current state, not a malformed request).
 */
function handoffFailure(message: string | undefined, code: string | undefined): HttpError {
  if (code === 'PERMISSION_DENIED') {
    return new HttpError(
      403,
      ApiErrorCode.FORBIDDEN,
      message ?? 'You may not resolve this handoff.',
    );
  }
  return new HttpError(
    409,
    ApiErrorCode.CONFLICT,
    message ?? 'This handoff has already been resolved.',
  );
}

/** Convenience factory mirroring the usual Express idiom. */
export function createHandoffRouter(deps: HandoffRouterDeps): Router {
  return new HandoffRouter(deps).router;
}
