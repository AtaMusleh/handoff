/**
 * Handoff domain logic: the task lifecycle state machine and the aggregates
 * that drive it.
 *
 * Design rules this file follows:
 *
 *   * The transition matrix is the single source of truth for what may happen
 *     to a task. Nothing else hard-codes a status comparison.
 *   * Every accepted transition emits exactly one {@link NewTaskEvent}, so the
 *     current status is always reconstructible from the stream in
 *     `task_events`. Aggregates never mutate status without an event.
 *   * {@link TaskAggregate} is immutable: each operation returns a new instance
 *     carrying an incremented `version` and the events it produced.
 */

import {
  EventType,
  HandoffStatus,
  TaskStatus,
  isTerminalStatus,
  type Handoff,
  type ISODateTime,
  type NewTaskEvent,
  type Task,
  type UUID,
} from './types';

export { TaskStatus, EventType, HandoffStatus };

// =============================================================================
// Errors
// =============================================================================

/** Machine-readable discriminant carried by every {@link DomainError}. */
export enum DomainErrorCode {
  INVALID_TRANSITION = 'INVALID_TRANSITION',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
}

/** Base class for every error this domain raises deliberately. */
export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Required for `instanceof` to survive compilation to ES5/ES2015 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A status change that the transition matrix does not permit. */
export class InvalidTransitionError extends DomainError {
  readonly code = DomainErrorCode.INVALID_TRANSITION;

  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
    detail?: string,
  ) {
    super(
      detail ??
        `Cannot transition task from ${from} to ${to}. Valid next states: ` +
          `${TransitionMatrix.default.nextStates(from).join(', ') || '(none)'}.`,
    );
  }
}

/** The actor is not allowed to perform this operation on this task. */
export class PermissionError extends DomainError {
  readonly code = DomainErrorCode.PERMISSION_DENIED;

  constructor(
    message: string,
    readonly actorId?: UUID,
  ) {
    super(message);
  }
}

/** Input failed a domain rule (missing reason, blank title, self-handoff...). */
export class ValidationError extends DomainError {
  readonly code = DomainErrorCode.VALIDATION_FAILED;

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

// =============================================================================
// Shared shapes
// =============================================================================

/** Who is attempting an operation. */
export interface ActorRef {
  userId: UUID;
  /** Admins bypass the ownership check; they never bypass the matrix. */
  isAdmin?: boolean;
}

/**
 * Everything {@link StateMachine.validateTransition} needs about the actor and
 * the task they are acting on.
 */
export interface TransitionActor extends ActorRef {
  /**
   * Current owner of the task. Omit to skip ownership checks entirely (system
   * or already-authorized callers); pass `null` for an unowned backlog task.
   */
  ownerId?: UUID | null;
}

/** Result of a non-throwing validation. */
export interface TransitionValidation {
  valid: boolean;
  error?: string;
  /** Present whenever `valid` is false; lets callers branch without parsing. */
  code?: DomainErrorCode;
}

/** Result of accepting or declining a handoff. */
export interface HandoffActionResult {
  success: boolean;
  error?: string;
  code?: DomainErrorCode;
}

const VALID: TransitionValidation = Object.freeze({ valid: true });

function invalid(
  code: DomainErrorCode,
  error: string,
): TransitionValidation {
  return { valid: false, code, error };
}

// =============================================================================
// Transition matrix
// =============================================================================

/**
 * One edge of the lifecycle graph, with the rules that guard it.
 */
export interface TransitionRule {
  from: TaskStatus;
  to: TaskStatus;
  /** Event appended to the stream when this edge is taken. */
  event: EventType;
  /** The transition is rejected without a non-blank reason. */
  requiresReason?: boolean;
  /** The task must have an owner *after* the transition. */
  requiresOwner?: boolean;
  /**
   * Skip the "actor must be the current owner" check. Used for edges where the
   * acting user is by definition not the current owner: claiming an unowned
   * backlog task, and a handoff recipient taking over a TRANSFERRED task.
   */
  allowsNonOwner?: boolean;
  /** Human-readable name, used in error messages and UI affordances. */
  label: string;
}

/**
 * The task lifecycle graph.
 *
 * ```
 *   BACKLOG ──assign──> ASSIGNED ──start──> IN_PROGRESS ──complete──> COMPLETED
 *      ^                  │  │                 │   ^                     │
 *      └──unassign────────┘  │                 │   └──unblock── BLOCKED  │
 *                            │                 └──block───────────^      │
 *                            │                 │                         │
 *                            v                 v                         │
 *                        TRANSFERRED <─transfer┘                         │
 *                            │                                           │
 *                            └──accept──> ASSIGNED <────reopen───────────┘
 *                                                    (to IN_PROGRESS)
 * ```
 *
 * Reopening a COMPLETED task returns it to IN_PROGRESS under its previous
 * owner: there is no separate REOPENED status, because every consumer (board
 * columns, "open work" queries, the partial index in `db/schema.sql`) would
 * have to treat it identically to IN_PROGRESS. The fact that a reopen happened
 * is recorded as a {@link EventType.TaskReopened} event instead — which is what
 * an event-sourced system is for.
 */
export class TransitionMatrix {
  /** The matrix used by {@link StateMachine} unless one is injected. */
  static readonly default = new TransitionMatrix([
    {
      from: TaskStatus.BACKLOG,
      to: TaskStatus.ASSIGNED,
      event: EventType.TaskAssigned,
      requiresOwner: true,
      allowsNonOwner: true,
      label: 'assign',
    },
    {
      from: TaskStatus.ASSIGNED,
      to: TaskStatus.IN_PROGRESS,
      event: EventType.TaskStarted,
      requiresOwner: true,
      label: 'start',
    },
    {
      from: TaskStatus.ASSIGNED,
      to: TaskStatus.BACKLOG,
      event: EventType.TaskUnassigned,
      label: 'unassign',
    },
    {
      from: TaskStatus.ASSIGNED,
      to: TaskStatus.TRANSFERRED,
      event: EventType.TaskTransferred,
      label: 'transfer',
    },
    {
      from: TaskStatus.IN_PROGRESS,
      to: TaskStatus.BLOCKED,
      event: EventType.TaskBlocked,
      requiresReason: true,
      requiresOwner: true,
      label: 'block',
    },
    {
      from: TaskStatus.IN_PROGRESS,
      to: TaskStatus.COMPLETED,
      event: EventType.TaskCompleted,
      requiresOwner: true,
      label: 'complete',
    },
    {
      from: TaskStatus.IN_PROGRESS,
      to: TaskStatus.TRANSFERRED,
      event: EventType.TaskTransferred,
      label: 'transfer',
    },
    {
      from: TaskStatus.BLOCKED,
      to: TaskStatus.IN_PROGRESS,
      event: EventType.TaskUnblocked,
      requiresOwner: true,
      label: 'unblock',
    },
    {
      from: TaskStatus.BLOCKED,
      to: TaskStatus.TRANSFERRED,
      event: EventType.TaskTransferred,
      label: 'transfer',
    },
    {
      from: TaskStatus.COMPLETED,
      to: TaskStatus.IN_PROGRESS,
      event: EventType.TaskReopened,
      requiresReason: true,
      requiresOwner: true,
      label: 'reopen',
    },
    {
      from: TaskStatus.TRANSFERRED,
      to: TaskStatus.ASSIGNED,
      event: EventType.TaskAssigned,
      requiresOwner: true,
      allowsNonOwner: true,
      label: 'accept handoff',
    },
  ]);

  /** from -> to -> rule */
  private readonly graph: ReadonlyMap<TaskStatus, ReadonlyMap<TaskStatus, TransitionRule>>;

  constructor(rules: readonly TransitionRule[]) {
    const graph = new Map<TaskStatus, Map<TaskStatus, TransitionRule>>();
    for (const rule of rules) {
      let edges = graph.get(rule.from);
      if (!edges) {
        edges = new Map();
        graph.set(rule.from, edges);
      }
      if (edges.has(rule.to)) {
        throw new Error(
          `Duplicate transition rule ${rule.from} -> ${rule.to} in matrix.`,
        );
      }
      edges.set(rule.to, rule);
    }
    this.graph = graph;
  }

  /** The rule for an edge, or `undefined` when the edge does not exist. */
  rule(from: TaskStatus, to: TaskStatus): TransitionRule | undefined {
    return this.graph.get(from)?.get(to);
  }

  allows(from: TaskStatus, to: TaskStatus): boolean {
    return this.rule(from, to) !== undefined;
  }

  /** Statuses reachable from `from` in one step. */
  nextStates(from: TaskStatus): TaskStatus[] {
    return [...(this.graph.get(from)?.keys() ?? [])];
  }

  /** Every outbound rule from `from`, for building UI affordances. */
  rulesFrom(from: TaskStatus): TransitionRule[] {
    return [...(this.graph.get(from)?.values() ?? [])];
  }

  /** Every edge in the matrix. */
  all(): TransitionRule[] {
    return [...this.graph.values()].flatMap((edges) => [...edges.values()]);
  }
}

// =============================================================================
// State machine
// =============================================================================

/** Optional context that sharpens {@link StateMachine.validateTransition}. */
export interface TransitionContext {
  /** Owner the task will have once the transition lands. */
  nextOwnerId?: UUID | null;
}

/**
 * Validates task status changes against a {@link TransitionMatrix}.
 *
 * Stateless and safe to share; {@link taskStateMachine} is the default
 * instance.
 */
export class StateMachine {
  constructor(readonly matrix: TransitionMatrix = TransitionMatrix.default) {}

  /** Whether the edge exists at all, ignoring actor and reason. */
  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return this.matrix.allows(from, to);
  }

  /** Statuses reachable from `currentStatus` in one step. */
  getValidNextStates(currentStatus: TaskStatus): TaskStatus[] {
    return this.matrix.nextStates(currentStatus);
  }

  /** Whether the status admits any further transition. */
  isTerminal(status: TaskStatus): boolean {
    return this.getValidNextStates(status).length === 0;
  }

  /**
   * Full check: matrix edge, actor permission, and reason/owner requirements.
   * Never throws — see {@link assertTransition} for the throwing variant.
   *
   * @param actor Pass `ownerId` to enable the ownership check; omit it to skip
   *              permission checks (already-authorized or system callers).
   */
  validateTransition(
    from: TaskStatus,
    to: TaskStatus,
    actor?: TransitionActor,
    reason?: string | null,
    context: TransitionContext = {},
  ): TransitionValidation {
    const rule = this.matrix.rule(from, to);
    if (!rule) {
      const options = this.getValidNextStates(from);
      return invalid(
        DomainErrorCode.INVALID_TRANSITION,
        `Cannot transition task from ${from} to ${to}. ` +
          (options.length
            ? `Valid next states: ${options.join(', ')}.`
            : `${from} is a terminal state.`),
      );
    }

    if (rule.requiresReason && !isNonBlank(reason)) {
      return invalid(
        DomainErrorCode.VALIDATION_FAILED,
        `A non-empty reason is required to ${rule.label} a task (${from} -> ${to}).`,
      );
    }

    if (
      rule.requiresOwner &&
      'nextOwnerId' in context &&
      !context.nextOwnerId
    ) {
      return invalid(
        DomainErrorCode.VALIDATION_FAILED,
        `Cannot ${rule.label} a task without an owner (${from} -> ${to}).`,
      );
    }

    // Ownership is only checked when the caller supplied the current owner.
    if (actor && actor.ownerId !== undefined && !actor.isAdmin) {
      const owner = actor.ownerId;
      if (owner !== null && !rule.allowsNonOwner && owner !== actor.userId) {
        return invalid(
          DomainErrorCode.PERMISSION_DENIED,
          `Only the current owner may ${rule.label} this task.`,
        );
      }
    }

    return VALID;
  }

  /**
   * {@link validateTransition}, but throws the matching {@link DomainError}
   * subclass. This is what the aggregates use.
   */
  assertTransition(
    from: TaskStatus,
    to: TaskStatus,
    actor?: TransitionActor,
    reason?: string | null,
    context: TransitionContext = {},
  ): TransitionRule {
    const result = this.validateTransition(from, to, actor, reason, context);
    if (!result.valid) {
      const message = result.error ?? 'Transition rejected.';
      switch (result.code) {
        case DomainErrorCode.PERMISSION_DENIED:
          throw new PermissionError(message, actor?.userId);
        case DomainErrorCode.VALIDATION_FAILED:
          throw new ValidationError(message);
        default:
          throw new InvalidTransitionError(from, to, message);
      }
    }
    // validateTransition already proved the edge exists.
    return this.matrix.rule(from, to) as TransitionRule;
  }
}

/** Default machine over {@link TransitionMatrix.default}. */
export const taskStateMachine = new StateMachine();

// =============================================================================
// Task aggregate
// =============================================================================

/** Options accepted by {@link TaskAggregate.create}. */
export interface CreateTaskOptions {
  /** Pre-generated id, e.g. when the caller needs it before persisting. */
  id?: UUID;
  /** Create the task already owned, skipping the backlog. */
  ownerId?: UUID | null;
  /** Who created the task; recorded as the event actor. */
  actorId?: UUID | null;
  /** Overrides `now()`; useful for deterministic tests and backfills. */
  createdAt?: ISODateTime;
}

/**
 * A task plus the events produced since it was loaded.
 *
 * Immutable — every operation returns a new aggregate. Persist with:
 *
 * ```ts
 * const next = TaskAggregate.from(row).start({ userId });
 * await repo.save(next.state, next.pendingEvents); // one transaction
 * ```
 *
 * `pendingEvents` carries no `sequence`; the repository assigns it as
 * `MAX(sequence) + 1` inside the same transaction that writes `state`.
 */
export class TaskAggregate {
  private constructor(
    /** Current projected state, matching the `tasks` row. */
    readonly state: Task,
    /** Events produced by this aggregate, in order, not yet persisted. */
    readonly pendingEvents: readonly NewTaskEvent[],
    private readonly machine: StateMachine,
  ) {}

  // --- construction --------------------------------------------------------

  /** A brand new task, in BACKLOG unless `ownerId` is supplied. */
  static create(
    title: string,
    projectId: UUID,
    options: CreateTaskOptions = {},
    machine: StateMachine = taskStateMachine,
  ): TaskAggregate {
    const cleanTitle = requireNonBlank(title, 'title');
    requireNonBlank(projectId, 'projectId');

    const id = options.id ?? newUUID();
    const createdAt = options.createdAt ?? nowISO();
    const ownerId = options.ownerId ?? null;

    const state: Task = {
      id,
      projectId,
      title: cleanTitle,
      status: ownerId ? TaskStatus.ASSIGNED : TaskStatus.BACKLOG,
      ownerId,
      version: 0,
      createdAt,
    };

    const event: NewTaskEvent = {
      taskId: id,
      type: EventType.TaskCreated,
      actorId: options.actorId ?? ownerId ?? null,
      payload: {
        title: cleanTitle,
        projectId,
        ...(ownerId ? { ownerId } : {}),
      },
    };

    return new TaskAggregate(state, [event], machine);
  }

  /** Rehydrate from a persisted row. Starts with no pending events. */
  static from(
    task: Task,
    machine: StateMachine = taskStateMachine,
  ): TaskAggregate {
    return new TaskAggregate({ ...task }, [], machine);
  }

  // --- queries -------------------------------------------------------------

  getStatus(): TaskStatus {
    return this.state.status;
  }

  getOwnerId(): UUID | null {
    return this.state.ownerId;
  }

  /** Statuses this task can move to right now. */
  getValidNextStates(): TaskStatus[] {
    return this.machine.getValidNextStates(this.state.status);
  }

  /** True once the task can no longer move. */
  isTerminal(): boolean {
    return isTerminalStatus(this.state.status);
  }

  /** Plain `Task` snapshot, for serialization and persistence. */
  toJSON(): Task {
    return { ...this.state };
  }

  // --- operations ----------------------------------------------------------

  /** BACKLOG -> ASSIGNED, or TRANSFERRED -> ASSIGNED when a handoff lands. */
  assign(ownerId: UUID, actor?: ActorRef): TaskAggregate {
    requireNonBlank(ownerId, 'ownerId');
    const from = this.state.status;
    return this.apply(TaskStatus.ASSIGNED, actor, null, {
      nextOwnerId: ownerId,
      ownerId,
      payload: {
        fromOwnerId: this.state.ownerId,
        toOwnerId: ownerId,
      },
      // TRANSFERRED -> ASSIGNED reuses TaskAssigned, matching the matrix rule
      // for whichever edge we are on.
      expectFrom: from,
    });
  }

  /** ASSIGNED -> IN_PROGRESS. */
  start(actor?: ActorRef): TaskAggregate {
    return this.apply(TaskStatus.IN_PROGRESS, actor, null, {
      nextOwnerId: this.state.ownerId,
      payload: () => ({ ownerId: this.requireOwner('start') }),
    });
  }

  /** ASSIGNED -> BACKLOG. Clears the owner. */
  unassign(reason?: string, actor?: ActorRef): TaskAggregate {
    return this.apply(TaskStatus.BACKLOG, actor, reason, {
      nextOwnerId: null,
      ownerId: null,
      payload: () => ({
        previousOwnerId: this.requireOwner('unassign'),
        ...(isNonBlank(reason) ? { reason: reason.trim() } : {}),
      }),
    });
  }

  /** IN_PROGRESS -> COMPLETED. */
  complete(note?: string, actor?: ActorRef): TaskAggregate {
    return this.apply(TaskStatus.COMPLETED, actor, null, {
      nextOwnerId: this.state.ownerId,
      payload: isNonBlank(note) ? { note: note.trim() } : {},
    });
  }

  /** IN_PROGRESS -> BLOCKED. Requires a reason. */
  block(
    reason: string,
    actor?: ActorRef,
    blockedByTaskIds?: UUID[],
  ): TaskAggregate {
    return this.apply(TaskStatus.BLOCKED, actor, reason, {
      nextOwnerId: this.state.ownerId,
      payload: {
        reason: (reason ?? '').trim(),
        ...(blockedByTaskIds?.length ? { blockedByTaskIds } : {}),
      },
    });
  }

  /** BLOCKED -> IN_PROGRESS. */
  unblock(resolution = 'Unblocked', actor?: ActorRef): TaskAggregate {
    return this.apply(TaskStatus.IN_PROGRESS, actor, null, {
      nextOwnerId: this.state.ownerId,
      payload: {
        resolution: isNonBlank(resolution) ? resolution.trim() : 'Unblocked',
        resumedStatus: TaskStatus.IN_PROGRESS,
      },
    });
  }

  /**
   * ASSIGNED | IN_PROGRESS | BLOCKED -> TRANSFERRED.
   *
   * Marks the task as handed off but does *not* move ownership: the recipient
   * takes over by accepting the {@link HandoffAggregate}, which then calls
   * {@link assign}. Until then the task keeps its previous owner, so a declined
   * handoff leaves the work with someone.
   */
  transfer(
    toUserId: UUID,
    reason: string | null,
    actor?: ActorRef,
    handoffId: UUID = newUUID(),
  ): TaskAggregate {
    requireNonBlank(toUserId, 'toUserId');
    if (this.state.ownerId && this.state.ownerId === toUserId) {
      throw new ValidationError(
        'Cannot transfer a task to its current owner.',
        'toUserId',
      );
    }
    return this.apply(TaskStatus.TRANSFERRED, actor, reason, {
      nextOwnerId: this.state.ownerId,
      payload: {
        handoffId,
        fromUserId: this.state.ownerId,
        toUserId,
        reason: isNonBlank(reason) ? reason.trim() : null,
      },
    });
  }

  /**
   * COMPLETED -> IN_PROGRESS. Requires a reason.
   *
   * The completing owner picks the work back up; if the task somehow has no
   * owner, the acting user takes it.
   */
  reopen(reason: string, actor?: ActorRef): TaskAggregate {
    const ownerId = this.state.ownerId ?? actor?.userId ?? null;
    return this.apply(TaskStatus.IN_PROGRESS, actor, reason, {
      nextOwnerId: ownerId,
      ownerId,
      payload: () => ({ reason: (reason ?? '').trim(), ownerId }),
    });
  }

  // --- internals -----------------------------------------------------------

  private requireOwner(operation: string): UUID {
    const { ownerId } = this.state;
    if (!ownerId) {
      throw new ValidationError(
        `Cannot ${operation} a task that has no owner.`,
        'ownerId',
      );
    }
    return ownerId;
  }

  /**
   * Validate the edge, then produce the next aggregate with its event.
   * Central choke point: no other method writes `status` or `version`.
   */
  private apply(
    to: TaskStatus,
    actor: ActorRef | undefined,
    reason: string | null | undefined,
    spec: {
      /**
       * Lazy so that owner-derived payloads are built only after the edge has
       * been validated - otherwise "you can't start a backlog task" surfaces as
       * a misleading "task has no owner".
       */
      payload: Record<string, unknown> | (() => Record<string, unknown>);
      nextOwnerId?: UUID | null;
      /** Owner after the transition; defaults to the current owner. */
      ownerId?: UUID | null;
      expectFrom?: TaskStatus;
    },
  ): TaskAggregate {
    const from = spec.expectFrom ?? this.state.status;

    const rule = this.machine.assertTransition(
      from,
      to,
      actor ? { ...actor, ownerId: this.state.ownerId } : undefined,
      reason,
      { nextOwnerId: spec.nextOwnerId },
    );

    const nextOwnerId =
      spec.ownerId !== undefined ? spec.ownerId : this.state.ownerId;

    const nextState: Task = {
      ...this.state,
      status: to,
      ownerId: nextOwnerId,
      version: this.state.version + 1,
    };

    const event = {
      taskId: this.state.id,
      type: rule.event,
      actorId: actor?.userId ?? null,
      payload:
        typeof spec.payload === 'function' ? spec.payload() : spec.payload,
    } as NewTaskEvent;

    return new TaskAggregate(
      nextState,
      [...this.pendingEvents, event],
      this.machine,
    );
  }
}

// =============================================================================
// Handoff aggregate
// =============================================================================

/** Options accepted by {@link HandoffAggregate.initiate}. */
export interface InitiateHandoffOptions {
  id?: UUID;
  createdAt?: ISODateTime;
}

/**
 * A proposed transfer of task ownership.
 *
 * Unlike {@link TaskAggregate} this one mutates in place, because
 * `accept`/`decline` return an outcome rather than a new aggregate. Read the
 * result back from {@link state} after either call.
 */
export class HandoffAggregate {
  private current: Handoff;

  private constructor(handoff: Handoff) {
    this.current = handoff;
  }

  /**
   * Propose a handoff of `taskId` from one user to another.
   *
   * `taskId` is required even though it is not in the informal signature: a
   * handoff without a task cannot be persisted (`handoffs.task_id` is NOT NULL).
   */
  static initiate(
    taskId: UUID,
    fromUserId: UUID | null,
    toUserId: UUID,
    reason: string | null,
    options: InitiateHandoffOptions = {},
  ): HandoffAggregate {
    requireNonBlank(taskId, 'taskId');
    requireNonBlank(toUserId, 'toUserId');
    if (fromUserId !== null && fromUserId === toUserId) {
      throw new ValidationError(
        'Cannot hand a task off to the user who already owns it.',
        'toUserId',
      );
    }

    return new HandoffAggregate({
      id: options.id ?? newUUID(),
      taskId,
      fromUserId,
      toUserId,
      reason: isNonBlank(reason) ? reason.trim() : null,
      status: HandoffStatus.PENDING,
      resolvedAt: null,
      createdAt: options.createdAt ?? nowISO(),
    });
  }

  /** Rehydrate from a persisted row. */
  static from(handoff: Handoff): HandoffAggregate {
    return new HandoffAggregate({ ...handoff });
  }

  /** Current state, matching the `handoffs` row. */
  get state(): Handoff {
    return { ...this.current };
  }

  getStatus(): HandoffStatus {
    return this.current.status;
  }

  isPending(): boolean {
    return this.current.status === HandoffStatus.PENDING;
  }

  /**
   * Whether `toUserId` is the user this pending handoff is addressed to.
   * False for the wrong recipient and for an already-resolved handoff.
   */
  validateReceiver(toUserId: UUID): boolean {
    return (
      this.isPending() &&
      isNonBlank(toUserId) &&
      toUserId === this.current.toUserId
    );
  }

  /**
   * Recipient accepts. On success the handoff is ACCEPTED; apply the ownership
   * change with `TaskAggregate.from(task).assign(toUserId, actor)`.
   */
  accept(toUserId: UUID, at: ISODateTime = nowISO()): HandoffActionResult {
    const rejection = this.checkResolvable(toUserId, 'accept');
    if (rejection) return rejection;

    this.current = {
      ...this.current,
      status: HandoffStatus.ACCEPTED,
      resolvedAt: at,
    };
    return { success: true };
  }

  /**
   * Recipient declines. The task stays TRANSFERRED with its previous owner;
   * the sender is expected to reassign or propose a new handoff.
   */
  decline(toUserId: UUID, at: ISODateTime = nowISO()): HandoffActionResult {
    const rejection = this.checkResolvable(toUserId, 'decline');
    if (rejection) return rejection;

    this.current = {
      ...this.current,
      status: HandoffStatus.DECLINED,
      resolvedAt: at,
    };
    return { success: true };
  }

  /** Shared guard: returns a failure result, or undefined when allowed. */
  private checkResolvable(
    toUserId: UUID,
    action: 'accept' | 'decline',
  ): HandoffActionResult | undefined {
    if (!this.isPending()) {
      return {
        success: false,
        code: DomainErrorCode.INVALID_TRANSITION,
        error: `Handoff is already ${this.current.status.toLowerCase()} and cannot be ${action}ed.`,
      };
    }
    if (!this.validateReceiver(toUserId)) {
      return {
        success: false,
        code: DomainErrorCode.PERMISSION_DENIED,
        error: `Only the intended recipient may ${action} this handoff.`,
      };
    }
    return undefined;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function isNonBlank(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonBlank(value: string | null | undefined, field: string): string {
  if (!isNonBlank(value)) {
    throw new ValidationError(`${field} must be a non-empty string.`, field);
  }
  return value.trim();
}

function nowISO(): ISODateTime {
  return new Date().toISOString();
}

/**
 * UUID v4 from the platform crypto (Node 18+, all modern browsers). Callers in
 * exotic runtimes should pass ids explicitly via the `id` options.
 */
function newUUID(): UUID {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObj?.randomUUID) {
    throw new Error(
      'crypto.randomUUID is unavailable; pass an explicit id in the options object.',
    );
  }
  return cryptoObj.randomUUID();
}
