import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, locator, waitJob, type Clip, type Edits, type FeedKill, type Job, type ProjectView, type Rect, type Settings, type ShortLayout, type ShortView } from './api.ts';
import type { WebcamMode } from '../../server/types.ts';
import { TimelineEditor } from './Editor.tsx';
import { ReelStage, type ReelPlayer } from './reel.tsx';
import { Progress } from './ui.tsx';
import { captionChunks, wordClass } from './CaptionPreview.tsx';
import { captionChars } from '../../server/captions/ass.ts';
import {
  clampRect, DEFAULT_SAFE_BOTTOM, DEFAULT_SAFE_TOP, gameplayTop, hasCamera, layoutAspects, layoutBands, MAX_PIP_W, MAX_SAFE_TOP, MIN_PIP_W, PIP_SHADOW_ALPHA, pipRect, pipStyle, webcamMode, fitLayout, MAX_SAFE_BOTTOM, MAX_SPLIT, MIN_SPLIT, overlayRect, resizeRect, SAFE_BLUR, SAFE_DIM, safeBottom, type OverlayAlign,
} from '../../server/shorts/layout.ts';
import { DEFAULT_SETTINGS } from '../../server/types.ts';
import { FilePicker } from './FilePicker.tsx';
import { TitlesPanel } from './Titles.tsx';
import {
  BORDER as FEED_BORDER, FEED_BG, feedAlpha, feedImageRect, feedMargin, feedOnScreen, feedSlot, holdKills, holdsFeed, feedStay, fitFeedScale, MAX_FEED_STAY, FEED_MARGIN, MAX_FEED_MARGIN, slideFrom, type FeedAlign, FEED_MUTED, FEED_RED, FEED_ROW, feedTextSize, feedTopPct, killMarks, MAX_FEED_SCALE, MIN_FEED_SCALE, PAD as FEED_PAD, SIDE_COLOR, weaponName,
} from '../../server/shorts/killfeed.ts';
import {
  MAX_LINE_HEIGHT, MAX_TITLE_SIZE, MAX_WORD_SPACING, MIN_LINE_HEIGHT, MIN_TITLE_SIZE, MIN_WORD_SPACING, placeTitle, TITLE_PRESETS, TITLE_WIDTH, titleBoxes, titlePreset, titleWarnings, titleWords, wrapTitle, type TitleFont, type TitlePreset,
} from '../../server/shorts/title.ts';

/** canvas width of the 9:16 preview (half of a 1080-wide short) */
const PREVIEW_W = 540;
const SAVE_DELAY_MS = 400;

type Video = { width: number; height: number };
const FEED_SCALE_STEP = 0.1;
const WEBCAM_MODES: [WebcamMode, string, string][] = [
  ['off', 'Off', 'No webcam: the gameplay between a top and a bottom safe area'],
  ['float', 'Floating', 'The webcam in a box on top of the short: drag it anywhere, drag its corner to resize it'],
  ['band', 'Band on top', 'The webcam in its own band above the gameplay'],
];
/** how long after the final kill a looping short may open (on the reaction) */
const MAX_LOOP_AFTER = 5;
const DEFAULT_OVERLAY = DEFAULT_SETTINGS.shortOverlay;
const TITLE_DEFAULTS = DEFAULT_SETTINGS.shortTitle;
/** the overlay can be made this faint, but not invisible */
const MIN_OPACITY = 0.1;
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
  const [title, setTitleState] = useState('');
  const [titleStyle, setTitleStyleState] = useState<Settings['shortTitle'] | null>(null);
  // the game's own kill-feed entries, cut out of the recording (takes a moment the first time)
  const [feedImages, setFeedImages] = useState<FeedImages>(null);
  // a clip made straight into a short: its kill feed being read; once done, the kills (and their entries) come in
  const [readJob, setReadJob] = useState<Job | null>(null);
  const [kills, setKillsVersion] = useState(0);
  useEffect(() => {
    api.shortFeed(id, sid).then(setFeedImages).catch(() => setFeedImages([]));
  }, [id, sid, kills]);
  useEffect(() => {
    if (readJob?.status !== 'running') return;
    let live = true;
    waitJob(readJob.id, (j) => live && setReadJob(j))
      .then(async () => {
        if (!live) return;
        setV(await api.short(id, sid));
        setKillsVersion((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [readJob?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [job, setJob] = useState<Job | null>(null);
  // the 1080p export for Instagram, TikTok and Facebook
  const [socialJob, setSocialJob] = useState<Job | null>(null);
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
        setTitleState(short.short.title ?? '');
        setTitleStyleState(proj.settings.shortTitle);
        setJob(short.renderJob);
        setSocialJob(short.socialJob);
        setReadJob(short.readJob);
        // an export still running from before: follow it
        if (short.renderJob?.status === 'running') void follow(short.renderJob.id, setJob);
        if (short.socialJob?.status === 'running') void follow(short.socialJob.id, setSocialJob);
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
  const setTitle = (t: string) => {
    setTitleState(t);
    later({ title: t });
  };
  const setTitleStyle = (t: Settings['shortTitle']) => {
    setTitleStyleState(t);
    later({ titleStyle: t });
  };
  // saved at once: the short's length depends on it
  const setLoop = (l: Settings['shortLoop']) => {
    setLoopState(l);
    patch({ loop: l });
  };

  const follow = async (jobId: string, set: (j: Job) => void) => {
    const done = await waitJob(jobId, set);
    if (done.status === 'error') setError(done.error ?? 'Export failed');
    setV(await api.short(id, sid));
  };
  // social: the 1080p export for Instagram, TikTok and Facebook
  const exportShort = async (flushEdits: () => void, social = false) => {
    flushEdits();
    flushPending();
    await saving.current;
    const set = social ? setSocialJob : setJob;
    try {
      const j = await api.renderShort(id, sid, social);
      set(j);
      await follow(j.id, set);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const locate = useMemo(() => (p ? locator(p) : null), [p]);
  if (!p || !v || !layout || !caps || !feed || !overlay || !loop || !titleStyle || !locate) {
    return <main className="home">{error ? <div className="error">{error}</div> : <div className="muted">Loading…</div>}</main>;
  }

  const clips = p.mode === 'clips';
  const name = v.direct ? p.name.replace(/^Short · /, '') : clips ? `Clip ${v.short.round}` : `Round ${v.short.round}`;
  const running = job?.status === 'running';
  const socialRunning = socialJob?.status === 'running';

  return (
    <main className="project short-page">
      <div className="project-head">
        <div>
          {/* a clip made straight into a short has no project page: back home */}
          <a className="muted small" href={v.direct ? '#' : `#${id}`}>
            ← {v.direct ? 'Home' : p.name}
          </a>
          <h1>{name} · Short</h1>
          <div className="muted">
            9:16 · {v.frame.width}×{v.frame.height} · {fmtTime(v.duration)} · {v.clips.length} pieces · same codec, bitrate and frame rate as the recording
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {v.direct && readJob?.status === 'running' && (
        <div className="muted small">
          Reading the clip's kill feed… your kills show up in the short's kill feed when it's done ({Math.round((readJob.progress ?? 0) * 100)}%).
        </div>
      )}
      {v.direct && readJob?.status === 'error' && <div className="error">Couldn't read the clip's kill feed: {readJob.error}</div>}
      {v.direct && v.killfeed && !readJob && v.kills.length === 0 && (
        <div className="muted small">No kill feed: put ANTHROPIC_API_KEY in the app's .env and restart it to have your kills read from the clip.</div>
      )}
      {v.direct && readJob?.status === 'done' && v.kills.length === 0 && (
        <div className="muted small">No kills of yours were found in this clip's kill feed (check your in-game name on the home page).</div>
      )}

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
          <>
            <button className="btn" disabled={socialRunning} onClick={() => exportShort(flush, true)} title="1080p, made for Instagram Reels, TikTok and Facebook Reels">
              {socialRunning ? 'Exporting for social…' : 'Export for Instagram · TikTok · Facebook'}
            </button>
            <button className="btn btn-primary" disabled={running} onClick={() => exportShort(flush)} title="The recording's own quality, for YouTube Shorts">
              {running ? 'Exporting…' : 'Export short'}
            </button>
          </>
        )}
        stage={(player, badge) => (
          <div className="short-stage">
            <div className="short-source">
              <ReelStage player={player}>
                {badge}
                {webcamMode(layout) !== 'off' && (
                  <CropBox
                    label="Camera"
                    kind="camera"
                    rect={layout.camera}
                    // floating, the crop takes any shape (the box on the short follows it); in its band, the band's
                    aspect={webcamMode(layout) === 'float' ? null : layoutAspects(p.video, layout).camera}
                    video={p.video}
                    onChange={(camera) => setLayout({ ...layout, camera })}
                  />
                )}
                <CropBox label="Gameplay" kind="gameplay" rect={layout.gameplay} aspect={layoutAspects(p.video, layout).gameplay} video={p.video} onChange={(gameplay) => setLayout({ ...layout, gameplay })} />
              </ReelStage>
              <div className="row wrap small">
                <span>Webcam</span>
                <div className="seg" role="radiogroup" aria-label="Webcam">
                  {WEBCAM_MODES.map(([m, label, hint]) => (
                    <button
                      key={m}
                      role="radio"
                      aria-checked={webcamMode(layout) === m}
                      className={`btn btn-xs ${webcamMode(layout) === m ? 'on' : ''}`}
                      title={hint}
                      onClick={() => setLayout(fitLayout({ ...layout, webcam: m }, p.video))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="muted small">
                {webcamMode(layout) === 'off'
                  ? 'Drag the box over the gameplay; drag its corner to resize it. It keeps its band’s shape, so nothing stretches.'
                  : webcamMode(layout) === 'float'
                    ? 'Drag the boxes over your facecam and the gameplay; drag a box’s corner to resize it. Then move and resize the webcam on the short itself.'
                    : 'Drag the boxes over your facecam and the gameplay; drag a box’s corner to resize it. Each box keeps its band’s shape, so nothing stretches.'}
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
              pieces={v.clips}
              loopCut={loop.enabled ? v.loopCut : null}
              feedImages={feedImages}
              feed={feed}
              setFeed={setFeed}
              overlay={overlay}
              setOverlay={setOverlay}
              title={title}
              setTitle={setTitle}
              titleStyle={titleStyle}
              setTitleStyle={setTitleStyle}
              titleFonts={v.titleFonts}
              killfeed={v.killfeed}
            />
          </div>
        )}
      />

      <section className="card">
        <h2>Export</h2>
        <div className="short-exports small">
          <span>YouTube Shorts</span>
          <span className="muted">
            the recording's own quality ({v.frame.width}×{v.frame.height}, its codec and bitrate)
          </span>
          <span className="muted mono">{v.short.outputPath ?? v.defaultOutputPath}</span>
          <span>Instagram · TikTok · Facebook</span>
          <span className="muted">1080×1920, H.264 High, up to 60 fps, ~16 Mbps, AAC 48 kHz: what their apps re-encode cleanly</span>
          <span className="muted mono">{v.short.socialOutputPath ?? v.defaultSocialPath}</span>
        </div>
        <label className="row small">
          <input type="checkbox" checked={loop.enabled} disabled={running || socialRunning} onChange={(e) => setLoop({ ...loop, enabled: e.target.checked })} />
          <span>Seamless loop</span>
          <span className="muted">
            opens on the reaction after the final kill, blends into the round's start and ends on that kill, so a replay runs straight into the reaction
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
              min={0}
              max={MAX_LOOP_AFTER}
              step={0.1}
              value={loop.after}
              disabled={running || socialRunning}
              onChange={(e) => setLoop({ ...loop, after: Math.min(MAX_LOOP_AFTER, Math.max(0, Number(e.target.value) || 0)) })}
            />
            <span className="muted">s after the final kill, on the reaction{v.loopCut !== null && ` (cut at ${fmtTime(v.loopCut)} in the recording)`}</span>
          </label>
        )}
        {job && running && (
          <div className="small">
            YouTube export <Progress value={job.progress} />
          </div>
        )}
        {socialJob && socialRunning && (
          <div className="small">
            Social export <Progress value={socialJob.progress} />
          </div>
        )}
        {job?.status === 'cancelled' && <div className="muted small">YouTube export cancelled.</div>}
        {socialJob?.status === 'cancelled' && <div className="muted small">Social export cancelled.</div>}
        <div className="row wrap short-outputs">
          {v.short.outputPath && !running && (
            <figure>
              {/* plays on repeat, as on a phone, so the loop point can be checked */}
              <video className="short-output" controls loop src={`/api/projects/${id}/shorts/${sid}/output?t=${job?.id ?? ''}`} />
              <figcaption className="muted small">YouTube</figcaption>
            </figure>
          )}
          {v.short.socialOutputPath && !socialRunning && (
            <figure>
              <video className="short-output" controls loop src={`/api/projects/${id}/shorts/${sid}/output?for=social&t=${socialJob?.id ?? ''}`} />
              <figcaption className="muted small">Instagram · TikTok · Facebook</figcaption>
            </figure>
          )}
        </div>
      </section>

      {/* written from the CS2 round (demo or kill feed): not for clips of other games */}
      {v.killfeed && (
      <TitlesPanel
        heading="YouTube Shorts titles"
        intro={
          clips
            ? 'Claude reads this clip (your kills, whether you died, the score on screen) and writes Shorts titles with you as the hero, each with thumbnail text to go with it.'
            : `Claude reads this round from the demo (your kills in order, a clutch, the score and what was at stake${p.transcript?.length ? ', what you said' : ''}) and writes Shorts titles with you as the hero, each with thumbnail text to go with it.`
        }
        available={v.titlesAvailable}
        profile={v.creatorProfile}
        saveProfile={async (creatorProfile) => {
          await api.patch(id, { settings: { creatorProfile } });
          setV(await api.short(id, sid));
        }}
        titles={v.short.titles}
        job={v.titlesJob}
        start={(direction) => api.writeShortTitles(id, sid, direction)}
        done={async () => setV(await api.short(id, sid))}
        fits={[25, 50]}
        placeholder="Direction for this batch (optional), e.g. focus on the AWP, or that it was match point"
        useThumbnail={(text) => setTitle(text)}
      />
      )}
    </main>
  );
}

/** A framed region on the recording: drag to move, drag the corner to resize (at the band's aspect). */
/** A crop on the source. `aspect` (width / height, pixels) is kept when resizing; null: any shape (the corner sets width and height). */
function CropBox({ label, kind, rect, aspect, video, onChange }: { label: string; kind: string; rect: Rect; aspect: number | null; video: Video; onChange: (r: Rect) => void }) {
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
    const free = (r: Rect) => ({ ...r, w: Math.max(0.05, Math.min(1 - r.x, d.r0.w + dx)), h: Math.max(0.05, Math.min(1 - r.y, d.r0.h + dy)) });
    onChange(d.resize ? (aspect === null ? free(d.r0) : resizeRect(d.r0, d.r0.w + dx, aspect, video)) : clampRect({ ...d.r0, x: d.r0.x + dx, y: d.r0.y + dy }));
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
  pieces,
  loopCut,
  feedImages,
  feed,
  setFeed,
  overlay,
  setOverlay,
  title,
  setTitle,
  titleStyle,
  setTitleStyle,
  titleFonts,
  killfeed,
}: {
  player: ReelPlayer;
  p: ProjectView;
  frame: Video;
  layout: ShortLayout;
  setLayout: (l: ShortLayout) => void;
  caps: Settings['shortCaptions'];
  setCaps: (c: Settings['shortCaptions']) => void;
  kills: FeedKill[];
  /** the short's pieces, in the order they play */
  pieces: Clip[];
  /** a looping short: where its opening reaction starts in the recording (the feed holds every kill from there) */
  loopCut: number | null;
  feedImages: FeedImages;
  feed: Settings['shortKillfeed'];
  setFeed: (f: Settings['shortKillfeed']) => void;
  overlay: Settings['shortOverlay'];
  setOverlay: (o: Settings['shortOverlay']) => void;
  title: string;
  setTitle: (t: string) => void;
  titleStyle: Settings['shortTitle'];
  setTitleStyle: (t: Settings['shortTitle']) => void;
  titleFonts: ShortView['titleFonts'];
  /** the kill feed is known (CS2); off, any game: no kill-feed settings */
  killfeed: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ player, layout });
  live.current = { player, layout };
  const H = Math.round((PREVIEW_W * frame.height) / frame.width);
  // the settings tab, remembered on this computer
  const [tab, setTab] = useState<SettingsTab>(() => {
    try {
      const t = localStorage.getItem(TAB_KEY);
      return SETTINGS_TABS.some(([x]) => x === t && (killfeed || x !== 'feed')) ? (t as SettingsTab) : 'title';
    } catch {
      return 'title';
    }
  });
  const pickTab = (t: SettingsTab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // not saved: fine
    }
  };

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
      // the bands as the export stacks them (camera or top safe band, gameplay, bottom safe band)
      const bands = layoutBands({ width: PREVIEW_W, height: H }, l);
      const camH = bands.camera;
      const topH = bands.top;
      const safeH = bands.safe;
      const gameH = bands.gameplay;
      const gameY = camH + topH;
      const band = (r: Rect, y: number, h: number) => g.drawImage(vid, r.x * vw, r.y * vh, r.w * vw, r.h * vh, 0, y, PREVIEW_W, h);
      if (camH) band(l.camera, 0, camH);
      band(l.gameplay, gameY, gameH);
      const r = l.gameplay;
      const blur = SAFE_BLUR * PREVIEW_W;
      // drawn a blur's width past the band on every side, so its edges blur into picture, not into nothing
      const m = Math.ceil(blur * 2);
      // a safe band as the export makes it: the gameplay's edge at `seam` mirrored over it, blurred and dimmed
      const mirrored = (seam: number, h: number, below: boolean) => {
        const share = Math.min(1, (h + m) / gameH); // of the gameplay box, from that edge
        g.save();
        g.beginPath();
        g.rect(0, below ? seam : seam - h, PREVIEW_W, h);
        g.clip();
        g.filter = `blur(${blur}px) brightness(${SAFE_DIM})`;
        g.translate(0, 2 * seam);
        g.scale(1, -1);
        if (below) g.drawImage(vid, r.x * vw, (r.y + r.h * (1 - share)) * vh, r.w * vw, r.h * share * vh, -m, seam - h - m, PREVIEW_W + 2 * m, h + 2 * m);
        else g.drawImage(vid, r.x * vw, r.y * vh, r.w * vw, r.h * share * vh, -m, seam - m, PREVIEW_W + 2 * m, h + 2 * m);
        g.restore();
      };
      if (topH > 0) mirrored(gameY, topH, false);
      if (safeH > 0) mirrored(gameY + gameH, safeH, true);

      // the floating webcam as the export draws it: a soft shadow, a white border, rounded corners
      const pip = pipRect(l, frame, p.video);
      if (pip) {
        const k = PREVIEW_W / frame.width;
        const s = pipStyle(pip, frame);
        const [x, y, w, h] = [pip.x * k, pip.y * k, pip.w * k, pip.h * k];
        const b = s.border * k;
        const rounded = (rx: number, ry: number, rw: number, rh: number, rr: number) => {
          g.beginPath();
          g.roundRect(rx, ry, rw, rh, rr);
        };
        g.save();
        g.shadowColor = `rgba(0, 0, 0, ${PIP_SHADOW_ALPHA})`;
        g.shadowBlur = s.shadow * k;
        g.shadowOffsetY = s.drop * k;
        g.fillStyle = '#fff';
        rounded(x - b, y - b, w + 2 * b, h + 2 * b, (s.radius + s.border) * k);
        g.fill();
        g.restore();
        g.save();
        rounded(x, y, w, h, s.radius * k);
        g.clip();
        const c = l.camera;
        g.drawImage(vid, c.x * vw, c.y * vh, c.w * vw, c.h * vh, x, y, w, h);
        g.restore();
      }
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
    const at = (e.clientY - s.top) / s.h;
    // with no camera, the line is the top safe band's edge
    setLayout(
      fitLayout(
        hasCamera(s.base) ? { ...s.base, split: Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, at)) } : { ...s.base, top: Math.round(Math.min(MAX_SAFE_TOP, Math.max(0, at)) * 100) / 100 },
        p.video,
      ),
    );
  };
  const onSplitUp = () => (split.current = null);

  // captions as they'll be burned in, laid out for the vertical frame
  const style = { ...p.settings.captions, ...caps };
  const lines = useMemo(() => (p.transcript ?? []).filter((l) => !l.removed), [p.transcript]);
  const maxChars = captionChars(style, frame);
  // as the export: smaller than asked when the widest entry wouldn't fit
  const feedSide = feedMargin(feed.sidePct);
  const shownScale = fitFeedScale(feedImages ?? [], frame, feed.scale, feed.align, feedSide);
  const chunks = useMemo(() => captionChunks(lines, style.wordsPerCaption, maxChars, style.pauseS), [lines, style.wordsPerCaption, maxChars, style.pauseS]);
  const rec = player.recNow();
  const shown = style.enabled ? chunks.find((c) => rec >= c.start && rec < c.end) : undefined;

  const feedHint = feed.enabled ? `${kills.length} kills` : 'off';

  // the title measured as the export measures it, and where it would be hard to see or in the way
  const titleFont = useTitleFont(titlePreset(titleStyle.preset).font, titleFonts);
  // where the export puts it: kept above the gameplay, that's where this short's gameplay starts
  const seam = gameplayTop(frame, layout);
  const placedTitle = useMemo(() => placeTitle(title, titleStyle, frame, titleFont, seam), [title, titleStyle, frame, titleFont, seam]);
  const titleNotes = useMemo(() => {
    const boxes = titleBoxes(wrapTitle(title, placedTitle, frame, titleFont), placedTitle, frame, titleFont);
    if (!boxes.length) return [];
    const extent = { top: boxes[0].y / frame.height, bottom: (boxes.at(-1)!.y + boxes.at(-1)!.h) / frame.height };
    const feedTop = feedTopPct(feed.positionPct, seam) / 100;
    const feedRows = Math.min(5, Math.max(1, kills.length));
    const feedBox = feed.enabled ? { top: feedTop, bottom: feedTop + (feedRows * FEED_ROW * feedTextSize(frame, shownScale)) / frame.height } : null;
    return titleWarnings(extent, { split: seam, bottom: layoutBands(frame, layout).safe / frame.height }, feedBox);
  }, [title, placedTitle, frame, titleFont, feed.enabled, feed.positionPct, layout, kills.length, shownScale]);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  // the selected words wrapped in stars (or the stars taken off them): they show in the preset's accent
  const emphasise = () => {
    const el = titleInput.current;
    if (!el) return;
    let { selectionStart: a, selectionEnd: b } = el;
    // nothing selected: the word at the cursor
    if (a === b) {
      while (a > 0 && !/\s/.test(title[a - 1])) a--;
      while (b < title.length && !/\s/.test(title[b])) b++;
    }
    const picked = title.slice(a, b);
    if (!picked.trim()) return;
    const starred = /^\*.*\*$/s.test(picked);
    const next = starred ? picked.slice(1, -1) : `*${picked.replace(/\*/g, '')}*`;
    setTitle(title.slice(0, a) + next + title.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a, a + next.length);
    });
  };
  return (
    <>
    <div className="short-side">
      <div className="short-preview" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        <canvas ref={canvas} width={PREVIEW_W} height={H} onClick={player.togglePlay} />
        <div
          className="short-split"
          style={{ top: `${seam * 100}%` }}
          title="Drag to change how tall the camera is"
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onPointerCancel={onSplitUp}
        />
        {feed.enabled && (
          <KillFeed
            kills={kills}
            pieces={pieces}
            loopCut={loopCut}
            images={feedImages}
            rec={rec}
            frame={frame}
            topPct={feedTopPct(feed.positionPct, seam)}
            scale={shownScale}
            align={feed.align}
            margin={feedSide}
            stay={feedStay(feed.stay)}
          />
        )}
        {webcamMode(layout) === 'float' && <WebcamPip layout={layout} setLayout={setLayout} frame={frame} video={p.video} />}
        {overlay.enabled && overlay.path && <OverlayPicture overlay={overlay} setOverlay={setOverlay} frame={frame} />}
        {/* dragged, it's placed by hand from where it's shown */}
        {title.trim() && <TitleText text={title} style={placedTitle} setStyle={(t) => setTitleStyle({ ...t, aboveGameplay: false })} frame={frame} font={titleFont} />}
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
      <div className="muted small short-hint">Click to play · drag the line to resize the {hasCamera(layout) ? 'camera' : 'top safe area'} · drag the title, overlay to move them</div>
    </div>
      <div className="short-settings small">
        <style>{[...new Set(TITLE_PRESETS.map((t) => t.font))].map((font) => `@font-face{font-family:'${font}';src:url('/api/fonts/${encodeURIComponent(font)}')}`).join('')}</style>
        <div className="settings-tabs" role="tablist">
          {SETTINGS_TABS.filter(([t]) => killfeed || t !== 'feed').map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`settings-tab ${tab === t ? 'on' : ''}`} onClick={() => pickTab(t)}>
              {label}
              {t === 'feed' && <span className="tab-note">{feedHint}</span>}
              {t === 'overlay' && <span className="tab-note">{overlay.enabled && overlay.path ? 'on' : 'off'}</span>}
            </button>
          ))}
        </div>
        {tab === 'title' && (
        <div className="settings-panel">
          <label className="field">
            <span>Title</span>
            <textarea
              ref={titleInput}
              className="input short-title-input"
              rows={2}
              maxLength={200}
              placeholder="What the short is about, e.g. THAT WAS *INSANE* (Enter for a new line)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="row title-emphasis">
            <button className="btn btn-xs" onClick={emphasise} title="Wrap the selected words (or the word at the cursor) in *stars*; again to take them off">
              Emphasise
            </button>
            <span className="muted">
              Words in <span className="mono">*stars*</span> show in the preset's accent colour
            </span>
          </div>
          <div className="title-presets" role="radiogroup" aria-label="Title style">
            {TITLE_PRESETS.map((t) => (
              <button
                key={t.id}
                role="radio"
                className={`title-preset ${titleStyle.preset === t.id ? 'on' : ''}`}
                aria-checked={titleStyle.preset === t.id}
                title={t.name}
                onClick={() => setTitleStyle({ ...titleStyle, preset: t.id })}
              >
                <PresetSample t={t} />
                <em>{t.name}</em>
              </button>
            ))}
          </div>
          <label className="row setting">
            <span className="muted">Size</span>
            <input
              className="input"
              type="number"
              min={MIN_TITLE_SIZE}
              max={MAX_TITLE_SIZE}
              step={0.5}
              value={titleStyle.sizePct}
              onChange={(e) => setTitleStyle({ ...titleStyle, sizePct: Math.min(MAX_TITLE_SIZE, Math.max(MIN_TITLE_SIZE, Number(e.target.value) || MIN_TITLE_SIZE)) })}
            />
            <span className="muted">% of the height</span>
          </label>
          <label className="row setting">
            <span className="muted">From top</span>
            <input
              className="input"
              type="number"
              min={0}
              max={90}
              step={1}
              value={Math.round(placedTitle.positionPct)}
              onChange={(e) => setTitleStyle({ ...titleStyle, aboveGameplay: false, positionPct: Math.min(90, Math.max(0, Number(e.target.value) || 0)) })}
            />
            <span className="muted">%{title.trim() ? ', or drag it' : ''}</span>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={!!titleStyle.aboveGameplay}
              onChange={(e) => setTitleStyle({ ...titleStyle, aboveGameplay: e.target.checked, positionPct: placedTitle.positionPct })}
            />
            <span title="Its bottom sits on the camera's lower edge, just above the gameplay: the same place in every short, clear of the crosshair">
              Keep it just above the gameplay
            </span>
          </label>
          {title.trim() && titleNotes.map((n) => (
            <div key={n} className="warn-text small">
              {n}
            </div>
          ))}
          <label className="row setting">
            <span className="muted">Line height</span>
            <input
              className="input"
              type="number"
              min={MIN_LINE_HEIGHT}
              max={MAX_LINE_HEIGHT}
              step={0.05}
              value={titleStyle.lineHeight}
              onChange={(e) =>
                setTitleStyle({ ...titleStyle, lineHeight: Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, Number(e.target.value) || 1)) })
              }
            />
            <span className="muted">× (1 = the font's own)</span>
          </label>
          <label className="row setting">
            <span className="muted">Word spacing</span>
            <input
              className="input"
              type="number"
              min={MIN_WORD_SPACING}
              max={MAX_WORD_SPACING}
              step={0.25}
              value={titleStyle.wordSpacing}
              onChange={(e) =>
                setTitleStyle({ ...titleStyle, wordSpacing: Math.min(MAX_WORD_SPACING, Math.max(MIN_WORD_SPACING, Number(e.target.value) || 1)) })
              }
            />
            <span className="muted">× (1 = normal)</span>
          </label>
          <div>
            <button
              className="btn btn-xs"
              title={`Size ${TITLE_DEFAULTS.sizePct}%, ${TITLE_DEFAULTS.positionPct}% from the top, line height ${TITLE_DEFAULTS.lineHeight}, word spacing ${TITLE_DEFAULTS.wordSpacing} (keeps the style)`}
              onClick={() => setTitleStyle({ ...TITLE_DEFAULTS, preset: titleStyle.preset })}
            >
              Reset to TEYE defaults
            </button>
          </div>
        </div>
        )}
        {tab === 'overlay' && (
        <div className="settings-panel">
          <label className="row">
            <input type="checkbox" checked={overlay.enabled} onChange={(e) => setOverlay({ ...overlay, enabled: e.target.checked })} />
            <span>Show an overlay picture</span>
          </label>
          <div className="muted">{overlay.path ? 'Drag it in the preview; drag its corner to resize it.' : 'A picture on top of the short, such as a "follow me" badge (PNG or WebP with transparency).'}</div>
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
            <div className="row setting">
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
          {overlay.enabled && overlay.path && (
            <label className="row setting">
              <span className="muted">Opacity</span>
              <input
                type="range"
                min={MIN_OPACITY}
                max={1}
                step={0.05}
                value={overlay.opacity}
                onChange={(e) => setOverlay({ ...overlay, opacity: Number(e.target.value) })}
                onDoubleClick={() => setOverlay({ ...overlay, opacity: 1 })}
                title="Double-click for solid"
              />
              <span className="mono">{Math.round(overlay.opacity * 100)}%</span>
            </label>
          )}
        </div>
        )}
        {tab === 'feed' && (
        <div className="settings-panel">
        <label className="row">
          <input type="checkbox" checked={feed.enabled} onChange={(e) => setFeed({ ...feed, enabled: e.target.checked })} />
          <span>Show my kills</span>
          <span className="muted">({kills.length} in this round)</span>
        </label>
        {feed.enabled && (
          <label className="row setting">
            <span className="muted">From top</span>
            <input
              className="input"
              type="number"
              min={0}
              max={90}
              step={1}
              placeholder={String(Math.round(feedTopPct(null, seam)))}
              value={feed.positionPct ?? ''}
              onChange={(e) => setFeed({ ...feed, positionPct: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <span className="muted">%{feed.positionPct === null ? ' (under the camera)' : ''}</span>
          </label>
        )}
        {feed.enabled && (
          <div className="row setting">
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
        {feed.enabled && feed.align !== 'center' && (
          <label className="row setting">
            <span className="muted">Padding {feed.align}</span>
            <input
              type="range"
              min={0}
              max={MAX_FEED_MARGIN * 100}
              step={0.5}
              value={feedSide * 100}
              onChange={(e) => setFeed({ ...feed, sidePct: Number(e.target.value) })}
              onDoubleClick={() => setFeed({ ...feed, sidePct: FEED_MARGIN * 100 })}
              title="Double-click for the default"
            />
            <span className="mono">{(feedSide * 100).toFixed(1)}%</span>
          </label>
        )}
        {feed.enabled && (
          <label className="row setting">
            <span className="muted">Fade out after</span>
            <input
              className="input"
              type="number"
              min={0}
              max={MAX_FEED_STAY}
              step={0.5}
              value={feedStay(feed.stay)}
              onChange={(e) => setFeed({ ...feed, stay: Number(e.target.value) })}
            />
            <span className="muted">s{feedStay(feed.stay) === 0 ? ' (0: they stay up)' : ' of the short'}</span>
          </label>
        )}
        {feed.enabled && (
          <label className="row setting">
            <span className="muted">Size</span>
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
        </div>
        )}
        {tab === 'frame' && (
        <div className="settings-panel">
        {!hasCamera(layout) && (
          <>
            <h4>Top safe area</h4>
            <label className="row setting">
              <span className="muted">Height</span>
              <input
                type="range"
                min={0}
                max={MAX_SAFE_TOP}
                step={0.01}
                value={layout.top ?? DEFAULT_SAFE_TOP}
                onChange={(e) => setLayout(fitLayout({ ...layout, top: Number(e.target.value) }, p.video))}
                onDoubleClick={() => setLayout(fitLayout({ ...layout, top: DEFAULT_SAFE_TOP }, p.video))}
                title="Double-click for the default"
              />
              <span className="mono">{Math.round((layout.top ?? DEFAULT_SAFE_TOP) * 100)}%</span>
            </label>
            <div className="muted">
              With no webcam, the gameplay starts below this, clear of the phone's status bar and YouTube's top buttons; the band shows the gameplay blurred. You can also drag the line in the preview.
            </div>
          </>
        )}
        <h4>Bottom safe area</h4>
        <label className="row setting">
          <span className="muted">Height</span>
          <input
            type="range"
            min={0}
            max={MAX_SAFE_BOTTOM}
            step={0.01}
            value={layout.bottom ?? 0}
            onChange={(e) => setLayout(fitLayout({ ...layout, bottom: Number(e.target.value) }, p.video))}
            onDoubleClick={() => setLayout(fitLayout({ ...layout, bottom: DEFAULT_SAFE_BOTTOM }, p.video))}
            title="Double-click for the default"
          />
          <span className="mono">{Math.round((layout.bottom ?? 0) * 100)}%</span>
        </label>
        <div className="muted">
          The gameplay stops above this, so YouTube's title and buttons don't cover the HUD; the band shows the gameplay blurred.
        </div>
        <h4>Captions</h4>
        <label className="row setting">
          <span className="muted">Size</span>
          <input className="input" type="number" min={1} max={15} step={0.5} value={caps.sizePct} onChange={(e) => setCaps({ ...caps, sizePct: Number(e.target.value) })} />
          <span className="muted">%</span>
        </label>
        <label className="row setting">
          <span className="muted">From top</span>
          <input className="input" type="number" min={5} max={95} step={1} value={caps.positionPct} onChange={(e) => setCaps({ ...caps, positionPct: Number(e.target.value) })} />
          <span className="muted">%</span>
        </label>
        {!style.enabled ? (
          <div className="muted">Captions are off (Captions step), so the short won't have them.</div>
        ) : (
          lines.length === 0 && <div className="muted">No transcript in this project, so the short has no captions.</div>
        )}
        </div>
        )}
      </div>
    </>
  );
}

type SettingsTab = 'title' | 'feed' | 'overlay' | 'frame';
const SETTINGS_TABS: [SettingsTab, string][] = [
  ['title', 'Title'],
  ['feed', 'Kill feed'],
  ['overlay', 'Overlay'],
  ['frame', 'Frame & captions'],
];
const TAB_KEY = 'shortSettingsTab';

/** The short's kill feed as it will be exported: the game's own entries where found, drawn rows for the rest. */
function KillFeed({
  kills,
  pieces,
  loopCut,
  images,
  rec,
  frame,
  topPct,
  scale,
  align,
  margin,
  stay,
}: {
  kills: FeedKill[];
  /** the short's pieces, in the order they play */
  pieces: Clip[];
  loopCut: number | null;
  images: FeedImages;
  rec: number;
  frame: Video;
  topPct: number;
  scale: number;
  align: FeedAlign;
  /** the side padding, a fraction of the width */
  margin: number;
  /** seconds a row stays up after its kill; 0 = for good */
  stay: number;
}) {
  const sorted = useMemo(() => [...kills].sort((a, b) => a.at - b.at), [kills]);
  // on the short's own clock, as the export: the piece on screen (or, looking at cut footage, the one before it)
  const inPiece = pieces.findIndex((p) => rec >= p.start && rec < p.end);
  const n = inPiece >= 0 ? inPiece : pieces.reduce((m, p, i) => (p.start <= rec ? i : m), 0);
  const live = pieces.length ? feedOnScreen(sorted, pieces, n) : { kills: sorted, clip: { start: 0, end: Infinity } };
  const now = pieces.length ? live.clip.start + Math.min(rec, pieces[n].end) - pieces[n].start : rec;
  // a looping short's opening reaction (played here after the final kill): every kill held up, as the export opens
  const held = holdsFeed(rec, loopCut);
  const shown = held ? holdKills(sorted, Infinity, now - 1) : live.kills;
  if (held) stay = 0;
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
        const alpha = feedAlpha(shown[i], now, stay);
        if (shown[i].at > now || !img || alpha <= 0) return null;
        // in its slot: the rows above it that are gone have closed up
        const r = feedImageRect(img, feedSlot(shown, i, now, stay), frame, topPct, scale, align, margin);
        return (
          <img
            key={i}
            className="feed-img"
            src={img.url}
            alt=""
            style={{ left: pct(r.x, frame.width), top: pct(r.y, frame.height), width: pct(r.w, frame.width), fontSize: `${size}cqw`, opacity: alpha, ...slide }}
          />
        );
      })}
      <div
        className="short-feed"
        style={{
          top: `${topPct}%`,
          // the side padding on the aligned side, the default gap on the other
          left: `${(align === 'left' ? margin : FEED_MARGIN) * 100}%`,
          right: `${(align === 'right' ? margin : FEED_MARGIN) * 100}%`,
          fontSize: `${size}cqw`,
        }}
      >
        {sorted.map((k, i) =>
          shown[i].at <= now && images !== null && !images[i] && feedAlpha(shown[i], now, stay) > 0 ? (
            <div
              key={i}
              className="feed-row"
              style={{
                top: `${feedSlot(shown, i, now, stay) * FEED_ROW}em`,
                opacity: feedAlpha(shown[i], now, stay),
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
/**
 * The floating webcam's handle on the short: drawn by the preview's canvas
 * (as the export draws it), moved by dragging it and resized from its corner;
 * the arrow keys nudge it (Shift: 10 px). Its height follows the camera crop.
 */
function WebcamPip({ layout, setLayout, frame, video }: { layout: ShortLayout; setLayout: (l: ShortLayout) => void; frame: Video; video: Video }) {
  const r = pipRect(layout, frame, video);
  const drag = useRef<{ resize: boolean; x0: number; y0: number; p0: { x: number; y: number; w: number }; w: number; h: number } | null>(null);
  if (!r) return null;
  // where it is now, as set (kept in the frame)
  const here = { x: r.x / frame.width, y: r.y / frame.height, w: r.w / frame.width };
  const place = (pip: { x: number; y: number; w: number }) => setLayout({ ...layout, pip: { ...pip, w: Math.min(MAX_PIP_W, Math.max(MIN_PIP_W, pip.w)) } });
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    drag.current = { resize: (e.target as HTMLElement).classList.contains('crop-handle'), x0: e.clientX, y0: e.clientY, p0: here, w: box.width, h: box.height };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) / d.w;
    const dy = (e.clientY - d.y0) / d.h;
    place(d.resize ? { ...d.p0, w: d.p0.w + dx } : { ...d.p0, x: d.p0.x + dx, y: d.p0.y + dy });
  };
  const onUp = () => (drag.current = null);
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    place({ ...here, x: here.x + dx / frame.width, y: here.y + dy / frame.height });
  };
  const pct = (n: number, of: number) => `${(n * 100) / of}%`;
  return (
    <div
      className="pip-box"
      tabIndex={0}
      style={{ left: pct(r.x, frame.width), top: pct(r.y, frame.height), width: pct(r.w, frame.width), height: pct(r.h, frame.height) }}
      title="Your webcam: drag to move, drag the corner to resize; click it, then the arrow keys nudge it (Shift: 10 px)"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
    >
      <i className="crop-handle" />
    </div>
  );
}

function OverlayPicture({ overlay, setOverlay, frame }:{ overlay: Settings['shortOverlay']; setOverlay: (o: Settings['shortOverlay']) => void; frame: Video }) {
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
      <img src={`/api/image?path=${encodeURIComponent(overlay.path)}`} alt="" draggable={false} style={{ opacity: overlay.opacity }} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      <i className="crop-handle" />
    </div>
  );
}

/** "#RRGGBB" and an ASS-style alpha (0 = solid, 1 = gone) as CSS */
const rgba = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(1 - alpha).toFixed(2)})`;
};

/**
 * A title preset's letters in CSS, matching the export's ASS. The export's
 * sizes are shares of its font size, which is `1 / scale` em here (see assScale).
 */
function titleCss(t: TitlePreset, scale = 1): React.CSSProperties {
  const em = (n: number) => `${n / scale}em`;
  const shadow = t.shadow && !t.box ? t.shadow : null;
  return {
    fontFamily: `'${t.font}', Impact, 'Arial Black', sans-serif`,
    color: t.color,
    // the export's outline is outside the letters: a centred stroke twice as wide, drawn under the fill
    ...(t.outline ? { WebkitTextStroke: `${em(t.outlineW * 2)} ${t.outline}`, paintOrder: 'stroke fill' } : {}),
    // the export's shadow is of the outlined letters: a drop shadow of what's drawn, stroke and all
    ...(shadow ? { filter: `drop-shadow(${em(shadow.offset)} ${em(shadow.offset)} 0 ${rgba(shadow.color, shadow.alpha)})` } : {}),
  };
}

/** A box preset's box in CSS, around text at `scale` (for the preset cards; the preview draws titleBoxes). */
function titleBoxCss(t: TitlePreset, scale = 1): React.CSSProperties {
  if (!t.box) return {};
  const em = (n: number) => `${n / scale}em`;
  return {
    background: t.box,
    padding: `${em(t.pad.y * 0.6)} ${em(t.pad.x)}`,
    borderRadius: em(t.radius),
    ...(t.shadow ? { boxShadow: `${em(t.shadow.offset)} ${em(t.shadow.offset)} 0 ${rgba(t.shadow.color, t.shadow.alpha)}` } : {}),
  };
}

/** A line's words, the *starred* ones in the preset's accent. */
/** A preset card's sample line, in the preset's look, its capitals in the middle of its box. */
function PresetSample({ t }: { t: TitlePreset }) {
  const box = useFontBox(t.font);
  return (
    <span className="title-preset-sample">
      <span style={{ ...titleCss(t), ...titleBoxCss(t), display: 'inline-block', transform: t.tilt ? `rotate(${t.tilt}deg)` : undefined }}>
        <span style={{ position: 'relative', top: `${capCentreShift(box)}em` }}>
          <TitleWords line={t.sample} preset={t} />
        </span>
      </span>
    </span>
  );
}

function TitleWords({ line, preset }: { line: string; preset: TitlePreset }) {
  return (
    <>
      {titleWords(line).map((w, i) => (
        <span key={i}>
          {i > 0 && ' '}
          {w.em ? <span style={{ color: preset.accent }}>{w.text}</span> : w.text}
        </span>
      ))}
    </>
  );
}

/** A title font as the export measures it: its scale, baseline and capital height from the server, widths from the browser. */
function useTitleFont(font: string, fonts: ShortView['titleFonts'] | undefined): TitleFont {
  const width = useFontWidth(font);
  const m = fonts?.[font];
  return useMemo(() => ({ scale: m?.scale ?? 1, width, ascent: m?.ascent ?? undefined, cap: m?.cap ?? undefined }), [m?.scale, m?.ascent, m?.cap, width]);
}

/** The short's title where the export puts it, over its rounded boxes; dragged up or down to move it. */
function TitleText({ text, style, setStyle, frame, font }: { text: string; style: Settings['shortTitle']; setStyle: (t: Settings['shortTitle']) => void; frame: Video; font: TitleFont }) {
  const preset = titlePreset(style.preset);
  const { scale } = font;
  const cssBox = useFontBox(preset.font);
  // broken into lines the way the export breaks them, its boxes where the export draws them
  const lines = wrapTitle(text, style, frame, font);
  const boxes = preset.box ? titleBoxes(lines, style, frame, font) : [];
  const drag = useRef<{ y0: number; pos0: number; h: number } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, pos0: style.positionPct, h: e.currentTarget.parentElement!.getBoundingClientRect().height };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pos = Math.min(90, Math.max(0, d.pos0 + ((e.clientY - d.y0) / d.h) * 100));
    setStyle({ ...style, positionPct: Math.round(pos * 10) / 10 });
  };
  const onUp = () => (drag.current = null);
  const pctW = (n: number) => `${(n * 100) / frame.width}%`;
  const pctH = (n: number) => `${(n * 100) / frame.height}%`;
  const cqw = (n: number) => `${(n * 100) / frame.width}cqw`;
  const size = (frame.height * style.sizePct) / 100;
  const boxShadow = preset.shadow ? Math.max(1, size * preset.shadow.offset) : 0;
  return (
    <>
      {boxes.map((b, i) => (
        <div
          key={i}
          className="short-title-box"
          style={{
            left: pctW(b.x),
            top: pctH(b.y),
            width: pctW(b.w),
            height: pctH(b.h),
            borderRadius: cqw(b.r),
            background: preset.box!,
            boxShadow: preset.shadow ? `${cqw(boxShadow)} ${cqw(boxShadow)} 0 ${rgba(preset.shadow.color, preset.shadow.alpha)}` : undefined,
          }}
        />
      ))}
      <div
        className="short-title"
        style={{
          // each line's baseline where the export puts it (the browser would put it a little higher or lower)
          top: `calc(${style.positionPct}% + ${baselineShift(cssBox, 1 / scale, (font.ascent ?? 0.8) / scale)}em)`,
          // the export's letters: its font size times this font's scale; a line is the whole font size tall, as in the export
          fontSize: `${(style.sizePct * frame.height * scale) / frame.width}cqw`,
          lineHeight: 1 / scale,
          // added to each space, in em of the letters: the export stretches the space itself
          wordSpacing: `${((style.wordSpacing ?? 1) - 1) * font.width(' ')}em`,
          width: `${TITLE_WIDTH * 100}%`,
          // the export turns the title about its middle
          transform: `translateX(-50%)${preset.tilt ? ` rotate(${preset.tilt}deg)` : ''}`,
        }}
        title="Drag up or down to move the title"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={(e) => e.stopPropagation()}
      >
        {lines.map((l, i) => (
          // as the export: each line's top is a line height below the one before (the last keeps its own height)
          <div key={i} style={{ height: i < lines.length - 1 ? `${(style.lineHeight ?? 1) / scale}em` : undefined, whiteSpace: 'nowrap' }}>
            <span style={titleCss(preset, scale)}>
              <TitleWords line={l} preset={preset} />
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Where the browser puts a font's baseline: its ascent and descent (em) as it
 * lays out a line, and a capital's height. These can differ from what the
 * export uses (libass places the baseline by the font's win ascent; Chrome by
 * its hhea ascent, centred in the line height), so the preview moves its
 * letters by the difference.
 */
function useFontBox(font: string) {
  const width = useFontWidth(font); // changes once the font is in
  return useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `100px '${font}', Impact, 'Arial Black', sans-serif`;
    const m = ctx.measureText('H');
    return { ascent: m.fontBoundingBoxAscent / 100, descent: m.fontBoundingBoxDescent / 100, cap: m.actualBoundingBoxAscent / 100 };
  }, [font, width]);
}

/** How far down (em) the browser must move a line `lineEm` tall for its baseline to land `baselineEm` below the line's top. */
const baselineShift = (box: { ascent: number; descent: number }, lineEm: number, baselineEm: number) =>
  baselineEm - ((lineEm - box.ascent - box.descent) / 2 + box.ascent);

/** How far down (em) to move a line so its capitals sit in the middle of its line box (whatever the line height). */
const capCentreShift = (box: { ascent: number; descent: number; cap: number }) => (box.descent - box.ascent + box.cap) / 2;

/** A font's text width in em, measured by the browser (the same glyph advances the export wraps with). */
function useFontWidth(font: string) {
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    let live = true;
    // measured again once the font is in, not with the fallback it's drawn in meanwhile
    document.fonts.load(`100px '${font}'`).then(() => live && setLoaded((n) => n + 1), () => {});
    return () => {
      live = false;
    };
  }, [font]);
  return useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `100px '${font}', 'Arial Black', sans-serif`;
    return (t: string) => ctx.measureText(t).width / 100;
  }, [font, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
}
