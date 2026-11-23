import { Miniflare } from 'miniflare';
import fs from 'node:fs';
const out = process.argv[2];
const config = JSON.parse(fs.readFileSync(out + '/worker.config.json', 'utf8'));
delete config.assets; delete config.env.ASSETS;
delete config.manifest.type; config.manifest.modulesRoot = out + '/bundle';
for (const k of Object.keys(config.manifest.modules)) { if (k.endsWith('.map')) {delete config.manifest.modules[k];} else {config.manifest.modules[k].contents = fs.readFileSync(out + '/bundle/' + k, 'utf8');} }
const mf = new Miniflare({ workers: [{ config }] });
try {
  await mf.ready; console.log('worker started');
  for (const [m, p, h] of [['POST','/rpc/whoami',{authorization:'Bearer t-alice'}],['POST','/rpc/whoami',{}],['GET','/rpc/manifest.json',{}]]) {
    const r = await mf.dispatchFetch('http://x' + p, { method: m, headers: h });
    console.log(m, p, r.status, (await r.text()).slice(0, 200));
  }
} catch (error) { console.log('ERROR', String(error).slice(0, 400)); }
await mf.dispose();
