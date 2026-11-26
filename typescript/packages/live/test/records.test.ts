import { createLiveQueryCollection, eq } from '@tanstack/db';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ContractEvent } from '@builtbyfriends/realtime';
import { createRecords } from '../src/records.js';
import type { EventTransport } from '../src/records.js';
import { notes, notesWorld } from './fixtures/notes.js';

function fakeTransport() {
  const topics = new Map<string, Set<(event: unknown) => void>>();
  const reconnects = new Set<() => void>();
  const transport: EventTransport = {
    subscribe: (topic, cb) => {
      (topics.get(topic) ?? topics.set(topic, new Set()).get(topic)!).add(cb);
      return () => void topics.get(topic)!.delete(cb);
    },
    onReconnect: (cb) => (reconnects.add(cb), () => void reconnects.delete(cb)),
  };
  return {
    transport,
    deliver: (event: ContractEvent) => topics.get(event.topic)?.forEach((cb) => cb(event)),
    reconnect: () => reconnects.forEach((cb) => cb()),
    listeners: (topic: string) => topics.get(topic)?.size ?? 0,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function setup() {
  const world = notesWorld();
  const net = fakeTransport();
  world.module.events.subscribe((e) => net.deliver(e));
  const records = createRecords({ contract: notes, client: world.client, transport: net.transport });
  const spec = {
    key: 'id',
    version: 'updatedAt',
    reads: { list: { boardId: 'boardId' }, get: { id: 'id' } },
    upserts: ['renamed'],
  } as const;
  const note = records.recordCollection('Note', spec);
  const rename = records.command('rename', { records: note, spec }, {
    optimistic: ({ id, title }) =>
      note.collection.update(id, (d) => {
        d.title = title;
      }),
  });
  const list = createLiveQueryCollection((q) => q.from({ n: note.collection }).where(({ n }) => eq(n.boardId, 'b-1')));
  const one = createLiveQueryCollection((q) => q.from({ n: note.collection }).where(({ n }) => eq(n.id, 'n-1')));
  return { world, net, note, rename, list, one };
}

describe('a record shared by a list and a single view', () => {
  it('loads through the contract reads and shares one record', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    t.world.store.add('n-2', 'b-1', 'Second');
    await t.list.preload();
    await t.one.preload();
    expect(t.list.toArray.map((n) => n.title).sort()).toEqual(['First', 'Second']);
    expect(t.one.toArray.map((n) => n.title)).toEqual(['First']);
  });

  it('renames in both at once, and rolls back in both when the command fails', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    await t.one.preload();
    const intent = t.rename({ id: 'n-1', title: 'Renamed' });
    expect(t.list.toArray[0]?.title).toBe('Renamed');
    expect(t.one.toArray[0]?.title).toBe('Renamed');
    await intent.settled;
    expect(t.one.toArray[0]?.title).toBe('Renamed');
    expect(t.world.store.notes.get('n-1')?.title).toBe('Renamed');

    t.world.store.failNextRename = 'TITLE_TAKEN';
    const bad = t.rename({ id: 'n-1', title: 'Nope' });
    expect(t.list.toArray[0]?.title).toBe('Nope');
    expect(t.one.toArray[0]?.title).toBe('Nope');
    await expect(bad.settled).rejects.toMatchObject({ code: 'TITLE_TAKEN' });
    expect(t.list.toArray[0]?.title).toBe('Renamed');
    expect(t.one.toArray[0]?.title).toBe('Renamed');
  });

  it('keeps the newest record when events arrive twice or out of order', async () => {
    const t = setup();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    const mk = (title: string, updatedAt: string): ContractEvent => ({
      module: 'notes', name: 'renamed', event: 'notes.renamed', topic: 'boards:b-1:notes', payload: { ...a, title, updatedAt },
    });
    const v2 = mk('Two', '2026-11-26T12:00:00.100Z');
    const v3 = mk('Three', '2026-11-26T12:00:00.200Z');
    t.net.deliver(v3);
    await settle();
    t.net.deliver(v2);
    t.net.deliver(v3);
    await settle();
    expect(t.list.toArray[0]?.title).toBe('Three');
  });

  it('a retried command with the same request id changes nothing', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    const first = t.rename({ id: 'n-1', title: 'Once' });
    await first.settled;
    const again = t.rename({ id: 'n-1', title: 'Once' }, { requestId: first.requestId });
    await again.settled;
    expect(t.world.store.renameCalls).toBe(1);
  });

  it('loads again on reconnect and catches what it missed', async () => {
    const t = setup();
    t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    t.world.store.notes.set('n-1', { ...t.world.store.notes.get('n-1')!, title: 'Missed', updatedAt: t.world.store.stamp() });
    t.net.reconnect();
    await settle();
    expect(t.list.toArray[0]?.title).toBe('Missed');
  });

  it('applies an event that arrives while a command is out, and the newest record wins', async () => {
    const t = setup();
    const a = t.world.store.add('n-1', 'b-1', 'First');
    await t.list.preload();
    const intent = t.rename({ id: 'n-1', title: 'Mine' });
    t.net.deliver({ module: 'notes', name: 'renamed', event: 'notes.renamed', topic: 'boards:b-1:notes', payload: { ...a, title: 'Theirs', updatedAt: '2026-12-01T00:00:00.000Z' } });
    await intent.settled;
    await settle();
    expect(t.list.toArray[0]?.title).toBe('Theirs');
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
          const delivered = picks.map((p) => versions[p % versions.length]!);
          for (const v of delivered) {
            t.net.deliver({ module: 'notes', name: 'renamed', event: 'notes.renamed', topic: 'boards:b-1:notes', payload: { ...first, title: `v${v}`, updatedAt: at(v) } });
          }
          await settle();
          expect(t.list.toArray[0]?.title).toBe(`v${Math.max(...delivered)}`);
        },
      ),
      { numRuns: 80 },
    );
  });
});
