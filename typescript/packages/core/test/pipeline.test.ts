import { describe, expect, it, vi } from 'vitest';
import { defineRegistry } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { env, getContact, ping, purge, req } from './fixtures.js';

function setup() {
  const analytics = memoryAnalytics();
  const onError = vi.fn();
  const registry = defineRegistry([getContact, purge, ping], { analytics, onError });
  const pending: Array<Promise<unknown>> = [];
  const call = async (name: string, input: unknown, token?: string) => {
    const r = await registry.call(name, input, { request: req(token), env, surface: 'http', waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return r;
  };
  return { registry, analytics, onError, call };
}

describe('pipeline', () => {
  it('runs authn, input, authz, handler and output in order', async () => {
    const { call } = setup();
    expect(await call('contacts.get', { orgId: 'o1', id: 'c1' })).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'nobody')).toMatchObject({ status: 401 });
    expect(await call('contacts.get', { orgId: 'o1' }, 'bob')).toMatchObject({
      status: 400,
      code: 'INVALID_INPUT',
      issues: [{ path: 'id', message: expect.any(String) }],
    });
    expect(await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'eve')).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'bob')).toEqual({ ok: true, status: 200, value: { id: 'c1', owner: 'u-bob' } });
  });

  it('checks auth before input, so anonymous callers learn nothing about the schema', async () => {
    const { call } = setup();
    expect(await call('contacts.get', 'garbage')).toMatchObject({ status: 401 });
  });

  it('maps declared errors, and lets fail() override the message', async () => {
    const { call } = setup();
    expect(await call('contacts.get', { orgId: 'o1', id: 'missing' }, 'bob')).toEqual({ ok: false, status: 404, code: 'NOT_FOUND', message: 'No such contact' });
    expect(await call('contacts.get', { orgId: 'o1', id: 'gone' }, 'bob')).toEqual({ ok: false, status: 410, code: 'GONE', message: 'Deleted on Tuesday' });
  });

  it('turns unexpected throws and bad output into a 500 without leaking details', async () => {
    const { call, onError } = setup();
    const boom = await call('contacts.get', { orgId: 'o1', id: 'boom' }, 'bob');
    expect(boom).toEqual({ ok: false, status: 500, code: 'INTERNAL', message: 'Internal error' });
    expect(JSON.stringify(boom)).not.toContain('exploded');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'database exploded' }), expect.objectContaining({ stage: 'handler' }));
    expect(await call('contacts.get', { orgId: 'o1', id: 'badshape' }, 'bob')).toMatchObject({ status: 500 });
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error), expect.objectContaining({ stage: 'output' }));
  });

  it('rejects a payload sent to a procedure that takes no input', async () => {
    const { call } = setup();
    expect(await call('ping', undefined)).toMatchObject({ status: 200 });
    expect(await call('ping', {})).toMatchObject({ status: 200 });
    expect(await call('ping', { surprise: 1 })).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  });

  it('applies profile decisions (admin-only)', async () => {
    const { call } = setup();
    expect(await call('cache.purge', undefined, 'bob')).toMatchObject({ status: 403 });
    expect(await call('cache.purge', undefined, 'alice')).toMatchObject({ status: 200, value: { purged: true } });
  });

  it('sends analytics once per call that reached the handler, after the result', async () => {
    const { call, analytics } = setup();
    await call('contacts.get', { orgId: 'o1', id: 'c1' });
    await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'eve');
    await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'bob');
    await call('contacts.get', { orgId: 'o1', id: 'missing' }, 'bob');
    await call('ping', undefined);
    expect(analytics.events).toHaveLength(2);
    expect(analytics.events[0]).toMatchObject({
      event: 'contact.viewed',
      procedure: 'contacts.get',
      surface: 'http',
      outcome: 'ok',
      status: 200,
      actorId: 'u-bob',
      props: { orgId: 'o1' },
    });
    expect(analytics.events[1]).toMatchObject({ outcome: 'error', code: 'NOT_FOUND', status: 404 });
  });

  it('returns 404 for unknown procedures', async () => {
    const { call } = setup();
    expect(await call('nope', undefined)).toMatchObject({ status: 404, code: 'NOT_FOUND_PROCEDURE' });
  });
});
