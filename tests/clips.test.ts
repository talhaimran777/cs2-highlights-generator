import { describe, expect, it } from 'vitest';
import { bursts, clipCardText, clipMoments, lastRoundKills, planSourceClips, roundStartsFrom } from '../server/clips/moments.ts';
import { classify, newEntries, parseTimer, sameName, whoIsMe, type RawEntry } from '../server/clips/read.ts';
import { feedShotTimes } from '../server/clips/analyze.ts';
import { applyEdits } from '../server/edit/edits.ts';
import { protectSpeech } from '../server/edit/plan.ts';
import { DEFAULT_SETTINGS, type ClipAnalysis, type FeedEntry, type HudSample, type Source } from '../server/types.ts';

const kill = (t: number, extra: Partial<FeedEntry> = {}): FeedEntry => ({ t, kind: 'kill', attacker: 'me', victim: `v${t}`, weapon: 'ak47', headshot: false, ...extra });
const death = (t: number): FeedEntry => ({ t, kind: 'death', attacker: 'enemy', victim: 'me', weapon: 'awp', headshot: false });
const hud = (t: number, timer: number | null, left: number | null, right: number | null): HudSample => ({ t, timer, left, right });

const analysis = (entries: FeedEntry[], roundStarts: number[] = [], samples: HudSample[] = []): ClipAnalysis => ({
  entries, hud: samples, roundStarts, usage: { input: 0, output: 0 },
});
const source = (id: string, offset: number, a: ClipAnalysis | null, duration = 120): Source => ({
  id, path: `${id}.mp4`, name: id, offset, analysis: a,
  info: { duration, width: 1920, height: 1080, fps: '60/1', audio: [], encoding: { codec: 'h264', profile: null, pixFmt: 'yuv420p', bitRate: null, colorSpace: null, colorPrimaries: null, colorTransfer: null, colorRange: null } },
});
const settings = { ...DEFAULT_SETTINGS, preRoll: 3, postRoll: 2, mergeGap: 1.5, burstGap: 8 };

describe('round starts from the HUD', () => {
  it('a score change or a timer reset starts a round', () => {
    const starts = roundStartsFrom([
      hud(0, 40, 5, 3),
      hud(5, 35, 5, 3),
      hud(10, null, 6, 3), // round won: score up, timer hidden
      hud(15, 15, 6, 3), // freeze time
      hud(20, 115, 6, 3), // action starts: timer reset
      hud(25, 110, 6, 3),
    ]);
    expect(starts).toEqual([12.5, 17.5]);
  });

  it('kills right after the score changes still belong to that round', () => {
    // as read from a real clip: bomb planted (timer hidden), round lost at ~97 s, an exit kill at 102 s
    const samples = [hud(35, 1, 11, 9), hud(40, 111, 11, 9), hud(60, 91, 11, 9), hud(65, null, 11, 9), hud(95, null, 11, 9), hud(100, null, 11, 10)];
    const a = analysis([kill(65.3), kill(86.3), kill(102)], roundStartsFrom(samples), samples);
    expect(a.roundStarts).toEqual([37.5]);
    expect(lastRoundKills(a)?.kills.map((k) => k.t)).toEqual([65.3, 86.3, 102]);
  });

  it('the kill that ends the round stays in it (restart countdown is not a new round)', () => {
    // as read from "Ace Dust2": the 5th kill ends the round, the next sample shows 5-7 and the 0:07 restart countdown
    const samples = [hud(0, null, 5, 6), hud(5, 16, 5, 6), hud(20, 1, 5, 6), hud(25, 111, 5, 6), hud(105, 31, 5, 6), hud(110, 7, 5, 7)];
    const a = analysis([kill(75), kill(75.1), kill(82), kill(93.8), kill(111)], roundStartsFrom(samples), samples);
    expect(a.roundStarts).toEqual([22.5]);
    expect(lastRoundKills(a)?.kills).toHaveLength(5);
  });

  it('freeze time after the restart countdown starts the next round', () => {
    expect(roundStartsFrom([hud(0, 30, 5, 6), hud(5, 4, 5, 7), hud(10, 18, 5, 7), hud(30, 115, 5, 7)])).toEqual([7.5, 20]);
  });

  it('unreadable samples are skipped, not counted as changes', () => {
    expect(roundStartsFrom([hud(0, 90, 2, 2), hud(5, null, null, null), hud(10, 80, 2, 2)])).toEqual([]);
  });

  it('reads the timer text', () => {
    expect(parseTimer('1:42')).toBe(102);
    expect(parseTimer('0:07')).toBe(7);
    expect(parseTimer('')).toBeNull();
  });
});

describe('last round', () => {
  it('keeps only the kills after the last round start', () => {
    const r = lastRoundKills(analysis([kill(10), kill(14), kill(70), kill(95)], [40]));
    expect(r?.start).toBe(40);
    expect(r?.kills.map((k) => k.t)).toEqual([70, 95]);
  });

  it('falls back to the previous round when the latest round has no kills', () => {
    const r = lastRoundKills(analysis([kill(10), kill(14), death(80)], [40, 100]));
    expect(r?.start).toBe(0);
    expect(r?.kills.map((k) => k.t)).toEqual([10, 14]);
    expect(r?.death).toBeNull(); // the death was in a later round
  });

  it('no kills: nothing to keep', () => {
    expect(lastRoundKills(analysis([death(30)]))).toBeNull();
  });
});

describe('bursts', () => {
  it('a gap longer than the burst gap starts a new piece', () => {
    expect(bursts([kill(10), kill(14), kill(40), kill(45)], 8).map((b) => b.map((k) => k.t))).toEqual([[10, 14], [40, 45]]);
  });
});

describe('clip moments and pieces', () => {
  it('one moment per burst, pieces with pre/post-roll on the timeline', () => {
    const a = analysis([kill(50, { headshot: true }), kill(53), kill(80)], [30]);
    const src = source('a', 200, a);
    const moments = clipMoments(src, 0, settings);
    expect(moments.map((m) => [m.label, m.at])).toEqual([
      ['2K (1 HS)', [250, 253]],
      ['1 kill', [280, 280]],
    ]);
    const clips = planSourceClips(moments, [src], settings);
    expect(clips.map((c) => [c.start, c.end])).toEqual([[247, 255], [277, 282]]);
    expect(clips[0].bounds).toEqual([200, 320]);
  });

  it('a piece never starts before the round or runs on after my death', () => {
    const a = analysis([kill(31), kill(60), death(61)], [30]);
    const src = source('a', 0, a);
    const clips = planSourceClips(clipMoments(src, 0, settings), [src], settings);
    expect(clips.map((c) => [c.start, c.end])).toEqual([[30, 33], [57, 62]]);
  });

  it('pieces stay inside their clip, and added footage never crosses into the next clip', () => {
    const first = source('a', 0, analysis([kill(118)]), 120);
    const second = source('b', 120, analysis([kill(1)]), 120);
    const sources = [first, second];
    const moments = sources.flatMap((s, i) => clipMoments(s, i, settings));
    const clips = planSourceClips(moments, sources, settings);
    expect(clips.map((c) => [c.round, c.start, c.end])).toEqual([[1, 115, 120], [2, 120, 123]]);
    const edited = applyEdits(clips, { cuts: [], splits: [], adds: [[100, 130]] });
    expect(edited.map((c) => [c.start, c.end])).toEqual([[100, 120], [120, 130]]);
  });

  it('cuts wait for a sentence to finish, but only inside the clip\'s own file', () => {
    const first = source('a', 0, analysis([kill(50), kill(116)]), 120);
    const second = source('b', 120, analysis([kill(3)]), 120);
    const sources = [first, second];
    const clips = planSourceClips(sources.flatMap((s, i) => clipMoments(s, i, settings)), sources, settings);
    // talking over the end of the first piece, past the end of the first clip, and over the start of the second clip
    const speech = { raw: [[50, 56], [115, 120], [120, 121]] as [number, number][], utterances: [[50, 56], [115, 120], [120, 121]] as [number, number][] };
    const out = protectSpeech(clips, speech, { speechMaxWait: 8, mergeGap: 1.5 }, 240);
    expect(out.map((c) => [c.start, c.end])).toEqual([[47, 56.25], [113, 120], [120, 125]]);
  });

  it('a disabled burst is left out', () => {
    const src = source('a', 0, analysis([kill(20), kill(60)]));
    const moments = clipMoments(src, 0, settings);
    moments[0].enabled = false;
    expect(planSourceClips(moments, [src], settings).map((c) => c.label)).toEqual(['1 kill']);
  });
});

describe('title cards', () => {
  it('uses the score read during the round', () => {
    const src = source('a', 0, analysis([kill(50), kill(52), kill(55)], [30], [hud(25, null, 7, 4), hud(35, 110, 7, 4)]));
    expect(clipCardText(src, 0, clipMoments(src, 0, settings))).toEqual({ title: 'Round 12', subtitle: '7 – 4 · 3K' });
  });

  it('falls back to the clip number', () => {
    const src = source('a', 0, analysis([kill(50)]));
    expect(clipCardText(src, 2, clipMoments(src, 2, settings)).title).toBe('Clip 3');
  });
});

describe('kill-feed shots', () => {
  it('besides each rise in the count, a shot every 2 s while red entries show; single-sample red is noise', () => {
    // 4 samples per second: noise at 1 s, entries from 5 s to 10 s (the count never rises for the 2nd entry)
    const counts = Array(48).fill(0);
    counts[4] = 1;
    for (let i = 20; i < 40; i++) counts[i] = 1;
    expect(feedShotTimes(counts, 4, [5], 12)).toEqual([5.5, 7.5, 9.5]);
  });

  it('drops shots too close together and stays inside the clip', () => {
    const counts = Array(16).fill(1);
    expect(feedShotTimes(counts, 4, [0.2, 3.9], 4)).toEqual([0.5, 2.5, 3.95]);
  });
});

describe('whose entry it is', () => {
  const raw = (killer: string, assister: string, victim: string): RawEntry => ({ killer, assister, victim, weapon: 'ak47', headshot: false });

  it('the name before the "+" made the kill, even with a teammate assisting', () => {
    // as seen in "1V5 Ace": TEYEcs + _father_ -> TonyMRGZ
    expect(classify(raw('TEYEcs', '_father_', 'TonyMRGZ'), 'TEYEcs')).toBe('kill');
    expect(classify(raw('_father_', 'TEYEcs', 'TonyMRGZ'), 'TEYEcs')).toBe('assist');
    expect(classify(raw('[66] Guapp_Real', '', 'TEYEcs'), 'TEYEcs')).toBe('death');
    expect(classify(raw('someone', '', 'else'), 'TEYEcs')).toBeNull();
  });

  it('matches names despite case, clan tags and one misread letter', () => {
    expect(sameName('[ViVa] TEYECS', 'TEYEcs')).toBe(true);
    expect(sameName('TEYEc5', 'TEYEcs')).toBe(true);
    expect(sameName('TEYE', 'TEYEcs')).toBe(false);
    expect(sameName('Zuhril', 'TEYEcs')).toBe(false);
  });

  it('without a (matching) name, me is whoever shows up in the most red entries', () => {
    const entries = [raw('TEYEcs', 'Abowd', 'a'), raw('TEYEcs', '', 'b'), raw('x', '', 'TEYEcs')];
    expect(whoIsMe(entries, '')).toBe('TEYEcs');
    expect(whoIsMe(entries, 'typo name')).toBe('TEYEcs');
  });
});

describe('kill-feed entries', () => {
  it('an entry still on screen in the next shot is not counted twice', () => {
    const e = (attacker: string, victim: string) => ({ kind: 'kill' as const, attacker, victim, weapon: '', headshot: false });
    const out = newEntries([
      { t: 10, entries: [e('me', 'a')] },
      { t: 13, entries: [e('me', 'a'), e('me', 'b')] },
      { t: 60, entries: [e('me', 'a')] }, // same names much later: another round
    ]);
    expect(out.map((x) => [x.t, x.victim])).toEqual([[10, 'a'], [13, 'b'], [60, 'a']]);
  });
});
