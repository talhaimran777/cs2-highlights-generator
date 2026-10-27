import { videoTime } from '../sync/align.ts';
import type { Clip, MatchData, Moment, Settings, SyncModel } from '../types.ts';

/**
 * Enabled moments -> recording time ranges with pre/post-roll. Overlapping or
 * nearly touching ranges in the same round merge into one clip. A round whose
 * intro is enabled plays unbroken from spawn to its last highlight. Everything
 * not covered (freeze time, pauses, dead time) is simply never cut in.
 */
export function planClips(moments: Moment[], sync: SyncModel, settings: Settings, videoDuration: number): Clip[] {
  const fullRounds = new Set(moments.filter((m) => m.kind === 'intro' && m.enabled).map((m) => m.round));
  const ranges = moments
    .filter((m) => m.enabled)
    .map((m) => {
      // The intro starts right as freeze time ends and runs into the first action.
      const pre = m.kind === 'intro' ? 1 : m.kind === 'clutch' ? settings.clutchPreRoll : settings.preRoll;
      const post = m.kind === 'intro' ? 0 : settings.postRoll;
      const start = videoTime(sync, m.startTick, m.round) - pre + m.trimStart;
      const end = videoTime(sync, m.endTick, m.round) + post + m.trimEnd;
      return {
        round: m.round,
        start: Math.max(0, start),
        end: Math.min(videoDuration, end),
        momentIds: [m.id],
        label: m.label,
      };
    })
    .filter((c) => c.end - c.start > 0.5)
    .sort((a, b) => a.start - b.start);

  const clips: Clip[] = [];
  for (const r of ranges) {
    const last = clips.at(-1);
    if (last && last.round === r.round && (fullRounds.has(r.round) || r.start - last.end <= settings.mergeGap)) {
      last.end = Math.max(last.end, r.end);
      last.momentIds.push(...r.momentIds);
      last.label += ` + ${r.label}`;
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
