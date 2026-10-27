import { randomUUID } from 'node:crypto';

export interface Job {
  id: string;
  kind: string;
  projectId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  error?: string;
  result?: unknown;
}

const jobs = new Map<string, Job & { controller: AbortController }>();

export function startJob(
  kind: string,
  projectId: string,
  fn: (progress: (f: number) => void, signal: AbortSignal) => Promise<unknown>,
): Job {
  for (const j of jobs.values()) {
    if (j.projectId === projectId && j.kind === kind && j.status === 'running') return view(j);
  }
  const controller = new AbortController();
  const job = { id: randomUUID().slice(0, 8), kind, projectId, status: 'running' as Job['status'], progress: 0, controller };
  jobs.set(job.id, job);
  fn((f) => (job.progress = f), controller.signal)
    .then((result) => Object.assign(job, { status: 'done', progress: 1, result }))
    .catch((e) =>
      Object.assign(job, controller.signal.aborted ? { status: 'cancelled' } : { status: 'error', error: String(e?.message ?? e) }),
    );
  return view(job);
}

/** The most recent job of a kind for a project (running or finished). */
export function latestJob(projectId: string, kind: string): Job | null {
  const all = [...jobs.values()].filter((j) => j.projectId === projectId && j.kind === kind);
  const last = all.at(-1);
  return last ? view(last) : null;
}

export function getJob(id: string): Job | null {
  const j = jobs.get(id);
  return j ? view(j) : null;
}

export function cancelJob(id: string) {
  jobs.get(id)?.controller.abort();
}

const view = ({ controller, ...j }: Job & { controller: AbortController }): Job => ({ ...j });
