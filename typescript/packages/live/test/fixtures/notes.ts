import { z } from 'zod';
import { bearerAuth, defineContract, defineRegistry, implementContract, memoryOutbox, memoryRunOnce } from '@builtbyfriends/realtime';
import type { ContractEvent, RecordOf } from '@builtbyfriends/realtime';
import { defineRecords } from '../../src/records.js';
import { fakeBackend } from '../../src/records-testing.js';

const Note = z.object({ id: z.string(), boardId: z.string(), title: z.string(), updatedAt: z.iso.datetime() });
const Board = z.object({ id: z.string(), name: z.string(), updatedAt: z.iso.datetime() });
const ById = z.object({ id: z.string().min(1) });
const notFound = { NOT_FOUND: { status: 404, message: 'No note with this id' } } as const;
const asTool = { needsApproval: false } as const;
const topics = ['notes:{id}', 'boards:{boardId}:notes'] as const;

export const notes = defineContract({
  name: 'notes',
  description: 'A short note that sits on a board.',
  data: { Note, Board },
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
    board: { description: 'Show one board.', effect: 'read', input: ById, output: Board, errors: notFound, capability: 'notes.read', tool: asTool, cli: true, example: { id: 'b-1' } },
    can: {
      description: 'What the caller may do with a note right now.',
      effect: 'read',
      input: ById,
      output: z.object({ rename: z.boolean() }),
      errors: notFound,
      capability: 'notes.read',
      tool: asTool,
      cli: true,
      example: { id: 'n-1' },
    },
    remove: {
      description: 'Delete a note.',
      effect: 'destructive',
      input: ById,
      output: z.object({ id: z.string() }),
      errors: notFound,
      capability: 'notes.write',
      tool: { reason: 'Deleting stays a choice a person makes' },
      cli: true,
      emits: ['removed'],
      example: { id: 'n-1' },
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
    boardRenamed: { description: 'A board got a new name.', topic: 'boards:{id}', payload: Board },
    removed: { description: 'A note was deleted.', topic: topics, payload: z.object({ id: z.string(), boardId: z.string() }) },
  },
});

export type NoteRecord = RecordOf<typeof notes, 'Note'>;

export type BoardRecord = RecordOf<typeof notes, 'Board'>;

export type Env = { TOKENS: string };

export class NoteStore {
  readonly notes = new Map<string, NoteRecord>();
  readonly boards = new Map<string, BoardRecord>();
  readonly feed: Array<ContractEvent> = [];
  clock = 0;
  renameCalls = 0;
  failNextRename: 'TITLE_TAKEN' | undefined;

  stamp(): string {
    this.clock += 1;

    return new Date(Date.UTC(2026, 10, 26, 12, 0, 0, this.clock)).toISOString();
  }

  addBoard(id: string, name: string): BoardRecord {
    const board = { id, name, updatedAt: this.stamp() };
    this.boards.set(id, board);

    return board;
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
      board: ({ input, fail }) => store.boards.get(input.id) ?? fail('NOT_FOUND'),
      can: ({ input, fail }) => ({ rename: (store.notes.get(input.id) ?? fail('NOT_FOUND')).title !== 'Locked' }),
      remove: ({ input, fail, emit }) => {
        const note = store.notes.get(input.id) ?? fail('NOT_FOUND');
        store.notes.delete(note.id);
        emit('removed', { id: note.id, boardId: note.boardId });

        return { id: note.id };
      },
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
  const backend = fakeBackend({ registry, modules: [module], headers: { authorization: 'Bearer ok' } });

  return { store, module, backend };
}

export const noteRecords = defineRecords(notes, {
  records: {
    Note: {
      key: 'id',
      version: 'updatedAt',
      reads: { list: { boardId: 'boardId' }, get: { id: 'id' } },
      upserts: ['renamed'],
      removes: ['removed'],
    },
    Board: { key: 'id', version: 'updatedAt', reads: { board: { id: 'id' } }, upserts: ['boardRenamed'] },
  },
  commands: {
    rename: {
      answers: 'Note',
      optimistic: ({ id, title }, { Note }) => {
        if (!Note.has(id)) {return;}

        Note.update(id, (draft) => {
          draft.title = title;
        });
      },
    },
    remove: { removes: 'Note', optimistic: ({ id }, { Note }) => void (Note.has(id) && Note.delete(id)) },
  },
  views: { can: { events: ['renamed'], commands: ['rename'] } },
});
