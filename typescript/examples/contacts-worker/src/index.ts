import { rpcHandler } from '@builtbyfriends/realtime-http';
import { mcpHandler } from '@builtbyfriends/realtime-mcp';
import type { Env } from './procedures.js';
import { registry } from './registry.js';

const rpc = rpcHandler(registry, { openapi: { title: 'Contacts API', version: '0.1.0' } });
const mcp = mcpHandler(registry, { name: 'contacts', version: '0.1.0' });

export default {
  fetch(request, env, ctx) {
    if (mcp.matches(request)) {return mcp(request, env, ctx);}
    if (rpc.matches(request)) {return rpc(request, env, ctx);}
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
