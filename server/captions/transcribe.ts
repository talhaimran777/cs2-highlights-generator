import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FFMPEG, runFfmpeg } from '../util/ffmpeg.ts';
import { romanize } from './romanize.ts';
import { mergeEnglish } from './merge.ts';
import type { CaptionLine, CaptionWord } from '../types.ts';

const TOOLS = resolve(process.env.CS2H_TOOLS ?? 'tools');
const MODEL = join(TOOLS, 'models', 'ggml-large-v3-turbo.bin');
const SAMPLE_RATE = 16000;
const PAD_S = 0.3; // a little audio either side so first/last words aren't clipped

/** whisper.cpp builds, best first: the GPU (CUDA) build, then the CPU build. */
export function whisperBinaries(): string[] {
  return ['whisper-cuda', 'whisper-cpu']
    .map((dir) => [join(TOOLS, dir, 'whisper-cli.exe'), join(TOOLS, dir, 'Release', 'whisper-cli.exe')])
    .flat()
    .filter(existsSync);
}

export function captionsReady(): { ok: boolean; missing: string[] } {
  const missing = [];
  if (whisperBinaries().length === 0) missing.push('whisper.cpp (tools/whisper-cuda or tools/whisper-cpu)');
  if (!existsSync(MODEL)) missing.push('speech model (tools/models/ggml-large-v3-turbo.bin)');
  return { ok: missing.length === 0, missing };
}

// Whisper's tags for non-speech, and lines it tends to invent on noise.
const NOISE_TAG = /^[[(].*[\])]$/;
const HALLUCINATIONS = [/thanks? (you )?for watching/i, /^thank you\.?$/i, /subscribe/i, /^you$/i, /^\.+$/];

interface WhisperWord {
  start: number;
  end: number;
  text: string;
}

/** Parses whisper.cpp JSON with one word per segment (-ml 1 -sow). */
export function parseWhisperJson(json: any): { language: string; words: WhisperWord[] } {
  const words = (json.transcription ?? [])
    .map((s: any) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: String(s.text).trim() }))
    .filter((w: WhisperWord) => w.text && !NOISE_TAG.test(w.text));
  return { language: json.result?.language ?? 'en', words };
}

/** Whisper sometimes loops on a word ("sim sim sim sim sim"); keep at most two in a row. */
export function collapseRepeats<T extends { text: string }>(words: T[]): T[] {
  const key = (w: T) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return words.filter((w, i) => !(i >= 2 && key(w) && key(w) === key(words[i - 1]) && key(w) === key(words[i - 2])));
}

function wavFile(samples: Int16Array): Buffer {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, bytes)]);
}

/** Runs whisper-cli over files; progress counts files as whisper starts on them. */
// Nudges the English pass towards game vocabulary it would otherwise mishear.
const CS_PROMPT = 'CS2 callouts: A site, B site, mid, long, short, banana, AWP, deagle, HP, one HP, smoke, flash, molly, nade, rotate, eco, force buy, clutch, ace, bhai, yaar.';

function runWhisper(bin: string, files: string[], language: string, onFile: () => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(
      bin,
      // -ml 1 -sow: one word per segment; -sns: no "(gunshots)"-style tokens
      ['-m', MODEL, '-l', language, '-ml', '1', '-sow', '-sns', '-oj', '-ojf', '-t', '8', ...(language === 'en' ? ['--prompt', CS_PROMPT] : []), ...files],
      { signal },
    );
    p.stdout.resume(); // transcripts also go to stdout; drain it so whisper never blocks
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-4000);
      for (const _ of s.matchAll(/processing '/g)) onFile();
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`whisper exited ${code}: ${stderr.trim().slice(-800)}`))));
  });
}

const SPAN_GAP_S = 5; // utterances closer than this are decoded in one go

/** Recording ranges to decode: each utterance with its padding, close ones joined. */
export function audioSpans(utterances: [number, number][]): [number, number][] {
  const spans: [number, number][] = [];
  for (const [a, b] of [...utterances].sort((x, y) => x[0] - y[0])) {
    const from = Math.max(0, a - PAD_S);
    const to = b + PAD_S;
    const last = spans.at(-1);
    if (last && from - last[1] <= SPAN_GAP_S) last[1] = Math.max(last[1], to);
    else spans.push([from, to]);
  }
  return spans;
}

/**
 * Transcribes the given utterances (recording seconds) from the voice track(s).
 * English words stay English; Urdu is written in Roman Urdu.
 */
export async function transcribe(
  videoPath: string,
  utterances: [number, number][],
  tracks: number[],
  workDir: string,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<CaptionLine[]> {
  const bins = whisperBinaries();
  if (!bins.length || !existsSync(MODEL)) throw new Error(`Captions aren't set up: ${captionsReady().missing.join(', ')}`);
  if (utterances.length === 0) return [];
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  // 1. the voice audio as 16 kHz mono, only around the utterances (not the whole recording):
  //    nearby utterances share one seek-and-decode
  const audio = tracks.length <= 1
    ? ['-map', `0:a:${tracks[0] ?? 0}`]
    : ['-filter_complex', `${tracks.map((t) => `[0:a:${t}]`).join('')}amix=inputs=${tracks.length}:normalize=0[v]`, '-map', '[v]'];
  const spans = audioSpans(utterances);
  const pcmPath = join(workDir, 'voice.s16');
  const decoded: { from: number; samples: Int16Array }[] = [];
  for (const [i, [from, to]] of spans.entries()) {
    await runFfmpeg(
      ['-ss', from.toFixed(3), '-i', videoPath, '-t', (to - from).toFixed(3), '-vn', ...audio, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', pcmPath],
      undefined,
      signal,
    );
    const pcm = readFileSync(pcmPath);
    decoded.push({ from, samples: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1) });
    onProgress?.((0.1 * (i + 1)) / spans.length);
  }
  rmSync(pcmPath, { force: true });

  // 2. one WAV per utterance
  const items = utterances.map(([a, b], i) => {
    const from = Math.max(0, a - PAD_S);
    const to = b + PAD_S;
    const span = decoded.find((d, j) => from >= d.from - 1e-6 && to <= spans[j][1] + 1e-6)!;
    const file = join(workDir, `u${String(i).padStart(4, '0')}.wav`);
    writeFileSync(file, wavFile(span.samples.subarray(Math.floor((from - span.from) * SAMPLE_RATE), Math.ceil((to - span.from) * SAMPLE_RATE))));
    return { from, start: a, end: b, file };
  });

  // 3. two passes over every utterance (see merge.ts for why language detection isn't used):
  //    Hindi script captures every word as spoken; English spells the English words properly.
  const totalWork = items.length * 2;
  let done = 0;
  const tick = () => onProgress?.(Math.min(0.99, 0.1 + (0.9 * ++done) / totalWork));
  const run = async (lang: string) => {
    let lastErr: unknown;
    for (const bin of bins) {
      try {
        await runWhisper(bin, items.map((x) => x.file), lang, tick, signal);
        return items.map((x) => parseWhisperJson(JSON.parse(readFileSync(`${x.file}.json`, 'utf8'))).words);
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e; // e.g. the CUDA build failing on this GPU: try the CPU build
      }
    }
    throw lastErr;
  };
  const spoken = await run('hi');
  const english = await run('en');

  // 4. merge, back to recording time, hallucinations dropped
  const lines: CaptionLine[] = [];
  items.forEach((x, i) => {
    const source = spoken[i].map((w) => w.text).join(' ');
    const roman = spoken[i].map((w) => ({ ...w, text: romanize(w.text) }));
    const both = roman.length ? mergeEnglish(roman, english[i]) : { words: english[i], englishCount: english[i].length };
    const merged = { ...both, words: collapseRepeats(both.words) };
    const text = merged.words.map((w) => w.text).join(' ');
    if (!text.trim() || HALLUCINATIONS.some((h) => h.test(text.trim()))) return;
    const words: CaptionWord[] = merged.words.map((w) => ({ start: x.from + w.start, end: x.from + w.end, text: w.text }));
    const lang = merged.englishCount >= 0.8 * merged.words.length ? 'en' : 'ur';
    lines.push({ id: `u${x.start.toFixed(2)}`, start: x.start, end: x.end, lang, source: source || text, words });
  });
  rmSync(workDir, { recursive: true, force: true });
  onProgress?.(1);
  return lines;
}
