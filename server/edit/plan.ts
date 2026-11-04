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

const UTILITY_ROLL_S = 2;

function mergeRanges(moments: Moment[], sync: SyncModel, settings: Settings, videoDuration: number): Clip[] {
  const ranges = moments
    .filter((m) => m.enabled)
    .flatMap((m) => {
      // The intro starts right as freeze time ends; its pieces are played as-is.
      // a throw only needs its wind-up and the grenade landing
      const pre = m.kind === 'intro' ? 1 : m.kind === 'utility' ? UTILITY_ROLL_S : m.kind === 'clutch' ? settings.clutchPreRoll : settings.preRoll;
      const post = m.kind === 'intro' ? 0 : m.kind === 'utility' ? UTILITY_ROLL_S : settings.postRoll;
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

const SPEECH_TAIL_S = 0.4; // let the last word ring out
const SPEECH_LEAD_S = 0.8; // a moment of room before the first word, so the start isn't abrupt
const BREATH_PAUSE_S = 0.15;

/**
 * Utterances with a pause shorter than `gap` between them are one sentence:
 * speech detection splits at 0.4 s, but a thinking pause between two words is
 * often longer, and cutting there still cuts the sentence.
 */
export function joinSentences(utterances: [number, number][], gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (const u of [...utterances].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && u[0] - last[1] < gap) last[1] = Math.max(last[1], u[1]);
    else out.push([u[0], u[1]]);
  }
  return out;
}

/**
 * Moves cut points out of speech: a clip that would end mid-sentence runs on
 * until the sentence ends, short pauses between words included. A sentence
 * that runs on longer than `maxWait` is cut at its longest pause within that
 * wait (most likely where one thought ends). A clip that would start
 * mid-sentence starts where the sentence starts, the same way, with a moment
 * of room before the first word (also when speech begins right after the start).
 * Clips of a round that now touch are merged; rounds never overlap.
 */
export function protectSpeech(
  clips: Clip[],
  speech: { raw: [number, number][]; utterances: [number, number][] },
  settings: Pick<Settings, 'speechMaxWait' | 'mergeGap' | 'sentenceGap'>,
  videoDuration: number,
): Clip[] {
  const { raw } = speech;
  const maxWait = settings.speechMaxWait;
  const sentences = joinSentences(speech.utterances, settings.sentenceGap ?? 1);
  const inside = (t: number) => sentences.find(([a, b]) => t > a && t < b);
  // pauses between words: gaps between raw speech runs (inside a sentence, or between its utterances)
  const pauses = raw.slice(1).map((r, i): [number, number] => [raw[i][1], r[0]]).filter(([a, b]) => b - a >= BREATH_PAUSE_S);
  const longest = (list: [number, number][]) => list.reduce<[number, number] | null>((best, p) => (!best || p[1] - p[0] > best[1] - best[0] ? p : best), null);

  const moveEnd = (t: number) => {
    const u = inside(t);
    if (!u) return t;
    if (u[1] - t <= maxWait) return u[1] + SPEECH_TAIL_S;
    const pause = longest(pauses.filter(([a, b]) => a >= t && (a + b) / 2 <= t + maxWait));
    return pause ? (pause[0] + pause[1]) / 2 : t + maxWait;
  };
  // room before a sentence starting at s, but not back into the sentence before it
  const lead = (s: number) => {
    const prev = sentences.filter(([, b]) => b <= s).at(-1);
    return Math.max(s - SPEECH_LEAD_S, prev ? (prev[1] + s) / 2 : -Infinity);
  };
  const moveStart = (t: number) => {
    const u = inside(t);
    if (!u) {
      const next = sentences.find(([a]) => a >= t && a < t + SPEECH_LEAD_S);
      return next ? Math.min(t, lead(next[0])) : t;
    }
    if (t - u[0] <= maxWait) return lead(u[0]);
    const pause = longest(pauses.filter(([a, b]) => b <= t && (a + b) / 2 >= t - maxWait));
    return pause ? (pause[0] + pause[1]) / 2 : t - maxWait;
  };

  const moved = clips.map((c) => {
    // in clips mode a sentence can only finish inside the clip's own file
    const start = Math.max(0, c.bounds?.[0] ?? 0, moveStart(c.start));
    const end = Math.min(videoDuration, c.bounds?.[1] ?? Infinity, moveEnd(c.end));
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
