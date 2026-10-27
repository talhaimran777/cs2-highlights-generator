import { videoTime } from '../sync/align.ts';
import type { Clip, MatchData, Moment, Settings, SyncModel } from '../types.ts';

/**
 * Enabled moments -> recording time ranges with pre/post-roll. Overlapping or
 * nearly touching ranges in the same round merge into one clip. The intro ends
 * exactly where my first action's clip begins, so the two play as one unbroken
 * opening. Everything not covered (holds, dead time, pauses) is never cut in.
 */
export function planClips(
  moments: Moment[],
  sync: SyncModel,
  settings: Settings,
  videoDuration: number,
  speech?: { raw: [number, number][]; utterances: [number, number][] } | null,
): Clip[] {
  const clips = mergeRanges(moments, sync, settings, videoDuration);
  return speech && settings.protectSpeech ? protectSpeech(clips, speech, settings, videoDuration) : clips;
}

function mergeRanges(moments: Moment[], sync: SyncModel, settings: Settings, videoDuration: number): Clip[] {
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

const SPEECH_TAIL_S = 0.25; // let the last word ring out
const SPEECH_LEAD_S = 0.2;
const BREATH_PAUSE_S = 0.15;

/**
 * Moves cut points out of speech: a clip that would end mid-sentence runs on
 * until the sentence ends (or the first breath pause within `maxWait`), and a
 * clip that would start mid-sentence starts where the sentence starts.
 * Clips of a round that now touch are merged; rounds never overlap.
 */
export function protectSpeech(
  clips: Clip[],
  speech: { raw: [number, number][]; utterances: [number, number][] },
  settings: Pick<Settings, 'speechMaxWait' | 'mergeGap'>,
  videoDuration: number,
): Clip[] {
  const { utterances, raw } = speech;
  const maxWait = settings.speechMaxWait;
  const inside = (t: number) => utterances.find(([a, b]) => t > a && t < b);
  // breath pauses: gaps between raw speech runs inside one utterance
  const pauses = raw.slice(1).map((r, i): [number, number] => [raw[i][1], r[0]]).filter(([a, b]) => b - a >= BREATH_PAUSE_S);

  const moveEnd = (t: number) => {
    const u = inside(t);
    if (!u) return t;
    if (u[1] - t <= maxWait) return u[1] + SPEECH_TAIL_S;
    const pause = pauses.find(([a, b]) => a >= t && (a + b) / 2 <= t + maxWait);
    return pause ? (pause[0] + pause[1]) / 2 : t + maxWait;
  };
  const moveStart = (t: number) => {
    const u = inside(t);
    if (!u) return t;
    if (t - u[0] <= maxWait) return u[0] - SPEECH_LEAD_S;
    const pause = [...pauses].reverse().find(([a, b]) => b <= t && (a + b) / 2 >= t - maxWait);
    return pause ? (pause[0] + pause[1]) / 2 : t - maxWait;
  };

  const moved = clips.map((c) => {
    const start = Math.max(0, moveStart(c.start));
    const end = Math.min(videoDuration, moveEnd(c.end));
    return { ...c, start, end, speech: { start: c.start - start, end: end - c.end } };
  });

  const out: Clip[] = [];
  for (const c of moved) {
    const last = out.at(-1);
    if (last && last.round === c.round && c.start - last.end <= settings.mergeGap) {
      last.end = Math.max(last.end, c.end);
      last.momentIds.push(...c.momentIds.filter((id) => !last.momentIds.includes(id)));
      last.label += ` + ${c.label}`;
      last.speech = { start: last.speech!.start, end: c.speech!.end };
    } else {
      // a different round: never replay footage the previous clip already showed
      if (last && c.start < last.end) c.start = last.end;
      if (c.end - c.start > 0.5) out.push({ ...c, momentIds: [...c.momentIds] });
    }
  }
  return out;
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
