import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { open } from '../src/db/schema.js';
import { Store } from '../src/lib/store.js';

/**
 * The sign-in throttle, as /rest relies on it.
 *
 * /rest authenticates on EVERY request and had no throttle at all, so the web login's
 * six-per-fifteen-minutes limit could simply be walked around. These pin the two things
 * that path depends on: that the count and the lockout come back together (so the hot
 * path can avoid a write), and that the bucket is keyed narrowly enough that throttling
 * one attacker cannot lock out somebody else.
 */

const MAX_FAILS = 6;
const WINDOW_S = 900;

let db: Database.Database;
let store: Store;

beforeEach(() => {
  db = open(':memory:');
  store = new Store(db);
});

const failTimes = (n: number, ip = '203.0.113.9', user = 'matt'): void => {
  for (let i = 0; i < n; i += 1) store.recordFail(ip, user);
};

describe('loginFailState', () => {
  test('a clean slate is no failures and no lockout', () => {
    assert.deepEqual(store.loginFailState('203.0.113.9', 'matt'), { fails: 0, lockedForS: 0 });
  });

  test('counts failures without locking until the limit is reached', () => {
    failTimes(MAX_FAILS - 1);
    const state = store.loginFailState('203.0.113.9', 'matt');
    assert.equal(state.fails, MAX_FAILS - 1);
    assert.equal(state.lockedForS, 0, 'the fifth wrong guess still gets a sixth try');
  });

  test('locks on the limit, for the rest of the window', () => {
    failTimes(MAX_FAILS);
    const state = store.loginFailState('203.0.113.9', 'matt');
    assert.equal(state.fails, MAX_FAILS);
    assert.ok(state.lockedForS > 0, 'must be locked');
    assert.ok(state.lockedForS <= WINDOW_S);
  });

  test('the lockout is keyed on address AND username', () => {
    // One account being attacked must not lock a different one out, and one attacker
    // must not be able to lock an account out from every address at once.
    failTimes(MAX_FAILS);
    assert.ok(store.loginFailState('203.0.113.9', 'matt').lockedForS > 0);
    assert.equal(store.loginFailState('203.0.113.9', 'someone-else').lockedForS, 0);
    assert.equal(store.loginFailState('198.51.100.4', 'matt').lockedForS, 0);
  });

  test('the username is matched case- and whitespace-insensitively', () => {
    // Otherwise "Matt", "matt " and "matt" are three separate budgets of six.
    failTimes(MAX_FAILS, '203.0.113.9', 'matt');
    assert.ok(store.loginFailState('203.0.113.9', '  MATT ').lockedForS > 0);
  });

  test('a success clears the record', () => {
    failTimes(MAX_FAILS);
    store.clearFails('203.0.113.9', 'matt');
    assert.deepEqual(store.loginFailState('203.0.113.9', 'matt'), { fails: 0, lockedForS: 0 });
  });

  test('attempts older than the window do not count', () => {
    const stale = Math.floor(Date.now() / 1000) - WINDOW_S - 60;
    for (let i = 0; i < MAX_FAILS; i += 1) {
      db.prepare('INSERT INTO login_attempts (ip,username,at) VALUES (?,?,?)').run(
        '203.0.113.9',
        'matt',
        stale,
      );
    }
    assert.deepEqual(store.loginFailState('203.0.113.9', 'matt'), { fails: 0, lockedForS: 0 });
  });

  test('old attempts do not top up recent ones into a lockout', () => {
    const stale = Math.floor(Date.now() / 1000) - WINDOW_S - 60;
    for (let i = 0; i < MAX_FAILS - 1; i += 1) {
      db.prepare('INSERT INTO login_attempts (ip,username,at) VALUES (?,?,?)').run(
        '203.0.113.9',
        'matt',
        stale,
      );
    }
    failTimes(1);
    const state = store.loginFailState('203.0.113.9', 'matt');
    assert.equal(state.fails, 1);
    assert.equal(state.lockedForS, 0);
  });

  test('lockoutRemaining agrees with it', () => {
    // It is now a thin wrapper; the web path must not drift from the /rest path.
    failTimes(MAX_FAILS);
    assert.equal(
      store.lockoutRemaining('203.0.113.9', 'matt'),
      store.loginFailState('203.0.113.9', 'matt').lockedForS,
    );
  });

  test('reading the state writes nothing', () => {
    // The point of returning `fails`: the caller skips clearFails() when it is zero, so
    // a client streaming an album does one indexed read per request and no writes.
    const before = db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as { n: number };
    store.loginFailState('203.0.113.9', 'matt');
    const after = db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as { n: number };
    assert.equal(after.n, before.n);
  });
});
