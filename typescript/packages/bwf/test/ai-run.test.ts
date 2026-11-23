import { describe, expect, it, vi } from 'vitest';
import { env, req } from '../../core/test/fixtures.js';

vi.mock('virtual:realtime/registry', async () => {
  const { defineRegistry } = await import('@builtbyfriends/realtime');
  const { memoryAnalytics } = await import('@builtbyfriends/realtime-analytics');
  const { purge } = await import('../../core/test/fixtures.js');
  return { registry: defineRegistry([purge], { analytics: memoryAnalytics() }), app: { name: 'test', version: '0.0.0', basePath: '/rpc', mcpRoute: '/mcp' } };
});
vi.mock('virtual:realtime/devtools-page', () => ({ default: '' }));
vi.stubEnv('DEV', false);

const { default: middleware } = await import('../src/middleware.js');
const { approveAiRuns } = await import('../src/index.js');

async function run(body: unknown) {
  const base = req('alice');
  const request = new Request('https://app.test/rpc/ai/run', { method: 'POST', headers: base.headers, body: JSON.stringify(body) });
  const res = await middleware({ req: { raw: request }, env, executionCtx: { waitUntil: () => {} } }, async () => {});
  return (await (res as Response).json()) as { status: string };
}

describe('POST /ai/run', () => {
  it('holds a tool that needs approval, whatever the body says', async () => {
    expect((await run({ tool: 'cache_purge', approved: true })).status).toBe('needs_approval');
  });

  it('runs a held tool once the app\'s own check approves it', async () => {
    const seen: Array<string> = [];
    approveAiRuns(({ tool }) => (seen.push(tool), true));
    expect((await run({ tool: 'cache_purge' })).status).toBe('ok');
    expect(seen).toEqual(['cache_purge']);
  });

  it('counts a check that throws as no', async () => {
    approveAiRuns(() => {
      throw new Error('down');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await run({ tool: 'cache_purge' })).status).toBe('needs_approval');
    logged.mockRestore();
  });
});
