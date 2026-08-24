import { useEffect, useRef, useState } from 'react';

/**
 * What art looks like when there is none.
 *
 * Baked in as SVG rather than fetched, because a placeholder that needs the
 * network has the same failure mode as the thing it is standing in for. These
 * are drawn in currentColor at low opacity so they take the surrounding theme
 * and stay quiet — a page of them should read as artwork not loaded, not as a
 * page of icons.
 */

export function AlbumPlaceholder() {
  return (
    <svg className="phart" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="23" fill="none" stroke="currentColor" strokeWidth="2.4" />
      {/* The pressed-groove ring, which is what makes it read as a disc rather
          than a doughnut at thumbnail size. */}
      <circle cx="32" cy="32" r="15.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <circle cx="32" cy="32" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="32" cy="32" r="1.7" fill="currentColor" />
      {/* A single highlight sweep: enough to suggest a shiny surface without
          becoming detail that disappears at 42px anyway. */}
      <path
        d="M20 20a17 17 0 0 1 9-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}

export function ArtistPlaceholder() {
  return (
    <svg className="phart" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {/* A bust, not a face: at circle-crop thumbnail sizes eyes and mouth turn
          to mush, while a head-and-shoulders silhouette stays legible. */}
      <circle cx="32" cy="24" r="10" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path
        d="M14 51c0-9.6 8-15 18-15s18 5.4 18 15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Bounded, widening retries for art that was not ready yet. */
const RETRIES = [1500, 5000, 15000];

/**
 * An image that degrades to a placeholder, and quietly tries again.
 *
 * The server answers 404 the moment it knows a cover cannot be resolved inside
 * its budget and keeps fetching in the background, so a miss is usually "not
 * yet" rather than "never" — hence the retries. They are bounded because a
 * genuine miss must not become a polling loop, and a page of them must not
 * become a flood.
 *
 * Every art surface in the app goes through this. Several used to be bare
 * <img> tags, which meant a 404 rendered the browser's own broken-image icon
 * and stayed that way until a reload.
 */
export function Artwork({
  src,
  kind,
  className,
  alt = '',
}: {
  src?: string | null;
  kind: 'album' | 'artist';
  className?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const tries = useRef(0);

  // A new src is a new subject: forget that the previous one failed, or a
  // recycled row would show a placeholder over perfectly good artwork.
  useEffect(() => {
    setFailed(false);
    tries.current = 0;
  }, [src]);

  useEffect(() => {
    if (!failed || !src) return;
    const n = tries.current;
    const delay = RETRIES[n];
    if (delay === undefined) return;
    tries.current = n + 1;
    // Jittered, so thirty tiles that failed together do not retry together.
    const t = window.setTimeout(() => {
      setFailed(false);
      // Bust the browser's negative cache: without a changed URL the retry is
      // served straight back from the failed response and never reaches crate.
      setNonce((v) => v + 1);
    }, delay + Math.random() * 1200);
    return () => window.clearTimeout(t);
  }, [failed, src]);

  if (!src || failed) {
    return (
      <span className={`ph ${className ?? ''}`.trim()} role="img" aria-label={alt || undefined}>
        {kind === 'album' ? <AlbumPlaceholder /> : <ArtistPlaceholder />}
      </span>
    );
  }

  return (
    <img
      src={nonce ? `${src}${src.includes('?') ? '&' : '?'}r=${nonce}` : src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
