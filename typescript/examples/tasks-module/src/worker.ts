import { defineRegistry } from '@builtbyfriends/realtime';
import { rpcHandler } from '@builtbyfriends/realtime-http';
import { mcpHandler } from '@builtbyfriends/realtime-mcp';
import { TaskStore, tasksIndex, tasksModule } from './module.js';
import type { Env } from './module.js';

export const store = new TaskStore();
export const module = tasksModule(store);
export const index = tasksIndex(store);

// Decision: built at module scope, so a contract or module that doesn't load fails `wrangler deploy` instead of shipping.
export const registry = defineRegistry([...module.procedures, ...index.procedures]);

const rpc = rpcHandler(registry, { openapi: { title: 'Tasks API', version: '0.1.0' } });
const mcp = mcpHandler(registry, { name: 'tasks', version: '0.1.0' });

export default {
  fetch(request, env, ctx) {
    if (mcp.matches(request)) {return mcp(request, env, ctx);}

    if (rpc.matches(request)) {return rpc(request, env, ctx);}

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
