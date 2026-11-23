import type { Plugin, ViteDevServer } from 'vite';
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RealtimePluginOptions = {
  /** Where procedures live. Default "src/procedures" (bwf scans src/ for bindings, so @builtbyfriends/bwf/db etc. just work). */
  dir?: string;
  /** Analytics Engine binding. Default "ANALYTICS". Pass false only together with an explicit reason in code review. */
  analyticsBinding?: string;
  /** Also print each analytics event to the console during `vite dev`. Default true. */
  logEventsInDev?: boolean;
  /** Default "/rpc". */
  basePath?: string;
  /** Default "/mcp". */
  mcpRoute?: string;
};

const ID = 'virtual:realtime/registry';
const RESOLVED = '\0' + ID;
const PAGE_ID = 'virtual:realtime/devtools-page';
const PAGE_RESOLVED = '\0' + PAGE_ID;
const ALLOW_RE = /\/\/\s*realtime-allow:\s*(.+)/;

/**
 * realtime for bwf. Finds every procedure in `src/procedures/`, builds the registry, and
 * checks the two things bwf cannot: that the realtime middleware file exists (it serves
 * /rpc and /mcp and loads the registry at startup, which is the deploy gate) and that
 * no plain bwf route skips the nine decisions.
 */
export function realtime(options: RealtimePluginOptions = {}): Plugin {
  const dir = options.dir ?? 'src/procedures';
  const analytics = options.analyticsBinding ?? 'ANALYTICS';
  let root = process.cwd();
  let dev = false;

  const procedureFiles = () =>
    globSync(`${dir}/**/*.{ts,tsx,js,mts}`, { cwd: root })
      .filter((f) => !/\.(test|spec)\.|\/_|\.d\.ts$/.test(f))
      .sort();

  const problems = (): Array<string> => {
    const out: Array<string> = [];
    const mwDir = join(root, 'middleware');
    const stub = existsSync(mwDir) && readdirSync(mwDir).some((f) => readFileSync(join(mwDir, f), 'utf8').includes('@builtbyfriends/realtime-bwf/middleware'));
    if (!stub) {out.push('middleware/ has no realtime middleware. Run `npx realtime init`, or create middleware/00.realtime.ts containing: export { default } from \'@builtbyfriends/realtime-bwf/middleware\';');}
    const routesDir = join(root, 'routes');
    if (existsSync(routesDir)) {
      for (const f of globSync('**/*.{ts,tsx,js,jsx,mts,mjs}', { cwd: routesDir })) {
        const reason = ALLOW_RE.exec(readFileSync(join(routesDir, f), 'utf8'))?.[1]?.trim() ?? '';
        if (reason.split(/\s+/).filter(Boolean).length < 3)
          {out.push(`routes/${f} is a plain bwf route, so it skips auth, authz, input, output, errors, analytics, MCP, CLI and AI tool decisions. Move it to ${dir}/ as a procedure, or keep it and add "// realtime-allow: <why this must be a raw route>" (at least three words).`);}
      }
    }
    if (procedureFiles().length === 0) {out.push(`${dir}/ has no procedures.`);}
    return out;
  };

  return {
    name: 'realtime:bwf',
    configResolved(config) {
      root = config.root;
      dev = config.command === 'serve';
    },
    buildStart() {
      const found = problems();
      if (found.length) {this.error(`realtime found ${found.length} problem(s):\n  - ${found.join('\n  - ')}`);}
    },
    resolveId(id) {
      if (id === ID) {return RESOLVED;}
      if (id === PAGE_ID) {return PAGE_RESOLVED;}
    },
    load(id) {
      if (id === PAGE_RESOLVED) {return `export default ${JSON.stringify(dev ? readFileSync(new URL('./devtools.html', import.meta.url), 'utf8') : '')};`;}
      if (id !== RESOLVED) {return;}
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const files = procedureFiles();
      const logEvents = dev && options.logEventsInDev !== false;
      return [
        `import { defineRegistry } from '@builtbyfriends/realtime';`,
        `import { analyticsEngine, fanOut } from '@builtbyfriends/realtime-analytics';`,
        ...files.map((f, i) => `import * as m${i} from ${JSON.stringify('/' + f)};`),
        // Decision: pick up unfinished builders too, so a procedure missing .handler() fails instead of vanishing.
        `const found = [${files.map((_, i) => `...Object.values(m${i})`).join(', ')}]`,
        `  .filter((v) => v && (v['~realtime'] === 'procedure' || v['~realtime'] === 'builder'));`,
        `const console_ = { name: 'console', track: (e) => console.log('[analytics]', JSON.stringify(e)) };`,
        `const ae = analyticsEngine({ binding: ${JSON.stringify(analytics)} });`,
        `export const registry = defineRegistry(found, { analytics: ${logEvents ? 'fanOut(ae, console_)' : 'ae'} });`,
        `export const app = ${JSON.stringify({ name: pkg.name ?? 'app', version: pkg.version ?? '0.0.0', basePath: options.basePath ?? '/rpc', mcpRoute: options.mcpRoute ?? '/mcp' })};`,
      ].join('\n');
    },
    configureServer(server: ViteDevServer) {
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        printUrls();
        const url = server.resolvedUrls?.local[0];
        if (url) {server.config.logger.info(`  \x1b[32m➜\x1b[0m  \x1b[1mrealtime\x1b[0m:    \x1b[36m${url.replace(/\/$/, '')}/__realtime\x1b[0m  (network, MCP and AI chat visualizers)`);}
      };
      // Decision: a new or deleted procedure file changes the registry module itself, so reload it.
      const reload = (file: string) => {
        if (!relative(root, file).startsWith(dir)) {return;}
        for (const env of Object.values(server.environments)) {
          const mod = env.moduleGraph.getModuleById(RESOLVED);
          if (mod) {env.moduleGraph.invalidateModule(mod);}
        }
      };
      const pagePath = fileURLToPath(new URL('./devtools.html', import.meta.url));
      server.watcher.add(pagePath);
      server.watcher.on('change', (file) => {
        if (file !== pagePath) {return;}
        for (const env of Object.values(server.environments)) {
          const mod = env.moduleGraph.getModuleById(PAGE_RESOLVED);
          if (mod) {env.moduleGraph.invalidateModule(mod);}
        }
      });
      server.watcher.on('add', reload);
      server.watcher.on('unlink', reload);
    },
  };
}
