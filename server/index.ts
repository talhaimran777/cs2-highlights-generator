import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { cancelJob, getJob, latestJob, startJob } from './jobs.ts';
import {
  analyzeSpeech, autoSync, clipsFor, createCaptionTest, createProject, defaultOutputPath, editCaption, getProject, hasPlayer, listProjects, loadSettings,
  reelCaptions, renderProject, saveProject, saveSettings, setPlayer, syncAnchors, transcribeProject, type Project,
} from './project.ts';
import { captionsReady } from './captions/transcribe.ts';
import { availableFonts, fontFile } from './captions/fonts.ts';
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
    speechJob: latestJob(p.id, 'speech'),
    transcriptJob: latestJob(p.id, 'transcribe'),
    reelCaptions: reelCaptions(p, clips),
    anchors: hasPlayer(p) ? syncAnchors(p) : [],
  };
}

app.get('/api/health', async () => ({ ffmpeg: checkFfmpeg(), nvenc: hasNvenc(), settings: loadSettings() }));

app.get('/api/captions/status', async () => ({ ...captionsReady(), fonts: availableFonts() }));

/** Caption fonts for the in-app preview (same files libass burns in). */
app.get<{ Params: { name: string } }>('/api/fonts/:name', (req, reply) => {
  const file = fontFile(req.params.name);
  if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Font not installed' });
  reply.type('font/ttf').header('Cache-Control', 'max-age=86400');
  return reply.send(createReadStream(file));
});

app.post<{ Params: { id: string } }>('/api/projects/:id/transcribe', async (req) => {
  const id = load(req.params.id).id;
  return startJob('transcribe', id, async (progress, signal) => {
    const working = load(id);
    await transcribeProject(working, progress, signal);
    const p = load(id); // keep edits made meanwhile
    const edited = new Map((p.transcript ?? []).filter((l) => l.edited).map((l) => [l.id, l]));
    p.transcript = working.transcript!.map((l) => edited.get(l.id) ?? l);
    saveProject(p);
    return p.transcript.length;
  });
});

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

/** Speech detection runs in the background; the planner uses it once it's there. */
function startSpeechJob(id: string) {
  return startJob('speech', id, async (progress, signal) => {
    const working = load(id);
    await analyzeSpeech(working, progress, signal);
    const p = load(id); // keep edits made meanwhile
    p.speech = working.speech;
    saveProject(p);
    return p.speech!.utterances.length;
  });
}

app.post<{ Body: { videoPath: string; demoPath: string } }>('/api/projects', async (req) => {
  const p = createProject(req.body.videoPath, req.body.demoPath);
  startSpeechJob(p.id);
  return view(p);
});

app.post<{ Params: { id: string } }>('/api/projects/:id/speech', async (req) => startSpeechJob(load(req.params.id).id));

/** Captions test: just a recording, no demo; the whole video gets captioned. */
app.post<{ Body: { videoPath: string } }>('/api/projects/captions-test', async (req) => {
  const p = createCaptionTest(req.body.videoPath);
  startSpeechJob(p.id);
  return view(p);
});

app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => view(load(req.params.id)));

app.patch<{
  Params: { id: string };
  Body: {
    steamId?: string;
    settings?: Partial<Settings>;
    moments?: Record<string, { enabled?: boolean; trimStart?: number; trimEnd?: number }>;
    /** caption line id -> new text */
    captions?: Record<string, string>;
    outputPath?: string;
  };
}>('/api/projects/:id', async (req) => {
  const p = load(req.params.id);
  const { steamId, settings, moments, outputPath, captions } = req.body;
  for (const [id, text] of Object.entries(captions ?? {})) editCaption(p, id, text);
  if (steamId && steamId !== p.settings.steamId) setPlayer(p, steamId);
  let redetectSpeech = false;
  if (settings) {
    redetectSpeech = 'voiceTracks' in settings && JSON.stringify(settings.voiceTracks) !== JSON.stringify(p.settings.voiceTracks);
    p.settings = { ...p.settings, ...settings, steamId: p.settings.steamId };
    // steamId and voice tracks belong to this match; the rest are defaults for the next one
    const { steamId: _, voiceTracks: __, ...shared } = p.settings;
    saveSettings({ ...loadSettings(), ...shared });
    if (redetectSpeech) {
      // new voice tracks, new speech: drop lines transcribed from the old tracks (keep hand edits)
      p.speech = null;
      p.transcript = (p.transcript ?? []).filter((l) => l.edited);
    }
  }
  for (const [id, patch] of Object.entries(moments ?? {})) {
    const m = p.moments.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
  }
  if (outputPath !== undefined) p.outputPath = outputPath || null;
  saveProject(p);
  if (redetectSpeech) startSpeechJob(p.id);
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
