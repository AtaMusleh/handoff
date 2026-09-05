/**
 * Migration runner.
 *
 * Applies every `db/migrations/NNN_*.sql` file that has not run yet, in
 * numeric order, each in its own transaction.
 *
 * Design rules:
 *
 *   * One transaction per migration. A failure rolls that migration back
 *     entirely; migrations already applied stay applied.
 *   * A session advisory lock serializes concurrent runners, so two instances
 *     starting at once during a rolling deploy cannot apply the same migration
 *     twice or interleave halfway.
 *   * Applied migrations are checksummed. Editing a file that has already run
 *     is a mistake the runner refuses to paper over — every database would be
 *     in a different state from the file that claims to describe it.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

import { createScriptPool, redact, requireDatabaseUrl } from './pool';

// =============================================================================
// Errors
// =============================================================================

export enum MigrationErrorCode {
  DISCOVERY_FAILED = 'DISCOVERY_FAILED',
  CHECKSUM_MISMATCH = 'CHECKSUM_MISMATCH',
  APPLY_FAILED = 'APPLY_FAILED',
  LOCK_TIMEOUT = 'LOCK_TIMEOUT',
}

export abstract class MigrationError extends Error {
  abstract readonly code: MigrationErrorCode;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The migrations directory is missing, unreadable, or badly named. */
export class MigrationDiscoveryError extends MigrationError {
  readonly code = MigrationErrorCode.DISCOVERY_FAILED;
}

/** An already-applied migration file has been edited since it ran. */
export class MigrationChecksumError extends MigrationError {
  readonly code = MigrationErrorCode.CHECKSUM_MISMATCH;

  constructor(
    readonly migration: string,
    readonly applied: string,
    readonly current: string,
  ) {
    super(
      `Migration "${migration}" has changed since it was applied.\n` +
        `  recorded checksum: ${applied}\n` +
        `  current checksum:  ${current}\n` +
        '  Applied migrations are immutable. Add a new migration with the\n' +
        '  change instead of editing this one. If the edit was cosmetic and\n' +
        '  you are certain every database already matches, update the recorded\n' +
        `  checksum: UPDATE migrations_log SET checksum = '${current}' WHERE name = '${migration}';`,
    );
  }
}

/** A migration threw. It has been rolled back. */
export class MigrationApplyError extends MigrationError {
  readonly code = MigrationErrorCode.APPLY_FAILED;

  constructor(
    readonly migration: string,
    cause: unknown,
  ) {
    super(
      `Migration "${migration}" failed and was rolled back.\n` +
        `  ${describe(cause)}`,
      cause,
    );
  }
}

/** Another runner is holding the lock. */
export class MigrationLockError extends MigrationError {
  readonly code = MigrationErrorCode.LOCK_TIMEOUT;
}

function describe(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { message?: string; detail?: string; hint?: string; position?: string };
  return [
    e.message ?? String(err),
    e.detail ? `detail: ${e.detail}` : null,
    e.hint ? `hint: ${e.hint}` : null,
    e.position ? `position: ${e.position}` : null,
  ]
    .filter(Boolean)
    .join('\n  ');
}

// =============================================================================
// Discovery
// =============================================================================

export interface MigrationFile {
  /** Numeric prefix, used for ordering. */
  id: number;
  /** File name, e.g. `001_create_tables.sql`. Unique key in the log. */
  name: string;
  sql: string;
  checksum: string;
}

/** `NNN_description.sql`, at least three digits. */
const MIGRATION_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

/** Default location: `db/migrations/` at the repository root. */
export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/api/src/db -> repo root
  return path.resolve(here, '..', '..', '..', '..', 'db', 'migrations');
}

export async function discoverMigrations(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new MigrationDiscoveryError(
      `Could not read the migrations directory: ${dir}`,
      err,
    );
  }

  const sqlFiles = entries.filter((f) => f.endsWith('.sql'));
  const migrations: MigrationFile[] = [];
  const seen = new Map<number, string>();

  for (const name of sqlFiles) {
    const match = MIGRATION_PATTERN.exec(name);
    if (!match) {
      throw new MigrationDiscoveryError(
        `Migration file "${name}" does not match NNN_snake_case.sql ` +
          '(for example 002_add_project_members.sql).',
      );
    }
    const id = Number.parseInt(match[1]!, 10);
    const clash = seen.get(id);
    if (clash) {
      // Two migrations with the same number apply in an order that depends on
      // the filesystem, which is not an order at all.
      throw new MigrationDiscoveryError(
        `Duplicate migration number ${match[1]}: "${clash}" and "${name}".`,
      );
    }
    seen.set(id, name);

    const sql = await readFile(path.join(dir, name), 'utf8');
    migrations.push({ id, name, sql, checksum: sha256(sql) });
  }

  return migrations.sort((a, b) => a.id - b.id);
}

/** Normalized so line endings alone do not invalidate a checksum. */
function sha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

// =============================================================================
// Log table
// =============================================================================

const LOG_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS migrations_log (
    id          INTEGER      PRIMARY KEY,
    name        VARCHAR(200) NOT NULL UNIQUE,
    checksum    CHAR(64)     NOT NULL,
    duration_ms INTEGER      NOT NULL,
    applied_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);`;

/**
 * Advisory lock key. Any fixed 64-bit value works; this one is arbitrary but
 * stable, and namespaced to this application so it cannot collide with another
 * system sharing the database.
 */
const LOCK_KEY = 8_274_119_004_551_233n;

interface LogRow {
  id: number;
  name: string;
  checksum: string;
  applied_at: Date | string;
}

// =============================================================================
// Runner
// =============================================================================

export interface MigrateOptions {
  dir?: string;
  pool?: Pool;
  logger?: Pick<Console, 'log' | 'error' | 'warn'>;
  /** Report what would run, change nothing. */
  dryRun?: boolean;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply pending migrations.
 *
 * @throws {MigrationChecksumError} if an applied migration file has changed.
 * @throws {MigrationApplyError} if a migration fails; it is rolled back first.
 */
export async function migrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const log = options.logger ?? console;
  const dir = options.dir ?? defaultMigrationsDir();
  const ownsPool = !options.pool;
  const pool = options.pool ?? createScriptPool();

  const files = await discoverMigrations(dir);
  if (files.length === 0) {
    log.warn(`[migrate] no migration files found in ${dir}`);
    return { applied: [], skipped: [] };
  }

  const client = await pool.connect();
  let locked = false;

  try {
    await client.query(LOG_TABLE_DDL);

    // Serialize concurrent runners. Session-scoped, so it is held across the
    // per-migration transactions below and released in `finally`.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY.toString()]);
    locked = true;

    const { rows } = await client.query<LogRow>(
      'SELECT id, name, checksum, applied_at FROM migrations_log ORDER BY id',
    );
    const appliedByName = new Map(rows.map((r) => [r.name, r]));

    // Verify history before applying anything: a tampered earlier migration
    // means the database does not match the files, and continuing would build
    // on a foundation nobody can reproduce.
    for (const file of files) {
      const record = appliedByName.get(file.name);
      if (record && record.checksum !== file.checksum) {
        throw new MigrationChecksumError(file.name, record.checksum, file.checksum);
      }
    }

    const pending = files.filter((f) => !appliedByName.has(f.name));
    const skipped = files.filter((f) => appliedByName.has(f.name)).map((f) => f.name);

    if (pending.length === 0) {
      log.log(`[migrate] up to date (${skipped.length} already applied)`);
      return { applied: [], skipped };
    }

    if (options.dryRun) {
      log.log(`[migrate] dry run - ${pending.length} pending:`);
      for (const f of pending) log.log(`  - ${f.name}`);
      return { applied: [], skipped };
    }

    const applied: string[] = [];
    for (const file of pending) {
      log.log(`[migrate] applying ${file.name}`);
      const startedAt = Date.now();

      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          `INSERT INTO migrations_log (id, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [file.id, file.name, file.checksum, durationMs],
        );
        await client.query('COMMIT');
        applied.push(file.name);
        log.log(`[migrate] applied ${file.name} in ${durationMs}ms`);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          log.error('[migrate] rollback failed; connection may be unusable', rollbackErr);
        }
        // Stop here. Later migrations may assume this one succeeded.
        throw new MigrationApplyError(file.name, err);
      }
    }

    log.log(`[migrate] done - ${applied.length} applied, ${skipped.length} already up to date`);
    return { applied, skipped };
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()]);
      } catch {
        // Session end releases it anyway.
      }
    }
    client.release();
    if (ownsPool) await pool.end();
  }
}

/** Applied migrations, oldest first. */
export async function migrationStatus(
  pool: Pool,
): Promise<Array<{ name: string; appliedAt: string }>> {
  const { rows } = await pool.query<LogRow>(
    'SELECT id, name, checksum, applied_at FROM migrations_log ORDER BY id',
  );
  return rows.map((r) => ({
    name: r.name,
    appliedAt:
      r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at),
  }));
}

// =============================================================================
// CLI
// =============================================================================

/** True when this module is the process entrypoint. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

// An async IIFE rather than top-level await, which would make this module
// ESM-async and therefore impossible to require() or import from a CommonJS
// build. See the same note in seed.ts.
if (isMain()) {
  void (async () => {
    const dryRun = process.argv.includes('--dry-run');
    try {
      console.log(`[migrate] database ${redact(requireDatabaseUrl())}`);
      await migrate({ dryRun });
    } catch (err) {
      if (err instanceof MigrationError) {
        console.error(`\n[migrate] ${err.name}\n${err.message}\n`);
      } else {
        console.error('\n[migrate] unexpected failure\n', err, '\n');
      }
      process.exit(1);
    }
  })();
}
