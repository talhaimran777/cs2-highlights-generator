import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumperFile, bumperSeconds } from '../server/branding/bumper.ts';
import { DEFAULT_SETTINGS } from '../server/types.ts';
import { probe } from '../server/util/ffmpeg.ts';

const dir = mkdtempSync(join(tmpdir(), 'cs2h-bumper-'));
const branding = { ...DEFAULT_SETTINGS.branding, name: 'TEYEcs' };
// like an OBS recording with two tracks: the sound goes on the first, the second stays silent
const target = {
  width: 640,
  height: 360,
  fps: '30/1',
  audio: [{ sampleRate: 48000, channels: 2 }, { sampleRate: 44100, channels: 1 }],
  encode: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
};

describe('intro / outro', () => {
  for (const kind of ['intro', 'outro'] as const) {
    it(`renders the ${kind} with the target's size and audio tracks`, async () => {
      const file = await bumperFile(kind, branding, target, dir);
      const info = probe(file);
      expect(info.width).toBe(640);
      expect(info.duration).toBeCloseTo(bumperSeconds(kind), 1);
      expect(info.audio.map((a) => [a.sampleRate, a.channels])).toEqual([[48000, 2], [44100, 1]]);
    }, 60_000);
  }

  it('reuses the cached render for the same look', async () => {
    const a = await bumperFile('intro', branding, target, dir);
    const b = await bumperFile('intro', branding, target, dir);
    const c = await bumperFile('intro', { ...branding, name: 'Other' }, target, dir);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  }, 60_000);
});
