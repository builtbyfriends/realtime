import { describe, expect, it } from 'vitest';
import { defineRegistry } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { aiSdkTools, anthropicTools, runTool, toolResultContent } from '@builtbyfriends/realtime-ai';
import { env, getContact, ping, purge, req } from '../../core/test/fixtures.js';

const analytics = memoryAnalytics();
const registry = defineRegistry([getContact, purge, ping], { analytics });

describe('ai tools', () => {
  it('lists only procedures that chose aiTool, in the Anthropic shape', () => {
    const tools = anthropicTools(registry);
    expect(tools.map((t) => t.name)).toEqual(['contacts_get', 'cache_purge']);
    expect(tools[0]).toEqual({
      name: 'contacts_get',
      description: 'Fetch one contact',
      input_schema: { type: 'object', properties: { orgId: { type: 'string' }, id: { type: 'string' } }, required: ['orgId', 'id'] },
    });
  });

  it('runs as the user who sent the request', async () => {
    const asBob = { request: req('bob'), env };
    const r = await runTool(registry, 'contacts_get', { orgId: 'o1', id: 'c1' }, asBob);
    expect(toolResultContent(r)).toEqual({ content: '{"id":"c1","owner":"u-bob"}', is_error: false });
    const denied = await runTool(registry, 'contacts_get', { orgId: 'o2', id: 'c1' }, asBob);
    expect(toolResultContent(denied).is_error).toBe(true);
    expect(analytics.events.at(-1)?.surface).toBe('ai');
  });

  it('holds tools that need approval until approved', async () => {
    const asAlice = { request: req('alice'), env };
    expect(await runTool(registry, 'cache_purge', {}, asAlice)).toEqual({ status: 'needs_approval', tool: 'cache_purge', input: {} });
    const r = await runTool(registry, 'cache_purge', undefined, { ...asAlice, approved: true });
    expect(r).toMatchObject({ status: 'ok', result: { ok: true, value: { purged: true } } });
    expect(await runTool(registry, 'ping', undefined, asAlice)).toEqual({ status: 'unknown_tool', tool: 'ping' });
  });

  it('builds AI SDK tools with needsApproval', async () => {
    const tools = aiSdkTools(registry, { request: req('bob'), env }, { jsonSchema: (s) => ({ wrapped: s }) });
    expect(Object.keys(tools)).toEqual(['contacts_get', 'cache_purge']);
    expect(tools.cache_purge.needsApproval).toBe(true);
    expect(await tools.contacts_get.execute({ orgId: 'o1', id: 'c1' })).toEqual({ id: 'c1', owner: 'u-bob' });
  });
});
