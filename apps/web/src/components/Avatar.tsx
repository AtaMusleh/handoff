/**
 * Initials avatar.
 *
 * There is no avatar URL in the schema, so identity is conveyed by initials on a
 * hue derived from the user id — stable across renders and sessions without
 * needing to store anything.
 */
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return hash;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function Avatar({
  userId,
  name,
  size = 28,
  title,
}: {
  userId: string | null;
  name?: string;
  size?: number;
  title?: string;
}) {
  if (!userId) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed"
        style={{ width: size, height: size, fontSize: size * 0.4, color: 'var(--text-subtle)' }}
        title={title ?? 'Unassigned'}
        aria-label={title ?? 'Unassigned'}
      >
        &ndash;
      </span>
    );
  }

  const label = name ?? userId;
  const hue = hueFor(userId);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `hsl(${hue} 62% 88%)`,
        color: `hsl(${hue} 62% 26%)`,
      }}
      title={title ?? label}
      aria-label={title ?? label}
    >
      {initialsFor(label)}
    </span>
  );
}
