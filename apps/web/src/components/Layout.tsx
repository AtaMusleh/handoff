import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'handoff.theme';

/**
 * Theme toggle.
 *
 * Writes `data-theme` on <html> for explicit choices and removes it for
 * "system", which lets the `prefers-color-scheme` rules in globals.css apply.
 * The initial value is applied by the inline script in `_document`, before
 * first paint — reading it here would flash the wrong palette.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      setTheme((window.localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system');
    } catch {
      /* storage blocked; stay on system */
    }
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* non-fatal */
    }
  };

  const order: Theme[] = ['system', 'light', 'dark'];
  const icon = { system: '◐', light: '☀', dark: '☾' }[theme];

  return (
    <button
      type="button"
      className="btn px-2"
      onClick={() => apply(order[(order.indexOf(theme) + 1) % order.length]!)}
      title={`Theme: ${theme}. Click to change.`}
      aria-label={`Theme: ${theme}. Click to change.`}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}

export function ConnectionPill({
  isConnected,
  state,
}: {
  isConnected: boolean;
  state: string;
}) {
  const tone = isConnected
    ? { bg: 'var(--status-completed-bg)', fg: 'var(--status-completed-fg)' }
    : state === 'connecting'
      ? { bg: 'var(--status-progress-bg)', fg: 'var(--status-progress-fg)' }
      : { bg: 'var(--status-blocked-bg)', fg: 'var(--status-blocked-fg)' };

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: tone.bg, color: tone.fg }}
      title={`Realtime connection: ${state}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: 'currentColor' }}
      />
      {isConnected ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline'}
    </span>
  );
}

export function Layout({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-40 border-b backdrop-blur"
        style={{ background: 'color-mix(in srgb, var(--surface) 88%, transparent)' }}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Link href="/" className="text-base font-semibold tracking-tight">
            Handoff
          </Link>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
