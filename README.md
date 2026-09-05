# Handoff

Task tracker built around the moment work changes hands.

Most trackers record *that* a task moved to someone else. Handoff records the
whole history as an immutable event stream, and when a task is transferred it
generates a brief for the receiver from that stream — what the goal is, what
already happened, which decisions are settled, what is still blocking, and the
one thing to do next.

```
┌──────────┐   HTTP + WebSocket   ┌──────────┐   Bull queue   ┌────────────────┐
│  web     │◄────────────────────►│   api    │◄──────────────►│ handoff-brief  │
│ Next 15  │                      │ Express  │                │ worker (Claude)│
└──────────┘                      └────┬─────┘                └───────┬────────┘
                                       │                              │
                                  ┌────▼──────┐              ┌────────▼───────┐
                                  │ Postgres  │              │     Redis      │
                                  └───────────┘              └────────────────┘
```

## Quick start

Requires Node 22+, Postgres, and (optionally) Redis.

```bash
git clone <repo> && cd handoff
npm install

cp .env.example .env          # DATABASE_URL is the only one you must set

npm -w @handoff/api run db:migrate
npm -w @handoff/api run db:seed

npm run dev                   # api on :3001, web on :3000
```

Open <http://localhost:3000> and click **Continue as Ata Musleh**. That signs
you in as the seeded development account, which owns two projects, three tasks,
and a pending handoff — so the dashboard has something in it.

Redis is optional for a first run. Without it the API logs a warning and skips
brief notifications; everything else works. To generate real AI briefs, set
`REDIS_URL` and `ANTHROPIC_API_KEY`, then run the worker:

```bash
npm -w @handoff/worker-handoff-brief run dev
```

Without an Anthropic key the worker still produces a brief — a deterministic
one built from the event history.

## Layout

```
apps/web                  Next.js 15 (Pages Router), React 19, Tailwind 4
apps/api                  Express 5, Socket.IO, JWT auth
  src/routes/             REST endpoints
  src/middleware/auth.ts  JWT verification, roles, ownership
  src/realtime/           Socket.IO gateway
  src/repositories/       Event store + repositories
  src/db/                 Pool, migrations runner, seed
packages/domain           Types + transition matrix. No dependencies, no I/O.
workers/handoff-brief     Bull consumer that calls Claude
db/migrations             The authoritative schema
docs/                     Architecture, API, deployment
```

## Architecture in one page

**Event-sourced.** `task_events` is the system of record; `tasks` is a
projection that can be rebuilt from it. Append-only is enforced by database
triggers, not convention. Sequence numbers are allocated server-side under a
row lock, and `version = sequence − 1` holds by construction — replaying a
stream reproduces the projection exactly, and there is a test that says so.

**One transition matrix.** Every legal status change is one row in a table in
`packages/domain`. Nothing else in the codebase compares statuses, and the API
hands `validNextStates` to the client so the UI does not reimplement it.

**Optimistic concurrency.** Writes are guarded by `WHERE version = <loaded
version>`. A lost race is a 409 with both version numbers, not a silent
overwrite.

**Events broadcast after commit, never before.** Repositories inside a unit of
work publish into a buffer that drains only once `COMMIT` returns, so a
rolled-back transaction cannot announce itself.

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, event sourcing, data flow, and what is deliberately not built |
| [docs/API.md](docs/API.md) | Every endpoint, auth header format, error code table |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Environment variables, Vercel, Supabase, Redis |

## Scripts

```bash
npm run dev                              # api + web together
npm -w @handoff/api run db:migrate       # apply pending migrations
npm -w @handoff/api run db:seed          # fixtures (refuses a populated db)
npm -w @handoff/api run db:reset         # drop everything, migrate, seed
npx tsc --noEmit -p tsconfig.json        # typecheck api, domain, worker
npm -w @handoff/web run typecheck        # typecheck web
```

## Status

Working end to end: the domain model, event store, REST API, realtime gateway,
JWT auth, migrations and seed, the brief worker, and the web UI.

Known gaps, each documented where it bites:

- No project membership table, so project-level access is owner-only.
- No `GET /users` endpoint, so the transfer picker falls back to pasting a user id.
- No comments API, though the table and the UI both exist.
- Realtime is single-instance; multiple API instances need a shared event feed.
- `/auth/dev-login` is a stand-in for real sign-in. It is disabled in production.

The append-only triggers, migrations, and seed have been verified against an
in-memory Postgres but **not yet against a real server** — run `db:migrate`
before trusting them.
