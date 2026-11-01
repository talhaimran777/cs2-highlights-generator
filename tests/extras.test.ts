import { describe, expect, it } from 'vitest';
import { breakCards, coldOpenPieces, matchStats, overlayText, replays, sideSwitches } from '../server/edit/extras.ts';
import type { Kill, MatchData, Moment, Round, SyncModel } from '../server/types.ts';

const ME = 'me';
const TR = 64;
// 1 tick = 1/64 s, video time = seconds (offset 0, scale 1)
const sync: SyncModel = { tickrate: TR, offset: 0, scale: 1, roundOffsets: {}, method: 'auto', inliers: 10, rmsError: 0.1, confident: true };
const s = (sec: number) => sec * TR;

const round = (num: number, side: 'T' | 'CT', us: number, them: number): Round => ({
  num, startTick: s(num * 100), endTick: s(num * 100 + 90), winner: side, reason: '',
  roster: { [ME]: side, mate: side, e1: side === 'T' ? 'CT' : 'T' }, score: { us, them },
});
const kill = (num: number, sec: number, extra: Partial<Kill> = {}): Kill => ({
  tick: s(num * 100 + sec), round: num, attacker: ME, attackerName: 'me', attackerSide: 'T', victim: `v${num}-${sec}`, victimName: 'v',
  victimSide: 'CT', assister: null, assisterName: '', flashAssist: false, weapon: 'ak47', headshot: false, wallbang: false,
  noscope: false, throughSmoke: false, attackerBlind: false, ...extra,
});
const moment = (num: number, kind: Moment['kind'], score: number, label: string = kind): Moment => ({
  id: `r${num}-${kind}`, round: num, kind, label, tags: [], score, startTick: s(num * 100), endTick: s(num * 100 + 80),
  enabled: true, trimStart: 0, trimEnd: 0,
});

// rounds 1-2 on T, 3-4 on CT (halftime at 3), 5 on T again (overtime)
const match: MatchData = {
  demoPath: '', map: 'de_ancient', tickrate: TR, players: [],
  rounds: [round(1, 'T', 1, 0), round(2, 'T', 1, 1), round(3, 'CT', 2, 1), round(4, 'CT', 3, 1), round(5, 'T', 4, 1)],
  kills: [
    kill(1, 10, { headshot: true }),
    // round 2: an ace
    ...[20, 22, 30, 41, 43].map((t) => kill(2, t, { headshot: t > 40 })),
    kill(3, 15),
    kill(3, 50, { attacker: 'e1', attackerSide: 'CT', victim: ME, victimSide: 'T' }), // my death
    kill(4, 12, { attacker: 'mate', victim: 'e1', assister: ME }), // my assist
    kill(4, 13, { victim: 'mate', victimSide: 'T' }), // a teamkill: not a kill
    kill(5, 30),
  ],
  bombs: [], combat: [],
};
const moments = [moment(1, 'kills', 13), moment(2, 'kills', 110, 'ACE'), moment(3, 'clutch', 60, '1v2 clutch'), moment(5, 'kills', 200, '4K')];

describe('cold open', () => {
  it('the two best rounds, best first, never the last round', () => {
    const pieces = coldOpenPieces(moments, match, ME, sync);
    expect(pieces.map((c) => c.round)).toEqual([2, 3]);
  });

  it('the decisive kills: from 2 s before my second-to-last kill to 1 s after the last, at most 7 s', () => {
    const [ace, clutch] = coldOpenPieces(moments, match, ME, sync);
    expect([ace.start, ace.end]).toEqual([239, 244]); // kills at 241 and 243
    expect(clutch.end - clutch.start).toBeLessThanOrEqual(7);
    expect(clutch.end).toBe(316);
  });

  it('disabled moments are left out', () => {
    const off = moments.map((m) => (m.round === 2 ? { ...m, enabled: false } : m));
    expect(coldOpenPieces(off, match, ME, sync).map((c) => c.round)).toEqual([3, 1]);
  });
});

describe('replays', () => {
  it('only after a won clutch or a round with 4+ of my kills', () => {
    const r = replays(moments, match, ME, sync);
    expect([...r.keys()].sort()).toEqual([2, 3]);
    const ace = r.get(2)!;
    expect([ace.start, ace.end]).toEqual([239.5, 244]);
  });
});

describe('half time', () => {
  it('halftime at the first side switch, overtime after', () => {
    expect(sideSwitches(match, ME)).toEqual([
      { round: 3, title: 'HALF TIME', subtitle: 'SWITCHING SIDES' },
      { round: 5, title: 'OVERTIME', subtitle: 'SWITCHING SIDES' },
    ]);
  });

  it('the card goes before the first round in the reel at or after the switch', () => {
    const cards = breakCards(sideSwitches(match, ME), [1, 2, 4, 4]);
    expect([...cards.keys()]).toEqual([4]);
    expect(cards.get(4)?.title).toBe('HALF TIME');
  });
});

describe('score graphic', () => {
  it('shows the score going into the round', () => {
    expect(overlayText(match, 1)).toBe('ANCIENT · ROUND 1 · 0 – 0');
    expect(overlayText(match, 3)).toBe('ANCIENT · ROUND 3 · 1 – 1');
  });
});

describe('final scoreboard', () => {
  it('my K/D/A without teamkills, headshots, multi-kill rounds and the result', () => {
    expect(matchStats(match, ME, moments)).toEqual({
      map: 'ANCIENT', result: 'WIN', us: 4, them: 1,
      kills: 8, deaths: 1, assists: 1, hsPct: 38, kd: 8,
      multiKillRounds: 1, aces: 1, clutches: 1,
    });
  });
});
