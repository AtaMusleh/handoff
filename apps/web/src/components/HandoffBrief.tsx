import { useMemo, useState } from 'react';
import { EventType, TaskStatus } from '@handoff/domain';
import type { HandoffBriefDto, TaskEventDto, TaskResponse } from '@/lib/schemas';
import { describeEvent } from './Timeline';
import { formatRelative, shortId } from '@/lib/format';

/**
 * The context card a receiver sees when a task is handed to them.
 *
 * The AI brief is generated asynchronously by the `handoff-brief` worker, so
 * three states matter: generating, ready, and unavailable. The last one is not
 * an error state — {@link buildFallbackBrief} derives a usable brief straight
 * from the event stream, so a receiver is never left with nothing while the
 * model is slow or down.
 */

export interface BriefSections {
  objective: string;
  whatHappened: string[];
  decisions: string[];
  blockers: string[];
  remainingWork: string[];
  suggestedNextAction: string;
  /** Whether this came from the model or was derived locally. */
  source: 'ai' | 'derived';
  model?: string;
  confidence?: number;
}

/**
 * Turn an AI brief into display sections.
 *
 * `HandoffBriefContent` stores `summary` / `keyContext` / `openQuestions` /
 * `blockers`; the richer shape the UI wants is mapped from those, with the
 * event stream filling the gaps the stored content does not cover.
 */
export function toSections(
  brief: HandoffBriefDto,
  task: TaskResponse,
  events: TaskEventDto[],
): BriefSections {
  const derived = buildFallbackBrief(task, events);
  return {
    objective: brief.content.summary || derived.objective,
    whatHappened: derived.whatHappened,
    decisions: brief.content.keyContext.length ? brief.content.keyContext : derived.decisions,
    blockers: brief.content.blockers.length ? brief.content.blockers : derived.blockers,
    remainingWork: brief.content.openQuestions.length
      ? brief.content.openQuestions
      : derived.remainingWork,
    suggestedNextAction: derived.suggestedNextAction,
    source: 'ai',
    model: brief.model,
    confidence: brief.content.confidence,
  };
}

/**
 * Deterministic brief, built from the event stream alone.
 *
 * Used when the model is unavailable or still working. It is genuinely useful
 * rather than a placeholder: the stream already records who did what, why a
 * task was blocked, and what state it is in.
 */
export function buildFallbackBrief(
  task: TaskResponse,
  events: TaskEventDto[],
): BriefSections {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  const whatHappened = ordered.slice(-8).map((e) => {
    const p = describeEvent(e);
    return `${p.title}${p.detail ? ` — ${p.detail}` : ''} (${formatRelative(e.createdAt)})`;
  });

  const decisions = ordered
    .filter(
      (e) =>
        e.type === EventType.TaskTransferred ||
        e.type === EventType.TaskReopened ||
        e.type === EventType.TaskUnblocked,
    )
    .map((e) => {
      if (e.type === EventType.TaskTransferred) {
        return `Handed off to ${shortId(e.payload.toUserId)}${
          e.payload.reason ? `: ${e.payload.reason}` : ''
        }`;
      }
      if (e.type === EventType.TaskReopened) return `Reopened: ${e.payload.reason}`;
      if (e.type === EventType.TaskUnblocked) return `Unblocked: ${e.payload.resolution}`;
      return '';
    })
    .filter(Boolean);

  // Only blocks that were never resolved still count as risks.
  const blockers: string[] = [];
  for (const e of ordered) {
    if (e.type === EventType.TaskBlocked) blockers.push(e.payload.reason);
    if (e.type === EventType.TaskUnblocked) blockers.pop();
  }

  const remainingWork: string[] = [];
  if (task.status === TaskStatus.BLOCKED) {
    remainingWork.push('Clear the outstanding blocker before continuing.');
  }
  if (task.status !== TaskStatus.COMPLETED) {
    remainingWork.push('Finish the work and mark the task complete.');
  }
  if (remainingWork.length === 0) remainingWork.push('Nothing outstanding.');

  const suggestedNextAction =
    task.status === TaskStatus.TRANSFERRED
      ? 'Accept the handoff to take ownership, then start work.'
      : task.status === TaskStatus.BLOCKED
        ? 'Resolve the blocker, then unblock the task.'
        : task.status === TaskStatus.ASSIGNED
          ? 'Start the task when you pick it up.'
          : 'Review the timeline and continue where the previous owner left off.';

  return {
    objective: task.title,
    whatHappened: whatHappened.length ? whatHappened : ['No activity recorded yet.'],
    decisions: decisions.length ? decisions : ['No explicit decisions recorded.'],
    blockers,
    remainingWork,
    suggestedNextAction,
    source: 'derived',
  };
}

// -----------------------------------------------------------------------------

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4
        className="text-xs font-semibold tracking-wide uppercase"
        style={{ color: 'var(--text-subtle)' }}
      >
        {title}
      </h4>
      <ul className="mt-1.5 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span aria-hidden="true" style={{ color: 'var(--text-subtle)' }}>
              •
            </span>
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkeletonLine({ width }: { width: string }) {
  return (
    <div
      className="h-3 animate-pulse rounded"
      style={{ width, background: 'var(--surface-2)' }}
    />
  );
}

export function HandoffBrief({
  task,
  events,
  brief,
  isGenerating,
  fromUserId,
  onMarkRead,
  isRead,
  compact = false,
}: {
  task: TaskResponse;
  events: TaskEventDto[];
  /** Null while the worker has not written one. */
  brief: HandoffBriefDto | null;
  /** True while waiting on the worker; drives the loading state. */
  isGenerating?: boolean;
  fromUserId?: string | null;
  onMarkRead?: () => void;
  isRead?: boolean;
  compact?: boolean;
}) {
  const sections = useMemo(
    () => (brief ? toSections(brief, task, events) : buildFallbackBrief(task, events)),
    [brief, task, events],
  );

  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <section
      className="card animate-slide-up overflow-hidden"
      style={{ borderColor: 'var(--accent)' }}
      aria-labelledby="brief-heading"
    >
      <header
        className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"
        style={{ background: 'var(--accent-soft)' }}
      >
        <div className="min-w-0">
          <h3 id="brief-heading" className="text-sm font-semibold">
            Handoff brief
          </h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {fromUserId ? `Handed to you by ${shortId(fromUserId)}` : 'Handed to you'}
          </p>
        </div>

        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={{
            background: 'var(--surface)',
            color: sections.source === 'ai' ? 'var(--accent)' : 'var(--text-muted)',
          }}
          title={
            sections.source === 'ai'
              ? `Generated by ${sections.model}`
              : 'Derived from the event history because no AI brief is available.'
          }
        >
          {isGenerating
            ? 'Generating…'
            : sections.source === 'ai'
              ? `AI · ${sections.model}`
              : 'Derived from history'}
        </span>
      </header>

      <div className="space-y-4 p-4">
        {isGenerating && !brief ? (
          <div className="space-y-3" aria-live="polite" aria-busy="true">
            <span className="sr-only">Generating the handoff brief.</span>
            <SkeletonLine width="70%" />
            <SkeletonLine width="90%" />
            <SkeletonLine width="55%" />
            <SkeletonLine width="80%" />
            <p className="pt-1 text-xs" style={{ color: 'var(--text-subtle)' }}>
              Showing history-derived context below until the AI brief arrives.
            </p>
          </div>
        ) : null}

        <div>
          <h4
            className="text-xs font-semibold tracking-wide uppercase"
            style={{ color: 'var(--text-subtle)' }}
          >
            Objective
          </h4>
          <p className="mt-1.5 text-sm">{sections.objective}</p>
        </div>

        {!compact && <Section title="What happened" items={sections.whatHappened} />}
        <Section title="Decisions" items={sections.decisions} />
        <Section title="Blockers &amp; risks" items={sections.blockers} />
        <Section title="Remaining work" items={sections.remainingWork} />

        <div
          className="rounded-lg p-3"
          style={{ background: 'var(--surface-2)' }}
        >
          <h4
            className="text-xs font-semibold tracking-wide uppercase"
            style={{ color: 'var(--text-subtle)' }}
          >
            Suggested next action
          </h4>
          <p className="mt-1 text-sm">{sections.suggestedNextAction}</p>
        </div>

        {typeof sections.confidence === 'number' && (
          <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            Model confidence: {Math.round(sections.confidence * 100)}%
          </p>
        )}
      </div>

      {onMarkRead && (
        <footer className="flex justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            className="btn"
            onClick={() => {
              onMarkRead();
              setDismissed(true);
            }}
            disabled={isRead}
          >
            {isRead ? 'Read' : 'Mark as read'}
          </button>
        </footer>
      )}
    </section>
  );
}
