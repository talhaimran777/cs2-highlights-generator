// Shared data model. Everything time-related in the demo is in ticks;
// everything in the recording is in seconds. sync/ converts between them.

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

export interface MatchData {
  demoPath: string;
  map: string;
  tickrate: number;
  players: Player[];
  rounds: Round[];
  kills: Kill[];
  bombs: BombEvent[];
  combat: CombatEvent[];
}

/** Where I ended up after leaving spawn, per round. */
export interface RoundIntro {
  /** tick I settled at my spot (or the search window ran out) */
  arriveTick: number;
  place: string;
}

export type MomentKind = 'intro' | 'kills' | 'clutch' | 'bomb' | 'assist' | 'team' | 'decider' | 'death' | 'funny';

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
}

/** Cuts made in the editor. Recording seconds, so they survive re-planning the clips. */
export interface Edits {
  /** removed ranges */
  cuts: [number, number][];
  /** extra edit points (S / Ctrl+K) */
  splits: number[];
}

export const NO_EDITS: Edits = { cuts: [], splits: [] };

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
  /** never cut while someone is talking */
  protectSpeech: boolean;
  /** longest a cut waits for a sentence to finish before taking a breath pause */
  speechMaxWait: number;
  /** audio tracks that carry voice (mic / Discord); null = all tracks */
  voiceTracks: number[] | null;
  captions: CaptionSettings;
  branding: Branding;
  /** kill-feed region as fractions of frame size */
  killfeed: { x: number; y: number; w: number; h: number };
}

export const DEFAULT_SETTINGS: Settings = {
  steamId: '',
  preRoll: 3,
  postRoll: 2,
  clutchPreRoll: 5,
  mergeGap: 1.5,
  titleCards: true,
  protectSpeech: true,
  speechMaxWait: 8,
  voiceTracks: null,
  captions: { enabled: true, style: 'pop', font: 'Montserrat Black', sizePct: 7, positionPct: 70, uppercase: true, cleanup: true },
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
};
