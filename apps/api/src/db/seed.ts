/**
 * Development seed data.
 *
 * Every id is a deterministic UUID v5 derived from a stable name, so the same
 * rows get the same ids on every machine and every reset. That makes fixtures
 * quotable in tests and bug reports ("task alice-blocked-1") and lets the seed
 * be re-run without duplicating anything.
 *
 * Refuses to run against a database that already has users, so it cannot
 * quietly scribble over real data.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

import { EventType, HandoffStatus, TaskStatus } from '@handoff/domain';
import { DEV_ACCOUNT, seedIds, uuidv5 } from './ids';
import { createScriptPool, redact, requireDatabaseUrl } from './pool';

// =============================================================================
// Deterministic ids
// =============================================================================

// Identifiers come from ./ids so that dev-login and the seed cannot disagree
// about which row the development account is.
const id = seedIds;

// =============================================================================
// Fixture data
// =============================================================================

/** Fixed clock so timestamps are reproducible. */
const T0 = Date.parse('2026-08-01T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** `at(n)` is n hours after the base instant. */
const at = (hours: number): string => new Date(T0 + hours * HOUR).toISOString();
const days = (n: number): string => new Date(T0 + n * DAY).toISOString();

/**
 * Fixture users.
 *
 * The first is the account `POST /auth/dev-login` issues tokens for, so that
 * signing in during development lands on an account that owns real data rather
 * than an empty one.
 */
const USERS = [
  { slug: DEV_ACCOUNT.slug, email: DEV_ACCOUNT.email, displayName: DEV_ACCOUNT.displayName },
  { slug: 'bob', email: 'bob@example.com', displayName: 'Bob Osei' },
  { slug: 'charlie', email: 'charlie@example.com', displayName: 'Charlie Duval' },
] as const;

const PROJECTS = [
  { slug: 'billing', name: 'Billing platform', owner: DEV_ACCOUNT.slug },
  { slug: 'onboarding', name: 'Customer onboarding', owner: DEV_ACCOUNT.slug },
] as const;

type EventSpec = {
  type: EventType;
  actor: string | null;
  payload: Record<string, unknown>;
  /** Hours after T0. */
  hour: number;
};

type TaskSpec = {
  slug: string;
  project: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  dueDays: number | null;
  events: EventSpec[];
};

/**
 * Ten tasks covering every non-terminal state plus COMPLETED and TRANSFERRED.
 *
 * Each task's events are a real, valid path through the transition matrix, and
 * `status`/`version` below are what replaying those events produces — the seed
 * would otherwise create rows the domain could never have reached.
 */
const TASKS: TaskSpec[] = [
  {
    slug: 'billing-gateway',
    project: 'billing',
    title: 'Migrate billing to the new payment gateway',
    status: TaskStatus.BLOCKED,
    owner: DEV_ACCOUNT.slug,
    dueDays: 14,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 0, payload: { title: 'Migrate billing to the new payment gateway', projectId: '@project:billing' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 1, payload: { fromOwnerId: null, toOwnerId: '@user:ata' } },
      { type: EventType.TaskStarted, actor: DEV_ACCOUNT.slug, hour: 2, payload: { ownerId: '@user:ata' } },
      { type: EventType.TaskBlocked, actor: DEV_ACCOUNT.slug, hour: 26, payload: { reason: 'Waiting on vendor sandbox credentials.' } },
    ],
  },
  {
    slug: 'billing-refunds',
    project: 'billing',
    title: 'Support partial refunds',
    status: TaskStatus.IN_PROGRESS,
    owner: 'bob',
    dueDays: 21,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 3, payload: { title: 'Support partial refunds', projectId: '@project:billing' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 4, payload: { fromOwnerId: null, toOwnerId: '@user:bob' } },
      { type: EventType.TaskStarted, actor: 'bob', hour: 6, payload: { ownerId: '@user:bob' } },
    ],
  },
  {
    slug: 'billing-invoices',
    project: 'billing',
    title: 'Generate monthly invoice PDFs',
    status: TaskStatus.COMPLETED,
    owner: 'bob',
    dueDays: null,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 5, payload: { title: 'Generate monthly invoice PDFs', projectId: '@project:billing' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 5, payload: { fromOwnerId: null, toOwnerId: '@user:bob' } },
      { type: EventType.TaskStarted, actor: 'bob', hour: 7, payload: { ownerId: '@user:bob' } },
      { type: EventType.TaskCompleted, actor: 'bob', hour: 30, payload: { note: 'Shipped behind a feature flag.' } },
    ],
  },
  {
    slug: 'billing-dunning',
    project: 'billing',
    title: 'Dunning emails for failed charges',
    status: TaskStatus.BACKLOG,
    owner: null,
    dueDays: null,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 8, payload: { title: 'Dunning emails for failed charges', projectId: '@project:billing' } },
    ],
  },
  {
    slug: 'billing-tax',
    project: 'billing',
    title: 'EU VAT calculation',
    status: TaskStatus.ASSIGNED,
    owner: 'charlie',
    dueDays: 30,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 9, payload: { title: 'EU VAT calculation', projectId: '@project:billing' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 10, payload: { fromOwnerId: null, toOwnerId: '@user:charlie' } },
    ],
  },
  {
    slug: 'billing-audit',
    project: 'billing',
    title: 'Audit log for billing changes',
    status: TaskStatus.TRANSFERRED,
    owner: DEV_ACCOUNT.slug,
    dueDays: 10,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 11, payload: { title: 'Audit log for billing changes', projectId: '@project:billing' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 11, payload: { fromOwnerId: null, toOwnerId: '@user:ata' } },
      { type: EventType.TaskStarted, actor: DEV_ACCOUNT.slug, hour: 12, payload: { ownerId: '@user:ata' } },
      { type: EventType.TaskTransferred, actor: DEV_ACCOUNT.slug, hour: 33, payload: { handoffId: '@handoff:audit-pending', fromUserId: '@user:ata', toUserId: '@user:bob', reason: 'Heading on leave; you have the most context on the audit trail.' } },
    ],
  },
  {
    slug: 'onboarding-wizard',
    project: 'onboarding',
    title: 'Rebuild the signup wizard',
    status: TaskStatus.IN_PROGRESS,
    owner: 'charlie',
    dueDays: 7,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 13, payload: { title: 'Rebuild the signup wizard', projectId: '@project:onboarding' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 13, payload: { fromOwnerId: null, toOwnerId: '@user:charlie' } },
      { type: EventType.TaskStarted, actor: 'charlie', hour: 14, payload: { ownerId: '@user:charlie' } },
      { type: EventType.TaskBlocked, actor: 'charlie', hour: 18, payload: { reason: 'Design tokens not finalized.' } },
      { type: EventType.TaskUnblocked, actor: 'charlie', hour: 34, payload: { resolution: 'Design signed off the tokens.', resumedStatus: TaskStatus.IN_PROGRESS } },
    ],
  },
  {
    slug: 'onboarding-emails',
    project: 'onboarding',
    title: 'Welcome email sequence',
    status: TaskStatus.ASSIGNED,
    owner: 'bob',
    dueDays: 3,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 15, payload: { title: 'Welcome email sequence', projectId: '@project:onboarding' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 16, payload: { fromOwnerId: null, toOwnerId: '@user:charlie' } },
      { type: EventType.TaskTransferred, actor: 'charlie', hour: 20, payload: { handoffId: '@handoff:emails-accepted', fromUserId: '@user:charlie', toUserId: '@user:bob', reason: 'You own the messaging templates.' } },
      { type: EventType.TaskAssigned, actor: 'bob', hour: 21, payload: { fromOwnerId: '@user:charlie', toOwnerId: '@user:bob' } },
    ],
  },
  {
    slug: 'onboarding-import',
    project: 'onboarding',
    title: 'CSV contact import',
    status: TaskStatus.BACKLOG,
    owner: null,
    dueDays: null,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 17, payload: { title: 'CSV contact import', projectId: '@project:onboarding' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 18, payload: { fromOwnerId: null, toOwnerId: '@user:bob' } },
      { type: EventType.TaskUnassigned, actor: 'bob', hour: 19, payload: { previousOwnerId: '@user:bob', reason: 'Deprioritized this sprint.' } },
    ],
  },
  {
    slug: 'onboarding-checklist',
    project: 'onboarding',
    title: 'In-app setup checklist',
    status: TaskStatus.BLOCKED,
    owner: DEV_ACCOUNT.slug,
    dueDays: 5,
    events: [
      { type: EventType.TaskCreated, actor: DEV_ACCOUNT.slug, hour: 22, payload: { title: 'In-app setup checklist', projectId: '@project:onboarding' } },
      { type: EventType.TaskAssigned, actor: DEV_ACCOUNT.slug, hour: 22, payload: { fromOwnerId: null, toOwnerId: '@user:ata' } },
      { type: EventType.TaskStarted, actor: DEV_ACCOUNT.slug, hour: 23, payload: { ownerId: '@user:ata' } },
      { type: EventType.TaskBlocked, actor: DEV_ACCOUNT.slug, hour: 35, payload: { reason: 'Blocked on the analytics events shipping first.' } },
    ],
  },
];

const COMMENTS = [
  { slug: 'c1', task: 'billing-gateway', author: 'bob', hour: 27, body: 'Vendor says the sandbox should be up Monday.' },
  { slug: 'c2', task: 'billing-gateway', author: DEV_ACCOUNT.slug, hour: 28, body: 'Thanks — I will pick it back up as soon as it is.' },
  { slug: 'c3', task: 'onboarding-wizard', author: DEV_ACCOUNT.slug, hour: 19, body: 'Design tokens are in Figma now.' },
  { slug: 'c4', task: 'billing-refunds', author: 'charlie', hour: 8, body: 'Watch out for currency rounding on partial amounts.' },
  { slug: 'c5', task: 'onboarding-emails', author: 'bob', hour: 22, body: 'Taking this on — templates are mostly ready.' },
] as const;

const HANDOFFS = [
  {
    slug: 'audit-pending',
    task: 'billing-audit',
    from: DEV_ACCOUNT.slug,
    to: 'bob',
    reason: 'Heading on leave; you have the most context on the audit trail.',
    status: HandoffStatus.PENDING,
    hour: 33,
    resolutionNote: null as string | null,
    resolvedHour: null as number | null,
  },
  {
    slug: 'emails-accepted',
    task: 'onboarding-emails',
    from: 'charlie',
    to: 'bob',
    reason: 'You own the messaging templates.',
    status: HandoffStatus.ACCEPTED,
    hour: 20,
    resolutionNote: 'Happy to take it.',
    resolvedHour: 21,
  },
] as const;

/** One brief, on the pending handoff, so the UI has something to render. */
const BRIEFS = [
  {
    slug: 'audit-pending',
    handoff: 'audit-pending',
    model: 'seed',
    content: {
      objective: 'Add an audit log covering every billing configuration change.',
      whatHappened:
        'Alice scoped the audit trail and started implementation, then handed it over before finishing.',
      decisions: [
        'Reuse the existing task_events append-only pattern rather than a new mechanism.',
      ],
      blockers: [],
      remainingWork: 'Finish the writer and add coverage for the admin endpoints.',
      suggestedNextAction: 'Read the existing task_events triggers, then continue the writer.',
    },
    sourceEvents: [1, 2, 3, 4] as const,
  },
] as const;

// =============================================================================
// Seeding
// =============================================================================

/** Resolve `@user:ata` / `@project:billing` / `@handoff:x` placeholders. */
function resolveRefs(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('@')) {
    const [kind, slug] = value.slice(1).split(':');
    if (kind === 'user') return id.user(slug!);
    if (kind === 'project') return id.project(slug!);
    if (kind === 'handoff') return id.handoff(slug!);
    if (kind === 'task') return id.task(slug!);
    throw new Error(`Unknown seed reference: ${value}`);
  }
  if (Array.isArray(value)) return value.map(resolveRefs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveRefs(v)]),
    );
  }
  return value;
}

export interface SeedOptions {
  pool?: Pool;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Seed even if the database already has users. */
  force?: boolean;
}

export interface SeedResult {
  seeded: boolean;
  counts: Record<string, number>;
}

/**
 * Insert the fixtures, in one transaction.
 *
 * No-op when users already exist unless `force` is set — the guard is there so
 * `db:seed` cannot be run against a real database by accident.
 */
export async function seed(options: SeedOptions = {}): Promise<SeedResult> {
  const log = options.logger ?? console;
  const ownsPool = !options.pool;
  const pool = options.pool ?? createScriptPool();

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM users');
    const existing = Number.parseInt(rows[0]?.count ?? '0', 10);
    if (existing > 0 && !options.force) {
      log.warn(
        `[seed] database already has ${existing} user(s); skipping. ` +
          'Use db:reset to rebuild, or pass --force to seed anyway.',
      );
      return { seeded: false, counts: {} };
    }

    await client.query('BEGIN');
    const counts = await insertAll(client);
    await client.query('COMMIT');

    log.log('[seed] inserted ' + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
    log.log(`[seed] ${DEV_ACCOUNT.displayName} = ${id.user(DEV_ACCOUNT.slug)}`);
    log.log(`[seed] billing project = ${id.project('billing')}`);
    return { seeded: true, counts };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection is already unusable */
    }
    throw err;
  } finally {
    client.release();
    if (ownsPool) await pool.end();
  }
}

async function insertAll(client: PoolClient): Promise<Record<string, number>> {
  // --- users ---------------------------------------------------------------
  for (const u of USERS) {
    await client.query(
      `INSERT INTO users (id, email, display_name, created_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [id.user(u.slug), u.email, u.displayName, at(-24)],
    );
  }

  // --- projects ------------------------------------------------------------
  for (const p of PROJECTS) {
    await client.query(
      `INSERT INTO projects (id, user_id, name, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [id.project(p.slug), id.user(p.owner), p.name, at(-12)],
    );
  }

  // --- tasks ---------------------------------------------------------------
  for (const t of TASKS) {
    // version is derived, not invented: replaying n events leaves a task at
    // version n-1, the same invariant the aggregate and replayEvents rely on.
    const version = t.events.length - 1;
    await client.query(
      `INSERT INTO tasks
           (id, project_id, title, status, owner_id, due_date, version, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::timestamptz, $7, $8::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        id.task(t.slug),
        id.project(t.project),
        t.title,
        t.status,
        t.owner ? id.user(t.owner) : null,
        t.dueDays === null ? null : days(t.dueDays),
        version,
        at(t.events[0]!.hour),
      ],
    );
  }

  // --- handoffs (before the events that cite them) -------------------------
  for (const h of HANDOFFS) {
    await client.query(
      `INSERT INTO handoffs
           (id, task_id, from_user_id, to_user_id, reason, status, resolution_note,
            resolved_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
               $8::timestamptz, $9::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        id.handoff(h.slug),
        id.task(h.task),
        id.user(h.from),
        id.user(h.to),
        h.reason,
        h.status,
        h.resolutionNote,
        h.resolvedHour === null ? null : at(h.resolvedHour),
        at(h.hour),
      ],
    );
  }

  // --- events --------------------------------------------------------------
  let eventCount = 0;
  for (const t of TASKS) {
    let sequence = 0;
    for (const e of t.events) {
      sequence += 1;
      await client.query(
        `INSERT INTO task_events (id, task_id, type, actor_id, payload, sequence, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb, $6, $7::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          id.event(t.slug, sequence),
          id.task(t.slug),
          e.type,
          e.actor ? id.user(e.actor) : null,
          JSON.stringify(resolveRefs(e.payload)),
          sequence,
          at(e.hour),
        ],
      );
      eventCount += 1;
    }
  }

  // --- comments ------------------------------------------------------------
  for (const c of COMMENTS) {
    await client.query(
      `INSERT INTO comments (id, task_id, author_id, body, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [id.comment(c.slug), id.task(c.task), id.user(c.author), c.body, at(c.hour)],
    );
  }

  // --- briefs --------------------------------------------------------------
  for (const b of BRIEFS) {
    const taskSlug = HANDOFFS.find((h) => h.slug === b.handoff)!.task;
    await client.query(
      `INSERT INTO handoff_briefs (id, handoff_id, content, source_event_ids, model, created_at)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::jsonb, $5, $6::timestamptz)
       ON CONFLICT (handoff_id) DO NOTHING`,
      [
        id.brief(b.slug),
        id.handoff(b.handoff),
        JSON.stringify(b.content),
        JSON.stringify(b.sourceEvents.map((s) => id.event(taskSlug, s))),
        b.model,
        at(34),
      ],
    );
  }

  return {
    users: USERS.length,
    projects: PROJECTS.length,
    tasks: TASKS.length,
    events: eventCount,
    comments: COMMENTS.length,
    handoffs: HANDOFFS.length,
    briefs: BRIEFS.length,
  };
}

/** Exposed so tests and tooling can reference the fixtures by name. */
export { seedIds, uuidv5 };
export const seedFixtures = { USERS, PROJECTS, TASKS, COMMENTS, HANDOFFS, BRIEFS };

// =============================================================================
// CLI
// =============================================================================

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

// An async IIFE rather than top-level await: top-level await makes the module
// ESM-async, which means it cannot be require()d or imported from a CommonJS
// build. The CLI behaviour is identical, and the module stays importable.
if (isMain()) {
  void (async () => {
    try {
      console.log(`[seed] database ${redact(requireDatabaseUrl())}`);
      await seed({ force: process.argv.includes('--force') });
    } catch (err) {
      console.error('\n[seed] failed\n', err, '\n');
      process.exit(1);
    }
  })();
}
