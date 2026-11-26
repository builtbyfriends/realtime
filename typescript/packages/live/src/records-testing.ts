import type { ContractEvent, ModuleEvents, Registry } from '@builtbyfriends/realtime';
import type { EventTransport, RecordsClient } from './records.js';

export type FakeBackendOptions = {
  /** The registry of the real module, so a command runs through its own checks, handlers and request id store. */
  registry: Registry;
  /** The modules whose events the window hears. */
  modules: ReadonlyArray<{ readonly events: Pick<ModuleEvents, 'subscribe'> }>;
  env?: unknown;
  /** What the module's auth wants, such as an `authorization` header. */
  headers?: HeadersInit;
};

/**
 * A client and an event transport that run a real module in the same process, for a feature's tests and a dev page: no
 * network and no backend. Commands fail the way they do on the wire, with a `code` and a `status`.
 */
export function fakeBackend(options: FakeBackendOptions) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const refusals = new Map<string, Set<(error: Error) => void>>();
  const reconnects = new Set<() => void>();

  function deliver(event: ContractEvent) {
    for (const listener of listeners.get(event.topic) ?? []) {listener(event);}
  }

  for (const module of options.modules) {module.events.subscribe(deliver);}

  const client: RecordsClient = {
    async call(name, input) {
      const request = new Request(`https://fake.test/rpc/${name}`, { method: 'POST', headers: options.headers });
      const result = await options.registry.call(name, input, { request, env: options.env, surface: 'direct' });

      if (result.ok) {return result.value;}

      throw Object.assign(new Error(result.message), { code: result.code, status: result.status, issues: result.issues });
    },
  };

  const transport: EventTransport = {
    subscribe(topic, onEvent, onRefused) {
      const set = listeners.get(topic) ?? new Set();
      listeners.set(topic, set);
      set.add(onEvent);

      if (onRefused) {
        const told = refusals.get(topic) ?? new Set();
        refusals.set(topic, told);
        told.add(onRefused);
      }

      return () => {
        set.delete(onEvent);

        if (onRefused) {refusals.get(topic)?.delete(onRefused);}
      };
    },
    onReconnect(callback) {
      reconnects.add(callback);

      return () => void reconnects.delete(callback);
    },
  };

  return {
    client,
    transport,
    /** Delivers an event by hand, such as a repeat or a late one. */
    deliver,
    /** The server ended the subscription to a topic and wouldn't take it again: its watchers are told, and no more events reach them. */
    refuse: (topic: string, error: Error = new Error('FORBIDDEN')) => {
      const told = [...(refusals.get(topic) ?? [])];
      listeners.get(topic)?.clear();
      refusals.delete(topic);

      for (const callback of told) {callback(error);}
    },
    /** The connection came back: every watcher loads again. */
    reconnect: () => {
      for (const callback of reconnects) {callback();}
    },
    /** How many listeners are left, on one topic or on all of them and on reconnects. A screen that unmounted leaves none. */
    listenerCount: (topic?: string) =>
      topic === undefined ? [...listeners.values()].reduce((n, s) => n + s.size, 0) + reconnects.size : (listeners.get(topic)?.size ?? 0),
  };
}
