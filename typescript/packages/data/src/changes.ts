import { parseDoc, run } from './storage.js';
import type { DataStorage } from './storage.js';
import type { JsonObject, Schema, TableDef } from './schema.js';
import type { DbReader } from './db.js';

/**
 * The change index: for each synced document, the position of its latest change and the group it's in. It's an index,
 * not a history. A document written 100 times has one row, so a device that catches up gets each document once.
 *
 * One position per commit. A document that moves to another group leaves a delete marker in the old group, so devices
 * that lose access drop it.
 */
export type Change = {
  table: string;
  id: string;
  group: string;
  /** The document's visible fields, or null for a delete or a move out of this group. */
  doc: JsonObject | null;
};

export type ChangeBatch = { seq: number; changes: Array<Change> };

export type PullResult = ChangeBatch & {
  /** True when there's more after `seq`: pull again from it. */
  more: boolean;
};

/** Declares that a table syncs to devices: which group each document is in, and which fields a device may see. */
export type SyncDef<D = JsonObject> = {
  /**
   * The group a document belongs to, or null to keep it off devices. A document several readers share, such as a chat
   * between people, can be in more than one group: one per reader.
   */
  group: (doc: D) => string | ReadonlyArray<string> | null;
  /** The fields a device gets. Leave it out to send every field. `_id` and `_creationTime` are always sent. */
  fields?: ReadonlyArray<keyof D & string>;
  /**
   * The document as one reader sees it, when that depends on who they are (their own reactions) or on other records
   * (names, a reply's original). It runs once per reader for each change they get, so keep its reads few. Return null to
   * leave the change out for that reader. Leave it out to send the visible fields to everyone.
   */
  view?: (doc: D, reader: SyncReader) => JsonObject | null | undefined;
};

/** What a `view` gets: read access and who's reading. `actor` is what the door said the caller is. */
export type SyncReader = { db: DbReader<Schema>; actor: string; now: number };

export function syncChanges(storage: DataStorage): void {
  run(storage, `CREATE TABLE IF NOT EXISTS _changes (tbl TEXT NOT NULL, id TEXT NOT NULL, grp TEXT NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY (tbl, id, grp)) WITHOUT ROWID`);
  run(storage, `CREATE INDEX IF NOT EXISTS _changes_by_group ON _changes (grp, seq)`);
  run(storage, `INSERT OR IGNORE INTO _meta (key,value) VALUES ('epoch',?)`, crypto.randomUUID());
}

/** This storage's epoch: made once when the change index is, so positions from a wiped or replaced storage don't carry over. */
export function currentEpoch(storage: DataStorage): string {
  return run<{ value: string }>(storage, `SELECT value FROM _meta WHERE key='epoch'`)[0]?.value ?? '';
}

function currentSeq(storage: DataStorage): number {
  return Number(run<{ value: string }>(storage, `SELECT value FROM _meta WHERE key='seq'`)[0]?.value ?? 0);
}

export function visible(def: TableDef, doc: JsonObject): JsonObject {
  const fields = def.sync?.fields;
  if (!fields) {return doc;}
  const out: JsonObject = { _id: doc._id, _creationTime: doc._creationTime };
  for (const f of fields) {
    if (f in doc) {out[f] = doc[f];}
  }
  return out;
}

type Pending = { table: string; id: string; before: Array<string>; after: JsonObject | null };

function groupsOf(def: TableDef, doc: JsonObject | null): Array<string> {
  const sync = def.sync;
  const g: unknown = doc && sync ? sync.group(doc) : null;
  if (g === null || g === undefined) {return [];}
  if (typeof g === 'string') {return [g];}
  if (!Array.isArray(g) || !g.every((x: unknown): x is string => typeof x === 'string')) {
    throw new Error('sync.group must return a string, a list of strings or null');
  }
  return [...new Set(g)];
}

/** Collects one mutation's changes to synced tables, and writes them to the index inside its transaction. */
export class ChangeRecorder {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly schema: Schema) {}

  /** `before` and `after` are the stored document (with `_id` and `_creationTime`) or null. */
  record(table: string, id: string, before: JsonObject | null, after: JsonObject | null): void {
    const def = this.schema[table];
    if (!def?.sync) {return;}
    const key = `${table}\u0000${id}`;
    const first = this.pending.get(key);
    // Decision: keep the group from the first write in this mutation, since it knows the group the document started in.
    const startGroup = first ? first.before : groupsOf(def, before);
    this.pending.set(key, { table, id, before: startGroup, after });
  }

  get empty(): boolean {
    return this.pending.size === 0;
  }

  /** Writes the index rows and returns what changed, with the documents as devices see them. Call inside the transaction. */
  flush(storage: DataStorage): ChangeBatch | null {
    if (!this.pending.size) {return null;}
    const seq = currentSeq(storage) + 1;
    const changes: Array<Change> = [];
    const put = (table: string, id: string, group: string, doc: JsonObject | null) => {
      run(storage, `INSERT OR REPLACE INTO _changes (tbl,id,grp,seq,deleted) VALUES (?,?,?,?,?)`, table, id, group, seq, doc ? 0 : 1);
      changes.push({ table, id, group, doc });
    };
    for (const p of this.pending.values()) {
      const def = this.schema[p.table];
      if (!def) {continue;}
      const groups = groupsOf(def, p.after);
      for (const g of p.before) {
        if (!groups.includes(g)) {put(p.table, p.id, g, null);}
      }
      if (p.after && groups.length) {
        const doc = visible(def, p.after);
        for (const g of groups) {put(p.table, p.id, g, doc);}
      }
    }
    this.pending.clear();
    if (!changes.length) {return null;}
    run(storage, `INSERT OR REPLACE INTO _meta (key,value) VALUES ('seq',?)`, String(seq));
    return { seq, changes };
  }
}

const MAX_PULL = 500;

/** The page size a pull uses: what was asked, as a whole number from 1 to 500. 500 when nothing sensible was asked. */
export function pullLimit(asked?: number): number {
  return typeof asked === 'number' && Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), MAX_PULL) : MAX_PULL;
}

/**
 * Everything in `groups` that changed after position `after`, oldest first, up to `limit` documents. A device keeps the
 * returned `seq` and pulls from it after a reconnect. `after: 0` loads the groups from scratch, deletes left out.
 */
export function pull(storage: DataStorage, schema: Schema, groups: ReadonlyArray<string>, after: number, asked?: number): PullResult {
  const now = currentSeq(storage);
  if (!groups.length) {return { seq: now, changes: [], more: false };}
  const limit = pullLimit(asked);
  // Decision: the groups go in as one JSON parameter, because a Durable Object's SQLite takes at most 100 bound parameters.
  const mine = JSON.stringify(groups);
  const rows = run<{ tbl: string; id: string; grp: string; seq: number; deleted: number }>(
    storage,
    `SELECT tbl,id,grp,seq,deleted FROM _changes WHERE grp IN (SELECT value FROM json_each(?)) AND seq > ? ${after === 0 ? 'AND deleted = 0' : ''} ORDER BY seq, deleted DESC LIMIT ?`,
    mine,
    after,
    limit + 1,
  );
  let more = rows.length > limit;
  let page = more ? rows.slice(0, limit) : rows;
  // Decision: a page ends on a whole commit, so a device never stops halfway through one.
  const next = rows[limit];
  const end = page.at(-1);
  if (more && next && end && next.seq === end.seq) {
    const last = end.seq;
    const whole = page.filter((r) => r.seq < last);
    page = whole.length
      ? whole
      : run(storage, `SELECT tbl,id,grp,seq,deleted FROM _changes WHERE grp IN (SELECT value FROM json_each(?)) AND seq = ? ${after === 0 ? 'AND deleted = 0' : ''} ORDER BY deleted DESC`, mine, last);
  }
  const changes: Array<Change> = page.map((r) => {
    const def = schema[r.tbl];
    const row = r.deleted || !def ? undefined : run<{ _id: string; _creationTime: number; doc: string }>(storage, `SELECT _id,_creationTime,doc FROM t_${r.tbl} WHERE _id=?`, r.id)[0];
    const doc = def && row ? visible(def, { ...parseDoc(row.doc), _id: row._id, _creationTime: row._creationTime }) : null;
    return { table: r.tbl, id: r.id, group: r.grp, doc };
  });
  const tail = page.at(-1);
  const seq = more && tail ? tail.seq : now;
  more = more && seq < now;
  return { seq, changes, more };
}
