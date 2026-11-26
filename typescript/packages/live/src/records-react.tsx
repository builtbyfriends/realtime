import { createContext, createElement, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { CommandName, CommandOutput, ContractSpec, GoodInput } from '@builtbyfriends/realtime';
import { createRuntime } from './records.js';
import { warnRefused } from './records-shared.js';
import type { ReadCommands, RecordsDefinition, RecordsOptions, RecordsSpec, Runtime, ViewState } from './records.js';

export { eq, useLiveQuery } from '@tanstack/react-db';

type Registry = { get<C extends ContractSpec, S extends RecordsSpec<C>>(definition: RecordsDefinition<C, S>): Runtime<C, S> };

function registryFor(options: RecordsOptions): Registry {
  const runtimes = new Map<object, unknown>();

  function get<C extends ContractSpec, S extends RecordsSpec<C>>(definition: RecordsDefinition<C, S>): Runtime<C, S> {
    const kept = runtimes.get(definition);

    if (kept !== undefined) {
      // Decision: a runtime is only stored under the definition that made it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the Decision above
      return kept as Runtime<C, S>;
    }

    const made = createRuntime(definition, options);
    runtimes.set(definition, made);

    return made;
  }

  return { get };
}

const RecordsContext = createContext<Registry | undefined>(undefined);

/**
 * The shell fills this once, with the client and the event transport. A feature below it asks for its records with
 * `useRecords` and builds no context and no subscription of its own.
 */
export function RecordsProvider(props: RecordsOptions & { children?: ReactNode }) {
  const { client, transport, onRefused, children } = props;
  const [latest] = useState<{ onRefused: RecordsOptions['onRefused'] }>({ onRefused });

  useEffect(() => {
    // Decision: the runtime outlives a render, so it reads the latest handler from this holder instead of being made again when the handler changes.
    // oxlint-disable-next-line react/immutability -- see the Decision above
    latest.onRefused = onRefused;
  }, [latest, onRefused]);

  const registry = useMemo(
    () => registryFor({ client, transport, onRefused: (refusal) => (latest.onRefused ? latest.onRefused(refusal) : warnRefused(refusal.name, refusal.topic, refusal.error)) }),
    [client, transport, latest],
  );

  return createElement(RecordsContext.Provider, { value: registry }, children);
}

/** The collections, commands and views a definition gives, typed by its contract. */
export function useRecords<C extends ContractSpec, S extends RecordsSpec<C>>(definition: RecordsDefinition<C, S>): Runtime<C, S> {
  const registry = useContext(RecordsContext);

  if (!registry) {throw new Error('useRecords needs a RecordsProvider above it');}

  return registry.get(definition);
}

/** A read that depends on who's asking, kept fresh by the events and commands its definition names. */
export function useView<C extends ContractSpec, S extends RecordsSpec<C>, K extends keyof S['views'] & ReadCommands<C> & CommandName<C>>(
  definition: RecordsDefinition<C, S>,
  name: K,
  input: GoodInput<C, K>,
): ViewState<CommandOutput<C, K>> {
  const runtime = useRecords(definition);
  const handle = runtime.views[name](input);

  return useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
}
