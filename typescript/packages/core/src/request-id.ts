import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { isRecord, schemaAt, wordsAt } from './json-schema.js';
import type { AnySchema, JsonSchema } from './schema.js';
import { validate } from './schema.js';

/** A write's input after its schema ran: the caller's `requestId` and the command's own input. */
export type RequestInput = { requestId: string; input: unknown };

const MAX = 200;
const REQUEST_ID = { type: 'string', minLength: 1, maxLength: MAX, description: 'Any id that stays the same when this call is retried' };

// Decision: the pipeline hands a handler whatever the input schema returned. The schema below returns a frozen token, and this map
// holds what the token stands for, so a handler finds the parsed input by identity and nothing has to narrow an unknown value.
const parsed = new WeakMap<JsonSchema, RequestInput>();

/** True for a value the request id schema returned. */
export function isRequestToken(value: unknown): value is JsonSchema {
  return isRecord(value) && parsed.has(value);
}

export function requestInput(token: JsonSchema): RequestInput | undefined {
  return parsed.get(token);
}

function withRequestId(json: JsonSchema | null): JsonSchema {
  return {
    ...json,
    type: 'object',
    properties: { ...schemaAt(json, 'properties'), requestId: REQUEST_ID },
    required: [...wordsAt(json, 'required'), 'requestId'],
  };
}

function token(requestId: string, input: RequestInput['input']) {
  const value: JsonSchema = Object.freeze({});

  parsed.set(value, { requestId, input });

  return { value };
}

const issue = (message: string, path: Array<string> = []) => ({ issues: [{ message, path }] });

/** The input schema of a write: the command's own schema, plus a required `requestId`. */
export function requestIdSchema(inner: AnySchema | undefined, innerJson: JsonSchema | null): StandardSchemaV1<unknown, JsonSchema> & StandardJSONSchemaV1 {
  const json = withRequestId(innerJson);

  return {
    '~standard': {
      version: 1,
      vendor: inner ? `${inner['~standard'].vendor}+requestId` : 'requestId',
      validate: async (value) => {
        if (!isRecord(value)) {return issue('Input has to be an object with a requestId');}

        const { requestId, ...rest } = value;
        const id = String(requestId);

        if (id !== requestId || !id.length || id.length > MAX) {
          return issue('requestId is required: any string that stays the same when the call is retried', ['requestId']);
        }

        if (!inner) {return Object.keys(rest).length ? issue('This command takes only a requestId') : token(id, undefined);}

        const r = await validate(inner, rest);

        return r.ok ? token(id, r.value) : { issues: r.issues.map((i) => ({ message: i.message, path: i.path ? i.path.split('.') : [] })) };
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}
