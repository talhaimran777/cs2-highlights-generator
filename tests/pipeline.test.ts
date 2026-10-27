import { describe, expect, it } from 'vitest';
import { arrival, buildRounds, humanizePlace } from '../server/demo/parse.ts';
import { buildMoments, findClutch } from '../server/demo/moments.ts';
import { fitSync, manualSync, videoTime } from '../server/sync/align.ts';
import { countHighlightedEntries, countsToEvents } from '../server/sync/killfeed.ts';
import { planClips } from '../server/edit/plan.ts';
import { DEFAULT_SETTINGS, type Kill, type MatchData, type Moment, type Round } from '../server/types.ts';

const TR = 64;
const ME = 'me';
const s = (sec: number) => sec * TR;

function kill(tick: number, round: number, attacker: string, victim: string, extra: Partial<Kill> = {}): Kill {
  const side = (id: string) => (id.startsWith('e') ? 'T' : 'CT');
  return {
    tick, round, attacker, victim,
    attackerName: attacker, victimName: victim,
    attackerSide: side(attacker), victimSide: side(victim),
    assister: null, assisterName: '', flashAssist: false,
    weapon: 'ak47', headshot: false, wallbang: false, noscope: false, throughSmoke: false, attackerBlind: false,
    ...extra,
  };
}

const roster = { me: 'CT', m2: 'CT', m3: 'CT', e1: 'T', e2: 'T', e3: 'T' } as const;
function round(num: number, start: number, end: number, winner: 'T' | 'CT'): Round {
  return { num, startTick: s(start), endTick: s(end), winner, reason: '', roster: { ...roster }, score: null };
}

describe('buildRounds', () => {
  it('drops warmup and starts at the last match start', () => {
    const ev = [
      { event_name: 'round_freeze_end', tick: 10 },
      { event_name: 'round_end', tick: 20, winner: 2 },
      { event_name: 'round_announce_match_start', tick: 100 },
      { event_name: 'round_freeze_end', tick: 200 },
      { event_name: 'round_end', tick: 900, winner: 'CT' },
      { event_name: 'round_freeze_end', tick: 1200 },
      { event_name: 'round_end', tick: 2000, winner: 3 },
    ];
    const r = buildRounds(ev);
    expect(r.map((x) => [x.num, x.startTick, x.endTick, x.winner])).toEqual([
      [1, 200, 900, 'CT'],
      [2, 1200, 2000, 'CT'],
    ]);
  });
});

describe('moments', () => {
  it('chains close kills into a multi-kill, keeps separate kills apart', () => {
    const match: MatchData = {
      demoPath: '', map: 'de_mirage', tickrate: TR, players: [], bombs: [],
      rounds: [round(1, 0, 100, 'CT')],
      kills: [
        kill(s(10), 1, ME, 'e1', { headshot: true }),
        kill(s(12), 1, ME, 'e2', { headshot: true }),
        kill(s(40), 1, ME, 'e3'),
      ],
    };
    const m = buildMoments(match, ME).filter((x) => x.kind === 'kills');
    expect(m.map((x) => x.label)).toEqual(['2K', 'Kill · ak47']);
    expect(m[0].tags).toContain('3K round');
    expect(m[0].tags).toContain('all HS');
  });

  it('detects a won 1v2 clutch and folds kills into it', () => {
    const r = round(1, 0, 100, 'CT');
    const kills = [
      kill(s(10), 1, 'e1', 'm2'),
      kill(s(20), 1, 'e2', 'm3'), // now 1v3
      kill(s(25), 1, ME, 'e1'),
      kill(s(30), 1, ME, 'e2'),
      kill(s(35), 1, ME, 'e3'),
    ];
    expect(findClutch(r, kills, ME)).toEqual({ startTick: s(20), vs: 3 });
    const m = buildMoments({ demoPath: '', map: '', tickrate: TR, players: [], bombs: [], rounds: [r], kills }, ME);
    expect(m.map((x) => x.kind)).toEqual(['intro', 'clutch']);
    expect(m[1].label).toBe('1v3 clutch · 3K');
  });

  it('no clutch when my side loses', () => {
    const r = round(1, 0, 100, 'T');
    expect(findClutch(r, [kill(s(10), 1, 'e1', 'm2'), kill(s(11), 1, 'e1', 'm3')], ME)).toBeNull();
  });

  it('adds the round decider when it is not mine, and funny deaths', () => {
    const match: MatchData = {
      demoPath: '', map: '', tickrate: TR, players: [], bombs: [],
      rounds: [round(1, 0, 60, 'CT')],
      kills: [kill(s(20), 1, 'e1', ME, { weapon: 'knife_karambit' }), kill(s(58), 1, 'm2', 'e3')],
    };
    const m = buildMoments(match, ME);
    expect(m.map((x) => [x.kind, x.label])).toEqual([
      ['intro', 'Round start'],
      ['funny', 'Knifed by e1'],
      ['decider', 'Round-ending kill · m2 (ak47)'],
    ]);
  });
});

describe('round intro', () => {
  // run 250 u/s along X for 6 s, then hold still
  const pts = Array.from({ length: 120 }, (_, i) => {
    const t = i * 0.125;
    return { tick: Math.round(s(t)), X: Math.min(t, 6) * 250, Y: 0, last_place_name: t < 6 ? 'CTSpawn' : 'BombsiteB' };
  });

  it('finds when I stop at my spot', () => {
    const a = arrival(pts, TR)!;
    // settles up to SETTLE_RADIUS / run speed (~0.6 s) before the full stop
    expect(Math.abs(a.arriveTick / TR - 6)).toBeLessThan(0.75);
    expect(a.place).toBe('Bombsite B');
  });

  it('jiggle-peeking at the spot still counts as arrived', () => {
    const jiggle = pts.map((p, i) => (p.tick / TR >= 6 ? { ...p, X: 1500 + (i % 8 < 4 ? 60 : -60) } : p));
    expect(Math.abs(arrival(jiggle, TR)!.arriveTick / TR - 6)).toBeLessThan(0.75);
  });

  it('a quick pause right at spawn does not count', () => {
    const fidget = pts.map((p) => ({ ...p, X: Math.min(p.tick / TR, 0.5) * 100 }));
    expect(arrival(fidget, TR)).toBeNull();
  });

  it('humanizes place names', () => {
    expect(humanizePlace('CTSpawn')).toBe('CT Spawn');
    expect(humanizePlace('TopofMid')).toBe('Top of Mid');
    expect(humanizePlace('BombsiteB')).toBe('Bombsite B');
    expect(humanizePlace('Banana')).toBe('Banana');
  });

  const match = (kills: Kill[]): MatchData => ({
    demoPath: '', map: '', tickrate: TR, players: [], bombs: [], rounds: [round(1, 100, 200, 'CT')], kills,
  });

  it('runs from spawn to my first action, however long the hold', () => {
    const m = buildMoments(match([kill(s(180), 1, ME, 'e1')]), ME, { 1: { arriveTick: s(110), place: 'Banana' } });
    expect(m[0]).toMatchObject({ kind: 'intro', label: 'Spawn → Banana', startTick: s(100), endTick: s(180) });
  });

  it('an assist or my death also ends the opening', () => {
    const assist = buildMoments(match([kill(s(130), 1, 'm2', 'e1', { assister: ME }), kill(s(150), 1, ME, 'e2')]), ME);
    expect(assist[0]).toMatchObject({ kind: 'intro', endTick: s(130) });
    const death = buildMoments(match([kill(s(125), 1, 'e1', ME)]), ME);
    expect(death[0]).toMatchObject({ kind: 'intro', endTick: s(125) });
  });

  it('a plant ends the opening', () => {
    const m = buildMoments(
      { ...match([]), bombs: [{ tick: s(140), round: 1, kind: 'planted', player: ME, site: 'B' }] },
      ME,
    );
    expect(m[0]).toMatchObject({ kind: 'intro', endTick: s(140) });
  });

  it('quiet rounds (nothing from me) get no opening', () => {
    const m = buildMoments(match([kill(s(195), 1, 'm2', 'e1')]), ME, { 1: { arriveTick: s(110), place: '' } });
    expect(m.map((x) => x.kind)).toEqual(['decider']);
  });

  it('adds assists as their own moments', () => {
    const m = buildMoments(match([kill(s(150), 1, 'm2', 'e1', { assister: ME, flashAssist: true })]), ME);
    expect(m.map((x) => [x.kind, x.label])).toContainEqual(['assist', 'Flash assist · m2 → e1']);
  });
});

describe('sync', () => {
  const anchors = [10, 25, 70, 140, 300, 420].map((sec, i) => ({ tick: s(sec), round: i < 3 ? 1 : 2 }));

  it('recovers the offset despite missing and spurious detections', () => {
    const offset = 37.25;
    const det = [10, 25, 140, 300, 420].map((t) => t + offset + 0.1).concat([5, 200, 555]);
    const m = fitSync(anchors, det, TR, [1, 2]);
    expect(m.confident).toBe(true);
    expect(videoTime(m, s(70), 1)).toBeCloseTo(70 + offset, 0);
  });

  it('handles a jump between rounds (pause not recorded in demo time)', () => {
    const det = anchors.map((a, i) => a.tick / TR + (i < 3 ? 12 : 12 + 95));
    const m = fitSync(anchors, det, TR, [1, 2]);
    expect(videoTime(m, s(10), 1)).toBeCloseTo(22, 1);
    expect(videoTime(m, s(300), 2)).toBeCloseTo(407, 1);
  });

  it('a round whose only anchor was missed keeps the running offset', () => {
    // like a real match: rounds with one kill each, one of them not detected, lots of noise
    const one = [100, 200, 300, 400, 500, 600].map((sec, i) => ({ tick: s(sec), round: i + 1 }));
    const det = [100, 200, 400, 500, 600].map((t) => t + 60.4).concat([0, 3, 77, 151, 333, 610]);
    const m = fitSync(one, det, TR, [1, 2, 3, 4, 5, 6]);
    for (const r of [1, 2, 3, 4, 5, 6]) expect(m.roundOffsets[r]).toBeCloseTo(60.4, 1);
  });

  it('never jumps backwards, even when two missed anchors line up with noise', () => {
    const anchors = [100, 200, 300, 2100, 2118].map((sec, i) => ({ tick: s(sec), round: i < 3 ? i + 1 : 4 }));
    // round 4's real entries missed; two noise detections 18 s apart far earlier in the video
    const det = [100, 200, 300].map((t) => t + 60).concat([150, 168]);
    const m = fitSync(anchors, det, TR, [1, 2, 3, 4]);
    expect(m.roundOffsets[4]).toBeCloseTo(60, 1);
  });

  it('manual sync from one known point', () => {
    const m = manualSync(s(100), 160, TR);
    expect(videoTime(m, s(130), 4)).toBe(190);
  });
});

describe('kill feed', () => {
  function frame(w: number, h: number, boxes: [number, number][]) {
    const px = new Uint8Array(w * h * 3).fill(30);
    for (const [top, bottom] of boxes) {
      for (const y of [top, bottom]) {
        for (let x = Math.floor(w * 0.4); x < w - 4; x++) px.set([200, 20, 25], (y * w + x) * 3);
      }
    }
    return px;
  }

  it('counts outlined entries', () => {
    expect(countHighlightedEntries(frame(200, 120, []), 200, 120)).toBe(0);
    expect(countHighlightedEntries(frame(200, 120, [[10, 28]]), 200, 120)).toBe(1);
    expect(countHighlightedEntries(frame(200, 120, [[10, 28], [32, 50]]), 200, 120)).toBe(2);
  });

  it('turns count increases into events, ignoring 1-frame noise', () => {
    expect(countsToEvents([0, 0, 1, 1, 1, 2, 2, 0, 0, 1, 0, 0], 4)).toEqual([0.5, 1.25]);
  });
});

describe('clip planning', () => {
  it('merges overlapping moments in a round, never across rounds', () => {
    const sync = manualSync(0, 0, TR);
    const base = { enabled: true, trimStart: 0, trimEnd: 0, tags: [], score: 1 };
    const clips = planClips(
      [
        { ...base, id: 'a', round: 1, kind: 'kills', label: '2K', startTick: s(10), endTick: s(12) },
        { ...base, id: 'b', round: 1, kind: 'death', label: 'Died', startTick: s(15), endTick: s(15) },
        { ...base, id: 'c', round: 2, kind: 'kills', label: 'Kill', startTick: s(19), endTick: s(19) },
        { ...base, id: 'd', round: 2, kind: 'bomb', label: 'Plant', startTick: s(60), endTick: s(60), enabled: false },
      ],
      sync,
      DEFAULT_SETTINGS,
      1000,
    );
    expect(clips.map((c) => [c.round, c.start, c.end, c.momentIds])).toEqual([
      [1, 7, 17, ['a', 'b']],
      [2, 16, 21, ['c']],
    ]);
  });

  const base = { enabled: true, trimStart: 0, trimEnd: 0, tags: [], score: 1 };
  const fullRound = (introOn: boolean): Moment[] => [
    { ...base, id: 'i', round: 3, kind: 'intro', label: 'Spawn → B', startTick: s(100), endTick: s(140), enabled: introOn },
    { ...base, id: 'k', round: 3, kind: 'kills', label: 'Kill', startTick: s(140), endTick: s(140) },
    { ...base, id: 'k2', round: 3, kind: 'kills', label: 'Kill', startTick: s(170), endTick: s(170) },
    { ...base, id: 'd', round: 3, kind: 'decider', label: 'Round end', startTick: s(188), endTick: s(190) },
    { ...base, id: 'n', round: 4, kind: 'kills', label: 'Kill', startTick: s(240), endTick: s(240) },
  ];

  it('plays a round with its intro on unbroken, from spawn to the last highlight', () => {
    const clips = planClips(fullRound(true), manualSync(0, 0, TR), DEFAULT_SETTINGS, 1000);
    expect(clips.map((c) => [c.round, c.start, c.end, c.momentIds])).toEqual([
      [3, 99, 192, ['i', 'k', 'k2', 'd']],
      [4, 237, 242, ['n']],
    ]);
  });

  it('with the intro off the round is cut between highlights again', () => {
    const clips = planClips(fullRound(false), manualSync(0, 0, TR), DEFAULT_SETTINGS, 1000);
    expect(clips.map((c) => [c.round, c.start, c.end])).toEqual([
      [3, 137, 142],
      [3, 167, 172],
      [3, 185, 192],
      [4, 237, 242],
    ]);
  });
});
