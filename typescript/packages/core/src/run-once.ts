import { isRecord } from './json-schema.js';

/** A command's result as the run-once store keeps it. */
export type Settled = { value: unknown };

/**
 * Where a write's `requestId` lives with its first result. `run` calls `start` once per key while the key is kept. A call with the same
 * key, at the same time or later, gets the first call's result. A run that throws keeps nothing, so a retry runs again.
 */
export interface RunOnceStore {
  run(key: string, keepMs: number, start: () => Promise<Settled>): Promise<Settled>;
}

/**
 * Keeps request ids in this isolate's memory. It fits a module whose owner holds its state in the same isolate, such as one Durable
 * Object, and tests. The ids go when the isolate restarts, as in-memory state does.
 */
export function memoryRunOnce(now: () => number = Date.now): RunOnceStore {
  const kept = new Map<string, { until: number; result: Promise<Settled> }>();

  return {
    run(key, keepMs, start) {
      const at = now();

      for (const [k, v] of kept) {
        if (v.until <= at) {kept.delete(k);}
      }

      const found = kept.get(key);

      if (found) {return found.result;}

      const result = start();

      kept.set(key, { until: at + keepMs, result });
      result.catch(() => kept.delete(key));

      return result;
    },
  };
}

/** The slice of a Durable Object's SQLite storage `storageRunOnce` uses. `ctx.storage` has it as is. */
export interface RunOnceStorage {
  sql: { exec(query: string, ...bindings: Array<string | number>): { toArray(): Array<Record<string, string | number | ArrayBuffer | null>> } };
}

const TABLE = '_realtime_run_once';

function settledFrom(text: string): Settled {
  const stored: unknown = JSON.parse(text);

  return { value: isRecord(stored) ? stored.value : undefined };
}

/**
 * Keeps request ids in a Durable Object's own SQLite storage, next to the state they guard, so a retry after a restart still gets the
 * first result. Each id is kept with its result as JSON for `keepMs`, then deleted on a later call. Calls that come while the first one
 * runs share it in memory, since one object runs them.
 *
 * The id is written right after the handler returns. When the handler doesn't wait on anything outside the object in between, it lands
 * in the same batch of writes as the handler's own SQLite changes. A handler that waits on an outside call can leave its state written
 * with no id kept if the object stops at that moment, and a retry then runs it again.
 */
export function storageRunOnce(storage: RunOnceStorage, now: () => number = Date.now): RunOnceStore {
  const running = new Map<string, Promise<Settled>>();
  let ready = false;

  const sql = (query: string, ...bindings: Array<string | number>) => storage.sql.exec(query, ...bindings).toArray();

  return {
    run(key, keepMs, start) {
      if (!ready) {
        sql(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, until INTEGER NOT NULL, result TEXT NOT NULL)`);
        sql(`CREATE INDEX IF NOT EXISTS ${TABLE}_until ON ${TABLE} (until)`);
        ready = true;
      }

      const at = now();

      sql(`DELETE FROM ${TABLE} WHERE until <= ?`, at);

      const [row] = sql(`SELECT result FROM ${TABLE} WHERE key = ?`, key);

      if (row) {return Promise.resolve(settledFrom(String(row.result)));}

      const found = running.get(key);

      if (found) {return found;}

      const result = start()
        .then((settled) => {
          sql(`INSERT OR REPLACE INTO ${TABLE} (key, until, result) VALUES (?, ?, ?)`, key, at + keepMs, JSON.stringify(settled));

          return settled;
        })
        .finally(() => running.delete(key));

      running.set(key, result);

      return result;
    },
  };
}
