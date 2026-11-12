import { cropRect, type VideoInfo } from '../util/ffmpeg.ts';
import type { ShortLayout } from '../types.ts';
import { hasCamera, layoutBands, PIP_SHADOW_ALPHA, pipRect, pipStyle, SAFE_BLUR, SAFE_DIM } from './layout.ts';

/**
 * A rounded rectangle `w` x `h` (corner radius `r`) at (`ox`, `oy`) as an
 * ffmpeg expression of X and Y: 255 inside, 0 outside, its edge smoothed over
 * a pixel. For geq on a gray mask.
 */
export function roundedMask(w: number, h: number, r: number, ox = 0, oy = 0): string {
  const x = ox ? `(X-${ox})` : 'X';
  const y = oy ? `(Y-${oy})` : 'Y';
  return `255*clip(${r}+0.5-hypot(max(max(${r}-${x},${x}-${w - 1 - r}),0),max(max(${r}-${y},${y}-${h - 1 - r}),0)),0,1)`;
}

/**
 * ffmpeg graph for a short: the source frame split, the facecam (when the
 * short has its band) and the gameplay each cropped and scaled to their band,
 * stacked camera over gameplay. With no camera band, a top safe band instead:
 * the gameplay's top mirrored upwards (so it runs on from the gameplay's
 * edge), blurred and dimmed. Under them, the bottom safe band, made the same
 * way from the gameplay's bottom. A floating webcam goes on top of it all,
 * with rounded corners, a thin white border and a soft shadow.
 */
export function shortGraph(layout: ShortLayout, src: VideoInfo, frame: { width: number; height: number }): string {
  const bands = layoutBands(frame, layout);
  const camera = hasCamera(layout);
  const pip = pipRect(layout, frame, src);
  const band = (r: ShortLayout['camera'], w: number, h: number) => `${cropRect(src, r)},scale=${w}:${h}:flags=lanczos,setsar=1`;
  const sigma = Math.max(1, Math.round(frame.width * SAFE_BLUR));
  // a safe band: `h` rows of the gameplay from `y`, flipped over its edge, blurred and dimmed
  // (never more than the gameplay band has: bandHeights keeps them smaller)
  const safe = (h: number, y: number) => `crop=${frame.width}:${h}:0:${y},vflip,gblur=sigma=${sigma},colorchannelmixer=rr=${SAFE_DIM}:gg=${SAFE_DIM}:bb=${SAFE_DIM}`;

  // what's stacked, top to bottom, and the gameplay's copies the safe bands are made from
  const stack: string[] = [];
  const steps: string[] = [];
  const copies: string[] = ['game'];
  if (bands.top) copies.push('gtop');
  if (bands.safe) copies.push('gbot');
  steps.push(camera || pip ? '[0:v]split[a][b]' : '[0:v]null[b]');
  if (camera) {
    steps.push(`[a]${band(layout.camera, frame.width, bands.camera)}[cam]`);
    stack.push('[cam]');
  }
  steps.push(`[b]${band(layout.gameplay, frame.width, bands.gameplay)}${copies.length > 1 ? `,split=${copies.length}${copies.map((c) => `[${c}]`).join('')}` : '[game]'}`);
  if (bands.top) {
    steps.push(`[gtop]${safe(bands.top, 0)}[top]`);
    stack.push('[top]');
  }
  stack.push('[game]');
  if (bands.safe) {
    steps.push(`[gbot]${safe(bands.safe, bands.gameplay - bands.safe)}[safe]`);
    stack.push('[safe]');
  }
  const stacked = stack.length > 1 ? `${stack.join('')}vstack=inputs=${stack.length}` : `${stack[0]}null`;
  if (!pip) {
    steps.push(stacked);
    return steps.join(';');
  }
  steps.push(`${stacked}[base]`);

  // the floating webcam: the camera with its corners rounded off (a mask made from a copy of it, so it
  // has a frame for every camera frame), over a white plate a border wider, over a blurred dark shadow
  const s = pipStyle(pip, frame);
  const bw = pip.w + 2 * s.border;
  const bh = pip.h + 2 * s.border;
  const sw = bw + 4 * s.shadow;
  const sh = bh + 4 * s.shadow;
  const plate = (w: number, h: number, color: string) => `scale=${w}:${h},drawbox=x=0:y=0:w=iw:h=ih:color=${color}:t=fill,format=yuva420p`;
  // a mask never changes: made from the first frame only (alphamerge repeats a finished input's last frame)
  const mask = (w: number, h: number, expr: string) => `trim=end_frame=1,scale=${w}:${h},format=gray,geq=lum='${expr}'`;
  steps.push(`[a]${band(layout.camera, pip.w, pip.h)},split=6[cv][cm][bp][bm][sp][sm]`);
  steps.push(`[cm]${mask(pip.w, pip.h, roundedMask(pip.w, pip.h, s.radius))}[cma]`);
  steps.push('[cv]format=yuva420p[cvf]', '[cvf][cma]alphamerge[pipcam]');
  steps.push(`[bp]${plate(bw, bh, 'white')}[bpw]`);
  steps.push(`[bm]${mask(bw, bh, roundedMask(bw, bh, s.radius + s.border))}[bma]`);
  steps.push('[bpw][bma]alphamerge[pipborder]');
  steps.push(`[sp]${plate(sw, sh, 'black')}[spk]`);
  steps.push(`[sm]${mask(sw, sh, `${PIP_SHADOW_ALPHA}*${roundedMask(bw, bh, s.radius + s.border, 2 * s.shadow, 2 * s.shadow)}`)},gblur=sigma=${Math.max(1, Math.round(s.shadow / 2))}[sma]`);
  steps.push('[spk][sma]alphamerge[pipshadow]');
  steps.push(`[base][pipshadow]overlay=x=${pip.x - s.border - 2 * s.shadow}:y=${pip.y - s.border - 2 * s.shadow + s.drop}[b1]`);
  steps.push(`[b1][pipborder]overlay=x=${pip.x - s.border}:y=${pip.y - s.border}[b2]`);
  steps.push(`[b2][pipcam]overlay=x=${pip.x}:y=${pip.y}`);
  return steps.join(';');
}
