import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

/** Any Standard Schema (Zod, Valibot, ArkType, ...). */
export type AnySchema = StandardSchemaV1<any, any>;
export type InferIn<S> = S extends StandardSchemaV1<infer I, any> ? I : never;
export type InferOut<S> = S extends StandardSchemaV1<any, infer O> ? O : never;

export type JsonSchema = Record<string, unknown>;

export async function validate(
  schema: AnySchema,
  value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; issues: Array<{ message: string; path: string }> }> {
  let result = schema['~standard'].validate(value);
  if (result instanceof Promise) {result = await result;}
  if (result.issues) {
    return {
      ok: false,
      issues: result.issues.map((i) => ({
        message: i.message,
        path: (i.path ?? []).map((p) => String(typeof p === 'object' && p !== null ? p.key : p)).join('.'),
      })),
    };
  }
  return { ok: true, value: result.value };
}

/**
 * Converts a schema to JSON Schema through Standard JSON Schema (`~standard.jsonSchema`).
 * Zod 4.2+ and ArkType implement it directly; wrap Valibot schemas with
 * `toStandardJsonSchema` from `@valibot/to-json-schema`.
 */
export function toJsonSchema(schema: AnySchema, io: 'input' | 'output'): JsonSchema {
  const converter = (schema['~standard'] as Partial<StandardJSONSchemaV1.Props>).jsonSchema;
  if (!converter) {
    throw new Error(
      `schema from "${schema['~standard'].vendor}" does not implement Standard JSON Schema (~standard.jsonSchema). ` +
        'Use Zod 4.2+ or ArkType, or wrap Valibot schemas with toStandardJsonSchema() from @valibot/to-json-schema.',
    );
  }
  const json = { ...converter[io]({ target: 'draft-2020-12' }) };
  delete json.$schema;
  return json;
}
