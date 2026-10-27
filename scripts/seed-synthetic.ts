// Creates a synthetic test project (no real demo needed) for trying the UI and
// the auto-sync end to end. The recording starts 100 s after the demo, and
// my kill-feed entries are drawn as red outlines at the right times.
//   npm run seed
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { probe, runFfmpeg, hasNvenc } from '../server/util/ffmpeg.ts';
import { DATA_DIR, saveProject } from '../server/project.ts';
import { buildMoments } from '../server/demo/moments.ts';
import { scoreRounds } from '../server/demo/parse.ts';
import { DEFAULT_SETTINGS, type Kill, type MatchData, type Side } from '../server/types.ts';

const TR = 64;
const ME = '76561190000000001';
const OFFSET = -100; // video_t = demo_t + OFFSET
const roster: Record<string, Side> = { [ME]: 'CT', m2: 'CT', m3: 'CT', e1: 'T', e2: 'T', e3: 'T' };

const k = (sec: number, round: number, a: string, v: string, extra: Partial<Kill> = {}): Kill => ({
  tick: sec * TR, round, attacker: a, victim: v,
  attackerName: a === ME ? 'You' : a, victimName: v === ME ? 'You' : v,
  attackerSide: roster[a], victimSide: roster[v],
  assister: null, assisterName: '', flashAssist: false,
  weapon: 'ak47', headshot: false, wallbang: false, noscope: false, throughSmoke: false, attackerBlind: false,
  ...extra,
});

const kills: Kill[] = [
  k(130, 1, ME, 'e1', { headshot: true }), k(135, 1, ME, 'e2', { headshot: true }), k(150, 1, ME, 'e3', { wallbang: true }),
  k(185, 2, 'e1', 'm2'), k(195, 2, 'e2', 'm3'),
  k(200, 2, ME, 'e1', { weapon: 'awp', noscope: true }), k(212, 2, ME, 'e2'), k(220, 2, ME, 'e3'),
  k(270, 3, 'e1', 'm2'), k(290, 3, 'e2', ME, { weapon: 'knife_karambit' }), k(300, 3, 'e3', 'm3'),
];
const match: MatchData = {
  demoPath: 'synthetic.dem', map: 'de_mirage', tickrate: TR,
  players: Object.keys(roster).map((id) => ({ steamId: id, name: id === ME ? 'You' : id })),
  rounds: [
    { num: 1, startTick: 120 * TR, endTick: 152 * TR, winner: 'CT', reason: '', roster: { ...roster }, score: null },
    { num: 2, startTick: 180 * TR, endTick: 222 * TR, winner: 'CT', reason: '', roster: { ...roster }, score: null },
    { num: 3, startTick: 260 * TR, endTick: 301 * TR, winner: 'T', reason: '', roster: { ...roster }, score: null },
  ],
  kills,
  bombs: [],
  combat: [],
};
scoreRounds(match.rounds, ME);

// Outlined entries stack while visible (5 s each), like the real kill feed.
const mine = kills.filter((x) => x.attacker === ME || x.victim === ME).map((x) => x.tick / TR + OFFSET);
const boxes = mine.map((t, i) => {
  const slot = mine.slice(0, i).filter((u) => t - u < 5).length;
  return `drawbox=x=1440:y=${70 + slot * 42}:w=440:h=34:color=0xD01818:t=2:enable='between(t,${t},${t + 5})'`;
});

const dir = join(DATA_DIR, 'synthetic');
mkdirSync(dir, { recursive: true });
const video = join(dir, 'synthetic-match.mp4');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=240',
  '-f', 'lavfi', '-i', 'sine=f=300:d=240',
  '-vf', boxes.join(','),
  '-c:v', hasNvenc() ? 'h264_nvenc' : 'libx264', '-c:a', 'aac', video,
]);

saveProject({
  id: 'synth001',
  name: 'de_mirage · synthetic test match',
  createdAt: new Date().toISOString(),
  videoPath: video,
  demoPath: 'synthetic.dem',
  video: probe(video),
  settings: { ...DEFAULT_SETTINGS, steamId: ME },
  match,
  moments: buildMoments(match, ME),
  sync: null,
  killfeedEvents: null,
  outputPath: null,
});
console.log(`Seeded project synth001. Expected sync offset: ${OFFSET} s`);
console.log(`My kill-feed events in the video at: ${mine.join(', ')} s`);
