import { describe, expect, it } from 'vitest';
import { deathVictim } from '../server/demo/parse.ts';

// player_death rows as demoparser2 gives them for this match's demo
const death = (extra: Record<string, unknown>) => ({
  event_name: 'player_death', tick: 112058, weapon: 'm4a1_silencer',
  attacker_name: 'TEYEcs', attacker_steamid: '76561198808407425', attacker_team_num: 3,
  user_name: null, user_steamid: null, user_team_num: null, ...extra,
});

describe('deaths of bots', () => {
  it('a kill on a bot the parser knows nothing about is still a kill, on the enemy team', () => {
    expect(deathVictim(death({}))).toEqual({ id: 'bot:112058', name: 'BOT', side: 'T' });
  });

  it('a named bot (steam id 0) gets an id from its name', () => {
    expect(deathVictim(death({ user_name: 'Operator', user_steamid: '0', user_team_num: 2 }))).toEqual({ id: 'bot:Operator', name: 'Operator', side: 'T' });
  });

  it('a "world" death with no killer is a bot being removed, not a kill', () => {
    expect(deathVictim(death({ attacker_name: null, attacker_steamid: null, attacker_team_num: null, weapon: 'world' }))).toBeNull();
  });

  it('a normal death is unchanged', () => {
    expect(deathVictim(death({ user_name: 'Icy2979', user_steamid: '76561199861995063', user_team_num: 2 }))).toEqual({
      id: '76561199861995063', name: 'Icy2979', side: 'T',
    });
  });
});
