import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineRegistry } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { rpcHandler } from '@builtbyfriends/realtime-http';
import { createClient, RpcError } from '@builtbyfriends/realtime-http/client';
import { env, getContact, ping, purge } from '../../core/test/fixtures.js';

const analytics = memoryAnalytics();
const registry = defineRegistry([getContact, purge, ping], { analytics });
const rpc = rpcHandler(registry, { openapi: { title: 'Test', version: '1' } });
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const fetchVia: typeof fetch = async (input, init) => rpc(new Request(input as string, init), env, ctx);
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  rpc(new Request(`https://api.test${path}`, { method: 'POST', body: body === undefined ? '' : JSON.stringify(body), headers }), env, ctx);

describe('rpcHandler', () => {
  it('serves procedures as POST /rpc/{name}', async () => {
    const res = await post('/rpc/contacts.get', { orgId: 'o1', id: 'c1' }, { authorization: 'Bearer bob' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'c1', owner: 'u-bob' } });
  });

  it('returns errors as { error } with the declared status', async () => {
    const res = await post('/rpc/contacts.get', { orgId: 'o1', id: 'c1' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    expect((await post('/rpc/contacts.get', { orgId: 'o1', id: 'missing' }, { authorization: 'Bearer bob' })).status).toBe(404);
    const bad = await rpc(new Request('https://api.test/rpc/ping', { method: 'POST', body: '{nope' }), env, ctx);
    expect(bad.status).toBe(400);
    expect((await rpc(new Request('https://api.test/rpc/ping'), env, ctx)).status).toBe(405);
    expect((await post('/rpc/nope')).status).toBe(404);
  });

  it('tags CLI calls for analytics', async () => {
    analytics.events.length = 0;
    await post('/rpc/contacts.get', { orgId: 'o1', id: 'c1' }, { authorization: 'Bearer bob', 'x-realtime-surface': 'cli' });
    await new Promise((r) => setTimeout(r, 0));
    expect(analytics.events.at(-1)?.surface).toBe('cli');
  });

  it('serves the manifest and OpenAPI', async () => {
    const manifest = await (await rpc(new Request('https://api.test/rpc/manifest.json'), env, ctx)).json();
    expect(manifest.procedures.map((p: any) => p.name)).toEqual(['contacts.get', 'ping']);
    const openapi = await (await rpc(new Request('https://api.test/rpc/openapi.json'), env, ctx)).json();
    expect(Object.keys(openapi.paths)).toEqual(['/rpc/contacts.get', '/rpc/cache.purge', '/rpc/ping']);
    expect(Object.keys(openapi.paths['/rpc/contacts.get'].post.responses).sort()).toEqual(['200', '400', '401', '403', '404', '410', '500']);
    expect(openapi.paths['/rpc/ping'].post.security).toEqual([]);
  });

  it('matches only its base path', () => {
    expect(rpc.matches(new Request('https://api.test/rpc/ping'))).toBe(true);
    expect(rpc.matches(new Request('https://api.test/rpcx'))).toBe(false);
  });
});

describe('typed client', () => {
  const client = createClient<typeof registry>('https://api.test', { token: 'bob', fetch: fetchVia });

  it('types inputs and outputs from the procedures', async () => {
    const c = await client.call('contacts.get', { orgId: 'o1', id: 'c1' });
    expectTypeOf(c).toEqualTypeOf<{ id: string; owner: string }>();
    expect(c).toEqual({ id: 'c1', owner: 'u-bob' });
    expect(await client.call('ping')).toEqual({ ok: true });
    // @ts-expect-error unknown procedure
    void (() => client.call('nope'));
    // @ts-expect-error missing input field
    void (() => client.call('contacts.get', { orgId: 'o1' }));
  });

  it('throws RpcError with the code', async () => {
    const err = await client.call('contacts.get', { orgId: 'o1', id: 'missing' }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  const answering = (res: () => Response) => createClient<typeof registry>('https://api.test', { fetch: (async () => res()) as typeof fetch });

  it('rejects with RpcError INTERNAL when a 200 answer is not JSON', async () => {
    const err = await answering(() => new Response('<html>', { status: 200 })).call('ping').catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: 'INTERNAL', status: 200 });
  });

  it('rejects with RpcError INTERNAL when the body is JSON null', async () => {
    const err = await answering(() => new Response('null', { status: 200 })).call('ping').catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: 'INTERNAL', status: 200 });
  });

  it('gives an error body whose error is not an object the code INTERNAL', async () => {
    const err = await answering(() => Response.json({ error: 'boom' }, { status: 500 })).call('ping').catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: 'INTERNAL', status: 500 });
  });
});
