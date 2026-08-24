/** Thin fetch layer. Same origin, so no base URL and no credentials juggling. */

export interface Images {
  poster?: string;
  cover?: string;
  fanart?: string;
  banner?: string;
  logo?: string;
}

export interface Me {
  id: number | null;
  user: string;
  name: string;
  admin: boolean;
  viaToken: boolean;
  /** Whether a Subsonic streaming password is set. Never the value. */
  streamPasswordSet?: boolean;
  /** Which page '/' opens for this account. */
  homePage: 'discover' | 'mylibrary' | 'playlists';
  albumsToday: number;
  /** 0 = unlimited. */
  dailyAlbumCap: number;
  /** 0 = unlimited. */
  maxAlbumsPerRequest: number;
  /** Ids of plugins the admin has switched off; their UI slots render nothing. */
  disabledPlugins?: string[];
}

export interface ArtistCard {
  name: string;
  score: number;
  because: string[];
}

export interface LibraryArtist {
  mbid: string;
  name: string;
  images: Images;
  trackFiles: number;
}

export interface HomeRow {
  title: string;
  reason: string;
  artists: ArtistCard[];
}

export interface Home {
  cold: boolean;
  lastfm: boolean;
  seedCount: number;
  library: LibraryArtist[];
  rows: HomeRow[];
}

export interface SearchArtist {
  kind: 'artist';
  mbid: string;
  name: string;
  disambiguation: string;
  genres: string[];
  images: Images;
  held: boolean;
  trackFiles: number;
}

export interface SearchAlbum {
  kind: 'album';
  mbid: string;
  title: string;
  trackFiles: number;
  artistName: string;
  artistMbid: string;
  albumType: string;
  releaseDate: string;
  genres: string[];
  images: Images;
  rating: number | null;
  held: boolean;
  artistHeld: boolean;
  requested: boolean;
}

export interface SearchResult {
  artists: SearchArtist[];
  albums: SearchAlbum[];
}

/**
 * The instant half of search: what crate already holds, answered from SQLite alone. Local
 * artists carry no mbid — the artist page needs one, so a click resolves it on the way.
 */
export interface LocalSearch {
  tracks: TrackHit[];
  artists: { name: string; images: Images }[];
  albums: { artistName: string; title: string; mbid: string | null; images: Images }[];
}

export interface ArtistDetail {
  /** Albums crate holds that MusicBrainz's release-group list does not mention. */
  onDiskOnly?: { albumTitle: string; mine: number; onDisk: number }[];
  /** Tracks where this artist performs but owns no album — a featured credit. */
  appearsOn?: MyTrack[];
  /** Every track of theirs on disk — what the Songs tab plays. */
  songs?: MyTrack[];
  artist: {
    mbid: string;
    name: string;
    held: boolean;
    images: Images;
    overview?: string;
    genres?: string[];
    disambiguation?: string;
    trackCount?: number;
    albumsHeld?: number;
  };
  albumCount: number;
  /** How many of those albums actually have files on disk. */
  heldCount: number;
  albums: SearchAlbum[];
  wouldExceedPerRequest: boolean;
}

export interface CrateUser {
  id: number;
  username: string;
  name: string;
  admin: boolean;
  enabled: boolean;
  lastLoginAt: number | null;
}

export interface AlbumTrack {
  position: number;
  title: string;
  lengthMs: number | null;
  /** null when the album is not in the library, so "missing" is not implied. */
  hasFile: boolean | null;
}

export interface RequestRow {
  id: number;
  kind: string;
  mbid: string;
  title: string;
  asked_for: string;
  requested_by: string;
  requested_at: number;
  album_count: number;
  status: string;
  error: string | null;
  /** Download percentage from SABnzbd, 0 when nothing is in flight. */
  progress?: number;
  /** What the pipeline is doing right now, e.g. "3:20 left" or "retrying: ...". */
  note?: string | null;
}

/** Thrown for a 401 so callers can show the sign-in screen rather than an error. */
export class NeedsLogin extends Error {
  constructor() {
    super('sign in to continue');
    this.name = 'NeedsLogin';
  }
}

/** Rejections carry the server's message, because the caps explain themselves. */
async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && (body as { needsLogin?: boolean }).needsLogin) {
      throw new NeedsLogin();
    }
    const msg = (body as { error?: string }).error ?? `request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

/*
 * Exported for plugin folders (web/src/plugins/*), which own their fetch wrappers the way this
 * file owns the core ones. They all route through json<T>() above, so a plugin call gets the
 * same NeedsLogin handling as everything else.
 */
export const get = <T,>(path: string) => fetch(path).then((r) => json<T>(r));

export const post = <T,>(path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));

export const del = <T,>(path: string) => fetch(path, { method: 'DELETE' }).then((r) => json<T>(r));

export const put = <T,>(path: string, body: unknown) =>
  fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));

/** How ready the library's artist and album pages are — see src/lib/warm.ts. */
export interface WarmCounts {
  total: number;
  warm: number;
  pending: number;
  failed: number;
}
export interface WarmProgress {
  artists: WarmCounts;
  albums: WarmCounts;
  /** What the worker is on right now, empty when idle. */
  current: string;
  enabled: boolean;
  /**
   * The MusicBrainz mirror: a configured-but-down mirror is why pages are slow. Optional
   * because a client can outlive the server build that started serving it.
   */
  mirror?: { configured: boolean; live: boolean; downForS: number; fails: number };
}

export interface AdminStats {
  disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
  musicRoot: string;
  tracks: number;
  albums: number;
  artists: number;
  users: { total: number; admins: number; enabled: number };
  playlists: number | null;
  artCache: { entries: number; bytes: number; pinned: number; onDiskBytes: number };
  artRetentionDays: number;
  requests: { total: number; queued: number; fulfilled: number; failed: number };
  topArtists: { name: string; trackFiles: number; albums: number }[];
}

/** Secrets come back as a set-flag and a hint, never as the value. */
export interface AdminSettings {
  /** Fetch artist and album page metadata in the background. On by default. */
  warmPages: boolean;
  /** Song characteristics: AI analysis of how a track sounds and feels. Off by default. */
  songCharacteristics: boolean;
  sabUrl: string;
  sabKey: string;
  sabKeySet: boolean;
  sabKeyHint: string;
  sabCategory: string;
  prowlarrUrl: string;
  prowlarrKey: string;
  prowlarrKeySet: boolean;
  prowlarrKeyHint: string;
  formats: string[];
  requireLossless: boolean;
  losslessMinMbPerTrack: number;
  losslessMaxMbPerTrack: number;
  lossyMinMbPerTrack: number;
  lossyMaxMbPerTrack: number;
  /** Whole-release ceiling in MB; 0 means unlimited. */
  maxTotalMb: number;
  /** Days of disuse before cached art and metadata are reclaimed. 0 = keep forever. */
  artRetentionDays: number;
  disqualify: string[];
  maxAttempts: number;
  stallMinutes: number;
  qbitUrl: string;
  qbitUser: string;
  qbitPassword: string;
  qbitCategory: string;
  qbitSavePath: string;
  preferProtocol: string;
  /** 0 = accept any swarm. */
  minSeeders: number;
  /** 0 = unlimited. */
  dailyAlbumCap: number;
  /** 0 = unlimited. */
  maxAlbumsPerRequest: number;
  lastfmKey: string;
  mbMirrorUrl: string;
  acoustidKey: string;
  openaiKey: string;
  lastfmKeySet: boolean;
  lastfmKeyHint: string;
  acoustidKeySet: boolean;
  acoustidKeyHint: string;
  openaiKeySet: boolean;
  openaiKeyHint: string;
  minSeeds: number;
}

export interface Webhook {
  id: number;
  name: string;
  kind: 'pushover' | 'rest';
  enabled: boolean;
  events: string[];
  lastAt: number | null;
  /** null when it has never been tried. */
  lastOk: boolean | null;
  lastError: string | null;
  failures: number;
  /** Secrets arrive as <field>Set / <field>Hint, never as values. */
  config: Record<string, unknown>;
}

export interface EventInfo {
  name: string;
  label: string;
}

export interface TrackHit {
  /** 0 when the track is not on disk yet. */
  trackId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  trackNo: number | null;
  durationS: number | null;
  /** Starred by this user. Only meaningful on rows from their own library. */
  favorite?: boolean;
  /** 0 unrated, 1..5 stars. Only on rows from their own library. */
  rating?: number;
  /** Somebody already downloaded it, so adding is instant. */
  onDisk: boolean;
  /** Already in this user's library. */
  mine: boolean;
  /** The album to download when it is not on disk. */
  albumMbid: string | null;
}

export interface MyTrack extends TrackHit {
  addedAt: number | null;
}

/** One release an indexer offers, with crate's verdict on it. */
export interface Release {
  title: string;
  sizeMb: number;
  protocol: string;
  seeders: number;
  grabs: number;
  files: number;
  ageDays: number;
  indexer: string;
  infoUrl: string;
  downloadUrl: string;
  /** Null when crate filtered this one out. */
  score: number | null;
  reasons: string[];
}

/** One import run: a batch of songs and its outcome so far. */
export interface ImportRun {
  batchId: string;
  userId: number;
  username: string;
  startedAt: number;
  updatedAt: number;
  total: number;
  done: number;
  failed: number;
  open: number;
}

/** One song of a library import, with where it is in its journey. */
export interface ImportItem {
  id: number;
  title: string;
  artist: string;
  album: string;
  playlist: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  detail: string;
}

/** One row of a tag chart: a song, and which of the three states it is in. */
/**
 * A chart row from /api/toptracks. Tracks the caller already owns are filtered out server-side,
 * so there is no `mine` — every row here is something they do not have, either sitting in the
 * shared pool (one click to add) or needing a download.
 */
export interface ChartTrack {
  title: string;
  artistName: string;
  /** Known only when the pool holds it. */
  albumTitle: string;
  trackId: number | null;
  durationS: number | null;
  onDisk: boolean;
}

export interface Exclusion {
  kind: 'artist' | 'album' | 'track';
  key: string;
  label: string;
  at: number;
}

export type RecSource = 'pool-similar' | 'deep-cut' | 'similar' | 'track-similar';

export interface RecTrack {
  /** 0 when it would have to be downloaded. */
  trackId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  durationS: number | null;
  onDisk: boolean;
  score: number;
  source: RecSource;
  because: string;
}

export interface RecSet {
  tracks: RecTrack[];
  artists: { name: string; score: number; because: string }[];
  albums: { artistName: string; albumTitle: string; onDisk: boolean; because: string }[];
  cold: boolean;
}

export interface AdoptableEntry {
  name: string;
  path: string;
  audioFiles: number;
  /** Archive files found, so the UI knows whether Unpack has anything to do. */
  archiveFiles: number;
  bytes: number;
  ageMinutes: number;
  /** Changed in the last ten minutes, so it may still be mid-write. Not adoptable yet. */
  settling: boolean;
  note: string;
}

export interface UploadedFile {
  name: string;
  size: number;
  kind: 'audio' | 'image';
  /** Fingerprint identification, present when the server has an AcoustID key. */
  match?: {
    recordingMbid: string;
    title: string;
    artist: string;
    releaseGroupMbid: string | null;
    album: string;
    score: number;
  } | null;
  tags: {
    artist: string;
    album: string;
    title: string;
    trackNo: number | null;
    durationS: number | null;
  } | null;
}

export interface HomePage {
  cold: boolean;
  lastfm: boolean;
  counts?: { tracks: number; artists: number; albums: number };
  mostPlayed: (MyTrack & { plays: number })[];
  newest: MyTrack[];
  rec: RecSet | null;
}

export interface AlbumPage {
  artist: string;
  album: string;
  /** MusicBrainz's first-release year, falling back to the tags. Null when neither knows. */
  year: number | null;
  /** The tag year, only when it disagrees with MusicBrainz — i.e. this copy is a reissue. */
  tagYear: number | null;
  tracks: (MyTrack & { plays: number })[];
  otherAlbums: { albumTitle: string; mine: number; onDisk: number }[];
  similar: { name: string; because: string }[];
}

export type LibrarySort = 'alpha' | 'plays' | 'added' | 'fav' | 'algo' | 'shuffle';

export type WarmthKind = 'genre' | 'artist' | 'album' | 'track';
export interface WarmthEntry {
  kind: WarmthKind;
  normKey: string;
  label: string;
  warmth: number;
}
export interface AlgoProfile {
  id: number;
  name: string;
  active: boolean;
  entries: number;
}

export interface LibraryArtist {
  name: string;
  tracks: number;
  albums: number;
  plays: number;
  added: number;
}

export interface LibraryAlbumRow {
  artistName: string;
  albumTitle: string;
  tracks: number;
  plays: number;
  added: number;
}

export interface Paged {
  total: number;
  page: number;
  per: number;
}

/**
 * Song characteristics: one dense, comparable description of how a track sounds and feels.
 *
 * Scores stay NUMERIC out here — never bucketed into tags — because the point of this data is
 * that a listener's direction ("more energy, less dark, keep the atmosphere") is arithmetic
 * over these numbers.
 */
export interface TrackCharacteristic {
  /** Stable key, e.g. "atmosphere". Match on this, never on the display name. */
  key: string;
  name: string;
  group: string;
  /** 0..1. Zero is a real score, not missing data. */
  score: number;
  source: 'ai' | 'manual' | 'imported';
}

export type AnalysisState = 'not-analysed' | 'pending' | 'analysing' | 'analysed' | 'failed';

export interface TrackAnalysisStatus {
  trackId: number;
  characteristics: TrackCharacteristic[];
  state: AnalysisState;
  version: string;
  model: string;
  detail: string;
  attempts: number;
  analysedAt: number | null;
  current: boolean;
}

export interface CharacteristicDef {
  key: string;
  name: string;
  group: string;
  description: string;
  similarityWeight: number;
  enabled: boolean;
}

export interface AnalysisProgress {
  enabled: boolean;
  /** Enabled but with no OpenAI key: nothing will run, and the UI should say why. */
  ready: boolean;
  version: string;
  characteristics: number;
  counts: { notAnalysed: number; pending: number; analysing: number; analysed: number; failed: number };
  stale: number;
  tracks: number;
}

export interface SimilarityContribution {
  characteristic: string;
  name: string;
  a: number;
  b: number;
  delta: number;
  weight: number;
}

export interface SimilarityResult {
  /** Null when the two tracks do not share enough scored dimensions to compare honestly. */
  similarity: number | null;
  overlap: number;
  reason?: string;
  closest: SimilarityContribution[];
  differences: SimilarityContribution[];
}

export interface SimilarTrack {
  trackId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  similarity: number;
  overlap: number;
}

export interface TrackInfo {
  trackId: number;
  title: string;
  artistName: string;
  albumArtist: string | null;
  albumTitle: string;
  year: number | null;
  genres: string[];
  /** From the local analyzer; null until the background pass reaches this file. */
  bpm?: number | null;
  energy?: number | null;
  /** Crate's own data, not the file's — present even when the file cannot be parsed. */
  characteristics?: TrackCharacteristic[];
  characteristicState?: AnalysisState;
  trackNo: number | null;
  trackOf: number | null;
  discNo: number | null;
  composer: string[];
  codec: string | null;
  container: string | null;
  lossless: boolean | null;
  bitrateKbps: number | null;
  sampleRate: number | null;
  bitsPerSample: number | null;
  channels: number | null;
  durationS: number | null;
  sizeBytes: number;
  path: string;
  hasLyrics: boolean;
  musicbrainzAlbumId: string | null;
  inLibrary: boolean;
  plays: number;
  /** True when the file could not be parsed; only the stored fields are populated. */
  unreadable: boolean;
}

/** One term of a dynamic playlist's recipe. Mirrors src/lib/dynamicpl.ts. */
export interface RuleTerm {
  kind: 'genre' | 'style' | 'era' | 'energy' | 'artist' | 'char';
  /** char keys carry the band: "darkness|high", "danceability|low". */
  key: string;
  weight: number;
  label?: string;
}

export interface PlaylistRules {
  v: 1;
  terms: RuleTerm[];
  limit: number;
}

/** The Dynamic-builder's vocabulary: what the library actually contains. */
/** "Your listening" — the timeline, the tops, and the vibe they add up to. */
export interface ListeningSummary {
  window: number;
  totals: { plays: number; tracks: number; artists: number; minutes: number };
  recent: { trackId: number; title: string; artistName: string; albumTitle: string; at: number }[];
  topArtists: { name: string; plays: number }[];
  topAlbums: { artistName: string; albumTitle: string; plays: number }[];
  topTracks: { trackId: number; title: string; artistName: string; plays: number }[];
  clock: number[];
  vibe: {
    families: { id: string; label: string; share: number }[];
    energy: { band: string; share: number }[];
    suggest: { id: string; label: string }[];
  };
}

/** One song-characteristic dimension, as the recipe builder offers it. */
export interface CharOption {
  key: string;
  name: string;
  group: string;
  groupLabel: string;
  /** Weighted highest for similarity — shown before the long tail. */
  prominent: boolean;
}

export interface GenreVocab {
  genres: { name: string; count: number; family: string | null }[];
  families: { id: string; label: string }[];
  eras: number[];
  energyReady: boolean;
  characteristics: CharOption[];
  /** How many tracks have a characteristic profile, and out of how many. */
  charAnalysed: number;
  charTotal: number;
  charsReady: boolean;
}

export interface Playlist {
  id: number;
  name: string;
  description: string;
  tracks: number;
  /** Doubles as the art cache-buster — see playlistArtUrl. */
  updatedAt: number;
  /** 1 when the owner uploaded a cover, so Remove has something to undo. */
  customArt: number;
  /** Recipe JSON when dynamic; parse with JSON.parse into PlaylistRules. */
  rules?: string | null;
  dynamic?: boolean;
}

/**
 * The playlist's cover. Versioned on updatedAt, which the server bumps for every change that
 * can alter the mosaic, so this can be cached immutably and still never go stale.
 */
export function playlistArtUrl(pl: { id: number; updatedAt: number }): string {
  return `/api/playlists/${pl.id}/art?v=${pl.updatedAt}`;
}

export interface Orphan {
  /** trackId, matching the server's PoolTrack — see the note on that interface. */
  trackId: number;
  path: string;
  title: string;
  artistName: string;
  albumTitle: string;
  sizeBytes: number;
  firstSeen: number;
}

export interface LibraryAlbum {
  normKey: string;
  mbid: string | null;
  artistName: string;
  albumTitle: string;
  path: string;
  files: { name: string; sizeBytes: number }[];
  /** True when the folder holds other albums too, so deletion is per file. */
  sharedFolder: boolean;
}

export interface SearchProbe {
  found: number;
  viable: number;
  rejected: number;
  results: {
    title: string;
    sizeMb: number;
    score: number;
    reasons: string[];
    indexer: string;
  }[];
}

/** One row of the admin plugin switchboard. */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string | null;
  description: string;
  /** builtin = compiled into this image; installed = downloaded; removed = uninstalled, awaiting restart. */
  source: 'builtin' | 'installed' | 'removed';
  enabled: boolean;
  /** Whether this process is actually running its server half. */
  loaded: boolean;
  needsRestart: boolean;
}

export interface PluginSwitchboard {
  installed: InstalledPlugin[];
  repo: { repo: string; token: { set: boolean; hint: string } };
  needsRestart: boolean;
}

export interface AvailablePlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  installed: boolean;
  installedVersion: string | null;
  builtin: boolean;
}

export const api = {
  setup: () => get<{ hasUsers: boolean }>('/api/setup'),

  // ---- admin -------------------------------------------------------------
  adminStats: () => get<AdminStats>('/api/admin/stats'),
  warmProgress: () => get<WarmProgress>('/api/admin/warm'),
  warmSweep: (all: boolean) =>
    post<{ ok: true; queued: number } & WarmProgress>('/api/admin/warm', { all }),
  adminSettings: () =>
    get<{ settings: AdminSettings; ready: { prowlarr: boolean; sab: boolean } }>(
      '/api/admin/settings',
    ),
  saveSettings: (patch: Partial<Record<string, unknown>>) =>
    put<{ ok: true; settings: AdminSettings }>('/api/admin/settings', patch),
  clearSetting: (key: string) =>
    post<{ ok: true; settings: AdminSettings }>('/api/admin/settings/clear', { key }),
  testConnection: (what: 'sab' | 'prowlarr' | 'lastfm' | 'qbit' | 'mbmirror' | 'acoustid' | 'openai') =>
    post<{ ok: boolean; detail: string }>(`/api/admin/test/${what}`, {}),
  testSearch: (artist: string, album: string, trackCount?: number) =>
    post<SearchProbe>('/api/admin/test/search', { artist, album, trackCount }),

  setStreamPassword: (password: string) =>
    post<{ ok: true; set: boolean }>('/api/streampassword', { password }),

  // ---- playback ----------------------------------------------------------
  notePlay: (trackId: number, skipped = false) =>
    post<{ ok: true }>('/api/plays', { trackId, skipped }),
  queue: (params: Record<string, string>) =>
    get<{ tracks: MyTrack[]; name?: string }>(
      `/api/queue?${new URLSearchParams(params).toString()}`,
    ),

  album: (artist: string, album: string) =>
    get<AlbumPage>(
      `/api/album?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`,
    ),
  /** `seed` picks which deal of the shuffle to serve; it is ignored by every other sort. */
  mySongs: (o: { q?: string; sort?: LibrarySort; page?: number; per?: number; seed?: number } = {}) =>
    get<{ tracks: (MyTrack & { plays: number })[] } & Paged>(
      `/api/library/songs?${new URLSearchParams(
        Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  myArtists: (o: { sort?: LibrarySort; page?: number; per?: number } = {}) =>
    get<{ artists: LibraryArtist[] } & Paged>(
      `/api/library/artists?${new URLSearchParams(
        Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  myAlbums: (o: { sort?: LibrarySort; page?: number; per?: number } = {}) =>
    get<{ albums: LibraryAlbumRow[] } & Paged>(
      `/api/library/albums?${new URLSearchParams(
        Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  trackInfo: (trackId: number) => get<TrackInfo>(`/api/track/${trackId}/info`),
  // ---- song characteristics --------------------------------------------------
  characteristicVocab: () =>
    get<{ characteristics: CharacteristicDef[]; progress: AnalysisProgress }>('/api/characteristics'),
  characteristicProgress: (batch?: string) =>
    get<{
      progress: AnalysisProgress;
      batch: { batchId: string; total: number; done: number; failed: number; open: number } | null;
    }>(`/api/characteristics/progress${batch ? `?batch=${encodeURIComponent(batch)}` : ''}`),
  trackCharacteristics: (trackId: number) =>
    get<TrackAnalysisStatus>(`/api/track/${trackId}/characteristics`),
  analyseTrack: (trackId: number) =>
    post<{ ok: true; status: TrackAnalysisStatus }>(`/api/track/${trackId}/characteristics/analyse`, {}),
  analyseCharacteristics: (body: { trackIds?: number[]; scope?: 'library'; force?: boolean }) =>
    post<{ ok: true; batchId: string; queued: number; skipped: number }>('/api/characteristics/analyse', body),
  setTrackCharacteristic: (trackId: number, key: string, score: number) =>
    put<{ ok: true; status: TrackAnalysisStatus }>(`/api/track/${trackId}/characteristics`, { key, score }),
  removeTrackCharacteristic: (trackId: number, key: string) =>
    del<{ ok: true; status: TrackAnalysisStatus }>(`/api/track/${trackId}/characteristics/${key}`),
  similarTracks: (trackId: number, limit = 8) =>
    get<{ trackId: number; results: SimilarTrack[]; reason?: string }>(
      `/api/track/${trackId}/similar?limit=${limit}&sameArtist=false`,
    ),
  compareTracks: (a: number, b: number) => get<SimilarityResult>(`/api/track/${a}/similarity/${b}`),
  playlists: () => get<{ playlists: Playlist[] }>('/api/playlists'),
  createPlaylist: (name: string, rules?: PlaylistRules) =>
    post<{ ok: true; id: number; playlists: Playlist[] }>('/api/playlists', { name, rules }),
  genres: () => get<GenreVocab>('/api/genres'),
  gaps: () =>
    get<{ albums: { artistName: string; albumTitle: string; mine: number; onDisk: number }[] }>(
      '/api/library/gaps',
    ),
  fillGap: (artist: string, album: string) =>
    post<{ ok: true; added: number; albums: number }>('/api/library/gaps/fill', { artist, album }),
  fillAllGaps: () =>
    post<{ ok: true; added: number; albums: number }>('/api/library/gaps/fill', { all: true }),
  listening: (days: number) => get<ListeningSummary>(`/api/listening?days=${days}`),
  topArtists: (tag: string) =>
    get<{ tag: string; artists: { name: string; listeners: number; images: Images; held: boolean }[] }>(
      `/api/topartists?tag=${encodeURIComponent(tag)}`,
    ),
  // Slow by nature — the model reads the whole library — so callers show their own patience.
  // A given name or description wins over the model's own suggestion.
  aiPlaylist: (prompt: string, name?: string, description?: string) =>
    post<{ ok: true; id: number; name: string; added: number }>('/api/playlists/ai', {
      prompt,
      name,
      description,
    }),
  playlist: (id: number) =>
    get<{ playlist: Playlist; tracks: MyTrack[] }>(`/api/playlists/${id}`),
  addToPlaylist: (id: number, trackIds: number[]) =>
    post<{ ok: true; added: number; tracks: MyTrack[] }>(`/api/playlists/${id}/tracks`, {
      trackIds,
    }),
  removeFromPlaylist: (id: number, trackId: number) =>
    del<{ ok: true; tracks: MyTrack[] }>(`/api/playlists/${id}/tracks/${trackId}`),
  renamePlaylist: (id: number, name: string) =>
    put<{ ok: true; playlist: Playlist; playlists: Playlist[] }>(`/api/playlists/${id}`, { name }),
  describePlaylist: (id: number, description: string) =>
    put<{ ok: true; playlist: Playlist; playlists: Playlist[] }>(`/api/playlists/${id}`, {
      description,
    }),
  /** Swap a dynamic playlist's recipe. The next deal uses the new one. */
  setPlaylistRules: (id: number, rules: PlaylistRules) =>
    put<{ ok: true; playlist: Playlist; playlists: Playlist[] }>(`/api/playlists/${id}`, { rules }),
  /** Replace the cover with an uploaded image. */
  setPlaylistArt: (id: number, file: File) => {
    const form = new FormData();
    form.append('art', file, file.name);
    return fetch(`/api/playlists/${id}/art`, { method: 'POST', body: form }).then((r) =>
      json<{ ok: true; playlist: Playlist }>(r),
    );
  },
  /** Drop the upload, which rerolls the generated mosaic. */
  clearPlaylistArt: (id: number) =>
    del<{ ok: true; playlist: Playlist }>(`/api/playlists/${id}/art`),
  deletePlaylist: (id: number) =>
    del<{ ok: true; playlists: Playlist[] }>(`/api/playlists/${id}`),

  // ---- tracks and per-user libraries -------------------------------------
  searchTracks: (q: string) =>
    get<{ tracks: TrackHit[] }>(`/api/tracks/search?q=${encodeURIComponent(q)}`),
  myTracks: () =>
    get<{ tracks: MyTrack[]; counts: { tracks: number; artists: number; albums: number } }>(
      '/api/mytracks',
    ),
  addTrack: (trackId: number) =>
    post<{ ok: true; added: { trackId: number; title: string } }>('/api/mytracks', { trackId }),
  removeTrack: (trackId: number) =>
    del<{ ok: true; note: string }>(`/api/mytracks/${trackId}`),
  requestTrack: (albumMbid: string, title: string, askedFor: string, playlistId?: number) =>
    post<{ ok: true; requestId: number; wanted: string }>('/api/request', {
      kind: 'track',
      mbid: albumMbid,
      title,
      askedFor,
      // When set, the track joins this playlist once the download lands — the alternative is
      // telling somebody to come back later and add it by hand.
      playlistId,
    }),
  /** As requestTrack, for a song known only by names — a chart entry, a suggestion.
   *  The server resolves the containing album through MusicBrainz. */
  requestTrackByName: (artist: string, title: string, playlistId?: number) =>
    post<{ ok: true; requestId: number; wanted: string }>('/api/request', {
      kind: 'track',
      artist,
      title,
      askedFor: `${artist} — ${title}`,
      playlistId,
    }),
  /** A name to an mbid — cheaper than search(), which also hunts release groups. */
  resolveArtist: (name: string) =>
    get<{ artist: { mbid: string; name: string } | null }>(
      `/api/artist/resolve?name=${encodeURIComponent(name)}`,
    ),
  /**
   * Stage an album's files, with upload progress.
   *
   * XHR rather than fetch, because fetch still cannot report UPLOAD progress
   * and a 300 MB FLAC album with no progress bar looks hung, not busy.
   */
  uploadFiles: (files: File[], onProgress: (pct: number) => void) =>
    new Promise<{ batchId: string; files: UploadedFile[]; rejected: { name: string; why: string }[] }>(
      (resolvePromise, reject) => {
        const form = new FormData();
        for (const f of files) form.append('files', f, f.name);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          try {
            const body = JSON.parse(xhr.responseText) as {
              error?: string;
              batchId: string;
              files: UploadedFile[];
              rejected: { name: string; why: string }[];
            };
            if (xhr.status >= 400) reject(new Error(body.error ?? `HTTP ${xhr.status}`));
            else resolvePromise(body);
          } catch {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('upload failed'));
        xhr.send(form);
      },
    ),
  finalizeUpload: (body: {
    batchId: string;
    artistName: string;
    albumTitle: string;
    mbid?: string;
    cover?: string;
    files: { name: string; title: string; trackNo: number }[];
  }) =>
    post<{
      ok: true;
      /** Null when nothing moved because every song was already on disk. */
      albumDir: string | null;
      tracks: number;
      /** Songs that were already on disk and were added to the library rather than uploaded. */
      adopted?: number;
      skipped?: { name: string; why: string }[];
    }>('/api/upload/finalize', body),
  discardUpload: (batchId: string) =>
    fetch(`/api/upload/${encodeURIComponent(batchId)}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  /** The whole My Algorithm page in one call. */
  algo: () =>
    get<{
      profiles: AlgoProfile[];
      entries: WarmthEntry[];
      genres: { genre: string; artists: number }[];
      coverage: { artists: number; withGenres: number };
    }>('/api/algo'),
  createAlgoProfile: (name: string) => post<{ ok: true; id: number }>('/api/algo/profiles', { name }),
  activateAlgoProfile: (id: number) => post<{ ok: true }>(`/api/algo/profiles/${id}/activate`, {}),
  deleteAlgoProfile: (id: number) =>
    fetch(`/api/algo/profiles/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  setWarmth: (kind: WarmthKind, label: string, warmth: number) =>
    post<{ ok: true }>('/api/algo/warmth', { kind, label, warmth }),
  removeWarmth: (kind: WarmthKind, key: string) =>
    fetch(`/api/algo/warmth?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }).then((r) => json<{ ok: true }>(r)),
  fillGenres: () =>
    post<{ ok: true; filled: number; genreless: number; remaining: number }>('/api/algo/genres/fill', {}),
  /** Rate a library song 1–5, or 0 to clear. */
  setRating: (trackId: number, rating: number) =>
    post<{ ok: true; rating: number }>(`/api/tracks/${trackId}/rating`, { rating }),
  /** The caller's rating of one song; 404s when it is not in their library. */
  getRating: (trackId: number) => get<{ rating: number }>(`/api/tracks/${trackId}/rating`),
  /** Server-side file-to-track matching: rules, with AI arbitration when configured. */
  matchTracks: (
    files: { name: string; tagTitle?: string | null; tagTrackNo?: number | null; durationS?: number | null }[],
    tracks: { position: number; title: string; lengthMs?: number | null }[],
  ) =>
    post<{ assignments: { name: string; position: number | null; confidence: number }[]; via: string }>(
      '/api/upload/match',
      { files, tracks },
    ),
  /** Thirty seconds of a song from Apple, or null when they do not carry it. */
  preview: (artist: string, title: string) =>
    get<{
      preview: { url: string; trackName: string; artistName: string; albumName: string } | null;
    }>(
      `/api/preview?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`,
    ),
  /** The album a song lives on, resolved by names — what a preview opens with. */
  resolveTrack: (artist: string, title: string) =>
    get<{ albumMbid: string; albumTitle: string }>(
      `/api/track/resolve?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`,
    ),
  topTracks: (tag: string) =>
    get<{ tag: string; tracks: ChartTrack[] }>(`/api/toptracks?tag=${encodeURIComponent(tag)}`),

  excludes: () => get<{ excludes: Exclusion[]; removedArtists: string[] }>('/api/excludes'),
  /** Undo both "don't recommend" and the suppression a library removal creates. */
  lyrics: (trackId: number) =>
    get<{ synced: boolean; text: string | null }>(`/api/track/${trackId}/lyrics`),

  importRows: (rows: { title: string; artist: string; album: string; playlist: string; isrc: string }[]) =>
    post<{ batchId: string; items: number; playlists: number }>('/api/import', { rows }),
  importRetry: (group?: 'downloads') =>
    post<{ ok: true; retried: number }>('/api/import/retry', group ? { group } : {}),
  importHistory: () => get<{ runs: ImportRun[] }>('/api/import/history'),
  adminImports: () => get<{ runs: ImportRun[] }>('/api/admin/imports'),
  importStatus: (batch?: string) =>
    get<{
      batchId: string | null;
      counts: Record<string, number>;
      total: number;
      albums: { album: string; artist: string; progress: number; state: string; songs: number }[];
      failed: ImportItem[];
      recentDone: ImportItem[];
      waitingPreview: ImportItem[];
    }>(`/api/import/status${batch ? `?batch=${encodeURIComponent(batch)}` : ''}`),
  setPrefs: (homePage: 'discover' | 'mylibrary' | 'playlists') =>
    post<{ ok: true; homePage: string }>('/api/me/prefs', { homePage }),
  recommendAgain: (artist: string) =>
    post<{ ok: true; cleared: number }>('/api/recommendable', { artist }),
  addExclude: (e: { kind: 'artist' | 'album' | 'track'; artist: string; album?: string; title?: string }) =>
    post<{ ok: true; excludes: Exclusion[] }>('/api/excludes', e),
  removeExclude: (kind: string, key: string) =>
    del<{ ok: true; excludes: Exclusion[] }>(
      `/api/excludes?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`,
    ),

  orphans: () =>
    get<{ orphans: Orphan[]; totals: { tracks: number; bytes: number } }>('/api/admin/orphans'),
  purge: (body: { trackIds?: number[]; all?: boolean }) =>
    post<{ ok: true; removed: number; skipped: { path: string; why: string }[] }>(
      '/api/admin/purge',
      body,
    ),

  // ---- library -----------------------------------------------------------
  libraryAlbums: () =>
    get<{
      albums: LibraryAlbum[];
      trashRoot: string;
      totals: { albums: number; tracks: number; bytes: number };
    }>('/api/admin/library'),
  deleteAlbum: (normKey: string) =>
    del<{ ok: true; moved: number; trash: string }>(
      `/api/admin/library/album?key=${encodeURIComponent(normKey)}`,
    ),
  deleteTrack: (path: string) =>
    del<{ ok: true; trash: string }>(
      `/api/admin/library/track?path=${encodeURIComponent(path)}`,
    ),
  rescanLibrary: () =>
    post<{ ok: true; albums: number; tracks: number }>('/api/admin/library/rescan', {}),

  // ---- webhooks ----------------------------------------------------------
  webhooks: () => get<{ webhooks: Webhook[]; events: EventInfo[] }>('/api/admin/webhooks'),
  addWebhook: (w: {
    name: string;
    kind: 'pushover' | 'rest';
    enabled: boolean;
    config: Record<string, unknown>;
    events: string[];
  }) => post<{ ok: true; id: number; webhooks: Webhook[] }>('/api/admin/webhooks', w),
  updateWebhook: (
    id: number,
    w: {
      name?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      events?: string[];
    },
  ) => put<{ ok: true; webhooks: Webhook[] }>(`/api/admin/webhooks/${id}`, w),
  deleteWebhook: (id: number) =>
    del<{ ok: true; webhooks: Webhook[] }>(`/api/admin/webhooks/${id}`),
  testWebhook: (id: number) =>
    post<{ ok: boolean; detail: string; webhooks: Webhook[] }>(
      `/api/admin/webhooks/${id}/test`,
      {},
    ),
  login: (username: string, password: string) =>
    post<{ ok: true; user: { username: string; name: string; admin: boolean } }>('/api/login', {
      username,
      password,
    }),
  logout: () => post<{ ok: true }>('/api/logout', {}),
  users: () => get<{ users: CrateUser[] }>('/api/users'),
  addUser: (b: { username: string; password: string; displayName?: string; isAdmin?: boolean }) =>
    post<{ ok: true; id: number }>('/api/users', b),
  setPassword: (id: number, password: string) =>
    post<{ ok: true; signedOut: boolean }>(`/api/users/${id}/password`, { password }),
  setEnabled: (id: number, enabled: boolean) =>
    post<{ ok: true }>(`/api/users/${id}/enabled`, { enabled }),
  me: () => get<Me>('/api/me'),
  /** The plugin switchboard. Admin-only. */
  adminPlugins: () => get<PluginSwitchboard>('/api/admin/plugins'),
  setPluginEnabled: (id: string, enabled: boolean) =>
    put<PluginSwitchboard>(`/api/admin/plugins/${encodeURIComponent(id)}`, { enabled }),
  adminPluginsAvailable: () =>
    get<{ available: AvailablePlugin[] }>('/api/admin/plugins/available'),
  setPluginSource: (repo: string, token?: string) =>
    put<{ ok: true; repo: string; token: { set: boolean; hint: string } }>(
      '/api/admin/plugins/source',
      token === undefined ? { repo } : { repo, token },
    ),
  installPlugin: (id: string) =>
    post<{ ok: true; id: string; version: string; needsRestart: boolean }>(
      '/api/admin/plugins/install',
      { id },
    ),
  uninstallPlugin: (id: string) =>
    del<{ ok: true; needsRestart: boolean }>(`/api/admin/plugins/installed/${encodeURIComponent(id)}`),
  restartCrate: () => post<{ ok: true }>('/api/admin/restart', {}),
  home: () => get<HomePage>('/api/home'),
  search: (q: string) => get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`),
  searchLocal: (q: string) => get<LocalSearch>(`/api/search/local?q=${encodeURIComponent(q)}`),
  artist: (mbid: string) => get<ArtistDetail>(`/api/artist/${encodeURIComponent(mbid)}`),
  tracks: (mbid: string) =>
    get<{ source: string; tracks: AlbumTrack[] }>(
      `/api/album/${encodeURIComponent(mbid)}/tracks`,
    ),
  retryRequest: (id: number) => post<{ ok: true }>(`/api/requests/${id}/retry`, {}),
  /** `q` searches the operator's own words instead of the album crate resolved. */
  releases: (id: number, q?: string) =>
    get<{ artist: string; album: string; query: string; releases: Release[] }>(
      `/api/requests/${id}/releases${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ),
  grabRelease: (id: number, r: { downloadUrl: string; title: string; protocol: string }) =>
    post<{ ok: true; via: string }>(`/api/requests/${id}/grab`, r),
  /** Everything one user has, for the admin's inspect panel. */
  adminUserData: (id: number) =>
    get<{
      user: { id: number; username: string; name: string; admin: boolean; enabled: boolean };
      counts: { tracks: number; artists: number; albums: number };
      exclusive: { tracks: number; bytes: number };
      playlists: { id: number; name: string; tracks: number; updatedAt: number }[];
      albums: { artistName: string; albumTitle: string; tracks: number; plays: number }[];
      mostPlayed: { title: string; artistName: string; plays: number }[];
      requests: number;
      imports: { batches: number; items: number };
    }>(`/api/admin/users/${id}/data`),
  /** Rewrite an album's names and track metadata in the index. */
  editAlbum: (body: {
    key: string;
    artistName?: string;
    albumTitle?: string;
    tracks: { trackId: number; title: string; trackNo: number }[];
  }) => post<{ ok: true; touched: number; artistName: string; albumTitle: string }>('/api/admin/album/edit', body),
  /** Replace an album's cover image. */
  setCover: (key: string, file: File) => {
    const form = new FormData();
    form.append('cover', file, file.name);
    return fetch(`/api/admin/album/cover?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      body: form,
    }).then((r) => json<{ ok: true }>(r));
  },
  /** Finished downloads crate never queued, waiting in the completed-music folder. */
  adoptable: () =>
    get<{ adoptRoot: string; entries: AdoptableEntry[]; unpacker: boolean }>(
      '/api/admin/adoptable',
    ),
  /** Extract the archives inside these downloads, in place. Nothing is deleted. */
  unpackAdoptables: (paths: string[]) =>
    post<{
      ok: true;
      results: { path: string; archives: number; audioGained: number; errors: string[] }[];
    }>('/api/admin/adoptable/unpack', { paths }),
  /** The same song twice inside one album — two rips merged into one folder. */
  duplicates: () =>
    get<{
      sets: {
        albumArtist: string;
        album: string;
        title: string;
        keep: number;
        files: { trackId: number; path: string; sizeBytes: number; holders: string[] }[];
      }[];
      totals: { sets: number; redundant: number; bytes: number };
    }>('/api/admin/duplicates'),
  purgeDuplicates: () =>
    post<{ ok: true; removed: number; freed: number; failed: { path: string; why: string }[] }>(
      '/api/admin/duplicates/purge',
      {},
    ),
  /** Trash a hand-picked set of downloads. */
  deleteAdoptables: (paths: string[]) =>
    post<{ ok: true; removed: string[]; failed: { path: string; why: string }[] }>(
      '/api/admin/adoptable/delete',
      { paths },
    ),
  /** Trash every no-audio, no-archive entry at once. */
  purgeDuds: () => post<{ ok: true; removed: string[] }>('/api/admin/adoptable/purge-duds', {}),
  /** Trash a download nobody wants — never unlinked, recoverable from the trash. */
  deleteAdoptable: (path: string) =>
    fetch(`/api/admin/adoptable?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true; trash: string }>(r),
    ),
  /** Pull one into a staging batch; returns the same shape /api/upload does. */
  adopt: (path: string) =>
    post<{ batchId: string; files: UploadedFile[]; rejected: { name: string; why: string }[] }>(
      '/api/admin/adopt',
      { path },
    ),
  /** The typed username is the server-side confirmation, not decoration. */
  purgeUser: (id: number, username: string) =>
    post<{
      ok: true;
      rows: Record<string, number>;
      files: number;
      freedBytes: number;
      skipped: { path: string; why: string }[];
    }>(`/api/admin/users/${id}/purge`, { username }),
  requests: (opts: { source?: 'user' | 'import'; trouble?: boolean; all?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.source) q.set('source', opts.source);
    if (opts.trouble) q.set('trouble', '1');
    // Admin-only on the server; anyone else sends it and still gets their own.
    if (opts.all) q.set('all', '1');
    const s = q.toString();
    return get<{ requests: RequestRow[] }>(`/api/requests${s ? `?${s}` : ''}`);
  },
  /** Delete this user's failed requests. Queued rows with an error are left alone. */
  clearFailedRequests: (all = false) => {
    return del<{ ok: true; removed: number }>(`/api/requests/failed${all ? '?all=1' : ''}`);
  },
  request: (body: { kind: 'artist' | 'album'; mbid: string; askedFor?: string }) =>
    post<{ ok: true; requestId: number | null; queuedAlbums: number; added?: number; instant?: boolean }>(
      '/api/request',
      body,
    ),
  dismiss: (name: string) => post<{ ok: true }>('/api/dismiss', { name }),
};
