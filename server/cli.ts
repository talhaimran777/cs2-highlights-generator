import { parseArgs } from 'node:util';
import { inspectDemo, parseDemo } from './demo/parse.ts';
import { buildMoments } from './demo/moments.ts';
import { manualSync } from './sync/align.ts';
import { totalDuration } from './edit/plan.ts';
import { analyzeSpeech, autoSync, clipsFor, createProject, renderProject, saveProject, setPlayer } from './project.ts';
import { checkFfmpeg, hasNvenc } from './util/ffmpeg.ts';

const USAGE = `
cs2-highlights CLI

  npm run cli -- inspect  <demo>                    dump event names + sample fields
  npm run cli -- players  <demo>                    list players and SteamIDs
  npm run cli -- moments  <demo> --me <steamid>     list detected highlight moments
  npm run cli -- run <video> <demo> --me <steamid> [--sync <tick>:<seconds>] [--out <file>] [--dry]
      Full pipeline. Without --sync it auto-syncs from the kill feed.
      --dry stops before rendering and prints the clip list.
`;

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { me: { type: 'string' }, sync: { type: 'string' }, out: { type: 'string' }, dry: { type: 'boolean' } },
  });
  const [cmd, ...rest] = positionals;

  if (cmd === 'inspect') {
    console.dir(inspectDemo(rest[0]), { depth: 4 });
  } else if (cmd === 'players') {
    const m = parseDemo(rest[0]);
    console.log(`${m.map}, ${m.rounds.length} rounds`);
    for (const p of m.players) console.log(`  ${p.steamId}  ${p.name}`);
  } else if (cmd === 'moments') {
    if (!values.me) throw new Error('--me <steamid> is required');
    const m = parseDemo(rest[0], values.me);
    for (const x of buildMoments(m, values.me)) {
      console.log(`R${String(x.round).padStart(2)}  ${x.kind.padEnd(8)} ${String(x.score).padStart(3)}  ${x.label}  ${x.tags.join(', ')}`);
    }
  } else if (cmd === 'run') {
    const [video, demo] = rest;
    if (!values.me) throw new Error('--me <steamid> is required');
    const ff = checkFfmpeg();
    if (!ff.ok) throw new Error('ffmpeg not found on PATH (or set FFMPEG_PATH)');
    console.log(`${ff.version}  ·  NVENC: ${hasNvenc() ? 'yes' : 'no'}`);

    const p = createProject(video, demo);
    setPlayer(p, values.me);
    console.log(`Project ${p.id}: ${p.match.map}, ${p.match.rounds.length} rounds, ${p.moments.length} moments`);

    if (values.sync) {
      const [tick, sec] = values.sync.split(':').map(Number);
      p.sync = manualSync(tick, sec, p.match.tickrate);
    } else {
      console.log('Scanning kill feed…');
      const s = await autoSync(p, (f) => process.stdout.write(`\r  ${(f * 100).toFixed(0)}%`));
      console.log(`\n  ${p.killfeedEvents?.length} kill-feed events, ${s.inliers} matched, rms ${s.rmsError.toFixed(2)}s, offset ${s.offset.toFixed(2)}s`);
      if (!s.confident) console.warn('  ⚠ Low confidence. Check the clips, or pass --sync <tick>:<seconds> from a kill you can find in the video.');
    }
    console.log('Detecting speech…');
    const speech = await analyzeSpeech(p, (f) => process.stdout.write(`\r  ${(f * 100).toFixed(0)}%`));
    console.log(`\n  ${speech.utterances.length} speech segments; cuts will wait for sentences to finish`);
    saveProject(p);

    const clips = clipsFor(p);
    for (const c of clips) console.log(`  R${String(c.round).padStart(2)}  ${fmt(c.start)} → ${fmt(c.end)}  ${c.label}`);
    console.log(`${clips.length} clips, ${fmt(totalDuration(clips))} total`);
    if (values.dry) return;

    if (values.out) p.outputPath = values.out;
    const out = await renderProject(p, (f) => process.stdout.write(`\rRendering ${(f * 100).toFixed(0)}%`));
    saveProject(p);
    console.log(`\nDone: ${out}`);
  } else {
    console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
