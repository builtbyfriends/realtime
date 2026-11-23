import type { CallResult, Exec, JsonSchema, LoadedProcedure, Registry, ToolGateTrace } from '@builtbyfriends/realtime';

export type ToolInfo = {
  name: string;
  procedure: string;
  description: string;
  needsApproval: boolean;
  inputSchema: JsonSchema;
};

type FailedCall = Extract<CallResult, { ok: false }>;
type ErrorPayload = { code: string; message: string; issues?: FailedCall['issues'] };

type ErrorBody = { error: ErrorPayload };

function errorBody(failed: FailedCall): ErrorBody {
  const error: ErrorPayload = { code: failed.code, message: failed.message };
  if (failed.issues) {error.issues = failed.issues;}
  return { error };
}

function aiProcedures(registry: Registry): Array<{ p: LoadedProcedure; info: ToolInfo }> {
  const out: Array<{ p: LoadedProcedure; info: ToolInfo }> = [];
  for (const p of registry.procedures.values()) {
    const t = p.decisions.aiTool;
    if (t.kind !== 'tool') {continue;}
    out.push({
      p,
      info: {
        name: p.toolName,
        procedure: p.name,
        description: t.description,
        needsApproval: t.needsApproval,
        inputSchema: p.jsonSchema.input ?? { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

/** Every procedure that chose `.aiTool()`, with its JSON Schema. */
export function toolInfo(registry: Registry): Array<ToolInfo> {
  return aiProcedures(registry).map((x) => x.info);
}

/** Tool definitions in the Anthropic Messages API shape (`tools: [...]`). */
export function anthropicTools(registry: Registry) {
  return toolInfo(registry).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

export type ToolRunResult =
  | { status: 'ok'; result: CallResult }
  | { status: 'needs_approval'; tool: string; input: unknown }
  | { status: 'unknown_tool'; tool: string };

/**
 * Runs one tool call through the full pipeline. The caller is whoever sent `exec.request`,
 * so an agent acting for a user gets exactly that user's permissions. A tool that chose
 * `needsApproval: true` returns `needs_approval` until the caller passes `approved: true`. Set `approved` from something
 * the agent can't write, such as a person's answer in your app. Don't copy it from a request body.
 */
export async function runTool(
  registry: Registry,
  toolName: string,
  input: unknown,
  exec: Omit<Exec, 'surface'> & { approved?: boolean },
): Promise<ToolRunResult> {
  const found = aiProcedures(registry).find((x) => x.info.name === toolName);
  const gate = !found ? 'unknown-tool' : !found.info.needsApproval ? 'no-approval-needed' : exec.approved ? 'approved' : 'needs-approval';
  if (registry.trace?.active) {
    const event: ToolGateTrace = { type: 'tool-gate', at: Date.now(), tool: toolName, request: exec.request, input, gate };
    if (found) {event.procedure = found.p.name;}
    registry.trace.emit(event);
  }
  if (!found) {return { status: 'unknown_tool', tool: toolName };}
  if (gate === 'needs-approval') {return { status: 'needs_approval', tool: toolName, input };}
  const { approved: _a, ...rest } = exec;
  return { status: 'ok', result: await registry.call(found.p.name, input, { ...rest, surface: 'ai' }) };
}

/** The `content` string for a tool_result block: the value on success, the error otherwise. */
export type ToolResultContent = { content: string; is_error: boolean };

export function toolResultContent(run: ToolRunResult): ToolResultContent {
  if (run.status === 'needs_approval') {return { content: JSON.stringify({ error: { code: 'NEEDS_APPROVAL', message: 'A person must approve this call first' } }), is_error: true };}
  if (run.status === 'unknown_tool') {return { content: JSON.stringify({ error: { code: 'UNKNOWN_TOOL', message: `No tool ${run.tool}` } }), is_error: true };}
  const r = run.result;
  if (r.ok) {return { content: JSON.stringify(r.value), is_error: false };}
  return { content: JSON.stringify(errorBody(r)), is_error: true };
}

type AiSdkTool<S> = {
  description: string;
  inputSchema: S;
  needsApproval: boolean;
  // oxlint-disable-next-line quality/no-unknown-returns -- a procedure's output is typed only by the registry, which this package doesn't see
  execute: (input: unknown) => Promise<unknown>;
};

/**
 * Tools for the Vercel AI SDK. Pass its `jsonSchema` helper so this package needs no
 * dependency on `ai`: `aiSdkTools(registry, exec, { jsonSchema })`.
 * Tools that chose `needsApproval: true` set the AI SDK's `needsApproval` flag.
 */
export function aiSdkTools<S>(
  registry: Registry,
  exec: Omit<Exec, 'surface'>,
  helpers: { jsonSchema: (schema: JsonSchema) => S },
) {
  const tools: Record<string, AiSdkTool<S>> = {};
  for (const { p, info } of aiProcedures(registry)) {
    tools[info.name] = {
      description: info.description,
      inputSchema: helpers.jsonSchema(info.inputSchema),
      needsApproval: info.needsApproval,
      // Decision: the AI SDK only calls execute after its own approval step, so approval is granted here.
      execute: async (input) => {
        const r = await registry.call(p.name, input, { ...exec, surface: 'ai' });
        if (r.ok) {return r.value;}
        return errorBody(r);
      },
    };
  }
  return tools;
}
