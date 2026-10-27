import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReel } from '../server/edit/render.ts';
import { checkFfmpeg, probe, runFfmpeg } from '../server/util/ffmpeg.ts';

const dir = mkdtempSync(join(tmpdir(), 'cs2h-'));
const src = join(dir, 'match.mp4');

describe.skipIf(!checkFfmpeg().ok)('render', () => {
  beforeAll(async () => {
    // 30 s 1080p60 test video with two audio tracks, like an OBS multi-track recording
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=30',
      '-f', 'lavfi', '-i', 'sine=f=440:d=30',
      '-f', 'lavfi', '-i', 'sine=f=880:d=30',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-ac', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src,
    ]);
  }, 120_000);

  it('cuts clips, adds round cards, keeps every audio track', async () => {
    const out = join(dir, 'reel.mp4');
    await renderReel({
      videoPath: src,
      info: probe(src),
      clips: [
        { round: 1, start: 2, end: 6, momentIds: [], label: '' },
        { round: 1, start: 10, end: 13, momentIds: [], label: '' },
        { round: 2, start: 20, end: 25, momentIds: [], label: '' },
      ],
      cards: new Map([
        [1, { title: 'ROUND 1', subtitle: "1 – 0   ·   3K (it's: fine)" }],
        [2, { title: 'ROUND 2', subtitle: '2 – 0' }],
      ]),
      outPath: out,
      workDir: join(dir, 'work'),
    });
    const info = probe(out);
    expect(info.width).toBe(1920);
    expect(info.audio).toHaveLength(2);
    expect(info.duration).toBeGreaterThan(4 + 3 + 5 + 3 - 0.3);
    expect(info.duration).toBeLessThan(4 + 3 + 5 + 3 + 0.5);
  }, 180_000);
});
