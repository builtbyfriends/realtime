import { z } from 'zod';
import { bearerAuth, defineContract, defineRegistry, implementContract, memoryOutbox, memoryRunOnce } from '@builtbyfriends/realtime';
import type { ContractEvent, RecordOf } from '@builtbyfriends/realtime';
import { rpcHandler } from '@builtbyfriends/realtime-http';

const Note = z.object({ id: z.string(), boardId: z.string(), title: z.string(), updatedAt: z.iso.datetime() });
const ById = z.object({ id: z.string().min(1) });
const notFound = { NOT_FOUND: { status: 404, message: 'No note with this id' } } as const;
const asTool = { needsApproval: false } as const;
const topics = ['notes:{id}', 'boards:{boardId}:notes'] as const;

export const notes = defineContract({
  name: 'notes',
  description: 'A short note that sits on a board.',
  data: { Note },
  requestIds: { keepHours: 24 },
  commands: {
    get: { description: 'Show one note.', effect: 'read', input: ById, output: Note, errors: notFound, capability: 'notes.read', tool: asTool, cli: true, example: { id: 'n-1' } },
    list: {
      description: 'List the notes on a board.',
      effect: 'read',
      input: z.object({ boardId: z.string().min(1) }),
      output: z.array(Note),
      errors: {},
      capability: 'notes.read',
      tool: asTool,
      cli: true,
      example: { boardId: 'b-1' },
    },
    rename: {
      description: 'Give a note a new title.',
      effect: 'write',
      input: z.object({ id: z.string().min(1), title: z.string().trim().min(1).max(100) }),
      output: Note,
      errors: { ...notFound, TITLE_TAKEN: { status: 409, message: 'A note on this board has this title' } },
      capability: 'notes.write',
      tool: asTool,
      cli: true,
      emits: ['renamed'],
      example: { id: 'n-1', title: 'Plan' },
    },
  },
  events: {
    renamed: { description: 'A note got a new title.', topic: topics, payload: Note },
  },
});

export type NoteRecord = RecordOf<typeof notes, 'Note'>;

export type Env = { TOKENS: string };

export class NoteStore {
  readonly notes = new Map<string, NoteRecord>();
  readonly feed: Array<ContractEvent> = [];
  clock = 0;
  renameCalls = 0;
  failNextRename: 'TITLE_TAKEN' | undefined;

  stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 10, 26, 12, 0, 0, this.clock)).toISOString();
  }

  add(id: string, boardId: string, title: string): NoteRecord {
    const note = { id, boardId, title, updatedAt: this.stamp() };
    this.notes.set(id, note);
    return note;
  }
}

const apiToken = bearerAuth<{ id: string }, Env>({ name: 'token', verify: (token) => (token === 'ok' ? { id: 'u-1' } : null), actorId: (c) => c.id });

export function notesWorld() {
  const store = new NoteStore();
  const module = implementContract(notes).with({
    auth: apiToken,
    can: () => true,
    analytics: { reason: 'A test fixture' },
    publish: (event) => void store.feed.push(event),
    runOnce: memoryRunOnce(),
    outbox: memoryOutbox(),
    commands: {
      get: ({ input, fail }) => store.notes.get(input.id) ?? fail('NOT_FOUND'),
      list: ({ input }) => [...store.notes.values()].filter((n) => n.boardId === input.boardId),
      rename: ({ input, fail, emit }) => {
        store.renameCalls += 1;
        const note = store.notes.get(input.id) ?? fail('NOT_FOUND');
        if (store.failNextRename) {
          const code = store.failNextRename;
          store.failNextRename = undefined;
          return fail(code);
        }
        const next = { ...note, title: input.title, updatedAt: store.stamp() };
        store.notes.set(note.id, next);
        emit('renamed', next);
        return next;
      },
    },
  });
  const registry = defineRegistry(module.procedures);
  const handler = rpcHandler(registry);
  const env: Env = { TOKENS: '' };
  const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const client = {
    async call(name: string, input: unknown) {
      const res = await handler(
        new Request(`https://notes.test/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ok' }, body: JSON.stringify(input) }),
        env,
        ctx,
      );
      const body: { data?: unknown; error?: { code: string; message: string } } = await res.json();
      if (body.error) {throw Object.assign(new Error(body.error.message), { code: body.error.code });}
      return body.data;
    },
  };
  return { store, module, client };
}
