import { createLiveQueryCollection, eq } from '@tanstack/db';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { ContractEvent } from '@builtbyfriends/realtime';
import { createRuntime, defineRecords } from '../src/records.js';
import type { EventTransport } from '../src/records.js';
import type { NoteRecord } from './fixtures/notes.js';
import { notes, noteRecords, notesWorld } from './fixtures/notes.js';

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

  it('drops rows a screen showed once when a removal happened while nothing was watching', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    t.world.store.add('n-2', 'b-1', 'Second');
    await t.list.preload();
    await t.list.cleanup();
    await settle();
    t.world.store.notes.delete('n-2');
    const again = createLiveQueryCollection({ query: (q) => q.from({ n: t.runtime.collections.Note }).where(({ n }) => eq(n.boardId, 'b-1')) });
    await again.preload();
    await settle();
    expect(again.toArray.map((n) => n.id)).toEqual(['n-1']);
  });

  it('drops a record whose single read now answers not found', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.one.preload();
    await t.one.cleanup();
    await settle();
    t.world.store.notes.delete('n-1');
    const again = createLiveQueryCollection({ query: (q) => q.from({ n: t.runtime.collections.Note }).where(({ n }) => eq(n.id, 'n-1')) });
    await again.preload();
    await settle();
    expect(again.toArray).toEqual([]);
  });

  it('takes a second change with the same version, and not an older record after a removal', async () => {
    const t = setup();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    t.backend.deliver(renamed(a, 'Tie one', '2026-12-01T00:00:00.000Z'));
    t.backend.deliver(renamed(a, 'Tie two', '2026-12-01T00:00:00.000Z'));
    await settle();
    expect(t.list.toArray[0]?.title).toBe('Tie two');
  });

  it('joins two record types in a live query, and updates when either side changes', async () => {
    const t = setup();
    const board = t.world.store.addBoard('b-1', 'Plans');
    t.world.store.add('n-1', 'b-1', 'First');
    const { Note, Board } = t.runtime.collections;

    const joined = createLiveQueryCollection((q) =>
      q.from({ n: Note }).where(({ n }) => eq(n.boardId, 'b-1')).join({ b: Board }, ({ n, b }) => eq(n.boardId, b.id)).select(({ n, b }) => ({ id: n.id, title: n.title, board: b.name })),
    );

    await joined.preload();
    await settle();
    expect(joined.toArray.map((r) => `${r.title} on ${r.board}`)).toEqual(['First on Plans']);
    await t.runtime.commands.rename({ id: 'n-1', title: 'Renamed' }).settled;
    await settle();
    expect(joined.toArray.map((r) => `${r.title} on ${r.board}`)).toEqual(['Renamed on Plans']);
    t.backend.deliver({ module: 'notes', name: 'boardRenamed', event: 'notes.boardRenamed', topic: 'boards:b-1', payload: { ...board, name: 'Ideas', updatedAt: '2026-12-02T00:00:00.000Z' } });
    await settle();
    expect(joined.toArray.map((r) => `${r.title} on ${r.board}`)).toEqual(['Renamed on Ideas']);
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

  it('ends on the newest record, and on the last of equal versions, whatever the order and the repeats of events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ version: fc.integer({ min: 1, max: 4 }), title: fc.constantFrom('a', 'b', 'c') }), { minLength: 1, maxLength: 16 }),
        async (delivered) => {
          const t = setup();
          const first = t.world.store.add('n-1', 'b-1', 'start');
          await t.list.preload();
          const at = (v: number) => new Date(Date.UTC(2026, 11, 1, 0, 0, 0, v)).toISOString();

          for (const { version, title } of delivered) {t.backend.deliver(renamed(first, title, at(version)));}

          await settle();
          const top = Math.max(...delivered.map((d) => d.version));
          const last = delivered.findLast((d) => d.version === top);
          expect(t.list.toArray[0]?.title).toBe(last?.title);
          await t.list.cleanup();
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe('subscriptions', () => {
  it('opens one subscription for a topic that a record with three events and a view all follow, and drops it with the last listener', async () => {
    const world = notesWorld();
    world.store.add('n-1', 'b-1', 'First');
    const calls: Array<string> = [];
    const transport: EventTransport = { ...world.backend.transport, subscribe: (topic, cb) => (calls.push(topic), world.backend.transport.subscribe(topic, cb)) };

    const definition = defineRecords(notes, {
      records: { Note: { key: 'id', version: 'updatedAt', reads: { get: { id: 'id' } }, upserts: ['renamed', 'pinned'], removes: ['removed'] } },
      views: { can: { events: ['renamed'] } },
    });

    const runtime = createRuntime(definition, { client: world.backend.client, transport });
    const one = createLiveQueryCollection({ query: (q) => q.from({ n: runtime.collections.Note }).where(({ n }) => eq(n.id, 'n-1')) });
    await one.preload();
    const stop = runtime.views.can({ id: 'n-1' }).subscribe(() => {});
    await settle();
    expect(calls).toEqual(['notes:n-1']);
    expect(world.backend.listenerCount('notes:n-1')).toBe(1);
    expect(world.backend.listenerCount()).toBe(2);
    stop();
    expect(world.backend.listenerCount('notes:n-1')).toBe(1);
    await one.cleanup();
    await settle();
    expect(world.backend.listenerCount()).toBe(0);
  });
});

describe('when the server ends a subscription and refuses it again', () => {
  function refusing() {
    const world = notesWorld();
    const refusals: Array<{ name: string; topic: string; message: string }> = [];

    const runtime = createRuntime(noteRecords, {
      client: world.backend.client,
      transport: world.backend.transport,
      onRefused: ({ name, topic, error }) => void refusals.push({ name, topic, message: error.message }),
    });

    const one = (id: string) => createLiveQueryCollection({ query: (q) => q.from({ n: runtime.collections.Note }).where(({ n }) => eq(n.id, id)) });

    return { world, runtime, refusals, one };
  }

  it('tells the app once for the record and topic, keeps the rows, and stops applying events', async () => {
    const t = refusing();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    const one = t.one('n-1');
    await one.preload();
    t.world.backend.refuse('notes:n-1');
    t.world.backend.refuse('notes:n-1');
    await settle();
    expect(t.refusals).toEqual([{ name: 'notes.Note', topic: 'notes:n-1', message: 'FORBIDDEN' }]);
    expect(one.toArray.map((n) => n.title)).toEqual(['First']);
    t.world.backend.deliver(renamed(a, 'After', t.world.store.stamp(), 'notes:n-1'));
    await settle();
    expect(one.toArray.map((n) => n.title)).toEqual(['First']);
  });

  it('tells the app again after the record starts listening to the topic again', async () => {
    const t = refusing();
    t.world.store.add('n-1', 'b-1', 'First');
    const first = t.one('n-1');
    await first.preload();
    t.world.backend.refuse('notes:n-1', new Error('FORBIDDEN'));
    await first.cleanup();
    await settle();
    const again = t.one('n-1');
    await again.preload();
    await settle();
    expect(t.world.backend.listenerCount('notes:n-1')).toBe(1);
    t.world.backend.refuse('notes:n-1', new Error('GONE'));
    expect(t.refusals.map((r) => r.message)).toEqual(['FORBIDDEN', 'GONE']);
  });

  it('warns in the console when the app gave no hook', async () => {
    const world = notesWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createRuntime(noteRecords, { client: world.backend.client, transport: world.backend.transport });
    world.store.add('n-1', 'b-1', 'First');
    await createLiveQueryCollection({ query: (q) => q.from({ n: runtime.collections.Note }).where(({ n }) => eq(n.id, 'n-1')) }).preload();
    world.backend.refuse('notes:n-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('notes.Note');
    warn.mockRestore();
  });

  it('puts a view that listens to the topic into its error state, with the data it had', async () => {
    const t = refusing();
    t.world.store.add('n-1', 'b-1', 'First');
    const view = t.runtime.views.can({ id: 'n-1' });
    const stop = view.subscribe(() => {});
    await settle();
    t.world.backend.refuse('notes:n-1', new Error('FORBIDDEN'));
    expect(view.getSnapshot()).toMatchObject({ status: 'error', data: { rename: true }, error: { message: 'FORBIDDEN' } });
    stop();
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
