import type { SyncModel } from '../types.ts';

export interface Anchor {
  tick: number;
  round: number;
}

const TOLERANCE_S = 0.6; // kill-feed sampling is 4 fps, plus debounce slack
const MIN_ROUND_MATCHES = 2;
const MAX_PAUSE_JUMP_S = 15 * 60;

export function videoTime(model: SyncModel, tick: number, round: number): number {
  const offset = model.roundOffsets[round] ?? model.offset;
  return offset + model.scale * (tick / model.tickrate);
}

export function manualSync(tick: number, videoSec: number, tickrate: number): SyncModel {
  return {
    tickrate,
    offset: videoSec - tick / tickrate,
    scale: 1,
    roundOffsets: {},
    method: 'manual',
    inliers: 1,
    rmsError: 0,
    confident: true,
  };
}

/**
 * Fits demo anchors (my kills/deaths) to kill-feed detections in the video.
 * Global RANSAC over offset hypotheses (scale ~ 1), least-squares refine,
 * then per-round re-fit for rounds that don't agree with the global line,
 * which happens if the demo clock jumps around a pause.
 */
export function fitSync(anchors: Anchor[], detections: number[], tickrate: number, rounds: number[]): SyncModel {
  const a = anchors.map((x) => ({ t: x.tick / tickrate, round: x.round })).sort((p, q) => p.t - q.t);
  const v = [...detections].sort((p, q) => p - q);
  const empty: SyncModel = {
    tickrate, offset: 0, scale: 1, roundOffsets: {}, method: 'auto', inliers: 0, rmsError: Infinity, confident: false,
  };
  if (a.length === 0 || v.length === 0) return empty;

  const best = bestOffset(a.map((x) => x.t), v);
  if (!best) return empty;

  let pairs = matchPairs(a, v, (t) => best + t);
  let offset = best;
  let scale = 1;
  if (pairs.length >= 3) {
    ({ offset, scale } = leastSquares(pairs));
    // Clock drift between OBS and the demo is tiny; reject anything wild.
    if (Math.abs(scale - 1) > 0.01) {
      scale = 1;
      offset = median(pairs.map((p) => p.v - p.a));
    }
    pairs = matchPairs(a, v, (t) => offset + scale * t);
  }

  // Per-round: walk rounds in order; a round whose own anchors fit a different
  // offset starts a new segment that later rounds inherit.
  const roundOffsets: Record<number, number> = {};
  let current = offset;
  for (const r of rounds) {
    const ra = a.filter((x) => x.round === r);
    if (ra.length > 0) {
      const fitsCurrent = matchPairs(ra, v, (t) => current + scale * t).length;
      // A single anchor matches *some* detection at any offset, so a jump
      // needs at least two of the round's own anchors agreeing on it.
      if (fitsCurrent < Math.ceil(ra.length / 2) && ra.length >= MIN_ROUND_MATCHES) {
        const local = bestOffset(ra.map((x) => x.t * scale), v);
        if (local !== null) {
          const n = matchPairs(ra, v, (t) => local + scale * t).length;
          // In one continuous recording a pause the demo clock skipped can only
          // push the video later, by at most a pause's length.
          const jump = local - current;
          if (n >= MIN_ROUND_MATCHES && n > fitsCurrent && jump > 0.5 && jump <= MAX_PAUSE_JUMP_S) current = local;
        }
      } else {
        const rp = matchPairs(ra, v, (t) => current + scale * t);
        if (rp.length) current = median(rp.map((p) => p.v - scale * p.a));
      }
    }
    roundOffsets[r] = current;
  }

  const all = rounds.flatMap((r) =>
    matchPairs(a.filter((x) => x.round === r), v, (t) => roundOffsets[r] + scale * t).map((p) => ({
      ...p,
      err: p.v - (roundOffsets[r] + scale * p.a),
    })),
  );
  const rms = all.length ? Math.sqrt(all.reduce((s, p) => s + p.err ** 2, 0) / all.length) : Infinity;

  return {
    tickrate,
    offset,
    scale,
    roundOffsets,
    method: 'auto',
    inliers: all.length,
    rmsError: rms,
    confident: all.length >= 3 && rms < 0.5 && all.length / a.length >= 0.4,
  };
}

/** Offset hypothesis (v - a for every pair) that explains the most anchors. */
function bestOffset(a: number[], v: number[]): number | null {
  let bestOff: number | null = null;
  let bestCount = 0;
  let bestErr = Infinity;
  for (const ai of a) {
    for (const vj of v) {
      const off = vj - ai;
      let count = 0;
      let err = 0;
      for (const ak of a) {
        const d = nearestDist(v, ak + off);
        if (d < TOLERANCE_S) {
          count++;
          err += d;
        }
      }
      if (count > bestCount || (count === bestCount && err < bestErr)) {
        bestOff = off;
        bestCount = count;
        bestErr = err;
      }
    }
  }
  return bestCount >= 1 ? bestOff : null;
}

/** One-to-one nearest matches within tolerance. */
function matchPairs(a: { t: number }[], v: number[], map: (t: number) => number) {
  const used = new Set<number>();
  const pairs: { a: number; v: number }[] = [];
  for (const x of a) {
    const target = map(x.t);
    const j = nearestIndex(v, target);
    if (j >= 0 && !used.has(j) && Math.abs(v[j] - target) < TOLERANCE_S) {
      used.add(j);
      pairs.push({ a: x.t, v: v[j] });
    }
  }
  return pairs;
}

function leastSquares(pairs: { a: number; v: number }[]) {
  const n = pairs.length;
  const ma = pairs.reduce((s, p) => s + p.a, 0) / n;
  const mv = pairs.reduce((s, p) => s + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pairs) {
    num += (p.a - ma) * (p.v - mv);
    den += (p.a - ma) ** 2;
  }
  const scale = den > 0 ? num / den : 1;
  return { scale, offset: mv - scale * ma };
}

function nearestIndex(sorted: number[], x: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - x) <= Math.abs(sorted[lo] - x)) return lo - 1;
  return lo;
}

const nearestDist = (sorted: number[], x: number) => Math.abs(sorted[nearestIndex(sorted, x)] - x);

export function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
