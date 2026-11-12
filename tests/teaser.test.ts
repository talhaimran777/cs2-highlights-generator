import { describe, expect, it } from 'vitest';
import { fadeIn, FLASH_S, pickTeaser, playKind, planTeaser, RAMP_SPEED, SHOT_POST_S, SHOT_PRE_S, TEASER_GRADE, teaserCuts, teaserLength, teaserLook, teaserMoments, teaserText, WHOOSH_SOURCE, WHOOSH_VOLUME, type TeaserMoment } from '../server/teaser.ts';
import { DEFAULT_SETTINGS, type Kill, type MatchData, type Round, type Side, type SyncModel } from '../server/types.ts';

const TICK = 64;
// round n runs from (n-1)*100 s of demo time; the recording starts with the demo
const at = (n: number, sec: number) => ((n - 1) * 100 + sec) * TICK;
const T: Side = 'T';
const roster = { me: T, m1: T, m2: T, e1: 'CT' as Side, e2: 'CT' as Side, e3: 'CT' as Side, e4: 'CT' as Side, e5: 'CT' as Side };
const round = (n: number, won = true): Round => ({ num: n, startTick: at(n, 0), endTick: at(n, 90), winner: won ? 'T' : 'CT', reason: 't_win', roster, score: { us: n, them: 0 } });
const kill = (n: number, sec: number, attacker: string, victim: string, extra: Partial<Kill> = {}): Kill => ({
  tick: at(n, sec), round: n, attacker, attackerName: attacker, attackerSide: roster[attacker as keyof typeof roster], victim, victimName: victim,
  victimSide: roster[victim as keyof typeof roster], assister: null, assisterName: '', flashAssist: false, weapon: 'ak47',
  headshot: false, wallbang: false, noscope: false, throughSmoke: false, attackerBlind: false, ...extra,
});

const kills: Kill[] = [
  // round 1: one plain kill
  kill(1, 20, 'me', 'e1'),
  // round 2: a no-scope
  kill(2, 30, 'me', 'e1', { weapon: 'awp', noscope: true }),
  // round 3: a 4K: a spray double, then two more, far apart (and a teamkill that doesn't count)
  kill(3, 10, 'me', 'e1', { headshot: true }),
  kill(3, 10.8, 'me', 'e2', { headshot: true }),
  kill(3, 25, 'me', 'e3', { headshot: true }),
  kill(3, 26, 'me', 'm1'),
  kill(3, 50, 'me', 'e4', { headshot: true }),
  // round 4: a double in a spray
  kill(4, 40, 'me', 'e1'),
  kill(4, 41, 'me', 'e2', { headshot: true }),
  // round 5: both mates die, then I win it 1v2
  kill(5, 10, 'e1', 'm1'),
  kill(5, 11, 'e2', 'm2'),
  kill(5, 30, 'me', 'e1'),
  kill(5, 44, 'me', 'e2'),
  // round 6: not in the video
  kill(6, 15, 'me', 'e1', { wallbang: true, headshot: true }),
];
const match: MatchData = {
  demoPath: '', map: 'de_mirage', tickrate: TICK, players: [], rounds: [1, 2, 3, 4, 5, 6].map((n) => (n === 5 ? { ...round(n), roster: { me: T, m1: T, m2: T, e1: 'CT' as Side, e2: 'CT' as Side } } : round(n))), kills, bombs: [], combat: [],
};
const sync: SyncModel = { tickrate: TICK, offset: 0, scale: 1, roundOffsets: {}, method: 'manual', inliers: 1, rmsError: 0, confident: true };
const inVideo = new Set([1, 2, 3, 4, 5]);
const moments = teaserMoments(match, 'me', sync, inVideo, 10_000);
const byRound = (n: number) => moments.find((m) => m.round === n)!;

describe('the cold open: its moments', () => {
  it('only the shots: a beat before each kill, a beat after; kills close together are one shot', () => {
    const one = byRound(1);
    expect(one.shots).toEqual([{ start: 20 - SHOT_PRE_S, end: 20 + SHOT_POST_S, kills: 1 }]);
    expect(byRound(4).shots).toEqual([{ start: 340 - SHOT_PRE_S, end: 341 + SHOT_POST_S, kills: 2 }]);
    expect(byRound(4).tag).toBe('DOUBLE *KILL*');
  });

  it('a big round plays as a run of every kill, under one tag; teamkills don’t count', () => {
    const big = byRound(3);
    // its headline: the starred count in TEYE red
    expect(big.tag).toBe('*4K*');
    expect(big.kills).toBe(4);
    // the spray double is one shot, the other two each their own
    expect(big.shots.map((s) => s.kills)).toEqual([2, 1, 1]);
    expect(big.shots[0].start).toBeCloseTo(210 - SHOT_PRE_S);
  });

  it('tags what a shot is about, and a won clutch', () => {
    expect(byRound(2).tag).toBe('*NO-SCOPE*');
    expect(byRound(1).tag).toBe('');
    expect(byRound(5).tag).toBe('*1v2* CLUTCH');
    expect(byRound(5).shots).toHaveLength(2);
    // a round outside the video is never promised
    expect(moments.some((m) => m.round === 6)).toBe(false);
  });

  it('the bigger the moment, the higher it scores', () => {
    const score = (n: number) => byRound(n).score;
    expect(score(3)).toBeGreaterThan(score(5));
    expect(score(5)).toBeGreaterThan(score(4));
    expect(score(4)).toBeGreaterThan(score(2));
    expect(score(2)).toBeGreaterThan(score(1));
  });
});

describe('the cold open: what it plays', () => {
  it('like a trailer: the best moment first, then other kinds of play, inside its length', () => {
    const open = pickTeaser(moments, 12);
    expect(open[0].round).toBe(3); // the 4K hooks
    // then a clutch and a no-scope, before a second multi-kill (the double) would get in
    expect(open.map((m) => playKind(m.tag)).slice(0, 3)).toEqual(['multi', 'clutch', 'NO-SCOPE']);
    const len = open.flatMap((m) => m.shots).reduce((s, x) => s + x.end - x.start, 0);
    expect(len).toBeLessThanOrEqual(12 + 1.5);
    expect(open.length).toBeLessThanOrEqual(4);
  });

  it('tells kinds of play apart', () => {
    expect(['*4K*', '*3K* SPRAY', 'DOUBLE *KILL*', '*ACE*'].map(playKind)).toEqual(['multi', 'multi', 'multi', 'multi']);
    expect(playKind('*1v3* CLUTCH')).toBe('clutch');
    expect(playKind('ONE *TAP*')).toBe('ONE TAP');
    expect(playKind('')).toBe('kill');
  });

  it('a short open keeps the best moments', () => {
    const open = pickTeaser(moments, 5);
    expect(open.map((m) => m.round)).toContain(3);
    expect(open.length).toBeGreaterThanOrEqual(2);
  });

  it('none without enough moments, a sync or a player', () => {
    expect(pickTeaser([byRound(1)], 12)).toEqual([]);
    expect(planTeaser(match, 'me', null, inVideo, 10_000)).toEqual([]);
    expect(planTeaser(match, '', sync, inVideo, 10_000)).toEqual([]);
  });

  it('its cuts in order: hard cuts; the hook slows before its last kill, the last moment flashes in, the open flashes out', () => {
    const open: TeaserMoment[] = [byRound(3), byRound(2)];
    const cuts = teaserCuts(open);
    expect(cuts.map((c) => [c.tag, c.first, c.kicker, c.pop, c.flashIn, c.flashOut, c.speed])).toEqual([
      ['*4K*', true, true, true, false, false, 1],
      ['*4K*', false, true, false, false, false, 1],
      // the 4K's last kill (at 250 s): slowed up to just before it, then the kill at full speed
      ['*4K*', false, true, false, false, false, RAMP_SPEED],
      ['*4K*', false, true, false, false, false, 1],
      ['*NO-SCOPE*', false, false, true, true, true, 1],
    ]);
    const [slow, kill] = cuts.slice(2, 4);
    expect(slow.end).toBe(kill.start);
    expect(kill.start).toBeCloseTo(250 - 0.12);
    expect(kill.end).toBeCloseTo(250 + SHOT_POST_S);
    // the slowed part plays longer than the footage it shows
    expect(teaserLength(cuts)).toBeCloseTo(cuts.reduce((s, c) => s + c.end - c.start, 0) + (slow.end - slow.start) * (1 / RAMP_SPEED - 1));
  });

  it('its look: graded, an impact as each moment starts, flashes only where marked', () => {
    const plain = teaserLook({ pop: false }, 2, '/impact.wav');
    expect(plain.before).toEqual(TEASER_GRADE);
    expect(plain.after).toEqual([]);
    expect(plain.impact).toBeNull();
    const best = teaserLook({ pop: true, flashIn: true, flashOut: true }, 2, '/impact.wav');
    expect(best.impact).toEqual({ file: '/impact.wav', volume: expect.any(Number) });
    expect(best.after).toEqual([`fade=t=in:st=0:d=${FLASH_S}:color=white`, `fade=t=out:st=${(2 - FLASH_S).toFixed(3)}:d=${FLASH_S}:color=white`]);
    expect(teaserLook({ pop: true }, 2, null).impact).toBeNull();
  });

  it('the whoosh is off unless asked for, and has no bass to boom over the game', () => {
    expect(DEFAULT_SETTINGS.teaser.whoosh).toBe(false);
    expect(WHOOSH_SOURCE).toMatch(/highpass=f=600/);
    expect(WHOOSH_VOLUME).toBeLessThan(0.5);
  });
});

describe('the cold open: its text', () => {
  const title = (text: string, style: { preset: string }, dur: number) => `[Events]\nDialogue: 1,0:00:00.00,${dur},Title,,0,0,0,,{\\an8}${style.preset}:${text}`;

  const frame = { width: 2560, height: 1440 };

  it('the kicker over the hook (fading in), the headline in Bold White (popping in), a red underline wiping in under it', () => {
    const [kicker, tag, bar] = teaserText({ tag: '*4K*', first: true, kicker: true, pop: true }, 'MATCH HIGHLIGHTS', 2, title, frame);
    expect(kicker).toContain('{\\fad(160,0)\\an8}bold:MATCH HIGHLIGHTS');
    // pops in: fading in while it shrinks from 135 % to its size
    expect(tag).toContain('{\\fad(90,0)\\fscx135\\fscy135\\t(0,140,\\fscx100\\fscy100)\\an8}bold:*4K*');
    // TEYE crimson (#E3223A), centred, wiping out from its middle
    expect(bar).toContain('\\an8\\pos(1280,');
    expect(bar).toContain('\\1c&H3A22E3&\\fscx0\\t(70,230,\\fscx100)\\p1}m ');
    // after the hook: no kicker; a run's later cuts keep their text up, nothing animating
    const later = teaserText({ tag: '*4K*', first: false, kicker: false, pop: false }, 'MATCH HIGHLIGHTS', 2, title, frame);
    expect(later).toHaveLength(2);
    expect(later.join()).not.toContain('\\fad');
    expect(later.join()).not.toContain('\\t(');
    // no headline: no underline either
    expect(teaserText({ tag: '', first: false, kicker: false, pop: true }, 'MATCH HIGHLIGHTS', 2, title, frame)).toEqual([]);
  });

  it('fades every line of a script in', () => {
    expect(fadeIn('Dialogue: 0,a,b,S,,0,0,0,,{\\p1}m\nDialogue: 1,a,b,S,,0,0,0,,{\\an8}x', 50)).toBe('Dialogue: 0,a,b,S,,0,0,0,,{\\fad(50,0)\\p1}m\nDialogue: 1,a,b,S,,0,0,0,,{\\fad(50,0)\\an8}x');
  });
});
