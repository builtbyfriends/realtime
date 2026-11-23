import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRegistry } from '@builtbyfriends/realtime';
import { memoryAnalytics } from '@builtbyfriends/realtime-analytics';
import { rpcHandler } from '@builtbyfriends/realtime-http';
import { run } from '@builtbyfriends/realtime-cli';
import { env, getContact, ping, procedure, purge, token } from '../../core/test/fixtures.js';

const search = procedure('contacts.search')
  .auth(token)
  .input(z.object({ query: z.string(), limit: z.number().int().optional(), exact: z.boolean().optional(), tags: z.array(z.string()).optional(), sort: z.enum(['name', 'id']).optional() }))
  .noAuthz({ reason: 'Every signed-in user may search' })
  .output(z.object({ input: z.any() }))
  .noErrors({ reason: 'An empty result is a valid answer' })
  .noAnalytics({ reason: 'Covered by contacts.get tracking' })
  .noMcp({ reason: 'Agents use the AI tool instead' })
  .cli({ command: 'contacts search', description: 'Search contacts' })
  .noAiTool({ reason: 'Not needed for this test suite' })
  .handler(({ input }) => ({ input }));

const registry = defineRegistry([getContact, purge, ping, search], { analytics: memoryAnalytics() });
const rpc = rpcHandler(registry);
const f: typeof fetch = async (input, init) => rpc(new Request(input, init), env, { waitUntil: () => {} });

async function cli(...argv: Array<string>) {
  let out = '';
  let err = '';
  const code = await run({ argv, env: { REALTIME_URL: 'https://api.test', REALTIME_TOKEN: 'bob' }, fetch: f, stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

describe('cli', () => {
  it('lists commands from the manifest', async () => {
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain('contacts get');
    expect(r.out).toContain('ping');
    expect(r.out).not.toContain('purge');
  });

  it('maps flags to input and prints JSON', async () => {
    const r = await cli('contacts', 'get', '--org-id', 'o1', '--id=c1');
    expect(r).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(r.out)).toEqual({ id: 'c1', owner: 'u-bob' });
  });

  it('coerces numbers, booleans, enums and repeated array flags', async () => {
    const r = await cli('contacts', 'search', '--query', 'ada', '--limit', '5', '--exact', '--tags', 'a', '--tags', 'b', '--sort', 'name');
    expect(JSON.parse(r.out)).toEqual({ input: { query: 'ada', limit: 5, exact: true, tags: ['a', 'b'], sort: 'name' } });
    expect(JSON.parse((await cli('contacts', 'search', '--query', 'x', '--no-exact')).out).input.exact).toBe(false);
    expect((await cli('contacts', 'search', '--query', 'x', '--limit', 'many')).err).toContain('--limit must be an integer');
    expect((await cli('contacts', 'search', '--query', 'x', '--sort', 'size')).err).toContain('--sort must be one of: name, id');
    expect(JSON.parse((await cli('contacts', 'search', '--query', 'x', '--exact', 'false')).out).input.exact).toBe(false);
    expect(JSON.parse((await cli('contacts', 'search', '--query', 'x', '--exact=false')).out).input.exact).toBe(false);
    expect((await cli('contacts', 'search', '--query', 'x', '--exact=maybe')).err).toContain('--exact takes true or false');
    expect(JSON.parse((await cli('--query', 'x', 'contacts', 'search', '--limit=-1')).out).input).toEqual({ query: 'x', limit: -1 });
  });

  it('explains usage errors with exit code 2', async () => {
    const missing = await cli('contacts', 'get', '--org-id', 'o1');
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('missing --id');
    const unknown = await cli('contacts', 'get', '--org', 'o1');
    expect(unknown.err).toContain('unknown flag --org for "contacts get". Flags: --org-id, --id');
    expect((await cli('contacts', 'frobnicate')).code).toBe(2);
  });

  it('prints server errors with exit code 1', async () => {
    const r = await cli('contacts', 'get', '--org-id', 'o1', '--id', 'missing');
    expect(r).toMatchObject({ code: 1, err: 'error NOT_FOUND: No such contact\n' });
    let err = '';
    const code = await run({ argv: ['contacts', 'get', '--org-id', 'o1', '--id', 'c1'], env: { REALTIME_URL: 'https://api.test' }, fetch: f, stdout: () => {}, stderr: (s) => (err += s) });
    expect(code).toBe(1);
    expect(err).toContain('Set --token or REALTIME_TOKEN');
  });

  it('shows per-command help with flags and errors', async () => {
    const r = await cli('contacts', 'get', '--help');
    expect(r.out).toContain('--org-id <string> (required)');
    expect(r.out).toContain('NOT_FOUND (404) No such contact');
  });
});
