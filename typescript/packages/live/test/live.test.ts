import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLive, stableKey, type LiveTransport } from '../src/index.js';

function fakeTransport() {
  const topics = new Map<string, Set<() => void>>();
  const reconnects = new Set<() => void>();
  const transport: LiveTransport = {
    subscribe: async (topic, cb) => {
      (topics.get(topic) ?? topics.set(topic, new Set()).get(topic)!).add(cb);
      return () => void topics.get(topic)!.delete(cb);
    },
    onReconnect: (cb) => (reconnects.add(cb), () => void reconnects.delete(cb)),
  };
  return {
    transport,
    emit: (topic: string) => topics.get(topic)?.forEach((cb) => cb()),
    reconnect: () => reconnects.forEach((cb) => cb()),
    listeners: (topic: string) => topics.get(topic)?.size ?? 0,
    reconnectListeners: () => reconnects.size,
  };
}

const flush = async () => {
  await vi.advanceTimersByTimeAsync(60);
};

describe('live store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(extra: Partial<Parameters<typeof createLive>[0]> = {}) {
    let n = 0;
    const call = vi.fn(async (name: string, input: any) => ({ name, input, n: ++n }));
    const t = fakeTransport();
    const live = createLive<any>({ client: { call }, transport: t.transport, topics: { 'messages.list': (i: any) => [`messages:channel:${i.channel}`] }, ...extra });
    return { call, t, live };
  }

  it('fetches on first listener, exposes loading then ready, and subscribes to the default topics', async () => {
    const { call, t, live } = setup();
    const q = live.query('messages.list', { channel: 'a' });
    expect(q.getSnapshot()).toMatchObject({ status: 'loading', data: undefined });
    const seen = vi.fn();
    const stop = q.subscribe(seen);
    await flush();
    expect(q.getSnapshot()).toMatchObject({ status: 'ready', data: { n: 1 }, fetching: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(t.listeners('messages:channel:a')).toBe(1);
    stop();
    expect(t.listeners('messages:channel:a')).toBe(0);
    expect(t.reconnectListeners()).toBe(0);
  });

  it('refetches on an event, keeps the old data meanwhile, and collapses a burst into one fetch', async () => {
    const { call, t, live } = setup();
    const q = live.query('messages.list', { channel: 'a' });
    q.subscribe(() => {});
    await flush();
    for (let i = 0; i < 5; i++) t.emit('messages:channel:a');
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().data).toMatchObject({ n: 2 });
  });

  it('refetches on reconnect, and runs once more when an event lands during a fetch', async () => {
    const { call, t, live } = setup();
    const gates: Array<() => void> = [];
    call.mockImplementation((name: string) => new Promise((res) => gates.push(() => res({ name, n: gates.length }))));
    const q = live.query('messages.list', { channel: 'a' });
    q.subscribe(() => {});
    await flush();
    t.reconnect();
    await flush();
    expect(call).toHaveBeenCalledTimes(1);
    gates[0]!();
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
    gates[1]!();
    await flush();
    expect(q.getSnapshot()).toMatchObject({ status: 'ready', data: { n: 2 }, fetching: false });
  });

  it('shares one fetch between watchers of the same query, even with keys in another order', async () => {
    const { call, live } = setup();
    const a = live.query('thing', { x: 1, y: 2 } as any, { topics: [] });
    const b = live.query('thing', { y: 2, x: 1 } as any, { topics: [] });
    a.subscribe(() => {});
    b.subscribe(() => {});
    await flush();
    expect(call).toHaveBeenCalledTimes(1);
    expect(stableKey({ b: 1, a: { d: 1, c: 2 } })).toBe(stableKey({ a: { c: 2, d: 1 }, b: 1 }));
  });

  it('keeps last good data on an error and recovers on the next event', async () => {
    const { call, t, live } = setup();
    const q = live.query('messages.list', { channel: 'a' });
    q.subscribe(() => {});
    await flush();
    call.mockRejectedValueOnce(new Error('down'));
    t.emit('messages:channel:a');
    await flush();
    expect(q.getSnapshot()).toMatchObject({ status: 'error', data: { n: 1 }, error: { message: 'down' } });
    t.emit('messages:channel:a');
    await flush();
    expect(q.getSnapshot()).toMatchObject({ status: 'ready' });
  });

  it('stays idle when disabled, and a topic override replaces the defaults', async () => {
    const { call, t, live } = setup();
    const off = live.query('messages.list', { channel: 'a' }, { enabled: false });
    off.subscribe(() => {});
    await flush();
    expect(call).not.toHaveBeenCalled();
    const custom = live.query('messages.list', { channel: 'a' }, { topics: ['messages'] });
    custom.subscribe(() => {});
    await flush();
    expect(t.listeners('messages')).toBe(1);
    expect(t.listeners('messages:channel:a')).toBe(0);
  });

  it('shows cached data on remount, then refetches, and forgets after cacheMs', async () => {
    const { call, live } = setup({ cacheMs: 1000 });
    const first = live.query('messages.list', { channel: 'a' });
    const stop = first.subscribe(() => {});
    await flush();
    stop();
    const again = live.query('messages.list', { channel: 'a' });
    expect(again.getSnapshot()).toMatchObject({ status: 'ready', data: { n: 1 } });
    again.subscribe(() => {})();
    await vi.advanceTimersByTimeAsync(1500);
    expect(live.query('messages.list', { channel: 'a' }).getSnapshot().status).toBe('loading');
    void call;
  });

  it('drops a subscription that resolves after the watcher left', async () => {
    const { t, live } = setup();
    const slow: LiveTransport = { ...t.transport, subscribe: (topic, cb) => new Promise((res) => setTimeout(() => res(t.transport.subscribe(topic, cb) as any), 200)) };
    const l = createLive<any>({ client: { call: async () => 1 }, transport: slow, topics: { x: () => ['t'] } });
    const stop = l.query('x', {}).subscribe(() => {});
    stop();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(t.listeners('t')).toBe(0);
    void live;
  });

  it('mutate calls the procedure and refetchAll refreshes watched queries', async () => {
    const { call, live } = setup();
    const q = live.query('messages.list', { channel: 'a' });
    q.subscribe(() => {});
    await flush();
    await expect(live.mutate('messages.send', { body: 'x' })).resolves.toMatchObject({ name: 'messages.send' });
    await live.refetchAll();
    expect(call).toHaveBeenCalledTimes(3);
  });

  describe('optimistic updates', () => {
    function chat() {
      let messages = ['hi'];
      let fail = false;
      const call = vi.fn(async (name: string, input: any) => {
        if (name === 'messages.list') return [...messages];
        await new Promise((r) => setTimeout(r, 100));
        if (fail) throw new Error('refused');
        messages = [...messages, input.body];
        return null;
      });
      const live = createLive<any>({ client: { call }, transport: fakeTransport().transport, topics: { 'messages.list': () => ['messages'] } });
      const q = live.query('messages.list', { channel: 'a' });
      q.subscribe(() => {});
      const optimistic = (body: string) => ({
        optimistic: (store: any) => store.update('messages.list', { channel: 'a' }, (list: string[]) => [...list, body]),
      });
      return { live, q, call, optimistic, refuse: () => void (fail = true) };
    }

    it('shows the change at once, then the server answer', async () => {
      const { live, q, optimistic } = chat();
      await flush();
      const sent = live.mutate('messages.send', { body: 'yo' }, optimistic('yo'));
      expect(q.getSnapshot().data).toEqual(['hi', 'yo']);
      await vi.advanceTimersByTimeAsync(150);
      await sent;
      await flush();
      expect(q.getSnapshot()).toMatchObject({ status: 'ready', data: ['hi', 'yo'] });
    });

    it('puts the query back when the call fails', async () => {
      const { live, q, optimistic, refuse } = chat();
      await flush();
      refuse();
      const sent = live.mutate('messages.send', { body: 'yo' }, optimistic('yo'));
      const failed = expect(sent).rejects.toThrow('refused');
      expect(q.getSnapshot().data).toEqual(['hi', 'yo']);
      await vi.advanceTimersByTimeAsync(150);
      await failed;
      expect(q.getSnapshot().data).toEqual(['hi']);
    });

    it('leaves queries alone that it was not asked to change, or that have no data yet', async () => {
      const { live, optimistic } = chat();
      const other = live.query('messages.list', { channel: 'b' });
      other.subscribe(() => {});
      const sent = live.mutate('messages.send', { body: 'yo' }, optimistic('yo'));
      expect(other.getSnapshot().status).toBe('loading');
      await vi.advanceTimersByTimeAsync(150);
      await sent;
    });
  });

  it('update changes a ready answer in place, and refetch reaches only matching inputs', async () => {
    const { call, live } = setup();
    const a = live.query('messages.list', { channel: 'a' });
    const b = live.query('messages.list', { channel: 'b' });
    let heard = 0;
    a.subscribe(() => void heard++);
    b.subscribe(() => {});
    await flush();
    const before = call.mock.calls.length;
    const seen = heard;
    live.update('messages.list', (data: any, input: any) => (input.channel === 'a' ? { ...data, patched: true } : undefined));
    expect(a.getSnapshot().data).toMatchObject({ patched: true });
    expect(b.getSnapshot().data).not.toHaveProperty('patched');
    expect(heard).toBe(seen + 1);
    expect(call.mock.calls.length).toBe(before);
    await live.refetch('messages.list', (i: any) => i.channel === 'b');
    expect(call.mock.calls.length).toBe(before + 1);
  });

  describe('reported races', () => {
    function gated() {
      const gates: Array<(v: unknown) => void> = [];
      const call = vi.fn(() => new Promise((res) => gates.push(res)));
      const t = fakeTransport();
      const live = createLive<any>({ client: { call }, transport: t.transport, topics: { 'messages.list': () => ['messages'] } });
      return { gates, call, t, live };
    }

    it('keeps one fetch running when an old fetch ends after the watcher left and came back', async () => {
      const { gates, call, t, live } = gated();
      const q = live.query('messages.list', {});
      const stop = q.subscribe(() => {});
      await flush();
      stop();
      q.subscribe(() => {});
      await flush();
      expect(call).toHaveBeenCalledTimes(2);
      gates[0]!('old');
      await flush();
      t.emit('messages');
      await flush();
      expect(call).toHaveBeenCalledTimes(2);
      gates[1]!('new');
      await flush();
      expect(call).toHaveBeenCalledTimes(3);
    });

    it('undoes optimistic changes and sends nothing when the optimistic callback throws', async () => {
      const call = vi.fn(async (name: string) => (name === 'messages.list' ? ['hi'] : null));
      const live = createLive<any>({ client: { call }, transport: fakeTransport().transport, topics: { 'messages.list': () => ['messages'] } });
      const q = live.query('messages.list', { channel: 'a' });
      q.subscribe(() => {});
      await flush();
      const sent = live.mutate('messages.send', {}, {
        optimistic: (store: any) => {
          store.update('messages.list', { channel: 'a' }, (list: string[]) => [...list, 'yo']);
          throw new Error('bad guess');
        },
      });
      await expect(sent).rejects.toThrow('bad guess');
      expect(q.getSnapshot().data).toEqual(['hi']);
      expect(call.mock.calls.some(([name]) => name === 'messages.send')).toBe(false);
    });

    it('starts an enabled watcher that mounts after a disabled one on the same query', async () => {
      const { call, live } = setup();
      live.query('messages.list', { channel: 'a' }, { enabled: false }).subscribe(() => {});
      const on = live.query('messages.list', { channel: 'a' });
      on.subscribe(() => {});
      await flush();
      expect(call).toHaveBeenCalledTimes(1);
      expect(on.getSnapshot().status).toBe('ready');
    });

    it('resolves refetch only after a fetch that started after the call', async () => {
      const { gates, call, live } = gated();
      const q = live.query('messages.list', {});
      q.subscribe(() => {});
      await flush();
      let done = false;
      const p = q.refetch().then(() => void (done = true));
      gates[0]!('stale');
      await flush();
      expect(call).toHaveBeenCalledTimes(2);
      expect(done).toBe(false);
      gates[1]!('fresh');
      await p;
      expect(q.getSnapshot().data).toBe('fresh');
    });

    it('does not let an earlier gc timer cut the cache window short', async () => {
      const { live } = setup({ cacheMs: 1000 });
      const stop = live.query('messages.list', { channel: 'a' }).subscribe(() => {});
      await flush();
      stop();
      await vi.advanceTimersByTimeAsync(500);
      live.query('messages.list', { channel: 'a' }, { enabled: false }).subscribe(() => {})();
      await vi.advanceTimersByTimeAsync(600);
      expect(live.query('messages.list', { channel: 'a' }).getSnapshot().status).toBe('ready');
    });

    it('does not let an old entry delete a newer one with the same key', async () => {
      const { live } = setup({ cacheMs: 1000 });
      const old = live.query('messages.list', { channel: 'a' });
      old.subscribe(() => {})();
      await vi.advanceTimersByTimeAsync(1500);
      const fresh = live.query('messages.list', { channel: 'a' });
      fresh.subscribe(() => {});
      await flush();
      old.subscribe(() => {})();
      await vi.advanceTimersByTimeAsync(1500);
      expect(live.query('messages.list', { channel: 'a' }).getSnapshot().status).toBe('ready');
    });

    it('ignores an event that reaches an entry after its last watcher left', async () => {
      const { call, t, live } = setup();
      let late = () => {};
      const slow: LiveTransport = { ...t.transport, subscribe: (topic, cb) => ((late = cb), t.transport.subscribe(topic, cb)) };
      const l = createLive<any>({ client: { call }, transport: slow, topics: { x: () => ['t'] } });
      const stop = l.query('x', {}).subscribe(() => {});
      await flush();
      stop();
      const before = call.mock.calls.length;
      late();
      await flush();
      expect(call.mock.calls.length).toBe(before);
      void live;
    });
  });

  describe('review fixes', () => {
    it('refetches at maxWaitMs while events keep coming, then starts the wait over', async () => {
      const { call, t, live } = setup({ debounceMs: 50, maxWaitMs: 200 });
      live.query('messages.list', { channel: 'a' }).subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(call).toHaveBeenCalledTimes(1);
      const stream = async (from: number, to: number) => {
        for (let at = from; at < to; at += 10) {
          t.emit('messages:channel:a');
          await vi.advanceTimersByTimeAsync(10);
        }
      };
      await stream(0, 190);
      expect(call).toHaveBeenCalledTimes(1);
      await stream(190, 200);
      expect(call).toHaveBeenCalledTimes(2);
      await stream(200, 390);
      expect(call).toHaveBeenCalledTimes(2);
      await stream(390, 400);
      expect(call).toHaveBeenCalledTimes(3);
    });

    it('reports a disabled, never started query as idle, and an enabled one as fetching', async () => {
      const { call, live } = setup();
      const off = live.query('messages.list', { channel: 'a' }, { enabled: false });
      expect(off.getSnapshot()).toEqual({ status: 'loading', data: undefined, error: undefined, fetching: false });
      expect(off.getSnapshot()).toBe(off.getSnapshot());
      off.subscribe(() => {});
      await flush();
      expect(call).not.toHaveBeenCalled();
      expect(off.getSnapshot().fetching).toBe(false);
      const on = live.query('messages.list', { channel: 'b' });
      expect(on.getSnapshot()).toMatchObject({ status: 'loading', fetching: true });
    });

    it('puts a collected entry back when a held handle subscribes, so update and refetch still reach it', async () => {
      const { call, live } = setup({ cacheMs: 1000 });
      const held = live.query('messages.list', { channel: 'a' });
      held.subscribe(() => {})();
      await vi.advanceTimersByTimeAsync(1500);
      held.subscribe(() => {});
      await flush();
      expect(call).toHaveBeenCalledTimes(2);
      live.update('messages.list', (data: any) => ({ ...data, patched: true }));
      expect(held.getSnapshot().data).toMatchObject({ patched: true });
      const fresh = live.query('messages.list', { channel: 'a' });
      expect(fresh.getSnapshot()).toBe(held.getSnapshot());
      await live.refetch('messages.list');
      expect(call).toHaveBeenCalledTimes(3);
    });

    it('collects an entry whose handle never subscribed', async () => {
      const { live } = setup({ cacheMs: 1000 });
      const unwatched = live.query('messages.list', { channel: 'a' });
      await unwatched.refetch();
      expect(live.query('messages.list', { channel: 'a' }).getSnapshot().status).toBe('ready');
      await vi.advanceTimersByTimeAsync(1500);
      expect(live.query('messages.list', { channel: 'a' }).getSnapshot().status).toBe('loading');
    });

    it('stops when the last enabled listener leaves even if a disabled one stays, and does not collect while listeners remain', async () => {
      const { call, t, live } = setup({ cacheMs: 1000 });
      const on = live.query('messages.list', { channel: 'a' }).subscribe(() => {});
      const off = live.query('messages.list', { channel: 'a' }, { enabled: false });
      const offStop = off.subscribe(() => {});
      await flush();
      expect(t.listeners('messages:channel:a')).toBe(1);
      call.mockImplementationOnce(() => new Promise(() => {}));
      t.emit('messages:channel:a');
      await flush();
      expect(off.getSnapshot()).toMatchObject({ status: 'ready', fetching: true });
      on();
      expect(off.getSnapshot()).toMatchObject({ status: 'ready', fetching: false });
      expect(t.listeners('messages:channel:a')).toBe(0);
      await vi.advanceTimersByTimeAsync(1500);
      expect(live.query('messages.list', { channel: 'a' }).getSnapshot().status).toBe('ready');
      offStop();
    });

    it('a disabled subscribe clears a pending collection timer', async () => {
      const { live } = setup({ cacheMs: 1000 });
      const stop = live.query('messages.list', { channel: 'a' }).subscribe(() => {});
      await flush();
      stop();
      live.query('messages.list', { channel: 'a' }, { enabled: false }).subscribe(() => {});
      await vi.advanceTimersByTimeAsync(1500);
      expect(live.query('messages.list', { channel: 'a' }).getSnapshot().status).toBe('ready');
    });

    it('shares one entry between topic lists that are equal as sets', async () => {
      const { call, live } = setup();
      live.query('thing', {} as any, { topics: ['b', 'a', 'a'] }).subscribe(() => {});
      live.query('thing', {} as any, { topics: ['a', 'b'] }).subscribe(() => {});
      await flush();
      expect(call).toHaveBeenCalledTimes(1);
    });

    function slowChat() {
      let messages = ['hi'];
      let failList = false;
      const failSend = new Set<string>();
      const call = vi.fn(async (name: string, input: any) => {
        await new Promise((r) => setTimeout(r, name === 'messages.send' && failSend.has(input.body) ? 50 : name === 'messages.send' ? 200 : 100));
        if (name === 'messages.list') {
          if (failList) throw new Error('list down');
          return [...messages];
        }
        if (failSend.has(input.body)) throw new Error('refused');
        messages = [...messages, input.body];
        return null;
      });
      const live = createLive<any>({ client: { call } });
      const q = live.query('messages.list', { channel: 'a' });
      const stop = q.subscribe(() => {});
      const opt = (body: string) => ({ optimistic: (store: any) => store.update('messages.list', { channel: 'a' }, (l: string[]) => [...l, body]) });
      return { live, q, stop, opt, failSend, failList: () => void (failList = true) };
    }

    it('does not show a guess as data when a refetch fails after a rollback to another guess', async () => {
      const { live, q, opt, failSend, failList } = slowChat();
      await vi.advanceTimersByTimeAsync(150);
      failSend.add('b');
      const a = live.mutate('messages.send', { body: 'a' }, opt('a'));
      const b = live.mutate('messages.send', { body: 'b' }, opt('b'));
      const bFailed = expect(b).rejects.toThrow('refused');
      expect(q.getSnapshot().data).toEqual(['hi', 'a', 'b']);
      failList();
      await vi.advanceTimersByTimeAsync(60);
      await bFailed;
      expect(q.getSnapshot().data).toEqual(['hi', 'a']);
      await vi.advanceTimersByTimeAsync(300);
      await a;
      await vi.advanceTimersByTimeAsync(300);
      expect(q.getSnapshot()).toMatchObject({ status: 'error', data: ['hi', 'a'] });
    });

    it('hides the guess of a mutation that is still pending when a fetch fails', async () => {
      const { live, q, opt, failList } = slowChat();
      await vi.advanceTimersByTimeAsync(150);
      const sent = live.mutate('messages.send', { body: 'a' }, opt('a'));
      failList();
      await vi.advanceTimersByTimeAsync(20);
      void live.refetch('messages.list');
      await vi.advanceTimersByTimeAsync(110);
      expect(q.getSnapshot()).toMatchObject({ status: 'error', data: ['hi'] });
      await vi.advanceTimersByTimeAsync(300);
      await sent;
    });

    it('keeps the guess of a mutation that succeeded when nothing watched the entry and a later fetch fails', async () => {
      const { live, stop, opt, failList } = slowChat();
      await vi.advanceTimersByTimeAsync(150);
      stop();
      const sent = live.mutate('messages.send', { body: 'yo' }, opt('yo'));
      await vi.advanceTimersByTimeAsync(250);
      await sent;
      failList();
      const again = live.query('messages.list', { channel: 'a' });
      again.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(150);
      expect(again.getSnapshot()).toMatchObject({ status: 'error', data: ['hi', 'yo'] });
    });

    it('applies update() to the settled data too while a guess is held', async () => {
      const { live, q, opt, failList } = slowChat();
      await vi.advanceTimersByTimeAsync(150);
      const sent = live.mutate('messages.send', { body: 'a' }, opt('a'));
      live.update('messages.list', (list: string[]) => [...list, 'synced']);
      failList();
      await vi.advanceTimersByTimeAsync(20);
      void live.refetch('messages.list');
      await vi.advanceTimersByTimeAsync(110);
      expect(q.getSnapshot()).toMatchObject({ status: 'error', data: ['hi', 'synced'] });
      await vi.advanceTimersByTimeAsync(300);
      await sent;
    });

    it('replaces a guess held by an unwatched entry when it is watched again', async () => {
      const { live, stop, opt } = slowChat();
      await vi.advanceTimersByTimeAsync(150);
      stop();
      const sent = live.mutate('messages.send', { body: 'yo' }, opt('yo'));
      await vi.advanceTimersByTimeAsync(250);
      await sent;
      const again = live.query('messages.list', { channel: 'a' });
      again.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(150);
      expect(again.getSnapshot()).toMatchObject({ status: 'ready', data: ['hi', 'yo'], fetching: false });
    });
  });
});
