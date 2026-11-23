import type { CallResult, Registry, Surface } from '@builtbyfriends/realtime';
import { BUILTIN_ERRORS } from '@builtbyfriends/realtime';

export type RpcHandlerOptions = {
  /** Path prefix for procedures, the manifest and OpenAPI. Default "/rpc". */
  basePath?: string;
  /** Serve GET {basePath}/manifest.json for the CLI. Default true. */
  manifest?: boolean;
  /** Serve GET {basePath}/openapi.json. Default { title: 'API', version: '0.0.0' }. Pass false to turn off. */
  openapi?: { title: string; version: string } | false;
};

type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };

export type RpcHandler = ((request: Request, env: unknown, ctx: ExecutionContextLike) => Promise<Response>) & {
  /** True when the request is under basePath, for routing in a Worker's fetch. */
  matches(request: Request): boolean;
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Turns a call result into the wire format: `{ data }` on success, `{ error: { code, message, issues? } }` otherwise. */
export function toResponse(result: CallResult): Response {
  if (result.ok) return json({ data: result.value ?? null });
  const { code, message, issues, status } = result;
  return json({ error: { code, message, ...(issues ? { issues } : {}) } }, status, status === 401 ? { 'www-authenticate': 'Bearer' } : {});
}

/**
 * Fetch handler for the registry: every procedure is `POST {basePath}/{name}` with a JSON body.
 * CLI calls send `x-realtime-surface: cli` so analytics can tell them apart.
 */
export function rpcHandler(registry: Registry<any>, options: RpcHandlerOptions = {}): RpcHandler {
  const base = (options.basePath ?? '/rpc').replace(/\/$/, '');
  const manifest = options.manifest === false ? null : JSON.stringify(registry.manifest(base));
  const openapi = options.openapi === false ? null : JSON.stringify(openApi(registry, base, options.openapi ?? { title: 'API', version: '0.0.0' }));

  const matches = (request: Request) => {
    const path = new URL(request.url).pathname;
    return path === base || path.startsWith(`${base}/`);
  };

  const handler = async (request: Request, env: unknown, ctx: ExecutionContextLike) => {
    const path = new URL(request.url).pathname;
    if (!matches(request)) return toResponse({ ok: false, status: 404, code: 'NOT_FOUND_PROCEDURE', message: BUILTIN_ERRORS.NOT_FOUND_PROCEDURE.message });
    const rest = path.slice(base.length + 1);

    if (request.method === 'GET' && rest === 'manifest.json' && manifest) return new Response(manifest, { headers: { 'content-type': 'application/json' } });
    if (request.method === 'GET' && rest === 'openapi.json' && openapi) return new Response(openapi, { headers: { 'content-type': 'application/json' } });
    if (!registry.procedures.has(rest)) return toResponse({ ok: false, status: 404, code: 'NOT_FOUND_PROCEDURE', message: BUILTIN_ERRORS.NOT_FOUND_PROCEDURE.message });
    if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } }, 405, { allow: 'POST' });

    let input: unknown = undefined;
    const text = await request.text();
    if (text.trim()) {
      try {
        input = JSON.parse(text);
      } catch {
        return toResponse({ ok: false, status: 400, code: 'INVALID_INPUT', message: 'Body is not valid JSON' });
      }
    }
    const surface: Surface = request.headers.get('x-realtime-surface') === 'cli' ? 'cli' : 'http';
    const result = await registry.call(rest, input, { request, env, surface, waitUntil: (p) => ctx.waitUntil(p) });
    return toResponse(result);
  };
  return Object.assign(handler, { matches });
}

/** OpenAPI 3.1 for every procedure, generated from the same JSON Schema the registry checked at load. */
export function openApi(registry: Registry<any>, basePath = '/rpc', info = { title: 'API', version: '0.0.0' }) {
  const errorBody = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' }, issues: { type: 'array', items: { type: 'object' } } },
        required: ['code', 'message'],
      },
    },
    required: ['error'],
  };
  const paths: Record<string, unknown> = {};
  for (const p of registry.procedures.values()) {
    const d = p.decisions;
    const responses: Record<string, unknown> = {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: { type: 'object', properties: { data: p.jsonSchema.output ?? {} }, required: ['data'] } } },
      },
      '400': { description: 'INVALID_INPUT', content: { 'application/json': { schema: errorBody } } },
      '500': { description: 'INTERNAL', content: { 'application/json': { schema: errorBody } } },
    };
    if (d.authn.kind === 'auth') responses['401'] = { description: 'UNAUTHENTICATED', content: { 'application/json': { schema: errorBody } } };
    if (d.authz.kind === 'policy') responses['403'] = { description: 'FORBIDDEN', content: { 'application/json': { schema: errorBody } } };
    for (const [code, spec] of Object.entries(p.errors)) {
      const key = String(spec.status);
      const prev = responses[key] as { description: string } | undefined;
      responses[key] = { description: prev ? `${prev.description}, ${code}` : code, content: { 'application/json': { schema: errorBody } } };
    }
    const description =
      (d.mcp.kind === 'tool' && d.mcp.description) || (d.cli.kind === 'command' && d.cli.description) || (d.aiTool.kind === 'tool' && d.aiTool.description) || undefined;
    paths[`${basePath}/${p.name}`] = {
      post: {
        operationId: p.toolName,
        ...(description ? { summary: description } : {}),
        ...(d.authn.kind === 'auth' ? { security: [{ bearer: [] }] } : { security: [] }),
        ...(d.input.kind === 'schema'
          ? { requestBody: { required: true, content: { 'application/json': { schema: p.jsonSchema.input ?? {} } } } }
          : {}),
        responses,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info,
    paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  };
}
