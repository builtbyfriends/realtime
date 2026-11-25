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
