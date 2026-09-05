import { TaskStatus } from '@handoff/domain';

/**
 * Status pill.
 *
 * Colours come from CSS variables rather than Tailwind colour utilities, so the
 * dark palette is a variable swap instead of a `dark:` class on every branch.
 */
const STYLES: Record<TaskStatus, { bg: string; fg: string; label: string }> = {
  [TaskStatus.BACKLOG]: {
    bg: 'var(--status-backlog-bg)',
    fg: 'var(--status-backlog-fg)',
    label: 'Backlog',
  },
  [TaskStatus.ASSIGNED]: {
    bg: 'var(--status-assigned-bg)',
    fg: 'var(--status-assigned-fg)',
    label: 'Assigned',
  },
  [TaskStatus.IN_PROGRESS]: {
    bg: 'var(--status-progress-bg)',
    fg: 'var(--status-progress-fg)',
    label: 'In progress',
  },
  [TaskStatus.BLOCKED]: {
    bg: 'var(--status-blocked-bg)',
    fg: 'var(--status-blocked-fg)',
    label: 'Blocked',
  },
  [TaskStatus.COMPLETED]: {
    bg: 'var(--status-completed-bg)',
    fg: 'var(--status-completed-fg)',
    label: 'Completed',
  },
  [TaskStatus.TRANSFERRED]: {
    bg: 'var(--status-transferred-bg)',
    fg: 'var(--status-transferred-fg)',
    label: 'Transferred',
  },
};

export function StatusBadge({
  status,
  size = 'sm',
}: {
  status: TaskStatus;
  size?: 'sm' | 'md';
}) {
  const style = STYLES[status];
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium whitespace-nowrap ${
        size === 'md' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs'
      }`}
      style={{ background: style.bg, color: style.fg }}
    >
      {/* Colour alone must not carry the meaning: the label always shows. */}
      {style.label}
    </span>
  );
}

export function statusLabel(status: TaskStatus): string {
  return STYLES[status].label;
}
