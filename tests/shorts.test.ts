import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutRound, LOOP_BLEND_S, loopOrder, matchShortClips, matchShortKills, matchShortRounds, sourceShortClips, sourceShortKills, sourceShortRounds } from '../server/shorts/plan.ts';
import { feedAlpha, feedImageRect, feedMargin, feedOnScreen, feedSlot, holdKills, holdsFeed, feedTextSize, feedTopPct, fitFeedScale, killfeedAss, weaponName } from '../server/shorts/killfeed.ts';
import { cleanEntry, findRedBoxes, grabFeedEntries, newBoxes, type Box } from '../server/shorts/feedgrab.ts';
import { readFileSync } from 'node:fs';
import { bandAspects, bandHeights, DEFAULT_SAFE_BOTTOM, fitLayout, gameplayTop, hasCamera, layoutBands, pipRect, webcamMode, overlayRect, resizeRect, safeBottom, shortFrame } from '../server/shorts/layout.ts';
import { shortGraph } from '../server/shorts/render.ts';
import { ABOVE_GAMEPLAY_GAP, lineWidth, placeTitle, TITLE_PRESETS, titleAss, titleBoxes, titlePreset, titleWarnings, titleWords, wrapTitle } from '../server/shorts/title.ts';
import { fontFile, fontMetrics } from '../server/captions/fonts.ts';
import { overlayGraph, renderReel, SOCIAL, socialEncodeArgs, socialFps, socialInfo } from '../server/edit/render.ts';
import { baseShortClips, readsKillfeed, shortKills, shortRounds, socialFrame, type Project } from '../server/project.ts';
import { clipMoments, planSourceClips } from '../server/clips/moments.ts';
import { applyEdits } from '../server/edit/edits.ts';
import { buildAss } from '../server/captions/ass.ts';
import { checkFfmpeg, probe, runFfmpeg } from '../server/util/ffmpeg.ts';
import { DEFAULT_SETTINGS, type Clip, type ClipAnalysis, type FeedEntry, type Kill, type MatchData, type Source, type SyncModel } from '../server/types.ts';

const TICKRATE = 64;
const k = (sec: number, extra: Partial<Kill> = {}): Kill => ({
  tick: sec * TICKRATE, round: 1, attacker: 'me', attackerName: 'me', attackerSide: 'T', victim: `v${sec}`, victimName: `v${sec}`, victimSide: 'CT',
  assister: null, assisterName: '', flashAssist: false, weapon: 'ak47', headshot: false, wallbang: false, noscope: false, throughSmoke: false, attackerBlind: false,
  ...extra,
});
const match = (kills: Kill[]): MatchData => ({
  demoPath: '', map: 'de_mirage', tickrate: TICKRATE, players: [],
  rounds: [
    { num: 1, startTick: 0, endTick: 100 * TICKRATE, winner: 'T', reason: '', roster: {}, score: null },
    { num: 2, startTick: 110 * TICKRATE, endTick: 200 * TICKRATE, winner: 'T', reason: '', roster: {}, score: null },
  ],
  kills, bombs: [], combat: [],
});
// the recording starts 10 s before the demo
const sync: SyncModel = { tickrate: TICKRATE, offset: 10, scale: 1, roundOffsets: {}, method: 'manual', inliers: 1, rmsError: 0, confident: true };
const info = { duration: 600, width: 1920, height: 1080, fps: '60/1', audio: [], encoding: { codec: 'h264', profile: null, pixFmt: 'yuv420p', bitRate: null, colorSpace: null, colorPrimaries: null, colorTransfer: null, colorRange: null } };

describe('cutting a round for a short', () => {
  it('keeps each fight and cuts the rotation between them', () => {
    // 2 quick kills, a long rotation, then the clutch kill
    const clips = matchShortClips(match([k(5), k(7), k(40)]), 'me', sync, 1, 600);
    expect(clips.map((c) => [c.start, c.end])).toEqual([
      [13, 18.5],
      [48, 54], // last kill gets extra for the reaction
    ]);
    expect(clips.map((c) => c.label)).toEqual(['2K', 'Kill']);
    // the editor can bring footage back from the round's start up to the next round's start (the reaction after it ends)
    expect(clips[0].bounds).toEqual([10, 120]);
  });

  it("leaves out teammates' kills, teamkills and other rounds", () => {
    const m = match([k(5), k(6, { attacker: 'mate' }), k(7, { victimSide: 'T' }), k(120, { round: 2 })]);
    expect(matchShortClips(m, 'me', sync, 1, 600)).toHaveLength(1);
  });

  it('kills closer than the gap stay one piece', () => {
    expect(cutRound([{ from: 10, at: 10 }, { from: 14, at: 16 }], 1, [0, 100], 2)).toHaveLength(1);
    expect(cutRound([{ from: 10, at: 10 }, { from: 20, at: 20 }], 1, [0, 100], 2)).toHaveLength(2);
  });

  it('a piece never leaves the round', () => {
    const [c] = cutRound([{ from: 1, at: 2 }], 1, [0.5, 3], 2);
    expect([c.start, c.end]).toEqual([0.5, 3]);
  });

  it('only rounds with 3+ of my kills get a short', () => {
    expect(matchShortRounds(match([k(5), k(7), k(40), k(120, { round: 2 })]), 'me')).toEqual([1]);
    expect(matchShortRounds(match([k(5), k(7)]), 'me')).toEqual([]);
  });

  it('edge drags bring back the cut rotation, up to the round', () => {
    const clips = matchShortClips(match([k(5), k(7), k(40)]), 'me', sync, 1, 600);
    const out = applyEdits(clips, { cuts: [], splits: [], adds: [[18.5, 30]] });
    expect(out[0].end).toBe(30);
  });
});

describe('clips mode shorts', () => {
  const kill = (t: number): FeedEntry => ({ t, kind: 'kill', attacker: 'me', victim: `v${t}`, weapon: 'ak47', headshot: false });
  const analysis = (entries: FeedEntry[], roundStarts: number[]): ClipAnalysis => ({ entries, hud: [], roundStarts, usage: { input: 0, output: 0 } });
  const src = (offset: number, a: ClipAnalysis): Source => ({ id: 's', path: 's.mp4', name: 's', offset, analysis: a, info: { ...info, duration: 120 } });

  it("uses the clip's last round, with a longer run-up (the kill feed is read late)", () => {
    // a kill before the round started belongs to the round before
    const clips = sourceShortClips(src(100, analysis([kill(10), kill(30), kill(33), kill(70)], [20])), 2);
    expect(clips.map((c) => [c.start, c.end, c.round])).toEqual([
      [126, 134.5, 2],
      [166, 174, 2],
    ]);
    expect(clips[0].bounds).toEqual([120, 220]);
  });

  it('clips with 3+ kills in their last round get a short, numbered like the clips', () => {
    const three = analysis([kill(30), kill(33), kill(70)], []);
    const two = analysis([kill(30), kill(33)], []);
    expect(sourceShortRounds([src(0, two), src(120, three)])).toEqual([2]);
  });
});

describe('short layout', () => {
  // the webcam in its own band above the gameplay
  const banded = { ...DEFAULT_SETTINGS.shortLayout, webcam: 'band' as const };
  it('turns the frame on its side: same pixel count, so the source bitrate fits', () => {
    expect(shortFrame({ width: 1920, height: 1080 })).toEqual({ width: 1080, height: 1920 });
    expect(bandHeights({ width: 1080, height: 1920 }, 0.35)).toEqual({ camera: 672, top: 0, gameplay: 1248, safe: 0 });
  });

  it('keeps a bottom band clear of the gameplay, never squeezing the gameplay too small', () => {
    const frame = { width: 1080, height: 1920 };
    expect(bandHeights(frame, 0.35, 0.15)).toEqual({ camera: 672, top: 0, gameplay: 960, safe: 288 });
    // a tall camera: the band gives way so the gameplay keeps a quarter of the height
    expect(bandHeights(frame, 0.6, 0.3)).toEqual({ camera: 1152, top: 0, gameplay: 480, safe: 288 });
    // a layout from before the band gets the default one; 0 turns it off
    expect(safeBottom({})).toBe(DEFAULT_SAFE_BOTTOM);
    expect(safeBottom({ bottom: 0 })).toBe(0);
  });

  it("fits each box to its band's shape, so nothing stretches", () => {
    const video = { width: 1920, height: 1080 };
    const l = fitLayout({ ...banded, split: 0.4 }, video);
    const a = bandAspects(video, l.split, safeBottom(l));
    expect(l.bottom).toBeCloseTo(0.15, 2);
    expect((l.camera.w * 1920) / (l.camera.h * 1080)).toBeCloseTo(a.camera, 3);
    expect((l.gameplay.w * 1920) / (l.gameplay.h * 1080)).toBeCloseTo(a.gameplay, 3);
    for (const r of [l.camera, l.gameplay]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('resizing keeps the shape and stays in the frame', () => {
    const r = resizeRect({ x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, 0.9, 1080 / 672, { width: 1920, height: 1080 });
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('the ffmpeg graph crops both regions and stacks them at the band sizes', () => {
    const g = shortGraph({ ...banded, bottom: 0 }, info, { width: 1080, height: 1920 });
    expect(g).toContain('scale=1080:672');
    expect(g).toContain('scale=1080:1248');
    expect(g.endsWith('[cam][game]vstack=inputs=2')).toBe(true);
  });

  it('fills the bottom band with the gameplay’s bottom, mirrored down and blurred', () => {
    const g = shortGraph(banded, info, { width: 1080, height: 1920 });
    expect(g).toContain('scale=1080:960');
    // the last 288 rows of the 960-row gameplay band, flipped so they run on from its edge
    expect(g).toContain('[gbot]crop=1080:288:0:672,vflip,gblur=sigma=22,');
    expect(g).toMatch(/\[cam\]\[game\]\[safe\]vstack=inputs=3$/);
  });

  it('with no webcam: the gameplay between a top and a bottom safe band, both its edges mirrored and blurred', () => {
    const frame = { width: 1080, height: 1920 };
    const video = { width: 1920, height: 1080 };
    const off = fitLayout({ ...banded, webcam: 'off' }, video);
    // 15 % top band, 15 % bottom band, the gameplay in between
    expect(layoutBands(frame, off)).toEqual({ camera: 0, top: 288, gameplay: 1344, safe: 288 });
    expect(gameplayTop(frame, off)).toBeCloseTo(0.15, 3);
    // its box takes the taller band's shape, keeping its bottom (the HUD)
    expect((off.gameplay.w * 1920) / (off.gameplay.h * 1080)).toBeCloseTo(1080 / 1344, 3);
    const g = shortGraph(off, info, frame);
    expect(g).not.toContain('[cam]');
    expect(g).toContain('scale=1080:1344');
    expect(g).toContain('split=3[game][gtop][gbot]');
    expect(g).toContain('[gtop]crop=1080:288:0:0,vflip,gblur=sigma=22,'); // the top 288 rows, flipped up
    expect(g).toContain('[gbot]crop=1080:288:0:1056,vflip,');
    expect(g.endsWith('[top][game][safe]vstack=inputs=3')).toBe(true);
    // the top band can be set, or turned off (the gameplay then starts at the very top)
    expect(layoutBands(frame, { ...off, top: 0.1 }).top).toBe(192);
    expect(shortGraph({ ...off, top: 0 }, info, frame).endsWith('[game][safe]vstack=inputs=2')).toBe(true);
    expect(shortGraph({ ...off, top: 0, bottom: 0 }, info, frame).endsWith('[game]null')).toBe(true);
    // the camera's framing is kept while it's off, and comes back with it
    const on = fitLayout({ ...off, webcam: 'band' }, video);
    expect(on.noCamera).toBeUndefined();
    expect(on.split).toBeCloseTo(0.35, 2);
    expect(layoutBands(frame, on)).toEqual({ camera: 672, top: 0, gameplay: 960, safe: 288 });
    // no webcam is the default; a layout from before the choice keeps its band (or none, from noCamera)
    expect(webcamMode(DEFAULT_SETTINGS.shortLayout)).toBe('off');
    const { webcam: _, ...older } = banded;
    expect(hasCamera(older)).toBe(true);
    expect(webcamMode({ ...older, noCamera: true })).toBe('off');
  });

  it('a floating webcam: the no-webcam bands, with the camera in a rounded, bordered box on top, anywhere', () => {
    const frame = { width: 1080, height: 1920 };
    const video = { width: 1920, height: 1080 };
    // a 16:9 camera crop
    const float = fitLayout({ ...banded, webcam: 'float', camera: { x: 0, y: 0.6, w: 0.3, h: 0.3 }, pip: { x: 0.5, y: 0.5, w: 0.4 } }, video);
    expect(float.camera).toEqual({ x: 0, y: 0.6, w: 0.3, h: 0.3 }); // any shape: not reshaped to a band
    expect(layoutBands(frame, float)).toEqual(layoutBands(frame, { ...float, webcam: 'off' }));
    // 40 % of the width, its height from the crop's shape (16:9), where it was put
    expect(pipRect(float, frame, video)).toEqual({ x: 540, y: 960, w: 432, h: 244 });
    // kept inside the frame, and never too small or too big
    expect(pipRect({ ...float, pip: { x: 0.95, y: 0.99, w: 0.4 } }, frame, video)).toMatchObject({ x: 1080 - 432, y: 1920 - 244 });
    expect(pipRect({ ...float, pip: { x: 0, y: 0, w: 0.01 } }, frame, video)!.w).toBe(Math.round(1080 * 0.12 / 2) * 2);
    // only when it floats; where it was is kept for when it floats again
    expect(pipRect({ ...float, webcam: 'off' }, frame, video)).toBeNull();
    expect(fitLayout({ ...float, webcam: 'off' }, video).pip).toEqual({ x: 0.5, y: 0.5, w: 0.4 });
    // floating for the first time: the gameplay's top left
    expect(fitLayout({ ...banded, webcam: 'float' }, video).pip).toEqual({ x: 0.04, y: 0.17, w: 0.34 });

    const g = shortGraph(float, info, frame);
    expect(g).toContain('[top][game][safe]vstack=inputs=3[base]');
    expect(g).toContain(',scale=432:244:flags=lanczos,setsar=1,split=6');
    // the masks are made once (from the first frame), with rounded corners
    expect(g).toMatch(/\[cm\]trim=end_frame=1,scale=432:244,format=gray,geq=lum='255\*clip\(20\+0\.5-hypot/);
    // shadow, then the white border 4 px wider each side, then the camera
    expect(g).toContain('[b1][pipborder]overlay=x=536:y=956[b2]');
    expect(g.endsWith('[b2][pipcam]overlay=x=540:y=960')).toBe(true);
  });

  it('captions are placed in the vertical frame', () => {
    const lines = [{ id: 'a', start: 1, end: 2, lang: 'en' as const, source: 'hi', words: [{ start: 1, end: 1.5, text: 'nice' }] }];
    const ass = buildAss(lines, { start: 0, end: 5 }, { width: 1080, height: 1920 }, { ...DEFAULT_SETTINGS.captions, ...DEFAULT_SETTINGS.shortCaptions }, 'Montserrat Black')!;
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('\\pos(540,672)'); // 35 % down: on the line between camera and gameplay
  });
});

describe("a short's kill feed", () => {
  const frame = { width: 1080, height: 1920 };
  const feed = (at: number, victim: string) => ({ at, attacker: 'me', victim, weapon: 'ak47', headshot: true });
  const dialogues = (ass: string | null) => (ass ?? '').split('\n').filter((l) => l.startsWith('Dialogue: 1,'));

  it('my kills from the demo, at their recording times, with the game details', () => {
    const [kill] = matchShortKills(match([k(5, { headshot: true, wallbang: true })]), 'me', sync, 1);
    expect(kill).toMatchObject({ at: 15, attacker: 'me', victim: 'v5', weapon: 'ak47', headshot: true, wallbang: true });
  });

  it('clips mode: kills read off the screen, moved back to when the entry appeared', () => {
    const src: Source = {
      id: 's', path: 's.mp4', name: 's', offset: 100, info: { ...info, duration: 120 },
      analysis: { entries: [{ t: 30, kind: 'kill', attacker: 'me', victim: 'x', weapon: 'awp', headshot: false }], hud: [], roundStarts: [], usage: { input: 0, output: 0 } },
    };
    expect(sourceShortKills(src)).toEqual([{ at: 129.5, attacker: 'me', victim: 'x', weapon: 'awp', headshot: false }]);
  });

  it('a kill stays up for the rest of the short; the next one slides in below it', () => {
    const kills = [feed(12, 'first'), feed(25, 'second'), feed(60, 'later')];
    // a piece from 20 to 30 s: the first kill is already up, the second slides in at 5 s, the third isn't yet
    const rows = dialogues(killfeedAss(kills, { start: 20, end: 30 }, frame, 37));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^Dialogue: 1,0:00:00\.00,0:00:10\.00,.*\\pos\(/);
    expect(rows[1]).toMatch(/^Dialogue: 1,0:00:05\.00,0:00:10\.00,.*\\move\(.*\\fad\(/);
    expect(rows[0]).toContain('AK-47  HS');
    const y = (r: string) => Number(/\\(?:pos|move)\(\d+,(\d+)/.exec(r)![1]);
    expect(y(rows[1])).toBeGreaterThan(y(rows[0]));
    // before any kill: no feed at all
    expect(killfeedAss(kills, { start: 0, end: 10 }, frame, 37)).toBeNull();
  });

  it('sits just under the camera unless placed', () => {
    expect(feedTopPct(null, 0.35)).toBe(37);
    expect(feedTopPct(10, 0.35)).toBe(10);
  });

  it('shows weapon names as the game does', () => {
    expect(weaponName('m4a1_silencer')).toBe('M4A1-S');
    expect(weaponName('weapon_ak47')).toBe('AK-47');
    expect(weaponName('knife_karambit')).toBe('Knife');
    expect(weaponName('usp-s')).toBe('USP-S');
  });
});

describe.skipIf(!checkFfmpeg().ok)('rendering a short', () => {
  it('comes out 9:16 with the source codec, frame rate and every audio track', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs2h-short-'));
    const src = join(dir, 'src.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=12',
      '-f', 'lavfi', '-i', 'sine=f=440:d=12:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=f=880:d=12:sample_rate=48000',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-ac', '2', '-c:v', 'libx264', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src,
    ]);
    const srcInfo = probe(src);
    const frame = shortFrame(srcInfo);
    const out = join(dir, 'short.mp4');
    // a cut-out kill-feed entry, laid over the second piece (sliding in) and the first (already up)
    const entry = join(dir, 'entry.png');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=400x40', '-frames:v', '1', entry]);
    const rect = feedImageRect({ w: 400, h: 40 }, 0, frame, 37);
    await renderReel({
      videoPath: src,
      info: srcInfo,
      clips: [
        { round: 1, start: 1, end: 4, momentIds: [], label: '' },
        { round: 1, start: 7, end: 10, momentIds: [], label: '' },
      ],
      cards: new Map(),
      outPath: out,
      workDir: join(dir, 'work'),
      frame: {
        ...frame,
        graph: (s) => shortGraph(DEFAULT_SETTINGS.shortLayout, s, frame),
        overlays: (c) => [{ file: entry, from: 2 - c.start, ...rect }],
      },
      // a drawn row (a kill whose entry wasn't found) burns in on the stacked frame too
      captions: (c) => [killfeedAss([{ at: 2, attacker: 'me', victim: 'enemy', weapon: 'awp', headshot: true }], c, frame, 50), null],
    });
    const r = probe(out);
    expect([r.width, r.height, r.fps, r.encoding.codec]).toEqual([1080, 1920, '60/1', 'h264']);
    // the entry is on screen in the second piece (3 s in)
    const px = join(dir, 'px.rgb');
    await runFfmpeg(['-ss', '4', '-i', out, '-frames:v', '1', '-vf', `crop=2:2:${rect.x + rect.w / 2}:${rect.y + rect.h / 2}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', px]);
    const [red, green] = readFileSync(px);
    expect(red).toBeGreaterThan(200);
    expect(green).toBeLessThan(60);
    expect(r.audio).toHaveLength(2);
    expect(Math.abs(r.duration - 6)).toBeLessThan(0.3);
  }, 300_000);
});

describe("finding the game's own kill-feed entries", () => {
  /** an RGB image with red-outlined boxes drawn in */
  function image(w: number, h: number, boxes: Box[]) {
    const rgb = new Uint8Array(w * h * 3).fill(40);
    const red = (x: number, y: number) => rgb.set([220, 30, 40], (y * w + x) * 3);
    for (const b of boxes) {
      for (let x = b.x0; x <= b.x1; x++) for (const y of [b.y0, b.y0 + 1, b.y1 - 1, b.y1]) red(x, y);
      for (let y = b.y0; y <= b.y1; y++) for (const x of [b.x0, b.x1]) red(x, y);
    }
    return rgb;
  }

  it('finds each red-outlined entry, top to bottom', () => {
    const boxes = [
      { x0: 300, y0: 20, x1: 760, y1: 58 },
      { x0: 420, y0: 66, x1: 760, y1: 104 },
    ];
    expect(findRedBoxes(image(768, 300, boxes), 768, 300, 1440)).toEqual(boxes);
  });

  it("ignores red that isn't an entry's outline", () => {
    const rgb = image(768, 300, [{ x0: 300, y0: 20, x1: 760, y1: 200 }]); // far too tall for an entry
    expect(findRedBoxes(rgb, 768, 300, 1440)).toEqual([]);
  });

  it('tells the new entry by its width, even when the feed moved up', () => {
    const old = { x0: 450, y0: 66, x1: 760, y1: 104 };
    const moved = { ...old, y0: 20, y1: 58 };
    const fresh = { x0: 380, y0: 66, x1: 760, y1: 104 };
    expect(newBoxes([{ x0: 300, y0: 20, x1: 760, y1: 58 }, old], [moved, fresh])).toEqual([fresh]);
  });

  it('a cut-out entry sits in its row, right-aligned and scaled to the row height', () => {
    const r = feedImageRect({ w: 400, h: 40 }, 1, { width: 1080, height: 1920 }, 37);
    expect(r.x + r.w).toBe(Math.round(1080 * (1 - 0.035)));
    expect(r.h).toBeGreaterThan(70);
    expect(r.w / r.h).toBeCloseTo(10, 0);
    expect(r.y).toBeGreaterThan(Math.round(1920 * 0.37));
  });
});

describe('kill-feed size', () => {
  const frame = { width: 1080, height: 1920 };
  it('scales the entries and the gaps between rows together', () => {
    const normal = feedImageRect({ w: 300, h: 40 }, 1, frame, 37);
    const big = feedImageRect({ w: 300, h: 40 }, 1, frame, 37, 1.5);
    expect(big.h / normal.h).toBeCloseTo(1.5, 1);
    expect(big.y - 1920 * 0.37).toBeCloseTo((normal.y - 1920 * 0.37) * 1.5, -1);
  });

  it('scales drawn rows too', () => {
    const kill = [{ at: 1, attacker: 'me', victim: 'x', weapon: 'ak47', headshot: false }];
    const fontSize = (ass: string | null) => Number(/Style: Feed,Arial,(\d+)/.exec(ass ?? '')![1]);
    expect(fontSize(killfeedAss(kill, { start: 0, end: 5 }, frame, 37, undefined, 0.5))).toBe(Math.round(fontSize(killfeedAss(kill, { start: 0, end: 5 }, frame, 37)) / 2));
  });

  it('stays within 50–200 %', () => {
    expect(feedImageRect({ w: 40, h: 40 }, 0, frame, 37, 10).h).toBe(feedImageRect({ w: 40, h: 40 }, 0, frame, 37, 2).h);
  });
});

describe('kill-feed size when entries are wide', () => {
  const frame = { width: 1080, height: 1920 };
  it('shrinks the whole feed together so the widest entry fits and rows stay one height', () => {
    const images = [{ w: 300, h: 40 }, { w: 520, h: 40 }];
    const s = fitFeedScale(images, frame, 2);
    expect(s).toBeLessThan(2);
    const rows = images.map((img, i) => feedImageRect(img, i, frame, 37, s));
    expect(rows[1].w).toBeLessThanOrEqual(1080 * 0.93 + 2);
    expect(rows[0].h).toBe(rows[1].h);
    expect(fitFeedScale(images, frame, 0.8)).toBe(0.8);
  });
});

describe('cleaning a cut-out entry', () => {
  it('cuts exactly at the outline and gives it one dark background, keeping the text', () => {
    const w = 60;
    const h = 30;
    const rgb = new Uint8Array(w * h * 3);
    const set = (x: number, y: number, c: number[]) => rgb.set(c, (y * w + x) * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, [55, 70, 98]); // sky showing through the entry's dark background
    const box = { x0: 5, y0: 4, x1: 54, y1: 25 };
    for (let x = box.x0; x <= box.x1; x++) for (const y of [4, 5, 24, 25]) set(x, y, [220, 30, 40]);
    for (let y = box.y0; y <= box.y1; y++) for (const x of [5, 6, 53, 54]) set(x, y, [220, 30, 40]);
    set(20, 14, [255, 255, 255]); // a letter
    const e = cleanEntry(rgb, w, box);
    expect([e.w, e.h]).toEqual([50, 22]);
    const at = (x: number, y: number) => [...e.data.subarray((y * e.w + x) * 3, (y * e.w + x) * 3 + 3)];
    expect(at(10, 10)).toEqual([18, 18, 20]); // background: the same dark everywhere
    expect(at(15, 10)).toEqual([255, 255, 255]); // the letter stays
    expect(at(0, 0)).toEqual([220, 30, 40]); // the outline
    expect(at(e.w - 1, e.h - 1)).toEqual([220, 30, 40]);
  });
});

describe.skipIf(!checkFfmpeg().ok)('cutting an entry out of the recording', () => {
  it("waits out a flashbang: the entry is cut from a frame where it's clear, not washed out", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs2h-flash-'));
    const src = join(dir, 'src.mp4');
    const entry = "enable='gte(t,1)'";
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=0x808080:s=1280x720:r=30:d=5',
      '-vf', [
        // my entry from 1 s: a red outline, some white text and a dark background,
        // washed out to light grey while I'm flashed (until 2.5 s; the outline still shows)
        `drawbox=x=900:y=60:w=300:h=30:color=0x121214:t=fill:${entry}`,
        "drawbox=x=900:y=60:w=300:h=30:color=0xC8C8C8:t=fill:enable='between(t,1,2.5)'",
        `drawbox=x=900:y=60:w=300:h=30:color=red:t=2:${entry}`,
        `drawbox=x=960:y=70:w=120:h=10:color=white:t=fill:${entry}`,
      ].join(','),
      '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-qp', '0', src,
    ]);
    const info = probe(src);
    const [img] = await grabFeedEntries(
      [{ at: 1, attacker: 'me', victim: 'x', weapon: 'ak47', headshot: false }],
      () => ({ path: src, info, offset: 0 }),
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      join(dir, 'cache'),
    );
    expect(img).not.toBeNull();
    expect(img!.w).toBeGreaterThan(290); // the whole entry
    const raw = join(dir, 'entry.rgb');
    await runFfmpeg(['-i', img!.file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]);
    const rgb = readFileSync(raw);
    const i = (Math.floor(img!.h / 2) * img!.w + 20) * 3; // background, left of the text
    expect(Math.max(rgb[i], rgb[i + 1], rgb[i + 2])).toBeLessThan(60);
  }, 120_000);
});

describe("a short's title", () => {
  const frame = { width: 1080, height: 1920 };
  const style = { preset: 'bold', sizePct: 5, positionPct: 10 };
  // every character half an em wide: a 96 px title fits 0.86 × 1080 / 48 = 19 characters a line
  const font = { scale: 1, width: (t: string) => t.length * 0.5 };
  const events = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => l.slice(l.indexOf('{')));

  it('is up for the whole piece, its top centred where asked, one line per line typed', () => {
    const ass = titleAss('ace on ancient\n  1v4 clutch ', style, 75.5, frame, 'Montserrat Black', font)!;
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:01:15.50,Title,');
    // one line under the other, a text size apart
    expect(events(ass)).toEqual(['{\\an8\\pos(540,192)}ACE ON ANCIENT', '{\\an8\\pos(540,288)}1V4 CLUTCH']);
    // 5 % of 1920 px; white with a thin TEYE-black outline (6 % of the size) and a soft shadow (45 % see-through)
    expect(ass).toContain('Style: Title,Montserrat Black,96,&H00FFFFFF,&H00FFFFFF,&H000D0B0B,&H730D0B0B,0,0,0,0,100,100,0,0,1,6,5,8,');
  });

  it('breaks a long line between words where it gets too wide, and spaces lines by the line height', () => {
    const ass = titleAss('ace on ancient no mercy at all', { ...style, lineHeight: 1.5 }, 10, frame, 'Anton', font)!;
    expect(events(ass)).toEqual(['{\\an8\\pos(540,192)}ACE ON ANCIENT NO', '{\\an8\\pos(540,336)}MERCY AT ALL']);
    // a word too wide for a line keeps one to itself
    expect(wrapTitle('a supercalifragilisticexpialidocious b', style, frame, font)).toEqual(['A', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'B']);
    // the export draws a font's letters `scale` times the size: smaller letters fit more a line
    expect(wrapTitle('ace on ancient no mercy at all', style, frame, { ...font, scale: 0.5 })).toEqual(['ACE ON ANCIENT NO MERCY AT ALL']);
  });

  it('word spacing stretches each space (in the export and when wrapping)', () => {
    const wide = { ...style, wordSpacing: 3 };
    // a space is now 1.5 em, not 0.5: fewer words fit a line
    expect(wrapTitle('ace on ancient no mercy at all', wide, frame, font)).toEqual(['ACE ON ANCIENT', 'NO MERCY AT', 'ALL']);
    expect(events(titleAss('ace on ancient', wide, 10, frame, 'Anton', font)!)).toEqual(['{\\an8\\pos(540,192)}ACE{\\fscx300} {\\fscx100}ON{\\fscx300} {\\fscx100}ANCIENT']);
    expect(lineWidth('A B', { ...style, wordSpacing: 0.5 }, font)).toBeCloseTo(1.25); // 0.5 + 0.25 + 0.5
  });

  it('a box preset draws a rounded box under each line, around its capitals, in capitals', () => {
    const ass = titleAss('Ace on Ancient', { ...style, preset: 'banner' }, 10, frame, 'Anton', font)!;
    // the box: 7 em of letters (672 px) + a 0.26-size pad each side, from 0.17 size above the capitals
    // (baseline 0.8 of the line down, capitals 0.7 em tall) to as far below the baseline
    expect(events(ass)[0]).toMatch(/^\{\\an7\\pos\(179,185\)\\bord0\\shad4\\1c&H2E12B3&\\4c&H0D0B0B&\\4a&HB3&\\p1\}m 15 0 l 707 0 b /);
    expect(ass).toMatch(/^Dialogue: 0,.*\{\\p0\}$/m); // under the letters (layer 0)
    expect(events(ass)[1]).toBe('{\\an8\\pos(540,192)}ACE ON ANCIENT');
    // letters: white, no outline and no shadow of their own
    expect(ass).toContain(',&H00FFFFFF,&H00FFFFFF,&H00000000,&HB30D0B0B,0,0,0,0,100,100,0,0,1,0,0,8,');
    expect(titleBoxes(['ACE'], { ...style, preset: 'banner' }, frame, font)[0]).toMatchObject({ y: expect.closeTo(185.28), h: expect.closeTo(99.84) });
    // the White Box is compact: a 0.08-size pad above and below the capitals, 0.18 sideways
    expect(titleBoxes(['ACE'], { ...style, preset: 'box' }, frame, font)[0]).toMatchObject({ w: expect.closeTo(144 + 2 * 17.28), h: expect.closeTo(67.2 + 2 * 7.68) });
    // one line per box, a line height apart
    const two = titleBoxes(['A', 'B'], { ...style, preset: 'box', lineHeight: 0.85 }, frame, font);
    expect(two[1].y - two[0].y).toBeCloseTo(96 * 0.85);
  });

  it('every preset uses the one condensed TEYE font, and no text means no title', () => {
    expect(new Set(TITLE_PRESETS.map((p) => p.font))).toEqual(new Set(['Anton']));
    expect(TITLE_PRESETS.map((p) => p.name)).toEqual(['Bold White', 'White Box', 'TEYE Yellow', 'Comic Pop', 'TEYE Red Banner']);
    for (const p of TITLE_PRESETS) expect(fontFile(p.font)).not.toBeNull();
    expect(titleAss(' \n ', style, 10, frame, 'Anton', font)).toBeNull();
    expect(titleAss('** *', style, 10, frame, 'Anton', font)).toBeNull();
    // saved settings keep their preset ids; an unknown one is Bold White
    expect(titlePreset('gamer').name).toBe('TEYE Yellow');
    expect(titlePreset('gone').id).toBe('bold');
  });

  it('*starred* words show in the preset accent, nothing else is coloured', () => {
    expect(titleWords('THAT WAS *INSANE!*')).toEqual([
      { text: 'THAT', em: false },
      { text: 'WAS', em: false },
      { text: 'INSANE!', em: true },
    ]);
    // across words, glued to a word, and a star with no partner kept as typed
    expect(titleWords('*four headshots* *4*K 5*').map((w) => [w.text, w.em])).toEqual([['four', true], ['headshots', true], ['4K', true], ['5*', false]]);
    // stars aren't drawn, so they don't count when wrapping
    expect(lineWidth('*AB*', style, font)).toBe(1);
    expect(wrapTitle('*four headshots*', style, frame, font)).toEqual(['*FOUR* *HEADSHOTS*']);
    // Bold White: crimson, then back to white
    expect(events(titleAss('no *way!*', style, 10, frame, 'Anton', font)!)).toEqual(['{\\an8\\pos(540,192)}NO {\\c&H3A22E3&}WAY!{\\c&HFFFFFF&}']);
    // the banner's accent is yellow; without stars there are no colour changes
    expect(titleAss('clutch *won*', { ...style, preset: 'banner' }, 10, frame, 'Anton', font)).toContain('{\\c&H1CB8FF&}WON'); // #FFB81C, a warm yellow
    expect(titleAss('clutch won', style, 10, frame, 'Anton', font)).not.toContain('\\c&H');
    // word spacing still stretches the spaces
    expect(events(titleAss('a *b*', { ...style, wordSpacing: 2 }, 10, frame, 'Anton', font)!)[0]).toContain('A{\\fscx200} {\\fscx100}{\\c&H3A22E3&}B');
  });

  it('Comic Pop tilts the whole title about its middle, over a hard crimson pop', () => {
    const ass = titleAss('no\nway', { ...style, preset: 'comic' }, 10, frame, 'Anton', font)!;
    const [a, b] = events(ass);
    // a slight lean (1.5°), anticlockwise
    const org = /\\org\(540,(\d+)\)\\frz1\.5/;
    expect(a).toMatch(org);
    expect(org.exec(a)![1]).toBe(org.exec(b)![1]);
    expect(ass).toContain(',&H002E12B3,0,0,0,0,'); // the shadow: solid deep crimson
  });

  it('warns where the title is hard to see or in the way', () => {
    const bands = { split: 0.35, bottom: 0.15 };
    expect(titleWarnings({ top: 0.32, bottom: 0.38 }, bands)).toEqual([]);
    expect(titleWarnings({ top: 0.02, bottom: 0.08 }, bands)).toEqual([expect.stringMatching(/top/)]);
    expect(titleWarnings({ top: 0.8, bottom: 0.86 }, bands)).toEqual([expect.stringMatching(/YouTube/)]);
    // the crosshair: the middle of the gameplay, between 0.35 and 0.85
    expect(titleWarnings({ top: 0.57, bottom: 0.63 }, bands)).toEqual(['Over the crosshair']);
    expect(titleWarnings({ top: 0.36, bottom: 0.4 }, bands, { top: 0.37, bottom: 0.45 })).toEqual(['Over the kill feed']);
  });

  it('kept above the gameplay: its bottom just over where the gameplay starts, in every short', () => {
    const above = { ...style, aboveGameplay: true };
    for (const seam of [0.3, 0.4]) {
      for (const text of ['ace', 'ace\non ancient']) {
        const placed = placeTitle(text, above, frame, font, seam);
        const boxes = titleBoxes(wrapTitle(text, placed, frame, font), placed, frame, font);
        const bottom = boxes.at(-1)!.y + boxes.at(-1)!.h;
        expect(bottom / 1920).toBeCloseTo(seam - ABOVE_GAMEPLAY_GAP, 3);
      }
    }
    // too tall for the camera band: stops at the safe top
    const tall = placeTitle('a\nb\nc\nd\ne\nf\ng', above, frame, font, 0.2);
    expect(titleBoxes(['A'], tall, frame, font)[0].y / 1920).toBeCloseTo(0.05, 3);
    // placed by hand: as set
    expect(placeTitle('ace', style, frame, font, 0.3)).toBe(style);
  });

  it('the TEYE defaults: big enough for a phone, kept above the gameplay, clear of the crosshair', () => {
    expect(DEFAULT_SETTINGS.shortTitle).toEqual({ preset: 'bold', sizePct: 6.5, positionPct: 32, lineHeight: 0.85, wordSpacing: 1, aboveGameplay: true });
    const anton = fontMetrics('Anton');
    expect(anton.cap).toBeGreaterThan(0.6);
    expect(anton.ascent).toBeGreaterThan(0.5);
    const lines = wrapTitle('that was *insane!*', DEFAULT_SETTINGS.shortTitle, frame, anton);
    expect(lines).toEqual(['THAT WAS *INSANE!*']);
    // over the default layout: just above the gameplay, nothing in the way
    const seam = bandHeights(frame, 0.35, 0.15).camera / 1920;
    const placed = placeTitle('that was *insane!*', DEFAULT_SETTINGS.shortTitle, frame, anton, seam);
    const [box] = titleBoxes(lines, placed, frame, anton);
    expect(box.w).toBeLessThan(1080 * 0.86);
    expect((box.y + box.h) / 1920).toBeLessThan(seam);
    expect(titleWarnings({ top: box.y / 1920, bottom: (box.y + box.h) / 1920 }, { split: 0.35, bottom: 0.15 })).toEqual([]);
  });

  it("measures a font from its file: the export's letter size and each glyph's width", () => {
    const m = fontMetrics('Montserrat Black');
    expect(m.scale).toBeCloseTo(1000 / 1562, 3); // em / (win ascent + descent)
    expect(m.width('MMMM')).toBeCloseTo(4 * m.width('M'), 6);
    expect(m.width('M')).toBeGreaterThan(m.width('I'));
  });
});

describe('a clip made straight into a short', () => {
  const src = { id: 'a', path: 'c.mp4', name: 'clutch', info: { ...info, duration: 42 }, offset: 0, analysis: null };
  const p = { mode: 'clips', direct: true, sources: [src], settings: DEFAULT_SETTINGS, video: src.info, speech: null } as unknown as Project;

  it('is one short, the whole clip, before its kill feed is read (and with no kills found)', () => {
    expect(shortRounds(p)).toEqual([1]);
    expect(baseShortClips(p, 1)).toEqual([{ round: 1, start: 0, end: 42, momentIds: [], label: 'clutch', bounds: [0, 42] }]);
    expect(shortKills(p, 1)).toEqual([]);
    // an ordinary clips project with that clip unread has no short
    expect(shortRounds({ ...p, direct: false })).toEqual([]);
  });
});

describe('clips of any game (kill feed not read)', () => {
  const a = { id: 'a', path: 'a.mp4', name: 'heist', info: { ...info, duration: 30 }, offset: 0, analysis: null };
  const b = { id: 'b', path: 'b.mp4', name: 'chase', info: { ...info, duration: 20 }, offset: 30, analysis: null };
  const p = { mode: 'clips', readKillfeed: false, sources: [a, b], settings: DEFAULT_SETTINGS, video: { ...info, duration: 50 }, speech: null, moments: [] } as unknown as Project;

  it('every clip is used whole, nothing read', () => {
    const moments = [a, b].flatMap((s, i) => clipMoments(s, i, DEFAULT_SETTINGS, false));
    expect(moments.map((m) => [m.kind, m.label, m.at, m.round])).toEqual([
      ['clip', 'heist', [0, 30], 1],
      ['clip', 'chase', [30, 50], 2],
    ]);
    // the pre/post roll never reaches past a clip's ends
    expect(planSourceClips(moments, [a, b], DEFAULT_SETTINGS).map((c) => [c.start, c.end])).toEqual([[0, 30], [30, 50]]);
  });

  it('every clip can be a short: all of it, no kill feed', () => {
    expect(shortRounds(p)).toEqual([1, 2]);
    expect(baseShortClips(p, 2)).toEqual([{ round: 2, start: 30, end: 50, momentIds: [], label: 'chase', bounds: [30, 50] }]);
    expect(shortKills(p, 2)).toEqual([]);
    // read (CS2) is what older clips projects do
    expect(readsKillfeed({ mode: 'clips' })).toBe(true);
    expect(readsKillfeed(p)).toBe(false);
    expect(readsKillfeed({ mode: 'match' })).toBe(false);
  });
});

describe('a short for Instagram, TikTok and Facebook', () => {
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('is 1080 wide, the same 9:16 shape, whatever the recording', () => {
    expect(socialFrame({ width: 1440, height: 2560 })).toEqual({ width: 1080, height: 1920 });
    expect(socialFrame({ width: 2160, height: 3840 })).toEqual({ width: 1080, height: 1920 });
    expect(socialFrame({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
  });

  it('keeps the frame rate up to 60, and only the first audio track (the mix)', () => {
    expect(socialFps('60/1')).toBe('60/1');
    expect(socialFps('30/1')).toBe('30/1');
    expect(socialFps('120/1')).toBe('60/1');
    expect(socialFps('60000/1001')).toBe('60000/1001');
    const tracks = [1, 2, 3].map((n) => ({ index: n, codec: 'aac', sampleRate: 48000, channels: 2, bitRate: 160000 }));
    expect(socialInfo({ ...info, fps: '144/1', audio: tracks })).toMatchObject({ fps: '60/1', audio: [tracks[0]] });
  });

  it('H.264 High, 8-bit BT.709, a key frame every 2 s, quality-led under a cap below Meta’s 25 Mbps', () => {
    const withAudio = { ...info, audio: [{ index: 1, codec: 'opus', sampleRate: 44100, channels: 1, bitRate: 96000 }] };
    for (const nvenc of [true, false]) {
      const a = socialEncodeArgs(withAudio, nvenc);
      expect(at(a, '-c:v')).toBe(nvenc ? 'h264_nvenc' : 'libx264');
      expect(at(a, '-profile:v')).toBe('high');
      expect(at(a, '-pix_fmt')).toBe('yuv420p');
      expect(at(a, '-g')).toBe('120'); // 60 fps × 2 s
      expect(at(a, '-color_primaries')).toBe('bt709');
      expect(at(a, '-color_range')).toBe('tv');
      expect(at(a, '-maxrate')).toBe('20M');
      expect(SOCIAL.high.max).toBeLessThan(25);
      // stereo AAC at 48 kHz, whatever the recording had
      expect([at(a, '-c:a'), at(a, '-b:a'), at(a, '-ar'), at(a, '-ac')]).toEqual(['aac', '256k', '48000', '2']);
    }
    expect(at(socialEncodeArgs(withAudio, true), '-b:v')).toBe('16M');
    // 30 fps needs less
    const thirty = socialEncodeArgs({ ...info, fps: '30/1' }, true);
    expect([at(thirty, '-b:v'), at(thirty, '-maxrate'), at(thirty, '-g')]).toEqual(['10M', '14M', '60']);
    expect(thirty).not.toContain('-c:a'); // no sound, no audio options
  });
});

describe('overlay opacity', () => {
  it('a see-through overlay has its alpha scaled; a solid one is left alone', () => {
    const graph = (opacity?: number) => overlayGraph([{ file: 'b.png', x: 0, y: 0, w: 100, h: 40, from: 0, opacity }], '60/1').graph;
    expect(graph(0.35)).toContain('format=rgba,colorchannelmixer=aa=0.350');
    expect(graph(1)).not.toContain('colorchannelmixer');
    expect(graph()).not.toContain('colorchannelmixer');
  });
});

describe('kill-feed alignment', () => {
  const frame = { width: 1080, height: 1920 };
  const img = { w: 300, h: 40 };
  const margin = Math.round(1080 * 0.035);

  it('lines the entries up on the chosen side, keeping the margin there', () => {
    const left = feedImageRect(img, 0, frame, 37, 1, 'left');
    const right = feedImageRect(img, 0, frame, 37, 1, 'right');
    const center = feedImageRect(img, 0, frame, 37, 1, 'center');
    expect(left.x).toBe(margin);
    expect(right.x + right.w).toBe(1080 - margin);
    expect(Math.abs(center.x + center.w / 2 - 540)).toBeLessThanOrEqual(1);
    expect(new Set([left.y, right.y, center.y]).size).toBe(1);
  });

  it('the side padding moves the feed in from its side; centred, it has none', () => {
    const pad = feedMargin(12); // 12 % of the width
    expect(feedImageRect(img, 0, frame, 37, 1, 'left', pad).x).toBe(Math.round(1080 * 0.12));
    const right = feedImageRect(img, 0, frame, 37, 1, 'right', pad);
    expect(right.x + right.w).toBe(1080 - Math.round(1080 * 0.12));
    expect(feedImageRect(img, 0, frame, 37, 1, 'center', pad)).toEqual(feedImageRect(img, 0, frame, 37, 1, 'center'));
    // drawn rows: anchored that far in, plus their box padding
    const kill = [{ at: 2, attacker: 'me', victim: 'x', weapon: 'ak47', headshot: false }];
    const ass = killfeedAss(kill, { start: 0, end: 5 }, frame, 37, undefined, 1, 'left', pad)!;
    const pos = /\\move\(-?\d+,\d+,(\d+),/.exec(ass)!;
    expect(Number(pos[1])).toBe(Math.round(1080 * 0.12) + Math.max(2, Math.round(feedTextSize(frame) * 0.38)));
    // kept in range; missing = the default
    expect(feedMargin(80)).toBe(0.3);
    expect(feedMargin(undefined)).toBeCloseTo(0.035);
  });

  it('a wide entry shrinks to fit inside the side padding', () => {
    const wide = { w: 1000, h: 40 };
    const r = feedImageRect(wide, 0, frame, 37, 1, 'right', feedMargin(20));
    expect(r.x).toBeGreaterThanOrEqual(margin - 2); // stays inside the default gap on the far side
    expect(r.x + r.w).toBe(1080 - Math.round(1080 * 0.2));
  });

  it('drawn rows are anchored on the same side and slide in from it', () => {
    const kill = [{ at: 2, attacker: 'me', victim: 'x', weapon: 'ak47', headshot: false }];
    const row = (align: 'left' | 'center' | 'right') => killfeedAss(kill, { start: 0, end: 5 }, frame, 37, undefined, 1, align)!.split('\n').find((l) => l.startsWith('Dialogue: 1,'))!;
    // the left slide starts just off the frame's left edge (a negative x)
    const move = (r: string) => /\\move\((-?\d+),\d+,(-?\d+),/.exec(r)!.slice(1).map(Number);
    expect(row('left')).toContain('\\an7');
    expect(row('right')).toContain('\\an9');
    expect(row('center')).toContain('\\an8');
    const [fromL, toL] = move(row('left'));
    const [fromR, toR] = move(row('right'));
    expect(fromL).toBeLessThan(toL); // from the left
    expect(fromR).toBeGreaterThan(toR); // from the right
    const [fromC, toC] = move(row('center'));
    expect(fromC).toBe(toC); // centred: fades in where it stays
  });

  it('a cut-out entry slides in from its side in the export', () => {
    const lay = (slide: number) => overlayGraph([{ file: 'e.png', x: 100, y: 50, w: 300, h: 40, from: 1, slide }], '60/1').graph;
    expect(lay(1)).toContain('*(48)');
    expect(lay(-1)).toContain('*(-48)');
    expect(lay(0)).toContain("overlay=x=100:");
  });
});

describe('overlay picture', () => {
  const frame = { width: 1080, height: 1920 };
  const badge = { w: 2000, h: 667 };
  it('is placed where it was dragged, its height from its own shape', () => {
    const r = overlayRect({ x: 0.1, y: 0.8, w: 0.8 }, badge, frame);
    expect([r.x, r.y, r.w]).toEqual([108, 1536, 864]);
    expect(r.h).toBe(288); // 864 * 667 / 2000, even
  });

  it("can't leave the frame", () => {
    const r = overlayRect({ x: 0.9, y: 0.99, w: 0.8 }, badge, frame);
    expect(r.x + r.w).toBeLessThanOrEqual(1080);
    expect(r.y + r.h).toBeLessThanOrEqual(1920);
    expect(overlayRect({ x: 0, y: 0, w: 5 }, badge, frame).w).toBe(1080);
  });
});

describe('overlay alignment', () => {
  const frame = { width: 1440, height: 2560 };
  const badge = { w: 2000, h: 667 };
  it('centred is exactly in the middle, and stays there at any size', () => {
    for (const w of [0.8, 0.583, 0.31]) {
      const r = overlayRect({ x: 0.02, y: 0.5, w, align: 'center' }, badge, frame);
      expect(r.x * 2 + r.w).toBe(1440); // the same gap on both sides, to the pixel
    }
  });

  it('left and right keep the margin to their edge; free goes where it was dragged', () => {
    const margin = Math.round(1440 * 0.035);
    expect(overlayRect({ x: 0.5, y: 0.5, w: 0.5, align: 'left' }, badge, frame).x).toBe(margin);
    const right = overlayRect({ x: 0.1, y: 0.5, w: 0.5, align: 'right' }, badge, frame);
    expect(right.x + right.w).toBe(1440 - margin);
    expect(overlayRect({ x: 0.25, y: 0.5, w: 0.5, align: 'free' }, badge, frame).x).toBe(360);
  });
});

describe('loop order', () => {
  const piece = (start: number, end: number) => ({ round: 1, start, end, momentIds: [], label: '' });
  const kill = (at: number) => ({ at, attacker: 'me', victim: 'x', weapon: 'ak47', headshot: false });

  it('opens on the reaction after the final kill, blends into the round start and ends on that kill', () => {
    const order = loopOrder([piece(10, 20), piece(30, 40), piece(50, 58)], [kill(15), kill(35), kill(55)], 1)!;
    expect(order.map((c) => [c.start, c.end])).toEqual([
      [56, 58], // the reaction after the final kill
      [10, 20], // the round from its start, crossfaded in
      [30, 40],
      [50, 56], // ends right where the opening starts: a replay runs straight on
    ]);
    expect(order.map((c) => c.blend)).toEqual([undefined, LOOP_BLEND_S, undefined, undefined]);
    expect(order[0].seamless).toBe('start');
    expect(order.at(-1)!.seamless).toBe('end');
  });

  it('all kills in one piece: the reaction blends into the start of that piece', () => {
    const order = loopOrder([piece(10, 30)], [kill(15), kill(20), kill(25)], 0.5)!;
    expect(order.map((c) => [c.start, c.end, c.blend])).toEqual([[25.5, 30, undefined], [10, 25.5, LOOP_BLEND_S]]);
  });

  it('cuts after the last kill the edits left in, and keeps some footage on both sides', () => {
    // the final kill (at 70) was cut out in the editor
    expect(loopOrder([piece(10, 20), piece(30, 40)], [kill(15), kill(35), kill(70)], 1)![0].start).toBe(36);
    // little footage after the kill: the opening still gets a second
    expect(loopOrder([piece(10, 20), piece(30, 40)], [kill(39.5)], 1)![0].start).toBe(39);
    expect(loopOrder([piece(10, 20)], [], 1)).toBeNull();
  });
});

describe.skipIf(!checkFfmpeg().ok)('a looping short', () => {
  it('crossfades the opening into the round start, keeps every audio track, and its last frame runs straight into its first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs2h-loop-'));
    const src = join(dir, 'src.mp4');
    await runFfmpeg([
      // brightness ramps from black to near white: a jump at the loop point would be obvious
      '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=6,geq=lum=T*40:cb=128:cr=128',
      '-f', 'lavfi', '-i', 'sine=f=440:d=6:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=f=660:d=6:sample_rate=48000',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src,
    ]);
    const info = probe(src);
    const render = async (name: string, clips: Clip[]) => {
      const out = join(dir, name);
      await renderReel({ videoPath: src, info, clips, cards: new Map(), outPath: out, workDir: join(dir, `w-${name}`) });
      return out;
    };
    const pieces: Clip[] = [{ round: 1, start: 0, end: 6, momentIds: [], label: '' }];
    const whole = await render('whole.mp4', pieces);
    // the final kill at 4 s: it opens at 4.5 s, runs to the end, then blends into 0 – 4.5 s
    const out = await render('loop.mp4', loopOrder(pieces, [{ at: 4, attacker: 'me', victim: 'x', weapon: 'ak47', headshot: false }], 0.5)!);
    const r = probe(out);
    // the blend overlaps the two
    expect(Math.abs(r.duration - (6 - LOOP_BLEND_S))).toBeLessThan(0.15);
    expect(r.audio).toHaveLength(2);
    expect([r.width, r.height, r.fps]).toEqual([640, 360, '30/1']);

    // the seam: the last frame is (nearly) the first, while the source's own ends differ a lot
    const frame = async (file: string, last: boolean) => {
      const raw = join(dir, `f${Math.random().toString(36).slice(2)}.rgb`);
      // the last frame: the final 0.3 s played backwards, its first frame
      await runFfmpeg([...(last ? ['-sseof', '-0.3'] : []), '-i', file, '-vf', `${last ? 'reverse,' : ''}scale=64:36`, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', raw]);
      return readFileSync(raw);
    };
    const diff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    const seam = diff(await frame(out, false), await frame(out, true));
    const plain = diff(await frame(whole, false), await frame(whole, true));
    expect(plain).toBeGreaterThan(150);
    expect(seam).toBeLessThan(plain / 6);
  }, 300_000);
});

describe('kill-feed rows fade out, as in the game', () => {
  const frame = { width: 1080, height: 1920 };
  const feed = (at: number, victim: string) => ({ at, attacker: 'me', victim, weapon: 'ak47', headshot: true });
  const rows = (ass: string | null) => (ass ?? '').split('\n').filter((l) => l.startsWith('Dialogue: 1,'));
  const span = (r: string) => r.split(',').slice(1, 3).join(',');
  const y = (r: string) => { const n = /\\(?:pos|move)\(([0-9,-]+)/.exec(r)![1].split(',').map(Number); return n.length === 2 ? [n[1]] : [n[1], n[3]]; };

  it('a row is up from its kill to `stay` seconds after it, fading over its last moments', () => {
    const k = feed(10, 'a');
    expect(feedAlpha(k, 10, 6)).toBe(1);
    expect(feedAlpha(k, 15.8, 6)).toBeCloseTo(0.5);
    expect(feedAlpha(k, 16, 6)).toBe(0);
    // 0: it never goes
    expect(feedAlpha(k, 1000, 0)).toBe(1);
  });

  it('the rows under a gone one close up', () => {
    const sorted = [feed(10, 'a'), feed(12, 'b'), feed(30, 'c')];
    expect(feedSlot(sorted, 1, 13, 6)).toBe(1);
    expect(feedSlot(sorted, 1, 16 + 0.09, 6)).toBeCloseTo(0.5);
    expect(feedSlot(sorted, 1, 17, 6)).toBe(0);
    expect(feedSlot(sorted, 2, 30, 6)).toBe(0);
    expect(feedSlot(sorted, 2, 30, 0)).toBe(2);
  });

  it('burned in: each row ends faded out, the one under it moving up as it goes', () => {
    const kills = [feed(12, 'a'), feed(14, 'b'), feed(25, 'c')];
    const r = rows(killfeedAss(kills, { start: 10, end: 30 }, frame, 37, undefined, 1, 'right', undefined, 6));
    // a: 2 s to 8 s, fading out at the end; b: up to 8 s in the second slot, then the first until it goes at 10 s
    expect(r.map(span)).toEqual(['0:00:02.00,0:00:08.00', '0:00:04.00,0:00:08.00', '0:00:08.00,0:00:10.00', '0:00:15.00,0:00:20.00']);
    expect(r[0]).toMatch(/\\fade\(255,0,255,0,180,5600,6000\)/);
    const [first, second] = [y(r[0])[0], y(r[1])[0]];
    expect(second).toBeGreaterThan(first);
    expect(y(r[2])).toEqual([second, first]); // moves up into the first slot
    expect(r[2]).toMatch(/\\fade\(0,0,255,0,0,1600,2000\)/);
    // c comes after both are gone: the first slot, sliding in, and still up when the piece ends
    expect(y(r[3])[0]).toBe(first);
    expect(r[3]).toMatch(/\\fad\(180,0\)/);
    // a piece after every row has gone has no feed
    expect(killfeedAss(kills, { start: 40, end: 45 }, frame, 37, undefined, 1, 'right', undefined, 6)).toBeNull();
  });

  it("runs on the short's own clock: a cut doesn't take time off a row", () => {
    // 0-10 s and 30-40 s of the round, 20 s of rotation cut between
    const pieces = [{ start: 0, end: 10 }, { start: 30, end: 40 }];
    const kills = [feed(8, 'a'), feed(20, 'in the cut'), feed(35, 'b')];
    const second = feedOnScreen(kills, pieces, 1);
    expect(second.clip).toEqual({ start: 10, end: 20 });
    // the 8 s kill was 2 s before the cut: up until 14 s into the short, 4 s into this piece
    expect(second.kills.map((k) => k.at)).toEqual([8, 10, 15]);
    const r = rows(killfeedAss(second.kills, second.clip, frame, 37, undefined, 1, 'right', undefined, 6));
    expect(span(r[0])).toBe('0:00:00.00,0:00:04.00');
    // the first piece: nothing after it is up yet
    expect(feedOnScreen(kills, pieces, 0).kills.slice(1).every((k) => k.at > 1e9)).toBe(true);
  });

  it('a looping short opens with the rows still up from the end it follows', () => {
    // reaction (45-50), then the round from its start; the last kill at 42 s plays 3 s before the end
    const pieces = [{ start: 45, end: 50 }, { start: 0, end: 10 }, { start: 30, end: 45 }];
    const kills = [feed(5, 'a'), feed(42, 'b')];
    const open = feedOnScreen(kills, pieces, 0);
    expect(open.clip).toEqual({ start: 0, end: 5 });
    // 'a' played 20 s before the end, 'b' 3 s before it
    expect(open.kills.map((k) => k.at)).toEqual([-20, -3]);
    // crossfaded pieces overlap
    expect(feedOnScreen(kills, [pieces[0], { ...pieces[1], blend: 0.5 }, pieces[2]], 2).clip.start).toBe(14.5);
  });

  it("a looping short's opening reaction holds every kill of the round up, none fading", () => {
    // kills at 10, 12 and 30 s; the loop cuts at 31 s, so the reaction (31-35 s) opens the short
    const kills = [feed(10, 'a'), feed(12, 'b'), feed(30, 'c')];
    expect(holdsFeed(31, 31)).toBe(true);
    expect(holdsFeed(20, 31)).toBe(false);
    expect(holdsFeed(31, null)).toBe(false);
    const clip = { start: 0, end: 4 }; // the reaction is the short's first 4 s
    const held = holdKills(kills, 35, clip.start - 1);
    const r = rows(killfeedAss(held, clip, frame, 37, undefined, 1, 'right', undefined, 0));
    // all three, from the first frame to the end of the reaction: no slide-in, no fade
    expect(r.map(span)).toEqual(['0:00:00.00,0:00:04.00', '0:00:00.00,0:00:04.00', '0:00:00.00,0:00:04.00']);
    expect(r.every((x) => x.includes('\\pos(') && !x.includes('\\fad'))).toBe(true);
    // in their order, one row each
    const ys = r.map((x) => y(x)[0]);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
    // a kill after the reaction (can't happen, but) isn't up
    expect(holdKills([feed(40, 'late')], 35, -1)[0].at).toBeGreaterThan(1e9);
  });

  it('starting part-way into a fade carries on from there', () => {
    const r = rows(killfeedAss([feed(10, 'a')], { start: 15.8, end: 20 }, frame, 37, undefined, 1, 'right', undefined, 6));
    expect(r).toHaveLength(1);
    expect(span(r[0])).toBe('0:00:00.00,0:00:00.20');
    expect(r[0]).toMatch(/\\fade\(128,128,255,0,0,0,200\)/);
  });
});

describe.skipIf(!checkFfmpeg().ok)('a cut-out kill-feed entry in the export', () => {
  it('moves up when the row above goes, then fades out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs2h-feedfade-'));
    const pic = join(dir, 'e.png');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=100x40', '-frames:v', '1', pic]);
    const o = overlayGraph([{ file: pic, x: 100, y: 200, w: 100, h: 40, from: 0, until: 1.5, fadeOut: 0.4, up: { at: [-1, 0.5], by: 50, over: 0.18 } }], '30/1');
    const out = join(dir, 'out.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=400x400:r=30:d=2', ...o.inputs,
      '-filter_complex', `[0:v]null[in];${o.graph}`, '-map', '[out]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-qp', '0', out,
    ]);
    const red = async (t: number, yy: number) => {
      const px = join(dir, `p${t}-${yy}.rgb`);
      await runFfmpeg(['-ss', String(t), '-i', out, '-frames:v', '1', '-vf', `crop=2:2:150:${yy}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', px]);
      return readFileSync(px)[0];
    };
    // the row above went before the clip: one slot up already (150); the other goes at 0.5 s (100)
    expect(await red(0.2, 165)).toBeGreaterThan(200);
    expect(await red(0.2, 115)).toBeLessThan(30);
    expect(await red(1, 115)).toBeGreaterThan(200);
    expect(await red(1, 165)).toBeLessThan(30);
    // half faded at 1.3 s, gone after 1.5 s
    const half = await red(1.3, 115);
    expect(half).toBeGreaterThan(60);
    expect(half).toBeLessThan(200);
    expect(await red(1.8, 115)).toBeLessThan(30);
  }, 60_000);
});
