// Clips mode: pick what to keep from each replay clip, using only what was
// read off the screen (no demo). A clip holds the last ~2 minutes, so it can
// start in the round before; the round that counts is the last one with my kills.

import type { Clip, ClipAnalysis, FeedEntry, HudSample, Moment, Settings, Source } from '../types.ts';

const MULTI_BONUS: Record<number, number> = { 2: 5, 3: 15, 4: 30, 5: 60 };
/** a timer jumping up by more than this is a new round (or freeze time ending) */
const TIMER_RESET_S = 20;
/** after a round ends the timer counts down the restart delay (~7 s); freeze time starts higher */
const POST_ROUND_MAX_S = 10;
/** how long after my death a piece may run on */
const AFTER_DEATH_S = 1;

/**
 * Source seconds where a new round begins: freeze time showing after the score
 * went up, or the round timer resetting. The score change itself is the old
 * round's end: the kill that ended it, and kills during the restart countdown
 * (timer at a few seconds), still belong to the old round.
 */
export function roundStartsFrom(hud: HudSample[]): number[] {
  const starts: number[] = [];
  let lastSum: number | null = null;
  let lastTimer: number | null = null;
  let roundOver = false;
  let prevT: number | null = null;
  for (const s of [...hud].sort((a, b) => a.t - b.t)) {
    const sum = s.left !== null && s.right !== null ? s.left + s.right : null;
    if (sum !== null && lastSum !== null && sum > lastSum) roundOver = true;
    if (s.timer !== null && prevT !== null) {
      const reset = lastTimer !== null && s.timer - lastTimer > TIMER_RESET_S;
      const freezeTime = roundOver && s.timer > POST_ROUND_MAX_S;
      if (freezeTime || reset) {
        starts.push((prevT + s.t) / 2);
        roundOver = false;
      }
    }
    if (sum !== null) lastSum = sum;
    if (s.timer !== null) lastTimer = s.timer;
    prevT = s.t;
  }
  return starts;
}

/** The kills of the last round that has any: [round start, kills, my death in it]. */
export function lastRoundKills(a: Pick<ClipAnalysis, 'entries' | 'roundStarts'>): { start: number; kills: FeedEntry[]; death: FeedEntry | null } | null {
  const kills = a.entries.filter((e) => e.kind === 'kill').sort((x, y) => x.t - y.t);
  if (kills.length === 0) return null;
  const last = kills.at(-1)!.t;
  const start = Math.max(0, ...a.roundStarts.filter((s) => s <= last));
  const end = Math.min(Infinity, ...a.roundStarts.filter((s) => s > last));
  return {
    start,
    kills: kills.filter((k) => k.t >= start),
    death: a.entries.filter((e) => e.kind === 'death' && e.t >= start && e.t < end).sort((x, y) => x.t - y.t)[0] ?? null,
  };
}

/** Kills closer together than `gap` seconds stay in one burst. */
export function bursts(kills: FeedEntry[], gap: number): FeedEntry[][] {
  const out: FeedEntry[][] = [];
  for (const k of kills) {
    const cur = out.at(-1);
    if (cur && k.t - cur.at(-1)!.t <= gap) cur.push(k);
    else out.push([k]);
  }
  return out;
}

const killLabel = (n: number) => (n === 1 ? '1 kill' : n === 5 ? 'ACE' : `${n}K`);

/**
 * One moment per burst of my kills in the clip's last round with kills. The
 * clip's number is used as the "round", so each clip gets its own title card.
 */
export function clipMoments(src: Source, index: number, settings: Pick<Settings, 'burstGap'>, readFeed = true): Moment[] {
  if (!readFeed) return [wholeClipMoment(src, index)];
  const round = src.analysis && lastRoundKills(src.analysis);
  if (!round) return [];
  // never before the round started; never long after I died
  const lo = src.offset + round.start;
  const hi = src.offset + Math.min(src.info.duration, round.death ? round.death.t + AFTER_DEATH_S : Infinity);
  return bursts(round.kills, settings.burstGap).map((b) => {
    const hs = b.filter((k) => k.headshot).length;
    const weapons = [...new Set(b.map((k) => k.weapon).filter(Boolean))];
    return {
      id: `${src.id}-${Math.round(b[0].t * 10)}`,
      round: index + 1,
      kind: 'kills',
      label: `${killLabel(b.length)}${hs ? ` (${hs} HS)` : ''}`,
      tags: [...(hs ? [`${hs} HS`] : []), ...weapons],
      score: 10 * b.length + (MULTI_BONUS[b.length] ?? 0) + 3 * hs,
      startTick: 0,
      endTick: 0,
      at: [src.offset + b[0].t, src.offset + b.at(-1)!.t],
      limits: [lo, hi],
      enabled: true,
      trimStart: 0,
      trimEnd: 0,
    };
  });
}

/**
 * A clip whose kill feed isn't read (any game, not only CS2): all of it, one
 * moment (cut it down with its trims or in the editor).
 */
export function wholeClipMoment(src: Source, index: number): Moment {
  const range: [number, number] = [src.offset, src.offset + src.info.duration];
  return {
    id: `${src.id}-clip`,
    round: index + 1,
    kind: 'clip',
    label: src.name,
    tags: [],
    score: 0,
    startTick: 0,
    endTick: 0,
    at: range,
    limits: range,
    enabled: true,
    trimStart: 0,
    trimEnd: 0,
  };
}

/**
 * Enabled moments -> timeline ranges with pre/post-roll, kept inside the
 * round (and their source clip). Bursts that end up touching merge.
 */
export function planSourceClips(moments: Moment[], sources: Source[], settings: Settings): Clip[] {
  const clips: Clip[] = [];
  const ranges = moments
    .filter((m) => m.enabled && m.at)
    .map((m) => {
      const [lo, hi] = m.limits ?? [-Infinity, Infinity];
      const src = sources[m.round - 1];
      const bounds: [number, number] = src ? [src.offset, src.offset + src.info.duration] : [lo, hi];
      return {
        round: m.round,
        start: Math.max(lo, bounds[0], m.at![0] - settings.preRoll + m.trimStart),
        end: Math.min(hi, bounds[1], m.at![1] + settings.postRoll + m.trimEnd),
        momentIds: [m.id],
        label: m.label,
        bounds,
      };
    })
    .filter((c) => c.end - c.start > 0.5)
    .sort((a, b) => a.start - b.start);
  for (const r of ranges) {
    const last = clips.at(-1);
    if (last && last.round === r.round && r.start - last.end <= settings.mergeGap) {
      last.end = Math.max(last.end, r.end);
      last.momentIds.push(...r.momentIds);
      last.label += ` + ${r.label}`;
    } else {
      clips.push({ ...r });
    }
  }
  return clips;
}

/** Title card for a clip: the round number and score when they could be read, else the clip number. */
export function clipCardText(src: Source, index: number, moments: Moment[]): { title: string; subtitle: string } {
  const mine = moments.filter((m) => m.round === index + 1);
  const kills = mine.reduce((n, m) => n + (Number(/^(\d)K/.exec(m.label)?.[1]) || (m.label.startsWith('ACE') ? 5 : 1)), 0);
  const subtitle = kills ? killLabel(kills) : '';
  const round = src.analysis && lastRoundKills(src.analysis);
  // the score shown during the round (before it ends)
  const s = src.analysis?.hud.find((h) => round && h.t >= round.start && h.left !== null && h.right !== null);
  if (!s) return { title: `Clip ${index + 1}`, subtitle };
  return { title: `Round ${s.left! + s.right! + 1}`, subtitle: `${s.left} – ${s.right}${subtitle ? ` · ${subtitle}` : ''}` };
}
