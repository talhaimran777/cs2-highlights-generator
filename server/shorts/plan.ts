// Shorts: one round cut down to its fights. Each kill keeps the fight leading
// into it; walking, rotating and holding between fights is left out. Tighter
// than the reel, which keeps kills up to `burstGap` / CHAIN_GAP_S apart together.

import { videoTime } from '../sync/align.ts';
import { contactStart, isTeamkill } from '../demo/moments.ts';
import { lastRoundKills } from '../clips/moments.ts';
import type { Clip, FeedKill, Kill, MatchData, Source, SyncModel } from '../types.ts';

/** kills (with their run-up) closer than this stay in one piece */
export const SHORT_GAP_S = 4;
/** before a kill's fight starts; the kill feed is read late in clips mode, so it needs more */
export const SHORT_PRE_S = { match: 2, clips: 4 };
export const SHORT_POST_S = 1.5;
/** after the last kill, so the clutch or ace reaction plays out */
const SHORT_TAIL_S = 1;
/** a round ending: the win banner shows for a few seconds */
const ROUND_END_S = 3;
/** a short needs this many kills in the round */
export const SHORT_MIN_KILLS = 3;

/** One kill on the timeline: where its fight starts and when it lands (timeline seconds). */
export interface KillMark {
  from: number;
  at: number;
}

const MULTI: Record<number, string> = { 1: 'Kill', 2: '2K', 3: '3K', 4: '4K', 5: 'ACE' };

/**
 * A round's kills -> pieces: [fight start - pre, kill + post], joined when
 * less than SHORT_GAP_S apart, kept inside the round. Every piece carries the
 * round's range as `bounds`, so the editor can bring cut footage back up to it.
 */
export function cutRound(kills: KillMark[], round: number, bounds: [number, number], pre: number): Clip[] {
  const sorted = [...kills].sort((a, b) => a.at - b.at);
  const pieces: (Clip & { kills: number })[] = [];
  sorted.forEach((k, i) => {
    const start = Math.max(bounds[0], Math.min(k.from, k.at) - pre);
    const end = Math.min(bounds[1], k.at + SHORT_POST_S + (i === sorted.length - 1 ? SHORT_TAIL_S : 0));
    const last = pieces.at(-1);
    if (last && start - last.end < SHORT_GAP_S) {
      last.end = Math.max(last.end, end);
      last.kills++;
    } else {
      pieces.push({ round, start, end, momentIds: [], label: '', bounds, kills: 1 });
    }
  });
  return pieces
    .filter((c) => c.end - c.start > 0.5)
    .map(({ kills: n, ...c }) => ({ ...c, label: MULTI[Math.min(n, 5)] }));
}

/** My kills in a demo round (no teamkills, no suicides). */
export const myRoundKills = (match: MatchData, me: string, round: number): Kill[] =>
  match.kills.filter((k) => k.round === round && k.attacker === me && k.victim !== me && !isTeamkill(k));

/** Demo mode: a round's pieces, from the demo's kill ticks through the sync. */
export function matchShortClips(match: MatchData, me: string, sync: SyncModel, round: number, videoDuration: number): Clip[] {
  const r = match.rounds.find((x) => x.num === round);
  if (!r) return [];
  const t = (tick: number) => videoTime(sync, tick, round);
  const bounds: [number, number] = [Math.max(0, t(r.startTick)), Math.min(videoDuration, t(r.endTick) + ROUND_END_S)];
  const marks = myRoundKills(match, me, round).map((k) => ({ from: t(contactStart(match, me, k.tick)), at: t(k.tick) }));
  return cutRound(marks, round, bounds, SHORT_PRE_S.match);
}

/** Clips mode: a clip's pieces, from the kills read off its kill feed. `round` is the clip's number. */
export function sourceShortClips(src: Source, round: number): Clip[] {
  const r = src.analysis && lastRoundKills(src.analysis);
  if (!r) return [];
  // never before the round started; never long after I died (as clipMoments)
  const bounds: [number, number] = [src.offset + r.start, src.offset + Math.min(src.info.duration, r.death ? r.death.t + 1 : Infinity)];
  const marks = r.kills.map((k) => ({ from: src.offset + k.t, at: src.offset + k.t }));
  return cutRound(marks, round, bounds, SHORT_PRE_S.clips);
}

/** a kill-feed entry is read about this long after it appears (see clips/analyze.ts SETTLE_S) */
const FEED_READ_LAG_S = 0.5;

/** Demo mode: my kills in the round, for the short's kill feed. */
export function matchShortKills(match: MatchData, me: string, sync: SyncModel, round: number): FeedKill[] {
  return myRoundKills(match, me, round).map((k) => ({
    at: videoTime(sync, k.tick, round),
    attacker: k.attackerName,
    victim: k.victimName,
    weapon: k.weapon,
    headshot: k.headshot,
    wallbang: k.wallbang,
    noscope: k.noscope,
    throughSmoke: k.throughSmoke,
    attackerSide: k.attackerSide,
    victimSide: k.victimSide,
  }));
}

/** Clips mode: my kills in the clip's last round, as read off its kill feed. */
export function sourceShortKills(src: Source): FeedKill[] {
  const r = src.analysis && lastRoundKills(src.analysis);
  if (!r) return [];
  return r.kills.map((k) => ({
    at: src.offset + Math.max(0, k.t - FEED_READ_LAG_S),
    attacker: k.attacker,
    victim: k.victim,
    weapon: k.weapon,
    headshot: k.headshot,
  }));
}

/** Rounds with enough kills for a short: game rounds (demo), or clip numbers (clips mode). */
export function matchShortRounds(match: MatchData, me: string): number[] {
  return match.rounds.filter((r) => myRoundKills(match, me, r.num).length >= SHORT_MIN_KILLS).map((r) => r.num);
}

export function sourceShortRounds(sources: Source[]): number[] {
  return sources.flatMap((s, i) => ((s.analysis && lastRoundKills(s.analysis)?.kills.length) ?? 0) >= SHORT_MIN_KILLS ? [i + 1] : []);
}

/** the seam is never closer than this to a piece's edge, so both sides of it have some footage */
const SEAM_ROOM_S = 0.3;

/**
 * A looping short's order: cut `lead` seconds before the final kill (inside
 * its piece, where the recording runs on) and the part from there to the end
 * moved to the front. It opens on the payoff; its end is the footage right
 * before the opening, so a replay runs on with no seam. The two edges at the
 * cut are marked `seamless` (no sound fade there). Null when there's no kill
 * left in the pieces to cut before.
 */
export function loopOrder(clips: Clip[], kills: FeedKill[], lead: number): Clip[] | null {
  const last = [...kills]
    .sort((a, b) => b.at - a.at)
    .map((k) => ({ k, i: clips.findIndex((c) => k.at > c.start && k.at <= c.end) }))
    .find((x) => x.i >= 0);
  if (!last) return null;
  const piece = clips[last.i];
  const cut = Math.max(piece.start + SEAM_ROOM_S, last.k.at - lead);
  if (cut > piece.end - SEAM_ROOM_S) return null;
  const before: Clip = { ...piece, momentIds: [...piece.momentIds], end: cut, seamless: 'end' };
  const after: Clip = { ...piece, momentIds: [...piece.momentIds], start: cut, seamless: 'start' };
  return [after, ...clips.slice(last.i + 1), ...clips.slice(0, last.i), before];
}
