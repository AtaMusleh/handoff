/**
 * Socket.IO client hook.
 *
 * Mirrors the server gateway in `apps/api/src/realtime/SocketIO.ts`:
 *
 *   * Subscribes to `project` / `task` / `user` rooms and re-subscribes after a
 *     reconnect, since rooms live on the server connection and do not survive it.
 *   * Tracks the last sequence seen per task and replays it on reconnect, so the
 *     server can send only what was missed.
 *   * Drops duplicates by sequence. The server already dedupes per connection,
 *     but a reconnect hands back a fresh connection with no memory of what this
 *     client holds — so the client keeps its own watermark too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { EventType } from '@handoff/domain';
import type { TaskEventDto } from '@/lib/schemas';

export type ChannelKind = 'project' | 'task' | 'user';

export interface Subscription {
  channel: ChannelKind;
  id: string;
}

/** The envelope the gateway emits on `task:event`. */
export interface RealtimeEvent {
  type: EventType;
  taskId: string;
  version: number;
  sequence: number;
  payload: Record<string, unknown>;
  timestamp: string;
  eventId: string;
  projectId: string;
}

export interface RealtimeNotification {
  type: 'HandoffReceived' | 'HandoffBriefReady' | 'TaskAssigned';
  taskId: string;
  handoffId?: string;
  fromUserId?: string | null;
  message: string;
  timestamp: string;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface UseWebSocketOptions {
  /** Identifies the connection to the gateway's authenticator. */
  userId: string;
  subscriptions: Subscription[];
  /** Defaults to `NEXT_PUBLIC_WS_URL`, else the API origin. */
  url?: string;
  /** Set false to stay disconnected (e.g. before the user id is known). */
  enabled?: boolean;
  /** Highest sequence already held per task, seeded from a server render. */
  initialCursors?: Record<string, number>;
  onNotification?: (n: RealtimeNotification) => void;
}

export interface UseWebSocketResult {
  /** Events received this session, oldest first. */
  events: RealtimeEvent[];
  notifications: RealtimeNotification[];
  isConnected: boolean;
  state: ConnectionState;
  error: string | null;
  /** Count of events received since the last {@link markSeen}. */
  unseenCount: number;
  markSeen: () => void;
  /** Ask the server for anything missed on a task. */
  resync: (taskId: string) => void;
  clear: () => void;
}

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:3001';

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketResult {
  const { userId, url = WS_URL, enabled = true, onNotification } = options;

  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [notifications, setNotifications] = useState<RealtimeNotification[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  /** Highest sequence accepted per task. Survives reconnects. */
  const cursors = useRef<Record<string, number>>({ ...options.initialCursors });
  /** Read inside socket handlers without making them a dependency. */
  const notifyRef = useRef(onNotification);
  notifyRef.current = onNotification;

  // Serialize so a caller passing a fresh array literal each render does not
  // tear down the socket on every render.
  const subsKey = JSON.stringify(
    [...options.subscriptions]
      .map((s) => `${s.channel}:${s.id}`)
      .sort(),
  );
  const subscriptions = useMemo(
    () => (JSON.parse(subsKey) as string[]).map((s) => {
      const [channel, ...rest] = s.split(':');
      return { channel: channel as ChannelKind, id: rest.join(':') };
    }),
    [subsKey],
  );

  /** Accept an event if it advances this task's watermark. */
  const accept = useCallback((event: RealtimeEvent): boolean => {
    const seen = cursors.current[event.taskId] ?? 0;
    if (event.sequence <= seen) return false;
    cursors.current[event.taskId] = event.sequence;
    return true;
  }, []);

  useEffect(() => {
    if (!enabled || !userId) return;

    setState('connecting');
    const socket: Socket = io(url, {
      auth: { userId },
      transports: ['websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8_000,
    });
    socketRef.current = socket;

    const subscribeAll = () => {
      for (const sub of subscriptions) {
        socket.emit('subscribe', sub, (ack?: { ok: boolean; error?: string }) => {
          if (ack && !ack.ok) {
            setError(
              ack.error === 'FORBIDDEN'
                ? `You do not have access to ${sub.channel} ${sub.id}.`
                : (ack.error ?? 'Subscription failed.'),
            );
          }
        });
      }
      // Rooms are re-joined above; now close any gap opened while we were away.
      //
      // Sync every subscribed task, not only those with a cursor: a socket that
      // drops before its first event has no cursor at all, and skipping those
      // would silently lose everything that happened while it was down.
      // lastSequence 0 asks for a snapshot, which is the correct cold start.
      const taskIds = new Set<string>([
        ...Object.keys(cursors.current),
        ...subscriptions.filter((s) => s.channel === 'task').map((s) => s.id),
      ]);

      for (const taskId of taskIds) {
        const lastSequence = cursors.current[taskId] ?? 0;
        socket.emit(
          'sync',
          { taskId, lastSequence },
          (res: { events?: RealtimeEvent[]; mode?: string } | { ok: boolean }) => {
            if (!('events' in res) || !res.events) return;
            const fresh = res.events.filter(accept);
            if (fresh.length > 0) {
              setEvents((prev) => [...prev, ...fresh]);
              setUnseenCount((n) => n + fresh.length);
            }
          },
        );
      }
    };

    socket.on('connect', () => {
      setState('connected');
      setError(null);
      subscribeAll();
    });

    socket.on('task:event', (event: RealtimeEvent) => {
      if (!accept(event)) return; // duplicate or stale
      setEvents((prev) => [...prev, event]);
      setUnseenCount((n) => n + 1);
    });

    socket.on('notification', (n: RealtimeNotification) => {
      setNotifications((prev) => [n, ...prev].slice(0, 50));
      notifyRef.current?.(n);
    });

    socket.on('subscription:error', (payload: { error: string }) => {
      setError(payload.error);
    });

    socket.on('disconnect', (reason: string) => {
      setState('disconnected');
      // An explicit server-side disconnect will not auto-reconnect.
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (err: Error) => {
      setState('error');
      setError(
        err.message === 'UNAUTHENTICATED'
          ? 'Realtime connection rejected: not authenticated.'
          : `Realtime connection failed: ${err.message}`,
      );
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, [url, userId, enabled, subscriptions, accept]);

  const resync = useCallback(
    (taskId: string) => {
      const socket = socketRef.current;
      if (!socket?.connected) return;
      socket.emit(
        'sync',
        { taskId, lastSequence: cursors.current[taskId] ?? 0 },
        (res: { events?: RealtimeEvent[] } | { ok: boolean }) => {
          if (!('events' in res) || !res.events) return;
          const fresh = res.events.filter(accept);
          if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh]);
        },
      );
    },
    [accept],
  );

  const markSeen = useCallback(() => setUnseenCount(0), []);
  const clear = useCallback(() => {
    setEvents([]);
    setUnseenCount(0);
  }, []);

  return {
    events,
    notifications,
    isConnected: state === 'connected',
    state,
    error,
    unseenCount,
    markSeen,
    resync,
    clear,
  };
}

/** Seed the client watermark from events already fetched over HTTP. */
export function cursorsFromEvents(events: TaskEventDto[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    out[e.taskId] = Math.max(out[e.taskId] ?? 0, e.sequence);
  }
  return out;
}
