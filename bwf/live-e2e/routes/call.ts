import { defineHandler } from '@builtbyfriends/bwf';
import { world, counters, settlePublishes } from '../src/backend';
import { defineRegistry } from '@builtbyfriends/realtime';

const registry = defineRegistry(world.module.procedures);

export const POST = defineHandler(async (c) => {
  // Decision: only the test's own page calls this route, and it sends this shape.
  const { name, input } = (await c.req.json()) as { name: string; input: unknown };
  counters.calls += 1;
  const result = await registry.call(name, input, { request: c.req.raw, env: c.env, surface: 'direct' });
  await settlePublishes();

  if (result.ok) {return c.json({ ok: true, value: result.value });}

  return c.json({ ok: false, code: result.code, message: result.message, status: result.status }, 200);
});
