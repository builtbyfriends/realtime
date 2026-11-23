import { z } from 'zod';
import { procedure } from '@builtbyfriends/realtime-bwf';
import { signedIn } from './_shared';

export const forgot = procedure('contacts.count')
  .use(signedIn)
  .input(z.object({ orgId: z.string() }))
  .output(z.object({ count: z.number() }))
  .mcp({ description: 'Count contacts', effect: 'read' })
  .handler(async () => ({ count: 0 }));

export const lazy = procedure('lazy')
  .noAuth({ reason: 'n/a' });

export const undeclared = procedure('contacts.archive')
  .use(signedIn)
  .noAuthz({ reason: 'Archiving only touches the caller\'s own org' })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.boolean() }))
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' } })
  .noAnalytics({ reason: 'Covered by the audit log instead' })
  .noMcp({ reason: 'Dashboard-only action for now' })
  .noCli({ reason: 'Dashboard-only action for now' })
  .noAiTool({ reason: 'Dashboard-only action for now' })
  .handler(({ fail }) => fail('ALREADY_ARCHIVED'));

export const authzFirst = procedure('authz.first')
  // oxlint-disable-next-line typescript/no-explicit-any -- fixture: the check is left untyped on purpose
  .authz({ policy: 'admin', check: (user: any) => user.role === 'admin' });

export const twice = procedure('twice')
  .input(z.object({ a: z.string() }))
  .input(z.object({ b: z.string() }));

export const noEffect = procedure('no.effect')
  .mcp({ description: 'Does something' });

export const noApproval = procedure('no.approval')
  .aiTool({ description: 'Does something' });

export const wrongOutput = procedure('wrong.output')
  .noAuth({ reason: 'Public read of static data' })
  .noAuthz({ reason: 'Public read of static data' })
  .noInput()
  .output(z.object({ count: z.number() }))
  .noErrors({ reason: 'Static data cannot fail' })
  .noAnalytics({ reason: 'Static data is not worth tracking' })
  .noMcp({ reason: 'Not useful to agents at all' })
  .noCli({ reason: 'Not useful from a terminal' })
  .noAiTool({ reason: 'Not useful to agents at all' })
  .handler(() => ({ count: 'three' }));
