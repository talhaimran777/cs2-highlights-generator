import { useEffect, useMemo, type MutableRefObject } from 'react';
import type { CaptionLine, CaptionWord, ProjectView } from './api.ts';
import { chunkWords } from '../../server/captions/ass.ts';
import { buildSegments, parseFps, PlayerControls, recToReel, ReelStage, useReelPlayer } from './reel.tsx';

const HOLD_S = 0.15; // as in the burned-in captions: the last word stays up a moment

export interface CaptionPreviewControl {
  /** Plays one caption line (recording seconds) with a little lead-in and tail. */
  playLine: (start: number, end: number) => void;
}

/**
 * The edited reel with the captions drawn over it as they'll be burned in:
 * same grouping into on-screen chunks, style, font, size and position.
 */
export function CaptionPreview({ p, control }: { p: ProjectView; control: MutableRefObject<CaptionPreviewControl | null> }) {
  const sig = JSON.stringify(p.clips.map((c) => [c.start, c.end]));
  const segments = useMemo(() => buildSegments(p.clips), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const player = useReelPlayer(segments, parseFps(p.video.fps));

  useEffect(() => {
    control.current = {
      playLine: (start, end) => player.playRange(Math.max(0, recToReel(segments, start) - 0.5), recToReel(segments, end) + 0.5),
    };
  });

  const chunks = useMemo(() => captionChunks(p.reelCaptions), [p.reelCaptions]);
  const caps = p.settings.captions;
  const rec = player.recNow();
  const shown = chunks.find((c) => rec >= c.start && rec < c.end);

  return (
    <div className="caption-player">
      <ReelStage player={player} src={`/api/projects/${p.id}/media`}>
        {shown && (
          <div className="caption-overlay" style={{ ['--pos' as string]: `${caps.positionPct}%`, ['--size' as string]: `${caps.sizePct * 0.5625}cqw` }}>
            <div className={`caption-sample style-${caps.style}`} style={{ fontFamily: `'${caps.font}', 'Arial Black', sans-serif` }}>
              {shown.words.map((w, i) => (
                <span key={i} className={wordClass(caps.style, w, shown.words, rec)}>
                  {caps.uppercase ? w.text.toLocaleUpperCase('en') : w.text}
                </span>
              ))}
            </div>
          </div>
        )}
      </ReelStage>
      <div className="row wrap editor-controls">
        <PlayerControls player={player} />
      </div>
      {player.videoError && <div className="muted small">The browser can't play this recording (e.g. HEVC); the export still works.</div>}
      <div className="muted small">
        Your edited reel with the captions as they'll look. ▶ on a line plays just that line.
        {!caps.enabled && <strong> "Burn captions into the reel" is off, so the export won't have them.</strong>}
      </div>
    </div>
  );
}

/** The on-screen captions over time (recording seconds), grouped exactly like the export. */
function captionChunks(lines: CaptionLine[]) {
  const chunks = [...lines]
    .sort((a, b) => a.start - b.start)
    .flatMap((l) => chunkWords(l.words.filter((w) => w.text.trim())));
  return chunks.map((words, i) => {
    const next = chunks[i + 1]?.[0].start ?? Infinity;
    return { words, start: words[0].start, end: Math.min(next, words.at(-1)!.end + HOLD_S) };
  });
}

/** Word pop: only the word being said is lit. Karaoke: everything said so far. Clean: nothing. */
function wordClass(style: string, w: CaptionWord, words: CaptionWord[], rec: number) {
  if (style === 'clean') return '';
  const spoken = words.filter((x) => x.start <= rec);
  if (style === 'karaoke') return w.start <= rec ? 'active' : '';
  return w === (spoken.at(-1) ?? words[0]) ? 'active' : '';
}
