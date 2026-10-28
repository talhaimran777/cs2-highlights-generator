import { describe, expect, it } from 'vitest';
import { CHUNK_GAP_S, chunkSlots, cutWords, planChunks, splitWords } from '../server/captions/chunks.ts';
import { soundKey } from '../server/captions/merge.ts';

describe('transcription chunks', () => {
  it('joins short utterances up to the chunk length', () => {
    const ranges: [number, number][] = Array.from({ length: 30 }, (_, i) => [i * 3, i * 3 + 1]);
    const chunks = planChunks(ranges);
    expect(chunks.flat()).toEqual(ranges.map((_, i) => i));
    for (const c of chunks) {
      const len = c.reduce((n, i) => n + ranges[i][1] - ranges[i][0], 0) + (c.length - 1) * CHUNK_GAP_S;
      expect(len).toBeLessThanOrEqual(28);
    }
    expect(chunks[0].length).toBeGreaterThanOrEqual(10);
  });

  it('starts a new chunk after a long silence', () => {
    expect(planChunks([[0, 1], [2, 3], [200, 201]])).toEqual([[0, 1], [2]]);
  });

  it('keeps a long utterance whole in its own chunk', () => {
    expect(planChunks([[0, 1], [2, 40], [41, 42]])).toEqual([[0], [1], [2]]);
  });

  it('splits words back per utterance, relative to each one', () => {
    const slots = chunkSlots([1, 2]); // utterance 2 starts after the gap
    expect(slots).toEqual([{ offset: 0, dur: 1 }, { offset: 1 + CHUNK_GAP_S, dur: 2 }]);
    const o = 1 + CHUNK_GAP_S - 1.5; // the words below were written for a 0.5 s gap
    const out = splitWords(
      [
        { start: 0.1, end: 0.6, text: 'bhai' },
        { start: 0.6, end: 1.2, text: 'yaar' }, // runs into the gap: still the first utterance's
        { start: 1.2, end: 2.2 + o, text: 'push' }, // starts in the gap, ends in the second
        { start: 2.2 + o, end: 3.9 + o, text: 'karo' },
      ],
      slots,
    );
    expect(out[0].map((w) => w.text)).toEqual(['bhai', 'yaar']);
    expect(out[0][1].end).toBe(1);
    expect(out[1].map((w) => w.text)).toEqual(['push', 'karo']);
    expect(out[1][0].start).toBe(0); // the part in the gap is cut off
    expect(out[1][1].end).toBeCloseTo(2);
  });

  it('moves a line break to match what each utterance sounded like alone', () => {
    const slots = chunkSlots([2, 2]);
    // Whisper timed the second utterance's first word ('hamein') inside the first one
    const t = (start: number, end: number, text: string) => ({ start, end, text });
    const words = [t(0.2, 0.8, 'jeette'), t(0.8, 1.5, 'rahein'), t(1.5, 1.9, 'hamein'), t(1 + CHUNK_GAP_S, 4, 'koi'), t(4, 4.5, 'chahiye')];
    const alone = [['jeete', 'rahe'], ['hamen', 'koi', 'chahie']];
    expect(cutWords(words, slots, alone, soundKey)).toEqual([0, 2, 5]);
  });
});