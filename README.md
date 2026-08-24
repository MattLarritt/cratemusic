<div align="center">
  <img src="brand/crate%20-%20hoz%20lg.png" alt="crate" width="360">
  <p><strong>A self-hosted music library, player and recommender that owns the whole path.</strong></p>
</div>

crate manages the music you have, helps you find music you don't, imports it,
describes what it sounds like, serves it to your phone, and recommends more from
what you actually play. One container, one SQLite file, no companion services
required.

It is not a Navidrome or Jellyfin alternative with extras bolted on — it is a
single application that does the library, the acquisition, the identification,
the streaming and the recommendation itself, because splitting those across four
tools is what made them all disagree.

---

## What it does

**Library**
- Per-user libraries over one shared pool of files — two people pointing a phone
  at the same server get two different libraries, and neither can see the other's
- Deletes move to a trash directory, verified by size before the original goes.
  Nothing here calls `unlink` on your music
- Bring-your-own albums: drag files in, and crate matches them to an official
  tracklist before it commits

**Finding and getting music**
- Search MusicBrainz, request an album, and crate runs the whole pipeline:
  choose a release, grab it, watch the download, import it, embed lyrics
- Works with Prowlarr + SABnzbd + qBittorrent if you have them. With none of
  them, crate manages the library you already have

**Knowing what it is**
- MusicBrainz for metadata, Cover Art Archive / Deezer / iTunes for artwork —
  no keys, no accounts
- AcoustID identifies audio by how it *sounds*, for files whose tags lie
- Local `ffmpeg` analysis for energy and BPM; a multidimensional characteristic
  vector per track for similarity that isn't just genre matching

**Playing it**
- Web player, plus a full **OpenSubsonic API** — so any Subsonic client
  (phone, car, desktop) works, filtered to that user's own library
- **Intelligent Shuffle**: a DJ over your own library that reads the room and
  takes votes, rather than shuffling at random
- **Dynamic playlists** that store a *recipe*, not rows, and deal fresh every time
- Recommendations scored against what you actually play, with named "algorithm
  profiles" that reshape the whole library view

**Optional AI**
- OpenAI is used strictly as an *arbiter*: breaking ties the rules engine cannot
  settle when matching messy filenames, and building a playlist from a text
  prompt. It is never in the critical path, and absent it nothing else changes.

---

## Install

You need Docker with Compose v2, and two directories: your music library, and
wherever your downloads land.

```bash
git clone https://github.com/MattLarritt/cratemusic.git
cd cratemusic
cp .env.example .env
```

Edit `.env` — at minimum:

```ini
CRATE_MUSIC_DIR=/srv/music          # your library, as the host sees it
CRATE_DOWNLOADS_DIR=/srv/downloads  # must be a DIFFERENT tree
CRATE_BOOTSTRAP_USER=admin          # creates your first admin on first boot
CRATE_BOOTSTRAP_PASSWORD=change-me
```

Then:

```bash
docker compose up -d --build
```

The first build takes a few minutes (it compiles the web app and `better-sqlite3`).
Open **http://localhost:8080** and sign in with the bootstrap credentials, then
change the password and remove those two lines from `.env`.

Watch it come up:

```bash
docker compose logs -f crate
```

The boot line tells you exactly which integrations are live:

```
crate listening on :8080, lastfm enabled, api key set, users 1
```

### Scanning your library

Go to **Admin → Library → Scan**. crate reads tags, groups tracks into albums,
and resolves artists against MusicBrainz. A first scan of a few thousand tracks
takes a few minutes; MusicBrainz allows one request per second, so identification
continues in the background and everything is cached afterwards.

### If you cannot sign in

The single most common problem. crate's session cookie is `Secure`-only by
default, so over plain HTTP the browser silently discards it and sign-in appears
to do nothing. Either put it behind HTTPS, or set:

```ini
CRATE_COOKIE_INSECURE=1
```

---

## Configuration

Everything is optional except the two directories. Each integration's absence
disables that feature — crate never fails to start because something is missing,
and the boot log says what is off. See [`.env.example`](.env.example) for the
annotated list; the ones worth having:

| Setting | Gets you | Cost |
| --- | --- | --- |
| `CRATE_LASTFM_KEY` | artist similarity, richer Discover | free key |
| `ACOUSTID_API_KEY` | identify audio by sound, not tags | free key |
| `OPENAI_API_KEY` | AI playlists, hard-case match arbitration | paid, tiny usage |
| `CRATE_PROWLARR_*` + `CRATE_SAB_*` / `CRATE_QBIT_*` | crate acquires music itself | your existing setup |
| `CRATE_API_KEY` | bearer-auth endpoints for scripts / automation | — |

### Behind a reverse proxy

crate binds to `127.0.0.1` by default because it has no rate limiting of its own.
Put it behind your proxy and forward the real client IP. One caveat: **do not put
a login gateway in front of `/rest`** — Subsonic clients authenticate on every
request and cannot follow an interactive login. Gate the app, leave `/rest` to
crate's own auth.

### Optional: a local MusicBrainz mirror

crate is gated to MusicBrainz's one-request-per-second limit, which makes bulk
imports slow. If you run a [MusicBrainz
mirror](https://github.com/metabrainz/musicbrainz-docker), set its URL in
**Admin → Settings → MusicBrainz** and hit **Test**. crate then prefers the
mirror and falls back to the public API automatically — including when the mirror
is switched off, which it treats as normal rather than an error. A database-only
mirror (no search indexes) works fine: MBID lookups go local, text searches go
public.

---

## Backup

Everything that matters is in `./data`:

```
data/crate.db          the database — library, users, plays, playlists, settings
data/art/              cached artwork (regenerable)
data/playlist-art/     playlist covers (uploads are NOT regenerable)
data/plugins/          installed plugins
```

`crate.db` in WAL mode is safe to copy while running, but a consistent snapshot
is better:

```bash
docker compose exec crate sh -c 'sqlite3 /data/crate.db ".backup /data/backup.db"'
```

Your music files are never modified in place — crate only moves them on import
or delete, and never rewrites tags.

---

## Development

```bash
npm install && (cd web && npm install)
npm run build          # typechecks server + web
npm test               # 91 tests, node:test
CRATE_DB=./dev.db CRATE_MUSIC_ROOT=/path/to/music npm start
```

Node 22+. The server is Fastify + `better-sqlite3` (synchronous, deliberately);
the web app is React + Vite. `src/lib/*` holds one module per domain, each with a
header comment explaining *why* it is the way it is — start there rather than
here.

---

## Licence

MIT — see [LICENSE](LICENSE).

Metadata from [MusicBrainz](https://musicbrainz.org), artwork from the
[Cover Art Archive](https://coverartarchive.org), similarity from
[Last.fm](https://www.last.fm/api), fingerprinting by
[AcoustID](https://acoustid.org)/Chromaprint. crate is not affiliated with any of
them; please respect their rate limits and terms.
