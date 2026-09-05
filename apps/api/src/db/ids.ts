/**
 * Deterministic identifiers for seeded fixtures.
 *
 * Lives apart from `seed.ts` so that code needing a fixture id — the dev-login
 * endpoint, for instance — can import it without pulling in the seed's Postgres
 * dependency and its whole fixture set. One derivation, one namespace, no
 * chance of two files disagreeing about what Ata's id is.
 */

import { createHash } from 'node:crypto';

/**
 * Fixed namespace for this project's seed data. Any UUID works as long as it
 * never changes: change it and every seeded id changes with it.
 */
export const SEED_NAMESPACE = '6f9619ff-8b86-d011-b42d-00c04fc964ff';

/**
 * RFC 4122 UUID v5 (SHA-1, name-based).
 *
 * Implemented here rather than pulled in as a dependency: it is a dozen lines,
 * and it is verified against the published test vectors.
 */
export function uuidv5(name: string, namespace: string = SEED_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error(`Invalid UUID namespace: ${namespace}`);

  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Fixture ids, keyed by the slugs used in `seed.ts`. */
export const seedIds = {
  user: (slug: string) => uuidv5(`user:${slug}`),
  project: (slug: string) => uuidv5(`project:${slug}`),
  task: (slug: string) => uuidv5(`task:${slug}`),
  event: (taskSlug: string, seq: number) => uuidv5(`event:${taskSlug}:${seq}`),
  comment: (slug: string) => uuidv5(`comment:${slug}`),
  handoff: (slug: string) => uuidv5(`handoff:${slug}`),
  brief: (slug: string) => uuidv5(`brief:${slug}`),
};

/**
 * The primary development account.
 *
 * `POST /auth/dev-login` issues a token for this user, and the seed inserts a
 * row with exactly this id — so signing in lands on an account that already
 * owns projects, tasks, and a pending handoff.
 */
export const DEV_ACCOUNT = {
  slug: 'ata',
  id: seedIds.user('ata'),
  email: 'atamusleh3@gmail.com',
  displayName: 'Ata Musleh',
} as const;
