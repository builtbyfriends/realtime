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

const flagged = procedure('flags.set')
  .auth(token)
  .input(z.object({ cache: z.boolean().optional(), noCache: z.boolean().optional() }))
  .noAuthz({ reason: 'Used only in this test' })
  .output(z.object({ input: z.any() }))
  .noErrors({ reason: 'Used only in this test' })
  .noAnalytics({ reason: 'Used only in this test' })
  .noMcp({ reason: 'Used only in this test' })
  .cli({ command: 'flags set', description: 'Set flags' })
  .noAiTool({ reason: 'Used only in this test' })
  .handler(({ input }) => ({ input }));

const clashing = procedure('links.add')
  .auth(token)
  .input(z.object({ url: z.string(), label: z.string().optional() }))
  .noAuthz({ reason: 'Used only in this test' })
  .output(z.object({ input: z.any() }))
  .noErrors({ reason: 'Used only in this test' })
  .noAnalytics({ reason: 'Used only in this test' })
  .noMcp({ reason: 'Used only in this test' })
  .cli({ command: 'links add', description: 'Add a link' })
  .noAiTool({ reason: 'Used only in this test' })
  .handler(({ input }) => ({ input }));

const registry = defineRegistry([getContact, purge, ping, search, flagged, clashing], { analytics: memoryAnalytics() });
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

  it('prefers an exact flag over a --no- negation', async () => {
    expect(JSON.parse((await cli('flags', 'set', '--no-cache')).out).input).toEqual({ noCache: true });
    expect(JSON.parse((await cli('flags', 'set', '--cache')).out).input).toEqual({ cache: true });
  });

  it('asks for --json when an input is named like a CLI flag', async () => {
    const r = await cli('links', 'add', '--url', 'https://x.test');
    expect(r.code).toBe(2);
    expect(r.err).toContain('"url" is also a flag of the CLI');
    expect(r.err).toContain('--json');
    expect((await cli('links', 'add', '--label', 'a')).code).toBe(2);
    const ok = await cli('links', 'add', '--json', '{"url":"https://x.test"}', '--label', 'a');
    expect(ok).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(ok.out).input).toEqual({ url: 'https://x.test', label: 'a' });
  });

  it('fails when a successful response is not JSON', async () => {
    let out = '';
    let err = '';
    const html: typeof fetch = async (input, init) => (String(input).endsWith('manifest.json') ? f(input, init) : new Response('<html>ok</html>', { status: 200 }));
    const code = await run({ argv: ['ping'], env: { REALTIME_URL: 'https://api.test', REALTIME_TOKEN: 'bob' }, fetch: html, stdout: (s) => (out += s), stderr: (s) => (err += s) });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain("isn't JSON");
  });

  it('fails when --url or --token has no value', async () => {
    const url = await cli('contacts', 'search', '--query', 'x', '--url');
    expect(url).toMatchObject({ code: 2, err: 'realtime: --url needs a value\n' });
    const token = await cli('contacts', 'search', '--query', 'x', '--token');
    expect(token).toMatchObject({ code: 2, err: 'realtime: --token needs a value\n' });
  });

  it('fails when --json is not an object', async () => {
    for (const value of ['"text"', '[1]', 'null', '5']) {
      const r = await cli('contacts', 'search', '--json', value);
      expect(r.code).toBe(2);
      expect(r.err).toContain('--json must be a JSON object');
    }
    expect(JSON.parse((await cli('contacts', 'search', '--json', '{"query":"q"}')).out).input).toEqual({ query: 'q' });
  });
});
