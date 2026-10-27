import type { Kill, MatchData, Moment, MomentKind, Round, RoundIntro } from '../types.ts';

const CHAIN_GAP_S = 10; // own kills closer than this become one multi-kill clip
const TEAM_FIGHT_GAP_S = 5; // teammate kills/deaths closer than this are one fight
const INTRO_MIN_S = 2;

// Round editing guidelines:
// 2. Rotation: a short rotation plays whole; a long one shows enough to
//    establish direction, then jumps to just before I arrive.
const ROTATION_FULL_S = 12;
const ROTATION_SHOW_S = 5;
const ARRIVE_LEADIN_S = 2;
// 3. Holding: a short hold plays unbroken into contact (tension); a long one
//    keeps a few seconds of holding, then cuts closer to the action.
const HOLD_FULL_S = 10;
const HOLD_KEEP_S = 4;
// 4. Contact: a fight starts at the first shot or damage involving the player,
//    chained back through gaps shorter than CONTACT_GAP_S.
const CONTACT_GAP_S = 5;
const CONTACT_LOOKBACK_S = 12;
const MULTI_BONUS: Record<number, number> = { 2: 5, 3: 15, 4: 30, 5: 60 };
const MULTI_LABEL: Record<number, string> = { 1: 'Kill', 2: '2K', 3: '3K', 4: '4K', 5: 'ACE' };

const isKnife = (w: string) => w.includes('knife') || w === 'bayonet';
const isZeus = (w: string) => w === 'taser';
const isWorld = (k: Kill) => !k.attacker || k.attacker === k.victim || k.weapon === 'world';
const isTeamkill = (k: Kill) =>
  !!k.attacker && k.attacker !== k.victim && !!k.attackerSide && k.attackerSide === k.victimSide;

export function buildMoments(match: MatchData, me: string, intros: Record<number, RoundIntro> = {}): Moment[] {
  const out: Moment[] = [];
  for (const round of match.rounds) {
    const kills = match.kills.filter((k) => k.round === round.num);
    const bombs = match.bombs.filter((b) => b.round === round.num);
    const roundMoments: Moment[] = [];
    const add = (m: Omit<Moment, 'id' | 'round' | 'enabled' | 'trimStart' | 'trimEnd'>) =>
      roundMoments.push({
        ...m,
        id: `r${round.num}-${m.kind}-${m.startTick}`,
        round: round.num,
        enabled: true,
        trimStart: 0,
        trimEnd: 0,
      });

    const myKills = kills.filter((k) => k.attacker === me && k.victim !== me && !isTeamkill(k));
    const roundTotal = myKills.length;
    const contact = (players: (string | null)[], tick: number) =>
      Math.min(...players.filter((p): p is string => !!p).map((p) => contactStart(match, p, tick)), tick);

    for (const chain of chainKills(myKills, CHAIN_GAP_S * match.tickrate)) {
      const n = chain.length;
      const tags = killTags(chain);
      if (roundTotal >= 3 && n < roundTotal) tags.unshift(`${MULTI_LABEL[Math.min(roundTotal, 5)]} round`);
      add({
        kind: 'kills',
        label: n === 1 ? `Kill · ${chain[0].weapon}` : MULTI_LABEL[Math.min(n, 5)],
        tags,
        score: chain.reduce((s, k) => s + killScore(k), 0) + (MULTI_BONUS[n] ?? 0),
        startTick: contact([me], chain[0].tick),
        endTick: chain[n - 1].tick,
      });
    }

    const clutch = findClutch(round, kills, me);
    if (clutch) {
      // Kill clips inside the clutch are folded into it.
      const inside = roundMoments.filter((m) => m.kind === 'kills' && m.startTick >= clutch.startTick);
      const clutchKills = myKills.filter((k) => k.tick >= clutch.startTick).length;
      for (const m of inside) roundMoments.splice(roundMoments.indexOf(m), 1);
      add({
        kind: 'clutch',
        label: `1v${clutch.vs} clutch${clutchKills ? ` · ${clutchKills}K` : ''}`,
        tags: ['clutch', ...new Set(inside.flatMap((m) => m.tags))],
        score: 30 + 15 * clutch.vs + inside.reduce((s, m) => s + m.score, 0),
        startTick: clutch.startTick,
        endTick: round.endTick,
      });
    }

    for (const b of bombs) {
      if (b.player !== me || b.kind === 'exploded') continue;
      const planted = b.kind === 'planted';
      add({
        kind: 'bomb',
        label: planted ? `Plant${b.site ? ` (${b.site})` : ''}` : 'Defuse',
        tags: [b.kind],
        score: planted ? 8 : 15,
        // include the plant / defuse animation itself
        startTick: b.tick - (planted ? 3 : 5) * match.tickrate,
        endTick: b.tick,
      });
    }

    const myDeath = kills.find((k) => k.victim === me);
    if (myDeath) {
      const funny = funnyDeath(myDeath);
      add({
        kind: funny ? 'funny' : 'death',
        label: funny ?? `Died to ${myDeath.attackerName || 'world'} · ${myDeath.weapon}`,
        tags: funny ? ['funny'] : ['death'],
        score: funny ? 6 : 2,
        startTick: contact([me], myDeath.tick),
        endTick: myDeath.tick,
      });
    }

    for (const k of kills) {
      if (k.assister === me && k.attacker !== me && k.victim !== me && !isTeamkill(k)) {
        add({
          kind: 'assist',
          label: `${k.flashAssist ? 'Flash assist' : 'Assist'} · ${k.attackerName} → ${k.victimName}`,
          tags: [k.flashAssist ? 'flash' : 'assist'],
          score: k.flashAssist ? 5 : 4,
          startTick: contact([me], k.tick),
          endTick: k.tick,
        });
      }
      if (k.attacker === me && isTeamkill(k)) {
        add({
          kind: 'funny',
          label: `Team-killed ${k.victimName}`,
          tags: ['funny', 'teamkill'],
          score: 6,
          startTick: k.tick,
          endTick: k.tick,
        });
      }
    }

    // Every action of mine this round: the opening runs to the first one, and
    // the rest of the round (teammates, bomb) is told after the last one.
    const ownTicks = [
      ...kills.filter((k) => k.attacker === me || k.victim === me || k.assister === me).map((k) => k.tick),
      ...bombs.filter((b) => b.player === me && b.kind !== 'exploded').map((b) => b.tick),
    ].filter((t) => t <= round.endTick);
    const lastAction = ownTicks.length ? Math.max(...ownTicks) : round.startTick;
    // everything in roundMoments so far is my own play
    const firstContact = roundMoments.length ? Math.min(...roundMoments.map((m) => m.startTick)) : null;

    // 5. After I die, keep teammates' fights selectively: a multi-kill, a
    // teammate clutch, or a fight while the round is still winnable.
    if (myDeath) {
      const mySide = round.roster[me];
      const isMate = (id: string | null) => !!id && id !== me && !!mySide && round.roster[id] === mySide;
      const after = kills.filter(
        (k) => k.tick > myDeath.tick && k.tick <= round.endTick && (isMate(k.attacker) || isMate(k.victim)),
      );
      for (const fight of chainKills(after, TEAM_FIGHT_GAP_S * match.tickrate)) {
        const won = fight.filter((k) => isMate(k.attacker) && !isMate(k.victim)).length;
        const lost = fight.filter((k) => isMate(k.victim)).length;
        const { mates, enemies } = aliveBefore(round, kills, me, fight[0].tick);

        if (mates.length === 1 && enemies >= 1) {
          // A teammate clutch is one moment to the end of the round. Long odds
          // (1v4, 1v5) only count if they actually get a kill.
          const rest = after.filter((k) => k.tick >= fight[0].tick);
          const clutchKills = rest.filter((k) => k.attacker === mates[0] && !isMate(k.victim)).length;
          if (enemies <= 3 || clutchKills > 0) {
            add({
              kind: 'team',
              label: `Teammate clutch · ${playerName(match, rest, mates[0])} 1v${enemies}${clutchKills ? ` · ${clutchKills}K` : ''}`,
              tags: ['teammates', 'clutch'],
              score: 10 + 5 * clutchKills,
              startTick: contact([fight[0].attacker, fight[0].victim], fight[0].tick),
              endTick: rest.at(-1)!.tick,
            });
          }
          break;
        }
        if (won < 2 && mates.length < enemies - 1) continue; // one-sided trade: skip

        add({
          kind: 'team',
          label:
            fight.length === 1
              ? `Teammates · ${fight[0].attackerName || 'world'} killed ${fight[0].victimName}`
              : `Teammates · ${[won && plural(won, 'kill'), lost && plural(lost, 'death')].filter(Boolean).join(', ')}`,
          tags: won >= 2 ? ['teammates', 'multi-kill'] : ['teammates'],
          score: 6 + 4 * won,
          startTick: contact([fight[0].attacker, fight[0].victim], fight[0].tick),
          endTick: fight.at(-1)!.tick,
        });
      }
    }

    // Bomb plays by others after my last action (mine are added above).
    for (const b of bombs) {
      if (b.player === me || b.kind === 'exploded' || b.tick <= lastAction || b.tick > round.endTick) continue;
      const planted = b.kind === 'planted';
      add({
        kind: 'bomb',
        label: `${planted ? `Bomb planted${b.site ? ` (${b.site})` : ''}` : 'Defused'}${b.player ? ` · ${nameOf(match, b.player)}` : ''}`,
        tags: [b.kind],
        score: planted ? 4 : 8,
        startTick: b.tick - (planted ? 3 : 5) * match.tickrate,
        endTick: b.tick,
      });
    }

    const decider = findDecider(round, kills, bombs.filter((b) => b.kind !== 'planted'), match.tickrate);
    if (decider && decider.player !== me && !roundMoments.some((m) => covers(m, decider.tick))) {
      add({
        kind: 'decider',
        label: decider.label,
        tags: ['round-end'],
        score: 5,
        startTick: decider.tick - 2 * match.tickrate,
        endTick: decider.tick,
      });
    }

    // 1-3. Rounds where I do something open as the buy phase ends: the
    // rotation to my spot, some holding, then into first contact.
    if (firstContact !== null && firstContact - round.startTick >= INTRO_MIN_S * match.tickrate) {
      const intro = intros[round.num];
      const segments = openingSegments(round.startTick, intro?.arriveTick ?? firstContact, firstContact, match.tickrate);
      add({
        kind: 'intro',
        label: intro?.place ? `Spawn → ${intro.place}` : 'Round start',
        tags: ['opening'],
        score: 0,
        startTick: round.startTick,
        endTick: segments.at(-1)![1],
        segments,
      });
    }

    out.push(...roundMoments.sort((a, b) => a.startTick - b.startTick));
  }
  return out;
}

/**
 * The opening as played pieces: spawn → spot (shortened if long), a few
 * seconds of holding (unbroken into contact if the hold is short).
 * `contact` is where my first play's own clip begins.
 */
export function openingSegments(start: number, arrive: number, contact: number, tickrate: number): [number, number][] {
  const s = (sec: number) => sec * tickrate;
  const a = Math.min(Math.max(arrive, start), contact);
  const pieces: [number, number][] =
    a - start <= s(ROTATION_FULL_S)
      ? [[start, a]]
      : [[start, start + s(ROTATION_SHOW_S)], [a - s(ARRIVE_LEADIN_S), a]];
  pieces.push(contact - a <= s(HOLD_FULL_S) ? [a, contact] : [a, a + s(HOLD_KEEP_S)]);
  // join touching pieces
  return pieces.reduce<[number, number][]>((acc, p) => {
    const last = acc.at(-1);
    if (last && p[0] <= last[1]) last[1] = Math.max(last[1], p[1]);
    else if (p[1] > p[0]) acc.push([...p]);
    return acc;
  }, []);
}

/** First shot or damage of `player` in the fight that ends at `tick`. */
export function contactStart(match: MatchData, player: string, tick: number): number {
  const from = tick - CONTACT_LOOKBACK_S * match.tickrate;
  const ticks = match.combat
    .filter((c) => c.tick >= from && c.tick <= tick && (c.attacker === player || c.victim === player))
    .map((c) => c.tick)
    .sort((a, b) => b - a);
  let start = tick;
  for (const t of ticks) {
    if (start - t > CONTACT_GAP_S * match.tickrate) break;
    start = t;
  }
  return start;
}

/** Who is alive just before `tick`: my teammates (excluding me) and the number of enemies. */
function aliveBefore(round: Round, kills: Kill[], me: string, tick: number) {
  const mySide = round.roster[me];
  const dead = new Set(kills.filter((k) => k.tick < tick).map((k) => k.victim));
  const alive = Object.entries(round.roster).filter(([id]) => !dead.has(id));
  return {
    mates: alive.filter(([id, s]) => s === mySide && id !== me).map(([id]) => id),
    enemies: alive.filter(([, s]) => s !== mySide).length,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const nameOf = (match: MatchData, id: string) => match.players.find((p) => p.steamId === id)?.name ?? 'someone';
const playerName = (match: MatchData, kills: Kill[], id: string) =>
  kills.find((k) => k.attacker === id)?.attackerName ?? kills.find((k) => k.victim === id)?.victimName ?? nameOf(match, id);

export function chainKills(kills: Kill[], maxGapTicks: number): Kill[][] {
  const chains: Kill[][] = [];
  for (const k of [...kills].sort((a, b) => a.tick - b.tick)) {
    const last = chains.at(-1);
    if (last && k.tick - last.at(-1)!.tick <= maxGapTicks) last.push(k);
    else chains.push([k]);
  }
  return chains;
}

function killScore(k: Kill): number {
  let s = 10;
  if (k.headshot) s += 3;
  if (k.wallbang) s += 8;
  if (k.noscope) s += 10;
  if (k.throughSmoke) s += 6;
  if (k.attackerBlind) s += 6;
  if (isKnife(k.weapon) || isZeus(k.weapon)) s += 15;
  return s;
}

function killTags(chain: Kill[]): string[] {
  const tags: string[] = [];
  const hs = chain.filter((k) => k.headshot).length;
  if (hs) tags.push(hs === chain.length && hs > 1 ? 'all HS' : `${hs} HS`);
  if (chain.some((k) => k.wallbang)) tags.push('wallbang');
  if (chain.some((k) => k.noscope)) tags.push('no-scope');
  if (chain.some((k) => k.throughSmoke)) tags.push('through smoke');
  if (chain.some((k) => k.attackerBlind)) tags.push('while flashed');
  if (chain.some((k) => isKnife(k.weapon))) tags.push('knife');
  if (chain.some((k) => isZeus(k.weapon))) tags.push('zeus');
  const weapons = [...new Set(chain.map((k) => k.weapon))];
  if (weapons.length === 1 && chain.length > 1) tags.push(weapons[0]);
  return tags;
}

function funnyDeath(k: Kill): string | null {
  if (isWorld(k)) return k.weapon === 'world' ? 'Died to the world' : 'Suicide';
  if (isTeamkill(k)) return `Team-killed by ${k.attackerName}`;
  if (isKnife(k.weapon)) return `Knifed by ${k.attackerName}`;
  if (isZeus(k.weapon)) return `Zeused by ${k.attackerName}`;
  if (k.noscope) return `No-scoped by ${k.attackerName}`;
  return null;
}

/**
 * Replays deaths against the freeze-end roster. A clutch starts the moment I'm
 * the last one alive on my side, and only counts if my side wins the round.
 */
export function findClutch(round: Round, kills: Kill[], me: string): { startTick: number; vs: number } | null {
  const mySide = round.roster[me];
  if (!mySide || round.winner !== mySide) return null;
  const alive = new Map(Object.entries(round.roster));
  for (const k of [...kills].sort((a, b) => a.tick - b.tick)) {
    if (k.tick > round.endTick) break;
    alive.delete(k.victim);
    const mates = [...alive].filter(([, s]) => s === mySide);
    const enemies = [...alive].filter(([, s]) => s !== mySide).length;
    if (mates.length === 1 && mates[0][0] === me && enemies >= 1) {
      return { startTick: k.tick, vs: enemies };
    }
    if (!alive.has(me)) return null;
  }
  return null;
}

function findDecider(
  round: Round,
  kills: Kill[],
  bombs: { tick: number; kind: string; player: string | null }[],
  tickrate: number,
): { tick: number; player: string | null; label: string } | null {
  const bomb = bombs.filter((b) => b.tick <= round.endTick).at(-1);
  if (bomb) {
    return {
      tick: bomb.tick,
      player: bomb.player,
      label: bomb.kind === 'defused' ? 'Round won on defuse' : 'Bomb exploded',
    };
  }
  const last = kills.filter((k) => k.tick <= round.endTick).at(-1);
  if (!last || last.tick < round.endTick - 5 * tickrate) return null; // round ended on time
  return {
    tick: last.tick,
    player: last.attacker,
    label: `Round-ending kill · ${last.attackerName || 'world'} (${last.weapon})`,
  };
}

const covers = (m: Moment, tick: number) => tick >= m.startTick && tick <= m.endTick;

export const KIND_ORDER: MomentKind[] = ['intro', 'clutch', 'kills', 'bomb', 'assist', 'team', 'decider', 'funny', 'death'];
