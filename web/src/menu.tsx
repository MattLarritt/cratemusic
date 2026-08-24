/**
 * The one context menu, shared by songs, albums and artists.
 *
 * A single component rather than three, because the point is that they behave identically:
 * the same trigger, the same position, the same dismissal, the same keyboard handling. Three
 * separate implementations drift within a week, and "why does the album menu close differently"
 * is the kind of inconsistency people notice without being able to name.
 *
 * Two triggers: a `…` button — faded in on mouse-over on a pointer device, simply always
 * visible on touch — and a right click on desktop. There used to be a long press as well;
 * it went, because the visible button already covers touch and a hidden second affordance
 * that fights scrolling bought nothing.
 *
 * Dismissal is on outside click, Escape, and scroll. Scroll matters because the menu is
 * absolutely positioned against the viewport: without it, scrolling leaves the menu behind,
 * detached from the thing it belongs to.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Shown greyed with a reason instead of being hidden, so the option is discoverable. */
  disabled?: boolean;
  hint?: string;
  /** Destructive items are separated and tinted. */
  danger?: boolean;
}

/**
 * Wraps content, adding the menu affordances.
 *
 * The trigger button is rendered inside, positioned by CSS from the wrapper, so a caller only
 * has to supply the items and whatever the row looks like.
 */
export function WithMenu({
  items,
  children,
  className,
  label = 'More',
}: {
  items: MenuItem[];
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setAt(null), []);

  useEffect(() => {
    if (!at) return;
    const onDown = (e: MouseEvent) => {
      // A click inside the menu is handled by the item itself.
      if ((e.target as HTMLElement)?.closest('.menupop')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    // Capture, because the scroll may happen on an inner container rather than the window.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [at, close]);

  const openAt = (x: number, y: number) => {
    // Flip when close to an edge so the menu never opens off-screen — most often the case for
    // the last row on a page or a tile at the right edge of a shelf.
    const w = 208;
    const h = Math.min(items.length * 40 + 12, 260);
    setAt({
      x: Math.min(x, window.innerWidth - w - 10),
      y: y + h > window.innerHeight - 100 ? Math.max(10, y - h) : y,
    });
  };

  return (
    <div
      ref={wrap}
      className={`withmenu${className ? ' ' + className : ''}`}
      onContextMenu={(e) => {
        // A right click opens the same menu as the … button, and suppressing the
        // browser menu here is what people expect from an app-like surface.
        e.preventDefault();
        openAt(e.clientX, e.clientY);
      }}
    >
      {children}
      <button
        className="menubtn"
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openAt(r.right - 200, r.bottom + 6);
        }}
      >
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="19" cy="12" r="1.9" />
        </svg>
      </button>

      {at && (
        <div className="menupop" style={{ left: at.x, top: at.y }} role="menu">
          {items.map((it, i) => (
            <button
              key={`${it.label}-${i}`}
              className={`menuitem${it.danger ? ' danger' : ''}`}
              role="menuitem"
              disabled={it.disabled}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                close();
                if (!it.disabled) it.onSelect();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <em>{it.hint}</em>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A modal panel, used by every info screen.
 *
 * Closes on backdrop click and Escape. Deliberately not a `<dialog>`: its default backdrop and
 * focus behaviour vary enough across browsers that matching the rest of the app's look means
 * overriding most of it anyway.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Stops the page behind scrolling while a modal is up, which on iOS is otherwise very
    // easy to do by accident.
    const prior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prior;
    };
  }, [onClose]);

  return (
    <div className="modalback" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modalhead">
          <h3>{title}</h3>
          <button className="btn sec sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modalbody">{children}</div>
      </div>
    </div>
  );
}

/** A label/value row inside an info panel. Skips itself when there is nothing to show. */
export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === '' ) return null;
  return (
    <div className="inforow">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}
