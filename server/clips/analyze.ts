import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { detectKillfeed, SAMPLE_FPS } from '../sync/killfeed.ts';
import { runFfmpeg, type VideoInfo } from '../util/ffmpeg.ts';
import type { ClipAnalysis, Settings } from '../types.ts';
import { readClip, type Shot } from './read.ts';
import { roundStartsFrom } from './moments.ts';

/** the kill-feed entry is fully drawn this long after it was first spotted */
const SETTLE_S = 0.5;
/** while red entries are on screen, a kill-feed shot this often (an entry stays up longer) */
const FEED_EVERY_S = 2;
/** red seen for fewer samples than this in a row is noise (red scenery), not an entry */
const MIN_RUN = 2;
/** a shot this close to another one adds nothing */
const SAME_SHOT_S = 0.75;
const HUD_STEP_S = 5;
/** the HUD is read from this long before the first entry: far enough back to see the round start */
const HUD_LOOKBACK_S = 120;
const MAX_HUD_SHOTS = 60;
const FEED_WIDTH = 640;
const HUD_WIDTH = 480;

type Region = Settings['killfeed'];

/** crop + scale for a region of the frame (even sizes, as encoders and scalers like them) */
function cropFilter(info: VideoInfo, r: Region, width: number) {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const cw = even(info.width * r.w);
  const ch = even(info.height * r.h);
  const w = Math.min(width, cw);
  return `crop=${cw}:${ch}:${Math.floor(info.width * r.x)}:${Math.floor(info.height * r.y)},scale=${w}:-2:flags=lanczos`;
}

/**
 * When to photograph the kill feed. The red-outline count is a good sign that
 * my entries are on screen, but not a reliable count: entries stacked close
 * together or arriving as old ones fade don't always raise it. So besides each
 * rise, a shot every FEED_EVERY_S while red entries are showing, so every
 * entry is in at least one shot (Claude's answers are de-duplicated by name).
 */
export function feedShotTimes(counts: number[], fps: number, events: number[], duration: number): number[] {
  const wanted = events.map((t) => t + SETTLE_S);
  for (let i = 0; i < counts.length; ) {
    if (counts[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < counts.length && counts[j] > 0) j++;
    if (j - i >= MIN_RUN) {
      for (let t = i / fps + SETTLE_S; t < j / fps; t += FEED_EVERY_S) wanted.push(t);
    }
    i = j;
  }
  const out: number[] = [];
  for (const t of wanted.map((t) => Math.min(duration - 0.05, t)).sort((a, b) => a - b)) {
    if (out.length === 0 || t - out.at(-1)! >= SAME_SHOT_S) out.push(t);
  }
  return out;
}

async function grabAt(path: string, info: VideoInfo, r: Region, width: number, t: number, out: string, signal?: AbortSignal): Promise<Shot> {
  await runFfmpeg(['-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-an', '-vf', cropFilter(info, r, width), out], undefined, signal);
  return { t, png: readFileSync(out) };
}

/** The HUD every few seconds from `from` to `to`, in one ffmpeg run. */
async function grabEvery(path: string, info: VideoInfo, r: Region, width: number, from: number, to: number, dir: string, signal?: AbortSignal): Promise<Shot[]> {
  const step = Math.max(HUD_STEP_S, (to - from) / MAX_HUD_SHOTS);
  await runFfmpeg(
    ['-ss', from.toFixed(3), '-i', path, '-t', (to - from).toFixed(3), '-an', '-vf', `fps=1/${step.toFixed(3)},${cropFilter(info, r, width)}`, join(dir, 'hud_%04d.png')],
    undefined,
    signal,
  );
  return readdirSync(dir)
    .filter((f) => f.startsWith('hud_'))
    .sort()
    .map((f, i) => ({ t: from + i * step, png: readFileSync(join(dir, f)) }));
}

/**
 * Reads one replay clip: the local kill-feed scan finds when my red-outlined
 * entries appear, and Claude reads those moments plus the HUD around them.
 * A clip with no red entries costs nothing (no request is made).
 */
export async function analyzeClip(
  path: string,
  info: VideoInfo,
  settings: Settings,
  workDir: string,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<ClipAnalysis> {
  const { events, counts } = await detectKillfeed(path, info, settings.killfeed, (f) => onProgress?.(f * 0.5), signal);
  if (events.length === 0) return { entries: [], hud: [], roundStarts: [], usage: { input: 0, output: 0 } };

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  try {
    const times = feedShotTimes(counts, SAMPLE_FPS, events, info.duration);
    const feed: Shot[] = [];
    for (const [i, t] of times.entries()) feed.push(await grabAt(path, info, settings.killfeed, FEED_WIDTH, t, join(workDir, `feed_${i}.png`), signal));
    const from = Math.max(0, events[0] - HUD_LOOKBACK_S);
    const to = Math.min(info.duration, events.at(-1)! + HUD_STEP_S);
    const hud = await grabEvery(path, info, settings.hud, HUD_WIDTH, from, to, workDir, signal);
    onProgress?.(0.6);
    const read = await readClip(feed, hud, settings.playerName, signal);
    onProgress?.(1);
    return { ...read, roundStarts: roundStartsFrom(read.hud) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
