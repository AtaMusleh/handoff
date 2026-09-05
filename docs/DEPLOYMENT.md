# Deployment

## Environment variables

Full annotated list in [`.env.example`](../.env.example). Which service needs
what:

| Variable | web | api | worker | Notes |
|---|:--:|:--:|:--:|---|
| `DATABASE_URL` | | ● | ● | Also needed by `db:migrate` / `db:seed` |
| `PGPOOL_MAX` | | ○ | ○ | Default 10 per pool |
| `API_PORT` | | ● | | Default 3001 |
| `NODE_ENV` | ● | ● | ● | `production` changes auth and reset behaviour |
| `CORS_ORIGIN` | | ● | | Comma-separated websocket origins |
| `WS_PORT` | | ○ | | Only for a standalone gateway |
| `JWT_SECRET` | | ● | | **Required in production**; the API refuses to boot without it |
| `JWT_EXPIRY` | | ○ | | Default `7d` |
| `DEV_LOGIN_KEY` | | ○ | | Gates `/auth/dev-login` on shared dev boxes |
| `ALLOW_REMOTE_DB_RESET` | | ○ | | Guard for `db:reset` against a non-local host |
| `NEXT_PUBLIC_API_URL` | ● | | | **Baked in at build time** |
| `NEXT_PUBLIC_WS_URL` | ● | | | Baked in at build time |
| `NEXT_PUBLIC_DEV_USER_ID` | ○ | | | Pre-fills the dev sign-in |
| `NEXT_PUBLIC_DEV_PROJECT_ID` | ○ | | | Pre-fills the create-task form |
| `WEB_PORT` | ○ | | | Dev server port, default 3000 |
| `REDIS_URL` | | ● | ● | Bull queue; API subscribes for brief notifications |
| `ANTHROPIC_API_KEY` | | | ● | Without it the worker writes fallback briefs |
| `ANTHROPIC_MODEL` | | | ○ | Default `claude-opus-5` |
| `ANTHROPIC_EFFORT` | | | ○ | Default `low` |
| `BRIEF_TIMEOUT_MS` | | | ○ | Default 30000 |
| `BRIEF_MAX_TOKENS` | | | ○ | Default 8000 |
| `BRIEF_ATTEMPTS` | | | ○ | Bull attempts, default 3 |
| `BRIEF_BACKOFF_MS` | | | ○ | Default 2000 |

● required ○ optional

`NEXT_PUBLIC_*` are inlined by Next at **build** time, not read at runtime.
Changing one means rebuilding, not restarting.

## What can go on Vercel, and what cannot

**`apps/web` fits Vercel well.** It is a standard Next.js app.

**`apps/api` does not.** This is worth being blunt about rather than writing
steps that will not work:

- It holds **persistent WebSocket connections** via Socket.IO. Vercel's
  serverless functions are request-scoped and terminate; they cannot hold a
  socket open. The gateway also keeps per-connection state (each socket's
  last-delivered sequence per task) in process memory.
- It subscribes to **Redis pub/sub** for the whole process lifetime.
- `InProcessEventBus` fans out only within one process, so even if functions
  could hold sockets, each invocation would see only its own writes.

**`workers/handoff-brief` does not either** — a Bull consumer is a long-running
process, not a request handler.

So: web on Vercel, API and worker on something that runs a process — Railway,
Render, Fly.io, an EC2 box, or a container platform. If everything must be on
Vercel, the realtime layer has to be replaced with a hosted service (Pusher,
Ably, Supabase Realtime) and the worker with a queue that has an HTTP consumer
(QStash, Inngest).

### `apps/web` on Vercel

1. Import the repository. Set **Root Directory** to `apps/web`.
2. Vercel detects Next.js. Because this is an npm workspace, override the
   install command to install from the repo root:
   - Install Command: `npm install --prefix ../..`
   - Build Command: `npm run build`
3. Environment variables (Production and Preview):
   ```
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com
   NEXT_PUBLIC_WS_URL=https://api.yourdomain.com
   ```
   Use `https://`, not `wss://` — Socket.IO derives the websocket URL itself.
4. Deploy, then set `CORS_ORIGIN` on the API to the resulting web origin.

`transpilePackages: ['@handoff/domain']` is already set in
`next.config.mjs`, which is what lets the workspace package ship TypeScript
source.

### API and worker on a process host

```bash
npm ci
npm -w @handoff/api run db:migrate      # once per deploy, before traffic
npm -w @handoff/api start               # API
npm -w @handoff/worker-handoff-brief run dev   # worker (separate process)
```

Both need `DATABASE_URL` and `REDIS_URL`; the API additionally needs
`JWT_SECRET` or it will refuse to start.

## Postgres on Supabase

### Connection strings

Supabase gives you two, and the difference matters here:

| Port | Mode | Use for |
|---|---|---|
| 5432 | Session (direct) | **Migrations** |
| 6543 | Transaction (pooler) | Application traffic |

Run migrations against **5432**. The migration runner takes a
`pg_advisory_lock`, which is *session*-scoped — under transaction pooling the
connection can be handed to someone else between statements and the lock is
meaningless. The application itself is fine on 6543: every multi-statement
operation is already wrapped in an explicit transaction.

```bash
# migrations — direct connection
DATABASE_URL='postgresql://postgres:PW@db.PROJECT.supabase.co:5432/postgres' \
  npm -w @handoff/api run db:migrate

# application — pooler
DATABASE_URL='postgresql://postgres.PROJECT:PW@aws-0-REGION.pooler.supabase.com:6543/postgres'
```

With the pooler, keep `PGPOOL_MAX` small (2–5 per instance) — you are pooling
in front of a pooler.

### TLS

Supabase terminates TLS with a chain Node does not trust by default, so a plain
connection fails with `SELF_SIGNED_CERT_IN_CHAIN`. For development, append:

```
?sslmode=no-verify
```

`db/pool.ts` reads this and sets `rejectUnauthorized: false`. It encrypts the
connection but does not authenticate the server, so it stops eavesdropping and
not an active man-in-the-middle. For production, download Supabase's CA
certificate and use `sslmode=verify-full` instead.

## Redis

Required for the brief worker (Bull queue) and for the API to receive
"brief ready" notifications.

- Without `REDIS_URL`, the **worker refuses to start** and the **API logs a
  warning and runs without brief notifications**. Everything else works.
- Bull needs a Redis that supports blocking commands and keyspace operations.
  Upstash's REST API will not do; its TCP endpoint will. Managed Redis on
  Railway, Render, or ElastiCache is fine.
- The API opens a **dedicated subscriber connection** — a Redis client in
  subscriber mode cannot issue other commands — so budget two connections per
  API instance plus the worker's.

## Deploy order

1. Provision Postgres and Redis.
2. `db:migrate` against the **direct** (5432) connection.
3. `db:seed` if this is a fresh development or demo database. It refuses to run
   when users already exist.
4. Start the API with `JWT_SECRET` set.
5. Start the worker.
6. Build and deploy the web app with `NEXT_PUBLIC_API_URL` pointing at the API.
7. Set `CORS_ORIGIN` on the API to the web origin.

## Production checklist

- [ ] `JWT_SECRET` set to at least 32 characters (`openssl rand -base64 48`). The
      API will not start otherwise, which is the intended behaviour.
- [ ] `NODE_ENV=production`, which also makes `/auth/dev-login` return 404.
- [ ] `CORS_ORIGIN` set to the real web origin, not `*`.
- [ ] Migrations applied before traffic reaches the new build.
- [ ] `sslmode=verify-full` rather than `no-verify`.
- [ ] Exactly one API instance, or the realtime layer replaced — see
      [ARCHITECTURE.md](./ARCHITECTURE.md#what-is-not-built).
