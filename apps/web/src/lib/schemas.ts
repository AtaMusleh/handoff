/**
 * Zod schemas for everything crossing the network boundary.
 *
 * The API is typed, but a deploy skew or a proxy rewriting a body will happily
 * hand the browser something else. Every response is parsed here, so a shape
 * change surfaces as one legible error instead of an `undefined` three
 * components deep.
 *
 * The `satisfies` clauses tie each schema to the shared `@handoff/domain` types:
 * if the domain changes and a schema is not updated, this file stops compiling.
 */

import { z } from 'zod';
import {
  EventType,
  HandoffStatus,
  TaskStatus,
  type Comment,
  type Handoff,
  type HandoffBrief,
  type Task,
  type TaskEvent,
} from '@handoff/domain';

const uuid = z.string().min(1);
const iso = z.string();

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------

export const metaSchema = z
  .object({ serverTime: iso })
  .catchall(z.unknown());

/** Wrap a payload schema in the API's `{ data, meta }` envelope. */
export function envelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: metaSchema });
}

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  meta: metaSchema,
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

// -----------------------------------------------------------------------------
// Entities
// -----------------------------------------------------------------------------

export const taskSchema = z.object({
  id: uuid,
  projectId: uuid,
  title: z.string(),
  status: z.enum(TaskStatus),
  ownerId: uuid.nullable(),
  dueDate: iso.nullable(),
  version: z.number().int(),
  createdAt: iso,
});

/** The API adds `validNextStates` so the UI need not reimplement the matrix. */
export const taskResponseSchema = taskSchema.extend({
  validNextStates: z.array(z.enum(TaskStatus)),
});

export type TaskResponse = z.infer<typeof taskResponseSchema>;

const _taskShape = null as unknown as z.infer<typeof taskSchema> satisfies Task;

// --- events ------------------------------------------------------------------

const eventBase = {
  id: uuid,
  taskId: uuid,
  actorId: uuid.nullable(),
  sequence: z.number().int(),
  createdAt: iso,
};

/**
 * Discriminated union over `type`, mirroring the domain's `TaskEvent`.
 * Narrowing on `event.type` narrows `event.payload`.
 */
export const taskEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskCreated),
    payload: z.object({
      title: z.string(),
      projectId: uuid,
      ownerId: uuid.optional(),
      dueDate: iso.nullish(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskAssigned),
    payload: z.object({ fromOwnerId: uuid.nullable(), toOwnerId: uuid }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskStarted),
    payload: z.object({ ownerId: uuid }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskUnassigned),
    payload: z.object({ previousOwnerId: uuid, reason: z.string().optional() }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskBlocked),
    payload: z.object({
      reason: z.string(),
      blockedByTaskIds: z.array(uuid).optional(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskUnblocked),
    payload: z.object({
      resolution: z.string(),
      // Narrower than TaskStatus: the domain only ever resumes into these two.
      resumedStatus: z.enum([TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS]).optional(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskTransferred),
    payload: z.object({
      handoffId: uuid,
      fromUserId: uuid.nullable(),
      toUserId: uuid,
      reason: z.string().nullable(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskCompleted),
    payload: z.object({ note: z.string().optional() }),
  }),
  z.object({
    ...eventBase,
    type: z.literal(EventType.TaskReopened),
    payload: z.object({ reason: z.string(), ownerId: uuid }),
  }),
]);

export type TaskEventDto = z.infer<typeof taskEventSchema>;

// Compile-time proof the wire union still lines up with the domain union.
const _eventShape = null as unknown as TaskEventDto satisfies TaskEvent;

// --- handoffs ----------------------------------------------------------------

export const handoffBriefContentSchema = z.object({
  objective: z.string(),
  whatHappened: z.string(),
  decisions: z.array(z.string()),
  blockers: z.array(z.string()),
  remainingWork: z.string(),
  suggestedNextAction: z.string(),
  confidence: z.number().optional(),
});

export const handoffBriefSchema = z.object({
  id: uuid,
  handoffId: uuid,
  content: handoffBriefContentSchema,
  sourceEventIds: z.array(uuid),
  model: z.string(),
  createdAt: iso,
});

const _briefShape = null as unknown as z.infer<typeof handoffBriefSchema> satisfies HandoffBrief;

export const handoffSchema = z.object({
  id: uuid,
  taskId: uuid,
  fromUserId: uuid.nullable(),
  toUserId: uuid,
  reason: z.string().nullable(),
  status: z.enum(HandoffStatus),
  resolutionNote: z.string().nullable(),
  resolvedAt: iso.nullable(),
  createdAt: iso,
});

const _handoffShape = null as unknown as z.infer<typeof handoffSchema> satisfies Handoff;

export const handoffDetailSchema = handoffSchema.extend({
  brief: handoffBriefSchema.nullable(),
});

export type HandoffDto = z.infer<typeof handoffSchema>;
export type HandoffDetailDto = z.infer<typeof handoffDetailSchema>;
export type HandoffBriefDto = z.infer<typeof handoffBriefSchema>;

// --- comments ----------------------------------------------------------------

export const commentSchema = z.object({
  id: uuid,
  taskId: uuid,
  authorId: uuid.nullable(),
  body: z.string(),
  createdAt: iso,
});

const _commentShape = null as unknown as z.infer<typeof commentSchema> satisfies Comment;
export type CommentDto = z.infer<typeof commentSchema>;

// --- users -------------------------------------------------------------------

/**
 * Trimmed user projection for pickers and avatars. The API does not expose a
 * user endpoint yet — see `listUsers` in `lib/api.ts`.
 */
export const userSummarySchema = z.object({
  id: uuid,
  email: z.string(),
  displayName: z.string(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;

// -----------------------------------------------------------------------------
// Response schemas
// -----------------------------------------------------------------------------

export const taskDetailSchema = z.object({
  task: taskResponseSchema,
  events: z.array(taskEventSchema),
});

export const taskListResponse = envelope(z.array(taskResponseSchema));
export const taskResponse = envelope(taskResponseSchema);
export const taskDetailResponse = envelope(taskDetailSchema);
export const historyResponse = envelope(z.array(taskEventSchema));
export const handoffDetailResponse = envelope(handoffDetailSchema);
export const handoffListResponse = envelope(z.array(handoffSchema));
export const transferResponse = envelope(
  z.object({ handoff: handoffSchema, task: taskResponseSchema }),
);
export const acceptResponse = transferResponse;
export const commentListResponse = envelope(z.array(commentSchema));
export const commentResponse = envelope(commentSchema);
export const userListResponse = envelope(z.array(userSummarySchema));
