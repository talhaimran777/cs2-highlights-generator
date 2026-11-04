import Anthropic from '@anthropic-ai/sdk';
import type { FeedEntry, HudSample } from '../types.ts';

// Claude reads the screenshots the local scan picked out of a replay clip:
// the red-outlined kill-feed entries (mine: a kill, my death or an assist)
// and the round timer and score, which show where a new round starts.
// Claude copies each entry as written; which of them are my kills is decided
// here by matching my name, since "TEYEcs + mate -> enemy" (my kill, mate
// assisted) was easy to read the wrong way round.

const MODEL = 'claude-opus-5-5';
/**
 * A kill-feed entry seen again this soon is the same entry, still on screen.
 * Shots come every couple of seconds while an entry is up, so a longer gap
 * means it went away and this is a new kill with the same names (two enemies
 * both called "M", or a fancy name read as a plain one).
 */
const SAME_ENTRY_S = 5;

export interface Shot {
  t: number; // seconds into the clip
  png: Buffer;
}

const SYSTEM = `You read screenshots from Counter-Strike 2 gameplay recorded by one player ("me").

Kill-feed screenshots show the top-right kill feed. Entries that involve me have a red outline. Each entry reads, left to right:
  KILLER [+ ASSISTER] WEAPON-ICON [HEADSHOT-ICON] VICTIM
The name left of the "+" is always the killer and the name right of the "+" is the assister, whoever they are.
List only the red-outlined entries in each screenshot, top to bottom, copying what is written:
- killer: the first name (empty string if there is none, e.g. a fall or bomb death).
- assister: the name after the "+", or an empty string when there is no "+".
- victim: the name right of the weapon icon.
- Names exactly as written, including clan tags in brackets.
- weapon: the weapon's name if you can tell it from the icon (ak47, m4a1-s, awp, deagle, usp-s, glock, knife, ...), else an empty string.
- headshot: true when the headshot icon is shown.

HUD screenshots show the top centre of the screen: the round timer between the two team scores. For each, give:
- timer: the round timer exactly as shown ("1:42", "0:07"), or an empty string when it isn't shown (bomb planted icon, round over, warmup) or can't be read.
- left and right: the two scores, left and right of the timer, or -1 when they can't be read.

Every screenshot is labelled with its number. Return every screenshot once.`;

const SCHEMA = {
  type: 'object',
  properties: {
    feed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          shot: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                killer: { type: 'string' },
                assister: { type: 'string' },
                victim: { type: 'string' },
                weapon: { type: 'string' },
                headshot: { type: 'boolean' },
              },
              required: ['killer', 'assister', 'victim', 'weapon', 'headshot'],
              additionalProperties: false,
            },
          },
        },
        required: ['shot', 'entries'],
        additionalProperties: false,
      },
    },
    hud: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          shot: { type: 'integer' },
          timer: { type: 'string' },
          left: { type: 'integer' },
          right: { type: 'integer' },
        },
        required: ['shot', 'timer', 'left', 'right'],
        additionalProperties: false,
      },
    },
  },
  required: ['feed', 'hud'],
  additionalProperties: false,
};

/** A kill-feed entry as written on screen. */
export interface RawEntry {
  killer: string;
  assister: string;
  victim: string;
  weapon: string;
  headshot: boolean;
}

interface Reply {
  feed: { shot: number; entries: RawEntry[] }[];
  hud: { shot: number; timer: string; left: number; right: number }[];
}

/** A name without clan tags, case or symbols: "[ViVa] TEYEcs!" -> "teyecs". */
export const nameKey = (s: string) => s.replace(/\[[^\]]*\]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Same player, allowing one misread letter in a longer name. */
export function sameName(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 5 || Math.abs(x.length - y.length) > 1) return false;
  // edit distance of at most 1
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (x.length > y.length) i++;
    else if (y.length > x.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

/**
 * Who "me" is in a clip: the name given, if it shows up in the red entries;
 * otherwise the name that shows up most (every red entry involves me).
 */
export function whoIsMe(entries: RawEntry[], playerName: string): string {
  const names = entries.flatMap((e) => [e.killer, e.assister, e.victim]).filter((n) => nameKey(n));
  if (playerName.trim() && names.some((n) => sameName(n, playerName))) return playerName;
  const count = new Map<string, { name: string; n: number }>();
  for (const n of names) {
    const c = count.get(nameKey(n)) ?? { name: n, n: 0 };
    c.n++;
    count.set(nameKey(n), c);
  }
  return [...count.values()].sort((a, b) => b.n - a.n)[0]?.name ?? playerName;
}

/** My kill, my death or my assist; null when I'm not in the entry (misread). */
export function classify(e: RawEntry, me: string): FeedEntry['kind'] | null {
  if (sameName(e.victim, me)) return 'death';
  if (sameName(e.killer, me)) return 'kill';
  if (sameName(e.assister, me)) return 'assist';
  return null;
}

export const readerAvailable = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** "1:42" -> 102 */
export function parseTimer(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The entries that appeared in each kill-feed shot: an entry still on screen
 * from the shot before (same attacker and victim) isn't new. Each new entry
 * gets the time of the shot where it first showed up.
 */
export function newEntries(feed: { t: number; entries: Omit<FeedEntry, 't'>[] }[]): FeedEntry[] {
  const seen = new Map<string, number>();
  const out: FeedEntry[] = [];
  for (const shot of [...feed].sort((a, b) => a.t - b.t)) {
    for (const e of shot.entries) {
      const key = `${e.attacker.toLowerCase()}|${e.victim.toLowerCase()}`;
      const last = seen.get(key);
      if (last === undefined || shot.t - last > SAME_ENTRY_S) out.push({ ...e, t: shot.t });
      seen.set(key, shot.t);
    }
  }
  return out;
}

/** One request per clip: kill-feed shots (taken when a new red entry appeared) and HUD shots. */
export async function readClip(
  feedShots: Shot[],
  hudShots: Shot[],
  playerName: string,
  signal?: AbortSignal,
): Promise<{ entries: FeedEntry[]; hud: HudSample[]; usage: { input: number; output: number } }> {
  // Claude only copies what's written; whose kill it is gets decided here, by name
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const shots = [...feedShots.map((s) => ({ ...s, kind: 'Kill feed' })), ...hudShots.map((s) => ({ ...s, kind: 'HUD' }))];
  shots.forEach((s, i) => {
    content.push({ type: 'text', text: `Screenshot ${i} · ${s.kind} at ${s.t.toFixed(1)}s` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: s.png.toString('base64') } });
  });

  const client = new Anthropic();
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // a safety decline is retried on another model instead of failing the job
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    },
    { signal },
  );
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Reading the clip was declined by the model');
  if (msg.stop_reason === 'max_tokens') throw new Error('Reading the clip ran out of output space');
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const reply = JSON.parse(text) as Reply;

  const read = reply.feed.filter((f) => shots[f.shot]?.kind === 'Kill feed');
  const me = whoIsMe(read.flatMap((f) => f.entries), playerName);
  const feed = read.map((f) => ({
    t: shots[f.shot].t,
    entries: f.entries.flatMap((e) => {
      const kind = classify(e, me);
      return kind ? [{ kind, attacker: e.killer, assister: e.assister, victim: e.victim, weapon: e.weapon, headshot: e.headshot }] : [];
    }),
  }));
  const hud = reply.hud
    .filter((h) => shots[h.shot]?.kind === 'HUD')
    .map((h) => ({
      t: shots[h.shot].t,
      timer: parseTimer(h.timer),
      left: h.left >= 0 ? h.left : null,
      right: h.right >= 0 ? h.right : null,
    }))
    .sort((a, b) => a.t - b.t);
  return { entries: newEntries(feed), hud, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens } };
}
