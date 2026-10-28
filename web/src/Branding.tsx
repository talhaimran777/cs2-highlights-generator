import { useState } from 'react';
import type { ProjectView, Settings } from './api.ts';
import { FilePicker } from './FilePicker.tsx';

type Branding = Settings['branding'];

/** Channel intro and subscribe outro: what they say, the profile picture, and a preview of each. */
export function BrandingSection({ p, setting }: { p: ProjectView; setting: (patch: Partial<Settings>) => Promise<void> }) {
  const b = p.settings.branding;
  const set = (patch: Partial<Branding>) => setting({ branding: { ...b, ...patch } });
  const [preview, setPreview] = useState<{ kind: 'intro' | 'outro'; loading: boolean } | null>(null);
  // the preview URL changes with the look, so the server renders (and caches) the new one
  const look = encodeURIComponent(JSON.stringify(b));

  return (
    <div className="quality">
      <div className="quality-head">
        <strong>Intro &amp; outro</strong>
        <span className="muted small">Added to the start and end of every export</span>
      </div>
      <div className="row wrap">
        <label className="field check">
          <input type="checkbox" checked={b.intro} onChange={(e) => set({ intro: e.target.checked })} />
          <span>Channel intro (3.6 s)</span>
        </label>
        <label className="field check">
          <input type="checkbox" checked={b.outro} onChange={(e) => set({ outro: e.target.checked })} />
          <span>Subscribe outro (4.6 s)</span>
        </label>
      </div>
      {(b.intro || b.outro) && (
        <>
          <div className="grid2">
            <TextField label="Channel name" value={b.name} placeholder="TEYEcs" onCommit={(name) => set({ name })} />
            <TextField label="Handle under the picture" value={b.handle} placeholder={`@${b.name || 'channel'}`} onCommit={(handle) => set({ handle })} />
            <TextField label="Line above the name" value={b.topLine} onCommit={(topLine) => set({ topLine })} />
            <TextField label="Line below the name" value={b.bottomLine} onCommit={(bottomLine) => set({ bottomLine })} />
          </div>
          <div className="row wrap branding-avatar">
            {b.avatarPath && <img src={`/api/image?path=${encodeURIComponent(b.avatarPath)}`} alt="" />}
            <label className="field grow">
              <span>Profile picture (outro)</span>
              <FilePicker kind="image" value={b.avatarPath} onChange={(avatarPath) => set({ avatarPath })} />
            </label>
            <label className="field">
              <span>Color</span>
              <input type="color" className="color" value={b.accent} onChange={(e) => set({ accent: e.target.value })} />
            </label>
          </div>
          {!b.name.trim() && <div className="muted small">Enter your channel name to turn the intro and outro on.</div>}
          <div className="row">
            <button className="btn btn-sm" disabled={!b.name.trim()} onClick={() => setPreview({ kind: 'intro', loading: true })}>
              ▶ Preview intro
            </button>
            <button className="btn btn-sm" disabled={!b.name.trim()} onClick={() => setPreview({ kind: 'outro', loading: true })}>
              ▶ Preview outro
            </button>
            {preview?.loading && <span className="muted small">Rendering preview…</span>}
          </div>
          {preview && (
            <video
              key={`${preview.kind}-${look}`}
              className="output"
              src={`/api/projects/${p.id}/bumper/${preview.kind}?look=${look}`}
              autoPlay
              controls
              onCanPlay={() => setPreview((x) => x && { ...x, loading: false })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Text input that saves when you leave it, not on every key. */
function TextField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        key={value}
        className="input"
        defaultValue={value}
        placeholder={placeholder}
        onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  );
}
