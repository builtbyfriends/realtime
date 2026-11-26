import { createCollection, createOptimisticAction, parseLoadSubsetOptions } from '@tanstack/db';
import type { Collection, LoadSubsetOptions } from '@tanstack/db';
import { fillTopic, topicsOf, validate } from '@builtbyfriends/realtime';
import type {
  AnySchema,
  CommandError,
  CommandInput,
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

export type RecordsClient = { call(name: string, input: unknown): Promise<unknown> };

export type EventTransport = {
  subscribe(topic: string, onEvent: (event: unknown) => void): Promise<() => void> | (() => void);
  onReconnect(callback: () => void): () => void;
};

type Row = Record<string, unknown>;

const topicFields = (topic: string): Array<string> => [...topic.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? '');

type ReadCommands<C extends ContractSpec> = {
  [K in CommandName<C>]: C['commands'][K] extends { effect: 'read' } ? K : never;
}[CommandName<C>];

type CarryingEvents<C extends ContractSpec, R extends keyof C['data'] & string> = {
  [E in EventName<C>]: EventPayload<C, E> extends RecordOf<C, R> ? E : never;
}[EventName<C>];

type RecordOutputs<C extends ContractSpec, R extends keyof C['data'] & string> = {
  [K in CommandName<C>]: CommandOutput<C, K> extends RecordOf<C, R> ? K : never;
}[CommandName<C>];

type ReadMap<C extends ContractSpec, K extends CommandName<C>, R extends keyof C['data'] & string> = {
  [F in keyof GoodInput<C, K> & string]: keyof RecordOf<C, R> & string;
};

export type RecordSpec<C extends ContractSpec, R extends keyof C['data'] & string> = {
  /** The field that identifies a record. */
  key: keyof RecordOf<C, R> & string;
  /** A field whose bigger value means a newer record. */
  version: keyof RecordOf<C, R> & string;
  /** The read commands that load this record, each with how its input fields match the record's fields. */
  reads: { [K in ReadCommands<C>]?: ReadMap<C, K, R> };
  /** Events whose payload holds the record as it is after the change. */
  upserts: ReadonlyArray<CarryingEvents<C, R>>;
  /** Commands whose answer is the record after the change. */
  answers?: ReadonlyArray<RecordOutputs<C, R>>;
};

export type CommandFailure<C extends ContractSpec, K extends CommandName<C>> = Error & {
  requestId: string;
  code: CommandError<C, K> | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'INTERNAL';
};

const isCoded = (e: Error): boolean => 'code' in e && typeof e.code === 'string';

export type CommandOptions<C extends ContractSpec, K extends CommandName<C>> = {
  /** Shows the change at once. It runs in the same tick, and the change is undone when the command fails. */
  optimistic?: (input: GoodInput<C, K>) => void;
};

export type CommandResult<C extends ContractSpec, K extends CommandName<C>> =
  | { ok: true; value: CommandOutput<C, K> }
  | { ok: false; error: CommandFailure<C, K> };

export type Intent<C extends ContractSpec, K extends CommandName<C>> = {
  requestId: string;
  /** Settles when the module has answered and the answer is in the collection. Rejects with a `CommandFailure`. */
  settled: Promise<CommandOutput<C, K>>;
  /** The same, as a value: a failure carries the code the contract lists for this command, so a switch on it is checked. */
  result: Promise<CommandResult<C, K>>;
};

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parse(schema: AnySchema, value: unknown, where: string): Promise<unknown> {
  const r = await validate(schema, value);
  if (!r.ok) {throw new Error(`${where} doesn't match the contract: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);}
  return r.value;
}

function failureOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createRecords<C extends ContractSpec>(options: { contract: Contract<C>; client: RecordsClient; transport?: EventTransport }) {
  const { contract, client, transport } = options;

  function recordCollection<R extends keyof C['data'] & string>(record: R, spec: RecordSpec<C, R>) {
    type Rec = RecordOf<C, R> & Row;
    const found = contract.data[record];
    if (!found) {throw new Error(`${contract.name} has no record "${record}"`);}
    const schema: AnySchema = found;
    const readList: Array<[string, Record<string, string>]> = Object.entries(spec.reads).map(([name, map]) => [name, isRow(map) ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)])) : {}]);
    const applied = new Map<string, string>();
    const active = new Map<string, { run: () => Promise<void>; stop: () => void }>();
    let ops: { begin: () => void; write: (m: never) => void; commit: () => unknown } | undefined;
    let ready = false;

    const keyOf = (row: Row) => String(row[spec.key]);
    const versionOf = (row: Row) => String(row[spec.version]);

    function apply(rows: ReadonlyArray<Row>, collection: Collection<Rec, string>) {
      if (!ops) {return;}
      const fresh = rows.filter((row) => {
        const have = applied.get(keyOf(row));
        return have === undefined || versionOf(row) > have || (versionOf(row) === have && stableKey(row) !== stableKey(collection.get(keyOf(row))));
      });
      if (!fresh.length) {return;}
      ops.begin();
      for (const row of fresh) {
        applied.set(keyOf(row), versionOf(row));
        const type = collection.has(keyOf(row)) ? 'update' : 'insert';
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows were parsed with the contract's record schema
        ops.write({ type, key: keyOf(row), value: row } as never);
      }
      ops.commit();
    }

    async function toRows(raw: unknown): Promise<Array<Row>> {
      const items = Array.isArray(raw) ? raw : [raw];
      const out: Array<Row> = [];
      for (const item of items) {
        const parsed = await parse(schema, item, `${contract.name}.${record}`);
        if (isRow(parsed)) {out.push(parsed);}
      }
      return out;
    }

    async function onEvent(name: string, raw: unknown, collection: Collection<Rec, string>) {
      const payload = isRow(raw) && 'payload' in raw ? raw.payload : raw;
      const evSchema = contract.events[name]?.payload;
      if (!evSchema) {return;}
      const checked = await parse(evSchema, payload, `${contract.name}.${name} event`);
      apply(await toRows(checked), collection);
    }

    const collection: Collection<Rec, string> = createCollection<Rec, string>({
      id: `${contract.name}.${record}`,
      getKey: (row) => keyOf(row),
      syncMode: 'on-demand',
      sync: {
        rowUpdateMode: 'full',
        sync: (params) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the collection hands back the same begin, write and commit that it was made with
          ops = params as never;
          ready = true;
          params.markReady();
          const stopReconnect = transport?.onReconnect(() => {
            for (const a of active.values()) {void a.run();}
          });
          return {
            cleanup: () => {
              stopReconnect?.();
              for (const a of active.values()) {a.stop();}
              active.clear();
            },
            loadSubset: async (opts: LoadSubsetOptions) => {
              const filters = new Map<string, unknown>();
              for (const f of parseLoadSubsetOptions(opts).filters) {
                if (f.operator === 'eq') {filters.set(f.field.join('.'), f.value);}
              }
              const read = readList.find(([, map]) => Object.keys(map).length > 0 && Object.values(map).every((rf) => filters.has(rf)));
              if (!read) {throw new Error(`${contract.name}.${record}: no read matches a query on ${[...filters.keys()].join(', ') || 'nothing'}`);}
              const [command, map] = read;
              const input = Object.fromEntries(Object.entries(map).map(([inputField, recordField]) => [inputField, filters.get(recordField)]));
              const id = `${command}:${stableKey(input)}`;
              if (active.has(id)) {return;}
              const run = async () => {
                const answer = await client.call(`${contract.name}.${command}`, input);
                const cmd = contract.commands[command];
                const checked = cmd ? await parse(cmd.output, answer, `${contract.name}.${command} answer`) : answer;
                apply(await toRows(checked), collection);
              };
              const stops: Array<() => void> = [];
              let live = true;
              if (transport) {
                for (const name of spec.upserts) {
                  const ev = contract.events[name];
                  if (!ev) {continue;}
                  for (const topic of topicsOf(ev)) {
                    if (!topicFields(topic).every((f) => f in input)) {continue;}
                    const filled = fillTopic(topic, input);
                    Promise.resolve(transport.subscribe(filled, (event) => void onEvent(name, event, collection))).then(
                      (stop) => (live ? stops.push(stop) : stop()),
                      (error: unknown) => console.error(`live: subscribing to "${filled}" failed`, error),
                    );
                  }
                }
              }
              active.set(id, { run, stop: () => { live = false; for (const s of stops.splice(0)) {s();} } });
              await run();
            },
            unloadSubset: () => {
              // Decision: the spike keeps a subscription until the collection is cleaned up.
            },
          };
        },
      },
    });

    void ready;

    return {
      collection,
      utils: {
        /** Puts a record in, as an event would. */
        apply: (row: unknown) => toRows(row).then((rows) => apply(rows, collection)),
      },
    };
  }

  function command<K extends CommandName<C>, R extends keyof C['data'] & string>(
    name: K,
    target: { records: ReturnType<typeof recordCollection<R>>; spec: RecordSpec<C, R> },
    opts: CommandOptions<C, K> = {},
  ) {
    const action = createOptimisticAction<{ input: GoodInput<C, K>; requestId: string }>({
      onMutate: ({ input }) => opts.optimistic?.(input),
      mutationFn: async ({ input, requestId }) => {
        const sent = isRow(input) ? { ...input, requestId } : { requestId };
        const answer = await client.call(`${contract.name}.${name}`, sent);
        const cmd = contract.commands[name];
        const checked = cmd ? await parse(cmd.output, answer, `${contract.name}.${name} answer`) : answer;
        await target.records.utils.apply(checked);
        lastAnswer.set(requestId, checked);
      },
    });
    const lastAnswer = new Map<string, unknown>();

    return (input: GoodInput<C, K>, retry?: { requestId: string }): Intent<C, K> => {
      const requestId = retry?.requestId ?? crypto.randomUUID();
      const tx = action({ input, requestId });
      const settled = tx.when("settled").then(
        () => {
          const out = lastAnswer.get(requestId);
          lastAnswer.delete(requestId);
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the answer was parsed with this command's output schema
          return out as CommandOutput<C, K>;
        },
        (error: unknown) => {
          const e = failureOf(error);
          throw Object.assign(e, { requestId }, isCoded(e) ? {} : { code: 'INTERNAL' });
        },
      );
      const result = settled.then(
        (value): CommandResult<C, K> => ({ ok: true, value }),
        (error: CommandFailure<C, K>): CommandResult<C, K> => ({ ok: false, error }),
      );
      return { requestId, settled, result };
    };
  }

  return { recordCollection, command };
}

export type { CommandInput };
