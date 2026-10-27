import { spawn } from 'node:child_process';
import { FFMPEG, hasNvenc, type VideoInfo } from '../util/ffmpeg.ts';
import type { Settings } from '../types.ts';

export const SAMPLE_FPS = 4;
const ANALYSIS_WIDTH = 480;

/**
 * CS2 draws a red outline around kill-feed entries that involve the local
 * player. Each outlined entry has a top and bottom border: a long horizontal
 * run of saturated red. Returns how many outlined entries are visible.
 */
export function countHighlightedEntries(rgb: Uint8Array, width: number, height: number): number {
  const minRun = Math.round(width * 0.2);
  const borderRows: number[] = [];
  for (let y = 0; y < height; y++) {
    let run = 0;
    let longest = 0;
    let gap = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      if (r >= 120 && r - Math.max(g, b) >= 70) {
        run++;
        gap = 0;
        if (run > longest) longest = run;
      } else if (++gap > 2) {
        run = 0; // tolerate antialiasing holes of up to 2px
      }
    }
    if (longest >= minRun) borderRows.push(y);
  }
  // Adjacent border rows (thick/blurred outline) form one line.
  let lines = 0;
  for (let i = 0; i < borderRows.length; i++) {
    if (i === 0 || borderRows[i] - borderRows[i - 1] > 2) lines++;
  }
  return Math.ceil(lines / 2);
}

/**
 * Turns the per-sample entry count into event times: every debounced increase
 * of the count is a new kill-feed entry of mine (kill or death).
 */
export function countsToEvents(counts: number[], fps: number): number[] {
  const events: number[] = [];
  let stable = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    // require the new count to hold for 2 samples, so a single noisy frame doesn't count
    if (c !== stable && i + 1 < counts.length && counts[i + 1] === c) {
      for (let k = 0; k < c - stable; k++) events.push(i / fps);
      stable = c;
    }
  }
  return events;
}

export interface KillfeedResult {
  events: number[];
  counts: number[];
}

export async function detectKillfeed(
  videoPath: string,
  info: VideoInfo,
  region: Settings['killfeed'],
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<KillfeedResult> {
  try {
    return await scan(videoPath, info, region, hasNvenc(), onProgress, signal);
  } catch (e) {
    if (signal?.aborted || !hasNvenc()) throw e;
    return scan(videoPath, info, region, false, onProgress, signal); // CUDA decode can fail on odd inputs
  }
}

function scan(
  videoPath: string,
  info: VideoInfo,
  region: Settings['killfeed'],
  cuda: boolean,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<KillfeedResult> {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const cw = even(info.width * region.w);
  const ch = even(info.height * region.h);
  const cx = Math.floor(info.width * region.x);
  const cy = Math.floor(info.height * region.y);
  const w = ANALYSIS_WIDTH;
  const h = even((ch * w) / cw);
  const frameSize = w * h * 3;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(cuda ? ['-hwaccel', 'cuda'] : []),
    '-i', videoPath,
    '-an', '-sn',
    '-vf', `fps=${SAMPLE_FPS},crop=${cw}:${ch}:${cx}:${cy},scale=${w}:${h}:flags=area`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ];

  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { signal });
    const counts: number[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    p.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameSize) {
        counts.push(countHighlightedEntries(pending.subarray(0, frameSize), w, h));
        pending = pending.subarray(frameSize);
        if (onProgress && counts.length % (SAMPLE_FPS * 30) === 0) {
          onProgress(Math.min(1, counts.length / SAMPLE_FPS / info.duration));
        }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`kill-feed scan failed (${code}): ${stderr.trim()}`));
      resolve({ events: countsToEvents(counts, SAMPLE_FPS), counts });
    });
  });
}
