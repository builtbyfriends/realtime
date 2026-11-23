import { bindable, fieldSql, hash, ident, isJsonArray, isJsonObject, parseDoc, run } from './storage.js';
import type { DataStorage } from './storage.js';
import type { Doc, JsonObject, JsonValue, NewDoc, Schema, TableDef } from './schema.js';
import { ChangeRecorder } from './changes.js';

const SYSTEM = new Set(['_id', '_creationTime']);

type Row = { _rowid: number; _id: string; _creationTime: number; doc: string };
/** Values a search or vector query can match a filter field against. */
export type FilterValues = { [field: string]: string | number | boolean | null | undefined };

type Cond = { field: string; op: '=' | '>' | '>=' | '<' | '<='; value: unknown };

/** Range builder passed to `withIndex`: equality on a prefix of the index, then one range. */
export interface IndexRange {
  eq(field: string, value: unknown): IndexRange;
  gt(field: string, value: unknown): IndexRange;
  gte(field: string, value: unknown): IndexRange;
  lt(field: string, value: unknown): IndexRange;
  lte(field: string, value: unknown): IndexRange;
}

/** Reads. A query function gets this; a mutation gets `Db`, which adds writes. */
export class DbReader<S extends Schema> {
  /** @internal */
  constructor(
    /** @internal */ readonly storage: DataStorage,
    /** @internal */ readonly schema: S,
  ) {}

  /** @internal */
  protected def(name: string): TableDef {
    const def = this.schema[name];
    if (!def) {throw new Error(`no table "${name}" in the schema`);}
    return def;
  }

  get<T extends keyof S & string>(table: T, id: string): Doc<S[T]> | null {
    ident(table, 'table');
    const row = run<Row>(this.storage, `SELECT * FROM t_${table} WHERE _id=?`, id)[0];
    return row ? toDoc<S, T>(row) : null;
  }

  query<T extends keyof S & string>(table: T): Query<S, T> {
    this.def(table);
    return new Query(this, table, undefined, [], 'asc', []);
  }

  /**
   * Full text search through an FTS5 index, best match first. The last word of `text`
   * matches as a prefix. `eq` filters on the index's `filters` fields.
   */
  search<T extends keyof S & string>(
    table: T,
    index: string,
    text: string,
    options: { eq?: FilterValues; limit?: number } = {},
  ): Array<Doc<S[T]>> {
    const spec = this.def(table).search?.[index];
    if (!spec) {throw new Error(`no search index "${index}" on "${table}"`);}
    const match = ftsQuery(text);
    if (!match) {return [];}
    const { where, params } = filterSql(spec.filters ?? [], options.eq, 'f_');
    const rows = run<Row>(
      this.storage,
      `SELECT d.* FROM ${ftsTable(table, index)} f JOIN t_${table} d ON d._rowid=f.rowid
       WHERE ${ftsTable(table, index)} MATCH ? ${where} ORDER BY bm25(${ftsTable(table, index)}) LIMIT ?`,
      match,
      ...params,
      options.limit ?? 20,
    );
    return rows.map((row) => toDoc<S, T>(row));
  }

  /** Nearest documents by cosine similarity, highest score first. */
  vectorSearch<T extends keyof S & string>(
    table: T,
    index: string,
    vector: ReadonlyArray<number>,
    options: { eq?: FilterValues; limit?: number } = {},
  ): Array<{ doc: Doc<S[T]>; score: number }> {
    const spec = this.def(table).vectors?.[index];
    if (!spec) {throw new Error(`no vector index "${index}" on "${table}"`);}
    if (vector.length !== spec.dimensions) {throw new Error(`vector has ${vector.length} dimensions, "${index}" needs ${spec.dimensions}`);}
    const { where, params } = filterSql(spec.filters ?? [], options.eq, 'f_');
    const rows = run<{ rowid: number; v: ArrayBuffer }>(this.storage, `SELECT rowid, v FROM ${vecTable(table, index)} WHERE 1=1 ${where}`, ...params);
    const scored = rows
      .map((r) => ({ rowid: r.rowid, score: cosine(vector, toFloats(r.v)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 10);
    return scored.flatMap(({ rowid, score }) => {
      const row = run<Row>(this.storage, `SELECT * FROM t_${table} WHERE _rowid=?`, rowid)[0];
      return row ? [{ doc: toDoc<S, T>(row), score }] : [];
    });
  }
}

/** Reads and writes. Every write in one mutation commits or rolls back together. */
export class Db<S extends Schema> extends DbReader<S> {
  /** @internal Topics touched by this call, published after the commit. */
  readonly touched = new Set<string>();
  /** @internal Changes to synced tables, written to the change index at the end of the mutation. */
  readonly changes: ChangeRecorder;

  /** @internal */
  constructor(storage: DataStorage, schema: S) {
    super(storage, schema);
    this.changes = new ChangeRecorder(schema);
  }

  /** Adds an extra live topic for this call, on top of the table topics. */
  touch(topic: string): void {
    this.touched.add(topic);
  }

  insert<T extends keyof S & string>(table: T, value: NewDoc<S[T]>): string {
    const def = this.def(table);
    const doc = checked(def, value);
    const id = crypto.randomUUID();
    const creationTime = Date.now();
    run(this.storage, `INSERT INTO t_${table} (_id,_creationTime,doc) VALUES (?,?,?)`, id, creationTime, JSON.stringify(doc));
    const inserted = run<{ _rowid: number }>(this.storage, `SELECT _rowid FROM t_${table} WHERE _id=?`, id)[0];
    if (!inserted) {throw new Error(`document ${id} was not written to "${table}"`);}
    this.reindex(table, def, inserted._rowid, doc);
    if (def.sync) {this.changes.record(table, id, null, { ...doc, _id: id, _creationTime: creationTime });}
    this.touchDoc(table, id, def, doc);
    return id;
  }

  /** Shallow merge. A field set to `undefined` is removed. */
  patch<T extends keyof S & string>(table: T, id: string, fields: Partial<NewDoc<S[T]>>): void {
    const { def, row, old } = this.load(table, id);
    if (!isJsonObject(fields)) {throw new Error('a document must be an object');}
    const merged = { ...old };
    for (const [k, v] of Object.entries<JsonValue>(fields)) {
      if (v === undefined) {delete merged[k];}
      else {merged[k] = v;}
    }
    this.write(table, def, row, old, checked(def, merged));
  }

  /** Replaces the whole document, keeping its id and creation time. */
  replace<T extends keyof S & string>(table: T, id: string, value: NewDoc<S[T]>): void {
    const { def, row, old } = this.load(table, id);
    this.write(table, def, row, old, checked(def, value));
  }

  delete<T extends keyof S & string>(table: T, id: string): void {
    const { def, row, old } = this.load(table, id);
    run(this.storage, `DELETE FROM t_${table} WHERE _rowid=?`, row._rowid);
    this.unindex(table, def, row._rowid);
    if (def.sync) {this.changes.record(table, id, stored(row, old), null);}
    this.touchDoc(table, id, def, old);
  }

  private load<T extends string>(table: T, id: string) {
    const def = this.def(table);
    const row = run<Row>(this.storage, `SELECT * FROM t_${table} WHERE _id=?`, id)[0];
    if (!row) {throw new Error(`no document ${id} in "${table}"`);}
    return { def, row, old: parseDoc(row.doc) };
  }

  private write(table: string, def: TableDef, row: Row, old: JsonObject, next: JsonObject) {
    run(this.storage, `UPDATE t_${table} SET doc=? WHERE _rowid=?`, JSON.stringify(next), row._rowid);
    this.unindex(table, def, row._rowid);
    this.reindex(table, def, row._rowid, next);
    if (def.sync) {this.changes.record(table, row._id, stored(row, old), stored(row, next));}
    this.touchDoc(table, row._id, def, old);
    this.touchDoc(table, row._id, def, next);
  }

  private touchDoc(table: string, id: string, def: TableDef, doc: JsonObject) {
    this.touched.add(table);
    this.touched.add(`${table}:${id}`);
    for (const topic of def.topics?.(doc) ?? []) {this.touched.add(topic);}
  }

  private reindex(table: string, def: TableDef, rowid: number, doc: JsonObject) {
    for (const [name, spec] of Object.entries(def.search ?? {})) {
      const filters = spec.filters ?? [];
      run(
        this.storage,
        `INSERT INTO ${ftsTable(table, name)} (rowid,text${filters.map((_, i) => `,f_${i}`).join('')}) VALUES (?,?${filters.map(() => ',?').join('')})`,
        rowid,
        String(pick(doc, spec.field) ?? ''),
        ...filters.map((f) => bindable(pick(doc, f))),
      );
    }
    for (const [name, spec] of Object.entries(def.vectors ?? {})) {
      const vector = pick(doc, spec.field);
      if (vector === undefined || vector === null) {continue;}
      if (!isJsonArray(vector) || vector.length !== spec.dimensions) {throw new Error(`"${spec.field}" must be a number[${spec.dimensions}]`);}
      const filters = spec.filters ?? [];
      run(
        this.storage,
        `INSERT INTO ${vecTable(table, name)} (rowid,v${filters.map((_, i) => `,f_${i}`).join('')}) VALUES (?,?${filters.map(() => ',?').join('')})`,
        rowid,
        vectorBytes(vector),
        ...filters.map((f) => bindable(pick(doc, f))),
      );
    }
  }

  private unindex(table: string, def: TableDef, rowid: number) {
    for (const name of Object.keys(def.search ?? {})) {run(this.storage, `DELETE FROM ${ftsTable(table, name)} WHERE rowid=?`, rowid);}
    for (const name of Object.keys(def.vectors ?? {})) {run(this.storage, `DELETE FROM ${vecTable(table, name)} WHERE rowid=?`, rowid);}
  }
}

export class Query<S extends Schema, T extends keyof S & string> {
  /** @internal */
  constructor(
    private readonly db: DbReader<S>,
    private readonly table: T,
    private readonly index: string | undefined,
    private readonly conds: Array<Cond>,
    private readonly direction: 'asc' | 'desc',
    private readonly filters: Array<(doc: Doc<S[T]>) => boolean>,
  ) {}

  private next(patch: { index?: string; conds?: Array<Cond>; direction?: 'asc' | 'desc'; filter?: (doc: Doc<S[T]>) => boolean }) {
    return new Query(this.db, this.table, patch.index ?? this.index, patch.conds ?? this.conds, patch.direction ?? this.direction, patch.filter ? [...this.filters, patch.filter] : this.filters);
  }

  /** Walks a declared index. Equality on a prefix of its fields, then at most one range. */
  withIndex(name: string, range?: (q: IndexRange) => IndexRange): Query<S, T> {
    const fields = this.db.schema[this.table]?.indexes?.[name];
    if (!fields) {throw new Error(`no index "${name}" on "${this.table}"`);}
    const conds: Array<Cond> = [];
    const add = (field: string, op: Cond['op'], value: unknown): IndexRange => {
      const eqs = conds.filter((c) => c.op === '=').length;
      const rangeFieldAt = conds.find((c) => c.op !== '=')?.field;
      if (fields[eqs] !== field && !(op !== '=' && field === rangeFieldAt)) {
        throw new Error(`index "${name}" (${fields.join(', ')}) expects "${fields[eqs]}" next, got "${field}"`);
      }
      if (op === '=' && rangeFieldAt) {throw new Error(`index "${name}": equality on "${field}" after a range`);}
      conds.push({ field, op, value });
      return q;
    };
    const q: IndexRange = {
      eq: (f, v) => add(f, '=', v),
      gt: (f, v) => add(f, '>', v),
      gte: (f, v) => add(f, '>=', v),
      lt: (f, v) => add(f, '<', v),
      lte: (f, v) => add(f, '<=', v),
    };
    range?.(q);
    return this.next({ index: name, conds });
  }

  order(direction: 'asc' | 'desc'): Query<S, T> {
    return this.next({ direction });
  }

  /** Filters in JS after the index narrows the scan. Use an index for anything large. */
  filter(predicate: (doc: Doc<S[T]>) => boolean): Query<S, T> {
    return this.next({ filter: predicate });
  }

  take(n: number): Array<Doc<S[T]>> {
    const out: Array<Doc<S[T]>> = [];
    if (n <= 0) {return out;}
    const dir = this.direction.toUpperCase();
    const fields = (this.index ? this.db.schema[this.table]?.indexes?.[this.index] : undefined) ?? [];
    const order = [...fields.map((f) => `${fieldSql(f)} ${dir}`), `_rowid ${dir}`].join(',');
    const where = this.conds.map((c) => `${fieldSql(c.field)} ${c.op === '=' && c.value === null ? 'IS' : c.op} ?`);
    const sql = `SELECT * FROM t_${this.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`;
    for (const row of this.db.storage.sql.exec<Row>(sql, ...this.conds.map((c) => bindable(c.value)))) {
      const doc = toDoc<S, T>(row);
      if (this.filters.every((f) => f(doc))) {out.push(doc);}
      if (out.length >= n) {break;}
    }
    return out;
  }

  collect(): Array<Doc<S[T]>> {
    return this.take(Infinity);
  }

  first(): Doc<S[T]> | null {
    return this.take(1)[0] ?? null;
  }

  /** The only match, null for none, and an error for more than one. */
  unique(): Doc<S[T]> | null {
    const [a, b] = this.take(2);
    if (b) {throw new Error(`unique() found more than one document in "${this.table}"`);}
    return a ?? null;
  }
}

const ftsTable = (table: string, index: string) => `fts_${ident(table, 'table')}_${ident(index, 'index')}`;
const vecTable = (table: string, index: string) => `vec_${ident(table, 'table')}_${ident(index, 'index')}`;

/**
 * Makes the database match the schema: tables, indexes, FTS5 and vector tables. Safe to
 * run on every start. A changed search or vector index is dropped and rebuilt from the
 * documents; a changed or removed regular index is dropped by name hash.
 */
export function syncSchema(storage: DataStorage, schema: Schema): void {
  // Decision: a wake with the same schema as last time reads one row and stops. Measured on a real app's schema
  // (2026-11-21), the full pass read about 8,000 rows on each wake.
  const signature = schemaSignature(schema);
  storage.transactionSync(() => {
    run(storage, `CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    if (run<{ value: string }>(storage, `SELECT value FROM _meta WHERE key='schema'`)[0]?.value === signature) {return;}
    for (const [table, def] of Object.entries(schema)) {
      ident(table, 'table');
      run(
        storage,
        `CREATE TABLE IF NOT EXISTS t_${table} (_rowid INTEGER PRIMARY KEY AUTOINCREMENT, _id TEXT NOT NULL UNIQUE, _creationTime REAL NOT NULL, doc TEXT NOT NULL)`,
      );
      const wanted = new Map<string, string>();
      for (const [name, fields] of Object.entries(def.indexes ?? {})) {
        ident(name, 'index');
        const idx = `i_${table}_${name}_${hash(fields.join(','))}`;
        wanted.set(idx, `CREATE INDEX IF NOT EXISTS ${idx} ON t_${table} (${[...fields.map(fieldSql), '_rowid'].join(',')})`);
      }
      const existing = run<{ name: string }>(storage, `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ? ESCAPE '\\'`, `i\\_${table}\\_%`);
      for (const { name } of existing) {
        if (!wanted.has(name)) {run(storage, `DROP INDEX ${name}`);}
      }
      for (const sql of wanted.values()) {run(storage, sql);}

      for (const [name, spec] of Object.entries(def.search ?? {})) {
        const filters = spec.filters ?? [];
        derived(storage, table, `fts:${name}`, JSON.stringify(spec), ftsTable(table, name), () => {
          run(storage, `CREATE VIRTUAL TABLE ${ftsTable(table, name)} USING fts5(text${filters.map((_, i) => `, f_${i} UNINDEXED`).join('')})`);
          for (const row of run<Row>(storage, `SELECT * FROM t_${table}`)) {
            const doc = parseDoc(row.doc);
            run(
              storage,
              `INSERT INTO ${ftsTable(table, name)} (rowid,text${filters.map((_, i) => `,f_${i}`).join('')}) VALUES (?,?${filters.map(() => ',?').join('')})`,
              row._rowid,
              String(pick(doc, spec.field) ?? ''),
              ...filters.map((f) => bindable(pick(doc, f))),
            );
          }
        });
      }
      for (const [name, spec] of Object.entries(def.vectors ?? {})) {
        const filters = spec.filters ?? [];
        derived(storage, table, `vec:${name}`, JSON.stringify(spec), vecTable(table, name), () => {
          run(storage, `CREATE TABLE ${vecTable(table, name)} (rowid INTEGER PRIMARY KEY, v BLOB NOT NULL${filters.map((_, i) => `, f_${i}`).join('')})`);
          for (const row of run<Row>(storage, `SELECT * FROM t_${table}`)) {
            const doc = parseDoc(row.doc);
            const vector = pick(doc, spec.field);
            if (!isJsonArray(vector)) {continue;}
            run(
              storage,
              `INSERT INTO ${vecTable(table, name)} (rowid,v${filters.map((_, i) => `,f_${i}`).join('')}) VALUES (?,?${filters.map(() => ',?').join('')})`,
              row._rowid,
              vectorBytes(vector),
              ...filters.map((f) => bindable(pick(doc, f))),
            );
          }
        });
      }
    }
    run(storage, `INSERT OR REPLACE INTO _meta (key,value) VALUES ('schema',?)`, signature);
  });
}

/** What `syncSchema` builds from: tables, indexes, search and vectors. Validators and topic functions don't change tables. */
export function schemaSignature(schema: Schema): string {
  const shape = Object.entries(schema).map(([table, def]) => [table, def.indexes ?? {}, def.search ?? {}, def.vectors ?? {}]);
  return `v1:${JSON.stringify(shape)}`;
}

function derived(storage: DataStorage, table: string, key: string, signature: string, name: string, build: () => void) {
  const metaKey = `${table}/${key}`;
  const stored = run<{ value: string }>(storage, `SELECT value FROM _meta WHERE key=?`, metaKey)[0]?.value;
  if (stored === signature) {return;}
  run(storage, `DROP TABLE IF EXISTS ${name}`);
  build();
  run(storage, `INSERT OR REPLACE INTO _meta (key,value) VALUES (?,?)`, metaKey, signature);
}

function stored(row: Row, doc: JsonObject) {
  return { ...doc, _id: row._id, _creationTime: row._creationTime };
}

function toDoc<S extends Schema, T extends keyof S & string>(row: Row): Doc<S[T]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table's document type comes from the schema generic, and writes are checked
  return { ...parseDoc(row.doc), _id: row._id, _creationTime: row._creationTime } as Doc<S[T]>;
}

function checked(def: TableDef, value: unknown): JsonObject {
  if (!isJsonObject(value)) {throw new Error('a document must be an object');}
  for (const k of SYSTEM) {
    if (k in value) {throw new Error(`"${k}" is set by the database`);}
  }
  if (!def.schema) {return value;}
  const result = def.schema['~standard'].validate(value);
  if ('then' in result) {throw new Error('table schemas must validate synchronously');}
  if (result.issues) {throw new Error(`invalid document: ${result.issues.map((i) => i.message).join('; ')}`);}
  if (!isJsonObject(result.value)) {throw new Error('a document must be an object');}
  return result.value;
}

function vectorBytes(vector: ReadonlyArray<JsonValue>): ArrayBufferLike {
  return Float32Array.from(vector, Number).buffer;
}

function pick(doc: JsonObject, path: string): JsonValue {
  let cur: JsonValue = doc;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) {return undefined;}
    cur = isJsonObject(cur) ? cur[key] : cur[Number(key)];
  }
  return cur;
}

function filterSql(declared: ReadonlyArray<string>, eq: FilterValues | undefined, prefix: string) {
  let where = '';
  const params: Array<unknown> = [];
  for (const [field, value] of Object.entries(eq ?? {})) {
    const i = declared.indexOf(field);
    if (i < 0) {throw new Error(`"${field}" is not a filter of this index (${declared.join(', ') || 'none'})`);}
    where += ` AND ${prefix}${i} ${value === null ? 'IS' : '='} ?`;
    params.push(bindable(value));
  }
  return { where, params };
}

/** Quotes every word so user text can never be FTS5 syntax, and makes the last word a prefix. */
export function ftsQuery(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

function toFloats(v: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = ArrayBuffer.isView(v) ? v : new Uint8Array(v);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function cosine(a: ReadonlyArray<number>, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
