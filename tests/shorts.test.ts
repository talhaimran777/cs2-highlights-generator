import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutRound, loopOrder, matchShortClips, matchShortKills, matchShortRounds, sourceShortClips, sourceShortKills, sourceShortRounds } from '../server/shorts/plan.ts';
import { feedImageRect, feedTopPct, fitFeedScale, killfeedAss, weaponName } from '../server/shorts/killfeed.ts';
import { cleanEntry, findRedBoxes, newBoxes, type Box } from '../server/shorts/feedgrab.ts';
import { readFileSync } from 'node:fs';
import { bandAspects, bandHeights, fitLayout, overlayRect, resizeRect, shortFrame } from '../server/shorts/layout.ts';
import { shortGraph } from '../server/shorts/render.ts';
import { overlayGraph, renderReel } from '../server/edit/render.ts';
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
      [48, 52.5], // last kill gets a little extra for the reaction
    ]);
    expect(clips.map((c) => c.label)).toEqual(['2K', 'Kill']);
    // the editor can bring footage back up to the round's edges (round end + the win banner)
    expect(clips[0].bounds).toEqual([10, 113]);
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
      [166, 172.5, 2],
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
  it('turns the frame on its side: same pixel count, so the source bitrate fits', () => {
    expect(shortFrame({ width: 1920, height: 1080 })).toEqual({ width: 1080, height: 1920 });
    expect(bandHeights({ width: 1080, height: 1920 }, 0.35)).toEqual({ camera: 672, gameplay: 1248 });
  });

  it("fits each box to its band's shape, so nothing stretches", () => {
    const video = { width: 1920, height: 1080 };
    const l = fitLayout({ ...DEFAULT_SETTINGS.shortLayout, split: 0.4 }, video);
    const a = bandAspects(video, l.split);
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
    const g = shortGraph(DEFAULT_SETTINGS.shortLayout, info, { width: 1080, height: 1920 });
    expect(g).toContain('scale=1080:672');
    expect(g).toContain('scale=1080:1248');
    expect(g).toMatch(/vstack$/);
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

  it('opens just before the final kill, plays the round from its start and ends right before the opening', () => {
    const order = loopOrder([piece(10, 20), piece(30, 40), piece(50, 58)], [kill(15), kill(35), kill(55)], 1)!;
    expect(order.map((c) => [c.start, c.end])).toEqual([
      [54, 58], // the final kill and what follows it
      [10, 20],
      [30, 40],
      [50, 54], // ends right where the opening starts: a replay runs straight on
    ]);
    expect(order[0].seamless).toBe('start');
    expect(order.at(-1)!.seamless).toBe('end');
  });

  it('cuts before the last kill the edits left in, and keeps some footage on both sides', () => {
    // the final kill (at 70) was cut out in the editor
    expect(loopOrder([piece(10, 20), piece(30, 40)], [kill(15), kill(35), kill(70)], 1)![0].start).toBe(34);
    // a kill right at a piece's start: the seam keeps a little of the piece before it
    expect(loopOrder([piece(10, 20), piece(30, 40)], [kill(30.1)], 1)![0].start).toBeCloseTo(30.3);
    expect(loopOrder([piece(10, 20)], [], 1)).toBeNull();
  });
});

describe.skipIf(!checkFfmpeg().ok)('a looping short', () => {
  it('keeps its length and every audio track, and its last frame runs straight into its first', async () => {
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
    // the final kill at 4.5 s: it opens at 3.5 s, runs to the end, then plays 0 – 3.5 s
    const out = await render('loop.mp4', loopOrder(pieces, [{ at: 4.5, attacker: 'me', victim: 'x', weapon: 'ak47', headshot: false }], 1)!);
    const r = probe(out);
    expect(Math.abs(r.duration - 6)).toBeLessThan(0.15);
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
