import { run, type DataStorage } from './storage.js';

export type ScheduledJob = { id: string; name: string; args: unknown; runAt: number; status: 'pending' | 'failed'; attempts: number; error: string | null };

type Row = { id: string; name: string; args: string; run_at: number; status: 'pending' | 'failed'; attempts: number; error: string | null };

export function syncJobs(storage: DataStorage): void {
  run(storage, `CREATE TABLE IF NOT EXISTS _jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, args TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT)`);
  run(storage, `CREATE INDEX IF NOT EXISTS _jobs_due ON _jobs (status, run_at)`);
  if (!run<{ name: string }>(storage, `SELECT name FROM pragma_table_info('_jobs')`).some((c) => c.name === 'cut_short')) run(storage, `ALTER TABLE _jobs ADD COLUMN cut_short INTEGER NOT NULL DEFAULT 0`);
}

/**
 * Delayed, cancellable jobs stored in the same SQLite as the documents, so scheduling
 * inside a mutation commits or rolls back with the writes. A Durable Object alarm fires
 * the earliest one. Delivery is at least once: a job that throws is retried with backoff,
 * and one cut off by an eviction runs again. Write handlers to be safe to repeat, or give
 * the job a stable `id` and check for it.
 */
export class Scheduler {
  /** @internal True once this call changed the queue, so the alarm needs re-arming. */
  changed = false;

  private ended = false;

  /** @internal */
  constructor(
    private readonly storage: DataStorage,
    private readonly knows: (name: string) => boolean,
  ) {}

  /** @internal Called when the mutation's transaction is over. A job scheduled after that would land outside it, so it throws. */
  end(): void {
    this.ended = true;
  }

  private open(): void {
    if (this.ended) throw new Error('this mutation has ended: a job scheduled after an await would land outside its transaction');
  }

  /**
   * Runs job `name` after `ms`. A given `id` replaces the pending job with that id
   * (a debounce); otherwise an id is made up. Returns the id for `cancel`.
   */
  runAfter(ms: number, name: string, args: unknown = null, options: { id?: string } = {}): string {
    return this.runAt(Date.now() + Math.max(0, ms), name, args, options);
  }

  runAt(at: number | Date, name: string, args: unknown = null, options: { id?: string } = {}): string {
    this.open();
    if (!this.knows(name)) throw new Error(`no job named "${name}"`);
    const when = Number(at);
    if (!Number.isFinite(when)) throw new Error('a job needs a time that is a finite number');
    const id = options.id ?? crypto.randomUUID();
    run(
      this.storage,
      `INSERT INTO _jobs (id,name,args,run_at) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, args=excluded.args, run_at=excluded.run_at, status='pending', attempts=0, error=NULL, cut_short=0`,
      id,
      name,
      JSON.stringify(args ?? null),
      when,
    );
    this.changed = true;
    return id;
  }

  /** Cancels a job that has not run yet. Returns whether there was one. */
  cancel(id: string): boolean {
    this.open();
    const gone = run(this.storage, `DELETE FROM _jobs WHERE id=? RETURNING id`, id).length > 0;
    if (gone) this.changed = true;
    return gone;
  }

  get(id: string): ScheduledJob | null {
    const row = run<Row>(this.storage, `SELECT * FROM _jobs WHERE id=?`, id)[0];
    return row ? toJob(row) : null;
  }

  /** @internal */
  due(now: number, limit: number): ScheduledJob[] {
    return run<Row>(this.storage, `SELECT * FROM _jobs WHERE status='pending' AND run_at<=? ORDER BY run_at, rowid LIMIT ?`, now, limit).map(toJob);
  }

  /** @internal */
  nextAt(): number | null {
    return run<{ at: number | null }>(this.storage, `SELECT MIN(run_at) AS at FROM _jobs WHERE status='pending'`)[0]?.at ?? null;
  }

  /**
   * @internal Called before the handler runs. Returns how many earlier runs of this job started and never ended, which
   * is what a run that takes the object down with it looks like. A deploy or an eviction in the middle of a run looks the same.
   * Null when the job was cancelled or replaced since it was read, so it shouldn't run.
   */
  started(job: ScheduledJob): number | null {
    return run<{ cut_short: number }>(this.storage, `UPDATE _jobs SET cut_short=cut_short+1 WHERE id=? AND run_at=? AND status='pending' RETURNING cut_short`, job.id, job.runAt)[0]?.cut_short ?? null;
  }

  /** @internal Parks a job whose runs keep being cut short. */
  park(job: ScheduledJob, error: string): void {
    run(this.storage, `UPDATE _jobs SET status='failed', error=? WHERE id=? AND run_at=?`, error, job.id, job.runAt);
  }

  /** @internal Called after the handler succeeded. Skips a job that was replaced while it ran. */
  done(job: ScheduledJob): void {
    run(this.storage, `DELETE FROM _jobs WHERE id=? AND run_at=?`, job.id, job.runAt);
  }

  /** @internal Retries with exponential backoff, then parks the job as failed. */
  fail(job: ScheduledJob, error: string, maxAttempts: number, now: number): void {
    const attempts = job.attempts + 1;
    if (attempts >= maxAttempts) run(this.storage, `UPDATE _jobs SET status='failed', attempts=?, error=? WHERE id=? AND run_at=?`, attempts, error, job.id, job.runAt);
    else run(this.storage, `UPDATE _jobs SET run_at=?, attempts=?, error=?, cut_short=0 WHERE id=? AND run_at=?`, now + Math.min(2 ** attempts * 1000, 5 * 60_000), attempts, error, job.id, job.runAt);
  }
}

function toJob(row: Row): ScheduledJob {
  return { id: row.id, name: row.name, args: JSON.parse(row.args), runAt: row.run_at, status: row.status, attempts: row.attempts, error: row.error };
}
