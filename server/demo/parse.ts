import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decompress as zstdDecompress } from 'fzstd';
import type { BombEvent, Kill, MatchData, Player, Round, RoundIntro, Side } from '../types.ts';

const require = createRequire(import.meta.url);
const dp = require('@laihoe/demoparser2') as typeof import('@laihoe/demoparser2');

export const CS2_TICKRATE = 64;

type Row = Record<string, any>;

/** FACEIT serves demos as .dem.zst (sometimes .gz); the parser wants raw bytes. */
export function loadDemo(path: string): Buffer {
  const raw = readFileSync(path);
  const lower = path.toLowerCase();
  if (lower.endsWith('.zst')) return Buffer.from(zstdDecompress(raw));
  if (lower.endsWith('.gz')) return gunzipSync(raw);
  return raw;
}

export function sideOf(v: unknown): Side | null {
  if (v === 2 || v === '2' || v === 'T' || v === 'TERRORIST') return 'T';
  if (v === 3 || v === '3' || v === 'CT') return 'CT';
  return null;
}

const sid = (v: unknown): string | null =>
  v === null || v === undefined || v === '' || v === '0' || v === 0 ? null : String(v);

export function parseDemo(demoPath: string, mySteamId?: string): MatchData {
  const buf = loadDemo(demoPath);

  const header = dp.parseHeader(buf) as Row;
  const players: Player[] = (dp.parsePlayerInfo(buf) as Row[])
    .filter((p) => sid(p.steamid))
    .map((p) => ({ steamId: String(p.steamid), name: String(p.name ?? '') }));

  const events = (dp.parseEvents(
    buf,
    [
      'round_announce_match_start',
      'round_freeze_end',
      'round_end',
      'player_death',
      'bomb_planted',
      'bomb_defused',
      'bomb_exploded',
    ],
    ['team_num'],
    ['is_warmup_period'],
  ) as Row[]).sort((a, b) => a.tick - b.tick);

  const rounds = buildRounds(events);
  attachRosters(buf, rounds);

  const roundAt = makeRoundLookup(rounds);
  const kills: Kill[] = [];
  const bombs: BombEvent[] = [];
  for (const e of events) {
    const round = roundAt(e.tick);
    if (round === 0) continue;
    if (e.event_name === 'player_death') {
      const victim = sid(e.user_steamid);
      if (!victim) continue;
      kills.push({
        tick: e.tick,
        round,
        attacker: sid(e.attacker_steamid),
        attackerName: String(e.attacker_name ?? ''),
        attackerSide: sideOf(e.attacker_team_num),
        victim,
        victimName: String(e.user_name ?? ''),
        victimSide: sideOf(e.user_team_num),
        assister: sid(e.assister_steamid),
        assisterName: String(e.assister_name ?? ''),
        flashAssist: !!e.assistedflash,
        weapon: String(e.weapon ?? ''),
        headshot: !!e.headshot,
        wallbang: Number(e.penetrated ?? 0) > 0,
        noscope: !!e.noscope,
        throughSmoke: !!e.thrusmoke,
        attackerBlind: !!e.attackerblind,
      });
    } else if (e.event_name.startsWith('bomb_')) {
      bombs.push({
        tick: e.tick,
        round,
        kind: e.event_name.slice(5) as BombEvent['kind'],
        player: sid(e.user_steamid),
        site: String(e.site ?? ''),
      });
    }
  }

  if (mySteamId) scoreRounds(rounds, mySteamId);

  return {
    demoPath,
    map: String(header.map_name ?? 'unknown'),
    tickrate: CS2_TICKRATE,
    players,
    rounds,
    kills,
    bombs,
  };
}

/**
 * Rounds run from freeze-time end to round_end. Everything before the last
 * match-start announcement (warmup, restarts) is dropped.
 */
export function buildRounds(events: Row[]): Round[] {
  let startIdx = 0;
  events.forEach((e, i) => {
    if (e.event_name === 'round_announce_match_start') startIdx = i;
  });

  const rounds: Round[] = [];
  let freezeEnd: number | null = null;
  let lastEnd = startIdx > 0 ? events[startIdx].tick : 0;
  for (const e of events.slice(startIdx)) {
    if (e.is_warmup_period === true) continue;
    if (e.event_name === 'round_freeze_end') freezeEnd = e.tick;
    if (e.event_name === 'round_end') {
      // A round_end with no freeze_end means the demo/match started mid-round.
      const start = freezeEnd ?? lastEnd;
      if (e.tick > start) {
        rounds.push({
          num: rounds.length + 1,
          startTick: start,
          endTick: e.tick,
          winner: sideOf(e.winner),
          reason: String(e.reason ?? ''),
          roster: {},
          score: null,
        });
      }
      freezeEnd = null;
      lastEnd = e.tick;
    }
  }
  return rounds;
}

/** Round that owns a tick: from its freeze end until the next round's freeze end. */
export function makeRoundLookup(rounds: Round[]) {
  return (tick: number): number => {
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (tick >= rounds[i].startTick) return rounds[i].num;
    }
    return 0;
  };
}

function attachRosters(buf: Buffer, rounds: Round[]) {
  if (rounds.length === 0) return;
  const rows = dp.parseTicks(
    buf,
    ['team_num', 'is_alive'],
    rounds.map((r) => r.startTick),
  ) as Row[];
  const byTick = new Map(rounds.map((r) => [r.startTick, r]));
  for (const row of rows) {
    const round = byTick.get(row.tick);
    const side = sideOf(row.team_num);
    const id = sid(row.steamid);
    if (round && side && id && row.is_alive !== false) round.roster[id] = side;
  }
}

export function scoreRounds(rounds: Round[], me: string) {
  let us = 0;
  let them = 0;
  for (const r of rounds) {
    const mySide = r.roster[me];
    if (!mySide || !r.winner) {
      r.score = null;
      continue;
    }
    if (r.winner === mySide) us++;
    else them++;
    r.score = { us, them };
  }
}

const SAMPLE_STEP = 8; // ticks between position samples (0.125 s)
const SEARCH_S = 30; // how long after freeze end to look for my spot
// Holding a spot still means jiggling, shoulder-peeking and crouch-shifting,
// so "arrived" = staying inside a small circle, not standing dead still.
// Tuned on a real FACEIT match: lands ~8-10 s for normal rotations.
const SETTLE_S = 2;
const SETTLE_RADIUS = 150; // units; running is ~250 u/s
const MIN_TRAVEL = 300; // units moved from spawn before settling counts

/**
 * For each round, when I reached my spot: the first time after leaving spawn
 * that I stay within SETTLE_RADIUS for SETTLE_S. Uses positions from the demo.
 */
export function findArrivals(demoPath: string, me: string, rounds: Round[], tickrate = CS2_TICKRATE): Record<number, RoundIntro> {
  if (rounds.length === 0) return {};
  const wanted: number[] = [];
  for (const r of rounds) {
    const end = Math.min(r.endTick, r.startTick + SEARCH_S * tickrate);
    for (let t = r.startTick; t <= end; t += SAMPLE_STEP) wanted.push(t);
  }
  const rows = (dp.parseTicks(loadDemo(demoPath), ['X', 'Y', 'last_place_name', 'is_alive'], wanted, [me]) as Row[])
    .filter((row) => String(row.steamid) === me)
    .sort((a, b) => a.tick - b.tick);

  const out: Record<number, RoundIntro> = {};
  for (const r of rounds) {
    const pts = rows.filter((row) => row.tick >= r.startTick && row.tick <= r.startTick + SEARCH_S * tickrate && row.is_alive !== false);
    if (pts.length < 2) continue;
    out[r.num] = arrival(pts as PositionRow[], tickrate) ?? {
      arriveTick: pts.at(-1)!.tick,
      place: humanizePlace(pts.at(-1)!.last_place_name),
    };
  }
  return out;
}

type PositionRow = { tick: number; X: number; Y: number; last_place_name?: string };

export function arrival(pts: PositionRow[], tickrate: number): RoundIntro | null {
  const dist = (a: PositionRow, b: PositionRow) => Math.hypot(a.X - b.X, a.Y - b.Y);
  const settleSamples = Math.ceil((SETTLE_S * tickrate) / SAMPLE_STEP);
  let travelled = 0;
  for (let i = 1; i < pts.length; i++) {
    travelled += dist(pts[i], pts[i - 1]);
    if (travelled < MIN_TRAVEL || i + settleSamples >= pts.length) continue;
    let settled = true;
    for (let j = i + 1; j <= i + settleSamples && settled; j++) settled = dist(pts[j], pts[i]) < SETTLE_RADIUS;
    // the place is read where I end up, not where settling began
    if (settled) return { arriveTick: pts[i].tick, place: humanizePlace(pts[i + settleSamples].last_place_name) };
  }
  return null;
}

/** "BombsiteB" -> "Bombsite B", "CTSpawn" -> "CT Spawn" */
export function humanizePlace(p: unknown): string {
  return String(p ?? '')
    .replace(/([a-z])of([A-Z])/g, '$1 of $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/** Dumps event names + sample fields, to check field names against a real demo. */
export function inspectDemo(demoPath: string) {
  const buf = loadDemo(demoPath);
  const names = dp.listGameEvents(buf) as string[];
  const sample = (name: string) => (dp.parseEvent(buf, name, ['team_num']) as Row[]).slice(0, 2);
  return {
    header: dp.parseHeader(buf),
    events: names,
    samples: {
      player_death: sample('player_death'),
      round_end: sample('round_end'),
      round_freeze_end: sample('round_freeze_end'),
      bomb_planted: sample('bomb_planted'),
    },
  };
}
