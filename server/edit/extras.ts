// Extras that make a match reel easier to follow and harder to click away
// from: a cold open, replays of the big rounds, halftime cards, a score
// graphic and the final scoreboard. Everything comes from the demo.

import { videoTime } from '../sync/align.ts';
import type { Clip, Kill, MatchData, Moment, SyncModel } from '../types.ts';

/** cold open: this many of the best rounds, each at most PIECE_MAX_S */
const COLD_OPEN_ROUNDS = 2;
const COLD_OPEN_PIECE_MAX_S = 7;
const REPLAY_MAX_S = 6;
/** seconds shown before the first and after the last of the decisive kills */
const LEAD_S = 2;
const REPLAY_LEAD_S = 1.5;
const TAIL_S = 1;
/** my kills in a round that earn a replay (a won clutch always does) */
const REPLAY_KILLS = 4;

const isTeamkill = (k: Kill) => !!k.attacker && k.attacker !== k.victim && !!k.attackerSide && k.attackerSide === k.victimSide;
const myKills = (match: MatchData, me: string, round?: number) =>
  match.kills
    .filter((k) => (round === undefined || k.round === round) && k.attacker === me && k.victim !== me && !isTeamkill(k))
    .sort((a, b) => a.tick - b.tick);

/** The reel's decisive kills of a round as a timeline piece: the last two of my kills, with a little lead-in. */
function decisivePiece(match: MatchData, me: string, round: number, sync: SyncModel, lead: number, maxS: number, label: string): Clip | null {
  const kills = myKills(match, me, round);
  if (kills.length === 0) return null;
  const last = kills.at(-1)!;
  const first = kills.at(-2) ?? last;
  const end = videoTime(sync, last.tick, round) + TAIL_S;
  const start = Math.max(0, end - maxS, videoTime(sync, first.tick, round) - lead);
  return { round, start, end, momentIds: [], label };
}

/** Best (enabled) clutch / kills moment per round, best first. */
function bestRounds(moments: Moment[]): Moment[] {
  const best = new Map<number, Moment>();
  for (const m of moments) {
    if (!m.enabled || (m.kind !== 'clutch' && m.kind !== 'kills')) continue;
    if ((best.get(m.round)?.score ?? -1) < m.score) best.set(m.round, m);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * The cold open: the decisive kills of the two best rounds, best first,
 * about 15 s in all. The last round is never used, so the result isn't spoiled.
 */
export function coldOpenPieces(moments: Moment[], match: MatchData, me: string, sync: SyncModel): Clip[] {
  const lastRound = match.rounds.at(-1)?.num;
  return bestRounds(moments)
    .filter((m) => m.round !== lastRound)
    .slice(0, COLD_OPEN_ROUNDS)
    .flatMap((m) => decisivePiece(match, me, m.round, sync, LEAD_S, COLD_OPEN_PIECE_MAX_S, `Cold open · ${m.label}`) ?? []);
}

/** Rounds that earn a replay after them (a won clutch, or 4+ of my kills) -> the replayed piece. */
export function replays(moments: Moment[], match: MatchData, me: string, sync: SyncModel): Map<number, Clip> {
  const out = new Map<number, Clip>();
  for (const m of bestRounds(moments)) {
    const big = moments.some((x) => x.round === m.round && x.kind === 'clutch') || myKills(match, me, m.round).length >= REPLAY_KILLS;
    if (!big) continue;
    const piece = decisivePiece(match, me, m.round, sync, REPLAY_LEAD_S, REPLAY_MAX_S, `Replay · ${m.label}`);
    if (piece) out.set(m.round, piece);
  }
  return out;
}

/** Rounds where my side changes: halftime first, overtime halves after. */
export function sideSwitches(match: MatchData, me: string): { round: number; title: string; subtitle: string }[] {
  const out: { round: number; title: string; subtitle: string }[] = [];
  let side: string | undefined;
  for (const r of match.rounds) {
    const now = r.roster[me];
    if (!now) continue;
    if (side && now !== side) out.push({ round: r.num, title: out.length === 0 ? 'HALF TIME' : 'OVERTIME', subtitle: 'SWITCHING SIDES' });
    side = now;
  }
  return out;
}

/**
 * A switch's card goes before the first round in the reel at or after it (the
 * switch round itself may have nothing worth keeping). Round number -> card.
 */
export function breakCards(switches: ReturnType<typeof sideSwitches>, reelRounds: number[]): Map<number, { title: string; subtitle: string }> {
  const rounds = [...new Set(reelRounds)].sort((a, b) => a - b);
  const out = new Map<number, { title: string; subtitle: string }>();
  for (const s of switches) {
    const at = rounds.find((r) => r >= s.round);
    if (at !== undefined && !out.has(at)) out.set(at, { title: s.title, subtitle: s.subtitle });
  }
  return out;
}

export const mapName = (map: string) => map.replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ').toUpperCase();

/** The score graphic during a round: map, round number and the score going into it. */
export function overlayText(match: MatchData, round: number): string {
  const i = match.rounds.findIndex((r) => r.num === round);
  const before = i > 0 ? match.rounds[i - 1].score : null;
  return `${mapName(match.map)} · ROUND ${round} · ${before?.us ?? 0} – ${before?.them ?? 0}`;
}

export interface MatchStats {
  map: string;
  result: 'WIN' | 'LOSS' | 'DRAW';
  us: number;
  them: number;
  kills: number;
  deaths: number;
  assists: number;
  /** headshot kills, % of kills */
  hsPct: number;
  kd: number;
  /** rounds with 3+ of my kills */
  multiKillRounds: number;
  aces: number;
  clutches: number;
}

/** My final scoreboard line. */
export function matchStats(match: MatchData, me: string, moments: Moment[]): MatchStats {
  const kills = myKills(match, me);
  const deaths = match.kills.filter((k) => k.victim === me).length;
  const assists = match.kills.filter((k) => k.assister === me && k.attacker !== me).length;
  const perRound = new Map<number, number>();
  for (const k of kills) perRound.set(k.round, (perRound.get(k.round) ?? 0) + 1);
  const final = [...match.rounds].reverse().find((r) => r.score)?.score ?? { us: 0, them: 0 };
  return {
    map: mapName(match.map),
    result: final.us > final.them ? 'WIN' : final.us < final.them ? 'LOSS' : 'DRAW',
    us: final.us,
    them: final.them,
    kills: kills.length,
    deaths,
    assists,
    hsPct: kills.length ? Math.round((100 * kills.filter((k) => k.headshot).length) / kills.length) : 0,
    kd: Math.round((kills.length / Math.max(1, deaths)) * 100) / 100,
    multiKillRounds: [...perRound.values()].filter((n) => n >= 3).length,
    aces: [...perRound.values()].filter((n) => n >= 5).length,
    clutches: new Set(moments.filter((m) => m.kind === 'clutch').map((m) => m.round)).size,
  };
}
