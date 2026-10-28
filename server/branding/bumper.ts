import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas';
import { FFMPEG, type VideoInfo } from '../util/ffmpeg.ts';
import { CAPTION_FONTS, FONTS_DIR } from '../captions/fonts.ts';
import type { Branding } from '../types.ts';
import { drawIntro, drawOutro, INTRO_SECONDS, introSound, OUTRO_SECONDS, outroSound } from './animate.ts';

export type BumperKind = 'intro' | 'outro';

/** Bump when the animations or sounds change, so cached renders are redone. */
const BUMPER_VERSION = 1;

export const bumperSeconds = (kind: BumperKind) => (kind === 'intro' ? INTRO_SECONDS : OUTRO_SECONDS);

let fontsLoaded = false;
function loadFonts() {
  if (fontsLoaded) return;
  for (const [family, file] of Object.entries(CAPTION_FONTS)) {
    const path = join(FONTS_DIR, file);
    if (existsSync(path)) GlobalFonts.registerFromPath(path, family);
  }
  fontsLoaded = true;
}

export interface BumperTarget {
  width: number;
  height: number;
  fps: string; // rational, e.g. "60/1"
  /** sample rate and channels of each audio track; the sound goes on the first, the rest are silent */
  audio: { sampleRate: number; channels: number }[];
  /** ffmpeg output options (codec, bitrate, pixel format, ...) */
  encode: string[];
}

/** Reel target: same size, rate, tracks and encoder settings as the clips, so the join stays lossless. */
export const reelTarget = (info: VideoInfo, encode: string[]): BumperTarget => ({
  width: info.width,
  height: info.height,
  fps: info.fps,
  audio: info.audio.map((a) => ({ sampleRate: a.sampleRate, channels: a.channels })),
  encode,
});

/** Small, quick H.264 for previewing in the browser. */
export const PREVIEW_TARGET: BumperTarget = {
  width: 1280,
  height: 720,
  fps: '30/1',
  audio: [{ sampleRate: 48000, channels: 2 }],
  encode: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
};

/**
 * Renders the intro or outro once per look and target and caches it; later
 * reels reuse the file. Returns the cached path.
 */
export async function bumperFile(kind: BumperKind, b: Branding, target: BumperTarget, cacheDir: string, signal?: AbortSignal): Promise<string> {
  const avatarStamp = b.avatarPath && existsSync(b.avatarPath) ? statSync(b.avatarPath).mtimeMs : 0;
  const key = createHash('sha1')
    .update(JSON.stringify({ v: BUMPER_VERSION, kind, b, avatarStamp, target }))
    .digest('hex')
    .slice(0, 16);
  const out = join(cacheDir, `${kind}_${key}.mp4`);
  if (existsSync(out)) return out;
  mkdirSync(cacheDir, { recursive: true });
  const tmp = out.replace(/\.mp4$/, '.tmp.mp4');
  try {
    await renderBumper(kind, b, target, tmp, signal);
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(tmp.replace(/\.mp4$/, '.wav'), { force: true });
  }
  return out;
}

async function renderBumper(kind: BumperKind, b: Branding, target: BumperTarget, out: string, signal?: AbortSignal) {
  loadFonts();
  const { width: W, height: H } = target;
  const [num, den] = target.fps.split('/').map(Number);
  const fps = den ? num / den : num;
  const seconds = bumperSeconds(kind);
  const frames = Math.round(seconds * fps);

  let avatar: Image | null = null;
  if (kind === 'outro' && b.avatarPath && existsSync(b.avatarPath)) {
    avatar = await loadImage(b.avatarPath).catch(() => null);
  }

  // sound effects on the first track (the main mix), silence on the others
  const wav = out.replace(/\.mp4$/, '.wav');
  const first = target.audio[0];
  if (first) (kind === 'intro' ? introSound : outroSound)(first.sampleRate).writeWav(wav, Math.min(2, first.channels));
  const audioInputs = target.audio.flatMap((a, i) =>
    i === 0
      ? ['-i', wav]
      : ['-f', 'lavfi', '-i', `anullsrc=r=${a.sampleRate}:cl=${a.channels === 1 ? 'mono' : a.channels === 6 ? '5.1' : 'stereo'}`],
  );
  const maps = ['-map', '0:v', ...target.audio.flatMap((_, i) => ['-map', `${i + 1}:a`])];
  const channels = target.audio.flatMap((a, i) => [`-ac:a:${i}`, String(a.channels)]);

  const ff = spawn(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', target.fps, '-i', 'pipe:0',
      ...audioInputs,
      ...maps,
      '-t', seconds.toFixed(3),
      // canvas pixels are sRGB; tag-matched BT.709 so colors aren't shifted
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv',
      ...channels,
      ...target.encode,
      out,
    ],
    { signal, stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const exited = new Promise<number | null>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', resolve);
  });
  ff.stdin.on('error', () => {}); // ffmpeg failing early closes the pipe; the exit code reports it

  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  for (let i = 0; i < frames && !signal?.aborted; i++) {
    const t = i / fps;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (kind === 'intro') drawIntro(g, t, W, H, b);
    else drawOutro(g, t, W, H, b, avatar);
    if (!ff.stdin.write(canvas.data())) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), exited]);
    if (ff.exitCode !== null) break;
  }
  ff.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`${kind} render failed (${code}): ${stderr.trim()}`);
}
