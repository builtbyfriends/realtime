// Decision: dev only. The middleware loads this under `vite dev` alone, so production builds leave it out.
import { createParser } from 'eventsource-parser';
import type { CallTrace, Registry, ToolGateTrace, TraceEvent } from '@builtbyfriends/realtime';
import page from 'virtual:realtime/devtools-page';

type Kind = 'rpc' | 'mcp' | 'ai' | 'llm' | 'outbound' | 'direct';

type Exchange = {
  id: number;
  rev: number;
  at: number;
  kind: Kind;
  surface?: string;
  method: string;
  url: string;
  path: string;
  status?: number;
  ms?: number;
  reqHeaders: Record<string, string>;
  reqBody?: unknown;
  resHeaders?: Record<string, string>;
  resBody?: unknown;
  error?: string;
  calls: Omit<CallTrace, 'request'>[];
  gates: Omit<ToolGateTrace, 'request'>[];
};

const MAX = 400;
const SECRET_HEADERS = /^(authorization|x-api-key|cookie|set-cookie|proxy-authorization)$/i;
// Decision: the dev server or the HTTP client adds these to each request, so they only add noise.
const NOISE_HEADERS = /^(cf-|x-forwarded-|sec-|accept-encoding$|accept-language$|connection$|host$|content-length$)/i;

const show = (t: string) => (t.length > 6 ? `${t.slice(0, 6)}…` : t);

const maskCookie = (pair: string) => {
  const eq = pair.indexOf('=');
  return eq < 0 ? show(pair.trim()) : `${pair.slice(0, eq + 1)}${show(pair.slice(eq + 1).trim())}`;
};

const mask = (value: string, name = 'authorization') => {
  if (/^cookie$/i.test(name)) return value.split(';').map((pair) => maskCookie(pair.trim())).join('; ');
  if (/^set-cookie$/i.test(name)) {
    const [first, ...attributes] = value.split(';');
    return [maskCookie(first!.trim()), ...attributes.map((a) => a.trim())].join('; ');
  }
  const [scheme, token] = value.includes(' ') ? value.split(/ (.*)/s) : ['', value];
  const shown = show(token ?? '');
  return scheme ? `${scheme} ${shown}` : shown;
};

const headers = (h: Headers) => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (!NOISE_HEADERS.test(k)) out[k] = SECRET_HEADERS.test(k) ? mask(v, k) : v;
  });
  return out;
};

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return undefined;
  if (contentType?.includes('text/event-stream')) {
    const events: unknown[] = [];
    const parser = createParser({
      onEvent: ({ data }) => {
        try {
          events.push(JSON.parse(data));
        } catch {
          events.push(data);
        }
      },
    });
    // Decision: a recorded body can stop before the blank line that ends its last event.
    parser.feed(`${text}\n\n`);
    return { sse: events };
  }
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 20_000 ? `${text.slice(0, 20_000)}… (${text.length} chars)` : text;
  }
}

export function createDevtools(registry: Registry, app: { name: string; basePath: string; mcpRoute: string }) {
  const route = '/__realtime';
  const exchanges: Exchange[] = [];
  const byRequest = new WeakMap<Request, Exchange>();
  let seq = 0;
  let rev = 0;

  const touch = (ex: Exchange) => (ex.rev = ++rev);
  const add = (ex: Omit<Exchange, 'id' | 'rev'>) => {
    const full = { ...ex, id: ++seq, rev: ++rev } as Exchange;
    exchanges.push(full);
    if (exchanges.length > MAX) exchanges.splice(0, exchanges.length - MAX);
    return full;
  };
  const kindOf = (path: string): Kind | null => {
    if (path === app.mcpRoute) return 'mcp';
    if (path.startsWith(`${app.basePath}/ai/`)) return 'ai';
    if (path === app.basePath || path.startsWith(`${app.basePath}/`)) return 'rpc';
    return null;
  };

  registry.trace.subscribe((event: TraceEvent) => {
    const { request, ...rest } = event;
    let ex = byRequest.get(request);
    if (!ex) {
      // Decision: a call can come without a request the middleware saw, for example from a cron or queue handler.
      ex = add({ at: event.at, kind: 'direct', method: 'CALL', url: '', path: event.type === 'call' ? event.procedure : event.tool, reqHeaders: {}, calls: [], gates: [] });
      byRequest.set(request, ex);
    }
    if (rest.type === 'call') ex.calls.push(rest);
    else ex.gates.push(rest);
    touch(ex);
  });

  // Decision: kept on globalThis, so a hot reload of the middleware wraps the real fetch and not our wrapper.
  const g = globalThis as typeof globalThis & { __realtimeFetch?: typeof fetch };
  const original = (g.__realtimeFetch ??= globalThis.fetch.bind(globalThis));
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const llm = request.method === 'POST' && url.pathname.endsWith('/v1/messages');
    const ex = add({
      at: Date.now(),
      kind: llm ? 'llm' : 'outbound',
      method: request.method,
      url: request.url,
      path: `${url.host}${url.pathname}`,
      reqHeaders: headers(request.headers),
      reqBody: parseBody(await request.clone().text().catch(() => ''), request.headers.get('content-type')),
      calls: [],
      gates: [],
    });
    try {
      const res = await original(request);
      ex.status = res.status;
      ex.ms = Date.now() - ex.at;
      ex.resHeaders = headers(res.headers);
      res
        .clone()
        .text()
        .then((t) => {
          ex.resBody = parseBody(t, res.headers.get('content-type'));
          touch(ex);
        })
        .catch(() => {});
      touch(ex);
      return res;
    } catch (e) {
      ex.error = (e as Error)?.message ?? String(e);
      ex.ms = Date.now() - ex.at;
      touch(ex);
      throw e;
    }
  };

  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  const registryInfo = () => ({
    app,
    audit: registry.audit(),
    procedures: [...registry.procedures.values()].map((p) => ({
      name: p.name,
      toolName: p.toolName,
      mcp: p.decisions.mcp.kind === 'tool' ? { effect: p.decisions.mcp.effect, description: p.decisions.mcp.description } : null,
      aiTool: p.decisions.aiTool.kind === 'tool' ? { needsApproval: p.decisions.aiTool.needsApproval, description: p.decisions.aiTool.description } : null,
      cli: p.decisions.cli.kind === 'command' ? p.decisions.cli.command : null,
      errors: p.errors,
    })),
  });

  return {
    route,
    serves: (path: string) => path === route || path.startsWith(`${route}/`),
    async serve(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const sub = url.pathname.slice(route.length);
      if (sub === '/events') {
        const since = Number(url.searchParams.get('since') ?? 0);
        return json({ rev, exchanges: exchanges.filter((e) => e.rev > since), ids: exchanges.map((e) => e.id) });
      }
      if (sub === '/registry') return json(registryInfo());
      if (sub === '/clear' && request.method === 'POST') {
        exchanges.length = 0;
        rev++;
        return json({ ok: true });
      }
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    },
    /** Runs the middleware for one request and records it when realtime answered it. */
    async record(request: Request, waitUntil: (p: Promise<unknown>) => void, run: () => Promise<Response | null>): Promise<Response | null> {
      const url = new URL(request.url);
      const kind = kindOf(url.pathname);
      if (!kind) return run();
      const reqText = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text().catch(() => '');
      const ex = add({
        at: Date.now(),
        kind,
        ...(kind === 'rpc' ? { surface: request.headers.get('x-realtime-surface') === 'cli' ? 'cli' : 'http' } : {}),
        method: request.method,
        url: request.url,
        path: url.pathname,
        reqHeaders: headers(request.headers),
        reqBody: parseBody(reqText, request.headers.get('content-type')),
        calls: [],
        gates: [],
      });
      byRequest.set(request, ex);
      try {
        const res = await run();
        ex.ms = Date.now() - ex.at;
        if (!res) {
          exchanges.splice(exchanges.indexOf(ex), 1);
          return res;
        }
        ex.status = res.status;
        ex.resHeaders = headers(res.headers);
        waitUntil(
          res
            .clone()
            .text()
            .then((t) => {
              ex.resBody = parseBody(t, res.headers.get('content-type'));
              touch(ex);
            })
            .catch(() => {}),
        );
        touch(ex);
        return res;
      } catch (e) {
        ex.error = (e as Error)?.message ?? String(e);
        ex.ms = Date.now() - ex.at;
        touch(ex);
        throw e;
      }
    },
  };
}
