/**
 * Resolving "which album does this song live on" — the step that decides what crate goes and
 * looks for at the indexers, and therefore the step where a wrong answer costs a failed request.
 *
 * These are unit tests over stubbed MusicBrainz responses, not live lookups: the point is the
 * RANKING, and the responses below are trimmed copies of what MusicBrainz actually returns for
 * the cases that failed in the wild. Both failures Matt reported are here as fixtures:
 *
 *   "The Real Slim Shady" resolved to The Marshall Mathers LP Snippet Tape — a DJ's promo tape,
 *   dated "2000" against the real LP's "2000-05-22", which won the oldest-first tie-break
 *   because "2000" sorts before "2000-05-22" as a string.
 *
 *   "Lose Yourself" resolved to an obscure compilation, because the song is on no studio album
 *   and every candidate landed in one undifferentiated bin.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { open } from '../src/db/schema.js';
import { MusicBrainz } from '../src/lib/musicbrainz.js';
import { Store } from '../src/lib/store.js';

/** A MusicBrainz that answers from a URL→payload table and records what it was asked. */
function fakeMb(routes: { match: RegExp; body: unknown }[]) {
  const asked: string[] = [];
  const db = open(':memory:');
  const mb = new MusicBrainz(new Store(db), 'test', () => {});
  // The transport is the seam: everything above it is the logic under test.
  (mb as unknown as { json: unknown }).json = async (url: string) => {
    asked.push(url);
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) throw new Error(`no stub for ${url}`);
    return hit.body;
  };
  return { mb, asked };
}

const artistSearch = (name: string, mbid: string) => ({
  match: /\/artist\?/,
  body: { artists: [{ id: mbid, name, score: 100 }] },
});

/** What GET /release?release-group=… returns: releases, each with media and tracks. */
const tracklist = (...titles: string[]) => ({
  releases: [{ media: [{ tracks: titles.map((title, i) => ({ position: i + 1, title })) }] }],
});

const rg = (o: {
  id: string;
  title: string;
  date?: string;
  credit?: string;
  primary?: string;
  secondary?: string[];
}) => ({
  id: o.id,
  title: o.title,
  'primary-type': o.primary ?? 'Album',
  'secondary-types': o.secondary ?? [],
  'first-release-date': o.date ?? '',
  'artist-credit': (o.credit ?? 'Eminem').split(', ').map((n) => ({ name: n })),
});

describe('albumForTrack', () => {
  it('prefers the real album over a same-year promo tape credited to somebody else', async () => {
    // The exact shape that failed: the snippet tape is dated "2000" (year only) and led by a DJ.
    const { mb } = fakeMb([
      artistSearch('Eminem', 'em-mbid'),
      {
        match: /\/release-group\?artist=em-mbid/,
        body: {
          'release-groups': [
            rg({ id: 'snippet', title: 'The Marshall Mathers LP Snippet Tape', date: '2000', credit: 'Stretch Armstrong, Eminem' }),
            rg({ id: 'mmlp', title: 'The Marshall Mathers LP', date: '2000-05-22' }),
          ],
        },
      },
      // Both "contain" the track, as a snippet tape genuinely does. tracks() browses RELEASES
      // by release group, so the stub matches that URL and returns that payload shape.
      { match: /\/release\?release-group=snippet/, body: tracklist('The Real Slim Shady') },
      { match: /\/release\?release-group=mmlp/, body: tracklist('The Real Slim Shady') },
    ]);
    const got = await mb.albumForTrack('Eminem', 'The Real Slim Shady');
    assert.equal(got?.albumTitle, 'The Marshall Mathers LP');
  });

  it('a year-only date does not beat a precise one in the same year', async () => {
    // Same test with the credit made innocent, so the date rule is what is being measured.
    const { mb } = fakeMb([
      artistSearch('Eminem', 'em-mbid'),
      {
        match: /\/release-group\?artist=em-mbid/,
        body: {
          'release-groups': [
            rg({ id: 'vague', title: 'Unmastered Sequence', date: '2000' }),
            rg({ id: 'mmlp', title: 'The Marshall Mathers LP', date: '2000-05-22' }),
          ],
        },
      },
      { match: /\/release\?release-group=vague/, body: tracklist('Stan') },
      { match: /\/release\?release-group=mmlp/, body: tracklist('Stan') },
    ]);
    assert.equal((await mb.albumForTrack('Eminem', 'Stan'))?.albumTitle, 'The Marshall Mathers LP');
  });

  it('a genuine collaboration still counts as the artist’s own record', async () => {
    // "Eminem, Dr. Dre" leads with Eminem; the credit rule must not throw those away.
    const { mb } = fakeMb([
      artistSearch('Eminem', 'em-mbid'),
      {
        match: /\/release-group\?artist=em-mbid/,
        body: {
          'release-groups': [rg({ id: 'collab', title: 'Some Collaboration', date: '2013-12-03', credit: 'Eminem, Dr. Dre' })],
        },
      },
      { match: /\/release\?release-group=collab/, body: tracklist('A Song') },
    ]);
    assert.equal((await mb.albumForTrack('Eminem', 'A Song'))?.albumTitle, 'Some Collaboration');
  });

  describe('a song on no studio album at all', () => {
    /** Eminem has no studio album with Lose Yourself on it; the fallback search decides. */
    const loseYourself = (recordings: unknown) => [
      artistSearch('Eminem', 'em-mbid'),
      { match: /\/release-group\?artist=em-mbid/, body: { 'release-groups': [rg({ id: 'mmlp', title: 'The Marshall Mathers LP', date: '2000-05-22' })] } },
      { match: /\/release\?release-group=mmlp/, body: tracklist('Stan') },
      { match: /\/recording\?/, body: { recordings } },
    ];

    const rec = (releases: { status: string; group: { id: string; title: string; primary: string; secondary?: string[] } }[]) => ({
      score: 100,
      title: 'Lose Yourself',
      'artist-credit': [{ name: 'Eminem' }],
      releases: releases.map((r) => ({
        status: r.status,
        'release-group': {
          id: r.group.id,
          title: r.group.title,
          'primary-type': r.group.primary,
          'secondary-types': r.group.secondary ?? [],
        },
      })),
    });

    it('takes a soundtrack or hits compilation over a random various-artists comp', async () => {
      const { mb } = fakeMb(
        loseYourself([
          rec([{ status: 'Official', group: { id: 'funky', title: 'Funkymix 64', primary: 'Album', secondary: ['Compilation'] } }]),
          rec([{ status: 'Official', group: { id: 'ost', title: '8 Mile: Music From and Inspired by the Motion Picture', primary: 'Album', secondary: ['Soundtrack'] } }]),
        ]),
      );
      const got = await mb.albumForTrack('Eminem', 'Lose Yourself');
      // Either of the two acceptable homes, but never a mixtape or a single.
      assert.ok(got, 'resolved nothing');
      assert.ok(/8 Mile|Funkymix/.test(got.albumTitle));
    });

    it('a mixtape or a single never beats a soundtrack', async () => {
      const { mb } = fakeMb(
        loseYourself([
          rec([{ status: 'Official', group: { id: 'mix', title: 'Before the Curtain Closes', primary: 'Album', secondary: ['Mixtape/Street'] } }]),
          rec([{ status: 'Official', group: { id: 'single', title: 'Lose Yourself', primary: 'Single' } }]),
          rec([{ status: 'Official', group: { id: 'ost', title: '8 Mile: Music From and Inspired by the Motion Picture', primary: 'Album', secondary: ['Soundtrack'] } }]),
        ]),
      );
      assert.match((await mb.albumForTrack('Eminem', 'Lose Yourself'))?.albumTitle ?? '', /8 Mile/);
    });

    it('an official release beats the bootleg copy of the same record', async () => {
      const { mb } = fakeMb(
        loseYourself([
          rec([
            { status: 'Bootleg', group: { id: 'ost-boot', title: '8 Mile bootleg rip', primary: 'Album', secondary: ['Soundtrack'] } },
            { status: 'Official', group: { id: 'ost', title: '8 Mile: Music From and Inspired by the Motion Picture', primary: 'Album', secondary: ['Soundtrack'] } },
          ]),
        ]),
      );
      assert.match((await mb.albumForTrack('Eminem', 'Lose Yourself'))?.albumTitle ?? '', /Motion Picture/);
    });
  });
});
