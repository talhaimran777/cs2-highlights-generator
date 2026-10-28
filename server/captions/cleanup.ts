import Anthropic from '@anthropic-ai/sdk';
import type { CaptionLine, CaptionWord } from '../types.ts';

// Whisper hears Urdu well enough, but the rule-based Roman Urdu (romanize.ts)
// and the English merge (merge.ts) spell it stiffly and sometimes swap in the
// wrong English word ("Urdu" -> "And"). Claude rewrites each line the way a
// Pakistani player would type it, keeping the word timings for the animation.

const MODEL = 'claude-opus-5-5';
const BATCH = 60; // lines per request

/** Cleanup needs an Anthropic credential; without one the rule-based captions are used as they are. */
export const cleanupAvailable = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SYSTEM = `You fix captions for a Pakistani Counter-Strike 2 player's YouTube videos. The player and teammates speak Urdu (Hindi), English, and a mix of both in one sentence.

For each line you get:
- "heard": what the speech recognizer heard, written in Hindi (Devanagari) script. English words in it are written phonetically (वेरी = very, रश = rush). This is the most faithful record of what was said.
- "draft": a rough automatic Roman Urdu version, with some English spellings merged in. It can contain wrong English words that only sound similar.

Rewrite each line as the caption should read:
- Urdu/Hindi words in Roman Urdu, spelled the way Pakistanis commonly type them: hai, hain, nahi, kya, kyun, bhai, yaar, acha, theek, wahan, yahan, par, mein, unhon ne, kar raha hoon, kar diya, jaldi, chalo.
- English words in normal English spelling (check, rush, molly, nice, man, don't).
- CS2 terms in their usual English form: A site, B site, mid, long, short, banana, AWP, deagle, one HP, smoke, flash, molly, nade, rotate, eco, force buy, plant, defuse, clutch, ace, CT, T.
- Keep the words that were said, in their order. Never translate Urdu into English or English into Urdu, never summarize, never add words. Only fix a word the recognizer clearly misheard when the context (a CS2 callout, a common phrase) makes the intended word obvious.
- Light punctuation: a question mark for questions, otherwise few commas.
- If a line is only a filler sound or noise ("uh", "hmm", "अ..."), return no words for it.
- lang is "en" when the line is (almost) all English, otherwise "ur".

Return every line id exactly once.`;

const SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          lang: { type: 'string', enum: ['en', 'ur'] },
          words: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'lang', 'words'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

interface Fixed {
  id: string;
  lang: 'en' | 'ur';
  words: string[];
}

/**
 * Rewrites caption lines into natural Roman Urdu / English. Lines you edited by
 * hand and lines already cleaned are left alone. Returns the new list; lines
 * that came back empty (filler sounds) are marked removed.
 */
export async function cleanupCaptions(lines: CaptionLine[], onProgress?: (f: number) => void, signal?: AbortSignal): Promise<CaptionLine[]> {
  const todo = lines.filter((l) => !l.edited && !l.cleaned && !l.removed);
  if (todo.length === 0) return lines;
  const client = new Anthropic();
  const fixed = new Map<string, Fixed>();

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const input = batch.map((l) => ({ id: l.id, heard: l.source, draft: l.words.map((w) => w.text).join(' ') }));
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // a safety decline is retried on another model instead of failing the job
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify({ lines: input }, null, 1) }],
      },
      { signal },
    );
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('Caption cleanup was declined by the model');
    if (msg.stop_reason === 'max_tokens') throw new Error('Caption cleanup ran out of output space');
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    for (const f of (JSON.parse(text) as { lines: Fixed[] }).lines) fixed.set(f.id, f);
    onProgress?.(Math.min(1, (i + batch.length) / todo.length));
  }

  return lines.map((l) => {
    const f = fixed.get(l.id);
    if (!f) return l; // not sent, or missing from the reply: keep the rule-based version
    const tokens = f.words.map((w) => w.trim()).filter(Boolean);
    if (tokens.length === 0) return { ...l, cleaned: true, removed: true };
    return { ...l, lang: f.lang, words: retime(l.words, tokens, l), cleaned: true };
  });
}

/**
 * Timing for rewritten words. Same number of words: each keeps its slot.
 * Otherwise each new word is placed where the same stretch of text was in the
 * old words (by character position), so it keeps their real timing and pauses.
 */
export function retime(old: CaptionWord[], tokens: string[], line: { start: number; end: number }): CaptionWord[] {
  if (tokens.length === old.length) return old.map((w, i) => ({ ...w, text: tokens[i] }));
  if (old.length === 0) return spreadWords(tokens, line.start, line.end);
  const oldLen = old.map((w) => w.text.length + 1);
  const oldTotal = oldLen.reduce((a, b) => a + b, 0);
  const newTotal = tokens.reduce((n, t) => n + t.length + 1, 0);
  // time at character position c of the old text; at a word boundary an end
  // takes the earlier word's end and a start the later word's start (skipping the pause)
  const at = (c: number, side: 'start' | 'end') => {
    let k = 0;
    for (; k < old.length; k++) {
      if (c < oldLen[k] - 1e-9 || (side === 'end' && c <= oldLen[k] + 1e-9)) break;
      c -= oldLen[k];
    }
    if (k >= old.length) return old.at(-1)!.end;
    const w = old[k];
    return w.start + (w.end - w.start) * Math.min(1, c / oldLen[k]);
  };
  // new word boundaries in old-text characters; one close to an old word
  // boundary snaps onto it ("karraha" -> "kar raha" keeps the pause after it)
  const pos = [0];
  for (const t of tokens) pos.push(pos.at(-1)! + ((t.length + 1) * oldTotal) / newTotal);
  let b = 0;
  for (let k = 0; k + 1 < old.length; k++) {
    b += oldLen[k];
    let j = 1;
    for (let i = 2; i < tokens.length; i++) if (Math.abs(pos[i] - b) < Math.abs(pos[j] - b)) j = i;
    if (j < tokens.length && Math.abs(pos[j] - b) <= 0.5 * Math.min(tokens[j - 1].length, tokens[j].length) + 1 && pos[j - 1] < b && b < pos[j + 1]) pos[j] = b;
  }
  return tokens.map((text, i) => {
    const start = at(pos[i], 'start');
    return { start, end: Math.max(start, at(pos[i + 1], 'end')), text };
  });
}

/** Words laid out over [from, to], each taking time in proportion to its length. */
export function spreadWords(tokens: string[], from: number, to: number): CaptionWord[] {
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = from;
  return tokens.map((text, i) => {
    const d = ((to - from) * weights[i]) / total;
    const w = { start: t, end: t + d, text };
    t += d;
    return w;
  });
}
