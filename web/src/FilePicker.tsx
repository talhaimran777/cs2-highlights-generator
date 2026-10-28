import { useEffect, useState } from 'react';
import { api, type FsEntry } from './api.ts';

const LAST_DIR_KEY = 'cs2h:lastDir:';

function readLastDir(kind: string) {
  try {
    return localStorage.getItem(LAST_DIR_KEY + kind) ?? '';
  } catch {
    return '';
  }
}

function fmtSize(b?: number) {
  if (b === undefined) return '';
  return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(0)} MB`;
}

/** Browses the local disk through the server, since browsers hide real file paths. */
export function FilePicker(props: {
  kind: 'video' | 'demo' | 'image';
  value: string;
  onChange: (path: string) => void;
}) {
  const exts =
    props.kind === 'video' ? ['.mp4', '.mkv', '.mov', '.flv', '.ts'] : props.kind === 'image' ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.dem', '.zst', '.gz'];
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(() => readLastDir(props.kind));
  const [listing, setListing] = useState<{ path: string; parent: string | null; entries: FsEntry[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    api
      .fs(dir)
      .then((l) => {
        setListing(l);
        setError('');
      })
      .catch((e) => {
        setError(e.message);
        if (dir) setDir('');
      });
  }, [open, dir]);

  const pick = (e: FsEntry) => {
    if (e.dir) return setDir(e.path);
    try {
      localStorage.setItem(LAST_DIR_KEY + props.kind, listing?.path ?? '');
    } catch {}
    props.onChange(e.path);
    setOpen(false);
  };

  const files = listing?.entries.filter((e) => e.dir || exts.some((x) => e.name.toLowerCase().endsWith(x))) ?? [];

  return (
    <div className="picker">
      <div className="picker-row">
        <input
          className="input mono"
          placeholder={
            props.kind === 'video'
              ? 'D:\\Recordings\\faceit-mirage.mkv'
              : props.kind === 'image'
                ? 'C:\\Users\\you\\Pictures\\avatar.png'
                : 'C:\\Users\\you\\Downloads\\match.dem.zst'
          }
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button className="btn" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Browse…'}
        </button>
      </div>
      {open && (
        <div className="browser">
          <div className="browser-path mono">
            {listing?.parent !== null && listing?.parent !== undefined && (
              <button className="btn btn-sm" onClick={() => setDir(listing.parent ?? '')}>
                ↑ Up
              </button>
            )}
            <span>{listing?.path || 'This PC'}</span>
          </div>
          {error && <div className="error">{error}</div>}
          <ul className="browser-list">
            {files.map((e) => (
              <li key={e.path} onClick={() => pick(e)} className={e.dir ? 'dir' : 'file'}>
                <span>{e.dir ? '📁' : props.kind === 'video' ? '🎬' : props.kind === 'image' ? '🖼' : '📄'}</span>
                <span className="name">{e.name}</span>
                <span className="muted">{fmtSize(e.size)}</span>
              </li>
            ))}
            {files.length === 0 && <li className="muted empty">No matching files here</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
