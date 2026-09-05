/**
 * Task REST routes.
 *
 *   POST   /tasks                 create
 *   GET    /tasks                 list (?ownerId= &status= &projectId=)
 *   GET    /tasks/:id             detail, with the current event stream
 *   GET    /tasks/:id/history     paged event timeline (?limit= &cursor=)
 *   POST   /tasks/:id/start       ASSIGNED     -> IN_PROGRESS
 *   POST   /tasks/:id/complete    IN_PROGRESS  -> COMPLETED
 *   POST   /tasks/:id/block       IN_PROGRESS  -> BLOCKED
 *   POST   /tasks/:id/unblock     BLOCKED      -> IN_PROGRESS
 *
 * Every mutation goes through the aggregate, so the transition matrix and the
 * permission rules are enforced in exactly one place. Routes never touch status
 * directly.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  TaskAggregate,
  TaskStatus,
  type UUID,
} from '@handoff/domain';
import {
  EventStore,
  TaskRepository,
  type PoolLike,
} from '../repositories/EventStore';
import {
  ApiErrorCode,
  HttpError,
  asyncHandler,
  requireActor,
  sendData,
  serializeTask,
  type AuthenticatedUser,
  type TaskResponse,
} from '../http/api';

// =============================================================================
// Schemas
// =============================================================================

const uuid = z.uuid({ message: 'Must be a UUID.' });

/**
 * Optimistic-locking token. Clients echo the `version` from a prior task
 * response; the request is rejected if the task has moved on since.
 */
const expectedVersion = z
  .number()
  .int()
  .nonnegative()
  .optional();

export const createTaskSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title must not be empty.')
    .max(500, 'Title must be at most 500 characters.'),
  projectId: uuid,
  ownerId: uuid.optional(),
  /** ISO-8601 instant. Null or omitted means no deadline. */
  dueDate: z.iso.datetime({ offset: true }).nullish(),
});

export const blockTaskSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'A reason is required to block a task.')
    .max(2000),
  blockedByTaskIds: z.array(uuid).max(50).optional(),
  expectedVersion,
});

export const unblockTaskSchema = z.object({
  resolution: z.string().trim().min(1).max(2000).optional(),
  expectedVersion,
});

export const completeTaskSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  expectedVersion,
});

export const startTaskSchema = z.object({ expectedVersion });

export const listTasksQuerySchema = z
  .object({
    ownerId: uuid.optional(),
    projectId: uuid.optional(),
    status: z.enum(TaskStatus).optional(),
  })
  .refine((q) => q.ownerId !== undefined || q.projectId !== undefined, {
    message: 'Provide at least one of ownerId or projectId.',
  });

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque to clients; the sequence number of the last event already seen. */
  cursor: z.coerce.number().int().nonnegative().default(0),
});

export const taskIdParamSchema = z.object({ id: uuid });

export type CreateTaskBody = z.infer<typeof createTaskSchema>;
export type BlockTaskBody = z.infer<typeof blockTaskSchema>;

// =============================================================================
// Router
// =============================================================================

/** Collaborators the router needs. Injected so routes are testable. */
export interface TaskRouterDeps {
  pool: PoolLike;
  tasks?: TaskRepository;
  events?: EventStore;
}

/**
 * Task endpoints.
 *
 * ```ts
 * app.use('/api', new TaskRouter({ pool }).router);
 * ```
 */
export class TaskRouter {
  readonly router: Router;
  private readonly tasks: TaskRepository;
  private readonly events: EventStore;

  constructor(deps: TaskRouterDeps) {
    this.tasks = deps.tasks ?? new TaskRepository(deps.pool);
    this.events = deps.events ?? new EventStore(deps.pool);
    this.router = Router();
    this.mount();
  }

  private mount(): void {
    const r = this.router;
    r.post('/tasks', asyncHandler(this.create));
    r.get('/tasks', asyncHandler(this.list));
    // Static sub-paths are declared before ':id' so they cannot be shadowed.
    r.get('/tasks/:id/history', asyncHandler(this.history));
    r.get('/tasks/:id', asyncHandler(this.detail));
    r.post('/tasks/:id/start', asyncHandler(this.start));
    r.post('/tasks/:id/complete', asyncHandler(this.complete));
    r.post('/tasks/:id/block', asyncHandler(this.block));
    r.post('/tasks/:id/unblock', asyncHandler(this.unblock));
  }

  // --- reads ----------------------------------------------------------------

  private readonly create = async (req: Request, res: Response) => {
    const actor = requireActor(req);
    const body = createTaskSchema.parse(req.body);

    const aggregate = TaskAggregate.create(body.title, body.projectId, {
      ownerId: body.ownerId ?? null,
      dueDate: body.dueDate ?? null,
      actorId: actor.userId,
    });

    const saved = await this.tasks.saveAndReturn(aggregate);
    res.setHeader('Location', `/tasks/${saved.state.id}`);
    sendData<TaskResponse>(res, 201, serializeTask(saved));
  };

  private readonly list = async (req: Request, res: Response) => {
    requireActor(req);
    const query = listTasksQuerySchema.parse(req.query);

    // getByOwner is the only indexed access path the repository exposes today.
    // A projectId-only filter would need a repository method backed by
    // tasks_project_id_status_created_at_idx; reject it rather than scanning.
    if (!query.ownerId) {
      throw new HttpError(
        400,
        ApiErrorCode.VALIDATION_FAILED,
        'Listing by projectId alone is not supported yet; include ownerId.',
      );
    }

    const found = await this.tasks.getByOwner(query.ownerId, query.status);
    const filtered = query.projectId
      ? found.filter((t) => t.state.projectId === query.projectId)
      : found;

    sendData<TaskResponse[]>(res, 200, filtered.map(serializeTask), {
      count: filtered.length,
    });
  };

  private readonly detail = async (req: Request, res: Response) => {
    requireActor(req);
    const { id } = taskIdParamSchema.parse(req.params);

    const aggregate = await this.tasks.requireById(id);
    const events = await this.events.getEvents(id);

    sendData(res, 200, { task: serializeTask(aggregate), events });
  };

  private readonly history = async (req: Request, res: Response) => {
    requireActor(req);
    const { id } = taskIdParamSchema.parse(req.params);
    const { limit, cursor } = historyQuerySchema.parse(req.query);

    // Distinguish "no events yet" from "no such task" — getEventsPage cannot.
    const exists = await this.tasks.getById(id);
    if (!exists) {
      throw new HttpError(404, ApiErrorCode.NOT_FOUND, `Task ${id} was not found.`);
    }

    const page = await this.events.getEventsPage(id, cursor, limit);
    sendData(res, 200, page.events, {
      count: page.events.length,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  };

  // --- transitions ----------------------------------------------------------

  private readonly start = async (req: Request, res: Response) => {
    const { expectedVersion: v } = startTaskSchema.parse(req.body ?? {});
    await this.transition(req, res, v, (task, actor) => task.start(actor));
  };

  private readonly complete = async (req: Request, res: Response) => {
    const body = completeTaskSchema.parse(req.body ?? {});
    await this.transition(req, res, body.expectedVersion, (task, actor) =>
      task.complete(body.note, actor),
    );
  };

  private readonly block = async (req: Request, res: Response) => {
    const body = blockTaskSchema.parse(req.body);
    await this.transition(req, res, body.expectedVersion, (task, actor) =>
      task.block(body.reason, actor, body.blockedByTaskIds),
    );
  };

  private readonly unblock = async (req: Request, res: Response) => {
    const body = unblockTaskSchema.parse(req.body ?? {});
    await this.transition(req, res, body.expectedVersion, (task, actor) =>
      task.unblock(body.resolution, actor),
    );
  };

  /**
   * Shared body for every transition endpoint: load, check the caller's
   * expected version, apply the domain operation, save.
   *
   * The `expectedVersion` check is a fast fail with a clear message; the
   * authoritative guard is the conditional UPDATE inside `save`, which raises
   * {@link ConcurrencyError} (409) if the row moved in between.
   */
  private async transition(
    req: Request,
    res: Response,
    expected: number | undefined,
    apply: (task: TaskAggregate, actor: AuthenticatedUser) => TaskAggregate,
  ): Promise<void> {
    const actor = requireActor(req);
    const { id } = taskIdParamSchema.parse(req.params);

    const task = await this.tasks.requireById(id);
    assertExpectedVersion(task, id, expected);

    const saved = await this.tasks.saveAndReturn(apply(task, actor));
    sendData<TaskResponse>(res, 200, serializeTask(saved));
  }
}

/** Throw 409 when the client's view of the task is already stale. */
function assertExpectedVersion(
  task: TaskAggregate,
  id: UUID,
  expected: number | undefined,
): void {
  if (expected === undefined || task.state.version === expected) return;
  throw new HttpError(
    409,
    ApiErrorCode.CONFLICT,
    `Task ${id} has moved on: expected version ${expected}, found ${task.state.version}. ` +
      'Reload the task and retry.',
    { expectedVersion: expected, actualVersion: task.state.version },
  );
}

/** Convenience factory mirroring the usual Express idiom. */
export function createTaskRouter(deps: TaskRouterDeps): Router {
  return new TaskRouter(deps).router;
}
