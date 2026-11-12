import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { cancelJob, getJob, latestJob, startJob } from './jobs.ts';
import {
  alignProject, analyzeSpeech, autoSync, cleanupProject, baseClipsFor, clipsFor, createProject, createRecordingTest, defaultOutputPath, editCaption, editsOf, getProject, hasPlayer, listProjects,
  BUMPER_CACHE, loadSettings, peaksFile, reelCaptions, renderProject, saveProject, saveSettings, setPlayer, syncAnchors, transcribeProject, type Project,
  analyzeClips, buildClipMoments, clipsMode, clipsPeaks, createClipsProject, readsKillfeed, sourceAt,
  titlesPossible, writeTitles, writeShortTitles, projectTeaser, openingPath,
  baseShortClips, createDirectShort, createShort, defaultShortPath, feedImagesDir, findShort, renderShort, shortClipsFor, shortFeedImages, shortKills, shortLoopOrder, shortRounds,
} from './project.ts';
import { fitLayout, shortFrame } from './shorts/layout.ts';
import { readerAvailable } from './clips/read.ts';
import { captionsReady } from './captions/transcribe.ts';
import { cleanupAvailable } from './captions/cleanup.ts';
import { titlesAvailable } from './titles/generate.ts';
import { assScale, availableFonts, fontFile, fontMetrics } from './captions/fonts.ts';
import { TITLE_PRESETS } from './shorts/title.ts';
import { manualSync } from './sync/align.ts';
import { totalDuration } from './edit/plan.ts';
import { normalizeCuts } from './edit/edits.ts';
import { computePeaks, PEAKS_PER_SEC, readPeaks } from './audio/peaks.ts';
import { exportSettings } from './edit/render.ts';
import { checkFfmpeg, FFMPEG, hasNvenc } from './util/ffmpeg.ts';
import { spawn } from 'node:child_process';

/** seconds of a track played when listening for the mic */
const TRACK_SAMPLE_S = 8;
import { bumperFile, PREVIEW_TARGET } from './branding/bumper.ts';
import type { CaptionLine, Edits, Settings, Short, ShortLayout } from './types.ts';

// ANTHROPIC_API_KEY (caption cleanup) can live in .env, so it works without a system-wide variable
if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number(process.env.PORT ?? 5174);
const VIDEO_EXT = ['.mp4', '.mkv', '.mov', '.flv', '.ts'];
const DEMO_EXT = ['.dem', '.zst', '.gz'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

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
    baseClips: baseClipsFor(p),
    edits: editsOf(p),
    reelDuration: totalDuration(clips),
    // the cold open's opening-only test render, its last run
    openingJob: latestJob(p.id, 'render-opening'),
    openingPath: openingPath(p),
    // the cold open's moments (what it would be, even while it's off)
    teaser: projectTeaser(p, true),
    defaultOutputPath: defaultOutputPath(p),
    hasPlayer: hasPlayer(p),
    exportSettings: exportSettings(p.video),
    speechJob: latestJob(p.id, 'speech'),
    transcriptJob: latestJob(p.id, 'transcribe'),
    cleanupJob: latestJob(p.id, 'cleanup'),
    alignJob: latestJob(p.id, 'align'),
    peaksJob: latestJob(p.id, 'peaks'),
    analyzeJob: latestJob(p.id, 'analyze'),
    readerAvailable: readerAvailable(),
    titlesJob: latestJob(p.id, 'titles'),
    titlesPossible: titlesPossible(p),
    titlesAvailable: titlesAvailable(),
    // global, not this project's copy: the same profile for every match
    creatorProfile: loadSettings().creatorProfile,
    reelCaptions: reelCaptions(p, clips),
    anchors: hasPlayer(p) ? syncAnchors(p) : [],
    shortRounds: shortRounds(p),
  };
}

/** Edits from the editor, kept inside the recording and normalized. */
function cleanEdits(p: Project, edits: Edits): Edits {
  const inside = (t: number) => Math.min(p.video.duration, Math.max(0, Number(t) || 0));
  return {
    cuts: normalizeCuts((edits.cuts ?? []).map(([a, b]) => [inside(a), inside(b)])),
    splits: [...new Set((edits.splits ?? []).map(inside))].sort((a, b) => a - b),
    adds: normalizeCuts((edits.adds ?? []).map(([a, b]) => [inside(a), inside(b)])),
  };
}

app.get('/api/health',async () => ({ ffmpeg: checkFfmpeg(), nvenc: hasNvenc(), settings: loadSettings() }));

app.get('/api/captions/status', async () => ({ ...captionsReady(), fonts: availableFonts(), cleanup: cleanupAvailable() }));

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
    const p = load(id); // keep other changes made meanwhile; the captions start fresh
    p.transcript = working.transcript!;
    saveProject(p);
    if (cleanupAvailable() && p.settings.captions.cleanup) startCleanupJob(id);
    return p.transcript.length;
  });
});

/** A background job's caption lines, with hand edits and removals made while it ran kept. */
function keepUserChanges(fromJob: CaptionLine[], now: CaptionLine[] | null = []): CaptionLine[] {
  const edited = new Map((now ?? []).filter((l) => l.edited).map((l) => [l.id, l]));
  const removed = new Set((now ?? []).filter((l) => l.removed).map((l) => l.id));
  return fromJob.map((l) => {
    const line = edited.get(l.id) ?? l;
    return removed.has(l.id) ? { ...line, removed: true } : line;
  });
}

/** Claude rewrites the caption lines into natural Roman Urdu / English. */
function startCleanupJob(id: string) {
  return startJob('cleanup', id, async (progress, signal) => {
    const working = load(id);
    await cleanupProject(working, progress, signal);
    const p = load(id); // keep edits made meanwhile
    p.transcript = keepUserChanges(working.transcript!, p.transcript);
    saveProject(p);
    return p.transcript.filter((l) => l.cleaned).length;
  });
}

/** Snaps older caption lines' word timing to the voice audio. */
app.post<{ Params: { id: string } }>('/api/projects/:id/captions/align', async (req) => {
  const id = load(req.params.id).id;
  return startJob('align', id, async (progress, signal) => {
    const working = load(id);
    const n = await alignProject(working, progress, signal);
    const byId = new Map(working.transcript!.map((l) => [l.id, l]));
    const p = load(id);
    // a line edited or removed meanwhile keeps that change; its new timing is used if the text is the same
    const text = (l: CaptionLine) => l.words.map((w) => w.text).join(' ');
    p.transcript = (p.transcript ?? []).map((l) => {
      const a = byId.get(l.id);
      return a?.aligned && text(a) === text(l) ? { ...l, words: a.words, aligned: true } : l;
    });
    saveProject(p);
    return n;
  });
});

app.post<{ Params: { id: string } }>('/api/projects/:id/captions/cleanup', async (req) => {
  if (!cleanupAvailable()) throw Object.assign(new Error('Set ANTHROPIC_API_KEY and restart the app to use caption cleanup'), { statusCode: 400 });
  return startCleanupJob(load(req.params.id).id);
});

/** Claude writes YouTube titles for the highlight video from the match story. */
app.post<{ Params: { id: string }; Body: { direction?: string } }>('/api/projects/:id/titles', async (req) => {
  if (!titlesAvailable()) throw Object.assign(new Error('Set ANTHROPIC_API_KEY and restart the app to write titles'), { statusCode: 400 });
  const id = load(req.params.id).id;
  const direction = String(req.body?.direction ?? '').slice(0, 300);
  return startJob('titles', id, async (_progress, signal) => {
    const titles = await writeTitles(load(id), direction, signal);
    const p = load(id); // keep changes made meanwhile
    p.titles = titles;
    saveProject(p);
    return titles.ideas.length;
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
      if (!VIDEO_EXT.includes(ext) && !DEMO_EXT.includes(ext) && !IMAGE_EXT.includes(ext)) return [];
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
  // with several tracks, speech waits until the voice tracks are ticked in Sync
  if (p.settings.voiceTracks === null) startSpeechJob(p.id);
  startPeaksJob(p.id);
  return view(p);
});

app.post<{ Params: { id: string } }>('/api/projects/:id/speech', async (req) => startSpeechJob(load(req.params.id).id));

/** Waveform for the editor's timeline; computed once per recording. */
function startPeaksJob(id: string) {
  return startJob('peaks', id, async (progress, signal) => {
    const p = load(id);
    if (clipsMode(p)) return clipsPeaks(p, peaksFile(p), progress, signal);
    return computePeaks(p.videoPath, p.video, peaksFile(p), progress, signal);
  });
}

app.post<{ Params: { id: string } }>('/api/projects/:id/peaks', async (req) => startPeaksJob(load(req.params.id).id));

/** Raw peaks, one byte per 1/PEAKS_PER_SEC s of the recording. */
app.get<{ Params: { id: string } }>('/api/projects/:id/peaks', (req, reply) => {
  const data = readPeaks(peaksFile(load(req.params.id)));
  if (!data) return reply.code(404).send({ error: 'Waveform not ready' });
  reply.type('application/octet-stream').header('X-Peaks-Per-Sec', String(PEAKS_PER_SEC));
  return reply.send(data);
});

/** Captions test: just a recording, no demo; the whole video gets captioned. */
app.post<{ Body: { videoPath: string } }>('/api/projects/captions-test', async (req) => {
  const p = createRecordingTest(req.body.videoPath, 'captions');
  startSpeechJob(p.id);
  return view(p);
});

/** Editing test: just a recording, no demo; the whole video goes into the editor. */
app.post<{ Body: { videoPath: string } }>('/api/projects/edit-test', async (req) => {
  const p = createRecordingTest(req.body.videoPath, 'edit');
  startSpeechJob(p.id);
  startPeaksJob(p.id);
  return view(p);
});

/**
 * Replay clips, no demo, into one video: CS2 clips with `readKillfeed` (each clip's last round with
 * kills, read by Claude); any game without it (every clip whole).
 */
app.post<{ Body: { paths: string[]; playerName?: string; readKillfeed?: boolean } }>('/api/projects/clips', async (req) => {
  const read = req.body.readKillfeed !== false;
  if (read && req.body.playerName !== undefined) saveSettings({ ...loadSettings(), playerName: req.body.playerName.trim() });
  const p = createClipsProject(req.body.paths ?? [], read);
  startSpeechJob(p.id);
  startPeaksJob(p.id);
  return view(p);
});

/**
 * One clip straight into a short: the clip opens in the short editor at once
 * (the whole clip); with `readKillfeed` (CS2), its kill feed is read in the background when Claude can.
 */
app.post<{ Body: { path: string; playerName?: string; readKillfeed?: boolean } }>('/api/projects/short', async (req) => {
  const read = req.body.readKillfeed !== false;
  if (read && req.body.playerName !== undefined) saveSettings({ ...loadSettings(), playerName: req.body.playerName.trim() });
  const { project: p, short } = createDirectShort(req.body.path ?? '', read);
  startSpeechJob(p.id);
  startPeaksJob(p.id);
  if (read && readerAvailable()) startAnalyzeJob(p.id, 'unread');
  return { id: p.id, shortId: short.id };
});

/** Reads the clips (kill feed and round timer): the unread ones, all `again`, or just the clips `ids`. */
app.post<{ Params: { id: string }; Body: { again?: boolean; ids?: string[] } }>('/api/projects/:id/analyze', async (req) => {
  const id = load(req.params.id).id;
  if (!readsKillfeed(load(id))) throw Object.assign(new Error('This project doesn’t read the kill feed'), { statusCode: 400 });
  if (!readerAvailable()) throw Object.assign(new Error('Set ANTHROPIC_API_KEY and restart the app to read clips'), { statusCode: 400 });
  return startAnalyzeJob(id, req.body?.ids?.length ? req.body.ids : req.body?.again ? 'all' : 'unread');
});

function startAnalyzeJob(id: string, which: 'unread' | 'all' | string[]) {
  return startJob('analyze', id, async (progress, signal) => {
    const working = load(id);
    return analyzeClips(
      working,
      which,
      (src) => {
        // save each clip as it finishes, keeping changes made meanwhile
        const p = load(id);
        p.sources = p.sources!.map((s) => (s.id === src.id ? { ...s, analysis: src.analysis, error: src.error } : s));
        buildClipMoments(p);
        saveProject(p);
      },
      progress,
      signal,
    );
  });
}

app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => view(load(req.params.id)));

app.patch<{
  Params: { id: string };
  Body: {
    steamId?: string;
    settings?: Partial<Settings>;
    moments?: Record<string, { enabled?: boolean; trimStart?: number; trimEnd?: number }>;
    /** caption line id -> new text */
    captions?: Record<string, string>;
    /** caption line id -> true to leave it out of the captions, false to bring it back */
    removeCaptions?: Record<string, boolean>;
    edits?: Edits;
    outputPath?: string;
  };
}>('/api/projects/:id', async (req) => {
  const p = load(req.params.id);
  const { steamId, settings, moments, outputPath, captions, removeCaptions, edits } = req.body;
  for (const [id, text] of Object.entries(captions ?? {})) editCaption(p, id, text);
  for (const [id, removed] of Object.entries(removeCaptions ?? {})) {
    const line = p.transcript?.find((l) => l.id === id);
    if (line) line.removed = removed || undefined;
  }
  if (steamId && steamId !== p.settings.steamId) setPlayer(p, steamId);
  let redetectSpeech = false;
  if (settings) {
    redetectSpeech = 'voiceTracks' in settings && JSON.stringify(settings.voiceTracks) !== JSON.stringify(p.settings.voiceTracks);
    p.settings = { ...p.settings, ...settings, steamId: p.settings.steamId };
    // steamId and voice tracks belong to this match; the rest are defaults for the next one
    // (a short's layout and captions are saved by the short, so this project's older copy never overwrites them)
    const { steamId: _, voiceTracks: __, shortLayout: ___, shortCaptions: ____, shortKillfeed: _____, shortOverlay: ______, shortLoop: _______, shortTitle: ________, ...shared } = p.settings;
    saveSettings({ ...loadSettings(), ...shared });
    if (redetectSpeech) {
      // new voice tracks, new speech: drop lines transcribed from the old tracks (keep hand edits)
      p.speech = null;
      p.transcript = (p.transcript ?? []).filter((l) => l.edited);
    }
    if (clipsMode(p)) buildClipMoments(p); // the burst gap splits kills differently
  }
  for (const [id, patch] of Object.entries(moments ?? {})) {
    const m = p.moments.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
  }
  if (edits) p.edits = cleanEdits(p, edits);
  if (outputPath !== undefined) p.outputPath = outputPath || null;
  saveProject(p);
  if (redetectSpeech && p.settings.voiceTracks?.length !== 0) startSpeechJob(p.id);
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

// ?only=opening: just the cold open (and the intro after it), to try its look out quickly
app.post<{ Params: { id: string }; Querystring: { only?: string } }>('/api/projects/:id/render', async (req) => {
  const id = req.params.id;
  if (req.query.only === 'opening') {
    load(id);
    return startJob('render-opening', id, (progress, signal) => renderProject(load(id), progress, signal, true));
  }
  return startJob('render', id, async (progress, signal) => {
    const out = await renderProject(load(id), progress, signal);
    const p = load(id);
    p.outputPath = out;
    saveProject(p);
    return out;
  });
});

// --- shorts: a vertical short of one round, with its own cut and layout ------

function loadShort(p: Project, sid: string): Short {
  const s = findShort(p, sid);
  if (!s) throw Object.assign(new Error('Short not found'), { statusCode: 404 });
  return s;
}

function shortView(p: Project, s: Short) {
  const clips = shortClipsFor(p, s);
  return {
    // its layout as it renders (an older one gets the bottom band)
    short: { ...s, layout: fitLayout(s.layout, p.video) },
    baseClips: baseShortClips(p, s.round),
    clips,
    kills: shortKills(p, s.round),
    duration: totalDuration(clips),
    // where a looping short is cut (recording seconds): it opens there, on the reaction, and ends right before it
    loopCut: shortLoopOrder(p, s, clips)?.[0].start ?? null,
    // per title font: how much smaller than CSS its letters come out in the export, its baseline and
    // capital height, so the preview's letters and boxes match the export's
    titleFonts: Object.fromEntries(
      TITLE_PRESETS.map((t) => {
        const m = fontMetrics(t.font);
        return [t.font, { scale: assScale(t.font), ascent: m.ascent ?? null, cap: m.cap ?? null }];
      }),
    ),
    frame: shortFrame(p.video),
    defaultOutputPath: defaultShortPath(p, s),
    renderJob: latestJob(p.id, `short:${s.id}`),
    // the 1080p export for Instagram, TikTok and Facebook
    socialJob: latestJob(p.id, `short-social:${s.id}`),
    // a clip made straight into a short: its kill feed being read (or read: then kills and titles have it)
    direct: !!p.direct,
    readJob: p.direct && readsKillfeed(p) ? latestJob(p.id, 'analyze') : null,
    // the kill feed is read (CS2): a demo, or clips read by Claude; off, it's any game (no kill feed, no titles)
    killfeed: !clipsMode(p) || readsKillfeed(p),
    defaultSocialPath: defaultShortPath(p, s, true),
    titlesJob: latestJob(p.id, `short-titles:${s.id}`),
    titlesAvailable: titlesAvailable(),
    // global, not this project's copy: the same profile for every match
    creatorProfile: loadSettings().creatorProfile,
  };
}

app.post<{ Params: { id: string }; Body: { round: number } }>('/api/projects/:id/shorts', async (req) => {
  const p = load(req.params.id);
  const s = createShort(p, Number(req.body.round));
  saveProject(p);
  return shortView(p, s);
});

app.get<{ Params: { id: string; sid: string } }>('/api/projects/:id/shorts/:sid', async (req) => {
  const p = load(req.params.id);
  return shortView(p, loadShort(p, req.params.sid));
});

app.patch<{
  Params: { id: string; sid: string };
  Body: {
    edits?: Edits;
    layout?: ShortLayout;
    outputPath?: string;
    captions?: Settings['shortCaptions'];
    killfeed?: Partial<Settings['shortKillfeed']>;
    overlay?: Partial<Settings['shortOverlay']>;
    loop?: Partial<Settings['shortLoop']>;
    /** the short's own title text */
    title?: string;
    /** how titles look (remembered for the next shorts) */
    titleStyle?: Partial<Settings['shortTitle']>;
  };
}>(
  '/api/projects/:id/shorts/:sid',
  async (req) => {
    const p = load(req.params.id);
    const s = loadShort(p, req.params.sid);
    const { edits, layout, outputPath, captions, killfeed, overlay, loop, title, titleStyle } = req.body;
    if (title !== undefined) s.title = title.slice(0, 200);
    if (titleStyle) {
      p.settings.shortTitle = { ...p.settings.shortTitle, ...titleStyle };
      saveSettings({ ...loadSettings(), shortTitle: p.settings.shortTitle });
    }
    if (loop) {
      p.settings.shortLoop = { ...p.settings.shortLoop, ...loop };
      saveSettings({ ...loadSettings(), shortLoop: p.settings.shortLoop });
    }
    if (killfeed) {
      p.settings.shortKillfeed = { ...p.settings.shortKillfeed, ...killfeed };
      saveSettings({ ...loadSettings(), shortKillfeed: p.settings.shortKillfeed });
    }
    if (overlay) {
      // the same badge goes on every short, so it's remembered for the next ones
      p.settings.shortOverlay = { ...p.settings.shortOverlay, ...overlay };
      saveSettings({ ...loadSettings(), shortOverlay: p.settings.shortOverlay });
    }
    if (edits) s.edits = cleanEdits(p, edits);
    if (layout) {
      s.layout = fitLayout(layout, p.video);
      // the facecam sits in the same place in the next recording
      saveSettings({ ...loadSettings(), shortLayout: s.layout });
    }
    if (captions) {
      p.settings.shortCaptions = { ...p.settings.shortCaptions, ...captions };
      saveSettings({ ...loadSettings(), shortCaptions: p.settings.shortCaptions });
    }
    if (outputPath !== undefined) s.outputPath = outputPath || null;
    saveProject(p);
    return shortView(p, s);
  },
);

/** Claude writes YouTube Shorts titles and thumbnail text for the short, from its round's story. */
app.post<{ Params: { id: string; sid: string }; Body: { direction?: string } }>('/api/projects/:id/shorts/:sid/titles', async (req) => {
  if (!titlesAvailable()) throw Object.assign(new Error('Set ANTHROPIC_API_KEY and restart the app to write titles'), { statusCode: 400 });
  const p0 = load(req.params.id);
  const sid = loadShort(p0, req.params.sid).id;
  const direction = String(req.body?.direction ?? '').slice(0, 300);
  return startJob(`short-titles:${sid}`, p0.id, async (_progress, signal) => {
    const titles = await writeShortTitles(load(p0.id), loadShort(load(p0.id), sid), direction, signal);
    const p = load(p0.id); // keep changes made meanwhile
    loadShort(p, sid).titles = titles;
    saveProject(p);
    return titles.ideas.length;
  });
});

// ?for=social: the 1080p export for Instagram, TikTok and Facebook (its own job, so both can run)
app.post<{ Params: { id: string; sid: string }; Querystring: { for?: string } }>('/api/projects/:id/shorts/:sid/render', async (req) => {
  const { id, sid } = req.params;
  const social = req.query.for === 'social';
  loadShort(load(id), sid);
  return startJob(`${social ? 'short-social' : 'short'}:${sid}`, id, async (progress, signal) => {
    const working = load(id);
    const out = await renderShort(working, loadShort(working, sid), progress, signal, social);
    // re-read so edits made while rendering aren't overwritten
    const p = load(id);
    const s = loadShort(p, sid);
    if (social) s.socialOutputPath = out;
    else s.outputPath = out;
    saveProject(p);
    return out;
  });
});

/** The game's own kill-feed entry for each of the short's kills (in time order), cut out on first use; null where none was found. */
app.get<{ Params: { id: string; sid: string } }>('/api/projects/:id/shorts/:sid/feed', async (req) => {
  const p = load(req.params.id);
  const s = loadShort(p, req.params.sid);
  const images = await shortFeedImages(p, shortKills(p, s.round));
  return images.map((img) => (img ? { url: `/api/projects/${p.id}/killfeed/${img.key}`, w: img.w, h: img.h } : null));
});

app.get<{ Params: { id: string; key: string } }>('/api/projects/:id/killfeed/:key', (req, reply) => {
  const p = load(req.params.id);
  const file = join(feedImagesDir(p), `${req.params.key}.png`);
  if (!/^[0-9a-f]+$/.test(req.params.key) || !existsSync(file)) return reply.code(404).send({ error: 'Not found' });
  reply.type('image/png').header('Cache-Control', 'max-age=31536000, immutable');
  return reply.send(createReadStream(file));
});

app.get<{ Params: { id: string; sid: string }; Querystring: { for?: string } }>('/api/projects/:id/shorts/:sid/output', (req, reply) => {
  const s = loadShort(load(req.params.id), req.params.sid);
  const path = req.query.for === 'social' ? s.socialOutputPath : s.outputPath;
  if (!path || !existsSync(path)) return reply.code(404).send({ error: 'Not rendered yet' });
  return streamFile(path, req.headers.range, reply);
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

/** The channel intro / outro with this project's branding, small and quick, for previewing. */
app.get<{ Params: { id: string; kind: string } }>('/api/projects/:id/bumper/:kind', async (req, reply) => {
  const kind = req.params.kind;
  if (kind !== 'intro' && kind !== 'outro') return reply.code(404).send({ error: 'Unknown bumper' });
  const file = await bumperFile(kind, load(req.params.id).settings.branding, PREVIEW_TARGET, BUMPER_CACHE);
  return streamFile(file, req.headers.range, reply);
});

/** A local image (the profile picture), for showing it in the UI. */
app.get<{ Querystring: { path?: string } }>('/api/image', (req, reply) => {
  const path = req.query.path ?? '';
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXT.includes(ext) || !existsSync(path)) return reply.code(404).send({ error: 'Image not found' });
  reply.type(ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
  return reply.send(createReadStream(path));
});

/**
 * A few seconds of one audio track on its own from `at` seconds, to tell
 * which track is the mic. Encoded on the fly; small enough to stream whole.
 */
app.get<{ Params: { id: string; n: string }; Querystring: { at?: string } }>('/api/projects/:id/track/:n', async (req, reply) => {
  const p = load(req.params.id);
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n >= p.video.audio.length) return reply.code(404).send({ error: 'No such audio track' });
  let at = Math.max(0, Math.min(p.video.duration - 1, Number(req.query.at) || 0));
  let file = p.videoPath;
  if (clipsMode(p)) {
    // timeline time -> the clip playing there
    const s = sourceAt(p, at);
    if (n >= s.info.audio.length) return reply.code(404).send({ error: 'This clip has no such audio track' });
    file = s.path;
    at -= s.offset;
  }
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', file, '-t', String(TRACK_SAMPLE_S), '-map', `0:a:${n}`, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
  reply.type('audio/mpeg').header('Cache-Control', 'no-store');
  return reply.send(ff.stdout);
});

/** The recording; in clips mode, the clip `source` (default: the first). */
app.get<{ Params: { id: string }; Querystring: { source?: string } }>('/api/projects/:id/media', (req, reply) => {
  const p = load(req.params.id);
  const src = p.sources?.find((s) => s.id === req.query.source);
  return streamFile(src?.path ?? p.videoPath, req.headers.range, reply);
});
// ?only=opening: the opening-only test render
app.get<{ Params: { id: string }; Querystring: { only?: string } }>('/api/projects/:id/output', (req, reply) => {
  const p = load(req.params.id);
  const path = req.query.only === 'opening' ? openingPath(p) : p.outputPath;
  if (!path || !existsSync(path)) return reply.code(404).send({ error: 'Not rendered yet' });
  return streamFile(path, req.headers.range, reply);
});

const webDist = resolve('dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send() : reply.sendFile('index.html')));
}


await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`CS2 Highlights → http://localhost:${existsSync(webDist) ? PORT : 5173}`);
