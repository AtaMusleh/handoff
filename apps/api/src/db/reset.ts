/**
 * Drop everything this application owns, then migrate and seed.
 *
 * Destructive by design and therefore guarded: it refuses to run when
 * `NODE_ENV=production`, and refuses to touch a non-local host unless
 * `ALLOW_REMOTE_DB_RESET=yes` is set. A `db:reset` fired at a staging URL by
 * accident is a bad afternoon.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

import { createScriptPool, redact, requireDatabaseUrl } from './pool';
import { migrate } from './migrate';
import { seed } from './seed';

export class UnsafeResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeResetError';
    Object.setPrototypeOf(this, UnsafeResetError.prototype);
  }
}

function assertSafe(databaseUrl: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new UnsafeResetError('Refusing to reset the database with NODE_ENV=production.');
  }

  let host = '';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new UnsafeResetError(`Could not parse DATABASE_URL: ${redact(databaseUrl)}`);
  }

  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal && process.env.ALLOW_REMOTE_DB_RESET !== 'yes') {
    throw new UnsafeResetError(
      `Refusing to reset a non-local database (${host}).\n` +
        '  If you are certain, set ALLOW_REMOTE_DB_RESET=yes.',
    );
  }
}

/**
 * Drop every table in the public schema.
 *
 * Generated from the catalog rather than a hard-coded list, so a table added by
 * a later migration is not silently left behind. CASCADE takes the foreign
 * keys, triggers, and indexes with it.
 */
export async function dropAllTables(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
  );
  const tables = rows.map((r) => r.tablename);
  if (tables.length === 0) return [];

  const quoted = tables.map((t) => `"${t.replace(/"/g, '""')}"`).join(', ');
  await pool.query(`DROP TABLE IF EXISTS ${quoted} CASCADE`);

  // Trigger functions are not owned by any table, so CASCADE leaves them.
  await pool.query(`
    DO $$
    DECLARE fn record;
    BEGIN
      FOR fn IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = current_schema()
           AND p.prokind = 'f'
           AND pg_get_function_result(p.oid) = 'trigger'
      LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || fn.sig || ' CASCADE';
      END LOOP;
    END $$;
  `);

  return tables;
}

export async function reset(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  assertSafe(databaseUrl);

  const pool = createScriptPool(databaseUrl);
  try {
    console.log(`[reset] dropping all tables in ${redact(databaseUrl)}`);
    const dropped = await dropAllTables(pool);
    console.log(
      dropped.length ? `[reset] dropped ${dropped.length}: ${dropped.join(', ')}` : '[reset] nothing to drop',
    );

    // Reuse the pool so migrate and seed do not each open their own.
    await migrate({ pool });
    await seed({ pool });
    console.log('[reset] done');
  } finally {
    await pool.end();
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

// Async IIFE rather than top-level await; see the note in seed.ts.
if (isMain()) {
  void (async () => {
    try {
      await reset();
    } catch (err) {
      if (err instanceof UnsafeResetError) {
        console.error(`\n[reset] ${err.message}\n`);
      } else {
        console.error('\n[reset] failed\n', err, '\n');
      }
      process.exit(1);
    }
  })();
}
