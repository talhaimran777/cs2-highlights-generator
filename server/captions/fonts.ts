import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');

/** Caption fonts: family name (as libass matches it) → file in FONTS_DIR. */
export const CAPTION_FONTS: Record<string, string> = {
  'Montserrat Black': 'Montserrat-Black.ttf',
  Anton: 'Anton-Regular.ttf',
  'Bebas Neue': 'BebasNeue-Regular.ttf',
  'Poppins ExtraBold': 'Poppins-ExtraBold.ttf',
};

// a short's title uses Anton (shorts/title.ts TITLE_FONT), one of the caption fonts
const ALL_FONTS = { ...CAPTION_FONTS };

/** Ships with Windows; used when a font hasn't been downloaded. */
export const FALLBACK_FONT = 'Arial Black';

export function availableFonts(): string[] {
  return Object.entries(CAPTION_FONTS)
    .filter(([, file]) => existsSync(join(FONTS_DIR, file)))
    .map(([name]) => name);
}

export const fontFile = (name: string) => (ALL_FONTS[name] ? join(FONTS_DIR, ALL_FONTS[name]) : null);

/** a bold capital is about this wide (em), for a font that can't be read */
const GUESS_EM = 0.62;

export interface FontMetrics {
  /**
   * How big the letters come out in a burned-in subtitle, against a browser at
   * the same size. libass sizes a font by its full line height (the OS/2 win
   * ascent + descent), CSS by its em, so the same number draws smaller letters
   * in the export: em / line height.
   */
  scale: number;
  /** a text's width, in em (its glyphs' advances; no kerning) */
  width: (text: string) => number;
  /** the baseline, as a share of the line height (win ascent / (ascent + descent)) */
  ascent?: number;
  /** a capital's height, in em */
  cap?: number;
}

const metricsCache = new Map<string, FontMetrics>();

/** A font's metrics, read from its file; a rough guess when it can't be read. */
export function fontMetrics(name: string): FontMetrics {
  const font = resolveFont(name);
  const known = metricsCache.get(font);
  if (known) return known;
  const guess: FontMetrics = { scale: 1, width: (t) => [...t].length * GUESS_EM };
  const file = fontFile(font);
  let m = guess;
  if (file) {
    try {
      m = readMetrics(readFileSync(file)) ?? guess;
    } catch {
      m = guess;
    }
  }
  metricsCache.set(font, m);
  return m;
}

/** scale and glyph advances from a TrueType file (cmap format 4: the Basic Multilingual Plane) */
function readMetrics(b: Buffer): FontMetrics | null {
  const tables = new Map<string, number>();
  for (let i = 0; i < b.readUInt16BE(4); i++) tables.set(b.toString('ascii', 12 + i * 16, 16 + i * 16), b.readUInt32BE(20 + i * 16));
  const [head, os2, hhea, hmtx, cmap] = ['head', 'OS/2', 'hhea', 'hmtx', 'cmap'].map((t) => tables.get(t));
  if (head === undefined || os2 === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) return null;
  const upem = b.readUInt16BE(head + 18);
  const line = b.readUInt16BE(os2 + 74) + b.readUInt16BE(os2 + 76);
  const metrics = b.readUInt16BE(hhea + 34);
  // OS/2 version 2 and up says how tall a capital is
  const capHeight = b.readUInt16BE(os2) >= 2 ? b.readInt16BE(os2 + 88) : 0;
  const advance = (glyph: number) => b.readUInt16BE(hmtx + 4 * Math.min(glyph, metrics - 1));

  // the Unicode subtable: platform 3 (Windows) encoding 1, or platform 0
  let sub = -1;
  for (let i = 0; i < b.readUInt16BE(cmap + 2); i++) {
    const r = cmap + 4 + i * 8;
    const platform = b.readUInt16BE(r);
    const encoding = b.readUInt16BE(r + 2);
    const at = cmap + b.readUInt32BE(r + 4);
    if (b.readUInt16BE(at) === 4 && ((platform === 3 && encoding === 1) || platform === 0)) sub = at;
  }
  if (sub < 0) return null;
  const segs = b.readUInt16BE(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  const glyphOf = (code: number) => {
    for (let s = 0; s < segs; s++) {
      if (code > b.readUInt16BE(ends + s * 2)) continue;
      const start = b.readUInt16BE(starts + s * 2);
      if (code < start) return 0;
      const delta = b.readInt16BE(deltas + s * 2);
      const range = b.readUInt16BE(ranges + s * 2);
      if (range === 0) return (code + delta) & 0xffff;
      const g = b.readUInt16BE(ranges + s * 2 + range + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  const widths = new Map<number, number>();
  const charWidth = (code: number) => {
    let w = widths.get(code);
    if (w === undefined) {
      // a character the font lacks is drawn from another font: about a capital's width
      const g = code <= 0xffff ? glyphOf(code) : 0;
      w = g ? advance(g) / upem : GUESS_EM;
      widths.set(code, w);
    }
    return w;
  };
  return {
    scale: line > 0 ? upem / line : 1,
    ascent: line > 0 ? b.readUInt16BE(os2 + 74) / line : undefined,
    cap: capHeight > 0 ? capHeight / upem : undefined,
    width: (t) => [...t].reduce((s, c) => s + charWidth(c.codePointAt(0)!), 0),
  };
}

/** see FontMetrics.scale */
export const assScale = (name: string) => fontMetrics(name).scale;

export function resolveFont(name: string): string {
  const file = fontFile(name);
  return file && existsSync(file) ? name : FALLBACK_FONT;
}
