/**
 * The slice of a Durable Object's storage this package uses. `ctx.storage` satisfies it
 * as is, and tests satisfy it with node:sqlite.
 */
export interface DataStorage {
  sql: { exec(query: string, ...bindings: Array<unknown>): Iterable<any> & { toArray(): Array<any> } };
  transactionSync<T>(fn: () => T): T;
  setAlarm(time: number): void | Promise<void>;
  deleteAlarm(): void | Promise<void>;
}

/** Runs one statement to completion and returns its rows. */
export function run<T = any>(storage: DataStorage, query: string, ...bindings: Array<unknown>): Array<T> {
  return storage.sql.exec(query, ...bindings).toArray() as Array<T>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Table, index and field names go into SQL text, so they are checked, never escaped. */
export function ident(name: string, what: string): string {
  if (!NAME.test(name)) {throw new Error(`${what} "${name}" must match ${NAME}`);}
  return name;
}

/** SQL for a document field. `_id` and `_creationTime` are real columns; the rest read the JSON. */
export function fieldSql(field: string): string {
  if (field === '_id' || field === '_creationTime') {return field;}
  if (!FIELD.test(field)) {throw new Error(`field "${field}" must match ${FIELD}`);}
  return `json_extract(doc,'$.${field}')`;
}

/** SQLite has no booleans: they are stored and compared as 0 and 1. */
export function bindable(value: unknown): string | number | null | ArrayBuffer {
  if (typeof value === 'boolean') {return value ? 1 : 0;}
  if (value === undefined) {return null;}
  if (value === null || typeof value === 'string' || typeof value === 'number') {return value;}
  throw new Error('only strings, numbers, booleans and null can be indexed or compared');
}

export function hash(text: string): string {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++) {h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);}
  return (h >>> 0).toString(36);
}
