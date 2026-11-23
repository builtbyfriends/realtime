import { z } from 'zod';
import { bearerAuth, createProcedures, defineRegistry } from '@builtbyfriends/realtime';
import { analyticsEngine } from '@builtbyfriends/realtime-analytics';
import { rpcHandler } from '@builtbyfriends/realtime-http';
type User = { id: string; orgId: string };
type Env = { API_TOKENS: string; ANALYTICS: { writeDataPoint(p: unknown): void } };
const { procedure } = createProcedures<Env>();
const token = bearerAuth<User, Env>({ verify: (t, env) => (JSON.parse(env.API_TOKENS) as Record<string, User>)[t] ?? null, actorId: (u) => u.id });
export const whoami = procedure('whoami')
  .auth(token)
  .noAuthz({ reason: 'Anyone signed in may see themselves' })
  .noInput()
  .output(z.object({ id: z.string(), orgId: z.string() }))
  .noErrors({ reason: 'Only auth can fail and that is a 401' })
  .analytics({ event: 'whoami.called' })
  .noMcp({ reason: 'Spike only tests the HTTP path' })
  .cli({ command: 'whoami', description: 'Print the caller' })
  .noAiTool({ reason: 'Spike only tests the HTTP path' })
  .handler(({ ctx }) => ({ id: ctx.id, orgId: ctx.orgId }));
const procs: Array<any> = [whoami];
if (process.env.REALTIME_BROKEN) {procs.push((procedure('broken') as any).noInput());}
export const registry = defineRegistry(procs as any, { analytics: analyticsEngine({ binding: 'ANALYTICS' }) });
export const rpc = rpcHandler(registry);
