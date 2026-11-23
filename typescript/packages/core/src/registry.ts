import { CONCERNS, type AnyProcedure, type AnalyticsProps, type Concern, type Decisions, type Surface } from './builder.js';
import { BUILTIN_ERRORS, ProcedureError, builtinFailure, type ErrorSpec, type Failure } from './errors.js';
import { reasonProblem } from './reason.js';
import { toJsonSchema, validate, type JsonSchema } from './schema.js';

export type AnalyticsEvent = {
  event: string;
  procedure: string;
  surface: Surface;
  outcome: 'ok' | 'error';
  /** Error code when outcome is "error". */
  code?: string;
  status: number;
  durationMs: number;
  actorId?: string;
  props: AnalyticsProps;
};

export interface AnalyticsProvider<Env = any> {
  readonly name: string;
  track(event: AnalyticsEvent, env: Env): void | Promise<void>;
}

export interface RegistryOptions {
  /** Required when any procedure calls `.analytics()`. */
  analytics?: AnalyticsProvider;
  /** Called for unexpected errors (500s). Defaults to console.error. Never sent to callers. */
  onError?: (error: unknown, info: { procedure: string; surface: Surface; stage: string }) => void;
}

export type Exec = {
  request: Request;
  env: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
  surface: Surface;
};

/** Where a call went, one row per decision, in the order the pipeline runs them. */
export type TraceConcern = Concern | 'handler';
export type TraceStep = {
  concern: TraceConcern;
  /** pass: ran and allowed the call. fail: stopped it. off: opted out with a reason. unreached: an earlier step stopped the call. */
  status: 'pass' | 'fail' | 'off' | 'unreached';
  /** The decision as the audit prints it, e.g. "policy(same-org)". */
  decision: string;
  detail?: string;
  ms?: number;
};
export type CallTrace = {
  type: 'call';
  id: number;
  at: number;
  procedure: string;
  surface: Surface;
  /** The incoming request, so dev tools can tie a call to the HTTP exchange that carried it. */
  request: Request;
  input: unknown;
  result: CallResult;
  steps: TraceStep[];
  durationMs: number;
};
/** An AI tool call that met (or skipped) the needsApproval gate before reaching call(). */
export type ToolGateTrace = {
  type: 'tool-gate';
  at: number;
  tool: string;
  procedure?: string;
  request: Request;
  input: unknown;
  gate: 'no-approval-needed' | 'approved' | 'needs-approval' | 'unknown-tool';
};
export type TraceEvent = CallTrace | ToolGateTrace;

export type Success<T = unknown> = { ok: true; status: 200; value: T };
export type CallResult<T = unknown> = Success<T> | Failure;

export type LoadedProcedure = {
  readonly name: string;
  /** Name usable as an AI or MCP tool name (dots become underscores). */
  readonly toolName: string;
  readonly decisions: Decisions;
  readonly profiles: readonly string[];
  readonly jsonSchema: { readonly input: JsonSchema | null; readonly output: JsonSchema | null };
  readonly errors: Readonly<Record<string, ErrorSpec>>;
};

export type AuditRow = { procedure: string; profiles: string } & Record<Concern, string>;

export type ManifestEntry = {
  name: string;
  path: string;
  input: JsonSchema | null;
  output: JsonSchema | null;
  errors: Record<string, ErrorSpec>;
  cli: { command: string; description: string } | null;
};
export type Manifest = { version: 1; procedures: ManifestEntry[] };

type ProcMap<P extends readonly AnyProcedure[]> = { [K in P[number] as K['name']]: K };

export interface Registry<P extends readonly AnyProcedure[] = readonly AnyProcedure[]> {
  readonly procedures: ReadonlyMap<string, LoadedProcedure>;
  /** Run one procedure through the full pipeline: authn, input, authz, handler, output, analytics. */
  call(name: string, input: unknown, exec: Exec): Promise<CallResult>;
  /**
   * Every call as it runs, step by step, for dev tools such as the /__realtime page. Nothing
   * is recorded until something subscribes, so production pays nothing for it.
   */
  readonly trace: {
    subscribe(listener: (event: TraceEvent) => void): () => void;
    /** For adapters: report a step that happens outside call(), such as an AI tool approval gate. */
    emit(event: TraceEvent): void;
    readonly active: boolean;
  };
  /** One row per procedure, every decision as text. Snapshot this in CI. */
  audit(): AuditRow[];
  /** The audit as a Markdown table, for snapshots that read well in a PR diff. */
  auditTable(): string;
  /** What the CLI downloads: every procedure that chose `.cli()`, with JSON Schema. */
  manifest(basePath?: string): Manifest;
  /** Phantom map of procedure name to procedure, for typed clients. */
  readonly '~procedures'?: ProcMap<P>;
}

const NAME_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const CODE_RE = /^[A-Z][A-Z0-9_]*$/;
const COMMAND_RE = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/;
const EXPOSED: Concern[] = ['mcp', 'cli', 'aiTool'];
const TRACE_ORDER: TraceConcern[] = ['mcp', 'cli', 'aiTool', 'authn', 'input', 'authz', 'handler', 'output', 'errors', 'analytics'];
const SURFACE_CONCERN: Partial<Record<Surface, Concern>> = { mcp: 'mcp', cli: 'cli', ai: 'aiTool' };

/**
 * Checks every procedure and throws one error listing every problem. Call it at module
 * scope in the Worker: a throw there fails `wrangler deploy` (error 10021), so an
 * incomplete procedure cannot ship even when the build skipped the type checker.
 */
export function defineRegistry<const P extends readonly AnyProcedure[]>(
  procedures: P,
  options: RegistryOptions = {},
): Registry<P> {
  const problems: string[] = [];
  const loaded = new Map<string, LoadedProcedure>();
  const toolNames = new Map<string, string>();
  const commands = new Map<string, string>();

  procedures.forEach((p, index) => {
    const label = typeof p?.name === 'string' ? `"${p.name}"` : `#${index}`;
    if (!p || p['~realtime'] !== 'procedure') {
      problems.push(
        (p as any)?.['~realtime'] === 'builder'
          ? `${label}: not finished; decide every concern and call .handler(fn)`
          : `${label}: not a procedure (build it with procedure(name)... .handler(fn))`,
      );
      return;
    }
    const before = problems.length;
    const d = p.decisions as Partial<Decisions>;
    if (!NAME_RE.test(p.name)) problems.push(`${label}: name must look like "contacts.get" (camelCase segments joined by dots)`);
    if (loaded.has(p.name)) problems.push(`${label}: registered twice`);

    const missing = CONCERNS.filter((c) => !d[c]);
    if (missing.length) problems.push(`${label}: undecided: ${missing.join(', ')}`);

    for (const c of CONCERNS) {
      const dec = d[c] as { kind: string; reason?: unknown } | undefined;
      if (!dec) continue;
      if (dec.kind === 'none' && c !== 'input') {
        const why = reasonProblem(dec.reason);
        if (why) problems.push(`${label}: ${c} opt-out: ${why}`);
      }
    }
    if (d.output && d.output.kind !== 'schema') problems.push(`${label}: output must be a schema`);
    for (const c of ['input', 'output'] as const) {
      const dec = d[c];
      if (dec?.kind === 'schema' && typeof dec.schema?.['~standard']?.validate !== 'function') {
        problems.push(`${label}: ${c} is not a Standard Schema (Zod, Valibot, ArkType, ...)`);
      }
    }
    if (d.authn?.kind === 'auth' && typeof d.authn.provider?.resolve !== 'function') {
      problems.push(`${label}: auth provider needs a resolve(request, env) function`);
    }
    if (d.authz?.kind === 'policy') {
      if (!d.authz.policy?.trim()) problems.push(`${label}: authz needs a policy name for the audit`);
      if (typeof d.authz.check !== 'function') problems.push(`${label}: authz needs a check(ctx, input) function`);
    }
    if (d.errors?.kind === 'map') {
      for (const [code, spec] of Object.entries(d.errors.map ?? {})) {
        if (!CODE_RE.test(code)) problems.push(`${label}: error code ${code} must be UPPER_SNAKE_CASE`);
        if (code in BUILTIN_ERRORS) problems.push(`${label}: error code ${code} is reserved by the pipeline`);
        if (!Number.isInteger(spec?.status) || spec.status < 400 || spec.status > 599)
          problems.push(`${label}: error ${code} needs an HTTP status from 400 to 599`);
        if (!spec?.message?.trim()) problems.push(`${label}: error ${code} needs a message`);
      }
      if (!Object.keys(d.errors.map ?? {}).length) problems.push(`${label}: errors({}) is empty; use noErrors({ reason })`);
    }
    if (d.analytics?.kind === 'event') {
      if (!d.analytics.event?.trim()) problems.push(`${label}: analytics needs an event name`);
      if (!options.analytics) problems.push(`${label}: uses analytics, but the registry has no analytics provider`);
    }
    if (d.mcp?.kind === 'tool') {
      if (!d.mcp.description?.trim()) problems.push(`${label}: mcp needs a description`);
      if (!['read', 'write', 'destructive'].includes(d.mcp.effect)) problems.push(`${label}: mcp effect must be read, write or destructive`);
    }
    if (d.aiTool?.kind === 'tool') {
      if (!d.aiTool.description?.trim()) problems.push(`${label}: aiTool needs a description`);
      if (typeof d.aiTool.needsApproval !== 'boolean') problems.push(`${label}: aiTool needs needsApproval: true or false`);
    }
    if (d.cli?.kind === 'command') {
      if (!COMMAND_RE.test(d.cli.command ?? '')) problems.push(`${label}: cli command "${d.cli.command}" must be lowercase words, e.g. "contacts get"`);
      else if (commands.has(d.cli.command)) problems.push(`${label}: cli command "${d.cli.command}" is also used by "${commands.get(d.cli.command)}"`);
      else commands.set(d.cli.command, p.name);
      if (!d.cli.description?.trim()) problems.push(`${label}: cli needs a description`);
    }
    if (typeof p.handler !== 'function') problems.push(`${label}: handler is not a function`);

    // Decision: convert JSON Schema now, so a schema that can't be expressed fails the deploy and
    // not the first tools/list call.
    const exposed = EXPOSED.some((c) => (d[c] as { kind?: string } | undefined)?.kind && (d[c] as any).kind !== 'none');
    const jsonSchema = { input: null as JsonSchema | null, output: null as JsonSchema | null };
    for (const io of ['input', 'output'] as const) {
      const dec = d[io];
      if (dec?.kind !== 'schema') continue;
      try {
        jsonSchema[io] = toJsonSchema(dec.schema, io);
      } catch (e) {
        if (exposed || (io === 'input' && d.cli?.kind === 'command')) problems.push(`${label}: ${io} schema: ${(e as Error).message}`);
      }
    }
    if (exposed && d.input?.kind === 'schema' && jsonSchema.input && jsonSchema.input.type !== 'object') {
      problems.push(`${label}: input exposed to MCP, CLI or AI tools must be an object schema`);
    }

    const toolName = p.name.replace(/\./g, '_');
    if (toolNames.has(toolName) && toolNames.get(toolName) !== p.name)
      problems.push(`${label}: tool name ${toolName} collides with "${toolNames.get(toolName)}"`);
    toolNames.set(toolName, p.name);

    if (problems.length === before) {
      loaded.set(p.name, {
        name: p.name,
        toolName,
        decisions: p.decisions,
        profiles: p.profiles ?? [],
        jsonSchema,
        errors: d.errors?.kind === 'map' ? d.errors.map : {},
      });
    }
  });

  if (problems.length) {
    throw new Error(`realtime registry has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }

  const handlers = new Map(procedures.map((p) => [p.name, p.handler]));
  const listeners = new Set<(event: TraceEvent) => void>();
  let traceSeq = 0;
  const emit = (event: TraceEvent) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (e) {
        console.error('[realtime] trace listener failed:', e);
      }
    }
  };
  const onError =
    options.onError ??
    ((error, info) => console.error(`[realtime] ${info.procedure} (${info.surface}) failed at ${info.stage}:`, error));

  async function call(name: string, rawInput: unknown, exec: Exec): Promise<CallResult> {
    if (!listeners.size) return run(name, rawInput, exec, null);
    const steps: TraceStep[] = [];
    const at = Date.now();
    const result = await run(name, rawInput, exec, steps);
    const proc = loaded.get(name);
    if (proc) {
      // Decision: concerns the call never reached still show, so a trace has each decision.
      const seen = new Set(steps.map((s) => s.concern));
      const surface = SURFACE_CONCERN[exec.surface];
      for (const c of TRACE_ORDER) if (!seen.has(c) && (c === 'handler' || !EXPOSED.includes(c) || c === surface)) steps.push({ concern: c, status: 'unreached', decision: c === 'handler' ? 'your code' : describe(c, proc.decisions[c]) });
      steps.sort((a, b) => TRACE_ORDER.indexOf(a.concern) - TRACE_ORDER.indexOf(b.concern));
    }
    emit({ type: 'call', id: ++traceSeq, at, procedure: name, surface: exec.surface, request: exec.request, input: rawInput, result, steps, durationMs: Date.now() - at });
    return result;
  }

  async function run(name: string, rawInput: unknown, exec: Exec, steps: TraceStep[] | null): Promise<CallResult> {
    const proc = loaded.get(name);
    if (!proc) return builtinFailure('NOT_FOUND_PROCEDURE');
    const d = proc.decisions;
    const info = (stage: string) => ({ procedure: name, surface: exec.surface, stage });
    const waitUntil = exec.waitUntil ?? ((p: Promise<unknown>) => void p.catch((e) => onError(e, info('waitUntil'))));
    let mark = Date.now();
    const step = (concern: TraceConcern, status: TraceStep['status'], detail?: string) => {
      if (!steps) return;
      const now = Date.now();
      const dec = concern === 'handler' ? null : d[concern];
      const off = !!dec && (dec as { kind: string }).kind === 'none' && status === 'pass';
      // Decision: an opt-out's reason is already in the decision text, so it gets no separate detail.
      steps.push({ concern, status: off ? 'off' : status, decision: dec ? describe(concern as Concern, dec) : 'your code', ...(detail && !off ? { detail } : {}), ms: now - mark });
      mark = now;
    };

    const surfaceConcern = SURFACE_CONCERN[exec.surface];
    if (surfaceConcern) step(surfaceConcern, 'pass', `called over ${exec.surface}`);

    let ctx: unknown = null;
    if (d.authn.kind === 'auth') {
      try {
        ctx = await d.authn.provider.resolve(exec.request, exec.env);
      } catch (e) {
        onError(e, info('authn'));
        step('authn', 'fail', 'provider threw: 500 INTERNAL');
        return builtinFailure('INTERNAL');
      }
      if (ctx == null) {
        step('authn', 'fail', 'no caller: 401 UNAUTHENTICATED');
        return builtinFailure('UNAUTHENTICATED');
      }
      const actor = d.authn.provider.actorId?.(ctx);
      step('authn', 'pass', actor ? `actor ${actor}` : 'signed in');
    } else step('authn', 'pass', d.authn.reason);

    let input: unknown = undefined;
    if (d.input.kind === 'schema') {
      const r = await validate(d.input.schema, rawInput);
      if (!r.ok) {
        step('input', 'fail', `400 INVALID_INPUT: ${r.issues.map((i) => i.message).join('; ')}`);
        return builtinFailure('INVALID_INPUT', r.issues);
      }
      input = r.value;
      step('input', 'pass', 'matched the schema');
    } else if (!isEmpty(rawInput)) {
      step('input', 'fail', '400 INVALID_INPUT: this procedure takes no input');
      return builtinFailure('INVALID_INPUT', [{ message: 'This procedure takes no input', path: '' }]);
    } else step('input', 'pass', 'no input');

    // Decision: authorization runs after input, so policies can check ownership.
    if (d.authz.kind === 'policy') {
      let allowed = false;
      try {
        allowed = (await d.authz.check(ctx, input)) === true;
      } catch (e) {
        onError(e, info('authz'));
        step('authz', 'fail', 'policy threw: 500 INTERNAL');
        return builtinFailure('INTERNAL');
      }
      if (!allowed) {
        step('authz', 'fail', `policy ${d.authz.policy} said no: 403 FORBIDDEN`);
        return builtinFailure('FORBIDDEN');
      }
      step('authz', 'pass', `policy ${d.authz.policy} allowed it`);
    } else step('authz', 'pass', d.authz.reason);

    const started = Date.now();
    let result: CallResult;
    try {
      const value = await handlers.get(name)!({
        input,
        ctx,
        env: exec.env,
        request: exec.request,
        surface: exec.surface,
        waitUntil,
        fail: (code: string, message?: string): never => {
          throw new ProcedureError(code, message);
        },
      });
      step('handler', 'pass', 'returned');
      // Decision: output is validated before it leaves, so clients and tools can trust its shape.
      const out = await validate(d.output.schema, value);
      if (out.ok) {
        result = { ok: true, status: 200, value: out.value };
        step('output', 'pass', 'matched the schema');
        step('errors', 'pass', d.errors.kind === 'none' ? d.errors.reason : 'none raised');
      } else {
        onError(new Error(`output did not match the schema: ${JSON.stringify(out.issues)}`), info('output'));
        result = builtinFailure('INTERNAL');
        step('output', 'fail', `did not match the schema, so callers get 500 INTERNAL: ${out.issues.map((i) => i.message).join('; ')}`);
      }
    } catch (e) {
      const spec = e instanceof ProcedureError && Object.hasOwn(proc.errors, e.code) ? proc.errors[e.code] : undefined;
      if (e instanceof ProcedureError && spec) {
        result = {
          ok: false,
          status: spec.status,
          code: e.code,
          message: e.message && e.message !== e.code ? e.message : spec.message,
        };
        step('handler', 'pass', `fail('${e.code}')`);
        step('errors', 'pass', `declared ${e.code}: ${spec.status}`);
      } else {
        onError(e, info('handler'));
        result = builtinFailure('INTERNAL');
        const why = e instanceof ProcedureError ? `fail('${e.code}') is not declared` : `threw ${(e as Error)?.message ?? String(e)}`;
        step('handler', 'fail', `${why}: 500 INTERNAL`);
      }
    }

    // Decision: analytics runs after the response is decided and doesn't block it.
    if (d.analytics.kind === 'event' && options.analytics) {
      const spec = d.analytics;
      const provider = options.analytics;
      let props: AnalyticsProps = {};
      try {
        props = spec.props ? spec.props(input, ctx) : {};
      } catch (e) {
        onError(e, info('analytics.props'));
      }
      const actorId = d.authn.kind === 'auth' && ctx != null ? d.authn.provider.actorId?.(ctx) : undefined;
      const event: AnalyticsEvent = {
        event: spec.event,
        procedure: name,
        surface: exec.surface,
        outcome: result.ok ? 'ok' : 'error',
        ...(result.ok ? {} : { code: result.code }),
        status: result.status,
        durationMs: Date.now() - started,
        ...(actorId ? { actorId } : {}),
        props,
      };
      step('analytics', 'pass', `${spec.event} ${JSON.stringify(props)}`);
      waitUntil(
        Promise.resolve()
          .then(() => provider.track(event, exec.env))
          .catch((e) => onError(e, info('analytics'))),
      );
    } else step('analytics', 'pass', (d.analytics as { reason?: string }).reason);
    return result;
  }

  const describe = (c: Concern, dec: any): string => {
    const via = dec.via ? ` [${dec.via}]` : '';
    if (dec.kind === 'none') return (c === 'input' ? 'none' : `none: ${dec.reason}`) + via;
    switch (c) {
      case 'authn': return `auth(${dec.provider.name ?? 'unnamed'})${via}`;
      case 'authz': return `policy(${dec.policy})${via}`;
      case 'input':
      case 'output': return `schema(${dec.schema['~standard'].vendor})${via}`;
      case 'errors': return `${Object.keys(dec.map).sort().join(' ')}${via}`;
      case 'analytics': return `event(${dec.event})${via}`;
      case 'mcp': return `tool(${dec.effect})${via}`;
      case 'cli': return `command(${dec.command})${via}`;
      case 'aiTool': return `tool(${dec.needsApproval ? 'needs approval' : 'no approval'})${via}`;
    }
  };

  const audit = (): AuditRow[] =>
    [...loaded.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        procedure: p.name,
        profiles: p.profiles.join(', ') || '-',
        ...(Object.fromEntries(CONCERNS.map((c) => [c, describe(c, p.decisions[c])])) as Record<Concern, string>),
      }));

  return {
    procedures: loaded,
    call,
    trace: {
      subscribe(fn) {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
      emit(event) {
        if (listeners.size) emit(event);
      },
      get active() {
        return listeners.size > 0;
      },
    },
    audit,
    auditTable() {
      const cols = ['procedure', 'profiles', ...CONCERNS] as const;
      const esc = (s: string) => s.replace(/\|/g, '\\|');
      const rows = audit().map((r) => `| ${cols.map((c) => esc(r[c])).join(' | ')} |`);
      return [`| ${cols.join(' | ')} |`, `|${cols.map(() => ' --- ').join('|')}|`, ...rows].join('\n') + '\n';
    },
    manifest(basePath = '/rpc') {
      return {
        version: 1,
        procedures: [...loaded.values()]
          .filter((p) => p.decisions.cli.kind === 'command')
          .map((p) => {
            const cli = p.decisions.cli as Extract<Decisions['cli'], { kind: 'command' }>;
            return {
              name: p.name,
              path: `${basePath}/${p.name}`,
              input: p.jsonSchema.input,
              output: p.jsonSchema.output,
              errors: { ...p.errors },
              cli: { command: cli.command, description: cli.description },
            };
          }),
      };
    },
  };
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);
}
