// A short's own kill feed. The game's feed sits in the top-right corner,
// which the 9:16 crop leaves out (and a phone screen is too small for), so my
// kills are listed again where they can be seen: each one stays up for the
// rest of the short, the next one slides in below it. Styled like CS2's feed
// for your own kills (dark row, red outline). Burned in as ASS; the web
// preview draws the same rows. No server-only imports: the web uses this too.

import { escapeAss } from '../captions/ass.ts';
import type { FeedKill, Side } from '../types.ts';

/** text height, as a fraction of the frame height */
export const FEED_SIZE = 0.021;
/** gap to the frame's edge on the side the feed is aligned to, as a fraction of its width */
export const FEED_MARGIN = 0.035;
/** a row's height, in text heights (text + padding + gap) */
export const FEED_ROW = 2.2;
/** a cut-out entry's height (the game's box with its red outline), in text heights */
export const FEED_IMAGE_H = 1.94;
/** box padding around the text, in text heights */
export const PAD = 0.38;
/** the red outline, in text heights */
export const BORDER = 0.09;
/** a new row slides in from its side (fades in when centred) */
const SLIDE_MS = 180;

/** Which side of the short the feed sits on. */
export type FeedAlign = 'left' | 'center' | 'right';

/** Where a new row slides in from: the side it's aligned to (+1 right, -1 left), or nowhere when centred. */
export const slideFrom = (align: FeedAlign) => (align === 'right' ? 1 : align === 'left' ? -1 : 0);

/** Left edge of a row `w` wide, aligned in the frame (the margin kept on the aligned side). */
export function feedRowX(w: number, frameWidth: number, align: FeedAlign) {
  const margin = Math.round(frameWidth * FEED_MARGIN);
  return align === 'left' ? margin : align === 'center' ? Math.round((frameWidth - w) / 2) : frameWidth - margin - w;
}
/** below the camera band when no position is set: the gameplay's top right */
const UNDER_CAMERA_PCT = 2;

export const feedFont = 'Arial';

/** Top of the feed as % of the frame height. */
export const feedTopPct = (positionPct: number | null, split: number) => positionPct ?? split * 100 + UNDER_CAMERA_PCT;

const WEAPONS: Record<string, string> = {
  ak47: 'AK-47', m4a1: 'M4A4', m4a4: 'M4A4', m4a1_silencer: 'M4A1-S', 'm4a1-s': 'M4A1-S', awp: 'AWP', ssg08: 'SSG 08', deagle: 'Desert Eagle',
  usp_silencer: 'USP-S', 'usp-s': 'USP-S', glock: 'Glock-18', hkp2000: 'P2000', p250: 'P250', fiveseven: 'Five-SeveN', tec9: 'Tec-9',
  cz75a: 'CZ75-Auto', elite: 'Dual Berettas', revolver: 'R8 Revolver', famas: 'FAMAS', galilar: 'Galil AR', aug: 'AUG', sg556: 'SG 553',
  mp9: 'MP9', mac10: 'MAC-10', mp7: 'MP7', mp5sd: 'MP5-SD', ump45: 'UMP-45', p90: 'P90', bizon: 'PP-Bizon', nova: 'Nova', xm1014: 'XM1014',
  mag7: 'MAG-7', sawedoff: 'Sawed-Off', negev: 'Negev', m249: 'M249', g3sg1: 'G3SG1', scar20: 'SCAR-20', taser: 'Zeus x27',
  hegrenade: 'HE Grenade', inferno: 'Molotov', molotov: 'Molotov', incgrenade: 'Incendiary', knife: 'Knife', bayonet: 'Knife',
};

/** How a weapon id (demo) or name (read off the screen) is shown. */
export function weaponName(w: string): string {
  const id = w.trim().toLowerCase().replace(/^weapon_/, '');
  if (!id) return '';
  if (WEAPONS[id]) return WEAPONS[id];
  if (id.includes('knife') || id.startsWith('knife')) return 'Knife';
  return w.trim().toUpperCase();
}

/** The extras after the weapon, as CS2 shows icons for them. */
export const killMarks = (k: FeedKill) =>
  [k.noscope && 'NOSCOPE', k.throughSmoke && 'SMOKE', k.wallbang && 'WALLBANG', k.headshot && 'HS'].filter((x): x is string => !!x);

/** Name colours as in the game: CT blue, T yellow; white when the side isn't known (clips mode). */
export const SIDE_COLOR: Record<Side | 'none', string> = { CT: '#B5D4EE', T: '#EAD18A', none: '#FFFFFF' };
export const FEED_RED = '#E0262F';
export const FEED_BG = '#141414';
export const FEED_MUTED = '#D2D2D2';
const sideColor = (s: Side | null | undefined) => SIDE_COLOR[s ?? 'none'];

/** #RRGGBB -> ASS &HAABBGGRR */
const assColor = (hex: string, alpha = 0) => {
  const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
};

function time(sec: number) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** smallest and biggest kill-feed size against the default */
export const MIN_FEED_SCALE = 0.5;
export const MAX_FEED_SCALE = 2;

/** The feed's text height in pixels; every other measure of a row follows it. */
export const feedTextSize = (frame: { height: number }, scale = 1) =>
  Math.round(frame.height * FEED_SIZE * Math.min(MAX_FEED_SCALE, Math.max(MIN_FEED_SCALE, scale || 1)));

/**
 * The size the feed is actually shown at: the size asked for, unless the
 * widest entry wouldn't fit across the frame then; the whole feed is kept
 * smaller together, so every row stays the same height.
 */
export function fitFeedScale(images: ({ w: number; h: number } | null)[], frame: { width: number; height: number }, scale: number) {
  const asked = Math.min(MAX_FEED_SCALE, Math.max(MIN_FEED_SCALE, scale || 1));
  const room = frame.width * (1 - 2 * FEED_MARGIN);
  const fits = images.reduce((m, img) => (img ? Math.min(m, (room * img.h) / (img.w * frame.height * FEED_SIZE * FEED_IMAGE_H)) : m), Infinity);
  return Math.max(MIN_FEED_SCALE, Math.min(asked, fits));
}

/**
 * Where a cut-out entry (`w` x `h` source pixels) goes in the short, in
 * pixels: row `i`'s slot, aligned, scaled to the row height (and never
 * wider than the frame).
 */
export function feedImageRect(
  img: { w: number; h: number },
  i: number,
  frame: { width: number; height: number },
  topPct: number,
  scale = 1,
  align: FeedAlign = 'right',
) {
  const size = feedTextSize(frame, scale);
  const k = Math.min((size * FEED_IMAGE_H) / img.h, (frame.width * (1 - 2 * FEED_MARGIN)) / img.w);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const w = even(img.w * k);
  const h = even(img.h * k);
  return { x: feedRowX(w, frame.width, align), y: Math.round((frame.height * topPct) / 100 + i * size * FEED_ROW), w, h };
}

/**
 * ASS for one piece of the short: every kill before the piece ends, each row
 * from its kill to the end of the piece (rows stay in their place for the
 * whole short, so a cut doesn't reshuffle them). A kill inside the piece
 * slides in; one before it is already there.
 */
export function killfeedAss(
  kills: FeedKill[],
  clip: { start: number; end: number },
  frame: { width: number; height: number },
  topPct: number,
  /** rows drawn here; the others are the game's own entries, overlaid (see feedImageRect) */
  drawn: (i: number) => boolean = () => true,
  scale = 1,
  align: FeedAlign = 'right',
): string | null {
  const dur = clip.end - clip.start;
  const sorted = [...kills].sort((a, b) => a.at - b.at);
  if (!sorted.some((k, i) => k.at < clip.end && drawn(i))) return null;

  const size = feedTextSize(frame, scale);
  const pad = Math.max(2, Math.round(size * PAD));
  const border = Math.max(2, Math.round(size * BORDER));
  const margin = Math.round(frame.width * FEED_MARGIN);
  // the anchor (\an7 top-left, \an8 top-centre, \an9 top-right); the box reaches `pad` beyond the text, so it's moved in by that much
  const [an, x] = align === 'left' ? [7, margin + pad] : align === 'center' ? [8, Math.round(frame.width / 2)] : [9, frame.width - margin - pad];
  const slide = slideFrom(align) * Math.round(size * 2);
  const top = (frame.height * topPct) / 100;
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // BorderStyle 3: the "outline" is a box behind the text, `pad` wide
    `Style: Feed,${feedFont},${size},&H00FFFFFF,&H00FFFFFF,${assColor(FEED_BG)},&H00000000,-1,0,0,0,100,100,0,0,3,${pad},0,9,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  sorted.forEach((k, i) => {
    if (k.at >= clip.end || !drawn(i)) return;
    const from = Math.max(0, k.at - clip.start);
    const y = Math.round(top + pad + i * size * FEED_ROW);
    const anim = k.at >= clip.start ? `\\move(${x + slide},${y},${x},${y},0,${SLIDE_MS})\\fad(${SLIDE_MS},0)` : `\\pos(${x},${y})`;
    const marks = killMarks(k);
    const text = [
      `{\\c${assColor(sideColor(k.attackerSide))}}${escapeAss(k.attacker)}`,
      `{\\c${assColor(FEED_MUTED)}}  ${escapeAss(weaponName(k.weapon))}${marks.length ? `  ${marks.join(' ')}` : ''}  `,
      `{\\c${assColor(sideColor(k.victimSide))}}${escapeAss(k.victim)}`,
    ].join('');
    const at = `${time(from)},${time(dur)}`;
    // the red outline: the same row's box, `border` bigger, underneath
    events.push(`Dialogue: 0,${at},Feed,,0,0,0,,{\\an${an}${anim}\\bord${pad + border}\\3c${assColor(FEED_RED)}}${text}`);
    events.push(`Dialogue: 1,${at},Feed,,0,0,0,,{\\an${an}${anim}}${text}`);
  });
  return [...header, ...events, ''].join('\n');
}
