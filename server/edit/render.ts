import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterPath, hasEncoder, runFfmpeg, type VideoInfo } from '../util/ffmpeg.ts';
import type { Clip } from '../types.ts';
import { FONTS_DIR } from '../captions/fonts.ts';

const CARD_SECONDS = 1.5;
const FONT = 'C:/Windows/Fonts/arialbd.ttf';

export interface RenderInput {
  videoPath: string;
  info: VideoInfo;
  clips: Clip[];
  /** round number -> title card text, only for rounds that get a card */
  cards: Map<number, { title: string; subtitle: string }>;
  outPath: string;
  workDir: string;
  /** ASS subtitles to burn into a clip (times relative to the clip), or null */
  captions?: (clip: Clip) => string | null;
  /** channel intro / outro, rendered with the same settings as the clips */
  intro?: Bookend;
  outro?: Bookend;
}

/** A ready-made segment added before or after the reel. */
export interface Bookend {
  dur: number;
  /** the segment's file (rendered and cached on first use) */
  file: (signal?: AbortSignal) => Promise<string>;
}

/** Per source codec: GPU encoder first, then the CPU one. */
const ENCODERS: Record<string, { gpu: string; cpu: string }> = {
  h264: { gpu: 'h264_nvenc', cpu: 'libx264' },
  hevc: { gpu: 'hevc_nvenc', cpu: 'libx265' },
  av1: { gpu: 'av1_nvenc', cpu: 'libsvtav1' },
};
const AUDIO_ENCODERS: Record<string, string> = { aac: 'aac', opus: 'libopus', mp3: 'libmp3lame' };
const PROFILES: Record<string, string> = {
  'h264:High': 'high', 'h264:Main': 'main', 'h264:Constrained Baseline': 'baseline', 'h264:Baseline': 'baseline',
  'hevc:Main': 'main', 'hevc:Main 10': 'main10',
};

export interface ExportSettings {
  encoder: string;
  codec: string;
  /** false when the source codec has no working encoder here and we fell back */
  sameCodec: boolean;
  bitRate: number | null; // null = no source bitrate known, quality mode used
  profile: string | null;
  pixFmt: string;
  audio: { encoder: string; bitRate: number; sampleRate: number; channels: number }[];
}

/** Export settings that match the source recording as closely as this machine can encode. */
export function exportSettings(info: VideoInfo): ExportSettings {
  const src = info.encoding;
  const wanted = ENCODERS[src.codec] ? src.codec : 'h264';
  const order = [wanted, 'h264'].flatMap((c) => [[c, ENCODERS[c].gpu], [c, ENCODERS[c].cpu]]);
  const [codec, encoder] = order.find(([, e]) => hasEncoder(e)) ?? ['h264', 'libx264'];
  const tenBit = /10/.test(src.pixFmt);
  return {
    encoder,
    codec,
    sameCodec: codec === src.codec,
    bitRate: src.bitRate,
    profile: codec === src.codec && src.profile ? (PROFILES[`${codec}:${src.profile}`] ?? null) : null,
    pixFmt: tenBit ? (encoder.endsWith('_nvenc') ? 'p010le' : 'yuv420p10le') : 'yuv420p',
    audio: info.audio.map((a) => ({
      encoder: AUDIO_ENCODERS[a.codec] ?? 'aac',
      bitRate: a.bitRate ?? 192_000,
      sampleRate: a.sampleRate,
      channels: a.channels,
    })),
  };
}

// ITU-T H.273 codes for the color tags OBS and games use.
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9 };
const TRANSFER: Record<string, number> = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13, 'bt2020-10': 14, smpte2084: 16, 'arib-std-b67': 18 };
const MATRIX: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020nc: 9 };

/**
 * NVENC ignores -color_primaries / -color_trc (it only writes matrix and
 * range), so the tags are written into the bitstream with a metadata filter.
 */
function colorMetadataFilter(codec: string, src: VideoInfo['encoding']): string[] {
  const p = src.colorPrimaries ? PRIMARIES[src.colorPrimaries] : undefined;
  const t = src.colorTransfer ? TRANSFER[src.colorTransfer] : undefined;
  const m = src.colorSpace ? MATRIX[src.colorSpace] : undefined;
  if (p === undefined || t === undefined || m === undefined) return [];
  const full = src.colorRange === 'pc';
  if (codec === 'av1') {
    return ['-bsf:v', `av1_metadata=color_primaries=${p}:transfer_characteristics=${t}:matrix_coefficients=${m}:color_range=${full ? 'pc' : 'tv'}`];
  }
  return ['-bsf:v', `${codec}_metadata=colour_primaries=${p}:transfer_characteristics=${t}:matrix_coefficients=${m}:video_full_range_flag=${full ? 1 : 0}`];
}

/** ffmpeg output options for `exportSettings`: target the source bitrate, keep its profile and colors. */
export function encodeArgs(info: VideoInfo): string[] {
  const x = exportSettings(info);
  const src = info.encoding;
  const nvenc = x.encoder.endsWith('_nvenc');
  const kbps = (b: number) => `${Math.round(b / 1000)}k`;

  const rate = x.bitRate
    ? [
        ...(nvenc ? ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr'] : x.encoder === 'libsvtav1' ? ['-preset', '8'] : ['-preset', 'medium']),
        '-b:v', kbps(x.bitRate), '-maxrate', kbps(x.bitRate * 1.5), '-bufsize', kbps(x.bitRate * 2),
      ]
    : nvenc
      ? ['-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
      : x.encoder === 'libsvtav1'
        ? ['-preset', '8', '-crf', '30']
        : ['-preset', 'medium', '-crf', x.codec === 'hevc' ? '20' : '18'];

  const color = [
    ['-colorspace', src.colorSpace],
    ['-color_primaries', src.colorPrimaries],
    ['-color_trc', src.colorTransfer],
    ['-color_range', src.colorRange],
  ].flatMap(([flag, v]) => (v && v !== 'unknown' ? [flag!, v] : []));

  return [
    '-c:v', x.encoder, ...rate,
    ...(x.profile ? ['-profile:v', x.profile] : []),
    '-pix_fmt', x.pixFmt, ...color, ...colorMetadataFilter(x.codec, src),
    ...(x.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []), // so players and editors recognise HEVC in MP4
    '-r', info.fps, '-video_track_timescale', '90000',
    ...x.audio.flatMap((a, i) => [`-c:a:${i}`, a.encoder, `-b:a:${i}`, kbps(a.bitRate), `-ar:a:${i}`, String(a.sampleRate)]),
  ];
}

/**
 * Every segment (clips and title cards) is encoded with identical stream
 * layout, so the final join is a lossless concat. All OBS audio tracks are kept.
 */
export async function renderReel(
  input: RenderInput,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { info, clips, workDir } = input;
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const common = encodeArgs(info);

  const plan: { kind: 'bookend' | 'card' | 'clip'; dur: number; run: (out: string, prog: (s: number) => void) => Promise<void> }[] = [];
  const bookend = (b: Bookend) => ({
    kind: 'bookend' as const,
    dur: b.dur,
    run: async (out: string) => copyFileSync(await b.file(signal), out),
  });
  if (input.intro) plan.push(bookend(input.intro));
  const seenRounds = new Set<number>();
  for (const clip of clips) {
    const card = input.cards.get(clip.round);
    if (card && !seenRounds.has(clip.round)) {
      seenRounds.add(clip.round);
      plan.push({ kind: 'card', dur: CARD_SECONDS, run: (out, prog) => renderCard(info, card, common, out, workDir, prog, signal) });
    }
    const dur = clip.end - clip.start;
    const fade = Math.min(0.1, dur / 4);
    const ass = input.captions?.(clip) ?? null;
    plan.push({
      kind: 'clip',
      dur,
      run: (out, prog) => {
        // captions are burned in while the clip is encoded anyway
        let vf: string[] = [];
        if (ass) {
          const assFile = out.replace(/\.mp4$/, '.ass');
          writeFileSync(assFile, ass);
          vf = ['-vf', `ass='${filterPath(assFile)}':fontsdir='${filterPath(FONTS_DIR)}'`];
        }
        return runFfmpeg(
          [
            '-ss', clip.start.toFixed(3), '-i', input.videoPath, '-t', dur.toFixed(3),
            '-map', '0:v:0', '-map', '0:a?',
            ...vf,
            '-af', `afade=t=in:d=${fade},afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade}`,
            ...common, out,
          ],
          prog,
          signal,
        );
      },
    });
  }

  if (input.outro) plan.push(bookend(input.outro));

  const total = plan.reduce((s, p) => s + p.dur, 0);
  let done = 0;
  const segments: string[] = [];
  for (const [i, step] of plan.entries()) {
    const out = join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
    await step.run(out, (s) => onProgress?.(Math.min(0.99, (done + Math.min(s, step.dur)) / total)));
    done += step.dur;
    segments.push(out);
  }

  const list = join(workDir, 'segments.txt');
  writeFileSync(list, segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-movflags', '+faststart', input.outPath], undefined, signal);
  onProgress?.(1);
  rmSync(workDir, { recursive: true, force: true });
  return input.outPath;
}

function renderCard(
  info: VideoInfo,
  card: { title: string; subtitle: string },
  common: string[],
  out: string,
  workDir: string,
  prog: (s: number) => void,
  signal?: AbortSignal,
) {
  // textfile= avoids drawtext's escaping rules for ':' and quotes in player names
  const titleFile = join(workDir, 'card_title.txt');
  const subFile = join(workDir, 'card_sub.txt');
  writeFileSync(titleFile, card.title);
  writeFileSync(subFile, card.subtitle || ' ');
  const size = `${info.width}x${info.height}`;
  const big = Math.round(info.height / 9);
  const small = Math.round(info.height / 22);
  const text = (file: string, px: number, y: string, color: string) =>
    `drawtext=fontfile='${filterPath(FONT)}':textfile='${filterPath(file)}':fontsize=${px}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`;
  const vf = [
    text(titleFile, big, `(h/2)-${big}`, 'white'),
    text(subFile, small, `(h/2)+${Math.round(small * 0.6)}`, '0xF5A623'),
    `fade=t=in:d=0.25,fade=t=out:st=${CARD_SECONDS - 0.25}:d=0.25`,
  ].join(',');

  const audioInputs = info.audio.flatMap((a) => [
    '-f', 'lavfi', '-i', `anullsrc=r=${a.sampleRate}:cl=${a.channels === 1 ? 'mono' : a.channels === 6 ? '5.1' : 'stereo'}`,
  ]);
  const maps = ['-map', '0:v', ...info.audio.flatMap((_, i) => ['-map', `${i + 1}:a`])];

  return runFfmpeg(
    [
      '-f', 'lavfi', '-i', `color=c=0x0D0F14:s=${size}:r=${info.fps}`,
      ...audioInputs,
      '-t', String(CARD_SECONDS), '-vf', vf, ...maps, ...common, out,
    ],
    prog,
    signal,
  );
}
