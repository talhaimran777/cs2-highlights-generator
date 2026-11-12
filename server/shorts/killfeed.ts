// A short's own kill feed. The game's feed sits in the top-right corner,
// which the 9:16 crop leaves out (and a phone screen is too small for), so my
// kills are listed again where they can be seen: each one slides in below
// the last and, as in the game, fades out a few seconds after its kill (the
// rows under it move up), or stays up for the rest of the short. Styled like CS2's feed
// for your own kills (dark row, red outline). Burned in as ASS; the web
// preview draws the same rows. No server-only imports: the web uses this too.

import { escapeAss } from '../captions/ass.ts';
import type { FeedKill, Side } from '../types.ts';

/** text height, as a fraction of the frame height */
export const FEED_SIZE = 0.021;
/** gap to the frame's edge on the side the feed is aligned to, as a fraction of its width (the default; it's a setting) */
export const FEED_MARGIN = 0.035;
/** the most side padding: a third of the width */
export const MAX_FEED_MARGIN = 0.3;
/** a side padding setting (% of the width) as a fraction, in range */
export const feedMargin = (sidePct: number | undefined) => Math.min(MAX_FEED_MARGIN, Math.max(0, (sidePct ?? FEED_MARGIN * 100) / 100));
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

/** how long a row's fade-out takes, ending when it's gone */
export const FEED_FADE_S = 0.4;
/** how long the rows under a gone one take to move up */
export const FEED_SHIFT_S = 0.18;
/** the default and longest time a row stays up after its kill */
export const DEFAULT_FEED_STAY = 6;
export const MAX_FEED_STAY = 30;
/** a stay setting (seconds) in range; 0 = rows never fade */
export const feedStay = (stay: number | undefined) => Math.min(MAX_FEED_STAY, Math.max(0, stay ?? DEFAULT_FEED_STAY));
/** when kill `k`'s row is gone (timeline seconds; never when rows stay) */
export const feedGoneAt = (k: { at: number }, stay: number) => (stay > 0 ? k.at + stay : Infinity);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/**
 * Row `i`'s slot at timeline time `t` (kills sorted by time): one for each
 * row above it still up, a gone one's slot closing over FEED_SHIFT_S (so it's
 * fractional while the rows move up).
 */
export function feedSlot(sorted: { at: number }[], i: number, t: number, stay: number) {
  let slot = 0;
  for (let j = 0; j < i; j++) slot += 1 - clamp01((t - feedGoneAt(sorted[j], stay)) / FEED_SHIFT_S);
  return slot;
}
/** A row's opacity at timeline time `t`: 1 until it starts fading, 0 once it's gone. */
export const feedAlpha = (k: { at: number }, t: number, stay: number) => clamp01((feedGoneAt(k, stay) - t) / FEED_FADE_S);

/** a kill that hasn't come up yet in a piece (after it): never shown there */
const NOT_YET = 1e15;

/**
 * The kills on the short's own clock (seconds into what's watched), for piece
 * `n` of `pieces` (in the order they play): each kill's `at` moved to when its
 * row comes up, and the piece's window on that clock. So a row stays up for
 * `stay` seconds of the short, however much of the round was cut between.
 * A kill in a cut comes up where the footage resumes; one that only plays
 * later (a looping short opens on the reaction after its final kill) is from
 * the loop before, as the short runs on into its start. Order is kept.
 */
export function feedOnScreen<K extends { at: number }>(
  kills: K[],
  pieces: { start: number; end: number; blend?: number }[],
  n: number,
): { kills: K[]; clip: { start: number; end: number } } {
  // where each piece starts in the output (a crossfade overlaps it with the one before)
  const starts: number[] = [];
  let total = 0;
  pieces.forEach((p, i) => {
    total -= i ? (p.blend ?? 0) : 0;
    starts.push(total);
    total += p.end - p.start;
  });
  const inside = (p: { start: number; end: number }, at: number) => at >= p.start && at < p.end;
  const shownAt = (at: number) => {
    const i = pieces.findIndex((p) => inside(p, at));
    if (i >= 0) return starts[i] + at - pieces[i].start;
    // in a cut: when the footage after it plays
    let next = -1;
    pieces.forEach((p, j) => p.start > at && (next < 0 || p.start < pieces[next].start) && (next = j));
    return next >= 0 ? starts[next] : NOT_YET;
  };
  const piece = pieces[n];
  const from = starts[n];
  return {
    clip: { start: from, end: from + piece.end - piece.start },
    kills: kills.map((k) => {
      if (k.at >= piece.end) return { ...k, at: NOT_YET };
      const at = shownAt(k.at);
      return { ...k, at: inside(piece, k.at) || at <= from ? at : at - total };
    }),
  };
}

/**
 * A looping short's opening reaction (everything from the loop's cut on):
 * every kill of the round up together, already there and never fading, as
 * the round's tally (the reaction comes after all of them). Kills from
 * `until` on aren't up yet. Use with a stay of 0 (rows stay up).
 */
export function holdKills<K extends { at: number }>(kills: K[], until: number, at: number): K[] {
  return kills.map((k) => ({ ...k, at: k.at < until ? at : NOT_YET }));
}

/** Footage from the loop's cut on is the opening reaction: its kill feed holds every kill (see holdKills). */
export const holdsFeed = (start: number, loopCut: number | null | undefined) => loopCut != null && start >= loopCut - 1e-6;

/** Which side of the short the feed sits on. */
export type FeedAlign = 'left' | 'center' | 'right';

/** Where a new row slides in from: the side it's aligned to (+1 right, -1 left), or nowhere when centred. */
export const slideFrom = (align: FeedAlign) => (align === 'right' ? 1 : align === 'left' ? -1 : 0);

/** Left edge of a row `w` wide, aligned in the frame (`margin`, a fraction of the width, kept on the aligned side). */
export function feedRowX(w: number, frameWidth: number, align: FeedAlign, margin = FEED_MARGIN) {
  margin = Math.round(frameWidth * margin);
  return align === 'left' ? margin : align === 'center' ? Math.round((frameWidth - w) / 2) : frameWidth - margin - w;
}
/** below the camera band (or the top safe band) when no position is set: the gameplay's top right */
const UNDER_CAMERA_PCT = 2;

export const feedFont = 'Arial';

/** Top of the feed as % of the frame height; `split` is where the gameplay starts (a share of the height). */
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
export function fitFeedScale(
  images: ({ w: number; h: number } | null)[],
  frame: { width: number; height: number },
  scale: number,
  align: FeedAlign = 'right',
  margin = FEED_MARGIN,
) {
  const asked = Math.min(MAX_FEED_SCALE, Math.max(MIN_FEED_SCALE, scale || 1));
  const room = frame.width * feedRoom(align, margin);
  const fits = images.reduce((m, img) => (img ? Math.min(m, (room * img.h) / (img.w * frame.height * FEED_SIZE * FEED_IMAGE_H)) : m), Infinity);
  return Math.max(MIN_FEED_SCALE, Math.min(asked, fits));
}

/** The width a row may take, as a fraction of the frame: inside the side padding, and the default gap on the other side. */
const feedRoom = (align: FeedAlign, margin: number) => (align === 'center' ? 1 - 2 * FEED_MARGIN : Math.max(0.2, 1 - margin - FEED_MARGIN));

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
  margin = FEED_MARGIN,
) {
  const size = feedTextSize(frame, scale);
  const k = Math.min((size * FEED_IMAGE_H) / img.h, (frame.width * feedRoom(align, margin)) / img.w);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const w = even(img.w * k);
  const h = even(img.h * k);
  return { x: feedRowX(w, frame.width, align, margin), y: Math.round((frame.height * topPct) / 100 + i * size * FEED_ROW), w, h };
}

/**
 * ASS for one piece of the short: every kill before the piece ends, each row
 * from its kill until it's gone (`stay` seconds after it, faded out; 0 = the
 * end of the piece). A kill inside the piece slides in; one before it is
 * already there. Rows keep the order of their kills: when one is gone the
 * rows under it move up (a row is split into events where that happens).
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
  /** the side padding, a fraction of the width */
  sideMargin = FEED_MARGIN,
  /** seconds a row stays up after its kill; 0 = for good */
  stay = 0,
): string | null {
  const sorted = [...kills].sort((a, b) => a.at - b.at);
  const shown = (k: FeedKill, i: number) => k.at < clip.end && feedGoneAt(k, stay) > clip.start && drawn(i);
  if (!sorted.some(shown)) return null;

  const size = feedTextSize(frame, scale);
  const pad = Math.max(2, Math.round(size * PAD));
  const border = Math.max(2, Math.round(size * BORDER));
  const margin = Math.round(frame.width * sideMargin);
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
  const ms = (s: number) => Math.round(s * 1000);
  const rowY = (slot: number) => Math.round(top + pad + slot * size * FEED_ROW);
  sorted.forEach((k, i) => {
    if (!shown(k, i)) return;
    const gone = feedGoneAt(k, stay);
    const from = Math.max(k.at, clip.start);
    const until = Math.min(gone, clip.end);
    // split where a row above goes (this one moves up then)
    const cuts = sorted.slice(0, i).map((o) => feedGoneAt(o, stay)).filter((g) => g > from && g < until);
    const edges = [from, ...[...new Set(cuts)].sort((a, b) => a - b), until];
    const marks = killMarks(k);
    const text = [
      `{\\c${assColor(sideColor(k.attackerSide))}}${escapeAss(k.attacker)}`,
      `{\\c${assColor(FEED_MUTED)}}  ${escapeAss(weaponName(k.weapon))}${marks.length ? `  ${marks.join(' ')}` : ''}  `,
      `{\\c${assColor(sideColor(k.victimSide))}}${escapeAss(k.victim)}`,
    ].join('');
    for (let e = 0; e + 1 < edges.length; e++) {
      const [s, end] = [edges[e], edges[e + 1]];
      const slidesIn = e === 0 && k.at >= clip.start;
      const y0 = rowY(feedSlot(sorted, i, s, stay));
      const y1 = rowY(feedSlot(sorted, i, s + FEED_SHIFT_S, stay));
      const move = slidesIn
        ? `\\move(${x + slide},${y1},${x},${y1},0,${SLIDE_MS})`
        : y0 !== y1
          ? `\\move(${x},${y0},${x},${y1},0,${ms(FEED_SHIFT_S)})`
          : `\\pos(${x},${y1})`;
      // fading out at the end of its last event (from part-way when the piece starts mid-fade)
      const fades = end === gone;
      const fadeAt = Math.max(s, gone - FEED_FADE_S);
      const a = Math.round(255 * (1 - feedAlpha(k, fadeAt, stay)));
      const fade = fades
        ? `\\fade(${slidesIn ? 255 : a},${a},255,0,${slidesIn ? SLIDE_MS : 0},${ms(fadeAt - s)},${ms(end - s)})`
        : slidesIn
          ? `\\fad(${SLIDE_MS},0)`
          : '';
      const at = `${time(s - clip.start)},${time(end - clip.start)}`;
      // the red outline: the same row's box, `border` bigger, underneath
      events.push(`Dialogue: 0,${at},Feed,,0,0,0,,{\\an${an}${move}${fade}\\bord${pad + border}\\3c${assColor(FEED_RED)}}${text}`);
      events.push(`Dialogue: 1,${at},Feed,,0,0,0,,{\\an${an}${move}${fade}}${text}`);
    }
  });
  return [...header, ...events, ''].join('\n');
}
