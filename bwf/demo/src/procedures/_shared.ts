// Decision: files that start with _ aren't scanned for procedures, so shared auth, profiles and schemas go here.
import { z } from 'zod';
import { apiTokens, profile } from '@builtbyfriends/realtime-bwf';
import { db, eq } from '@builtbyfriends/bwf/db';
import { apiTokens as tokensTable } from '@schema';

export type User = { id: string; orgId: string; role: 'admin' | 'member' };

export const token = apiTokens<User>(async (hash) => {
  const row = await db.select().from(tokensTable).where(eq(tokensTable.hash, hash)).get();
  return row ? { id: row.userId, orgId: row.orgId, role: row.role } : null;
});

export const signedIn = profile('signed-in').auth(token);

export const adminOnly = profile('admin-only')
  .auth(token)
  .authz({ policy: 'admin', check: (user) => user.role === 'admin' })
  .noCli({ reason: 'Admin actions ship through the dashboard only' });

export const Contact = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  email: z.email(),
});
