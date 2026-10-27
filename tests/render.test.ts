import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeArgs, exportSettings, renderReel } from '../server/edit/render.ts';
import { checkFfmpeg, FFPROBE, hasEncoder, probe, runFfmpeg } from '../server/util/ffmpeg.ts';

const dir = mkdtempSync(join(tmpdir(), 'cs2h-'));

/** 30 s 1080p60 source with two AAC tracks (like OBS multi-track) at a known bitrate. */
async function makeSource(name: string, encoder: string, bitrate: string) {
  const out = join(dir, name);
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=30',
    '-f', 'lavfi', '-i', 'sine=f=440:d=30:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=f=880:d=30:sample_rate=44100',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-ac', '2',
    '-c:v', encoder, '-b:v', bitrate, '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '160k', out,
  ]);
  return out;
}

async function renderFrom(src: string, name: string) {
  const out = join(dir, name);
  await renderReel({
    videoPath: src,
    info: probe(src),
    clips: [
      { round: 1, start: 2, end: 8, momentIds: [], label: '' },
      { round: 1, start: 10, end: 16, momentIds: [], label: '' },
      { round: 2, start: 20, end: 28, momentIds: [], label: '' },
    ],
    cards: new Map([
      [1, { title: 'ROUND 1', subtitle: "1 – 0   ·   3K (it's: fine)" }],
      [2, { title: 'ROUND 2', subtitle: '2 – 0' }],
    ]),
    outPath: out,
    workDir: join(dir, `work-${name}`),
  });
  return out;
}

function videoStreamTags(path: string) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_tag_string', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  return r.stdout.trim();
}

describe.skipIf(!checkFfmpeg().ok)('export settings', () => {
  const obsHevc = {
    duration: 60, width: 1920, height: 1080, fps: '60/1',
    encoding: {
      codec: 'hevc', profile: 'Main', pixFmt: 'yuv420p', bitRate: 17_963_711,
      colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorRange: 'tv',
    },
    audio: [{ index: 1, codec: 'aac', sampleRate: 44100, channels: 2, bitRate: 197_498 }],
  };

  it('targets the source bitrate and writes BT.709 tags into the stream (NVENC ignores the flags)', () => {
    const args = encodeArgs(obsHevc).join(' ');
    expect(args).toContain('-b:v 17964k');
    expect(args).toContain('-b:a:0 197k -ar:a:0 44100');
    expect(args).toContain('hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0');
  });

  it('without a known source bitrate it falls back to quality mode', () => {
    const args = encodeArgs({ ...obsHevc, encoding: { ...obsHevc.encoding, bitRate: null } }).join(' ');
    expect(args).not.toContain('-b:v 1');
    expect(args).toMatch(/-cq 19|-crf 20/);
  });
});

describe.skipIf(!checkFfmpeg().ok)('render', () => {
  const hevcEncoder = hasEncoder('hevc_nvenc') ? 'hevc_nvenc' : 'libx265';
  let h264Src = '';
  let hevcSrc = '';

  beforeAll(async () => {
    h264Src = await makeSource('h264.mp4', 'libx264', '8M');
    hevcSrc = await makeSource('hevc.mp4', hevcEncoder, '12M');
  }, 300_000);

  it('cuts clips, adds round cards, keeps every audio track', async () => {
    const info = probe(await renderFrom(h264Src, 'reel-h264.mp4'));
    expect(info.width).toBe(1920);
    expect(info.audio).toHaveLength(2);
    expect(info.duration).toBeGreaterThan(6 + 6 + 8 + 3 - 0.3);
    expect(info.duration).toBeLessThan(6 + 6 + 8 + 3 + 0.5);
  }, 300_000);

  it('matches an H.264 source: codec, bitrate, colors, audio', async () => {
    const src = probe(h264Src);
    const out = probe(await renderFrom(h264Src, 'reel-h264-match.mp4'));
    expect(out.encoding.codec).toBe('h264');
    for (const k of ['colorSpace', 'colorPrimaries', 'colorTransfer', 'colorRange'] as const) {
      expect(out.encoding[k]).toBe(src.encoding[k]);
    }
    expect(out.encoding.bitRate! / src.encoding.bitRate!).toBeGreaterThan(0.7);
    expect(out.encoding.bitRate! / src.encoding.bitRate!).toBeLessThan(1.3);
    expect(out.audio.map((a) => [a.codec, a.sampleRate])).toEqual(src.audio.map((a) => [a.codec, a.sampleRate]));
    for (const [i, a] of out.audio.entries()) expect(Math.abs(a.bitRate! - src.audio[i].bitRate!)).toBeLessThan(25_000);
  }, 300_000);

  it('matches an HEVC source (like an OBS HEVC recording) and tags it hvc1', async () => {
    const src = probe(hevcSrc);
    expect(exportSettings(src)).toMatchObject({ codec: 'hevc', sameCodec: true, profile: 'main' });
    const reel = await renderFrom(hevcSrc, 'reel-hevc.mp4');
    const out = probe(reel);
    expect(out.encoding.codec).toBe('hevc');
    expect(out.encoding.profile).toBe('Main');
    expect(videoStreamTags(reel)).toBe('hvc1');
    expect(out.encoding.bitRate! / src.encoding.bitRate!).toBeGreaterThan(0.7);
    expect(out.encoding.bitRate! / src.encoding.bitRate!).toBeLessThan(1.3);
  }, 300_000);
});
