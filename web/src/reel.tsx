import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtTime, type Clip } from './api.ts';

// The edited reel played straight from the recording, without rendering:
// two <video>s take turns, so the jump over a cut (or between clips) doesn't
// stall. Used by the Edit and Captions steps.

/** A piece of the reel between two edit points (clip edges, cuts, splits). */
export interface Segment {
  clip: Clip;
  recStart: number; // recording seconds
  recEnd: number;
  reelStart: number; // seconds into the edited reel
  reelEnd: number;
}

const EDGE = 0.05; // splits this close to a clip edge are ignored

/** The clips back to back, split at the editor's split points. */
export function buildSegments(clips: Clip[], splits: number[] = []): Segment[] {
  const out: Segment[] = [];
  let reel = 0;
  for (const clip of clips) {
    const points = [clip.start, ...splits.filter((s) => s > clip.start + EDGE && s < clip.end - EDGE), clip.end];
    for (let i = 0; i < points.length - 1; i++) {
      const d = points[i + 1] - points[i];
      out.push({ clip, recStart: points[i], recEnd: points[i + 1], reelStart: reel, reelEnd: reel + d });
      reel += d;
    }
  }
  return out;
}

export const segIndexAt = (segs: Segment[], t: number) => {
  let i = 0;
  while (i < segs.length - 1 && segs[i].reelEnd <= t) i++;
  return i;
};

/** Where a recording time plays in the reel (the next piece's start if it was cut out). */
export function recToReel(segs: Segment[], rec: number) {
  for (const s of segs) if (rec < s.recEnd) return s.reelStart + Math.max(0, rec - s.recStart);
  return segs.at(-1)?.reelEnd ?? 0;
}

/** Playing on from a into b needs no seek (split inside a clip, or clips that touch). */
const continuous = (a: Segment | undefined, b: Segment | undefined) => !!a && !!b && Math.abs(b.recStart - a.recEnd) < 0.02;

export const parseFps = (fps: string) => {
  const [n, d] = fps.split('/').map(Number);
  return d ? n / d : n || 60;
};

export type ReelPlayer = ReturnType<typeof useReelPlayer>;

/** Playback of the segments: a clock in reel time, seeking, play/pause and preview volume. */
export function useReelPlayer(segments: Segment[], fps: number) {
  const vidA = useRef<HTMLVideoElement>(null);
  const vidB = useRef<HTMLVideoElement>(null);
  const vid = (i: number) => (i === 0 ? vidA.current : vidB.current);
  const active = useRef(0);
  const [activeVid, setActiveVid] = useState(0);
  const segIdx = useRef(0);
  const segsRef = useRef(segments);
  segsRef.current = segments;
  const total = segments.at(-1)?.reelEnd ?? 0;
  const timeRef = useRef(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const stopAt = useRef<number | null>(null); // reel time to pause at (playing one caption line)
  const peeking = useRef(false); // showing a frame outside the reel (dragging a piece's edge)
  const [videoError, setVideoError] = useState(false);

  // preview volume only (the export keeps the original audio); remembered per browser
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem('editor.volume'));
      return localStorage.getItem('editor.volume') !== null && v >= 0 && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  });
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    // .muted belongs to the A/B swap (only the visible video is heard), so the user's level goes on .volume
    for (const v of [vidA.current, vidB.current]) if (v) v.volume = silent ? 0 : volume;
    try {
      localStorage.setItem('editor.volume', String(volume));
    } catch {}
  }, [volume, silent]);

  const setPlay = (on: boolean) => {
    playingRef.current = on;
    setPlaying(on);
  };

  /** Parks the hidden video at the start of the next jump, so the swap is instant. */
  const prepare = (from: number) => {
    const segs = segsRef.current;
    let j = from + 1;
    while (j < segs.length && continuous(segs[j - 1], segs[j])) j++;
    const hidden = vid(1 - active.current);
    if (hidden && segs[j] && Math.abs(hidden.currentTime - segs[j].recStart) > 0.02) hidden.currentTime = segs[j].recStart;
  };

  const seekTo = (t: number) => {
    const segs = segsRef.current;
    const v = vid(active.current);
    if (!v || segs.length === 0) return;
    const end = segs.at(-1)!.reelEnd;
    t = Math.min(end, Math.max(0, t));
    const i = segIndexAt(segs, t);
    v.currentTime = segs[i].recStart + (t - segs[i].reelStart);
    segIdx.current = i;
    timeRef.current = t;
    setTime(t);
    prepare(i);
  };

  /** Moves playback on to segment i: same video if it's contiguous, otherwise swap to the parked one. */
  const advance = (i: number) => {
    const segs = segsRef.current;
    if (continuous(segs[segIdx.current], segs[i])) {
      segIdx.current = i;
      return;
    }
    const cur = vid(active.current)!;
    const next = vid(1 - active.current)!;
    if (Math.abs(next.currentTime - segs[i].recStart) > 0.02) next.currentTime = segs[i].recStart;
    next.muted = false;
    cur.muted = true;
    void next.play();
    cur.pause();
    active.current = 1 - active.current;
    setActiveVid(active.current);
    segIdx.current = i;
    prepare(i);
  };

  const play = () => {
    const v = vid(active.current);
    if (!v || segsRef.current.length === 0) return;
    if (timeRef.current >= total - 0.05) seekTo(0);
    void vid(active.current)!.play();
    setPlay(true);
  };
  const pause = () => {
    vid(active.current)?.pause();
    setPlay(false);
  };
  const togglePlay = () => {
    stopAt.current = null;
    if (playingRef.current) pause();
    else play();
  };
  /** Plays reel time [from, to] and stops. */
  const playRange = (from: number, to: number) => {
    seekTo(from);
    stopAt.current = to;
    play();
  };

  // the playback clock: follows the active video and jumps over cuts
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const segs = segsRef.current;
      const v = vid(active.current);
      const seg = segs[segIdx.current];
      if (!v || !seg || peeking.current) return;
      if (playingRef.current && stopAt.current !== null && timeRef.current >= stopAt.current) {
        stopAt.current = null;
        v.pause();
        setPlay(false);
        return;
      }
      if (playingRef.current) {
        // a frame early: the next check is one animation frame (~16 ms) away
        if (v.currentTime >= seg.recEnd - Math.max(0.5 / fps, 0.017)) {
          if (segIdx.current + 1 >= segs.length) {
            v.pause();
            setPlay(false);
            timeRef.current = seg.reelEnd;
            setTime(seg.reelEnd);
            return;
          }
          advance(segIdx.current + 1);
          return;
        }
        if (v.currentTime < seg.recStart - 0.25) return; // still seeking
      }
      const t = seg.reelStart + Math.min(seg.recEnd, Math.max(seg.recStart, v.currentTime)) - seg.recStart;
      if (Math.abs(t - timeRef.current) > 1e-4 && (playingRef.current || !v.seeking)) {
        timeRef.current = t;
        setTime(t);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fps]); // eslint-disable-line react-hooks/exhaustive-deps

  // the reel changed: stay at the same reel time (or wherever timeRef was moved to)
  useEffect(() => seekTo(timeRef.current), [segments]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The recording time on screen right now. */
  const recNow = () => {
    const s = segsRef.current[segIdx.current];
    return s ? s.recStart + (timeRef.current - s.reelStart) : 0;
  };

  /** Shows the recording at `rec` (even footage that isn't in the reel); null goes back to the reel. */
  const peek = (rec: number | null) => {
    if (rec === null) {
      if (!peeking.current) return;
      peeking.current = false;
      seekTo(timeRef.current);
      return;
    }
    if (playingRef.current) pause();
    peeking.current = true;
    const v = vid(active.current);
    if (v) v.currentTime = rec;
  };

  return {
    vidA, vidB, active, activeVid, segIdx, total, time, timeRef, playing, videoError, setVideoError,
    volume, setVolume, silent, setSilent, prepare, seekTo, play, pause, togglePlay, playRange, recNow, peek,
  };
}

/** The two videos stacked, the visible one on top; children are drawn over the picture. */
export function ReelStage({ player, src, children }: { player: ReelPlayer; src: string; children?: ReactNode }) {
  return (
    <div className="editor-stage">
      {[player.vidA, player.vidB].map((ref, i) => (
        <video
          key={i}
          ref={ref}
          className={player.activeVid === i ? 'on' : ''}
          src={src}
          preload="auto"
          muted={i !== 0}
          playsInline
          onLoadedMetadata={() => (i === player.active.current ? player.seekTo(player.timeRef.current) : player.prepare(player.segIdx.current))}
          onError={() => player.setVideoError(true)}
          onClick={player.togglePlay}
        />
      ))}
      {children}
    </div>
  );
}

/** Play/pause, the time, and the preview volume. */
export function PlayerControls({ player }: { player: ReelPlayer }) {
  const { volume, silent } = player;
  const level = silent ? 0 : volume;
  return (
    <>
      <button className="btn btn-sm" onClick={player.togglePlay} title="Space">
        {player.playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <span className="mono small">
        {fmtTime(player.time)} / {fmtTime(player.total)}
      </span>
      <span className="volume">
        <button className="btn btn-xs" onClick={() => player.setSilent((s) => !s)} title={silent ? 'Unmute (M)' : 'Mute (M)'}>
          {level === 0 ? '🔇' : level < 0.5 ? '🔉' : '🔊'}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={level}
          title={`Preview volume ${Math.round(level * 100)}%`}
          onChange={(e) => {
            player.setVolume(Number(e.target.value));
            player.setSilent(false);
          }}
          onKeyDown={(e) => e.key === ' ' && e.preventDefault()}
        />
        <span className="mono small muted">{Math.round(level * 100)}%</span>
      </span>
    </>
  );
}
