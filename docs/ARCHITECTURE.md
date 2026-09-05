# Architecture

Handoff is an event-sourced task tracker built around one idea: when work moves
between people, the receiver should get the *context*, not just the ticket.

## System overview

```
┌─────────────────┐         HTTP + WebSocket        ┌──────────────────────────┐
│  apps/web       │◄───────────────────────────────►│  apps/api                │
│  Next.js 15     │  Bearer JWT on both transports  │  Express 5 + Socket.IO   │
│  Pages Router   │                                 │                          │
└─────────────────┘                                 │  ┌────────────────────┐  │
                                                    │  │ routes/            │  │
┌─────────────────┐                                 │  │ middleware/auth    │  │
│ packages/domain │  imported by all three          │  │ realtime/SocketIO  │  │
│ types +         │◄────────────────────────────────┤  │ repositories/      │  │
│ state machine   │                                 │  └────────┬───────────┘  │
└─────────────────┘                                 └───────────┼──────────────┘
                                                                │
                                          ┌─────────────────────┼──────────────┐
                                          │                     │              │
                                    ┌─────▼──────┐      ┌───────▼───────┐      │
                                    │ PostgreSQL │      │  Redis        │      │
                                    │            │      │  Bull queue + │      │
                                    │ tasks      │      │  pub/sub      │      │
                                    │ task_events│      └───────┬───────┘      │
                                    │ handoffs   │              │              │
                                    │ ...        │              │              │
                                    └─────▲──────┘      ┌───────▼────────────┐ │
                                          │             │ workers/           │ │
                                          └─────────────┤ handoff-brief      │ │
                                                        │ Claude API         │ │
                                                        └────────────────────┘ │
                                                                               │
        brief ready ───► Redis pub/sub ───► API gateway ───► receiver's socket ┘
```

## Event sourcing

`task_events` is the system of record. `tasks` is a **projection** — a cached
current state that can be thrown away and rebuilt.

```
task_events (append-only)                    tasks (projection)
┌──────────────────────────────┐             ┌─────────────────────┐
│ seq 1  TaskCreated           │             │ status  BLOCKED     │
│ seq 2  TaskAssigned  → ata   │  ─replay─►  │ ownerId ata         │
│ seq 3  TaskStarted           │             │ version 3           │
│ seq 4  TaskBlocked  "vendor" │             └─────────────────────┘
└──────────────────────────────┘
```

Three properties hold, and each is enforced rather than assumed:

**Append-only.** Two `BEFORE` triggers on `task_events` reject `UPDATE` and
`DELETE`. The delete guard checks whether the parent task still exists, so the
`ON DELETE CASCADE` from `tasks` can still remove a stream without deadlocking
against its own trigger.

**Gapless ordering.** `sequence` is a per-task counter starting at 1, allocated
server-side as `MAX(sequence) + 1` under a `SELECT ... FOR UPDATE` on the task
row. `UNIQUE (task_id, sequence)` is the backstop: two racing writers get a
loud unique violation rather than a silent interleave.

**Version = sequence − 1.** `TaskCreated` is sequence 1 and leaves the task at
version 0; every later event advances both by one. `replayEvents()` and the
realtime envelope both rely on this, and a test asserts that replaying a
stream reproduces the projection exactly.

That last property is why `dueDate` lives in the `TaskCreated` payload rather
than only on the `tasks` row — a projection-only field would make replay
lossy. Changing a due date later would need its own event type for the same
reason.

### The transition matrix

Every legal status change is one row in `TransitionMatrix` — 11 edges, each
carrying its event type, whether it needs a reason, whether it needs an owner,
and whether a non-owner may take it. Nothing else in the codebase compares
statuses.

```
BACKLOG ──assign──► ASSIGNED ──start──► IN_PROGRESS ──complete──► COMPLETED
   ▲                 │    │                │    ▲                     │
   └──unassign───────┘    │                │    └──unblock── BLOCKED   │
                          │                └──block────────────▲       │
                          ▼                ▼                           │
                      TRANSFERRED ◄────transfer                        │
                          │                                            │
                          └──accept──► ASSIGNED ◄──────reopen──────────┘
```

Reopening returns a task to `IN_PROGRESS` and records a `TaskReopened` event.
There is no separate `REOPENED` status: every consumer — board columns, "open
work" queries, the partial index — would have to treat it identically to
`IN_PROGRESS`.

A transfer does **not** move ownership. It marks the task `TRANSFERRED` while
keeping the previous owner, so a declined handoff still leaves the work with
someone. Ownership moves when the recipient accepts.

## Service boundaries

| Service | Runtime | Owns | Talks to |
|---|---|---|---|
| `apps/web` | Next.js 15 (Pages Router), React 19 | Rendering, optimistic UI, socket subscriptions | API over HTTP + WebSocket |
| `apps/api` | Express 5 + Socket.IO 4.7 | Auth, request validation, transactions, realtime fan-out | Postgres, Redis (subscribe) |
| `workers/handoff-brief` | Node, Bull consumer | Calling Claude, writing briefs | Postgres, Redis (queue + publish) |
| `packages/domain` | Pure TypeScript, zero deps | Types, transition matrix, aggregates | nothing |

`packages/domain` has no I/O and no dependencies. The state machine can be
exercised without a database, and the same types are imported by all three
services, so an event payload shape cannot drift between them.

The **repository layer** takes a structural `Queryable` interface that
`pg.Pool` and `pg.PoolClient` both satisfy. Nothing in `apps/api` imports `pg`
except `db/pool.ts`, which is why the whole layer unit-tests against a fake.

## Data flow

A state change, end to end:

```
1. POST /api/tasks/:id/block          { reason, expectedVersion }
      │
2. requireAuth                        verify JWT (HS256 pinned), set req.user
      │
3. route handler                      Zod-validate body and params
      │
4. TaskRepository.requireById         load projection → TaskAggregate
      │
5. aggregate.block(reason, actor)     transition matrix decides:
      │                                 - is IN_PROGRESS → BLOCKED an edge?
      │                                 - is the actor the owner?
      │                                 - is a reason present?
      │                               returns a NEW aggregate + pending event
      │
6. TaskRepository.save                ── BEGIN ──────────────────────────────┐
      │                                 UPDATE tasks ... WHERE version = base │
      │                                 SELECT id, project_id FOR UPDATE      │
      │                                 INSERT task_events (seq = MAX+1)      │
      │                               ── COMMIT ─────────────────────────────┘
      │
7. publisher.publish(events)          only after COMMIT returns
      │
8. SocketIOGateway.broadcast          → project:<id> and task:<id> rooms
      │                                 per-socket dedupe + gap backfill
      ▼
9. browser                            timeline updates
```

Two details in there matter more than they look:

**Step 6, `WHERE version = base`.** `baseVersion` is the version the aggregate
was *loaded* at, not `state.version`, which has already advanced past the
database. A zero row count means another writer won, and the caller gets 409.

**Step 7, after COMMIT.** Inside a unit of work, repositories publish to a
`BufferingPublisher` that `inUnitOfWork` drains only once `COMMIT` returns, and
resets on each retry attempt. Broadcasting at append time would announce events
that a rollback then erased.

### The brief path

```
transfer committed
   │
   ├─► TaskTransferred event ──► realtime ──► receiver sees the task move
   │
   └─► Bull job (jobId = handoff:<id>, so a replay is a no-op)
          │
          ▼
       worker: load task + events + comments
          │
          ▼
       Claude, structured output, 30s deadline
          │        │
          │        └── timeout / refusal / unusable → deterministic fallback
          │                                            built from the stream
          ▼
       verify citations against the real event ids, drop invented ones
          │
          ▼
       UPSERT handoff_briefs  ──►  Redis publish  ──►  API  ──►  receiver
```

A brief is always produced. Only two failures are fatal: the handoff cannot be
loaded, or the row cannot be written. A slow or refusing model yields the
fallback and the job *succeeds* — retrying three times just delays a brief the
receiver could already be reading.

## What is not built

Documented so nobody goes looking:

- **No project membership.** `projects.user_id` is a single owner, so realtime
  project rooms and `canViewProject` are owner-only. Multi-member projects need
  a `project_members` table.
- **No `GET /users`.** The transfer picker falls back to pasting a user id.
- **No comments API.** The `comments` table and the UI both exist; the route
  does not. The UI renders "not available yet" on the 404.
- **Single-instance realtime.** `InProcessEventBus` only sees its own process's
  writes. Multiple API instances need the Socket.IO Redis adapter plus a shared
  feed — Postgres `LISTEN`/`NOTIFY` on `task_events` is the natural fit, since
  `NOTIFY` is itself transactional.
- **No refresh tokens.** A JWT lasts `JWT_EXPIRY` and then you sign in again.
