import { describe, expect, it } from 'vitest';
import { applyEdits, normalizeCuts, subtractRange } from '../server/edit/edits.ts';
import type { Clip } from '../server/types.ts';

const clip = (round: number, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({
  round, start, end, momentIds: [`m${round}`], label: `R${round}`, ...extra,
});
const ranges = (clips: Clip[]) => clips.map((c) => [c.start, c.end]);

describe('added footage', () => {
  it('extends the clip it touches, before cuts are applied', () => {
    const out = applyEdits([clip(1, 10, 20)], { cuts: [[6, 7]], splits: [], adds: [[5, 10], [20, 22]] });
    expect(ranges(out)).toEqual([[5, 6], [7, 22]]);
  });

  it('never grows into the neighbouring clip, and ignores adds touching no clip', () => {
    const out = applyEdits([clip(1, 10, 20), clip(2, 25, 30)], { cuts: [], splits: [], adds: [[18, 28], [40, 50]] });
    expect(ranges(out)).toEqual([[10, 25], [25, 30]]);
  });

  it('subtractRange takes a range out of cuts', () => {
    expect(subtractRange([[0, 5], [10, 20]], [3, 12])).toEqual([[0, 3], [12, 20]]);
    expect(subtractRange([[10, 20]], [5, 25])).toEqual([]);
  });
});

describe('applyEdits', () => {
  it('leaves clips alone without cuts', () => {
    const clips = [clip(1, 10, 20)];
    expect(applyEdits(clips, undefined)).toBe(clips);
    expect(applyEdits(clips, { cuts: [], splits: [5] })).toBe(clips);
  });

  it('splits a clip around a cut in the middle', () => {
    const out = applyEdits([clip(1, 10, 20)], { cuts: [[12, 15]], splits: [] });
    expect(ranges(out)).toEqual([[10, 12], [15, 20]]);
    expect(out.every((c) => c.round === 1 && c.momentIds[0] === 'm1')).toBe(true);
  });

  it('trims the edges of clips a cut overlaps', () => {
    const out = applyEdits([clip(1, 10, 20), clip(2, 30, 40)], { cuts: [[18, 33]], splits: [] });
    expect(ranges(out)).toEqual([[10, 18], [33, 40]]);
  });

  it('drops a clip that is cut whole, and ignores cuts outside every clip', () => {
    const out = applyEdits([clip(1, 10, 20), clip(2, 30, 40)], { cuts: [[9, 21], [50, 60]], splits: [] });
    expect(ranges(out)).toEqual([[30, 40]]);
  });

  it('drops leftover slivers', () => {
    const out = applyEdits([clip(1, 10, 20)], { cuts: [[10.05, 19.95]], splits: [] });
    expect(out).toEqual([]);
  });

  it('keeps the speech hold only on the outer edges', () => {
    const out = applyEdits([clip(1, 10, 20, { speech: { start: 1, end: 2 } })], { cuts: [[14, 16]], splits: [] });
    expect(out.map((c) => c.speech)).toEqual([{ start: 1, end: 0 }, { start: 0, end: 2 }]);
  });

  it('still applies after the clips are re-planned longer', () => {
    const edits = { cuts: [[14, 16]] as [number, number][], splits: [] };
    expect(ranges(applyEdits([clip(1, 12, 20)], edits))).toEqual([[12, 14], [16, 20]]);
    expect(ranges(applyEdits([clip(1, 8, 22)], edits))).toEqual([[8, 14], [16, 22]]);
  });
});

describe('normalizeCuts', () => {
  it('sorts, orients and merges overlapping cuts', () => {
    expect(normalizeCuts([[20, 15], [1, 3], [2, 5], [16, 18], [7, 7]])).toEqual([[1, 5], [15, 20]]);
  });
});
