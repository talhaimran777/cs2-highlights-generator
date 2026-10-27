import { videoTime } from '../sync/align.ts';
import type { Clip, MatchData, Moment, Settings, SyncModel } from '../types.ts';

/**
 * Enabled moments -> recording time ranges with pre/post-roll. Overlapping or
 * nearly touching ranges in the same round merge into one clip. The intro ends
 * exactly where my first action's clip begins, so the two play as one unbroken
 * opening. Everything not covered (holds, dead time, pauses) is never cut in.
 */
export function planClips(moments: Moment[], sync: SyncModel, settings: Settings, videoDuration: number): Clip[] {
  const ranges = moments
    .filter((m) => m.enabled)
    .flatMap((m) => {
      // The intro starts right as freeze time ends; its pieces are played as-is.
      const pre = m.kind === 'intro' ? 1 : m.kind === 'clutch' ? settings.clutchPreRoll : settings.preRoll;
      const post = m.kind === 'intro' ? 0 : settings.postRoll;
      const pieces = m.segments ?? [[m.startTick, m.endTick]];
      return pieces.map(([from, to], i) => ({
        round: m.round,
        start: Math.max(0, videoTime(sync, from, m.round) + (i === 0 ? m.trimStart - pre : 0)),
        end: Math.min(videoDuration, videoTime(sync, to, m.round) + (i === pieces.length - 1 ? post + m.trimEnd : 0)),
        momentIds: [m.id],
        label: m.label,
      }));
    })
    .filter((c) => c.end - c.start > 0.5)
    .sort((a, b) => a.start - b.start);

  const clips: Clip[] = [];
  for (const r of ranges) {
    const last = clips.at(-1);
    if (last && last.round === r.round && r.start - last.end <= settings.mergeGap) {
      last.end = Math.max(last.end, r.end);
      for (const id of r.momentIds) {
        if (!last.momentIds.includes(id)) {
          last.momentIds.push(id);
          last.label += ` + ${r.label}`;
        }
      }
    } else {
      clips.push({ ...r });
    }
  }
  return clips;
}

export function roundCardText(match: MatchData, round: number, moments: Moment[]): { title: string; subtitle: string } {
  const r = match.rounds.find((x) => x.num === round);
  const best = moments
    .filter((m) => m.round === round && m.enabled && m.kind !== 'death' && m.kind !== 'intro')
    .sort((a, b) => b.score - a.score)[0];
  const parts = [r?.score ? `${r.score.us} – ${r.score.them}` : null, best?.label ?? null].filter(Boolean);
  return { title: `ROUND ${round}`, subtitle: parts.join('   ·   ') };
}

export const totalDuration = (clips: Clip[]) => clips.reduce((s, c) => s + (c.end - c.start), 0);
