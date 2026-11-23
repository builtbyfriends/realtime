import { describe, expect, it } from 'vitest';
import { defineData, defineSchema, table } from '../src/index.js';
import type { ChangeBatch } from '../src/index.js';
import { memoryStorage } from './storage.js';

type Note = { room: string; text: string; secret?: string };

const schema = defineSchema({
  notes: table<Note>({
    indexes: { by_room: ['room'] },
    sync: { group: (n) => (n.room === 'hidden' ? null : `room:${n.room}`), fields: ['room', 'text'] },
  }),
  logs: table<{ line: string }>({}),
});

function setup() {
  const batches: Array<ChangeBatch> = [];
  const data = defineData({
    schema,
    functions: ({ mutation }) => ({
      add: mutation((ctx, a: { room: string; text: string }) => ctx.db.insert('notes', { ...a, secret: 'token' })),
      edit: mutation((ctx, a: { id: string; text?: string; room?: string }) => {
        ctx.db.patch('notes', a.id, { ...(a.text && { text: a.text }), ...(a.room && { room: a.room }) });
      }),
      editTwice: mutation((ctx, a: { id: string }) => {
        ctx.db.patch('notes', a.id, { text: 'one' });
        ctx.db.patch('notes', a.id, { text: 'two' });
      }),
      remove: mutation((ctx, a: { id: string }) => ctx.db.delete('notes', a.id)),
      log: mutation((ctx) => void ctx.db.insert('logs', { line: 'x' })),
      fail: mutation((ctx) => {
        ctx.db.insert('notes', { room: 'a', text: 'lost' });
        throw new Error('boom');
      }),
    }),
    onChanges: (batch) => void batches.push(batch),
  });
  const storage = memoryStorage();
  const engine = data.engine(storage);
  engine.init();
  const m = (name: string, args?: unknown) => engine.run('mutation', name, args) as Promise<any>;
  return { engine, m, batches, storage };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('change index', () => {
  it('gives each commit one position and sends only the visible fields', async () => {
    const { engine, m, batches } = setup();
    const id = await m('add', { room: 'a', text: 'hello' });
    await tick();
    expect(batches).toHaveLength(1);
    expect(batches[0].seq).toBe(1);
    expect(batches[0].changes[0].doc).toEqual({ _id: id, _creationTime: expect.any(Number), room: 'a', text: 'hello' });
    const pulled = engine.pull(['room:a'], 0);
    expect(pulled).toMatchObject({ seq: 1, more: false, changes: [{ table: 'notes', id, group: 'room:a' }] });
    expect(pulled.changes[0].doc).not.toHaveProperty('secret');
  });

  it('keeps one row per document, however often it changes', async () => {
    const { engine, m, storage } = setup();
    const id = await m('add', { room: 'a', text: 'hello' });
    await m('editTwice', { id });
    await m('edit', { id, text: 'three' });
    expect(storage.db.prepare('SELECT count(*) AS n FROM _changes').get()).toEqual({ n: 1 });
    const pulled = engine.pull(['room:a'], 1);
    expect(pulled.seq).toBe(3);
    expect(pulled.changes.map((c) => c.doc?.text)).toEqual(['three']);
  });

  it('leaves a delete marker in the old group when a document moves', async () => {
    const { engine, m } = setup();
    const id = await m('add', { room: 'a', text: 'hello' });
    await m('edit', { id, room: 'b' });
    expect(engine.pull(['room:a'], 1).changes).toEqual([{ table: 'notes', id, group: 'room:a', doc: null }]);
    expect(engine.pull(['room:b'], 0).changes[0].doc).toMatchObject({ room: 'b' });
    expect(engine.pull(['room:a'], 0).changes).toEqual([]);
  });

  it('marks deletes, and keeps a document whose group is null off devices', async () => {
    const { engine, m } = setup();
    const id = await m('add', { room: 'a', text: 'hello' });
    await m('remove', { id });
    expect(engine.pull(['room:a'], 1).changes).toEqual([{ table: 'notes', id, group: 'room:a', doc: null }]);
    await m('add', { room: 'hidden', text: 'nope' });
    expect(engine.pull(['room:hidden'], 0).changes).toEqual([]);
  });

  it('writes nothing for tables that do not sync, and nothing when the mutation fails', async () => {
    const { engine, m, batches } = setup();
    await m('log');
    await expect(m('fail')).rejects.toThrow('boom');
    await tick();
    expect(batches).toEqual([]);
    expect(engine.pull(['room:a'], 0)).toEqual({ seq: 0, changes: [], more: false });
  });

  it('pages on whole commits', async () => {
    const { engine, m } = setup();
    for (let i = 0; i < 5; i++) {await m('add', { room: 'a', text: `n${i}` });}
    const first = engine.pull(['room:a'], 0, 2);
    expect(first).toMatchObject({ seq: 2, more: true });
    const rest = engine.pull(['room:a'], first.seq, 10);
    expect(rest).toMatchObject({ seq: 5, more: false });
    expect(rest.changes.map((c) => c.doc?.text)).toEqual(['n2', 'n3', 'n4']);
  });
});

describe('documents in several groups', () => {
  const schema = defineSchema({ chats: table<{ people: Array<string>; text: string }>({ sync: { group: (c) => c.people.map((p) => `user:${p}`) } }) });
  const data = defineData({
    schema,
    functions: ({ mutation }) => ({
      add: mutation((ctx, a: { people: Array<string>; text: string }) => ctx.db.insert('chats', a)),
      set: mutation((ctx, a: { id: string; people: Array<string> }) => void ctx.db.patch('chats', a.id, { people: a.people })),
    }),
  });

  it('puts a shared document in each reader group, and leaves a delete marker for one who leaves', async () => {
    const engine = data.engine(memoryStorage());
    engine.init();
    const id = (await engine.run('mutation', 'add', { people: ['ann', 'bo'], text: 'hi' })) as string;
    expect(engine.pull(['user:ann'], 0).changes).toHaveLength(1);
    expect(engine.pull(['user:bo'], 0).changes).toHaveLength(1);
    await engine.run('mutation', 'set', { id, people: ['ann'] });
    expect(engine.pull(['user:bo'], 1).changes).toEqual([{ table: 'chats', id, group: 'user:bo', doc: null }]);
    expect(engine.pull(['user:ann'], 1).changes[0].doc).toMatchObject({ people: ['ann'] });
  });
});
