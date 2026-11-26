import { createCollection } from '@tanstack/db';
import type { Collection, LoadSubsetOptions } from '@tanstack/db';
import { stableKey } from './index.js';
import type { AnySchema, Contract, ContractSpec } from '@builtbyfriends/realtime';
import type { RecordName, RecordSpec, Refusal } from './records.js';
import { isEvent, isRow, newer, parse, readAnswer, resolveSubsets, refusalsOf, topicsFor, watcher } from './records-shared.js';
import type { EventTransport, RecordsClient, Row, SubsetRequest, Watch } from './records-shared.js';

export function recordStore<C extends ContractSpec>(contract: Contract<C>, name: string, spec: RecordSpec<C, RecordName<C>>, client: RecordsClient, transport: EventTransport | undefined, onRefused?: (refusal: Refusal) => void) {
  const found = contract.data[name];

  if (!found) {throw new Error(`${contract.name} has no record "${name}"`);}

  const schema: AnySchema = found;
  const reads = Object.entries(spec.reads).flatMap(([command, map]) => (isRow(map) ? [{ command, map: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)])) }] : []));
  const seen = new Map<string, { version: unknown; signature: string }>();
  const tombstones = new Set<string>();
  const knownBy = new Map<string, Set<string>>();
  const label = `${contract.name}.${name}`;
  const synced = new Set<string>();
  const refusals = refusalsOf(label, onRefused);
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

  const heldElsewhere = (id: string, key: string) => [...subsets.keys()].some((other) => other !== id && knownBy.get(other)?.has(key));

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
        seen.clear();
        tombstones.clear();
        knownBy.clear();
        synced.clear();
        params.markReady();
        const has = (key: string) => synced.has(key);

        const upsert = (rows: ReadonlyArray<Row>) => {
          const changes: Array<{ type: 'insert' | 'update'; key: string; value: Row }> = [];

          for (const row of rows) {
            const key = keyOf(row);
            const before = seen.get(key);
            const signature = stableKey(row);
            const order = before === undefined ? 1 : newer(row[spec.version], before.version);

            // Decision: an equal version is taken when the row differs, because a lost change is worse than a repeated one. A removed
            // record needs a strictly newer version, so an older update can't bring it back. A contract with a counting version has no ties.
            const take = order > 0 || (order === 0 && before?.signature !== signature && !tombstones.has(key));

            if (!take) {continue;}

            tombstones.delete(key);
            seen.set(key, { version: row[spec.version], signature });
            changes.push({ type: has(key) ? 'update' : 'insert', key, value: row });
          }

          mutate(changes);
        };

        const remove = (keys: ReadonlyArray<string>) => {
          for (const key of keys) {tombstones.add(key);}

          mutate(keys.flatMap((key) => (has(key) ? [{ type: 'delete' as const, key, value: {} }] : [])));
        };

        upsertRows = upsert;
        removeKeys = remove;

        const loadOne = async ({ command, input, id }: SubsetRequest) => {
        const have = subsets.get(id);

        if (have) {
          have.count += 1;

          return;
        }

        const known = knownBy.get(id) ?? new Set<string>();
        knownBy.set(id, known);
        const keyField = Object.entries(reads.find((r) => r.command === command)?.map ?? {}).find(([, recordField]) => recordField === spec.key)?.[0];

        const run = async () => {
          const { answer, missing } = await readAnswer(client, contract, command, input);
          const rows = await toRows(answer);
          upsert(rows);
          const now = new Set(rows.map(keyOf));
          const named = missing && keyField !== undefined ? [String(input[keyField])] : [];
          const gone = [...named, ...known];
          remove(gone.filter((k) => !now.has(k) && !heldElsewhere(id, k)));
          known.clear();

          for (const k of now) {known.add(k);}
        };

        const watches: Array<Watch> = [
          ...topicsFor(contract, spec.upserts, input).map(({ event, topic }) => ({
            topic,
            refused: refusals.watching(topic),
            handle: (raw: unknown) => {
              if (isEvent(raw, event)) {void onEvent(event, raw).then(upsert).catch(reportError);}
            },
          })),
          ...topicsFor(contract, spec.removes ?? [], input).map(({ event, topic }) => ({
            topic,
            refused: refusals.watching(topic),
            handle: (raw: unknown) => {
              if (isEvent(raw, event)) {void onEvent(event, raw).then((rows) => remove(rows.map(keyOf))).catch(reportError);}
            },
          })),
        ];

        subsets.set(id, { count: 1, stop: watch(watches, () => void run().catch(reportError)) });
        await run();
        };

        return {
          cleanup: () => {
            for (const s of subsets.values()) {s.stop();}

            subsets.clear();
          },
          loadSubset: async (opts: LoadSubsetOptions) => {
            await Promise.all(resolveSubsets(label, reads, opts).map((request) => loadOne(request)));
          },
          unloadSubset: (opts: LoadSubsetOptions) => {
            for (const { id } of resolveSubsets(label, reads, opts)) {
              const have = subsets.get(id);

              if (!have) {continue;}

              have.count -= 1;

              if (have.count > 0) {continue;}

              have.stop();
              subsets.delete(id);
            }
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
