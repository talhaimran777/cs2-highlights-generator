import { cropRect, type VideoInfo } from '../util/ffmpeg.ts';
import type { ShortLayout } from '../types.ts';
import { bandHeights } from './layout.ts';

/**
 * ffmpeg graph for a short: the source frame split in two, the facecam and the
 * gameplay each cropped and scaled to their band, stacked camera over gameplay.
 */
export function shortGraph(layout: ShortLayout, src: VideoInfo, frame: { width: number; height: number }): string {
  const bands = bandHeights(frame, layout.split);
  const band = (r: ShortLayout['camera'], h: number) => `${cropRect(src, r)},scale=${frame.width}:${h}:flags=lanczos,setsar=1`;
  return [
    '[0:v]split[a][b]',
    `[a]${band(layout.camera, bands.camera)}[cam]`,
    `[b]${band(layout.gameplay, bands.gameplay)}[game]`,
    '[cam][game]vstack',
  ].join(';');
}
