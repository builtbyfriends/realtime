import { z } from 'zod';
import { anyOf, bearerAuth, createProcedures } from '@builtbyfriends/realtime';

export type User = { id: string; orgId: string; role: 'admin' | 'member' };
export type Env = {
  API_TOKENS: string;
  ANALYTICS: { writeDataPoint(p: unknown): void };
};

const { procedure, profile } = createProcedures<Env>();

const Tokens = z.record(z.string(), z.object({ id: z.string(), orgId: z.string(), role: z.enum(['admin', 'member']) }));

const apiToken = bearerAuth<User, Env>({
  name: 'api-token',
  verify: (token, env) => Tokens.parse(JSON.parse(env.API_TOKENS))[token] ?? null,
  actorId: (u) => u.id,
});
const session = anyOf('session-or-token', apiToken);

const Contact = z.object({ id: z.string(), orgId: z.string(), name: z.string(), email: z.email() });
type Contact = z.infer<typeof Contact>;
const contacts = new Map<string, Contact>([
  ['c1', { id: 'c1', orgId: 'o1', name: 'Ada Lovelace', email: 'ada@example.com' }],
  ['c2', { id: 'c2', orgId: 'o1', name: 'Alan Turing', email: 'alan@example.com' }],
  ['c3', { id: 'c3', orgId: 'o2', name: 'Grace Hopper', email: 'grace@example.com' }],
]);

const orgMember = profile('org-member').auth(session);

const adminOnly = profile('admin-only')
  .auth(session)
  .authz({ policy: 'admin', check: (user) => user.role === 'admin' })
  .noCli({ reason: 'Admin actions ship through the dashboard only' });

export const getContact = procedure('contacts.get')
  .use(orgMember)
  .input(z.object({ orgId: z.string().describe('Organization id'), id: z.string().describe('Contact id') }))
  .authz({ policy: 'same-org', check: (user, input) => user.orgId === input.orgId })
  .output(Contact)
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' } })
  .analytics({ event: 'contact.viewed', props: (input) => ({ orgId: input.orgId }) })
  .mcp({ description: 'Look up one contact by id', effect: 'read', idempotent: true })
  .cli({ command: 'contacts get', description: 'Print one contact as JSON' })
  .noAiTool({ reason: 'Returns PII; agents use contacts.search, which redacts email' })
  .handler(({ input, fail }) => {
    const c = contacts.get(input.id);
    if (!c || c.orgId !== input.orgId) {return fail('NOT_FOUND');}
    return c;
  });

export const searchContacts = procedure('contacts.search')
  .use(orgMember)
  .input(z.object({ orgId: z.string(), query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) }))
  .authz({ policy: 'same-org', check: (user, input) => user.orgId === input.orgId })
  .output(z.object({ results: z.array(z.object({ id: z.string(), name: z.string() })) }))
  .noErrors({ reason: 'An empty result is a valid answer, not an error' })
  .analytics({ event: 'contacts.searched', props: (input) => ({ orgId: input.orgId, limit: input.limit }) })
  .mcp({ description: 'Search contacts by name', effect: 'read', idempotent: true })
  .cli({ command: 'contacts search', description: 'Search contacts by name' })
  .aiTool({ description: 'Search contacts in an organization by name. Returns ids and names only.', needsApproval: false })
  .handler(({ input }) => ({
    results: [...contacts.values()]
      .filter((c) => c.orgId === input.orgId && c.name.toLowerCase().includes(input.query.toLowerCase()))
      .slice(0, input.limit)
      .map(({ id, name }) => ({ id, name })),
  }));

export const deleteContact = procedure('contacts.delete')
  .use(adminOnly)
  .input(z.object({ id: z.string() }))
  .output(z.object({ deleted: z.boolean() }))
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' } })
  .analytics({ event: 'contact.deleted' })
  .mcp({ description: 'Delete a contact permanently', effect: 'destructive' })
  .aiTool({ description: 'Delete a contact permanently', needsApproval: true })
  .handler(({ input, ctx, fail }) => {
    const c = contacts.get(input.id);
    if (!c || c.orgId !== ctx.orgId) {return fail('NOT_FOUND');}
    contacts.delete(input.id);
    return { deleted: true };
  });

export const status = procedure('status')
  .noAuth({ reason: 'Uptime checks run without credentials' })
  .noAuthz({ reason: 'Anyone may see whether the service is up' })
  .noInput()
  .output(z.object({ ok: z.boolean(), contacts: z.number() }))
  .noErrors({ reason: 'Status always answers; failures surface as 500s' })
  .noAnalytics({ reason: 'Health checks every few seconds would drown real events' })
  .noMcp({ reason: 'Agents have no use for an uptime probe' })
  .cli({ command: 'status', description: 'Check that the API is up' })
  .noAiTool({ reason: 'Agents have no use for an uptime probe' })
  .handler(() => ({ ok: true, contacts: contacts.size }));
