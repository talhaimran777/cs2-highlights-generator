import type { CaptionLine, CaptionSettings, CaptionWord, Clip, Edits, FeedKill, Kill, MatchData, Moment, Rect, Settings, Short, ShortLayout, Source, SyncModel } from '../../server/types.ts';
import type { VideoInfo } from '../../server/util/ffmpeg.ts';
import type { Job } from '../../server/jobs.ts';
import type { ExportSettings } from '../../server/edit/render.ts';

export type { CaptionLine, CaptionSettings, CaptionWord, Clip, Edits, FeedKill, Kill, Moment, Rect, Settings, Short, ShortLayout, Source, SyncModel, Job, ExportSettings };

export interface ProjectView {
  id: string;
  /** 'captions' / 'edit': a recording without a demo, used whole; 'clips': OBS replay clips back to back */
  mode?: 'match' | 'captions' | 'edit' | 'clips';
  /** clips mode: the clips, in timeline order */
  sources?: Source[];
  analyzeJob: Job | null;
  /** clips can be read (an Anthropic key is set) */
  readerAvailable: boolean;
  name: string;
  videoPath: string;
  demoPath: string;
  video: VideoInfo;
  settings: Settings;
  match: MatchData;
  moments: Moment[];
  sync: SyncModel | null;
  killfeedEvents: number[] | null;
  outputPath: string | null;
  /** what gets rendered: the planned clips minus the editor's cuts */
  clips: Clip[];
  /** the planned clips before the editor's cuts */
  baseClips: Clip[];
  edits: Edits;
  reelDuration: number;
  defaultOutputPath: string;
  /** false when the remembered player isn't in this match */
  hasPlayer: boolean;
  exportSettings: ExportSettings;
  speech?: { tracks: number[]; raw: [number, number][]; utterances: [number, number][] } | null;
  speechJob: Job | null;
  transcript?: CaptionLine[] | null;
  transcriptJob: Job | null;
  cleanupJob: Job | null;
  alignJob: Job | null;
  peaksJob: Job | null;
  /** caption lines for speech inside the current reel */
  reelCaptions: CaptionLine[];
  anchors: { tick: number; round: number }[];
  /** rounds (clip numbers in clips mode) with enough kills for a short */
  shortRounds: number[];
  shorts?: Short[];
}

/** A short with its pieces, as the short page needs it. */
export interface ShortView {
  short: Short;
  /** the round cut to its fights, before the short's edits */
  baseClips: Clip[];
  clips: Clip[];
  /** my kills in the round, for the short's kill feed */
  kills: FeedKill[];
  duration: number;
  /** where a looping short is cut (recording seconds): it opens there and ends right before it; null = it doesn't loop */
  loopCut: number | null;
  /** the short's size in pixels (9:16) */
  frame: { width: number; height: number };
  defaultOutputPath: string;
  renderJob: Job | null;
}

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  mtime?: number;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  // Fastify's own error bodies put the reason in `message` and the status text in `error`.
  if (!r.ok) throw new Error(data.message ?? data.error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export const api = {
  health: () => req<{ ffmpeg: { ok: boolean; version?: string }; nvenc: boolean; settings: Settings }>('GET', '/api/health'),
  fs: (path = '') => req<{ path: string; parent: string | null; entries: FsEntry[] }>('GET', `/api/fs?path=${encodeURIComponent(path)}`),
  projects: () => req<{ id: string; name: string; createdAt: string }[]>('GET', '/api/projects'),
  create: (videoPath: string, demoPath: string) => req<ProjectView>('POST', '/api/projects', { videoPath, demoPath }),
  createCaptionTest: (videoPath: string) => req<ProjectView>('POST', '/api/projects/captions-test', { videoPath }),
  createEditTest: (videoPath: string) => req<ProjectView>('POST', '/api/projects/edit-test', { videoPath }),
  createClips: (paths: string[], playerName: string) => req<ProjectView>('POST', '/api/projects/clips', { paths, playerName }),
  /** reads the unread clips, all of them `again`, or just the clips `ids` */
  analyze: (id: string, again = false, ids?: string[]) => req<Job>('POST', `/api/projects/${id}/analyze`, { again, ids }),
  get: (id: string) => req<ProjectView>('GET', `/api/projects/${id}`),
  patch: (id: string, body: object) => req<ProjectView>('PATCH', `/api/projects/${id}`, body),
  autoSync: (id: string) => req<Job>('POST', `/api/projects/${id}/sync/auto`),
  manualSync: (id: string, tick: number, videoSec: number) =>
    req<ProjectView>('POST', `/api/projects/${id}/sync/manual`, { tick, videoSec }),
  nudge: (id: string, delta: number, round?: number) => req<ProjectView>('POST', `/api/projects/${id}/sync/nudge`, { delta, round }),
  render: (id: string) => req<Job>('POST', `/api/projects/${id}/render`),
  detectSpeech: (id: string) => req<Job>('POST', `/api/projects/${id}/speech`),
  transcribe: (id: string) => req<Job>('POST', `/api/projects/${id}/transcribe`),
  startPeaks: (id: string) => req<Job>('POST', `/api/projects/${id}/peaks`),
  /** waveform bytes (100 per second of recording), or null while it's being computed */
  peaks: async (id: string) => {
    const r = await fetch(`/api/projects/${id}/peaks`);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  },
  captionsStatus: () => req<{ ok: boolean; missing: string[]; fonts: string[]; cleanup: boolean }>('GET', '/api/captions/status'),
  alignCaptions: (id: string) => req<Job>('POST', `/api/projects/${id}/captions/align`),
  cleanupCaptions: (id: string) => req<Job>('POST', `/api/projects/${id}/captions/cleanup`),
  /** the round's short (made on first use) */
  createShort: (id: string, round: number) => req<ShortView>('POST', `/api/projects/${id}/shorts`, { round }),
  short: (id: string, sid: string) => req<ShortView>('GET', `/api/projects/${id}/shorts/${sid}`),
  patchShort: (
    id: string,
    sid: string,
    body: {
      edits?: Edits;
      layout?: ShortLayout;
      outputPath?: string;
      captions?: Partial<Settings['shortCaptions']>;
      killfeed?: Partial<Settings['shortKillfeed']>;
      overlay?: Partial<Settings['shortOverlay']>;
      loop?: Partial<Settings['shortLoop']>;
    },
  ) =>
    req<ShortView>('PATCH', `/api/projects/${id}/shorts/${sid}`, body),
  /** the game's own kill-feed entry for each kill of the short (time order), null where none was found */
  shortFeed: (id: string, sid: string) => req<({ url: string; w: number; h: number } | null)[]>('GET', `/api/projects/${id}/shorts/${sid}/feed`),
  renderShort: (id: string, sid: string) => req<Job>('POST', `/api/projects/${id}/shorts/${sid}/render`),
  job: (id: string) => req<Job | null>('GET', `/api/jobs/${id}`),
  cancel: (id: string) => req('DELETE', `/api/jobs/${id}`),
};

export function videoTime(sync: SyncModel, tick: number, round: number) {
  return (sync.roundOffsets[round] ?? sync.offset) + sync.scale * (tick / sync.tickrate);
}

/** Where a timeline time plays: which file, and how far into it. */
export interface Located {
  src: string;
  /** timeline time where that file starts */
  offset: number;
}

/** The project's media for a timeline time: the recording, or in clips mode the clip playing then. */
export function locator(p: Pick<ProjectView, 'id' | 'sources'>) {
  const whole = { src: `/api/projects/${p.id}/media`, offset: 0 };
  const sources = p.sources ?? [];
  return (t: number): Located => {
    const s = sources.filter((x) => x.offset <= t + 1e-6).at(-1) ?? sources[0];
    return s ? { src: `/api/projects/${p.id}/media?source=${s.id}`, offset: s.offset } : whole;
  };
}

export function fmtTime(sec: number) {
  if (!isFinite(sec)) return '–';
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Polls a job until it finishes. */
export async function waitJob(id: string, onProgress: (j: Job) => void): Promise<Job> {
  for (;;) {
    const j = await api.job(id);
    if (!j) throw new Error('Job disappeared (server restarted?)');
    onProgress(j);
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 700));
  }
}
