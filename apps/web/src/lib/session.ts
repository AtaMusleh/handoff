/**
 * Who the browser believes it is.
 *
 * A stand-in for real authentication, which does not exist in this codebase
 * yet: the API reads `req.user` from middleware that has still to be written.
 * The id is read from an env var or localStorage so the stack can be run
 * end-to-end during development.
 *
 * This is NOT authentication. Anyone can set it. Replace it with a real session
 * before this is exposed to anyone.
 */

const STORAGE_KEY = 'handoff.dev.userId';
const PROJECT_KEY = 'handoff.dev.projectId';

function read(key: string, fallback: string | undefined): string | null {
  if (typeof window === 'undefined') return fallback ?? null;
  try {
    return window.localStorage.getItem(key) ?? fallback ?? null;
  } catch {
    // Private mode or blocked storage: fall back rather than crash the app.
    return fallback ?? null;
  }
}

export function getCurrentUserId(): string | null {
  return read(STORAGE_KEY, process.env.NEXT_PUBLIC_DEV_USER_ID);
}

export function setCurrentUserId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* non-fatal */
  }
}

export function getCurrentProjectId(): string | null {
  return read(PROJECT_KEY, process.env.NEXT_PUBLIC_DEV_PROJECT_ID);
}

export function setCurrentProjectId(id: string): void {
  try {
    window.localStorage.setItem(PROJECT_KEY, id);
  } catch {
    /* non-fatal */
  }
}
