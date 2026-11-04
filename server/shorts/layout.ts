// A short's frame: the source turned on its side (1920x1080 -> 1080x1920, the
// same pixel count, so the source bitrate fits as-is), the facecam on top and
// gameplay below. No server-only imports: the web preview uses this too.

import type { Rect, ShortLayout } from '../types.ts';

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export const shortFrame = (video: { width: number; height: number }) => ({ width: even(video.height), height: even(video.width) });

export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 0.7;

/** Heights of the camera and gameplay bands in the short. */
export function bandHeights(frame: { width: number; height: number }, split: number) {
  const camera = even(frame.height * Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split)));
  return { camera, gameplay: frame.height - camera };
}

/** Width / height of a rect of the frame in fractions, for a pixel aspect `aspect`. */
const fractionAspect = (aspect: number, video: { width: number; height: number }) => aspect / (video.width / video.height);

/** `r` kept inside the frame (moved, not resized). */
export function clampRect(r: Rect): Rect {
  const w = Math.min(1, r.w);
  const h = Math.min(1, r.h);
  return { x: Math.max(0, Math.min(1 - w, r.x)), y: Math.max(0, Math.min(1 - h, r.y)), w, h };
}

/**
 * `r` at the band's aspect (`aspect` = band width / height, in pixels): same
 * centre and about the same area, shrunk to fit the frame. So nothing stretches
 * when it's scaled into the band, and moving the divider keeps what's framed.
 */
export function reshapeRect(r: Rect, aspect: number, video: { width: number; height: number }): Rect {
  const k = fractionAspect(aspect, video);
  let w = Math.sqrt(Math.max(1e-4, r.w * r.h) * k);
  let h = w / k;
  const over = Math.max(w, h, 1);
  w /= over;
  h /= over;
  return clampRect({ x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h });
}

/** `r` resized to width `w` at the band's aspect, its top-left corner kept (dragging the corner handle). */
export function resizeRect(r: Rect, w: number, aspect: number, video: { width: number; height: number }): Rect {
  const k = fractionAspect(aspect, video);
  const maxW = Math.min(1 - r.x, (1 - r.y) * k);
  const width = Math.max(0.05, Math.min(maxW, w));
  return { x: r.x, y: r.y, w: width, h: width / k };
}

/** The pixel aspect of each band. */
export function bandAspects(video: { width: number; height: number }, split: number) {
  const frame = shortFrame(video);
  const bands = bandHeights(frame, split);
  return { camera: frame.width / bands.camera, gameplay: frame.width / bands.gameplay, split: bands.camera / frame.height };
}

/** The layout with both rects at their bands' aspects. */
export function fitLayout(layout: ShortLayout, video: { width: number; height: number }): ShortLayout {
  const a = bandAspects(video, layout.split);
  return {
    split: a.split,
    camera: reshapeRect(layout.camera, a.camera, video),
    gameplay: reshapeRect(layout.gameplay, a.gameplay, video),
  };
}

/** smallest and biggest overlay width, as fractions of the short's width */
export const MIN_OVERLAY_W = 0.1;
export const MAX_OVERLAY_W = 1;

/** an overlay lined up on a side keeps this gap to the edge, as a fraction of the short's width (as the kill feed) */
export const OVERLAY_MARGIN = 0.035;

export type OverlayAlign = 'free' | 'left' | 'center' | 'right';

/**
 * Where the overlay picture (`img` pixels) goes in the short, in pixels: its
 * top edge and width as placed, the height from the picture's shape; across,
 * lined up on a side, exactly centred (the frame and the width are both even),
 * or where it was dragged. Kept inside the frame.
 */
export function overlayRect(
  o: { x: number; y: number; w: number; align?: OverlayAlign },
  img: { w: number; h: number },
  frame: { width: number; height: number },
) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const w = even(frame.width * Math.min(MAX_OVERLAY_W, Math.max(MIN_OVERLAY_W, o.w)));
  const h = Math.min(even((w * img.h) / img.w), even(frame.height));
  const margin = Math.round(frame.width * OVERLAY_MARGIN);
  const across =
    o.align === 'center' ? (frame.width - w) / 2 : o.align === 'left' ? margin : o.align === 'right' ? frame.width - margin - w : frame.width * o.x;
  const x = Math.round(Math.max(0, Math.min(frame.width - w, across)));
  const y = Math.round(Math.max(0, Math.min(frame.height - h, frame.height * o.y)));
  return { x, y, w, h };
}
