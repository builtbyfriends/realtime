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

  it('masks custom secret headers and secret query values', async () => {
    const devtools = createDevtools(registry, app);
    await devtools.record(new Request('https://app.test/rpc/x?key=abcdefghijkl&page=2&keyword=a%20long%20phrase', { headers: { 'x-auth-token': 'abcdefghijkl', 'x-ratelimit-remaining-tokens': '1234567' } }), () => {}, async () => new Response('{}'));
    const ex = (await (await devtools.serve(new Request('https://app.test/__realtime/events'))).json()).exchanges[0];
    expect(ex.reqHeaders['x-auth-token']).toBe('abcdef…');
    expect(ex.url).not.toContain('abcdefghijkl');
    expect(ex.url).toContain('page=2');
    expect(ex.url).toContain('keyword=a%20long%20phrase');
    expect(ex.reqHeaders['x-ratelimit-remaining-tokens']).toBe('1234567');
  });
});

describe('recorded bodies', () => {
  it('cuts a very large JSON body and a long event stream', async () => {
    const devtools = createDevtools(registry, app);
    const big = JSON.stringify({ text: 'x'.repeat(300_000) });
    await devtools.record(new Request('https://app.test/rpc/x'), () => {}, async () => new Response(big, { headers: { 'content-type': 'application/json' } }));
    const stream = Array.from({ length: 500 }, (_, i) => `data: ${i}\n\n`).join('');
    await devtools.record(new Request('https://app.test/rpc/y'), () => {}, async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    await new Promise((r) => setTimeout(r, 0));
    const { exchanges } = await (await devtools.serve(new Request('https://app.test/__realtime/events'))).json();
    expect(typeof exchanges[0].resBody).toBe('string');
    expect(exchanges[0].resBody.length).toBeLessThan(21_000);
    expect(exchanges[1].resBody.sse).toHaveLength(200);
  });
});
