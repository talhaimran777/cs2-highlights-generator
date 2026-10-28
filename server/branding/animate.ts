import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import type { Branding } from '../types.ts';
import { Mix } from './sfx.ts';

// Frame-by-frame drawings of the channel intro and the subscribe outro.
// Everything is laid out in units of 1/1080 of the frame height.

export const INTRO_SECONDS = 3.6;
export const OUTRO_SECONDS = 4.6;

const TITLE_FONT = 'Anton, "Arial Black", sans-serif';
const ROUND_FONT = '"Poppins ExtraBold", "Arial Black", sans-serif';

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeInCubic = (x: number) => x ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const easeOutBack = (x: number, s = 1.7) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
/** 0 before `from`, 1 after `from + len`. */
const phase = (t: number, from: number, len: number) => clamp((t - from) / len);
/** Stable pseudo-random numbers for particles, so frames don't flicker. */
const rand = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
/** Mixes a hex color toward white (amt > 0) or black (amt < 0). */
const shade = (hex: string, amt: number) => {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = (v: number) => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt));
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
};

// --- intro ------------------------------------------------------------------

const HIT = 0.62; // the name lands

/**
 * Twitch-style intro: a light streak, the top tag slides in, the channel name
 * slams down with a flash and a shake, the bottom tag slides in, sparks drift,
 * then it all pushes in and fades out.
 */
export function drawIntro(g: SKRSContext2D, t: number, W: number, H: number, b: Branding) {
  const u = H / 1080;
  const cx = W / 2;
  const cy = H / 2;
  const accent = b.accent;

  g.save();
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  // background glow, brighter once the name lands
  const glow = t < HIT ? 0.15 * phase(t, 0.1, HIT) : 0.35 + 0.08 * Math.sin((t - HIT) * 4);
  const bg = g.createRadialGradient(cx, cy, 0, cx, cy, H * 0.75);
  bg.addColorStop(0, rgba(accent, glow));
  bg.addColorStop(1, rgba(accent, 0));
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // light streak sweeping across before the hit
  if (t < 0.7) {
    const x = lerp(-0.3 * W, 1.3 * W, easeInOut(phase(t, 0, 0.7)));
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.transform(1, 0, -0.35, 1, 0.35 * cy, 0);
    const s = g.createLinearGradient(x - 160 * u, 0, x + 160 * u, 0);
    s.addColorStop(0, rgba(accent, 0));
    s.addColorStop(0.45, rgba(accent, 0.55));
    s.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    s.addColorStop(0.55, rgba(accent, 0.55));
    s.addColorStop(1, rgba(accent, 0));
    g.fillStyle = s;
    g.fillRect(x - 160 * u, 0, 320 * u, H);
    g.restore();
  }

  // camera: shake after the hit, push-in at the end
  const out = phase(t, INTRO_SECONDS - 0.6, 0.6);
  const shake = t > HIT ? Math.exp(-(t - HIT) * 9) * 16 * u : 0;
  g.translate(cx + Math.sin(t * 93) * shake, cy + Math.cos(t * 71) * shake);
  const zoom = 1 + 0.12 * easeInCubic(out) + 0.02 * phase(t, HIT, 2.4);
  g.scale(zoom, zoom);
  g.globalAlpha = 1 - easeInCubic(out);

  // channel name
  const name = b.name.toUpperCase();
  let size = 260 * u;
  g.font = `${size}px ${TITLE_FONT}`;
  const maxW = 0.62 * W;
  const measured = g.measureText(name).width;
  if (measured > maxW) {
    size *= maxW / measured;
    g.font = `${size}px ${TITLE_FONT}`;
  }
  const nameW = g.measureText(name).width;
  const nameIn = phase(t, 0.38, HIT - 0.38);
  if (nameIn > 0) {
    const settle = t > HIT ? 1 + 0.035 * Math.exp(-(t - HIT) * 7) * Math.cos((t - HIT) * 30) : lerp(2.4, 1, easeInCubic(nameIn));
    g.save();
    g.globalAlpha *= clamp(nameIn * 1.6);
    g.scale(settle, settle);
    g.transform(1, 0, -0.16, 1, 0, 0); // italic lean
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = accent;
    for (const blur of [90, 40, 14]) {
      g.shadowBlur = blur * u;
      g.fillStyle = '#fff';
      g.fillText(name, 0, 0);
    }
    g.shadowBlur = 0;
    const fill = g.createLinearGradient(0, -size / 2, 0, size / 2);
    fill.addColorStop(0, '#ffffff');
    fill.addColorStop(0.6, '#ffffff');
    fill.addColorStop(1, shade(accent, 0.75));
    g.fillStyle = fill;
    g.fillText(name, 0, 0);
    g.restore();
  }

  // tags above and below the name
  const tagH = 74 * u;
  const top = -size * 0.5 - tagH * 0.55;
  const bottom = size * 0.5 + tagH * 0.55;
  const left = -nameW / 2 + 0.05 * nameW;
  const right = nameW / 2 - 0.02 * nameW;
  const topIn = easeOutBack(phase(t, 0.18, 0.4));
  const botIn = easeOutBack(phase(t, 0.78, 0.4));
  if (b.topLine && topIn > 0) {
    g.save();
    g.translate((1 - topIn) * -W, 0);
    g.globalAlpha *= clamp(topIn * 2);
    drawTag(g, b.topLine, left, top, tagH, accent, 'after', u);
    g.restore();
  }
  if (b.bottomLine && botIn > 0) {
    g.save();
    g.translate((1 - botIn) * W, 0);
    g.globalAlpha *= clamp(botIn * 2);
    drawTag(g, b.bottomLine, right, bottom, tagH, accent, 'before', u);
    g.restore();
  }

  // sparks drifting up after the hit
  if (t > HIT) {
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 46; i++) {
      const age = t - HIT - rand(i) * 0.5;
      if (age < 0) continue;
      const x = (rand(i + 100) - 0.5) * W * 0.9;
      const y = (rand(i + 200) - 0.3) * H * 0.7 - age * (60 + 120 * rand(i + 300)) * u;
      const a = clamp(1 - age / 2.6) * (0.5 + 0.5 * Math.sin(age * 12 + i));
      g.fillStyle = i % 3 ? rgba(accent, a) : `rgba(255,255,255,${a})`;
      g.beginPath();
      g.arc(x, y, (1.5 + 3 * rand(i + 400)) * u, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }
  g.restore();

  // white flash on the hit
  if (t > HIT && t < HIT + 0.4) {
    g.fillStyle = `rgba(255,255,255,${0.7 * Math.exp(-(t - HIT) * 12)})`;
    g.fillRect(0, 0, W, H);
  }
}

/** A slanted purple tag with a Twitch glyph box on one side, anchored at x (left or right edge). */
function drawTag(g: SKRSContext2D, text: string, x: number, y: number, h: number, accent: string, glyph: 'before' | 'after', u: number) {
  const label = text.toUpperCase();
  g.font = `${h * 0.78}px ${TITLE_FONT}`;
  const tw = g.measureText(label).width;
  const pad = h * 0.35;
  const boxW = tw + pad * 2;
  const gap = h * 0.14;
  const total = boxW + gap + h;
  const x0 = glyph === 'after' ? x : x - total;
  const textX = glyph === 'after' ? x0 : x0 + h + gap;
  const glyphX = glyph === 'after' ? x0 + boxW + gap : x0;

  g.save();
  g.transform(1, 0, -0.22, 1, 0, 0);
  g.shadowColor = rgba(accent, 0.9);
  g.shadowBlur = 30 * u;
  const fill = g.createLinearGradient(0, y - h / 2, 0, y + h / 2);
  fill.addColorStop(0, shade(accent, 0.25));
  fill.addColorStop(1, shade(accent, -0.1));
  g.fillStyle = fill;
  g.fillRect(textX, y - h / 2, boxW, h);
  g.fillRect(glyphX, y - h / 2, h, h);
  g.shadowBlur = 0;
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowOffsetY = 3 * u;
  g.shadowBlur = 4 * u;
  g.fillText(label, textX + pad, y + h * 0.03);
  g.restore();
  // the boxes were drawn slanted (x shifts by -0.22·y); the glyph stays upright, centered in its box
  drawTwitchGlyph(g, glyphX - 0.22 * y + h * 0.12, y - h * 0.38, h * 0.76, accent);
}

/** The Twitch glitch logo, roughly, in a size x size box. */
function drawTwitchGlyph(g: SKRSContext2D, x: number, y: number, s: number, accent: string) {
  const poly = (pts: number[][], color: string) => {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(x + px * s, y + py * s) : g.moveTo(x + px * s, y + py * s)));
    g.closePath();
    g.fillStyle = color;
    g.fill();
  };
  poly([[0.18, 0], [0.92, 0], [0.92, 0.58], [0.66, 0.84], [0.47, 0.84], [0.32, 1], [0.32, 0.84], [0.1, 0.84], [0.1, 0.16]], '#fff');
  poly([[0.27, 0.11], [0.82, 0.11], [0.82, 0.53], [0.63, 0.72], [0.44, 0.72], [0.36, 0.8], [0.36, 0.72], [0.27, 0.72]], shade(accent, -0.15));
  g.fillStyle = '#fff';
  g.fillRect(x + 0.45 * s, y + 0.25 * s, 0.08 * s, 0.24 * s);
  g.fillRect(x + 0.64 * s, y + 0.25 * s, 0.08 * s, 0.24 * s);
}

export function introSound(sampleRate: number): Mix {
  const m = new Mix(sampleRate, INTRO_SECONDS);
  m.whoosh(0.0, 0.7, 0.35, 400, 4000);
  m.whoosh(0.18, 0.4, 0.4);
  m.riser(0.05, HIT - 0.05);
  m.impact(HIT);
  m.whoosh(0.78, 0.4, 0.4, 500, 3000);
  m.sparkle(0.9);
  m.whoosh(INTRO_SECONDS - 0.62, 0.6, 0.3, 300, 2500);
  return m;
}

// --- outro ------------------------------------------------------------------

const CLICK = 2.3;

/**
 * Subscribe outro: the profile picture pops in with a spinning ring, the
 * handle and a red Subscribe button slide up, a cursor clicks it, it turns
 * into "Subscribed" and the bell rings.
 */
export function drawOutro(g: SKRSContext2D, t: number, W: number, H: number, b: Branding, avatar: Image | null) {
  const u = H / 1080;
  const cx = W / 2;
  const accent = b.accent;
  const fadeIn = phase(t, 0, 0.25);
  const fadeOut = 1 - phase(t, OUTRO_SECONDS - 0.6, 0.6);

  g.save();
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalAlpha = fadeIn * fadeOut;

  const bg = g.createRadialGradient(cx, H * 0.4, 0, cx, H * 0.4, H * 0.7);
  bg.addColorStop(0, rgba(accent, 0.28 + 0.05 * Math.sin(t * 3)));
  bg.addColorStop(1, rgba(accent, 0));
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // profile picture
  const r = 175 * u;
  const ay = H * 0.37;
  const pop = phase(t, 0.15, 0.5);
  if (pop > 0) {
    const s = easeOutBack(pop, 2.4);
    g.save();
    g.translate(cx, ay);
    g.scale(s, s);
    g.shadowColor = accent;
    g.shadowBlur = 60 * u;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, 0, r + 8 * u, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.save();
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.clip();
    if (avatar) {
      g.drawImage(avatar, -r, -r, 2 * r, 2 * r);
    } else {
      g.fillStyle = shade(accent, -0.3);
      g.fillRect(-r, -r, 2 * r, 2 * r);
      g.fillStyle = '#fff';
      g.font = `${r}px ${TITLE_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(b.name.slice(0, 1).toUpperCase(), 0, 0);
    }
    g.restore();
    // spinning dashed ring
    g.strokeStyle = rgba(accent, 0.9);
    g.lineWidth = 6 * u;
    g.setLineDash([26 * u, 18 * u]);
    g.lineDashOffset = -t * 120 * u;
    g.beginPath();
    g.arc(0, 0, r + 26 * u, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.restore();
  }

  // handle under the picture
  const handle = b.handle || `@${b.name}`;
  const hIn = easeOutCubic(phase(t, 0.55, 0.45));
  if (hIn > 0) {
    g.save();
    g.globalAlpha *= hIn;
    g.font = `${58 * u}px ${ROUND_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.shadowColor = rgba(accent, 0.8);
    g.shadowBlur = 24 * u;
    g.fillText(handle, cx, ay + r + 90 * u + (1 - hIn) * 40 * u);
    g.restore();
  }

  // subscribe button
  const by = H * 0.8;
  const bIn = phase(t, 0.85, 0.5);
  const clicked = t >= CLICK;
  const press = clicked ? 1 - 0.08 * Math.exp(-(t - CLICK) * 14) * Math.sin(Math.min(Math.PI, (t - CLICK) * 26)) : 1;
  const label = clicked ? 'SUBSCRIBED' : 'SUBSCRIBE';
  g.font = `${46 * u}px ${ROUND_FONT}`;
  const lw = g.measureText(label).width;
  const icon = 64 * u;
  const bw = lw + icon + 110 * u;
  const bh = 104 * u;
  if (bIn > 0) {
    g.save();
    g.translate(cx, by + (1 - easeOutBack(bIn)) * 160 * u);
    g.scale(press, press);
    g.globalAlpha *= clamp(bIn * 2);
    g.shadowColor = clicked ? 'rgba(0,0,0,0.5)' : 'rgba(255,0,51,0.6)';
    g.shadowBlur = 40 * u;
    g.fillStyle = clicked ? '#2b2b2f' : '#ff0033';
    roundRect(g, -bw / 2, -bh / 2, bw, bh, bh / 2);
    g.fill();
    g.shadowBlur = 0;
    const ix = -bw / 2 + 48 * u;
    if (clicked) {
      // check mark
      g.strokeStyle = '#fff';
      g.lineWidth = 9 * u;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(ix + 8 * u, 0);
      g.lineTo(ix + 26 * u, 18 * u);
      g.lineTo(ix + 56 * u, -18 * u);
      g.stroke();
    } else {
      // play badge
      g.fillStyle = '#fff';
      roundRect(g, ix, -icon * 0.36, icon, icon * 0.72, icon * 0.2);
      g.fill();
      g.fillStyle = '#ff0033';
      g.beginPath();
      g.moveTo(ix + icon * 0.4, -icon * 0.17);
      g.lineTo(ix + icon * 0.68, 0);
      g.lineTo(ix + icon * 0.4, icon * 0.17);
      g.closePath();
      g.fill();
    }
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(label, ix + icon + 22 * u, 3 * u);
    g.restore();
  }

  // bell next to the button, ringing after the click
  const bellIn = phase(t, CLICK + 0.2, 0.3);
  if (bellIn > 0) {
    const swing = Math.sin((t - CLICK - 0.2) * 28) * 0.45 * Math.exp(-(t - CLICK - 0.2) * 2.2);
    g.save();
    g.translate(cx + bw / 2 + 80 * u, by - 8 * u);
    g.scale(easeOutBack(bellIn, 2.6), easeOutBack(bellIn, 2.6));
    g.rotate(swing);
    drawBell(g, 46 * u);
    g.restore();
  }

  // burst of rays on the click
  const burst = phase(t, CLICK, 0.55);
  if (burst > 0 && burst < 1) {
    g.save();
    g.translate(cx, by);
    g.strokeStyle = `rgba(255,255,255,${1 - burst})`;
    g.lineWidth = 5 * u;
    g.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const r0 = bw * 0.45 + easeOutCubic(burst) * 90 * u;
      g.beginPath();
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * 0.45);
      g.lineTo(Math.cos(a) * (r0 + 30 * u), Math.sin(a) * (r0 + 30 * u) * 0.45);
      g.stroke();
    }
    g.restore();
  }

  // mouse pointer gliding in, clicking, drifting away
  const move = easeInOut(phase(t, 1.4, CLICK - 1.45));
  const away = easeInOut(phase(t, CLICK + 0.5, 0.8));
  if (move > 0 && away < 1) {
    const tx = cx + bw * 0.18;
    const ty = by + 14 * u;
    const px = lerp(W * 0.86, tx, move) + away * 160 * u;
    const py = lerp(H * 1.08, ty, move) + away * 120 * u;
    const down = t >= CLICK && t < CLICK + 0.14 ? 0.85 : 1;
    g.save();
    g.globalAlpha *= 1 - away;
    g.translate(px, py);
    g.scale(down, down);
    drawPointer(g, 60 * u);
    g.restore();
  }
  g.restore();
}

function roundRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Arrow cursor with its tip at (0, 0). */
function drawPointer(g: SKRSContext2D, s: number) {
  const pts = [[0, 0], [0, 0.78], [0.2, 0.6], [0.34, 0.92], [0.46, 0.86], [0.32, 0.56], [0.58, 0.56]];
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
  g.closePath();
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = s * 0.15;
  g.fillStyle = '#fff';
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = s * 0.05;
  g.lineJoin = 'round';
  g.strokeStyle = '#000';
  g.stroke();
}

/** Notification bell centered on (0, 0). */
function drawBell(g: SKRSContext2D, s: number) {
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(-s * 0.62, s * 0.42);
  g.quadraticCurveTo(-s * 0.48, s * 0.3, -s * 0.48, -s * 0.05);
  g.quadraticCurveTo(-s * 0.48, -s * 0.62, 0, -s * 0.66);
  g.quadraticCurveTo(s * 0.48, -s * 0.62, s * 0.48, -s * 0.05);
  g.quadraticCurveTo(s * 0.48, s * 0.3, s * 0.62, s * 0.42);
  g.closePath();
  g.fill();
  g.beginPath();
  g.arc(0, s * 0.56, s * 0.15, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(0, -s * 0.72, s * 0.09, 0, Math.PI * 2);
  g.fill();
}

export function outroSound(sampleRate: number): Mix {
  const m = new Mix(sampleRate, OUTRO_SECONDS);
  m.pop(0.17, 0.6);
  m.sparkle(0.3);
  m.whoosh(0.55, 0.35, 0.2, 800, 3000);
  m.whoosh(0.85, 0.45, 0.35);
  m.whoosh(1.45, 0.8, 0.12, 300, 1200);
  m.click(CLICK);
  m.sparkle(CLICK + 0.05, 0.15);
  m.ding(CLICK + 0.22);
  m.whoosh(OUTRO_SECONDS - 0.6, 0.55, 0.25, 300, 2000);
  return m;
}
