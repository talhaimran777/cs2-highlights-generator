// Whisper guesses badly on a 1-second callout heard on its own: most game
// speech is that short. So utterances are joined back to back (with a short
// silence between them) into chunks of up to ~28 s, which gives Whisper the
// conversation as context, and the words are split back per utterance after.

export const CHUNK_MAX_S = 28; // Whisper works on 30 s windows
export const CHUNK_GAP_S = 1; // silence between two utterances in a chunk: room for Whisper's timing to be off
const MAX_JUMP_S = 60; // utterances further apart than this aren't one conversation

/** Groups consecutive utterances (recording ranges, in order) into chunks; returns their indices. */
export function planChunks(ranges: [number, number][], maxS = CHUNK_MAX_S): number[][] {
  const chunks: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  ranges.forEach(([from, to], i) => {
    const d = to - from;
    const prev = cur.at(-1);
    if (prev !== undefined && (len + CHUNK_GAP_S + d > maxS || from - ranges[prev][1] > MAX_JUMP_S)) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    len += (cur.length ? CHUNK_GAP_S : 0) + d;
    cur.push(i);
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Where each utterance sits in its chunk's audio: start offset and length, in seconds. */
export function chunkSlots(durations: number[]): { offset: number; dur: number }[] {
  let t = 0;
  return durations.map((dur, i) => {
    if (i) t += CHUNK_GAP_S;
    const slot = { offset: t, dur };
    t += dur;
    return slot;
  });
}

/**
 * Splits a chunk's words (chunk seconds) back per utterance, with times made
 * relative to the utterance's own audio. Whisper stretches a word's start back
 * over the silence before it, but its end is close to right: a word goes to the
 * utterance its end is in (or nearest to).
 */
export function splitWords<W extends { start: number; end: number }>(words: W[], slots: { offset: number; dur: number }[]): W[][] {
  const out: W[][] = slots.map(() => []);
  for (const w of words) {
    const mid = Math.max(w.start, w.end - 0.1);
    let best = 0;
    let bestDist = Infinity;
    slots.forEach((s, i) => {
      const dist = mid < s.offset ? s.offset - mid : mid > s.offset + s.dur ? mid - s.offset - s.dur : 0;
      if (dist < bestDist) [best, bestDist] = [i, dist];
    });
    const s = slots[best];
    const start = Math.min(Math.max(w.start - s.offset, 0), s.dur);
    const end = Math.min(Math.max(w.end - s.offset, start), s.dur);
    out[best].push({ ...w, start, end });
  }
  return out;
}

const SHIFT = 3; // how many words a line break can move to match the lone pass

/** Longest common subsequence length of two strings. */
function lcs(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Where a chunk's words break into its utterances: word indices, one more than
 * there are utterances. Whisper's timing in a joined chunk can put the first
 * word or two of an utterance at the end of the one before, so each break
 * starts where the timing says and then moves up to a few words to best match
 * what Whisper heard in each utterance on its own (`alone`, by sound).
 */
export function cutWords(
  words: { start: number; end: number; text: string }[],
  slots: { offset: number; dur: number }[],
  alone: string[][],
  key: (word: string) => string,
): number[] {
  const n = words.length;
  const k = slots.length;
  const byTime = splitWords(
    words.map((w, i) => ({ ...w, i })),
    slots,
  );
  const cuts = [0];
  for (let s = 0; s + 1 < k; s++) cuts.push(Math.max(cuts[s], (byTime[s].at(-1)?.i ?? cuts[s] - 1) + 1));
  cuts.push(n);
  for (let s = 1; s < k; s++) cuts[s] = Math.min(Math.max(cuts[s], cuts[s - 1]), n);

  const sound = (from: number, to: number) => words.slice(from, to).map((w) => key(w.text)).join('');
  const heard = alone.map((ws) => ws.map(key).join(''));
  for (let s = 1; s < k; s++) {
    let best = cuts[s];
    let bestScore = -Infinity;
    for (let c = Math.max(cuts[s - 1], cuts[s] - SHIFT); c <= Math.min(cuts[s + 1], cuts[s] + SHIFT); c++) {
      // ties stay with the timing
      const score = lcs(sound(cuts[s - 1], c), heard[s - 1]) + lcs(sound(c, cuts[s + 1]), heard[s]) - 0.1 * Math.abs(c - cuts[s]);
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    cuts[s] = best;
  }
  return cuts;
}
