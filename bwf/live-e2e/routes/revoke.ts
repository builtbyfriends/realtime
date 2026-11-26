import { defineHandler } from '@builtbyfriends/bwf';
import { live } from '../src/live';

export const POST = defineHandler(async (c) => {
  // Decision: only the test's own run calls this route, and it sends this shape.
  const { topic } = (await c.req.json()) as { topic: string };

  return c.json(await live.revoke({ owner: 'tester', topic, reason: 'check again' }));
});
