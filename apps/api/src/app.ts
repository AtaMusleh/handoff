/**
 * HTTP composition root.
 *
 * Assembles the Express application: parsers, authentication, routers, and the
 * terminal error handler. Kept separate from `index.ts` so tests can build an
 * app without binding a port or opening a database pool.
 *
 * Middleware order matters here and is not incidental:
 *
 *   1. body parsing        — routes need `req.body`
 *   2. dev login           — must be reachable *without* a token
 *   3. authentication      — populates `req.user` for everything below
 *   4. routers             — assume an authenticated caller
 *   5. 404, then errors    — terminal, in that order
 */

import express, { type Express } from 'express';

import { errorHandler, notFoundHandler, type ErrorLogger } from './http/api';
import {
  devLoginHandler,
  isDevelopment,
  loadAuthConfig,
  requireAuth,
  type AuthConfig,
} from './middleware/auth';
import { HandoffRouter } from './routes/handoffs';
import { TaskRouter } from './routes/tasks';
import type { PoolLike } from './repositories/EventStore';

export interface BuildAppOptions {
  pool: PoolLike;
  authConfig?: AuthConfig;
  logger?: ErrorLogger;
  /** Mount `POST /auth/dev-login`. Defaults to on outside production. */
  enableDevLogin?: boolean;
  /** Prefix for the API routes. Default `/api`. */
  basePath?: string;
}

export function buildApp(options: BuildAppOptions): Express {
  const {
    pool,
    authConfig = loadAuthConfig(),
    logger = console,
    enableDevLogin = isDevelopment(),
    basePath = '/api',
  } = options;

  const app = express();

  // Do not advertise the framework.
  app.disable('x-powered-by');
  // Behind a proxy, so req.ip and secure-cookie logic see the real client.
  app.set('trust proxy', true);

  app.use(express.json({ limit: '1mb' }));

  // Liveness. Deliberately unauthenticated and above the auth middleware:
  // a health check that needs a token cannot report that auth is broken.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', serverTime: new Date().toISOString() });
  });

  if (enableDevLogin) {
    app.post('/auth/dev-login', devLoginHandler({ config: authConfig, enabled: true }));
    logger.error?.(
      '[app] POST /auth/dev-login is mounted. It issues a valid session to any ' +
        'caller and must never be enabled in production.',
      undefined,
    );
  }

  // Everything below this line requires a verified token.
  app.use(basePath, requireAuth({ config: authConfig }));
  app.use(basePath, new TaskRouter({ pool }).router);
  app.use(basePath, new HandoffRouter({ pool }).router);

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
