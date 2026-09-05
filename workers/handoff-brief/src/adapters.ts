/**
 * Production adapters for the brief worker: Postgres for context and storage,
 * Redis pub/sub for realtime notifications.
 *
 * Kept apart from `worker.ts` so the generator can be unit-tested with fakes
 * and no infrastructure.
 */

import type { Pool } from 'pg';
import type Redis from 'ioredis';

import {
  isEventType,
  type HandoffBriefContent,
  type TaskEvent,
  type UUID,
} from '@handoff/domain';
import {
  ContextUnavailableError,
  type BriefContext,
  type BriefNotifier,
  type BriefStore,
  type CommentInput,
  type ContextLoader,
  type Logger,
} from './worker';

// =============================================================================
// Postgres
// =============================================================================

interface HandoffRow {
  id: string;
  task_id: string;
  from_user_id: string | null;
  to_user_id: string;
  reason: string | null;
  task_title: string;
  task_status: string;
}

interface EventRow {
  id: string;
  task_id: string;
  type: string;
  actor_id: string | null;
  payload: unknown;
  sequence: number | string;
  created_at: Date | string;
}

interface CommentRow {
  id: string;
  author_id: string | null;
  body: string;
  created_at: Date | string;
}

const toISO = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

const toInt = (v: number | string): number =>
  typeof v === 'number' ? v : Number.parseInt(v, 10);

/** Reads handoff context from Postgres. */
export class PgContextLoader implements ContextLoader {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: Logger,
  ) {}

  async load(handoffId: UUID): Promise<BriefContext> {
    const { rows } = await this.pool.query<HandoffRow>(
      `SELECT h.id, h.task_id, h.from_user_id, h.to_user_id, h.reason,
              t.title AS task_title, t.status AS task_status
         FROM handoffs h
         JOIN tasks t ON t.id = h.task_id
        WHERE h.id = $1`,
      [handoffId],
    );

    const handoff = rows[0];
    if (!handoff) {
      throw new ContextUnavailableError(`Handoff ${handoffId} was not found.`);
    }

    const [events, comments] = await Promise.all([
      this.loadEvents(handoff.task_id),
      this.loadComments(handoff.task_id),
    ]);

    return {
      handoffId: handoff.id,
      taskId: handoff.task_id,
      taskTitle: handoff.task_title,
      taskStatus: handoff.task_status,
      fromUserId: handoff.from_user_id,
      toUserId: handoff.to_user_id,
      transferReason: handoff.reason,
      events,
      comments,
      decisions: [],
    };
  }

  private async loadEvents(taskId: UUID): Promise<TaskEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT id, task_id, type, actor_id, payload, sequence, created_at
         FROM task_events
        WHERE task_id = $1
        ORDER BY sequence ASC`,
      [taskId],
    );

    const events: TaskEvent[] = [];
    for (const row of rows) {
      if (!isEventType(row.type)) {
        // An unknown type means the enum and the CHECK constraint have drifted.
        // Skip it rather than failing the whole brief over one row.
        this.logger?.warn(`skipping event ${row.id} with unknown type "${row.type}"`);
        continue;
      }
      events.push({
        id: row.id,
        taskId: row.task_id,
        type: row.type,
        actorId: row.actor_id,
        payload: row.payload,
        sequence: toInt(row.sequence),
        createdAt: toISO(row.created_at),
      } as TaskEvent);
    }
    return events;
  }

  private async loadComments(taskId: UUID): Promise<CommentInput[]> {
    const { rows } = await this.pool.query<CommentRow>(
      `SELECT id, author_id, body, created_at
         FROM comments
        WHERE task_id = $1
        ORDER BY created_at ASC`,
      [taskId],
    );
    return rows.map((r) => ({
      id: r.id,
      authorId: r.author_id,
      body: r.body,
      createdAt: toISO(r.created_at),
    }));
  }
}

/** Writes briefs to `handoff_briefs`. */
export class PgBriefStore implements BriefStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert on `handoff_id`.
   *
   * The table has a UNIQUE constraint there — one brief per handoff — so a
   * regeneration replaces the previous row rather than colliding with it.
   */
  async save(input: {
    handoffId: UUID;
    content: HandoffBriefContent;
    sourceEventIds: UUID[];
    model: string;
  }): Promise<{ id: UUID }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO handoff_briefs (handoff_id, content, source_event_ids, model)
       VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4)
       ON CONFLICT (handoff_id) DO UPDATE
           SET content = EXCLUDED.content,
               source_event_ids = EXCLUDED.source_event_ids,
               model = EXCLUDED.model,
               created_at = now()
       RETURNING id`,
      [
        input.handoffId,
        JSON.stringify(input.content),
        JSON.stringify(input.sourceEventIds),
        input.model,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error(`Upserting the brief for ${input.handoffId} returned no row.`);
    return { id: row.id };
  }
}

// =============================================================================
// Redis notifications
// =============================================================================

/** Channel the API's Socket.IO gateway subscribes to. */
export const BRIEF_EVENTS_CHANNEL = 'handoff:brief-events';

export type BriefEventMessage =
  | {
      type: 'HandoffBriefReady';
      handoffId: UUID;
      taskId: UUID;
      toUserId: UUID;
      briefId: UUID;
      aiGenerated: boolean;
    }
  | {
      type: 'BriefGenerationFailed';
      handoffId: UUID;
      taskId: UUID;
      toUserId: UUID;
      reason: string;
    };

/**
 * Publishes brief outcomes over Redis pub/sub.
 *
 * The worker is a separate process from the API, so it cannot call the
 * Socket.IO gateway directly. The API subscribes to {@link BRIEF_EVENTS_CHANNEL}
 * and forwards to the receiver's personal room:
 *
 * ```ts
 * // in the API process, once the gateway is attached
 * const sub = new Redis(process.env.REDIS_URL!);
 * await sub.subscribe(BRIEF_EVENTS_CHANNEL);
 * sub.on('message', (_channel, raw) => {
 *   const msg = JSON.parse(raw) as BriefEventMessage;
 *   if (msg.type === 'HandoffBriefReady') {
 *     gateway.notifyBriefReady({
 *       toUserId: msg.toUserId,
 *       taskId: msg.taskId,
 *       handoffId: msg.handoffId,
 *     });
 *   }
 * });
 * ```
 *
 * A dedicated connection is required: a Redis client in subscriber mode cannot
 * run other commands.
 */
export class RedisBriefNotifier implements BriefNotifier {
  constructor(
    private readonly redis: Redis,
    private readonly logger?: Logger,
  ) {}

  async briefReady(input: {
    handoffId: UUID;
    taskId: UUID;
    toUserId: UUID;
    briefId: UUID;
    aiGenerated: boolean;
  }): Promise<void> {
    await this.publish({ type: 'HandoffBriefReady', ...input });
  }

  async briefFailed(input: {
    handoffId: UUID;
    taskId: UUID;
    toUserId: UUID;
    reason: string;
  }): Promise<void> {
    await this.publish({ type: 'BriefGenerationFailed', ...input });
  }

  private async publish(message: BriefEventMessage): Promise<void> {
    await this.redis.publish(BRIEF_EVENTS_CHANNEL, JSON.stringify(message));
    this.logger?.info(`published ${message.type}`, { handoffId: message.handoffId });
  }
}

/** Notifier that does nothing. For tests and single-process development. */
export class NoopNotifier implements BriefNotifier {
  async briefReady(): Promise<void> {}
  async briefFailed(): Promise<void> {}
}
