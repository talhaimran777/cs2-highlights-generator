// A short's frame: the source turned on its side (1920x1080 -> 1080x1920, the
// same pixel count, so the source bitrate fits as-is), the facecam on top and
// gameplay below. No server-only imports: the web preview uses this too.

import type { Rect, ShortLayout, WebcamMode } from '../types.ts';

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export const shortFrame = (video: { width: number; height: number }) => ({ width: even(video.height), height: even(video.width) });

export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 0.7;

/**
 * The bottom safe band: YouTube covers the bottom of a Short with the title,
 * channel and buttons, so the gameplay (and its HUD: health, armour, ammo,
 * money) stops above it and the band shows it blurred.
 */
export const DEFAULT_SAFE_BOTTOM = 0.15;
export const MAX_SAFE_BOTTOM = 0.3;
/** the bottom band's blur, as a share of the short's width (the export and the preview blur the same) */
export const SAFE_BLUR = 0.02;
/** and how much darker it is than the gameplay, so it reads as background */
export const SAFE_DIM = 0.75;
/** the gameplay band never gets smaller than this share of the height */
const MIN_GAMEPLAY = 0.25;

/** A layout's bottom band, as a share of the height (older layouts have none set: the default). */
export const safeBottom = (l: Pick<ShortLayout, 'bottom'>) => Math.min(MAX_SAFE_BOTTOM, Math.max(0, l.bottom ?? DEFAULT_SAFE_BOTTOM));

/**
 * The top safe band, with no camera: the gameplay stops below it (the phone's
 * status bar and YouTube's top buttons sit there) and the band shows the
 * gameplay's top mirrored up, blurred and dimmed, like the bottom one.
 */
export const DEFAULT_SAFE_TOP = 0.15;
export const MAX_SAFE_TOP = 0.3;

/** Where the facecam goes (older layouts: in its band, or none). */
export const webcamMode = (l: Pick<ShortLayout, 'webcam' | 'noCamera'>): WebcamMode => l.webcam ?? (l.noCamera ? 'off' : 'band');
/** The short has the facecam band on top. */
export const hasCamera = (l: Pick<ShortLayout, 'webcam' | 'noCamera'>) => webcamMode(l) === 'band';

/** A floating webcam's place when it hasn't been moved: the gameplay's top left, a third of the width. */
export const DEFAULT_PIP = { x: 0.04, y: 0.17, w: 0.34 };
export const MIN_PIP_W = 0.12;
export const MAX_PIP_W = 0.9;
/** never taller than this share of the short */
const MAX_PIP_H = 0.6;

/**
 * The floating webcam in the short, in pixels (even sizes): its width as set,
 * its height from the camera crop's shape (`video` pixels), kept inside the
 * frame. Null unless the layout floats it.
 */
export function pipRect(l: ShortLayout, frame: { width: number; height: number }, video: { width: number; height: number }) {
  if (webcamMode(l) !== 'float') return null;
  const p = l.pip ?? DEFAULT_PIP;
  const shape = (l.camera.h * video.height) / Math.max(1e-6, l.camera.w * video.width); // height / width
  let w = frame.width * Math.min(MAX_PIP_W, Math.max(MIN_PIP_W, p.w));
  if (w * shape > frame.height * MAX_PIP_H) w = (frame.height * MAX_PIP_H) / shape;
  const pw = even(w);
  const ph = even(w * shape);
  const x = Math.round(Math.max(0, Math.min(frame.width - pw, frame.width * p.x)));
  const y = Math.round(Math.max(0, Math.min(frame.height - ph, frame.height * p.y)));
  return { x, y, w: pw, h: ph };
}

/** The floating webcam's look, as shares of the short's width: its border, its corners' radius (of its own shorter side) and its shadow. */
export const PIP_BORDER = 0.004;
export const PIP_RADIUS = 0.08;
export const PIP_SHADOW = 0.012;
/** how dark the shadow is at its darkest (0..1) */
export const PIP_SHADOW_ALPHA = 0.45;

/** The floating webcam's border, corner radius, shadow size and the shadow's drop, in pixels. */
export function pipStyle(pip: { w: number; h: number }, frame: { width: number }) {
  const border = Math.max(2, Math.round(frame.width * PIP_BORDER));
  const radius = Math.max(2, Math.round(Math.min(pip.w, pip.h) * PIP_RADIUS));
  const shadow = Math.max(2, Math.round(frame.width * PIP_SHADOW));
  return { border, radius, shadow, drop: Math.round(shadow * 0.4) };
}
/** A layout's top band with no camera, as a share of the height. */
export const safeTop = (l: Pick<ShortLayout, 'top'>) => Math.min(MAX_SAFE_TOP, Math.max(0, l.top ?? DEFAULT_SAFE_TOP));

/**
 * Heights of the bands in the short, top to bottom: the camera (or, with no
 * camera, the top safe band: `split` is then its share, 0 for none), the
 * gameplay and the bottom safe band. `camera` and `top` are never both set.
 */
export function bandHeights(frame: { width: number; height: number }, split: number, bottom = 0, camera = true) {
  const above = camera
    ? even(frame.height * Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split)))
    : split > 0
      ? even(frame.height * Math.min(MAX_SAFE_TOP, split))
      : 0;
  const room = Math.max(0, frame.height - above - frame.height * MIN_GAMEPLAY);
  const safe = bottom > 0 ? Math.min(even(frame.height * bottom), Math.floor(room / 2) * 2) : 0;
  return { camera: camera ? above : 0, top: camera ? 0 : above, gameplay: frame.height - above - safe, safe };
}

/** A layout's bands in the short (see bandHeights). */
export const layoutBands = (frame: { width: number; height: number }, l: ShortLayout) =>
  hasCamera(l) ? bandHeights(frame, l.split, safeBottom(l)) : bandHeights(frame, safeTop(l), safeBottom(l), false);

/** Where the gameplay starts, as a share of the short's height: under the camera, or under the top safe band. */
export function gameplayTop(frame: { width: number; height: number }, l: ShortLayout) {
  const b = layoutBands(frame, l);
  return (b.camera + b.top) / frame.height;
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

/**
 * `r` at the band's aspect keeping its height and bottom edge (wider or
 * narrower about its centre), for the gameplay: its HUD sits at the bottom of
 * the frame, so a shorter band shows more to the sides instead of cutting the
 * HUD off. Only when it would be wider than the frame does it lose height
 * (from the top).
 */
export function reshapeKeepBottom(r: Rect, aspect: number, video: { width: number; height: number }): Rect {
  const k = fractionAspect(aspect, video);
  let h = Math.min(1, r.h);
  let w = h * k;
  if (w > 1) {
    w = 1;
    h = 1 / k;
  }
  return clampRect({ x: r.x + r.w / 2 - w / 2, y: r.y + r.h - h, w, h });
}

/** `r` resized to width `w` at the band's aspect, its top-left corner kept (dragging the corner handle). */
export function resizeRect(r: Rect, w: number, aspect: number, video: { width: number; height: number }): Rect {
  const k = fractionAspect(aspect, video);
  const maxW = Math.min(1 - r.x, (1 - r.y) * k);
  const width = Math.max(0.05, Math.min(maxW, w));
  return { x: r.x, y: r.y, w: width, h: width / k };
}

/** The pixel aspect of each band. */
export function bandAspects(video: { width: number; height: number }, split: number, bottom = 0) {
  const frame = shortFrame(video);
  const bands = bandHeights(frame, split, bottom);
  return { camera: frame.width / bands.camera, gameplay: frame.width / bands.gameplay, split: bands.camera / frame.height, bottom: bands.safe / frame.height };
}

/** A layout's camera and gameplay aspects as the short shows them (the camera's also when it's off: for when it's back). */
export function layoutAspects(video: { width: number; height: number }, l: ShortLayout) {
  const withCamera = bandAspects(video, l.split, safeBottom(l));
  if (hasCamera(l)) return withCamera;
  const frame = shortFrame(video);
  const bands = layoutBands(frame, l);
  return { ...withCamera, gameplay: frame.width / bands.gameplay, bottom: bands.safe / frame.height, top: bands.top / frame.height };
}

/**
 * The layout with its rects at their bands' aspects (and its safe bands and
 * webcam mode set). A floating webcam's crop keeps whatever shape it's given.
 * Where a floating webcam was is kept in every mode, for when it floats again.
 */
export function fitLayout(layout: ShortLayout, video: { width: number; height: number }): ShortLayout {
  const a = layoutAspects(video, layout);
  const mode = webcamMode(layout);
  return {
    split: a.split,
    bottom: a.bottom,
    webcam: mode,
    ...(mode === 'band' ? {} : { top: 'top' in a ? a.top : safeTop(layout) }),
    ...(layout.pip ? { pip: layout.pip } : mode === 'float' ? { pip: DEFAULT_PIP } : {}),
    camera: mode === 'float' ? clampRect({ ...layout.camera, w: Math.max(0.05, layout.camera.w), h: Math.max(0.05, layout.camera.h) }) : reshapeRect(layout.camera, a.camera, video),
    gameplay: reshapeKeepBottom(layout.gameplay, a.gameplay, video),
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
