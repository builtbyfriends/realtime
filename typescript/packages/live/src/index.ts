import type { InputOf, OutputOf, Registry } from '@builtbyfriends/realtime';

/**
 * What the live client needs of a registry: its procedure map, which is a type and nothing at runtime. A `Registry` has
 * one, and so does a plain `{ '~procedures': ProcedureMap }` (bwf generates the map from the procedures folder).
 */
export type Typed = { readonly '~procedures'?: unknown };

/**
 * How a client hears about changes. bwf's `connectLiveStream` is one (see `@builtbyfriends/realtime-bwf/live`);
 * anything with topics and a reconnect signal works. Delivery may be at most once, so the
 * store never trusts an event's payload: an event only means "this query may be stale".
 */
export interface LiveTransport {
  /** Listen to a topic. Resolves to the function that stops listening. */
  subscribe(topic: string, onEvent: () => void): Promise<() => void> | (() => void);
  /** The connection came back after a drop, so events may have been missed. Returns an unsubscribe. */
  onReconnect(callback: () => void): () => void;
}

export type QueryState<T> =
  /** `fetching` is false while a query is idle: disabled and never started. */
  | { status: 'loading'; data: undefined; error: undefined; fetching: boolean }
  | { status: 'ready'; data: T; error: undefined; fetching: boolean }
  /** `data` is the last good value, if there was one. */
  | { status: 'error'; data: T | undefined; error: Error; fetching: boolean };

export type Procs<R> = R extends { readonly '~procedures'?: infer P } ? NonNullable<P> : never;
export type TopicMap<R> = { [N in keyof Procs<R> & string]?: (input: InputOf<Procs<R>[N]>) => string[] };

export type LiveOptions<R> = {
  /** Same shape as `createClient<R>(...)` from `@builtbyfriends/realtime-http/client`. */
  client: { call: (name: any, input?: any) => Promise<any> };
  /** Without a transport, queries load once and refetch only when asked. */
  transport?: LiveTransport;
  /** Default topics per procedure, derived from its input. A query can override them. */
  topics?: TopicMap<R>;
  /** Events within this window collapse into one refetch. Default 50. */
  debounceMs?: number;
  /**
   * The longest an event waits before a refetch, when events keep arriving faster than `debounceMs` and would
   * otherwise keep pushing it back. Default 4 times `debounceMs`.
   */
  maxWaitMs?: number;
  /** How long a query nobody watches stays cached for the next mount to show. Default 30000. */
  cacheMs?: number;
  /** Also refetch when the tab becomes visible again or the browser goes back online. Default true. */
  refetchOnFocus?: boolean;
};

export type QueryOptions = {
  /** Topics for this query, replacing the defaults from `createLive`. */
  topics?: string[];
  /** False keeps the query idle (no fetch, no subscription), e.g. while an id is not known. */
  enabled?: boolean;
};

/** What `optimistic` gets: change a watched query's data now, by procedure name and input. */
export type OptimisticStore<R> = {
  update<N extends keyof Procs<R> & string>(
    name: N,
    input: InputOf<Procs<R>[N]>,
    fn: (data: OutputOf<Procs<R>[N]>) => OutputOf<Procs<R>[N]>,
  ): void;
};

export type MutateOptions<R> = {
  /** Change watched queries before the server answers. Undone if the call fails. */
  optimistic?: (store: OptimisticStore<R>) => void;
};

export interface QueryHandle<T = unknown> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): QueryState<T>;
  refetch(): Promise<void>;
}

type Entry = {
  key: string;
  name: string;
  input: unknown;
  topics: string[];
  state: QueryState<any>;
  subs: Set<Sub>;
  stops: Array<() => void>;
  inFlight: boolean;
  running: Promise<void> | undefined;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  gc: ReturnType<typeof setTimeout> | undefined;
  generation: number;
  waitStart: number | undefined;
  guessed: boolean;
  pending: number;
  settled: any;
};

type Sub = { listener: () => void; enabled: boolean };

const idle: QueryState<any> = { status: 'loading', data: undefined, error: undefined, fetching: false };

function hasEnabled(e: Entry): boolean {
  for (const s of e.subs) if (s.enabled) return true;
  return false;
}

/** Sorted-key JSON, so `{a,b}` and `{b,a}` share one cache entry. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

/**
 * The framework-free core. One entry per (procedure, input): components that ask for the same
 * query share one fetch and one set of subscriptions. An entry is live while someone listens.
 */
export function createLive<R extends Typed = Registry<any>>(options: LiveOptions<R>) {
  const entries = new Map<string, Entry>();
  const debounceMs = options.debounceMs ?? 50;
  const cacheMs = options.cacheMs ?? 30_000;
  const maxWaitMs = options.maxWaitMs ?? debounceMs * 4;
  const topicsFor = options.topics as Record<string, ((input: unknown) => string[]) | undefined> | undefined;

  async function fetchNow(e: Entry): Promise<void> {
    if (e.inFlight) {
      e.dirty = true;
      return e.running;
    }
    e.inFlight = true;
    let finish!: () => void;
    e.running = new Promise<void>((resolve) => (finish = resolve));
    const generation = e.generation;
    try {
      do {
        e.dirty = false;
        if (e.state.status !== 'loading') set(e, { ...e.state, fetching: true } as QueryState<any>);
        try {
          const data = await options.client.call(e.name, e.input);
          if (generation !== e.generation) break;
          e.guessed = false;
          set(e, { status: 'ready', data, error: undefined, fetching: e.dirty });
        } catch (err) {
          if (generation !== e.generation) break;
          const data = e.guessed ? e.settled : e.state.data;
          e.guessed = false;
          set(e, { status: 'error', data, error: err instanceof Error ? err : new Error(String(err)), fetching: e.dirty });
        }
      } while (e.dirty && generation === e.generation);
    } finally {
      if (generation === e.generation) e.inFlight = false;
      finish();
    }
  }

  function set(e: Entry, state: QueryState<any>) {
    e.state = state;
    for (const s of [...e.subs]) s.listener();
  }

  function schedule(e: Entry) {
    if (!hasEnabled(e)) return;
    clearTimeout(e.timer);
    const now = Date.now();
    e.waitStart ??= now;
    const delay = Math.min(debounceMs, Math.max(0, e.waitStart + maxWaitMs - now));
    e.timer = setTimeout(() => {
      e.waitStart = undefined;
      void fetchNow(e);
    }, delay);
  }

  function collectLater(e: Entry) {
    clearTimeout(e.gc);
    e.gc = setTimeout(() => {
      if (!e.subs.size && entries.get(e.key) === e) entries.delete(e.key);
    }, cacheMs);
  }

  function start(e: Entry) {
    clearTimeout(e.gc);
    if (e.stops.length) return;
    const alive = { current: true };
    const gen = e.generation;
    void fetchNow(e);
    const transport = options.transport;
    if (transport) {
      for (const topic of e.topics) {
        Promise.resolve(transport.subscribe(topic, () => schedule(e))).then(
          (stop) => (alive.current && gen === e.generation ? e.stops.push(stop) : stop()),
          (err) => console.error(`live: subscribing to "${topic}" failed`, err),
        );
      }
      e.stops.push(transport.onReconnect(() => void fetchNow(e)));
    }
    if (options.refetchOnFocus !== false && typeof document !== 'undefined') {
      const onVisible = () => document.visibilityState === 'visible' && schedule(e);
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', onVisible);
      e.stops.push(() => {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', onVisible);
      });
    }
    e.stops.push(() => void (alive.current = false));
  }

  function stop(e: Entry) {
    clearTimeout(e.timer);
    e.waitStart = undefined;
    for (const s of e.stops.splice(0)) s();
    e.generation++;
    if (e.inFlight) {
      e.inFlight = false;
      if (e.state.fetching) set(e, { ...e.state, fetching: false } as QueryState<any>);
    }
  }

  /** Watch one query. React's `useQuery` is a thin wrapper over this. */
  function query<N extends keyof Procs<R> & string>(
    name: N,
    input: InputOf<Procs<R>[N]>,
    queryOptions: QueryOptions = {},
  ): QueryHandle<OutputOf<Procs<R>[N]>> {
    const topics = [...new Set(queryOptions.topics ?? topicsFor?.[name]?.(input) ?? [])].sort();
    const enabled = queryOptions.enabled !== false;
    const key = `${name}:${stableKey(input)}:${stableKey(topics)}`;
    let e = entries.get(key);
    if (!e) {
      e = { key, name, input, topics, state: { status: 'loading', data: undefined, error: undefined, fetching: true }, subs: new Set(), stops: [], inFlight: false, running: undefined, dirty: false, timer: undefined, gc: undefined, generation: 0, waitStart: undefined, guessed: false, pending: 0, settled: undefined };
      entries.set(key, e);
      collectLater(e);
    }
    let entry = e;
    function resolve(reinsert: boolean): Entry {
      const current = entries.get(key);
      if (current) entry = current;
      else if (reinsert) entries.set(key, entry);
      return entry;
    }
    return {
      getSnapshot() {
        const current = resolve(false);
        return !enabled && current.state.status === 'loading' && !current.stops.length && !current.inFlight ? idle : current.state;
      },
      subscribe(listener) {
        const current = resolve(true);
        const sub: Sub = { listener, enabled };
        current.subs.add(sub);
        clearTimeout(current.gc);
        if (enabled) start(current);
        return () => {
          if (!current.subs.delete(sub)) return;
          if (current.stops.length && !hasEnabled(current)) stop(current);
          if (!current.subs.size) collectLater(current);
        };
      },
      refetch: () => fetchNow(resolve(false)),
    };
  }

  /**
   * Runs a procedure. The server publishes the topics the change touched, so live queries refresh themselves.
   *
   * `optimistic` changes the data of watched queries right away, before the server answers. If the call fails, each
   * changed query goes back to what it showed before (unless something newer arrived meanwhile) and fetches again.
   * If it succeeds, the changed queries fetch again too, since a topic event can be missed, so the server's answer
   * replaces the guess either way.
   */
  async function mutate<N extends keyof Procs<R> & string>(
    name: N,
    input: InputOf<Procs<R>[N]>,
    mutateOptions: MutateOptions<R> = {},
  ): Promise<OutputOf<Procs<R>[N]>> {
    let done = false;
    const changed: Array<{ e: Entry; before: QueryState<any>; guess: QueryState<any>; fn: (data: any) => any }> = [];
    try {
      mutateOptions.optimistic?.({
        update(queryName, queryInput, fn) {
          const prefix = `${queryName}:${stableKey(queryInput)}:`;
          for (const e of entries.values()) {
            if (!e.key.startsWith(prefix) || e.state.data === undefined) continue;
            const before = e.state;
            const guess = { ...before, data: fn(before.data) } as QueryState<any>;
            if (!e.guessed) e.settled = before.data;
            e.guessed = true;
            e.pending++;
            set(e, guess);
            changed.push({ e, before, guess, fn });
          }
        },
      });
      const result = await options.client.call(name, input);
      for (const { e, fn } of changed) {
        e.pending--;
        const prev = e.settled;
        try {
          e.settled = fn(prev);
        } catch {}
        if (!e.pending) e.guessed = false;
        if (e.state.status === 'error' && e.state.data === prev && e.settled !== prev) set(e, { ...e.state, data: e.settled });
      }
      done = true;
      return result;
    } catch (err) {
      if (!done) {
        for (const { e, before, guess } of changed.reverse()) {
          e.pending--;
          if (e.state.data === guess.data) set(e, { ...e.state, data: before.data } as QueryState<any>);
          if (!e.pending) e.guessed = false;
        }
      }
      throw err;
    } finally {
      for (const { e } of changed) if (hasEnabled(e)) void fetchNow(e);
    }
  }

  /** Refetch every query that is currently being watched. */
  function refetchAll(): Promise<void[]> {
    return Promise.all([...entries.values()].filter(hasEnabled).map((e) => fetchNow(e)));
  }

  /**
   * Changes the cached answers of a procedure in place, without a fetch, for a device that hears the changed records
   * themselves (a sync socket). `fn` gets each answer that's ready with its input, and returns the new answer, or
   * undefined to leave it be. Watchers see the new answer at once.
   */
  function update<N extends keyof Procs<R> & string>(
    name: N,
    fn: (data: OutputOf<Procs<R>[N]>, input: InputOf<Procs<R>[N]>) => OutputOf<Procs<R>[N]> | undefined,
  ): void {
    for (const e of entries.values()) {
      if (e.name !== name || e.state.status !== 'ready') continue;
      const next = fn(e.state.data, e.input as InputOf<Procs<R>[N]>);
      if (next === undefined || next === e.state.data) continue;
      // Decision: a fetch on its way may have read before this change, so fetch once more after it and it can't win.
      if (e.inFlight) e.dirty = true;
      if (e.guessed && e.settled !== undefined) e.settled = fn(e.settled, e.input as InputOf<Procs<R>[N]>) ?? e.settled;
      set(e, { ...e.state, data: next });
    }
  }

  /** Refetches the watched answers of a procedure whose input passes `match`. */
  function refetch<N extends keyof Procs<R> & string>(name: N, match: (input: InputOf<Procs<R>[N]>) => boolean = () => true): Promise<void[]> {
    return Promise.all([...entries.values()].filter((e) => e.name === name && hasEnabled(e) && match(e.input as InputOf<Procs<R>[N]>)).map((e) => fetchNow(e)));
  }

  return { query, mutate, refetchAll, update, refetch };
}

export type Live<R extends Typed = Registry<any>> = ReturnType<typeof createLive<R>>;
