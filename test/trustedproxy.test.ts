import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ipToBig, parseCidr, parseTrustedProxies, isTrustedProxy } from '../src/lib/trustedproxy.js';
import { clientIp } from '../src/routes/auth.js';
import { scrubUrl } from '../src/lib/logscrub.js';
import type { FastifyRequest } from 'fastify';

/** Just the parts of a request clientIp() actually reads. */
function req(peer: string | undefined, headers: Record<string, string> = {}): FastifyRequest {
  return { headers, socket: { remoteAddress: peer } } as unknown as FastifyRequest;
}

describe('ipToBig', () => {
  test('reads IPv4', () => {
    assert.equal(ipToBig('192.0.2.1')?.value, 3221225985n);
    assert.equal(ipToBig('192.0.2.1')?.family, 4);
  });

  test('reads IPv6, including :: expansion', () => {
    assert.equal(ipToBig('::1')?.value, 1n);
    assert.equal(ipToBig('::1')?.family, 6);
    assert.deepEqual(ipToBig('::1'), ipToBig('0:0:0:0:0:0:0:1'));
    assert.equal(ipToBig('2001:db8::1')?.family, 6);
  });

  test('an IPv4-mapped address IS the IPv4 address', () => {
    // A dual-stack listener reports a v4 client this way. An operator writing
    // 192.0.2.0/24 means that client, so the two have to compare equal.
    assert.deepEqual(ipToBig('::ffff:192.0.2.1'), ipToBig('192.0.2.1'));
  });

  test('brackets and zone indices are notation, not address', () => {
    assert.deepEqual(ipToBig('[::1]'), ipToBig('::1'));
    assert.deepEqual(ipToBig('fe80::1%eth0'), ipToBig('fe80::1'));
  });

  test('refuses what it cannot read instead of guessing', () => {
    for (const bad of ['', 'nope', '999.0.0.1', '1.2.3', '1.2.3.4.5', '::ffff::1', 'g::1', '1::2::3']) {
      assert.equal(ipToBig(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseCidr', () => {
  test('a bare address is one host', () => {
    const c = parseCidr('10.0.0.5');
    assert.equal(c?.bits, 32);
    assert.ok(isTrustedProxy('10.0.0.5', [c!]));
    assert.ok(!isTrustedProxy('10.0.0.6', [c!]));
  });

  test('a bare IPv6 address is one host too', () => {
    const c = parseCidr('2001:db8::1');
    assert.equal(c?.bits, 128);
    assert.ok(isTrustedProxy('2001:db8::1', [c!]));
    assert.ok(!isTrustedProxy('2001:db8::2', [c!]));
  });

  test('host bits below the prefix are masked off', () => {
    // 10.0.0.7/24 describes 10.0.0.0/24; being untidy should not be an error.
    assert.ok(isTrustedProxy('10.0.0.99', [parseCidr('10.0.0.7/24')!]));
  });

  test('rejects an impossible prefix', () => {
    assert.equal(parseCidr('10.0.0.0/33'), null);
    assert.equal(parseCidr('::/129'), null);
    assert.equal(parseCidr('10.0.0.0/x'), null);
  });

  test('/0 matches the whole family', () => {
    assert.ok(isTrustedProxy('203.0.113.1', [parseCidr('0.0.0.0/0')!]));
  });
});

describe('parseTrustedProxies', () => {
  test('accepts commas and whitespace', () => {
    assert.equal(parseTrustedProxies('10.0.0.0/8, 192.0.2.1\n2001:db8::/32').length, 3);
  });

  test('one typo does not stop the server booting', () => {
    // Failing to boot over a malformed proxy list would take the service down to
    // protect a lockout counter. The bad entry simply grants nothing.
    assert.equal(parseTrustedProxies('10.0.0.0/8, garbage, 192.0.2.1').length, 2);
  });

  test('empty configuration is an empty list', () => {
    assert.deepEqual(parseTrustedProxies(''), []);
    assert.deepEqual(parseTrustedProxies('   '), []);
  });
});

describe('isTrustedProxy', () => {
  test('an empty list trusts nobody — the default', () => {
    assert.equal(isTrustedProxy('10.0.0.1', []), false);
  });

  test('the two families never match each other', () => {
    const v4 = parseTrustedProxies('0.0.0.0/0');
    const v6 = parseTrustedProxies('::/0');
    assert.ok(isTrustedProxy('1.2.3.4', v4));
    assert.ok(!isTrustedProxy('2001:db8::1', v4));
    assert.ok(isTrustedProxy('2001:db8::1', v6));
    assert.ok(!isTrustedProxy('1.2.3.4', v6));
  });

  test('an unreadable or absent address is not trusted', () => {
    assert.equal(isTrustedProxy(undefined, parseTrustedProxies('0.0.0.0/0')), false);
    assert.equal(isTrustedProxy('nonsense', parseTrustedProxies('0.0.0.0/0')), false);
  });

  test('matches inside a real-world range', () => {
    const list = parseTrustedProxies('172.16.0.0/12 103.21.244.0/22');
    assert.ok(isTrustedProxy('172.20.5.9', list));
    assert.ok(!isTrustedProxy('172.32.0.1', list));
  });
});

describe('clientIp', () => {
  const trusted = parseTrustedProxies('10.0.0.1');

  test('with nothing configured, headers are ignored entirely', () => {
    // The whole point of the default: a caller reaching crate directly must not be able
    // to choose its own lockout key.
    const r = req('203.0.113.9', {
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8',
    });
    assert.equal(clientIp(r, []), '203.0.113.9');
  });

  test('an untrusted peer cannot rotate its way to a fresh bucket', () => {
    const a = clientIp(req('203.0.113.9', { 'cf-connecting-ip': 'aaa' }), trusted);
    const b = clientIp(req('203.0.113.9', { 'cf-connecting-ip': 'bbb' }), trusted);
    assert.equal(a, b, 'the key must not move when the header does');
    assert.equal(a, '203.0.113.9');
  });

  test('a trusted proxy may name the client', () => {
    assert.equal(clientIp(req('10.0.0.1', { 'cf-connecting-ip': '198.51.100.7' }), trusted), '198.51.100.7');
  });

  test('from a trusted proxy, the RIGHT-most forwarded entry wins', () => {
    // The left-most is whatever the client wrote; the nearest hop is attested.
    const r = req('10.0.0.1', { 'x-forwarded-for': 'forged-by-client, 198.51.100.7' });
    assert.equal(clientIp(r, trusted), '198.51.100.7');
  });

  test('a trusted proxy that forwards nothing falls back to the peer', () => {
    assert.equal(clientIp(req('10.0.0.1'), trusted), '10.0.0.1');
  });

  test('a missing socket address never throws', () => {
    assert.equal(clientIp(req(undefined), trusted), 'unknown');
  });
});

describe('scrubUrl', () => {
  test('masks a Subsonic password but keeps the rest readable', () => {
    const out = scrubUrl('/rest/ping?u=matt&p=hunter2&v=1.16.1&c=client');
    assert.match(out, /u=matt/);
    assert.match(out, /c=client/);
    assert.doesNotMatch(out, /hunter2/);
    assert.match(out, /p=%5Bredacted%5D/);
  });

  test('masks the replayable token and salt pair', () => {
    const out = scrubUrl('/rest/ping?u=matt&t=26719a1196d2a940705a59634eb18eab&s=c19b2d');
    assert.doesNotMatch(out, /26719a1196d2a940705a59634eb18eab/);
    assert.doesNotMatch(out, /c19b2d/);
  });

  test('masks hex-encoded passwords, which are not encrypted', () => {
    const out = scrubUrl('/rest/ping?u=matt&p=enc:68756e74657232');
    assert.doesNotMatch(out, /68756e74657232/);
  });

  test('leaves a URL with no secrets exactly as it was', () => {
    const plain = '/api/albums?page=2&sort=added';
    assert.equal(scrubUrl(plain), plain);
    assert.equal(scrubUrl('/api/health'), '/api/health');
  });
});
