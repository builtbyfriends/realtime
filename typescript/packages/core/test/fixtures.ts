import { z } from 'zod';
import { bearerAuth, createProcedures } from '@builtbyfriends/realtime';

export type User = { id: string; orgId: string; role: 'admin' | 'member' };
export type Env = { tokens: Record<string, User> };
export const env: Env = {
  tokens: {
    alice: { id: 'u-alice', orgId: 'o1', role: 'admin' },
    bob: { id: 'u-bob', orgId: 'o1', role: 'member' },
    eve: { id: 'u-eve', orgId: 'o2', role: 'member' },
  },
};

const { procedure, profile } = createProcedures<Env>();
export { procedure };
export const token = bearerAuth<User, Env>({ name: 'api-token', verify: (t, e) => e.tokens[t] ?? null, actorId: (u) => u.id });

export const req = (token?: string) =>
  new Request('https://api.test/rpc/x', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });

export const getContact = procedure('contacts.get')
  .auth(token)
  .input(z.object({ orgId: z.string(), id: z.string() }))
  .authz({ policy: 'same-org', check: (u, i) => u.orgId === i.orgId })
  .output(z.object({ id: z.string(), owner: z.string() }))
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' }, GONE: { status: 410, message: 'Contact was deleted' } })
  .analytics({ event: 'contact.viewed', props: (i) => ({ orgId: i.orgId }) })
  .mcp({ description: 'Look up one contact', effect: 'read' })
  .cli({ command: 'contacts get', description: 'Print one contact' })
  .aiTool({ description: 'Fetch one contact', needsApproval: false })
  .handler(({ input, ctx, fail }) => {
    if (input.id === 'missing') {return fail('NOT_FOUND');}
    if (input.id === 'gone') {return fail('GONE', 'Deleted on Tuesday');}
    if (input.id === 'boom') {throw new Error('database exploded');}
    if (input.id === 'badshape') {return { id: 1 } as any;}
    return { id: input.id, owner: ctx.id };
  });

export const purge = procedure('cache.purge')
  .use(
    profile('admin-only')
      .auth(token)
      .authz({ policy: 'admin', check: (u) => u.role === 'admin' })
      .noCli({ reason: 'Admin actions ship through the dashboard' }),
  )
  .noInput()
  .output(z.object({ purged: z.boolean() }))
  .noErrors({ reason: 'Purging is idempotent and cannot fail' })
  .noAnalytics({ reason: 'Purges are logged by the CDN already' })
  .mcp({ description: 'Purge the edge cache', effect: 'destructive' })
  .aiTool({ description: 'Purge the edge cache', needsApproval: true })
  .handler(() => ({ purged: true }));

export const ping = procedure('ping')
  .noAuth({ reason: 'Uptime checks run without credentials' })
  .noAuthz({ reason: 'Anyone may check whether we are up' })
  .noInput()
  .output(z.object({ ok: z.literal(true) }))
  .noErrors({ reason: 'Ping always answers when the Worker runs' })
  .noAnalytics({ reason: 'Health checks would drown real events' })
  .noMcp({ reason: 'Agents have no use for an uptime probe' })
  .cli({ command: 'ping', description: 'Check that the API is up' })
  .noAiTool({ reason: 'Agents have no use for an uptime probe' })
  .handler(() => ({ ok: true as const }));
