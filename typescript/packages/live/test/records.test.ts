import { createLiveQueryCollection, eq } from '@tanstack/db';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ContractEvent } from '@builtbyfriends/realtime';
import { createRuntime } from '../src/records.js';
import type { NoteRecord } from './fixtures/notes.js';
import { noteRecords, notesWorld } from './fixtures/notes.js';

const settle = () => new Promise((r) => setTimeout(r, 10));

function setup() {
  const world = notesWorld();
  const { backend } = world;
  const runtime = createRuntime(noteRecords, { client: backend.client, transport: backend.transport });
  const { Note } = runtime.collections;
  const list = createLiveQueryCollection({ query: (q) => q.from({ n: Note }).where(({ n }) => eq(n.boardId, 'b-1')) });
  const one = createLiveQueryCollection({ query: (q) => q.from({ n: Note }).where(({ n }) => eq(n.id, 'n-1')) });

  return { world, backend, runtime, list, one };
}

const renamed = (note: NoteRecord, title: string, updatedAt: string, topic = 'boards:b-1:notes'): ContractEvent => ({
  module: 'notes',
  name: 'renamed',
  event: 'notes.renamed',
  topic,
  payload: { ...note, title, updatedAt },
});

describe('a record shared by a list and a single view', () => {
  it('loads through the contract reads and shares one record', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    t.world.store.add('n-2', 'b-1', 'Second');
    await t.list.preload();
    await t.one.preload();
    expect(t.list.toArray.map((n) => n.title).toSorted()).toEqual(['First', 'Second']);
    expect(t.one.toArray.map((n) => n.title)).toEqual(['First']);
  });

  it('renames in both at once, and rolls back in both when the command fails', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    await t.one.preload();
    const intent = t.runtime.commands.rename({ id: 'n-1', title: 'Renamed' });
    expect(t.list.toArray[0]?.title).toBe('Renamed');
    expect(t.one.toArray[0]?.title).toBe('Renamed');
    await intent.settled;
    expect(t.one.toArray[0]?.title).toBe('Renamed');
    expect(t.world.store.notes.get('n-1')?.title).toBe('Renamed');

    t.world.store.failNextRename = 'TITLE_TAKEN';
    const bad = t.runtime.commands.rename({ id: 'n-1', title: 'Nope' });
    expect(t.list.toArray[0]?.title).toBe('Nope');
    expect(t.one.toArray[0]?.title).toBe('Nope');
    const result = await bad.result;
    expect(result.ok === false && result.error.code).toBe('TITLE_TAKEN');
    expect(t.list.toArray[0]?.title).toBe('Renamed');
    expect(t.one.toArray[0]?.title).toBe('Renamed');
  });

  it('keeps the newest record when events arrive twice or out of order', async () => {
    const t = setup();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    const v2 = renamed(a, 'Two', '2026-11-26T12:00:00.100Z');
    const v3 = renamed(a, 'Three', '2026-11-26T12:00:00.200Z');
    t.backend.deliver(v3);
    await settle();
    t.backend.deliver(v2);
    t.backend.deliver(v3);
    await settle();
    expect(t.list.toArray[0]?.title).toBe('Three');
  });

  it('a retried command with the same request id changes nothing', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    const first = t.runtime.commands.rename({ id: 'n-1', title: 'Once' });
    await first.settled;
    await t.runtime.commands.rename({ id: 'n-1', title: 'Once' }, { requestId: first.requestId }).settled;
    expect(t.world.store.renameCalls).toBe(1);
  });

  it('loads again on reconnect and catches what it missed', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    t.world.store.notes.set('n-1', { ...t.world.store.notes.get('n-1')!, title: 'Missed', updatedAt: t.world.store.stamp() });
    t.backend.reconnect();
    await settle();
    expect(t.list.toArray[0]?.title).toBe('Missed');
  });

  it('applies an event that arrives while a command is out, and the newest record wins', async () => {
    const t = setup();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    const intent = t.runtime.commands.rename({ id: 'n-1', title: 'Mine' });
    t.backend.deliver(renamed(a, 'Theirs', '2026-12-01T00:00:00.000Z'));
    await intent.settled;
    await settle();
    expect(t.list.toArray[0]?.title).toBe('Theirs');
  });

  it('drops a record when its removal event arrives, and an older update does not bring it back', async () => {
    const t = setup();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    t.backend.deliver({ module: 'notes', name: 'removed', event: 'notes.removed', topic: 'boards:b-1:notes', payload: { id: 'n-1', boardId: 'b-1' } });
    await settle();
    expect(t.list.toArray).toEqual([]);
    t.backend.deliver(renamed(a, 'Late', a.updatedAt));
    await settle();
    expect(t.list.toArray).toEqual([]);
  });

  it('removes at once with the command, and brings the record back when the command fails', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    const ok = t.runtime.commands.remove({ id: 'n-1' });
    expect(t.list.toArray).toEqual([]);
    await ok.settled;
    expect(t.list.toArray).toEqual([]);
    const missing = t.runtime.commands.remove({ id: 'n-1' });
    const result = await missing.result;
    expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
  });

  it('drops a record that a later read no longer lists', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    t.world.store.add('n-2', 'b-1', 'Second');
    await t.list.preload();
    t.world.store.notes.delete('n-2');
    t.backend.reconnect();
    await settle();
    expect(t.list.toArray.map((n) => n.id)).toEqual(['n-1']);
  });

  it('refuses an answer that does not match the contract', async () => {
    const t = setup();
    const bad = createRuntime(noteRecords, { client: { call: async () => [{ id: 'n-1' }] }, transport: t.backend.transport });
    const q = createLiveQueryCollection({ query: (x) => x.from({ n: bad.collections.Note }).where(({ n }) => eq(n.boardId, 'b-1')) });
    await expect(q.preload()).rejects.toThrow(/doesn't match the contract/);
  });

  it('leaves no listener behind once the queries are cleaned up', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    await t.one.preload();
    expect(t.backend.listenerCount()).toBeGreaterThan(0);
    await t.list.cleanup();
    await t.one.cleanup();
    await settle();
    expect(t.backend.listenerCount()).toBe(0);
  });

  it('ends on the newest record whatever the order and the repeats of events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 20 }),
        async (versions, picks) => {
          const t = setup();
          const first = t.world.store.add('n-1', 'b-1', 'start');
          await t.list.preload();
          const at = (v: number) => new Date(Date.UTC(2026, 11, 1, 0, 0, 0, v)).toISOString();
          const delivered = picks.map((p) => versions[p % versions.length]);

          for (const v of delivered) {t.backend.deliver(renamed(first, `v${v}`, at(v)));}

          await settle();
          expect(t.list.toArray[0]?.title).toBe(`v${Math.max(...delivered)}`);
          await t.list.cleanup();
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('a view that depends on who is asking', () => {
  it('loads, and loads again after a command and after an event', async () => {
    const t = setup();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    const view = t.runtime.views.can({ id: 'n-1' });
    const stop = view.subscribe(() => {});
    await settle();
    expect(view.getSnapshot()).toMatchObject({ status: 'ready', data: { rename: true } });

    await t.runtime.commands.rename({ id: 'n-1', title: 'Locked' }).settled;
    await settle();
    expect(view.getSnapshot().data).toEqual({ rename: false });

    t.world.store.notes.set('n-1', { ...a, title: 'Open again', updatedAt: t.world.store.stamp() });
    t.backend.deliver(renamed(a, 'Open again', t.world.store.stamp(), 'notes:n-1'));
    await settle();
    expect(view.getSnapshot().data).toEqual({ rename: true });

    stop();
    expect(t.backend.listenerCount()).toBe(0);
  });
});
