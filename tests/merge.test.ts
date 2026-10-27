import { describe, expect, it } from 'vitest';
import { mergeEnglish, soundsAlike } from '../server/captions/merge.ts';
import { collapseRepeats } from '../server/captions/transcribe.ts';

describe('repeats', () => {
  it('keeps at most two of the same word in a row', () => {
    const w = (text: string) => ({ text });
    expect(collapseRepeats('Sim, Sim. sim sim sim sim sim go'.split(' ').map(w)).map((x) => x.text)).toEqual(['Sim,', 'Sim.', 'go']);
    expect(collapseRepeats('short short go'.split(' ').map(w)).map((x) => x.text)).toEqual(['short', 'short', 'go']);
  });
});

describe('sounds alike', () => {
  it.each([
    ['wud', 'would'],
    ['weri', 'very'],
    ['gud', 'good'],
    ['bikaaj', 'because'],
    ['B', 'be'],
    ['it', 'it'],
    ['maich', 'match'],
  ])('%s ≈ %s', (a, b) => expect(soundsAlike(a, b)).toBe(true));

  it.each([
    ['match', 'this'],
    ['taraf', 'people'],
    ['chaar', 'four'],
    ['bande', 'have'],
  ])('%s ≠ %s', (a, b) => expect(soundsAlike(a, b)).toBe(false));
});

describe('merging the two passes', () => {
  // From a real FACEIT clip: the English pass translated the Urdu, the Hindi-script pass wrote English phonetically.
  const t = (words: string, from: number, step = 0.4) => words.split(' ').map((text, i) => ({ start: from + i * step, end: from + i * step + 0.3, text }));
  const roman = t('it wud B gud ke ye match lag jaye na it wud B weri gud bikaaj unki taraf chaar bande aa chuke hain', 10);
  // English pass: same moments for the English parts, a translation for the Urdu parts
  const english = [
    ...t('it would be good', 10),
    ...t('that this match', 11.6),
    ...t('it would be very good because', 14),
    ...t('4 people have come', 16.6),
  ];

  it('spells English words properly and keeps Roman Urdu', () => {
    const { words, englishCount } = mergeEnglish(roman, english);
    expect(words.map((w) => w.text).join(' ')).toBe(
      'it would be good ke ye match lag jaye na it would be very good because unki taraf chaar bande aa chuke hain',
    );
    expect(englishCount).toBeGreaterThanOrEqual(9);
  });
});
