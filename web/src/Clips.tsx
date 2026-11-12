import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, fmtTime, waitJob, type FsEntry, type Job, type Moment, type ProjectView, type Source } from './api.ts';
import { Progress } from './ui.tsx';
import { CreateShortButton } from './Short.tsx';

// Clips mode: OBS replay-buffer clips, no demo. Pick a folder, let the app
// read each clip's kill feed and round timer, keep the last round's kills.

const VIDEO_EXT = ['.mp4', '.mkv', '.mov', '.flv', '.ts'];
const LAST_DIR_KEY = 'cs2h:lastDir:clips';
// claude-opus-5-5, per million tokens
const INPUT_USD = 4;
const OUTPUT_USD = 20;

type Update = (fn: () => Promise<ProjectView>) => Promise<void>;

function readLastDir() {
  try {
    return localStorage.getItem(LAST_DIR_KEY) ?? '';
  } catch {
    return '';
  }
}

const READ_FEED_KEY = 'cs2h:readKillfeed';

/** Whether new clips are CS2 clips whose kill feed is read: remembered on this computer (off at first). */
export function useReadKillfeed(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(READ_FEED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(READ_FEED_KEY, v ? '1' : '0');
    } catch {
      // not remembered: fine
    }
  };
  return [on, set];
}

/**
 * CS2 or any game: ticked, Claude reads the clips' kill feed (your kills,
 * what's kept, the short's kill feed), which needs your in-game name; unticked
 * (GTA, anything), every clip is used whole and nothing is read.
 */
export function KillfeedChoice({ on, setOn, name, setName }: { on: boolean; setOn: (on: boolean) => void; name: string; setName: (n: string) => void }) {
  return (
    <>
      <label className="row">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>CS2: read the kill feed with Claude</span>
        <span className="muted small">{on ? 'finds your kills (Claude sees a few small screenshots)' : 'off: any game, every clip used whole, nothing read'}</span>
      </label>
      {on && (
        <label className="field">
          <span>Your in-game name</span>
          <input className="input" placeholder="As it shows in the kill feed" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
    </>
  );
}

/** New clips project: a folder of replay clips (oldest first, untick any) and, for CS2, your in-game name. */
export function ClipsForm() {
  const [dir, setDir] = useState(readLastDir);
  const [listing, setListing] = useState<{ path: string; parent: string | null; entries: FsEntry[] } | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [read, setRead] = useReadKillfeed();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => void api.health().then((h) => setName(h.settings.playerName ?? '')).catch(() => {}), []);
  useEffect(() => {
    api
      .fs(dir)
      .then((l) => {
        setListing(l);
        setError('');
        try {
          localStorage.setItem(LAST_DIR_KEY, l.path);
        } catch {}
      })
      .catch((e) => {
        setError(e.message);
        if (dir) setDir('');
      });
  }, [dir]);

  const folders = listing?.entries.filter((e) => e.dir) ?? [];
  // replay clips are saved as they happen, so the save time is the match order
  const clips = useMemo(
    () =>
      (listing?.entries ?? [])
        .filter((e) => !e.dir && VIDEO_EXT.some((x) => e.name.toLowerCase().endsWith(x)))
        .sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0) || a.name.localeCompare(b.name)),
    [listing],
  );
  const chosen = clips.filter((c) => !skipped.has(c.path));

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const p = await api.createClips(
        chosen.map((c) => c.path),
        name,
        read,
      );
      location.hash = p.id;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <KillfeedChoice on={read} setOn={setRead} name={name} setName={setName} />
      <div className="field">
        <span>Clips folder</span>
        <div className="browser">
          <div className="browser-path mono">
            {listing?.parent !== null && listing?.parent !== undefined && (
              <button className="btn btn-sm" onClick={() => setDir(listing.parent ?? '')}>
                ↑ Up
              </button>
            )}
            <span>{listing?.path || 'This PC'}</span>
          </div>
          <ul className="browser-list">
            {folders.map((e) => (
              <li key={e.path} className="dir" onClick={() => setDir(e.path)}>
                <span>📁</span>
                <span className="name">{e.name}</span>
              </li>
            ))}
            {clips.map((c) => (
              <li
                key={c.path}
                className="file"
                onClick={() =>
                  setSkipped((s) => {
                    const next = new Set(s);
                    if (!next.delete(c.path)) next.add(c.path);
                    return next;
                  })
                }
              >
                <input type="checkbox" readOnly checked={!skipped.has(c.path)} />
                <span className="name">{c.name}</span>
                <span className="muted small">{c.mtime ? new Date(c.mtime).toLocaleString() : ''}</span>
              </li>
            ))}
            {folders.length + clips.length === 0 && <li className="muted empty">Nothing here</li>}
          </ul>
        </div>
        {clips.length > 0 && (
          <span className="muted small">
            {chosen.length} of {clips.length} clips, oldest first. Click a clip to leave it out.
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn btn-primary" disabled={chosen.length === 0 || busy} onClick={create}>
        {busy ? 'Opening clips…' : `Use ${chosen.length} clips`}
      </button>
    </>
  );
}

const killCount = (s: Source) => s.analysis?.entries.filter((e) => e.kind === 'kill').length ?? 0;

function clipStatus(s: Source, moments: Moment[]) {
  if (s.error) return <span className="pill pill-bad" title={s.error}>Couldn’t read</span>;
  if (!s.analysis) return <span className="muted small">Not read yet</span>;
  if (moments.length === 0) return <span className="muted small">{killCount(s) ? 'No kills in the last round' : 'No kills of yours found'}</span>;
  const kept = moments.reduce((n, m) => n + (Number(/^(\d)K/.exec(m.label)?.[1]) || (m.label.startsWith('ACE') ? 5 : 1)), 0);
  return <span className="pill pill-ok">{kept} kill{kept === 1 ? '' : 's'} kept</span>;
}

/** Reads the clips with Claude and shows what was found in each. */
export function AnalyzeStep({ p, setP, update, onNext }: { p: ProjectView; setP: (p: ProjectView) => void; update: Update; onNext: () => void }) {
  const [job, setJob] = useState<Job | null>(p.analyzeJob?.status === 'running' ? p.analyzeJob : null);
  const [name, setName] = useState(p.settings.playerName);
  const sources = p.sources ?? [];
  const unread = sources.filter((s) => !s.analysis).length;
  const used = sources.reduce((u, s) => ({ input: u.input + (s.analysis?.usage.input ?? 0), output: u.output + (s.analysis?.usage.output ?? 0) }), { input: 0, output: 0 });
  const cost = (used.input * INPUT_USD + used.output * OUTPUT_USD) / 1e6;

  const run = async (again: boolean, ids?: string[]) => {
    if (name !== p.settings.playerName) await update(() => api.patch(p.id, { settings: { playerName: name.trim() } }));
    const j = await api.analyze(p.id, again, ids);
    let seen = -1;
    const done = await waitJob(j.id, (x) => {
      setJob(x);
      // each clip is saved as it's read: show it
      if (x.progress !== seen) {
        seen = x.progress;
        void api.get(p.id).then(setP).catch(() => {});
      }
    });
    setP(await api.get(p.id));
    if (done.status === 'error') setJob(done);
  };
  // a run started before this page was opened
  useEffect(() => {
    if (p.analyzeJob?.status !== 'running') return;
    void waitJob(p.analyzeJob.id, setJob).then(() => api.get(p.id).then(setP));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const running = job?.status === 'running';
  return (
    <>
      <section className="card">
        <h2>Read the clips</h2>
        <p className="muted">
          Each clip is scanned here for your red-outlined kill-feed entries. Claude then reads those moments and the round timer to tell your
          kills from your death and to find where the last round starts. Clips without any of your entries cost nothing.
        </p>
        {!p.readerAvailable && <div className="error">Set ANTHROPIC_API_KEY in .env and restart the app to read clips.</div>}
        <label className="field">
          <span>Your in-game name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="As it shows in the kill feed" />
        </label>
        <div className="row">
          <button className="btn btn-primary" disabled={running || !p.readerAvailable || unread === 0} onClick={() => run(false)}>
            {running ? 'Reading…' : `Read ${unread} clip${unread === 1 ? '' : 's'}`}
          </button>
          <button className="btn" disabled={running || !p.readerAvailable || unread === sources.length} onClick={() => run(true)}>
            Read all again
          </button>
          {running && (
            <>
              <Progress value={job!.progress} />
              <button className="btn btn-sm" onClick={() => api.cancel(job!.id)}>
                Cancel
              </button>
            </>
          )}
          <span className="grow" />
          <button className="btn" disabled={running || p.moments.length === 0} onClick={onNext}>
            Highlights →
          </button>
        </div>
        {job?.status === 'error' && <div className="error">{job.error}</div>}
        {used.input > 0 && (
          <div className="muted small">
            Claude used {used.input.toLocaleString()} input + {used.output.toLocaleString()} output tokens so far, about ${cost.toFixed(2)}.
          </div>
        )}
      </section>
      <section className="card">
        <ul className="recent">
          {sources.map((s, i) => (
            <li key={s.id}>
              <span>
                <strong>Clip {i + 1}</strong> <span className="muted">· {s.name} · {fmtTime(s.info.duration)}</span>
              </span>
              <span className="row">
                {clipStatus(s, p.moments.filter((m) => m.round === i + 1))}
                {s.analysis && (
                  <button className="btn btn-xs" disabled={running || !p.readerAvailable} title="Read just this clip again" onClick={() => run(false, [s.id])}>
                    Read again
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** What's kept from each clip: one row per burst of kills, with toggles and trims. */
export function ClipsHighlightsStep({
  p,
  update,
  play,
  onNext,
  speech,
}: {
  p: ProjectView;
  update: Update;
  /** plays timeline seconds [from, to] in the preview */
  play: (from: number, to: number) => void;
  onNext: () => void;
  /** speech-safe cuts: settings, voice tracks, detection */
  speech?: ReactNode;
}) {
  const patchMoments = (patch: Record<string, Partial<Moment>>) => update(() => api.patch(p.id, { moments: patch }));
  const clipOf = (m: Moment) => p.clips.find((c) => c.momentIds.includes(m.id));
  const setting = (burstGap: number) => update(() => api.patch(p.id, { settings: { burstGap } }));
  // CS2 clips read by Claude; off, any game: every clip whole
  const read = p.readKillfeed !== false;

  return (
    <>
      <section className="card sticky-summary">
        <div className="row spread">
          <div>
            <strong>{p.clips.length} pieces</strong> · video length <strong>{fmtTime(p.reelDuration)}</strong>
            <span className="muted"> from {(p.sources ?? []).length} clips</span>
          </div>
          <button className="btn btn-primary" onClick={onNext}>
            Edit →
          </button>
        </div>
        {read && (
        <label className="row small">
          <span className="muted">Kills further apart than</span>
          <input
            className="input"
            style={{ width: 70 }}
            type="number"
            min={1}
            step={1}
            value={p.settings.burstGap}
            onChange={(e) => setting(Number(e.target.value))}
          />
          <span className="muted">seconds become separate pieces (the walking between them is cut).</span>
        </label>
        )}
        {!read && <div className="muted small">Every clip is used whole: untick one to leave it out, trim its ends here, or cut it down in the editor.</div>}
      </section>
      {speech && <section className="card">{speech}</section>}

      {(p.sources ?? []).map((s, i) => {
        const moments = p.moments.filter((m) => m.round === i + 1);
        return (
          <section key={s.id} className={`round ${moments.length === 0 ? 'empty' : ''}`}>
            <div className="round-head">
              <strong>Clip {i + 1}</strong>
              <span className="muted small">{s.name}</span>
              {p.shortRounds.includes(i + 1) && <CreateShortButton p={p} round={i + 1} />}
              <span className="grow" />
              {read && clipStatus(s, moments)}
            </div>
            {moments.map((m) => {
              const clip = clipOf(m);
              return (
                <div key={m.id} className={`moment ${m.enabled ? '' : 'off'}`}>
                  <input type="checkbox" checked={m.enabled} onChange={(e) => patchMoments({ [m.id]: { enabled: e.target.checked } })} />
                  <span className="chip kind-kills on">{m.kind === 'clip' ? 'Clip' : 'Kills'}</span>
                  <span className="label" title={m.label}>
                    {m.label}
                  </span>
                  <span className="tags">
                    {m.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </span>
                  <span className="grow" />
                  {clip?.speech && clip.speech.start + clip.speech.end >= 0.1 && (
                    <span className="tag speech" title="Cut moved so nobody is cut off mid-sentence">
                      🎙 +{(clip.speech.start + clip.speech.end).toFixed(1)}s
                    </span>
                  )}
                  {m.at && <span className="muted small mono">{fmtTime(m.at[0] - s.offset)}</span>}
                  <span className="trim">
                    <button className="btn btn-xs" title="Start earlier" onClick={() => patchMoments({ [m.id]: { trimStart: m.trimStart - 1 } })}>
                      ⇤
                    </button>
                    <button className="btn btn-xs" title="Start later" onClick={() => patchMoments({ [m.id]: { trimStart: m.trimStart + 1 } })}>
                      ⇥
                    </button>
                    <button className="btn btn-xs" title="End earlier" onClick={() => patchMoments({ [m.id]: { trimEnd: m.trimEnd - 1 } })}>
                      ⇤
                    </button>
                    <button className="btn btn-xs" title="End later" onClick={() => patchMoments({ [m.id]: { trimEnd: m.trimEnd + 1 } })}>
                      ⇥
                    </button>
                  </span>
                  <button className="btn btn-sm" disabled={!clip} onClick={() => clip && play(clip.start, clip.end)}>
                    ▶
                  </button>
                </div>
              );
            })}
          </section>
        );
      })}
    </>
  );
}
