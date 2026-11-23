import { z } from 'zod';
import { procedure } from '@builtbyfriends/realtime-bwf';
import { and, db, eq, like } from '@builtbyfriends/bwf/db';
import { contacts } from '@schema';
import { adminOnly, Contact, signedIn } from './_shared';

const sameOrg = { policy: 'same-org', check: (user: { orgId: string }, input: { orgId: string }) => user.orgId === input.orgId };

export const get = procedure('contacts.get')
  .use(signedIn)
  .input(z.object({ orgId: z.string().describe('Organization id'), id: z.string().describe('Contact id') }))
  .authz(sameOrg)
  .output(Contact)
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' } })
  .analytics({ event: 'contact.viewed', props: (input) => ({ orgId: input.orgId }) })
  .mcp({ description: 'Look up one contact by id', effect: 'read', idempotent: true })
  .cli({ command: 'contacts get', description: 'Print one contact as JSON' })
  .noAiTool({ reason: 'Returns email addresses; agents use contacts.search, which leaves them out' })
  .handler(async ({ input, fail }) => {
    const row = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.orgId, input.orgId))).get();
    return row ?? fail('NOT_FOUND');
  });

export const search = procedure('contacts.search')
  .use(signedIn)
  .input(z.object({ orgId: z.string(), query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) }))
  .authz(sameOrg)
  .output(z.object({ results: z.array(z.object({ id: z.string(), name: z.string() })) }))
  .noErrors({ reason: 'An empty result is a valid answer, not an error' })
  .analytics({ event: 'contacts.searched', props: (input) => ({ orgId: input.orgId, limit: input.limit }) })
  .mcp({ description: 'Search contacts by name. Returns ids and names only.', effect: 'read', idempotent: true })
  .cli({ command: 'contacts search', description: 'Search contacts by name' })
  .aiTool({ description: 'Search contacts in an organization by name. Returns ids and names only.', needsApproval: false })
  .handler(async ({ input }) => {
    const rows = await db
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(and(eq(contacts.orgId, input.orgId), like(contacts.name, `%${input.query}%`)))
      .limit(input.limit);
    return { results: rows };
  });

export const create = procedure('contacts.create')
  .use(signedIn)
  .input(z.object({ orgId: z.string(), name: z.string().min(1).max(200), email: z.email() }))
  .authz(sameOrg)
  .output(Contact)
  .errors({ DUPLICATE_EMAIL: { status: 409, message: 'A contact with this email already exists' } })
  .analytics({ event: 'contact.created', props: (input) => ({ orgId: input.orgId }) })
  .mcp({ description: 'Create a contact', effect: 'write' })
  .cli({ command: 'contacts create', description: 'Create a contact' })
  .aiTool({ description: 'Create a contact in an organization', needsApproval: true })
  .handler(async ({ input, fail }) => {
    const dupe = await db.select().from(contacts).where(and(eq(contacts.orgId, input.orgId), eq(contacts.email, input.email))).get();
    if (dupe) {return fail('DUPLICATE_EMAIL');}
    const row = { id: `c${crypto.randomUUID().slice(0, 8)}`, ...input, createdAt: Date.now() };
    await db.insert(contacts).values(row);
    return row;
  });

export const remove = procedure('contacts.delete')
  .use(adminOnly)
  .input(z.object({ id: z.string() }))
  .output(z.object({ deleted: z.boolean() }))
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' } })
  .analytics({ event: 'contact.deleted' })
  .mcp({ description: 'Delete a contact permanently', effect: 'destructive' })
  .aiTool({ description: 'Delete a contact permanently', needsApproval: true })
  .handler(async ({ input, ctx, fail }) => {
    const where = and(eq(contacts.id, input.id), eq(contacts.orgId, ctx.orgId));
    if (!(await db.select().from(contacts).where(where).get())) {return fail('NOT_FOUND');}
    await db.delete(contacts).where(where);
    return { deleted: true };
  });
