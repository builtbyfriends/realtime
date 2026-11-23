import { describe, expect, it, vi } from 'vitest';
import { defineData, defineSchema, SyncSockets, table } from '../src/index.js';
import { memoryStorage } from './storage.js';

const schema = defineSchema({
  notes: table<{ room: string; text: string }>({ sync: { group: (n) => `room:${n.room}` } }),
});

function setup() {
  const data = defineData({ schema, functions: ({ mutation }) => ({ add: mutation((ctx, a: { room: string; text: string }) => ctx.db.insert('notes', a)) }) });
  const engine = data.engine(memoryStorage());
  engine.init();
  const all: { tags: string[]; ws: ReturnType<typeof fakeSocket> }[] = [];
  const state = {
    acceptWebSocket: (ws: any, tags: string[] = []) => void all.push({ ws, tags }),
    getWebSockets: (tag?: string) => all.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
  };
  const sockets = new SyncSockets(state, (g, a, l) => engine.pull(g, a, l));
  engine.listen((batch) => sockets.broadcast(batch));
  const add = (room: string, text: string) => engine.run('mutation', 'add', { room, text });
  return { sockets, add };
}

function fakeSocket() {
  let attachment: unknown = null;
  const sent: any[] = [];
  const closed: number[] = [];
  return { sent, closed, close: (code = 1000) => void closed.push(code), send: (m: string) => void sent.push(JSON.parse(m)), serializeAttachment: (v: unknown) => void (attachment = v), deserializeAttachment: () => attachment };
}

describe('sync sockets', () => {
  it('sends each socket only the changes in its groups', async () => {
    const { sockets, add } = setup();
    const a = fakeSocket();
    const b = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: ['room:x'] });
    sockets.accept(b, { actor: 'bo', groups: ['room:y'] });
    await add('x', 'hello');
    expect(a.sent).toEqual([{ type: 'changes', seq: 1, changes: [expect.objectContaining({ group: 'room:x', doc: expect.objectContaining({ text: 'hello' }) })] }]);
    expect(b.sent).toEqual([]);
  });

  it('answers a pull, and tells a socket about groups it gained and lost', async () => {
    const { sockets, add } = setup();
    await add('x', 'one');
    await add('y', 'two');
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: ['room:x'] });
    expect(sockets.message(a, JSON.stringify({ type: 'pull', after: 0, id: 7 }))).toBe(true);
    expect(a.sent[0]).toMatchObject({ type: 'pull', id: 7, seq: 2, more: false, changes: [{ group: 'room:x' }] });
    sockets.regroup('ann', ['room:y']);
    expect(a.sent[1]).toEqual({ type: 'groups', added: ['room:y'], removed: ['room:x'] });
    await add('x', 'unseen');
    expect(a.sent).toHaveLength(2);
    expect(sockets.message(a, 'not json')).toBe(false);
  });
});

describe('watching groups', () => {
  type Note = { room: string; text: string; likes: string[] };
  const schema = defineSchema({
    notes: table<Note>({
      sync: { group: (n) => `room:${n.room}`, view: (n, { actor }) => (n.room === 'secret' ? null : { text: n.text, mine: n.likes.includes(actor) }) },
    }),
    members: table<{ room: string; user: string }>({ indexes: { by_user: ['user', 'room'] } }),
  });

  function setup() {
    const data = defineData({
      schema,
      functions: ({ mutation }) => ({
        add: mutation((ctx, a: Note) => ctx.db.insert('notes', a)),
        join: mutation((ctx, a: { room: string; user: string }) => void ctx.db.insert('members', a)),
        leave: mutation((ctx, a: { room: string; user: string }) => {
          const row = ctx.db.query('members').withIndex('by_user', (q) => q.eq('user', a.user).eq('room', a.room)).first();
          if (row) ctx.db.delete('members', row._id);
        }),
      }),
      syncAccess: (ctx, actor, group) => !!ctx.db.query('members').withIndex('by_user', (q) => q.eq('user', actor).eq('room', group.slice(5))).first(),
      syncRecheck: (topics) => topics.includes('members'),
    });
    const engine = data.engine(memoryStorage());
    engine.init();
    const all: { tags: string[]; ws: ReturnType<typeof fakeSocket> }[] = [];
    const state = {
      acceptWebSocket: (ws: any, tags: string[] = []) => void all.push({ ws, tags }),
      getWebSockets: (tag?: string) => all.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
    };
    const sockets = new SyncSockets(state, { pull: (_a, g, after, l) => engine.pull(g, after, l), view: (a, c) => engine.view(a, c), access: (a, g) => engine.access(a, g) });
    engine.listen((batch) => sockets.broadcast(batch));
    engine.onRecheck(() => sockets.recheck());
    const m = (name: string, args: unknown) => engine.run('mutation', name, args);
    return { sockets, m };
  }

  it('lets a device watch only the groups it may read, and sends each reader its own view', async () => {
    const { sockets, m } = setup();
    await m('join', { room: 'x', user: 'ann' });
    await m('add', { room: 'x', text: 'before', likes: ['ann'] });
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.message(a, JSON.stringify({ type: 'watch', groups: ['room:x', 'room:y'], id: 1 }));
    expect(a.sent[0]).toEqual({ type: 'watching', id: 1, groups: ['room:x'], denied: ['room:y'], seq: 1, changes: [], more: false });
    await m('add', { room: 'x', text: 'hi', likes: ['bo'] });
    await m('add', { room: 'y', text: 'not yours', likes: [] });
    expect(a.sent[1]).toMatchObject({ type: 'changes', seq: 2, changes: [{ group: 'room:x', doc: { text: 'hi', mine: false } }] });
    expect(a.sent).toHaveLength(2);
    sockets.message(a, JSON.stringify({ type: 'watch', groups: ['room:x'], after: 0, id: 2 }));
    expect(a.sent[2]).toMatchObject({ type: 'watching', id: 2, seq: 3, changes: [{ doc: { text: 'before', mine: true } }, { doc: { text: 'hi' } }] });
    sockets.message(a, JSON.stringify({ type: 'unwatch', groups: ['room:x'] }));
    await m('add', { room: 'x', text: 'after', likes: [] });
    expect(a.sent).toHaveLength(3);
  });

  it('drops a group once the reader loses access, and leaves out what a view hides', async () => {
    const { sockets, m } = setup();
    await m('join', { room: 'x', user: 'ann' });
    await m('join', { room: 'secret', user: 'ann' });
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.message(a, JSON.stringify({ type: 'watch', groups: ['room:x', 'room:secret'], id: 1 }));
    await m('add', { room: 'secret', text: 'hidden', likes: [] });
    expect(a.sent).toHaveLength(1);
    await m('leave', { room: 'x', user: 'ann' });
    expect(a.sent[1]).toEqual({ type: 'groups', added: [], removed: ['room:x'] });
    await m('add', { room: 'x', text: 'gone', likes: [] });
    expect(a.sent).toHaveLength(2);
  });
});

describe('live topics over the socket', () => {
  const schema = defineSchema({
    pins: table<{ room: string }>({ topics: (p) => [`pins:room:${p.room}`] }),
    members: table<{ room: string; user: string }>({ indexes: { by_user: ['user', 'room'] } }),
  });

  function setup() {
    const data = defineData({
      schema,
      functions: ({ mutation }) => ({
        pin: mutation((ctx, a: { room: string }) => void ctx.db.insert('pins', a)),
        join: mutation((ctx, a: { room: string; user: string }) => void ctx.db.insert('members', a)),
        leave: mutation((ctx, a: { room: string; user: string }) => {
          const row = ctx.db.query('members').withIndex('by_user', (q) => q.eq('user', a.user).eq('room', a.room)).first();
          if (row) ctx.db.delete('members', row._id);
        }),
      }),
      syncTopics: (ctx, actor, topic) => !!ctx.db.query('members').withIndex('by_user', (q) => q.eq('user', actor).eq('room', topic.split(':')[2]!)).first(),
      syncRecheck: (topics) => topics.includes('members'),
    });
    const engine = data.engine(memoryStorage());
    engine.init();
    const all: { tags: string[]; ws: ReturnType<typeof fakeSocket> }[] = [];
    const state = {
      acceptWebSocket: (ws: any, tags: string[] = []) => void all.push({ ws, tags }),
      getWebSockets: (tag?: string) => all.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
    };
    const sockets = new SyncSockets(state, {
      pull: (_a, g, after, l) => engine.pull(g, after, l),
      topicAccess: (a, t) => engine.topicAccess(a, t),
      epoch: () => engine.epoch(),
    });
    engine.onTopics((t) => sockets.publish(t));
    engine.onRecheck(() => sockets.recheck());
    const m = (name: string, args: unknown) => engine.run('mutation', name, args);
    return { sockets, m, engine };
  }

  it('tells a listener a topic changed, refuses topics it may not hear, and stops once access goes', async () => {
    const { sockets, m, engine } = setup();
    await m('join', { room: 'x', user: 'ann' });
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.message(a, JSON.stringify({ type: 'listen', topics: ['pins:room:x', 'pins:room:y'], id: 1 }));
    expect(a.sent[0]).toEqual({ type: 'listening', id: 1, topics: ['pins:room:x'], denied: ['pins:room:y'] });
    await m('pin', { room: 'x' });
    await m('pin', { room: 'y' });
    expect(a.sent.slice(1)).toEqual([{ type: 'topics', topics: ['pins:room:x'] }]);
    await m('leave', { room: 'x', user: 'ann' });
    expect(a.sent.at(-1)).toEqual({ type: 'unheard', topics: ['pins:room:x'] });
    await m('pin', { room: 'x' });
    expect(a.sent.at(-1)).toEqual({ type: 'unheard', topics: ['pins:room:x'] });
    sockets.message(a, JSON.stringify({ type: 'pull', after: 0, id: 2 }));
    expect(a.sent.at(-1)).toMatchObject({ type: 'pull', epoch: engine.epoch() });
    expect(engine.epoch()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('live queries over the socket', () => {
  const schema = defineSchema({
    pins: table<{ room: string; text: string; secret: string }>({ topics: (p) => [`pins:room:${p.room}`], indexes: { by_room: ['room'] } }),
    members: table<{ room: string; user: string }>({ indexes: { by_user: ['user', 'room'] } }),
  });
  const output = {
    '~standard': {
      validate: (v: unknown) => (Array.isArray(v) ? { value: v.map(({ text }: { text: string }) => ({ text })) } : { issues: [{ message: 'not a list' }] }),
    },
  };

  function setup() {
    const data = defineData({
      schema,
      functions: ({ query, mutation }) => ({
        pin: mutation((ctx, a: { room: string; text: string }) => void ctx.db.insert('pins', { ...a, secret: 's' })),
        join: mutation((ctx, a: { room: string; user: string }) => void ctx.db.insert('members', a)),
        leave: mutation((ctx, a: { room: string; user: string }) => {
          const row = ctx.db.query('members').withIndex('by_user', (q) => q.eq('user', a.user).eq('room', a.room)).first();
          if (row) ctx.db.delete('members', row._id);
        }),
        listPins: query((ctx, a: { room: string; userId: string }) => ctx.db.query('pins').withIndex('by_room', (q) => q.eq('room', a.room)).collect()),
      }),
      syncTopics: (ctx, actor, topic) => !!ctx.db.query('members').withIndex('by_user', (q) => q.eq('user', actor).eq('room', topic.split(':')[2]!)).first(),
      syncRecheck: (topics) => topics.includes('members'),
      syncQuery: (actor, name, input) => (name === 'pins.list' ? { fn: 'listPins', args: { ...(input as object), userId: actor }, output } : null),
    });
    const engine = data.engine(memoryStorage());
    engine.init();
    const runs: string[] = [];
    const all: ReturnType<typeof fakeSocket>[] = [];
    const sockets = new SyncSockets(
      { acceptWebSocket: (ws: any) => void all.push(ws), getWebSockets: () => all },
      { pull: (_a, g, after, l) => engine.pull(g, after, l), topicAccess: (a, t) => engine.topicAccess(a, t), query: (a, n, i) => (runs.push(a), engine.liveQuery(a, n, i)) },
    );
    engine.onTopics((t) => sockets.publish(t));
    engine.onRecheck(() => sockets.recheck());
    const m = (name: string, args: unknown) => engine.run('mutation', name, args);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { sockets, m, tick, runs };
  }

  it('answers a live query, answers again after a commit that touches it, and stops once access goes', async () => {
    const { sockets, m, tick } = setup();
    await m('join', { room: 'x', user: 'ann' });
    await m('pin', { room: 'x', text: 'one' });
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.message(a, JSON.stringify({ type: 'query', id: 'q1', name: 'pins.list', input: { room: 'x' }, topics: ['pins:room:x'] }));
    sockets.message(a, JSON.stringify({ type: 'query', id: 'q2', name: 'pins.list', input: { room: 'y' }, topics: ['pins:room:y'] }));
    sockets.message(a, JSON.stringify({ type: 'query', id: 'q3', name: 'other', input: {}, topics: ['pins:room:x'] }));
    await tick();
    expect(a.sent).toHaveLength(3);
    expect(a.sent).toEqual(expect.arrayContaining([
      { type: 'result', id: 'q1', value: [{ text: 'one' }] },
      { type: 'result', id: 'q2', denied: true },
      { type: 'result', id: 'q3', denied: true },
    ]));
    a.sent.length = 0;
    await m('pin', { room: 'x', text: 'two' });
    await m('pin', { room: 'y', text: 'other room' });
    await tick();
    expect(a.sent).toEqual([{ type: 'result', id: 'q1', value: [{ text: 'one' }, { text: 'two' }] }]);
    await m('leave', { room: 'x', user: 'ann' });
    expect(a.sent.at(-1)).toEqual({ type: 'result', id: 'q1', denied: true });
    const count = a.sent.length;
    await m('pin', { room: 'x', text: 'three' });
    await tick();
    expect(a.sent).toHaveLength(count);
  });

  it('runs a query once for one actor\'s sockets that ask the same thing', async () => {
    const { sockets, m, tick, runs } = setup();
    await m('join', { room: 'x', user: 'ann' });
    await m('join', { room: 'x', user: 'bo' });
    const mine = [fakeSocket(), fakeSocket(), fakeSocket()];
    mine.forEach((ws, i) => {
      sockets.accept(ws, { actor: i === 2 ? 'bo' : 'ann', groups: [] });
      sockets.message(ws, JSON.stringify({ type: 'query', id: 'q', name: 'pins.list', input: { room: 'x' }, topics: ['pins:room:x'] }));
    });
    await tick();
    runs.length = 0;
    await m('pin', { room: 'x', text: 'one' });
    await tick();
    expect(runs).toEqual(['ann', 'bo']);
    for (const ws of mine) expect(ws.sent.at(-1)).toEqual({ type: 'result', id: 'q', value: [{ text: 'one' }] });
  });

  it('refuses a query with no name before the app is asked', async () => {
    const { sockets, tick, runs } = setup();
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.message(a, JSON.stringify({ type: 'query', id: 'q', input: { all: true } }));
    await tick();
    expect(a.sent).toEqual([{ type: 'result', id: 'q', denied: true }]);
    expect(runs).toEqual([]);
  });

  it('sends nothing when the answer is the same, and stops after unquery', async () => {
    const { sockets, m, tick } = setup();
    await m('join', { room: 'x', user: 'ann' });
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.message(a, JSON.stringify({ type: 'query', id: 1, name: 'pins.list', input: { room: 'x' }, topics: ['pins:room:x', 'members'] }));
    await tick();
    expect(a.sent).toEqual([{ type: 'result', id: '1', denied: true }]);
    sockets.message(a, JSON.stringify({ type: 'query', id: 2, name: 'pins.list', input: { room: 'x' }, topics: ['pins:room:x'] }));
    await tick();
    await m('join', { room: 'x', user: 'bob' });
    await tick();
    expect(a.sent.slice(1)).toEqual([{ type: 'result', id: '2', value: [] }]);
    sockets.message(a, JSON.stringify({ type: 'unquery', ids: ['2'] }));
    await m('pin', { room: 'x', text: 'one' });
    await tick();
    expect(a.sent).toHaveLength(2);
  });
});

describe('sockets that go wrong', () => {
  type Note = { room: string; text: string };
  const schema = defineSchema({
    notes: table<Note>({
      sync: {
        group: (n) => `room:${n.room}`,
        view: (n, { actor }) => {
          if (actor === 'bad' && n.text === 'boom') throw new Error('view failed');
          return { text: n.text };
        },
      },
    }),
  });

  function setup() {
    const data = defineData({ schema, functions: ({ mutation }) => ({ add: mutation((ctx, a: Note) => ctx.db.insert('notes', a)) }), syncAccess: () => true });
    const storage = memoryStorage();
    const engine = data.engine(storage);
    engine.init();
    const all: { tags: string[]; ws: ReturnType<typeof fakeSocket> }[] = [];
    const state = {
      acceptWebSocket: (ws: any, tags: string[] = []) => void all.push({ ws, tags }),
      getWebSockets: (tag?: string) => all.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
    };
    const view = (a: string, c: Parameters<typeof engine.view>[1]) => {
      if (a === 'broken') throw new Error('hook failed');
      return engine.view(a, c);
    };
    const sockets = new SyncSockets(state, { pull: (_a, g, after, l) => engine.pull(g, after, l), view, access: (a, g) => engine.access(a, g) });
    engine.listen((batch) => sockets.broadcast(batch));
    return { sockets, storage, add: (room: string, text: string) => engine.run('mutation', 'add', { room, text }) };
  }

  it('closes the socket the object could not serve, and still sends the commit to the sockets after it', async () => {
    const { sockets, add } = setup();
    const bad = fakeSocket();
    const good = fakeSocket();
    sockets.accept(bad, { actor: 'broken', groups: ['room:x'] });
    sockets.accept(good, { actor: 'ann', groups: ['room:x'] });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await add('x', 'hi');
    logged.mockRestore();
    expect(bad.closed).toEqual([1011]);
    expect(bad.sent).toEqual([]);
    expect(good.sent).toMatchObject([{ type: 'changes', seq: 1, changes: [{ doc: { text: 'hi' } }] }]);
  });

  it('closes the socket when answering its message throws, and takes the message as its own', async () => {
    const { sockets, add } = setup();
    await add('x', 'hi');
    const bad = fakeSocket();
    sockets.accept(bad, { actor: 'broken', groups: ['room:x'] });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(sockets.message(bad, JSON.stringify({ type: 'pull', after: 0, id: 1 }))).toBe(true);
    logged.mockRestore();
    expect(bad.closed).toEqual([1011]);
  });

  it('leaves out the one document whose view throws, and sends the rest of the page', async () => {
    const { sockets, add } = setup();
    await add('x', 'boom');
    await add('x', 'fine');
    const a = fakeSocket();
    sockets.accept(a, { actor: 'bad', groups: ['room:x'] });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    sockets.message(a, JSON.stringify({ type: 'pull', after: 0, id: 1 }));
    logged.mockRestore();
    expect(a.closed).toEqual([]);
    expect(a.sent[0]).toMatchObject({ type: 'pull', seq: 2, changes: [{ doc: { text: 'fine' } }] });
    expect(a.sent[0].changes).toHaveLength(1);
  });

  it('refuses a header that does not name an actor and its groups', async () => {
    const data = defineData({ schema, functions: () => ({}) });
    class Base {}
    const Obj = data.durableObject(Base as never) as unknown as new (ctx: unknown, env: unknown) => { fetch(r: Request): Response | Promise<Response> };
    const ctx = { storage: memoryStorage(), blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(), acceptWebSocket: () => {}, getWebSockets: () => [] };
    const object = new Obj(ctx, {});
    for (const header of ['not json', '{"actor":7,"groups":[]}', '{"actor":"ann","groups":"team:1"}', 'null']) {
      const res = await object.fetch(new Request('https://x/sync', { headers: { upgrade: 'websocket', 'x-realtime-sync': header } }));
      expect(res.status).toBe(400);
    }
  });

  it('answers a pull whatever limit the device sends', async () => {
    const { sockets, add } = setup();
    for (let i = 0; i < 3; i++) await add('x', `n${i}`);
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: ['room:x'] });
    for (const limit of [-1, 0, 'many', 1e12, null, 2.5]) sockets.message(a, JSON.stringify({ type: 'pull', after: 0, id: 1, limit }));
    expect(a.closed).toEqual([]);
    expect(a.sent.map((m) => m.changes.length)).toEqual([3, 3, 3, 3, 3, 2]);
    expect(a.sent[5]).toMatchObject({ seq: 2, more: true });
  });

  it('pulls for a socket in more groups than one statement takes parameters', async () => {
    const { sockets, add } = setup();
    await add('r7', 'seven');
    await add('r149', 'last');
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    const groups = Array.from({ length: 150 }, (_, i) => `room:r${i}`);
    sockets.message(a, JSON.stringify({ type: 'watch', groups, after: 0, id: 1 }));
    expect(a.closed).toEqual([]);
    expect(a.sent[0]).toMatchObject({ type: 'watching', seq: 2, changes: [{ doc: { text: 'seven' } }, { doc: { text: 'last' } }] });
    expect(a.sent[0].groups).toHaveLength(150);
  });

  it('splits a pull that would not fit in one message', async () => {
    const { sockets, add } = setup();
    const big = 'x'.repeat(400_000);
    for (let i = 0; i < 4; i++) await add('x', big);
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: ['room:x'] });
    sockets.message(a, JSON.stringify({ type: 'pull', after: 0, id: 1 }));
    expect(a.sent[0]).toMatchObject({ seq: 2, more: true });
    expect(a.sent[0].changes).toHaveLength(2);
    sockets.message(a, JSON.stringify({ type: 'pull', after: 2, id: 2 }));
    expect(a.sent[1]).toMatchObject({ seq: 4, more: false });
    expect(a.sent[1].changes).toHaveLength(2);
  });

  it('leaves a message that is JSON but not an object to the object', () => {
    const { sockets } = setup();
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    for (const raw of ['null', '5', '"pull"', '[]', '{"type":7}']) expect(sockets.message(a, raw)).toBe(false);
  });

  it('closes a socket whose new groups do not fit, instead of stopping at it', () => {
    const { sockets } = setup();
    const a = fakeSocket();
    const b = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.accept(b, { actor: 'ann', groups: [] });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    sockets.regroup('ann', Array.from({ length: 2000 }, (_, i) => `room:${i}-${'x'.repeat(20)}`));
    logged.mockRestore();
    expect(a.closed).toEqual([1011]);
    expect(b.closed).toEqual([1011]);
  });

  it('refuses what a watch asks past the first thousand groups', () => {
    const { sockets } = setup();
    const a = fakeSocket();
    sockets.accept(a, { actor: 'ann', groups: [] });
    sockets.message(a, JSON.stringify({ type: 'watch', groups: Array.from({ length: 1200 }, (_, i) => `r${i}`), id: 1 }));
    expect(a.sent[0].groups).toHaveLength(1000);
    expect(a.sent[0].denied).toHaveLength(200);
  });

  it('still sends a commit to devices when the alarm cannot be set', async () => {
    const data = defineData({
      schema,
      functions: ({ mutation }) => ({ add: mutation((ctx, a: Note) => (ctx.scheduler.runAfter(1000, 'later'), ctx.db.insert('notes', a))) }),
      jobs: (job) => ({ later: job(() => {}) }),
    });
    const storage = memoryStorage();
    storage.setAlarm = () => {
      throw new Error('no alarm');
    };
    const engine = data.engine(storage);
    engine.init();
    const seen: number[] = [];
    engine.listen((batch) => void seen.push(batch.seq));
    await expect(engine.run('mutation', 'add', { room: 'x', text: 'hi' })).rejects.toThrow('no alarm');
    expect(seen).toEqual([1]);
  });
});
