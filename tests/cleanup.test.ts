import { describe, expect, it } from 'vitest';
import { retime, spreadWords } from '../server/captions/cleanup.ts';

const words = [
  { start: 1, end: 1.4, text: 'wo' },
  { start: 1.4, end: 1.9, text: 'chek' },
  { start: 1.9, end: 2.3, text: 'karo' },
];

describe('caption cleanup timing', () => {
  it('keeps each word slot when the word count is unchanged', () => {
    expect(retime(words, ['wo', 'check', 'karo'], { start: 1, end: 2.3 })).toEqual([
      { start: 1, end: 1.4, text: 'wo' },
      { start: 1.4, end: 1.9, text: 'check' },
      { start: 1.9, end: 2.3, text: 'karo' },
    ]);
  });

  it('spreads a different number of words over the same span', () => {
    const out = retime(words, ['unhon', 'ne', 'check', 'kiya'], { start: 1, end: 2.3 });
    expect(out).toHaveLength(4);
    expect(out[0].start).toBe(1);
    expect(out.at(-1)!.end).toBeCloseTo(2.3);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end);
  });

  it('gives longer words more time', () => {
    const [a, b] = spreadWords(['ab', 'abcdef'], 0, 1);
    expect(b.end - b.start).toBeGreaterThan(a.end - a.start);
  });
});
