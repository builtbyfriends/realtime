import type { Contract, ContractSpec } from '@builtbyfriends/realtime';
import { stableKey } from './index.js';
import type { ViewHandle, ViewSpec, ViewState } from './records.js';
import { failureOf, isEvent, parse, topicsFor, watcher } from './records-shared.js';
import type { EventTransport, RecordsClient, Row } from './records-shared.js';

export function viewStore<C extends ContractSpec>(
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
        refused: (error: Error) => {
          generation += 1;
          set({ status: 'error', data: state.data, error });
        },
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
