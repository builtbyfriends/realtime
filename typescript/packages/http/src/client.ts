import type { ErrorsOf, InputOf, OutputOf, Registry } from '@builtbyfriends/realtime';

type Procs<R> = R extends Registry ? NonNullable<R['~procedures']> : never;

type ErrorBody = { code: string; message: string; issues?: Array<{ message: string; path: string }> };

function isIssues(value: unknown): value is NonNullable<ErrorBody['issues']> {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'object' && item !== null && 'message' in item && typeof item.message === 'string' && 'path' in item && typeof item.path === 'string')
  );
}

function readError(body: unknown): ErrorBody | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) {return undefined;}
  const raw = body.error;
  if (typeof raw !== 'object' || raw === null || !('code' in raw) || !('message' in raw)) {return undefined;}
  if (typeof raw.code !== 'string' || typeof raw.message !== 'string') {return undefined;}
  const error: ErrorBody = { code: raw.code, message: raw.message };
  if ('issues' in raw && isIssues(raw.issues)) {error.issues = raw.issues;}
  return error;
}

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
export function createClient<R extends Registry>(
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
      const authorization = token ? { authorization: `Bearer ${token}` } : undefined;
      const res = await f(`${base}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authorization, ...options.headers },
        body: input === undefined ? '' : JSON.stringify(input),
      });
      const body: unknown = await res.json().catch(() => undefined);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new RpcError<ErrorsOf<Procs<R>[N]>>('INTERNAL', `HTTP ${res.status}: the answer wasn't the expected JSON`, res.status);
      }
      const error = readError(body);
      if (!res.ok || ('error' in body && body.error)) {
        const e = error ?? { code: 'INTERNAL', message: `HTTP ${res.status}` };
        throw new RpcError(e.code, e.message, res.status, e.issues);
      }
      const data = 'data' in body ? body.data : undefined;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- types-only client: the registry type is the contract for the wire data
      return data as OutputOf<Procs<R>[N]>;
    },
  };
}
