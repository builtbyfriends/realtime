import { describe, expect, it } from 'vitest';
import { defineRegistry } from '@builtbyfriends/realtime';
import type { CallTrace, TraceEvent } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { env, getContact, ping, purge, req } from './fixtures.js';

function setup() {
  const registry = defineRegistry([getContact, purge, ping], { analytics: memoryAnalytics(), onError: () => {} });
  const events: Array<TraceEvent> = [];
  const call = (name: string, input: unknown, token?: string, surface: 'http' | 'mcp' = 'http') =>
    registry.call(name, input, { request: req(token), env, surface }).then(() => events.at(-1) as CallTrace);
  return { registry, events, call };
}
const statuses = (t: CallTrace) => Object.fromEntries(t.steps.map((s) => [s.concern, s.status]));

describe('trace', () => {
  it('records nothing until someone subscribes', async () => {
    const { registry, events, call } = setup();
    expect(registry.trace.active).toBe(false);
    await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'bob');
    expect(events).toHaveLength(0);
  });

  it('shows every step of a successful call, and the surface decision it came through', async () => {
    const { registry, events, call } = setup();
    registry.trace.subscribe((e) => events.push(e));
    const t = await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'bob', 'mcp');
    expect(t.steps.map((s) => s.concern)).toEqual(['mcp', 'authn', 'input', 'authz', 'handler', 'output', 'errors', 'analytics']);
    expect(new Set(Object.values(statuses(t)))).toEqual(new Set(['pass']));
    expect(t.steps.find((s) => s.concern === 'authn')?.detail).toBe('actor u-bob');
    expect(t.result).toMatchObject({ ok: true });
  });

  it('marks the failing step and leaves later ones unreached', async () => {
    const { registry, events, call } = setup();
    registry.trace.subscribe((e) => events.push(e));
    const t = await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'eve');
    expect(statuses(t)).toMatchObject({ authn: 'pass', input: 'pass', authz: 'fail', handler: 'unreached', output: 'unreached', analytics: 'unreached' });
    expect(t.steps.find((s) => s.concern === 'authz')?.detail).toContain('403 FORBIDDEN');
  });

  it('shows declared errors and opt-outs', async () => {
    const { registry, events, call } = setup();
    registry.trace.subscribe((e) => events.push(e));
    expect(statuses(await call('contacts.get', { orgId: 'o1', id: 'missing' }, 'bob'))).toMatchObject({ handler: 'pass', errors: 'pass', output: 'unreached' });
    const purged = await call('cache.purge', undefined, 'alice');
    expect(statuses(purged)).toMatchObject({ errors: 'off', analytics: 'off' });
  });

  it('stops recording after unsubscribe', async () => {
    const { registry, events, call } = setup();
    const off = registry.trace.subscribe((e) => events.push(e));
    off();
    await call('contacts.get', { orgId: 'o1', id: 'c1' }, 'bob');
    expect(events).toHaveLength(0);
  });
});
