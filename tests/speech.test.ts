import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpeech, detectSpeech } from '../server/audio/speech.ts';
import { protectSpeech } from '../server/edit/plan.ts';
import { checkFfmpeg, probe, runFfmpeg } from '../server/util/ffmpeg.ts';
import type { Clip } from '../server/types.ts';

/** probabilities at 0.1 s per frame from a list of [start, end, p] spans */
function probs(spans: [number, number, number][], seconds: number) {
  const out = new Array(seconds * 10).fill(0.05);
  for (const [a, b, p] of spans) for (let i = a * 10; i < b * 10; i++) out[i] = p;
  return out;
}

describe('utterances', () => {
  it('joins runs with short gaps into one sentence, keeps the gaps as pauses', () => {
    const s = buildSpeech(probs([[1, 2, 0.9], [2.2, 3, 0.9], [5, 6, 0.9]], 10), 0.1);
    expect(s.utterances.map(([a, b]) => [+a.toFixed(1), +b.toFixed(1)])).toEqual([[1, 3], [5, 6]]);
    expect(s.raw).toHaveLength(3);
  });

  it('drops blips shorter than 0.3 s (gunshots, clicks)', () => {
    expect(buildSpeech(probs([[1, 1.2, 0.95]], 5), 0.1).utterances).toEqual([]);
  });

  it('hysteresis: dipping to 0.4 does not end speech, below 0.35 does', () => {
    const s = buildSpeech(probs([[1, 2, 0.9], [2, 2.5, 0.4], [2.5, 3, 0.9]], 5), 0.1);
    expect(s.raw).toHaveLength(1);
  });
});

const clip = (round: number, start: number, end: number, id = `${round}-${start}`): Clip => ({ round, start, end, momentIds: [id], label: id });
const settings = { speechMaxWait: 8, mergeGap: 1.5 };

describe('speech-safe cuts', () => {
  it('a cut mid-sentence waits for the sentence to end', () => {
    const out = protectSpeech([clip(1, 10, 20)], { raw: [[18, 23]], utterances: [[18, 23]] }, settings, 100);
    expect(out[0].end).toBeCloseTo(23.25);
    expect(out[0].speech!.end).toBeCloseTo(3.25);
  });

  it('a long monologue is cut at the first breath pause within 8 s', () => {
    const raw: [number, number][] = [[15, 22], [22.3, 26], [26.4, 40]];
    const out = protectSpeech([clip(1, 10, 20)], { raw, utterances: [[15, 40]] }, settings, 100);
    expect(out[0].end).toBeCloseTo(22.15); // middle of the 22.0–22.3 pause
  });

  it('no pause at all: cut at the 8 s limit', () => {
    const out = protectSpeech([clip(1, 10, 20)], { raw: [[15, 40]], utterances: [[15, 40]] }, settings, 100);
    expect(out[0].end).toBe(28);
  });

  it('a clip that would start mid-sentence starts with the sentence', () => {
    const out = protectSpeech([clip(1, 30, 40)], { raw: [[27, 32]], utterances: [[27, 32]] }, settings, 100);
    expect(out[0].start).toBeCloseTo(26.8);
  });

  it('cuts outside speech are left alone', () => {
    const out = protectSpeech([clip(1, 10, 20)], { raw: [[25, 27]], utterances: [[25, 27]] }, settings, 100);
    expect([out[0].start, out[0].end]).toEqual([10, 20]);
  });

  it('clips of a round that now touch become one, so no tiny cut remains', () => {
    const out = protectSpeech([clip(1, 10, 20, 'a'), clip(1, 24, 30, 'b')], { raw: [[19, 23]], utterances: [[19, 23]] }, settings, 100);
    expect(out.map((c) => [c.start, c.end, c.momentIds])).toEqual([[10, 30, ['a', 'b']]]);
  });

  it('rounds never overlap after extending', () => {
    const out = protectSpeech([clip(1, 10, 20), clip(2, 21, 30)], { raw: [[19, 24]], utterances: [[19, 24]] }, settings, 100);
    expect(out[1].start).toBeGreaterThanOrEqual(out[0].end);
  });
});

describe.skipIf(!checkFfmpeg().ok)('speech detection', () => {
  it('a steady tone is not speech', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs2h-speech-'));
    const video = join(dir, 'tone.mp4');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=s=320x240:r=30:d=20',
      '-f', 'lavfi', '-i', 'sine=f=440:d=20:sample_rate=44100',
      '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', video,
    ]);
    const s = await detectSpeech(video, probe(video), [0]);
    expect(s.utterances).toEqual([]);
  }, 120_000);
});
