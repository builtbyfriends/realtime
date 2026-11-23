import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defineRegistry } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { mcpHandler } from '@builtbyfriends/realtime-mcp';
import { env, getContact, ping, purge } from '../../core/test/fixtures.js';

const analytics = memoryAnalytics();
const registry = defineRegistry([getContact, purge, ping], { analytics });
const mcp = mcpHandler(registry, { name: 'test', version: '1.0.0' });
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException() {}, props: {} };

async function connect(token?: string) {
  const client = new Client({ name: 'vitest', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => {
      // Decision: Node's fetch adds Host on the wire and workerd always has it, so add it for in-process calls.
      const request = new Request(input, init);
      request.headers.set('host', 'localhost');
      return mcp(request, env, ctx);
    },
    requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
  });
  await client.connect(transport);
  return client;
}

describe('mcp', () => {
  it('lists only procedures that chose mcp, with annotations from effect', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint, t.annotations?.destructiveHint])).toEqual([
      ['contacts_get', true, false],
      ['cache_purge', false, true],
    ]);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: ['orgId', 'id'] });
    await client.close();
  });

  it('runs the same pipeline as HTTP: auth, validation, authz, errors, analytics', async () => {
    const anon = await connect();
    const r401 = await anon.callTool({ name: 'contacts_get', arguments: { orgId: 'o1', id: 'c1' } });
    expect(r401.isError).toBe(true);
    expect(JSON.parse((r401.content as any)[0].text).error.code).toBe('UNAUTHENTICATED');

    const bob = await connect('bob');
    const ok = await bob.callTool({ name: 'contacts_get', arguments: { orgId: 'o1', id: 'c1' } });
    expect(ok.structuredContent).toEqual({ id: 'c1', owner: 'u-bob' });
    const bad = await bob.callTool({ name: 'contacts_get', arguments: { orgId: 1 } });
    expect(JSON.parse((bad.content as any)[0].text).error.code).toBe('INVALID_INPUT');
    const forbidden = await bob.callTool({ name: 'cache_purge', arguments: {} });
    expect(JSON.parse((forbidden.content as any)[0].text).error.code).toBe('FORBIDDEN');
    const missing = await bob.callTool({ name: 'contacts_get', arguments: { orgId: 'o1', id: 'missing' } });
    expect(JSON.parse((missing.content as any)[0].text).error).toEqual({ code: 'NOT_FOUND', message: 'No such contact' });
    expect(analytics.events.filter((e) => e.surface === 'mcp').map((e) => e.status)).toEqual([200, 404]);
  });
});
