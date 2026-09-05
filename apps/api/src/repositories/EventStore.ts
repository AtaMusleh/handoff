/**
 * Persistence layer for the Handoff event store and its aggregates.
 *
 * Design rules:
 *
 *   * The database driver is injected as a structural {@link Queryable}, which
 *     `pg.Pool` and `pg.PoolClient` both satisfy. Nothing here imports `pg`, so
 *     the layer unit-tests against a fake without a live database.
 *   * Every write that touches more than one row runs in a transaction. The
 *     `tasks` row is locked FOR UPDATE before its stream is appended to, so
 *     sequence numbers are allocated serially per task.
 *   * Optimistic locking compares against {@link TaskAggregate.baseVersion} —
 *     the version the aggregate was *loaded* at — not `state.version`, which has
 *     already advanced past the database.
 *   * Callers get aggregates. Row shapes never escape this file.
 */

import {
  EventType,
  HandoffAggregate,
  HandoffStatus,
  TaskAggregate,
  TaskStatus,
  isEventType,
  isHandoffStatus,
  isTaskStatus,
  type Handoff,
  type HandoffBrief,
  type HandoffBriefContent,
  type ISODateTime,
  type JsonObject,
  type NewTaskEvent,
  type Task,
  type TaskEvent,
  type UUID,
} from '@handoff/domain';

// =============================================================================
// Driver seam
// =============================================================================

/** Subset of `pg.QueryResult` this layer relies on. */
export interface QueryResultLike<R> {
  rows: R[];
  rowCount: number | null;
}

/** Anything that can run a parameterized statement: `pg.Pool` or `pg.PoolClient`. */
export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<R>>;
}

/** A `pg.PoolClient`: a connection that must be released. */
export interface PoolClientLike extends Queryable {
  release(err?: boolean): void;
}

/** A `pg.Pool`: hands out clients. */
export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
}

export function isPool(db: Queryable): db is PoolLike {
  return typeof (db as PoolLike).connect === 'function';
}

// =============================================================================
// Errors
// =============================================================================

export enum RepositoryErrorCode {
  CONCURRENCY_CONFLICT = 'CONCURRENCY_CONFLICT',
  NOT_FOUND = 'NOT_FOUND',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  CONSTRAINT_VIOLATION = 'CONSTRAINT_VIOLATION',
}

/** Base class for every error this layer raises deliberately. */
export abstract class RepositoryError extends Error {
  abstract readonly code: RepositoryErrorCode;

  protected constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Someone else wrote first: the row moved on before our update landed. */
export class ConcurrencyError extends RepositoryError {
  readonly code = RepositoryErrorCode.CONCURRENCY_CONFLICT;

  constructor(
    readonly entity: string,
    readonly id: UUID,
    readonly expectedVersion?: number,
    readonly actualVersion?: number,
    cause?: unknown,
  ) {
    super(
      `${entity} ${id} was modified concurrently` +
        (expectedVersion !== undefined
          ? ` (expected version ${expectedVersion}, found ` +
            `${actualVersion ?? 'a different value'})`
          : '') +
        '. Reload the aggregate and retry.',
      cause,
    );
  }
}

/** The aggregate does not exist. */
export class NotFoundError extends RepositoryError {
  readonly code = RepositoryErrorCode.NOT_FOUND;

  constructor(
    readonly entity: string,
    readonly id: UUID,
    cause?: unknown,
  ) {
    super(`${entity} ${id} was not found.`, cause);
  }
}

/** The transaction could not be completed; it has been rolled back. */
export class TransactionError extends RepositoryError {
  readonly code = RepositoryErrorCode.TRANSACTION_FAILED;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * A CHECK, FK, or append-only trigger rejected the write. Distinct from
 * {@link ConcurrencyError}: retrying will not help.
 */
export class ConstraintViolationError extends RepositoryError {
  readonly code = RepositoryErrorCode.CONSTRAINT_VIOLATION;

  constructor(
    message: string,
    readonly constraint?: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

// -----------------------------------------------------------------------------
// PostgreSQL error translation
// -----------------------------------------------------------------------------

/** The `pg` error shape, structurally. */
interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
  table?: string;
}

const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  RESTRICT_VIOLATION: '23001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

function asPgError(err: unknown): PgError | undefined {
  return err && typeof err === 'object' ? (err as PgError) : undefined;
}

function pgCode(err: unknown): string | undefined {
  return asPgError(err)?.code;
}

/** True for failures that a retry of the whole transaction may resolve. */
export function isRetryable(err: unknown): boolean {
  const code = pgCode(err);
  return code === PG.SERIALIZATION_FAILURE || code === PG.DEADLOCK_DETECTED;
}

/**
 * Map a driver error onto this layer's error types. Anything unrecognized is
 * rethrown untouched — swallowing unknown failures hides real bugs.
 */
function translatePgError(err: unknown, context: { entity: string; id: UUID }): never {
  const pg = asPgError(err);
  const { entity, id } = context;

  switch (pg?.code) {
    case PG.FOREIGN_KEY_VIOLATION:
      // The parent row is gone or was never there: a missing task, project, or
      // user rather than a caller error.
      throw new NotFoundError(
        `${entity} referenced a row that does not exist ` +
          `(constraint ${pg.constraint ?? 'unknown'})`,
        id,
        err,
      );

    case PG.UNIQUE_VIOLATION:
      // On task_events this is the (task_id, sequence) guard: two writers
      // raced for the same stream position.
      throw new ConcurrencyError(entity, id, undefined, undefined, err);

    case PG.SERIALIZATION_FAILURE:
    case PG.DEADLOCK_DETECTED:
      throw new ConcurrencyError(entity, id, undefined, undefined, err);

    case PG.CHECK_VIOLATION:
    case PG.NOT_NULL_VIOLATION:
      throw new ConstraintViolationError(
        `${entity} ${id} violated ${pg.constraint ?? 'a database constraint'}.`,
        pg.constraint,
        err,
      );

    case PG.RESTRICT_VIOLATION:
      // Raised by the append-only triggers on task_events.
      throw new ConstraintViolationError(
        pg.message ?? `${entity} ${id} attempted a forbidden mutation.`,
        pg.constraint,
        err,
      );

    default:
      throw err;
  }
}

// =============================================================================
// Publication
// =============================================================================

/**
 * An event as broadcast to subscribers, enriched with the routing information
 * the realtime layer needs but `task_events` does not store on the row.
 */
export interface PublishedTaskEvent {
  event: TaskEvent;
  /** Owning project, for room routing. Read under the same lock as the append. */
  projectId: UUID;
  /**
   * The task version this event produced.
   *
   * Equal to `sequence - 1` by construction: TaskCreated is sequence 1 and
   * leaves the task at version 0, and every later event advances both by one.
   * `replayEvents` relies on the same invariant.
   */
  version: number;
}

/** Receives events that have been durably committed. */
export interface TaskEventPublisher {
  publish(events: readonly PublishedTaskEvent[]): void;
}

/**
 * Holds events until someone flushes them.
 *
 * Used by {@link inUnitOfWork} so that repositories enlisted in a caller's
 * transaction do not broadcast work that a later ROLLBACK would undo: the
 * buffer is drained only once COMMIT has returned.
 */
export class BufferingPublisher implements TaskEventPublisher {
  private buffered: PublishedTaskEvent[] = [];

  publish(events: readonly PublishedTaskEvent[]): void {
    this.buffered.push(...events);
  }

  /** Discard anything buffered. Called before each transaction attempt. */
  reset(): void {
    this.buffered = [];
  }

  /** Hand everything buffered to `target` and clear. */
  flushTo(target: TaskEventPublisher | undefined): void {
    if (target && this.buffered.length > 0) target.publish(this.buffered);
    this.buffered = [];
  }
}

// =============================================================================
// Transactions
// =============================================================================

export interface TransactionOptions {
  /** Retries on serialization failure / deadlock. Default 2. */
  maxRetries?: number;
  /** Isolation level for the transaction. Default: the server default. */
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Retries the whole callback on serialization failures and deadlocks, so `fn`
 * must be safe to run more than once (it re-reads everything it needs).
 */
export async function withTransaction<T>(
  pool: PoolLike,
  fn: (client: PoolClientLike) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(
        options.isolation
          ? `BEGIN ISOLATION LEVEL ${options.isolation}`
          : 'BEGIN',
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      lastError = err;
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // A failed rollback means the connection is unusable; report the
        // original failure but flag the connection so it is not reused.
        client.release(true);
        throw new TransactionError(
          'Transaction failed and could not be rolled back.',
          rollbackErr,
        );
      }
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      continue;
    } finally {
      // release() is idempotent in pg; the error path above may have run first.
      client.release();
    }
  }

  throw new TransactionError(
    `Transaction failed after ${maxRetries + 1} attempts.`,
    lastError,
  );
}

// =============================================================================
// Row mapping
// =============================================================================

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  owner_id: string | null;
  due_date: Date | string | null;
  version: number | string;
  created_at: Date | string;
}

interface TaskEventRow {
  id: string;
  task_id: string;
  type: string;
  actor_id: string | null;
  payload: unknown;
  sequence: number | string;
  created_at: Date | string;
}

interface HandoffRow {
  id: string;
  task_id: string;
  from_user_id: string | null;
  to_user_id: string;
  reason: string | null;
  status: string;
  resolution_note: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
}

function toISO(value: Date | string): ISODateTime {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toISOOrNull(value: Date | string | null): ISODateTime | null {
  return value === null ? null : toISO(value);
}

/** `bigint`/`numeric` come back as strings from `pg`; normalize to number. */
function toInt(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toJsonObject(value: unknown): JsonObject {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as JsonObject) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as JsonObject) : {};
}

function mapTask(row: TaskRow): Task {
  if (!isTaskStatus(row.status)) {
    throw new ConstraintViolationError(
      `Task ${row.id} has status "${row.status}", which is not a known TaskStatus. ` +
        'The database CHECK constraint and the TaskStatus enum have drifted.',
    );
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    ownerId: row.owner_id,
    dueDate: toISOOrNull(row.due_date),
    version: toInt(row.version),
    createdAt: toISO(row.created_at),
  };
}

function mapEvent(row: TaskEventRow): TaskEvent {
  if (!isEventType(row.type)) {
    throw new ConstraintViolationError(
      `Event ${row.id} has type "${row.type}", which is not a known EventType. ` +
        'The database CHECK constraint and the EventType enum have drifted.',
    );
  }
  // The cast is the one unavoidable trust boundary: the payload column is
  // schemaless, so its correlation with `type` is enforced on write, not read.
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    actorId: row.actor_id,
    payload: toJsonObject(row.payload),
    sequence: toInt(row.sequence),
    createdAt: toISO(row.created_at),
  } as TaskEvent;
}

function mapHandoff(row: HandoffRow): Handoff {
  if (!isHandoffStatus(row.status)) {
    throw new ConstraintViolationError(
      `Handoff ${row.id} has status "${row.status}", which is not a known HandoffStatus.`,
    );
  }
  return {
    id: row.id,
    taskId: row.task_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    reason: row.reason,
    status: row.status,
    resolutionNote: row.resolution_note,
    resolvedAt: toISOOrNull(row.resolved_at),
    createdAt: toISO(row.created_at),
  };
}

const TASK_COLUMNS =
  'id, project_id, title, status, owner_id, due_date, version, created_at';
const EVENT_COLUMNS = 'id, task_id, type, actor_id, payload, sequence, created_at';
const HANDOFF_COLUMNS =
  'id, task_id, from_user_id, to_user_id, reason, status, resolution_note, resolved_at, created_at';

// =============================================================================
// Event replay
// =============================================================================

/**
 * Rebuild task state from its event stream.
 *
 * This is the inverse of the aggregate's transitions and must stay in step with
 * them: replaying a stream produces the same `Task` the projection holds. That
 * property is what makes the `tasks` table disposable and is worth a test.
 *
 * @throws {ConstraintViolationError} if the stream does not start with
 *   TaskCreated, or has gaps in its sequence.
 */
export function replayEvents(events: readonly TaskEvent[]): Task {
  if (events.length === 0) {
    throw new ConstraintViolationError('Cannot replay an empty event stream.');
  }

  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const first = ordered[0]!;

  if (first.type !== EventType.TaskCreated) {
    throw new ConstraintViolationError(
      `Stream for task ${first.taskId} starts with ${first.type}; expected TaskCreated.`,
    );
  }

  for (let i = 0; i < ordered.length; i++) {
    const expected = i + 1;
    if (ordered[i]!.sequence !== expected) {
      throw new ConstraintViolationError(
        `Stream for task ${first.taskId} has a gap: expected sequence ${expected}, ` +
          `found ${ordered[i]!.sequence}.`,
      );
    }
  }

  let state: Task = {
    id: first.taskId,
    projectId: first.payload.projectId,
    title: first.payload.title,
    status: first.payload.ownerId ? TaskStatus.ASSIGNED : TaskStatus.BACKLOG,
    ownerId: first.payload.ownerId ?? null,
    dueDate: first.payload.dueDate ?? null,
    version: 0,
    createdAt: first.createdAt,
  };

  for (const event of ordered.slice(1)) {
    state = { ...applyEvent(state, event), version: state.version + 1 };
  }

  return state;
}

/** Single-event reducer. Mirrors `TaskAggregate`'s transitions exactly. */
function applyEvent(state: Task, event: TaskEvent): Task {
  switch (event.type) {
    case EventType.TaskCreated:
      throw new ConstraintViolationError(
        `Task ${state.id} has a second TaskCreated event at sequence ${event.sequence}.`,
      );

    case EventType.TaskAssigned:
      return { ...state, status: TaskStatus.ASSIGNED, ownerId: event.payload.toOwnerId };

    case EventType.TaskStarted:
      return { ...state, status: TaskStatus.IN_PROGRESS };

    case EventType.TaskUnassigned:
      return { ...state, status: TaskStatus.BACKLOG, ownerId: null };

    case EventType.TaskBlocked:
      return { ...state, status: TaskStatus.BLOCKED };

    case EventType.TaskUnblocked:
      return {
        ...state,
        status: event.payload.resumedStatus ?? TaskStatus.IN_PROGRESS,
      };

    case EventType.TaskTransferred:
      // Ownership moves only when the recipient accepts, which arrives as a
      // separate TaskAssigned event.
      return { ...state, status: TaskStatus.TRANSFERRED };

    case EventType.TaskCompleted:
      return { ...state, status: TaskStatus.COMPLETED };

    case EventType.TaskReopened:
      return {
        ...state,
        status: TaskStatus.IN_PROGRESS,
        ownerId: event.payload.ownerId ?? state.ownerId,
      };

    default: {
      const exhaustive: never = event;
      throw new ConstraintViolationError(
        `Unhandled event type in replay: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// =============================================================================
// EventStore
// =============================================================================

/** Internal result of an append: the row plus what publication needs. */
interface AppendedEvent {
  id: UUID;
  sequence: number;
  taskId: UUID;
  projectId: UUID;
  event: TaskEvent;
}

/** Project an {@link AppendedEvent} into the broadcast shape. */
function toPublished(a: AppendedEvent): PublishedTaskEvent {
  return { event: a.event, projectId: a.projectId, version: a.sequence - 1 };
}

/** What {@link EventStore.getTaskHistory} returns. */
export interface TaskHistory {
  events: TaskEvent[];
  aggregate: TaskAggregate;
}

/**
 * Append-only access to `task_events`.
 *
 * Construct with a pool for standalone use, or with a transaction client via
 * {@link EventStore.withClient} to enlist in a caller's transaction.
 */
export class EventStore {
  constructor(
    private readonly db: Queryable,
    /**
     * Notified after events are durably committed. When this store is enlisted
     * in someone else's transaction, {@link inUnitOfWork} passes a
     * {@link BufferingPublisher} so nothing escapes before COMMIT.
     */
    private readonly publisher?: TaskEventPublisher,
  ) {}

  /** A store bound to `client`, for use inside an open transaction. */
  withClient(client: Queryable, publisher?: TaskEventPublisher): EventStore {
    return new EventStore(client, publisher ?? this.publisher);
  }

  /**
   * Append one event, allocating the next sequence for its task.
   *
   * Locks the `tasks` row first so concurrent appends to the same stream
   * serialize rather than colliding on the `(task_id, sequence)` unique index.
   *
   * @throws {NotFoundError} if the task does not exist.
   */
  async append(event: NewTaskEvent): Promise<{ id: UUID; sequence: number }> {
    const appended = await this.run((client) => appendAll(client, [event]));
    // run() has committed by now (or handed off to a buffer that will only be
    // drained post-COMMIT), so this can never announce a rolled-back event.
    this.publisher?.publish(appended.map(toPublished));
    const first = appended[0]!;
    return { id: first.id, sequence: first.sequence };
  }

  /**
   * Append several events to one or more streams, atomically and in order.
   * Used by {@link TaskRepository.save} to flush an aggregate's pending events.
   */
  async appendMany(
    events: readonly NewTaskEvent[],
  ): Promise<Array<{ id: UUID; sequence: number }>> {
    if (events.length === 0) return [];
    const appended = await this.run((client) => appendAll(client, events));
    this.publisher?.publish(appended.map(toPublished));
    return appended.map((a) => ({ id: a.id, sequence: a.sequence }));
  }

  /** Full stream for a task, in sequence order. */
  async getEvents(taskId: UUID): Promise<TaskEvent[]> {
    const { rows } = await this.db.query<TaskEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM task_events
        WHERE task_id = $1
        ORDER BY sequence ASC`,
      [taskId],
    );
    return rows.map(mapEvent);
  }

  /**
   * Events after `afterSequence`, in order. The realtime layer uses this to
   * catch a reconnecting client up from its last-seen position.
   */
  async getEventsSince(taskId: UUID, afterSequence: number): Promise<TaskEvent[]> {
    const { rows } = await this.db.query<TaskEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM task_events
        WHERE task_id = $1 AND sequence > $2
        ORDER BY sequence ASC`,
      [taskId, afterSequence],
    );
    return rows.map(mapEvent);
  }

  /**
   * One page of a task's stream, in sequence order, starting after
   * `afterSequence`. Backs cursor pagination on the history endpoint.
   *
   * Fetches `limit + 1` rows internally to report `hasMore` without a
   * second COUNT query.
   */
  async getEventsPage(
    taskId: UUID,
    afterSequence: number,
    limit: number,
  ): Promise<{ events: TaskEvent[]; hasMore: boolean; nextCursor: number | null }> {
    const safeLimit = normalizeLimit(limit, 200);
    const { rows } = await this.db.query<TaskEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM task_events
        WHERE task_id = $1 AND sequence > $2
        ORDER BY sequence ASC
        LIMIT $3`,
      [taskId, afterSequence, safeLimit + 1],
    );
    const hasMore = rows.length > safeLimit;
    const events = rows.slice(0, safeLimit).map(mapEvent);
    return {
      events,
      hasMore,
      nextCursor: hasMore ? (events[events.length - 1]?.sequence ?? null) : null,
    };
  }

  /** Most recent events of one type across all tasks, newest first. */
  async getEventsByType(type: EventType, limit: number): Promise<TaskEvent[]> {
    const safeLimit = normalizeLimit(limit);
    const { rows } = await this.db.query<TaskEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM task_events
        WHERE type = $1
        ORDER BY created_at DESC, sequence DESC
        LIMIT $2`,
      [type, safeLimit],
    );
    return rows.map(mapEvent);
  }

  /**
   * A task's full stream plus the aggregate rebuilt from it.
   *
   * The aggregate comes from {@link replayEvents}, not from the `tasks` row, so
   * this doubles as a consistency check on the projection.
   *
   * @throws {NotFoundError} if the task has no events.
   */
  async getTaskHistory(taskId: UUID): Promise<TaskHistory> {
    const events = await this.getEvents(taskId);
    if (events.length === 0) throw new NotFoundError('Task', taskId);
    return { events, aggregate: TaskAggregate.from(replayEvents(events)) };
  }

  /**
   * Rebuild a task purely from its events, ignoring the projection. Primarily
   * for tests and for repairing a drifted `tasks` row.
   */
  async replay(taskId: UUID): Promise<TaskAggregate> {
    return (await this.getTaskHistory(taskId)).aggregate;
  }

  /** Run `fn` in a transaction when holding a pool; inline when already in one. */
  private async run<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    return isPool(this.db) ? withTransaction(this.db, fn) : fn(this.db);
  }
}

/**
 * Lock each touched task, then insert its events with server-computed
 * sequences. Shared by {@link EventStore} and {@link TaskRepository.save} so
 * both allocate sequences identically.
 */
async function appendAll(
  client: Queryable,
  events: readonly NewTaskEvent[],
): Promise<AppendedEvent[]> {
  // Lock in a deterministic order so two concurrent multi-task appends cannot
  // deadlock by grabbing the same rows in opposite orders.
  const taskIds = [...new Set(events.map((e) => e.taskId))].sort();
  const projectByTask = new Map<UUID, UUID>();
  for (const taskId of taskIds) {
    // project_id comes back under the same lock, so the realtime layer can
    // route without a second read that might see a different row.
    const { rows } = await client.query<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM tasks WHERE id = $1 FOR UPDATE',
      [taskId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Task', taskId);
    projectByTask.set(taskId, row.project_id);
  }

  const appended: AppendedEvent[] = [];
  for (const event of events) {
    try {
      const { rows } = await client.query<{
        id: string;
        sequence: number | string;
        created_at: Date | string;
      }>(
        `INSERT INTO task_events (task_id, type, actor_id, payload, sequence)
         SELECT $1::uuid, $2, $3::uuid, $4::jsonb,
                COALESCE(
                  (SELECT MAX(sequence) FROM task_events WHERE task_id = $1::uuid),
                  0
                ) + 1
         RETURNING id, sequence, created_at`,
        [event.taskId, event.type, event.actorId, JSON.stringify(event.payload)],
      );
      const row = rows[0];
      if (!row) {
        throw new TransactionError(
          `Appending ${event.type} to task ${event.taskId} returned no row.`,
        );
      }
      const sequence = toInt(row.sequence);
      appended.push({
        id: row.id,
        sequence,
        taskId: event.taskId,
        projectId: projectByTask.get(event.taskId)!,
        event: {
          ...event,
          id: row.id,
          sequence,
          createdAt: toISO(row.created_at),
        } as TaskEvent,
      });
    } catch (err) {
      if (err instanceof RepositoryError) throw err;
      translatePgError(err, { entity: 'TaskEvent', id: event.taskId });
    }
  }
  return appended;
}

function normalizeLimit(limit: number, max = 1000): number {
  if (!Number.isFinite(limit) || limit <= 0) return 1;
  return Math.min(Math.floor(limit), max);
}

// =============================================================================
// TaskRepository
// =============================================================================

/** What {@link TaskRepository.getWithVersion} returns. */
export interface VersionedTask {
  aggregate: TaskAggregate;
  version: number;
}

/**
 * Reads and writes `tasks`, keeping the projection and the event stream in the
 * same transaction.
 */
export class TaskRepository {
  private readonly events: EventStore;

  constructor(
    private readonly db: Queryable,
    events?: EventStore,
    private readonly publisher?: TaskEventPublisher,
  ) {
    this.events = events ?? new EventStore(db, publisher);
  }

  /** A repository bound to `client`, for use inside an open transaction. */
  withClient(client: Queryable, publisher?: TaskEventPublisher): TaskRepository {
    return new TaskRepository(client, undefined, publisher ?? this.publisher);
  }

  /** The task, or null when it does not exist. */
  async getById(taskId: UUID): Promise<TaskAggregate | null> {
    const { rows } = await this.db.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`,
      [taskId],
    );
    const row = rows[0];
    return row ? TaskAggregate.from(mapTask(row)) : null;
  }

  /** {@link getById}, but throwing when absent. */
  async requireById(taskId: UUID): Promise<TaskAggregate> {
    const found = await this.getById(taskId);
    if (!found) throw new NotFoundError('Task', taskId);
    return found;
  }

  /** A user's tasks, newest first, optionally filtered to one status. */
  async getByOwner(userId: UUID, status?: TaskStatus): Promise<TaskAggregate[]> {
    const { rows } = status
      ? await this.db.query<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM tasks
            WHERE owner_id = $1 AND status = $2
            ORDER BY created_at DESC`,
          [userId, status],
        )
      : await this.db.query<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM tasks
            WHERE owner_id = $1
            ORDER BY created_at DESC`,
          [userId],
        );
    return rows.map((row) => TaskAggregate.from(mapTask(row)));
  }

  /** The task with its current version, for a read-modify-write cycle. */
  async getWithVersion(taskId: UUID): Promise<VersionedTask> {
    const aggregate = await this.requireById(taskId);
    return { aggregate, version: aggregate.state.version };
  }

  /**
   * Whether the stored version still matches. Advisory only — a `true` here can
   * be stale by the time you write, which is why {@link save} re-checks
   * atomically. Use it for cheap pre-flight checks, never as the only guard.
   */
  async checkVersion(taskId: UUID, expectedVersion: number): Promise<boolean> {
    const { rows } = await this.db.query<{ version: number | string }>(
      'SELECT version FROM tasks WHERE id = $1',
      [taskId],
    );
    const row = rows[0];
    return row !== undefined && toInt(row.version) === expectedVersion;
  }

  /**
   * Persist the projection and flush pending events in one transaction.
   *
   * New aggregates are INSERTed; existing ones are UPDATEd under
   * `WHERE version = baseVersion`. A zero row count means another writer got
   * there first.
   *
   * @throws {ConcurrencyError} on a version mismatch.
   * @throws {NotFoundError} if the row vanished, or its project/owner FK is dangling.
   */
  async save(aggregate: TaskAggregate): Promise<void> {
    await this.saveAndReturn(aggregate);
  }

  /**
   * {@link save}, returning the aggregate rebased onto the persisted version so
   * the caller can keep working without a re-read.
   */
  async saveAndReturn(aggregate: TaskAggregate): Promise<TaskAggregate> {
    const run = async (
      client: Queryable,
    ): Promise<{ saved: TaskAggregate; appended: AppendedEvent[] }> => {
      if (aggregate.isNew) {
        await this.insert(client, aggregate);
      } else {
        await this.update(client, aggregate);
      }
      const appended = aggregate.hasPendingEvents
        ? await appendAll(client, aggregate.pendingEvents)
        : [];
      return { saved: aggregate.markPersisted(), appended };
    };

    const { saved, appended } = isPool(this.db)
      ? await withTransaction(this.db, run)
      : await run(this.db);

    // Pool-owned path: withTransaction has returned, so COMMIT succeeded.
    // Enlisted path: this is a BufferingPublisher that inUnitOfWork drains
    // after its own COMMIT. Either way nothing escapes before it is durable.
    this.publisher?.publish(appended.map(toPublished));
    return saved;
  }

  private async insert(client: Queryable, aggregate: TaskAggregate): Promise<void> {
    const t = aggregate.state;
    try {
      await client.query(
        `INSERT INTO tasks
             (id, project_id, title, status, owner_id, due_date, version, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::timestamptz, $7, $8::timestamptz)`,
        [
          t.id,
          t.projectId,
          t.title,
          t.status,
          t.ownerId,
          t.dueDate,
          t.version,
          t.createdAt,
        ],
      );
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) {
        // The id already exists: this aggregate believed it was new.
        throw new ConcurrencyError('Task', t.id, undefined, undefined, err);
      }
      translatePgError(err, { entity: 'Task', id: t.id });
    }
  }

  private async update(client: Queryable, aggregate: TaskAggregate): Promise<void> {
    const t = aggregate.state;
    let result: QueryResultLike<TaskRow>;
    try {
      result = await client.query<TaskRow>(
        `UPDATE tasks
            SET title = $2, status = $3, owner_id = $4::uuid,
                due_date = $5::timestamptz, version = $6
          WHERE id = $1::uuid AND version = $7
        RETURNING ${TASK_COLUMNS}`,
        [
          t.id,
          t.title,
          t.status,
          t.ownerId,
          t.dueDate,
          t.version,
          aggregate.baseVersion,
        ],
      );
    } catch (err) {
      translatePgError(err, { entity: 'Task', id: t.id });
    }

    if ((result.rowCount ?? result.rows.length) > 0) return;

    // Nothing matched: either the row is gone, or its version moved.
    const { rows } = await client.query<{ version: number | string }>(
      'SELECT version FROM tasks WHERE id = $1',
      [t.id],
    );
    const current = rows[0];
    if (!current) throw new NotFoundError('Task', t.id);
    throw new ConcurrencyError(
      'Task',
      t.id,
      aggregate.baseVersion,
      toInt(current.version),
    );
  }
}

// =============================================================================
// HandoffRepository
// =============================================================================

/** Reads and writes `handoffs`. */
export class HandoffRepository {
  constructor(private readonly db: Queryable) {}

  /** A repository bound to `client`, for use inside an open transaction. */
  withClient(client: Queryable): HandoffRepository {
    return new HandoffRepository(client);
  }

  /** The handoff, or null when it does not exist. */
  async getById(handoffId: UUID): Promise<HandoffAggregate | null> {
    const { rows } = await this.db.query<HandoffRow>(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs WHERE id = $1`,
      [handoffId],
    );
    const row = rows[0];
    return row ? HandoffAggregate.from(mapHandoff(row)) : null;
  }

  /**
   * The most recent handoff for a task.
   *
   * A task can have many handoffs over its life, so this returns the latest.
   * Use {@link listByTask} for the full transfer history, or
   * {@link getPendingByTask} for the one still awaiting an answer.
   *
   * @throws {NotFoundError} if the task has never been handed off.
   */
  async getByTask(taskId: UUID): Promise<HandoffAggregate> {
    const { rows } = await this.db.query<HandoffRow>(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
        WHERE task_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [taskId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Handoff for task', taskId);
    return HandoffAggregate.from(mapHandoff(row));
  }

  /** Every handoff for a task, newest first. */
  async listByTask(taskId: UUID): Promise<HandoffAggregate[]> {
    const { rows } = await this.db.query<HandoffRow>(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
        WHERE task_id = $1
        ORDER BY created_at DESC`,
      [taskId],
    );
    return rows.map((row) => HandoffAggregate.from(mapHandoff(row)));
  }

  /**
   * The task's open proposal, if any. At most one can exist — enforced by the
   * `handoffs_one_pending_per_task_idx` partial unique index.
   */
  async getPendingByTask(taskId: UUID): Promise<HandoffAggregate | null> {
    const { rows } = await this.db.query<HandoffRow>(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
        WHERE task_id = $1 AND status = $2`,
      [taskId, HandoffStatus.PENDING],
    );
    const row = rows[0];
    return row ? HandoffAggregate.from(mapHandoff(row)) : null;
  }

  /** Proposals awaiting this user's answer, newest first. */
  async getPending(userId: UUID): Promise<HandoffAggregate[]> {
    const { rows } = await this.db.query<HandoffRow>(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
        WHERE to_user_id = $1 AND status = $2
        ORDER BY created_at DESC`,
      [userId, HandoffStatus.PENDING],
    );
    return rows.map((row) => HandoffAggregate.from(mapHandoff(row)));
  }

  /**
   * Insert a new handoff, or resolve an existing PENDING one.
   *
   * `HandoffAggregate` carries no version, so the guard is the status itself:
   * the UPDATE branch only fires while the row is still PENDING. Racing
   * accept/decline calls mean the second one finds a resolved row and fails,
   * which is the correct outcome.
   *
   * @throws {ConcurrencyError} if the handoff was already resolved, or the task
   *   already has a different open proposal.
   * @throws {NotFoundError} if the task or either user does not exist.
   */
  async save(aggregate: HandoffAggregate): Promise<void> {
    const h = aggregate.state;
    let result: QueryResultLike<{ id: string }>;
    try {
      result = await this.db.query<{ id: string }>(
        `INSERT INTO handoffs
             (id, task_id, from_user_id, to_user_id, reason, status, resolution_note, resolved_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::timestamptz, $9::timestamptz)
         ON CONFLICT (id) DO UPDATE
             SET status = EXCLUDED.status,
                 resolution_note = EXCLUDED.resolution_note,
                 resolved_at = EXCLUDED.resolved_at
           WHERE handoffs.status = $10
         RETURNING id`,
        [
          h.id,
          h.taskId,
          h.fromUserId,
          h.toUserId,
          h.reason,
          h.status,
          h.resolutionNote,
          h.resolvedAt,
          h.createdAt,
          HandoffStatus.PENDING,
        ],
      );
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) {
        // Not the primary key (that path is the ON CONFLICT above), so this is
        // the one-pending-per-task index.
        throw new ConcurrencyError(
          'Handoff',
          h.id,
          undefined,
          undefined,
          err,
        );
      }
      translatePgError(err, { entity: 'Handoff', id: h.id });
    }

    if ((result.rowCount ?? result.rows.length) === 0) {
      // The ON CONFLICT ... WHERE guard rejected the update.
      throw new ConcurrencyError('Handoff', h.id);
    }
  }
}

// =============================================================================
// HandoffBriefRepository
// =============================================================================

interface HandoffBriefRow {
  id: string;
  handoff_id: string;
  content: unknown;
  source_event_ids: unknown;
  model: string;
  created_at: Date | string;
}

function mapBrief(row: HandoffBriefRow): HandoffBrief {
  const ids = row.source_event_ids;
  return {
    id: row.id,
    handoffId: row.handoff_id,
    content: toJsonObject(row.content) as unknown as HandoffBriefContent,
    sourceEventIds: Array.isArray(ids) ? (ids as UUID[]) : [],
    model: row.model,
    createdAt: toISO(row.created_at),
  };
}

const BRIEF_COLUMNS = 'id, handoff_id, content, source_event_ids, model, created_at';

/**
 * Reads the AI-generated brief attached to a handoff. Briefs are written by the
 * `handoff-brief` worker, so this layer is read-only.
 */
export class HandoffBriefRepository {
  constructor(private readonly db: Queryable) {}

  withClient(client: Queryable): HandoffBriefRepository {
    return new HandoffBriefRepository(client);
  }

  /** The brief for a handoff, or null when the worker has not produced one yet. */
  async getByHandoffId(handoffId: UUID): Promise<HandoffBrief | null> {
    const { rows } = await this.db.query<HandoffBriefRow>(
      `SELECT ${BRIEF_COLUMNS} FROM handoff_briefs WHERE handoff_id = $1`,
      [handoffId],
    );
    const row = rows[0];
    return row ? mapBrief(row) : null;
  }
}

// =============================================================================
// Unit of work
// =============================================================================

/** The repositories, all bound to one transaction client. */
export interface UnitOfWork {
  client: PoolClientLike;
  events: EventStore;
  tasks: TaskRepository;
  handoffs: HandoffRepository;
  briefs: HandoffBriefRepository;
}

/**
 * Run a callback with all three repositories enlisted in a single transaction.
 *
 * ```ts
 * await inUnitOfWork(pool, async ({ tasks, handoffs }) => {
 *   const task = await tasks.requireById(taskId);
 *   await tasks.save(task.transfer(toUserId, reason, actor));
 *   await handoffs.save(HandoffAggregate.initiate(taskId, actor.userId, toUserId, reason));
 * });
 * ```
 */
export async function inUnitOfWork<T>(
  pool: PoolLike,
  fn: (uow: UnitOfWork) => Promise<T>,
  options?: TransactionOptions & { publisher?: TaskEventPublisher },
): Promise<T> {
  const buffer = new BufferingPublisher();

  const result = await withTransaction(
    pool,
    (client) => {
      // withTransaction may retry the callback; start each attempt with an
      // empty buffer so a retried append is not published twice.
      buffer.reset();
      return fn({
        client,
        events: new EventStore(client, buffer),
        tasks: new TaskRepository(client, undefined, buffer),
        handoffs: new HandoffRepository(client),
        briefs: new HandoffBriefRepository(client),
      });
    },
    options,
  );

  // COMMIT has returned; only now is it safe to tell the world.
  buffer.flushTo(options?.publisher);
  return result;
}
