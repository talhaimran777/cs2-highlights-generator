import type { CaptionLine, CaptionWord } from '../types.ts';

// whisper.cpp (without DTW) gives each word the time up to the next word's
// first token, so a word "ends" well after it's said and the next one starts
// late: the caption highlight trails the voice by 0.1-0.3 s. Snapping word
// boundaries to the pauses and dips in the voice audio fixes that.

export const FRAME_S = 0.01;
const MIN_WORD_S = 0.06;
const BACK_S = 0.35; // how far before Whisper's boundary the real one can be
const FWD_S = 0.1;
const MIN_GAP_FRAMES = 3; // a quiet run this long is a pause between words
const DIP_BACK_S = 0.2; // no pause: look for an energy dip this close instead
const DIP_FWD_S = 0.05;
const DIP_RATIO = 0.6; // the dip must be this much quieter than the window's median

/** RMS loudness per 10 ms frame. */
export function envelope(samples: Int16Array, rate: number): Float32Array {
  const n = Math.round(rate * FRAME_S);
  const out = new Float32Array(Math.floor(samples.length / n));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let k = f * n; k < (f + 1) * n; k++) s += samples[k] * samples[k];
    out[f] = Math.sqrt(s / n);
  }
  return out;
}

const percentile = (a: Float32Array, q: number) => {
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/**
 * Moves word boundaries onto the pauses (or loudness dips) in `env`, whose
 * first frame starts at `t0` seconds. The first word starts where the voice
 * does and the last ends where it stops. Words keep their order and text.
 */
export function alignWords(words: CaptionWord[], env: Float32Array, t0: number): CaptionWord[] {
  if (words.length === 0 || env.length < 10) return words;
  const floor = percentile(env, 0.1);
  const peak = percentile(env, 0.95);
  if (peak < floor * 2) return words; // no clear voice to align to
  const thr = floor + 0.15 * (peak - floor);
  const frame = (t: number) => Math.max(0, Math.min(env.length - 1, Math.round((t - t0) / FRAME_S)));
  const time = (f: number) => t0 + f * FRAME_S;
  const loud = (f: number) => env[f] > thr;
  const out = words.map((w) => ({ ...w }));

  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i];
    const b = out[i + 1];
    const at = b.start;
    const lo = frame(Math.max(a.start + MIN_WORD_S, at - BACK_S));
    const hi = frame(Math.min(b.end - MIN_WORD_S, at + FWD_S));
    if (hi <= lo) continue;
    // the longest quiet run is the pause between the two words
    let best: [number, number] | null = null;
    for (let f = lo; f <= hi; f++) {
      if (loud(f)) continue;
      let g = f;
      while (g + 1 <= hi && !loud(g + 1)) g++;
      if (g - f + 1 >= MIN_GAP_FRAMES && (!best || g - f > best[1] - best[0])) best = [f, g];
      f = g;
    }
    if (best) {
      // the pause can reach past the window: follow it to where the voice is
      let [s, e] = best;
      while (s - 1 > frame(a.start + MIN_WORD_S) && !loud(s - 1)) s--;
      while (e + 1 < frame(b.end - MIN_WORD_S) && !loud(e + 1)) e++;
      a.end = time(s);
      b.start = time(e + 1);
      continue;
    }
    // words run together: cut at the quietest frame near Whisper's boundary
    const dlo = frame(Math.max(a.start + MIN_WORD_S, at - DIP_BACK_S));
    const dhi = frame(Math.min(b.end - MIN_WORD_S, at + DIP_FWD_S));
    if (dhi <= dlo) continue;
    const win = env.subarray(dlo, dhi + 1);
    let m = dlo;
    for (let f = dlo; f <= dhi; f++) if (env[f] < env[m]) m = f;
    if (env[m] < DIP_RATIO * percentile(win, 0.5)) a.end = b.start = time(m);
  }

  // first word: starts with the voice, not in the silence before it
  const first = out[0];
  for (let f = frame(first.start), stop = frame(Math.min(first.start + 0.4, first.end - MIN_WORD_S)); f < stop && !loud(f); f++) {
    first.start = time(f + 1);
  }
  // last word: ends when the voice stops
  const last = out.at(-1)!;
  for (let f = frame(last.end) - 1, stop = frame(Math.max(last.end - 0.6, last.start + MIN_WORD_S)); f > stop && !loud(f); f--) {
    last.end = time(f);
  }
  return out;
}

/** The recording range a line's audio has to cover to align it. */
export const lineRange = (l: CaptionLine): [number, number] => [
  Math.min(l.start, l.words[0]?.start ?? l.start) - 0.2,
  Math.max(l.end, l.words.at(-1)?.end ?? l.end) + 0.2,
];
