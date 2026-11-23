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
  | { status: 'loading'; data: undefined; error: undefined; fetching: true }
  | { status: 'ready'; data: T; error: undefined; fetching: boolean }
  /** `data` is the last good value, if there was one. */
  | { status: 'error'; data: T | undefined; error: Error; fetching: boolean };

export type Procs<R> = R extends { readonly '~procedures'?: infer P } ? NonNullable<P> : never;
export type TopicMap<R> = { [N in keyof Procs<R> & string]?: (input: InputOf<Procs<R>[N]>) => Array<string> };

export type LiveOptions<R> = {
  /** Same shape as `createClient<R>(...)` from `@builtbyfriends/realtime-http/client`. */
  client: {
    call<N extends keyof Procs<R> & string>(name: N, input?: InputOf<Procs<R>[N]>): Promise<OutputOf<Procs<R>[N]>>;
  };
  /** Without a transport, queries load once and refetch only when asked. */
  transport?: LiveTransport;
  /** Default topics per procedure, derived from its input. A query can override them. */
  topics?: TopicMap<R>;
  /** Events within this window collapse into one refetch. Default 50. */
  debounceMs?: number;
  /** How long a query nobody watches stays cached for the next mount to show. Default 30000. */
  cacheMs?: number;
  /** Also refetch when the tab becomes visible again or the browser goes back online. Default true. */
  refetchOnFocus?: boolean;
};

export type QueryOptions = {
  /** Topics for this query, replacing the defaults from `createLive`. */
  topics?: Array<string>;
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
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => QueryState<T>;
  refetch: () => Promise<void>;
}

type Entry = {
  key: string;
  name: string;
  input: unknown;
  load: () => Promise<{ data: unknown }>;
  topics: Array<string>;
  state: QueryState<unknown>;
  listeners: Set<() => void>;
  stops: Array<() => void>;
  inFlight: boolean;
  running: Promise<void> | undefined;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  gc: ReturnType<typeof setTimeout> | undefined;
  generation: number;
};

/** Sorted-key JSON, so `{a,b}` and `{b,a}` share one cache entry. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_: string, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

/**
 * The framework-free core. One entry per (procedure, input): components that ask for the same
 * query share one fetch and one set of subscriptions. An entry is live while someone listens.
 */
export function createLive<R extends Typed = Registry>(options: LiveOptions<R>) {
  const entries = new Map<string, Entry>();
  const debounceMs = options.debounceMs ?? 50;
  const cacheMs = options.cacheMs ?? 30_000;

  async function fetchNow(e: Entry): Promise<void> {
    if (e.inFlight) {
      e.dirty = true;
      return e.running;
    }
    e.inFlight = true;
    const finishers: Array<() => void> = [];
    e.running = new Promise<void>((resolve) => {
      finishers.push(resolve);
    });
    const generation = e.generation;
    try {
      do {
        e.dirty = false;
        if (e.state.status !== 'loading') {set(e, { ...e.state, fetching: true });}
        try {
          const { data } = await e.load();
          if (generation !== e.generation) {break;}
          set(e, { status: 'ready', data, error: undefined, fetching: e.dirty });
        } catch (error) {
          if (generation !== e.generation) {break;}
          set(e, { status: 'error', data: e.state.data, error: error instanceof Error ? error : new Error(String(error)), fetching: e.dirty });
        }
      } while (e.dirty && generation === e.generation);
    } finally {
      if (generation === e.generation) {e.inFlight = false;}
      for (const finish of finishers) {finish();}
    }
  }

  function set(e: Entry, state: QueryState<unknown>) {
    e.state = state;
    // oxlint-disable-next-line unicorn/no-useless-spread -- a listener may unsubscribe while the loop runs, so it walks a copy
    for (const l of [...e.listeners]) {l();}
  }

  function schedule(e: Entry) {
    if (!e.listeners.size) {return;}
    clearTimeout(e.timer);
    e.timer = setTimeout(() => void fetchNow(e), debounceMs);
  }

  function start(e: Entry) {
    clearTimeout(e.gc);
    if (e.stops.length) {return;}
    const alive = { current: true };
    const gen = e.generation;
    void fetchNow(e);
    const transport = options.transport;
    if (transport) {
      for (const topic of e.topics) {
        Promise.resolve(transport.subscribe(topic, () => schedule(e))).then(
          (stop) => (alive.current && gen === e.generation ? e.stops.push(stop) : stop()),
          (error: unknown) => console.error(`live: subscribing to "${topic}" failed`, error),
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
    for (const s of e.stops.splice(0)) {s();}
    e.generation++;
    e.inFlight = false;
    clearTimeout(e.gc);
    e.gc = setTimeout(() => {
      if (!e.listeners.size && entries.get(e.key) === e) {entries.delete(e.key);}
    }, cacheMs);
  }

  /** Watch one query. React's `useQuery` is a thin wrapper over this. */
  function query<N extends keyof Procs<R> & string>(
    name: N,
    input: InputOf<Procs<R>[N]>,
    queryOptions: QueryOptions = {},
  ): QueryHandle<OutputOf<Procs<R>[N]>> {
    const topics = queryOptions.topics ?? options.topics?.[name]?.(input) ?? [];
    const enabled = queryOptions.enabled !== false;
    const key = `${name}:${stableKey(input)}:${stableKey(topics)}`;
    let e = entries.get(key);
    if (!e) {
      e = { key, name, input, load: async () => ({ data: await options.client.call(name, input) }), topics, state: { status: 'loading', data: undefined, error: undefined, fetching: true }, listeners: new Set(), stops: [], inFlight: false, running: undefined, dirty: false, timer: undefined, gc: undefined, generation: 0 };
      entries.set(key, e);
    }
    const entry = e;
    return {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cache is keyed by procedure and input, so the key is what says what type its data has
      getSnapshot: () => entry.state as QueryState<OutputOf<Procs<R>[N]>>,
      subscribe(listener) {
        entry.listeners.add(listener);
        if (enabled) {start(entry);}
        return () => {
          entry.listeners.delete(listener);
          if (!entry.listeners.size) {stop(entry);}
        };
      },
      refetch: () => fetchNow(entry),
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
    const changed: Array<{ e: Entry; before: QueryState<unknown>; guess: QueryState<unknown> }> = [];
    try {
      mutateOptions.optimistic?.({
        update(queryName, queryInput, fn) {
          const prefix = `${queryName}:${stableKey(queryInput)}:`;
          for (const e of entries.values()) {
            const before = e.state;
            if (!e.key.startsWith(prefix) || before.status === 'loading' || before.data === undefined) {continue;}
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the key matched this procedure and input, so the cached data has the type the store gives `fn`
            const guess = { ...before, data: fn(before.data as OutputOf<Procs<R>[typeof queryName]>) };
            set(e, guess);
            changed.push({ e, before, guess });
          }
        },
      });
      return await options.client.call(name, input);
    } catch (error) {
      for (const { e, before, guess } of changed.reverse()) {
        if (e.state === guess) {set(e, before);}
      }
      throw error;
    } finally {
      for (const { e } of changed) {
        if (e.listeners.size) {void fetchNow(e);}
      }
    }
  }

  /** Refetch every query that is currently being watched. */
  function refetchAll(): Promise<Array<void>> {
    const watched: Array<Entry> = [];
    for (const e of entries.values()) {
      if (e.listeners.size) {watched.push(e);}
    }
    return Promise.all(watched.map((e) => fetchNow(e)));
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
      if (e.name !== name || e.state.status !== 'ready') {continue;}
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- entries of this procedure name hold the types the registry gives it
      const next = fn(e.state.data as OutputOf<Procs<R>[N]>, e.input as InputOf<Procs<R>[N]>);
      if (next === undefined || next === e.state.data) {continue;}
      // Decision: a fetch on its way may have read before this change, so fetch once more after it and it can't win.
      if (e.inFlight) {e.dirty = true;}
      set(e, { ...e.state, data: next });
    }
  }

  /** Refetches the watched answers of a procedure whose input passes `match`. */
  function refetch<N extends keyof Procs<R> & string>(name: N, match: (input: InputOf<Procs<R>[N]>) => boolean = () => true): Promise<Array<void>> {
    const matching: Array<Entry> = [];
    for (const e of entries.values()) {
      if (e.name !== name || !e.listeners.size) {continue;}
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- entries of this procedure name hold the input type the registry gives it
      if (match(e.input as InputOf<Procs<R>[N]>)) {matching.push(e);}
    }
    return Promise.all(matching.map((e) => fetchNow(e)));
  }

  return { query, mutate, refetchAll, update, refetch };
}

export type Live<R extends Typed = Registry> = ReturnType<typeof createLive<R>>;
