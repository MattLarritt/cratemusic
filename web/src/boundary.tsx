/**
 * Error boundary, plus a global handler for everything a boundary cannot catch.
 *
 * Without this a single render throw blanks the page: no message, no way back except a reload,
 * and the only trace in a console nobody has open. That is exactly what happened once, and the
 * reason it could not be diagnosed afterwards.
 *
 * Boundaries catch render and lifecycle errors only, so the window handlers cover the rest —
 * an async rejection in a click handler is at least as likely as a bad render.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

function report(message: string, stack?: string, componentStack?: string): void {
  // Fire and forget, and never throw from the reporter: a failure here must not become a
  // second error on top of the first.
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, stack, componentStack, url: window.location.href }),
    }).catch(() => {});
  } catch {
    /* nothing sensible to do */
  }
}

/** Installed once, for the errors a boundary never sees. */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => {
    report(e.message, e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    report(
      r instanceof Error ? r.message : `unhandled rejection: ${String(r)}`,
      r instanceof Error ? r.stack : undefined,
    );
  });
  installStallWatch();
}

/**
 * Report main-thread stalls, and memory when the browser will say.
 *
 * A hang is the one failure that cannot report itself: nothing throws, so the
 * error handlers above never fire, and if the tab is eventually killed there is
 * no trace at all. That happened — a session was described as "hang, then
 * crash" and the server log held not one client error, which is what finally
 * pointed at a render storm rather than an exception.
 *
 * So: a one-second heartbeat that measures its own lateness. Lateness IS the
 * stall — the timer could not run because something else held the thread. One
 * report per stall, rate limited, with the heap size when the browser exposes
 * it, so the next incident arrives with evidence instead of a description.
 */
const STALL_MS = 3000;
const STALL_QUIET_MS = 60_000;

function installStallWatch(): void {
  let last = Date.now();
  let lastReport = 0;

  window.setInterval(() => {
    const now = Date.now();
    const late = now - last - 1000;
    last = now;

    // A backgrounded tab is throttled by design and is not a stall.
    if (document.hidden) return;
    if (late < STALL_MS) return;
    if (now - lastReport < STALL_QUIET_MS) return;
    lastReport = now;

    // Non-standard and Chromium-only, hence the guarded read: when it is
    // there, a heap near its limit turns "it hung" into "it ran out of room".
    const mem = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      }
    ).memory;
    const heap = mem
      ? ` heap ${Math.round(mem.usedJSHeapSize / 1048576)}MB of ${Math.round(
          mem.jsHeapSizeLimit / 1048576,
        )}MB`
      : '';

    report(`main thread stalled ${(late / 1000).toFixed(1)}s${heap}`);
  }, 1000);
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    report(error.message, error.stack, info.componentStack ?? undefined);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crashed">
        <h2>Something broke</h2>
        <p className="muted">
          This is a bug in crate, not something you did. It has been logged with the details
          needed to fix it.
        </p>
        <pre>{error.message}</pre>
        <div className="bar">
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            className="btn sec"
            onClick={() => {
              // Home is the one route certain to render, so it is the safe escape from a
              // page whose own data is what broke.
              window.history.pushState({}, '', '/');
              window.location.reload();
            }}
          >
            Go home
          </button>
        </div>
      </div>
    );
  }
}
