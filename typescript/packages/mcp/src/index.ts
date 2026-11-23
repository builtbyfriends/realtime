import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import type { CreateMcpHandlerOptions } from 'agents/mcp/server';
import type { CallResult, JsonSchema, LoadedProcedure, Registry } from '@builtbyfriends/realtime';

type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };

export type McpHandlerOptions = Omit<CreateMcpHandlerOptions, 'route'> & {
  /** Server name and version reported to MCP clients. */
  name: string;
  version: string;
  /** Default "/mcp". */
  route?: string;
};

// Decision: the MCP SDK gets a schema that only carries JSON Schema. Validation stays in the realtime
// pipeline, so MCP calls get the same 400s, auth and analytics as HTTP calls.
const passthrough = (json: JsonSchema) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'realtime',
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => json, output: () => json },
  },
});

function toToolResult(result: CallResult, structured: boolean): CallToolResult {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value) }],
      ...(structured ? { structuredContent: result.value } : {}),
    };
  }
  const { code, message, issues } = result;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...(issues ? { issues } : {}) } }) }] };
}

/** Builds an MCP server with one tool per procedure that chose `.mcp()`. */
export function buildMcpServer(
  registry: Registry<any>,
  info: { name: string; version: string },
  exec: { request: Request; env: unknown; ctx?: ExecutionContextLike },
): McpServer {
  const server = new McpServer({ name: info.name, version: info.version });
  for (const p of registry.procedures.values()) {
    const mcp = p.decisions.mcp;
    if (mcp.kind !== 'tool') {continue;}
    const structured = p.jsonSchema.output?.type === 'object';
    const run = (args: unknown) =>
      registry
        .call(p.name, args, {
          request: exec.request,
          env: exec.env,
          surface: 'mcp',
          ...(exec.ctx ? { waitUntil: (pr: Promise<unknown>) => exec.ctx!.waitUntil(pr) } : {}),
        })
        .then((r) => toToolResult(r, structured));
    const config = {
      ...(mcp.title ? { title: mcp.title } : {}),
      description: mcp.description,
      annotations: annotations(p),
      ...(structured ? { outputSchema: passthrough(p.jsonSchema.output) } : {}),
    };
    if (p.decisions.input.kind === 'schema') {
      server.registerTool(p.toolName, { ...config, inputSchema: passthrough(p.jsonSchema.input ?? { type: 'object' }) }, (args) => run(args));
    } else {
      server.registerTool(p.toolName, config, () => run(undefined));
    }
  }
  return server;
}

function annotations(p: LoadedProcedure) {
  const mcp = p.decisions.mcp as Extract<LoadedProcedure['decisions']['mcp'], { kind: 'tool' }>;
  return {
    readOnlyHint: mcp.effect === 'read',
    destructiveHint: mcp.effect === 'destructive',
    ...(mcp.idempotent !== undefined ? { idempotentHint: mcp.idempotent } : {}),
    openWorldHint: mcp.openWorld ?? false,
  };
}

/**
 * Stateless MCP over Streamable HTTP, through Cloudflare's createMcpHandler. A fresh
 * server is built per request, so tools see that request's auth headers and env.
 */
export function mcpHandler(registry: Registry<any>, options: McpHandlerOptions) {
  const { name, version, route = '/mcp', ...rest } = options;
  const handler = (request: Request, env: unknown, ctx: ExecutionContextLike) =>
    createMcpHandler(() => buildMcpServer(registry, { name, version }, { request, env, ctx }), { ...rest, route })(
      request,
      env,
      ctx as any,
    );
  return Object.assign(handler, {
    matches: (request: Request) => new URL(request.url).pathname === route,
  });
}
