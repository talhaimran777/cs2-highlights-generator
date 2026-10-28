import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, videoTime, waitJob, type CaptionSettings, type Job, type Moment, type ProjectView } from './api.ts';
import { FilePicker } from './FilePicker.tsx';
import { Editor } from './Editor.tsx';
import { BrandingSection } from './Branding.tsx';

type Step = 'player' | 'sync' | 'highlights' | 'edit' | 'captions' | 'export';
const STEPS: { id: Step; label: string }[] = [
  { id: 'player', label: '1 · Player' },
  { id: 'sync', label: '2 · Sync' },
  { id: 'highlights', label: '3 · Highlights' },
  { id: 'edit', label: '4 · Edit' },
  { id: 'captions', label: '5 · Captions' },
  { id: 'export', label: '6 · Export' },
];
// a recording without a demo: just its own steps
const TEST_STEPS: Record<'captions' | 'edit', { id: Step; label: string }[]> = {
  captions: [{ id: 'captions', label: '1 · Captions' }, { id: 'export', label: '2 · Export' }],
  edit: [{ id: 'edit', label: '1 · Edit' }, { id: 'export', label: '2 · Export' }],
};
const recordingOnly = (p: Pick<ProjectView, 'mode'>) => p.mode === 'captions' || p.mode === 'edit';

const KIND_LABEL: Record<Moment['kind'], string> = {
  intro: 'Opening', clutch: 'Clutch', kills: 'Kills', bomb: 'Bomb', assist: 'Assist', team: 'Teammates', decider: 'Round end', funny: 'Funny', death: 'Death',
};
const FULL_ROUND_HINT =
  'Opening: your rotation to your spot (shortened if long) and a few seconds of holding, leading into first contact. Untick to start the round at your first fight.';

export function App() {
  const [projectId, setProjectId] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const onHash = () => setProjectId(location.hash.slice(1));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a href="#" className="brand">
          <span className="logo">◆</span> CS2 Highlights
        </a>
        <Health />
      </header>
      {projectId ? <ProjectScreen id={projectId} /> : <Home />}
    </div>
  );
}

function Health() {
  const [h, setH] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  useEffect(() => void api.health().then(setH).catch(() => setH(null)), []);
  if (!h) return <span className="pill pill-bad">Server offline</span>;
  return (
    <span className="health">
      <span className={`pill ${h.ffmpeg.ok ? 'pill-ok' : 'pill-bad'}`}>{h.ffmpeg.ok ? 'FFmpeg ✓' : 'FFmpeg missing'}</span>
      <span className={`pill ${h.nvenc ? 'pill-ok' : ''}`}>{h.nvenc ? 'NVENC ✓' : 'CPU encode'}</span>
    </span>
  );
}

function Home() {
  const [video, setVideo] = useState('');
  const [demo, setDemo] = useState('');
  const [mode, setMode] = useState<'match' | 'captions' | 'edit'>('match');
  const captionsOnly = mode === 'captions';
  const recordingTest = mode !== 'match';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<{ id: string; name: string; createdAt: string }[]>([]);
  useEffect(() => void api.projects().then(setRecent).catch(() => {}), []);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const p =
        mode === 'captions'
          ? await api.createCaptionTest(video.trim())
          : mode === 'edit'
            ? await api.createEditTest(video.trim())
            : await api.create(video.trim(), demo.trim());
      location.hash = p.id;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <section className="card">
        <div className="row spread">
          <h1>{captionsOnly ? 'Captions test' : mode === 'edit' ? 'Editing test' : 'New match'}</h1>
          <div className="steps">
            <button className={`step ${mode === 'match' ? 'active' : ''}`} onClick={() => setMode('match')}>
              Match + demo
            </button>
            <button className={`step ${captionsOnly ? 'active' : ''}`} onClick={() => setMode('captions')}>
              Captions test
            </button>
            <button className={`step ${mode === 'edit' ? 'active' : ''}`} onClick={() => setMode('edit')}>
              Editing test
            </button>
          </div>
        </div>
        <p className="muted">
          {captionsOnly
            ? 'Pick any recording, no demo needed. The whole clip gets captioned so you can check how accurate the captions are. Files are read where they are and nothing is uploaded.'
            : mode === 'edit'
              ? 'Pick any recording, no demo needed. The whole clip opens in the editor so you can try cutting it. Files are read where they are and nothing is uploaded.'
              : 'Pick your full OBS recording and the FACEIT demo of the same match. Files are read where they are and nothing is uploaded.'}
        </p>
        <label className="field">
          <span>{recordingTest ? 'Recording' : 'Match recording'}</span>
          <FilePicker kind="video" value={video} onChange={setVideo} />
        </label>
        {!recordingTest && (
          <label className="field">
            <span>FACEIT demo (.dem or .dem.zst)</span>
            <FilePicker kind="demo" value={demo} onChange={setDemo} />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={!video || (!recordingTest && !demo) || busy} onClick={create}>
          {recordingTest
            ? busy
              ? 'Reading recording…'
              : captionsOnly
                ? 'Start captions test'
                : 'Start editing test'
            : busy
              ? 'Parsing demo…'
              : 'Analyze match'}
        </button>
      </section>
      {recent.length > 0 && (
        <section className="card">
          <h2>Recent</h2>
          <ul className="recent">
            {recent.map((p) => (
              <li key={p.id}>
                <a href={`#${p.id}`}>{p.name}</a>
                <span className="muted">{new Date(p.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/** Shared preview player; plays a range and stops at its end. */
function usePreview() {
  const ref = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const play = useCallback((from: number, to?: number) => {
    const v = ref.current;
    if (!v) return;
    stopAt.current = to ?? null;
    v.currentTime = Math.max(0, from);
    void v.play();
  }, []);
  const onTimeUpdate = () => {
    const v = ref.current;
    if (v && stopAt.current !== null && v.currentTime >= stopAt.current) {
      v.pause();
      stopAt.current = null;
    }
  };
  return { ref, play, onTimeUpdate };
}

function ProjectScreen({ id }: { id: string }) {
  const [p, setP] = useState<ProjectView | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('player');
  const preview = usePreview();

  useEffect(() => {
    api
      .get(id)
      .then((proj) => {
        setP(proj);
        setStep(proj.mode === 'captions' ? 'captions' : proj.mode === 'edit' ? 'edit' : !proj.hasPlayer ? 'player' : !proj.sync ? 'sync' : 'highlights');
      })
      .catch((e) => setError(e.message));
  }, [id]);

  const update = useCallback(
    async (fn: () => Promise<ProjectView>) => {
      try {
        setP(await fn());
        setError('');
      } catch (e: any) {
        setError(e.message);
      }
    },
    [],
  );

  // Speech detection runs in the background; refresh until it's done so clips pick it up.
  // (transcription too)
  const backgroundRunning =
    p?.speechJob?.status === 'running' || p?.transcriptJob?.status === 'running' || p?.cleanupJob?.status === 'running';
  useEffect(() => {
    if (!backgroundRunning) return;
    const t = setInterval(() => api.get(id).then(setP).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [id, backgroundRunning]);

  if (!p) return <main className="home">{error ? <div className="error">{error}</div> : <div className="muted">Loading…</div>}</main>;

  const testMode = p.mode === 'captions' || p.mode === 'edit' ? p.mode : null;
  const steps = testMode ? TEST_STEPS[testMode] : STEPS;
  const enabled = (s: Step) => !!testMode || s === 'player' || (p.hasPlayer && (s === 'sync' || !!p.sync));

  return (
    <main className="project">
      <div className="project-head">
        <div>
          <h1>{p.name}</h1>
          <div className="muted">
            {testMode ? 'No demo' : `${p.match.rounds.length} rounds`} · recording {fmtTime(p.video.duration)} · {p.video.width}×{p.video.height}
            {p.video.audio.length > 1 && ` · ${p.video.audio.length} audio tracks`}
          </div>
        </div>
        <nav className="steps">
          {steps.map((s) => (
            <button key={s.id} className={`step ${step === s.id ? 'active' : ''}`} disabled={!enabled(s.id)} onClick={() => setStep(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
      </div>
      {error && <div className="error">{error}</div>}

      {step === 'edit' ? (
        <Editor
          p={p}
          update={update}
          nextLabel={testMode === 'edit' ? 'Export' : 'Captions'}
          onNext={() => setStep(testMode === 'edit' ? 'export' : 'captions')}
        />
      ) : (
      <div className="split">
        <div className="pane">
          {step === 'player' && (
            <PlayerStep p={p} onPick={(steamId) => update(() => api.patch(p.id, { steamId })).then(() => setStep('sync'))} />
          )}
          {step === 'sync' && <SyncStep p={p} setP={setP} update={update} preview={preview} onNext={() => setStep('highlights')} />}
          {step === 'highlights' && <HighlightsStep p={p} update={update} preview={preview} onNext={() => setStep('edit')} />}
          {step === 'captions' && <CaptionsStep p={p} update={update} preview={preview} onNext={() => setStep('export')} />}
          {step === 'export' && <ExportStep p={p} setP={setP} update={update} />}
        </div>
        <aside className="preview">
          <video
            ref={preview.ref}
            src={`/api/projects/${p.id}/media`}
            controls
            preload="metadata"
            onTimeUpdate={preview.onTimeUpdate}
          />
          <div className="muted small">
            Preview of your recording. Browsers can't play every OBS format (e.g. HEVC); if it stays black, the export still works.
          </div>
        </aside>
      </div>
      )}
    </main>
  );
}

function PlayerStep({ p, onPick }: { p: ProjectView; onPick: (steamId: string) => void }) {
  return (
    <section className="card">
      <h2>Which player are you?</h2>
      <p className="muted">Picked once, then remembered for future matches.</p>
      <div className="players">
        {p.match.players.map((pl) => (
          <button
            key={pl.steamId}
            className={`player ${pl.steamId === p.settings.steamId ? 'selected' : ''}`}
            onClick={() => onPick(pl.steamId)}
          >
            <strong>{pl.name}</strong>
            <span className="muted mono small">{pl.steamId}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function anchorLabel(p: ProjectView, a: { tick: number; round: number }) {
  const me = p.settings.steamId;
  const k = p.match.kills.find((x) => x.tick === a.tick && (x.attacker === me || x.victim === me || x.assister === me));
  if (!k) return `Round ${a.round}`;
  if (k.victim === me) return `R${a.round} · died to ${k.attackerName || 'world'} (${k.weapon})`;
  if (k.attacker === me) return `R${a.round} · killed ${k.victimName} (${k.weapon})`;
  return `R${a.round} · ${k.flashAssist ? 'flash-assisted' : 'assisted'} ${k.attackerName} on ${k.victimName}`;
}

type Preview = ReturnType<typeof usePreview>;
type Update = (fn: () => Promise<ProjectView>) => Promise<void>;

function SyncStep({ p, setP, update, preview, onNext }: { p: ProjectView; setP: (p: ProjectView) => void; update: Update; preview: Preview; onNext: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [selected, setSelected] = useState(0);
  const s = p.sync;

  const runAuto = async () => {
    const j = await api.autoSync(p.id);
    const done = await waitJob(j.id, setJob);
    if (done.status === 'done') setP(await api.get(p.id));
  };

  const anchor = p.anchors[selected];

  return (
    <>
      <section className="card">
        <h2>Line up the demo with your recording</h2>
        <p className="muted">
          Auto-sync scans the kill feed in your recording for the red-outlined entries (your kills, deaths and assists) and matches them to the demo. A
          full match takes a few minutes.
        </p>
        <div className="row">
          <button className="btn btn-primary" disabled={job?.status === 'running'} onClick={runAuto}>
            {job?.status === 'running' ? 'Scanning…' : s ? 'Re-run auto-sync' : 'Auto-sync'}
          </button>
          {job?.status === 'running' && (
            <>
              <Progress value={job.progress} />
              <button className="btn btn-sm" onClick={() => api.cancel(job.id)}>
                Cancel
              </button>
            </>
          )}
        </div>
        {job?.status === 'error' && <div className="error">{job.error}</div>}
        {s && (
          <div className={`sync-status ${s.confident ? 'ok' : 'warn'}`}>
            {s.method === 'manual' ? (
              <>Synced manually. Offset {s.offset.toFixed(2)} s.</>
            ) : s.confident ? (
              <>
                ✓ Synced: {s.inliers} of {p.anchors.length} kill-feed entries matched (±{s.rmsError.toFixed(2)} s).
              </>
            ) : (
              <>
                ⚠ Low confidence ({s.inliers} of {p.anchors.length} matched
                {p.killfeedEvents ? `, ${p.killfeedEvents.length} entries seen` : ''}). Use one manual point below.
              </>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Manual sync (one click)</h2>
        <ol className="muted steps-help">
          <li>Pick one of your kills, deaths or assists below.</li>
          <li>In the preview, pause on the frame where it pops into the kill feed.</li>
          <li>Click <em>Set sync here</em>.</li>
        </ol>
        {p.anchors.length === 0 && (
          <div className="error">No kills or deaths found for the selected player in this demo. Check step 1 · Player.</div>
        )}
        <div className="row">
          <select className="input" value={selected} disabled={p.anchors.length === 0} onChange={(e) => setSelected(Number(e.target.value))}>
            {p.anchors.map((a, i) => (
              <option key={a.tick} value={i}>
                {anchorLabel(p, a)}
                {s ? ` · ~${fmtTime(videoTime(s, a.tick, a.round))}` : ''}
              </option>
            ))}
          </select>
          {s && anchor && (
            <button className="btn" onClick={() => preview.play(videoTime(s, anchor.tick, anchor.round) - 3, videoTime(s, anchor.tick, anchor.round) + 2)}>
              ▶ Check
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={!anchor}
            onClick={() => update(() => api.manualSync(p.id, anchor.tick, preview.ref.current?.currentTime ?? 0))}
          >
            Set sync here
          </button>
        </div>
        {s && (
          <div className="row">
            <span className="muted">Shift everything:</span>
            {[-1, -0.25, 0.25, 1].map((d) => (
              <button key={d} className="btn btn-sm" onClick={() => update(() => api.nudge(p.id, d))}>
                {d > 0 ? '+' : ''}
                {d}s
              </button>
            ))}
          </div>
        )}
      </section>

      {s && (
        <div className="row end">
          <button className="btn btn-primary" onClick={onNext}>
            Review highlights →
          </button>
        </div>
      )}
    </>
  );
}

function HighlightsStep({ p, update, preview, onNext }: { p: ProjectView; update: Update; preview: Preview; onNext: () => void }) {
  const byRound = useMemo(() => {
    const m = new Map<number, Moment[]>();
    for (const x of p.moments) m.set(x.round, [...(m.get(x.round) ?? []), x]);
    return m;
  }, [p.moments]);
  const me = p.settings.steamId;

  const patchMoments = (patch: Record<string, Partial<Moment>>) => update(() => api.patch(p.id, { moments: patch }));
  const setKind = (kind: Moment['kind'], enabled: boolean) =>
    patchMoments(Object.fromEntries(p.moments.filter((m) => m.kind === kind).map((m) => [m.id, { enabled }])));

  const clipOf = (m: Moment) => p.clips.find((c) => c.momentIds.includes(m.id));
  const kinds = [...new Set(p.moments.map((m) => m.kind))];

  return (
    <>
      <section className="card sticky-summary">
        <div className="row spread">
          <div>
            <strong>{p.clips.length} clips</strong> · reel length <strong>{fmtTime(p.reelDuration)}</strong>
            <span className="muted"> of {fmtTime(p.video.duration)} recorded</span>
          </div>
          <button className="btn btn-primary" onClick={onNext}>
            Edit →
          </button>
        </div>
        <div className="row wrap">
          {kinds.map((k) => {
            const all = p.moments.filter((m) => m.kind === k);
            const on = all.filter((m) => m.enabled).length;
            return (
              <button
                key={k}
                className={`chip kind-${k} ${on ? 'on' : ''}`}
                title={k === 'intro' ? FULL_ROUND_HINT : undefined}
                onClick={() => setKind(k, on < all.length)}
              >
                {KIND_LABEL[k]} {on}/{all.length}
              </button>
            );
          })}
        </div>
      </section>

      {p.match.rounds.map((r) => {
        const moments = byRound.get(r.num) ?? [];
        const won = r.winner && r.roster[me] === r.winner;
        return (
          <section key={r.num} className={`round ${moments.length === 0 ? 'empty' : ''}`}>
            <div className="round-head">
              <strong>Round {r.num}</strong>
              <span className={`pill ${won ? 'pill-ok' : 'pill-bad'}`}>{won ? 'Won' : 'Lost'}</span>
              {r.score && (
                <span className="muted">
                  {r.score.us} – {r.score.them}
                </span>
              )}
              {r.roster[me] && <span className="muted small">{r.roster[me]}</span>}
              <span className="grow" />
              {moments.length > 0 && p.sync && (
                <span className="nudge">
                  <span className="muted small">timing</span>
                  <button className="btn btn-xs" onClick={() => update(() => api.nudge(p.id, -0.25, r.num))}>
                    −¼s
                  </button>
                  <button className="btn btn-xs" onClick={() => update(() => api.nudge(p.id, 0.25, r.num))}>
                    +¼s
                  </button>
                </span>
              )}
            </div>
            {moments.length === 0 && <div className="muted small">Nothing worth keeping, so this round is skipped.</div>}
            {moments.map((m) => {
              const clip = clipOf(m);
              return (
                <div key={m.id} className={`moment ${m.enabled ? '' : 'off'}`}>
                  <input type="checkbox" checked={m.enabled} onChange={(e) => patchMoments({ [m.id]: { enabled: e.target.checked } })} />
                  <span className={`chip kind-${m.kind} on`} title={m.kind === 'intro' ? FULL_ROUND_HINT : undefined}>
                    {KIND_LABEL[m.kind]}
                  </span>
                  <span className="label">{m.label}</span>
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
                  {clip && <span className="muted small mono">{fmtTime(clip.start)}</span>}
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
                  <button className="btn btn-sm" disabled={!clip} onClick={() => clip && preview.play(clip.start, clip.end)}>
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

function ExportStep({ p, setP, update }: { p: ProjectView; setP: (p: ProjectView) => void; update: Update }) {
  const [job, setJob] = useState<Job | null>(null);
  const [out, setOut] = useState(p.outputPath ?? p.defaultOutputPath);
  const stamp = useMemo(() => Date.now(), [job?.status]); // cache-bust after each render
  const st = p.settings;

  const setting = (patch: Partial<typeof st>) => update(() => api.patch(p.id, { settings: patch }));

  const render = async () => {
    await api.patch(p.id, { outputPath: out });
    const j = await api.render(p.id);
    const done = await waitJob(j.id, setJob);
    if (done.status === 'done') setP(await api.get(p.id));
  };

  return (
    <>
      <section className="card">
        <h2>{p.mode === 'captions' ? 'Export captioned recording' : p.mode === 'edit' ? 'Export edited recording' : 'Export highlight reel'}</h2>
        {!recordingOnly(p) && (
        <div className="grid2">
          <label className="field">
            <span>Seconds before each moment</span>
            <input className="input" type="number" step={0.5} min={0} value={st.preRoll} onChange={(e) => setting({ preRoll: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Seconds after each moment</span>
            <input className="input" type="number" step={0.5} min={0} value={st.postRoll} onChange={(e) => setting({ postRoll: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Seconds before a clutch</span>
            <input
              className="input"
              type="number"
              step={0.5}
              min={0}
              value={st.clutchPreRoll}
              onChange={(e) => setting({ clutchPreRoll: Number(e.target.value) })}
            />
          </label>
          <label className="field check">
            <input type="checkbox" checked={st.titleCards} onChange={(e) => setting({ titleCards: e.target.checked })} />
            <span>Round title cards (ROUND 7 · 4–2 · 3K)</span>
          </label>
        </div>
        )}
        {/* a captions test has no cuts to protect; its voice tracks are chosen on the Captions page */}
        {!recordingOnly(p) && <SpeechProtection p={p} setting={setting} update={update} />}
        {p.mode !== 'captions' && <BrandingSection p={p} setting={setting} />}
        <QualityMatch p={p} />
        <label className="field">
          <span>Save to</span>
          <input className="input mono" value={out} onChange={(e) => setOut(e.target.value)} />
        </label>
        <div className="row">
          <button className="btn btn-primary" disabled={job?.status === 'running' || p.clips.length === 0} onClick={render}>
            {job?.status === 'running'
              ? 'Rendering…'
              : p.mode === 'captions'
                ? `Render with captions (${fmtTime(p.reelDuration)})`
                : p.mode === 'edit'
                  ? `Render edit (${fmtTime(p.reelDuration)})`
                : `Render ${p.clips.length} clips (${fmtTime(p.reelDuration)})`}
          </button>
          {job?.status === 'running' && (
            <>
              <Progress value={job.progress} />
              <button className="btn btn-sm" onClick={() => api.cancel(job.id)}>
                Cancel
              </button>
            </>
          )}
        </div>
        {job?.status === 'error' && <div className="error">{job.error}</div>}
      </section>
      {p.outputPath && job?.status !== 'running' && (
        <section className="card">
          <h2>Your reel</h2>
          <video className="output" src={`/api/projects/${p.id}/output?v=${stamp}`} controls />
          <div className="mono small">{p.outputPath}</div>
        </section>
      )}
    </>
  );
}

const CAPTION_STYLES: { id: CaptionSettings['style']; label: string; hint: string }[] = [
  { id: 'pop', label: 'Word pop', hint: 'The spoken word pops in yellow' },
  { id: 'clean', label: 'Clean bold', hint: 'One calm line, fades in and out' },
  { id: 'karaoke', label: 'Karaoke fill', hint: 'Fills with yellow as it’s spoken' },
];

/** Animated captions: transcription status, style controls, live preview, editable lines. */
function CaptionsStep({ p, update, preview, onNext }: { p: ProjectView; update: Update; preview: Preview; onNext: () => void }) {
  const [status, setStatus] = useState<{ ok: boolean; missing: string[]; fonts: string[]; cleanup: boolean } | null>(null);
  useEffect(() => void api.captionsStatus().then(setStatus).catch(() => {}), []);
  const caps = p.settings.captions;
  const setCaps = (patch: Partial<CaptionSettings>) => update(() => api.patch(p.id, { settings: { captions: { ...caps, ...patch } } }));
  const job = p.transcriptJob;
  const running = job?.status === 'running';
  const lines = p.reelCaptions;
  const urdu = lines.filter((l) => l.lang === 'ur').length;
  const fonts = status?.fonts ?? [];
  const sample = (lines.find((l) => l.words.length >= 3)?.words.slice(0, 3).map((w) => w.text) ?? ['bhai', 'peeche', 'dekho']).map((t) =>
    caps.uppercase ? t.toUpperCase() : t,
  );

  return (
    <>
      <style>{fonts.map((f) => `@font-face{font-family:'${f}';src:url('/api/fonts/${encodeURIComponent(f)}')}`).join('')}</style>
      <section className="card">
        <div className="row spread">
          <h2>Captions</h2>
          <button className="btn btn-primary" onClick={onNext}>
            Export →
          </button>
        </div>
        <p className="muted">
          Bold animated captions while you or your team talk. English stays English; Urdu is written in Roman Urdu. Transcription runs on
          your PC with Whisper; nothing is uploaded.
        </p>
        {status && !status.ok && <div className="error">Captions aren’t set up: missing {status.missing.join(', ')}.</div>}
        {p.video.audio.length > 1 && (
          <div className="row wrap small">
            <span className="muted">Voice tracks (your mic, Discord):</span>
            {p.video.audio.map((_, i) => {
              const tracks = p.settings.voiceTracks ?? p.video.audio.map((__, j) => j);
              return (
                <label key={i} className="row">
                  <input
                    type="checkbox"
                    checked={tracks.includes(i)}
                    disabled={running}
                    onChange={(e) =>
                      update(() =>
                        api.patch(p.id, {
                          settings: { voiceTracks: e.target.checked ? [...tracks, i].sort() : tracks.filter((t) => t !== i) },
                        }),
                      )
                    }
                  />
                  Track {i + 1}
                </label>
              );
            })}
          </div>
        )}
        {!p.speech &&
          (p.speechJob?.status === 'running' ? (
            <div className="row">
              <span className="muted">Finding speech…</span>
              <Progress value={p.speechJob.progress} />
            </div>
          ) : p.speechJob?.status === 'error' ? (
            <div className="error">Speech detection failed: {p.speechJob.error}</div>
          ) : (
            <div className="row">
              <span className="muted">Speech hasn't been detected for these tracks yet.</span>
              <button className="btn btn-sm" onClick={() => update(async () => (await api.detectSpeech(p.id), api.get(p.id)))}>
                Detect speech
              </button>
            </div>
          ))}
        <div className="row wrap">
          <button
            className="btn btn-primary"
            disabled={running || !status?.ok || !p.speech}
            onClick={() => update(async () => (await api.transcribe(p.id), api.get(p.id)))}
          >
            {running ? 'Transcribing…' : lines.length ? 'Transcribe new speech' : 'Transcribe'}
          </button>
          {running && <Progress value={job!.progress} />}
          {!running && lines.length > 0 && (
            <span className="muted">
              {lines.length} lines · {lines.length - urdu} English · {urdu} Roman Urdu
            </span>
          )}
          {job?.status === 'error' && <span className="error">{job.error}</span>}
        </div>
        <CaptionCleanup p={p} available={!!status?.cleanup} lines={lines} update={update} setCaps={setCaps} />
      </section>

      <section className="card">
        <div className="row spread">
          <h2>Style</h2>
          <label className="field check">
            <input type="checkbox" checked={caps.enabled} onChange={(e) => setCaps({ enabled: e.target.checked })} />
            <span>Burn captions into the reel</span>
          </label>
        </div>
        <div className="caption-preview" style={{ ['--pos' as string]: `${caps.positionPct}%`, ['--size' as string]: `${caps.sizePct * 0.5625}cqw` }}>
          <div className={`caption-sample style-${caps.style}`} style={{ fontFamily: `'${caps.font}', 'Arial Black', sans-serif` }}>
            {sample.map((t, i) => (
              <span key={i} className={i === 1 ? 'active' : ''}>
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="row wrap">
          {CAPTION_STYLES.map((s) => (
            <button key={s.id} className={`chip ${caps.style === s.id ? 'on kind-assist' : ''}`} title={s.hint} onClick={() => setCaps({ style: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="grid2">
          <label className="field">
            <span>Font</span>
            <select className="input" value={caps.font} onChange={(e) => setCaps({ font: e.target.value })}>
              {[...new Set([...fonts, caps.font])].map((f) => (
                <option key={f} value={f}>
                  {f}
                  {!fonts.includes(f) ? ' (not installed, uses Arial Black)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field check">
            <input type="checkbox" checked={caps.uppercase} onChange={(e) => setCaps({ uppercase: e.target.checked })} />
            <span>ALL CAPS</span>
          </label>
          <label className="field">
            <span>Size · {caps.sizePct}% of height</span>
            <input type="range" min={4} max={11} step={0.5} value={caps.sizePct} onChange={(e) => setCaps({ sizePct: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Position · {caps.positionPct}% down</span>
            <input type="range" min={40} max={92} step={1} value={caps.positionPct} onChange={(e) => setCaps({ positionPct: Number(e.target.value) })} />
          </label>
        </div>
      </section>

      {lines.length > 0 && (
        <section className="card">
          <h2>Lines</h2>
          <p className="muted small">
            Only speech inside your {fmtTime(p.reelDuration)} reel is captioned; times are where each line plays in it. Fix any word: click a line,
            type, and click outside it. Timing is kept.
          </p>
          <div className="caption-lines">
            {lines.map((l) => (
              <div key={l.id} className="caption-line">
                <span className="muted small mono" title={`At ${fmtTime(l.start)} in the recording`}>
                  {fmtTime(reelTime(p.clips, l.start))}
                </span>
                <span className={`tag ${l.lang === 'ur' ? 'speech' : ''}`} title={l.source}>
                  {l.lang === 'ur' ? 'UR' : 'EN'}
                </span>
                <input
                  className="input"
                  defaultValue={l.words.map((w) => w.text).join(' ')}
                  onBlur={(e) => {
                    const text = e.target.value.trim();
                    if (text && text !== l.words.map((w) => w.text).join(' ')) update(() => api.patch(p.id, { captions: { [l.id]: text } }));
                  }}
                />
                {l.edited ? <span className="muted small">edited</span> : l.cleaned && <span className="muted small" title="Spelling cleaned up by Claude">✨</span>}
                <button className="btn btn-sm" onClick={() => preview.play(l.start - 0.5, l.end + 0.5)}>
                  ▶
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Where a recording time lands in the edited reel (its clips back to back, as in the editor). */
function reelTime(clips: ProjectView['clips'], t: number) {
  let reel = 0;
  for (const c of clips) {
    if (t < c.end) return reel + Math.max(0, t - c.start);
    reel += c.end - c.start;
  }
  return reel;
}

/** Claude rewrites the transcribed lines into natural Roman Urdu / English, keeping the timing. */
function CaptionCleanup({
  p,
  available,
  lines,
  update,
  setCaps,
}: {
  p: ProjectView;
  available: boolean;
  lines: ProjectView['reelCaptions'];
  update: Update;
  setCaps: (patch: Partial<CaptionSettings>) => Promise<void>;
}) {
  const job = p.cleanupJob;
  const running = job?.status === 'running';
  const todo = lines.filter((l) => !l.edited && !l.cleaned).length;
  if (!available) {
    return (
      <div className="muted small">
        For natural Roman Urdu spelling, put <span className="mono">ANTHROPIC_API_KEY=…</span> in a <span className="mono">.env</span> file in the app's
        folder and restart the app: Claude then cleans up every transcribed line.
      </div>
    );
  }
  return (
    <div className="row wrap small">
      <label className="row">
        <input type="checkbox" checked={p.settings.captions.cleanup} onChange={(e) => setCaps({ cleanup: e.target.checked })} />
        Clean up spelling with Claude after transcribing
      </label>
      <span className="grow" />
      {running ? (
        <>
          <span className="muted">Cleaning up…</span>
          <Progress value={job!.progress} />
        </>
      ) : (
        <button className="btn btn-sm" disabled={todo === 0} onClick={() => update(async () => (await api.cleanupCaptions(p.id), api.get(p.id)))}>
          {todo ? `Clean up ${todo} lines now` : 'All lines cleaned up'}
        </button>
      )}
      {job?.status === 'error' && <span className="error">{job.error}</span>}
    </div>
  );
}

/** Keeps cuts out of sentences: status of speech detection, toggle, max wait, voice tracks. */
function SpeechProtection({
  p,
  setting,
  update,
}: {
  p: ProjectView;
  setting: (patch: Partial<ProjectView['settings']>) => Promise<void>;
  update: Update;
}) {
  const st = p.settings;
  const job = p.speechJob;
  const running = job?.status === 'running';
  const held = p.clips.filter((c) => c.speech && c.speech.start + c.speech.end >= 0.1);
  const tracks = st.voiceTracks ?? p.video.audio.map((_, i) => i);
  const status = running
    ? `Detecting speech… ${Math.round(job.progress * 100)}%`
    : p.speech
      ? `${p.speech.utterances.length} speech segments found · ${held.length} cuts held for speech`
      : job?.status === 'error'
        ? `Speech detection failed: ${job.error}`
        : 'Speech not analyzed yet';

  return (
    <div className="quality">
      <div className="quality-head">
        <strong>Speech</strong>
        <span className="muted small">Never cut while you or your team are talking</span>
      </div>
      <div className="row wrap">
        <label className="field check">
          <input type="checkbox" checked={st.protectSpeech} onChange={(e) => setting({ protectSpeech: e.target.checked })} />
          <span>Let sentences finish before a cut</span>
        </label>
        <label className="row small">
          <span className="muted">wait up to</span>
          <input
            className="input narrow"
            type="number"
            min={1}
            max={30}
            step={1}
            value={st.speechMaxWait}
            onChange={(e) => setting({ speechMaxWait: Number(e.target.value) })}
          />
          <span className="muted">s</span>
        </label>
      </div>
      {p.video.audio.length > 1 && (
        <div className="row wrap small">
          <span className="muted">Voice tracks:</span>
          {p.video.audio.map((_, i) => (
            <label key={i} className="row">
              <input
                type="checkbox"
                checked={tracks.includes(i)}
                onChange={(e) => setting({ voiceTracks: e.target.checked ? [...tracks, i].sort() : tracks.filter((t) => t !== i) })}
              />
              Track {i + 1}
            </label>
          ))}
        </div>
      )}
      <div className="row small">
        <span className={job?.status === 'error' ? 'error' : 'muted'}>{status}</span>
        {!running && (
          <button className="btn btn-xs" onClick={() => update(async () => (await api.detectSpeech(p.id), api.get(p.id)))}>
            {p.speech ? 'Re-detect' : 'Detect speech'}
          </button>
        )}
      </div>
    </div>
  );
}

const CODEC_NAME: Record<string, string> = { h264: 'H.264', hevc: 'HEVC (H.265)', av1: 'AV1' };
const mbps = (b: number | null) => (b ? `${(b / 1e6).toFixed(1)} Mbps` : 'unknown');
const kbps = (b: number | null) => (b ? `${Math.round(b / 1000)} kbps` : 'unknown');

/** Source recording vs export encoding, so it's clear the reel keeps the original quality. */
function QualityMatch({ p }: { p: ProjectView }) {
  const src = p.video.encoding;
  const x = p.exportSettings;
  const fps = (() => {
    const [n, d] = p.video.fps.split('/').map(Number);
    return d ? Math.round((n / d) * 100) / 100 : n;
  })();
  const rows: [string, string, string, boolean][] = [
    ['Video', `${CODEC_NAME[src.codec] ?? src.codec}${src.profile ? ` ${src.profile}` : ''}`, `${CODEC_NAME[x.codec] ?? x.codec}${x.profile ? ` ${x.profile}` : ''} · ${x.encoder}`, x.sameCodec],
    ['Bitrate', mbps(src.bitRate), x.bitRate ? mbps(x.bitRate) : 'quality mode (CQ)', !!x.bitRate],
    ['Resolution', `${p.video.width}×${p.video.height} @ ${fps} fps`, `${p.video.width}×${p.video.height} @ ${fps} fps`, true],
    ...p.video.audio.map((a, i): [string, string, string, boolean] => [
      p.video.audio.length > 1 ? `Audio ${i + 1}` : 'Audio',
      `${a.codec.toUpperCase()} ${a.sampleRate / 1000} kHz · ${kbps(a.bitRate)}`,
      `${x.audio[i].encoder.toUpperCase()} ${x.audio[i].sampleRate / 1000} kHz · ${kbps(x.audio[i].bitRate)}`,
      true,
    ]),
  ];
  return (
    <div className="quality">
      <div className="quality-head">
        <strong>Quality</strong>
        <span className="muted small">Export matches your original recording</span>
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>Original</th>
            <th>Export</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, a, b, ok]) => (
            <tr key={name}>
              <td className="muted">{name}</td>
              <td>{a}</td>
              <td className={ok ? 'match' : 'mismatch'}>
                {ok ? '✓ ' : '⚠ '}
                {b}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <span className="progress">
      <span style={{ width: `${Math.round(value * 100)}%` }} />
      <em>{Math.round(value * 100)}%</em>
    </span>
  );
}
