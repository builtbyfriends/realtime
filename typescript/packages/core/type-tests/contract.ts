// Decision: compiled by the typecheck script. Each @ts-expect-error is a contract mistake the types must reject.
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import { defineContract, implementContract, memoryRunOnce } from '@builtbyfriends/realtime';
import type { CommandInput, RecordOf, StateOf } from '@builtbyfriends/realtime';

const states = ['draft', 'sent'] as const;
const Note = z.object({ id: z.string(), body: z.string(), state: z.enum(states) });
const off = { reason: 'Covered by a type test only' } as const;

const notes = defineContract({
  name: 'notes',
  description: 'A short note that can be sent.',
  data: { Note },
  states: { record: 'Note', field: 'state', list: states, initial: 'draft', moves: { send: { from: ['draft'], to: 'sent' } } },
  requestIds: { keepHours: 1 },
  commands: {
    write: {
      description: 'Write a note.',
      effect: 'write',
      input: z.object({ body: z.string() }),
      output: Note,
      errors: { TOO_LONG: { status: 422, message: 'Too long' } },
      capability: 'notes.write',
      tool: { needsApproval: false },
      cli: true,
      emits: ['written'],
      example: { body: 'Hello' },
    },
    send: {
      description: 'Send a note.',
      effect: 'write',
      input: z.object({ id: z.string() }),
      output: Note,
      errors: {},
      capability: off,
      tool: off,
      cli: off,
      move: 'send',
    },
  },
  events: { written: { description: 'A note was written.', topic: 'notes:{id}', payload: Note } },
});

expectTypeOf<RecordOf<typeof notes, 'Note'>>().toEqualTypeOf<{ id: string; body: string; state: 'draft' | 'sent' }>();

expectTypeOf<StateOf<typeof notes>>().toEqualTypeOf<'draft' | 'sent'>();

expectTypeOf<CommandInput<typeof notes, 'write'>>().toEqualTypeOf<{ body: string } & { requestId: string }>();

implementContract(notes).with({
  auth: off,
  can: ({ ctx, capability }) => ctx === null && capability.length > 0,
  analytics: off,
  publish: off,
  runOnce: memoryRunOnce(),
  commands: {
    write: ({ input, fail, emit }) => {
      expectTypeOf(input).toEqualTypeOf<{ body: string }>();

      if (input.body.length > 9) {fail('TOO_LONG');}

      // @ts-expect-error: a failure the contract doesn't list
      if (input.body === '') {fail('EMPTY');}

      // @ts-expect-error: an event the command doesn't list in emits
      emit('sent', { id: 'n1' });
      // @ts-expect-error: a payload that doesn't match the event
      emit('written', { id: 'n1' });
      emit('written', { id: 'n1', body: input.body, state: 'draft' });

      return { id: 'n1', body: input.body, state: 'draft' };
    },
    // @ts-expect-error: the output has to match the Note schema
    send: ({ move, fail }) => {
      expectTypeOf(move('draft')).toEqualTypeOf<'sent'>();
      fail('MOVE_NOT_ALLOWED');
      // @ts-expect-error: a state the contract doesn't list
      move('archived');

      return { id: 'n1' };
    },
  },
});

implementContract(notes).with({
  auth: off,
  can: () => true,
  analytics: off,
  publish: off,
  runOnce: memoryRunOnce(),
  commands: {
    write: { reason: 'The writer serves it' },
    send: ({ input }) => {
      expectTypeOf(input).toEqualTypeOf<{ id: string }>();

      return { id: input.id, body: '', state: 'sent' };
    },
  },
});

implementContract(notes).with({
  auth: off,
  can: () => true,
  analytics: off,
  publish: off,
  runOnce: memoryRunOnce(),
  // @ts-expect-error: a command with neither a handler nor a reason
  commands: { write: { reason: 'The writer serves it' } },
});

defineContract({
  name: 'broken',
  description: 'Mistakes the types catch.',
  data: { Note },
  states: { record: 'Note', field: 'state', list: states, initial: 'draft', moves: { send: { from: ['draft'], to: 'sent' } } },
  commands: {
    send: {
      description: 'Send a note.',
      effect: 'read',
      input: z.object({ id: z.string() }),
      output: Note,
      errors: {},
      capability: off,
      tool: off,
      cli: off,
      // @ts-expect-error: a move the states don't list
      move: 'archive',
      // @ts-expect-error: an event the contract doesn't list
      emits: ['hidden'],
      // @ts-expect-error: an example that doesn't match the input
      example: { id: 1 },
    },
  },
  events: {
    // @ts-expect-error: a topic field that isn't in the payload
    archived: { description: 'A note was archived.', topic: 'notes:{noteId}', payload: Note },
    // @ts-expect-error: a topic in a list with a field that isn't in the payload
    sent: { description: 'A note was sent.', topic: ['notes:{id}', 'notes-by:{author}'], payload: Note },
    read: { description: 'A note was read.', topic: ['notes:{id}', 'notes:{state}'], payload: Note },
  },
});
