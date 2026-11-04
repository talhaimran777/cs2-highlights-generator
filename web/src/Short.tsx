import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, locator, waitJob, type Edits, type FeedKill, type Job, type ProjectView, type Rect, type Settings, type ShortLayout, type ShortView } from './api.ts';
import { TimelineEditor } from './Editor.tsx';
import { ReelStage, type ReelPlayer } from './reel.tsx';
import { Progress } from './ui.tsx';
import { captionChunks, wordClass } from './CaptionPreview.tsx';
import { captionChars } from '../../server/captions/ass.ts';
import { bandAspects, clampRect, fitLayout, MAX_SPLIT, MIN_SPLIT, overlayRect, resizeRect, type OverlayAlign } from '../../server/shorts/layout.ts';
import { DEFAULT_SETTINGS } from '../../server/types.ts';
import { FilePicker } from './FilePicker.tsx';
import {
  BORDER as FEED_BORDER, FEED_BG, feedImageRect, fitFeedScale, FEED_MARGIN, slideFrom, type FeedAlign, FEED_MUTED, FEED_RED, FEED_ROW, feedTextSize, feedTopPct, killMarks, MAX_FEED_SCALE, MIN_FEED_SCALE, PAD as FEED_PAD, SIDE_COLOR, weaponName,
} from '../../server/shorts/killfeed.ts';

/** canvas width of the 9:16 preview (half of a 1080-wide short) */
const PREVIEW_W = 540;
const SAVE_DELAY_MS = 400;

type Video = { width: number; height: number };
const FEED_SCALE_STEP = 0.1;
/** how long before the final kill a looping short may open */
const MIN_LOOP_LEAD = 0.3;
const MAX_LOOP_LEAD = 5;
const DEFAULT_OVERLAY = DEFAULT_SETTINGS.shortOverlay;
const OVERLAY_ALIGNS: [OverlayAlign, string, string][] = [
  ['left', 'Left', 'Against the left edge (with a small margin)'],
  ['center', 'Center', 'Exactly in the middle, and kept there when resized'],
  ['right', 'Right', 'Against the right edge (with a small margin)'],
];
/** a drag that moves less than this sideways (screen px) keeps the overlay's alignment */
const SIDEWAYS_PX = 3;
const FEED_ALIGNS: [FeedAlign, string][] = [
  ['left', 'Left'],
  ['center', 'Center'],
  ['right', 'Right'],
];
/** one step bigger or smaller, kept on the step grid and in range */
const stepScale = (s: number, dir: 1 | -1) =>
  Math.min(MAX_FEED_SCALE, Math.max(MIN_FEED_SCALE, Math.round((s + dir * FEED_SCALE_STEP) * 10) / 10));
/** per kill (time order): the game's entry, or null to draw it; null overall while loading */
type FeedImages = ({ url: string; w: number; h: number } | null)[] | null;

/** The round's "Create short" button: opens its short page (made on first click). */
export function CreateShortButton({ p, round }: { p: ProjectView; round: number }) {
  const [busy, setBusy] = useState(false);
  const made = p.shorts?.some((s) => s.round === round);
  const open = async () => {
    setBusy(true);
    try {
      const v = await api.createShort(p.id, round);
      location.hash = `${p.id}/short/${v.short.id}`;
    } catch (e: any) {
      alert(e.message);
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-xs btn-short" disabled={busy} onClick={open} title="A vertical 9:16 short of this round: the fights cut together, facecam on top">
      {made ? '📱 Open short' : '📱 Create short'}
    </button>
  );
}

/**
 * A 9:16 short of one round: the facecam and gameplay framed on the recording,
 * the vertical result previewed live, the cut edited on the timeline below.
 */
export function ShortScreen({ id, sid }: { id: string; sid: string }) {
  const [p, setP] = useState<ProjectView | null>(null);
  const [v, setV] = useState<ShortView | null>(null);
  const [error, setError] = useState('');
  const [layout, setLayoutState] = useState<ShortLayout | null>(null);
  const [caps, setCapsState] = useState<Settings['shortCaptions'] | null>(null);
  const [feed, setFeedState] = useState<Settings['shortKillfeed'] | null>(null);
  const [overlay, setOverlayState] = useState<Settings['shortOverlay'] | null>(null);
  const [loop, setLoopState] = useState<Settings['shortLoop'] | null>(null);
  // the game's own kill-feed entries, cut out of the recording (takes a moment the first time)
  const [feedImages, setFeedImages] = useState<FeedImages>(null);
  useEffect(() => {
    api.shortFeed(id, sid).then(setFeedImages).catch(() => setFeedImages([]));
  }, [id, sid]);
  const [job, setJob] = useState<Job | null>(null);
  // the last save in flight, so an export waits for it
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    Promise.all([api.get(id), api.short(id, sid)])
      .then(([proj, short]) => {
        setP(proj);
        setV(short);
        setLayoutState(short.short.layout);
        setCapsState(proj.settings.shortCaptions);
        setFeedState(proj.settings.shortKillfeed);
        setOverlayState(proj.settings.shortOverlay);
        setLoopState(proj.settings.shortLoop);
        setJob(short.renderJob);
        // an export still running from before: follow it
        if (short.renderJob?.status === 'running') void follow(short.renderJob.id);
      })
      .catch((e) => setError(e.message));
  }, [id, sid]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useCallback(
    (body: Parameters<typeof api.patchShort>[2]) => {
      saving.current = api
        .patchShort(id, sid, body)
        .then(setV)
        .catch((e) => setError(e.message));
    },
    [id, sid],
  );
  const onSave = useCallback((edits: Edits) => patch({ edits }), [patch]);

  // layout and caption changes: shown at once, saved shortly after (and when leaving)
  const pending = useRef<Parameters<typeof api.patchShort>[2]>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flushPending = useCallback(() => {
    clearTimeout(timer.current);
    if (Object.keys(pending.current).length) patch(pending.current);
    pending.current = {};
  }, [patch]);
  useEffect(() => flushPending, [flushPending]);
  const later = (body: Parameters<typeof api.patchShort>[2]) => {
    pending.current = { ...pending.current, ...body };
    clearTimeout(timer.current);
    timer.current = setTimeout(flushPending, SAVE_DELAY_MS);
  };
  const setLayout = (l: ShortLayout) => {
    setLayoutState(l);
    later({ layout: l });
  };
  const setCaps = (c: Settings['shortCaptions']) => {
    setCapsState(c);
    later({ captions: c });
  };
  const setFeed = (f: Settings['shortKillfeed']) => {
    setFeedState(f);
    later({ killfeed: f });
  };
  const setOverlay = (o: Settings['shortOverlay']) => {
    setOverlayState(o);
    later({ overlay: o });
  };
  // saved at once: the short's length depends on it
  const setLoop = (l: Settings['shortLoop']) => {
    setLoopState(l);
    patch({ loop: l });
  };

  const follow = async (jobId: string) => {
    const done = await waitJob(jobId, setJob);
    if (done.status === 'error') setError(done.error ?? 'Export failed');
    setV(await api.short(id, sid));
  };
  const exportShort = async (flushEdits: () => void) => {
    flushEdits();
    flushPending();
    await saving.current;
    try {
      const j = await api.renderShort(id, sid);
      setJob(j);
      await follow(j.id);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const locate = useMemo(() => (p ? locator(p) : null), [p]);
  if (!p || !v || !layout || !caps || !feed || !overlay || !loop || !locate) {
    return <main className="home">{error ? <div className="error">{error}</div> : <div className="muted">Loading…</div>}</main>;
  }

  const clips = p.mode === 'clips';
  const name = clips ? `Clip ${v.short.round}` : `Round ${v.short.round}`;
  const running = job?.status === 'running';

  return (
    <main className="project">
      <div className="project-head">
        <div>
          <a className="muted small" href={`#${id}`}>
            ← {p.name}
          </a>
          <h1>{name} · Short</h1>
          <div className="muted">
            9:16 · {v.frame.width}×{v.frame.height} · {fmtTime(v.duration)} · {v.clips.length} pieces · same codec, bitrate and frame rate as the recording
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <TimelineEditor
        id={id}
        baseClips={v.baseClips}
        initialEdits={v.short.edits}
        onSave={onSave}
        video={p.video}
        moments={p.moments}
        locate={locate}
        title="Short"
        what="Short"
        empty="No kills were found in this round."
        actions={(flush) => (
          <button className="btn btn-primary" disabled={running} onClick={() => exportShort(flush)}>
            {running ? 'Exporting…' : 'Export short'}
          </button>
        )}
        stage={(player, badge) => (
          <div className="short-stage">
            <div className="short-source">
              <ReelStage player={player}>
                {badge}
                <CropBox label="Camera" kind="camera" rect={layout.camera} aspect={bandAspects(p.video, layout.split).camera} video={p.video} onChange={(camera) => setLayout({ ...layout, camera })} />
                <CropBox label="Gameplay" kind="gameplay" rect={layout.gameplay} aspect={bandAspects(p.video, layout.split).gameplay} video={p.video} onChange={(gameplay) => setLayout({ ...layout, gameplay })} />
              </ReelStage>
              <div className="muted small">
                Drag the boxes over your facecam and the gameplay; drag a box's corner to resize it. Each box keeps its band's shape, so nothing stretches.
              </div>
            </div>
            <ShortPreview
              player={player}
              p={p}
              frame={v.frame}
              layout={layout}
              setLayout={setLayout}
              caps={caps}
              setCaps={setCaps}
              kills={v.kills}
              feedImages={feedImages}
              feed={feed}
              setFeed={setFeed}
              overlay={overlay}
              setOverlay={setOverlay}
            />
          </div>
        )}
      />

      <section className="card">
        <h2>Export</h2>
        <div className="muted small mono">{v.short.outputPath ?? v.defaultOutputPath}</div>
        <label className="row small">
          <input type="checkbox" checked={loop.enabled} disabled={running} onChange={(e) => setLoop({ ...loop, enabled: e.target.checked })} />
          <span>Seamless loop</span>
          <span className="muted">
            opens on the final kill, plays the round from the start and ends right before that kill, so a replay runs straight on
            {loop.enabled && v.loopCut === null && ' (no kill left in this short to loop on)'}
          </span>
        </label>
        {loop.enabled && (
          <label className="row small">
            <span className="muted">Open</span>
            <input
              className="input"
              style={{ width: 64 }}
              type="number"
              min={MIN_LOOP_LEAD}
              max={MAX_LOOP_LEAD}
              step={0.1}
              value={loop.lead}
              disabled={running}
              onChange={(e) => setLoop({ ...loop, lead: Math.min(MAX_LOOP_LEAD, Math.max(MIN_LOOP_LEAD, Number(e.target.value) || 1)) })}
            />
            <span className="muted">s before the final kill{v.loopCut !== null && ` (cut at ${fmtTime(v.loopCut)} in the recording)`}</span>
          </label>
        )}
        {job && running && <Progress value={job.progress} />}
        {job?.status === 'cancelled' && <div className="muted small">Export cancelled.</div>}
        {v.short.outputPath && !running && (
          // plays on repeat, as on a phone, so the loop point can be checked
          <video className="short-output" controls loop src={`/api/projects/${id}/shorts/${sid}/output?t=${job?.id ?? ''}`} />
        )}
      </section>
    </main>
  );
}

/** A framed region on the recording: drag to move, drag the corner to resize (at the band's aspect). */
function CropBox({ label, kind, rect, aspect, video, onChange }: { label: string; kind: string; rect: Rect; aspect: number; video: Video; onChange: (r: Rect) => void }) {
  const drag = useRef<{ resize: boolean; x0: number; y0: number; r0: Rect; w: number; h: number } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const stage = e.currentTarget.parentElement!.getBoundingClientRect();
    const resize = (e.target as HTMLElement).classList.contains('crop-handle');
    drag.current = { resize, x0: e.clientX, y0: e.clientY, r0: rect, w: stage.width, h: stage.height };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) / d.w;
    const dy = (e.clientY - d.y0) / d.h;
    onChange(d.resize ? resizeRect(d.r0, d.r0.w + dx, aspect, video) : clampRect({ ...d.r0, x: d.r0.x + dx, y: d.r0.y + dy }));
  };
  const onUp = () => (drag.current = null);
  return (
    <div
      className={`crop-box ${kind}`}
      style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="crop-label">{label}</span>
      <i className="crop-handle" />
    </div>
  );
}

/**
 * The short as it will be exported: each frame of the playing video drawn
 * twice, camera rect into the top band and gameplay rect into the bottom one
 * (the same crop and scale as the ffmpeg graph), with the captions on top.
 * The line between the bands drags to resize them.
 */
function ShortPreview({
  player,
  p,
  frame,
  layout,
  setLayout,
  caps,
  setCaps,
  kills,
  feedImages,
  feed,
  setFeed,
  overlay,
  setOverlay,
}: {
  player: ReelPlayer;
  p: ProjectView;
  frame: Video;
  layout: ShortLayout;
  setLayout: (l: ShortLayout) => void;
  caps: Settings['shortCaptions'];
  setCaps: (c: Settings['shortCaptions']) => void;
  kills: FeedKill[];
  feedImages: FeedImages;
  feed: Settings['shortKillfeed'];
  setFeed: (f: Settings['shortKillfeed']) => void;
  overlay: Settings['shortOverlay'];
  setOverlay: (o: Settings['shortOverlay']) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ player, layout });
  live.current = { player, layout };
  const H = Math.round((PREVIEW_W * frame.height) / frame.width);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      const { player: pl, layout: l } = live.current;
      const vid = (pl.active.current === 0 ? pl.vidA : pl.vidB).current;
      if (!c || !vid || vid.readyState < 2 || !vid.videoWidth) return;
      const g = c.getContext('2d')!;
      const vw = vid.videoWidth;
      const vh = vid.videoHeight;
      const camH = Math.round(H * l.split);
      const band = (r: Rect, y: number, h: number) => g.drawImage(vid, r.x * vw, r.y * vh, r.w * vw, r.h * vh, 0, y, PREVIEW_W, h);
      band(l.camera, 0, camH);
      band(l.gameplay, camH, H - camH);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [H]);

  // the line between the bands: dragged from where it started, so the rects reshape from their first framing
  const split = useRef<{ base: ShortLayout; top: number; h: number } | null>(null);
  const onSplitDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    split.current = { base: layout, top: box.top, h: box.height };
  };
  const onSplitMove = (e: React.PointerEvent) => {
    const s = split.current;
    if (!s) return;
    const at = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (e.clientY - s.top) / s.h));
    setLayout(fitLayout({ ...s.base, split: at }, p.video));
  };
  const onSplitUp = () => (split.current = null);

  // captions as they'll be burned in, laid out for the vertical frame
  const style = { ...p.settings.captions, ...caps };
  const lines = useMemo(() => (p.transcript ?? []).filter((l) => !l.removed), [p.transcript]);
  const maxChars = captionChars(style, frame);
  // as the export: smaller than asked when the widest entry wouldn't fit
  const shownScale = fitFeedScale(feedImages ?? [], frame, feed.scale);
  const chunks = useMemo(() => captionChunks(lines, style.wordsPerCaption, maxChars, style.pauseS), [lines, style.wordsPerCaption, maxChars, style.pauseS]);
  const rec = player.recNow();
  const shown = style.enabled ? chunks.find((c) => rec >= c.start && rec < c.end) : undefined;

  return (
    <div className="short-side">
      <div className="short-preview" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        <canvas ref={canvas} width={PREVIEW_W} height={H} onClick={player.togglePlay} />
        <div
          className="short-split"
          style={{ top: `${layout.split * 100}%` }}
          title="Drag to change how tall the camera is"
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onPointerCancel={onSplitUp}
        />
        {feed.enabled && (
          <KillFeed
            kills={kills}
            images={feedImages}
            rec={rec}
            frame={frame}
            topPct={feedTopPct(feed.positionPct, layout.split)}
            scale={shownScale}
            align={feed.align}
          />
        )}
        {overlay.enabled && overlay.path && <OverlayPicture overlay={overlay} setOverlay={setOverlay} frame={frame} />}
        {shown && (
          <div className="caption-overlay" style={{ ['--pos' as string]: `${style.positionPct}%`, ['--size' as string]: `${(style.sizePct * frame.height) / frame.width}cqw` }}>
            <div className={`caption-sample style-${style.style}`} style={{ fontFamily: `'${style.font}', 'Arial Black', sans-serif` }}>
              {shown.words.map((w, i) => (
                <span key={i} className={wordClass(style.style, w, shown.words, rec)}>
                  {style.uppercase ? w.text.toLocaleUpperCase('en') : w.text}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="short-caption-settings small">
        <div className="short-overlay-settings">
          <label className="row">
            <input type="checkbox" checked={overlay.enabled} onChange={(e) => setOverlay({ ...overlay, enabled: e.target.checked })} />
            <span>Overlay</span>
            <span className="muted">{overlay.path ? 'drag it in the preview; drag its corner to resize' : 'a picture shown on top (PNG / WebP with transparency)'}</span>
          </label>
          {overlay.enabled && (
            <div className="row wrap">
              <FilePicker kind="image" value={overlay.path} onChange={(path) => setOverlay({ ...overlay, path })} />
              {overlay.path && (
                <>
                  <button
                    className="btn btn-xs"
                    onClick={() => setOverlay({ ...overlay, x: DEFAULT_OVERLAY.x, y: DEFAULT_OVERLAY.y, w: DEFAULT_OVERLAY.w, align: DEFAULT_OVERLAY.align })}
                    title="Back to the bottom, most of the width, centred"
                  >
                    Reset place
                  </button>
                  <button className="btn btn-xs" onClick={() => setOverlay({ ...overlay, path: '' })}>
                    Remove
                  </button>
                </>
              )}
            </div>
          )}
          {overlay.enabled && overlay.path && (
            <div className="row">
              <span className="muted">Align</span>
              <span className="segmented">
                {OVERLAY_ALIGNS.map(([a, label, hint]) => (
                  <button
                    key={a}
                    className={`btn btn-xs ${overlay.align === a ? 'on' : ''}`}
                    aria-pressed={overlay.align === a}
                    title={hint}
                    onClick={() => setOverlay({ ...overlay, align: a })}
                  >
                    {label}
                  </button>
                ))}
              </span>
              {overlay.align === 'free' && <span className="muted">placed by hand</span>}
            </div>
          )}
        </div>
        <label className="row">
          <input type="checkbox" checked={feed.enabled} onChange={(e) => setFeed({ ...feed, enabled: e.target.checked })} />
          <span>Kill feed</span>
          <span className="muted">({kills.length} kills)</span>
        </label>
        {feed.enabled && (
          <label className="row">
            <span className="muted">Feed at</span>
            <input
              className="input"
              type="number"
              min={0}
              max={90}
              step={1}
              placeholder={String(Math.round(feedTopPct(null, layout.split)))}
              value={feed.positionPct ?? ''}
              onChange={(e) => setFeed({ ...feed, positionPct: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <span className="muted">% from top{feed.positionPct === null ? ' (under the camera)' : ''}</span>
          </label>
        )}
        {feed.enabled && (
          <div className="row">
            <span className="muted">Align</span>
            <span className="segmented">
              {FEED_ALIGNS.map(([a, label]) => (
                <button key={a} className={`btn btn-xs ${feed.align === a ? 'on' : ''}`} aria-pressed={feed.align === a} onClick={() => setFeed({ ...feed, align: a })}>
                  {label}
                </button>
              ))}
            </span>
          </div>
        )}
        {feed.enabled && (
          <label className="row">
            <span className="muted">Feed size</span>
            <button className="btn btn-xs" disabled={feed.scale <= MIN_FEED_SCALE} onClick={() => setFeed({ ...feed, scale: stepScale(feed.scale, -1) })} title="Smaller">
              −
            </button>
            <input
              type="range"
              min={MIN_FEED_SCALE}
              max={MAX_FEED_SCALE}
              step={FEED_SCALE_STEP}
              value={feed.scale}
              onChange={(e) => setFeed({ ...feed, scale: Number(e.target.value) })}
              onDoubleClick={() => setFeed({ ...feed, scale: 1 })}
              title="Double-click for the default size"
            />
            <button className="btn btn-xs" disabled={feed.scale >= MAX_FEED_SCALE} onClick={() => setFeed({ ...feed, scale: stepScale(feed.scale, 1) })} title="Bigger">
              +
            </button>
            <span className="mono">{Math.round(feed.scale * 100)}%</span>
          </label>
        )}
        {feed.enabled && shownScale < feed.scale - 0.005 && (
          <div className="muted">The widest entry fills the frame at {Math.round(shownScale * 100)}%, so the feed stops growing there.</div>
        )}
        <label className="row">
          <span className="muted">Caption size</span>
          <input className="input" type="number" min={1} max={15} step={0.5} value={caps.sizePct} onChange={(e) => setCaps({ ...caps, sizePct: Number(e.target.value) })} />
          <span className="muted">%</span>
        </label>
        <label className="row">
          <span className="muted">Position</span>
          <input className="input" type="number" min={5} max={95} step={1} value={caps.positionPct} onChange={(e) => setCaps({ ...caps, positionPct: Number(e.target.value) })} />
          <span className="muted">% from top</span>
        </label>
        {!style.enabled ? (
          <div className="muted">Captions are off (Captions step), so the short won't have them.</div>
        ) : (
          lines.length === 0 && <div className="muted">No transcript in this project, so the short has no captions.</div>
        )}
      </div>
    </div>
  );
}

/** The short's kill feed as it will be exported: the game's own entries where found, drawn rows for the rest. */
function KillFeed({
  kills,
  images,
  rec,
  frame,
  topPct,
  scale,
  align,
}: {
  kills: FeedKill[];
  images: FeedImages;
  rec: number;
  frame: Video;
  topPct: number;
  scale: number;
  align: FeedAlign;
}) {
  const sorted = useMemo(() => [...kills].sort((a, b) => a.at - b.at), [kills]);
  // text height in container widths, as the export sizes it from the frame height
  const size = (feedTextSize(frame, scale) * 100) / frame.width;
  const pct = (n: number, of: number) => `${(n * 100) / of}%`;
  // a new row slides in from its side, as in the export
  const slide = { ['--slide' as string]: `${slideFrom(align) * 2}em` };
  // a drawn row lines up on the same side (centred: auto margins around its own width)
  const rowSide = align === 'left' ? { left: 0 } : align === 'right' ? { right: 0 } : { left: 0, right: 0, margin: '0 auto', width: 'fit-content' };
  return (
    <>
      {sorted.map((k, i) => {
        const img = images?.[i];
        if (k.at > rec || !img) return null;
        const r = feedImageRect(img, i, frame, topPct, scale, align);
        return (
          <img
            key={i}
            className="feed-img"
            src={img.url}
            alt=""
            style={{ left: pct(r.x, frame.width), top: pct(r.y, frame.height), width: pct(r.w, frame.width), fontSize: `${size}cqw`, ...slide }}
          />
        );
      })}
      <div className="short-feed" style={{ top: `${topPct}%`, left: `${FEED_MARGIN * 100}%`, right: `${FEED_MARGIN * 100}%`, fontSize: `${size}cqw` }}>
        {sorted.map((k, i) =>
          k.at <= rec && images !== null && !images[i] ? (
            <div
              key={i}
              className="feed-row"
              style={{
                top: `${i * FEED_ROW}em`,
                padding: `${FEED_PAD}em`,
                outlineWidth: `${FEED_BORDER}em`,
                background: FEED_BG,
                outlineColor: FEED_RED,
                ...rowSide,
                ...slide,
              }}
            >
              <span style={{ color: SIDE_COLOR[k.attackerSide ?? 'none'] }}>{k.attacker}</span>
              <span style={{ color: FEED_MUTED }}>
                {weaponName(k.weapon)}
                {killMarks(k).map((m) => ` ${m}`)}
              </span>
              <span style={{ color: SIDE_COLOR[k.victimSide ?? 'none'] }}>{k.victim}</span>
            </div>
          ) : null,
        )}
      </div>
    </>
  );
}

/**
 * The overlay picture over the 9:16 preview, where the export puts it: drag
 * it to move it, drag its corner to resize it (its shape is kept). Placed
 * with the same rule as the export, so it can't leave the frame.
 */
function OverlayPicture({ overlay, setOverlay, frame }: { overlay: Settings['shortOverlay']; setOverlay: (o: Settings['shortOverlay']) => void; frame: Video }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => setNatural(null), [overlay.path]);
  const drag = useRef<{ resize: boolean; x0: number; y0: number; o0: Settings['shortOverlay']; w: number; h: number } | null>(null);
  const r = natural ? overlayRect(overlay, natural, frame) : null;

  /** `want` stored as the export will place it (kept inside the frame) */
  const place = (want: Settings['shortOverlay']) => {
    if (!natural) return;
    const placed = overlayRect(want, natural, frame);
    setOverlay({ ...want, x: placed.x / frame.width, y: placed.y / frame.height, w: placed.w / frame.width });
  };
  /** where it is across right now, so leaving an alignment doesn't make it jump */
  const here = (o: Settings['shortOverlay']) => (natural ? overlayRect(o, natural, frame).x / frame.width : o.x);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.focus(); // selected: the arrow keys move it now
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    drag.current = { resize: (e.target as HTMLElement).classList.contains('crop-handle'), x0: e.clientX, y0: e.clientY, o0: overlay, w: box.width, h: box.height };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) / d.w;
    const dy = (e.clientY - d.y0) / d.h;
    if (d.resize) return place({ ...d.o0, w: d.o0.w + dx }); // an alignment is kept: centred stays centred
    // dragged sideways it's placed by hand; straight up or down it keeps its alignment
    const sideways = Math.abs(e.clientX - d.x0) > SIDEWAYS_PX;
    place({ ...d.o0, x: here(d.o0) + (sideways ? dx : 0), y: d.o0.y + dy, align: sideways ? 'free' : d.o0.align });
  };
  const onUp = () => (drag.current = null);

  // arrow keys nudge it a pixel of the short (Shift: ten); left / right place it by hand
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (e.key === 'Escape') (e.currentTarget as HTMLElement).blur();
    if (!dx && !dy) return;
    // the editor's own arrow keys (frame step, edit points) don't run while it's selected
    e.preventDefault();
    e.stopPropagation();
    place(dx ? { ...overlay, align: 'free', x: here(overlay) + dx / frame.width } : { ...overlay, y: overlay.y + dy / frame.height });
  };
  const pct = (n: number, of: number) => `${(n * 100) / of}%`;

  return (
    <div
      className="overlay-pic"
      tabIndex={0}
      style={r ? { left: pct(r.x, frame.width), top: pct(r.y, frame.height), width: pct(r.w, frame.width) } : { left: `${overlay.x * 100}%`, top: `${overlay.y * 100}%`, width: `${overlay.w * 100}%` }}
      title="Drag to move, drag the corner to resize; click it, then the arrow keys nudge it (Shift: 10 px)"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
    >
      <img src={`/api/image?path=${encodeURIComponent(overlay.path)}`} alt="" draggable={false} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      <i className="crop-handle" />
    </div>
  );
}
