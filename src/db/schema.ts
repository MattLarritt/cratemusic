import Database from 'better-sqlite3';

/**
 * Connection, pragmas, DDL and housekeeping. Nothing else in the codebase
 * touches the database handle directly — every query lives in lib/store.ts.
 */
export function open(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The DJ's weights DDL, once — migrate() needs the same text twice (fresh create and the
 * rebuild that loosens the old plugin-era CHECK, which predates 'era'/'style'/'energy' and
 * cannot be altered in place). See the DJ block inside migrate().
 */
const ISHUFFLE_WEIGHTS_DDL = `
  CREATE TABLE IF NOT EXISTS ishuffle_weights (
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('artist','album','track','genre','style','era','energy')),
    key        TEXT    NOT NULL,
    -- What to call this weight on screen ("Deftones", "nu metal", "1990s") — stored at write
    -- time because the readable name is only cheaply known then.
    label      TEXT    NOT NULL DEFAULT '',
    weight     REAL    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, key)
  );
`;

/**
 * Idempotent DDL, no migration table and no version number.
 *
 * The same approach gatekeeper uses: CREATE TABLE IF NOT EXISTS covers fresh
 * databases, and a PRAGMA table_info probe covers columns added later. A
 * migration framework would be more machinery than a single-file schema earns.
 */
function migrate(db: Database.Database): void {
  // The library index is derived from the disk, so when its shape changes the
  // honest migration is to drop it and let the next scan rebuild it — no data of
  // record lives here. This one changed key: from folder path to normalised
  // artist|album from the tags, because folder names identified a flat library
  // wrongly. An album's exact mbid is re-established by the next import.
  const libCols = db.prepare('PRAGMA table_info(library)').all() as {
    name: string;
    pk: number;
  }[];
  const libHasNormArtist = libCols.some((c) => c.name === 'norm_artist');
  if (
    libCols.length &&
    (!libCols.some((c) => c.name === 'norm_key' && c.pk === 1) || !libHasNormArtist)
  ) {
    db.exec('DROP TABLE library');
  }

  db.exec(`
    -- Every request ever made, including ones that failed. The history is the
    -- audit trail for the per-user cap, so rows are never deleted on failure.
    CREATE TABLE IF NOT EXISTS requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT    NOT NULL CHECK (kind IN ('artist','album','track')),
      mbid          TEXT    NOT NULL,
      title         TEXT    NOT NULL,
      artist_name   TEXT    NOT NULL DEFAULT '',
      -- What the user actually typed or clicked, kept because a track request
      -- is recorded against the album that satisfied it and the original
      -- intent is otherwise lost.
      asked_for     TEXT    NOT NULL DEFAULT '',
      requested_by  TEXT    NOT NULL,
      requested_at  INTEGER NOT NULL,
      -- albums this request queued, so the daily cap counts albums not clicks
      album_count   INTEGER NOT NULL DEFAULT 1,
      status        TEXT    NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued','fulfilled','failed')),
      lidarr_id     INTEGER,
      error         TEXT
    );

    CREATE INDEX IF NOT EXISTS requests_by_user ON requests (requested_by, requested_at);
    CREATE INDEX IF NOT EXISTS requests_by_mbid ON requests (mbid);
    CREATE INDEX IF NOT EXISTS requests_status  ON requests (status);

    -- Response cache for Lidarr search and every Last.fm read. Both are slow
    -- relative to a page load and neither changes minute to minute; Last.fm
    -- also asks that clients not hammer it.
    CREATE TABLE IF NOT EXISTS cache (
      k          TEXT    PRIMARY KEY,
      v          TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL,
      -- Swept on LAST USE, not on age. A tracklist for an album somebody still has is
      -- worth keeping however long ago it was fetched; one for an album browsed past once
      -- is not. Reading a row stamps this.
      last_used_at INTEGER NOT NULL DEFAULT 0
    );

    -- Cached artwork on disk, so an image is fetched from somebody else's server once
    -- rather than on every page load. See lib/artcache.ts for the resolution order and why
    -- pinning is computed rather than stored.
    CREATE TABLE IF NOT EXISTS art_cache (
      k            TEXT    PRIMARY KEY,
      path         TEXT    NOT NULL,
      content_type TEXT    NOT NULL,
      bytes        INTEGER NOT NULL DEFAULT 0,
      -- 'embedded', 'file:<name>', 'lidarr' — enough to explain a wrong cover.
      source       TEXT    NOT NULL DEFAULT '',
      fetched_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS art_cache_used ON art_cache (last_used_at);

    CREATE INDEX IF NOT EXISTS cache_age ON cache (fetched_at);

    -- Artists the user has signalled interest in, by NAME rather than MBID.
    -- This library has no MusicBrainz IDs on disk (the files carry no
    -- MusicBrainz tags), so a name is the only key that joins the library,
    -- Lidarr and Last.fm together.
    CREATE TABLE IF NOT EXISTS seeds (
      name       TEXT    PRIMARY KEY,
      -- 'library' (held on disk), 'request' (asked for here), 'listen' (played
      -- on disk). Kept so weights can be retuned without losing origin.
      source     TEXT    NOT NULL,
      weight     REAL    NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    -- crate owns its own accounts. gatekeeper is an optional extra layer in
    -- front of this app, not its identity system, so nothing here depends on a
    -- header from a reverse proxy.
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      display_name  TEXT    NOT NULL DEFAULT '',
      password_hash TEXT    NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );

    -- Opaque server-side sessions. A row can be revoked and the table can be
    -- emptied to sign everyone out, neither of which is possible if the cookie
    -- itself carries the identity.
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      seen_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
    CREATE INDEX IF NOT EXISTS sessions_user   ON sessions (user_id);

    -- Failed logins, per (ip, username), for lockout. Without this the login
    -- form is an unlimited password oracle on a LAN that includes IoT devices.
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip       TEXT    NOT NULL,
      username TEXT    NOT NULL,
      at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS attempts_lookup ON login_attempts (ip, username, at);

    -- Artists deliberately hidden from discovery rows. Without this the same
    -- rejected suggestion returns on every page load.
    CREATE TABLE IF NOT EXISTS dismissed (
      name       TEXT    PRIMARY KEY,
      by_user    TEXT    NOT NULL DEFAULT '',
      at         INTEGER NOT NULL
    );

    -- What crate owns, keyed by folder because that is the only fact that cannot
    -- disagree with the disk. mbid is set when crate imported the album itself and
    -- NULL for music that predates crate, which is matched on norm_key instead.
    --
    -- This replaces asking Lidarr "is this in the library". Lidarr attaches an
    -- artist's whole discography as metadata rows with real ids, so that question
    -- came back true for albums that were not on disk.
    -- Keyed by normalised artist|album from the TAGS, not by folder.
    --
    -- Folder names are not a reliable identity here: the pre-existing library is
    -- flat — Music/ABBA/*.flac with no album directory — so grouping by folder
    -- invented one album per artist and reported ABBA's "Ring Ring" as not held
    -- while its eleven files sat on disk, which invites re-downloading music you
    -- already own. Tags know the album; folders do not.
    CREATE TABLE IF NOT EXISTS library (
      norm_key    TEXT    PRIMARY KEY,
      mbid        TEXT,
      artist_name TEXT    NOT NULL,
      album_title TEXT    NOT NULL,
      -- normalised artist, because the tags say "System Of A Down" and MusicBrainz
      -- says "System of a Down"; matching raw strings loses every comparison
      norm_artist TEXT    NOT NULL DEFAULT '',
      path        TEXT    NOT NULL,
      track_files INTEGER NOT NULL DEFAULT 0,
      added_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS library_mbid ON library (mbid);
    CREATE INDEX IF NOT EXISTS library_artist ON library (norm_artist);

    -- Runtime settings, editable from the admin page. Environment variables remain
    -- the defaults; a row here simply wins. See lib/settings.ts for why that
    -- ordering matters — the compose file still describes a working deployment.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Lyrics, fetched while a download is in flight and embedded at import.
    --
    -- Keyed on normalised artist|title rather than a MusicBrainz id, because the lookup
    -- that matters is against the tags on the file that actually arrived, and a rip's
    -- titles are not always MusicBrainz's. An empty text is a cached MISS, so a track
    -- nothing has lyrics for is not looked up again on every import.
    CREATE TABLE IF NOT EXISTS lyrics (
      key         TEXT    PRIMARY KEY,
      artist_name TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      text        TEXT    NOT NULL DEFAULT '',
      synced      INTEGER NOT NULL DEFAULT 0,
      fetched_at  INTEGER NOT NULL
    );

    -- Outbound notifications. One row per destination, with the events it wants.
    --
    -- config is JSON because a Pushover destination and a REST endpoint need
    -- genuinely different fields, and a column per field across both would be mostly
    -- NULL. The delivery result is kept on the row so the admin page can show whether
    -- a webhook is actually working — a destination that silently stopped delivering
    -- is the same class of quiet failure as a request stuck at 'queued'.
    CREATE TABLE IF NOT EXISTS webhooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL CHECK (kind IN ('pushover','rest')),
      enabled     INTEGER NOT NULL DEFAULT 1,
      config      TEXT    NOT NULL DEFAULT '{}',
      -- comma-separated event names; empty means every event
      events      TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      last_at     INTEGER,
      last_ok     INTEGER,
      last_error  TEXT,
      failures    INTEGER NOT NULL DEFAULT 0
    );

    -- Every track on disk. THE POOL.
    --
    -- This is the pivot from a single shared library to per-user ones. What is on disk
    -- and what a person has in their library are now different questions: downloads are
    -- album-shaped because Usenet is album-shaped, but a user who asked for one song
    -- should get one song. So the album arrives, every track lands here, and only the
    -- requested one joins that user's library. The rest sit on disk costing nothing but
    -- space, and the next person who wants one gets it instantly instead of downloading
    -- it again.
    --
    -- Doubles as the tag cache it replaces: size and mtime invalidate a row, so a scan
    -- only re-reads headers for files that changed.
    CREATE TABLE IF NOT EXISTS tracks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL UNIQUE,
      size        INTEGER NOT NULL,
      mtime       INTEGER NOT NULL,
      artist_name TEXT    NOT NULL DEFAULT '',
      album_title TEXT    NOT NULL DEFAULT '',
      title       TEXT    NOT NULL DEFAULT '',
      -- normalised, because tags and metadata disagree on case and punctuation
      norm_artist TEXT    NOT NULL DEFAULT '',
      norm_album  TEXT    NOT NULL DEFAULT '',
      norm_title  TEXT    NOT NULL DEFAULT '',
      track_no    INTEGER,
      duration_s  INTEGER,
      album_mbid  TEXT,
      first_seen  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tracks_artist ON tracks (norm_artist);
    CREATE INDEX IF NOT EXISTS tracks_album  ON tracks (norm_artist, norm_album);
    CREATE INDEX IF NOT EXISTS tracks_title  ON tracks (norm_title);

    -- Which tracks each person actually has. The user-facing library.
    --
    -- Removing a row does NOT touch the file: the point of the pool is that one person
    -- losing interest does not cost everyone else a re-download. Admin can purge tracks
    -- that nobody has.
    CREATE TABLE IF NOT EXISTS user_tracks (
      user_id  INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      -- 'request' when it came from a download this user asked for, 'add' when they
      -- picked it up from the pool. Kept because it is the honest answer to "why is
      -- this here", and it distinguishes a deliberate choice from a side effect.
      source   TEXT    NOT NULL DEFAULT 'add',
      PRIMARY KEY (user_id, track_id)
    );

    CREATE INDEX IF NOT EXISTS user_tracks_by_user ON user_tracks (user_id, added_at);
    CREATE INDEX IF NOT EXISTS user_tracks_by_track ON user_tracks (track_id);

    -- Play counts, per user per track.
    --
    -- A count plus a last-played time rather than an event log. The two questions this has
    -- to answer are "what do they play most" and "what have they played lately", and both
    -- fall out of these columns; a row per play would be strictly more data for no extra
    -- answer at this scale.
    --
    -- skips is kept separately and deliberately: a track someone reaches for and abandons
    -- is evidence about their taste, and treating it as a play would make the
    -- recommendations worse the more they skipped.
    CREATE TABLE IF NOT EXISTS plays (
      user_id      INTEGER NOT NULL,
      track_id     INTEGER NOT NULL,
      plays        INTEGER NOT NULL DEFAULT 0,
      skips        INTEGER NOT NULL DEFAULT 0,
      first_played INTEGER NOT NULL,
      last_played  INTEGER NOT NULL,
      PRIMARY KEY (user_id, track_id)
    );

    CREATE INDEX IF NOT EXISTS plays_top    ON plays (user_id, plays DESC);

    -- One row per play, as it happens: the TIMELINE the aggregate above cannot be.
    --
    -- plays answers "how much" and every hot path reads it — the recommender, the
    -- library sorts, the DJ — so it stays an aggregate. This answers "when", which is
    -- what a listening history, a week in review and a time-of-day pattern need, and
    -- nothing on a hot path has to scan it.
    CREATE TABLE IF NOT EXISTS play_log (
      user_id  INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS play_log_when ON play_log (user_id, at DESC);
    CREATE INDEX IF NOT EXISTS plays_recent ON plays (user_id, last_played DESC);

    -- User playlists. Ordered by an explicit position rather than by insertion, so a
    -- reorder is a cheap update instead of a rewrite of the table.
    CREATE TABLE IF NOT EXISTS playlists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS playlists_by_user ON playlists (user_id, name);

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER NOT NULL,
      track_id    INTEGER NOT NULL,
      position    INTEGER NOT NULL,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, track_id)
    );

    CREATE INDEX IF NOT EXISTS playlist_tracks_order ON playlist_tracks (playlist_id, position);

    -- Tracks somebody deliberately took out of their library.
    --
    -- Removal has to be remembered, not just applied. The pool keeps the file, so a removed
    -- track immediately qualifies as a recommendation candidate again — delete Spice Girls and
    -- crate suggests Spice Girls, which is the opposite of listening to the user. A row here
    -- means "do not offer this back", and re-adding it clears the row because that is somebody
    -- changing their mind.
    --
    -- Deliberately NOT an exclude: excludes suppress a whole artist's influence on
    -- recommendations, while this is one track that was not wanted. Different scopes.
    CREATE TABLE IF NOT EXISTS user_removed (
      user_id  INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      at       INTEGER NOT NULL,
      PRIMARY KEY (user_id, track_id)
    );

    -- "Do not recommend": per user, per artist / album / track.
    --
    -- Exists because one song outside somebody's usual taste should not redirect every
    -- suggestion they get afterwards. Suppressing the recommendation is different from
    -- deleting the track — they keep the song and stop hearing about the genre.
    CREATE TABLE IF NOT EXISTS user_excludes (
      user_id  INTEGER NOT NULL,
      kind     TEXT    NOT NULL CHECK (kind IN ('artist','album','track')),
      -- normalised key: artist, or artist|album, or artist|title
      norm_key TEXT    NOT NULL,
      label    TEXT    NOT NULL DEFAULT '',
      at       INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, norm_key)
    );
  `);

  // Columns added after the first release. A PRAGMA probe rather than a migration
  // table, matching the approach above: adding a column twice is an error, so each
  // one is checked before it is added.
  const cols = new Set(
    (db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name),
  );
  const add = (name: string, ddl: string): void => {
    if (!cols.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${ddl}`);
  };

  // The native pipeline's state: which SABnzbd job is serving this request, how far
  // along it is, which candidate release is being tried, and the ranked list so a
  // retry does not have to search again and risk a different answer.
  /**
   * Who or what asked: 'user' or 'import'.
   *
   * A library import creates one album request per missing album, which on a
   * thousand-song export buries a person's own handful of requests entirely.
   * Existing rows are backfilled from the marker the importer wrote into
   * asked_for before this column existed.
   */
  if (!cols.has('source')) {
    db.exec("ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
    db.exec("UPDATE requests SET source = 'import' WHERE asked_for LIKE 'import:%'");
  }

  /**
   * Which client owns this download: 'usenet' or 'torrent'.
   *
   * nzo_id holds a SABnzbd job id or a torrent hash depending on this, so a
   * poll asks the right client. Older rows are all Usenet, which the default
   * says correctly.
   */
  add('download_via', "download_via TEXT NOT NULL DEFAULT 'usenet'");

  add('nzo_id', 'nzo_id TEXT');
  add('progress', 'progress INTEGER NOT NULL DEFAULT 0');
  add('note', 'note TEXT');
  add('attempt', 'attempt INTEGER NOT NULL DEFAULT 0');
  add('candidates', 'candidates TEXT');
  add('album_title', 'album_title TEXT NOT NULL DEFAULT \'\'');
  // When progress last CHANGED, not when it was last checked. A job wedged in a
  // state SABnzbd never advances out of ('Grabbing' on an unreachable NZB URL) has
  // to be distinguishable from one that is simply slow, or the request sits queued
  // forever — the silent stall this whole pipeline exists to prevent.
  add('progress_at', 'progress_at INTEGER NOT NULL DEFAULT 0');
  // For a track request: the album is what gets downloaded, this is what the person
  // asked for and the only thing that joins their library when it lands.
  add('wanted_title', "wanted_title TEXT NOT NULL DEFAULT ''");
  // Numeric user id of the requester, so a per-user library can be updated on import.
  // requested_by holds the username, which is not a stable key.
  add('requester_id', 'requester_id INTEGER');
  // "Add to playlist" on a song nobody has yet has to start a download and remember where the
  // track is meant to end up — the alternative is telling somebody to come back in ten minutes
  // and do it again by hand.
  add('wanted_playlist', 'wanted_playlist INTEGER');

  const cacheCols = new Set(
    (db.prepare('PRAGMA table_info(cache)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!cacheCols.has('last_used_at')) {
    db.exec('ALTER TABLE cache ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0');
    // Existing rows get their fetch time as a starting point rather than 0, which would
    // make every one of them look stale enough to sweep immediately.
    db.exec('UPDATE cache SET last_used_at = fetched_at WHERE last_used_at = 0');
  }

  db.exec(`
    -- One row per song of an uploaded library export (Apple Music CSV et al).
    -- The import processor drains these: pooled songs join the library
    -- instantly, the rest ride one album request per unique album, and only
    -- the songs listed here are added when the files land — the export is the
    -- authority on what the person actually had.
    CREATE TABLE IF NOT EXISTS import_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      batch_id    TEXT    NOT NULL,
      artist      TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      album       TEXT    NOT NULL DEFAULT '',
      playlist    TEXT    NOT NULL DEFAULT '',
      isrc        TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'pending',
      detail      TEXT    NOT NULL DEFAULT '',
      request_id  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS import_items_user ON import_items (user_id, batch_id, status);
  `);

  /*
   * SONG MOODS, REMOVED. The mood feature modelled a track as a handful of weighted tags, which
   * could not support the similarity maths it existed to enable: a tag was either present or
   * absent, and absent meant both "definitely not" and "never considered". Song characteristics
   * replaces it with a dense vector where zero is a real score. The feature was internal and
   * days old, so the tables go rather than being migrated — carrying forward six tags per track
   * into a fifty-five dimension model would produce vectors that are 90% holes and read as
   * genuine data.
   */
  for (const t of ['track_moods', 'track_mood_runs', 'moods']) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec("DELETE FROM settings WHERE key LIKE 'songMoods%'");

  db.exec(`
    -- SONG CHARACTERISTICS: one dense, comparable description of how every track sounds and
    -- feels. See lib/characteristics.ts for the taxonomy and lib/similarity.ts for the maths.

    -- The taxonomy. Code owns the list and syncs it in on boot; this table exists so scores can
    -- join to a name and a weight, so a RETIRED characteristic still renders in the data it was
    -- applied to, and so weights can be tuned without a schema change.
    CREATE TABLE IF NOT EXISTS characteristics (
      key               TEXT    PRIMARY KEY,
      name              TEXT    NOT NULL,
      -- "group" is reserved in SQL, hence grp.
      grp               TEXT    NOT NULL,
      description       TEXT    NOT NULL DEFAULT '',
      -- The 0/0.5/1 anchors handed to the classifier. Stored so an operator can see exactly
      -- what a stored score was supposed to mean, even after the code has moved on.
      definition        TEXT    NOT NULL DEFAULT '',
      similarity_weight REAL    NOT NULL DEFAULT 1,
      sort              INTEGER NOT NULL DEFAULT 0,
      enabled           INTEGER NOT NULL DEFAULT 1
    );

    -- One row per (track, characteristic, source), score in 0..1.
    --
    -- A MISSING ROW IS NOT A ZERO. Zero is a real score ("no danceable quality at all"); an
    -- absent row means the dimension was never scored, or does not apply — an instrumental has
    -- no vocal_intimacy row. Similarity excludes absent dimensions from both sides of the
    -- calculation rather than treating them as zero, which is the distinction the mood model
    -- could not express and the reason this table replaced it.
    --
    -- source in the primary key lets a person's judgement and the model's coexist on the same
    -- dimension: reanalysis deletes only source='ai' rows, so curated work survives it.
    CREATE TABLE IF NOT EXISTS track_characteristics (
      track_id           INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      characteristic_key TEXT    NOT NULL REFERENCES characteristics(key),
      score              REAL    NOT NULL CHECK (score >= 0 AND score <= 1),
      source             TEXT    NOT NULL DEFAULT 'ai',
      analysed_at        INTEGER NOT NULL,
      PRIMARY KEY (track_id, characteristic_key, source)
    );
    -- Reading one track's profile is the common case. The second index serves the other
    -- direction — "which tracks score highest on atmosphere" — which is how a future
    -- database-side pre-filter would narrow the candidate set before the vector maths runs.
    CREATE INDEX IF NOT EXISTS track_chars_track ON track_characteristics (track_id);
    CREATE INDEX IF NOT EXISTS track_chars_key   ON track_characteristics (characteristic_key, score DESC);

    -- Analysis bookkeeping, one row per track. No row here = never considered, which is the
    -- "not analysed" state; cheaper and clearer than backfilling a row per track on enable.
    CREATE TABLE IF NOT EXISTS track_characteristic_runs (
      track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      state       TEXT    NOT NULL DEFAULT 'pending',
      -- The CLASSIFIER's behaviour version (e.g. 'song-characteristics-v1'), which is what makes
      -- a profile stale — deliberately separate from the model that happened to produce it.
      version     TEXT    NOT NULL DEFAULT '',
      model       TEXT    NOT NULL DEFAULT '',
      -- Short, human diagnostic for a failure. Never the prompt or the response.
      detail      TEXT    NOT NULL DEFAULT '',
      attempts    INTEGER NOT NULL DEFAULT 0,
      batch_id    TEXT    NOT NULL DEFAULT '',
      queued_at   INTEGER NOT NULL DEFAULT 0,
      started_at  INTEGER NOT NULL DEFAULT 0,
      analysed_at INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0
    );
    -- The worker's only query: the oldest thing still waiting, skipping what keeps failing.
    CREATE INDEX IF NOT EXISTS track_char_runs_state ON track_characteristic_runs (state, attempts, queued_at);
    CREATE INDEX IF NOT EXISTS track_char_runs_batch ON track_characteristic_runs (batch_id);
  `);

  /*
   * PAGE WARMING — lib/warm.ts.
   *
   * An artist page costs two MusicBrainz calls and a Last.fm call, all behind MusicBrainz's
   * one-request-per-second courtesy limit, so the FIRST visit to an artist took three to nine
   * seconds against the live library while every later visit took fifteen milliseconds. This
   * table is the worklist that pays that cost in the background instead, before anybody clicks.
   *
   * One row per page, not per API call: "is this page ready" is the question the admin screen
   * asks and the only one worth persisting. Whether each underlying lookup is cached is already
   * answerable from the cache table, and duplicating it here would be two truths to keep.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_warm (
      -- 'artist' | 'album'. Both live in one table because they share a worker and a queue.
      kind       TEXT    NOT NULL,
      -- artist: the normalised artist. album: normalised artist + '|' + album identity.
      key        TEXT    NOT NULL,
      -- The display strings the warm calls need, so the worker never re-queries for them.
      name       TEXT    NOT NULL DEFAULT '',
      album      TEXT    NOT NULL DEFAULT '',
      state      TEXT    NOT NULL DEFAULT 'pending',
      -- Capped: an artist MusicBrainz genuinely does not know must stop being asked.
      attempts   INTEGER NOT NULL DEFAULT 0,
      -- Short human diagnostic, never a payload.
      detail     TEXT    NOT NULL DEFAULT '',
      -- How many plays this artist has, so the queue warms what gets opened first.
      weight     INTEGER NOT NULL DEFAULT 0,
      warmed_at  INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, key)
    );
    -- The worker's only query: the most-played thing still waiting, skipping what keeps failing.
    CREATE INDEX IF NOT EXISTS page_warm_next ON page_warm (state, attempts, weight DESC);
  `);

  /*
   * THE DJ (Intelligent Shuffle) — lib/dj.ts. These four tables arrived with the
   * intelligent-shuffle PLUGIN and moved here verbatim when the DJ went native, so a live
   * database already has them with a user's mood in them: everything below must be (and is)
   * a no-op against that. The weights DDL is a named constant because migrate needs the same
   * text twice — the fresh create and the rebuild that loosens the plugin 1.2.0-era CHECK
   * ('era' arrived in its 1.3.0, 'style' in 1.4.0), which SQLite cannot alter in place.
   */
  db.exec(ISHUFFLE_WEIGHTS_DDL);
  const ishuffleWeights = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ishuffle_weights'")
    .get() as { sql: string } | undefined;
  if (ishuffleWeights && !ishuffleWeights.sql.includes("'energy'")) {
    // An old table is rebuilt around the same rows — the evening's mood survives the upgrade.
    db.exec(`
      ALTER TABLE ishuffle_weights RENAME TO ishuffle_weights_old;
      ${ISHUFFLE_WEIGHTS_DDL}
      INSERT INTO ishuffle_weights SELECT * FROM ishuffle_weights_old;
      DROP TABLE ishuffle_weights_old;
    `);
  }
  db.exec(`
    -- The raw votes, briefly. Not a second copy of the mood — this exists so a NEW vote can
    -- look at the last few hours and ask "have they been singling this artist out?" (the
    -- escalation in lib/dj.ts). Rows older than the window are useless and pruned on write.
    CREATE TABLE IF NOT EXISTS ishuffle_votes (
      user_id     INTEGER NOT NULL,
      track_id    INTEGER NOT NULL,
      norm_artist TEXT    NOT NULL,
      direction   TEXT    NOT NULL CHECK (direction IN ('more','less')),
      at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ishuffle_votes_user ON ishuffle_votes (user_id, norm_artist, at);

    -- THE GHOST TRACK. One row per (user, characteristic): a point in the same space every
    -- analysed track occupies, which the next songs are chosen near. The votes column counts
    -- how many votes have shaped it, which is what scales its influence (see lib/dj.ts).
    -- No backticks in here: this block is a JS template literal and one would end it.
    --
    -- A row per dimension rather than a JSON blob, so the ghost is inspectable in SQL and an
    -- insight view can read the strongest dimensions with an ORDER BY rather than parsing.
    CREATE TABLE IF NOT EXISTS ishuffle_ghost (
      user_id    INTEGER NOT NULL,
      key        TEXT    NOT NULL,
      value      REAL    NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS ishuffle_ghost_meta (
      user_id    INTEGER PRIMARY KEY,
      votes      INTEGER NOT NULL DEFAULT 0,
      seeded_at  INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  const trackCols = new Set(
    (db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!trackCols.has('album_artist')) {
    /*
     * Which artist the album belongs to, as distinct from who a track is
     * CREDITED to. Without the split, a guest performer in the artist tag —
     * "Eminem, Beyoncé" with no albumartist — made its own album, and Revival
     * appeared seven times. Backfilled to norm_artist so every existing row
     * groups exactly as it did until reconcileAlbumArtists() knows better.
     */
    db.exec("ALTER TABLE tracks ADD COLUMN album_artist TEXT NOT NULL DEFAULT ''");
    db.exec('UPDATE tracks SET album_artist = norm_artist');
    db.exec('CREATE INDEX IF NOT EXISTS tracks_album_artist ON tracks (album_artist, norm_album)');
  }
  if (!trackCols.has('album_artist_name')) {
    /*
     * The READABLE album artist. album_artist is normalised for keying, and once artist_name
     * started holding the performer there was nowhere left storing "Various Artists" with its
     * capitals — so an album tile had no name it could both display and link with. Backfilled
     * from artist_name, which is exactly what it held before the performer was split out.
     */
    db.exec("ALTER TABLE tracks ADD COLUMN album_artist_name TEXT NOT NULL DEFAULT ''");
    db.exec('UPDATE tracks SET album_artist_name = artist_name');
  }
  if (!trackCols.has('canon_album')) {
    /*
     * The album title with its edition STRIPPED, kept beside norm_album which keeps it.
     *
     * Two columns because there are two questions. norm_album answers "which album is this
     * exactly", so a remaster is its own record. canon_album answers "which album is this
     * roughly", which is what a foreign title can be matched against — an importer or a
     * request knows MusicBrainz's "Rumours", not the local "Rumours (2001 Remaster)".
     *
     * Backfilled from norm_album because that is precisely what norm_album held until now:
     * the canonical form. The next scan rewrites norm_album to the exact identity and leaves
     * this as the loose one.
     */
    db.exec("ALTER TABLE tracks ADD COLUMN canon_album TEXT NOT NULL DEFAULT ''");
    db.exec('UPDATE tracks SET canon_album = norm_album');
    db.exec('CREATE INDEX IF NOT EXISTS tracks_canon_album ON tracks (album_artist, canon_album)');
  }
  if (!trackCols.has('tags_v')) {
    /*
     * Which generation of the tag reader wrote this row.
     *
     * The scanner skips files whose size and mtime are unchanged, so when readTags starts
     * extracting something NEW from the same bytes there is otherwise no way to make it look
     * again — the year column had to smuggle that in through a NULL check. This says it
     * outright: bump TAG_VERSION in lib/library.ts and every row re-reads once.
     */
    db.exec('ALTER TABLE tracks ADD COLUMN tags_v INTEGER NOT NULL DEFAULT 0');
  }
  if (!trackCols.has('year')) {
    /*
     * Release year from the tags, with THREE states rather than two:
     *
     *   NULL  never looked — the row predates this column
     *   0     looked, the file carries no usable year
     *   >0    the year
     *
     * The distinction is what keeps the backfill one-off. A null year on an otherwise
     * unchanged file is the scanner's cue to re-parse it, so one scan fills the whole
     * library in; without the 0 sentinel every file that simply has no year tag would
     * match that same cue and be re-parsed on every scan forever.
     */
    db.exec('ALTER TABLE tracks ADD COLUMN year INTEGER');
  }
  /*
   * Seed play_log once from the aggregate that predates it.
   *
   * ONE row per track, at its last_played — the only timestamp the aggregate actually
   * knows. A track played forty times contributes one entry, so the history undercounts
   * rather than inventing forty moments that were never recorded. Without this the
   * listening page would be blank until a week of new plays accumulated.
   */
  const logEmpty = (db.prepare('SELECT COUNT(*) AS n FROM play_log').get() as { n: number }).n === 0;
  const haveAggregate = (db.prepare('SELECT COUNT(*) AS n FROM plays').get() as { n: number }).n > 0;
  if (logEmpty && haveAggregate) {
    db.exec(
      `INSERT INTO play_log (user_id, track_id, at)
         SELECT user_id, track_id, last_played FROM plays WHERE plays > 0 AND last_played > 0`,
    );
  }

  if (!trackCols.has('bpm')) {
    /*
     * Audio analysis results, filled by the background analyzer (lib/analysis.ts) rather
     * than the tag re-read pass — analysis decodes audio and costs seconds per file, so it
     * trickles instead of blocking a scan. Three states each, like year:
     *
     *   energy NULL  never analysed        -1  failed, do not retry     0..1  the rating
     *   bpm    NULL  unknown (the usual: only a file's own TBPM tag is trusted)
     *
     * ENERGY is the analysed-marker, because a null bpm is the normal case.
     */
    db.exec('ALTER TABLE tracks ADD COLUMN bpm REAL');
    db.exec('ALTER TABLE tracks ADD COLUMN energy REAL');
  }
  if (!trackCols.has('genres')) {
    /*
     * The track's OWN genres, straight from the file's tags — lowercase, comma-joined
     * ("indie pop, pop soul"), empty when the file names none.
     *
     * Per-track where artist_genres is per-artist, and that difference is the point: Last.fm
     * files an artist under one vibe, but the quiet folk track on the metal record knows what
     * it is. Backfilled by the TAG_VERSION 3 re-read pass on the next scan, so no UPDATE here.
     */
    db.exec("ALTER TABLE tracks ADD COLUMN genres TEXT NOT NULL DEFAULT ''");
  }

  const utCols = new Set(
    (db.prepare('PRAGMA table_info(user_tracks)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!utCols.has('favorite')) {
    // Favourites are per-user, per-track — a property of the RELATIONSHIP, not
    // the file, which is why this lives on user_tracks rather than tracks.
    db.exec('ALTER TABLE user_tracks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
  }
  if (!utCols.has('rating')) {
    // 0 = unrated, 1..5 = stars. The binary favorite grew into this within a
    // day of shipping; anything already starred becomes five stars rather
    // than silently losing its mark.
    db.exec('ALTER TABLE user_tracks ADD COLUMN rating INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE user_tracks SET rating = 5 WHERE favorite = 1');
  }

  db.exec(`
    -- Named warmth profiles: "my moods". Every user gets a Default lazily;
    -- the ACTIVE one is a pointer on the user row, so switching is one write
    -- and there is never a moment with two actives.
    CREATE TABLE IF NOT EXISTS algo_profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS algo_profiles_user ON algo_profiles (user_id);

    -- One warmth per (profile, kind, key). 0 = prefer none of this, 5 = prefer
    -- most of this. Keys are the same normalised forms the library uses:
    -- artist, artist|album, artist|title, or a lowercase genre name — so the
    -- sort can join warmth straight onto tracks without a mapping table.
    CREATE TABLE IF NOT EXISTS algo_warmth (
      profile_id INTEGER NOT NULL,
      kind       TEXT    NOT NULL CHECK (kind IN ('genre','artist','album','track')),
      norm_key   TEXT    NOT NULL,
      label      TEXT    NOT NULL DEFAULT '',
      warmth     INTEGER NOT NULL CHECK (warmth BETWEEN 0 AND 5),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, kind, norm_key)
    );

    -- Which genres an artist belongs to, materialised from MusicBrainz.
    -- crate holds no per-track genre at all, so genre warmth means "genres of
    -- the artist" — and that mapping has to exist locally for the library
    -- sort to be a JOIN rather than a thousand lookups.
    CREATE TABLE IF NOT EXISTS artist_genres (
      norm_artist TEXT NOT NULL,
      genre       TEXT NOT NULL,
      PRIMARY KEY (norm_artist, genre)
    );
    -- Artists checked and found genreless still need a row-shaped memory, or
    -- every fill pass would re-ask MusicBrainz about them forever.
    CREATE TABLE IF NOT EXISTS artist_genres_checked (
      norm_artist TEXT PRIMARY KEY,
      checked_at  INTEGER NOT NULL
    );
  `);

  const userCols = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!userCols.has('algo_profile_id')) {
    // NULL means the Default profile; a real id means a chosen mood.
    db.exec('ALTER TABLE users ADD COLUMN algo_profile_id INTEGER');
  }
  if (!userCols.has('home_page')) {
    // Which page '/' shows this person: discover, mylibrary or playlists.
    // A preference, not navigation state, so it lives on the account.
    db.exec("ALTER TABLE users ADD COLUMN home_page TEXT NOT NULL DEFAULT 'discover'");
  }
  if (!userCols.has('stream_password')) {
    // Stored recoverably, which is unavoidable and therefore deliberate.
    //
    // Subsonic token auth is md5(password + salt) computed by the SERVER, so it needs the
    // plaintext. An argon2id hash cannot produce one — that is what a password hash is
    // for. Rather than weaken how account passwords are kept, this is a SEPARATE
    // credential: worst case it grants access to that person's own music, and it cannot
    // log into crate, change settings or request downloads. Empty means the user has not
    // set one and token-auth clients are told what to do.
    db.exec('ALTER TABLE users ADD COLUMN stream_password TEXT NOT NULL DEFAULT \'\'');
  }

  /*
   * Keep the album artist's two halves agreeing.
   *
   * album_artist is the key, album_artist_name is what is displayed and linked with. A fold
   * in reconcileAlbumArtists used to move only the key, leaving rows keyed on "skrillex"
   * whose readable name still said "Skrillex & Penny" — which split the album again on the
   * Subsonic surface and made an album tile's link correct only by luck.
   *
   * The name is taken from the row whose OWN credit is the album artist, which is what makes
   * this safe: a compilation keyed on "various artists" has no track credited that way, so
   * the subquery finds nothing and the row is left alone. Idempotent, and a no-op once
   * consistent, so it simply runs.
   */
  db.exec(`
    UPDATE tracks SET album_artist_name = COALESCE(
      (SELECT MIN(m.album_artist_name) FROM tracks m
        WHERE m.norm_album = tracks.norm_album
          AND m.norm_artist = tracks.album_artist
          AND m.album_artist_name != ''),
      album_artist_name)
     WHERE album_artist != '' AND album_artist != norm_artist
  `);

  const playlistCols = new Set(
    (db.prepare('PRAGMA table_info(playlists)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!playlistCols.has('description')) {
    db.exec("ALTER TABLE playlists ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!playlistCols.has('art_custom')) {
    // Filename of an uploaded cover, or NULL for the generated mosaic. A name rather than a
    // path, so moving the art directory does not invalidate every row.
    db.exec('ALTER TABLE playlists ADD COLUMN art_custom TEXT');
  }
  if (!playlistCols.has('art_seed')) {
    // Which albums the mosaic is built from, so it stays the same picture between requests
    // instead of reshuffling on every page load. See lib/playlistart.ts.
    db.exec('ALTER TABLE playlists ADD COLUMN art_seed TEXT');
  }
  if (!playlistCols.has('rules')) {
    /*
     * A DYNAMIC playlist's recipe, as JSON (lib/dynamicpl.ts), or NULL for an ordinary
     * hand-filled playlist. A dynamic playlist stores no playlist_tracks rows — every
     * open deals fresh tracks from the recipe, which is the whole point of it.
     */
    db.exec('ALTER TABLE playlists ADD COLUMN rules TEXT');
  }
}

/**
 * Drop cache entries nobody will read again. Cheap; run periodically.
 *
 * Deliberately does not touch `requests` — the daily cap reads history, and a
 * swept row would silently raise somebody's allowance.
 */
export function sweep(db: Database.Database, cacheRetentionDays = 14): void {
  const t = nowSec();
  /**
   * Metadata is swept on LAST USE, and never when it belongs to music that is here.
   *
   * A response about an album somebody still holds is worth keeping indefinitely: throwing
   * it away only guarantees another call to somebody else's API for an answer that has not
   * changed. Anything mentioning an mbid present in the pool is therefore kept, and the
   * rest goes once nobody has touched it for the retention window. 0 keeps everything.
   */
  if (cacheRetentionDays > 0) {
    db.prepare(
      `DELETE FROM cache
        WHERE last_used_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM tracks
             WHERE tracks.album_mbid IS NOT NULL
               AND instr(cache.k, tracks.album_mbid) > 0
          )`,
    ).run(t - cacheRetentionDays * 86400);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(t - 86400);
}
