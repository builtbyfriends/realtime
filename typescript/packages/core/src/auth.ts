import type { AuthProvider } from './builder.js';

/**
 * An auth provider that reads `Authorization: Bearer <token>`. The CLI and other API
 * clients send tokens this way. Combine with a session provider using `anyOf`.
 */
export function bearerAuth<Ctx, Env = unknown>(opts: {
  name?: string;
  verify: (token: string, env: Env) => Promise<Ctx | null | undefined> | Ctx | null | undefined;
  actorId?: (ctx: Ctx) => string | undefined;
  viaOf?: (ctx: Ctx) => string | undefined;
}): AuthProvider<Ctx, Env> {
  const provider: AuthProvider<Ctx, Env> = {
    name: opts.name ?? 'bearer',
    resolve(request, env) {
      const header = request.headers.get('authorization') ?? '';
      const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1];
      return token === undefined ? null : opts.verify(token.trim(), env);
    },
  };
  if (opts.actorId) {
    provider.actorId = opts.actorId;
  }
  if (opts.viaOf) {
    provider.viaOf = opts.viaOf;
  }
  return provider;
}

/** Tries each provider in order and uses the first that resolves a caller. That provider also names the actor and what acted for it. */
export function anyOf<Ctx, Env = unknown>(name: string, ...providers: Array<AuthProvider<Ctx, Env>>): AuthProvider<Ctx, Env> {
  const resolvedBy = new WeakMap<object, AuthProvider<Ctx, Env>>();
  const resolver = (ctx: Ctx) => (typeof ctx === 'object' && ctx !== null ? resolvedBy.get(ctx) : undefined);
  return {
    name,
    async resolve(request, env) {
      for (const p of providers) {
        const ctx = await p.resolve(request, env);
        if (ctx !== null && ctx !== undefined) {
          if (typeof ctx === 'object') {resolvedBy.set(ctx, p);}
          return ctx;
        }
      }
      return null;
    },
    actorId: (ctx) => {
      const owner = resolver(ctx);

      if (owner) {return owner.actorId?.(ctx);}

      for (const p of providers) {
        const id = p.actorId?.(ctx);

        if (id) {return id;}
      }

      return undefined;
    },
    viaOf: (ctx) => {
      const owner = resolver(ctx);

      if (owner) {return owner.viaOf?.(ctx);}

      for (const p of providers) {
        const via = p.viaOf?.(ctx);

        if (via) {return via;}
      }

      return undefined;
    },
  };
}
