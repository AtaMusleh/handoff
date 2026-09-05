/**
 * Shared HTTP plumbing for the Handoff API: response envelopes, error
 * translation, validation, and actor resolution.
 *
 * Both route modules depend on this so that a domain or repository error maps
 * to the same status code no matter which endpoint raised it.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

import {
  DomainError,
  DomainErrorCode,
  InvalidTransitionError,
  PermissionError,
  TaskAggregate,
  ValidationError,
  type Handoff,
  type HandoffBrief,
  type ISODateTime,
  type Task,
  type TaskEvent,
  type UUID,
} from '@handoff/domain';
import {
  ConcurrencyError,
  ConstraintViolationError,
  NotFoundError,
  RepositoryError,
  TransactionError,
} from '../repositories/EventStore';

// =============================================================================
// Authenticated actor
// =============================================================================

/** The caller, as established by upstream auth middleware. */
export interface AuthenticatedUser {
  userId: UUID;
  isAdmin?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by auth middleware; absent on unauthenticated requests. */
      user?: AuthenticatedUser;
    }
  }
}

/** Raised when a route needs an actor and none was authenticated. */
export class UnauthenticatedError extends Error {
  constructor(message = 'Authentication is required for this endpoint.') {
    super(message);
    this.name = 'UnauthenticatedError';
    Object.setPrototypeOf(this, UnauthenticatedError.prototype);
  }
}

/**
 * The authenticated caller.
 *
 * This layer performs no authentication of its own — it reads what auth
 * middleware put on the request. Mount that middleware ahead of these routers.
 *
 * @throws {UnauthenticatedError} rendered as 401.
 */
export function requireActor(req: Request): AuthenticatedUser {
  const user = req.user;
  if (!user?.userId) throw new UnauthenticatedError();
  return user;
}

// =============================================================================
// Response envelope
// =============================================================================

/** Metadata attached to every response, success or failure. */
export interface ResponseMeta {
  /** Server clock at the moment the response was built, ISO-8601 UTC. */
  serverTime: ISODateTime;
  [key: string]: unknown;
}

export interface SuccessBody<T> {
  data: T;
  meta: ResponseMeta;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level detail for validation failures. */
    details?: unknown;
  };
  meta: ResponseMeta;
}

function meta(extra?: Record<string, unknown>): ResponseMeta {
  return { serverTime: new Date().toISOString(), ...extra };
}

/** Send a success envelope. */
export function sendData<T>(
  res: Response,
  status: number,
  data: T,
  extraMeta?: Record<string, unknown>,
): void {
  const body: SuccessBody<T> = { data, meta: meta(extraMeta) };
  res.status(status).json(body);
}

// =============================================================================
// Serialization
// =============================================================================

/** A task as the API exposes it: state, plus what the client can do next. */
export interface TaskResponse extends Task {
  /**
   * Statuses reachable in one step. Lets the UI render affordances without
   * duplicating the transition matrix.
   */
  validNextStates: string[];
}

export function serializeTask(aggregate: TaskAggregate): TaskResponse {
  return {
    ...aggregate.toJSON(),
    validNextStates: aggregate.getValidNextStates(),
  };
}

export function serializeEvent(event: TaskEvent): TaskEvent {
  return event;
}

export function serializeHandoff(handoff: Handoff): Handoff {
  return handoff;
}

export interface HandoffDetailResponse extends Handoff {
  /** Null until the `handoff-brief` worker has generated one. */
  brief: HandoffBrief | null;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Parse `value` or throw a {@link ZodError}, which the error handler renders
 * as 400 with per-field details.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

/** Flatten Zod issues into a compact, client-friendly shape. */
function zodDetails(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

// =============================================================================
// Error translation
// =============================================================================

/** Wire-level error codes. Stable; clients may switch on these. */
export enum ApiErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/** An error raised deliberately by a route, with its status already chosen. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

interface Translated {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  /** True when the cause should be logged as a server fault. */
  isServerFault: boolean;
}

/**
 * Map any thrown value onto an HTTP response.
 *
 *   400 — malformed or invalid input (Zod, domain ValidationError)
 *   401 — no authenticated actor
 *   403 — authenticated, but not permitted to act on this task
 *   404 — task, handoff, or referenced row does not exist
 *   409 — optimistic lock lost, or a handoff already resolved
 *   422 — well-formed request the state machine refuses
 *   500 — anything else, including database invariant violations
 */
export function translateError(err: unknown): Translated {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
      isServerFault: err.status >= 500,
    };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      code: ApiErrorCode.VALIDATION_FAILED,
      message: 'Request validation failed.',
      details: zodDetails(err),
      isServerFault: false,
    };
  }

  if (err instanceof UnauthenticatedError) {
    return {
      status: 401,
      code: ApiErrorCode.UNAUTHENTICATED,
      message: err.message,
      isServerFault: false,
    };
  }

  // --- domain ---------------------------------------------------------------

  if (err instanceof InvalidTransitionError) {
    return {
      status: 422,
      code: ApiErrorCode.INVALID_STATE_TRANSITION,
      message: err.message,
      details: { from: err.from, to: err.to },
      isServerFault: false,
    };
  }

  if (err instanceof PermissionError) {
    return {
      status: 403,
      code: ApiErrorCode.FORBIDDEN,
      message: err.message,
      isServerFault: false,
    };
  }

  if (err instanceof ValidationError) {
    return {
      status: 400,
      code: ApiErrorCode.VALIDATION_FAILED,
      message: err.message,
      details: err.field ? [{ path: err.field, message: err.message }] : undefined,
      isServerFault: false,
    };
  }

  // --- repository -----------------------------------------------------------

  if (err instanceof NotFoundError) {
    return {
      status: 404,
      code: ApiErrorCode.NOT_FOUND,
      message: err.message,
      isServerFault: false,
    };
  }

  if (err instanceof ConcurrencyError) {
    return {
      status: 409,
      code: ApiErrorCode.CONFLICT,
      message: err.message,
      details: {
        expectedVersion: err.expectedVersion,
        actualVersion: err.actualVersion,
      },
      isServerFault: false,
    };
  }

  // A CHECK constraint, append-only trigger, or enum drift got past the domain
  // layer. That is a server bug, not something the client can fix by retrying.
  if (err instanceof ConstraintViolationError || err instanceof TransactionError) {
    return {
      status: 500,
      code: ApiErrorCode.INTERNAL_ERROR,
      message: 'The request could not be completed.',
      isServerFault: true,
    };
  }

  // Any DomainError or RepositoryError added later without a mapping here.
  if (err instanceof DomainError) {
    return {
      status: err.code === DomainErrorCode.VALIDATION_FAILED ? 400 : 422,
      code:
        err.code === DomainErrorCode.VALIDATION_FAILED
          ? ApiErrorCode.VALIDATION_FAILED
          : ApiErrorCode.INVALID_STATE_TRANSITION,
      message: err.message,
      isServerFault: false,
    };
  }

  if (err instanceof RepositoryError) {
    return {
      status: 500,
      code: ApiErrorCode.INTERNAL_ERROR,
      message: 'The request could not be completed.',
      isServerFault: true,
    };
  }

  return {
    status: 500,
    code: ApiErrorCode.INTERNAL_ERROR,
    message: 'An unexpected error occurred.',
    isServerFault: true,
  };
}

/** Where the error handler reports server faults. Defaults to `console.error`. */
export interface ErrorLogger {
  error(message: string, err: unknown): void;
}

/**
 * Terminal error middleware. Mount **after** all routers.
 *
 * Internal failures are logged in full and reported to the client as a generic
 * message, so stack traces and SQL never reach the wire.
 */
export function errorHandler(logger: ErrorLogger = console): RequestHandler {
  return ((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);

    const t = translateError(err);
    if (t.isServerFault) {
      logger.error(`${req.method} ${req.originalUrl} failed`, err);
    }

    const body: ErrorBody = {
      error: {
        code: t.code,
        message: t.message,
        ...(t.details === undefined ? {} : { details: t.details }),
      },
      meta: meta(),
    };
    res.status(t.status).json(body);
  }) as unknown as RequestHandler;
}

/** 404 handler for unmatched paths. Mount after routers, before `errorHandler`. */
export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    const body: ErrorBody = {
      error: {
        code: ApiErrorCode.NOT_FOUND,
        message: `No route matches ${req.method} ${req.path}.`,
      },
      meta: meta(),
    };
    res.status(404).json(body);
  };
}

// =============================================================================
// Async handler
// =============================================================================

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Forward rejected promises to the error middleware.
 *
 * Express 5 already does this, but wrapping keeps the intent explicit and keeps
 * these routers safe if they are ever mounted on an Express 4 app.
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
