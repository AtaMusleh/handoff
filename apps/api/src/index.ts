/**
 * API server entrypoint.
 *
 * Boots the HTTP app, attaches the realtime gateway to the same server, and
 * subscribes to the brief-worker's Redis channel so a generated brief reaches
 * the receiver's socket.
 */

import { createServer } from 'node:http';
import Redis from 'ioredis';

import { buildApp } from './app';
import { createPool } from './db/pool';
import { loadAuthConfig, verifyToken } from './middleware/auth';
import {
  InProcessEventBus,
  SchemaBackedAuthorizer,
  SocketIOGateway,
} from './realtime/SocketIO';
import { EventStore } from './repositories/EventStore';

/** Channel the handoff-brief worker publishes to. */
const BRIEF_EVENTS_CHANNEL = 'handoff:brief-events';

interface BriefEventMessage {
  type: 'HandoffBriefReady' | 'BriefGenerationFailed';
  handoffId: string;
  taskId: string;
  toUserId: string;
  briefId?: string;
}

async function main(): Promise<void> {
  const authConfig = loadAuthConfig();
  const pool = createPool();
  const port = Number.parseInt(process.env.API_PORT ?? '3001', 10);

  const app = buildApp({ pool, authConfig });
  const server = createServer(app);

  // --- realtime -------------------------------------------------------------
  const bus = new InProcessEventBus();
  const gateway = new SocketIOGateway({
    bus,
    events: new EventStore(pool, bus),
    // Sockets authenticate with the same token as HTTP: handshake.auth.token.
    authenticator: {
      authenticate: async (socket) => {
        const token = socket.handshake.auth?.token as string | undefined;
        if (!token) return null;
        try {
          const user = verifyToken(token, authConfig);
          return { userId: user.id, isAdmin: user.role === 'admin' };
        } catch {
          return null;
        }
      },
    },
    authorizer: new SchemaBackedAuthorizer(pool),
  });
  gateway.attach(server);

  // --- brief notifications --------------------------------------------------
  // The worker runs in its own process, so it cannot call the gateway directly.
  // A dedicated subscriber connection is required: a Redis client in subscriber
  // mode cannot issue other commands.
  let subscriber: Redis | undefined;
  if (process.env.REDIS_URL) {
    subscriber = new Redis(process.env.REDIS_URL);
    await subscriber.subscribe(BRIEF_EVENTS_CHANNEL);
    subscriber.on('message', (_channel, raw) => {
      try {
        const msg = JSON.parse(raw) as BriefEventMessage;
        if (msg.type === 'HandoffBriefReady') {
          gateway.notifyBriefReady({
            toUserId: msg.toUserId,
            taskId: msg.taskId,
            handoffId: msg.handoffId,
          });
        }
      } catch (err) {
        console.error('[api] malformed brief event', err);
      }
    });
    console.log(`[api] subscribed to ${BRIEF_EVENTS_CHANNEL}`);
  } else {
    console.warn('[api] REDIS_URL is not set; handoff-brief notifications are disabled.');
  }

  server.listen(port, () => {
    console.log(`[api] listening on ${port}`);
    if (authConfig.isDevSecret) {
      console.warn('[api] running with the development JWT secret; tokens are forgeable.');
    }
  });

  const shutdown = (signal: string): void => {
    console.log(`[api] ${signal} received; shutting down`);
    void (async () => {
      await gateway.close();
      await new Promise<void>((r) => server.close(() => r()));
      await Promise.allSettled([pool.end(), subscriber?.quit()]);
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((err: unknown) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
