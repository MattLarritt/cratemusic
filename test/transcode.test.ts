import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { plan, estimateBitrate, TARGETS } from '../src/lib/transcode.js';

/**
 * The decision table.
 *
 * Getting this wrong is expensive in both directions: transcoding when there is no need
 * burns CPU and quality on every stream, and refusing to when there is leaves a client
 * unable to play anything at all. Both failures are quiet, which is why the rules are
 * pinned here rather than inferred from whether playback happened to work.
 */

const flac = { path: '/m/a.flac', sizeBytes: 40_000_000, durationS: 300, sourceMime: 'audio/flac' };
const mp3 = { path: '/m/a.mp3', sizeBytes: 12_000_000, durationS: 300, sourceMime: 'audio/mpeg' };

describe('estimateBitrate', () => {
  test('derives kbps from size and duration', () => {
    // 12 MB over 300s ≈ 320 kbps
    assert.equal(estimateBitrate(12_000_000, 300), 320);
  });

  test('returns null rather than nonsense when duration is unknown', () => {
    assert.equal(estimateBitrate(12_000_000, null), null);
    assert.equal(estimateBitrate(12_000_000, 0), null);
    assert.equal(estimateBitrate(0, 300), null);
  });
});

describe('plan: when NOT to transcode', () => {
  test('no parameters means untouched bytes', () => {
    const p = plan({ ...flac });
    assert.equal(p.transcode, false);
    assert.equal(p.mime, 'audio/flac', 'keeps the source content type');
  });

  test('format=raw wins even with a ceiling sent alongside it', () => {
    const p = plan({ ...flac, format: 'raw', maxBitRate: 96 });
    assert.equal(p.transcode, false);
    assert.match(p.reason, /raw/);
  });

  test('raw is matched case-insensitively and trimmed', () => {
    assert.equal(plan({ ...flac, format: 'RAW' }).transcode, false);
    assert.equal(plan({ ...flac, format: ' raw ' }).transcode, false);
  });

  test('asking for the format it already is, with no ceiling, does nothing', () => {
    assert.equal(plan({ ...mp3, format: 'mp3' }).transcode, false);
  });

  test('a source already under the ceiling is left alone', () => {
    // 320 kbps mp3 asked for <= 320: re-encoding could only lose quality.
    const p = plan({ ...mp3, format: 'mp3', maxBitRate: 320 });
    assert.equal(p.transcode, false);
    assert.match(p.reason, /already within/);
  });

  test('an unknown format degrades to the original instead of failing', () => {
    // Subsonic has no error code for "cannot do that format", and the original is more
    // use to a client than an error it cannot interpret.
    const p = plan({ ...flac, format: 'wma' });
    assert.equal(p.transcode, false);
    assert.match(p.reason, /unsupported/);
  });

  test('lossless to the same lossless format is a no-op', () => {
    assert.equal(plan({ ...flac, format: 'flac' }).transcode, false);
  });

  test('maxBitRate=0 means no ceiling, per the spec', () => {
    assert.equal(plan({ ...mp3, maxBitRate: 0 }).transcode, false);
  });
});

describe('plan: when to transcode', () => {
  test('flac to mp3 at a requested ceiling', () => {
    const p = plan({ ...flac, format: 'mp3', maxBitRate: 128 });
    assert.equal(p.transcode, true);
    assert.equal(p.format, 'mp3');
    assert.equal(p.bitRate, 128);
    assert.equal(p.mime, 'audio/mpeg');
  });

  test('a ceiling alone downsamples in place, keeping the format', () => {
    const p = plan({ ...mp3, maxBitRate: 128 });
    assert.equal(p.transcode, true);
    assert.equal(p.format, 'mp3');
    assert.equal(p.bitRate, 128);
  });

  test('a format with no ceiling picks a sane default, never unbounded', () => {
    const p = plan({ ...flac, format: 'mp3' });
    assert.equal(p.transcode, true);
    assert.equal(p.bitRate, 320);
  });

  test('each lossy target carries the right mime', () => {
    for (const [fmt, mime] of [
      ['mp3', 'audio/mpeg'],
      ['opus', 'audio/ogg'],
      ['aac', 'audio/aac'],
      ['ogg', 'audio/ogg'],
    ] as const) {
      const p = plan({ ...flac, format: fmt, maxBitRate: 128 });
      assert.equal(p.transcode, true, `${fmt} should transcode`);
      assert.equal(p.mime, mime, `${fmt} mime`);
    }
  });

  test('a lossless target ignores the bitrate ceiling', () => {
    // There is no bitrate knob on a lossless encoder; asking for one must not produce
    // an ffmpeg argument that means something else entirely.
    const p = plan({ ...mp3, format: 'flac', maxBitRate: 128 });
    assert.equal(p.transcode, true);
    assert.equal(p.bitRate, null);
  });

  test('a file with unknown duration still transcodes when asked', () => {
    // estimateBitrate returns null here, and null must not be read as "0 kbps".
    const p = plan({ ...flac, durationS: null, format: 'mp3' });
    assert.equal(p.transcode, true);
    assert.equal(p.bitRate, 320);
  });
});

describe('targets table', () => {
  test('aac muxes to adts, not mp4 — a pipe is not seekable', () => {
    assert.equal(TARGETS.aac!.container, 'adts');
  });

  test('every target names an encoder, a container and a mime', () => {
    for (const [name, t] of Object.entries(TARGETS)) {
      assert.ok(t.codec, `${name} needs a codec`);
      assert.ok(t.container, `${name} needs a container`);
      assert.ok(t.mime.startsWith('audio/'), `${name} mime`);
    }
  });
});
