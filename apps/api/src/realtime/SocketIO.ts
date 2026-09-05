/**
 * Realtime gateway: Socket.IO fan-out of committed task events.
 *
 * Design rules:
 *
 *   * The gateway broadcasts only what the store has durably committed. It
 *     subscribes to a {@link TaskEventPublisher} feed that `inUnitOfWork` drains
 *     *after* COMMIT, so a rolled-back transaction never reaches a client.
 *   * Delivery is ordered and gap-free per task. Each socket tracks the last
 *     sequence it received; an out-of-order or duplicate frame is dropped, and a
 *     detected gap is backfilled from the event store before the new frame is
 *     released.
 *   * Subscriptions are authorized. A socket joins a room only if the injected
 *     {@link SubscriptionAuthorizer} says it may.
 *
 * Rooms: `project:<id>`, `task:<id>`, `user:<id>`.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';

import {
  EventType,
  type ISODateTime,
  type TaskEvent,
  type TaskEventPayloadMap,
  type UUID,
} from '@handoff/domain';
import {
  EventStore,
  type PublishedTaskEvent,
  type Queryable,
  type TaskEventPublisher,
} from '../repositories/EventStore';

// =============================================================================
// Wire protocol
// =============================================================================

/** Channel kinds a client may subscribe to. */
export type ChannelKind = 'project' | 'task' | 'user';

/**
 * The envelope every task event is delivered in.
 *
 * A discriminated union over {@link EventType}, so a client narrowing on `type`
 * gets the matching payload — the same contract the domain layer provides:
 *
 * ```ts
 * socket.on('task:event', (e) => {
 *   if (e.type === EventType.TaskBlocked) console.log(e.payload.reason);
 * });
 * ```
 */
export type RealtimeEvent = {
  [T in EventType]: {
    type: T;
    taskId: UUID;
    /** Task version this event produced. Equals `sequence - 1`. */
    version: number;
    /** Per-task position, 1-based and gapless. Use it to order and dedupe. */
    sequence: number;
    payload: TaskEventPayloadMap[T];
    /** When the event was appended, ISO-8601 UTC. */
    timestamp: ISODateTime;
    /** Event row id, for idempotency on the client. */
    eventId: UUID;
    /** Owning project, so a client on a project room can bucket by task. */
    projectId: UUID;
  };
}[EventType];

/** Notification kinds delivered to a user's personal room. */
export enum NotificationType {
  HandoffReceived = 'HandoffReceived',
  HandoffBriefReady = 'HandoffBriefReady',
  TaskAssigned = 'TaskAssigned',
}

export interface RealtimeNotification {
  type: NotificationType;
  taskId: UUID;
  handoffId?: UUID;
  fromUserId?: UUID | null;
  message: string;
  timestamp: ISODateTime;
}

export interface SubscribeRequest {
  channel: ChannelKind;
  id: UUID;
}

export interface SyncRequest {
  taskId: UUID;
  /** Last sequence the client already has. 0 (or omitted) requests a snapshot. */
  lastSequence?: number;
}

export interface SyncResponse {
  taskId: UUID;
  /** `catchup` replays missed events; `snapshot` means start over from these. */
  mode: 'catchup' | 'snapshot';
  events: RealtimeEvent[];
  /** Highest sequence in `events`, or the client's own if nothing was missed. */
  lastSequence: number;
  timestamp: ISODateTime;
}

export interface AckResponse {
  ok: boolean;
  error?: string;
}

/** Server -> client. */
export interface ServerToClientEvents {
  'task:event': (event: RealtimeEvent) => void;
  notification: (notification: RealtimeNotification) => void;
  heartbeat: (payload: { timestamp: ISODateTime }) => void;
  'subscription:error': (payload: { channel: ChannelKind; id: UUID; error: string }) => void;
}

/** Client -> server. Each takes an ack callback. */
export interface ClientToServerEvents {
  subscribe: (req: SubscribeRequest, ack?: (res: AckResponse) => void) => void;
  unsubscribe: (req: SubscribeRequest, ack?: (res: AckResponse) => void) => void;
  sync: (req: SyncRequest, ack?: (res: SyncResponse | AckResponse) => void) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

/** Per-connection server state. */
export interface SocketData {
  userId: UUID;
  isAdmin: boolean;
  /** Highest sequence delivered per task, for ordering and dedupe. */
  delivered: Map<UUID, number>;
  lastSeenAt: number;
}

export type HandoffSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type HandoffServer = IOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// =============================================================================
// Collaborators
// =============================================================================

/** Resolves the authenticated user for a connection. */
export interface SocketAuthenticator {
  /**
   * Return the user, or null to reject the connection.
   * `handshake.auth.token` is the conventional place to look.
   */
  authenticate(socket: HandoffSocket): Promise<{ userId: UUID; isAdmin?: boolean } | null>;
}

/** Decides whether a user may join a room. */
export interface SubscriptionAuthorizer {
  canSubscribe(
    user: { userId: UUID; isAdmin?: boolean },
    channel: ChannelKind,
    id: UUID,
  ): Promise<boolean>;
}

export interface GatewayLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, err?: unknown): void;
}

const consoleLogger: GatewayLogger = {
  info: (m, meta) => console.log(`[realtime] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[realtime] ${m}`, meta ?? ''),
  error: (m, err) => console.error(`[realtime] ${m}`, err ?? ''),
};

/**
 * Default authorizer, backed by the current schema.
 *
 * The schema has no project membership table — `projects.user_id` names a single
 * owner — so "all project members" is not yet expressible. Until a
 * `project_members` table exists this grants project access to the owner only,
 * and task access to the task's owner or its project's owner. Inject your own
 * implementation once membership is modelled.
 */
export class SchemaBackedAuthorizer implements SubscriptionAuthorizer {
  constructor(private readonly db: Queryable) {}

  async canSubscribe(
    user: { userId: UUID; isAdmin?: boolean },
    channel: ChannelKind,
    id: UUID,
  ): Promise<boolean> {
    if (user.isAdmin) return true;

    switch (channel) {
      case 'user':
        // Your own notifications, nobody else's.
        return id === user.userId;

      case 'project': {
        const { rows } = await this.db.query<{ ok: boolean }>(
          'SELECT true AS ok FROM projects WHERE id = $1 AND user_id = $2',
          [id, user.userId],
        );
        return rows.length > 0;
      }

      case 'task': {
        const { rows } = await this.db.query<{ ok: boolean }>(
          `SELECT true AS ok
             FROM tasks t
             JOIN projects p ON p.id = t.project_id
            WHERE t.id = $1 AND (t.owner_id = $2 OR p.user_id = $2)`,
          [id, user.userId],
        );
        return rows.length > 0;
      }

      default:
        return false;
    }
  }
}

// =============================================================================
// In-process event bus
// =============================================================================

type FeedHandler = (events: readonly PublishedTaskEvent[]) => void;

/**
 * Single-process fan-out between the repositories and the gateway.
 *
 * Implements {@link TaskEventPublisher}, so it can be handed to `inUnitOfWork`
 * as its publisher.
 *
 * For more than one API instance this is not enough: each process would only
 * see its own writes. Run the Socket.IO Redis adapter (so rooms span processes)
 * and replace this with a shared feed — Postgres LISTEN/NOTIFY on `task_events`
 * is the natural fit, since NOTIFY is itself transactional.
 */
export class InProcessEventBus implements TaskEventPublisher {
  private readonly handlers = new Set<FeedHandler>();

  constructor(private readonly logger: GatewayLogger = consoleLogger) {}

  publish(events: readonly PublishedTaskEvent[]): void {
    if (events.length === 0) return;
    for (const handler of this.handlers) {
      try {
        handler(events);
      } catch (err) {
        // A broken subscriber must never fail the request that published.
        this.logger.error('event feed subscriber threw', err);
      }
    }
  }

  subscribe(handler: FeedHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

// =============================================================================
// Gateway
// =============================================================================

export interface SocketIOGatewayOptions {
  /** Event feed to broadcast from. */
  bus: InProcessEventBus;
  /** Used for reconnect catch-up and gap backfill. */
  events: EventStore;
  authenticator: SocketAuthenticator;
  authorizer: SubscriptionAuthorizer;
  logger?: GatewayLogger;
  /** Allowed browser origins. Defaults to `CORS_ORIGIN` or same-origin only. */
  corsOrigin?: string | string[];
  /** Application-level heartbeat period, ms. Default 25_000. */
  heartbeatIntervalMs?: number;
  /** Drop a socket silent for this long, ms. Default 90_000. */
  staleConnectionMs?: number;
  /** Above this many missed events, send a snapshot instead. Default 200. */
  maxCatchUpEvents?: number;
}

/**
 * Socket.IO gateway.
 *
 * ```ts
 * const bus = new InProcessEventBus();
 * const gateway = new SocketIOGateway({ bus, events, authenticator, authorizer });
 * gateway.attach(httpServer);            // share the Express server, or
 * gateway.listenStandalone();            // bind WS_PORT
 * ```
 */
export class SocketIOGateway {
  private io?: HandoffServer;
  private ownServer?: HttpServer;
  private unsubscribe?: () => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  private readonly logger: GatewayLogger;
  private readonly heartbeatIntervalMs: number;
  private readonly staleConnectionMs: number;
  private readonly maxCatchUpEvents: number;

  constructor(private readonly options: SocketIOGatewayOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.staleConnectionMs = options.staleConnectionMs ?? 90_000;
    this.maxCatchUpEvents = options.maxCatchUpEvents ?? 200;
  }

  /** The underlying server, once attached. */
  get server(): HandoffServer {
    if (!this.io) throw new Error('Gateway is not attached yet; call attach() first.');
    return this.io;
  }

  // --- lifecycle ------------------------------------------------------------

  /** Attach to an existing HTTP server — the usual setup, sharing the API port. */
  attach(httpServer: HttpServer): HandoffServer {
    if (this.io) throw new Error('Gateway is already attached.');

    this.io = new IOServer<
      ClientToServerEvents,
      ServerToClientEvents,
      InterServerEvents,
      SocketData
    >(httpServer, {
      cors: { origin: resolveCorsOrigin(this.options.corsOrigin), credentials: true },
      // Transport-level liveness. The application heartbeat below is a second,
      // observable layer: it also proves the event loop is not wedged.
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });

    this.io.use(this.authenticateConnection);
    this.io.on('connection', (socket) => void this.onConnection(socket));
    this.io.engine.on('connection_error', (err: unknown) => {
      this.logger.error('engine connection error', err);
    });

    this.unsubscribe = this.options.bus.subscribe((events) => {
      void this.broadcast(events);
    });
    this.startHeartbeat();

    this.logger.info('gateway attached');
    return this.io;
  }

  /**
   * Bind a dedicated HTTP server on `WS_PORT`.
   *
   * Only for deployments that terminate websockets separately; sharing the
   * Express server via {@link attach} is simpler and avoids a second port.
   *
   * @throws if `WS_PORT` is unset or not a valid port.
   */
  listenStandalone(port = process.env.WS_PORT): HandoffServer {
    const parsed = Number.parseInt(String(port ?? ''), 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
      throw new Error(
        `WS_PORT must be a valid port number to run the gateway standalone; got ${String(port)}.`,
      );
    }
    this.ownServer = createServer();
    const io = this.attach(this.ownServer);
    this.ownServer.listen(parsed, () => {
      this.logger.info(`gateway listening standalone on port ${parsed}`);
    });
    return io;
  }

  /** Stop broadcasting, drop connections, and release timers. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;

    if (this.io) {
      await new Promise<void>((resolve) => this.io!.close(() => resolve()));
      this.io = undefined;
    }
    if (this.ownServer) {
      await new Promise<void>((resolve) => this.ownServer!.close(() => resolve()));
      this.ownServer = undefined;
    }
    this.logger.info('gateway closed');
  }

  // --- connection handling --------------------------------------------------

  private readonly authenticateConnection = (
    socket: HandoffSocket,
    next: (err?: Error) => void,
  ): void => {
    void (async () => {
      try {
        const user = await this.options.authenticator.authenticate(socket);
        if (!user) {
          next(new Error('UNAUTHENTICATED'));
          return;
        }
        socket.data.userId = user.userId;
        socket.data.isAdmin = user.isAdmin ?? false;
        socket.data.delivered = new Map();
        socket.data.lastSeenAt = Date.now();
        next();
      } catch (err) {
        this.logger.error('authentication failed', err);
        next(new Error('UNAUTHENTICATED'));
      }
    })();
  };

  private async onConnection(socket: HandoffSocket): Promise<void> {
    const { userId } = socket.data;
    this.logger.info('client connected', { socketId: socket.id, userId });

    // Personal notifications need no explicit subscribe: you are always in your
    // own room, and the authorizer would only ever allow your own id anyway.
    await socket.join(roomFor('user', userId));

    socket.on('subscribe', (req, ack) => {
      void this.handleSubscribe(socket, req, ack);
    });
    socket.on('unsubscribe', (req, ack) => {
      void this.handleUnsubscribe(socket, req, ack);
    });
    socket.on('sync', (req, ack) => {
      void this.handleSync(socket, req, ack);
    });

    // Any inbound frame counts as liveness, including transport pongs.
    socket.onAny(() => {
      socket.data.lastSeenAt = Date.now();
    });
    socket.conn.on('packet', () => {
      socket.data.lastSeenAt = Date.now();
    });

    socket.on('error', (err) => {
      this.logger.error(`socket ${socket.id} error`, err);
    });
    socket.on('disconnect', (reason) => {
      this.logger.info('client disconnected', { socketId: socket.id, userId, reason });
    });
  }

  private async handleSubscribe(
    socket: HandoffSocket,
    req: SubscribeRequest,
    ack?: (res: AckResponse) => void,
  ): Promise<void> {
    try {
      if (!isValidSubscribe(req)) {
        respond(ack, { ok: false, error: 'channel must be project|task|user and id a UUID.' });
        return;
      }
      const allowed = await this.options.authorizer.canSubscribe(
        { userId: socket.data.userId, isAdmin: socket.data.isAdmin },
        req.channel,
        req.id,
      );
      if (!allowed) {
        socket.emit('subscription:error', {
          channel: req.channel,
          id: req.id,
          error: 'You do not have access to this channel.',
        });
        respond(ack, { ok: false, error: 'FORBIDDEN' });
        return;
      }
      await socket.join(roomFor(req.channel, req.id));
      respond(ack, { ok: true });
    } catch (err) {
      this.logger.error('subscribe failed', err);
      respond(ack, { ok: false, error: 'Subscription failed.' });
    }
  }

  private async handleUnsubscribe(
    socket: HandoffSocket,
    req: SubscribeRequest,
    ack?: (res: AckResponse) => void,
  ): Promise<void> {
    if (!isValidSubscribe(req)) {
      respond(ack, { ok: false, error: 'Invalid unsubscribe request.' });
      return;
    }
    await socket.leave(roomFor(req.channel, req.id));
    if (req.channel === 'task') socket.data.delivered.delete(req.id);
    respond(ack, { ok: true });
  }

  // --- reconnect ------------------------------------------------------------

  /**
   * Catch a reconnecting client up.
   *
   * The client sends the last sequence it holds. If the gap is small we replay
   * exactly the missing events; if it is large (or the client has nothing) we
   * tell it to take a fresh snapshot instead of streaming hundreds of frames.
   */
  private async handleSync(
    socket: HandoffSocket,
    req: SyncRequest,
    ack?: (res: SyncResponse | AckResponse) => void,
  ): Promise<void> {
    try {
      if (!isUuid(req?.taskId)) {
        respond(ack, { ok: false, error: 'taskId must be a UUID.' });
        return;
      }
      const allowed = await this.options.authorizer.canSubscribe(
        { userId: socket.data.userId, isAdmin: socket.data.isAdmin },
        'task',
        req.taskId,
      );
      if (!allowed) {
        respond(ack, { ok: false, error: 'FORBIDDEN' });
        return;
      }

      const from = Math.max(0, Math.trunc(req.lastSequence ?? 0));
      const page = await this.options.events.getEventsPage(
        req.taskId,
        from,
        this.maxCatchUpEvents,
      );

      // Too far behind, or starting cold: a snapshot is cheaper and avoids
      // handing back a partial window the client would mistake for the tail.
      const mode: SyncResponse['mode'] = from === 0 || page.hasMore ? 'snapshot' : 'catchup';
      const events =
        mode === 'snapshot'
          ? (await this.options.events.getEvents(req.taskId)).map((e) =>
              toRealtimeEvent(e, unknownProject),
            )
          : page.events.map((e) => toRealtimeEvent(e, unknownProject));

      const lastSequence = events.length > 0 ? events[events.length - 1]!.sequence : from;

      // Re-baseline the dedupe watermark so the live stream resumes cleanly.
      socket.data.delivered.set(req.taskId, lastSequence);

      respond(ack, {
        taskId: req.taskId,
        mode,
        events,
        lastSequence,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error('sync failed', err);
      respond(ack, { ok: false, error: 'Sync failed.' });
    }
  }

  // --- broadcasting ---------------------------------------------------------

  /**
   * Fan committed events out to their rooms.
   *
   * Events arrive already ordered by sequence. Per-socket ordering is enforced
   * in {@link deliver}.
   */
  private async broadcast(published: readonly PublishedTaskEvent[]): Promise<void> {
    if (!this.io) return;

    for (const item of published) {
      try {
        const frame = toRealtimeEvent(item.event, item.projectId);

        // Project and task rooms both see every event. A socket in both rooms
        // would receive it twice, so deliver per-socket rather than via
        // io.to(a).to(b), which cannot dedupe.
        const rooms = [roomFor('project', item.projectId), roomFor('task', frame.taskId)];
        const sockets = await this.io.in(rooms).fetchSockets();
        for (const s of sockets) {
          this.deliver(s as unknown as HandoffSocket, frame);
        }

        this.notifyForEvent(frame, item);
      } catch (err) {
        this.logger.error('broadcast failed', err);
      }
    }
  }

  /**
   * Send one frame to one socket, preserving per-task order.
   *
   * Drops anything already delivered, and backfills before releasing a frame
   * that would leave a hole — so a client never has to reason about gaps.
   */
  private deliver(socket: HandoffSocket, frame: RealtimeEvent): void {
    const last = socket.data.delivered.get(frame.taskId) ?? 0;

    if (frame.sequence <= last) return; // duplicate or stale

    if (frame.sequence > last + 1) {
      // A hole: fill it from the store, then release this frame.
      void this.backfill(socket, frame, last);
      return;
    }

    socket.data.delivered.set(frame.taskId, frame.sequence);
    socket.emit('task:event', frame);
  }

  private async backfill(
    socket: HandoffSocket,
    frame: RealtimeEvent,
    from: number,
  ): Promise<void> {
    try {
      const missing = await this.options.events.getEventsSince(frame.taskId, from);
      for (const event of missing) {
        if (event.sequence >= frame.sequence) break;
        socket.data.delivered.set(frame.taskId, event.sequence);
        socket.emit('task:event', toRealtimeEvent(event, frame.projectId));
      }
      socket.data.delivered.set(frame.taskId, frame.sequence);
      socket.emit('task:event', frame);
    } catch (err) {
      this.logger.error(`backfill failed for task ${frame.taskId}`, err);
    }
  }

  /**
   * Personal notifications derived from a task event.
   *
   * A transfer notifies the recipient in addition to the project broadcast;
   * an assignment notifies the new owner.
   */
  private notifyForEvent(frame: RealtimeEvent, item: PublishedTaskEvent): void {
    if (!this.io) return;
    const { event } = item;

    if (event.type === EventType.TaskTransferred) {
      this.notifyUser(event.payload.toUserId, {
        type: NotificationType.HandoffReceived,
        taskId: frame.taskId,
        handoffId: event.payload.handoffId,
        fromUserId: event.payload.fromUserId,
        message: 'A task has been handed off to you.',
        timestamp: frame.timestamp,
      });
      return;
    }

    if (event.type === EventType.TaskAssigned) {
      this.notifyUser(event.payload.toOwnerId, {
        type: NotificationType.TaskAssigned,
        taskId: frame.taskId,
        fromUserId: event.payload.fromOwnerId,
        message: 'A task has been assigned to you.',
        timestamp: frame.timestamp,
      });
    }
  }

  /** Push a notification into a user's personal room. */
  notifyUser(userId: UUID, notification: RealtimeNotification): void {
    if (!this.io || !userId) return;
    this.io.to(roomFor('user', userId)).emit('notification', notification);
  }

  /**
   * Announce that the AI brief for a handoff is ready.
   *
   * Called by the `handoff-brief` worker once it has written the row; briefs are
   * produced outside the request path, so they are not task events.
   */
  notifyBriefReady(params: {
    toUserId: UUID;
    taskId: UUID;
    handoffId: UUID;
  }): void {
    this.notifyUser(params.toUserId, {
      type: NotificationType.HandoffBriefReady,
      taskId: params.taskId,
      handoffId: params.handoffId,
      message: 'Your handoff brief is ready.',
      timestamp: new Date().toISOString(),
    });
  }

  // --- heartbeat ------------------------------------------------------------

  /**
   * Emit an application heartbeat and reap sockets that have gone quiet.
   *
   * Socket.IO's own ping/pong already detects dead transports; this catches the
   * case where the transport is alive but the peer has stopped participating,
   * and gives clients a positive liveness signal to drive their own reconnect.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        if (!this.io) return;
        const now = Date.now();
        const timestamp = new Date(now).toISOString();
        try {
          const sockets = await this.io.fetchSockets();
          for (const s of sockets) {
            const socket = s as unknown as HandoffSocket;
            if (now - (socket.data.lastSeenAt ?? now) > this.staleConnectionMs) {
              this.logger.warn('dropping stale connection', { socketId: socket.id });
              socket.disconnect(true);
              continue;
            }
            socket.emit('heartbeat', { timestamp });
          }
        } catch (err) {
          this.logger.error('heartbeat sweep failed', err);
        }
      })();
    }, this.heartbeatIntervalMs);

    // Never hold the process open just for the heartbeat.
    this.heartbeatTimer.unref?.();
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Placeholder project id for frames built from a bare `TaskEvent`, which does
 * not carry one. Only reachable on the sync path, where the client already
 * knows which task it asked about.
 */
const unknownProject = '' as UUID;

export function roomFor(channel: ChannelKind, id: UUID): string {
  return `${channel}:${id}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isValidSubscribe(req: unknown): req is SubscribeRequest {
  if (!req || typeof req !== 'object') return false;
  const { channel, id } = req as SubscribeRequest;
  return (channel === 'project' || channel === 'task' || channel === 'user') && isUuid(id);
}

/** Build the wire envelope from a stored event. */
export function toRealtimeEvent(event: TaskEvent, projectId: UUID): RealtimeEvent {
  return {
    type: event.type,
    taskId: event.taskId,
    // Invariant shared with replayEvents: TaskCreated is sequence 1 / version 0.
    version: event.sequence - 1,
    sequence: event.sequence,
    payload: event.payload,
    timestamp: event.createdAt,
    eventId: event.id,
    projectId,
    // The mapped-type union cannot be built generically. The (type, payload)
    // pairing is correct by construction: it comes straight off a TaskEvent,
    // which is itself a discriminated union over the same map.
  } as RealtimeEvent;
}

function respond<T>(ack: ((res: T) => void) | undefined, value: T): void {
  ack?.(value);
}

function resolveCorsOrigin(configured?: string | string[]): string | string[] {
  if (configured) return configured;
  const fromEnv = process.env.CORS_ORIGIN;
  // Same-origin only unless told otherwise; never default to '*' with
  // credentials enabled.
  return fromEnv ? fromEnv.split(',').map((s) => s.trim()) : [];
}
