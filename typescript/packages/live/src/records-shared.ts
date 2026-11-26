import { parseLoadSubsetOptions } from '@tanstack/db';
import type { LoadSubsetOptions } from '@tanstack/db';
import { fillTopic, topicsOf, validate } from '@builtbyfriends/realtime';
import type { AnySchema, Contract, ContractSpec } from '@builtbyfriends/realtime';
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

export type Row = Record<string, unknown>;

export function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEvent(raw: unknown, name: string): boolean {
  return !isRow(raw) || !('name' in raw) || raw.name === name;
}

export const topicFields = (topic: string): Array<string> => [...topic.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? '');

export function newer(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {return a - b;}

  const x = String(a);
  const y = String(b);

  if (x === y) {return 0;}

  return x > y ? 1 : -1;
}

export async function parse(schema: AnySchema, value: unknown, where: string): Promise<unknown> {
  const r = await validate(schema, value);

  if (!r.ok) {throw new Error(`${where} doesn't match the contract: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);}

  return r.value;
}

export function failureOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function codeOf(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL';
}

export function topicsFor(contract: ContractSpec, events: ReadonlyArray<string>, input: Row): Array<{ event: string; topic: string }> {
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

export type Watch = { topic: string; handle: (event: unknown) => void };

type StopEntry = { ready: Promise<void>; stop: (() => void) | undefined };

type Hub = {
  listeners: Map<string, Set<(event: unknown) => void>>;
  stops: Map<string, StopEntry>;
  reconnects: Set<() => void>;
  stopReconnect: (() => void) | undefined;
};

const hubs = new WeakMap<EventTransport, Hub>();

function hubOf(transport: EventTransport): Hub {
  const kept = hubs.get(transport);

  if (kept) {return kept;}

  const hub: Hub = { listeners: new Map(), stops: new Map(), reconnects: new Set(), stopReconnect: undefined };
  hubs.set(transport, hub);

  return hub;
}

/**
 * Listens to topics for as long as someone needs them. All watchers of one transport share one subscription for each
 * topic and one reconnect listener, so a browser that opens a stream for each subscription opens one for each topic.
 */
export function watcher(transport: EventTransport | undefined) {
  return function watch(watches: ReadonlyArray<Watch>, onReconnect: () => void): () => void {
    if (!transport) {return () => {};}

    const hub = hubOf(transport);
    const mine: Array<{ topic: string; handle: (event: unknown) => void }> = [];

    for (const w of watches) {
      const set = hub.listeners.get(w.topic) ?? new Set();
      hub.listeners.set(w.topic, set);
      set.add(w.handle);
      mine.push(w);

      if (!hub.stops.has(w.topic)) {
        const entry: StopEntry = { ready: Promise.resolve(), stop: undefined };
        entry.ready = Promise.resolve(
          transport.subscribe(w.topic, (event) => {
            for (const listener of hub.listeners.get(w.topic) ?? []) {listener(event);}
          }),
        ).then(
          (stop) => {
            entry.stop = stop;
          },
          (error: unknown) => {
            console.error(`live: subscribing to "${w.topic}" failed`, error);
            hub.stops.delete(w.topic);
          },
        );
        hub.stops.set(w.topic, entry);
      }
    }

    hub.reconnects.add(onReconnect);
    hub.stopReconnect ??= transport.onReconnect(() => {
      for (const callback of hub.reconnects) {callback();}
    });

    return () => {
      for (const w of mine) {
        const set = hub.listeners.get(w.topic);
        set?.delete(w.handle);

        if (set?.size === 0) {
          hub.listeners.delete(w.topic);
          const entry = hub.stops.get(w.topic);
          hub.stops.delete(w.topic);

          if (entry?.stop) {
            entry.stop();
          } else {
            void entry?.ready.then(() => entry.stop?.());
          }
        }
      }

      hub.reconnects.delete(onReconnect);

      if (hub.reconnects.size === 0) {
        hub.stopReconnect?.();
        hub.stopReconnect = undefined;
      }
    };
  };
}

export type SubsetRequest = { command: string; input: Row; id: string };

/** The reads a query asks for: the first read whose input fields the query filters on, once for each key an `in` filter lists. */
export function resolveSubsets(label: string, reads: ReadonlyArray<{ command: string; map: Record<string, string> }>, opts: LoadSubsetOptions): Array<SubsetRequest> {
  const filters = new Map<string, Array<unknown>>();

  for (const f of parseLoadSubsetOptions(opts).filters) {
    if (f.operator === 'eq') {filters.set(f.field.join('.'), [f.value]);}

    if (f.operator === 'in' && Array.isArray(f.value)) {filters.set(f.field.join('.'), f.value);}
  }

  const read = reads.find(({ map }) => Object.keys(map).length > 0 && Object.values(map).every((field) => filters.has(field)));

  if (!read) {throw new Error(`${label}: no read matches a query on ${[...filters.keys()].join(', ') || 'nothing'}; list one in reads`);}

  const inputs = Object.entries(read.map).reduce<Array<Row>>(
    (all, [inputField, recordField]) => all.flatMap((input) => (filters.get(recordField) ?? []).map((value) => ({ ...input, [inputField]: value }))),
    [{}],
  );

  return inputs.map((input) => ({ command: read.command, input, id: `${read.command}:${stableKey(input)}` }));
}

/** What a read answers, checked against the contract. A `NOT_FOUND` is an answer too: the record isn't there, so `missing` is true. */
export async function readAnswer(client: RecordsClient, contract: Contract<ContractSpec>, command: string, input: Row): Promise<{ answer: unknown; missing: boolean }> {
  const output = contract.commands[command]?.output;

  try {
    const answer = await client.call(`${contract.name}.${command}`, input);

    return { answer: output ? await parse(output, answer, `${contract.name}.${command} answer`) : answer, missing: false };
  } catch (error) {
    if (!(error instanceof Error) || codeOf(error) !== 'NOT_FOUND') {throw error;}

    return { answer: [], missing: true };
  }
}
