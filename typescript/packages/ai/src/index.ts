import type { CallResult, Exec, JsonSchema, LoadedProcedure, Registry } from '@builtbyfriends/realtime';

export type ToolInfo = {
  name: string;
  procedure: string;
  description: string;
  needsApproval: boolean;
  inputSchema: JsonSchema;
};

function aiProcedures(registry: Registry<any>): { p: LoadedProcedure; info: ToolInfo }[] {
  const out: { p: LoadedProcedure; info: ToolInfo }[] = [];
  for (const p of registry.procedures.values()) {
    const t = p.decisions.aiTool;
    if (t.kind !== 'tool') continue;
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
export function toolInfo(registry: Registry<any>): ToolInfo[] {
  return aiProcedures(registry).map((x) => x.info);
}

/** Tool definitions in the Anthropic Messages API shape (`tools: [...]`). */
export function anthropicTools(registry: Registry<any>) {
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
  registry: Registry<any>,
  toolName: string,
  input: unknown,
  exec: Omit<Exec, 'surface'> & { approved?: boolean },
): Promise<ToolRunResult> {
  const found = aiProcedures(registry).find((x) => x.info.name === toolName);
  const gate = !found ? 'unknown-tool' : !found.info.needsApproval ? 'no-approval-needed' : exec.approved ? 'approved' : 'needs-approval';
  // Decision: report the approval gate, so dev tools can show it next to the call it guards.
  if (registry.trace?.active) registry.trace.emit({ type: 'tool-gate', at: Date.now(), tool: toolName, ...(found ? { procedure: found.p.name } : {}), request: exec.request, input, gate });
  if (!found) return { status: 'unknown_tool', tool: toolName };
  if (gate === 'needs-approval') return { status: 'needs_approval', tool: toolName, input };
  const { approved: _a, ...rest } = exec;
  return { status: 'ok', result: await registry.call(found.p.name, input, { ...rest, surface: 'ai' }) };
}

/** The `content` string for a tool_result block: the value on success, the error otherwise. */
export function toolResultContent(run: ToolRunResult): { content: string; is_error: boolean } {
  if (run.status === 'needs_approval') return { content: JSON.stringify({ error: { code: 'NEEDS_APPROVAL', message: 'A person must approve this call first' } }), is_error: true };
  if (run.status === 'unknown_tool') return { content: JSON.stringify({ error: { code: 'UNKNOWN_TOOL', message: `No tool ${run.tool}` } }), is_error: true };
  const r = run.result;
  if (r.ok) return { content: JSON.stringify(r.value), is_error: false };
  return { content: JSON.stringify({ error: { code: r.code, message: r.message, ...(r.issues ? { issues: r.issues } : {}) } }), is_error: true };
}

/**
 * Tools for the Vercel AI SDK. Pass its `jsonSchema` helper so this package needs no
 * dependency on `ai`: `aiSdkTools(registry, exec, { jsonSchema })`.
 * Tools that chose `needsApproval: true` set the AI SDK's `needsApproval` flag.
 */
export function aiSdkTools<S>(
  registry: Registry<any>,
  exec: Omit<Exec, 'surface'>,
  helpers: { jsonSchema: (schema: any) => S },
) {
  const tools: Record<string, { description: string; inputSchema: S; needsApproval: boolean; execute: (input: unknown) => Promise<unknown> }> = {};
  for (const { p, info } of aiProcedures(registry)) {
    tools[info.name] = {
      description: info.description,
      inputSchema: helpers.jsonSchema(info.inputSchema),
      needsApproval: info.needsApproval,
      // Decision: the AI SDK only calls execute after its own approval step, so approval is granted here.
      execute: async (input) => {
        const r = await registry.call(p.name, input, { ...exec, surface: 'ai' });
        if (r.ok) return r.value;
        return { error: { code: r.code, message: r.message, ...(r.issues ? { issues: r.issues } : {}) } };
      },
    };
  }
  return tools;
}
