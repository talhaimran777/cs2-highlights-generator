import type { Clip, Kill, MatchData, Moment, Settings, SyncModel } from '../../server/types.ts';
import type { VideoInfo } from '../../server/util/ffmpeg.ts';
import type { Job } from '../../server/jobs.ts';
import type { ExportSettings } from '../../server/edit/render.ts';

export type { Clip, Kill, Moment, Settings, SyncModel, Job, ExportSettings };

export interface ProjectView {
  id: string;
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
  clips: Clip[];
  reelDuration: number;
  defaultOutputPath: string;
  /** false when the remembered player isn't in this match */
  hasPlayer: boolean;
  exportSettings: ExportSettings;
  speech?: { tracks: number[]; raw: [number, number][]; utterances: [number, number][] } | null;
  speechJob: Job | null;
  anchors: { tick: number; round: number }[];
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
  get: (id: string) => req<ProjectView>('GET', `/api/projects/${id}`),
  patch: (id: string, body: object) => req<ProjectView>('PATCH', `/api/projects/${id}`, body),
  autoSync: (id: string) => req<Job>('POST', `/api/projects/${id}/sync/auto`),
  manualSync: (id: string, tick: number, videoSec: number) =>
    req<ProjectView>('POST', `/api/projects/${id}/sync/manual`, { tick, videoSec }),
  nudge: (id: string, delta: number, round?: number) => req<ProjectView>('POST', `/api/projects/${id}/sync/nudge`, { delta, round }),
  render: (id: string) => req<Job>('POST', `/api/projects/${id}/render`),
  detectSpeech: (id: string) => req<Job>('POST', `/api/projects/${id}/speech`),
  job: (id: string) => req<Job | null>('GET', `/api/jobs/${id}`),
  cancel: (id: string) => req('DELETE', `/api/jobs/${id}`),
};

export function videoTime(sync: SyncModel, tick: number, round: number) {
  return (sync.roundOffsets[round] ?? sync.offset) + sync.scale * (tick / sync.tickrate);
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
