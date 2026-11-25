import type { JsonSchema } from './schema.js';

/** True for a plain JSON object: not null, not an array, not a primitive. */
export function isRecord(value: unknown): value is JsonSchema {
  return Object(value) === value && !Array.isArray(value);
}

/** The schema at a key, such as `items`, when it's an object. */
export function schemaAt(json: JsonSchema | null | undefined, key: string): JsonSchema | null {
  const value = json?.[key];

  return isRecord(value) ? value : null;
}

/** The field schemas of an object schema, or null when it has none. */
export function fieldsOf(json: JsonSchema | null | undefined): Map<string, JsonSchema> | null {
  const props = schemaAt(json, 'properties');

  if (!props) {return null;}

  const fields = new Map<string, JsonSchema>();

  for (const [key, value] of Object.entries(props)) {
    if (isRecord(value)) {fields.set(key, value);}
  }

  return fields;
}

/** A list keyword, such as `required` or `enum`, as strings. Empty when it's missing. */
export function wordsAt(json: JsonSchema | null | undefined, key: string): Array<string> {
  const value = json?.[key];

  return Array.isArray(value) ? value.map(String) : [];
}

/** The schemas in a list keyword, such as `anyOf`. */
export function schemasAt(json: JsonSchema | null | undefined, key: string): Array<JsonSchema> {
  const value = json?.[key];

  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The `type` keyword as text, such as "string" or "string or null". */
export function typeOf(json: JsonSchema | null | undefined): string | null {
  const type = json?.type;

  if (Array.isArray(type)) {return type.map(String).join(' or ');}

  return type === undefined ? null : String(type);
}
