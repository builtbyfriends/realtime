import { DatabaseSync } from 'node:sqlite';
import type { DataStorage } from '../src/index.js';

export function memoryStorage() {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  let alarm: number | null = null;
  const toBinding = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  const storage: DataStorage & { alarm: () => number | null; db: DatabaseSync } = {
    db,
    sql: {
      exec(query, ...bindings) {
        // Decision: a Durable Object's SQLite takes at most 100 bound parameters, so the stand-in refuses more too.
        if (bindings.length > 100) throw new Error('too many SQL variables');
        const stmt = db.prepare(query);
        const rows = (stmt.all(...(bindings.map(toBinding) as any)) as any[]).map((row) => {
          for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) row[k] = row[k].buffer.slice(row[k].byteOffset, row[k].byteOffset + row[k].byteLength);
          return row;
        });
        return Object.assign(rows[Symbol.iterator](), { toArray: () => rows }) as any;
      },
    },
    transactionSync(fn) {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
    setAlarm: (t) => void (alarm = t),
    deleteAlarm: () => void (alarm = null),
    alarm: () => alarm,
  };
  return storage;
}
