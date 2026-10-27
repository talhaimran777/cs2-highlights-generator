// Re-fits a project's auto sync from its cached kill-feed scan, without rescanning the video.
//   npm run refit -- <projectId>
import { fitSync } from '../server/sync/align.ts';
import { getProject, saveProject, syncAnchors } from '../server/project.ts';

const p = getProject(process.argv[2] ?? '');
if (!p) throw new Error('usage: npm run refit -- <projectId>');
if (!p.killfeedEvents) throw new Error('No cached kill-feed scan; run auto-sync in the app');

const anchors = syncAnchors(p);
p.sync = fitSync(anchors, p.killfeedEvents, p.match.tickrate, p.match.rounds.map((r) => r.num));
saveProject(p);

const s = p.sync;
console.log(`${anchors.length} anchors, ${p.killfeedEvents.length} kill-feed events`);
console.log(`matched ${s.inliers}, rms ${s.rmsError.toFixed(3)} s, offset ${s.offset.toFixed(2)} s, scale ${s.scale.toFixed(5)}, confident: ${s.confident}`);
console.log('per-round offsets:', Object.values(s.roundOffsets).map((o) => o.toFixed(2)).join(' '));
