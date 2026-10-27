import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { cancelJob, getJob, startJob } from './jobs.ts';
import {
  autoSync, clipsFor, createProject, defaultOutputPath, getProject, hasPlayer, listProjects, loadSettings, renderProject,
  saveProject, saveSettings, setPlayer, syncAnchors, type Project,
} from './project.ts';
import { manualSync } from './sync/align.ts';
import { totalDuration } from './edit/plan.ts';
import { exportSettings } from './edit/render.ts';
import { checkFfmpeg, hasNvenc } from './util/ffmpeg.ts';
import type { Settings } from './types.ts';

const PORT = Number(process.env.PORT ?? 5174);
const VIDEO_EXT = ['.mp4', '.mkv', '.mov', '.flv', '.ts'];
const DEMO_EXT = ['.dem', '.zst', '.gz'];

const app = Fastify({ logger: { level: 'warn' } });

// Must be set before the routes: Fastify binds each route to the handler in place when it's declared.
app.setErrorHandler((err: any, _req, reply) => {
  console.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message || String(err) });
});

function load(id: string): Project {
  const p = getProject(id);
  if (!p) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  return p;
}

/** What the UI needs: the project minus heavy fields, plus derived clips. */
function view(p: Project) {
  const clips = clipsFor(p);
  return {
    ...p,
    clips,
    reelDuration: totalDuration(clips),
    defaultOutputPath: defaultOutputPath(p),
    hasPlayer: hasPlayer(p),
    exportSettings: exportSettings(p.video),
    anchors: hasPlayer(p) ? syncAnchors(p) : [],
  };
}

app.get('/api/health', async () => ({ ffmpeg: checkFfmpeg(), nvenc: hasNvenc(), settings: loadSettings() }));

/** Minimal local file browser: the browser can't hand us real paths. */
app.get<{ Querystring: { path?: string } }>('/api/fs', async (req) => {
  const path = req.query.path;
  if (!path) {
    const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`).filter((d) => existsSync(d));
    return { path: '', parent: null, entries: drives.map((d) => ({ name: d, path: d, dir: true })) };
  }
  const abs = resolve(path);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('$'))
    .flatMap((e) => {
      const full = join(abs, e.name);
      if (e.isDirectory()) return [{ name: e.name, path: full, dir: true }];
      const ext = extname(e.name).toLowerCase();
      if (!VIDEO_EXT.includes(ext) && !DEMO_EXT.includes(ext)) return [];
      try {
        const st = statSync(full);
        return [{ name: e.name, path: full, dir: false, size: st.size, mtime: st.mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = resolve(abs, '..');
  return { path: abs, parent: parent === abs ? '' : parent, entries };
});

app.get('/api/projects', async () => listProjects());

app.post<{ Body: { videoPath: string; demoPath: string } }>('/api/projects', async (req) => {
  return view(createProject(req.body.videoPath, req.body.demoPath));
});

app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => view(load(req.params.id)));

app.patch<{
  Params: { id: string };
  Body: {
    steamId?: string;
    settings?: Partial<Settings>;
    moments?: Record<string, { enabled?: boolean; trimStart?: number; trimEnd?: number }>;
    outputPath?: string;
  };
}>('/api/projects/:id', async (req) => {
  const p = load(req.params.id);
  const { steamId, settings, moments, outputPath } = req.body;
  if (steamId && steamId !== p.settings.steamId) setPlayer(p, steamId);
  if (settings) {
    p.settings = { ...p.settings, ...settings, steamId: p.settings.steamId };
    const { steamId: _, ...shared } = p.settings;
    saveSettings({ ...loadSettings(), ...shared });
  }
  for (const [id, patch] of Object.entries(moments ?? {})) {
    const m = p.moments.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
  }
  if (outputPath !== undefined) p.outputPath = outputPath || null;
  saveProject(p);
  return view(p);
});

app.post<{ Params: { id: string } }>('/api/projects/:id/sync/auto', async (req) => {
  const id = req.params.id;
  return startJob('sync', id, async (progress, signal) => {
    const working = load(id);
    await autoSync(working, progress, signal);
    // re-read so edits made while scanning aren't overwritten
    const p = load(id);
    p.sync = working.sync;
    p.killfeedEvents = working.killfeedEvents;
    saveProject(p);
    return p.sync;
  });
});

app.post<{ Params: { id: string }; Body: { tick: number; videoSec: number } }>(
  '/api/projects/:id/sync/manual',
  async (req) => {
    const p = load(req.params.id);
    p.sync = manualSync(req.body.tick, req.body.videoSec, p.match.tickrate);
    saveProject(p);
    return view(p);
  },
);

/** Shift one round (or everything, when round is omitted) by delta seconds. */
app.post<{ Params: { id: string }; Body: { delta: number; round?: number } }>(
  '/api/projects/:id/sync/nudge',
  async (req) => {
    const p = load(req.params.id);
    if (!p.sync) throw Object.assign(new Error('Not synced yet'), { statusCode: 400 });
    const { delta, round } = req.body;
    if (round === undefined) {
      p.sync.offset += delta;
      for (const r of Object.keys(p.sync.roundOffsets)) p.sync.roundOffsets[Number(r)] += delta;
    } else {
      p.sync.roundOffsets[round] = (p.sync.roundOffsets[round] ?? p.sync.offset) + delta;
    }
    saveProject(p);
    return view(p);
  },
);

app.post<{ Params: { id: string } }>('/api/projects/:id/render', async (req) => {
  const id = req.params.id;
  return startJob('render', id, async (progress, signal) => {
    const out = await renderProject(load(id), progress, signal);
    const p = load(id);
    p.outputPath = out;
    saveProject(p);
    return out;
  });
});

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => getJob(req.params.id));
app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
  cancelJob(req.params.id);
  return { ok: true };
});

/** Range-capable streaming so the <video> preview can seek a multi-GB recording. */
function streamFile(path: string, range: string | undefined, reply: any) {
  const size = statSync(path).size;
  const type = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' }[extname(path).toLowerCase()] ?? 'video/mp4';
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    reply.header('Content-Length', size).header('Accept-Ranges', 'bytes').type(type);
    return reply.send(createReadStream(path));
  }
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : Math.min(start + 8 * 1024 * 1024, size - 1);
  reply
    .code(206)
    .header('Content-Range', `bytes ${start}-${end}/${size}`)
    .header('Accept-Ranges', 'bytes')
    .header('Content-Length', end - start + 1)
    .type(type);
  return reply.send(createReadStream(path, { start, end }));
}

app.get<{ Params: { id: string } }>('/api/projects/:id/media', (req, reply) =>
  streamFile(load(req.params.id).videoPath, req.headers.range, reply),
);
app.get<{ Params: { id: string } }>('/api/projects/:id/output', (req, reply) => {
  const p = load(req.params.id);
  if (!p.outputPath || !existsSync(p.outputPath)) return reply.code(404).send({ error: 'Not rendered yet' });
  return streamFile(p.outputPath, req.headers.range, reply);
});

const webDist = resolve('dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send() : reply.sendFile('index.html')));
}


await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`CS2 Highlights → http://localhost:${existsSync(webDist) ? PORT : 5173}`);
