import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, type Clip, type Edits, type Moment, type ProjectView } from './api.ts';
import { applyEdits } from '../../server/edit/edits.ts';
import { buildSegments, parseFps, PlayerControls, ReelStage, segIndexAt, useReelPlayer } from './reel.tsx';

type Update = (fn: () => Promise<ProjectView>) => Promise<void>;

const EDGE = 0.05; // splits and cuts this close to an edge are ignored
const MAX_PPS = 200; // most zoomed in, pixels per second
const PEAKS_PER_SEC = 100;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

/** Focus is in a text field (a focused slider, like the volume, still lets the shortcuts work). */
const isTyping = (e: KeyboardEvent) =>
  e.target instanceof HTMLInputElement
    ? !['range', 'checkbox', 'button'].includes(e.target.type)
    : e.target instanceof HTMLElement && /^(TEXTAREA|SELECT)$/.test(e.target.tagName);

/**
 * Timeline editor: the reel plays straight from the recording (two <video>s
 * take turns so the jump over a cut doesn't stall), and Q / W / S / Delete
 * cut it like Premiere or CapCut. Nothing is rendered until Export.
 */
export function Editor({ p, update, onNext, nextLabel }: { p: ProjectView; update: Update; onNext: () => void; nextLabel: string }) {
  // --- edits + undo -------------------------------------------------------
  const [edits, setEdits] = useState<Edits>(p.edits);
  const [history, setHistory] = useState<{ past: Edits[]; future: Edits[] }>({ past: [], future: [] });
  const pendingSave = useRef<Edits | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    const e = pendingSave.current;
    pendingSave.current = null;
    if (e) void update(() => api.patch(p.id, { edits: e }));
  }, [p.id, update]);
  const save = (e: Edits) => {
    pendingSave.current = e;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 500);
  };
  useEffect(() => flush, [flush]); // save what's pending when leaving the step

  const commit = (next: Edits, newTime = player.timeRef.current) => {
    setHistory((h) => ({ past: [...h.past, edits].slice(-200), future: [] }));
    player.timeRef.current = newTime;
    setEdits(next);
    save(next);
  };
  const undo = () => {
    const prev = history.past.at(-1);
    if (!prev) return;
    setHistory({ past: history.past.slice(0, -1), future: [edits, ...history.future] });
    setEdits(prev);
    save(prev);
  };
  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    setHistory({ past: [...history.past, edits], future: history.future.slice(1) });
    setEdits(next);
    save(next);
  };

  // --- reel model ---------------------------------------------------------
  // keyed on the content, so a server refresh with the same clips doesn't re-seek playback
  const sig = JSON.stringify([p.baseClips.map((c) => [c.start, c.end, c.round]), edits]);
  const segments = useMemo(() => buildSegments(applyEdits(p.baseClips, edits), edits.splits), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseTotal = useMemo(() => p.baseClips.reduce((s, c) => s + c.end - c.start, 0), [p.baseClips]);
  const fps = parseFps(p.video.fps);
  const kindOf = useMemo(() => new Map<string, Moment['kind']>(p.moments.map((m) => [m.id, m.kind])), [p.moments]);

  // --- player -------------------------------------------------------------
  const player = useReelPlayer(segments, fps);
  const { time, playing, total, seekTo, togglePlay } = player;

  // --- edit operations (all in recording time) ----------------------------
  const [selected, setSelected] = useState<number | null>(null); // recStart of the selected segment
  const selIdx = selected === null ? -1 : segments.findIndex((s) => Math.abs(s.recStart - selected) < 1e-3);
  const at = () => {
    const segs = segments;
    const i = segIndexAt(segs, player.timeRef.current);
    const s = segs[i];
    return s ? { i, s, rec: s.recStart + (player.timeRef.current - s.reelStart) } : null;
  };

  const split = () => {
    const x = at();
    if (!x || x.rec - x.s.recStart < EDGE || x.s.recEnd - x.rec < EDGE) return;
    commit({ ...edits, splits: [...edits.splits, x.rec].sort((a, b) => a - b) });
  };
  /** Q: remove from the segment's start to the playhead; the playhead lands on the new join. */
  const trimLeft = () => {
    const x = at();
    if (!x || x.rec - x.s.recStart < EDGE) return;
    commit({ ...edits, cuts: [...edits.cuts, [x.s.recStart, x.rec]] }, x.s.reelStart);
  };
  /** W: remove from the playhead to the segment's end. */
  const trimRight = () => {
    const x = at();
    if (!x || x.s.recEnd - x.rec < EDGE) return;
    commit({ ...edits, cuts: [...edits.cuts, [x.rec, x.s.recEnd]] });
  };
  const deleteSelected = () => {
    const s = segments[selIdx];
    if (!s) return;
    setSelected(null);
    commit({ ...edits, cuts: [...edits.cuts, [s.recStart, s.recEnd]] }, s.reelStart);
  };
  const reset = () => commit({ cuts: [], splits: [] });

  /** Edit points on the reel: segment starts plus the end. */
  const jumpEdit = (dir: 1 | -1) => {
    const points = [...segments.map((s) => s.reelStart), total];
    const t = player.timeRef.current;
    const target = dir > 0 ? points.find((x) => x > t + 1e-3) : [...points].reverse().find((x) => x < t - 1e-3);
    if (target !== undefined) seekTo(target);
  };

  // --- timeline: zoom, scroll, waveform -----------------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const fitPps = total > 0 ? Math.max(0.5, (viewW - 24) / total) : 10;
  const [pps, setPps] = useState<number | null>(null); // null = fit to width
  const zoom = Math.min(MAX_PPS, Math.max(fitPps, pps ?? fitPps));
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pendingScroll = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scroller.current) {
      scroller.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [zoom]);

  // wheel: scroll sideways; Ctrl+wheel: zoom around the cursor (native listener so it can preventDefault)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - el.getBoundingClientRect().left;
        const t = (el.scrollLeft + x) / zoomRef.current;
        const next = Math.min(MAX_PPS, zoomRef.current * (e.deltaY < 0 ? 1.25 : 0.8));
        pendingScroll.current = Math.max(0, t * next - x);
        zoomRef.current = next; // fast wheels fire again before the re-render
        setPps(next);
      } else {
        el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = time * zoom;
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.15);
  }, [time, zoom, playing]);

  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let stop = false;
    let started = false;
    const load = async () => {
      while (!stop) {
        const data = await api.peaks(p.id).catch(() => null);
        if (data) return !stop && setPeaks(data);
        if (!started) {
          started = true;
          await api.startPeaks(p.id).catch(() => {}); // older projects: compute it now
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void load();
    return () => {
      stop = true;
    };
  }, [p.id]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const TRACK_H = 84;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = devicePixelRatio || 1;
    c.width = Math.round(viewW * dpr);
    c.height = Math.round(TRACK_H * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, viewW, TRACK_H);
    if (!peaks || segments.length === 0) return;
    g.fillStyle = 'rgba(232, 235, 242, 0.55)';
    const mid = TRACK_H / 2;
    let i = 0;
    for (let x = 0; x < viewW; x++) {
      const t0 = (scrollLeft + x) / zoom;
      if (t0 >= total) break;
      while (i < segments.length - 1 && segments[i].reelEnd <= t0) i++;
      const s = segments[i];
      const r0 = s.recStart + (t0 - s.reelStart);
      const r1 = Math.min(s.recEnd, r0 + 1 / zoom);
      let max = 0;
      for (let k = Math.floor(r0 * PEAKS_PER_SEC), end = Math.max(k + 1, Math.ceil(r1 * PEAKS_PER_SEC)); k < end && k < peaks.length; k++) {
        if (peaks[k] > max) max = peaks[k];
      }
      const h = Math.max(1, Math.sqrt(max / 255) * (TRACK_H - 18));
      g.fillRect(x, mid - h / 2 + 6, 1, h);
    }
  }, [peaks, segments, scrollLeft, zoom, viewW, total]);

  // click / drag on the ruler or track scrubs; clicking a segment selects it
  const inner = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const timeAt = (clientX: number) => (clientX - inner.current!.getBoundingClientRect().left) / zoom;
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    const t = timeAt(e.clientX);
    seekTo(t);
    const onTrack = (e.target as HTMLElement).closest('.tl-track');
    setSelected(onTrack && t < total ? segments[segIndexAt(segments, t)].recStart : null);
  };
  const onPointerMove = (e: React.PointerEvent) => scrubbing.current && seekTo(timeAt(e.clientX));
  const onPointerUp = () => (scrubbing.current = false);

  const tickStep = TICK_STEPS.find((s) => s * zoom >= 80) ?? 3600;
  const ticks: number[] = [];
  for (let t = Math.floor(scrollLeft / zoom / tickStep) * tickStep; t <= Math.min(total, (scrollLeft + viewW) / zoom); t += tickStep) ticks.push(t);

  // --- keyboard -----------------------------------------------------------
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (isTyping(e)) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const run = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (ctrl && k === 'z') return run(e.shiftKey ? redo : undo);
    if (ctrl && k === 'y') return run(redo);
    if (ctrl && k === 'k') return run(split);
    if (ctrl || e.altKey) return;
    if (k === ' ') return run(togglePlay);
    if (k === 's') return run(split);
    if (k === 'm') return run(() => player.setSilent((s) => !s));
    if (k === 'q') return run(trimLeft);
    if (k === 'w') return run(trimRight);
    if (k === 'delete' || k === 'backspace') return run(deleteSelected);
    if (k === 'arrowleft') return run(() => seekTo(player.timeRef.current - (e.shiftKey ? 1 : 1 / fps)));
    if (k === 'arrowright') return run(() => seekTo(player.timeRef.current + (e.shiftKey ? 1 : 1 / fps)));
    if (k === 'arrowup') return run(() => jumpEdit(-1));
    if (k === 'arrowdown') return run(() => jumpEdit(1));
    if (k === 'home') return run(() => seekTo(0));
    if (k === 'end') return run(() => seekTo(total));
    if (k === '\\') return run(() => setPps(null));
    if (k === '=' || k === '+') return run(() => setPps(zoom * 1.5));
    if (k === '-') return run(() => setPps(zoom / 1.5));
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);

  if (p.baseClips.length === 0) {
    return (
      <section className="card">
        <h2>Nothing to edit yet</h2>
        <p className="muted">Pick some moments in Highlights first.</p>
      </section>
    );
  }

  const cur = segments[segIndexAt(segments, time)];
  const label = (c: Clip) => (c.round ? `R${c.round} · ${c.label}` : c.label);

  return (
    <section className="card editor">
      <div className="row spread wrap">
        <div>
          <h2>Edit</h2>
          <div className="muted small">
            Reel <strong className="mono">{fmtTime(total)}</strong>
            {Math.abs(baseTotal - total) > 0.05 && <> (was {fmtTime(baseTotal)}, −{fmtTime(baseTotal - total)})</>} · {segments.length} pieces ·{' '}
            {edits.cuts.length} cuts
          </div>
        </div>
        <div className="row wrap">
          <button className="btn btn-sm" disabled={history.past.length === 0} onClick={undo} title="Ctrl+Z">
            ↶ Undo
          </button>
          <button className="btn btn-sm" disabled={history.future.length === 0} onClick={redo} title="Ctrl+Shift+Z">
            ↷ Redo
          </button>
          <button className="btn btn-sm" disabled={edits.cuts.length + edits.splits.length === 0} onClick={reset}>
            Reset edits
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              flush();
              onNext();
            }}
          >
            {nextLabel} →
          </button>
        </div>
      </div>

      <ReelStage player={player} src={`/api/projects/${p.id}/media`}>
        {cur && <div className="editor-badge">{label(cur.clip)}</div>}
      </ReelStage>
      {player.videoError && (
        <div className="muted small">The browser can't play this recording (e.g. HEVC). Cuts still work and the export is unaffected.</div>
      )}

      <div className="row wrap editor-controls">
        <PlayerControls player={player} />
        <span className="grow" />
        <button className="btn btn-sm" onClick={split} title="S or Ctrl+K">
          Split
        </button>
        <button className="btn btn-sm" onClick={trimLeft} title="Q">
          Cut left
        </button>
        <button className="btn btn-sm" onClick={trimRight} title="W">
          Cut right
        </button>
        <button className="btn btn-sm" disabled={selIdx < 0} onClick={deleteSelected} title="Delete">
          Delete piece
        </button>
        <button className="btn btn-sm" onClick={() => setPps(zoom / 1.5)} title="−">
          −
        </button>
        <button className="btn btn-sm" onClick={() => setPps(null)} title="\">
          Fit
        </button>
        <button className="btn btn-sm" onClick={() => setPps(zoom * 1.5)} title="+">
          +
        </button>
      </div>

      <div className="timeline" ref={scroller} onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}>
        <div
          ref={inner}
          className="tl-inner"
          style={{ width: Math.max(viewW, total * zoom + 24) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="tl-ruler">
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: t * zoom }}>
                {fmtTime(t).replace(/\.0$/, '')}
              </span>
            ))}
          </div>
          <div className="tl-track" style={{ height: TRACK_H }}>
            {segments.map((s, i) => {
              const kind = s.clip.momentIds.map((id) => kindOf.get(id)).find(Boolean) ?? 'intro';
              return (
                <div
                  key={`${s.recStart}`}
                  className={`tl-seg kind-${kind} ${i === selIdx ? 'selected' : ''}`}
                  style={{ left: s.reelStart * zoom, width: Math.max(1, (s.reelEnd - s.reelStart) * zoom) }}
                  title={`${label(s.clip)} · ${fmtTime(s.reelEnd - s.reelStart)}`}
                >
                  <span>{label(s.clip)}</span>
                </div>
              );
            })}
            <canvas ref={canvas} className="tl-wave" style={{ left: scrollLeft, width: viewW, height: TRACK_H }} />
          </div>
          <div className="tl-playhead" style={{ left: time * zoom }} />
        </div>
      </div>

      <div className="muted small shortcuts">
        <kbd>Space</kbd> play · <kbd>M</kbd> mute ·<kbd>Q</kbd> cut left of playhead · <kbd>W</kbd> cut right · <kbd>S</kbd> split · <kbd>Del</kbd> delete selected piece
        · <kbd>Ctrl+Z</kbd> undo · <kbd>←</kbd>/<kbd>→</kbd> frame (Shift: 1 s) · <kbd>↑</kbd>/<kbd>↓</kbd> edit points · <kbd>Ctrl</kbd>+wheel zoom ·{' '}
        <kbd>\</kbd> fit
      </div>
    </section>
  );
}
