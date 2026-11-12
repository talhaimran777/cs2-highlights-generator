// A short's title: one line or two over the whole short saying what it's
// about ("ACE ON ANCIENT", "1v3 to win it"), in one of five TEYE looks. The
// same presets style the export (ASS) and the page's preview (CSS), and the
// boxes behind box presets are measured once (titleBoxes) for both.

import { escapeAss, time } from '../captions/ass.ts';

/** TEYE's colours: black, crimson and white, with gamer yellow as the accent. */
export const TEYE_BLACK = '#0B0B0D';
export const TEYE_CHARCOAL = '#141416';
/** crimson for letters: bright enough to read on dark footage */
export const TEYE_CRIMSON = '#E3223A';
/** crimson for the banner behind white letters */
export const TEYE_CRIMSON_DEEP = '#B3122E';
// a warm gold-leaning yellow (no green in it), loud against CS2's blues, greys and sand
export const TEYE_YELLOW = '#FFB81C';
export const TEYE_WHITE = '#FFFFFF';

/** One condensed font for every preset. */
export const TITLE_FONT = 'Anton';

export interface TitlePreset {
  id: string;
  name: string;
  /** family name, as in captions/fonts.ts */
  font: string;
  upper: boolean;
  color: string;
  /** emphasised words (*stars* in the title) */
  accent: string;
  /** the outline around each letter (none with a box) */
  outline: string | null;
  /** its width, as a share of the text size */
  outlineW: number;
  /** a solid rounded box behind each line instead of an outline */
  box: string | null;
  /** the box's padding around its capitals, as shares of the text size: sideways, and above and below */
  pad: { x: number; y: number };
  /** the box's corner radius, as a share of the text size */
  radius: number;
  /** a drop shadow (under the letters, or under the box), or none */
  shadow: { color: string; /** 0 = solid, 1 = gone */ alpha: number; /** offset, as a share of the size */ offset: number } | null;
  /** turned this many degrees (positive = clockwise), the whole title together */
  tilt: number;
  /** what its card shows */
  sample: string;
}

export const TITLE_PRESETS: TitlePreset[] = [
  {
    id: 'bold',
    name: 'Bold White',
    font: TITLE_FONT,
    upper: true,
    color: TEYE_WHITE,
    accent: TEYE_CRIMSON,
    outline: TEYE_BLACK,
    outlineW: 0.06,
    box: null,
    pad: { x: 0, y: 0 },
    radius: 0,
    shadow: { color: TEYE_BLACK, alpha: 0.45, offset: 0.05 },
    tilt: 0,
    sample: 'THAT WAS *INSANE!*',
  },
  {
    id: 'box',
    name: 'White Box',
    font: TITLE_FONT,
    upper: true,
    color: TEYE_CHARCOAL,
    accent: TEYE_CRIMSON,
    outline: null,
    outlineW: 0,
    box: TEYE_WHITE,
    pad: { x: 0.18, y: 0.08 },
    radius: 0.16,
    shadow: null,
    tilt: 0,
    sample: 'WAIT FOR IT…',
  },
  {
    id: 'gamer',
    name: 'TEYE Yellow',
    font: TITLE_FONT,
    upper: true,
    color: TEYE_YELLOW,
    accent: TEYE_WHITE,
    outline: TEYE_BLACK,
    outlineW: 0.1,
    box: null,
    pad: { x: 0, y: 0 },
    radius: 0,
    shadow: { color: TEYE_BLACK, alpha: 0.5, offset: 0.05 },
    tilt: 0,
    sample: '4 HEADSHOTS!',
  },
  {
    id: 'comic',
    name: 'Comic Pop',
    font: TITLE_FONT,
    upper: true,
    color: TEYE_WHITE,
    accent: TEYE_CRIMSON,
    outline: TEYE_BLACK,
    outlineW: 0.09,
    box: null,
    pad: { x: 0, y: 0 },
    radius: 0,
    // a hard crimson "pop" behind the outline
    shadow: { color: TEYE_CRIMSON_DEEP, alpha: 0, offset: 0.08 },
    // a slight lean: lively, still quick to read
    tilt: -1.5,
    sample: 'NO *WAY!*',
  },
  {
    id: 'banner',
    name: 'TEYE Red Banner',
    font: TITLE_FONT,
    upper: true,
    color: TEYE_WHITE,
    accent: TEYE_YELLOW,
    outline: null,
    outlineW: 0,
    box: TEYE_CRIMSON_DEEP,
    pad: { x: 0.26, y: 0.17 },
    radius: 0.16,
    shadow: { color: TEYE_BLACK, alpha: 0.7, offset: 0.04 },
    tilt: 0,
    sample: 'CLUTCH WON!',
  },
];

export const titlePreset = (id: string) => TITLE_PRESETS.find((p) => p.id === id) ?? TITLE_PRESETS[0];

export const MIN_TITLE_SIZE = 2;
export const MAX_TITLE_SIZE = 12;
/** the title wraps inside this share of the frame width */
export const TITLE_WIDTH = 0.86;
/** line height: one line to the next, as a share of the text size (1 = the font's own spacing) */
export const MIN_LINE_HEIGHT = 0.6;
export const MAX_LINE_HEIGHT = 2;
/** word spacing: the space between words, as a multiple of the font's own space */
export const MIN_WORD_SPACING = 0.5;
export const MAX_WORD_SPACING = 4;

export interface TitleStyle {
  preset: string;
  sizePct: number;
  positionPct: number;
  lineHeight?: number;
  wordSpacing?: number;
  /** kept just above the gameplay (see placeTitle) instead of at positionPct */
  aboveGameplay?: boolean;
}

/** A font's measures, in em of the letters drawn (see captions/fonts.ts FontMetrics). */
export interface TitleFont {
  scale: number;
  width: (text: string) => number;
  /** the baseline, as a share of the line (the size) down from its top */
  ascent?: number;
  /** a capital's height, in em of the letters */
  cap?: number;
}

/** A word of the title, and whether it was *starred* to stand out. */
export interface TitleWord {
  text: string;
  em: boolean;
}

/**
 * A line's words. `*…*` around one word or several makes them stand out (in
 * the preset's accent); a star with no partner is kept as typed.
 */
export function titleWords(line: string): TitleWord[] {
  const stars = [...line].filter((c) => c === '*').length;
  // an odd number of stars: the last one has no partner and is kept as a letter
  const lastPaired = stars % 2 ? line.lastIndexOf('*') : -1;
  const out: TitleWord[] = [];
  let starred = false;
  let cur: TitleWord | null = null;
  [...line].forEach((c, i) => {
    if (c === '*' && i !== lastPaired) {
      starred = !starred;
      return;
    }
    if (/\s/.test(c)) {
      cur = null;
      return;
    }
    if (!cur) out.push((cur = { text: '', em: false }));
    cur.text += c;
    // a word with any starred letters stands out whole ("*4*K")
    if (starred) cur.em = true;
  });
  return out;
}

/** A line written back with its starred words marked one by one ("*FOUR* *HEADSHOTS*"). */
const markLine = (words: TitleWord[]) => words.map((w) => (w.em ? `*${w.text}*` : w.text)).join(' ');
/** The letters drawn, without the stars. */
export const plainLine = (line: string) => titleWords(line).map((w) => w.text).join(' ');

/** The title as it's shown: its lines (stars marked word by word), in capitals where the preset uses them. */
export const titleLines = (text: string, preset: TitlePreset) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.replace(/\*/g, '').trim())
    .map((l) => markLine(titleWords(preset.upper ? l.toLocaleUpperCase('en') : l)));

/** the room a preset needs on each side of its letters, as a share of the size */
const edgeOf = (preset: TitlePreset) => (preset.box ? preset.pad.x : preset.outline ? preset.outlineW : 0);

/**
 * The title's lines as drawn: each typed line, broken between words where it
 * would be wider than TITLE_WIDTH (a word wider than that keeps a line to
 * itself). Done here, not by the renderer, so the line height can be set and
 * the preview breaks the same way (it measures with the same font). Starred
 * words keep their stars.
 */
export function wrapTitle(text: string, style: TitleStyle, frame: { width: number; height: number }, font: TitleFont): string[] {
  const size = (frame.height * style.sizePct) / 100;
  const preset = titlePreset(style.preset);
  // the box's padding or the outline, on both sides, stays inside TITLE_WIDTH too
  const edge = 2 * size * edgeOf(preset);
  // the letters' em in px: the export draws them `scale` times the font size
  const maxEm = (TITLE_WIDTH * frame.width - edge) / (size * font.scale);
  return titleLines(text, preset).flatMap((line) => {
    const out: string[] = [];
    for (const word of line.split(' ')) {
      const cur = out.at(-1);
      if (cur !== undefined && lineWidth(`${cur} ${word}`, style, font) <= maxEm) out[out.length - 1] = `${cur} ${word}`;
      else out.push(word);
    }
    return out;
  });
}

/** A line's width in em of the letters (its stars aren't drawn), its spaces widened (or narrowed) by the word spacing. */
export function lineWidth(line: string, style: TitleStyle, font: TitleFont): number {
  const plain = plainLine(line);
  const spaces = plain.split(' ').length - 1;
  return font.width(plain) + spaces * font.width(' ') * ((style.wordSpacing ?? 1) - 1);
}

/** a font's baseline and capital height, when they weren't read from it */
const ASCENT_GUESS = 0.8;
const CAP_GUESS = 0.7;

export interface TitleBox {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/**
 * Where each line's box goes, in px of the frame: around the line's capitals,
 * padded, its corners rounded. Every line has one, also for presets without a
 * box (the safe-place checks use them as the title's extent).
 */
export function titleBoxes(lines: string[], style: TitleStyle, frame: { width: number; height: number }, font: TitleFont): TitleBox[] {
  const preset = titlePreset(style.preset);
  const size = (frame.height * style.sizePct) / 100;
  const em = size * font.scale;
  const step = size * (style.lineHeight ?? 1);
  const top = (frame.height * style.positionPct) / 100;
  const padX = size * (preset.box ? preset.pad.x : preset.outlineW);
  const padY = size * (preset.box ? preset.pad.y : preset.outlineW);
  return lines.map((line, i) => {
    const baseline = top + i * step + size * (font.ascent ?? ASCENT_GUESS);
    const capTop = baseline - em * (font.cap ?? CAP_GUESS);
    const w = lineWidth(line, style, font) * em + 2 * padX;
    const h = baseline - capTop + 2 * padY;
    return { x: frame.width / 2 - w / 2, y: capTop - padY, w, h, r: Math.min(h / 2, size * preset.radius) };
  });
}

/** "#RRGGBB" -> ASS "&HAABBGGRR" */
const assColor = (hex: string, alpha = 0) => {
  const n = hex.replace('#', '');
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${n.slice(4, 6)}${n.slice(2, 4)}${n.slice(0, 2)}`.toUpperCase();
};
/** "#RRGGBB" -> an ASS colour override's "&HBBGGRR&" */
const assTagColor = (hex: string) => `${assColor(hex).replace('&H00', '&H')}&`;
const alphaByte = (a: number) => Math.round(Math.min(1, Math.max(0, a)) * 255);

/**
 * A line as ASS text: starred words in the accent, each space stretched
 * sideways to the word spacing (libass has no word-spacing tag).
 */
function assLine(line: string, preset: TitlePreset, wordSpacing = 1): string {
  const space = wordSpacing === 1 ? ' ' : `{\\fscx${Math.round(wordSpacing * 100)}} {\\fscx100}`;
  return titleWords(line)
    .map((w) => (w.em ? `{\\c${assTagColor(preset.accent)}}${escapeAss(w.text)}{\\c${assTagColor(preset.color)}}` : escapeAss(w.text)))
    .join(space);
}

/** a rounded rectangle as an ASS drawing, from its own top-left (0, 0) */
function roundedRect(w: number, h: number, r: number): string {
  const k = r * (1 - 0.5523); // a quarter circle's bézier handles
  const n = (v: number) => Math.round(v);
  return [
    `m ${n(r)} 0`,
    `l ${n(w - r)} 0`,
    `b ${n(w - k)} 0 ${n(w)} ${n(k)} ${n(w)} ${n(r)}`,
    `l ${n(w)} ${n(h - r)}`,
    `b ${n(w)} ${n(h - k)} ${n(w - k)} ${n(h)} ${n(w - r)} ${n(h)}`,
    `l ${n(r)} ${n(h)}`,
    `b ${n(k)} ${n(h)} 0 ${n(h - k)} 0 ${n(h - r)}`,
    `l 0 ${n(r)}`,
    `b 0 ${n(k)} ${n(k)} 0 ${n(r)} 0`,
  ].join(' ');
}

/**
 * The title for one piece of the short, up for all of it (no fade: the short
 * loops, and a fade would show where). Its top-centre sits `positionPct` down
 * the frame; long lines wrap inside TITLE_WIDTH (wrapTitle). Each line is its
 * own event, `lineHeight` text sizes below the one before, over its rounded
 * box when the preset has one. Null with no text.
 */
export function titleAss(
  text: string,
  style: TitleStyle,
  dur: number,
  frame: { width: number; height: number },
  fontName: string,
  font: TitleFont,
): string | null {
  const preset = titlePreset(style.preset);
  const lines = wrapTitle(text, style, frame, font);
  if (lines.length === 0) return null;
  const size = Math.round((frame.height * style.sizePct) / 100);
  const margin = Math.round((frame.width * (1 - TITLE_WIDTH)) / 2);
  const outline = preset.outline ? Math.max(1, Math.round(size * preset.outlineW)) : 0;
  // a box preset's shadow is under the box, not the letters
  const letterShadow = preset.shadow && !preset.box ? Math.max(1, Math.round(size * preset.shadow.offset)) : 0;
  const shadowColor = preset.shadow ? assColor(preset.shadow.color, alphaByte(preset.shadow.alpha)) : assColor('#000000', 0x60);
  const x = Math.round(frame.width / 2);
  const y = (frame.height * style.positionPct) / 100;
  const step = size * (style.lineHeight ?? 1);
  const boxes = titleBoxes(lines, style, frame, font);
  // a tilted title turns as one, about its middle
  const mid = boxes.length ? (boxes[0].y + boxes.at(-1)!.y + boxes.at(-1)!.h) / 2 : y;
  const turn = preset.tilt ? `\\org(${x},${Math.round(mid)})\\frz${-preset.tilt}` : '';
  const end = time(Math.max(0.01, dur));
  const boxEvents = preset.box
    ? boxes.map((b) => {
        const shadow = preset.shadow ? Math.max(1, Math.round(size * preset.shadow.offset)) : 0;
        const tags = `\\an7\\pos(${Math.round(b.x)},${Math.round(b.y)})\\bord0\\shad${shadow}\\1c${assTagColor(preset.box!)}${shadow ? `\\4c${assTagColor(preset.shadow!.color)}\\4a&H${alphaByte(preset.shadow!.alpha).toString(16).padStart(2, '0').toUpperCase()}&` : ''}${turn}\\p1`;
        return `Dialogue: 0,${time(0)},${end},Title,,0,0,0,,{${tags}}${roundedRect(b.w, b.h, b.r)}{\\p0}`;
      })
    : [];
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    // lines are broken here (wrapTitle), never by the renderer
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Title,${fontName},${size},${assColor(preset.color)},${assColor(preset.color)},${assColor(preset.outline ?? '#000000')},${shadowColor},0,0,0,0,100,100,0,0,1,${outline},${letterShadow},8,${margin},${margin},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...boxEvents,
    ...lines.map((l, i) => `Dialogue: 1,${time(0)},${end},Title,,0,0,0,,{\\an8\\pos(${x},${Math.round(y + i * step)})${turn}}${assLine(l, preset, style.wordSpacing)}`),
    '',
  ].join('\n');
}

/** the gap between a title kept above the gameplay and the gameplay, as a share of the frame height */
export const ABOVE_GAMEPLAY_GAP = 0.012;

/**
 * The title's style as drawn. Kept above the gameplay, its last line's bottom
 * sits just over where the gameplay starts (`seam`, a share of the frame
 * height): on the camera's lower edge, the same place in every short whatever
 * the camera's size or the title's lines, and never over the crosshair. A
 * title too tall for that stops at the safe top. Otherwise as set.
 */
export function placeTitle<T extends TitleStyle>(text: string, style: T, frame: { width: number; height: number }, font: TitleFont, seam: number): T {
  if (!style.aboveGameplay) return style;
  const lines = wrapTitle(text, style, frame, font);
  if (!lines.length) return style;
  // where its boxes are with its top at the frame's top
  const at0 = titleBoxes(lines, { ...style, positionPct: 0 }, frame, font);
  const last = at0[at0.length - 1];
  const top = Math.max(frame.height * SAFE_TOP - at0[0].y, frame.height * (seam - ABOVE_GAMEPLAY_GAP) - (last.y + last.h));
  return { ...style, positionPct: Math.round((top / frame.height) * 1000) / 10 };
}

/** YouTube's own buttons, channel name and caption cover about this much of a Short's bottom */
export const YOUTUBE_UI_BOTTOM = 0.22;
/** too near the top edge: the phone's status bar and YouTube's search */
export const SAFE_TOP = 0.05;
/** the crosshair: the middle of the gameplay, give or take this share of the frame */
export const CROSSHAIR_ZONE = 0.06;

/**
 * Where the title would be hard to see or in the way, from its drawn extent
 * (top and bottom, as shares of the frame height): near the top edge, behind
 * YouTube's buttons, over the crosshair, over the kill feed. Notes, not limits.
 */
export function titleWarnings(
  extent: { top: number; bottom: number },
  bands: { split: number; bottom: number },
  feed?: { top: number; bottom: number } | null,
): string[] {
  const out: string[] = [];
  const over = (a: number, b: number) => extent.top < b && extent.bottom > a;
  if (extent.top < SAFE_TOP) out.push('Too close to the top: the phone and YouTube cover it');
  if (extent.bottom > 1 - Math.max(YOUTUBE_UI_BOTTOM, bands.bottom)) out.push("Behind YouTube's buttons and caption at the bottom");
  const crosshair = bands.split + (1 - bands.split - bands.bottom) / 2;
  if (over(crosshair - CROSSHAIR_ZONE, crosshair + CROSSHAIR_ZONE)) out.push('Over the crosshair');
  if (feed && over(feed.top, feed.bottom)) out.push('Over the kill feed');
  return out;
}
