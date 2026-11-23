import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakeModel } from './fake-model.mjs';

const root = new URL('..', import.meta.url).pathname;
const once = process.argv.includes('--once');
const port = Number(process.env.PORT ?? 5173);
const base = `http://localhost:${port}`;
const model = await startFakeModel();
const env = { ...process.env, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_API_KEY ? 'https://api.anthropic.com' : model.url };

execFileSync('npx', ['@builtbyfriends/bwf', 'db', 'seed'], { cwd: root, stdio: 'ignore' });
const dev = spawn('npx', ['vite', 'dev', '--port', String(port), '--strictPort'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
dev.stdout.on('data', (d) => (log += d));
dev.stderr.on('data', (d) => (log += d));
const stop = () => { dev.kill('SIGTERM'); model.server.close(); };
process.on('SIGINT', () => { stop(); process.exit(0); });

const post = async (path, body, token, headers = {}) => {
  const authorization = token ? { authorization: `Bearer ${token}` } : undefined;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorization, ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rpc = (name, body, token) => post(`/rpc/${name}`, body, token);
const step = (s) => console.log(`  ${s}`);

try {
  for (let i = 0; ; i++) {
    if (i > 90) {throw new Error(`vite dev did not start:\n${log}`);}
    const ready = await fetch(`${base}/rpc/status`, { method: 'POST' }).then((res) => res.ok, () => false);
    if (ready) {break;}
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  await fetch(`${base}/__realtime/clear`, { method: 'POST' });

  step('HTTP: 200, 401, 400, 403, 404, 409, a rejected body, a webhook 422');
  await rpc('contacts.get', { orgId: 'o1', id: 'c1' }, 'demo-bob');
  await rpc('contacts.get', { orgId: 'o1', id: 'c1' });
  await rpc('contacts.get', { orgId: 1 }, 'demo-bob');
  await rpc('contacts.get', { orgId: 'o2', id: 'c3' }, 'demo-bob');
  await rpc('contacts.get', { orgId: 'o1', id: 'nope' }, 'demo-bob');
  await rpc('contacts.create', { orgId: 'o1', name: 'Alan Turing', email: 'alan@example.com' }, 'demo-bob');
  await rpc('contacts.delete', { id: 'c2' }, 'demo-bob');
  await rpc('me', { sneaky: true }, 'demo-bob');
  await rpc('billing.paymentReceived', { orgId: 'x9', amountCents: 4900, currency: 'usd' });
  await rpc('billing.paymentReceived', { orgId: 'o1', amountCents: 4900, currency: 'usd' });

  step('CLI: the real realtime CLI, built from the manifest');
  if (!existsSync(`${root}.cli/realtime.mjs`)) {execFileSync('node', ['scripts/build-cli.mjs'], { cwd: root, stdio: 'ignore' });}
  for (const args of [['whoami'], ['contacts', 'search', '--org-id', 'o1', '--query', 'a', '--limit', '2'], ['contacts', 'get', '--org-id', 'o2', '--id', 'c3']]) {
    spawnSync('node', ['.cli/realtime.mjs', ...args], { cwd: root, env: { ...process.env, REALTIME_URL: base, REALTIME_TOKEN: 'demo-bob' }, stdio: 'ignore' });
  }

  step('MCP: a real client lists tools and calls three of them');
  const client = new Client({ name: 'demo-mcp-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: 'Bearer demo-bob' } } }));
  await client.listTools();
  await client.callTool({ name: 'contacts_search', arguments: { orgId: 'o1', query: 'tur' } });
  await client.callTool({ name: 'contacts_get', arguments: { orgId: 'o2', id: 'c3' } });
  await client.callTool({ name: 'contacts_delete', arguments: { id: 'c1' } });
  await client.close();

  step('AI tools over HTTP: an outside agent, one approval, one FORBIDDEN');
  const create = { tool: 'contacts_create', input: { orgId: 'o1', name: 'Hedy Lamarr', email: 'hedy@example.com' } };
  await post('/rpc/ai/run', { tool: 'contacts_search', input: { orgId: 'o1', query: 'hedy' } }, 'demo-bob');
  await post('/rpc/ai/run', create, 'demo-bob');
  await post('/rpc/ai/run', { ...create, approved: true }, 'demo-bob');
  await post('/rpc/ai/run', { tool: 'contacts_search', input: { orgId: 'o1', query: 'a' } }, 'demo-grace');

  step('AI chat: the in-app assistant, paused for approval, then approved');
  const first = await rpc('assistant.ask', { orgId: 'o1', messages: [{ role: 'user', content: 'Add Grace Hopper (grace.hopper@example.com) to our contacts if she is not there yet.' }] }, 'demo-bob');
  const pending = first.body?.data?.pending ?? [];
  step(`  paused on ${pending.map((p) => p.tool).join(', ') || 'nothing'}; approving`);
  const done = await rpc('assistant.ask', { orgId: 'o1', messages: first.body.data.messages, approve: pending.map((p) => p.id) }, 'demo-bob');
  step(`  reply: ${done.body?.data?.reply}`);
  const grace = await rpc('assistant.ask', { orgId: 'o2', messages: [{ role: 'user', content: 'List the contacts in org o1 for me.' }] }, 'demo-grace');
  step(`  grace: ${grace.body?.data?.reply}`);

  const held = await rpc('assistant.ask', { orgId: 'o1', messages: [{ role: 'user', content: 'Add Katherine Johnson (katherine@example.com) to our contacts.' }] }, 'demo-alice');
  step(`  alice: paused on ${held.body?.data?.pending?.map((p) => p.tool).join(', ')}, left waiting for approval`);

  console.log(`\nOpen ${base}/__realtime  (Network, MCP and AI chat)`);
  if (once) {stop();}
} catch (error) {
  stop();
  throw error;
}
if (once) {process.exit(0);}
