import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findArrivals, parseDemo, scoreRounds } from './demo/parse.ts';
import { buildMoments } from './demo/moments.ts';
import { detectKillfeed } from './sync/killfeed.ts';
import { fitSync, type Anchor } from './sync/align.ts';
import { planClips, protectSpeech, roundCardText } from './edit/plan.ts';
import { applyEdits } from './edit/edits.ts';
import { BREAK_SECONDS, encodeArgs, renderReel, type Bookend } from './edit/render.ts';
import { bumperFile, bumperSeconds, reelTarget, type BumperKind } from './branding/bumper.ts';
import { probe, type VideoInfo } from './util/ffmpeg.ts';
import { detectSpeech, type Speech } from './audio/speech.ts';
import { DEFAULT_SETTINGS, NO_EDITS, type CaptionLine, type Edits, type Clip, type MatchData, type Moment, type RoundIntro, type Settings, type Source, type SyncModel } from './types.ts';
import { computePeaks, PEAKS_PER_SEC, readPeaks } from './audio/peaks.ts';
import { analyzeClip } from './clips/analyze.ts';
import { clipCardText, clipMoments, planSourceClips, roundStartsFrom } from './clips/moments.ts';
import { breakCards, coldOpenPieces, matchStats, overlayText, replays, sideSwitches } from './edit/extras.ts';
import { SCOREBOARD_SECONDS, scoreboardFile, scoreOverlay } from './branding/match.ts';
import { alignLines, transcribe } from './captions/transcribe.ts';
import { cleanupCaptions, retime } from './captions/cleanup.ts';
import { buildAss } from './captions/ass.ts';
import { resolveFont } from './captions/fonts.ts';

/** Bump when parsing/moments change in a way saved projects should pick up. */
const PROJECT_VERSION = 12;

export const DATA_DIR = resolve(process.env.CS2H_DATA ?? 'data');
const PROJECTS_DIR = join(DATA_DIR, 'projects');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
/** profile picture and cached intro / outro renders */
export const BRANDING_DIR = join(DATA_DIR, 'branding');
export const BUMPER_CACHE = join(BRANDING_DIR, 'cache');

export interface Project {
  id: string;
  version?: number;
  /**
   * 'captions' / 'edit': a recording without a demo, used whole (to try captions or the editor out).
   * 'clips': OBS replay clips without a demo, back to back on one timeline (`sources`);
   * videoPath is the first clip and `video` describes the whole timeline.
   */
  mode?: 'match' | 'captions' | 'edit' | 'clips';
  sources?: Source[];
  name: string;
  createdAt: string;
  videoPath: string;
  demoPath: string;
  video: VideoInfo;
  settings: Settings;
  match: MatchData;
  intros?: Record<number, RoundIntro>;
  moments: Moment[];
  sync: SyncModel | null;
  killfeedEvents: number[] | null;
  /** speech in the recording's voice track(s), so cuts never land mid-sentence */
  speech?: Speech | null;
  /** captions for the speech inside the reel (English / Roman Urdu), editable */
  transcript?: CaptionLine[] | null;
  /** cuts made in the editor */
  edits?: Edits;
  outputPath: string | null;
}

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  return withDefaults(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
}

/** Settings saved before a field existed get its default (caption settings too). */
export function withDefaults(s: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...s, captions: { ...DEFAULT_SETTINGS.captions, ...s.captions } };
}

export function saveSettings(s: Settings) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

export function saveProject(p: Project) {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  writeFileSync(join(PROJECTS_DIR, `${p.id}.json`), JSON.stringify(p));
}

export function getProject(id: string): Project | null {
  const f = join(PROJECTS_DIR, `${basename(id)}.json`);
  if (!existsSync(f)) return null;
  const p: Project = JSON.parse(readFileSync(f, 'utf8'));
  // settings added after this project was saved get their defaults;
  // the intro / outro belong to the channel, so every project uses the current ones
  p.settings = { ...withDefaults(p.settings), branding: loadSettings().branding };
  if (p.version !== PROJECT_VERSION) {
    upgradeProject(p);
    saveProject(p);
  }
  return p;
}

/**
 * Re-reads the demo for projects saved by an older version (e.g. before
 * assists and round intros), keeping the sync, kill-feed scan and toggles.
 */
function upgradeProject(p: Project) {
  p.settings = withDefaults(p.settings);
  // newer probes read the encoding settings
  if (clipsMode(p)) {
    placeSources(p, p.sources!.map((s) => (existsSync(s.path) ? { ...s, info: probe(s.path) } : s)));
    buildClipMoments(p);
  } else if (existsSync(p.videoPath)) p.video = probe(p.videoPath);
  if (existsSync(p.demoPath)) {
    p.match = parseDemo(p.demoPath);
    if (hasPlayer(p)) analyzePlayer(p);
    if (p.sync?.method === 'auto' && p.killfeedEvents) refitSync(p);
  }
  p.version = PROJECT_VERSION;
}

/** Scores, round intros and moments for the selected player. Keeps toggles/trims of moments that still exist. */
function analyzePlayer(p: Project) {
  const me = p.settings.steamId;
  scoreRounds(p.match.rounds, me);
  p.intros = existsSync(p.demoPath) ? findArrivals(p.demoPath, me, p.match.rounds, p.match.tickrate) : (p.intros ?? {});
  const old = new Map(p.moments.map((m) => [m.id, m]));
  p.moments = buildMoments(p.match, me, p.intros).map((m) => {
    const prev = old.get(m.id);
    return prev ? { ...m, enabled: prev.enabled, trimStart: prev.trimStart, trimEnd: prev.trimEnd } : m;
  });
}

function refitSync(p: Project) {
  p.sync = fitSync(syncAnchors(p), p.killfeedEvents!, p.match.tickrate, p.match.rounds.map((r) => r.num));
}

export function listProjects(): Pick<Project, 'id' | 'name' | 'createdAt'>[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')) as Project;
      return { id: p.id, name: p.name, createdAt: p.createdAt };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A captions or editing test: a recording without a demo, used whole. */
export const recordingOnly = (p: Pick<Project, 'mode'>) => p.mode === 'captions' || p.mode === 'edit';

/** A recording on its own (no demo): the whole video is the reel, so captions or the editor can be tried on any clip. */
export function createRecordingTest(videoPath: string, mode: 'captions' | 'edit'): Project {
  if (!existsSync(videoPath)) throw new Error(`File not found: ${videoPath}`);
  const settings = loadSettings();
  const p: Project = {
    id: randomUUID().slice(0, 8),
    version: PROJECT_VERSION,
    mode,
    name: `${mode === 'edit' ? 'Editing' : 'Captions'} test · ${basename(videoPath, extname(videoPath))}`,
    createdAt: new Date().toISOString(),
    videoPath,
    demoPath: '',
    video: probe(videoPath),
    settings: { ...settings, steamId: '', voiceTracks: null },
    match: { demoPath: '', map: '', tickrate: 64, players: [], rounds: [], kills: [], bombs: [], combat: [] },
    moments: [],
    sync: null,
    killfeedEvents: null,
    outputPath: null,
  };
  saveProject(p);
  return p;
}

export const clipsMode = (p: Pick<Project, 'mode'>) => p.mode === 'clips';

/** Lays the clips back to back: offsets, and `video` as the whole timeline (the first clip's format). */
function placeSources(p: Project, sources: Source[]) {
  let offset = 0;
  p.sources = sources.map((s) => {
    const placed = { ...s, offset };
    offset += s.info.duration;
    return placed;
  });
  p.video = { ...p.sources[0].info, duration: offset };
}

/** The clip playing at a timeline time. */
export function sourceAt(p: Project, t: number): Source {
  const all = p.sources ?? [];
  return all.filter((s) => s.offset <= t + 1e-6).at(-1) ?? all[0];
}

/** OBS replay clips without a demo, in the order given (oldest first). */
export function createClipsProject(paths: string[]): Project {
  if (paths.length === 0) throw new Error('Pick at least one clip');
  for (const f of paths) if (!existsSync(f)) throw new Error(`File not found: ${f}`);
  const settings = loadSettings();
  const p: Project = {
    id: randomUUID().slice(0, 8),
    version: PROJECT_VERSION,
    mode: 'clips',
    name: `Clips · ${basename(dirname(paths[0]))} (${paths.length})`,
    createdAt: new Date().toISOString(),
    videoPath: paths[0],
    demoPath: '',
    video: probe(paths[0]),
    settings: { ...settings, steamId: '', voiceTracks: null },
    match: { demoPath: '', map: '', tickrate: 64, players: [], rounds: [], kills: [], bombs: [], combat: [] },
    moments: [],
    sync: null,
    killfeedEvents: null,
    outputPath: null,
  };
  placeSources(
    p,
    paths.map((path) => ({ id: randomUUID().slice(0, 6), path, name: basename(path, extname(path)), info: probe(path), offset: 0, analysis: null })),
  );
  saveProject(p);
  return p;
}

/** Moments from every analysed clip. Keeps toggles/trims of moments that still exist. */
export function buildClipMoments(p: Project) {
  // round starts come from the saved HUD readings, so a better rule needs no new reading
  for (const s of p.sources ?? []) if (s.analysis) s.analysis.roundStarts = roundStartsFrom(s.analysis.hud);
  const old = new Map(p.moments.map((m) => [m.id, m]));
  p.moments = (p.sources ?? []).flatMap((s, i) =>
    clipMoments(s, i, p.settings).map((m) => {
      const prev = old.get(m.id);
      return prev ? { ...m, enabled: prev.enabled, trimStart: prev.trimStart, trimEnd: prev.trimEnd } : m;
    }),
  );
}

/**
 * Reads every clip that hasn't been read yet, all of them again (`'all'`), or
 * just the clips with the given ids. Each clip's result is saved as soon as
 * it's done, so a cancelled run keeps what it paid for. `save` gets each finished clip.
 */
export async function analyzeClips(
  p: Project,
  which: 'unread' | 'all' | string[],
  save: (src: Source) => void,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
) {
  const todo = (p.sources ?? []).filter((s) => (which === 'all' ? true : which === 'unread' ? !s.analysis : which.includes(s.id)));
  for (const [i, s] of todo.entries()) {
    const step = (f: number) => onProgress?.((i + f) / todo.length);
    try {
      s.analysis = await analyzeClip(s.path, s.info, p.settings, join(DATA_DIR, 'work', p.id, 'read'), step, signal);
      s.error = undefined;
      const u = s.analysis.usage;
      if (u.input) console.log(`read ${s.name}: ${u.input} input + ${u.output} output tokens`);
    } catch (e: any) {
      if (signal?.aborted) throw e;
      s.error = String(e?.message ?? e);
    }
    save(s);
  }
  return todo.length;
}

/** The editor's waveform for clips: each clip's peaks placed at its offset. */
export async function clipsPeaks(p: Project, outFile: string, onProgress?: (f: number) => void, signal?: AbortSignal) {
  const all = new Uint8Array(Math.ceil(p.video.duration * PEAKS_PER_SEC));
  const sources = p.sources ?? [];
  for (const [i, s] of sources.entries()) {
    const tmp = `${outFile}.${i}`;
    await computePeaks(s.path, s.info, tmp, (f) => onProgress?.((i + f) / sources.length), signal);
    const part = readPeaks(tmp)!;
    all.set(part.subarray(0, all.length - Math.round(s.offset * PEAKS_PER_SEC)), Math.round(s.offset * PEAKS_PER_SEC));
    rmSync(tmp, { force: true });
  }
  writeFileSync(outFile, all);
  return all.length;
}

export function createProject(videoPath: string, demoPath: string): Project {
  for (const f of [videoPath, demoPath]) if (!existsSync(f)) throw new Error(`File not found: ${f}`);
  const settings = loadSettings();
  const match = parseDemo(demoPath);
  // The remembered player only carries over if they're actually in this match.
  if (!match.players.some((pl) => pl.steamId === settings.steamId)) settings.steamId = '';
  const p: Project = {
    id: randomUUID().slice(0, 8),
    version: PROJECT_VERSION,
    name: `${match.map} · ${basename(videoPath, extname(videoPath))}`,
    createdAt: new Date().toISOString(),
    videoPath,
    demoPath,
    video: probe(videoPath),
    settings,
    match,
    moments: [],
    sync: null,
    killfeedEvents: null,
    outputPath: null,
  };
  if (settings.steamId) analyzePlayer(p);
  saveProject(p);
  return p;
}

export const hasPlayer = (p: Project) => p.match.players.some((pl) => pl.steamId === p.settings.steamId);

/**
 * Changing who "me" rebuilds scores, intros and moments. An auto sync is
 * re-fitted from the cached kill-feed scan, since its anchors were the old
 * player's kills; a manual sync doesn't depend on the player.
 */
export function setPlayer(p: Project, steamId: string) {
  p.settings.steamId = steamId;
  analyzePlayer(p);
  if (p.sync?.method === 'auto') {
    if (p.killfeedEvents) refitSync(p);
    else p.sync = null;
  }
  saveSettings({ ...loadSettings(), steamId });
}

/** My kills, deaths and assists: exactly the kill-feed entries that get the red outline. */
export function syncAnchors(p: Project): Anchor[] {
  const me = p.settings.steamId;
  return p.match.kills
    .filter((k) => k.attacker === me || k.victim === me || k.assister === me)
    .map((k) => ({ tick: k.tick, round: k.round }));
}

export async function autoSync(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<SyncModel> {
  if (!hasPlayer(p)) throw new Error('Pick your player first');
  if (syncAnchors(p).length === 0) throw new Error('No kills or deaths for the selected player in this demo');
  const { events } = await detectKillfeed(p.videoPath, p.video, p.settings.killfeed, onProgress, signal);
  p.killfeedEvents = events;
  p.sync = fitSync(syncAnchors(p), events, p.match.tickrate, p.match.rounds.map((r) => r.num));
  return p.sync;
}

/** The clips before the editor's cuts. */
export function baseClipsFor(p: Project): Clip[] {
  if (recordingOnly(p)) {
    return [{ round: 0, start: 0, end: p.video.duration, momentIds: [], label: 'Full recording' }];
  }
  if (clipsMode(p)) {
    const clips = planSourceClips(p.moments, p.sources ?? [], p.settings);
    return p.speech && p.settings.protectSpeech ? protectSpeech(clips, p.speech, p.settings, p.video.duration) : clips;
  }
  if (!p.sync) return [];
  return planClips(p.moments, p.sync, p.settings, p.video.duration, p.speech);
}

/** What gets rendered: the planned clips minus the editor's cuts. */
export const clipsFor = (p: Project): Clip[] => applyEdits(baseClipsFor(p), p.edits);

export const editsOf = (p: Project): Edits => p.edits ?? NO_EDITS;

/** Cached waveform of the whole recording, for the editor's timeline. */
// not under work/<id>: rendering clears that folder
export const peaksFile = (p: Project) => join(DATA_DIR, 'peaks', `${p.id}.u8`);

export const voiceTracks =(p: Project) => p.settings.voiceTracks ?? p.video.audio.map((_, i) => i);

export async function analyzeSpeech(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<Speech> {
  p.speech = clipsMode(p) ? await clipsSpeech(p, onProgress, signal) : await detectSpeech(p.videoPath, p.video, voiceTracks(p), onProgress, signal);
  return p.speech;
}

/** Speech in every clip, placed on the timeline at the clip's offset. A sentence never runs from one clip into the next. */
async function clipsSpeech(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<Speech> {
  const tracks = voiceTracks(p);
  const sources = p.sources ?? [];
  const out: Speech = { tracks, raw: [], utterances: [] };
  for (const [i, s] of sources.entries()) {
    const sp = await detectSpeech(s.path, s.info, tracks.filter((t) => t < s.info.audio.length), (f) => onProgress?.((i + f) / sources.length), signal);
    const shift = ([a, b]: [number, number]): [number, number] => [a + s.offset, b + s.offset];
    out.raw.push(...sp.raw.map(shift));
    out.utterances.push(...sp.utterances.map(shift));
  }
  return out;
}

const overlaps = (a: [number, number], clips: Clip[]) => clips.some((c) => a[1] > c.start && a[0] < c.end);

/** Caption lines for speech that's in the reel right now (removed lines left out). */
export function reelCaptions(p: Project, clips = clipsFor(p)): CaptionLine[] {
  return (p.transcript ?? []).filter((l) => !l.removed && overlaps([l.start, l.end], clips));
}

/**
 * Transcribes the speech inside the reel from scratch: every earlier line
 * (edited and removed ones too) is replaced.
 */
export async function transcribeProject(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal) {
  if (!p.speech) throw new Error('Speech detection has to finish first');
  if (!p.sync && !recordingOnly(p)) throw new Error('Sync the recording first');
  const clips = clipsFor(p);
  const wanted = p.speech.utterances.filter((u) => overlaps(u, clips));
  const fresh = await transcribe(p.videoPath, wanted, voiceTracks(p), join(DATA_DIR, 'work', p.id, 'whisper'), onProgress, signal);
  p.transcript = fresh.sort((a, b) => a.start - b.start);
  return p.transcript;
}

/** Snaps the word timing of the reel's caption lines that predate alignment to the voice audio. */
export async function alignProject(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal) {
  const todo = reelCaptions(p).filter((l) => !l.aligned);
  const aligned = new Map((await alignLines(p.videoPath, todo, voiceTracks(p), join(DATA_DIR, 'work', p.id, 'align'), onProgress, signal)).map((l) => [l.id, l]));
  p.transcript = (p.transcript ?? []).map((l) => aligned.get(l.id) ?? l);
  return aligned.size;
}

/** Rewrites the reel's caption lines with Claude (hand edits and already-cleaned lines are kept). */
export async function cleanupProject(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal) {
  const inReel = new Set(reelCaptions(p).map((l) => l.id));
  const cleaned = await cleanupCaptions((p.transcript ?? []).filter((l) => inReel.has(l.id)), onProgress, signal);
  const byId = new Map(cleaned.map((l) => [l.id, l]));
  p.transcript = (p.transcript ?? []).map((l) => byId.get(l.id) ?? l);
  return p.transcript;
}

/** Replaces a caption's text; the new words keep the old words' timing (see retime). */
export function editCaption(p: Project, id: string, text: string) {
  const line = p.transcript?.find((l) => l.id === id);
  if (!line) return;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  line.words = retime(line.words, tokens, line);
  line.edited = true;
}

/** ASS subtitles for one clip of the render, or null when captions are off or nothing is said. */
export function clipCaptions(p: Project) {
  const caps = p.settings.captions;
  if (!caps.enabled || !p.transcript?.length) return () => null;
  const font = resolveFont(caps.font);
  const lines = p.transcript.filter((l) => !l.removed);
  return (clip: Clip) => buildAss(lines, clip, p.video, caps, font);
}

export function defaultOutputPath(p: Project) {
  if (clipsMode(p)) return join(dirname(p.videoPath), `${basename(dirname(p.videoPath))}_highlights.mp4`);
  const suffix = p.mode === 'captions' ? '_captions' : p.mode === 'edit' ? '_edited' : '_highlights';
  return join(dirname(p.videoPath), `${basename(p.videoPath, extname(p.videoPath))}${suffix}.mp4`);
}

/**
 * The extras a match reel gets on export, by setting: cold open, replays,
 * halftime cards and the final scoreboard. Null for recording tests and clips
 * (no demo to take them from).
 */
export function matchExtras(p: Project, clips = clipsFor(p)) {
  if (recordingOnly(p) || clipsMode(p) || !p.sync || !hasPlayer(p)) return null;
  const st = p.settings;
  const me = st.steamId;
  const empty = new Map();
  return {
    coldOpen: st.coldOpen ? coldOpenPieces(p.moments, p.match, me, p.sync) : [],
    replays: st.replays ? replays(p.moments, p.match, me, p.sync) : (empty as ReturnType<typeof replays>),
    breaks: st.halftimeCard ? breakCards(sideSwitches(p.match, me), clips.map((c) => c.round)) : (empty as ReturnType<typeof breakCards>),
    stats: st.finalScoreboard ? matchStats(p.match, me, p.moments) : null,
  };
}

/** Seconds the extras add to the reel (shown with the reel length). */
export function extrasSeconds(x: ReturnType<typeof matchExtras>, clips: Clip[]) {
  if (!x) return 0;
  const rounds = new Set(clips.map((c) => c.round));
  const len = (c: Clip) => c.end - c.start;
  return (
    x.coldOpen.reduce((s, c) => s + len(c), 0) +
    [...x.replays].filter(([r]) => rounds.has(r)).reduce((s, [, c]) => s + len(c), 0) +
    x.breaks.size * BREAK_SECONDS +
    (x.stats ? SCOREBOARD_SECONDS : 0)
  );
}

export async function renderProject(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<string> {
  if (!p.sync && !recordingOnly(p) && !clipsMode(p)) throw new Error('Sync the recording first');
  const clips = clipsFor(p);
  if (clips.length === 0) throw new Error('No clips enabled');
  const cards = new Map<number, { title: string; subtitle: string }>();
  if (p.settings.titleCards && !recordingOnly(p)) {
    for (const c of clips) {
      cards.set(c.round, clipsMode(p) ? clipCardText(p.sources![c.round - 1], c.round - 1, p.moments) : roundCardText(p.match, c.round, p.moments));
    }
  }
  const outPath = p.outputPath ?? defaultOutputPath(p);
  const b = p.settings.branding;
  // a captions test is only for checking captions; everything else gets the channel's intro / outro
  const branded = p.mode !== 'captions' && !!b.name.trim();
  const target = reelTarget(p.video, encodeArgs(p.video));
  const bookend = (kind: BumperKind): Bookend => ({ dur: bumperSeconds(kind), file: (signal) => bumperFile(kind, b, target, BUMPER_CACHE, signal) });
  const x = matchExtras(p, clips);
  const st = p.settings;
  await renderReel(
    {
      videoPath: p.videoPath, info: p.video, clips, cards, outPath, workDir: join(DATA_DIR, 'work', p.id), captions: clipCaptions(p),
      sourceOf: clipsMode(p) ? (c) => sourceAt(p, c.start) : undefined,
      intro: branded && b.intro ? bookend('intro') : undefined,
      outro: branded && b.outro ? bookend('outro') : undefined,
      ...(x && {
        coldOpen: x.coldOpen,
        replays: x.replays,
        breaks: x.breaks,
        overlay: st.scoreOverlay
          ? (c: Clip) => scoreOverlay(overlayText(p.match, c.round), p.video.width, p.video.height, st.overlayCorner, b.accent, join(BUMPER_CACHE, 'overlay'))
          : undefined,
        ending: x.stats ? { dur: SCOREBOARD_SECONDS, file: (signal) => scoreboardFile(x.stats!, b.accent, target, BUMPER_CACHE, signal) } : undefined,
      }),
    },
    onProgress,
    signal,
  );
  p.outputPath = outPath;
  return outPath;
}
