import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { MatchStats } from '../edit/extras.ts';
import type { Settings } from '../types.ts';
import { easeOutBack, easeOutCubic, lerp, phase, rgba, roundRect, ROUND_FONT, TITLE_FONT } from './animate.ts';
import { loadFonts, renderAnimation, type BumperTarget } from './bumper.ts';

// Match graphics: the end-of-match scoreboard card and the small score
// graphic shown on the gameplay. Same fonts and accent as the intro.
// Laid out in units of 1/1080 of the frame height.

export const SCOREBOARD_SECONDS = 5;
const FADE_S = 0.35;
const BG = '#0D0F14';

/** The final scoreboard: result and score, then my stat tiles sliding in. */
export function drawScoreboard(g: SKRSContext2D, t: number, W: number, H: number, s: MatchStats, accent: string) {
  const u = H / 1080;
  const cx = W / 2;
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(cx, H * 0.42, 0, cx, H * 0.42, H * 0.75);
  glow.addColorStop(0, rgba(accent, 0.28));
  glow.addColorStop(1, rgba(accent, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  // map line, then the result landing
  const top = easeOutCubic(phase(t, 0.1, 0.5));
  g.globalAlpha = top;
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.font = `${Math.round(34 * u)}px ${ROUND_FONT}`;
  g.fillText(`${s.map} · FINAL`, cx, lerp(250, 270, 1 - top) * u);

  const hit = phase(t, 0.25, 0.55);
  const resultText = s.result === 'WIN' ? 'VICTORY' : s.result === 'LOSS' ? 'DEFEAT' : 'DRAW';
  g.save();
  g.globalAlpha = Math.min(1, hit * 2);
  g.translate(cx, 430 * u);
  const k = lerp(1.25, 1, easeOutBack(hit));
  g.scale(k, k);
  g.fillStyle = s.result === 'WIN' ? '#ffffff' : 'rgba(255,255,255,0.82)';
  g.shadowColor = rgba(accent, 0.8);
  g.shadowBlur = 40 * u;
  g.font = `${Math.round(170 * u)}px ${TITLE_FONT}`;
  g.fillText(resultText, 0, 0);
  g.restore();

  const score = easeOutCubic(phase(t, 0.55, 0.45));
  g.globalAlpha = score;
  g.fillStyle = s.result === 'WIN' ? rgba(accent, 1) : '#ff5a5a';
  g.font = `${Math.round(96 * u)}px ${TITLE_FONT}`;
  g.fillText(`${s.us}  –  ${s.them}`, cx, lerp(590, 620, 1 - score) * u);

  // stat tiles
  const tiles: [string, string][] = [
    ['K / D / A', `${s.kills} / ${s.deaths} / ${s.assists}`],
    ['K/D', s.kd.toFixed(2)],
    ['HEADSHOT %', `${s.hsPct}%`],
    ['3K+ ROUNDS', String(s.multiKillRounds)],
    s.aces ? ['ACES', String(s.aces)] : ['CLUTCHES', String(s.clutches)],
  ];
  const tw = 300 * u;
  const th = 150 * u;
  const gap = 28 * u;
  const total = tiles.length * tw + (tiles.length - 1) * gap;
  tiles.forEach(([label, value], i) => {
    const p = phase(t, 0.9 + i * 0.12, 0.5);
    if (p <= 0) return;
    const x = cx - total / 2 + i * (tw + gap);
    const y = lerp(800, 740, easeOutBack(p)) * u;
    g.globalAlpha = Math.min(1, p * 1.5);
    roundRect(g, x, y, tw, th, 18 * u);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fill();
    g.fillStyle = rgba(accent, 1);
    g.fillRect(x, y, tw, 5 * u);
    g.fillStyle = '#ffffff';
    g.font = `${Math.round(58 * u)}px ${TITLE_FONT}`;
    g.fillText(value, x + tw / 2, y + 82 * u);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = `${Math.round(24 * u)}px ${ROUND_FONT}`;
    g.fillText(label, x + tw / 2, y + 122 * u);
  });
  g.globalAlpha = 1;

  // fade in from and out to black
  const fade = Math.max(1 - phase(t, 0, FADE_S), phase(t, SCOREBOARD_SECONDS - FADE_S, FADE_S));
  if (fade > 0) {
    g.fillStyle = `rgba(0,0,0,${fade})`;
    g.fillRect(0, 0, W, H);
  }
}

/** The final scoreboard as a reel segment, rendered once per look and target and cached. */
export async function scoreboardFile(s: MatchStats, accent: string, target: BumperTarget, cacheDir: string, signal?: AbortSignal): Promise<string> {
  const key = createHash('sha1').update(JSON.stringify({ v: 1, s, accent, target })).digest('hex').slice(0, 16);
  const out = join(cacheDir, `scoreboard_${key}.mp4`);
  if (existsSync(out)) return out;
  mkdirSync(cacheDir, { recursive: true });
  const tmp = out.replace(/\.mp4$/, '.tmp.mp4');
  try {
    await renderAnimation((g, t, W, H) => drawScoreboard(g, t, W, H, s, accent), SCOREBOARD_SECONDS, null, target, tmp, signal);
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  return out;
}

export interface Overlay {
  png: string;
  x: number;
  y: number;
}

/**
 * The score graphic for one round: a small translucent label, drawn once per
 * text and size and cached. Placed next to the game's own scoreboard (the
 * strip between facecam and HUD), under it, or in a bottom corner.
 */
export function scoreOverlay(text: string, W: number, H: number, corner: Settings['overlayCorner'], accent: string, cacheDir: string): Overlay {
  loadFonts();
  const u = H / 1080;
  const font = `${Math.round(24 * u)}px ${ROUND_FONT}`;
  const measure = createCanvas(1, 1).getContext('2d');
  measure.font = font;
  const padX = 18 * u;
  const bar = 5 * u;
  const w = Math.ceil(measure.measureText(text).width + padX * 2 + bar);
  const h = Math.ceil(46 * u);

  const key = createHash('sha1').update(JSON.stringify({ text, w, h, accent })).digest('hex').slice(0, 16);
  const png = join(cacheDir, `overlay_${key}.png`);
  if (!existsSync(png)) {
    const c = createCanvas(w, h);
    const g = c.getContext('2d');
    roundRect(g, 0, 0, w, h, 10 * u);
    g.fillStyle = 'rgba(13,15,20,0.72)';
    g.fill();
    g.save();
    roundRect(g, 0, 0, w, h, 10 * u);
    g.clip();
    g.fillStyle = rgba(accent, 1);
    g.fillRect(0, 0, bar, h);
    g.restore();
    g.font = font;
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(text, bar + padX, h / 2 + 1 * u);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(png, c.toBuffer('image/png'));
  }

  const m = Math.round(16 * u);
  const pos: Record<Settings['overlayCorner'], [number, number]> = {
    hud: [Math.round(W * 0.42) - w, Math.round(12 * u)],
    below: [Math.round((W - w) / 2), Math.round(H * 0.085)],
    bl: [m, H - h - Math.round(120 * u)],
    br: [W - w - m, H - h - Math.round(120 * u)],
  };
  const [x, y] = pos[corner] ?? pos.hud;
  return { png, x, y };
}
