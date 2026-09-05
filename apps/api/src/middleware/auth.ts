/**
 * Authentication and authorization middleware.
 *
 * Design rules:
 *
 *   * The verifier pins the signing algorithm. Accepting whatever `alg` the
 *     token declares is the classic JWT forgery route (`alg: none`, or an
 *     RS256 public key replayed as an HS256 secret), and `jsonwebtoken` will
 *     not stop it unless told which algorithms are acceptable.
 *   * There is no usable fallback secret in production. The development secret
 *     below is a literal in a source file, so anything signed with it is
 *     forgeable by anyone who can read this repository; the process refuses to
 *     start in production without a real `JWT_SECRET`.
 *   * Nothing here logs a token, a secret, or a token fragment. Failures are
 *     reported by class, never by echoing the credential.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';

import type { UUID } from '@handoff/domain';
import { DEV_ACCOUNT } from '../db/ids';
import type { Queryable } from '../repositories/EventStore';

// =============================================================================
// Session types
// =============================================================================

export type Role = 'user' | 'admin';

/** The authenticated caller, as reconstructed from a verified token. */
export interface SessionUser {
  id: UUID;
  email: string;
  displayName: string;
  role: Role;
}

/**
 * Claims carried in the token.
 *
 * `sub` holds the user id, per RFC 7519, rather than a bespoke `userId` claim.
 */
export interface HandoffJwtClaims {
  sub: UUID;
  email: string;
  name: string;
  role: Role;
  /** Issued-at and expiry are added by the signer. */
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present once a valid token has been verified; null on public routes. */
      user?: SessionUser | null;
      /** True when {@link requireAuth} or {@link optionalAuth} verified a token. */
      isAuthenticated?: boolean;
    }
  }
}

// =============================================================================
// Errors
// =============================================================================

export enum AuthErrorCode {
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  FORBIDDEN = 'FORBIDDEN',
  MISCONFIGURED = 'MISCONFIGURED',
}

export abstract class AuthError extends Error {
  abstract readonly code: AuthErrorCode;
  abstract readonly status: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No credential was presented. */
export class UnauthenticatedError extends AuthError {
  readonly code = AuthErrorCode.UNAUTHENTICATED;
  readonly status = 401;

  constructor(message = 'Authentication required') {
    super(message);
  }
}

/** A credential was presented but is not usable. */
export class InvalidTokenError extends AuthError {
  readonly code = AuthErrorCode.INVALID_TOKEN;
  readonly status = 401;

  constructor(message = 'Invalid token') {
    super(message);
  }
}

/**
 * The token was valid but has expired.
 *
 * Separate from {@link InvalidTokenError} despite sharing a status: a client
 * should refresh on this and re-authenticate on the other.
 */
export class TokenExpiredError extends AuthError {
  readonly code = AuthErrorCode.TOKEN_EXPIRED;
  readonly status = 401;

  constructor(message = 'Invalid token') {
    super(message);
  }
}

/** Authenticated, but not permitted. */
export class ForbiddenError extends AuthError {
  readonly code = AuthErrorCode.FORBIDDEN;
  readonly status = 403;

  constructor(message = 'Forbidden') {
    super(message);
  }
}

/** The process is not configured well enough to authenticate anyone safely. */
export class AuthConfigError extends AuthError {
  readonly code = AuthErrorCode.MISCONFIGURED;
  readonly status = 500;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Development-only signing secret.
 *
 * This value is a literal in a file that is committed, so every token signed
 * with it is trivially forgeable by anyone who can read the repository. It
 * exists so `npm run dev` works with no setup, and {@link resolveSecret}
 * refuses to hand it out when `NODE_ENV=production`.
 */
const DEV_SECRET = 'handoff-development-only-secret-do-not-deploy';

/** Minimum length demanded of a real secret. */
const MIN_SECRET_LENGTH = 32;

const ISSUER = 'handoff';
const AUDIENCE = 'handoff-api';

export interface AuthConfig {
  secret: string;
  expiresIn: string;
  issuer: string;
  audience: string;
  /** True when running on the insecure development secret. */
  isDevSecret: boolean;
}

let warnedAboutDevSecret = false;

/**
 * Resolve the signing secret.
 *
 * @throws {AuthConfigError} in production when `JWT_SECRET` is absent or too
 *   short. Failing at boot is deliberate: the alternative is a service that
 *   starts happily and accepts forged tokens.
 */
export function resolveSecret(env: NodeJS.ProcessEnv = process.env): {
  secret: string;
  isDevSecret: boolean;
} {
  const configured = env.JWT_SECRET?.trim();
  const isProduction = env.NODE_ENV === 'production';

  if (configured) {
    if (isProduction && configured.length < MIN_SECRET_LENGTH) {
      throw new AuthConfigError(
        `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production ` +
          `(got ${configured.length}). Generate one with: openssl rand -base64 48`,
      );
    }
    if (isProduction && configured === DEV_SECRET) {
      throw new AuthConfigError(
        'JWT_SECRET is set to the development secret, which is public in the ' +
          'source tree. Generate a real one: openssl rand -base64 48',
      );
    }
    return { secret: configured, isDevSecret: false };
  }

  if (isProduction) {
    throw new AuthConfigError(
      'JWT_SECRET is not set. Refusing to start in production with the ' +
        'development secret, which is committed to the repository and would ' +
        'let anyone forge a token for any user.\n' +
        '  Generate one with: openssl rand -base64 48',
    );
  }

  if (!warnedAboutDevSecret) {
    warnedAboutDevSecret = true;
    console.warn(
      '[auth] JWT_SECRET is not set; using the built-in development secret. ' +
        'Tokens are forgeable. Set JWT_SECRET before deploying anywhere.',
    );
  }
  return { secret: DEV_SECRET, isDevSecret: true };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const { secret, isDevSecret } = resolveSecret(env);
  return {
    secret,
    expiresIn: env.JWT_EXPIRY?.trim() || '7d',
    issuer: ISSUER,
    audience: AUDIENCE,
    isDevSecret,
  };
}

/** True when this process is allowed to expose development affordances. */
export function isDevelopment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

// =============================================================================
// Token issue and verification
// =============================================================================

/**
 * The only algorithm this service issues or accepts.
 *
 * Passing this to `verify` is what prevents algorithm-confusion forgery; the
 * library defaults to trusting the token's own header otherwise.
 */
const ALGORITHM = 'HS256' as const;

/** Sign a session token for `user`. */
export function signToken(
  user: SessionUser,
  config: AuthConfig = loadAuthConfig(),
): string {
  const claims: Omit<HandoffJwtClaims, 'iat' | 'exp' | 'iss' | 'aud'> = {
    sub: user.id,
    email: user.email,
    name: user.displayName,
    role: user.role,
    jti: randomUUID(),
  };

  const options: SignOptions = {
    algorithm: ALGORITHM,
    expiresIn: config.expiresIn as SignOptions['expiresIn'],
    issuer: config.issuer,
    audience: config.audience,
  };

  return jwt.sign(claims, config.secret, options);
}

/**
 * Verify a token and project it onto a {@link SessionUser}.
 *
 * @throws {TokenExpiredError} when it has expired.
 * @throws {InvalidTokenError} for every other failure — bad signature, wrong
 *   issuer or audience, unexpected algorithm, malformed claims.
 */
export function verifyToken(
  token: string,
  config: AuthConfig = loadAuthConfig(),
): SessionUser {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.secret, {
      algorithms: [ALGORITHM],
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: 5,
    });
  } catch (err) {
    // Map by class; never include the token or the reason string verbatim,
    // since library messages can echo parts of the input.
    if (err instanceof jwt.TokenExpiredError) throw new TokenExpiredError();
    throw new InvalidTokenError();
  }

  return toSessionUser(decoded);
}

/** Validate the claim shape. A token that verifies can still be malformed. */
function toSessionUser(decoded: unknown): SessionUser {
  if (!decoded || typeof decoded !== 'object') throw new InvalidTokenError();
  const c = decoded as Partial<HandoffJwtClaims>;

  if (
    typeof c.sub !== 'string' ||
    c.sub.length === 0 ||
    typeof c.email !== 'string' ||
    typeof c.name !== 'string' ||
    (c.role !== 'user' && c.role !== 'admin')
  ) {
    throw new InvalidTokenError();
  }

  return { id: c.sub, email: c.email, displayName: c.name, role: c.role };
}

/**
 * Pull a bearer token out of the Authorization header.
 *
 * Returns null when absent. Only the `Bearer` scheme is accepted, and only
 * from the header — never a query parameter, which would leak the credential
 * into access logs, referrers, and browser history.
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;

  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

// =============================================================================
// Middleware
// =============================================================================

export interface AuthMiddlewareOptions {
  config?: AuthConfig;
}

/**
 * Require a valid bearer token.
 *
 * Attaches {@link SessionUser} to `req.user` and sets `req.isAuthenticated`.
 * Errors are passed to `next` so the application error handler renders them in
 * the standard envelope.
 */
export function requireAuth(options: AuthMiddlewareOptions = {}): RequestHandler {
  const config = options.config ?? loadAuthConfig();

  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req);
    if (!token) {
      req.user = null;
      req.isAuthenticated = false;
      next(new UnauthenticatedError());
      return;
    }

    try {
      req.user = verifyToken(token, config);
      req.isAuthenticated = true;
      next();
    } catch (err) {
      req.user = null;
      req.isAuthenticated = false;
      next(err);
    }
  };
}

/**
 * Verify a token when one is present, but allow anonymous callers through.
 *
 * A malformed or expired token is still rejected: presenting a broken
 * credential is a different situation from presenting none, and silently
 * downgrading it to anonymous would hide expired sessions from the client.
 */
export function optionalAuth(options: AuthMiddlewareOptions = {}): RequestHandler {
  const config = options.config ?? loadAuthConfig();

  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req);
    if (!token) {
      req.user = null;
      req.isAuthenticated = false;
      next();
      return;
    }

    try {
      req.user = verifyToken(token, config);
      req.isAuthenticated = true;
      next();
    } catch (err) {
      req.user = null;
      req.isAuthenticated = false;
      next(err);
    }
  };
}

/**
 * Require a role.
 *
 * `requireRole('user')` means any authenticated caller; `requireRole('admin')`
 * means admins only. Admins satisfy both, so a route guarded for users does not
 * have to enumerate every role above it.
 *
 * Mount after {@link requireAuth}.
 */
export function requireRole(role: Role): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      next(new UnauthenticatedError());
      return;
    }
    if (role === 'admin' && user.role !== 'admin') {
      next(new ForbiddenError());
      return;
    }
    next();
  };
}

/** The authenticated user, or throw. For use inside a handler. */
export function requireUser(req: Request): SessionUser {
  const user = req.user;
  if (!user) throw new UnauthenticatedError();
  return user;
}

// =============================================================================
// Ownership
// =============================================================================

/**
 * Ownership predicates.
 *
 * These hit the database, so they are collected behind an interface: routes
 * take one instance, and tests supply a fake instead of a live pool.
 *
 * Note the division of responsibility. These answer "may this user act on this
 * row at all" — a coarse gate. Whether a *particular* transition is allowed
 * stays in the domain's transition matrix, which already enforces that only an
 * owner may start or complete a task. Duplicating that here would give two
 * places to change and one to forget.
 */
export class OwnershipChecker {
  constructor(private readonly db: Queryable) {}

  /**
   * True when `userId` owns the task, owns the task's project, or is an admin.
   *
   * A project owner is included deliberately: they can already reassign the
   * task, so refusing them edit rights would be a gate they can trivially walk
   * around.
   */
  async canEditTask(userId: UUID, taskId: UUID, role: Role = 'user'): Promise<boolean> {
    if (role === 'admin') return true;
    const { rows } = await this.db.query<{ ok: boolean }>(
      `SELECT true AS ok
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 AND (t.owner_id = $2 OR p.user_id = $2)`,
      [taskId, userId],
    );
    return rows.length > 0;
  }

  /** True when `userId` owns the project, or is an admin. */
  async canViewProject(userId: UUID, projectId: UUID, role: Role = 'user'): Promise<boolean> {
    if (role === 'admin') return true;
    const { rows } = await this.db.query<{ ok: boolean }>(
      'SELECT true AS ok FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId],
    );
    return rows.length > 0;
  }

  /** True when `userId` may read the task (same rule as editing, for now). */
  async canViewTask(userId: UUID, taskId: UUID, role: Role = 'user'): Promise<boolean> {
    return this.canEditTask(userId, taskId, role);
  }
}

/** Where a route parameter holding the resource id lives. */
export type ParamSource = (req: Request) => string | undefined;

const fromParams =
  (name: string): ParamSource =>
  (req) =>
    typeof req.params[name] === 'string' ? req.params[name] : undefined;

/**
 * Middleware requiring edit rights on the task named by a route parameter.
 *
 * ```ts
 * router.post('/tasks/:id/start', requireAuth(), requireTaskAccess(checker), handler);
 * ```
 */
export function requireTaskAccess(
  checker: OwnershipChecker,
  source: ParamSource = fromParams('id'),
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const user = requireUser(req);
        const taskId = source(req);
        if (!taskId) {
          next(new ForbiddenError());
          return;
        }
        const allowed = await checker.canEditTask(user.id, taskId, user.role);
        next(allowed ? undefined : new ForbiddenError());
      } catch (err) {
        next(err);
      }
    })();
  };
}

/** Middleware requiring access to the project named by a route parameter. */
export function requireProjectAccess(
  checker: OwnershipChecker,
  source: ParamSource = fromParams('projectId'),
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const user = requireUser(req);
        const projectId = source(req);
        if (!projectId) {
          next(new ForbiddenError());
          return;
        }
        const allowed = await checker.canViewProject(user.id, projectId, user.role);
        next(allowed ? undefined : new ForbiddenError());
      } catch (err) {
        next(err);
      }
    })();
  };
}

// =============================================================================
// Development login
// =============================================================================

/**
 * The fixture account `POST /auth/dev-login` issues a token for.
 *
 * The id comes from `db/ids.ts`, the same derivation the seed uses, so this is
 * the id of a row that actually exists after `db:seed` — owning two projects,
 * three tasks, and a pending handoff. Previously it was a hand-written UUID
 * matching nothing, so signing in produced an empty dashboard.
 */
export const DEV_USER: SessionUser = {
  id: DEV_ACCOUNT.id,
  email: DEV_ACCOUNT.email,
  displayName: DEV_ACCOUNT.displayName,
  role: 'admin',
};

export interface DevLoginOptions {
  config?: AuthConfig;
  /** Overrides `NODE_ENV`-based gating. */
  enabled?: boolean;
  /**
   * Optional shared secret. When `DEV_LOGIN_KEY` is set, the caller must send
   * it as `x-dev-login-key`. Useful on a shared staging box where the endpoint
   * has to exist but should not be open to everyone on the network.
   */
  loginKey?: string;
}

/**
 * `POST /auth/dev-login` — issue a token for {@link DEV_USER}.
 *
 * This endpoint hands out a valid session to anyone who can reach it, so it is
 * refused outright when `NODE_ENV=production`. Mounting it is still an explicit
 * choice by the composition root; it is not installed by default.
 */
export function devLoginHandler(options: DevLoginOptions = {}): RequestHandler {
  const enabled = options.enabled ?? isDevelopment();
  const loginKey = options.loginKey ?? process.env.DEV_LOGIN_KEY?.trim();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) {
      // 404 rather than 403: in production this route does not exist, and
      // saying "forbidden" would confirm that it does.
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}.` },
        meta: { serverTime: new Date().toISOString() },
      });
      return;
    }

    if (loginKey && !matchesKey(req.get('x-dev-login-key'), loginKey)) {
      next(new UnauthenticatedError());
      return;
    }

    try {
      const config = options.config ?? loadAuthConfig();
      const body = (req.body ?? {}) as Partial<SessionUser>;

      // Allow overriding the fixture so a developer can act as a seeded user.
      const user: SessionUser = {
        id: typeof body.id === 'string' && body.id ? body.id : DEV_USER.id,
        email: typeof body.email === 'string' && body.email ? body.email : DEV_USER.email,
        displayName:
          typeof body.displayName === 'string' && body.displayName
            ? body.displayName
            : DEV_USER.displayName,
        role: body.role === 'user' || body.role === 'admin' ? body.role : DEV_USER.role,
      };

      const token = signToken(user, config);
      res.status(200).json({
        data: {
          token,
          user: { id: user.id, email: user.email, displayName: user.displayName },
        },
        meta: { serverTime: new Date().toISOString(), expiresIn: config.expiresIn },
      });
    } catch (err) {
      next(err);
    }
  };
}

/** Constant-time comparison, so the key cannot be recovered by timing. */
function matchesKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
