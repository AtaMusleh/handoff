/**
 * Handoff domain types.
 *
 * Mirrors `db/schema.sql`. SQL uses snake_case columns; these interfaces use
 * camelCase — map at the repository boundary, not in application code.
 *
 * Timestamps are ISO-8601 UTC strings (`TIMESTAMP WITH TIME ZONE` serialized
 * over JSON), keeping the types structurally identical across the API boundary
 * and inside the worker.
 */

// -----------------------------------------------------------------------------
// Scalars
// -----------------------------------------------------------------------------

/** RFC 4122 UUID. */
export type UUID = string;

/** ISO-8601 timestamp in UTC, e.g. `2026-09-05T12:34:56.789Z`. */
export type ISODateTime = string;

/** Arbitrary JSON value, as stored in a JSONB column. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

/**
 * Task lifecycle states. Kept in sync with the `tasks_status_valid` CHECK
 * constraint in `db/schema.sql`.
 */
export enum TaskStatus {
  /** Created, not yet owned. The only state permitted to have a null owner. */
  BACKLOG = 'BACKLOG',
  /** Owned but not started. */
  ASSIGNED = 'ASSIGNED',
  /** Actively being worked. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Halted on an external dependency; retains its owner. */
  BLOCKED = 'BLOCKED',
  /** Terminal: work finished. */
  COMPLETED = 'COMPLETED',
  /** Terminal for the previous owner: ownership moved via a handoff. */
  TRANSFERRED = 'TRANSFERRED',
}

/**
 * Event stream discriminants. Kept in sync with the `task_events_type_valid`
 * CHECK constraint in `db/schema.sql`.
 */
export enum EventType {
  TaskCreated = 'TaskCreated',
  TaskAssigned = 'TaskAssigned',
  TaskStarted = 'TaskStarted',
  TaskUnassigned = 'TaskUnassigned',
  TaskBlocked = 'TaskBlocked',
  TaskTransferred = 'TaskTransferred',
  TaskCompleted = 'TaskCompleted',
  TaskUnblocked = 'TaskUnblocked',
  TaskReopened = 'TaskReopened',
}

/**
 * Lifecycle of a {@link Handoff}. A handoff is proposed, then accepted or
 * declined by the recipient; only acceptance moves task ownership.
 */
export enum HandoffStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
}

/** Statuses from which no further transition is possible. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.TRANSFERRED,
] as const;

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

// -----------------------------------------------------------------------------
// Entities
// -----------------------------------------------------------------------------

/** `users` */
export interface User {
  id: UUID;
  email: string;
  displayName: string;
  createdAt: ISODateTime;
}

/** `projects` */
export interface Project {
  id: UUID;
  /** Owning user. */
  userId: UUID;
  name: string;
  createdAt: ISODateTime;
}

/**
 * `tasks` — the current-state projection of a task's event stream.
 *
 * Never mutate a task without appending the corresponding {@link TaskEvent};
 * the stream is the system of record and this row is derivable from it.
 */
export interface Task {
  id: UUID;
  projectId: UUID;
  title: string;
  status: TaskStatus;
  /** Null only while the task is in {@link TaskStatus.BACKLOG}. */
  ownerId: UUID | null;
  /**
   * Optimistic-concurrency token. Incremented on every state mutation; a
   * conditional UPDATE matching zero rows means a concurrent writer won.
   */
  version: number;
  createdAt: ISODateTime;
}

/**
 * `handoffs` — one transfer of task ownership between two users.
 */
export interface Handoff {
  id: UUID;
  taskId: UUID;
  /** Null when the task was previously unowned (claimed from backlog). */
  fromUserId: UUID | null;
  toUserId: UUID;
  /** Free-text rationale supplied by the sender. */
  reason: string | null;
  /** Proposal lifecycle. Task ownership moves only on ACCEPTED. */
  status: HandoffStatus;
  /** The recipient's note when accepting or declining; null while PENDING. */
  resolutionNote: string | null;
  /** When the recipient accepted or declined; null while PENDING. */
  resolvedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

/**
 * `handoff_briefs` — AI-generated context attached to a handoff.
 * One brief per handoff; regenerating replaces it.
 */
export interface HandoffBrief {
  id: UUID;
  handoffId: UUID;
  content: HandoffBriefContent;
  /**
   * The {@link TaskEvent} ids this brief was derived from. Compare against the
   * task's current stream to detect a stale brief.
   */
  sourceEventIds: UUID[];
  /** Model identifier used for generation, e.g. `claude-sonnet-5`. */
  model: string;
  createdAt: ISODateTime;
}

/** Structured body of a {@link HandoffBrief}; stored as JSONB. */
export interface HandoffBriefContent {
  /** One-paragraph orientation for the incoming owner. */
  summary: string;
  /** Decisions and constraints the recipient needs in order to continue. */
  keyContext: string[];
  /** Concrete next steps. */
  openQuestions: string[];
  /** Anything currently blocking progress. */
  blockers: string[];
  /** Model-reported confidence in the brief, 0..1. */
  confidence?: number;
}

/** `comments` */
export interface Comment {
  id: UUID;
  taskId: UUID;
  /** Null when the author's account has been deleted; the body is retained. */
  authorId: UUID | null;
  body: string;
  createdAt: ISODateTime;
}

// -----------------------------------------------------------------------------
// Event payloads
// -----------------------------------------------------------------------------

export interface TaskCreatedPayload {
  title: string;
  projectId: UUID;
  /** Present when the task was created pre-assigned rather than in backlog. */
  ownerId?: UUID;
}

export interface TaskAssignedPayload {
  /** Null when the task is being claimed straight out of the backlog. */
  fromOwnerId: UUID | null;
  toOwnerId: UUID;
}

export interface TaskStartedPayload {
  /** Owner who picked the task up. */
  ownerId: UUID;
}

export interface TaskUnassignedPayload {
  /** Owner the task is being taken away from. */
  previousOwnerId: UUID;
  /** Why the task went back to the backlog. */
  reason?: string;
}

export interface TaskReopenedPayload {
  /** Why the completed task is being reopened. Required — reopening is rare. */
  reason: string;
  /** Owner picking the work back up; defaults to the completing owner. */
  ownerId: UUID;
}

export interface TaskBlockedPayload {
  reason: string;
  /** Other tasks this one is waiting on, when the blocker is internal. */
  blockedByTaskIds?: UUID[];
}

export interface TaskUnblockedPayload {
  /** How the block was cleared. */
  resolution: string;
  /** Status the task returns to; defaults to IN_PROGRESS. */
  resumedStatus?: TaskStatus.ASSIGNED | TaskStatus.IN_PROGRESS;
}

export interface TaskTransferredPayload {
  handoffId: UUID;
  /** Null when transferring an unowned task. */
  fromUserId: UUID | null;
  toUserId: UUID;
  reason: string | null;
}

export interface TaskCompletedPayload {
  /** Optional closing note from the completer. */
  note?: string;
}

/** Maps each {@link EventType} to its payload shape. */
export interface TaskEventPayloadMap {
  [EventType.TaskCreated]: TaskCreatedPayload;
  [EventType.TaskAssigned]: TaskAssignedPayload;
  [EventType.TaskStarted]: TaskStartedPayload;
  [EventType.TaskUnassigned]: TaskUnassignedPayload;
  [EventType.TaskBlocked]: TaskBlockedPayload;
  [EventType.TaskUnblocked]: TaskUnblockedPayload;
  [EventType.TaskTransferred]: TaskTransferredPayload;
  [EventType.TaskCompleted]: TaskCompletedPayload;
  [EventType.TaskReopened]: TaskReopenedPayload;
}

export type TaskEventPayload = TaskEventPayloadMap[EventType];

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

/**
 * `task_events` — one immutable entry in a task's stream.
 *
 * Generic over {@link EventType} so `payload` narrows with `type`:
 *
 * ```ts
 * if (event.type === EventType.TaskBlocked) {
 *   console.log(event.payload.reason); // TaskBlockedPayload
 * }
 * ```
 */
export interface TaskEventOf<T extends EventType> {
  id: UUID;
  taskId: UUID;
  type: T;
  /** Null when the acting user's account has been deleted. */
  actorId: UUID | null;
  payload: TaskEventPayloadMap[T];
  /** Per-task position, 1-based and gapless. Unique with `taskId`. */
  sequence: number;
  createdAt: ISODateTime;
}

export type TaskCreatedEvent = TaskEventOf<EventType.TaskCreated>;
export type TaskAssignedEvent = TaskEventOf<EventType.TaskAssigned>;
export type TaskStartedEvent = TaskEventOf<EventType.TaskStarted>;
export type TaskUnassignedEvent = TaskEventOf<EventType.TaskUnassigned>;
export type TaskBlockedEvent = TaskEventOf<EventType.TaskBlocked>;
export type TaskUnblockedEvent = TaskEventOf<EventType.TaskUnblocked>;
export type TaskTransferredEvent = TaskEventOf<EventType.TaskTransferred>;
export type TaskCompletedEvent = TaskEventOf<EventType.TaskCompleted>;
export type TaskReopenedEvent = TaskEventOf<EventType.TaskReopened>;

/** Discriminated union of every event in the stream. */
export type TaskEvent =
  | TaskCreatedEvent
  | TaskAssignedEvent
  | TaskStartedEvent
  | TaskUnassignedEvent
  | TaskBlockedEvent
  | TaskUnblockedEvent
  | TaskTransferredEvent
  | TaskCompletedEvent
  | TaskReopenedEvent;

/**
 * An event before it has been persisted: no id, no sequence, no timestamp —
 * those are assigned by the append operation.
 */
export type NewTaskEvent<T extends EventType = EventType> = {
  [K in T]: Pick<TaskEventOf<K>, 'taskId' | 'type' | 'actorId' | 'payload'>;
}[T];

// -----------------------------------------------------------------------------
// Type guards
// -----------------------------------------------------------------------------

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    (Object.values(TaskStatus) as string[]).includes(value)
  );
}

export function isHandoffStatus(value: unknown): value is HandoffStatus {
  return (
    typeof value === 'string' &&
    (Object.values(HandoffStatus) as string[]).includes(value)
  );
}

export function isEventType(value: unknown): value is EventType {
  return (
    typeof value === 'string' &&
    (Object.values(EventType) as string[]).includes(value)
  );
}

export function isEventOfType<T extends EventType>(
  event: TaskEvent,
  type: T,
): event is Extract<TaskEvent, { type: T }> {
  return event.type === type;
}
