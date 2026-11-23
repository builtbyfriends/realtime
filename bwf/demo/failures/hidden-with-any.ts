import { z } from 'zod';
import { procedure } from '@builtbyfriends/realtime-bwf';

// oxlint-disable-next-line typescript/no-explicit-any -- fixture: hides the gaps with `as any` on purpose
export const sneaky = (procedure('contacts.sneaky') as any)
  .noAuth({ reason: 'Public because reasons' })
  .output(z.object({ ok: z.boolean() }))
  .handler(() => ({ ok: true }));

// oxlint-disable-next-line typescript/no-explicit-any -- fixture: hides the gaps with `as any` on purpose
export const weak = (procedure('contacts.weak') as any)
  .noAuth({ reason: 'todo' })
  .noAuthz({ reason: 'todo' })
  .noInput()
  .output(z.object({ ok: z.boolean() }))
  .noErrors({ reason: 'todo' })
  .noAnalytics({ reason: 'todo' })
  .noMcp({ reason: 'todo' })
  .noCli({ reason: 'todo' })
  .noAiTool({ reason: 'todo' })
  .handler(() => ({ ok: true }));
