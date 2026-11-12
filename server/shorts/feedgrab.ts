// The game's own kill-feed entries, cut out of the recording for a short's
// kill feed: the real look (weapon and headshot icons, the player's own name
// glyphs) instead of a drawn copy. My entries are the red-outlined ones, and
// a new entry joins the bottom of the feed, so just after a kill its entry is
// the lowest red box (or one above it, if another kill of mine came in between).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FFMPEG, type VideoInfo } from '../util/ffmpeg.ts';
import type { FeedKill, Rect } from '../types.ts';

/**
 * a new entry fades in: looked for from this long after the kill, for this
 * long (a flashbang can white out the screen for a few seconds), at this many
 * frames a second
 */
const LOOK_FROM_S = 0.3;
const LOOK_FOR_S = 5;
const LOOK_FPS = 8;
/** once it's in, the best-looking of this many frames (about a second) is kept */
const PICK_FRAMES = 8;
/** bump when the cut-outs change, so cached ones are made again */
const CUT_VERSION = 5;
/** the feed just before the kill, to tell the new entry from the ones already up */
const BEFORE_S = 0.25;
/** shortest red run that can be a border, as a fraction of the region width */
const MIN_BORDER = 0.1;
/** an entry's height, as a fraction of the frame height */
const MIN_ENTRY = 0.012;
const MAX_ENTRY = 0.06;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A cut-out entry: the PNG and its size in source pixels. */
export interface FeedImage {
  key: string;
  file: string;
  w: number;
  h: number;
}

const isRed = (rgb: Uint8Array, i: number) => rgb[i] >= 120 && rgb[i] - Math.max(rgb[i + 1], rgb[i + 2]) >= 70;

/**
 * Red-outlined boxes in an RGB image, top to bottom: rows with a long run of
 * red are borders; a border and the next one a plausible entry height below,
 * spanning about the same columns, are a box's top and bottom.
 */
export function findRedBoxes(rgb: Uint8Array, width: number, height: number, frameHeight: number): Box[] {
  const minRun = Math.round(width * MIN_BORDER);
  const lines: { y0: number; y1: number; x0: number; x1: number }[] = [];
  for (let y = 0; y < height; y++) {
    let best: [number, number] | null = null;
    let start = -1;
    let gap = 0;
    for (let x = 0; x <= width; x++) {
      const red = x < width && isRed(rgb, (y * width + x) * 3);
      if (red) {
        if (start < 0) start = x;
        gap = 0;
      } else if (start >= 0 && (++gap > 2 || x === width)) {
        // tolerate antialiasing holes of up to 2px
        const end = x - gap;
        if (!best || end - start > best[1] - best[0]) best = [start, end];
        start = -1;
        gap = 0;
      }
    }
    if (!best || best[1] - best[0] < minRun) continue;
    const last = lines.at(-1);
    // a thick or blurred border is several rows
    if (last && y - last.y1 <= 2) {
      last.y1 = y;
      last.x0 = Math.min(last.x0, best[0]);
      last.x1 = Math.max(last.x1, best[1]);
    } else {
      lines.push({ y0: y, y1: y, x0: best[0], x1: best[1] });
    }
  }

  const boxes: Box[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const top = lines[i];
    const bottom = lines[i + 1];
    const h = bottom.y1 - top.y0;
    const overlap = Math.min(top.x1, bottom.x1) - Math.max(top.x0, bottom.x0);
    const span = Math.max(top.x1 - top.x0, bottom.x1 - bottom.x0);
    if (h >= frameHeight * MIN_ENTRY && h <= frameHeight * MAX_ENTRY && overlap >= span * 0.8) {
      boxes.push({ x0: Math.min(top.x0, bottom.x0), y0: top.y0, x1: Math.max(top.x1, bottom.x1), y1: bottom.y1 });
      i++; // that bottom border is used
    }
  }
  return boxes;
}

/** an entry keeps its width (±this many px) while the feed moves around it */
const SAME_WIDTH_PX = 3;

/**
 * Boxes in `after` that weren't in `before`, top to bottom. Entries move up as
 * old ones expire, so they're matched by width (each before-box at most once),
 * not by position.
 */
export function newBoxes(before: Box[], after: Box[]): Box[] {
  const left = [...before];
  return after.filter((b) => {
    const i = left.findIndex((o) => Math.abs(o.x1 - o.x0 - (b.x1 - b.x0)) <= SAME_WIDTH_PX);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/** The region (in pixels) of a frame, as cropped by ffmpeg. */
function regionPx(info: VideoInfo, r: Rect) {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const w = Math.min(even(info.width * r.w), even(info.width));
  const h = Math.min(even(info.height * r.h), even(info.height));
  return { w, h, x: Math.max(0, Math.min(info.width - w, Math.floor(info.width * r.x))), y: Math.max(0, Math.min(info.height - h, Math.floor(info.height * r.y))) };
}

/** Runs ffmpeg and returns what it writes to stdout (`input` goes to its stdin). */
function ffmpegBytes(args: string[], signal?: AbortSignal, input?: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { signal });
    const chunks: Buffer[] = [];
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(`kill-feed grab failed: ${stderr.trim()}`))));
    if (input) p.stdin.end(input);
  });
}

/** Frames of the region as raw RGB: one at `t`, or `fps` a second for `dur` seconds from `t`. */
async function grabRegion(path: string, t: number, crop: ReturnType<typeof regionPx>, signal?: AbortSignal, dur = 0, fps = 1): Promise<Uint8Array[]> {
  const cut = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
  const raw = await ffmpegBytes(
    ['-ss', t.toFixed(3), '-i', path, ...(dur ? ['-t', dur.toFixed(3), '-vf', `fps=${fps},${cut}`] : ['-frames:v', '1', '-vf', cut]), '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    signal,
  );
  const size = crop.w * crop.h * 3;
  return Array.from({ length: Math.floor(raw.length / size) }, (_, i) => raw.subarray(i * size, (i + 1) * size));
}

/** below this (brightest channel) a pixel inside an entry is background; above TEXT_MIN it's text or icon */
const BG_MAX = 100;
const TEXT_MIN = 150;
/** every entry gets this background (CS2's own, when nothing shows through) */
const ENTRY_BG = [18, 18, 20];
/** the red outline's thickness in a 1440p recording (scaled up for the short anyway) */
const OUTLINE_PX = 2;

/**
 * share of an entry that's dark background when it shows clearly (about 0.75);
 * a flashbang's white-out or a fade-in leaves much less
 */
const CLEAR_DARK = 0.65;

/** How well an entry shows in a frame: text fully faded in first, then the darkest background; `dark` is the share that's background. */
function entryScore(rgb: Uint8Array, width: number, b: Box) {
  let text = 0;
  let bg = 0;
  let bgN = 0;
  let n = 0;
  for (let y = b.y0 + 4; y <= b.y1 - 4; y++) {
    for (let x = b.x0 + 4; x <= b.x1 - 4; x++) {
      const i = (y * width + x) * 3;
      const v = Math.max(rgb[i], rgb[i + 1], rgb[i + 2]);
      n++;
      if (v >= TEXT_MIN) text++;
      else if (v < BG_MAX) {
        bg += v;
        bgN++;
      }
    }
  }
  return { text, bg: bgN ? bg / bgN : 255, dark: n ? bgN / n : 0 };
}

/**
 * The entry cut out exactly at its red outline, with the game showing through
 * its background painted over in one dark colour, so every entry looks alike
 * (the edges of letters and icons are blended, not cut).
 */
export function cleanEntry(rgb: Uint8Array, width: number, b: Box): { data: Uint8Array; w: number; h: number } {
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((b.y0 + y) * width + b.x0 + x) * 3;
      const o = (y * w + x) * 3;
      const px = [rgb[i], rgb[i + 1], rgb[i + 2]];
      // the red outline stays as it is
      const v = isRed(rgb, i) ? 255 : Math.max(...px);
      const keep = Math.min(1, Math.max(0, (v - BG_MAX) / (TEXT_MIN - BG_MAX)));
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(ENTRY_BG[c] + (px[c] - ENTRY_BG[c]) * keep);
    }
  }
  // the outline falls between pixels: its outer ring is painted in the outline's own red, so no game shows at the edge
  const ring = (x: number, y: number) => x < OUTLINE_PX || y < OUTLINE_PX || x >= w - OUTLINE_PX || y >= h - OUTLINE_PX;
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((b.y0 + y) * width + b.x0 + x) * 3;
      if (!ring(x, y) || !isRed(rgb, i)) continue;
      for (let c = 0; c < 3; c++) sum[c] += rgb[i + c];
      n++;
    }
  }
  if (n) {
    const red = sum.map((s) => Math.round(s / n));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ring(x, y)) out.set(red, (y * w + x) * 3);
  }
  return { data: out, w, h };
}

/** Width and height from a PNG's header. */
const pngSize = (file: string) => {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

/**
 * Each kill's own entry cut out of the recording, or null where it couldn't
 * be found (that kill is drawn instead). Cached per file, time and region.
 */
export async function grabFeedEntries(
  kills: FeedKill[],
  sourceOf: (t: number) => { path: string; info: VideoInfo; offset: number },
  region: Rect,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<(FeedImage | null)[]> {
  mkdirSync(cacheDir, { recursive: true });
  const sorted = [...kills].sort((a, b) => a.at - b.at);
  const out: (FeedImage | null)[] = [];
  for (const [i, k] of sorted.entries()) {
    const src = sourceOf(k.at);
    const local = k.at - src.offset;
    const key = createHash('sha1').update(JSON.stringify([CUT_VERSION, src.path, local.toFixed(3), sorted.map((x) => x.at.toFixed(3)), region])).digest('hex').slice(0, 20);
    const file = join(cacheDir, `${key}.png`);
    const none = join(cacheDir, `${key}.none`);
    if (existsSync(file)) {
      out.push({ key, file, ...pngSize(file) });
      continue;
    }
    if (existsSync(none)) {
      out.push(null);
      continue;
    }
    const crop = regionPx(src.info, region);
    const boxes = (rgb: Uint8Array) => findRedBoxes(rgb, crop.w, crop.h, src.info.height);
    const [first] = await grabRegion(src.path, Math.max(0, local - BEFORE_S), crop, signal);
    const before = first ? boxes(first) : [];
    // the feed after the kill, in one pass: the entry fades in, then stays for several seconds
    const from = Math.max(0, local + LOOK_FROM_S);
    const frames = await grabRegion(src.path, from, crop, signal, Math.min(LOOK_FOR_S, src.info.duration - from), LOOK_FPS);
    // the first frame where the new entry shows clearly; failing that (it never does), the first where it shows at all
    let found: { at: number; box: Box } | null = null;
    let faint: { at: number; box: Box } | null = null;
    for (const [j, rgb] of frames.entries()) {
      const t = from + j / LOOK_FPS;
      // a later kill whose entry is already in by then sits below this one
      const later = sorted.slice(i + 1).filter((x) => x.at - src.offset <= t && sourceOf(x.at).path === src.path).length;
      const fresh = newBoxes(before, boxes(rgb));
      if (fresh.length >= 1 + later) {
        const box = fresh[fresh.length - 1 - later];
        faint ??= { at: j, box };
        // while flashed, the outline and the entry are washed out (and the box found may be only part of it)
        if (entryScore(rgb, crop.w, box).dark >= CLEAR_DARK) {
          found = { at: j, box };
          break;
        }
      }
    }
    found ??= faint;
    if (!found) {
      writeFileSync(none, '');
      out.push(null);
      continue;
    }
    // of the frames just after it appeared, the one where it shows best (fully faded in, least showing through)
    const width = found.box.x1 - found.box.x0;
    let best = { rgb: frames[found.at], box: found.box, score: entryScore(frames[found.at], crop.w, found.box) };
    for (const rgb of frames.slice(found.at + 1, found.at + 1 + PICK_FRAMES)) {
      // the same entry: same width, nearest to where it was (the feed may have moved up)
      const same = boxes(rgb)
        .filter((b) => Math.abs(b.x1 - b.x0 - width) <= SAME_WIDTH_PX)
        .sort((a, b) => Math.abs(a.y0 - found!.box.y0) - Math.abs(b.y0 - found!.box.y0))[0];
      if (!same) continue;
      const score = entryScore(rgb, crop.w, same);
      // never a frame that shows it less clearly (a flash coming back, the feed fading)
      if (score.dark < Math.min(CLEAR_DARK, best.score.dark)) continue;
      if (score.text > best.score.text * 1.02 || (score.text >= best.score.text * 0.98 && score.bg < best.score.bg)) best = { rgb, box: same, score };
    }
    const entry = cleanEntry(best.rgb, crop.w, best.box);
    writeFileSync(file, await ffmpegBytes(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${entry.w}x${entry.h}`, '-i', '-', '-f', 'image2', '-c:v', 'png', '-'], signal, entry.data));
    out.push({ key, file, w: entry.w, h: entry.h });
  }
  return out;
}
