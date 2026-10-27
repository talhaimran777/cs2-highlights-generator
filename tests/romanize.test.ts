import { describe, expect, it } from 'vitest';
import { romanize, romanizeDevanagariWord } from '../server/captions/romanize.ts';

describe('Roman Urdu', () => {
  it.each([
    ['भाई पीछे देखो', 'bhai peeche dekho'],
    ['क्या कर रहा है', 'kya kar raha hai'],
    ['यार जल्दी आजा', 'yaar jaldi aaja'],
    ['नहीं मैं ठीक हूँ', 'nahi main theek hoon'],
    ['बॉम्ब साइट बी', 'bomb site B'],
    ['वो लो है', 'wo low hai'],
  ])('%s → %s', (src, out) => {
    expect(romanize(src)).toBe(out);
  });

  it.each([
    ['देख', 'dekh'], // final schwa
    ['करना', 'karna'], // medial schwa
    ['समझना', 'samajhna'], // right-to-left keeps the right one
    ['समझ', 'samajh'],
    ['बात', 'baat'],
    ['काम', 'kaam'],
    ['ज़िंदगी', 'zindagi'], // nukta (precomposed) + anusvara
    ['फ़ायर', 'faayar'], // nukta as two code points
    ['बड़ा', 'bara'],
  ])('word %s → %s', (src, out) => {
    expect(romanizeDevanagariWord(src.normalize('NFC'))).toBe(out);
  });

  it('keeps English and punctuation as is', () => {
    expect(romanize('nice shot! bhai')).toBe('nice shot! bhai');
    expect(romanize('रुको।')).toBe('ruko.');
  });

  it('Urdu script fallback for common words', () => {
    expect(romanize('یار کیا ہے')).toBe('yaar kya hai');
  });
});
