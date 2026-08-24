import type Database from 'better-sqlite3';
import { familiesOf, isJunk, FAMILY_LABEL, type Family } from './genrefam.js';
import { energyBand } from './dynamicpl.js';

/**
 * "Your listening": what somebody actually played, and what that says about the vibe
 * they have been in.
 *
 * Built on play_log (the timeline) rather than plays (the aggregate), because every
 * question here is about WHEN. The vibe half deliberately reads plays rather than DJ
 * votes: votes only exist while somebody is using the DJ and decay within hours, while
 * what you chose to play over a week is the honest record of the mood you were in —
 * and it works for people who never open the DJ at all.
 */

export interface ListeningSummary {
  window: number;
  totals: { plays: number; tracks: number; artists: number; minutes: number };
  recent: { trackId: number; title: string; artistName: string; albumTitle: string; at: number }[];
  topArtists: { name: string; plays: number }[];
  topAlbums: { artistName: string; albumTitle: string; plays: number }[];
  topTracks: { trackId: number; title: string; artistName: string; plays: number }[];
  /** Plays per hour of the day, 0–23, in the server's timezone. */
  clock: number[];
  vibe: {
    families: { id: string; label: string; share: number }[];
    energy: { band: string; share: number }[];
    /** The families to lean on if they pressed "more of this" right now. */
    suggest: { id: string; label: string }[];
  };
}

interface LoggedPlay {
  track_id: number;
  at: number;
  title: string;
  artist_name: string;
  album_title: string;
  norm_artist: string;
  genres: string;
  energy: number | null;
  duration_s: number | null;
}

export function listeningSummary(
  db: Database.Database,
  userId: number,
  windowDays: number,
): ListeningSummary {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const hasEnergy = (db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).some(
    (c) => c.name === 'energy',
  );

  const plays = db
    .prepare(
      `SELECT l.track_id, l.at, t.title, t.artist_name, t.album_title, t.norm_artist,
              ${hasEnergy ? 'CASE WHEN t.energy >= 0 THEN t.energy ELSE NULL END' : 'NULL'} AS energy,
              t.genres, t.duration_s
         FROM play_log l JOIN tracks t ON t.id = l.track_id
        WHERE l.user_id = ? AND l.at >= ?
        ORDER BY l.at DESC`,
    )
    .all(userId, since) as LoggedPlay[];

  // Artist genres, merged with each track's own — the same rule the DJ and dynamic
  // playlists use, so "your vibe" and "what the DJ plays" describe one world.
  const artistGenres = new Map<string, string[]>();
  for (const r of db.prepare('SELECT norm_artist, genre FROM artist_genres').all() as {
    norm_artist: string;
    genre: string;
  }[]) {
    const list = artistGenres.get(r.norm_artist) ?? [];
    list.push(r.genre);
    artistGenres.set(r.norm_artist, list);
  }

  const artistCount = new Map<string, number>();
  const albumCount = new Map<string, { artistName: string; albumTitle: string; plays: number }>();
  const trackCount = new Map<number, { trackId: number; title: string; artistName: string; plays: number }>();
  const familyCount = new Map<Family, number>();
  const energyCount = new Map<string, number>();
  const clock = new Array<number>(24).fill(0);
  let seconds = 0;

  for (const p of plays) {
    artistCount.set(p.artist_name, (artistCount.get(p.artist_name) ?? 0) + 1);
    const aKey = `${p.artist_name}|${p.album_title}`;
    const album = albumCount.get(aKey) ?? { artistName: p.artist_name, albumTitle: p.album_title, plays: 0 };
    album.plays++;
    albumCount.set(aKey, album);
    const track = trackCount.get(p.track_id) ?? {
      trackId: p.track_id,
      title: p.title,
      artistName: p.artist_name,
      plays: 0,
    };
    track.plays++;
    trackCount.set(p.track_id, track);

    clock[new Date(p.at * 1000).getHours()]!++;
    seconds += p.duration_s ?? 0;

    const merged: string[] = [];
    for (const g of [...(p.genres ? p.genres.split(', ') : []), ...(artistGenres.get(p.norm_artist) ?? [])]) {
      const n = g.trim().toLowerCase();
      if (n && !isJunk(n) && !merged.includes(n)) merged.push(n);
    }
    // A play counted once per family, so a track in three families does not outvote
    // three separate tracks.
    for (const f of familiesOf(merged)) {
      familyCount.set(f, (familyCount.get(f) ?? 0) + 1);
    }
    const band = energyBand(p.energy);
    if (band) energyCount.set(band, (energyCount.get(band) ?? 0) + 1);
  }

  const top = <T>(m: Map<unknown, T>, by: (v: T) => number, n: number): T[] =>
    [...m.values()].sort((a, b) => by(b) - by(a)).slice(0, n);

  const familyTotal = [...familyCount.values()].reduce((a, b) => a + b, 0) || 1;
  const families = [...familyCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, n]) => ({ id, label: FAMILY_LABEL[id], share: Math.round((100 * n) / familyTotal) }));

  const energyTotal = [...energyCount.values()].reduce((a, b) => a + b, 0) || 1;
  const energy = [...energyCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([band, n]) => ({ band, share: Math.round((100 * n) / energyTotal) }));

  return {
    window: windowDays,
    totals: {
      plays: plays.length,
      tracks: trackCount.size,
      artists: artistCount.size,
      minutes: Math.round(seconds / 60),
    },
    recent: plays.slice(0, 30).map((p) => ({
      trackId: p.track_id,
      title: p.title,
      artistName: p.artist_name,
      albumTitle: p.album_title,
      at: p.at,
    })),
    topArtists: [...artistCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, n]) => ({ name, plays: n })),
    topAlbums: top(albumCount, (v) => v.plays, 10),
    topTracks: top(trackCount, (v) => v.plays, 10),
    clock,
    vibe: {
      families,
      energy,
      // The two strongest families are what "more of this" should mean.
      suggest: families.slice(0, 2).map((f) => ({ id: f.id, label: f.label })),
    },
  };
}
