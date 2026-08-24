/**
 * Transport icons, drawn rather than typed.
 *
 * These were emoji, which is wrong for a control surface in three separate ways: ⤨ is not an
 * emoji at all but a Unicode arrow that renders as a missing glyph on plenty of systems;
 * 🔁 and 🔂 arrive as full-colour emoji on Apple platforms and fight a monochrome UI that cannot
 * restyle them; and every one of them sits on a different baseline, so a row of them never
 * quite lines up.
 *
 * Everything here uses currentColor and is sized in `em`, so the existing CSS keeps control:
 * `.pbicon` sets a font-size, the icon follows, and the accent colour applied to an active
 * button reaches the glyph.
 *
 * Two styles on purpose, which is the convention Apple Music uses and worth keeping: the
 * transport — play, pause, previous, next — is solid, because those are the primary actions and
 * weight reads as importance; the modes — shuffle, repeat — are line drawings, because they are
 * toggles and a solid tangle of arrows at 16px is a smudge.
 */

export interface IconProps {
  /** Overrides the em-based default when an icon is used outside a sized button. */
  size?: string | number;
  className?: string;
}

/*
 * Exported for plugin folders: a plugin's icon must sit in the same row as these at the same
 * weight, and a duplicated wrapper would drift.
 */
export function Svg({
  children,
  size,
  className,
  stroke,
}: IconProps & { children: React.ReactNode; stroke?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size ?? '1em'}
      height={size ?? '1em'}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...(stroke
        ? {
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round' as const,
            strokeLinejoin: 'round' as const,
          }
        : { fill: 'currentColor' })}
    >
      {children}
    </svg>
  );
}

export function IconPlay(p: IconProps) {
  // Slightly inset from the box so it reads as centred; a triangle's visual centre sits left
  // of its bounding box centre.
  return (
    <Svg {...p}>
      <path d="M8.5 5.2a1 1 0 0 1 1.53-.85l9 6a1 1 0 0 1 0 1.7l-9 6A1 1 0 0 1 8.5 18.8z" />
    </Svg>
  );
}

export function IconPause(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
    </Svg>
  );
}

export function IconPrev(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5" y="5.5" width="2.6" height="13" rx="1.1" />
      <path d="M19.5 6.4v11.2a1 1 0 0 1-1.54.84l-8.4-5.6a1 1 0 0 1 0-1.68l8.4-5.6a1 1 0 0 1 1.54.84z" />
    </Svg>
  );
}

export function IconNext(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 6.4v11.2a1 1 0 0 0 1.54.84l8.4-5.6a1 1 0 0 0 0-1.68l-8.4-5.6a1 1 0 0 0-1.54.84z" />
      <rect x="16.4" y="5.5" width="2.6" height="13" rx="1.1" />
    </Svg>
  );
}

export function IconShuffle(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M16.5 4.5 20 7l-3.5 2.5" />
      <path d="M20 7h-3.1a4.2 4.2 0 0 0-3.45 1.82L9.05 15.18A4.2 4.2 0 0 1 5.6 17H4" />
      <path d="M16.5 14.5 20 17l-3.5 2.5" />
      <path d="M20 17h-3.1a4.2 4.2 0 0 1-3.45-1.82l-.62-.9" />
      <path d="M4 7h1.6a4.2 4.2 0 0 1 3.45 1.82l.62.9" />
    </Svg>
  );
}

export function IconRepeat(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M16.5 3 19.5 6l-3 3" />
      <path d="M19.5 6H8.5A4.5 4.5 0 0 0 4 10.5v1" />
      <path d="M7.5 21 4.5 18l3-3" />
      <path d="M4.5 18h11A4.5 4.5 0 0 0 20 13.5v-1" />
    </Svg>
  );
}

export function IconRepeatOne(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M16.5 3 19.5 6l-3 3" />
      <path d="M19.5 6H8.5A4.5 4.5 0 0 0 4 10.5v1" />
      <path d="M7.5 21 4.5 18l3-3" />
      <path d="M4.5 18h11A4.5 4.5 0 0 0 20 13.5v-1" />
      {/* The 1 is filled and unstroked: a stroked numeral at this size turns into a blob. */}
      <path d="M11.1 10.2h1.05a.35.35 0 0 1 .35.35v3.6h-1.05v-2.9h-.9z" fill="currentColor" stroke="none" />
      <path d="M11.05 14.15h2.1v1.05h-2.1z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * A–B repeat.
 *
 * A loop with two marks on it. The letters themselves are not drawn — at 16px they would be
 * unreadable — so the button keeps its text label and this sits beside it.
 */
export function IconAb(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M6 8h9a4 4 0 0 1 0 8H6a4 4 0 0 1 0-8z" />
      <path d="M9.5 5.5v5" fill="none" />
      <path d="M15 13.5v5" fill="none" />
    </Svg>
  );
}

/**
 * Lyrics: a quote bubble with two lines of text.
 *
 * A bubble rather than a microphone, because a microphone reads as
 * "record" or "voice input" on a media surface. Line style, matching the
 * other mode toggles — it opens a panel, it is not a transport action.
 */
export function IconLyrics(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4.2 3.4a.6.6 0 0 1-.98-.47V16H6.5A2.5 2.5 0 0 1 4 13.5z" />
      <path d="M8 8.6h8" />
      <path d="M8 11.6h5.5" />
    </Svg>
  );
}


/** Speaker with waves; the waves scale with the level in the caller. */
export function IconVolume(p: IconProps & { level?: 'high' | 'low' }) {
  return (
    <Svg {...p} stroke>
      <path d="M4 9.5v5h3l4.5 3.7V5.8L7 9.5z" />
      <path d="M15 9.5a4 4 0 0 1 0 5" />
      {p.level !== 'low' && <path d="M17.5 7.5a7.2 7.2 0 0 1 0 9" />}
    </Svg>
  );
}

/** Speaker, muted: same body, a slash where the waves were. */
export function IconVolumeMute(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M4 9.5v5h3l4.5 3.7V5.8L7 9.5z" />
      <path d="M15.5 9.5 20 14.5" />
      <path d="M20 9.5 15.5 14.5" />
    </Svg>
  );
}

export function IconInfo(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3h2v2h-2zm0 4h2v6h-2z" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
    </Svg>
  );
}

/* ---- the DJ's buttons. Stroke icons, same optical weight as the transport row. ---- */

export function IconThumbUp(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M7 11v9" />
      <path d="M7 20H4.8a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7" />
      <path d="M7 11.5 11.2 4a1.9 1.9 0 0 1 3.4 1.3L14 9h4.6a2 2 0 0 1 2 2.4l-1.3 6.5a2.6 2.6 0 0 1-2.5 2.1H7" />
    </Svg>
  );
}

export function IconThumbDown(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M17 13V4" />
      <path d="M17 4h2.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H17" />
      <path d="M17 12.5 12.8 20a1.9 1.9 0 0 1-3.4-1.3L10 15H5.4a2 2 0 0 1-2-2.4l1.3-6.5A2.6 2.6 0 0 1 7.2 4H17" />
    </Svg>
  );
}

/** End the DJ session: a stop square inside the session's circle. */
export function IconDjEnd(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <circle cx="12" cy="12" r="8.5" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Reset the DJ session: start over from here. */
export function IconDjReset(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M4.5 8.5A8.5 8.5 0 1 1 3.5 12" />
      <path d="M4.5 3.5v5h5" />
    </Svg>
  );
}

/** The DJ's insight: what the mood looks like from the booth. */
export function IconInsight(p: IconProps) {
  return (
    <Svg {...p} stroke>
      <path d="M12 5c-4.6 0-7.9 3.6-9 7 1.1 3.4 4.4 7 9 7s7.9-3.6 9-7c-1.1-3.4-4.4-7-9-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}
