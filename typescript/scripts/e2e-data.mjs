import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 9300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const dev = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(root, 'examples/chat-worker/.wrangler/e2e-state')], { cwd: join(root, 'examples/chat-worker'), stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
dev.stdout.on('data', (d) => (log += d));
dev.stderr.on('data', (d) => (log += d));
const call = async (name, body) => {
  const res = await fetch(`${base}/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
  const json = await res.json();
  assert.equal(res.status, 200, `${name}: ${JSON.stringify(json)}\n${log}`);
  return json.data;
};
const check = async (name, fn) => (await fn(), console.log(`  ok  ${name}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; ; i++) {
    if (i > 60) {throw new Error(`wrangler dev did not start:\n${log}`);}
    try {
      if ((await fetch(`${base}/rpc/messages.list`, { method: 'POST', body: JSON.stringify({ channel: 'warmup' }) })).ok) {break;}
    } catch {}
    await sleep(500);
  }
  const channel = `c${Date.now()}`;
  await check('send and list newest first', async () => {
    await call('messages.send', { channel, author: 'ann', body: 'first message about deployments' });
    await call('messages.send', { channel, author: 'bo', body: 'second message about lunch' });
    const rows = await call('messages.list', { channel });
    assert.deepEqual(rows.map((m) => m.author), ['bo', 'ann']);
  });
  await check('FTS5 search in the Durable Object', async () => {
    const rows = await call('messages.search', { channel, text: 'deploy' });
    assert.deepEqual(rows.map((m) => m.author), ['ann']);
  });
  await check('a delayed job runs from the alarm', async () => {
    await call('messages.send', { channel, author: 'ann', body: 'remind me', remindInMs: 1500 });
    assert.equal((await call('messages.list', { channel })).filter((m) => m.author === 'reminder').length, 0);
    await sleep(3500);
    assert.equal((await call('messages.list', { channel })).filter((m) => m.author === 'reminder').length, 1);
  });
  await check('a cancelled job never runs', async () => {
    const { job } = await call('messages.send', { channel, author: 'ann', body: 'never mind', remindInMs: 1500 });
    assert.deepEqual(await call('messages.cancelReminder', { job }), { cancelled: true });
    await sleep(3000);
    assert.equal((await call('messages.list', { channel })).filter((m) => m.author === 'reminder').length, 1);
  });
  console.log('data e2e passed');
} finally {
  dev.kill();
}
