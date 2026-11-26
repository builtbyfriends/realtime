import { createCollection, createOptimisticAction, parseLoadSubsetOptions } from '@tanstack/db';
import type { Collection, LoadSubsetOptions } from '@tanstack/db';
import { fillTopic, topicsOf, validate } from '@builtbyfriends/realtime';
import type {
  AnySchema,
  CommandError,
  CommandName,
  CommandOutput,
  Contract,
  ContractSpec,
  EventName,
  EventPayload,
  GoodInput,
  RecordOf,
} from '@builtbyfriends/realtime';
import { stableKey } from './index.js';

/** What the window needs to call a module: the contract's command name, `<module>.<command>`, and its input. */
export type RecordsClient = { call(name: string, input: unknown): Promise<unknown> };

/**
 * Where events come from. The event is what the module published (`{ module, name, event, topic, payload }`), and the
 * payload is checked against the contract before it's used.
 */
export type EventTransport = {
  subscribe(topic: string, onEvent: (event: unknown) => void): Promise<() => void> | (() => void);
  /** The connection came back after a drop, so events may have been missed. Returns an unsubscribe. */
  onReconnect(callback: () => void): () => void;
};

type Row = Record<string, unknown>;

type RecordName<C extends ContractSpec> = keyof C['data'] & string;

export type ReadCommands<C extends ContractSpec> = {
  [K in CommandName<C>]: C['commands'][K] extends { effect: 'read' } ? K : never;
}[CommandName<C>];

type CarryingEvents<C extends ContractSpec, R extends RecordName<C>> = {
  [E in EventName<C>]: EventPayload<C, E> extends RecordOf<C, R> ? E : never;
}[EventName<C>];

type AnswerOf<C extends ContractSpec, K extends CommandName<C>> = {
  [R in RecordName<C>]: CommandOutput<C, K> extends RecordOf<C, R> ? R : never;
}[RecordName<C>];

type ReadMap<C extends ContractSpec, K extends CommandName<C>, R extends RecordName<C>> = {
  [F in keyof GoodInput<C, K> & string]: keyof RecordOf<C, R> & string;
};

export type RecordSpec<C extends ContractSpec, R extends RecordName<C>> = {
  /** The field that identifies a record. */
  key: keyof RecordOf<C, R> & string;
  /** A field whose bigger value means a newer record. */
  version: keyof RecordOf<C, R> & string;
  /** The read commands that load this record, each with how its input fields match the record's fields. */
  reads: { [K in ReadCommands<C>]?: ReadMap<C, K, R> };
  /** Events whose payload holds the record as it is after the change. */
  upserts: ReadonlyArray<CarryingEvents<C, R>>;
  /** Events whose payload holds the record's key and says the record is gone. */
  removes?: ReadonlyArray<EventName<C>>;
};

export type Collections<C extends ContractSpec> = { [R in RecordName<C>]: Collection<RecordOf<C, R> & Row, string> };

export type CommandSpec<C extends ContractSpec, K extends CommandName<C>> = {
  /** The record the command's answer is: it goes into that record's collection. */
  answers?: AnswerOf<C, K>;
  /** The record the command deletes, by the key field of its answer. */
  removes?: RecordName<C>;
  /** Shows the change at once. It runs in the same tick, and the change is undone when the command fails. */
  optimistic?: (input: GoodInput<C, K>, collections: Collections<C>) => void;
};

export type ViewSpec<C extends ContractSpec> = {
  /** Events that mean the answer may have changed. Needs a topic whose fields are all in the read's input. */
  events?: ReadonlyArray<EventName<C>>;
  /** Commands that, once they settle, mean the answer may have changed. */
  commands?: ReadonlyArray<CommandName<C>>;
};

export type RecordsSpec<C extends ContractSpec> = {
  records: { [R in RecordName<C>]?: RecordSpec<C, R> };
  commands?: { [K in CommandName<C>]?: CommandSpec<C, K> };
  /** Reads that depend on who's asking, such as what may be done now. They sit beside the records and refresh on their own. */
  views?: { [K in ReadCommands<C>]?: ViewSpec<C> };
};

export type RecordsDefinition<C extends ContractSpec = ContractSpec, S extends RecordsSpec<C> = RecordsSpec<C>> = {
  readonly contract: Contract<C>;
  readonly spec: S;
};

/** Ties a contract to how its records are loaded and changed. The result is a plain value: nothing runs until a provider uses it. */
export function defineRecords<C extends ContractSpec, const S extends RecordsSpec<C>>(contract: Contract<C>, spec: S): RecordsDefinition<C, S> {
  return { contract, spec };
}

export type CommandFailure<C extends ContractSpec, K extends CommandName<C>> = Error & {
  requestId: string;
  code: CommandError<C, K> | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INTERNAL';
};

export type CommandResult<C extends ContractSpec, K extends CommandName<C>> =
  | { ok: true; value: CommandOutput<C, K> }
  | { ok: false; error: CommandFailure<C, K> };

export type Intent<C extends ContractSpec, K extends CommandName<C>> = {
  /** One per intent. Pass it back to `retry` and the module runs the command once. */
  requestId: string;
  /** Settles when the module has answered and the answer is in the collection. Rejects with a `CommandFailure`. */
  settled: Promise<CommandOutput<C, K>>;
  /** The same, as a value: a failure carries a code the contract lists for this command, so a switch on it is checked. */
  result: Promise<CommandResult<C, K>>;
};

export type ViewState<T> =
  | { status: 'loading'; data: undefined; error: undefined }
  | { status: 'ready'; data: T; error: undefined }
  | { status: 'error'; data: T | undefined; error: Error };

export type ViewHandle<T> = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ViewState<T>;
  refresh: () => Promise<void>;
};

export type Runtime<C extends ContractSpec, S extends RecordsSpec<C>> = {
  collections: { [R in keyof S['records'] & RecordName<C>]: Collection<RecordOf<C, R> & Row, string> };
  commands: {
    [K in keyof S['commands'] & CommandName<C>]: (input: GoodInput<C, K>, retry?: { requestId: string }) => Intent<C, K>;
  };
  views: { [K in keyof S['views'] & ReadCommands<C>]: (input: GoodInput<C, K>) => ViewHandle<CommandOutput<C, K>> };
};

export type RecordsOptions = {
  client: RecordsClient;
  transport?: EventTransport;
};

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEvent(raw: unknown, name: string): boolean {
  return !isRow(raw) || !('name' in raw) || raw.name === name;
}

const topicFields = (topic: string): Array<string> => [...topic.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? '');

function newer(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {return a - b;}

  const x = String(a);
  const y = String(b);

  if (x === y) {return 0;}

  return x > y ? 1 : -1;
}

async function parse(schema: AnySchema, value: unknown, where: string): Promise<unknown> {
  const r = await validate(schema, value);

  if (!r.ok) {throw new Error(`${where} doesn't match the contract: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);}

  return r.value;
}

function failureOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function codeOf(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL';
}

function topicsFor(contract: ContractSpec, events: ReadonlyArray<string>, input: Row): Array<{ event: string; topic: string }> {
  const out: Array<{ event: string; topic: string }> = [];

  for (const event of events) {
    const spec = contract.events[event];

    if (!spec) {continue;}

    for (const topic of topicsOf(spec)) {
      if (topicFields(topic).every((f) => f in input)) {out.push({ event, topic: fillTopic(topic, input) });}
    }
  }

  return out;
}

type Watch = { topic: string; handle: (event: unknown) => void };

function watcher(transport: EventTransport | undefined) {
  return function watch(watches: ReadonlyArray<Watch>, onReconnect: () => void): () => void {
    if (!transport) {return () => {};}

    let live = true;
    const stops: Array<() => void> = [];

    for (const w of watches) {
      Promise.resolve(transport.subscribe(w.topic, w.handle)).then(
        (stop) => (live ? stops.push(stop) : stop()),
        (error: unknown) => console.error(`live: subscribing to "${w.topic}" failed`, error),
      );
    }

    stops.push(transport.onReconnect(onReconnect));

    return () => {
      live = false;

      for (const stop of stops.splice(0)) {stop();}
    };
  };
}

function recordStore<C extends ContractSpec>(contract: Contract<C>, name: string, spec: RecordSpec<C, RecordName<C>>, client: RecordsClient, transport: EventTransport | undefined) {
  const found = contract.data[name];

  if (!found) {throw new Error(`${contract.name} has no record "${name}"`);}

  const schema: AnySchema = found;
  const reads = Object.entries(spec.reads).flatMap(([command, map]) => (isRow(map) ? [{ command, map: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)])) }] : []));
  const versions = new Map<string, unknown>();
  const synced = new Set<string>();
  const subsets = new Map<string, { count: number; stop: () => void }>();
  const watch = watcher(transport);
  let upsertRows: ((rows: ReadonlyArray<Row>) => void) | undefined;
  let removeKeys: ((keys: ReadonlyArray<string>) => void) | undefined;
  let ops: { begin: () => void; write: (message: never) => void; commit: () => unknown } | undefined;

  const keyOf = (row: Row) => String(row[spec.key]);

  function mutate(changes: ReadonlyArray<{ type: 'insert' | 'update' | 'delete'; key: string; value: Row }>) {
    if (!ops || !changes.length) {return;}

    ops.begin();

    for (const change of changes) {
      if (change.type === 'delete') {synced.delete(change.key);} else {synced.add(change.key);}

      // Decision: the rows were parsed with the contract's record schema, so the collection takes them as they are.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the Decision above
      ops.write(change as never);
    }

    ops.commit();
  }

  async function toRows(raw: unknown): Promise<Array<Row>> {
    const rows: Array<Row> = [];

    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const parsed = await parse(schema, item, `${contract.name}.${name}`);

      if (isRow(parsed)) {rows.push(parsed);}
    }

    return rows;
  }

  async function onEvent(event: string, raw: unknown): Promise<Array<Row>> {
    const payload = isRow(raw) && 'payload' in raw ? raw.payload : raw;
    const evSchema = contract.events[event]?.payload;

    if (!evSchema) {return [];}

    const checked = await parse(evSchema, payload, `${contract.name}.${event} event`);

    if (spec.removes?.includes(event) && isRow(checked)) {return [{ [spec.key]: checked[spec.key] }];}

    return toRows(checked);
  }

  function reportError(error: unknown) {
    console.error(`live: ${contract.name}.${name}`, error);
  }

  function resolve(opts: LoadSubsetOptions) {
    const filters = new Map<string, unknown>();

    for (const f of parseLoadSubsetOptions(opts).filters) {
      if (f.operator === 'eq') {filters.set(f.field.join('.'), f.value);}
    }

    const read = reads.find(({ map }) => Object.keys(map).length > 0 && Object.values(map).every((field) => filters.has(field)));

    if (!read) {throw new Error(`${contract.name}.${name}: no read matches a query on ${[...filters.keys()].join(', ') || 'nothing'}; list one in reads`);}

    const input = Object.fromEntries(Object.entries(read.map).map(([inputField, recordField]) => [inputField, filters.get(recordField)]));

    return { command: read.command, input, id: `${read.command}:${stableKey(input)}` };
  }

  const collection: Collection<Row, string> = createCollection<Row, string>({
    id: `${contract.name}.${name}`,
    getKey: keyOf,
    syncMode: 'on-demand',
    sync: {
      rowUpdateMode: 'full',
      sync: (params) => {
        // Decision: the collection hands back the begin, write and commit that it was made with, and `ops` only narrows their types.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the Decision above
        ops = params as never;
        versions.clear();
        synced.clear();
        params.markReady();
        const has = (key: string) => synced.has(key);

        const upsert = (rows: ReadonlyArray<Row>) => {
          const changes: Array<{ type: 'insert' | 'update'; key: string; value: Row }> = [];

          for (const row of rows) {
            const key = keyOf(row);
            const seen = versions.get(key);

            if (seen !== undefined && newer(row[spec.version], seen) <= 0) {continue;}

            versions.set(key, row[spec.version]);
            changes.push({ type: has(key) ? 'update' : 'insert', key, value: row });
          }

          mutate(changes);
        };

        const remove = (keys: ReadonlyArray<string>) => mutate(keys.flatMap((key) => (has(key) ? [{ type: 'delete' as const, key, value: {} }] : [])));
        upsertRows = upsert;
        removeKeys = remove;

        return {
          cleanup: () => {
            for (const s of subsets.values()) {s.stop();}

            subsets.clear();
          },
          loadSubset: async (opts: LoadSubsetOptions) => {
            const { command, input, id } = resolve(opts);
            const have = subsets.get(id);

            if (have) {
              have.count += 1;

              return;
            }

            const known = new Set<string>();
            const output = contract.commands[command]?.output;

            const run = async () => {
              const answer = await client.call(`${contract.name}.${command}`, input);
              const rows = await toRows(output ? await parse(output, answer, `${contract.name}.${command} answer`) : answer);
              upsert(rows);

              if (Array.isArray(answer)) {
                const now = new Set(rows.map(keyOf));
                remove([...known].filter((k) => !now.has(k)));
                known.clear();

                for (const k of now) {known.add(k);}
              }
            };

            const watches: Array<Watch> = [
              ...topicsFor(contract, spec.upserts, input).map(({ event, topic }) => ({
                topic,
                handle: (raw: unknown) => {
                  if (isEvent(raw, event)) {void onEvent(event, raw).then(upsert).catch(reportError);}
                },
              })),
              ...topicsFor(contract, spec.removes ?? [], input).map(({ event, topic }) => ({
                topic,
                handle: (raw: unknown) => {
                  if (isEvent(raw, event)) {void onEvent(event, raw).then((rows) => remove(rows.map(keyOf))).catch(reportError);}
                },
              })),
            ];

            subsets.set(id, { count: 1, stop: watch(watches, () => void run().catch(reportError)) });
            await run();
          },
          unloadSubset: (opts: LoadSubsetOptions) => {
            const { id } = resolve(opts);
            const have = subsets.get(id);

            if (!have) {return;}

            have.count -= 1;

            if (have.count > 0) {return;}

            have.stop();
            subsets.delete(id);
          },
        };
      },
    },
  });

  return {
    collection,
    apply: async (raw: unknown) => upsertRows?.(await toRows(raw)),
    drop: (raw: unknown) => {
      if (isRow(raw)) {removeKeys?.([keyOf(raw)]);}
    },
  };
}

function viewStore<C extends ContractSpec>(
  contract: Contract<C>,
  command: string,
  spec: ViewSpec<C>,
  client: RecordsClient,
  transport: EventTransport | undefined,
  settled: { subscribe: (listener: (name: string) => void) => () => void },
) {
  const cache = new Map<string, ViewHandle<unknown>>();
  const watch = watcher(transport);
  const output = contract.commands[command]?.output;

  return (input: Row): ViewHandle<unknown> => {
    const key = stableKey(input);
    const cached = cache.get(key);

    if (cached) {return cached;}

    let state: ViewState<unknown> = { status: 'loading', data: undefined, error: undefined };
    const listeners = new Set<() => void>();
    let stop: (() => void) | undefined;
    let generation = 0;

    const set = (next: ViewState<unknown>) => {
      state = next;

      // oxlint-disable-next-line unicorn/no-useless-spread -- a listener may unsubscribe while the loop runs
      for (const l of [...listeners]) {l();}
    };

    async function refresh() {
      const mine = ++generation;

      try {
        const answer = await client.call(`${contract.name}.${command}`, input);
        const data = output ? await parse(output, answer, `${contract.name}.${command} answer`) : answer;

        if (mine === generation) {set({ status: 'ready', data, error: undefined });}
      } catch (error) {
        if (mine === generation) {set({ status: 'error', data: state.data, error: failureOf(error) });}
      }
    }

    const again = () => void refresh();

    function start() {
      const watches = topicsFor(contract, spec.events ?? [], input).map(({ event, topic }) => ({
        topic,
        handle: (raw: unknown) => {
          if (isEvent(raw, event)) {again();}
        },
      }));

      const stopWatch = watch(watches, again);

      const stopCommands = settled.subscribe((name) => {
        if (spec.commands?.includes(name)) {again();}
      });

      stop = () => {
        stopWatch();
        stopCommands();
      };

      again();
    }

    const handle: ViewHandle<unknown> = {
      getSnapshot: () => state,
      refresh,
      subscribe(listener) {
        listeners.add(listener);

        if (listeners.size === 1) {start();}

        return () => {
          listeners.delete(listener);

          if (listeners.size === 0) {
            generation++;
            stop?.();
            stop = undefined;
          }
        };
      },
    };

    cache.set(key, handle);

    return handle;
  };
}

function buildRuntime<C extends ContractSpec, const S extends RecordsSpec<C>>(definition: RecordsDefinition<C, S>, options: RecordsOptions): unknown {
  const { contract, spec } = definition;
  const stores = new Map<string, ReturnType<typeof recordStore<C>>>();

  for (const [name, recordSpec] of Object.entries(spec.records)) {
    // Decision: Object.entries loses the link between a record's name and its spec; the types of `RecordsSpec` keep it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the Decision above
    stores.set(name, recordStore(contract, name, recordSpec as RecordSpec<C, RecordName<C>>, options.client, options.transport));
  }

  const settledListeners = new Set<(name: string) => void>();

  const settled = {
    subscribe: (listener: (name: string) => void) => {
      settledListeners.add(listener);

      return () => void settledListeners.delete(listener);
    },
  };

  const collections = Object.fromEntries([...stores].map(([name, s]) => [name, s.collection]));

  const commands = Object.fromEntries(
    Object.entries(spec.commands ?? {}).map(([name, raw]) => {
      const cs: Row = isRow(raw) ? raw : {};
      const answers = typeof cs.answers === 'string' ? stores.get(cs.answers) : undefined;
      const removes = typeof cs.removes === 'string' ? stores.get(cs.removes) : undefined;
      const optimistic = typeof cs.optimistic === 'function' ? cs.optimistic : undefined;
      const output = contract.commands[name]?.output;
      const answered = new Map<string, unknown>();

      const perform = async ({ input, requestId }: { input: unknown; requestId: string }) => {
        const answer = await options.client.call(`${contract.name}.${name}`, isRow(input) ? { ...input, requestId } : { requestId });
        const checked = output ? await parse(output, answer, `${contract.name}.${name} answer`) : answer;
        await answers?.apply(checked);
        removes?.drop(checked);
        answered.set(requestId, checked);
      };

      const action = createOptimisticAction<{ input: unknown; requestId: string }>({
        onMutate: ({ input }) => {
          optimistic?.(input, collections);
        },
        mutationFn: perform,
      });

      const run = (input: unknown, retry?: { requestId: string }) => {
        const requestId = retry?.requestId ?? crypto.randomUUID();
        const tx = action({ input, requestId });
        // Decision: a transaction with no change to show is never persisted, so the command is sent here and the call still happens.
        const sent = tx.mutations.length === 0 ? perform({ input, requestId }) : tx.when('settled');

        const done = sent.then(
          () => {
            const value = answered.get(requestId);
            answered.delete(requestId);

            for (const l of settledListeners) {l(name);}

            return value;
          },
          (error: unknown) => {
            const e = failureOf(error);
            throw Object.assign(e, { requestId, code: codeOf(e) });
          },
        );

        const result = done.then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );

        return { requestId, settled: done, result };
      };

      return [name, run];
    }),
  );

  const views = Object.fromEntries(
    Object.entries(spec.views ?? {}).map(([name, viewSpec]) => [name, viewStore(contract, name, viewSpec ?? {}, options.client, options.transport, settled)]),
  );

  // oxlint-disable-next-line quality/no-known-value-widening -- the maps are loose by construction; `createRuntime` gives them their types
  return { collections, commands, views };
}

/**
 * Builds what a window uses for one contract: a collection per record, a function per command, and a handle per view.
 * Most code gets this from the provider in `@builtbyfriends/realtime-live/records/react` and doesn't call it.
 */
export function createRuntime<C extends ContractSpec, const S extends RecordsSpec<C>>(definition: RecordsDefinition<C, S>, options: RecordsOptions): Runtime<C, S> {
  const built = buildRuntime(definition, options);

  // Decision: `buildRuntime` makes each map from the spec's own keys, and `Runtime` gives each key its type from the contract.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the Decision above
  return built as Runtime<C, S>;
}
