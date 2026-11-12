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
  /** ASS subtitles to burn into a clip (times relative to the clip), or null; several are layered in order */
  captions?: (clip: Clip) => string | null | (string | null)[];
  /** channel intro / outro, rendered with the same settings as the clips */
  intro?: Bookend;
  outro?: Bookend;
  /** several files on one timeline (clips mode): the file a clip comes from and where it starts */
  sourceOf?: (clip: Clip) => { path: string; info: VideoInfo; offset: number };
  /**
   * A different output frame (a vertical short): its size, and the filter graph
   * that makes it from a source's video ([0:v] in, its last chain's output out).
   */
  frame?: { width: number; height: number; graph: (src: VideoInfo) => string; overlays?: (clip: Clip) => Overlay[] };
  /** made for Instagram, TikTok and Facebook (see SOCIAL) instead of the source's own settings */
  social?: boolean;
  /** the cold open ("coming up"): shots played first, hard cut, before the intro; their text comes from `captions` */
  teaser?: Clip[];
  /** a clip's own look (a cold open's grade, flashes and impact), `dur` being how long it plays */
  look?: (clip: Clip, dur: number) => ClipLook | null;
}

/** A picture laid over a clip from `from` seconds into it (sliding in when that's inside the clip), in output pixels. */
export interface Overlay {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  from: number;
  /** where it slides in from: +1 the right (default), -1 the left, 0 it only fades in */
  slide?: number;
  /** 1 (default) = solid */
  opacity?: number;
  /** when it's gone (seconds into the clip), faded out over the `fadeOut` seconds before; missing = up to the end */
  until?: number;
  fadeOut?: number;
  /** it moves up by `by` pixels at each of these times (into the clip), over `over` seconds: a kill-feed row whose rows above are gone */
  up?: { at: number[]; by: number; over: number };
}

const SLIDE_S = 0.18;
/** a cold open's shots cut hard: their sound only just faded, so a cut doesn't click */
const TEASER_FADE_S = 0.02;

/**
 * The clip's sound faded in and out at its cuts; not at a seamless edge (a
 * looping short's seam) or where it's crossfaded with its neighbour.
 */
function afadeFilter(clip: Clip, next: Clip | undefined, dur: number, fade: number): string | null {
  const parts = [
    ...(clip.seamless === 'start' || clip.blend ? [] : [`afade=t=in:d=${fade}`]),
    ...(clip.seamless === 'end' || next?.blend ? [] : [`afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade}`]),
  ];
  return parts.length ? parts.join(',') : null;
}
const afade = (clip: Clip, next: Clip | undefined, dur: number, fade: number): string[] => {
  const f = afadeFilter(clip, next, dur, fade);
  return f ? ['-af', f] : [];
};

/**
 * A clip's own look (a cold open's shot): video filters under its captions
 * (`before`, a grade) and over them (`after`, a flash), and a sound mixed
 * into its first audio track as it starts (an impact).
 */
export interface ClipLook {
  before: string[];
  after: string[];
  impact: { file: string; volume: number } | null;
}

/** ffmpeg inputs and graph that lay the overlays (inputs 1..n) over `[in]`, ending in `[out]`. */
export function overlayGraph(overlays: Overlay[], fps: string): { inputs: string[]; graph: string } {
  const inputs = overlays.flatMap((o) => ['-loop', '1', '-framerate', fps, '-i', o.file]);
  const steps = overlays.map((o, n) => {
    const from = Math.max(0, o.from).toFixed(3);
    const slides = o.from > 0;
    const see = o.opacity !== undefined && o.opacity < 1 ? `,colorchannelmixer=aa=${o.opacity.toFixed(3)}` : '';
    // fading out before it's gone (a shorter fade when the clip starts part-way into it)
    const fadeOut =
      o.until !== undefined && o.fadeOut
        ? `,fade=t=out:st=${Math.max(0, o.until - o.fadeOut).toFixed(3)}:d=${Math.max(0.001, Math.min(o.fadeOut, o.until)).toFixed(3)}:alpha=1`
        : '';
    const pic = `[${n + 1}:v]scale=${o.w}:${o.h}:flags=lanczos,format=rgba${see}${slides ? `,fade=t=in:st=${from}:d=${SLIDE_S}:alpha=1` : ''}${fadeOut}[p${n}]`;
    const dist = Math.round(o.h * 1.2) * (o.slide ?? 1);
    const x = slides && dist ? `'${o.x}+max(0\\,${from}+${SLIDE_S}-t)/${SLIDE_S}*(${dist})'` : String(o.x);
    // each move up eases in over `over` seconds (already done for a time before the clip)
    const ups = o.up?.at.map((at) => `clip((t-(${at.toFixed(3)}))/${o.up!.over}\\,0\\,1)`) ?? [];
    const y = ups.length ? `'${o.y}-${o.up!.by}*(${ups.join('+')})'` : String(o.y);
    const shown = o.until !== undefined ? `between(t\\,${from}\\,${o.until.toFixed(3)})` : `gte(t\\,${from})`;
    const lay = `[${n ? `o${n - 1}` : 'in'}][p${n}]overlay=x=${x}:y=${y}:enable='${shown}'${n === overlays.length - 1 ? '[out]' : `[o${n}]`}`;
    return `${pic};${lay}`;
  });
  return { inputs, graph: steps.join(';') };
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
 * Instagram, TikTok and Facebook re-encode every upload, so a short for them
 * is made to survive that: 1080 wide (their playback size: a bigger upload is
 * scaled down by them anyway), H.264 High in MP4 (the codec all three take
 * without a detour), 8-bit BT.709, at most 60 fps, a key frame every 2
 * seconds, and a bitrate well above what they stream but under Meta's 25 Mbps
 * cap: 16 Mbps at 60 fps (fast, detailed gameplay), 10 at 30, quality-led
 * (constant quality, capped). One stereo AAC track at 48 kHz.
 */
export const SOCIAL = {
  width: 1080,
  maxFps: 60,
  /** Mbps: what it aims at, and its cap, above / at 30 fps */
  high: { target: 16, max: 20 },
  low: { target: 10, max: 14 },
  audioKbps: 256,
  /** seconds between key frames */
  gop: 2,
};

const fpsValue = (fps: string) => {
  const [n, d] = fps.split('/').map(Number);
  return d ? n / d : n;
};

/** A social upload's frame rate: the recording's, at most 60. */
export const socialFps = (fps: string) => (fpsValue(fps) > SOCIAL.maxFps + 0.01 ? `${SOCIAL.maxFps}/1` : fps);

/** The output stream as a social upload has it: its frame rate capped, one audio track (the first: OBS's mix). */
export const socialInfo = (info: VideoInfo): VideoInfo => ({ ...info, fps: socialFps(info.fps), audio: info.audio.slice(0, 1) });

/** ffmpeg output options for a social upload (see SOCIAL); `info` as socialInfo gives it. */
export function socialEncodeArgs(info: VideoInfo, nvenc = hasEncoder('h264_nvenc')): string[] {
  const fps = fpsValue(info.fps);
  const rate = fps > 30.5 ? SOCIAL.high : SOCIAL.low;
  const m = (n: number) => `${n}M`;
  const video = nvenc
    ? [
        '-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-multipass', 'fullres',
        // constant quality, held between the target and the cap
        '-cq', '19', '-b:v', m(rate.target), '-maxrate', m(rate.max), '-bufsize', m(rate.max * 2),
        '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-bf', '3',
      ]
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-maxrate', m(rate.max), '-bufsize', m(rate.max * 2)];
  return [
    ...video,
    '-profile:v', 'high', '-level:v', '4.2', '-pix_fmt', 'yuv420p',
    '-g', String(Math.round(fps * SOCIAL.gop)),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    // NVENC only writes matrix and range itself
    ...(nvenc ? ['-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0'] : []),
    '-r', info.fps, '-video_track_timescale', '90000',
    ...(info.audio.length ? ['-c:a', 'aac', '-b:a', `${SOCIAL.audioKbps}k`, '-ar', '48000', '-ac', '2'] : []),
  ];
}

/**
 * Every segment (clips and title cards) is encoded with identical stream
 * layout, so the final join is a lossless concat. All OBS audio tracks are
 * kept (a social upload: the first only).
 */
export async function renderReel(
  input: RenderInput,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { clips, workDir, frame } = input;
  // the output: the source's settings, at the frame's size when there is one (made for social media: see SOCIAL)
  const sized = frame ? { ...input.info, width: frame.width, height: frame.height } : input.info;
  const info = input.social ? socialInfo(sized) : sized;
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const common = input.social ? socialEncodeArgs(info) : encodeArgs(info);
  const audioMap = input.social ? '0:a:0?' : '0:a?';

  const plan: { kind: 'bookend' | 'card' | 'clip'; dur: number; blend?: number; run: (out: string, prog: (s: number) => void) => Promise<void> }[] = [];
  const bookend = (b: Bookend) => ({
    kind: 'bookend' as const,
    dur: b.dur,
    run: async (out: string) => copyFileSync(await b.file(signal), out),
  });
  /** one clip's segment: cut, its captions burned in, its sound faded at its edges (`next`: the clip after it, if any) */
  const clipStep = (clip: Clip, next: Clip | undefined, maxFade: number) => {
    // a clip played slower (a speed ramp) runs longer than the footage it shows
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const dur = (clip.end - clip.start) / speed;
    const fade = Math.min(maxFade, dur / 4);
    const look = input.look?.(clip, dur) ?? null;
    const subs = [input.captions?.(clip) ?? null].flat().filter((s): s is string => !!s);
    return {
      kind: 'clip' as const,
      dur,
      blend: clip.blend,
      run: (out: string, prog: (s: number) => void) => {
        const src = input.sourceOf?.(clip) ?? { path: input.videoPath, info: input.info, offset: 0 };
        const filters: string[] = [];
        // a social upload is limited-range BT.709: a full-range recording is converted, not just relabelled
        if (input.social && src.info.encoding.colorRange === 'pc') filters.push('scale=in_range=pc:out_range=tv');
        // a clip recorded at another size or frame rate is conformed, so the lossless join still works
        if (!frame && (src.info.width !== info.width || src.info.height !== info.height)) {
          filters.push(`scale=${info.width}:${info.height}:force_original_aspect_ratio=decrease`, `pad=${info.width}:${info.height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1');
        }
        // slowed: stretched in time (then the fps filter fills the frame rate back in)
        if (speed !== 1) filters.push(`setpts=(PTS-STARTPTS)/${speed}`);
        if (src.info.fps !== info.fps || speed !== 1) filters.push(`fps=${info.fps}`);
        // its own look under the captions (a grade)
        filters.push(...(look?.before ?? []));
        // captions are burned in while the clip is encoded anyway
        subs.forEach((ass, n) => {
          const assFile = out.replace(/\.mp4$/, n ? `.${n}.ass` : '.ass');
          writeFileSync(assFile, ass);
          filters.push(`ass='${filterPath(assFile)}':fontsdir='${filterPath(FONTS_DIR)}'`);
        });
        // and over them (a flash)
        filters.push(...(look?.after ?? []));
        // slowed, or with a sound mixed in: the sound goes through one filter graph with the picture
        if (!frame && (speed !== 1 || look?.impact)) {
          const tracks = Math.min(info.audio.length, src.info.audio.length);
          const chain = [speed !== 1 ? `atempo=${speed}` : null, afadeFilter(clip, next, dur, fade)].filter(Boolean).join(',') || 'anull';
          const graph = [`[0:v:0]${filters.join(',') || 'null'}[v]`];
          for (let i = 0; i < tracks; i++) {
            if (i === 0 && look?.impact) {
              graph.push(`[0:a:0]${chain}[m0]`, `[1:a]volume=${look.impact.volume}[hit]`, '[m0][hit]amix=inputs=2:duration=first:normalize=0[a0]');
            } else graph.push(`[0:a:${i}]${chain}[a${i}]`);
          }
          return runFfmpeg(
            [
              '-ss', (clip.start - src.offset).toFixed(3), '-i', src.path, ...(look?.impact ? ['-i', look.impact.file] : []), '-t', dur.toFixed(3),
              '-filter_complex', graph.join(';'),
              '-map', '[v]', ...Array.from({ length: tracks }, (_, i) => ['-map', `[a${i}]`]).flat(),
              ...common, out,
            ],
            prog,
            signal,
          );
        }
        // pictures over the frame (a short's kill-feed entries), under the captions
        const over = frame?.overlays?.(clip) ?? [];
        const lay = over.length ? overlayGraph(over, info.fps) : null;
        const tail = `${filters.map((f, i) => `${i ? ',' : ''}${f}`).join('') || 'null'}[v]`;
        return runFfmpeg(
          [
            '-ss', (clip.start - src.offset).toFixed(3), '-i', src.path, ...(lay?.inputs ?? []), '-t', dur.toFixed(3),
            ...(frame
              ? [
                  '-filter_complex',
                  lay ? `${frame.graph(src.info)}[in];${lay.graph};[out]${tail}` : `${frame.graph(src.info)},${tail}`,
                  '-map', '[v]', '-map', audioMap,
                ]
              : ['-map', '0:v:0', '-map', audioMap, ...(filters.length ? ['-vf', filters.join(',')] : [])]),
            // a short fade at each cut, except where a looping short's seam runs straight on
            ...afade(clip, next, dur, fade),
            ...common, out,
          ],
          prog,
          signal,
        );
      },
    };
  };

  // the cold open: its shots cut hard into one another, before the channel's intro
  (input.teaser ?? []).forEach((c, i, all) => plan.push(clipStep(c, all[i + 1], TEASER_FADE_S)));
  if (input.intro) plan.push(bookend(input.intro));
  const seenRounds = new Set<number>();
  for (const [ci, clip] of clips.entries()) {
    const card = input.cards.get(clip.round);
    if (card && !seenRounds.has(clip.round)) {
      seenRounds.add(clip.round);
      plan.push({ kind: 'card', dur: CARD_SECONDS, run: (out, prog) => renderCard(info, card, common, out, workDir, prog, signal) });
    }
    plan.push(clipStep(clip, clips[ci + 1], 0.1));
  }

  if (input.outro) plan.push(bookend(input.outro));

  const total = plan.reduce((s, p) => s + p.dur, 0);
  let done = 0;
  const segments: { file: string; dur: number }[] = [];
  for (const [i, step] of plan.entries()) {
    const out = join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
    await step.run(out, (s) => onProgress?.(Math.min(0.99, (done + Math.min(s, step.dur)) / total)));
    done += step.dur;
    const prev = segments.at(-1);
    const blend = step.blend && prev ? Math.min(step.blend, prev.dur / 2, step.dur / 2) : 0;
    if (prev && blend > 0) {
      // crossfaded with the segment before: the two become one (only these two are encoded again)
      const both = out.replace(/\.mp4$/, '_blend.mp4');
      await crossfade(prev, { file: out, dur: step.dur }, blend, info.audio.length, common, both, signal);
      segments[segments.length - 1] = { file: both, dur: prev.dur + step.dur - blend };
    } else {
      segments.push({ file: out, dur: step.dur });
    }
  }

  const list = join(workDir, 'segments.txt');
  writeFileSync(list, segments.map((s) => `file '${s.file.replace(/\\/g, '/')}'`).join('\n'));
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-movflags', '+faststart', input.outPath], undefined, signal);
  onProgress?.(1);
  rmSync(workDir, { recursive: true, force: true });
  return input.outPath;
}

/** Two segments as one, the first fading into the second over `blend` seconds, picture and every audio track. */
function crossfade(
  a: { file: string; dur: number },
  b: { file: string; dur: number },
  blend: number,
  tracks: number,
  common: string[],
  out: string,
  signal?: AbortSignal,
) {
  const d = blend.toFixed(3);
  const sound = Array.from({ length: tracks }, (_, k) => `[0:a:${k}][1:a:${k}]acrossfade=d=${d}[a${k}]`);
  return runFfmpeg(
    [
      '-i', a.file, '-i', b.file,
      '-filter_complex', [`[0:v][1:v]xfade=transition=fade:duration=${d}:offset=${(a.dur - blend).toFixed(3)}[v]`, ...sound].join(';'),
      '-map', '[v]', ...Array.from({ length: tracks }, (_, k) => ['-map', `[a${k}]`]).flat(),
      ...common, out,
    ],
    undefined,
    signal,
  );
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
