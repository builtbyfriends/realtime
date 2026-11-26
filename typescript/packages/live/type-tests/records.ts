// Decision: compiled by the typecheck script. Each @ts-expect-error is a change to a contract that a feature has to follow.
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import { defineContract } from '@builtbyfriends/realtime';
import { createRecords } from '../src/records.js';

const off = { reason: 'Covered by a type test only' } as const;
const asTool = { needsApproval: false } as const;

const Note = z.object({ id: z.string(), title: z.string(), updatedAt: z.string() });
const Lean = z.object({ id: z.string(), title: z.string() });

const notes = defineContract({
  name: 'notes',
  description: 'A short note that sits on a board.',
  data: { Note: Note },
  requestIds: { keepHours: 1 },
  commands: {
    get: { description: 'Show one note.', effect: 'read', input: z.object({ id: z.string() }), output: Note, errors: {}, capability: 'notes.read', tool: asTool, cli: true, example: { id: 'n-1' } },
    rename: {
      description: 'Rename a note.',
      effect: 'write',
      input: z.object({ id: z.string(), title: z.string() }),
      output: Note,
      errors: { TITLE_TAKEN: { status: 409, message: 'Taken' } },
      capability: off,
      tool: asTool,
      cli: true,
      emits: ['renamed', 'archived'],
      example: { id: 'n-1', title: 'Plan' },
    },
  },
  events: {
    renamed: { description: 'Renamed.', topic: 'notes:{id}', payload: Note },
    archived: { description: 'Archived.', topic: 'notes:{id}', payload: z.object({ id: z.string() }) },
  },
});

const lean = defineContract({
  name: 'notes',
  description: 'A short note that sits on a board.',
  data: { Note: Lean },
  requestIds: { keepHours: 1 },
  commands: {
    get: { description: 'Show one note.', effect: 'read', input: z.object({ id: z.string() }), output: Lean, errors: {}, capability: 'notes.read', tool: asTool, cli: true, example: { id: 'n-1' } },
    rename: {
      description: 'Rename a note.',
      effect: 'write',
      input: z.object({ id: z.string(), title: z.string() }),
      output: Lean,
      errors: { TITLE_TAKEN: { status: 409, message: 'Taken' } },
      capability: off,
      tool: asTool,
      cli: true,
      emits: ['renamed', 'archived'],
      example: { id: 'n-1', title: 'Plan' },
    },
  },
  events: {
    renamed: { description: 'Renamed.', topic: 'notes:{id}', payload: Lean },
    archived: { description: 'Archived.', topic: 'notes:{id}', payload: z.object({ id: z.string() }) },
  },
});

const client = { call: () => Promise.resolve(undefined) };

const ok = createRecords({ contract: notes, client }).recordCollection('Note', { key: 'id', version: 'updatedAt', reads: { get: { id: 'id' } }, upserts: ['renamed'] });
expectTypeOf(ok.collection.get('n-1')?.title).toEqualTypeOf<string | undefined>();

// An event that doesn't carry the record can't be listed as one that does.
createRecords({ contract: notes, client }).recordCollection('Note', {
  key: 'id',
  version: 'updatedAt',
  reads: { get: { id: 'id' } },
  // @ts-expect-error archived carries only an id
  upserts: ['archived'],
});

// A version field the record doesn't have.
createRecords({ contract: notes, client }).recordCollection('Note', {
  // @ts-expect-error the record has no `modified` field
  version: 'modified',
  key: 'id',
  reads: { get: { id: 'id' } },
  upserts: ['renamed'],
});

// A read that matches input fields to fields the record lost.
createRecords({ contract: notes, client }).recordCollection('Note', {
  key: 'id',
  version: 'updatedAt',
  // @ts-expect-error the record has no `slug` field
  reads: { get: { id: 'slug' } },
  upserts: ['renamed'],
});

// The contract drops `updatedAt`, so a feature that still names it stops compiling.
createRecords({ contract: lean, client }).recordCollection('Note', {
  key: 'id',
  // @ts-expect-error `updatedAt` is gone from the record
  version: 'updatedAt',
  reads: { get: { id: 'id' } },
  upserts: ['renamed'],
});

// A command's failure code is one the contract lists.
const rename = createRecords({ contract: notes, client }).command('rename', { records: ok, spec: { key: 'id', version: 'updatedAt', reads: {}, upserts: ['renamed'] } });
async function handle() {
  const result = await rename({ id: 'n-1', title: 'x' }).result;
  if (!result.ok) {
    switch (result.error.code) {
      case 'TITLE_TAKEN':
      case 'UNAUTHENTICATED':
      case 'FORBIDDEN':
      case 'INVALID_INPUT':
      case 'INTERNAL':
        break;
      // @ts-expect-error the contract lists no such code
      case 'NOT_A_CODE':
        break;
    }
  }
}
void handle;
