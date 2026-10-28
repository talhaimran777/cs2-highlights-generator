import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FFMPEG, type VideoInfo } from '../util/ffmpeg.ts';

const SAMPLE_RATE = 8000;
/** waveform buckets per second of recording */
export const PEAKS_PER_SEC = 100;
const BUCKET = SAMPLE_RATE / PEAKS_PER_SEC;

/**
 * Waveform for the editor's timeline: all audio tracks mixed to 8 kHz mono,
 * the loudest sample of every 10 ms as one byte (0-255). Cached on disk.
 */
export async function computePeaks(
  videoPath: string,
  info: VideoInfo,
  outFile: string,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const n = info.audio.length;
  const total = Math.ceil(info.duration * PEAKS_PER_SEC);
  const peaks = new Uint8Array(total + PEAKS_PER_SEC);
  if (n > 0) {
    const audio =
      n === 1
        ? ['-map', '0:a:0']
        : ['-filter_complex', `${info.audio.map((_, i) => `[0:a:${i}]`).join('')}amix=inputs=${n}:normalize=0[a]`, '-map', '[a]'];
    const ff = spawn(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vn', ...audio, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'],
      { signal },
    );
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const exited = new Promise<number | null>((resolve, reject) => {
      ff.on('error', reject);
      ff.on('close', resolve);
    });

    let i = 0; // bucket
    let inBucket = 0;
    let max = 0;
    let pending: Buffer = Buffer.alloc(0);
    for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const count = Math.floor(pending.length / 4);
      for (let s = 0; s < count; s++) {
        const v = Math.abs(pending.readFloatLE(s * 4));
        if (v > max) max = v;
        if (++inBucket === BUCKET) {
          if (i < peaks.length) peaks[i] = Math.min(255, Math.round(max * 255));
          i++;
          inBucket = 0;
          max = 0;
        }
      }
      pending = pending.subarray(count * 4);
      onProgress?.(Math.min(0.99, i / total));
    }
    const code = await exited;
    if (code !== 0) throw new Error(`waveform failed (${code}): ${stderr.trim()}`);
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, peaks.subarray(0, total));
  onProgress?.(1);
  return total;
}

export const readPeaks = (file: string): Buffer | null => (existsSync(file) ? readFileSync(file) : null);
