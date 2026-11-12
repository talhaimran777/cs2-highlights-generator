import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, waitJob, type Job, type ProjectView, type TitleSet } from './api.ts';

type Written = TitleSet & { generatedAt: string; direction: string };

/**
 * Claude's YouTube titles, each with the thumbnail text that goes with it:
 * your profile (the same for every match), a direction for the batch, and the
 * ideas to copy. Used for the match's highlight video and for each short.
 */
export function TitlesPanel({
  heading,
  intro,
  available,
  profile: savedProfile,
  saveProfile,
  titles,
  job: initialJob,
  start,
  done,
  fits,
  placeholder,
  useThumbnail,
}: {
  heading: string;
  intro: ReactNode;
  /** an Anthropic key is set */
  available: boolean;
  profile: string;
  saveProfile: (profile: string) => Promise<void>;
  titles: Written | null | undefined;
  /** the latest titles job (resumed when it's still running) */
  job: Job | null;
  start: (direction: string) => Promise<Job>;
  /** reload what the titles are shown from */
  done: () => Promise<void>;
  /** titles read best up to this many characters */
  fits: [number, number];
  placeholder: string;
  /** shorts: put a thumbnail text on the short as its on-screen title */
  useThumbnail?: (text: string) => void;
}) {
  const [profile, setProfile] = useState(savedProfile);
  const [editing, setEditing] = useState(!savedProfile.trim());
  const [direction, setDirection] = useState(titles?.direction ?? '');
  const [job, setJob] = useState<Job | null>(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const following = useRef(false);
  useEffect(() => setProfile(savedProfile), [savedProfile]);

  const follow = async (j: Job) => {
    if (following.current) return;
    following.current = true;
    try {
      const end = await waitJob(j.id, setJob);
      if (end.status === 'done') await done();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      following.current = false;
    }
  };
  // a batch still being written (the page was reloaded meanwhile): wait for it
  useEffect(() => {
    if (initialJob?.status === 'running') follow(initialJob);
  }, [initialJob?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = job?.status === 'running';
  const keepProfile = async () => {
    if (profile !== savedProfile) await saveProfile(profile);
  };
  const generate = async () => {
    setError(null);
    try {
      await keepProfile();
      const j = await start(direction);
      setJob(j);
      await follow(j);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      setError('Could not copy to the clipboard');
    }
  };

  const t = titles;
  return (
    <section className="card titles-card">
      <div className="row spread">
        <h2>{heading}</h2>
        {t && <span className="muted small">written {new Date(t.generatedAt).toLocaleString()}</span>}
      </div>
      <div className="muted small">{intro}</div>

      {!available ? (
        <div className="muted small">
          Put <span className="mono">ANTHROPIC_API_KEY=…</span> in a <span className="mono">.env</span> file in the app's folder and restart the app to write titles.
        </div>
      ) : (
        <>
          {editing ? (
            <label className="field">
              <span>About you (the same for every match and short)</span>
              <textarea
                className="input titles-profile"
                rows={4}
                maxLength={2000}
                placeholder="Who you are and how you play: e.g. Pakistani AWPer, Faceit level 8, streams daily on Twitch, loud reactions, catchphrase “bhai kya scene hai”, audience: South Asian CS2 fans"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                onBlur={() => keepProfile().catch((e) => setError(String(e.message ?? e)))}
              />
            </label>
          ) : (
            <div className="row titles-profile-line">
              <span className="muted small">About you:</span>
              <span className="small ellipsis">{profile}</span>
              <button className="btn btn-xs" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          )}
          <div className="row">
            <input
              className="input titles-direction"
              maxLength={300}
              placeholder={placeholder}
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !running && generate()}
            />
            <button className="btn btn-primary" disabled={running} onClick={generate}>
              {running ? 'Writing titles…' : t ? 'Write new titles' : 'Write titles'}
            </button>
          </div>
        </>
      )}
      {running && <div className="muted small">Claude is reading it… this takes about a minute.</div>}
      {error && <div className="error">{error}</div>}
      {job?.status === 'error' && !running && <div className="error">{job.error}</div>}

      {t && (
        <>
          <div className="titles-arc">
            <span className="muted small">The story</span>
            <p>{t.arc}</p>
          </div>
          <ol className="titles-list">
            {t.ideas.map((idea, i) => (
              <li key={i} className={`title-idea ${i === t.best ? 'best' : ''}`}>
                <div className="title-idea-main">
                  <div className="row title-idea-head">
                    <div className="title-idea-text">{idea.title}</div>
                    <button className="btn btn-sm" onClick={() => copy(`t${i}`, idea.title)}>
                      {copied === `t${i}` ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  {idea.thumbnail && (
                    <div className="row wrap title-thumb">
                      <span className="muted small">Thumbnail</span>
                      <span className="title-thumb-text">{idea.thumbnail}</span>
                      <button className="btn btn-xs" onClick={() => copy(`b${i}`, idea.thumbnail)}>
                        {copied === `b${i}` ? 'Copied' : 'Copy'}
                      </button>
                      {useThumbnail && (
                        <button className="btn btn-xs" title="Show it over the short as its on-screen title" onClick={() => useThumbnail(idea.thumbnail)}>
                          Put on the short
                        </button>
                      )}
                    </div>
                  )}
                  <div className="row wrap small">
                    {i === t.best && <span className="title-chip best">Best</span>}
                    <span className="title-chip">{idea.angle}</span>
                    <span className={`mono ${idea.title.length > fits[1] ? 'warn-text' : 'muted'}`} title={`Best at ${fits[0]}-${fits[1]} characters`}>
                      {idea.title.length} chars
                    </span>
                    {idea.rounds.length > 0 && <span className="muted">round{idea.rounds.length > 1 ? 's' : ''} {idea.rounds.join(', ')}</span>}
                  </div>
                  <div className="muted small">{idea.why}</div>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** The highlight video's titles (Export step): Claude reads the whole match from the demo. */
export function TitlesCard({ p, setP }: { p: ProjectView; setP: (p: ProjectView) => void }) {
  if (!p.titlesPossible) return null;
  return (
    <TitlesPanel
      heading="YouTube titles"
      intro={
        <>
          Claude reads the whole match from the demo (every round, your kills, clutches and the score){p.transcript?.length ? ' and what you said' : ''}, then writes
          storytelling titles with you as the hero, each with thumbnail text to go with it. Titles only promise rounds that are in your reel.
        </>
      }
      available={p.titlesAvailable}
      profile={p.creatorProfile}
      saveProfile={async (creatorProfile) => setP(await api.patch(p.id, { settings: { creatorProfile } }))}
      titles={p.titles}
      job={p.titlesJob}
      start={(direction) => api.writeTitles(p.id, direction)}
      done={async () => setP(await api.get(p.id))}
      fits={[40, 60]}
      placeholder="Direction for this batch (optional), e.g. focus on the overtime, or on my AWP rounds"
    />
  );
}
