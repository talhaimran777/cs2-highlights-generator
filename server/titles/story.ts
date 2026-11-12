// The match as a story, for Claude to write YouTube titles from: who I am,
// how the score went (comebacks, streaks, overtime), and per round what I did
// and said. Only facts from the demo, worked out here, so the titles can't
// promise a clutch or an ace that didn't happen. Pure: no Project, no I/O.

import type { BombEvent, CaptionLine, Kill, MatchData, Moment, Round, RoundIntro, Side, SyncModel } from '../types.ts';
import { isTeamkill } from '../demo/moments.ts';
import { videoTime } from '../sync/align.ts';
import { weaponName } from '../shorts/killfeed.ts';

/** lines of what I said kept per round, and their length */
export const MAX_SAID = 6;
export const MAX_SAID_CHARS = 120;

export interface StoryKill {
  /** seconds into the round */
  at: number;
  victim: string;
  weapon: string;
  extras: string[];
}

export interface StoryRound {
  round: number;
  side: Side | null;
  won: boolean;
  /** score after it, mine first, e.g. "7-5" */
  score: string | null;
  ended: string;
  kills: StoryKill[];
  died: { at: number; by: string; weapon: string } | null;
  assists: number;
  bomb: string | null;
  /** I was the last one alive on my side against this many */
  clutch: { vs: number; won: boolean } | null;
  highlights: string[];
  place: string | null;
  /** in the highlight video */
  featured: boolean;
  said: string[];
}

export interface MatchStory {
  me: { name: string; channel: string | null };
  match: { map: string; result: 'win' | 'loss' | 'tie'; finalScore: string | null; halfTime: string | null; rounds: number; overtime: boolean };
  stats: {
    kills: number;
    deaths: number;
    assists: number;
    headshotPct: number;
    multiKills: { '3K': number; '4K': number; ace: number };
    openingKills: number;
    clutches: { tried: number; won: number; best: string | null };
  };
  arc: {
    /** the most rounds we were behind by, and the score then */
    biggestDeficit: { by: number; at: string; round: number } | null;
    comeback: boolean;
    /** the most rounds won in a row */
    longestWinStreak: { rounds: number; from: number; to: number } | null;
    /** rounds that could end the match */
    matchPoints: number[];
    decidingRound: number | null;
    /** rounds we won where I had a multi-kill or a clutch */
    roundsICarried: number[];
    /** each half of regulation: its rounds, and the rounds we won and lost in it ("11-1"), and on which side */
    halves: { half: number; rounds: string; side: Side | null; result: string }[];
    /** every run of 3+ rounds in a row won or lost, with the score before and after it ("won 10 in a row: 1-2 to 11-2") */
    runs: { won: boolean; rounds: number; from: number; to: number; scoreBefore: string; scoreAfter: string }[];
    /** each overtime (6 rounds): the score going in and coming out, and whether we won it, lost it or it was tied (another overtime) */
    overtimes: { period: number; rounds: string; from: string; to: string; result: 'won' | 'lost' | 'tied' }[];
  };
  rounds: StoryRound[];
}

export interface StoryInput {
  match: MatchData;
  /** my steamId */
  me: string;
  channel?: string | null;
  sync: SyncModel | null;
  moments: Moment[];
  intros?: Record<number, RoundIntro>;
  transcript?: CaptionLine[] | null;
  /** rounds in the highlight video */
  featured: Set<number>;
}

/** "de_dust2" -> "Dust2" */
export const mapName = (map: string) =>
  map
    .replace(/^(de|cs|ar|gd)_/, '')
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');

const ENDED: Record<string, string> = {
  t_killed: 'Ts eliminated',
  ct_killed: 'CTs eliminated',
  bomb_exploded: 'bomb exploded',
  bomb_defused: 'bomb defused',
  time_ran_out: 'time ran out',
  target_saved: 'time ran out',
  t_surrender: 'Ts surrendered',
  ct_surrender: 'CTs surrendered',
};
const ended = (reason: string) => ENDED[reason] ?? reason.replace(/_/g, ' ');

const score = (s: Round['score']) => (s ? `${s.us}-${s.them}` : null);

/** I'm the last one alive on my side against `vs` enemies (won or not). */
export function lastAlive(round: Round, kills: Kill[], me: string): { vs: number; won: boolean } | null {
  const mySide = round.roster[me];
  if (!mySide) return null;
  const alive = new Map(Object.entries(round.roster));
  for (const k of [...kills].sort((a, b) => a.tick - b.tick)) {
    if (k.tick > round.endTick) break;
    alive.delete(k.victim);
    if (!alive.has(me)) return null;
    const mates = [...alive].filter(([, s]) => s === mySide).length;
    const enemies = [...alive].filter(([, s]) => s !== mySide).length;
    // a 1v1 that was always a 1v1 isn't a clutch; more than one teammate died first
    if (mates === 1 && enemies >= 1 && Object.values(round.roster).filter((s) => s === mySide).length > 1) {
      return { vs: enemies, won: round.winner === mySide };
    }
  }
  return null;
}

/** What I said during the round: the lines nearest my kills and the round's end first, in time order. */
function linesSaid(lines: CaptionLine[], from: number, to: number, keyTimes: number[]): string[] {
  const inRound = lines.filter((l) => !l.removed && l.end > from && l.start < to && l.words.length);
  const near = (l: CaptionLine) => Math.min(...keyTimes.map((t) => Math.abs((l.start + l.end) / 2 - t)), Infinity);
  return [...inRound]
    .sort((a, b) => near(a) - near(b))
    .slice(0, MAX_SAID)
    .sort((a, b) => a.start - b.start)
    .map((l) => {
      const text = l.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      return text.length > MAX_SAID_CHARS ? `${text.slice(0, MAX_SAID_CHARS - 1).trimEnd()}…` : text;
    })
    .filter(Boolean);
}

/**
 * A moment that's my own play: a multi-kill or a clutch. Teammates', the
 * enemy's bomb, utility and single kills (already in `kills`) are left out,
 * so Claude can't credit me with someone else's round.
 */
const isMine = (m: Moment) => m.kind === 'clutch' || (m.kind === 'kills' && !/^Kill\b/.test(m.label));

/**
 * The rounds a side needs to win before round `n`: 13 in regulation (MR12),
 * then each overtime (6 rounds, MR3) needs 3 more: 16, 19…
 */
export const roundsToWin = (n: number) => (n <= 24 ? 13 : 16 + 3 * Math.floor((n - 25) / 6));

const extras = (k: Kill) =>
  [k.headshot && 'headshot', k.wallbang && 'wallbang', k.noscope && 'no-scope', k.throughSmoke && 'through smoke', k.attackerBlind && 'while blind'].filter(
    (x): x is string => !!x,
  );

export function buildStory(input: StoryInput): MatchStory {
  const { match, me, sync, moments, intros = {}, transcript, featured } = input;
  const tick = match.tickrate;
  const name = match.players.find((pl) => pl.steamId === me)?.name ?? 'me';
  const rounds = [...match.rounds].sort((a, b) => a.num - b.num);
  const lines = transcript ?? [];

  const story: StoryRound[] = rounds.map((r) => {
    const kills = match.kills.filter((k) => k.round === r.num && k.tick <= r.endTick + 5 * tick);
    const secs = (t: number) => Math.round(((t - r.startTick) / tick) * 10) / 10;
    const mine = kills.filter((k) => k.attacker === me && k.victim !== me && !isTeamkill(k));
    // the kill that ended the round, when it ended on a wipe
    const final = /_killed$/.test(r.reason) ? kills.filter((k) => k.tick <= r.endTick && !isTeamkill(k)).sort((a, b) => a.tick - b.tick).at(-1) : undefined;
    const death = kills.find((k) => k.victim === me);
    const bomb = match.bombs.find((b: BombEvent) => b.round === r.num && b.player === me && (b.kind === 'planted' || b.kind === 'defused'));
    const side = r.roster[me] ?? null;
    const keyTimes = sync ? [...mine.map((k) => videoTime(sync, k.tick, r.num)), videoTime(sync, r.endTick, r.num)] : [];
    const said = sync && lines.length ? linesSaid(lines, videoTime(sync, r.startTick, r.num), videoTime(sync, r.endTick, r.num) + 3, keyTimes) : [];
    return {
      round: r.num,
      side,
      won: !!side && r.winner === side,
      score: score(r.score),
      ended: ended(r.reason),
      kills: mine.map((k) => ({ at: secs(k.tick), victim: k.victimName, weapon: weaponName(k.weapon), extras: [...extras(k), ...(k === final ? ['ended the round'] : [])] })),
      died: death ? { at: secs(death.tick), by: death.attackerName || 'the world', weapon: weaponName(death.weapon) } : null,
      assists: kills.filter((k) => k.assister === me && k.attacker !== me && !isTeamkill(k)).length,
      bomb: bomb ? (bomb.kind === 'planted' ? `planted at ${bomb.site || 'a site'}` : 'defused') : null,
      clutch: lastAlive(r, kills, me),
      highlights: moments.filter((m) => m.round === r.num && isMine(m)).map((m) => m.label),
      place: intros[r.num]?.place || null,
      featured: featured.has(r.num),
      said,
    };
  });

  const allMine = story.flatMap((r) => r.kills);
  const multi = (n: number) => story.filter((r) => (n === 5 ? r.kills.length >= 5 : r.kills.length === n)).length;
  const clutches = story.filter((r) => r.clutch);
  const bestClutch = clutches
    .filter((r) => r.clutch!.won)
    .sort((a, b) => b.clutch!.vs - a.clutch!.vs)[0];
  const opening = rounds.filter((r) => {
    const first = match.kills.filter((k) => k.round === r.num && !isTeamkill(k)).sort((a, b) => a.tick - b.tick)[0];
    return first?.attacker === me;
  }).length;

  // the score's shape
  const scored = rounds.filter((r) => r.score);
  let deficit: MatchStory['arc']['biggestDeficit'] = null;
  for (const r of scored) {
    const by = r.score!.them - r.score!.us;
    if (by > 0 && (!deficit || by > deficit.by)) deficit = { by, at: score(r.score)!, round: r.num };
  }
  let streak: MatchStory['arc']['longestWinStreak'] = null;
  let run: number[] = [];
  for (const r of story) {
    run = r.won ? [...run, r.round] : [];
    if (run.length > (streak?.rounds ?? 0)) streak = { rounds: run.length, from: run[0], to: run.at(-1)! };
  }
  const last = scored.at(-1)?.score ?? null;
  const result = !last ? 'tie' : last.us > last.them ? 'win' : last.us < last.them ? 'loss' : 'tie';
  // a match point: either side one round from winning (13 in regulation, 16, 19… in overtime)
  const matchPoints = scored
    .map((r, i) => ({ r, before: i ? scored[i - 1].score! : { us: 0, them: 0 } }))
    .filter(({ r, before }) => Math.max(before.us, before.them) === roundsToWin(r.num) - 1)
    .map(({ r }) => r.num);
  // overtimes: rounds 25-30, 31-36…, each won by the side that gets to 4 of its 6 (a 3-3 means another one)
  const scoreAfter = (n: number) => rounds.find((r) => r.num === n)?.score ?? null;
  const overtimes: MatchStory['arc']['overtimes'] = [];
  for (let k = 0; 25 + 6 * k <= (rounds.at(-1)?.num ?? 0); k++) {
    const first = 25 + 6 * k;
    const lastNum = Math.min(first + 5, rounds.at(-1)!.num);
    const from = scoreAfter(first - 1);
    const to = scoreAfter(lastNum);
    if (!from || !to) continue;
    const [us, them] = [to.us - from.us, to.them - from.them];
    overtimes.push({ period: k + 1, rounds: `${first}-${lastNum}`, from: score(from)!, to: score(to)!, result: us > them ? 'won' : us < them ? 'lost' : 'tied' });
  }
  // half time: the score before my side first changes
  const firstSide = story.find((r) => r.side)?.side;
  const switchAt = story.findIndex((r) => r.side && r.side !== firstSide);
  const half = switchAt > 0 ? story[switchAt - 1].score : null;
  // the halves of regulation (overtime is in `overtimes`): split where my side changes
  const regulation = story.filter((r) => r.round <= 24);
  const cut = switchAt > 0 ? switchAt : regulation.length;
  const halves = [regulation.slice(0, cut), regulation.slice(cut)]
    .filter((h) => h.length)
    .map((h, i) => ({
      half: i + 1,
      rounds: `${h[0].round}-${h.at(-1)!.round}`,
      side: h[0].side,
      result: `${h.filter((r) => r.won).length}-${h.filter((r) => !r.won).length}`,
    }));
  // runs of 3+ rounds won or lost in a row
  const runs: MatchStory['arc']['runs'] = [];
  for (let i = 0; i < story.length; ) {
    let j = i;
    while (j + 1 < story.length && story[j + 1].won === story[i].won) j++;
    if (j - i + 1 >= 3) {
      runs.push({
        won: story[i].won,
        rounds: j - i + 1,
        from: story[i].round,
        to: story[j].round,
        scoreBefore: i ? (story[i - 1].score ?? '0-0') : '0-0',
        scoreAfter: story[j].score ?? '',
      });
    }
    i = j + 1;
  }

  return {
    me: { name, channel: input.channel?.trim() || null },
    match: {
      map: mapName(match.map),
      result,
      finalScore: last ? `${last.us}-${last.them}` : null,
      halfTime: half,
      rounds: rounds.length,
      overtime: rounds.length > 24,
    },
    stats: {
      kills: allMine.length,
      deaths: story.filter((r) => r.died).length,
      assists: story.reduce((n, r) => n + r.assists, 0),
      headshotPct: allMine.length ? Math.round((allMine.filter((k) => k.extras.includes('headshot')).length / allMine.length) * 100) : 0,
      multiKills: { '3K': multi(3), '4K': multi(4), ace: multi(5) },
      openingKills: opening,
      clutches: { tried: clutches.length, won: clutches.filter((r) => r.clutch!.won).length, best: bestClutch ? `1v${bestClutch.clutch!.vs} in round ${bestClutch.round}` : null },
    },
    arc: {
      biggestDeficit: deficit,
      comeback: !!deficit && deficit.by >= 3 && result !== 'loss',
      longestWinStreak: streak,
      matchPoints,
      decidingRound: rounds.at(-1)?.num ?? null,
      roundsICarried: story.filter((r) => r.won && (r.kills.length >= 3 || r.clutch?.won)).map((r) => r.round),
      halves,
      runs,
      overtimes,
    },
    rounds: story,
  };
}

// --- a short: one round ------------------------------------------------------

export interface ShortStory {
  me: { name: string; channel: string | null };
  round: {
    round: number;
    /** what `at` on each kill counts from: the round's start (demo), or the first kill (clips, no round timing) */
    killsTimedFrom: 'round start' | 'first kill';
    kills: StoryKill[];
    multiKill: string | null;
    died: { at: number; by: string; weapon: string } | boolean | null;
    clutch: { vs: number; won: boolean } | null;
    side: Side | null;
    won: boolean | null;
    scoreBefore: string | null;
    scoreAfter: string | null;
    /** clips: the score on the HUD during the round (which side is mine isn't known) */
    scoreOnScreen: string | null;
    ended: string | null;
    /** pistol round, match point (ours or theirs), overtime, the match's last round */
    stakes: string[];
    said: string[];
    place: string | null;
  };
  /** the match around it (demo only) */
  match: MatchStory['match'] | null;
}

export const multiKillLabel = (n: number) => (n >= 5 ? 'ACE' : n >= 2 ? `${n}K` : null);

/** A short's story from the match's: its round, with the score and what was at stake then. */
export function shortStoryFromMatch(story: MatchStory, round: number): ShortStory {
  const i = story.rounds.findIndex((r) => r.round === round);
  const r = story.rounds[i];
  if (!r) throw new Error(`Round ${round} isn't in the match`);
  const before = i > 0 ? story.rounds[i - 1].score : '0-0';
  const [us, them] = (before ?? '0-0').split('-').map(Number);
  const need = roundsToWin(round);
  const firstOfHalf = story.arc.halves.some((h) => Number(h.rounds.split('-')[0]) === round);
  const stakes = [
    firstOfHalf && round <= 24 ? 'pistol round' : null,
    us === need - 1 && them === need - 1 ? 'match point for both teams' : us === need - 1 ? 'match point for us' : them === need - 1 ? 'match point for them' : null,
    round > 24 ? `overtime ${Math.floor((round - 25) / 6) + 1}` : null,
    round === story.arc.decidingRound ? `the last round of the match (${story.match.result})` : null,
  ].filter((x): x is string => !!x);
  return {
    me: story.me,
    round: {
      round,
      killsTimedFrom: 'round start',
      kills: r.kills,
      multiKill: multiKillLabel(r.kills.length),
      died: r.died,
      clutch: r.clutch,
      side: r.side,
      won: r.won,
      scoreBefore: before,
      scoreAfter: r.score,
      scoreOnScreen: null,
      ended: r.ended,
      stakes,
      said: r.said,
      place: r.place,
    },
    match: story.match,
  };
}

/** A short's story from a recorded clip (no demo): the kills read off its kill feed, whether I died, the HUD score. */
export function shortStoryFromClip(input: {
  name: string;
  channel?: string | null;
  round: number;
  kills: { at: number; victim: string; weapon: string; headshot: boolean }[];
  died: boolean;
  scoreOnScreen: string | null;
}): ShortStory {
  const sorted = [...input.kills].sort((a, b) => a.at - b.at);
  const first = sorted[0]?.at ?? 0;
  return {
    me: { name: input.name || 'me', channel: input.channel?.trim() || null },
    round: {
      round: input.round,
      killsTimedFrom: 'first kill',
      kills: sorted.map((k) => ({ at: Math.round((k.at - first) * 10) / 10, victim: k.victim, weapon: weaponName(k.weapon), extras: k.headshot ? ['headshot'] : [] })),
      multiKill: multiKillLabel(sorted.length),
      died: input.died,
      clutch: null,
      side: null,
      won: null,
      scoreBefore: null,
      scoreAfter: null,
      scoreOnScreen: input.scoreOnScreen,
      ended: null,
      stakes: [],
      said: [],
      place: null,
    },
    match: null,
  };
}
