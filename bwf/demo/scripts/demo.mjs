import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = new URL('..', import.meta.url).pathname;
const port = 5170 + Math.floor(Math.random() * 20);
let base = process.env.BASE;
let dev;
let devLog = '';

const h = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) => console.log(`\n$ ${label}\n${typeof value === 'string' ? value.trimEnd() : JSON.stringify(value, null, 2)}`);

async function call(name, body, token, method = 'POST') {
  const res = await fetch(`${base}/rpc/${name}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: body === undefined ? '' : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const http = async (label, name, body, token) => {
  const r = await call(name, body, token);
  show(`${label}\n  POST /rpc/${name}${token ? `  (Bearer ${token})` : ''}  ${body === undefined ? '' : JSON.stringify(body)}`, `${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

try {
  if (!base) {
    execFileSync('npx', ['@builtbyfriends/bwf', 'db', 'seed'], { cwd: root, stdio: 'ignore' });
    dev = spawn('npx', ['vite', 'dev', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    dev.stdout.on('data', (d) => (devLog += d));
    dev.stderr.on('data', (d) => (devLog += d));
    base = `http://localhost:${port}`;
    for (let i = 0; ; i++) {
      if (i > 90) throw new Error(`vite dev did not start:\n${devLog}`);
      try { if ((await call('status')).status === 200) break; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`bwf dev server: ${base}`);
  console.log('Tokens: demo-alice (admin, org o1), demo-bob (member, org o1), demo-grace (member, org o2)');

  h('1. HTTP: one POST per procedure, every outcome the pipeline produces');
  await http('No auth needed (status opted out of auth, with a reason)', 'status');
  await http('Signed in, own org: 200', 'contacts.get', { orgId: 'o1', id: 'c1' }, 'demo-bob');
  await http('No token: 401 from the auth decision', 'contacts.get', { orgId: 'o1', id: 'c1' });
  await http('Bad token: 401', 'contacts.get', { orgId: 'o1', id: 'c1' }, 'not-a-token');
  await http('Invalid input: 400 with issues from the input schema', 'contacts.get', { orgId: 1 }, 'demo-bob');
  await http('Another org: 403 from the authz policy "same-org"', 'contacts.get', { orgId: 'o2', id: 'c3' }, 'demo-bob');
  await http('Declared error: 404 NOT_FOUND', 'contacts.get', { orgId: 'o1', id: 'nope' }, 'demo-bob');
  await http('Defaults from the input schema (limit = 10)', 'contacts.search', { orgId: 'o1', query: 'a' }, 'demo-bob');
  const created = await http('A write', 'contacts.create', { orgId: 'o1', name: 'Katherine Johnson', email: 'katherine@example.com' }, 'demo-bob');
  await http('Same email again: declared error 409 DUPLICATE_EMAIL', 'contacts.create', { orgId: 'o1', name: 'K. Johnson', email: 'katherine@example.com' }, 'demo-bob');
  await http('Admin-only profile, as a member: 403', 'contacts.delete', { id: created.body.data.id }, 'demo-bob');
  await http('Admin-only profile, as an admin: 200', 'contacts.delete', { id: created.body.data.id }, 'demo-alice');
  await http('noInput(): a body is rejected', 'me', { sneaky: true }, 'demo-bob');
  await http('noInput(): empty body is fine', 'me', undefined, 'demo-grace');
  await http('Webhook, no auth, validated input', 'billing.paymentReceived', { orgId: 'o1', amountCents: 4900, currency: 'usd' });
  await http('Webhook, declared error 422', 'billing.paymentReceived', { orgId: 'x9', amountCents: 4900, currency: 'usd' });
  await http('Unknown procedure: 404', 'contacts.explode', {}, 'demo-bob');
  const get = await fetch(`${base}/rpc/contacts.get`);
  show('GET instead of POST: 405\n  GET /rpc/contacts.get', `${get.status} ${await get.text()}`);

  h('2. Generated documents: OpenAPI (every procedure) and the CLI manifest (only .cli() ones)');
  const openapi = await (await fetch(`${base}/rpc/openapi.json`)).json();
  show('GET /rpc/openapi.json  (paths only)', Object.keys(openapi.paths).join('\n'));
  const manifest = await (await fetch(`${base}/rpc/manifest.json`)).json();
  show('GET /rpc/manifest.json  (names only; each entry carries JSON Schema)', manifest.procedures.map((p) => p.name).join('\n'));

  h('3. MCP: Streamable HTTP at /mcp, only procedures that chose .mcp()');
  const client = new Client({ name: 'demo', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: 'Bearer demo-bob' } } }));
  const { tools } = await client.listTools();
  show('tools/list  (name, then the annotations set by mcp({ effect }))', tools.map((t) => `${t.name.padEnd(16)} ${JSON.stringify(t.annotations)}`).join('\n'));
  const ok = await client.callTool({ name: 'contacts_search', arguments: { orgId: 'o1', query: 'tur' } });
  show('tools/call contacts_search { orgId: "o1", query: "tur" }', ok.structuredContent);
  const denied = await client.callTool({ name: 'contacts_get', arguments: { orgId: 'o2', id: 'c3' } });
  show('tools/call contacts_get for another org (same authz as HTTP)', { isError: denied.isError, content: denied.content[0].text });
  const bad = await client.callTool({ name: 'contacts_create', arguments: { orgId: 'o1', name: '', email: 'not-an-email' } });
  show('tools/call contacts_create with bad input (same validation as HTTP)', { isError: bad.isError, content: bad.content[0].text });
  await client.close();

  h('4. CLI: commands come from /rpc/manifest.json; flags from the input schema');
  if (!existsSync(`${root}.cli/realtime.mjs`)) execFileSync('node', ['scripts/build-cli.mjs'], { cwd: root, stdio: 'inherit' });
  const cli = (args, token = 'demo-bob') => {
    try {
      return execFileSync('node', ['.cli/realtime.mjs', ...args], { cwd: root, env: { ...process.env, REALTIME_URL: base, REALTIME_TOKEN: token }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return `${e.stdout ?? ''}${e.stderr ?? ''}(exit code ${e.status})`;
    }
  };
  show('realtime', cli([]));
  show('realtime whoami', cli(['whoami']));
  show('realtime contacts search --help', cli(['contacts', 'search', '--help']));
  show('realtime contacts search --org-id o1 --query a --limit 1', cli(['contacts', 'search', '--org-id', 'o1', '--query', 'a', '--limit', '1']));
  show('realtime contacts get --org-id o1 --id nope', cli(['contacts', 'get', '--org-id', 'o1', '--id', 'nope']));
  show('realtime contacts get --org-id o2 --id c3', cli(['contacts', 'get', '--org-id', 'o2', '--id', 'c3']));
  show('realtime contacts delete --id c1   (admin-only profile chose noCli)', cli(['contacts', 'delete', '--id', 'c1']));
  show('realtime contacts search   (missing required flags)', cli(['contacts', 'search']));

  h('5. AI tools: only procedures that chose .aiTool(); the agent acts as the token\'s user');
  const defs = await (await fetch(`${base}/rpc/ai/tools.json`)).json();
  show('GET /rpc/ai/tools.json  (pass straight to messages.create({ tools }))', defs.map((t) => `${t.name.padEnd(16)} ${t.description}`).join('\n'));
  const tool = async (label, body, token = 'demo-bob') => {
    const r = await fetch(`${base}/rpc/ai/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    show(`${label}\n  POST /rpc/ai/run ${JSON.stringify(body)}`, await r.json());
  };
  await tool('needsApproval: false runs right away', { tool: 'contacts_search', input: { orgId: 'o1', query: 'ada' } });
  await tool('needsApproval: true is held until a person approves', { tool: 'contacts_create', input: { orgId: 'o1', name: 'Hedy Lamarr', email: 'hedy@example.com' } });
  await tool('... and the caller can\'t approve its own call', { tool: 'contacts_create', input: { orgId: 'o1', name: 'Hedy Lamarr', email: 'hedy@example.com' }, approved: true });
  await tool('Agents get the user\'s permissions: grace (org o2) asking about o1', { tool: 'contacts_search', input: { orgId: 'o1', query: 'a' } }, 'demo-grace');
  await tool('contacts.get chose noAiTool, so there is no such tool', { tool: 'contacts_get', input: { orgId: 'o1', id: 'c1' } });

  h('6. Audit: every decision for every procedure, snapshotted to audit.md for review');
  const audit = await (await fetch(`${base}/rpc/audit.md`)).text();
  writeFileSync(`${root}audit.md`, `# Audit\n\nGenerated by \`npm run demo\` from GET /rpc/audit.md. A change to any decision shows up here in the diff.\n\n${audit}\n`);
  show('GET /rpc/audit.md  (dev only)', audit);

  h('7. Analytics: one event per call that reached the handler (dev also logs them)');
  await new Promise((r) => setTimeout(r, 300));
  const events = devLog.split('\n').filter((l) => l.startsWith('[analytics]')).map((l) => JSON.parse(l.slice(12)));
  if (dev) show('events logged by the dev server (Analytics Engine gets the same ones)', events.map((e) => `${e.event.padEnd(18)} ${e.surface.padEnd(4)} ${e.outcome.padEnd(5)} ${String(e.status).padEnd(4)} actor=${e.actorId ?? '-'} ${JSON.stringify(e.props)}`).join('\n'));
  else console.log('\n(start the demo without BASE to capture the dev server log)');
} finally {
  dev?.kill('SIGTERM');
}
process.exit(0);
