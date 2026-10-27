// Code-switched speech (Urdu with English mixed in) defeats Whisper's language
// detection: it calls the whole clip English and *translates* the Urdu. So
// every utterance is transcribed twice:
//   - in Hindi script, which captures every word as spoken (English words too,
//     written phonetically: वुद, वेरी, बिकाज), and
//   - in English, which spells the English words properly but translates Urdu.
// The Hindi-script words are the base; where the English pass has a word at
// the same moment that *sounds* the same, its spelling wins.

export interface TimedWord {
  start: number;
  end: number;
  text: string;
}

/** Rough sound key: consonant skeleton with similar sounds folded together. */
export function soundKey(word: string): string {
  let s = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return '';
  s = s
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/sh|ch/g, 's')
    .replace(/ck|c|q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/v/g, 'w')
    .replace(/[zj]/g, 's')
    .replace(/(?<=.)l(?=[dt])/g, ''); // silent l: would, could, should
  const first = s[0];
  const rest = s.slice(1).replace(/[aeiouyh]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1').replace(/^[aeiou]/, 'a');
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

export function soundsAlike(a: string, b: string): boolean {
  const ka = soundKey(a);
  const kb = soundKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka[0] !== kb[0]) return false; // the opening sound must match ("match" is not "this")
  const longest = Math.max(ka.length, kb.length);
  return longest >= 3 && distance(ka, kb) <= 1;
}

const NEAR_S = 1.0; // the two passes' word timings drift up to about a second

/**
 * Merges the romanized Hindi-script words (base) with the English pass.
 * Returns the words to show and how many came from the English pass.
 */
export function mergeEnglish(base: TimedWord[], english: TimedWord[]): { words: TimedWord[]; englishCount: number } {
  const used = new Set<number>();
  let englishCount = 0;
  const words = base.map((w) => {
    const mid = (w.start + w.end) / 2;
    let best = -1;
    let bestGap = Infinity;
    english.forEach((e, i) => {
      if (used.has(i)) return;
      const gap = Math.abs((e.start + e.end) / 2 - mid);
      if (gap <= NEAR_S && gap < bestGap && soundsAlike(w.text, e.text)) {
        best = i;
        bestGap = gap;
      }
    });
    if (best < 0) return w;
    used.add(best);
    englishCount++;
    return { ...w, text: english[best].text };
  });
  return { words, englishCount };
}
