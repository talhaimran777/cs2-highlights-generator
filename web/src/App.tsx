import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, videoTime, waitJob, type Job, type Moment, type ProjectView } from './api.ts';
import { FilePicker } from './FilePicker.tsx';

type Step = 'player' | 'sync' | 'highlights' | 'export';
const STEPS: { id: Step; label: string }[] = [
  { id: 'player', label: '1 · Player' },
  { id: 'sync', label: '2 · Sync' },
  { id: 'highlights', label: '3 · Highlights' },
  { id: 'export', label: '4 · Export' },
];

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<{ id: string; name: string; createdAt: string }[]>([]);
  useEffect(() => void api.projects().then(setRecent).catch(() => {}), []);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const p = await api.create(video.trim(), demo.trim());
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
        <h1>New match</h1>
        <p className="muted">
          Pick your full OBS recording and the FACEIT demo of the same match. Files are read where they are and nothing is uploaded.
        </p>
        <label className="field">
          <span>Match recording</span>
          <FilePicker kind="video" value={video} onChange={setVideo} />
        </label>
        <label className="field">
          <span>FACEIT demo (.dem or .dem.zst)</span>
          <FilePicker kind="demo" value={demo} onChange={setDemo} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={!video || !demo || busy} onClick={create}>
          {busy ? 'Parsing demo…' : 'Analyze match'}
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
        setStep(!proj.hasPlayer ? 'player' : !proj.sync ? 'sync' : 'highlights');
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

  if (!p) return <main className="home">{error ? <div className="error">{error}</div> : <div className="muted">Loading…</div>}</main>;

  const enabled = (s: Step) => s === 'player' || (p.hasPlayer && (s === 'sync' || !!p.sync));

  return (
    <main className="project">
      <div className="project-head">
        <div>
          <h1>{p.name}</h1>
          <div className="muted">
            {p.match.rounds.length} rounds · recording {fmtTime(p.video.duration)} · {p.video.width}×{p.video.height}
            {p.video.audio.length > 1 && ` · ${p.video.audio.length} audio tracks`}
          </div>
        </div>
        <nav className="steps">
          {STEPS.map((s) => (
            <button key={s.id} className={`step ${step === s.id ? 'active' : ''}`} disabled={!enabled(s.id)} onClick={() => setStep(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="split">
        <div className="pane">
          {step === 'player' && (
            <PlayerStep p={p} onPick={(steamId) => update(() => api.patch(p.id, { steamId })).then(() => setStep('sync'))} />
          )}
          {step === 'sync' && <SyncStep p={p} setP={setP} update={update} preview={preview} onNext={() => setStep('highlights')} />}
          {step === 'highlights' && <HighlightsStep p={p} update={update} preview={preview} onNext={() => setStep('export')} />}
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
            Export →
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
        <h2>Export highlight reel</h2>
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
        <QualityMatch p={p} />
        <label className="field">
          <span>Save to</span>
          <input className="input mono" value={out} onChange={(e) => setOut(e.target.value)} />
        </label>
        <div className="row">
          <button className="btn btn-primary" disabled={job?.status === 'running' || p.clips.length === 0} onClick={render}>
            {job?.status === 'running' ? 'Rendering…' : `Render ${p.clips.length} clips (${fmtTime(p.reelDuration)})`}
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
