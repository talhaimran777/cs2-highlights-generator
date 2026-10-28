// Editor cuts. No server-only imports: the web editor uses this too.
import type { Clip, Edits } from '../types.ts';

const MIN_PIECE_S = 0.1;

/**
 * Removes the editor's cuts from the clips. A cut inside a clip splits it in
 * two; pieces keep the clip's round, moments and label. Cuts are in recording
 * time, so ones that no longer touch any clip simply do nothing.
 */
export function applyEdits(clips: Clip[], edits: Edits | null | undefined): Clip[] {
  const cuts = normalizeCuts(edits?.cuts ?? []);
  if (cuts.length === 0) return clips;
  return clips.flatMap((c) => {
    const pieces: Clip[] = [];
    let from = c.start;
    for (const [a, b] of cuts) {
      if (b <= from || a >= c.end) continue;
      if (a > from) pieces.push({ ...c, momentIds: [...c.momentIds], start: from, end: a });
      from = Math.max(from, b);
    }
    if (from < c.end) pieces.push({ ...c, momentIds: [...c.momentIds], start: from, end: c.end });
    const kept = pieces.filter((x) => x.end - x.start >= MIN_PIECE_S);
    // the speech hold only applies to the clip's outer edges
    return kept.map((x, i) =>
      x.speech
        ? { ...x, speech: { start: i === 0 && x.start === c.start ? x.speech.start : 0, end: i === kept.length - 1 && x.end === c.end ? x.speech.end : 0 } }
        : x,
    );
  });
}

/** Sorted, non-overlapping cuts with start < end. */
export function normalizeCuts(cuts: [number, number][]): [number, number][] {
  const sorted = cuts
    .map(([a, b]): [number, number] => [Math.min(a, b), Math.max(a, b)])
    .filter(([a, b]) => b - a > 0.001)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const c of sorted) {
    const last = out.at(-1);
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else out.push([...c]);
  }
  return out;
}
