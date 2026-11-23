import { rpcHandler } from '@builtbyfriends/realtime-http';
import { mcpHandler } from '@builtbyfriends/realtime-mcp';
import { anthropicTools, runTool, toolInfo, toolResultContent } from '@builtbyfriends/realtime-ai';
import { app, registry } from 'virtual:realtime/registry';
import { createDevtools } from './devtools.js';
import { aiRunApproved, setAppRegistry } from './index.js';
import type { BwfEnv } from './index.js';

// Decision: built when the Worker starts. bwf loads middleware eagerly, so a registry problem (an
// unfinished procedure, a weak reason, a duplicate name) stops the Worker and Cloudflare rejects the deploy.
setAppRegistry(registry);
const rpc = rpcHandler(registry, { basePath: app.basePath, openapi: { title: app.name, version: app.version } });
const mcp = mcpHandler(registry, { name: app.name, version: app.version, route: app.mcpRoute });
const tools = JSON.stringify(anthropicTools(registry));
// Decision: call visualizers at /__realtime only under `vite dev`. The build replaces
// import.meta.env.DEV with false, so this and the devtools module drop out of production bundles.
const devtools = import.meta.env.DEV ? createDevtools(registry, app) : null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Decision: bwf's defineMiddleware() is an identity function that adds types, so this file doesn't
// import bwf at all and works the same whatever the host package is called.
type HostContext = { req: { raw: Request }; env: BwfEnv; executionCtx: { waitUntil(p: Promise<unknown>): void } };

export default async (c: HostContext, next: () => Promise<void>): Promise<Response | void> => {
  const request = c.req.raw;
  const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
  if (devtools?.serves(new URL(request.url).pathname)) {return devtools.serve(request);}
  const res = devtools ? await devtools.record(request, waitUntil, () => handle(request, c.env, waitUntil)) : await handle(request, c.env, waitUntil);
  if (res) {return res;}
  await next();
};

type RunBody = { tool: string; input: unknown };

function readRunBody(value: unknown): RunBody | null {
  if (typeof value !== 'object' || value === null || !('tool' in value) || typeof value.tool !== 'string' || !value.tool) {return null;}
  return { tool: value.tool, input: 'input' in value ? value.input : undefined };
}

// Decision: null means "not ours", so bwf carries on to its own routes.
async function handle(request: Request, env: BwfEnv, waitUntil: (p: Promise<unknown>) => void): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const ctx = { waitUntil };

  if (mcp.matches(request)) {return mcp(request, env, ctx);}

  if (path === `${app.basePath}/ai/tools.json` && request.method === 'GET') {return new Response(tools, { headers: { 'content-type': 'application/json' } });}
  if (path === `${app.basePath}/ai/run` && request.method === 'POST') {
    const body = readRunBody(await request.json().catch(() => null));
    if (!body) {return json({ error: { code: 'INVALID_INPUT', message: 'Send { tool, input }' } }, 400);}
    const { tool, input } = body;
    // Decision: the caller can't approve its own call, so the body carries no approval. The app decides with approveAiRuns().
    const needsApproval = toolInfo(registry).some((t) => t.name === tool && t.needsApproval);
    const approved = needsApproval && (await aiRunApproved({ request, env, tool, input }));
    const run = await runTool(registry, tool, input, { request, env, waitUntil, approved });
    return json({ status: run.status, tool_result: toolResultContent(run) });
  }

  if (import.meta.env.DEV && path === `${app.basePath}/audit.md`) {return new Response(registry.auditTable(), { headers: { 'content-type': 'text/markdown' } });}

  if (rpc.matches(request)) {return rpc(request, env, ctx);}
  return null;
}
