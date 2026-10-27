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
}

export interface Settings {
  steamId: string;
  preRoll: number;
  postRoll: number;
  clutchPreRoll: number;
  mergeGap: number;
  titleCards: boolean;
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
  killfeed: { x: 0.7, y: 0.04, w: 0.3, h: 0.3 },
};
