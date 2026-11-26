import type { Collection } from '@tanstack/db';
import type {
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
import { buildCommands, settledBus } from './commands.js';
import { recordStore } from './record-store.js';
import type { EventTransport, RecordsClient, Row } from './records-shared.js';
import { viewStore } from './view-store.js';

export type { EventTransport, RecordsClient } from './records-shared.js';

export type RecordName<C extends ContractSpec> = keyof C['data'] & string;

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

function buildRuntime<C extends ContractSpec, const S extends RecordsSpec<C>>(definition: RecordsDefinition<C, S>, options: RecordsOptions) {
  const { contract, spec } = definition;
  const stores = new Map<string, ReturnType<typeof recordStore>>();

  for (const [name, recordSpec] of Object.entries(spec.records)) {
    // Decision: Object.entries loses the link between a record's name and its spec; the types of `RecordsSpec` keep it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the Decision above
    stores.set(name, recordStore(contract, name, recordSpec as RecordSpec<C, RecordName<C>>, options.client, options.transport));
  }

  const settled = settledBus();
  const collections = Object.fromEntries([...stores].map(([name, s]) => [name, s.collection]));
  const commands = buildCommands(contract, spec.commands ?? {}, options, stores, collections, settled);

  const views = Object.fromEntries(
    Object.entries(spec.views ?? {}).map(([name, viewSpec]) => [name, viewStore(contract, name, viewSpec ?? {}, options.client, options.transport, settled)]),
  );

  return { collections, commands, views };
}

/**
 * Builds what a window uses for one contract: a collection per record, a function per command, and a handle per view.
 * Most code gets this from the provider in `@builtbyfriends/realtime-live/records/react` and doesn't call it.
 */
export function createRuntime<C extends ContractSpec, const S extends RecordsSpec<C>>(definition: RecordsDefinition<C, S>, options: RecordsOptions): Runtime<C, S> {
  const built = buildRuntime(definition, options);

  // Decision: `buildRuntime` makes each map from the spec's own keys, and `Runtime` gives each key its type from the contract.
  return built as unknown as Runtime<C, S>; // oxlint-disable-line quality/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- see the Decision above
}
