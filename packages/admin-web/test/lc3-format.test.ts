import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLc3Header } from '../src/lc3-format.js';

function header(values: { sampleRate?: number; bitrate?: number; channels?: number; frameUs?: number; samples?: number; epmode?: number; headerSize?: number } = {}): Uint8Array {
  const sampleRate = values.sampleRate ?? 16000;
  const bitrate = values.bitrate ?? 16000;
  const channels = values.channels ?? 1;
  const frameUs = values.frameUs ?? 10000;
  const samples = values.samples ?? 320;
  const headerSize = values.headerSize ?? 18;
  const bytes = new Uint8Array(headerSize);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xCC1C, true);
  view.setUint16(2, headerSize, true);
  view.setUint16(4, sampleRate / 100, true);
  view.setUint16(6, bitrate / 100, true);
  view.setUint16(8, channels, true);
  view.setUint16(10, frameUs / 10, true);
  view.setUint16(12, values.epmode ?? 0, true);
  view.setUint16(14, samples & 0xFFFF, true);
  view.setUint16(16, samples >>> 16, true);
  return bytes;
}

test('parses the Voicecan LC3 header and derives streaming frame geometry', () => {
  const parsed = parseLc3Header(header(), 18 + 2 * (2 + 20));
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.frameDurationUs, 10000);
  assert.equal(parsed.frameSamples, 160);
  assert.equal(parsed.blockBytes, 20);
  assert.equal(parsed.frameBytes, 20);
  assert.equal(parsed.frameCount, 2);
  assert.equal(parsed.durationSeconds, 0.02);
  assert.equal(parsed.dataOffset, 18);
});

test('keeps stereo channel frames separate and rejects reserved encodings', () => {
  const parsed = parseLc3Header(header({ bitrate: 32000, channels: 2, samples: 480 }), 18 + 3 * (2 + 40));
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.blockBytes, 40);
  assert.equal(parsed.frameBytes, 20);
  assert.equal(parsed.frameCount, 3);
  assert.throws(() => parseLc3Header(header({ epmode: 1 }), 100), /epmode/);
  assert.throws(() => parseLc3Header(header({ channels: 3 }), 100), /mono and stereo/);
});
