import { describe, expect, it } from 'vitest';
import { buildAss, chunkWords, escapeAss } from '../server/captions/ass.ts';
import { DEFAULT_SETTINGS, type CaptionLine, type CaptionWord } from '../server/types.ts';

const w = (start: number, text: string, len = 0.3): CaptionWord => ({ start, end: start + len, text });
const line = (words: CaptionWord[]): CaptionLine => ({
  id: 'l1', start: words[0].start, end: words.at(-1)!.end, lang: 'ur', source: '', words,
});
const video = { width: 1920, height: 1080 };

describe('caption chunks', () => {
  it('at most 4 words', () => {
    const words = 'a b c d e f'.split(' ').map((t, i) => w(i * 0.35, t));
    expect(chunkWords(words).map((c) => c.length)).toEqual([4, 2]);
  });

  it('breaks at pauses and sentence ends', () => {
    const words = [w(0, 'bhai'), w(0.35, 'peeche'), w(1.5, 'dekho!'), w(1.85, 'jaldi')];
    expect(chunkWords(words).map((c) => c.map((x) => x.text).join(' '))).toEqual(['bhai peeche', 'dekho!', 'jaldi']);
  });

  it('breaks long words before 18 characters', () => {
    const words = [w(0, 'counterterrorist'), w(0.35, 'rotate')];
    expect(chunkWords(words)).toHaveLength(2);
  });
});

describe('ASS', () => {
  const caps = DEFAULT_SETTINGS.captions;
  const lines = [line([w(10, 'bhai'), w(10.4, 'peeche'), w(10.8, 'dekho')])];

  it('word pop: one event per word, active word yellow and popping, times relative to the clip', () => {
    const ass = buildAss(lines, { start: 8, end: 20 }, video, caps, 'Montserrat Black')!;
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(events).toHaveLength(3);
    expect(events[0]).toContain('0:00:02.00,0:00:02.40');
    expect(events[1]).toContain('{\\c&H0000D4FF\\t(0,80,\\fscx115\\fscy115)\\t(80,160,\\fscx100\\fscy100)}PEECHE{\\r}');
    expect(events[0]).toContain('\\pos(960,756)'); // 70 % down a 1080p frame
    expect(ass).toContain('Style: Caption,Montserrat Black,76,');
  });

  it('clean and karaoke presets', () => {
    const clean = buildAss(lines, { start: 8, end: 20 }, video, { ...caps, style: 'clean' }, 'Anton')!;
    expect(clean.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(1);
    const kara = buildAss(lines, { start: 8, end: 20 }, video, { ...caps, style: 'karaoke', uppercase: false }, 'Anton')!;
    expect(kara).toContain('{\\kf40}bhai {\\kf40}peeche {\\kf30}dekho');
  });

  it('leaves out words outside the clip; null when nothing is said', () => {
    expect(buildAss(lines, { start: 30, end: 40 }, video, caps, 'Anton')).toBeNull();
    const partial = buildAss(lines, { start: 10.5, end: 20 }, video, caps, 'Anton')!;
    expect(partial).not.toContain('BHAI');
  });

  it('two sentences never share a caption, even when close together', () => {
    const two = [line([w(10, 'hua'), w(10.35, 'hua')]), { ...line([w(10.7, 'smurfing')]), id: 'l2' }];
    const ass = buildAss(two, { start: 8, end: 20 }, video, { ...caps, style: 'clean' }, 'Anton')!;
    const texts = ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => l.split('}').pop());
    expect(texts).toEqual(['HUA HUA', 'SMURFING']);
  });

  it('escapes override braces and backslashes in captions', () => {
    expect(escapeAss('gg {ez} \\n')).toBe('gg (ez) /n');
  });
});
