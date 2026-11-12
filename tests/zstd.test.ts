import { describe, expect, it } from 'vitest';
import { zstdDecompress } from '../server/demo/parse.ts';

/** A zstd frame of raw (stored) blocks: valid zstd without needing an encoder. */
function rawFrame(data: Uint8Array): Uint8Array {
  const BLOCK = 128 * 1024;
  // magic, then a single-segment frame with a 4-byte content size
  const head = [0x28, 0xb5, 0x2f, 0xfd, 0xa0, ...[0, 8, 16, 24].map((s) => (data.length >>> s) & 0xff)];
  const parts: Uint8Array[] = [Uint8Array.from(head)];
  for (let at = 0; at < data.length; at += BLOCK) {
    const size = Math.min(BLOCK, data.length - at);
    const last = at + size >= data.length ? 1 : 0;
    const h = (size << 3) | last; // block type 0: raw
    parts.push(Uint8Array.from([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]), data.subarray(at, at + size));
  }
  return Buffer.concat(parts);
}

describe('zstd demos', () => {
  it('decodes a demo spread over many read chunks, byte for byte', () => {
    const data = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 31 + (i >> 9)) & 0xff);
    const out = zstdDecompress(rawFrame(data));
    expect(out.length).toBe(data.length);
    expect(out.equals(Buffer.from(data))).toBe(true);
  });
});
