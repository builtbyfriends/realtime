import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = fileURLToPath(new URL('..', import.meta.url));
const example = join(root, 'examples/contacts-worker');
const wrangler = join(root, 'node_modules/.bin/wrangler');
const port = 8787 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const results = [];
const check = async (name, fn) => {
  await fn();
  results.push(name);
  console.log(`  ok  ${name}`);
};

const dev = spawn(wrangler, ['dev', '--port', String(port), '--ip', '127.0.0.1'], { cwd: example, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
dev.stdout.on('data', (d) => (log += d));
dev.stderr.on('data', (d) => (log += d));
try {
  for (let i = 0; ; i++) {
    if (i > 60) {throw new Error(`wrangler dev did not start:\n${log}`);}
    const ready = await fetch(`${base}/rpc/status`, { method: 'POST' }).then((res) => res.ok, () => false);
    if (ready) {break;}
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  console.log(`wrangler dev on ${base}`);
  const post = (name, body, token) =>
    fetch(`${base}/rpc/${name}`, { method: 'POST', body: body === undefined ? '' : JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });

  await check('HTTP: 401 without a token', async () => assert.equal((await post('contacts.get', { orgId: 'o1', id: 'c1' })).status, 401));
  await check('HTTP: 400 for bad input', async () => assert.equal((await post('contacts.get', { orgId: 1 }, 't-bob')).status, 400));
  await check('HTTP: 403 for another org', async () => assert.equal((await post('contacts.get', { orgId: 'o2', id: 'c3' }, 't-bob')).status, 403));
  await check('HTTP: 404 from the declared error', async () => assert.equal((await post('contacts.get', { orgId: 'o1', id: 'zz' }, 't-bob')).status, 404));
  await check('HTTP: 200 on success', async () => {
    const res = await post('contacts.get', { orgId: 'o1', id: 'c1' }, 't-bob');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.name, 'Ada Lovelace');
  });
  await check('HTTP: admin-only profile blocks members', async () => assert.equal((await post('contacts.delete', { id: 'c2' }, 't-bob')).status, 403));
  await check('HTTP: OpenAPI is served', async () => assert.ok((await (await fetch(`${base}/rpc/openapi.json`)).json()).paths['/rpc/contacts.get']));

  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync('node', [join(root, 'packages/cli/dist/bin.js'), ...args], { env: { ...process.env, REALTIME_URL: base, REALTIME_TOKEN: 't-bob' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
      return { code: error.status, out: error.stdout, err: error.stderr };
    }
  };
  await check('CLI: lists commands from the manifest', async () => assert.match(cli().out, /contacts search\s+Search contacts by name/));
  await check('CLI: runs a command with flags', async () => assert.deepEqual(JSON.parse(cli('contacts', 'search', '--org-id', 'o1', '--query', 'tur').out), { results: [{ id: 'c2', name: 'Alan Turing' }] }));
  await check('CLI: server error exits 1', async () => {
    const r = cli('contacts', 'get', '--org-id', 'o1', '--id', 'zz');
    assert.equal(r.code, 1);
    assert.match(r.err, /error NOT_FOUND/);
  });

  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: 'Bearer t-bob' } } }));
  await check('MCP: tools/list holds only procedures that chose mcp', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['contacts_get', 'contacts_search', 'contacts_delete']);
  });
  await check('MCP: tools/call runs the pipeline', async () => {
    const ok = await client.callTool({ name: 'contacts_search', arguments: { orgId: 'o1', query: 'ada' } });
    assert.deepEqual(ok.structuredContent, { results: [{ id: 'c1', name: 'Ada Lovelace' }] });
    const denied = await client.callTool({ name: 'contacts_get', arguments: { orgId: 'o2', id: 'c3' } });
    assert.equal(JSON.parse(denied.content[0].text).error.code, 'FORBIDDEN');
  });
  await client.close();
  assert.doesNotMatch(log, /\[realtime\]/, 'no unexpected errors logged');
} finally {
  dev.kill('SIGTERM');
}

// Decision: the deploy gate. Bundle a Worker that hides missing decisions behind `as any` with esbuild
// (no type checking, like wrangler deploy), then load it the way Cloudflare does.
await check('Deploy gate: an esbuild bundle with missing decisions throws at load', async () => {
  const out = mkdtempSync(join(tmpdir(), 'realtime-broken-'));
  execFileSync(wrangler, ['deploy', '--dry-run', '--outdir', out, '--name', 'broken', 'test/broken-worker.ts'], { cwd: example, stdio: 'ignore' });
  await assert.rejects(import(join(out, 'broken-worker.js')), /"sneaky": undecided: authz, input, errors, analytics, mcp, cli, aiTool/);
});
console.log(`\n${results.length} checks passed`);
process.exit(0);
