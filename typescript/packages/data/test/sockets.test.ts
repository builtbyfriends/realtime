import { describe, expect, it } from 'vitest';
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
  return { sent, send: (m: string) => void sent.push(JSON.parse(m)), serializeAttachment: (v: unknown) => void (attachment = v), deserializeAttachment: () => attachment };
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
    const all: ReturnType<typeof fakeSocket>[] = [];
    const sockets = new SyncSockets(
      { acceptWebSocket: (ws: any) => void all.push(ws), getWebSockets: () => all },
      { pull: (_a, g, after, l) => engine.pull(g, after, l), topicAccess: (a, t) => engine.topicAccess(a, t), query: (a, n, i) => engine.liveQuery(a, n, i) },
    );
    engine.onTopics((t) => sockets.publish(t));
    engine.onRecheck(() => sockets.recheck());
    const m = (name: string, args: unknown) => engine.run('mutation', name, args);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { sockets, m, tick };
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
