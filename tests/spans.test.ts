import { describe, expect, it } from 'vitest';
import { audioSpans } from '../server/captions/transcribe.ts';

describe('audioSpans', () => {
  it('decodes only around the utterances, joining close ones', () => {
    // two callouts 2 s apart share a span; one 10 minutes later gets its own
    expect(audioSpans([[100, 101], [103, 104], [700, 702]])).toEqual([
      [99.7, 104.3],
      [699.7, 702.3],
    ]);
  });

  it('never starts before the recording', () => {
    expect(audioSpans([[0.1, 1]])[0][0]).toBe(0);
  });
});
