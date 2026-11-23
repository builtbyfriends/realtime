import type { AnySchema } from '@builtbyfriends/realtime';
import type { SyncDef } from './changes.js';

export type TableDef<D = any> = {
  /** Optional Standard Schema (zod, valibot, arktype) checked on every insert and replace. */
  schema?: AnySchema;
  /** Name to the fields it covers. An index query is equality on a prefix, then one range. */
  indexes?: Record<string, ReadonlyArray<string>>;
  /** FTS5 full text search over one string field, filterable by equality on other fields. */
  search?: Record<string, { field: string; filters?: ReadonlyArray<string> }>;
  /** Exact cosine search over a number[] field. Scans the filtered rows, so keep tables modest. */
  vectors?: Record<string, { field: string; dimensions: number; filters?: ReadonlyArray<string> }>;
  /** Extra live topics to publish when a document of this table changes (called with old and new). */
  topics?: (doc: D) => Array<string>;
  /** Sends this table's documents to devices: the group each is in and the fields they see. See `pull`. */
  sync?: SyncDef<D & { _id: string; _creationTime: number }>;
  /** Phantom type of the document. */
  readonly '~doc'?: D;
};

export type Schema = Record<string, TableDef>;

/** Declares a table. `table<Message>({...})` types every read and write. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-values
export function table<D extends Record<string, any> = Record<string, any>>(def: Omit<TableDef<D>, '~doc'> = {}): TableDef<D> {
  return def;
}

export function defineSchema<S extends Schema>(schema: S): S {
  return schema;
}

export type DocOf<T> = T extends TableDef<infer D> ? D : never;
export type Doc<T extends TableDef> = DocOf<T> & { _id: string; _creationTime: number };
export type NewDoc<T extends TableDef> = DocOf<T>;
