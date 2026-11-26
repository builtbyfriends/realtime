import { defineHandler } from '@builtbyfriends/bwf';
import { failures, outage } from '../src/backend';

export const GET = defineHandler((c) => c.json({ on: outage.on, failures }));

export const POST = defineHandler(async (c) => {
  // Decision: only the test's own run calls this route, and it sends this shape.
  const { on } = (await c.req.json()) as { on: boolean };

  outage.on = on;

  return c.json({ on });
});
