import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TaskStatus } from '@handoff/domain';

import { Layout, ConnectionPill } from '@/components/Layout';
import { StatusBadge, statusLabel } from '@/components/StatusBadge';
import { Avatar } from '@/components/Avatar';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { useWebSocket, type Subscription } from '@/hooks/useWebSocket';
import { ApiError, createTask, devLogin, listTasks } from '@/lib/api';
import type { TaskResponse } from '@/lib/schemas';
import { formatDate, formatRelative } from '@/lib/format';
import {
  getCurrentProjectId,
  getCurrentUserId,
  setAuthToken,
  setCurrentUserId,
} from '@/lib/session';

/** Board column order. Terminal states sit last. */
const COLUMNS: TaskStatus[] = [
  TaskStatus.BACKLOG,
  TaskStatus.ASSIGNED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.BLOCKED,
  TaskStatus.COMPLETED,
];

/** A deadline in the past on work that is not finished. */
function isOverdue(task: TaskResponse): boolean {
  if (!task.dueDate) return false;
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.TRANSFERRED) return false;
  return Date.parse(task.dueDate) < Date.now();
}

function TaskCard({ task }: { task: TaskResponse }) {
  return (
    <Link
      href={`/tasks/${task.id}`}
      className="card animate-fade-in block p-3 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-sm font-medium break-words">{task.title}</h3>
        <StatusBadge status={task.status} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Avatar userId={task.ownerId} size={22} />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {task.ownerId ? 'Owned' : 'Unassigned'}
        </span>
        {/* Due date when there is one, otherwise the creation date. */}
        {task.dueDate ? (
          <time
            className="ml-auto text-xs font-medium"
            style={{ color: isOverdue(task) ? 'var(--danger)' : 'var(--text-muted)' }}
            dateTime={task.dueDate}
            title={`Due ${formatRelative(task.dueDate)}`}
          >
            Due {formatDate(task.dueDate)}
          </time>
        ) : (
          <time
            className="ml-auto text-xs"
            style={{ color: 'var(--text-subtle)' }}
            dateTime={task.createdAt}
            title={`Created ${formatRelative(task.createdAt)}`}
          >
            {formatDate(task.createdAt)}
          </time>
        )}
      </div>
    </Link>
  );
}

function CreateTaskModal({
  open,
  onClose,
  actorId,
  defaultProjectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  actorId: string;
  defaultProjectId: string;
  onCreated: (task: TaskResponse) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [assignToMe, setAssignToMe] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setProjectId(defaultProjectId);
      setError(null);
    }
  }, [open, defaultProjectId]);

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const task = await createTask(
        {
          title: title.trim(),
          projectId: projectId.trim(),
          ...(assignToMe ? { ownerId: actorId } : {}),
        },
        { actorId },
      );
      toast.success('Task created.');
      onCreated(task);
      onClose();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not create the task.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create task"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!title.trim() || !projectId.trim() || submitting}
          >
            {submitting ? 'Creating…' : 'Create task'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="task-title" className="mb-1 block text-sm font-medium">
            Title
          </label>
          <input
            id="task-title"
            className="input"
            value={title}
            maxLength={500}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="What needs doing?"
          />
        </div>

        <div>
          <label htmlFor="task-project" className="mb-1 block text-sm font-medium">
            Project id
          </label>
          <input
            id="task-project"
            className="input font-mono text-xs"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value.trim())}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={assignToMe}
            onChange={(e) => setAssignToMe(e.target.checked)}
          />
          Assign to me (otherwise it starts in the backlog)
        </label>

        {error && (
          <p className="text-sm" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default function DashboardPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'ALL'>('ALL');
  const [createOpen, setCreateOpen] = useState(false);

  // Session identity lives in localStorage, so it can only be read on the
  // client — reading it during render would break hydration.
  useEffect(() => {
    setUserId(getCurrentUserId());
    setProjectId(getCurrentProjectId());
  }, []);

  const subscriptions = useMemo<Subscription[]>(() => {
    const subs: Subscription[] = [];
    if (projectId) subs.push({ channel: 'project', id: projectId });
    if (userId) subs.push({ channel: 'user', id: userId });
    return subs;
  }, [projectId, userId]);

  const { isConnected, state, unseenCount, markSeen, events } = useWebSocket({
    userId: userId ?? '',
    subscriptions,
    enabled: Boolean(userId),
  });

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setTasks(await listTasks({ ownerId: userId }, { actorId: userId }));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load tasks.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A live event means the projection moved; refetch rather than trying to
  // replay each transition into local state, which would duplicate the
  // reducer that already lives in the domain package.
  const lastEventId = events.length > 0 ? events[events.length - 1]!.eventId : null;
  useEffect(() => {
    if (lastEventId) void load();
  }, [lastEventId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter(
      (t) =>
        (statusFilter === 'ALL' || t.status === statusFilter) &&
        (q === '' || t.title.toLowerCase().includes(q)),
    );
  }, [tasks, search, statusFilter]);

  const grouped = useMemo(() => {
    const map = new Map<TaskStatus, TaskResponse[]>(COLUMNS.map((s) => [s, []]));
    for (const task of filtered) map.get(task.status)?.push(task);
    return map;
  }, [filtered]);

  // Transferred tasks are not one of the five board columns but must not vanish.
  const transferred = filtered.filter((t) => t.status === TaskStatus.TRANSFERRED);

  if (userId === null) {
    return (
      <Layout>
        <IdentityPrompt
          onSet={(id) => {
            setCurrentUserId(id);
            setUserId(id);
          }}
        />
      </Layout>
    );
  }

  return (
    <Layout
      actions={
        <>
          {unseenCount > 0 && (
            <button
              type="button"
              onClick={markSeen}
              className="rounded-full px-2.5 py-1 text-xs font-medium"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              title="New events received since you last checked"
            >
              {unseenCount} new {unseenCount === 1 ? 'event' : 'events'}
            </button>
          )}
          <ConnectionPill isConnected={isConnected} state={state} />
        </>
      }
    >
      {/* Hero */}
      <section className="card mb-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Your Tasks</h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              {loading
                ? 'Loading…'
                : `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} assigned to you`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen(true)}
            disabled={!projectId}
            title={projectId ? undefined : 'Set a project id first'}
          >
            + Create task
          </button>
        </div>

        {/* Search + filter */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <label htmlFor="search" className="sr-only">
              Search tasks
            </label>
            <input
              id="search"
              type="search"
              className="input"
              placeholder="Search tasks…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="status-filter" className="sr-only">
              Filter by status
            </label>
            <select
              id="status-filter"
              className="input sm:w-48"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as TaskStatus | 'ALL')}
            >
              <option value="ALL">All statuses</option>
              {Object.values(TaskStatus).map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {loadError && (
        <div
          className="card mb-6 p-4 text-sm"
          role="alert"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          {loadError}{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {/* Board */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {COLUMNS.map((status) => {
          const items = grouped.get(status) ?? [];
          return (
            <section key={status} aria-labelledby={`col-${status}`}>
              <div className="mb-2 flex items-center gap-2">
                <h2 id={`col-${status}`} className="text-sm font-semibold">
                  {statusLabel(status)}
                </h2>
                <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                  {items.length}
                </span>
              </div>
              <div className="space-y-2">
                {items.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
                {items.length === 0 && (
                  <p
                    className="rounded-lg border border-dashed p-3 text-center text-xs"
                    style={{ color: 'var(--text-subtle)' }}
                  >
                    Nothing here
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {transferred.length > 0 && (
        <section className="mt-6" aria-labelledby="col-transferred">
          <h2 id="col-transferred" className="mb-2 text-sm font-semibold">
            Awaiting handoff ({transferred.length})
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {transferred.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}

      {projectId && (
        <CreateTaskModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          actorId={userId}
          defaultProjectId={projectId}
          onCreated={(task) => setTasks((prev) => [task, ...prev])}
        />
      )}
    </Layout>
  );
}

/**
 * Development sign-in.
 *
 * Calls `POST /auth/dev-login`, which the API serves only outside production,
 * and stores the returned JWT. This is a stand-in for a real sign-in screen -
 * the server hands a session to anyone who asks.
 */
function IdentityPrompt({ onSet }: { onSet: (id: string) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async (id?: string) => {
    setBusy(true);
    setError(null);
    try {
      const session = await devLogin(id ? { id } : {});
      setAuthToken(session.token);
      onSet(session.user.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mx-auto mt-12 max-w-md p-6">
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
        Development sign-in. The server issues a session to anyone who asks, so this
        works only when the API is not running in production.
      </p>

      <button
        type="button"
        className="btn btn-primary mt-4 w-full"
        disabled={busy}
        onClick={() => void login()}
      >
        {busy ? 'Signing in…' : 'Continue as Ata Musleh'}
      </button>

      <p className="mt-4 text-xs" style={{ color: 'var(--text-subtle)' }}>
        Or sign in as a seeded user by id:
      </p>
      <input
        className="input mt-1 font-mono text-xs"
        placeholder="00000000-0000-0000-0000-000000000000"
        value={value}
        onChange={(e) => setValue(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value) void login(value);
        }}
      />
      <button
        type="button"
        className="btn mt-2 w-full"
        disabled={!value || busy}
        onClick={() => void login(value)}
      >
        Continue as that user
      </button>

      {error && (
        <p className="mt-3 text-sm" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
