import { z } from 'zod';
import { createProcedures, defineRegistry } from '@builtbyfriends/realtime';
import { rpcHandler } from '@builtbyfriends/realtime-http';
import { data, Deployment } from './data.js';

export { Deployment };

type Env = { DEPLOYMENT: DurableObjectNamespace };
const { procedure } = createProcedures<Env>();
const open = { reason: 'Example data is public on purpose' } as const;

const Message = z.object({ _id: z.string(), _creationTime: z.number(), channel: z.string(), author: z.string(), body: z.string(), at: z.number() });

const send = procedure('messages.send')
  .noAuth(open)
  .noAuthz(open)
  .input(z.object({ channel: z.string(), author: z.string(), body: z.string().min(1), remindInMs: z.number().int().positive().optional() }))
  .output(z.object({ id: z.string(), job: z.string().optional() }))
  .noErrors({ reason: 'Nothing here can fail by design' })
  .noAnalytics({ reason: 'Example without an analytics provider' })
  .noMcp({ reason: 'Example without agent tools' })
  .noCli({ reason: 'Example without a command line' })
  .noAiTool({ reason: 'Example without agent tools' })
  .handler(async ({ input, env }) => {
    const client = data.client(env.DEPLOYMENT);
    if (input.remindInMs) {return client.mutate.sendWithReminder({ ...input, remindInMs: input.remindInMs });}
    return { id: await client.mutate.send(input) };
  });

const cancel = procedure('messages.cancelReminder')
  .noAuth(open)
  .noAuthz(open)
  .input(z.object({ job: z.string() }))
  .output(z.object({ cancelled: z.boolean() }))
  .noErrors({ reason: 'Nothing here can fail by design' })
  .noAnalytics({ reason: 'Example without an analytics provider' })
  .noMcp({ reason: 'Example without agent tools' })
  .noCli({ reason: 'Example without a command line' })
  .noAiTool({ reason: 'Example without agent tools' })
  .handler(async ({ input, env }) => ({ cancelled: await data.client(env.DEPLOYMENT).mutate.cancel(input) }));

const list = procedure('messages.list')
  .noAuth(open)
  .noAuthz(open)
  .input(z.object({ channel: z.string(), limit: z.number().int().min(1).max(100).default(20) }))
  .output(z.array(Message))
  .noErrors({ reason: 'Nothing here can fail by design' })
  .noAnalytics({ reason: 'Example without an analytics provider' })
  .noMcp({ reason: 'Example without agent tools' })
  .noCli({ reason: 'Example without a command line' })
  .noAiTool({ reason: 'Example without agent tools' })
  .handler(({ input, env }) => data.client(env.DEPLOYMENT).query.list(input));

const search = procedure('messages.search')
  .noAuth(open)
  .noAuthz(open)
  .input(z.object({ channel: z.string(), text: z.string() }))
  .output(z.array(Message))
  .noErrors({ reason: 'Nothing here can fail by design' })
  .noAnalytics({ reason: 'Example without an analytics provider' })
  .noMcp({ reason: 'Example without agent tools' })
  .noCli({ reason: 'Example without a command line' })
  .noAiTool({ reason: 'Example without agent tools' })
  .handler(({ input, env }) => data.client(env.DEPLOYMENT).query.search(input));

export const registry = defineRegistry([send, cancel, list, search]);
const rpc = rpcHandler(registry);

export default {
  fetch(request, env, ctx) {
    return rpc.matches(request) ? rpc(request, env, ctx) : new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
