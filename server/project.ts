import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDemo, scoreRounds } from './demo/parse.ts';
import { buildMoments } from './demo/moments.ts';
import { detectKillfeed } from './sync/killfeed.ts';
import { fitSync, type Anchor } from './sync/align.ts';
import { planClips, roundCardText } from './edit/plan.ts';
import { renderReel } from './edit/render.ts';
import { probe, type VideoInfo } from './util/ffmpeg.ts';
import { DEFAULT_SETTINGS, type MatchData, type Moment, type Settings, type SyncModel } from './types.ts';

export const DATA_DIR = resolve(process.env.CS2H_DATA ?? 'data');
const PROJECTS_DIR = join(DATA_DIR, 'projects');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  videoPath: string;
  demoPath: string;
  video: VideoInfo;
  settings: Settings;
  match: MatchData;
  moments: Moment[];
  sync: SyncModel | null;
  killfeedEvents: number[] | null;
  outputPath: string | null;
}

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) };
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
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
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

export function createProject(videoPath: string, demoPath: string): Project {
  for (const f of [videoPath, demoPath]) if (!existsSync(f)) throw new Error(`File not found: ${f}`);
  const settings = loadSettings();
  const match = parseDemo(demoPath);
  // The remembered player only carries over if they're actually in this match.
  if (!match.players.some((pl) => pl.steamId === settings.steamId)) settings.steamId = '';
  const p: Project = {
    id: randomUUID().slice(0, 8),
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
  if (settings.steamId) {
    scoreRounds(match.rounds, settings.steamId);
    p.moments = buildMoments(match, settings.steamId);
  }
  saveProject(p);
  return p;
}

export const hasPlayer = (p: Project) => p.match.players.some((pl) => pl.steamId === p.settings.steamId);

/**
 * Changing who "me" is rebuilds scores and moments (and drops manual toggles).
 * An auto sync is re-fitted from the cached kill-feed scan, since its anchors
 * were the old player's kills; a manual sync doesn't depend on the player.
 */
export function setPlayer(p: Project, steamId: string) {
  p.settings.steamId = steamId;
  scoreRounds(p.match.rounds, steamId);
  p.moments = buildMoments(p.match, steamId);
  if (p.sync?.method === 'auto') {
    p.sync = p.killfeedEvents
      ? fitSync(syncAnchors(p), p.killfeedEvents, p.match.tickrate, p.match.rounds.map((r) => r.num))
      : null;
  }
  saveSettings({ ...loadSettings(), steamId });
}

/** My kills and deaths: exactly the kill-feed entries that get the red outline. */
export function syncAnchors(p: Project): Anchor[] {
  const me = p.settings.steamId;
  return p.match.kills
    .filter((k) => k.attacker === me || k.victim === me)
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

export function clipsFor(p: Project) {
  if (!p.sync) return [];
  return planClips(p.moments, p.sync, p.settings, p.video.duration);
}

export function defaultOutputPath(p: Project) {
  return join(dirname(p.videoPath), `${basename(p.videoPath, extname(p.videoPath))}_highlights.mp4`);
}

export async function renderProject(p: Project, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<string> {
  if (!p.sync) throw new Error('Sync the recording first');
  const clips = clipsFor(p);
  if (clips.length === 0) throw new Error('No clips enabled');
  const cards = new Map<number, { title: string; subtitle: string }>();
  if (p.settings.titleCards) {
    for (const c of clips) cards.set(c.round, roundCardText(p.match, c.round, p.moments));
  }
  const outPath = p.outputPath ?? defaultOutputPath(p);
  await renderReel(
    { videoPath: p.videoPath, info: p.video, clips, cards, outPath, workDir: join(DATA_DIR, 'work', p.id) },
    onProgress,
    signal,
  );
  p.outputPath = outPath;
  return outPath;
}
