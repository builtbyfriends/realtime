// Decision: each case runs in a scratch copy of this app next to it, so the demo itself stays untouched.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, NoOpLog } from 'miniflare';

const root = new URL('..', import.meta.url).pathname;
const tmp = join(root, '..', 'demo-failure-tmp');
const h = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
// oxlint-disable-next-line no-control-regex
const clean = (s) => s.replaceAll(/\u001b\[[0-9;]*m/g, '').replaceAll(tmp + '/', '').replaceAll(root, '');

function fresh() {
  rmSync(tmp, { recursive: true, force: true });
  cpSync(root, tmp, { recursive: true, filter: (src) => !/\/(node_modules|\.cli|dist|\.cloudflare|demo-failure-tmp)(\/|$)/.test(src.slice(root.length - 1)) });
  symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules'));
}
function run(cmd, args) {
  try {
    return { code: 0, out: clean(execFileSync(cmd, args, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (error) {
    return { code: error.status, out: clean(`${error.stdout ?? ''}${error.stderr ?? ''}`) };
  }
}
const build = () => run('npx', ['vite', 'build', '--logLevel', 'error']);
const realtimeMessage = (out) => {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.includes('realtime found'));
  if (i < 0) {return out.trim();}
  const rest = lines.slice(i + 1);
  const end = rest.findIndex((l) => !l.startsWith('  - '));
  return [lines[i].replace(/^.*?(realtime found)/, '$1'), ...rest.slice(0, end < 0 ? rest.length : end)].join('\n');
};
async function start() {
  const out = join(tmp, '.cloudflare/output/v0/workers/default');
  const config = JSON.parse(readFileSync(join(out, 'worker.config.json'), 'utf8'));
  delete config.assets;
  for (const [k, v] of Object.entries(config.env)) {if (v.type !== 'text' && v.type !== 'json') delete config.env[k];}
  delete config.manifest.type;
  config.manifest.modulesRoot = join(out, 'bundle');
  for (const k of Object.keys(config.manifest.modules)) {
    if (k.endsWith('.map')) {delete config.manifest.modules[k];}
    else {config.manifest.modules[k].contents = readFileSync(join(out, 'bundle', k), 'utf8');}
  }
  const logs = [];
  const mf = new Miniflare({ log: new NoOpLog(), handleStructuredLogs: (l) => logs.push(l.message), workers: [{ config }] });
  try {
    await mf.ready;
    return 'Worker started.';
  } catch (error) {
    const uncaught = logs.find((m) => m.includes('Uncaught')) ?? String(error.message ?? error);
    return `Worker failed to start, so Cloudflare would reject the deploy:\n${uncaught.replace(/^service \S+: /, '')}`;
  } finally {
    await mf.dispose().catch(() => {});
  }
}

try {
  h('1. Type gate: `tsc --noEmit` (run by `npm run deploy` before `bwf deploy`)');
  fresh();
  cpSync(join(root, 'failures/type-mistakes.ts'), join(tmp, 'src/procedures/type-mistakes.ts'));
  const tsc = run('npx', ['tsc', '--noEmit', '-p', '.', '--pretty', 'false']);
  console.log(`\n$ npx tsc --noEmit   (exit ${tsc.code})\n${tsc.out.trim()}`);

  h('2. Load gate: `as any` gets past tsc and the bundler, but not Worker startup');
  fresh();
  cpSync(join(root, 'failures/hidden-with-any.ts'), join(tmp, 'src/procedures/hidden-with-any.ts'));
  const b2 = build();
  console.log(`\n$ npx vite build   (exit ${b2.code}: the bundler never type-checks)`);
  console.log(`\n$ start the built Worker, as Cloudflare does on upload\n${clean(await start())}`);

  h('3. Route guard: a plain bwf route skips every decision, so the build fails');
  fresh();
  mkdirSync(join(tmp, 'routes/api'), { recursive: true });
  cpSync(join(root, 'failures/raw-route.ts'), join(tmp, 'routes/api/contacts.ts'));
  const b3 = build();
  console.log(`\n$ npx vite build   (exit ${b3.code})\n${realtimeMessage(b3.out)}`);

  h('4. Route guard escape hatch: a raw route with a stated reason is allowed');
  fresh();
  mkdirSync(join(tmp, 'routes/webhooks'), { recursive: true });
  cpSync(join(root, 'failures/allowed-route.ts'), join(tmp, 'routes/webhooks/stripe.ts'));
  const b4 = build();
  console.log(`\n$ head -1 routes/webhooks/stripe.ts\n${readFileSync(join(tmp, 'routes/webhooks/stripe.ts'), 'utf8').split('\n')[0]}`);
  console.log(`\n$ npx vite build   (exit ${b4.code})`);

  h('5. Missing middleware file: nothing would serve /rpc or load the registry, so the build fails');
  fresh();
  rmSync(join(tmp, 'middleware/00.realtime.ts'));
  const b5 = build();
  console.log(`\n$ rm middleware/00.realtime.ts && npx vite build   (exit ${b5.code})\n${realtimeMessage(b5.out)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
