import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { bundle } from '../build.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const port = 5300 + Math.floor(Math.random() * 500);
const direct = `http://localhost:${port}`;
const proxyPort = port + 1000;
const base = `http://localhost:${proxyPort}`;
const auth = { authorization: 'Bearer ok', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function proxy() {
  const sockets = new Set();
  let paused = false;

  const server = net.createServer((client) => {
    if (paused) {return client.destroy();}

    const upstream = net.connect(port, 'localhost');

    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
    }

    client.pipe(upstream).pipe(client);
  });

  server.listen(proxyPort);

  return {
    cut() {
      paused = true;

      for (const socket of sockets) {socket.destroy();}
    },
    restore() {
      paused = false;
    },
    close: () => server.close(),
  };
}

let cable;
let browser;

const dev = spawn('npx', ['vite', 'dev', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';

dev.stdout.on('data', (d) => (log += d));

dev.stderr.on('data', (d) => (log += d));

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  let last;

  while (Date.now() < end) {
    try {
      last = await fn();

      if (last) {return last;}
    } catch (error) {
      last = error;
    }

    await sleep(50);
  }

  throw new Error(`timed out waiting for ${what}; last: ${String(last)}`);
}

async function callApi(request, name, input, token = 'ok') {
  const res = await request.post(`${direct}/call`, { headers: { ...auth, authorization: `Bearer ${token}` }, data: { name, input } });

  return res.json();
}

function watch(page) {
  const seen = { streams: 0, controls: [], calls: 0, open: 0, maxOpen: 0, streamsOpen: 0, maxStreamsOpen: 0 };
  const live = new Set();

  page.on('request', (req) => {
    const url = new URL(req.url());

    if (url.pathname === '/live' && req.method() === 'GET') {
      seen.streams += 1;
      seen.streamsOpen += 1;
      seen.maxStreamsOpen = Math.max(seen.maxStreamsOpen, seen.streamsOpen);
    }

    if (url.pathname === '/live' && req.method() === 'POST') {seen.controls.push(JSON.parse(req.postData() ?? '{}'));}

    if (url.pathname === '/call') {seen.calls += 1;}

    if (url.pathname === '/live' || url.pathname === '/call') {live.add(req);}

    seen.open = live.size;
    seen.maxOpen = Math.max(seen.maxOpen, live.size);
  });

  for (const done of ['requestfinished', 'requestfailed']) {
    page.on(done, (req) => {
      live.delete(req);

      if (new URL(req.url()).pathname === '/live' && req.method() === 'GET') {seen.streamsOpen -= 1;}

      seen.open = live.size;
    });
  }

  return seen;
}

const subscribes = (seen) => seen.controls.flatMap((c) => (c.operations ?? []).filter((op) => op.kind === 'subscribe'));

async function freshPage(browser, script) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const seen = watch(page);
  page.on('pageerror', (error) => console.log('  pageerror', error.message));
  await page.goto(`${base}/`);
  await page.addScriptTag({ content: script });

  return { context, page, seen };
}

const check = async (name, fn) => {
  await fn();
  results.push(name);
  console.log(`  ok  ${name}`);
};

try {
  await until(() => fetch(`${direct}/`).then((r) => r.ok, () => false), 'vite dev', 60_000);
  cable = proxy();
  const script = await bundle();
  browser = await chromium.launch();
  const output = {};

  await check('many views of one note share one stream, one subscription and one load', async () => {
    const counts = [];

    for (const views of [3, 60]) {
      const { context, page, seen } = await freshPage(browser, script);
      await page.evaluate((n) => window.harness.mount(Array.from({ length: n }, () => 'n-1'), true), views);
      await until(() => page.evaluate(() => [...document.querySelectorAll('[data-view="one"]')].every((el) => el.textContent === 'Note 1') && document.querySelectorAll('[data-view="one"]').length), 'views to fill');
      await until(() => page.evaluate(() => window.harness.list()?.includes('n-30=Note 30')), 'the list');
      await sleep(500);
      counts.push({ views, streams: seen.streams, subscribes: subscribes(seen).length, controls: seen.controls.length, calls: seen.calls, maxOpen: seen.maxOpen });
      await context.close();
    }

    output.sameTopic = counts;
    assert.equal(counts[0].streams, 1);
    assert.equal(counts[0].subscribes, 2, 'a note and its board are two topics');
    assert.equal(counts[0].calls, 2, 'one load for the note and one for the board');
    assert.deepEqual({ ...counts[1], views: 0, maxOpen: 0 }, { ...counts[0], views: 0, maxOpen: 0 }, `the counts grew with the views: ${JSON.stringify(counts)}`);
  });

  await check('views of thirty notes stay on one stream, and a command comes back', async () => {
    const { context, page, seen } = await freshPage(browser, script);
    const ids = Array.from({ length: 30 }, (_, i) => `n-${i + 1}`);
    await page.evaluate((list) => window.harness.mount(list, true), ids);
    await until(() => page.evaluate(() => [...document.querySelectorAll('[data-view="one"]')].every((el) => el.textContent)), 'views to fill');
    await sleep(500);
    output.distinct = { views: 30, streams: seen.streams, subscribes: subscribes(seen).length, controls: seen.controls.length, calls: seen.calls, maxOpen: seen.maxOpen, maxStreamsOpen: seen.maxStreamsOpen };
    assert.equal(seen.streams, 1);
    assert.equal(output.distinct.subscribes, 31, 'one subscription for each of the 30 notes and one for the board');
    assert.equal(seen.maxStreamsOpen, 1, 'more than one stream was open at once');
    const result = await Promise.race([page.evaluate(() => window.harness.rename('n-3', 'Sent while open')), sleep(5000).then(() => 'hung')]);
    assert.notEqual(result, 'hung', 'the command did not come back');
    assert.equal(result.ok, true);
    await until(() => page.evaluate(() => window.harness.titles()['n-3#2'] === 'Sent while open'), 'the new title');
    await context.close();
  });

  await check('an event from another window changes the record without loading it again', async () => {
    const { context, page, seen } = await freshPage(browser, script);
    await page.evaluate(() => window.harness.mount(['n-5', 'n-5'], true));
    await until(() => page.evaluate(() => window.harness.titles()['n-5#0'] === 'Note 5'), 'the first fill');
    await sleep(300);
    const calls = seen.calls;
    const answer = await callApi(page.context().request, 'notes.rename', { id: 'n-5', title: 'From elsewhere', requestId: crypto.randomUUID() });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    await until(() => page.evaluate(() => window.harness.titles()['n-5#1'] === 'From elsewhere'), 'the event to arrive');
    assert.equal(seen.calls, calls, 'the window loaded again instead of using the event');
    await context.close();
  });

  await check('an event says who ran the command and what acted for them', async () => {
    const { context, page } = await freshPage(browser, script);
    await page.evaluate(() => window.harness.mount(['n-8'], true));
    await until(() => page.evaluate(() => window.harness.titles()['n-8#0'] === 'Note 8'), 'the first fill');
    await sleep(300);
    const lastEvent = () => page.evaluate(() => window.harness.events.at(-1));
    await callApi(context.request, 'notes.rename', { id: 'n-8', title: 'By a person', requestId: crypto.randomUUID() });
    await until(() => page.evaluate(() => window.harness.titles()['n-8#0'] === 'By a person'), 'the person\'s event');
    const person = await lastEvent();
    await callApi(context.request, 'notes.rename', { id: 'n-8', title: 'By a thread', requestId: crypto.randomUUID() }, 'ok:thread');
    await until(() => page.evaluate(() => window.harness.titles()['n-8#0'] === 'By a thread'), 'the thread\'s event');
    const thread = await lastEvent();
    output.who = { person: { actor: person.actor, via: person.via, hasVia: 'via' in person }, thread: { actor: thread.actor, via: thread.via } };
    assert.equal(person.actor, 'u-1');
    assert.equal('via' in person, false, 'a person\'s tap carries no via');
    assert.deepEqual({ actor: thread.actor, via: thread.via }, { actor: 'u-1', via: 'thread-1' });
    await context.close();
  });

  await check('a stream that is down tells the app once, keeps the event, and the next try delivers it', async () => {
    const { context, page } = await freshPage(browser, script);
    const api = context.request;
    const state = async () => (await api.get(`${direct}/outage`)).json();
    await page.evaluate(() => window.harness.mount(['n-9'], true));
    await until(() => page.evaluate(() => window.harness.titles()['n-9#0'] === 'Note 9'), 'the first fill');
    await sleep(300);
    const before = (await state()).failures.length;
    await api.post(`${direct}/outage`, { data: { on: true } });
    const answer = await callApi(api, 'notes.rename', { id: 'n-9', title: 'While down', requestId: crypto.randomUUID() });
    assert.equal(answer.ok, true, 'the command still came back');
    await sleep(800);
    const down = await state();
    output.outage = { failures: down.failures.slice(before), titleWhileDown: await page.evaluate(() => window.harness.titles()['n-9#0']) };
    assert.equal(down.failures.length - before, 1, 'the app was told once');
    assert.deepEqual(down.failures.at(-1), { topic: 'notes:n-9', attempt: 1, retrying: true, message: 'the stream is down' });
    assert.equal(output.outage.titleWhileDown, 'Note 9', 'the window changed while the stream was down');
    await api.post(`${direct}/outage`, { data: { on: false } });
    const delivered = await (await api.post(`${direct}/deliver`)).json();
    assert.equal(delivered.left, 0);
    await until(() => page.evaluate(() => window.harness.titles()['n-9#0'] === 'While down'), 'the kept event to arrive');
    assert.equal((await state()).failures.length - before, 1, 'the app was told again');
    await context.close();
  });

  await check('an ended subscription is asked for again, and events keep coming when the server allows it', async () => {
    const { context, page, seen } = await freshPage(browser, script);
    const api = context.request;
    const asks = () => subscribes(seen).filter((op) => op.topic === 'notes:n-11').length;
    await page.evaluate(() => window.harness.mount(['n-11'], true));
    await until(() => page.evaluate(() => window.harness.titles()['n-11#0'] === 'Note 11'), 'the first fill');
    await sleep(300);
    const before = { asks: asks(), streams: seen.streams, calls: seen.calls };
    output.revokedThenAllowed = [];

    for (const round of [1, 2]) {
      const ended = await (await api.post(`${direct}/revoke`, { data: { topic: 'notes:n-11' } })).json();
      assert.equal(ended.revoked, 1, `the stream ended ${JSON.stringify(ended)} subscriptions`);
      await until(() => asks() === before.asks + round, 'the window to ask again');
      await until(() => seen.calls > before.calls + round - 1, 'the window to load again');
      const title = `After ${round}`;
      const answer = await callApi(api, 'notes.rename', { id: 'n-11', title, requestId: crypto.randomUUID() });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      await until(() => page.evaluate((t) => window.harness.titles()['n-11#0'] === t, title), `the event after round ${round}`);
      output.revokedThenAllowed.push({ round, asks: asks() - before.asks, streams: seen.streams, calls: seen.calls - before.calls });
    }

    assert.equal(seen.streams, before.streams, 'the stream opened again');
    assert.deepEqual(await page.evaluate(() => window.harness.refusals), [], 'the app was told it was refused');
    await context.close();
  });

  await check('an ended subscription the server refuses is reported once, and nothing asks again', async () => {
    const { context, page, seen } = await freshPage(browser, script);
    const api = context.request;
    const asks = () => subscribes(seen).filter((op) => op.topic === 'notes:n-12').length;
    await page.evaluate(() => window.harness.mount(['n-12'], false));
    await until(() => page.evaluate(() => window.harness.titles()['n-12#0'] === 'Note 12'), 'the first fill');
    await sleep(300);
    const before = asks();
    await api.post(`${direct}/access`, { data: { deny: ['notes:n-12'] } });

    try {
      const ended = await (await api.post(`${direct}/revoke`, { data: { topic: 'notes:n-12' } })).json();
      assert.equal(ended.revoked, 1);
      await until(() => page.evaluate(() => window.harness.refusals.length), 'the app to be told');
      await sleep(1500);
      const refusals = await page.evaluate(() => window.harness.refusals);
      output.revokedThenRefused = { refusals, asks: asks() - before, streams: seen.streams };
      assert.equal(refusals.length, 1, 'the app was told more than once');
      assert.deepEqual({ name: refusals[0].name, topic: refusals[0].topic }, { name: 'notes.Note', topic: 'notes:n-12' });
      assert.equal(asks() - before, 1, 'the window asked more than once');
      const answer = await callApi(api, 'notes.rename', { id: 'n-12', title: 'Not for this window', requestId: crypto.randomUUID() });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      await sleep(800);
      assert.equal(await page.evaluate(() => window.harness.titles()['n-12#0']), 'Note 12', 'the window changed after the refusal');
    } finally {
      await api.post(`${direct}/access`, { data: { deny: [] } });
    }

    await context.close();
  });

  await check('a drop and a reconnect load again and leave the newest record', async () => {
    const { context, page, seen } = await freshPage(browser, script);
    await page.evaluate(() => window.harness.mount(['n-7'], true));
    await until(() => page.evaluate(() => window.harness.titles()['n-7#0'] === 'Note 7'), 'the first fill');
    await sleep(300);
    const streamsBefore = seen.streams;
    const callsBefore = seen.calls;
    cable.cut();
    const other = await browser.newContext();
    await callApi(other.request, 'notes.rename', { id: 'n-7', title: 'While away 1', requestId: crypto.randomUUID() });
    await callApi(other.request, 'notes.rename', { id: 'n-7', title: 'While away 2', requestId: crypto.randomUUID() });
    await sleep(800);
    const during = await page.evaluate(() => window.harness.titles()['n-7#0']);
    cable.restore();
    await until(() => page.evaluate(() => window.harness.titles()['n-7#0'] === 'While away 2'), 'the reload', 20_000);
    output.drop = { titleDuringDrop: during, streamsBefore, streamsAfter: seen.streams, callsBefore, callsAfter: seen.calls };
    assert.equal(during, 'Note 7', 'the window changed while it was cut off');
    assert.ok(seen.streams > streamsBefore, 'the stream did not open again');
    assert.ok(seen.calls > callsBefore, 'the window did not load again');
    await other.close();
    await context.close();
  });

  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error);
  console.error(log.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close();
  cable?.close();
  dev.kill('SIGTERM');
}

console.log(`${results.length} checks passed`);

process.exit(process.exitCode ?? 0);
