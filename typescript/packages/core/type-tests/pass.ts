// Decision: compiled by the typecheck script. Each @ts-expect-error is a mistake the types must reject;
// if one stops failing, tsc reports the unused directive and the build breaks.
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import { bearerAuth, createProcedures, defineRegistry } from '@builtbyfriends/realtime';
import type { InputOf, OutputOf } from '@builtbyfriends/realtime';

type Env = { DB: { get(id: string): string | null } };
type User = { id: string; orgId: string };
const { procedure, profile } = createProcedures<Env>();
const token = bearerAuth<User, Env>({ verify: () => ({ id: 'u1', orgId: 'o1' }) });
const R = { reason: 'Covered by a test fixture only' } as const;

export const getContact = procedure('contacts.get')
  .auth(token)
  .input(z.object({ orgId: z.string(), id: z.string(), limit: z.number().default(10) }))
  .authz({
    policy: 'same-org',
    check: (ctx, input) => {
      expectTypeOf(ctx).toEqualTypeOf<User>();
      expectTypeOf(input).toEqualTypeOf<{ orgId: string; id: string; limit: number }>();
      return ctx.orgId === input.orgId;
    },
  })
  .output(z.object({ id: z.string() }))
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' } })
  .analytics({ event: 'contact.viewed', props: (input, ctx) => ({ orgId: input.orgId, user: ctx.id }) })
  .mcp({ description: 'Look up one contact', effect: 'read' })
  .cli({ command: 'contacts get', description: 'Print a contact' })
  .noAiTool({ reason: 'Returns PII; agents use contacts.search' })
  .handler(async ({ input, ctx, env, fail }) => {
    expectTypeOf(env).toEqualTypeOf<Env>();
    expectTypeOf(fail).parameter(0).toEqualTypeOf<'NOT_FOUND'>();
    const row = env.DB.get(input.id);
    if (!row) {return fail('NOT_FOUND');}
    return { id: row + ctx.id };
  });
expectTypeOf<InputOf<typeof getContact>>().toEqualTypeOf<{ orgId: string; id: string; limit?: number | undefined }>();
expectTypeOf<OutputOf<typeof getContact>>().toEqualTypeOf<{ id: string }>();

procedure('any.order')
  .noCli(R).output(z.object({})).noMcp(R).noAuth(R).noAiTool(R).noAnalytics(R).noErrors(R).noInput().noAuthz(R)
  .handler(({ ctx, input }) => {
    expectTypeOf(ctx).toEqualTypeOf<null>();
    expectTypeOf(input).toEqualTypeOf<undefined>();
    return {};
  });

// @ts-expect-error authz before auth: parameter is "Decide authentication first: ..."
procedure('x').authz({ policy: 'p', check: () => true });

// @ts-expect-error parameter is "Undecided: authz, errors, analytics, mcp, cli, aiTool. ..."
procedure('x').noAuth(R).noInput().output(z.object({})).handler(() => ({}));

// @ts-expect-error output is required: there is no noOutput()
void procedure('x').noOutput;

// @ts-expect-error a decided concern's methods are gone: auth after noAuth
procedure('x').noAuth(R).auth(token);

// @ts-expect-error deciding the same concern twice
procedure('x').noInput().noInput();

// @ts-expect-error placeholder reason
procedure('x').noAuth({ reason: 'n/a' });
// @ts-expect-error two words are not a reason
procedure('x').noMcp({ reason: 'not needed' });
// @ts-expect-error a reason is required
procedure('x').noMcp({});
// Decision: a computed string passes the types; the registry checks it at load.
declare const computed: string;
procedure('x').noMcp({ reason: computed });

// @ts-expect-error mcp must say whether it reads, writes or destroys
procedure('x').mcp({ description: 'A tool' });
// @ts-expect-error aiTool must say whether a person approves each call
procedure('x').aiTool({ description: 'A tool' });

// @ts-expect-error codes the pipeline uses are reserved
procedure('x').errors({ FORBIDDEN: { status: 403, message: 'No' } });

procedure('x').noAuth(R).noAuthz(R).noInput().output(z.object({})).errors({ BUSY: { status: 503, message: 'Busy' } })
  .noAnalytics(R).noMcp(R).noCli(R).noAiTool(R)
  // @ts-expect-error only declared codes
  .handler(({ fail }) => fail('NOPE'));

procedure('x').noAuth(R).noAuthz(R).noInput().output(z.object({})).noErrors(R)
  .noAnalytics(R).noMcp(R).noCli(R).noAiTool(R)
  // @ts-expect-error after noErrors there is nothing to fail with
  .handler(({ fail }) => fail('ANY'));

procedure('x').noAuth(R).noAuthz(R).noInput().output(z.object({ n: z.number() })).noErrors(R)
  .noAnalytics(R).noMcp(R).noCli(R).noAiTool(R)
  // @ts-expect-error the handler must return the output schema's input type
  .handler(() => ({ n: 'one' }));

const internal = profile('internal').auth(token).authz({ policy: 'staff', check: (u) => u.id.startsWith('staff-') }).noCli(R);
procedure('p').use(internal).noInput().output(z.object({})).noErrors(R).noAnalytics(R).noMcp(R).noAiTool(R)
  .handler(({ ctx }) => {
    expectTypeOf(ctx).toEqualTypeOf<User>();
    return {};
  });
// @ts-expect-error the profile decides cli, which is already decided here
procedure('p').noCli(R).use(internal);

// @ts-expect-error an unfinished builder is not a procedure
defineRegistry([procedure('x').noAuth(R)]);
