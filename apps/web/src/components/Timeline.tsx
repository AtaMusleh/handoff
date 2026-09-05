import { useState } from 'react';
import { EventType } from '@handoff/domain';
import type { TaskEventDto } from '@/lib/schemas';
import { Avatar } from './Avatar';
import { formatAbsolute, formatRelative } from '@/lib/format';

/**
 * Vertical event timeline.
 *
 * Presentation is derived from the event union by exhaustive switch, so adding
 * an `EventType` without giving it a summary is a compile error rather than a
 * blank row.
 */

interface Presentation {
  icon: string;
  title: string;
  /** The one line worth reading without expanding. */
  detail?: string;
  accent: string;
}

export function describeEvent(event: TaskEventDto): Presentation {
  switch (event.type) {
    case EventType.TaskCreated:
      return {
        icon: '✦',
        title: 'Task created',
        detail: event.payload.title,
        accent: 'var(--status-backlog-fg)',
      };
    case EventType.TaskAssigned:
      return {
        icon: '→',
        title: event.payload.fromOwnerId ? 'Reassigned' : 'Assigned',
        detail: `to ${shortId(event.payload.toOwnerId)}`,
        accent: 'var(--status-assigned-fg)',
      };
    case EventType.TaskStarted:
      return { icon: '▶', title: 'Work started', accent: 'var(--status-progress-fg)' };
    case EventType.TaskUnassigned:
      return {
        icon: '↩',
        title: 'Returned to backlog',
        detail: event.payload.reason,
        accent: 'var(--status-backlog-fg)',
      };
    case EventType.TaskBlocked:
      return {
        icon: '⨯',
        title: 'Blocked',
        detail: event.payload.reason,
        accent: 'var(--status-blocked-fg)',
      };
    case EventType.TaskUnblocked:
      return {
        icon: '✓',
        title: 'Unblocked',
        detail: event.payload.resolution,
        accent: 'var(--status-progress-fg)',
      };
    case EventType.TaskTransferred:
      return {
        icon: '⇄',
        title: 'Handed off',
        detail: event.payload.reason ?? `to ${shortId(event.payload.toUserId)}`,
        accent: 'var(--status-transferred-fg)',
      };
    case EventType.TaskCompleted:
      return {
        icon: '●',
        title: 'Completed',
        detail: event.payload.note,
        accent: 'var(--status-completed-fg)',
      };
    case EventType.TaskReopened:
      return {
        icon: '↺',
        title: 'Reopened',
        detail: event.payload.reason,
        accent: 'var(--status-progress-fg)',
      };
    default: {
      // Exhaustiveness guard: a new EventType will fail to compile here.
      const exhaustive: never = event;
      return { icon: '?', title: 'Unknown event', accent: 'var(--text-muted)', detail: String(exhaustive) };
    }
  }
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function TimelineItem({
  event,
  isLast,
  isNew,
}: {
  event: TaskEventDto;
  isLast: boolean;
  isNew: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const p = describeEvent(event);
  const detailsId = `event-details-${event.id}`;

  return (
    <li className={`relative flex gap-3 pb-5 ${isNew ? 'animate-slide-in' : ''}`}>
      {/* Rail. Hidden from assistive tech: it is pure decoration. */}
      {!isLast && (
        <span
          aria-hidden="true"
          className="absolute top-8 bottom-0 left-[13px] w-px"
          style={{ background: 'var(--border)' }}
        />
      )}

      <span
        aria-hidden="true"
        className="z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs"
        style={{ background: 'var(--surface-2)', color: p.accent, border: '1px solid var(--border)' }}
      >
        {p.icon}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Avatar userId={event.actorId} size={20} />
          <span className="text-sm font-medium">{p.title}</span>
          <time
            className="text-xs"
            style={{ color: 'var(--text-subtle)' }}
            dateTime={event.createdAt}
            title={formatAbsolute(event.createdAt)}
          >
            {formatRelative(event.createdAt)}
          </time>
          <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            #{event.sequence}
          </span>
        </div>

        {p.detail && (
          <p className="mt-1 text-sm break-words" style={{ color: 'var(--text-muted)' }}>
            {p.detail}
          </p>
        )}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="mt-1 text-xs underline underline-offset-2"
          style={{ color: 'var(--text-subtle)' }}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </button>

        {expanded && (
          <pre
            id={detailsId}
            className="animate-fade-in mt-2 overflow-x-auto rounded-md p-3 text-xs"
            style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
          >
            {JSON.stringify({ type: event.type, actorId: event.actorId, payload: event.payload }, null, 2)}
          </pre>
        )}
      </div>
    </li>
  );
}

export function Timeline({
  events,
  newestFirst = true,
  liveEventIds,
}: {
  events: TaskEventDto[];
  /** Newest at the top, so live arrivals land where the eye already is. */
  newestFirst?: boolean;
  /** Ids that arrived over the socket this session; these animate in. */
  liveEventIds?: Set<string>;
}) {
  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm" style={{ color: 'var(--text-subtle)' }}>
        No events yet.
      </p>
    );
  }

  const ordered = [...events].sort((a, b) =>
    newestFirst ? b.sequence - a.sequence : a.sequence - b.sequence,
  );

  return (
    <ol className="list-none p-0">
      {ordered.map((event, i) => (
        <TimelineItem
          key={event.id}
          event={event}
          isLast={i === ordered.length - 1}
          isNew={liveEventIds?.has(event.id) ?? false}
        />
      ))}
    </ol>
  );
}
