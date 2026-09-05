/**
 * Typed API client.
 *
 * Every response is validated with Zod before it reaches a component, and every
 * non-2xx is turned into an {@link ApiError} carrying the server's error code —
 * so callers can branch on `CONFLICT` or `INVALID_STATE_TRANSITION` rather than
 * matching on message text.
 */

import { z } from 'zod';
import type { TaskStatus } from '@handoff/domain';
import { getAuthToken } from './session';
import {
  acceptResponse,
  apiErrorSchema,
  commentListResponse,
  commentResponse,
  envelope,
  handoffSchema,
  handoffDetailResponse,
  handoffListResponse,
  historyResponse,
  taskDetailResponse,
  taskListResponse,
  taskResponse,
  transferResponse,
  userListResponse,
  type CommentDto,
  type HandoffDetailDto,
  type HandoffDto,
  type TaskEventDto,
  type TaskResponse,
  type UserSummary,
} from './schemas';

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';

/** A non-2xx response, or a body that failed validation. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** True when the server said the caller's view of the task is stale. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** True when the endpoint is not implemented server-side yet. */
  get isUnavailable(): boolean {
    return this.status === 404 || this.status === 501;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * Overrides the stored bearer token. Rarely needed; the token from
   * `lib/session` is used by default.
   */
  token?: string;
  /**
   * Retained so existing call sites compile. It no longer authenticates
   * anything - the API verifies a JWT and ignores this.
   *
   * @deprecated Pass a token, or rely on the stored session.
   */
  actorId?: string;
}

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  init: RequestInit & RequestOptions = {},
): Promise<z.infer<T>> {
  const { actorId: _ignored, token, signal, ...rest } = init;
  const bearer = token ?? getAuthToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    signal,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...rest.headers,
    },
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'MALFORMED_RESPONSE', 'Response was not valid JSON.');
    }
  }

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details,
      );
    }
    throw new ApiError(res.status, 'UNKNOWN', `Request failed with status ${res.status}.`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // A shape mismatch is a deploy-skew bug, not a user error. Fail loudly.
    throw new ApiError(
      res.status,
      'SCHEMA_MISMATCH',
      `Unexpected response shape from ${path}.`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

// -----------------------------------------------------------------------------
// Tasks
// -----------------------------------------------------------------------------

export interface ListTasksParams {
  ownerId: string;
  status?: TaskStatus;
  projectId?: string;
}

export async function listTasks(
  params: ListTasksParams,
  opts?: RequestOptions,
): Promise<TaskResponse[]> {
  const q = new URLSearchParams({ ownerId: params.ownerId });
  if (params.status) q.set('status', params.status);
  if (params.projectId) q.set('projectId', params.projectId);
  const { data } = await request(`/tasks?${q}`, taskListResponse, opts);
  return data;
}

export async function getTask(
  id: string,
  opts?: RequestOptions,
): Promise<{ task: TaskResponse; events: TaskEventDto[] }> {
  const { data } = await request(`/tasks/${id}`, taskDetailResponse, opts);
  return data;
}

export async function getHistory(
  id: string,
  params: { limit?: number; cursor?: number } = {},
  opts?: RequestOptions,
): Promise<TaskEventDto[]> {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', String(params.cursor));
  const { data } = await request(`/tasks/${id}/history?${q}`, historyResponse, opts);
  return data;
}

export async function createTask(
  body: { title: string; projectId: string; ownerId?: string },
  opts?: RequestOptions,
): Promise<TaskResponse> {
  const { data } = await request('/tasks', taskResponse, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}

/** Every transition endpoint shares this shape. */
async function transition(
  id: string,
  action: 'start' | 'complete' | 'block' | 'unblock',
  body: Record<string, unknown>,
  opts?: RequestOptions,
): Promise<TaskResponse> {
  const { data } = await request(`/tasks/${id}/${action}`, taskResponse, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}

export const startTask = (id: string, expectedVersion?: number, o?: RequestOptions) =>
  transition(id, 'start', { expectedVersion }, o);

export const completeTask = (
  id: string,
  args: { note?: string; expectedVersion?: number },
  o?: RequestOptions,
) => transition(id, 'complete', args, o);

export const blockTask = (
  id: string,
  args: { reason: string; expectedVersion?: number },
  o?: RequestOptions,
) => transition(id, 'block', args, o);

export const unblockTask = (
  id: string,
  args: { resolution?: string; expectedVersion?: number },
  o?: RequestOptions,
) => transition(id, 'unblock', args, o);

// -----------------------------------------------------------------------------
// Handoffs
// -----------------------------------------------------------------------------

export async function transferTask(
  taskId: string,
  body: { toUserId: string; reason?: string | null; expectedVersion?: number },
  opts?: RequestOptions,
): Promise<{ handoff: HandoffDto; task: TaskResponse }> {
  const { data } = await request(`/tasks/${taskId}/transfer`, transferResponse, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}

export async function getHandoff(
  id: string,
  opts?: RequestOptions,
): Promise<HandoffDetailDto> {
  const { data } = await request(`/handoffs/${id}`, handoffDetailResponse, opts);
  return data;
}

export async function listTaskHandoffs(
  taskId: string,
  opts?: RequestOptions,
): Promise<HandoffDto[]> {
  const { data } = await request(`/tasks/${taskId}/handoffs`, handoffListResponse, opts);
  return data;
}

export async function acceptHandoff(
  id: string,
  body: { userId: string; note?: string },
  opts?: RequestOptions,
): Promise<{ handoff: HandoffDto; task: TaskResponse }> {
  const { data } = await request(`/handoffs/${id}/accept`, acceptResponse, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}

const declineResponse = envelope(handoffSchema);

export async function declineHandoff(
  id: string,
  body: { userId: string; reason?: string },
  opts?: RequestOptions,
): Promise<HandoffDto> {
  const { data } = await request(`/handoffs/${id}/decline`, declineResponse, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}

// -----------------------------------------------------------------------------
// Not yet implemented server-side
// -----------------------------------------------------------------------------

/**
 * Comments for a task.
 *
 * The `comments` table exists, but the API exposes no route for it yet. These
 * calls are written against the endpoint the rest of the API implies; until it
 * is added they return 404, which the UI renders as an unavailable state rather
 * than an error.
 */
export async function listComments(
  taskId: string,
  opts?: RequestOptions,
): Promise<CommentDto[]> {
  const { data } = await request(`/tasks/${taskId}/comments`, commentListResponse, opts);
  return data;
}

export async function addComment(
  taskId: string,
  body: { body: string },
  opts?: RequestOptions,
): Promise<CommentDto> {
  const { data } = await request(`/tasks/${taskId}/comments`, commentResponse, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}

/**
 * User search, for the assign and transfer pickers.
 *
 * Also not implemented server-side. The pickers fall back to accepting a raw
 * user id when this is unavailable, so transfers still work.
 */
export async function listUsers(
  query: string,
  opts?: RequestOptions,
): Promise<UserSummary[]> {
  const q = new URLSearchParams({ q: query });
  const { data } = await request(`/users?${q}`, userListResponse, opts);
  return data;
}

// -----------------------------------------------------------------------------
// Development login
// -----------------------------------------------------------------------------

const devLoginResponse = z.object({
  data: z.object({
    token: z.string(),
    user: z.object({ id: z.string(), email: z.string(), displayName: z.string() }),
  }),
  meta: z.object({ serverTime: z.string() }).catchall(z.unknown()),
});

export type DevLoginResult = z.infer<typeof devLoginResponse>['data'];

/**
 * Exchange nothing for a development session.
 *
 * Backed by `POST /auth/dev-login`, which the API serves only outside
 * production and which 404s otherwise. Not a login flow - a stand-in until one
 * exists.
 */
export async function devLogin(
  body: { id?: string; email?: string; displayName?: string } = {},
): Promise<DevLoginResult> {
  const res = await fetch(`${API_BASE}/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      res.status === 404 ? 'DEV_LOGIN_DISABLED' : 'UNKNOWN',
      res.status === 404
        ? 'Development login is not available on this server.'
        : `Development login failed (${res.status}).`,
    );
  }
  const parsed = devLoginResponse.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new ApiError(res.status, 'SCHEMA_MISMATCH', 'Unexpected dev-login response.');
  }
  return parsed.data.data;
}
