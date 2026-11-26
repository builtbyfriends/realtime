import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { anyOf, bearerAuth, defineRegistry } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { env, procedure, req } from './fixtures.js';
import type { Env, User } from './fixtures.js';

const shaky = bearerAuth<User, Env>({
  name: 'shaky',
  verify: (t, e) => (Object.hasOwn(e.tokens, t) ? e.tokens[t] : null),
  actorId: () => {
    throw new Error('no id');
  },
});

const throwingSchema = z.unknown().transform((): { n: number } => {
  throw new Error('schema broke');
});

const base = (name: string) =>
  procedure(name)
    .auth(shaky)
    .noAuthz({ reason: 'Any signed in caller may run this test procedure' })
    .noMcp({ reason: 'A test procedure that only HTTP calls' })
    .noCli({ reason: 'A test procedure that only HTTP calls' })
    .noAiTool({ reason: 'A test procedure that only HTTP calls' });

function setup() {
  const wrote = vi.fn();
  const save = base('things.save')
    .noInput()
    .output(z.object({ saved: z.boolean() }))
    .noErrors({ reason: 'This test procedure raises no errors' })
    .analytics({ event: 'thing.saved', props: () => ({ big: 1n }) })
    .handler(() => (wrote(), { saved: true }));
  const check = base('things.check')
    .input(throwingSchema)
    .output(z.object({ ok: z.boolean() }))
    .noErrors({ reason: 'This test procedure raises no errors' })
    .noAnalytics({ reason: 'A test procedure nobody needs to count' })
    .handler(() => ({ ok: true }));
  const onError = vi.fn();
  const registry = defineRegistry([save, check], { analytics: memoryAnalytics(), onError });
  const call = (name: string, input?: unknown) => registry.call(name, input, { request: req('bob'), env, surface: 'http', waitUntil: () => {} });
  return { call, onError, wrote, registry };
}

describe('callbacks that throw', () => {
  it('answers a call that already wrote, when the actor id or the analytics props can\'t be read', async () => {
    const { call, onError, wrote, registry } = setup();
    const stop = registry.trace.subscribe(() => {});
    expect(await call('things.save')).toEqual({ ok: true, status: 200, value: { saved: true } });
    stop();
    expect(wrote).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });

  it('answers 500 INTERNAL when an input schema throws', async () => {
    const { call, onError } = setup();
    expect(await call('things.check', { n: 1 })).toMatchObject({ ok: false, status: 500, code: 'INTERNAL' });
    expect(onError).toHaveBeenCalled();
  });
});

describe('anyOf', () => {
  it('asks the provider that resolved the caller for the actor id', async () => {
    type Session = { session: { userId: string } };
    type Key = { key: { owner: string } };
    const session = { name: 'session', resolve: async () => null, actorId: (c: Session | Key) => (c as Session).session.userId };
    const key = { name: 'key', resolve: async () => ({ key: { owner: 'u-1' } }), actorId: (c: Session | Key) => (c as Key).key.owner };
    const either = anyOf<Session | Key>('either', session, key);
    const ctx = await either.resolve(req(), env);
    expect(either.actorId!(ctx)).toBe('u-1');
  });

  it('asks the provider that resolved the caller what acted for them', async () => {
    type Session = { session: { userId: string } };

    type Key = { key: { owner: string; thread: string } };

    const session = { name: 'session', resolve: async () => null, viaOf: () => 'wrong' };
    const key = { name: 'key', resolve: async () => ({ key: { owner: 'u-1', thread: 'thread-1' } }), viaOf: (c: Session | Key) => (c as Key).key.thread };

    const either = anyOf<Session | Key>('either', session, key);
    const ctx = await either.resolve(req(), env);
    expect(either.viaOf!(ctx)).toBe('thread-1');
    expect(either.actorId!(ctx)).toBeUndefined();
  });
});

describe('bearerAuth', () => {
  it('gives the label of what acted for the caller when the app names one', async () => {
    const auth = bearerAuth<{ id: string; thread?: string }>({ verify: (t) => (t === 'k' ? { id: 'u-1', thread: 't-1' } : null), actorId: (c) => c.id, viaOf: (c) => c.thread });
    const ctx = await auth.resolve(new Request('https://x', { headers: { authorization: 'Bearer k' } }), undefined);
    expect([auth.actorId!(ctx!), auth.viaOf!(ctx!)]).toEqual(['u-1', 't-1']);
    expect(bearerAuth({ verify: () => null }).viaOf).toBeUndefined();
  });
});
