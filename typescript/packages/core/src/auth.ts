import type { AuthProvider } from './builder.js';

/**
 * An auth provider that reads `Authorization: Bearer <token>`. The CLI and other API
 * clients send tokens this way. Combine with a session provider using `anyOf`.
 */
export function bearerAuth<Ctx, Env = unknown>(opts: {
  name?: string;
  verify: (token: string, env: Env) => Promise<Ctx | null | undefined> | Ctx | null | undefined;
  actorId?: (ctx: Ctx) => string | undefined;
}): AuthProvider<Ctx, Env> {
  return {
    name: opts.name ?? 'bearer',
    resolve(request, env) {
      const header = request.headers.get('authorization') ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      return match ? opts.verify(match[1]!.trim(), env) : null;
    },
    ...(opts.actorId ? { actorId: opts.actorId } : {}),
  };
}

/** Tries each provider in order and uses the first that resolves a caller. */
export function anyOf<Ctx, Env = unknown>(name: string, ...providers: Array<AuthProvider<Ctx, Env>>): AuthProvider<Ctx, Env> {
  return {
    name,
    async resolve(request, env) {
      for (const p of providers) {
        const ctx = await p.resolve(request, env);
        if (ctx != null) {return ctx;}
      }
      return null;
    },
    actorId: (ctx) => {
      for (const p of providers) {
        const id = p.actorId?.(ctx);
        if (id) {return id;}
      }
      return undefined;
    },
  };
}
