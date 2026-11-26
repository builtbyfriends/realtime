import { createOptimisticAction } from '@tanstack/db';
import type { Contract, ContractSpec } from '@builtbyfriends/realtime';
import type { RecordsOptions } from './records.js';
import { codeOf, failureOf, isRow, parse } from './records-shared.js';
import type { Row } from './records-shared.js';
import type { recordStore } from './record-store.js';

type Stores = ReadonlyMap<string, ReturnType<typeof recordStore>>;

export type Settled = { listeners: Set<(name: string) => void>; subscribe: (listener: (name: string) => void) => () => void };

export function settledBus(): Settled {
  const listeners = new Set<(name: string) => void>();

  return {
    listeners,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };
}

export function buildCommands(
  contract: Contract<ContractSpec>,
  commandSpecs: Row,
  options: RecordsOptions,
  stores: Stores,
  collections: Row,
  settled: Settled,
) {
  return Object.fromEntries(
    Object.entries(commandSpecs).map(([name, raw]) => {
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

            for (const l of settled.listeners) {l(name);}

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
}
