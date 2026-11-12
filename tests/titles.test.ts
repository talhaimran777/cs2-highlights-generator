import { describe, expect, it } from 'vitest';
import { buildStory, shortStoryFromClip, shortStoryFromMatch, lastAlive, mapName, roundsToWin, MAX_SAID, MAX_SAID_CHARS, type StoryInput } from '../server/titles/story.ts';
import { parseTitles, shortTitlePrompt, titlePrompt, TITLE_COUNT } from '../server/titles/generate.ts';
import type { CaptionLine, Kill, MatchData, Moment, Round, Side, SyncModel } from '../server/types.ts';

const TICK = 64;
// round n runs from (n-1)*100 s to (n-1)*100 + 90 s of demo time
const start = (n: number) => (n - 1) * 100 * TICK;
const at = (n: number, sec: number) => start(n) + sec * TICK;
const side = (n: number, mine: boolean): Side => ((n <= 3) === mine ? 'T' : 'CT'); // sides switch after round 3
const roster = (n: number) => ({ me: side(n, true), m1: side(n, true), m2: side(n, true), e1: side(n, false), e2: side(n, false), e3: side(n, false) });
const NAMES: Record<string, string> = { me: 'Teyecs', m1: 'Mate1', m2: 'Mate2', e1: 'Enemy1', e2: 'Enemy2', e3: 'Enemy3' };

const kill = (n: number, sec: number, attacker: string, victim: string, extra: Partial<Kill> = {}): Kill => ({
  tick: at(n, sec), round: n, attacker, attackerName: NAMES[attacker], attackerSide: roster(n)[attacker as keyof ReturnType<typeof roster>],
  victim, victimName: NAMES[victim], victimSide: roster(n)[victim as keyof ReturnType<typeof roster>], assister: null, assisterName: '', flashAssist: false,
  weapon: 'ak47', headshot: false, wallbang: false, noscope: false, throughSmoke: false, attackerBlind: false, ...extra,
});

// lost 0-3, sides switch, then won four in a row: 4-3
const SCORES: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [3, 3], [4, 3]];
const rounds: Round[] = SCORES.map(([us, them], i) => {
  const n = i + 1;
  const won = n >= 4;
  return { num: n, startTick: start(n), endTick: at(n, 90), winner: won ? side(n, true) : side(n, false), reason: won ? 'bomb_defused' : 't_killed', roster: roster(n), score: { us, them } };
});

const kills: Kill[] = [
  // round 1: the opening kill is theirs, I die to it; I'd planted
  kill(1, 20, 'e1', 'me', { weapon: 'awp' }),
  // round 4: my 3K (a headshot and a wallbang), and a teamkill that doesn't count
  kill(4, 10, 'me', 'e1', { headshot: true }),
  kill(4, 12, 'me', 'e2', { wallbang: true }),
  kill(4, 15, 'me', 'm1', { attackerSide: 'CT', victimSide: 'CT' }),
  kill(4, 30, 'me', 'e3', { weapon: 'deagle' }),
  // round 5: both mates die, I'm alone against three and we win (on the defuse)
  kill(5, 10, 'e1', 'm1'),
  kill(5, 12, 'e2', 'm2'),
  kill(5, 40, 'me', 'e1', { headshot: true }),
  kill(5, 45, 'me', 'e2'),
];

const match: MatchData = {
  demoPath: '', map: 'de_dust2', tickrate: TICK, players: Object.entries(NAMES).map(([steamId, name]) => ({ steamId, name })), rounds, kills,
  bombs: [{ tick: at(1, 15), round: 1, kind: 'planted', player: 'me', site: 'A' }], combat: [],
};
// the recording starts 10 s before the demo
const sync: SyncModel = { tickrate: TICK, offset: 10, scale: 1, roundOffsets: {}, method: 'manual', inliers: 1, rmsError: 0, confident: true };
const line = (id: string, from: number, text: string, extra: Partial<CaptionLine> = {}): CaptionLine => ({
  id, start: from, end: from + 1.5, lang: 'ur', source: text, words: text.split(' ').map((w, i) => ({ start: from + i * 0.2, end: from + i * 0.2 + 0.2, text: w })), ...extra,
});
// round 4 is 310 s to 400 s of the recording
const transcript: CaptionLine[] = [
  line('a', 12, 'ye kya tha', { removed: true }),
  ...Array.from({ length: 8 }, (_, i) => line(`r4-${i}`, 312 + i * 10, `line ${i} bhai`)),
  line('long', 395, 'x'.repeat(200)),
];
const moments = [{ round: 4, kind: 'kills', label: '3K (1 HS)' }, { round: 5, kind: 'clutch', label: '1v2 clutch' }, { round: 1, kind: 'death', label: 'Death' }] as Moment[];
const input = (extra: Partial<StoryInput> = {}): StoryInput => ({
  match, me: 'me', channel: 'Teyecs TV', sync, moments, intros: { 4: { arriveTick: at(4, 5), place: 'Long A' } }, transcript, featured: new Set([4, 5]), ...extra,
});

describe('the match as a story', () => {
  it('names the map the way people say it', () => {
    expect(mapName('de_dust2')).toBe('Dust2');
    expect(mapName('de_ancient')).toBe('Ancient');
    expect(mapName('cs_office')).toBe('Office');
  });

  it('the match: result, scores at the end and at half time', () => {
    const s = buildStory(input());
    expect(s.me).toEqual({ name: 'Teyecs', channel: 'Teyecs TV' });
    expect(s.match).toEqual({ map: 'Dust2', result: 'win', finalScore: '4-3', halfTime: '0-3', rounds: 7, overtime: false });
  });

  it('per round: my kills with their extras, my death, the bomb and how it ended', () => {
    const s = buildStory(input());
    const r1 = s.rounds[0];
    expect(r1).toMatchObject({ round: 1, side: 'T', won: false, score: '0-1', ended: 'Ts eliminated', bomb: 'planted at A', kills: [] });
    expect(r1.died).toEqual({ at: 20, by: 'Enemy1', weapon: 'AWP' });
    const r4 = s.rounds[3];
    expect(r4.kills).toEqual([
      { at: 10, victim: 'Enemy1', weapon: 'AK-47', extras: ['headshot'] },
      { at: 12, victim: 'Enemy2', weapon: 'AK-47', extras: ['wallbang'] },
      { at: 30, victim: 'Enemy3', weapon: 'Desert Eagle', extras: [] }, // the round ended on the defuse, not a kill
    ]);
    expect(r4).toMatchObject({ side: 'CT', won: true, ended: 'bomb defused', place: 'Long A', highlights: ['3K (1 HS)'], died: null });
  });

  it('a kill that ended the round (a wipe) is marked', () => {
    const wiped = { ...match, rounds: rounds.map((r) => (r.num === 4 ? { ...r, reason: 't_killed' } : r)) };
    expect(buildStory(input({ match: wiped })).rounds[3].kills.map((k) => k.extras)).toEqual([['headshot'], ['wallbang'], ['ended the round']]);
  });

  it('the teamkill is not one of my kills', () => {
    const s = buildStory(input());
    expect(s.stats.kills).toBe(5);
    expect(s.rounds[3].kills.map((k) => k.victim)).not.toContain('Mate1');
  });

  it('a clutch: last alive against three, and won', () => {
    expect(lastAlive(rounds[4], kills.filter((k) => k.round === 5), 'me')).toEqual({ vs: 3, won: true });
    const s = buildStory(input());
    expect(s.rounds[4].clutch).toEqual({ vs: 3, won: true });
    expect(s.stats.clutches).toEqual({ tried: 1, won: 1, best: '1v3 in round 5' });
    // not last alive: no clutch
    expect(s.rounds[3].clutch).toBeNull();
  });

  it('the arc: down 0-3, a comeback, four in a row, the rounds I carried', () => {
    const { arc, stats } = buildStory(input());
    expect(arc.biggestDeficit).toEqual({ by: 3, at: '0-3', round: 3 });
    expect(arc.comeback).toBe(true);
    expect(arc.longestWinStreak).toEqual({ rounds: 4, from: 4, to: 7 });
    expect(arc.decidingRound).toBe(7);
    expect(arc.matchPoints).toEqual([]); // nobody got near 13
    expect(arc.roundsICarried).toEqual([4, 5]);
    expect(stats).toMatchObject({ headshotPct: 40, multiKills: { '3K': 1, '4K': 0, ace: 0 }, openingKills: 1, deaths: 1 });
  });

  it('match points follow the rules: first to 13, then 16, 19… in overtime', () => {
    expect([1, 24, 25, 30, 31, 36, 37].map(roundsToWin)).toEqual([13, 13, 16, 16, 19, 19, 22]);
  });

  it('each half in rounds won-lost, and every run of 3+ won or lost in a row', () => {
    const { arc } = buildStory(input());
    expect(arc.halves).toEqual([
      { half: 1, rounds: '1-3', side: 'T', result: '0-3' },
      { half: 2, rounds: '4-7', side: 'CT', result: '4-0' },
    ]);
    expect(arc.runs).toEqual([
      { won: false, rounds: 3, from: 1, to: 3, scoreBefore: '0-0', scoreAfter: '0-3' },
      { won: true, rounds: 4, from: 4, to: 7, scoreBefore: '0-3', scoreAfter: '4-3' },
    ]);
  });

  it('overtimes: the score in and out of each, and whether it was won, lost or tied into another', () => {
    // 12-12 after regulation, 15-15 after the first overtime, 19-17 at the end of the second
    const path: [number, number][] = [];
    for (let n = 1; n <= 24; n++) path.push([Math.ceil(n / 2), Math.floor(n / 2)]);
    for (const [us, them] of [[12, 13], [12, 14], [12, 15], [13, 15], [14, 15], [15, 15], [16, 15], [17, 15], [17, 16], [18, 16], [18, 17], [19, 17]]) path.push([us, them]);
    const long = { ...match, kills: [], bombs: [], rounds: path.map(([us, them], i) => ({ num: i + 1, startTick: start(i + 1), endTick: at(i + 1, 90), winner: null, reason: 't_killed', roster: {}, score: { us, them } })) };
    expect(buildStory(input({ match: long })).arc.overtimes).toEqual([
      { period: 1, rounds: '25-30', from: '12-12', to: '15-15', result: 'tied' },
      { period: 2, rounds: '31-36', from: '15-15', to: '19-17', result: 'won' },
    ]);
    expect(buildStory(input()).arc.overtimes).toEqual([]);
  });

  it('highlights are my own plays: teammates, the enemy bomb and single kills are left out', () => {
    const extra = [
      { round: 4, kind: 'team', label: 'Teammate clutch · Mate1 1v4' },
      { round: 4, kind: 'bomb', label: 'Bomb planted (A) · Enemy1' },
      { round: 4, kind: 'kills', label: 'Kill · deagle' },
    ] as Moment[];
    expect(buildStory(input({ moments: [...moments, ...extra] })).rounds[3].highlights).toEqual(['3K (1 HS)']);
  });

  it('only the rounds in the reel are featured', () => {
    expect(buildStory(input()).rounds.filter((r) => r.featured).map((r) => r.round)).toEqual([4, 5]);
  });

  it('what I said lands in its round, capped and shortened; removed lines are left out', () => {
    const s = buildStory(input());
    expect(s.rounds[0].said).toEqual([]);
    const said = s.rounds[3].said;
    expect(said).toHaveLength(MAX_SAID);
    expect(said.every((l) => l.length <= MAX_SAID_CHARS)).toBe(true);
    // the lines nearest my kills (322, 324, 340 s in the recording) and the round's end (400 s) are kept
    expect(said).toContain('line 1 bhai');
    expect(said).toContain('line 3 bhai');
    expect(said.at(-1)!.endsWith('…')).toBe(true);
    // no transcript, or no sync: nothing said
    expect(buildStory(input({ transcript: null })).rounds[3].said).toEqual([]);
    expect(buildStory(input({ sync: null })).rounds[3].said).toEqual([]);
  });

  it('a lost match is no comeback', () => {
    const lost = { ...match, rounds: rounds.slice(0, 3) };
    const s = buildStory(input({ match: lost }));
    expect(s.match.result).toBe('loss');
    expect(s.arc.comeback).toBe(false);
  });
});

describe('titles from Claude', () => {
  const idea = (title: string, thumbnail = 'NO WAY') => ({ title, thumbnail, angle: 'comeback', why: 'stakes', rounds: [4] });

  it('reads the reply, tidying it', () => {
    const t = parseTitles(JSON.stringify({ arc: ' Down 0-3, then… ', titles: [idea('  DOWN 0-3   and then THIS '), idea(''), idea('1v3 to win it')], best: 1 }));
    expect(t.arc).toBe('Down 0-3, then…');
    expect(t.ideas.map((i) => i.title)).toEqual(['DOWN 0-3 and then THIS', '1v3 to win it']);
    expect(t.best).toBe(1);
  });

  it('each title comes with its thumbnail text, tidied; an older reply without one has none', () => {
    const t = parseTitles(JSON.stringify({ arc: '', titles: [idea('a', '  10-0?!  '), { title: 'b', angle: '', why: '', rounds: [] }], best: 0 }));
    expect(t.ideas.map((i) => i.thumbnail)).toEqual(['10-0?!', '']);
  });

  it('a best index out of range points at the first title', () => {
    expect(parseTitles(JSON.stringify({ arc: '', titles: [idea('a')], best: 7 })).best).toBe(0);
  });

  it('a reply without titles is an error', () => {
    expect(() => parseTitles('{"arc":"x","titles":[],"best":0}')).toThrow(/no titles/);
    expect(() => parseTitles('not json')).toThrow();
  });

  it('the prompt has the story, and the profile and direction when given', () => {
    const story = buildStory(input());
    const bare = titlePrompt(story, ' ', '');
    expect(bare.startsWith('The match:')).toBe(true);
    expect(JSON.parse(bare.slice('The match:\n'.length)).match.finalScore).toBe('4-3');
    const full = titlePrompt(story, 'Pakistani AWPer, loud reactions', 'focus on the clutch');
    expect(full).toContain('About me, the creator:\nPakistani AWPer, loud reactions');
    expect(full).toContain('Direction for these titles: focus on the clutch');
    expect(TITLE_COUNT).toBe(10);
  });
});

describe("a short's round as a story", () => {
  it('the round with its score before and after, and what was at stake', () => {
    // round 4: my 3K, the first round after the sides switched (0-3 going in)
    const s = shortStoryFromMatch(buildStory(input()), 4);
    expect(s.round).toMatchObject({ round: 4, multiKill: '3K', side: 'CT', won: true, scoreBefore: '0-3', scoreAfter: '1-3', ended: 'bomb defused', place: 'Long A', killsTimedFrom: 'round start' });
    expect(s.round.kills).toHaveLength(3);
    expect(s.round.said.length).toBeGreaterThan(0);
    expect(s.match).toMatchObject({ map: 'Dust2', result: 'win', finalScore: '4-3' });
    // the first round of each half is a pistol round
    expect(shortStoryFromMatch(buildStory(input()), 1).round.stakes).toContain('pistol round');
    expect(shortStoryFromMatch(buildStory(input()), 4).round.stakes).toContain('pistol round');
    // the match's last round
    expect(shortStoryFromMatch(buildStory(input()), 7).round.stakes).toContain('the last round of the match (win)');
    expect(() => shortStoryFromMatch(buildStory(input()), 99)).toThrow();
  });

  it('match point for us, for them, and overtime', () => {
    // 12-11 going into round 24, then 12-12, then overtime from round 25
    const path: [number, number][] = [];
    for (let n = 1; n <= 22; n++) path.push([Math.ceil(n / 2), Math.floor(n / 2)]);
    path.push([12, 11], [12, 12], [12, 13], [13, 13]);
    const long = { ...match, kills: [], bombs: [], rounds: path.map(([us, them], i) => ({ num: i + 1, startTick: start(i + 1), endTick: at(i + 1, 90), winner: null, reason: 't_killed', roster: {}, score: { us, them } })) };
    const story = buildStory(input({ match: long }));
    expect(shortStoryFromMatch(story, 24).round.stakes).toContain('match point for us');
    expect(shortStoryFromMatch(story, 23).round.stakes).not.toContain('match point for us');
    const ot = shortStoryFromMatch(story, 26).round.stakes;
    expect(ot).toContain('overtime 1');
  });

  it('from a recorded clip: kills timed from the first, the death, the HUD score, no match', () => {
    const s = shortStoryFromClip({
      name: 'TEYEcs', channel: ' ', round: 3, died: true, scoreOnScreen: '4-2',
      kills: [{ at: 112.5, victim: 'b', weapon: 'awp', headshot: false }, { at: 110, victim: 'a', weapon: 'ak47', headshot: true }, { at: 115, victim: 'c', weapon: 'ak47', headshot: false }],
    });
    expect(s.me).toEqual({ name: 'TEYEcs', channel: null });
    expect(s.round.kills).toEqual([
      { at: 0, victim: 'a', weapon: 'AK-47', extras: ['headshot'] },
      { at: 2.5, victim: 'b', weapon: 'AWP', extras: [] },
      { at: 5, victim: 'c', weapon: 'AK-47', extras: [] },
    ]);
    expect(s.round).toMatchObject({ multiKill: '3K', died: true, scoreOnScreen: '4-2', killsTimedFrom: 'first kill', won: null, stakes: [] });
    expect(s.match).toBeNull();
  });

  it('the Shorts prompt has the round, and the profile and direction when given', () => {
    const story = shortStoryFromMatch(buildStory(input()), 4);
    const bare = shortTitlePrompt(story, '', '');
    expect(JSON.parse(bare.slice('The short:\n'.length)).round.multiKill).toBe('3K');
    expect(shortTitlePrompt(story, 'AWPer', 'match point')).toContain('Direction for these titles: match point');
  });
});
