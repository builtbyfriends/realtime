import { describe, expect, it, vi } from 'vitest';
import { createDevtools } from '../src/devtools.js';

vi.mock('virtual:realtime/devtools-page', () => ({ default: '' }));

const registry = { trace: { subscribe: () => () => {} }, audit: () => [], procedures: new Map() } as any;
const app = { name: 'test', basePath: '/rpc', mcpRoute: '/mcp' };

async function recorded(headers: Record<string, string>, resHeaders: Array<[string, string]> = []) {
  const devtools = createDevtools(registry, app);
  const res = new Response('{}', { headers: resHeaders });
  await devtools.record(new Request('https://app.test/rpc/x', { headers }), () => {}, async () => res);
  const body = await (await devtools.serve(new Request('https://app.test/__realtime/events'))).json();
  return body.exchanges[0];
}

describe('header masking', () => {
  it('masks every cookie value in a Cookie header', async () => {
    const ex = await recorded({ cookie: 'session=SECRET12345; theme=dark; token=abcdefghij' });
    expect(ex.reqHeaders.cookie).toBe('session=SECRET…; theme=dark; token=abcdef…');
    expect(ex.reqHeaders.cookie).not.toContain('SECRET12345');
  });

  it('masks the cookie value in Set-Cookie and keeps its attributes', async () => {
    const ex = await recorded({}, [['set-cookie', 'session=SECRET12345; Path=/; HttpOnly']]);
    expect(ex.resHeaders['set-cookie']).toBe('session=SECRET…; Path=/; HttpOnly');
  });

  it('keeps the scheme of an Authorization header', async () => {
    const ex = await recorded({ authorization: 'Bearer abcdefghijkl' });
    expect(ex.reqHeaders.authorization).toBe('Bearer abcdef…');
  });
});
