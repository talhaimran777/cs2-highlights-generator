// Shared data model. Everything time-related in the demo is in ticks;
// everything in the recording is in seconds. sync/ converts between them.

import type { VideoInfo } from './util/ffmpeg.ts';

export type Side = 'T' | 'CT';

export interface Player {
  steamId: string;
  name: string;
}

export interface Kill {
  tick: number;
  round: number;
  attacker: string | null; // steamId, null for world/bomb deaths
  attackerName: string;
  attackerSide: Side | null;
  victim: string;
  victimName: string;
  victimSide: Side | null;
  assister: string | null;
  assisterName: string;
  flashAssist: boolean;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  noscope: boolean;
  throughSmoke: boolean;
  attackerBlind: boolean;
}

export interface BombEvent {
  tick: number;
  round: number;
  kind: 'planted' | 'defused' | 'exploded';
  player: string | null;
  site: string;
}

/** A shot (victim null) or a damage event, used to find when a fight starts. */
export interface CombatEvent {
  tick: number;
  attacker: string | null;
  victim: string | null;
}

export interface Round {
  num: number; // 1-based, as shown on the scoreboard
  startTick: number; // freeze time end (action starts)
  endTick: number; // round_end
  winner: Side | null;
  reason: string;
  /** steamId -> side for every player alive at freeze end */
  roster: Record<string, Side>;
  /** score after this round, from the recording player's perspective */
  score: { us: number; them: number } | null;
}

export type UtilityKind = 'smoke' | 'flash' | 'he' | 'molotov' | 'decoy';

/** A grenade thrown; for a flash, the enemies it blinded. */
export interface UtilityThrow {
  tick: number;
  round: number;
  player: string | null;
  kind: UtilityKind;
  /** enemies blinded for at least a second (flashes only) */
  blinded: number;
}

export interface MatchData {
  demoPath: string;
  map: string;
  tickrate: number;
  players: Player[];
  rounds: Round[];
  kills: Kill[];
  bombs: BombEvent[];
  combat: CombatEvent[];
  /** grenades thrown (missing in projects parsed before it was read) */
  utility?: UtilityThrow[];
}

/** Where I ended up after leaving spawn, per round. */
export interface RoundIntro {
  /** tick I settled at my spot (or the search window ran out) */
  arriveTick: number;
  place: string;
}

export type MomentKind = 'intro' | 'kills' | 'clutch' | 'bomb' | 'assist' | 'team' | 'decider' | 'death' | 'funny' | 'fight' | 'utility' | 'clip';

export interface Moment {
  id: string;
  round: number;
  kind: MomentKind;
  label: string; // e.g. "3K (2 HS)", "1v3 clutch", "Defuse"
  tags: string[];
  score: number;
  /** first and last "action" ticks of the moment, before pre/post-roll */
  startTick: number;
  endTick: number;
  /** played pieces with cuts between them (the intro); default [[startTick, endTick]] */
  segments?: [number, number][];
  /** clips mode (no demo): first and last kill in timeline seconds, used instead of the ticks */
  at?: [number, number];
  /** clips mode: the piece stays inside this timeline range (the round, up to just after my death) */
  limits?: [number, number];
  enabled: boolean;
  /** manual trim adjustments in seconds, applied after pre/post-roll */
  trimStart: number;
  trimEnd: number;
}

export interface SyncModel {
  tickrate: number;
  /** video_t = offset + scale * (tick / tickrate) */
  offset: number;
  scale: number;
  /** per-round offset override (absorbs jumps around pauses) */
  roundOffsets: Record<number, number>;
  method: 'auto' | 'manual';
  /** auto-sync quality: number of matched anchors and their RMS error */
  inliers: number;
  rmsError: number;
  confident: boolean;
}

export interface Clip {
  round: number;
  start: number; // seconds in the recording
  end: number;
  momentIds: string[];
  label: string;
  /** seconds added to keep speech whole: start moved earlier / end moved later */
  speech?: { start: number; end: number };
  /** clips mode: the source clip's range on the timeline; added footage never crosses it */
  bounds?: [number, number];
  /** played at this speed (a cold open's speed ramp; missing = 1) */
  speed?: number;
  /** a looping short's seam: this edge runs straight on in the recording, so its sound isn't faded there */
  seamless?: 'start' | 'end';
  /** crossfade into this piece from the one before it over this many seconds (picture and sound) */
  blend?: number;
  /** a shot of the highlight video's cold open ("coming up"): what it shows, and whether it opens it */
  teaser?: { tag: string; first: boolean; kicker?: boolean; pop: boolean; flashIn?: boolean; flashOut?: boolean };
}

/** One red-outlined kill-feed entry (it involves me), as read from a replay clip. */
export interface FeedEntry {
  t: number; // seconds into the source clip
  kind: 'kill' | 'death' | 'assist';
  attacker: string;
  /** the teammate after the "+" (or me, when it's my assist) */
  assister?: string;
  victim: string;
  weapon: string;
  headshot: boolean;
}

/** The round timer and score at the top of the HUD at one moment. */
export interface HudSample {
  t: number;
  /** seconds on the round timer; null when it's hidden (bomb planted, round over) or unreadable */
  timer: number | null;
  left: number | null;
  right: number | null;
}

/** What was read from one replay clip. */
export interface ClipAnalysis {
  entries: FeedEntry[];
  hud: HudSample[];
  /** source seconds where a new round begins (the score changed or the timer reset) */
  roundStarts: number[];
  /** tokens used to read this clip, to keep an eye on the cost */
  usage: { input: number; output: number };
}

/** One OBS replay clip of a clips project. The clips play back to back on one timeline. */
export interface Source {
  id: string;
  path: string;
  name: string;
  info: VideoInfo;
  /** where the clip starts on the timeline */
  offset: number;
  analysis?: ClipAnalysis | null;
  error?: string;
}

/** Cuts made in the editor. Recording seconds, so they survive re-planning the clips. */
export interface Edits {
  /** removed ranges */
  cuts: [number, number][];
  /** extra edit points (S / Ctrl+K) */
  splits: number[];
  /** footage added back by dragging a piece's edge outward; extends the clip it touches */
  adds?: [number, number][];
}

export const NO_EDITS: Edits = { cuts: [], splits: [], adds: [] };

/** A region of the frame, as fractions of its size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a short's bands come from: the facecam on top (when there's one), gameplay below. */
export interface ShortLayout {
  camera: Rect;
  gameplay: Rect;
  /** the camera band's share of the short's height (kept while the camera is off, for when it's back on) */
  split: number;
  /**
   * the bottom band's share of the short's height, kept clear of the gameplay
   * (YouTube lays its title, channel and buttons there) and filled with it
   * blurred; missing = DEFAULT_SAFE_BOTTOM
   */
  bottom?: number;
  /**
   * the facecam: 'off' (none: the gameplay runs up to a top safe band),
   * 'float' (as 'off', with the camera in a box on top, anywhere: `pip`) or
   * 'band' (its own band above the gameplay); missing = from `noCamera`
   */
  webcam?: WebcamMode;
  /** older layouts: no facecam ('off'); missing = 'band' */
  noCamera?: boolean;
  /** with no camera band, the top band's share of the short's height, filled with the gameplay blurred; missing = DEFAULT_SAFE_TOP */
  top?: number;
  /** the floating webcam: its top-left corner and width, as shares of the short's frame (its height follows the camera crop's shape) */
  pip?: { x: number; y: number; w: number };
}

export type WebcamMode = 'off' | 'float' | 'band';

/** One of my kills, for a short's own kill feed; `at` is timeline seconds. */
export interface FeedKill {
  at: number;
  attacker: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  wallbang?: boolean;
  noscope?: boolean;
  throughSmoke?: boolean;
  attackerSide?: Side | null;
  victimSide?: Side | null;
}

/** A vertical (9:16) short of one round, cut and edited on its own. */
export interface Short {
  id: string;
  /** game round (demo) or clip number (clips mode), as in Clip.round */
  round: number;
  layout: ShortLayout;
  edits: Edits;
  /** the YouTube export: the recording's own quality */
  outputPath: string | null;
  /** the export for Instagram, TikTok and Facebook: 1080p, made to survive their re-encoding */
  socialOutputPath?: string | null;
  /** shown over the whole short (what it's about); lines break where it has a newline */
  title?: string;
  /** YouTube Shorts titles and thumbnail text, written by Claude from the round's story */
  titles?: ShortTitles | null;
}

/** Titles written by Claude (the shape of titles/generate.ts's TitleSet, kept here so types.ts imports nothing) */
export interface ShortTitles {
  arc: string;
  ideas: { title: string; thumbnail: string; angle: string; why: string; rounds: number[] }[];
  best: number;
  generatedAt: string;
  direction: string;
}

/** A transcribed word, in recording seconds; `text` is what's shown (English or Roman Urdu). */
export interface CaptionWord {
  start: number;
  end: number;
  text: string;
}

/** One utterance's caption: Whisper's words, romanized; editable in the app. */
export interface CaptionLine {
  id: string;
  start: number;
  end: number;
  lang: 'en' | 'ur';
  /** Whisper's original text (Devanagari / Urdu / English) */
  source: string;
  words: CaptionWord[];
  edited?: boolean;
  /** left out of the captions (removed by you, or filler cleanup dropped); kept so the speech isn't transcribed again */
  removed?: boolean;
  /** rewritten into natural Roman Urdu / English by Claude */
  cleaned?: boolean;
  /** word times snapped to the pauses in the voice audio (align.ts) */
  aligned?: boolean;
}

export type CaptionStyle = 'pop' | 'clean' | 'karaoke';

export interface CaptionSettings {
  enabled: boolean;
  style: CaptionStyle;
  font: string; // font family name, see server/captions/fonts.ts
  /** text height as % of frame height */
  sizePct: number;
  /** vertical center of the caption as % of frame height */
  positionPct: number;
  uppercase: boolean;
  /** most words on screen at a time (1-4) */
  wordsPerCaption: number;
  /** a pause at least this long (seconds) starts a new caption */
  pauseS: number;
  /** rewrite transcribed lines with Claude (needs ANTHROPIC_API_KEY) */
  cleanup: boolean;
}

/** Channel intro and subscribe outro added around every reel. */
export interface Branding {
  intro: boolean;
  outro: boolean;
  /** channel name, shown big in the intro */
  name: string;
  topLine: string;
  bottomLine: string;
  /** shown under the profile picture in the outro; default "@name" */
  handle: string;
  /** profile picture for the outro (png / jpg / webp) */
  avatarPath: string;
  accent: string;
}

export interface Settings {
  steamId: string;
  preRoll: number;
  postRoll: number;
  clutchPreRoll: number;
  mergeGap: number;
  titleCards: boolean;
  /** the highlight video opens on its best shots, cut hard, the first under `label` ("MATCH HIGHLIGHTS"); about `seconds` long */
  teaser: { enabled: boolean; seconds: number; label: string; whoosh: boolean };
  /** never cut while someone is talking */
  protectSpeech: boolean;
  /** longest a cut waits for a sentence to finish before taking a breath pause */
  speechMaxWait: number;
  /** a pause between words shorter than this (seconds) is still the same sentence */
  sentenceGap: number;
  /** audio tracks that carry voice (mic / Discord); null = all tracks */
  voiceTracks: number[] | null;
  captions: CaptionSettings;
  branding: Branding;
  /** kill-feed region as fractions of frame size */
  killfeed: { x: number; y: number; w: number; h: number };
  /** clips mode: your in-game name, so your kills can be told from your death */
  playerName: string;
  /** clips mode: the round timer and score at the top of the HUD, as fractions of frame size */
  hud: { x: number; y: number; w: number; h: number };
  /** clips mode: kills further apart than this (seconds) become separate pieces */
  burstGap: number;
  /** the last layout used for a short; new shorts start from it (the facecam doesn't move between recordings) */
  shortLayout: ShortLayout;
  /** captions in a short: size and position in the vertical frame (the rest comes from `captions`) */
  shortCaptions: Pick<CaptionSettings, 'sizePct' | 'positionPct'>;
  /**
   * a short's own kill feed: my kills listed as they happen, so they can be seen
   * on a phone (the game's feed is cropped out). Top of the feed as % of the
   * frame height; null = just under the camera.
   */
  shortKillfeed: {
    enabled: boolean;
    positionPct: number | null;
    /** size against the default (1 = 100 %) */
    scale: number;
    /** which side of the short the rows line up on */
    align: 'left' | 'center' | 'right';
    /** gap between the feed and that side, % of the short's width (not used when centred) */
    sidePct: number;
    /** seconds a row stays up after its kill before it fades out, as in the game; 0 = up for the rest of the short */
    stay: number;
  };
  /**
   * a picture laid over every short (a "follow me" badge, a logo), placed by
   * dragging it in the preview. x / y (its top-left corner) and w are fractions
   * of the short's frame; its height follows the picture's own shape.
   */
  shortOverlay: {
    enabled: boolean;
    path: string;
    x: number;
    y: number;
    w: number;
    /** lined up on a side or exactly centred (kept while resizing); 'free' = where it was dragged (x) */
    align: 'free' | 'left' | 'center' | 'right';
    /** 1 = solid; lower lets the video show through */
    opacity: number;
  };
  /**
   * a short that loops: it's cut `after` seconds after the final kill and the
   * reaction from there to the end moved to the front. It opens on the
   * reaction, blends into the round's start and ends on the final kill, which
   * runs straight (same footage, no transition) into the reaction again
   */
  shortLoop: { enabled: boolean; after: number };
  /** a short's title (its text is per short): one of the title presets, its size and where its top is, as % of the frame height */
  /** aboveGameplay: kept just above the gameplay (shorts/title.ts placeTitle), whatever positionPct says */
  shortTitle: { preset: string; sizePct: number; positionPct: number; lineHeight: number; wordSpacing: number; aboveGameplay: boolean };
  /** who the creator is (role, rank, style, catchphrases, audience), for Claude's YouTube titles; the same for every match */
  creatorProfile: string;
}

export const DEFAULT_SETTINGS: Settings = {
  steamId: '',
  preRoll: 3,
  postRoll: 2,
  clutchPreRoll: 5,
  mergeGap: 1.5,
  titleCards: true,
  teaser: { enabled: true, seconds: 10, label: 'MATCH HIGHLIGHTS', whoosh: false },
  protectSpeech: true,
  speechMaxWait: 8,
  sentenceGap: 1,
  voiceTracks: null,
  captions: { enabled: true, style: 'pop', font: 'Montserrat Black', sizePct: 7, positionPct: 70, uppercase: true, wordsPerCaption: 2, pauseS: 0.7, cleanup: true },
  branding: {
    intro: true,
    outro: true,
    name: '',
    topLine: 'Recorded live at',
    bottomLine: 'Daily streams',
    handle: '',
    avatarPath: '',
    accent: '#9146ff', // Twitch purple
  },
  killfeed: { x: 0.7, y: 0.04, w: 0.3, h: 0.3 },
  playerName: '',
  hud: { x: 0.38, y: 0, w: 0.24, h: 0.08 },
  burstGap: 8,
  // a bottom-left facecam and the middle of the frame, each at its band's aspect (1080x672 / 1080x1248 of a 1920x1080 source)
  shortLayout: {
    camera: { x: 0, y: 0.65, w: 0.3, h: 0.332 },
    gameplay: { x: 0.256, y: 0, w: 0.487, h: 1 },
    split: 0.35,
    bottom: 0.15,
    // no webcam band: the gameplay between a top and a bottom safe band (a webcam can float on top, or have its band)
    webcam: 'off',
    top: 0.15,
  },
  shortCaptions: { sizePct: 4, positionPct: 35 },
  shortKillfeed: { enabled: true, positionPct: null, scale: 1, align: 'right', sidePct: 3.5, stay: 6 },
  // near the bottom, most of the width: where a "follow me" badge usually sits
  shortOverlay: { enabled: true, path: '', x: 0.1, y: 0.8, w: 0.8, align: 'center', opacity: 1 },
  shortLoop: { enabled: true, after: 0.5 },
  // TEYE's look: Bold White, big enough for a phone, a third of the way down
  // kept just above the gameplay: the same place in every short, clear of the crosshair
  shortTitle: { preset: 'bold', sizePct: 6.5, positionPct: 32, lineHeight: 0.85, wordSpacing: 1, aboveGameplay: true },
  creatorProfile: '',
};
