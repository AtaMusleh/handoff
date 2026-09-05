import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskEventDto, TaskResponse, UserSummary } from '@/lib/schemas';
import { ApiError, listUsers, transferTask } from '@/lib/api';
import { Modal } from './Modal';
import { Avatar } from './Avatar';
import { useToast } from './Toast';
import { HandoffBrief } from './HandoffBrief';
import { shortId } from '@/lib/format';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Receiver picker.
 *
 * Prefers the user-search endpoint, but that route does not exist server-side
 * yet (see `listUsers`). Rather than blocking transfers behind a missing API,
 * it falls back to accepting a pasted user id — the transfer itself works
 * either way.
 */
function ReceiverPicker({
  value,
  onChange,
  actorId,
  excludeUserId,
}: {
  value: string;
  onChange: (id: string, user?: UserSummary) => void;
  actorId?: string;
  excludeUserId?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSummary[]>([]);
  const [searchAvailable, setSearchAvailable] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!searchAvailable || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    if (debounce.current) clearTimeout(debounce.current);

    debounce.current = setTimeout(() => {
      setIsSearching(true);
      listUsers(query.trim(), { signal: controller.signal, actorId })
        .then((users) => setResults(users.filter((u) => u.id !== excludeUserId)))
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // 404 means the endpoint is not deployed, not that nobody matched.
          if (err instanceof ApiError && err.isUnavailable) setSearchAvailable(false);
        })
        .finally(() => setIsSearching(false));
    }, 250);

    return () => {
      controller.abort();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, searchAvailable, actorId, excludeUserId]);

  return (
    <div>
      <label htmlFor="receiver" className="mb-1 block text-sm font-medium">
        Transfer to
      </label>

      {searchAvailable ? (
        <>
          <input
            id="receiver"
            className="input"
            placeholder="Search by name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="receiver-results"
          />
          {isSearching && (
            <p className="mt-1 text-xs" style={{ color: 'var(--text-subtle)' }}>
              Searching…
            </p>
          )}
          {results.length > 0 && (
            <ul
              id="receiver-results"
              className="card mt-1 max-h-44 list-none overflow-y-auto p-1"
            >
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(u.id, u);
                      setQuery(u.displayName);
                      setResults([]);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                    style={{ background: value === u.id ? 'var(--accent-soft)' : undefined }}
                  >
                    <Avatar userId={u.id} name={u.displayName} size={24} />
                    <span className="min-w-0">
                      <span className="block truncate">{u.displayName}</span>
                      <span className="block truncate text-xs" style={{ color: 'var(--text-subtle)' }}>
                        {u.email}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <input
            id="receiver"
            className="input font-mono text-xs"
            placeholder="00000000-0000-0000-0000-000000000000"
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            autoComplete="off"
            aria-describedby="receiver-hint"
          />
          <p id="receiver-hint" className="mt-1 text-xs" style={{ color: 'var(--text-subtle)' }}>
            User search is unavailable, so enter the recipient&rsquo;s id directly.
          </p>
        </>
      )}
    </div>
  );
}

export function TransferModal({
  open,
  onClose,
  task,
  events,
  actorId,
  currentOwnerName,
  onTransferred,
}: {
  open: boolean;
  onClose: () => void;
  task: TaskResponse;
  events: TaskEventDto[];
  actorId: string;
  currentOwnerName?: string;
  onTransferred?: (next: TaskResponse) => void;
}) {
  const toast = useToast();
  const [toUserId, setToUserId] = useState('');
  const [toUser, setToUser] = useState<UserSummary | undefined>();
  const [reason, setReason] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear state each time the dialog opens; a stale recipient is a real hazard.
  useEffect(() => {
    if (open) {
      setToUserId('');
      setToUser(undefined);
      setReason('');
      setShowPreview(false);
      setError(null);
    }
  }, [open]);

  const isSelf = toUserId !== '' && toUserId === task.ownerId;
  const canSubmit = UUID_RE.test(toUserId) && !isSelf && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const { task: next } = await transferTask(
        task.id,
        {
          toUserId,
          reason: reason.trim() || null,
          // Optimistic lock: refuse if the task moved while the dialog was open.
          expectedVersion: task.version,
        },
        { actorId },
      );
      toast.success(`Task handed off to ${toUser?.displayName ?? shortId(toUserId)}.`);
      onTransferred?.(next);
      onClose();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.isConflict
            ? 'This task changed while the dialog was open. Close it, reload, and try again.'
            : err.message
          : 'Transfer failed.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, task.id, task.version, toUserId, reason, actorId, toUser, toast, onTransferred, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Transfer task"
      description="Ownership moves once the recipient accepts. Until then the task stays with you."
      width="max-w-xl"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {submitting ? 'Transferring…' : 'Confirm transfer'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <ReceiverPicker
          value={toUserId}
          onChange={(id, user) => {
            setToUserId(id);
            setToUser(user);
          }}
          actorId={actorId}
          excludeUserId={task.ownerId}
        />

        {isSelf && (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            This task is already owned by that person.
          </p>
        )}

        <div>
          <label htmlFor="transfer-reason" className="mb-1 block text-sm font-medium">
            Reason <span style={{ color: 'var(--text-subtle)' }}>(optional)</span>
          </label>
          <textarea
            id="transfer-reason"
            className="input min-h-20 resize-y"
            placeholder="Why are you handing this over? This is the first thing they will read."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
          />
          <p className="mt-1 text-right text-xs" style={{ color: 'var(--text-subtle)' }}>
            {reason.length}/2000
          </p>
        </div>

        {/* Preview */}
        <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Avatar userId={task.ownerId} name={currentOwnerName} size={24} />
            <span className="font-medium">
              {currentOwnerName ?? shortId(task.ownerId)}
            </span>
            <span aria-hidden="true" style={{ color: 'var(--text-subtle)' }}>
              →
            </span>
            <Avatar userId={toUserId || null} name={toUser?.displayName} size={24} />
            <span className="font-medium">
              {toUser?.displayName ?? (toUserId ? shortId(toUserId) : 'nobody yet')}
            </span>
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {toUserId
              ? `Transferring “${task.title}” from ${
                  currentOwnerName ?? shortId(task.ownerId)
                } to ${toUser?.displayName ?? shortId(toUserId)}.`
              : 'Choose a recipient to see the summary.'}
          </p>
        </div>

        <div>
          <button
            type="button"
            className="text-sm underline underline-offset-2"
            style={{ color: 'var(--accent)' }}
            onClick={() => setShowPreview((v) => !v)}
            aria-expanded={showPreview}
          >
            {showPreview ? 'Hide' : 'Preview'} what the recipient will see
          </button>

          {showPreview && (
            <div className="animate-fade-in mt-3">
              {/*
                The real brief is written by the worker after the transfer
                lands, so this preview shows the deterministic version built
                from history — which is also the fallback the recipient sees if
                the model is unavailable.
              */}
              <HandoffBrief
                task={task}
                events={events}
                brief={null}
                fromUserId={task.ownerId}
                compact
              />
              <p className="mt-2 text-xs" style={{ color: 'var(--text-subtle)' }}>
                A richer AI brief is generated after the transfer. This preview shows the
                history-derived version.
              </p>
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
