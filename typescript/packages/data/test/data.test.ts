import { describe, expect, it, vi } from 'vitest';
import { defineData, defineSchema, table } from '../src/index.js';
import { memoryStorage } from './storage.js';

type Message = { channel: string; author: string; body: string; at: number; pinned?: boolean; embedding?: number[] };

const schema = defineSchema({
  messages: table<Message>({
    indexes: { by_channel: ['channel', 'at'] },
    search: { body: { field: 'body', filters: ['channel'] } },
    vectors: { embedding: { field: 'embedding', dimensions: 3, filters: ['channel'] } },
    topics: (m) => [`messages:channel:${m.channel}`],
  }),
});

function setup(options: { onCommit?: (topics: string[]) => void; seed?: boolean } = {}) {
  const calls: string[] = [];
  const data = defineData({
    schema,
    functions: ({ query, mutation }) => ({
      send: mutation((ctx, a: { channel: string; body: string; at?: number }) =>
        ctx.db.insert('messages', { channel: a.channel, author: 'ann', body: a.body, at: a.at ?? ctx.now }),
      ),
      sendThenFail: mutation((ctx, a: { channel: string }) => {
        ctx.db.insert('messages', { channel: a.channel, author: 'x', body: 'lost', at: 1 });
        ctx.scheduler.runAfter(1000, 'ping', { n: 1 });
        throw new Error('boom');
      }),
      edit: mutation((ctx, a: { id: string; body: string }) => ctx.db.patch('messages', a.id, { body: a.body })),
      remove: mutation((ctx, a: { id: string }) => ctx.db.delete('messages', a.id)),
      later: mutation((ctx, a: { ms: number; id?: string }) => ctx.scheduler.runAfter(a.ms, 'ping', { n: 1 }, { id: a.id })),
      cancel: mutation((ctx, a: { id: string }) => ctx.scheduler.cancel(a.id)),
      list: query((ctx, a: { channel: string; limit: number }) =>
        ctx.db.query('messages').withIndex('by_channel', (q) => q.eq('channel', a.channel)).order('desc').take(a.limit).map((m) => m.body),
      ),
      since: query((ctx, a: { channel: string; at: number }) =>
        ctx.db.query('messages').withIndex('by_channel', (q) => q.eq('channel', a.channel).gte('at', a.at)).collect().map((m) => m.body),
      ),
      find: query((ctx, a: { text: string; channel?: string }) =>
        ctx.db.search('messages', 'body', a.text, { eq: a.channel ? { channel: a.channel } : undefined }).map((m) => m.body),
      ),
      nearest: query((ctx, a: { v: number[]; channel?: string }) =>
        ctx.db.vectorSearch('messages', 'embedding', a.v, { eq: a.channel ? { channel: a.channel } : undefined, limit: 2 }).map((r) => r.doc.body),
      ),
      embed: mutation((ctx, a: { id: string; v: number[] }) => ctx.db.patch('messages', a.id, { embedding: a.v })),
      count: query((ctx) => ctx.db.query('messages').collect().length),
    }),
    jobs: (job) => ({
      ping: job((ctx, a: { n: number }) => {
        calls.push(`ping:${a.n}:${ctx.attempt}`);
      }),
      flaky: job(() => {
        calls.push('flaky');
        throw new Error('nope');
      }),
      slow: job(
        async () => {
          calls.push('slow:start');
          await new Promise((r) => setTimeout(r, 300));
          calls.push('slow:end');
        },
        { concurrent: true },
      ),
      hang: job(() => new Promise<void>(() => {})),
      quick: job(() => {
        calls.push('quick');
      }),
      cascade: job(async (ctx) => {
        await ctx.data.mutate.send({ channel: 'jobs', body: 'from a job' });
      }),
    }),
    onCommit: options.onCommit ? (topics) => options.onCommit!(topics) : undefined,
    maxJobAttempts: 2,
    laneMs: 50,
  });
  const storage = memoryStorage();
  const engine = data.engine(storage);
  engine.init();
  const call = {
    q: (name: string, args?: unknown) => engine.run('query', name, args) as Promise<any>,
    m: (name: string, args?: unknown) => engine.run('mutation', name, args) as Promise<any>,
  };
  return { call, engine, storage, calls, data };
}

describe('documents and indexes', () => {
  it('inserts, reads through an index in both directions and takes a limit', async () => {
    const { call } = setup();
    for (let i = 1; i <= 4; i++) await call.m('send', { channel: 'general', body: `m${i}`, at: i });
    await call.m('send', { channel: 'other', body: 'x', at: 9 });
    expect(await call.q('list', { channel: 'general', limit: 2 })).toEqual(['m4', 'm3']);
    expect(await call.q('since', { channel: 'general', at: 3 })).toEqual(['m3', 'm4']);
  });

  it('patches, removes a field set to undefined, and deletes', async () => {
    const { call, engine } = setup();
    const id = await call.m('send', { channel: 'a', body: 'one', at: 1 });
    await call.m('edit', { id, body: 'two' });
    expect(await call.q('list', { channel: 'a', limit: 5 })).toEqual(['two']);
    await call.m('remove', { id });
    expect(await call.q('count')).toBe(0);
    await expect(engine.run('mutation', 'remove', { id })).rejects.toThrow(/no document/);
  });

  it('rejects an index query that skips a field', async () => {
    const { storage } = setup();
    const { DbReader } = await import('../src/index.js');
    const db = new DbReader(storage, schema);
    expect(() => db.query('messages').withIndex('by_channel', (q) => q.gte('at', 1))).toThrow(/expects "channel"/);
  });

  it('rolls back writes and scheduled jobs when a mutation throws', async () => {
    const { call, storage } = setup();
    await expect(call.m('sendThenFail', { channel: 'a' })).rejects.toThrow('boom');
    expect(await call.q('count')).toBe(0);
    expect(storage.alarm()).toBeNull();
  });
});

describe('schema sync', () => {
  it('skips the pass on a wake with the same schema, and runs it when the schema changed', async () => {
    const { syncSchema } = await import('../src/index.js');
    const { storage } = setup();
    const statements: string[] = [];
    const exec = storage.sql.exec.bind(storage.sql);
    storage.sql.exec = (query: string, ...bindings: unknown[]) => (statements.push(query), exec(query, ...bindings));
    syncSchema(storage, schema);
    expect(statements).toHaveLength(2);
    statements.length = 0;
    const changed = defineSchema({ messages: table<Message>({ ...schema.messages, indexes: { ...schema.messages.indexes, by_author: ['author'] } }) });
    syncSchema(storage, changed);
    expect(statements.some((q) => q.includes('by_author'))).toBe(true);
    statements.length = 0;
    syncSchema(storage, changed);
    expect(statements).toHaveLength(2);
  });
});

describe('index clean-up', () => {
  it('keeps the indexes of a table whose name starts with another table\'s name', async () => {
    const { syncSchema } = await import('../src/index.js');
    const storage = memoryStorage();
    const indexes = () => storage.sql.exec(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'i\\_%' ESCAPE '\\' ORDER BY name`).toArray().map((r: { name: string }) => r.name.replace(/_[a-z0-9]+$/, ''));
    const first = defineSchema({
      message_reaction: table<{ message: string }>({ indexes: { by_message: ['message'] } }),
      message: table<{ author: string; channel: string }>({ indexes: { by_author: ['author'], by_channel: ['channel'] } }),
    });
    syncSchema(storage, first);
    expect(indexes()).toEqual(['i_message_by_author', 'i_message_by_channel', 'i_message_reaction_by_message']);
    syncSchema(storage, defineSchema({ message_reaction: first.message_reaction, message: table<{ author: string; channel: string }>({ indexes: { by_author: ['author'] } }) }));
    expect(indexes()).toEqual(['i_message_by_author', 'i_message_reaction_by_message']);
  });
});

describe('schema edges', () => {
  type Note = { owner: string; body: string; tag?: string | null; v?: number[] };
  const notes = (extra: object = {}) => defineSchema({ notes: table<Note>({ indexes: { by_owner: ['owner'], by_tag: ['tag'] }, ...extra }) });
  const fns = ({ query, mutation }: any) => ({
    add: mutation((ctx: any, a: Note) => ctx.db.insert('notes', a)),
    find: query((ctx: any, text: string) => ctx.db.search('notes', 'body', text).map((n: Note) => n.body)),
    near: query((ctx: any, v: number[]) => ctx.db.vectorSearch('notes', 'v', v).map((r: { doc: Note }) => r.doc.body)),
    untagged: query((ctx: any) => ctx.db.query('notes').withIndex('by_tag', (q: any) => q.eq('tag', undefined)).collect().map((n: Note) => n.body)),
    twice: query((ctx: any) => ctx.db.query('notes').withIndex('by_owner', (q: any) => q.eq('owner', 'ann')).withIndex('by_tag').collect()),
  });
  const open = (storage: ReturnType<typeof memoryStorage>, extra: object = {}) => {
    const engine = defineData({ schema: notes(extra), functions: fns }).engine(storage);
    engine.init();
    return engine;
  };

  it('refuses a second index on one query, which used to drop the first one\'s conditions', async () => {
    await expect(open(memoryStorage()).run('query', 'twice', undefined)).rejects.toThrow('walks one index');
  });

  it('reads eq(field, undefined) as a missing field, like null', async () => {
    const engine = open(memoryStorage());
    await engine.run('mutation', 'add', { owner: 'ann', body: 'plain' });
    await engine.run('mutation', 'add', { owner: 'ann', body: 'tagged', tag: 't' });
    expect(await engine.run('query', 'untagged', undefined)).toEqual(['plain']);
  });

  it('builds a search index again when it comes back after being removed', async () => {
    const storage = memoryStorage();
    const search = { search: { body: { field: 'body' } } };
    await open(storage, search).run('mutation', 'add', { owner: 'ann', body: 'first note' });
    await open(storage).run('mutation', 'add', { owner: 'ann', body: 'second note' });
    expect(await open(storage, search).run('query', 'find', 'note')).toHaveLength(2);
  });

  it('leaves a stored vector of another length out of a rebuilt index', async () => {
    const storage = memoryStorage();
    await open(storage, { vectors: { v: { field: 'v', dimensions: 2 } } }).run('mutation', 'add', { owner: 'ann', body: 'old', v: [1, 0] });
    const engine = open(storage, { vectors: { v: { field: 'v', dimensions: 3 } } });
    await engine.run('mutation', 'add', { owner: 'ann', body: 'new', v: [1, 0, 0] });
    expect(await engine.run('query', 'near', [1, 0, 0])).toEqual(['new']);
  });

  it('refuses two names that would share one SQLite name', () => {
    const clash = defineSchema({ a: table<{ x: string }>({ indexes: { b_c: ['x'] } }), a_b: table<{ x: string }>({ indexes: { c: ['x'] } }) });
    expect(() => defineData({ schema: clash, functions: () => ({}) }).engine(memoryStorage()).init()).toThrow('would share the name "i_a_b_c"');
  });
});

describe('search and vectors', () => {
  it('ranks full text matches, matches prefixes, filters by channel, and follows edits and deletes', async () => {
    const { call } = setup();
    const a = await call.m('send', { channel: 'dev', body: 'deploying the worker to production' });
    await call.m('send', { channel: 'dev', body: 'lunch plans' });
    await call.m('send', { channel: 'ops', body: 'worker queue is backed up' });
    expect((await call.q('find', { text: 'worker' })).sort()).toEqual(['deploying the worker to production', 'worker queue is backed up']);
    expect(await call.q('find', { text: 'worker', channel: 'ops' })).toEqual(['worker queue is backed up']);
    expect(await call.q('find', { text: 'prod' })).toEqual(['deploying the worker to production']);
    expect(await call.q('find', { text: 'AND OR "' })).toEqual([]);
    await call.m('edit', { id: a, body: 'rollback finished' });
    expect(await call.q('find', { text: 'production' })).toEqual([]);
    expect(await call.q('find', { text: 'rollback' })).toEqual(['rollback finished']);
    await call.m('remove', { id: a });
    expect(await call.q('find', { text: 'rollback' })).toEqual([]);
  });

  it('finds the nearest vectors by cosine, with a filter', async () => {
    const { call } = setup();
    const x = await call.m('send', { channel: 'a', body: 'x axis' });
    const y = await call.m('send', { channel: 'a', body: 'y axis' });
    const z = await call.m('send', { channel: 'b', body: 'near x, other channel' });
    await call.m('embed', { id: x, v: [1, 0, 0] });
    await call.m('embed', { id: y, v: [0, 1, 0] });
    await call.m('embed', { id: z, v: [0.9, 0.1, 0] });
    expect(await call.q('nearest', { v: [1, 0, 0] })).toEqual(['x axis', 'near x, other channel']);
    expect(await call.q('nearest', { v: [1, 0, 0], channel: 'a' })).toEqual(['x axis', 'y axis']);
    await expect(call.q('nearest', { v: [1, 0] })).rejects.toThrow(/dimensions/);
  });

  it('rebuilds a search index from the documents when its definition changes', async () => {
    const { call, storage } = setup();
    await call.m('send', { channel: 'a', body: 'hello world' });
    const { defineData: d } = await import('../src/index.js');
    const changed = d({
      schema: defineSchema({ messages: table<Message>({ search: { body: { field: 'author' } } }) }),
      functions: ({ query }) => ({ find: query((ctx) => ctx.db.search('messages', 'body', 'ann').map((m) => m.body)) }),
    }).engine(storage);
    changed.init();
    expect(await changed.run('query', 'find', undefined)).toEqual(['hello world']);
  });
});

describe('live topics', () => {
  it('reports table, document and custom topics after a commit, and none for a rollback or a read', async () => {
    const onCommit = vi.fn();
    const { call } = setup({ onCommit });
    const id = await call.m('send', { channel: 'general', body: 'hi' });
    expect(onCommit.mock.calls[0]![0].sort()).toEqual(['messages', `messages:${id}`, 'messages:channel:general'].sort());
    await call.q('count');
    await expect(call.m('sendThenFail', { channel: 'x' })).rejects.toThrow();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('answers a mutation without waiting for the publish to finish', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const onCommit = vi.fn(() => pending);
    const { call } = setup({ onCommit });
    await expect(call.m('send', { channel: 'general', body: 'hi' })).resolves.toBeTypeOf('string');
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    finish();
  });

  it('does not fail a mutation when publishing throws', async () => {
    const { call } = setup({ onCommit: () => { throw new Error('down'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(call.m('send', { channel: 'a', body: 'x' })).resolves.toBeTypeOf('string');
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith('onCommit failed', expect.any(Error)));
    err.mockRestore();
  });
});

describe('scheduler', () => {
  it('arms the alarm for the earliest job, runs due jobs, and clears the alarm', async () => {
    const { call, engine, storage, calls } = setup();
    const before = Date.now();
    await call.m('later', { ms: 60_000 });
    await call.m('later', { ms: 5_000 });
    expect(storage.alarm()).toBeGreaterThanOrEqual(before + 5_000);
    expect(storage.alarm()).toBeLessThan(before + 10_000);
    await engine.alarm();
    expect(calls).toEqual([]);
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    await engine.alarm();
    vi.useRealTimers();
    expect(calls).toEqual(['ping:1:1', 'ping:1:1']);
    expect(storage.alarm()).toBeNull();
  });

  it('cancels a pending job, and a job id replaces the pending one', async () => {
    const { call, engine, storage, calls } = setup();
    const id = await call.m('later', { ms: 1000 });
    expect(await call.m('cancel', { id })).toBe(true);
    expect(await call.m('cancel', { id })).toBe(false);
    expect(storage.alarm()).toBeNull();
    await call.m('later', { ms: 50_000, id: 'debounce' });
    await call.m('later', { ms: 1_000, id: 'debounce' });
    expect(storage.db.prepare('SELECT COUNT(*) AS n FROM _jobs').get()).toEqual({ n: 1 });
    vi.useFakeTimers({ now: Date.now() + 2_000 });
    await engine.alarm();
    vi.useRealTimers();
    expect(calls).toEqual(['ping:1:1']);
  });

  it('retries a failing job with backoff, then parks it as failed', async () => {
    const { engine, storage, calls } = setup();
    const scheduler = engine.scheduler();
    scheduler.runAfter(0, 'flaky', null, { id: 'f' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await engine.alarm();
    expect(scheduler.get('f')).toMatchObject({ status: 'pending', attempts: 1, error: 'nope' });
    expect(storage.alarm()).toBeGreaterThan(Date.now());
    vi.useFakeTimers({ now: Date.now() + 10_000 });
    await engine.alarm();
    vi.useRealTimers();
    err.mockRestore();
    expect(scheduler.get('f')).toMatchObject({ status: 'failed', attempts: 2 });
    expect(calls).toEqual(['flaky', 'flaky']);
    expect(storage.alarm()).toBeNull();
  });

  it("doesn't let a long concurrent job hold up the jobs behind it, and still runs plain jobs one at a time", async () => {
    const { engine, calls } = setup();
    const scheduler = engine.scheduler();
    scheduler.runAfter(0, 'slow', null, { id: 's1' });
    scheduler.runAfter(0, 'slow', null, { id: 's2' });
    scheduler.runAfter(0, 'quick', null, { id: 'q' });
    await engine.alarm();
    expect(calls).toEqual(['slow:start', 'slow:start', 'quick', 'slow:end', 'slow:end']);
    expect(scheduler.get('s1')).toBeNull();
    expect(scheduler.get('q')).toBeNull();
  });

  it("lets a plain job that hangs give up the lane, so the next one runs", async () => {
    const { engine, calls } = setup();
    const scheduler = engine.scheduler();
    scheduler.runAfter(0, 'hang', null, { id: 'h' });
    scheduler.runAfter(0, 'quick', null, { id: 'q' });
    const alarm = engine.alarm();
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toEqual(['quick']);
    expect(scheduler.get('q')).toBeNull();
    void alarm;
  });

  it('runs a job left pending by a restart once the object starts', async () => {
    const { engine, storage, calls } = setup();
    engine.scheduler().runAfter(0, 'quick', null, { id: 'left' });
    await storage.deleteAlarm();
    expect(storage.alarm()).toBeNull();
    await engine.rearm();
    expect(storage.alarm()).not.toBeNull();
    await engine.alarm();
    expect(calls).toEqual(['quick']);
  });

  it('lets a job call data functions, and rejects unknown job names', async () => {
    const { call, engine } = setup();
    engine.scheduler().runAfter(0, 'cascade');
    await engine.alarm();
    expect(await call.q('list', { channel: 'jobs', limit: 1 })).toEqual(['from a job']);
    expect(() => engine.scheduler().runAfter(0, 'missing')).toThrow(/no job named/);
  });
});

describe('a job that takes the object down', () => {
  it('counts the run as an attempt before the handler starts, and parks the job once they are used up', async () => {
    const { engine, calls } = setup();
    engine.scheduler().runAfter(0, 'hang', null, { id: 'h' });
    const crashed = () => {
      void engine.alarm();
      return new Promise((r) => setTimeout(r, 5));
    };
    await crashed();
    expect(engine.scheduler().get('h')).toMatchObject({ status: 'pending', attempts: 1 });
    await crashed();
    expect(engine.scheduler().get('h')).toMatchObject({ status: 'pending', attempts: 2 });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await crashed();
    logged.mockRestore();
    expect(engine.scheduler().get('h')).toMatchObject({ status: 'failed', error: expect.stringContaining('stopped before it finished') });
    expect(calls).toEqual([]);
  });
});

describe('client', () => {
  it('calls a Durable Object namespace by name and types functions from their definitions', async () => {
    const { data, engine } = setup();
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({ run: (kind: 'query' | 'mutation', name: string, args: unknown) => engine.run(kind, name, args), job: async () => null }),
    };
    const client = data.client(ns);
    const id = await client.mutate.send({ channel: 'c', body: 'typed' });
    expect(typeof id).toBe('string');
    expect(await client.query.list({ channel: 'c', limit: 1 })).toEqual(['typed']);
    expect(await client.query.count()).toBe(1);
    // @ts-expect-error unknown function
    expect(() => client.query.nope).not.toThrow();
  });
});
