import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decompress as zstdDecompress } from 'fzstd';
import { repairDemo } from './repair.ts';
import type { BombEvent, CombatEvent, Kill, MatchData, Player, Round, RoundIntro, Side, UtilityKind, UtilityThrow } from '../types.ts';

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

/**
 * A player's id: the steam id, or for a bot (steam id 0, e.g. one that took
 * over for a player who left) "bot:<name>", so kills on and by bots aren't
 * lost. `team` is required for the bot form: world / bomb deaths have no
 * attacker team.
 */
const pid = (steamid: unknown, name: unknown, team?: unknown): string | null =>
  sid(steamid) ?? (name && String(name).trim() && (team === undefined || sideOf(team)) ? `bot:${String(name).trim()}` : null);

/**
 * Who died in a player_death event. A bot that took over for a player who left
 * can die with no victim info at all; a real killer and weapon make that a
 * kill on a bot of the killer's enemy team. A victimless "world" death with no
 * killer is a bot being removed, not a kill (null).
 */
export function deathVictim(e: Row): { id: string; name: string; side: Side | null } | null {
  const id = pid(e.user_steamid, e.user_name, e.user_team_num);
  if (id) return { id, name: String(e.user_name ?? ''), side: sideOf(e.user_team_num) };
  const killer = pid(e.attacker_steamid, e.attacker_name, e.attacker_team_num);
  if (!killer || e.weapon === 'world') return null;
  const killerSide = sideOf(e.attacker_team_num);
  return { id: `bot:${e.tick}`, name: 'BOT', side: killerSide ? (killerSide === 'T' ? 'CT' : 'T') : null };
}

export function parseDemo(demoPath: string, mySteamId?: string): MatchData {
  const buf = loadDemo(demoPath);
  try {
    return parseBuffer(demoPath, buf, mySteamId);
  } catch (e) {
    if (!/MalformedMessage/.test(String((e as Error)?.message ?? e))) throw e;
    // A game event with a broken string makes the parser reject the whole demo.
    const fixed = repairDemo(buf);
    if (fixed.repaired === 0) {
      throw new Error('The demo parser could not read this demo (MalformedMessage), and no broken text was found to repair. The file may be damaged; try downloading it again.');
    }
    console.warn(`Repaired ${fixed.repaired} broken text value(s) in ${demoPath}`);
    return parseBuffer(demoPath, fixed.buf, mySteamId);
  }
}

function parseBuffer(demoPath: string, buf: Buffer, mySteamId?: string): MatchData {
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
      'weapon_fire',
      'player_hurt',
      'player_blind',
    ],
    ['team_num'],
    ['is_warmup_period'],
  ) as Row[]).sort((a, b) => a.tick - b.tick);

  const rounds = buildRounds(events);
  attachRosters(buf, rounds);

  const roundAt = makeRoundLookup(rounds);
  const kills: Kill[] = [];
  const bombs: BombEvent[] = [];
  const combat: CombatEvent[] = [];
  const utility: UtilityThrow[] = [];
  for (const e of events) {
    const round = roundAt(e.tick);
    if (round === 0) continue;
    if (e.event_name === 'weapon_fire') {
      const player = pid(e.user_steamid, e.user_name, e.user_team_num);
      combat.push({ tick: e.tick, attacker: player, victim: null });
      const kind = GRENADES[String(e.weapon ?? '')];
      if (kind) utility.push({ tick: e.tick, round, player, kind, blinded: 0 });
    } else if (e.event_name === 'player_blind') {
      // credit the thrower's latest flash, if it was thrown just before
      const thrower = pid(e.attacker_steamid, e.attacker_name, e.attacker_team_num);
      const enemy = sideOf(e.attacker_team_num) && sideOf(e.user_team_num) && sideOf(e.attacker_team_num) !== sideOf(e.user_team_num);
      if (!thrower || !enemy || Number(e.blind_duration ?? 0) < MIN_BLIND_S) continue;
      const flash = utility.filter((u) => u.kind === 'flash' && u.player === thrower).at(-1);
      if (flash && e.tick - flash.tick <= FLASH_WINDOW_S * CS2_TICKRATE) flash.blinded++;
    } else if (e.event_name === 'player_hurt') {
      combat.push({
        tick: e.tick,
        attacker: pid(e.attacker_steamid, e.attacker_name, e.attacker_team_num),
        victim: pid(e.user_steamid, e.user_name, e.user_team_num),
      });
    } else if (e.event_name === 'player_death') {
      const attacker = pid(e.attacker_steamid, e.attacker_name, e.attacker_team_num);
      const attackerSide = sideOf(e.attacker_team_num);
      const v = deathVictim(e);
      if (!v) continue;
      kills.push({
        tick: e.tick,
        round,
        attacker,
        attackerName: String(e.attacker_name ?? ''),
        attackerSide,
        victim: v.id,
        victimName: v.name,
        victimSide: v.side,
        assister: pid(e.assister_steamid, e.assister_name, e.assister_team_num),
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

  nameBombSites(buf, bombs);
  if (mySteamId) scoreRounds(rounds, mySteamId);

  return {
    demoPath,
    map: String(header.map_name ?? 'unknown'),
    tickrate: CS2_TICKRATE,
    players,
    rounds,
    kills,
    bombs,
    combat,
    utility,
  };
}

const GRENADES: Record<string, UtilityKind> = {
  weapon_smokegrenade: 'smoke',
  weapon_flashbang: 'flash',
  weapon_hegrenade: 'he',
  weapon_molotov: 'molotov',
  weapon_incgrenade: 'molotov',
  weapon_decoy: 'decoy',
};
const MIN_BLIND_S = 1; // shorter is a glance, not a flash that matters
const FLASH_WINDOW_S = 4; // throw to pop is ~1.6 s

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

/**
 * bomb_planted's `site` is an entity index, not A/B. The planter's place name
 * at the plant tick ("BombsiteA") gives the readable site.
 */
function nameBombSites(buf: Buffer, bombs: BombEvent[]) {
  const plants = bombs.filter((b) => b.kind === 'planted' && b.player);
  const rows = plants.length ? (dp.parseTicks(buf, ['last_place_name'], plants.map((b) => b.tick)) as Row[]) : [];
  for (const b of bombs) {
    const row = rows.find((r) => r.tick === b.tick && String(r.steamid) === b.player);
    const place = humanizePlace(row?.last_place_name);
    b.site = /^Bombsite ([AB])$/.exec(place)?.[1] ?? place;
  }
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
    const id = pid(row.steamid, row.name, row.team_num);
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
