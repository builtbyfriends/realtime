import type { ContractEvent } from './contract-module.js';
import { isRecord } from './json-schema.js';
import type { RunOnceStorage } from './run-once.js';

/** An event the outbox holds until it's delivered. */
export type KeptEvent = { id: string; event: ContractEvent };

/**
 * Where a module keeps its events until `publish` takes them. `keep` runs right after the handler returns, `pending` lists what's left
 * oldest first, `delivered` lets one go, and `retryLater` asks for another try, such as with an alarm. Delivery is at least once.
 */
export interface EventOutbox {
  keep(events: ReadonlyArray<ContractEvent>): Array<KeptEvent>;
  pending(): Array<KeptEvent>;
  delivered(id: string): void;
  retryLater(): void | Promise<void>;
}

/** Keeps events in this isolate's memory. It fits tests and examples: the events go when the isolate restarts. */
export function memoryOutbox(): EventOutbox {
  const kept = new Map<string, ContractEvent>();
  let seq = 0;

  return {
    keep(events) {
      return events.map((event) => {
        seq += 1;
        const id = String(seq);

        kept.set(id, event);

        return { id, event };
      });
    },
    pending: () => [...kept].map(([id, event]) => ({ id, event })),
    delivered: (id) => void kept.delete(id),
    retryLater: () => undefined,
  };
}

/** The slice of a Durable Object's storage `storageOutbox` uses: its SQLite, and its alarm. `ctx.storage` has it as is. */
export interface OutboxStorage extends RunOnceStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export type StorageOutboxOptions = { retryAfterMs?: number; now?: () => number };

const TABLE = '_realtime_outbox';

function eventFrom(text: string): ContractEvent {
  const stored: unknown = JSON.parse(text);
  const e = isRecord(stored) ? stored : {};

  return { module: String(e.module), name: String(e.name), event: String(e.event), topic: String(e.topic), payload: e.payload };
}

/**
 * Keeps events in a Durable Object's own SQLite storage until they're delivered, so an event outlives a failed delivery or a restart.
 * When a delivery fails, it sets the object's alarm `retryAfterMs` ahead, unless an earlier alarm is already set. The object's
 * `alarm()` then calls `module.events.deliver(env)`, which tries what's left, oldest first.
 *
 * The events are written right after the handler returns. When the handler doesn't wait on anything outside the object in between,
 * they land in the same batch of writes as the handler's own SQLite changes, as the request id does with `storageRunOnce`.
 */
export function storageOutbox(storage: OutboxStorage, options: StorageOutboxOptions = {}): EventOutbox {
  const retryAfterMs = options.retryAfterMs ?? 30_000;
  const now = options.now ?? Date.now;
  let ready = false;

  const sql = (query: string, ...bindings: Array<string | number>) => {
    if (!ready) {
      ready = true;
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)`).toArray();
    }

    return storage.sql.exec(query, ...bindings).toArray();
  };

  return {
    keep(events) {
      return events.map((event) => {
        const [row] = sql(`INSERT INTO ${TABLE} (event) VALUES (?) RETURNING id`, JSON.stringify(event));

        return { id: String(row?.id), event };
      });
    },
    pending: () => sql(`SELECT id, event FROM ${TABLE} ORDER BY id`).map((row) => ({ id: String(row.id), event: eventFrom(String(row.event)) })),
    delivered: (id) => void sql(`DELETE FROM ${TABLE} WHERE id = ?`, Number(id)),
    async retryLater() {
      const at = now() + retryAfterMs;
      const set = await storage.getAlarm();

      if (set === null || set > at) {await storage.setAlarm(at);}
    },
  };
}
