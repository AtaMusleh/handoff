/**
 * Postgres connection pool.
 *
 * One place that reads `DATABASE_URL` and fails loudly when it is missing, so
 * every entrypoint gets the same error rather than a driver-level "connection
 * refused to localhost" that hides the real cause.
 */

import { Pool, type PoolConfig } from 'pg';

/** Raised when the environment cannot produce a usable connection. */
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
    Object.setPrototypeOf(this, DatabaseConfigError.prototype);
  }
}

/**
 * Read `DATABASE_URL`, or fail with something actionable.
 *
 * @throws {DatabaseConfigError}
 */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new DatabaseConfigError(
      'DATABASE_URL is not set.\n' +
        '  Copy .env.example to .env and fill it in, or export it directly:\n' +
        '    export DATABASE_URL=postgresql://user:password@localhost:5432/handoff_dev',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new DatabaseConfigError(
      `DATABASE_URL does not look like a Postgres URL: ${redact(url)}\n` +
        '  Expected something starting with postgresql://',
    );
  }
  return url;
}

/** Strip credentials so a URL can safely appear in a log line. */
export function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+)(:[^@/]*)?@/, '//$1:***@');
}

export interface CreatePoolOptions {
  /** Overrides `DATABASE_URL`. */
  connectionString?: string;
  /** Max connections. Default 10, or 1 for one-shot scripts. */
  max?: number;
  /** Applied to `PoolConfig` verbatim. */
  overrides?: PoolConfig;
}

/**
 * A pool sized for a long-lived service.
 *
 * Pool size wants to be a deliberate choice: too many API instances times too
 * many connections each will exhaust `max_connections` on the server long
 * before the application is saturated. `PGPOOL_MAX` overrides the default.
 *
 * TLS is enabled for non-local hosts, since most managed providers require it
 * and reject plaintext.
 */
export function createPool(options: CreatePoolOptions = {}): Pool {
  const connectionString = options.connectionString ?? requireDatabaseUrl();
  const max =
    options.max ?? Number.parseInt(process.env.PGPOOL_MAX ?? '', 10) ?? 10;

  const pool = new Pool({
    connectionString,
    max: Number.isInteger(max) && max > 0 ? max : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(needsTls(connectionString) ? { ssl: { rejectUnauthorized: true } } : {}),
    ...options.overrides,
  });

  // An idle client erroring (server restart, network blip) emits on the pool.
  // Without a listener Node treats it as an unhandled 'error' event and exits.
  pool.on('error', (err) => {
    console.error('[db] idle client error', err);
  });

  return pool;
}

/** A single-connection pool for one-shot scripts like migrate and seed. */
export function createScriptPool(connectionString?: string): Pool {
  return createPool({ connectionString, max: 1 });
}

function needsTls(connectionString: string): boolean {
  if (/\bsslmode=disable\b/.test(connectionString)) return false;
  if (/\bsslmode=(require|verify-ca|verify-full)\b/.test(connectionString)) return true;
  try {
    const host = new URL(connectionString).hostname;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return false;
  }
}
