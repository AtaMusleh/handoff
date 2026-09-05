# API reference

Base URL: `http://localhost:3001` in development (`NEXT_PUBLIC_API_URL`).
All application routes are mounted under `/api`.

## Authentication

Every `/api/*` route requires a bearer token:

```
Authorization: Bearer <jwt>
```

Tokens are HS256, signed with `JWT_SECRET`, with `iss: handoff` and
`aud: handoff-api`. The verifier pins the algorithm and asserts both claims, so
a token minted elsewhere with the same secret will not authenticate here.

Claims:

```json
{
  "sub": "088bf8f8-305c-5a08-b4f2-3509ae8caa81",
  "email": "atamusleh3@gmail.com",
  "name": "Ata Musleh",
  "role": "admin",
  "iss": "handoff",
  "aud": "handoff-api",
  "jti": "…",
  "iat": 1788000000,
  "exp": 1788604800
}
```

The websocket uses the same token, passed in the Socket.IO handshake as
`auth.token`.

### Unauthenticated routes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Liveness. Deliberately above the auth middleware — a health check that needs a token cannot report that auth is broken. |
| `POST` | `/auth/dev-login` | Development only. Returns **404** when `NODE_ENV=production`. |

#### `POST /auth/dev-login`

Issues a session for the seeded development account. Sending a body lets you
sign in as a different seeded user.

```bash
curl -X POST localhost:3001/auth/dev-login -H 'content-type: application/json' -d '{}'
```

```json
{
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs…",
    "user": {
      "id": "088bf8f8-305c-5a08-b4f2-3509ae8caa81",
      "email": "atamusleh3@gmail.com",
      "displayName": "Ata Musleh"
    }
  },
  "meta": { "serverTime": "2026-09-05T21:30:00.000Z", "expiresIn": "7d" }
}
```

If `DEV_LOGIN_KEY` is set, send it as `x-dev-login-key` or receive 401.

## Response envelope

Success:

```json
{ "data": { }, "meta": { "serverTime": "2026-09-05T21:30:00.000Z" } }
```

`meta` carries extras per endpoint — `count`, `hasMore`, `nextCursor`,
`pendingCount`, `briefReady`.

Failure:

```json
{
  "error": { "code": "CONFLICT", "message": "…", "details": { } },
  "meta": { "serverTime": "2026-09-05T21:30:00.000Z" }
}
```

## Error codes

| Status | `error.code` | Raised when |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Zod rejected the body, query, or path params; or a domain `ValidationError` (blank title, transfer to self). `details` is `[{path, message}]`. |
| 401 | `UNAUTHENTICATED` | No `Authorization` header. Message: `Authentication required`. |
| 401 | `UNAUTHENTICATED` | Token invalid, expired, wrong signature, wrong issuer/audience, or `alg` not HS256. Message: `Invalid token`. |
| 403 | `FORBIDDEN` | Authenticated but not the task owner, or not the intended handoff recipient, or not an admin on an admin route. |
| 404 | `NOT_FOUND` | Task, handoff, or a referenced row does not exist. Also every unmatched path. |
| 409 | `CONFLICT` | `expectedVersion` is stale, the optimistic UPDATE matched no rows, the handoff was already resolved, or the task already has a pending handoff. `details` carries `expectedVersion`/`actualVersion`. |
| 422 | `INVALID_STATE_TRANSITION` | The transition matrix refuses the move. `details` carries `{from, to}`. |
| 500 | `INTERNAL_ERROR` | Anything else. The response body is always generic; the cause is logged server-side and never returned. |

## Tasks

### `POST /api/tasks`

```json
{ "title": "Migrate billing", "projectId": "<uuid>", "ownerId": "<uuid>", "dueDate": "2026-09-20T09:00:00Z" }
```

`ownerId` and `dueDate` are optional. Without an owner the task starts in
`BACKLOG`. Returns **201** with a `Location` header.

```json
{
  "data": {
    "id": "<uuid>", "projectId": "<uuid>", "title": "Migrate billing",
    "status": "ASSIGNED", "ownerId": "<uuid>", "dueDate": "2026-09-20T09:00:00.000Z",
    "version": 0, "createdAt": "2026-09-05T21:30:00.000Z",
    "validNextStates": ["IN_PROGRESS", "BACKLOG", "TRANSFERRED"]
  },
  "meta": { "serverTime": "…" }
}
```

`validNextStates` comes from the transition matrix, so a client can render
affordances without reimplementing it.

### `GET /api/tasks?ownerId=&status=&projectId=`

`ownerId` is **required** — a `projectId`-only listing returns 400, because the
repository has no indexed access path for it yet. `status` must be a valid
`TaskStatus`. `projectId` filters the owner's tasks further.

Returns an array of the shape above, with `meta.count`.

### `GET /api/tasks/:id`

```json
{ "data": { "task": { }, "events": [ ] }, "meta": { "serverTime": "…" } }
```

`events` is the full stream in sequence order.

### `GET /api/tasks/:id/history?limit=50&cursor=0`

Cursor pagination over the stream. `cursor` is the last sequence already seen;
`limit` is 1–200, default 50. Returns the events array with
`meta.hasMore` and `meta.nextCursor`. 404 if the task does not exist — an
empty page and a missing task are different answers.

### Transitions

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/tasks/:id/start` | `{ expectedVersion? }` |
| `POST` | `/api/tasks/:id/complete` | `{ note?, expectedVersion? }` |
| `POST` | `/api/tasks/:id/block` | `{ reason, blockedByTaskIds?, expectedVersion? }` — reason required |
| `POST` | `/api/tasks/:id/unblock` | `{ resolution?, expectedVersion? }` |

Each returns the updated task. `expectedVersion` is optional but recommended:
supplying it fails fast with 409 and both version numbers before any write.
Omitting it still gets you the conditional UPDATE, which is the authoritative
guard.

```bash
curl -X POST localhost:3001/api/tasks/$ID/block \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"Waiting on vendor credentials","expectedVersion":3}'
```

## Handoffs

### `POST /api/tasks/:id/transfer`

```json
{ "toUserId": "<uuid>", "reason": "Going on leave", "expectedVersion": 3 }
```

Marks the task `TRANSFERRED` and creates a `PENDING` handoff in one
transaction. **Ownership does not move yet.** Returns 201 with both objects
and a `Location` header pointing at the handoff.

409 if the task already has a pending handoff (`details.pendingHandoffId`).

### `GET /api/tasks/:id/handoffs`

Every handoff for the task, newest first. `meta.pendingCount`.

### `GET /api/handoffs/:id`

The handoff plus its AI brief, or `brief: null` while the worker is still
working. `meta.briefReady` is the boolean.

```json
{
  "data": {
    "id": "<uuid>", "taskId": "<uuid>", "fromUserId": "<uuid>", "toUserId": "<uuid>",
    "reason": "Going on leave", "status": "PENDING",
    "resolutionNote": null, "resolvedAt": null, "createdAt": "…",
    "brief": {
      "id": "<uuid>", "handoffId": "<uuid>", "model": "claude-sonnet-5",
      "sourceEventIds": ["<uuid>", "<uuid>"],
      "content": {
        "objective": "…", "whatHappened": "…",
        "decisions": ["…"], "blockers": ["…"],
        "remainingWork": "…", "suggestedNextAction": "…"
      },
      "createdAt": "…"
    }
  },
  "meta": { "serverTime": "…", "briefReady": true }
}
```

`model` is `"fallback"` when the deterministic brief was stored instead of a
generated one. `sourceEventIds` contains only ids verified against the task's
real stream.

### `POST /api/handoffs/:id/accept`

```json
{ "userId": "<uuid>", "note": "Happy to take it" }
```

Resolves the handoff and moves ownership, in one transaction. `userId` must be
the authenticated caller (or the caller must be an admin), and must be the
handoff's intended recipient — otherwise 403. 409 if already resolved.

### `POST /api/handoffs/:id/decline`

```json
{ "userId": "<uuid>", "reason": "No capacity this sprint" }
```

The task stays `TRANSFERRED` with its previous owner. `reason` is stored as
`resolutionNote`.

## Not implemented

The web client calls these; the server does not serve them yet. Both 404, and
the UI degrades rather than erroring.

| Method | Path | Needed for |
|---|---|---|
| `GET`/`POST` | `/api/tasks/:id/comments` | Comments section (table exists) |
| `GET` | `/api/users?q=` | Transfer/assign autocomplete |
