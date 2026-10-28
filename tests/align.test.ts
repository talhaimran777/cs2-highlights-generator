import { describe, expect, it } from 'vitest';
import { alignWords, FRAME_S } from '../server/captions/align.ts';
import { retime } from '../server/captions/cleanup.ts';

/** A loudness envelope: voice (1000) in the given ranges, quiet (20) elsewhere. */
function env(seconds: number, voice: [number, number][]) {
  const e = new Float32Array(Math.round(seconds / FRAME_S));
  for (let f = 0; f < e.length; f++) {
    const t = f * FRAME_S;
    e[f] = voice.some(([a, b]) => t >= a && t < b) ? 1000 : 20;
  }
  return e;
}

describe('word alignment', () => {
  it('moves a late boundary back onto the pause between two words', () => {
    // said: 0.5-1.0 and 1.2-1.6; Whisper ran the first word on to 1.4
    const out = alignWords(
      [
        { start: 0.5, end: 1.4, text: 'so' },
        { start: 1.4, end: 1.8, text: 'yeah' },
      ],
      env(2, [[0.5, 1.0], [1.2, 1.6]]),
      0,
    );
    expect(out[0].end).toBeCloseTo(1.0, 1);
    expect(out[1].start).toBeCloseTo(1.2, 1);
    expect(out[1].end).toBeCloseTo(1.6, 1);
  });

  it('starts the first word with the voice and cuts at a loudness dip', () => {
    const e = env(2, [[0.3, 1.5]]);
    e[Math.round(0.9 / FRAME_S)] = 100; // a dip between the two words, no pause
    const out = alignWords(
      [
        { start: 0.1, end: 1.0, text: 'kya' },
        { start: 1.0, end: 1.5, text: 'hua' },
      ],
      e,
      0,
    );
    expect(out[0].start).toBeCloseTo(0.3, 1);
    expect(out[0].end).toBeCloseTo(0.9, 2);
    expect(out[1].start).toBeCloseTo(0.9, 2);
  });

  it('leaves the words alone when there is no clear voice', () => {
    const words = [{ start: 0.2, end: 0.8, text: 'hm' }];
    expect(alignWords(words, new Float32Array(100).fill(50), 0)).toEqual(words);
  });

  it('keeps the words in order and never shorter than a frame or two', () => {
    const out = alignWords(
      [
        { start: 0, end: 0.1, text: 'a' },
        { start: 0.1, end: 0.2, text: 'b' },
        { start: 0.2, end: 1, text: 'c' },
      ],
      env(1, [[0.5, 0.9]]),
      0,
    );
    for (const w of out) expect(w.end).toBeGreaterThan(w.start);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end - 1e-9);
  });
});

describe('retiming rewritten words', () => {
  it('keeps the pause between the old words', () => {
    const old = [
      { start: 1, end: 1.5, text: 'karraha' },
      { start: 2.5, end: 3, text: 'hoon' },
    ];
    const out = retime(old, ['kar', 'raha', 'hoon'], { start: 1, end: 3 });
    expect(out.map((w) => w.text)).toEqual(['kar', 'raha', 'hoon']);
    expect(out[1].end).toBeLessThanOrEqual(1.5 + 0.1);
    expect(out[2].start).toBeGreaterThanOrEqual(2.5 - 0.1);
    expect(out.at(-1)!.end).toBeCloseTo(3);
  });
});
