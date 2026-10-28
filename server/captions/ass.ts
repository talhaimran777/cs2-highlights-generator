import type { CaptionLine, CaptionSettings, CaptionWord } from '../types.ts';

const HOLD_S = 0.15; // keep the last word up a moment after it's said

// ASS colors are &HAABBGGRR
const WHITE = '&H00FFFFFF';
const YELLOW = '&H0000D4FF'; // #FFD400
const BLACK = '&H00000000';
const SHADOW = '&H80000000';

/**
 * Most characters in one caption: about 9 per word asked for, but never more
 * than fit across the frame at the caption size (bold caps are ~0.62 em wide).
 */
export function captionChars(settings: Pick<CaptionSettings, 'wordsPerCaption' | 'sizePct'>, video: { width: number; height: number }) {
  const fit = Math.floor((0.9 * video.width) / (0.62 * ((video.height * settings.sizePct) / 100)));
  return Math.max(8, Math.min(9 * settings.wordsPerCaption, fit));
}

/**
 * Splits a line's words into on-screen captions of up to `maxWords`, breaking at sentence ends and at
 * pauses longer than `pauseS` (shorter ones are breaths mid-sentence).
 */
export function chunkWords(words: CaptionWord[], maxWords = 2, maxChars = 18, pauseS = 0.7): CaptionWord[][] {
  const chunks: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const breakHere =
      cur.length >= maxWords ||
      (cur.length > 0 && chars > maxChars) ||
      (prev && w.start - prev.end > pauseS) ||
      (prev && /[.!?]$/.test(prev.text));
    if (breakHere && cur.length) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Caption text can't contain ASS override braces or backslashes. */
export const escapeAss = (s: string) => s.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, ' ');

function time(sec: number) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * Builds the ASS subtitle file for one clip of the reel. Times are relative to
 * the clip's start; words outside the clip are left out.
 */
export function buildAss(
  lines: CaptionLine[],
  clip: { start: number; end: number },
  video: { width: number; height: number },
  settings: CaptionSettings,
  fontName: string,
): string | null {
  const dur = clip.end - clip.start;
  // each line (sentence) is chunked on its own, so two sentences never share a caption
  const chunks = lines
    .map((l) =>
      l.words
        .filter((w) => w.end > clip.start && w.start < clip.end && w.text.trim())
        .map((w) => ({
          start: Math.max(0, w.start - clip.start),
          end: Math.min(dur, w.end - clip.start),
          text: escapeAss(settings.uppercase ? w.text.toLocaleUpperCase('en') : w.text),
        })),
    )
    .filter((ws) => ws.length)
    .sort((a, b) => a[0].start - b[0].start)
    .flatMap((ws) => chunkWords(ws, settings.wordsPerCaption, captionChars(settings, video), settings.pauseS));
  if (chunks.length === 0) return null;

  const size = Math.round((video.height * settings.sizePct) / 100);
  const outline = Math.max(2, Math.round(size * 0.08));
  const shadow = Math.max(1, Math.round(size * 0.04));
  const x = Math.round(video.width / 2);
  const y = Math.round((video.height * settings.positionPct) / 100);
  const pos = `\\an5\\pos(${x},${y})`;
  // karaoke fills from secondary (white) to primary (yellow)
  const primary = settings.style === 'karaoke' ? YELLOW : WHITE;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${fontName},${size},${primary},${WHITE},${BLACK},${SHADOW},-1,0,0,0,100,100,1,0,1,${outline},${shadow},5,40,40,40,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events: string[] = [];
  const dialogue = (start: number, end: number, text: string) =>
    events.push(`Dialogue: 0,${time(start)},${time(end)},Caption,,0,0,0,,${text}`);

  chunks.forEach((chunk, ci) => {
    // hold the last word a moment, but never into the next caption
    const nextStart = chunks[ci + 1]?.[0].start ?? dur;
    const chunkEnd = Math.min(dur, nextStart, chunk.at(-1)!.end + HOLD_S);
    if (settings.style === 'clean') {
      dialogue(chunk[0].start, chunkEnd, `{${pos}\\fad(100,100)}${chunk.map((w) => w.text).join(' ')}`);
    } else if (settings.style === 'karaoke') {
      const k = chunk.map((w, i) => {
        const next = chunk[i + 1]?.start ?? w.end;
        return `{\\kf${Math.max(1, Math.round((next - w.start) * 100))}}${w.text}`;
      });
      dialogue(chunk[0].start, chunkEnd, `{${pos}\\fad(80,80)}${k.join(' ')}`);
    } else {
      // word pop: one event per word; the spoken word is yellow and pops to 115 %
      chunk.forEach((active, i) => {
        const start = i === 0 ? chunk[0].start : active.start;
        const end = i === chunk.length - 1 ? chunkEnd : chunk[i + 1].start;
        const fade = i === 0 ? '\\fad(80,0)' : i === chunk.length - 1 ? '\\fad(0,100)' : '';
        const text = chunk
          .map((w) =>
            w === active ? `{\\c${YELLOW}\\t(0,80,\\fscx115\\fscy115)\\t(80,160,\\fscx100\\fscy100)}${w.text}{\\r}` : w.text,
          )
          .join(' ');
        dialogue(start, end, `{${pos}${fade}}${text}`);
      });
    }
  });
  return [...header, ...events, ''].join('\n');
}
