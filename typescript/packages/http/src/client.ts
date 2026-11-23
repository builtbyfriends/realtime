import type { ErrorsOf, InputOf, OutputOf, Registry } from '@builtbyfriends/realtime';

type Procs<R> = R extends Registry<any> ? NonNullable<R['~procedures']> : never;

export class RpcError<Code extends string = string> extends Error {
  constructor(
    readonly code: Code | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'NOT_FOUND_PROCEDURE' | 'INTERNAL',
    message: string,
    readonly status: number,
    readonly issues?: Array<{ message: string; path: string }>,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * A typed fetch client. `createClient<typeof registry>(url)` types every call from the
 * procedures themselves; it imports only types, so no server code reaches the browser.
 */
export function createClient<R extends Registry<any>>(
  baseUrl: string,
  options: { token?: string | (() => string | undefined); headers?: Record<string, string>; fetch?: typeof fetch; basePath?: string } = {},
) {
  const f = options.fetch ?? fetch;
  const base = baseUrl.replace(/\/$/, '') + (options.basePath ?? '/rpc');
  return {
    async call<N extends keyof Procs<R> & string>(
      name: N,
      ...[input]: undefined extends InputOf<Procs<R>[N]> ? [input?: InputOf<Procs<R>[N]>] : [input: InputOf<Procs<R>[N]>]
    ): Promise<OutputOf<Procs<R>[N]>> {
      const token = typeof options.token === 'function' ? options.token() : options.token;
      const res = await f(`${base}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
        body: input === undefined ? '' : JSON.stringify(input),
      });
      const body = (await res.json().catch(() => ({}))) as { data?: unknown; error?: { code: string; message: string; issues?: any } };
      if (!res.ok || body.error) {
        const e = body.error ?? { code: 'INTERNAL', message: `HTTP ${res.status}` };
        throw new RpcError<ErrorsOf<Procs<R>[N]>>(e.code as any, e.message, res.status, e.issues);
      }
      return body.data as OutputOf<Procs<R>[N]>;
    },
  };
}
