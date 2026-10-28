import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FFMPEG, runFfmpeg } from '../util/ffmpeg.ts';
import { romanize } from './romanize.ts';
import { mergeEnglish, soundKey, type TimedWord } from './merge.ts';
import { retime, spreadWords } from './cleanup.ts';
import { alignWords, envelope, lineRange } from './align.ts';
import { CHUNK_GAP_S, chunkSlots, cutWords, planChunks } from './chunks.ts';
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

const JOIN_S = 0.6; // utterances closer than this are one sentence the speech detector cut up

/** Utterances in order, with ones that nearly touch joined into one. */
export function joinNear(utterances: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...utterances].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a - last[1] < JOIN_S) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
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

/** The voice track(s) as 16 kHz mono, decoded only around the given ranges (not the whole recording). */
async function decodeVoice(videoPath: string, ranges: [number, number][], tracks: number[], workDir: string, onProgress?: (f: number) => void, signal?: AbortSignal) {
  const audio = tracks.length <= 1
    ? ['-map', `0:a:${tracks[0] ?? 0}`]
    : ['-filter_complex', `${tracks.map((t) => `[0:a:${t}]`).join('')}amix=inputs=${tracks.length}:normalize=0[v]`, '-map', '[v]'];
  // nearby ranges share one seek-and-decode
  const spans = audioSpans(ranges);
  const pcmPath = join(workDir, 'voice.s16');
  const decoded: { from: number; to: number; samples: Int16Array }[] = [];
  for (const [i, [from, to]] of spans.entries()) {
    await runFfmpeg(
      ['-ss', from.toFixed(3), '-i', videoPath, '-t', (to - from).toFixed(3), '-vn', ...audio, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', pcmPath],
      undefined,
      signal,
    );
    const pcm = readFileSync(pcmPath);
    decoded.push({ from, to, samples: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1) });
    onProgress?.((i + 1) / spans.length);
  }
  rmSync(pcmPath, { force: true });
  /** Samples for [from, to] (recording seconds), which must lie inside one of the ranges. */
  return (from: number, to: number) => {
    const span = decoded.find((d) => from >= d.from - 1e-6 && to <= d.to + 1e-6)!;
    return span.samples.subarray(Math.max(0, Math.floor((from - span.from) * SAMPLE_RATE)), Math.ceil((to - span.from) * SAMPLE_RATE));
  };
}

/** Snaps the words of already transcribed lines to the voice audio (see align.ts). */
export async function alignLines(
  videoPath: string,
  lines: CaptionLine[],
  tracks: number[],
  workDir: string,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<CaptionLine[]> {
  if (lines.length === 0) return [];
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const ranges = lines.map(lineRange).map(([a, b]): [number, number] => [Math.max(0, a), b]);
  const voice = await decodeVoice(videoPath, ranges, tracks, workDir, onProgress, signal);
  rmSync(workDir, { recursive: true, force: true });
  return lines.map((l, i) => {
    const [from, to] = ranges[i];
    return { ...l, words: alignWords(l.words, envelope(voice(from, to), SAMPLE_RATE), from), aligned: true };
  });
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

  // 1. the voice audio, only around the utterances
  const sorted = joinNear(utterances);
  const ranges = sorted.map(([a, b]): [number, number] => [Math.max(0, a - PAD_S), b + PAD_S]);
  const voice = await decodeVoice(videoPath, ranges, tracks, workDir, (f) => onProgress?.(0.1 * f), signal);
  const items = sorted.map(([a, b], i) => {
    const [from, to] = ranges[i];
    const samples = voice(from, to);
    return { from, start: a, end: b, samples, env: envelope(samples, SAMPLE_RATE) };
  });

  // 2. utterances joined into chunks so Whisper hears them in context (see chunks.ts)
  const chunks = planChunks(ranges).map((idx, c) => {
    const slots = chunkSlots(idx.map((i) => ranges[i][1] - ranges[i][0]));
    const gap = new Int16Array(Math.round(CHUNK_GAP_S * SAMPLE_RATE));
    const parts = idx.flatMap((i, k) => (k ? [gap, items[i].samples] : [items[i].samples]));
    const all = new Int16Array(parts.reduce((n, x) => n + x.length, 0));
    parts.reduce((o, x) => (all.set(x, o), o + x.length), 0);
    const file = join(workDir, `c${String(c).padStart(4, '0')}.wav`);
    writeFileSync(file, wavFile(all));
    return { idx, slots, file, env: envelope(all, SAMPLE_RATE) };
  });

  // 3. passes (see merge.ts for why language detection isn't used): the chunks
  //    in Hindi script, which captures every word as spoken, and in English,
  //    which spells the English words properly; then each utterance alone in
  //    Hindi script, which tells where its words are (see cutWords)
  const alone = items.map((x, i) => {
    const file = join(workDir, `u${String(i).padStart(4, '0')}.wav`);
    writeFileSync(file, wavFile(x.samples));
    return file;
  });
  const totalWork = chunks.length * 2 + alone.length;
  let done = 0;
  const tick = () => onProgress?.(Math.min(0.99, 0.1 + (0.9 * ++done) / totalWork));
  const run = async (files: string[], lang: string) => {
    let lastErr: unknown;
    for (const bin of bins) {
      try {
        await runWhisper(bin, files, lang, tick, signal);
        return files.map((f) => parseWhisperJson(JSON.parse(readFileSync(`${f}.json`, 'utf8'))).words);
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e; // e.g. the CUDA build failing on this GPU: try the CPU build
      }
    }
    throw lastErr;
  };
  const files = chunks.map((c) => c.file);
  const spoken = await run(files, 'hi');
  const english = await run(files, 'en');
  const heardAlone = (await run(alone, 'hi')).map((ws) => ws.map((w) => ({ ...w, text: romanize(w.text) })));

  // 4. per chunk: English spellings merged in, then cut back into utterances
  const found = items.map(() => ({ words: [] as TimedWord[], source: [] as string[], english: [] as boolean[] }));
  chunks.forEach((c, ci) => {
    const roman = spoken[ci].map((w) => ({ ...w, text: romanize(w.text) }));
    const base = roman.length ? mergeEnglish(roman, english[ci]).words : english[ci];
    const source = roman.length ? spoken[ci].map((w) => w.text) : base.map((w) => w.text);
    const isEnglish = base.map((w, j) => !roman.length || w.text !== roman[j].text);
    // snapped to the silences between utterances first, so the timing points the right way
    const timed = alignWords(base, c.env, 0);
    const cuts = cutWords(timed, c.slots, c.idx.map((i) => heardAlone[i].map((w) => w.text)), soundKey);
    c.idx.forEach((i, k) => {
      const [from, to] = [cuts[k], cuts[k + 1]];
      found[i] = { words: base.slice(from, to), source: source.slice(from, to), english: isEnglish.slice(from, to) };
    });
  });

  // 5. back to recording time, hallucinations dropped
  const lines: CaptionLine[] = [];
  items.forEach((x, i) => {
    const heard = heardAlone[i];
    // nothing for it in the chunk (a quick "one, one, one" can get skipped in context): use it heard alone
    const f = found[i].words.length ? found[i] : { words: heard, source: heard.map((w) => w.text), english: heard.map(() => false) };
    const keep = collapseRepeats(f.words.map((w, j) => ({ ...w, j })));
    const tokens = keep.map((w) => w.text);
    const text = tokens.join(' ');
    if (!text.trim() || HALLUCINATIONS.some((h) => h.test(text.trim()))) return;
    // timing from the utterance heard alone: in a chunk Whisper's word times drift
    const dur = x.samples.length / SAMPLE_RATE;
    const rel = heard.length ? retime(heard, tokens, { start: 0, end: dur }) : spreadWords(tokens, Math.min(PAD_S, dur), Math.max(0, dur - PAD_S));
    const timed: CaptionWord[] = rel.map((w) => ({ start: x.from + w.start, end: x.from + w.end, text: w.text }));
    const words = alignWords(timed, x.env, x.from);
    const englishCount = keep.filter((w) => f.english[w.j]).length;
    const lang = englishCount >= 0.8 * keep.length ? 'en' : 'ur';
    lines.push({ id: `u${x.start.toFixed(2)}`, start: x.start, end: x.end, lang, source: f.source.join(' ') || text, words, aligned: true });
  });
  rmSync(workDir, { recursive: true, force: true });
  onProgress?.(1);
  return lines;
}
