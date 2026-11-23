import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bearerAuth, defineRegistry } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { env, procedure, req, type Env, type User } from './fixtures.js';

const shaky = bearerAuth<User, Env>({
  name: 'shaky',
  verify: (t, e) => (Object.hasOwn(e.tokens, t) ? e.tokens[t]! : null),
  actorId: () => {
    throw new Error('no id');
  },
});

const throwingSchema = { '~standard': { version: 1, vendor: 'test', validate: () => { throw new Error('schema broke'); } } } as unknown as z.ZodType<{ n: number }>;

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
    .analytics({ event: 'thing.saved', props: () => ({ big: 1n as unknown as number }) })
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
    const stop = registry.trace!.subscribe(() => {});
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
