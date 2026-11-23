import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import type { CreateMcpHandlerOptions } from 'agents/mcp/server';
import type { CallResult, Exec, JsonSchema, LoadedProcedure, Registry } from '@builtbyfriends/realtime';

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

type ErrorPayload = { code: string; message: string; issues?: Extract<CallResult, { ok: false }>['issues'] };
type McpTool = Extract<LoadedProcedure['decisions']['mcp'], { kind: 'tool' }>;
type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean };
type ToolConfig = {
  title?: string;
  description: string;
  annotations: ToolAnnotations;
  outputSchema?: ReturnType<typeof passthrough>;
};

function toToolResult(result: CallResult, structured: boolean): CallToolResult {
  if (result.ok) {
    const ok: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(result.value) }] };
    if (structured) {ok.structuredContent = result.value;}
    return ok;
  }
  const { code, message, issues } = result;
  const error: ErrorPayload = { code, message };
  if (issues) {error.issues = issues;}
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
}

/** Builds an MCP server with one tool per procedure that chose `.mcp()`. */
export function buildMcpServer(
  registry: Registry,
  info: { name: string; version: string },
  exec: { request: Request; env: unknown; ctx?: ExecutionContextLike },
): McpServer {
  const server = new McpServer({ name: info.name, version: info.version });
  for (const p of registry.procedures.values()) {
    const mcp = p.decisions.mcp;
    if (mcp.kind !== 'tool') {continue;}
    const structured = p.jsonSchema.output?.type === 'object';
    const callExec: Exec = { request: exec.request, env: exec.env, surface: 'mcp' };
    const { ctx } = exec;
    if (ctx) {callExec.waitUntil = (pr: Promise<unknown>) => ctx.waitUntil(pr);}
    const run = (args: unknown) => registry.call(p.name, args, callExec).then((r) => toToolResult(r, structured));
    const config: ToolConfig = { description: mcp.description, annotations: annotations(mcp) };
    if (mcp.title) {config.title = mcp.title;}
    if (structured) {config.outputSchema = passthrough(p.jsonSchema.output);}
    if (p.decisions.input.kind === 'schema') {
      server.registerTool(p.toolName, { ...config, inputSchema: passthrough(p.jsonSchema.input ?? { type: 'object' }) }, (args) => run(args));
    } else {
      server.registerTool(p.toolName, config, () => run(undefined));
    }
  }
  return server;
}

function annotations(mcp: McpTool): ToolAnnotations {
  const hints: ToolAnnotations = {
    readOnlyHint: mcp.effect === 'read',
    destructiveHint: mcp.effect === 'destructive',
    openWorldHint: mcp.openWorld ?? false,
  };
  if (mcp.idempotent !== undefined) {hints.idempotentHint = mcp.idempotent;}
  return hints;
}

/**
 * Stateless MCP over Streamable HTTP, through Cloudflare's createMcpHandler. A fresh
 * server is built per request, so tools see that request's auth headers and env.
 */
export function mcpHandler(registry: Registry, options: McpHandlerOptions) {
  const { name, version, route = '/mcp', ...rest } = options;
  const handler = (request: Request, env: unknown, ctx: ExecutionContextLike) =>
    createMcpHandler(() => buildMcpServer(registry, { name, version }, { request, env, ctx }), { ...rest, route })(
      request,
      env,
      ctx,
    );
  return Object.assign(handler, {
    matches: (request: Request) => new URL(request.url).pathname === route,
  });
}
