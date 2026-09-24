import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Qbit } from '../src/lib/qbit.js';
import { draftConfig, type Config, type ConfigSource } from '../src/lib/settings.js';

/**
 * Reported against /admin/downloading: with no matching category in qBittorrent, a
 * torrent downloads perfectly and crate never sees it again — because crate FINDS its
 * torrents by category rather than merely tagging them. So the category has to exist
 * before anything is filed under it, and crate creates it rather than requiring the
 * operator to have done so.
 *
 * The same report asked to test connection settings before saving them, which is what
 * draftConfig covers below.
 */

const cfg = (over: Partial<Config> = {}): ConfigSource => ({
  all: () =>
    ({
      qbitUrl: 'http://qb.test',
      qbitUser: '',
      qbitPassword: '',
      qbitCategory: 'crate',
      qbitSavePath: '/downloads/crate',
      ...over,
    }) as Config,
});

/** Records every request and answers from a scripted responder. */
function stubFetch(script: (url: string) => { status: number; body: string }) {
  const calls: { url: string; method: string; body: string }[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      body: typeof init.body === 'string' ? init.body : '',
    });
    const { status, body } = script(String(url));
    return new Response(body, { status });
  });
  return calls;
}

afterEach(() => mock.restoreAll());

describe('ensureCategory', () => {
  test('creates the category when the client does not have it', async () => {
    const calls = stubFetch((url) =>
      url.includes('/torrents/categories')
        ? { status: 200, body: JSON.stringify({ radarr: {}, 'tv-sonarr': {} }) }
        : { status: 200, body: '' },
    );
    assert.equal(await new Qbit(cfg()).ensureCategory(), 'created');

    const create = calls.find((c) => c.url.includes('/torrents/createCategory'));
    assert.ok(create, 'it must actually create it');
    assert.equal(create.method, 'POST');
    // The save path goes with it, or qBittorrent files crate's downloads elsewhere.
    assert.match(create.body, /category=crate/);
    assert.match(create.body, /savePath=%2Fdownloads%2Fcrate/);
  });

  test('does nothing when the category is already there', async () => {
    const calls = stubFetch(() => ({ status: 200, body: JSON.stringify({ crate: {} }) }));
    assert.equal(await new Qbit(cfg()).ensureCategory(), 'existed');
    assert.equal(calls.filter((c) => c.url.includes('createCategory')).length, 0);
  });

  test('a 409 is success, not a failure', async () => {
    // qBittorrent answers 409 "Unable to create category" when the name is taken.
    // Between listing and creating, anything else using the client may have made it —
    // and the outcome we wanted is the outcome we have.
    stubFetch((url) =>
      url.includes('/torrents/categories')
        ? { status: 200, body: '{}' }
        : { status: 409, body: 'Unable to create category' },
    );
    assert.equal(await new Qbit(cfg()).ensureCategory(), 'existed');
  });

  test('a real refusal is reported, naming the category', async () => {
    stubFetch((url) =>
      url.includes('/torrents/categories') ? { status: 200, body: '{}' } : { status: 500, body: 'boom' },
    );
    await assert.rejects(new Qbit(cfg()).ensureCategory(), /category "crate"/);
  });

  test('no category configured is nothing to create', async () => {
    const calls = stubFetch(() => ({ status: 200, body: '{}' }));
    assert.equal(await new Qbit(cfg({ qbitCategory: '' })).ensureCategory(), 'existed');
    assert.equal(calls.length, 0, 'nothing worth asking about');
  });
});

describe('categories', () => {
  test('reads the names out of the map qBittorrent returns', async () => {
    stubFetch(() => ({ status: 200, body: JSON.stringify({ crate: {}, radarr: {} }) }));
    assert.deepEqual(await new Qbit(cfg()).categories(), ['crate', 'radarr']);
  });

  test('a failure says so rather than reporting no categories', async () => {
    // Returning [] here would make ensureCategory try to create one on every add.
    stubFetch(() => ({ status: 503, body: 'down' }));
    await assert.rejects(new Qbit(cfg()).categories(), /503/);
  });
});

describe('draftConfig', () => {
  const base = {
    qbitUrl: 'http://old',
    qbitPassword: 'stored-secret',
    sabKey: 'stored-key',
    qbitCategory: 'crate',
    minSeeders: 3,
  } as unknown as Config;
  const writable = ['qbitUrl', 'qbitPassword', 'sabKey', 'qbitCategory', 'minSeeders'] as (keyof Config)[];

  test('an entered value wins over the stored one', () => {
    const c = draftConfig(base, { qbitUrl: 'http://new' }, writable);
    assert.equal(c.qbitUrl, 'http://new');
    assert.equal(c.qbitCategory, 'crate', 'untouched keys are kept');
  });

  test('an untouched secret falls back to the stored one', () => {
    // The form never receives secrets, so an empty field means "unchanged". Reading it
    // as "no password" would fail every test where only the URL had been edited.
    assert.equal(draftConfig(base, { qbitUrl: 'http://new', qbitPassword: '' }, writable).qbitPassword, 'stored-secret');
  });

  test('a retyped secret is used', () => {
    assert.equal(draftConfig(base, { qbitPassword: 'typed' }, writable).qbitPassword, 'typed');
  });

  test('null counts as untouched, the same as empty', () => {
    assert.equal(draftConfig(base, { sabKey: null }, writable).sabKey, 'stored-key');
  });

  test('a non-secret may legitimately be cleared', () => {
    // Blanking a category is a real intention; blanking a password is not expressible,
    // and that asymmetry is deliberate.
    assert.equal(draftConfig(base, { qbitCategory: '' }, writable).qbitCategory, '');
  });

  test('keys outside the writable list are ignored', () => {
    // The body is browser-supplied; a test must not become a way to set arbitrary config.
    const c = draftConfig(base, { notAKey: 'x', qbitUrl: 'http://new' }, writable);
    assert.equal((c as unknown as Record<string, unknown>).notAKey, undefined);
    assert.equal(c.qbitUrl, 'http://new');
  });

  test('the stored config is not mutated', () => {
    draftConfig(base, { qbitUrl: 'http://new' }, writable);
    assert.equal(base.qbitUrl, 'http://old');
  });

  test('an empty draft changes nothing', () => {
    assert.deepEqual(draftConfig(base, {}, writable), base);
  });
});
