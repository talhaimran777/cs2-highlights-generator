// Spoken Urdu → Roman Urdu, offline.
//
// Whisper is asked to write Urdu/Hindi speech in Devanagari (spoken Urdu and
// Hindi are nearly the same), because Devanagari spells every vowel and so
// converts to readable Roman Urdu with rules. Urdu script drops most vowels;
// a rougher converter handles lines Whisper still writes that way.

/** Whole words people spell a fixed way in Roman Urdu, and CS words Whisper writes in Devanagari. */
const WORDS: Record<string, string> = {
  // common Urdu
  'है': 'hai', 'हैं': 'hain', 'था': 'tha', 'थी': 'thi', 'थे': 'the',
  'नहीं': 'nahi', 'नही': 'nahi', 'ना': 'na', 'न': 'na',
  'मैं': 'main', 'में': 'mein', 'हम': 'hum', 'तुम': 'tum', 'तू': 'tu', 'आप': 'aap',
  'वो': 'wo', 'वह': 'wo', 'ये': 'ye', 'यह': 'ye', 'यहाँ': 'yahan', 'यहां': 'yahan', 'वहाँ': 'wahan', 'वहां': 'wahan',
  'क्या': 'kya', 'क्यों': 'kyun', 'कैसे': 'kaise', 'कहाँ': 'kahan', 'कहां': 'kahan', 'कौन': 'kaun',
  'यार': 'yaar', 'भाई': 'bhai', 'भाईजान': 'bhaijaan', 'अच्छा': 'acha', 'ठीक': 'theek', 'हाँ': 'haan', 'हां': 'haan', 'जी': 'ji',
  'और': 'aur', 'या': 'ya', 'कि': 'ke', 'के': 'ke', 'का': 'ka', 'की': 'ki', 'को': 'ko', 'से': 'se', 'पर': 'par',
  'भी': 'bhi', 'तो': 'to', 'ही': 'hi', 'बस': 'bas', 'अब': 'ab', 'फिर': 'phir', 'जल्दी': 'jaldi',
  'एक': 'aik', 'दो': 'do', 'तीन': 'teen', 'चार': 'chaar', 'पांच': 'paanch', 'पाँच': 'paanch',
  'मार': 'maar', 'मारो': 'maaro', 'मारा': 'maara', 'चल': 'chal', 'चलो': 'chalo', 'आजा': 'aaja', 'जा': 'ja',
  'गया': 'gaya', 'गई': 'gayi', 'गयी': 'gayi', 'गए': 'gaye', 'गये': 'gaye', 'तरफ': 'taraf', 'तरफ़': 'taraf',
  'लॉबी': 'lobby', 'लबी': 'lobby', 'मैच': 'match',
  // CS2 / gaming terms Whisper writes phonetically in Devanagari
  'बॉम्ब': 'bomb', 'बम': 'bomb', 'साइट': 'site', 'साईट': 'site', 'रश': 'rush', 'फ्लैश': 'flash', 'स्मोक': 'smoke',
  'प्लांट': 'plant', 'डिफ्यूज़': 'defuse', 'डिफ्यूज': 'defuse', 'इको': 'eco', 'किल': 'kill', 'ड्रॉप': 'drop', 'गन': 'gun',
  'मिड': 'mid', 'लॉन्ग': 'long', 'शॉर्ट': 'short', 'बैक': 'back', 'पुश': 'push', 'होल्ड': 'hold', 'रोटेट': 'rotate',
  'नाइस': 'nice', 'गुड': 'good', 'वेल': 'well', 'प्ले': 'play', 'शॉट': 'shot', 'क्लच': 'clutch', 'मॉली': 'molly',
  'नेड': 'nade', 'एचपी': 'HP', 'लो': 'low', 'वन': 'one', 'टू': 'two', 'थ्री': 'three', 'फोर': 'four', 'फाइव': 'five',
  'एडब्ल्यूपी': 'AWP', 'ऑप': 'awp', 'डीगल': 'deagle', 'स्काउट': 'scout', 'केटी': 'CT', 'सीटी': 'CT', 'टी': 'T',
  'ए': 'A', 'बी': 'B', 'ओके': 'okay', 'सॉरी': 'sorry', 'थैंक्स': 'thanks', 'जीजी': 'GG', 'वाओ': 'wow',
};

const CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'ch', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'w', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  // precomposed nukta forms
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
};
/** consonant + nukta (U+093C) written as two code points */
const NUKTA: Record<string, string> = { 'क': 'q', 'ख': 'kh', 'ग': 'gh', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y' };

const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};
const MATRAS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};
const VIRAMA = '्';
const NUKTA_SIGN = '़';
const NASAL = new Set(['ं', 'ँ']);

interface Unit {
  text: string; // consonant (romanized) or '' for an independent vowel
  vowel: string | null; // romanized vowel; null = none (virama)
  inherent: boolean; // vowel is the implicit "a"
  nasal: boolean;
}

function parseWord(word: string): Unit[] {
  const units: Unit[] = [];
  const chars = [...word];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const last = units.at(-1);
    if (CONSONANTS[ch] !== undefined) {
      let text = CONSONANTS[ch];
      if (chars[i + 1] === NUKTA_SIGN) {
        text = NUKTA[ch] ?? text;
        i++;
      }
      units.push({ text, vowel: 'a', inherent: true, nasal: false });
    } else if (MATRAS[ch] !== undefined && last) {
      last.vowel = MATRAS[ch];
      last.inherent = false;
    } else if (ch === VIRAMA && last) {
      last.vowel = null;
      last.inherent = false;
    } else if (NASAL.has(ch) && last) {
      last.nasal = true;
    } else if (VOWELS[ch] !== undefined) {
      units.push({ text: '', vowel: VOWELS[ch], inherent: false, nasal: false });
    } else if (ch !== NUKTA_SIGN) {
      units.push({ text: ch, vowel: null, inherent: false, nasal: false });
    }
  }
  return units;
}

/**
 * Hindi schwa deletion: drop the word-final inherent "a", and, scanning right
 * to left, a medial inherent "a" that sits between two pronounced vowels
 * (देख → dekh, करना → karna, समझना → samajhna).
 */
function deleteSchwas(units: Unit[]) {
  const hasVowel = (u?: Unit) => !!u && u.vowel !== null;
  const last = units.at(-1);
  if (last?.inherent && units.length > 1) last.vowel = null;
  for (let i = units.length - 2; i >= 1; i--) {
    const u = units[i];
    const prev = units[i - 1];
    // a syllable already closed by a nasal keeps the next "a" (ज़िंदगी → zindagi)
    if (u.inherent && u.text && hasVowel(prev) && !prev.nasal && hasVowel(units[i + 1]) && units[i + 1].text) {
      u.vowel = null;
    }
  }
}

/**
 * Casual Roman Urdu spelling: long vowels are written short at the end of a
 * word or before a vowel, unless nasalised (हूँ → hoon).
 */
function spell(units: Unit[]): string {
  let out = '';
  units.forEach((u, i) => {
    out += u.text;
    if (u.vowel) {
      const final = i === units.length - 1;
      const beforeVowel = !final && !units[i + 1].text;
      let v = u.vowel;
      // one-syllable words keep the long vowel: आ → aa, not a
      const shorten = (final || beforeVowel) && !u.nasal && units.length > 1;
      if (shorten) v = v === 'aa' ? 'a' : v === 'ee' ? 'i' : v === 'oo' ? 'u' : v;
      out += v;
    }
    if (u.nasal) out += 'n';
  });
  return out;
}

export function romanizeDevanagariWord(word: string): string {
  if (WORDS[word]) return WORDS[word];
  const units = parseWord(word);
  deleteSchwas(units);
  return spell(units);
}

const URDU_WORDS: Record<string, string> = {
  'ہے': 'hai', 'ہیں': 'hain', 'نہیں': 'nahi', 'کیا': 'kya', 'یار': 'yaar', 'بھائی': 'bhai', 'میں': 'main',
  'اور': 'aur', 'تو': 'to', 'بھی': 'bhi', 'کے': 'ke', 'کا': 'ka', 'کی': 'ki', 'کو': 'ko', 'سے': 'se',
  'وہ': 'wo', 'یہ': 'ye', 'اچھا': 'acha', 'ٹھیک': 'theek', 'ہاں': 'haan', 'جی': 'ji', 'چلو': 'chalo', 'مارو': 'maaro',
};
const URDU_LETTERS: Record<string, string> = {
  'ا': 'a', 'آ': 'aa', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ٹ': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ڈ': 'd', 'ذ': 'z', 'ر': 'r', 'ڑ': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z',
  'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ک': 'k', 'ك': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm',
  'ن': 'n', 'ں': 'n', 'و': 'o', 'ہ': 'h', 'ه': 'h', 'ھ': 'h', 'ء': '', 'ی': 'i', 'ي': 'i', 'ے': 'e', 'ۓ': 'e',
  'َ': 'a', 'ِ': 'i', 'ُ': 'u', 'ّ': '', 'ْ': '',
};

/** Rough fallback: Urdu script has no short vowels, so unknown words come out consonant-heavy. */
export function romanizeUrduWord(word: string): string {
  if (URDU_WORDS[word]) return URDU_WORDS[word];
  return [...word].map((c) => URDU_LETTERS[c] ?? c).join('');
}

const DEVANAGARI = /[ऀ-ॿ]/;
const ARABIC = /[؀-ۿ]/;
const DANDA = /[।॥]/g;

/** Romanizes one caption word (keeps leading/trailing punctuation; Latin passes through). */
export function romanizeWord(word: string): string {
  const m = /^([^\p{L}\p{M}]*)([\p{L}\p{M}\p{N}'’-]*)([^\p{L}\p{M}]*)$/u.exec(word.replace(DANDA, '.'));
  if (!m) return word;
  const [, pre, core, post] = m;
  let out = core;
  if (DEVANAGARI.test(core)) out = romanizeDevanagariWord(core);
  else if (ARABIC.test(core)) out = romanizeUrduWord(core);
  return pre + out + post;
}

export function romanize(text: string): string {
  return text
    .split(/(\s+)/)
    .map((w) => (/\s/.test(w) ? w : romanizeWord(w)))
    .join('');
}
