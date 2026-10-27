import { spawn, spawnSync } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export interface AudioStream {
  index: number;
  sampleRate: number;
  channels: number;
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: string; // as a rational, e.g. "60/1"
  audio: AudioStream[];
}

export function checkFfmpeg(): { ok: boolean; version?: string } {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false };
  return { ok: true, version: r.stdout.split('\n')[0] };
}

let nvencCache: boolean | null = null;
export function hasNvenc(): boolean {
  if (nvencCache === null) {
    const r = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1',
      '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ]);
    nvencCache = !r.error && r.status === 0;
  }
  return nvencCache;
}

export function probe(path: string): VideoInfo {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`ffprobe failed for ${path}: ${r.stderr || r.error}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error(`No video stream in ${path}`);
  return {
    duration: Number(j.format.duration),
    width: v.width,
    height: v.height,
    fps: v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate,
    audio: j.streams
      .filter((s: any) => s.codec_type === 'audio')
      .map((s: any) => ({ index: s.index, sampleRate: Number(s.sample_rate), channels: s.channels })),
  };
}

/**
 * Runs ffmpeg, reporting progress as seconds of output written.
 * Rejects with the tail of stderr on failure.
 */
export function runFfmpeg(args: string[], onProgress?: (sec: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-nostats', '-progress', 'pipe:1', ...args], {
      signal,
    });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    p.stdout.on('data', (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && onProgress) onProgress(Number(m[1]) / 1e6);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
}

/** Escapes a Windows path for use inside an ffmpeg filter option. */
export function filterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
