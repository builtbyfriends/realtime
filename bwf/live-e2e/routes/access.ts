import { defineHandler } from '@builtbyfriends/bwf';
import { denied } from '../src/access';

export const POST = defineHandler(async (c) => {
  // Decision: only the test's own run calls this route, and it sends this shape.
  const { deny } = (await c.req.json()) as { deny: Array<string> };

  denied.clear();

  for (const topic of deny) {denied.add(topic);}

  return c.json({ denied: [...denied] });
});
