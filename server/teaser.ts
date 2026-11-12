// The highlight video's cold open ("coming up"): the match's best moments as
// hard-cut shots before the video starts, so the viewer knows what's coming
// and stays for it. Only the shots make it in: a beat before each kill (the
// flick, the spray) and the kill landing, never the walking there. A big round
// (3K, 4K, ace, clutch) plays as a quick run of all its kills, one shot each,
// under one headline; any other round gives its best shot. Like a trailer: the
// best moment first (the hook), then two or three different kinds of play,
// about ten seconds, then straight into the match. Moments come from rounds
// that are in the video, so the open only promises what the video shows.

import { findClutch, isTeamkill } from './demo/moments.ts';
import { videoTime } from './sync/align.ts';
import type { Kill, MatchData, SyncModel } from './types.ts';
import { time } from './captions/ass.ts';
import { TEYE_CRIMSON } from './shorts/title.ts';

/** a shot starts this long before its first kill (the aim landing) */
export const SHOT_PRE_S = 0.8;
/** and runs this long past its last (the kill registering, the feed popping) */
export const SHOT_POST_S = 0.45;
/** kills closer than this are one shot (a spray, a double) */
export const CHAIN_S = 1.6;
/** no shot runs longer than this: a long spray keeps its last kills */
export const MAX_SHOT_S = 3.6;
export const DEFAULT_TEASER_S = 10;
export const MIN_TEASER_S = 5;
export const MAX_TEASER_S = 30;
/** a round with this many kills of mine plays all of them */
const RUN_KILLS = 3;
/** never more shots than this; fewer moments than MIN_MOMENTS is no open at all */
const MAX_SHOTS = 10;
const MIN_MOMENTS = 2;
/** a hook and two or three more: more reads as a montage, not a trailer */
const MAX_MOMENTS = 4;

export interface TeaserShot {
  /** recording seconds */
  start: number;
  end: number;
  kills: number;
}

/** One round's part of the open: its best shot, or (a big round) all its kills one after another. */
export interface TeaserMoment {
  round: number;
  /** its headline on screen ("*4K*", "*1v3* CLUTCH", "ONE *TAP*": the starred word in TEYE red), or '' */
  tag: string;
  kills: number;
  score: number;
  shots: TeaserShot[];
}

const MULTI_TAGS = ['', '', 'DOUBLE *KILL*', '*3K*', '*4K*', '*ACE*'];
/** bonus for a round's kills (3K and up play as a run) and for a burst's (a spray that drops several) */
const ROUND_BONUS = [0, 0, 3, 10, 18, 28];
const BURST_BONUS = [0, 0, 4, 8, 13, 20];

/** How exciting one kill is to watch. */
function killScore(k: Kill): number {
  return 2 + (k.headshot ? 1 : 0) + (k.wallbang ? 3 : 0) + (k.noscope ? 4 : 0) + (k.throughSmoke ? 2 : 0) + (k.attackerBlind ? 2 : 0);
}

/** What one shot is about, loudest first ('' for a plain kill). */
function shotTag(kills: Kill[]): string {
  if (kills.length >= 2) return MULTI_TAGS[Math.min(5, kills.length)];
  const k = kills[0];
  if (k.noscope) return '*NO-SCOPE*';
  if (k.wallbang) return '*WALLBANG*';
  if (k.throughSmoke) return 'THROUGH *SMOKE*';
  if (k.attackerBlind) return '*BLIND* KILL';
  if (k.headshot && /deagle|awp|ssg08|usp|glock|p2000|p250|revolver/.test(k.weapon)) return 'ONE *TAP*';
  if (k.headshot) return '*HEADSHOT*';
  return '';
}

const duration = (m: { shots: TeaserShot[] }) => m.shots.reduce((s, x) => s + x.end - x.start, 0);

/**
 * One moment per round in the video: my kills (no teamkills) chained into
 * bursts, each cut to its kills plus a beat either side. A round with 3+
 * kills or a won clutch is all its bursts in a row; another round, its best
 * burst. Scored for how much it makes you want to watch (kills, a multi-kill,
 * headshots, wallbangs, no-scopes, a clutch).
 */
export function teaserMoments(match: MatchData, me: string, sync: SyncModel, rounds: Set<number>, videoDuration: number): TeaserMoment[] {
  const out: TeaserMoment[] = [];
  for (const r of match.rounds) {
    if (!rounds.has(r.num)) continue;
    const mine = match.kills
      .filter((k) => k.round === r.num && k.attacker === me && k.victim !== me && !isTeamkill(k))
      .sort((a, b) => a.tick - b.tick);
    if (!mine.length) continue;
    const t = (k: Kill) => videoTime(sync, k.tick, r.num);
    const bursts: Kill[][] = [];
    for (const k of mine) {
      const last = bursts.at(-1);
      if (last && t(k) - t(last.at(-1)!) <= CHAIN_S) last.push(k);
      else bursts.push([k]);
    }
    const shotOf = (burst: Kill[]): TeaserShot & { kept: Kill[] } => {
      // too long: its last kills (the end of a spray, the kill that wins it)
      let kept = burst;
      while (kept.length > 1 && t(kept.at(-1)!) - t(kept[0]) > MAX_SHOT_S - SHOT_PRE_S - SHOT_POST_S) kept = kept.slice(1);
      return { start: Math.max(0, t(kept[0]) - SHOT_PRE_S), end: Math.min(videoDuration, t(kept.at(-1)!) + SHOT_POST_S), kills: kept.length, kept };
    };
    const clutch = findClutch(r, match.kills.filter((k) => k.round === r.num), me);
    if (mine.length >= RUN_KILLS || clutch) {
      const shots = bursts.map(shotOf);
      const n = mine.length;
      out.push({
        round: r.num,
        tag: clutch ? `*1v${clutch.vs}* CLUTCH` : n === bursts[0].length && n >= 3 && n <= 4 ?`${MULTI_TAGS[Math.min(5, n)]} SPRAY` : MULTI_TAGS[Math.min(5, n)],
        kills: n,
        score: shots.reduce((s, x) => s + x.kept.reduce((a, k) => a + killScore(k), 0) + BURST_BONUS[Math.min(5, x.kept.length)], 0) + ROUND_BONUS[Math.min(5, n)] + (clutch ? 4 + 3 * clutch.vs : 0),
        shots: shots.map(({ kept: _, ...s }) => s),
      });
    } else {
      const best = bursts
        .map(shotOf)
        .map((s) => ({ s, score: s.kept.reduce((a, k) => a + killScore(k), 0) + BURST_BONUS[Math.min(5, s.kept.length)] }))
        .sort((a, b) => b.score - a.score)[0];
      const { kept, ...shot } = best.s;
      out.push({ round: r.num, tag: shotTag(kept), kills: kept.length, score: best.score, shots: [shot] });
    }
  }
  return out;
}

/** What kind of play a moment is (so the open shows different kinds): a clutch, a multi-kill, or its trick shot. */
export function playKind(tag: string): string {
  const t = tag.replace(/\*/g, '');
  if (/CLUTCH/.test(t)) return 'clutch';
  if (/\dK|ACE|DOUBLE/.test(t)) return 'multi';
  return t || 'kill';
}

/**
 * The cold open, like a trailer: the best moment first (the hook), then the
 * next best of other kinds of play (a clutch after a multi-kill, a no-scope
 * after a spray), until about `seconds` are filled and at most MAX_MOMENTS.
 * A kind already shown is used only when nothing else fits. Empty when the
 * match has too little for it.
 */
export function pickTeaser(moments: TeaserMoment[], seconds = DEFAULT_TEASER_S): TeaserMoment[] {
  const budget = Math.min(MAX_TEASER_S, Math.max(MIN_TEASER_S, seconds));
  const ranked = [...moments].sort((a, b) => b.score - a.score || a.shots[0].start - b.shots[0].start);
  const picked: TeaserMoment[] = [];
  let total = 0;
  let shots = 0;
  const fits = (m: TeaserMoment) =>
    // the hook always; after it, a moment that would blow the budget gives way to a shorter one (it may run a little over)
    picked.length === 0 || (total + duration(m) <= budget + 1.5 && shots + m.shots.length <= MAX_SHOTS);
  const take = (m: TeaserMoment) => {
    picked.push(m);
    total += duration(m);
    shots += m.shots.length;
  };
  // first new kinds of play, then (only if there's room left) more of the same
  for (const sameKindOk of [false, true]) {
    for (const m of ranked) {
      if (total >= budget || picked.length >= MAX_MOMENTS) break;
      if (picked.includes(m) || !fits(m)) continue;
      if (!sameKindOk && picked.some((p) => playKind(p.tag) === playKind(m.tag))) continue;
      take(m);
    }
  }
  return picked.length < MIN_MOMENTS ? [] : picked;
}

/** The match's cold open: see teaserMoments and pickTeaser. */
export function planTeaser(match: MatchData, me: string, sync: SyncModel | null, rounds: Set<number>, videoDuration: number, seconds = DEFAULT_TEASER_S): TeaserMoment[] {
  if (!sync || !me) return [];
  return pickTeaser(teaserMoments(match, me, sync, rounds, videoDuration), seconds);
}

/** the best moment's last kill plays slowed to this before it lands, then back to full speed for the kill */
export const RAMP_SPEED = 0.6;
/** the slowed window: at most this much footage right before the kill (a burst's earlier kills play at full speed) */
const RAMP_WINDOW_S = 0.8;
/** the slow part stops this long before the kill, so the kill itself plays at full speed */
const RAMP_LEAD_S = 0.12;

/** One cut of the open, as it's rendered. */
export interface TeaserCut {
  round: number;
  /** recording seconds */
  start: number;
  end: number;
  /** played at this speed (1 = as recorded) */
  speed: number;
  /** its moment's headline */
  tag: string;
  /** opens the open: its kicker fades in */
  first: boolean;
  /** the hook (the first moment): its shots carry the small kicker ("MATCH HIGHLIGHTS") over the headline */
  kicker: boolean;
  /** starts a moment: its headline pops in and its underline wipes in (with the whoosh, when it's on); a run's later shots keep them up, so they don't flicker */
  pop: boolean;
  /** comes in from a quick white flash: the last moment, the only flash inside the open */
  flashIn: boolean;
  /** goes out on one: the open's last frames, into the video */
  flashOut: boolean;
}

/**
 * The open's cuts in play order. Hard cuts throughout. The hook (the best
 * moment, first) has the only speed ramp: its final shot slowed just before
 * the kill, the kill itself at full speed. The last moment comes in from a
 * quick flash, and the open flashes out into the video.
 */
export function teaserCuts(moments: TeaserMoment[]): TeaserCut[] {
  const cuts: TeaserCut[] = [];
  moments.forEach((m, mi) => {
    const hook = mi === 0;
    const last = mi === moments.length - 1 && moments.length > 1;
    m.shots.forEach((s, si) => {
      const base = { round: m.round, tag: m.tag, first: hook && si === 0, kicker: hook, pop: si === 0, flashIn: last && si === 0, flashOut: false };
      const killAt = s.end - SHOT_POST_S;
      const slowTo = killAt - RAMP_LEAD_S;
      const slowFrom = Math.max(s.start, slowTo - RAMP_WINDOW_S);
      if (hook && si === m.shots.length - 1 && slowTo - slowFrom > 0.25) {
        // the same footage running on, so no fade, pop or flash where its parts meet:
        // full speed up to the window before the kill, slowed through it, full speed for the kill
        const on = { first: false, pop: false, flashIn: false };
        if (slowFrom - s.start > 0.05) cuts.push({ ...base, start: s.start, end: slowFrom, speed: 1 });
        cuts.push({ ...base, ...(slowFrom - s.start > 0.05 ? on : {}), start: slowFrom, end: slowTo, speed: RAMP_SPEED });
        cuts.push({ ...base, ...on, start: slowTo, end: s.end, speed: 1 });
      } else cuts.push({ ...base, start: s.start, end: s.end, speed: 1 });
    });
  });
  if (cuts.length) cuts[cuts.length - 1].flashOut = true;
  return cuts;
}

/** How long the open plays (its slowed part runs longer). */
export const teaserLength = (cuts: { start: number; end: number; speed: number }[]) => cuts.reduce((s, c) => s + (c.end - c.start) / c.speed, 0);

/**
 * The open's look: a subtle cinematic grade so it reads as a preview, not
 * the match (the match itself stays as recorded): a little more contrast and
 * colour, highlights pulled down, a faint red in the shadows, a soft vignette.
 * ffmpeg filters, applied under the text.
 */
export const TEASER_GRADE = [
  'eq=contrast=1.12:saturation=1.08:brightness=-0.015',
  "curves=all='0/0 0.5/0.49 0.82/0.78 1/0.94'",
  'colorbalance=rs=0.06:gs=-0.01:bs=-0.03:rm=0.015',
  'vignette=angle=PI/5',
];
/** a flash is this long */
export const FLASH_S = 0.12;
/** the whoosh's level, well under the game */
export const WHOOSH_VOLUME = 0.35;

/**
 * A soft whoosh for a moment's start (optional, off by default): a breath of
 * pink noise with the bass and the hiss taken out (600 Hz to 7 kHz), swelling
 * in over 0.12 s and dying away over 0.3 s. No low end, so it never booms
 * over the game. An ffmpeg lavfi source, stereo 48 kHz, the same every time.
 */
export const WHOOSH_SOURCE =
  'anoisesrc=d=0.42:c=pink:a=0.6:seed=7,highpass=f=600,lowpass=f=7000,afade=t=in:d=0.12:curve=exp,afade=t=out:st=0.12:d=0.3:curve=qsin,aformat=sample_rates=48000:channel_layouts=stereo';

/** A cut's extra filters and sound: the grade under its text, its flashes over everything, a whoosh as a moment starts (when there's one). */
export function teaserLook(cut: { pop: boolean; flashIn?: boolean; flashOut?: boolean }, dur: number, whooshFile: string | null) {
  return {
    before: TEASER_GRADE,
    after: [
      ...(cut.flashIn ? [`fade=t=in:st=0:d=${FLASH_S}:color=white`] : []),
      ...(cut.flashOut ? [`fade=t=out:st=${Math.max(0, dur - FLASH_S).toFixed(3)}:d=${FLASH_S}:color=white`] : []),
    ],
    impact: cut.pop && whooshFile ? { file: whooshFile, volume: WHOOSH_VOLUME } : null,
  };
}

/**
 * The open's text: a small white kicker ("MATCH HIGHLIGHTS") over the hook,
 * the moment's headline under it (Bold White: white, a subtle black outline
 * and shadow, the starred word in TEYE red), and a short red underline under
 * the headline. Upper centre, under the HUD's score and timer: clear of the
 * crosshair, the radar and the kill feed. Sizes and tops, % of the frame height.
 */
export const TEASER_KICKER = { preset: 'bold', sizePct: 2.8, positionPct: 11.8, lineHeight: 1, wordSpacing: 1 };
export const TEASER_TAG = { preset: 'bold', sizePct: 7.7, positionPct: 15.2, lineHeight: 1, wordSpacing: 1 };
/** the underline: its top (a little under the headline's capitals), width and thickness, shares of the frame */
export const TEASER_BAR = { top: 0.152 + 0.077 * 1.04, w: 0.06, h: 0.0055 };
export const DEFAULT_TEASER_LABEL = 'MATCH HIGHLIGHTS';
/** the kicker fades in as the open starts; each headline pops in with its moment */
const LABEL_FADE_MS = 160;
const TAG_FADE_MS = 90;
/** the underline wipes out from its middle, just after the headline lands */
const BAR_WIPE_MS: [number, number] = [70, 230];

/** Every line of an ASS script faded in over `ms`. */
export const fadeIn = (ass: string, ms: number) => ass.replace(/^(Dialogue: (?:[^,]*,){9})\{/gm, `$1{\\fad(${ms},0)`);
/** a headline pops in: from this much bigger, settling over POP_MS (with its fade) */
const POP_SCALE = 135;
const POP_MS = 140;
/** Every line of an ASS script popping in: faded in over `ms` while it shrinks from POP_SCALE % to its size (text only: a box would scale apart from it). */
export const popIn = (ass: string, ms: number) =>
  ass.replace(/^(Dialogue: (?:[^,]*,){9})\{/gm, `$1{\\fad(${ms},0)\\fscx${POP_SCALE}\\fscy${POP_SCALE}\\t(0,${POP_MS},\\fscx100\\fscy100)`);

/** "#RRGGBB" as an ASS colour override's "&HBBGGRR&" */
const assColor = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();

/** The red underline under a headline, as an ASS script: a slim rounded bar, wiping out from its middle when it `wipe`s in. */
export function underlineAss(frame: { width: number; height: number }, dur: number, wipe: boolean): string {
  const w = Math.round(frame.width * TEASER_BAR.w);
  const h = Math.max(2, Math.round(frame.height * TEASER_BAR.h));
  const r = h / 2;
  const k = r * (1 - 0.5523);
  const x = Math.round(frame.width / 2);
  const y = Math.round(frame.height * TEASER_BAR.top);
  const shape = `m ${r} 0 l ${w - r} 0 b ${w - k} 0 ${w} ${k} ${w} ${r} b ${w} ${h - k} ${w - k} ${h} ${w - r} ${h} l ${r} ${h} b ${k} ${h} 0 ${h - k} 0 ${r} b 0 ${k} ${k} 0 ${r} 0`;
  const anim = wipe ? `\\fscx0\\t(${BAR_WIPE_MS[0]},${BAR_WIPE_MS[1]},\\fscx100)` : '';
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Bar,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,0,2,8,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,${time(0)},${time(Math.max(0.01, dur))},Bar,,0,0,0,,{\\an8\\pos(${x},${y})\\1c${assColor(TEYE_CRIMSON)}${anim}\\p1}${shape}{\\p0}`,
    '',
  ].join('\n');
}

/**
 * A cold-open cut's text, as ASS scripts: the kicker over the hook (`title`
 * draws it and the headline: shorts/title.ts titleAss, the same TEYE looks as
 * a short's title), the moment's headline popping in, and its red underline
 * wiping in under it. A moment with no headline has no underline either.
 */
export function teaserText(
  cut: { tag: string; first: boolean; pop: boolean; kicker?: boolean },
  label: string,
  dur: number,
  title: (text: string, style: typeof TEASER_TAG, dur: number) => string | null,
  frame: { width: number; height: number },
): string[] {
  const kicker = cut.kicker && label.trim() ? title(label, TEASER_KICKER, dur) : null;
  const tag = cut.tag ? title(cut.tag, TEASER_TAG, dur) : null;
  return [
    kicker && (cut.first ? fadeIn(kicker, LABEL_FADE_MS) : kicker),
    tag && (cut.pop ? popIn(tag, TAG_FADE_MS) : tag),
    tag && underlineAss(frame, dur, cut.pop),
  ].filter((s): s is string => !!s);
}
