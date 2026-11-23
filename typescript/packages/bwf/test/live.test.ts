import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineData, defineSchema, table } from '@builtbyfriends/realtime-data';
import { createLive } from '@builtbyfriends/realtime-live';
import { publishTopics, topicPolicy } from '../src/data.js';
import { bwfTransport, fetchEventSource, type ConnectLiveStream } from '../src/live.js';
import { memoryStorage } from '../../data/test/storage.js';

function fakeHost() {
  const subs = new Map<string, Map<string, (event: any) => void>>();
  let sources: any[] = [];
  const connect: ConnectLiveStream = (_url, options) => {
    const open = () => {
      const source = new options!.eventSource!('/live?connectionId=x', { withCredentials: true });
      sources.push(source);
      queueMicrotask(() => source.dispatch('open'));
    };
    open();
    return {
      subscribe: async ({ id, topic, onEvent }) => {
        (subs.get(topic) ?? subs.set(topic, new Map()).get(topic)!).set(id, onEvent!);
        return async () => void subs.get(topic)!.delete(id);
      },
      close: () => {},
      reconnect: open,
    } as any;
  };
  return {
    connect,
    publish: (topic: string) => subs.get(topic)?.forEach((cb) => cb({ topic, type: 'changed', data: null })),
    count: (topic: string) => subs.get(topic)?.size ?? 0,
    sources: () => sources,
  };
}

class FakeEventSource {
  handlers = new Map<string, Array<() => void>>();
  constructor(readonly url: string, readonly init?: unknown) {}
  addEventListener(type: string, cb: () => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), cb]);
  }
  dispatch(type: string) {
    this.handlers.get(type)?.forEach((cb) => cb());
  }
}

beforeEach(() => void ((globalThis as any).EventSource = FakeEventSource));
afterEach(() => void delete (globalThis as any).EventSource);

describe('bwfTransport', () => {
  it('opens one kept-open stream, routes events by topic, and unsubscribes', async () => {
    const v = fakeHost();
    const connect = vi.fn(v.connect);
    const t = bwfTransport({ connect });
    const a = vi.fn();
    const b = vi.fn();
    const stopA = await t.subscribe('x', a);
    await t.subscribe('y', b);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]![1]).toMatchObject({ keepOpen: true, withCredentials: true });
    v.publish('x');
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 0]);
    stopA();
    await Promise.resolve();
    expect(v.count('x')).toBe(0);
  });

  it('shares one bwf subscription per topic, and drops it after the last listener stops', async () => {
    const v = fakeHost();
    const t = bwfTransport({ connect: v.connect });
    const heard = vi.fn();
    const stops = await Promise.all(Array.from({ length: 300 }, () => t.subscribe('x', heard)));
    expect(v.count('x')).toBe(1);
    v.publish('x');
    expect(heard).toHaveBeenCalledTimes(300);
    for (const stop of stops.slice(1)) stop();
    await Promise.resolve();
    expect(v.count('x')).toBe(1);
    stops[0]!();
    await Promise.resolve();
    expect(v.count('x')).toBe(0);
    await t.subscribe('x', heard);
    expect(v.count('x')).toBe(1);
  });

  it('fails the query when bwf refuses the topic, and asks again for the next one', async () => {
    const v = fakeHost();
    let refuse = true;
    const connect: ConnectLiveStream = (url, options) => {
      const stream = v.connect(url, options);
      return {
        ...stream,
        subscribe: (o) => (refuse ? Promise.reject(new Error('FORBIDDEN')) : stream.subscribe(o)),
      };
    };
    const t = bwfTransport({ connect });
    await expect(t.subscribe('x', () => {})).rejects.toThrow('FORBIDDEN');
    refuse = false;
    await t.subscribe('x', () => {});
    expect(v.count('x')).toBe(1);
  });

  it('reports a reconnect only for opens after the first', async () => {
    const v = fakeHost();
    const t = bwfTransport({ connect: v.connect });
    const reconnected = vi.fn();
    t.onReconnect(reconnected);
    await t.subscribe('x', () => {});
    await Promise.resolve();
    expect(reconnected).not.toHaveBeenCalled();
    v.sources()[0].dispatch('open');
    expect(reconnected).toHaveBeenCalledTimes(1);
  });
});

describe('bwfTransport with headers', () => {
  it('opens the stream through a fetch based source that sends the headers, and skips cookies', async () => {
    const connect = vi.fn<ConnectLiveStream>(() => ({ subscribe: async () => async () => {}, close: () => {} }));
    const headers = () => ({ authorization: 'Bearer t1' });
    const t = bwfTransport({ connect, headers });
    await t.subscribe('x', () => {});
    const options = connect.mock.calls[0]![1]!;
    expect(options.headers).toBe(headers);
    expect(options.withCredentials).toBe(false);
    expect(options.eventSource).toBeDefined();
  });
});

describe('fetchEventSource', () => {
  const sse = (text: string) => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };

  it('sends headers, then emits open, message frames and a final error when the stream ends', async () => {
    const fetchMock = vi.fn(async () => sse(': connected\n\nevent: message\ndata: {"topic":"a"}\n\ndata: x\r\ndata: y\r\n\n'));
    const Source = fetchEventSource({ headers: async () => ({ authorization: 'Bearer t' }), fetch: fetchMock as any });
    const seen: string[] = [];
    const source = new Source('/live?connectionId=c');
    for (const type of ['open', 'message', 'error']) source.addEventListener(type, (e: any) => seen.push(e.data ? `${type}:${e.data}` : type));
    await vi.waitFor(() => expect(seen).toContain('error'));
    expect(seen).toEqual(['open', 'message:{"topic":"a"}', 'message:x\ny', 'error']);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('/live?connectionId=c');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer t');
    expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
  });

  it('reports an error for a refused stream', async () => {
    const Source = fetchEventSource({ headers: {}, fetch: (async () => new Response('no', { status: 401 })) as any });
    const source = new Source('/live');
    const error = vi.fn();
    source.addEventListener('error', error);
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  });
});

describe('topicPolicy', () => {
  const policy = topicPolicy([
    { pattern: /^messages:channel:(.+)$/, allow: ([, channel], ctx) => ctx.user === `member-of-${channel}` },
    { pattern: /^public$/, allow: () => true },
  ]);
  const ctx = (topic: string, user: unknown = null) => ({ topic, user, owner: null, env: {}, request: new Request('http://x') });

  it('allows a matching rule that agrees, refuses everything else', async () => {
    expect(await policy(ctx('public'))).toBeUndefined();
    expect(await policy(ctx('messages:channel:a', 'member-of-a'))).toBeUndefined();
    expect((await policy(ctx('messages:channel:a', 'member-of-b')))?.status).toBe(403);
    expect((await policy(ctx('secrets')))?.status).toBe(403);
    expect((await policy(ctx('xmessages:channel:a', 'member-of-a')))?.status).toBe(403);
  });

  it('says which topics a client could ever subscribe to', () => {
    expect(policy.subscribable('public')).toBe(true);
    expect(policy.subscribable('messages:channel:a')).toBe(true);
    expect(policy.subscribable('messages')).toBe(false);
    expect(policy.subscribable('messages:9f1c')).toBe(false);
    expect(policy.subscribable('xmessages:channel:a')).toBe(false);
  });

  it('gives the same answer each time for a pattern with the g or y flag', async () => {
    const flagged = topicPolicy([
      { pattern: /^public$/g, allow: () => true },
      { pattern: /^open$/y, allow: () => true },
    ]);
    for (let i = 0; i < 4; i++) {
      expect(await flagged(ctx('public'))).toBeUndefined();
      expect(await flagged(ctx('open'))).toBeUndefined();
      expect(flagged.subscribable('public')).toBe(true);
    }
  });
});

describe('publishTopics', () => {
  it('publishes only the topics `only` lets through, and nothing when none are left', async () => {
    const published: string[] = [];
    const withEnv = vi.fn(() => ({ publish: async (topic: string) => void published.push(topic) }));
    const onCommit = publishTopics({ withEnv }, { only: (t) => t.startsWith('messages:channel:') });
    await onCommit(['messages', 'messages:1', 'messages:channel:a'], {});
    expect(published).toEqual(['messages:channel:a']);
    await onCommit(['messages', 'messages:2'], {});
    expect(withEnv).toHaveBeenCalledTimes(1);
  });
});

describe('data layer to live query, end to end', () => {
  it('a mutation commits, its topics publish, and a watching query refetches the new rows', async () => {
    const v = fakeHost();
    const published: string[] = [];
    const live = {
      withEnv: () => ({
        publish: async (topic: string) => {
          published.push(topic);
          v.publish(topic);
        },
      }),
    };
    const data = defineData({
      schema: defineSchema({ messages: table<{ channel: string; body: string }>({ indexes: { by_channel: ['channel'] }, topics: (m) => [`messages:channel:${m.channel}`] }) }),
      functions: ({ query, mutation }) => ({
        send: mutation((ctx, a: { channel: string; body: string }) => ctx.db.insert('messages', a)),
        list: query((ctx, a: { channel: string }) => ctx.db.query('messages').withIndex('by_channel', (q) => q.eq('channel', a.channel)).collect().map((m) => m.body)),
      }),
      onCommit: publishTopics(live),
    });
    const engine = data.engine(memoryStorage());
    engine.init();
    const client = {
      call: (name: string, input: any) => engine.run(name === 'messages.send' ? 'mutation' : 'query', name === 'messages.send' ? 'send' : 'list', input),
    };

    vi.useFakeTimers();
    const store = createLive<any>({ client, transport: bwfTransport({ connect: v.connect }), topics: { 'messages.list': (i: any) => [`messages:channel:${i.channel}`] }, debounceMs: 10 });
    const q = store.query('messages.list', { channel: 'general' });
    q.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(q.getSnapshot().data).toEqual([]);

    await store.mutate('messages.send', { channel: 'general', body: 'hello' });
    await store.mutate('messages.send', { channel: 'random', body: 'elsewhere' });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();

    expect(q.getSnapshot().data).toEqual(['hello']);
    expect(published).toContain('messages:channel:general');
  });
});
