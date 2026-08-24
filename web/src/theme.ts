/**
 * Light, dark, or whatever the system says.
 *
 * The stylesheet's default IS dark and its `prefers-color-scheme: light` block
 * IS auto, so "auto" here means removing the attribute rather than setting one
 * — the CSS already does the right thing when nothing overrides it. Only an
 * explicit choice writes `data-theme`, and the rules keyed on that attribute
 * come after the media query so they win.
 */

export type Theme = 'auto' | 'dark' | 'light';

const KEY = 'crate.theme';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'auto';
  } catch {
    // Private browsing and some embedded webviews throw on access rather than
    // returning null, and a theme preference is not worth a blank page.
    return 'auto';
  }
}

/** Put the choice on <html>, where the CSS and the browser can both see it. */
export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);

  /*
   * color-scheme has to move too, or the parts the page does not paint stay
   * wrong: scrollbars, form controls, the flash of canvas before first paint.
   * Listing both values for auto is what lets the browser follow the system.
   */
  root.style.colorScheme = t === 'auto' ? 'dark light' : t;
}

export function setTheme(t: Theme): void {
  try {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* Choice still applies for this session; it just will not be remembered. */
  }
  applyTheme(t);
}
