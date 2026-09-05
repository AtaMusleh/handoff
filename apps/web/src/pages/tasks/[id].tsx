import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HandoffStatus, TaskStatus } from '@handoff/domain';

import { ConnectionPill, Layout } from '@/components/Layout';
import { StatusBadge, statusLabel } from '@/components/StatusBadge';
import { Avatar } from '@/components/Avatar';
import { Modal } from '@/components/Modal';
import { Timeline } from '@/components/Timeline';
import { TransferModal } from '@/components/TransferModal';
import { HandoffBrief } from '@/components/HandoffBrief';
import { useToast } from '@/components/Toast';
import { cursorsFromEvents, useWebSocket, type Subscription } from '@/hooks/useWebSocket';
import {
  ApiError,
  acceptHandoff,
  addComment,
  blockTask,
  completeTask,
  getHandoff,
  getTask,
  listComments,
  listTaskHandoffs,
  startTask,
  unblockTask,
} from '@/lib/api';
import type {
  CommentDto,
  HandoffBriefDto,
  HandoffDto,
  TaskEventDto,
  TaskResponse,
} from '@/lib/schemas';
import { formatAbsolute, formatRelative, shortId } from '@/lib/format';
import { getCurrentUserId } from '@/lib/session';

const READ_BRIEFS_KEY = 'handoff.readBriefs';

function useReadBriefs(): [Set<string>, (id: string) => void] {
  const [read, setRead] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(READ_BRIEFS_KEY);
      if (raw) setRead(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* storage blocked; treat everything as unread */
    }
  }, []);

  const mark = useCallback((id: string) => {
    setRead((prev) => {
      const next = new Set(prev).add(id);
      try {
        window.localStorage.setItem(READ_BRIEFS_KEY, JSON.stringify([...next]));
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }, []);

  return [read, mark];
}

// -----------------------------------------------------------------------------

function BlockModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Block task"
      description="A reason is required — it is what the next owner reads first."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!reason.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(reason.trim());
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Blocking…' : 'Block task'}
          </button>
        </>
      }
    >
      <label htmlFor="block-reason" className="mb-1 block text-sm font-medium">
        Reason
      </label>
      <textarea
        id="block-reason"
        className="input min-h-24 resize-y"
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What is this waiting on?"
      />
    </Modal>
  );
}

function Comments({
  taskId,
  actorId,
}: {
  taskId: string;
  actorId: string;
}) {
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listComments(taskId, { actorId })
      .then((c) => !cancelled && setComments(c))
      .catch((err: unknown) => {
        // The comments route does not exist server-side yet; a 404 here means
        // "not built", not "task missing". Degrade instead of erroring.
        if (!cancelled && err instanceof ApiError && err.isUnavailable) setAvailable(false);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [taskId, actorId]);

  const post = async () => {
    if (!draft.trim()) return;
    setPosting(true);
    try {
      const created = await addComment(taskId, { body: draft.trim() }, { actorId });
      setComments((prev) => [...prev, created]);
      setDraft('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not post the comment.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="card mt-6 p-4" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="text-sm font-semibold">
        Comments
      </h2>

      {!available ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-subtle)' }}>
          Comments are not available yet — the API does not expose{' '}
          <code className="text-xs">/tasks/:id/comments</code>.
        </p>
      ) : loading ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-subtle)' }}>
          Loading…
        </p>
      ) : (
        <>
          <ul className="mt-3 list-none space-y-3 p-0">
            {comments.map((c) => (
              <li key={c.id} className="flex gap-2">
                <Avatar userId={c.authorId} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{shortId(c.authorId)}</span>
                    <time
                      className="text-xs"
                      style={{ color: 'var(--text-subtle)' }}
                      dateTime={c.createdAt}
                      title={formatAbsolute(c.createdAt)}
                    >
                      {formatRelative(c.createdAt)}
                    </time>
                  </div>
                  <p className="mt-0.5 text-sm break-words">{c.body}</p>
                </div>
              </li>
            ))}
            {comments.length === 0 && (
              <li className="text-sm" style={{ color: 'var(--text-subtle)' }}>
                No comments yet.
              </li>
            )}
          </ul>

          <div className="mt-4">
            <label htmlFor="comment-draft" className="sr-only">
              Add a comment
            </label>
            <textarea
              id="comment-draft"
              className="input min-h-20 resize-y"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a comment…"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!draft.trim() || posting}
                onClick={() => void post()}
              >
                {posting ? 'Posting…' : 'Comment'}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------

export default function TaskDetailPage() {
  const router = useRouter();
  const taskId = typeof router.query.id === 'string' ? router.query.id : null;

  const toast = useToast();
  const [userId, setUserId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [events, setEvents] = useState<TaskEventDto[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffDto[]>([]);
  const [brief, setBrief] = useState<HandoffBriefDto | null>(null);
  const [briefPending, setBriefPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [readBriefs, markBriefRead] = useReadBriefs();

  /** Ids that arrived over the socket, so the timeline can animate only those. */
  const liveIds = useRef<Set<string>>(new Set());

  useEffect(() => setUserId(getCurrentUserId()), []);

  const subscriptions = useMemo<Subscription[]>(() => {
    const subs: Subscription[] = [];
    if (taskId) subs.push({ channel: 'task', id: taskId });
    if (userId) subs.push({ channel: 'user', id: userId });
    return subs;
  }, [taskId, userId]);

  const { isConnected, state, events: liveEvents } = useWebSocket({
    userId: userId ?? '',
    subscriptions,
    enabled: Boolean(userId && taskId),
    initialCursors: useMemo(() => cursorsFromEvents(events), [events]),
  });

  const load = useCallback(async () => {
    if (!taskId || !userId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const detail = await getTask(taskId, { actorId: userId });
      setTask(detail.task);
      setEvents(detail.events);

      const list = await listTaskHandoffs(taskId, { actorId: userId }).catch(() => []);
      setHandoffs(list);

      // The brief belongs to the pending handoff addressed to this user.
      const mine = list.find(
        (h) => h.status === HandoffStatus.PENDING && h.toUserId === userId,
      );
      if (mine) {
        setBriefPending(true);
        try {
          const detailed = await getHandoff(mine.id, { actorId: userId });
          setBrief(detailed.brief);
        } catch {
          setBrief(null);
        } finally {
          setBriefPending(false);
        }
      } else {
        setBrief(null);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load the task.');
    } finally {
      setLoading(false);
    }
  }, [taskId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Merge socket events into the timeline immediately, then refetch the task so
  // status and version stay authoritative.
  useEffect(() => {
    if (liveEvents.length === 0 || !taskId) return;
    const relevant = liveEvents.filter((e) => e.taskId === taskId);
    if (relevant.length === 0) return;

    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const additions = relevant
        .filter((e) => !seen.has(e.eventId))
        .map((e) => {
          liveIds.current.add(e.eventId);
          return {
            id: e.eventId,
            taskId: e.taskId,
            type: e.type,
            actorId: null,
            payload: e.payload,
            sequence: e.sequence,
            createdAt: e.timestamp,
          } as TaskEventDto;
        });
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });

    void load();
    // `load` is stable per (taskId, userId); re-running on every live event is
    // the point.
  }, [liveEvents, taskId, load]);

  const run = useCallback(
    async (label: string, fn: () => Promise<TaskResponse>) => {
      setBusy(label);
      try {
        setTask(await fn());
        toast.success(`Task ${label}.`);
        void load();
      } catch (err) {
        toast.error(
          err instanceof ApiError
            ? err.isConflict
              ? 'Someone else changed this task. Reloading.'
              : err.message
            : `Could not ${label} the task.`,
        );
        if (err instanceof ApiError && err.isConflict) void load();
      } finally {
        setBusy(null);
      }
    },
    [toast, load],
  );

  if (!userId) {
    return (
      <Layout>
        <p className="mt-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          <Link href="/" className="underline underline-offset-2">
            Choose a user
          </Link>{' '}
          to view this task.
        </p>
      </Layout>
    );
  }

  if (loading && !task) {
    return (
      <Layout>
        <div className="card animate-pulse p-6" aria-busy="true">
          <div className="h-5 w-1/3 rounded" style={{ background: 'var(--surface-2)' }} />
          <div className="mt-3 h-3 w-1/2 rounded" style={{ background: 'var(--surface-2)' }} />
        </div>
      </Layout>
    );
  }

  if (loadError || !task) {
    return (
      <Layout>
        <div className="card p-6 text-center">
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            {loadError ?? 'Task not found.'}
          </p>
          <Link href="/" className="btn mt-4 inline-flex">
            Back to dashboard
          </Link>
        </div>
      </Layout>
    );
  }

  const isOwner = task.ownerId === userId;
  const can = (s: TaskStatus) => task.validNextStates.includes(s);
  const pendingForMe = handoffs.find(
    (h) => h.status === HandoffStatus.PENDING && h.toUserId === userId,
  );

  return (
    <Layout actions={<ConnectionPill isConnected={isConnected} state={state} />}>
      <Link
        href="/"
        className="mb-4 inline-block text-sm underline underline-offset-2"
        style={{ color: 'var(--text-muted)' }}
      >
        ← All tasks
      </Link>

      <header className="card mb-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words">
            {task.title}
          </h1>
          <StatusBadge status={task.status} size="md" />
        </div>
        <p className="mt-2 text-xs" style={{ color: 'var(--text-subtle)' }}>
          Created {formatRelative(task.createdAt)} · version {task.version}
        </p>
      </header>

      {/* Incoming handoff: brief first, it is the reason the page was opened. */}
      {pendingForMe && (
        <div className="mb-6">
          <HandoffBrief
            task={task}
            events={events}
            brief={brief}
            isGenerating={briefPending}
            fromUserId={pendingForMe.fromUserId}
            isRead={readBriefs.has(pendingForMe.id)}
            onMarkRead={() => markBriefRead(pendingForMe.id)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() =>
                void run('accepted', async () => {
                  const { task: next } = await acceptHandoff(
                    pendingForMe.id,
                    { userId },
                    { actorId: userId },
                  );
                  return next;
                })
              }
            >
              Accept handoff
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Timeline */}
        <section className="card p-4 lg:col-span-2" aria-labelledby="timeline-heading">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="timeline-heading" className="text-sm font-semibold">
              Timeline
            </h2>
            <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>
              {events.length} {events.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          <Timeline events={events} liveEventIds={liveIds.current} />
        </section>

        {/* Side panel */}
        <aside className="space-y-4">
          <section className="card p-4" aria-labelledby="owner-heading">
            <h2 id="owner-heading" className="text-xs font-semibold tracking-wide uppercase"
              style={{ color: 'var(--text-subtle)' }}>
              Owner
            </h2>
            <div className="mt-2 flex items-center gap-2">
              <Avatar userId={task.ownerId} size={32} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {task.ownerId ? shortId(task.ownerId, 12) : 'Unassigned'}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                  {isOwner ? 'That is you' : task.ownerId ? 'Someone else' : 'In the backlog'}
                </p>
              </div>
            </div>

            <h2 className="mt-4 text-xs font-semibold tracking-wide uppercase"
              style={{ color: 'var(--text-subtle)' }}>
              Status
            </h2>
            <div className="mt-2">
              <StatusBadge status={task.status} size="md" />
            </div>
          </section>

          <section className="card p-4" aria-labelledby="actions-heading">
            <h2 id="actions-heading" className="text-xs font-semibold tracking-wide uppercase"
              style={{ color: 'var(--text-subtle)' }}>
              Actions
            </h2>

            {/*
              Buttons are enabled from `validNextStates`, which the API derives
              from the transition matrix — so the UI never offers a move the
              server would reject with a 422.
            */}
            <div className="mt-3 grid grid-cols-1 gap-2">
              <button
                type="button"
                className="btn"
                disabled={!can(TaskStatus.IN_PROGRESS) || task.status === TaskStatus.BLOCKED || busy !== null}
                onClick={() => void run('started', () => startTask(task.id, task.version, { actorId: userId }))}
              >
                Start
              </button>

              {task.status === TaskStatus.BLOCKED ? (
                <button
                  type="button"
                  className="btn"
                  disabled={!can(TaskStatus.IN_PROGRESS) || busy !== null}
                  onClick={() =>
                    void run('unblocked', () =>
                      unblockTask(task.id, { expectedVersion: task.version }, { actorId: userId }),
                    )
                  }
                >
                  Unblock
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!can(TaskStatus.BLOCKED) || busy !== null}
                  onClick={() => setBlockOpen(true)}
                >
                  Block
                </button>
              )}

              <button
                type="button"
                className="btn"
                disabled={!can(TaskStatus.COMPLETED) || busy !== null}
                onClick={() =>
                  void run('completed', () =>
                    completeTask(task.id, { expectedVersion: task.version }, { actorId: userId }),
                  )
                }
              >
                Complete
              </button>

              <button
                type="button"
                className="btn"
                disabled={!can(TaskStatus.TRANSFERRED) || busy !== null}
                onClick={() => setTransferOpen(true)}
              >
                Transfer
              </button>
            </div>

            {!isOwner && task.ownerId && (
              <p className="mt-3 text-xs" style={{ color: 'var(--text-subtle)' }}>
                You do not own this task, so most actions will be refused.
              </p>
            )}
          </section>

          {handoffs.length > 0 && (
            <section className="card p-4" aria-labelledby="handoffs-heading">
              <h2 id="handoffs-heading" className="text-xs font-semibold tracking-wide uppercase"
                style={{ color: 'var(--text-subtle)' }}>
                Handoffs
              </h2>
              <ul className="mt-2 list-none space-y-2 p-0 text-sm">
                {handoffs.map((h) => (
                  <li key={h.id} className="flex items-center gap-2">
                    <Avatar userId={h.toUserId} size={20} />
                    <span className="min-w-0 truncate">→ {shortId(h.toUserId)}</span>
                    <span
                      className="ml-auto text-xs"
                      style={{ color: 'var(--text-subtle)' }}
                      title={formatAbsolute(h.createdAt)}
                    >
                      {h.status.toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>

      <Comments taskId={task.id} actorId={userId} />

      <BlockModal
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        onSubmit={(reason) =>
          run('blocked', () =>
            blockTask(task.id, { reason, expectedVersion: task.version }, { actorId: userId }),
          )
        }
      />

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        task={task}
        events={events}
        actorId={userId}
        onTransferred={(next) => {
          setTask(next);
          void load();
        }}
      />
    </Layout>
  );
}
