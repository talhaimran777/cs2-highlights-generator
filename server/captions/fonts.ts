import { existsSync } from 'node:fs';
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

/** Ships with Windows; used when a font hasn't been downloaded. */
export const FALLBACK_FONT = 'Arial Black';

export function availableFonts(): string[] {
  return Object.entries(CAPTION_FONTS)
    .filter(([, file]) => existsSync(join(FONTS_DIR, file)))
    .map(([name]) => name);
}

export const fontFile = (name: string) => (CAPTION_FONTS[name] ? join(FONTS_DIR, CAPTION_FONTS[name]) : null);

export function resolveFont(name: string): string {
  const file = fontFile(name);
  return file && existsSync(file) ? name : FALLBACK_FONT;
}
