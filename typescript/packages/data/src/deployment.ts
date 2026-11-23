import { Db, DbReader, syncSchema } from './db.js';
import { currentEpoch, pull, syncChanges, type Change, type ChangeBatch, type PullResult } from './changes.js';
import { SyncSockets, type QueryAnswer, type SocketIdentity } from './sockets.js';

/** The header the door sets on a sync socket request: JSON `{ actor, groups }`. See `syncRequest`. */
export const SYNC_HEADER = 'x-realtime-sync';

/**
 * Builds the request a Worker forwards to the data object to open a device's sync socket. The door decides `actor` and
 * `groups` itself; any header of that name from the device is replaced.
 */
export function syncRequest(request: Request, who: SocketIdentity): Request {
  const headers = new Headers(request.headers);
  headers.set(SYNC_HEADER, JSON.stringify({ actor: who.actor, groups: who.groups }));
  return new Request(request.url, { method: request.method, headers });
}
import { Scheduler, syncJobs, type ScheduledJob } from './scheduler.js';
import type { Schema } from './schema.js';
import type { DataStorage } from './storage.js';

export type QueryCtx<S extends Schema> = { db: DbReader<S>; env: any; now: number };
export type MutationCtx<S extends Schema> = { db: Db<S>; scheduler: Scheduler; env: any; now: number };

type QueryFn<A = any, R = any> = { readonly kind: 'query'; readonly run: (ctx: QueryCtx<any>, args: A) => R };
type MutationFn<A = any, R = any> = { readonly kind: 'mutation'; readonly run: (ctx: MutationCtx<any>, args: A) => R };
export type AnyFn = QueryFn | MutationFn;

/** Handed to the `functions` builder. Functions are synchronous: SQLite in a Durable Object is. */
export type FunctionBuilders<S extends Schema> = {
  query: <A = void, R = unknown>(run: (ctx: QueryCtx<S>, args: A) => R) => QueryFn<A, R>;
  mutation: <A = void, R = unknown>(run: (ctx: MutationCtx<S>, args: A) => R) => MutationFn<A, R>;
};

type Names<F, K> = { [N in keyof F]: F[N] extends { kind: K } ? N : never }[keyof F] & string;
type ArgsOf<T> = T extends { run: (ctx: any, args: infer A) => any } ? A : never;
type ReturnOf<T> = T extends { run: (ctx: any, args: any) => infer R } ? Awaited<R> : never;
type Call<T> = [ArgsOf<T>] extends [void] ? () => Promise<ReturnOf<T>> : (args: ArgsOf<T>) => Promise<ReturnOf<T>>;

export type DataClient<F> = {
  query: { [N in Names<F, 'query'>]: Call<F[N]> };
  mutate: { [N in Names<F, 'mutation'>]: Call<F[N]> };
  /** Looks a scheduled job up from outside a mutation. */
  job(id: string): Promise<ScheduledJob | null>;
};

export type JobCtx<F> = {
  env: any;
  id: string;
  /** 1 on the first try. */
  attempt: number;
  /** Runs one of the data functions in this object, the same way a procedure would. */
  data: DataClient<F>;
};
/** `concurrent`: a job that runs long or waits on others, so it doesn't hold up the rest. By default jobs run one at a time. */
export type JobOptions = { concurrent?: boolean };
export type JobFn<F = any, A = any> = (ctx: JobCtx<F>, args: A) => void | Promise<void>;

export type DataDefinition<S extends Schema, F extends Record<string, AnyFn>, J extends Record<string, JobFn<F>>> = {
  schema: S;
  functions: (fn: FunctionBuilders<S>) => F;
  /** Handlers for `scheduler.runAfter(ms, name, args)`. They may be async and call other services. */
  jobs?: (job: <A = void>(run: JobFn<F, A>, options?: JobOptions) => JobFn<F, A>) => J;
  /**
   * Called after a mutation commits, with the topics it touched (`table`, `table:id`, plus
   * table `topics`). Publish them to your live transport here. The mutation answers without
   * waiting for it: publishing can mean a round trip per topic and per listener, and the
   * caller shouldn't wait on the slowest one. A Durable Object keeps running the work after it
   * answers. Errors are logged, never thrown: live delivery is at most once, so clients
   * refetch on reconnect anyway.
   */
  onCommit?: (topics: string[], env: any) => void | Promise<void>;
  /**
   * Called after a mutation commits, with what changed in synced tables (`sync` on the table): one position for the
   * commit and each document as devices see it. Send it to the devices in those groups. Like `onCommit`, it's started and
   * not awaited, and devices that miss it catch up with `pull`.
   */
  onChanges?: (batch: ChangeBatch, env: any) => void | Promise<void>;
  /**
   * Whether `actor` may read sync group `group`. A device asks to watch groups as it moves around (an open channel), and
   * the object checks each one here. Without it, devices read only the groups the door gave them.
   */
  syncAccess?: (ctx: QueryCtx<S>, actor: string, group: string) => boolean;
  /**
   * Whether a commit may have changed who can read what, from the topics it touched (a member left, a channel went
   * private). When it says yes, each open socket's groups are checked again with `syncAccess`.
   */
  syncRecheck?: (topics: string[]) => boolean;
  /**
   * Whether `actor` may hear live topic `topic` over its sync socket. A device that listens gets a `topics` message after
   * each commit that touches one, and refetches what reads it, as it would from a live stream. Without it, every listen
   * is refused.
   */
  syncTopics?: (ctx: QueryCtx<S>, actor: string, topic: string) => boolean;
  /**
   * Which query function answers live query `name` with `input` for `actor`, over its sync socket. A device that asks
   * gets the answer, and a new answer after each commit that touches the query's topics, so it doesn't refetch. Return
   * null to refuse it. `output` is checked against the answer before it goes out, as a procedure's output would be.
   */
  syncQuery?: (actor: string, name: string, input: unknown) => SyncQueryPlan | null | Promise<SyncQueryPlan | null>;
  /** Attempts per job before it is parked as failed. Default 5. */
  maxJobAttempts?: number;
  /** How long a plain job may hold the one-at-a-time lane before the next one starts beside it. Default 120000 (two minutes). */
  laneMs?: number;
};

const MAX_CUT_SHORT = 10;

/** How the object answers one live query over the socket. */
export type SyncQueryPlan = { fn: string; args: unknown; output?: StandardSchema };
type StandardSchema = { '~standard': { validate(value: unknown): unknown } };
type Validated = { value?: unknown; issues?: readonly unknown[] };

type Stub = { run(kind: string, name: string, args: unknown): Promise<any>; job(id: string): Promise<ScheduledJob | null>; pull(groups: string[], after: number, limit?: number): Promise<PullResult> };
type Namespace = { idFromName(name: string): unknown; get(id: any): any };

export type Data<S extends Schema, F extends Record<string, AnyFn>, _J extends Record<string, JobFn<F>>> = {
  readonly schema: S;
  readonly functions: F;
  /**
   * Mixes the data layer into a Durable Object class:
   * `export class Deployment extends data.durableObject(DurableObject) {}`
   * with `DurableObject` from "cloudflare:workers". Bind it and run a migration for it
   * like any SQLite-backed Durable Object.
   */
  durableObject<B extends abstract new (...args: any[]) => object>(Base: B): new (...args: ConstructorParameters<B>) => InstanceType<B> & DataObject;
  /** A typed client for the one object that holds the deployment's data. */
  client(namespace: Namespace, name?: string): DataClient<F>;
  /** For tests and in-process use: run against any storage that satisfies `DataStorage`. */
  engine(storage: DataStorage, env?: unknown): Engine;
};

export interface DataObject {
  run(kind: 'query' | 'mutation', name: string, args: unknown): Promise<unknown>;
  /** Changes the sync groups an actor's open sockets may read, after they join or leave something. */
  regroup(actor: string, groups: string[]): Promise<void>;
  /** What changed in these sync groups after `after`. Check the caller may read each group before calling. */
  pull(groups: string[], after: number, limit?: number): Promise<PullResult>;
  job(id: string): Promise<ScheduledJob | null>;
  alarm(): Promise<void>;
}

export function defineData<S extends Schema, F extends Record<string, AnyFn>, J extends Record<string, JobFn<F>> = {}>(
  def: DataDefinition<S, F, J>,
): Data<S, F, J> {
  const functions = def.functions({ query: (run) => ({ kind: 'query', run }) as any, mutation: (run) => ({ kind: 'mutation', run }) as any });
  const jobs = def.jobs?.((run, options) => (options?.concurrent ? Object.assign((ctx: any, args: any) => run(ctx, args), { concurrent: true }) : run)) ?? ({} as J);
  const resolved = { ...def, functions, jobs };
  const engine = (storage: DataStorage, env: unknown = {}) => new Engine(storage, env, resolved as any);

  return {
    schema: def.schema,
    functions,
    engine,
    durableObject(Base) {
      return class extends (Base as unknown as new (...args: any[]) => object) {
        #engine: Engine;
        #sockets: SyncSockets;
        constructor(...args: any[]) {
          super(...args);
          const [ctx, env] = args as [{ storage: DataStorage; blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> } & ConstructorParameters<typeof SyncSockets>[0], unknown];
          const own = (this.#engine = engine(ctx.storage, env));
          this.#sockets = new SyncSockets(ctx, {
            pull: (_actor, groups, after, limit) => own.pull(groups, after, limit),
            view: (actor, changes) => own.view(actor, changes),
            access: (actor, groups) => own.access(actor, groups),
            topicAccess: (actor, topics) => own.topicAccess(actor, topics),
            query: (actor, name, input) => own.liveQuery(actor, name, input),
            epoch: () => own.epoch(),
          });
          own.onTopics((topics) => this.#sockets.publish(topics));
          this.#engine.listen((batch) => this.#sockets.broadcast(batch));
          this.#engine.onRecheck(() => this.#sockets.recheck());
          // Decision: schema sync is synchronous, but block anyway so no request sees a half-built table.
          void ctx.blockConcurrencyWhile(async () => {
            this.#engine.init();
            await this.#engine.rearm();
          });
        }
        run(kind: 'query' | 'mutation', name: string, args: unknown) {
          return this.#engine.run(kind, name, args);
        }
        job(id: string) {
          return Promise.resolve(this.#engine.scheduler().get(id));
        }
        pull(groups: string[], after: number, limit?: number) {
          return Promise.resolve(this.#engine.pull(groups, after, limit));
        }
        regroup(actor: string, groups: string[]) {
          this.#sockets.regroup(actor, groups);
          return Promise.resolve();
        }
        fetch(request: Request): Response | Promise<Response> {
          const header = request.headers.get(SYNC_HEADER);
          if (header === null) {
            const base = (Base.prototype as { fetch?: (r: Request) => Response | Promise<Response> }).fetch;
            return base ? base.call(this, request) : new Response('not found', { status: 404 });
          }
          if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
          const who = socketIdentity(header);
          if (!who) return new Response('bad sync header', { status: 400 });
          // Decision: read WebSocketPair from globalThis, because this package doesn't load the Workers types.
          const Pair = (globalThis as unknown as { WebSocketPair: new () => [unknown, unknown] }).WebSocketPair;
          const [device, object] = new Pair();
          this.#sockets.accept(object as never, who);
          return new Response(null, { status: 101, webSocket: device } as ResponseInit);
        }
        webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
          if (this.#sockets.message(ws as never, message)) return;
          return (Base.prototype as { webSocketMessage?: (ws: WebSocket, m: string | ArrayBuffer) => unknown }).webSocketMessage?.call(this, ws, message);
        }
        webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
          const base = (Base.prototype as { webSocketClose?: (...a: unknown[]) => unknown }).webSocketClose;
          if (base) return base.call(this, ws, code, reason, wasClean);
          try {
            ws.close(1000, 'closed');
          } catch {}
        }
        alarm() {
          return this.#engine.alarm();
        }
      } as any;
    },
    client(namespace, name = 'main') {
      const stub = (): Stub => namespace.get(namespace.idFromName(name));
      const group = (kind: 'query' | 'mutation') =>
        new Proxy({}, { get: (_, fn) => (typeof fn === 'string' && fn !== 'then' ? (args?: unknown) => stub().run(kind, fn, args) : undefined) });
      return { query: group('query'), mutate: group('mutation'), job: (id: string) => stub().job(id) } as DataClient<F>;
    },
  };
}

/** @internal */
export function socketIdentity(header: string): SocketIdentity | null {
  try {
    const v = JSON.parse(header) as { actor?: unknown; groups?: unknown } | null;
    if (!v || typeof v.actor !== 'string' || !Array.isArray(v.groups) || !v.groups.every((g) => typeof g === 'string')) return null;
    if (v.actor.length === 0 || v.actor.length > 200) return null;
    return { actor: v.actor, groups: v.groups };
  } catch {
    return null;
  }
}

type Resolved = {
  schema: Schema;
  functions: Record<string, AnyFn>;
  jobs: Record<string, JobFn<any>>;
  onCommit?: (topics: string[], env: any) => void | Promise<void>;
  onChanges?: (batch: ChangeBatch, env: any) => void | Promise<void>;
  syncAccess?: (ctx: QueryCtx<any>, actor: string, group: string) => boolean;
  syncRecheck?: (topics: string[]) => boolean;
  syncTopics?: (ctx: QueryCtx<any>, actor: string, topic: string) => boolean;
  syncQuery?: (actor: string, name: string, input: unknown) => SyncQueryPlan | null | Promise<SyncQueryPlan | null>;
  maxJobAttempts?: number;
  laneMs?: number;
};

/** Runs data functions and jobs against one storage. The Durable Object mixin wraps this. */
export class Engine {
  constructor(
    private readonly storage: DataStorage,
    private readonly env: any,
    private readonly def: Resolved,
  ) {}

  private readonly listeners: ((batch: ChangeBatch) => void)[] = [];
  private readonly rechecks: (() => void)[] = [];
  private readonly topicListeners: ((topics: string[]) => void)[] = [];

  /** @internal Called after each commit with the topics it touched. */
  onTopics(fn: (topics: string[]) => void): void {
    this.topicListeners.push(fn);
  }

  /** This storage's epoch, sent with positions. */
  epoch(): string {
    return currentEpoch(this.storage);
  }

  /** The topics out of `topics` that `actor` may hear, by `syncTopics`. None without it. */
  topicAccess(actor: string, topics: string[]): string[] {
    const check = this.def.syncTopics;
    if (!check) return [];
    const ctx = this.reader();
    return topics.filter((t) => {
      try {
        return check(ctx, actor, t) === true;
      } catch (e) {
        console.error(`syncTopics for "${t}" failed`, e);
        return false;
      }
    });
  }

  /** Answers live query `name` for `actor` by `syncQuery`. Null when it's refused. */
  async liveQuery(actor: string, name: string, input: unknown): Promise<QueryAnswer | null> {
    let plan: SyncQueryPlan | null | undefined;
    try {
      plan = await this.def.syncQuery?.(actor, name, input);
    } catch (e) {
      console.error(`syncQuery for "${name}" failed`, e);
      return null;
    }
    const fn = plan && Object.hasOwn(this.def.functions, plan.fn) ? this.def.functions[plan.fn] : undefined;
    if (!plan || fn?.kind !== 'query') return null;
    try {
      const value = await this.run('query', plan.fn, plan.args);
      if (!plan.output) return { value };
      const checked = (await plan.output['~standard'].validate(value)) as Validated;
      return checked.issues ? { error: 'invalid output' } : { value: checked.value };
    } catch (e) {
      // Decision: the device gets a fixed text, as an HTTP caller gets INTERNAL. The error's own text can name tables and fields.
      console.error(`live query "${name}" failed`, e);
      return { error: 'query failed' };
    }
  }

  /** @internal Called after each commit that touched synced tables, before `onChanges`. */
  listen(fn: (batch: ChangeBatch) => void): void {
    this.listeners.push(fn);
  }

  /** @internal Called after a commit that `syncRecheck` says may have changed who can read what. */
  onRecheck(fn: () => void): void {
    this.rechecks.push(fn);
  }

  private reader(): QueryCtx<any> {
    return { db: new DbReader(this.storage, this.def.schema), env: this.env, now: Date.now() };
  }

  /** The changes as `actor` sees them, through each table's `sync.view`. A view that returns null leaves the change out. */
  view(actor: string, changes: Change[]): Change[] {
    if (!changes.some((c) => c.doc && this.def.schema[c.table]?.sync?.view)) return changes;
    const ctx = { ...this.reader(), actor };
    const out: Change[] = [];
    for (const c of changes) {
      const view = this.def.schema[c.table]?.sync?.view;
      if (!c.doc || !view) {
        out.push(c);
        continue;
      }
      // Decision: a view that throws for one document tells this reader to drop it. Failing the whole page would stop the
      // reader at that document on each pull, and leaving the change out would let the reader keep a copy it may not see now.
      try {
        const doc = ctx.db.get(c.table as never, c.id) as Record<string, unknown> | null;
        const seen: unknown = doc ? view(doc as never, ctx) : null;
        if (seen !== null && seen !== undefined) out.push({ ...c, doc: seen as Record<string, unknown> });
      } catch (e) {
        console.error(`sync view of ${c.table} ${c.id} failed`, e);
        out.push({ ...c, doc: null });
      }
    }
    return out;
  }

  /** The groups out of `groups` that `actor` may read, by `syncAccess`. None without it. */
  access(actor: string, groups: string[]): string[] {
    const check = this.def.syncAccess;
    if (!check) return [];
    const ctx = this.reader();
    return groups.filter((g) => {
      try {
        return check(ctx, actor, g) === true;
      } catch (e) {
        console.error(`syncAccess for "${g}" failed`, e);
        return false;
      }
    });
  }

  init(): void {
    syncSchema(this.storage, this.def.schema);
    syncJobs(this.storage);
    syncChanges(this.storage);
  }

  /** What changed in these sync groups after position `after`. */
  pull(groups: readonly string[], after: number, limit?: number): PullResult {
    return pull(this.storage, this.def.schema, groups, after, limit);
  }

  scheduler(): Scheduler {
    return new Scheduler(this.storage, (name) => Object.hasOwn(this.def.jobs, name));
  }

  async run(kind: 'query' | 'mutation', name: string, args: unknown): Promise<unknown> {
    const fn = Object.hasOwn(this.def.functions, name) ? this.def.functions[name] : undefined;
    if (!fn || fn.kind !== kind) throw new Error(`no ${kind} function "${name}"`);
    if (fn.kind === 'query') return fn.run({ db: new DbReader(this.storage, this.def.schema), env: this.env, now: Date.now() }, args);

    const db = new Db(this.storage, this.def.schema);
    const scheduler = this.scheduler();
    // Decision: one SQLite transaction, so a throw rolls back each write and each scheduled job.
    let batch: ChangeBatch | null = null;
    let result: unknown;
    try {
      result = this.storage.transactionSync(() => {
        const out = fn.run({ db, scheduler, env: this.env, now: Date.now() }, args);
        // Decision: a mutation that returns a promise would write after the transaction ended, with no rollback and no word to
        // devices. It is refused, and the rest of it finds the database closed to writes.
        if (out && typeof (out as { then?: unknown }).then === 'function') {
          void Promise.resolve(out).catch(() => {});
          throw new Error(`mutation "${name}" returned a promise: mutations are synchronous, so do async work in a job`);
        }
        batch = db.changes.flush(this.storage);
        return out;
      });
    } finally {
      db.end();
      scheduler.end();
    }
    await this.afterCommit(db.touched, scheduler.changed, batch);
    return result;
  }

  /**
   * Durable Object alarm: runs the due jobs, then arms the alarm for the next one. Jobs run one at a time, except those
   * defined `concurrent` (a bot's turn can take minutes): those start at once and don't hold up the rest. Each job id
   * runs once at a time. The alarm stays up while any job runs, and picks up jobs queued meanwhile.
   */
  async alarm(): Promise<void> {
    const scheduler = this.scheduler();
    const max = this.def.maxJobAttempts ?? 5;
    const running = new Set<string>();
    const active: Promise<void>[] = [];
    // Decision: a job that hangs gives up the one-at-a-time lane after `laneMs`, so it can't hold up the rest.
    let laneOwner: string | null = null;
    const laneMs = this.def.laneMs ?? 120_000;
    for (;;) {
      for (const job of scheduler.due(Date.now(), 50)) {
        if (running.has(job.id)) continue;
        const concurrent = !!(this.def.jobs[job.name] as { concurrent?: boolean } | undefined)?.concurrent;
        if (!concurrent && laneOwner !== null) continue;
        let release: ReturnType<typeof setTimeout> | undefined;
        if (!concurrent) {
          laneOwner = job.id;
          release = setTimeout(() => {
            if (laneOwner === job.id) laneOwner = null;
          }, laneMs);
        }
        running.add(job.id);
        const done = this.runJob(scheduler, job, max).finally(() => {
          running.delete(job.id);
          clearTimeout(release);
          if (laneOwner === job.id) laneOwner = null;
          active.splice(active.indexOf(done), 1);
        });
        active.push(done);
      }
      if (!active.length) break;
      await Promise.race([...active, new Promise((r) => setTimeout(r, 1000))]);
    }
    await this.arm(scheduler);
  }

  private async runJob(scheduler: Scheduler, job: ScheduledJob, max: number): Promise<void> {
    const handler = Object.hasOwn(this.def.jobs, job.name) ? this.def.jobs[job.name] : undefined;
    // Decision: what the handler did and writing that down are kept apart, so a job that ran isn't counted as failed
    // because the note couldn't be written, and a storage error here doesn't end the alarm for the jobs beside it.
    let failure: { error: unknown } | null = null;
    try {
      if (!handler) throw new Error(`no job named "${job.name}"`);
      // Decision: a run that never ended took the object down, or a deploy cut it short. After ten of those in a row the
      // job is parked. A throw is an ending, and counts against `maxJobAttempts` as before.
      const cutShort = scheduler.started(job);
      if (cutShort === null) return;
      if (cutShort > MAX_CUT_SHORT) {
        console.error(`job ${job.name} (${job.id}) parked: its runs keep stopping before they finish`);
        scheduler.park(job, 'stopped before it finished, too many times');
        return;
      }
      await handler({ env: this.env, id: job.id, attempt: job.attempts + 1, data: this.dataClient() }, job.args);
    } catch (error) {
      failure = { error };
    }
    try {
      if (!failure) return scheduler.done(job);
      console.error(`job ${job.name} (${job.id}) failed`, failure.error);
      scheduler.fail(job, failure.error instanceof Error ? failure.error.message : String(failure.error), max, Date.now());
    } catch (e) {
      console.error(`job ${job.name} (${job.id}): its result couldn't be saved`, e);
    }
  }

  /** Arms the alarm for the earliest pending job. A restart can leave jobs pending with no alarm set, so the object calls this when it starts. */
  async rearm(): Promise<void> {
    await this.arm(this.scheduler());
  }

  private dataClient(): DataClient<any> {
    const call = (kind: 'query' | 'mutation') => new Proxy({}, { get: (_, fn) => (typeof fn === 'string' && fn !== 'then' ? (args?: unknown) => this.run(kind, fn, args) : undefined) });
    return { query: call('query'), mutate: call('mutation'), job: async (id: string) => this.scheduler().get(id) } as DataClient<any>;
  }

  private async afterCommit(touched: Set<string>, queueChanged: boolean, batch: ChangeBatch | null = null): Promise<void> {
    // Decision: devices hear about the commit before the alarm is set. Setting it waits, and a commit that came in during the
    // wait would go out first. It also means devices hear when the alarm can't be set, and the caller still gets the error.
    this.fanOut(touched, batch);
    if (queueChanged) await this.arm(this.scheduler());
  }

  private fanOut(touched: Set<string>, batch: ChangeBatch | null): void {
    // Decision: access is checked again before the commit goes out, so a reader the commit removed doesn't get what it wrote.
    if (touched.size && this.rechecks.length) {
      try {
        // Decision: only a plain false skips the check. A hook that returns a promise or nothing would otherwise skip it for good.
        const hook = this.def.syncRecheck;
        if (hook && hook([...touched]) !== false) for (const fn of this.rechecks) fn();
      } catch (e) {
        console.error('sync recheck failed', e);
      }
    }
    if (batch) for (const fn of this.listeners) {
      try {
        fn(batch);
      } catch (e) {
        console.error('change listener failed', e);
      }
    }
    if (touched.size) for (const fn of this.topicListeners) {
      try {
        fn([...touched]);
      } catch (e) {
        console.error('topic listener failed', e);
      }
    }
    if (batch && this.def.onChanges) {
      const onChanges = this.def.onChanges;
      const changes = batch;
      void Promise.resolve()
        .then(() => onChanges(changes, this.env))
        .catch((e) => console.error('onChanges failed', e));
    }
    if (touched.size && this.def.onCommit) {
      const onCommit = this.def.onCommit;
      // Decision: started, not awaited. See `onCommit` in DataDefinition for why.
      void Promise.resolve()
        .then(() => onCommit([...touched], this.env))
        .catch((e) => console.error('onCommit failed', e));
    }
  }

  private async arm(scheduler: Scheduler): Promise<void> {
    const next = scheduler.nextAt();
    if (next === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(next);
  }
}
