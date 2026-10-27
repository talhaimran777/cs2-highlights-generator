import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterPath, hasNvenc, runFfmpeg, type VideoInfo } from '../util/ffmpeg.ts';
import type { Clip } from '../types.ts';

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
}

function videoEncoder(): string[] {
  return hasNvenc()
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
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

  const common = [
    ...videoEncoder(),
    '-pix_fmt', 'yuv420p', '-r', info.fps, '-video_track_timescale', '90000',
    '-c:a', 'aac', '-b:a', '192k',
  ];

  const plan: { kind: 'card' | 'clip'; dur: number; run: (out: string, prog: (s: number) => void) => Promise<void> }[] = [];
  const seenRounds = new Set<number>();
  for (const clip of clips) {
    const card = input.cards.get(clip.round);
    if (card && !seenRounds.has(clip.round)) {
      seenRounds.add(clip.round);
      plan.push({ kind: 'card', dur: CARD_SECONDS, run: (out, prog) => renderCard(info, card, common, out, workDir, prog, signal) });
    }
    const dur = clip.end - clip.start;
    const fade = Math.min(0.1, dur / 4);
    plan.push({
      kind: 'clip',
      dur,
      run: (out, prog) =>
        runFfmpeg(
          [
            '-ss', clip.start.toFixed(3), '-i', input.videoPath, '-t', dur.toFixed(3),
            '-map', '0:v:0', '-map', '0:a?',
            '-af', `afade=t=in:d=${fade},afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade}`,
            ...common, out,
          ],
          prog,
          signal,
        ),
    });
  }

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
