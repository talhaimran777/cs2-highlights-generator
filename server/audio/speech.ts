import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { FFMPEG, type VideoInfo } from '../util/ffmpeg.ts';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
// Silero VAD (v4) as shipped by @ricky0123/vad-node
const MODEL = join(dirname(require.resolve('@ricky0123/vad-node')), 'silero_vad.onnx');

const SAMPLE_RATE = 16000;
const FRAME = 512; // 32 ms; one of the frame sizes Silero was trained on
export const FRAME_SEC = FRAME / SAMPLE_RATE;

const SPEECH_ON = 0.5; // probability to start speech
const SPEECH_OFF = 0.35; // stays speech until it drops below this
const UTTERANCE_GAP_S = 0.4; // segments closer than this are one sentence
const MIN_UTTERANCE_S = 0.3; // shorter "speech" is usually a gunshot or click

export type Span = [number, number];

export interface Speech {
  tracks: number[];
  /** speech runs; the gaps between them are breath pauses */
  raw: Span[];
  /** raw runs joined into sentences / callouts */
  utterances: Span[];
}

/** Hysteresis over per-frame speech probabilities, then sentence grouping. */
export function buildSpeech(probs: ArrayLike<number>, frameSec = FRAME_SEC): Omit<Speech, 'tracks'> {
  const runs: Span[] = [];
  let start = -1;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (start < 0 && p >= SPEECH_ON) start = i;
    else if (start >= 0 && p < SPEECH_OFF) {
      runs.push([start * frameSec, i * frameSec]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start * frameSec, probs.length * frameSec]);

  const joined: Span[] = [];
  for (const r of runs) {
    const last = joined.at(-1);
    if (last && r[0] - last[1] < UTTERANCE_GAP_S) last[1] = r[1];
    else joined.push([...r]);
  }
  const utterances = joined.filter(([a, b]) => b - a >= MIN_UTTERANCE_S);
  const raw = runs.filter(([a, b]) => utterances.some(([ua, ub]) => a >= ua && b <= ub));
  return { raw, utterances };
}

/**
 * Speech detection on the recording's voice track(s): ffmpeg streams 16 kHz
 * mono, band-passed to the speech range so explosions and high game sounds
 * are dampened, and Silero scores every 32 ms frame.
 */
export async function detectSpeech(
  videoPath: string,
  info: VideoInfo,
  tracks: number[],
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Speech> {
  if (tracks.length === 0) return { tracks, raw: [], utterances: [] };
  const session = await ort.InferenceSession.create(MODEL);
  const band = 'highpass=f=150,lowpass=f=4000';
  const audio =
    tracks.length === 1
      ? ['-map', `0:a:${tracks[0]}`, '-af', band]
      : ['-filter_complex', `${tracks.map((t) => `[0:a:${t}]`).join('')}amix=inputs=${tracks.length}:normalize=0,${band}[v]`, '-map', '[v]'];
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

  const totalFrames = Math.ceil((info.duration * SAMPLE_RATE) / FRAME);
  const probs = new Float32Array(totalFrames + 64);
  let n = 0;
  let h = new ort.Tensor('float32', new Float32Array(128), [2, 1, 64]);
  let c = new ort.Tensor('float32', new Float32Array(128), [2, 1, 64]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]));
  const frameBytes = FRAME * 4;
  let pending: Buffer = Buffer.alloc(0);

  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    for (; off + frameBytes <= pending.length; off += frameBytes) {
      const frame = new Float32Array(pending.buffer.slice(pending.byteOffset + off, pending.byteOffset + off + frameBytes) as ArrayBuffer);
      const out = await session.run({ input: new ort.Tensor('float32', frame, [1, FRAME]), sr, h, c });
      h = out.hn as typeof h;
      c = out.cn as typeof c;
      if (n < probs.length) probs[n] = (out.output.data as Float32Array)[0];
      n++;
      if (onProgress && n % 2000 === 0) onProgress(Math.min(0.99, n / totalFrames));
    }
    pending = pending.subarray(off);
  }
  const code = await exited;
  if (code !== 0) throw new Error(`speech detection failed (${code}): ${stderr.trim()}`);
  onProgress?.(1);
  return { tracks, ...buildSpeech(probs.subarray(0, n)) };
}
