import type { AnySchema, InferIn, InferOut } from './schema.js';
import type { BuiltinErrorCode, ErrorSpec } from './errors.js';
import type { CheckReason } from './reason.js';

// Decision: the order here is the order error messages list the concerns in.

export const CONCERNS = ['authn', 'authz', 'input', 'output', 'errors', 'analytics', 'mcp', 'cli', 'aiTool'] as const;
export type Concern = (typeof CONCERNS)[number];

/** Where a call came from. CLI calls arrive over HTTP with an `x-realtime-surface: cli` header. */
export type Surface = 'http' | 'mcp' | 'cli' | 'ai' | 'direct';

/** Resolves who is calling. Return null for "not signed in", which becomes a 401. */
export interface AuthProvider<Ctx = unknown, Env = unknown> {
  /** Shows up in the audit, e.g. "session" or "api-token". */
  readonly name: string;
  resolve(request: Request, env: Env): Promise<Ctx | null | undefined> | Ctx | null | undefined;
  /** Optional stable id for analytics (never an email). */
  actorId?(ctx: Ctx): string | undefined;
}

export type AnalyticsProps = Record<string, string | number | boolean | null>;

/** What `mcp()` exposes. `effect` is required so read-only and destructive tools are never guessed. */
export type McpSpec = {
  description: string;
  effect: 'read' | 'write' | 'destructive';
  title?: string;
  idempotent?: boolean;
  /** True when the tool reaches systems outside this app (email, payments, the web). */
  openWorld?: boolean;
};
export type CliSpec = { command: string; description: string };
/** `needsApproval` is required: say whether a person must confirm before an agent runs this. */
export type AiToolSpec = { description: string; needsApproval: boolean };

type OptOut = { kind: 'none'; reason: string; via?: string };
type Via = { via?: string };

/** The runtime record of every decision. Adapters and the audit read only this. */
export type Decisions = {
  authn: ({ kind: 'auth'; provider: AuthProvider } & Via) | OptOut;
  authz: ({ kind: 'policy'; policy: string; check: (ctx: unknown, input: unknown) => boolean | Promise<boolean> } & Via) | OptOut;
  input: ({ kind: 'schema'; schema: AnySchema } & Via) | ({ kind: 'none' } & Via);
  output: { kind: 'schema'; schema: AnySchema } & Via;
  errors: ({ kind: 'map'; map: Record<string, ErrorSpec> } & Via) | OptOut;
  analytics: ({ kind: 'event'; event: string; props?: (input: unknown, ctx: unknown) => AnalyticsProps } & Via) | OptOut;
  mcp: ({ kind: 'tool' } & McpSpec & Via) | OptOut;
  cli: ({ kind: 'command' } & CliSpec & Via) | OptOut;
  aiTool: ({ kind: 'tool' } & AiToolSpec & Via) | OptOut;
};

// Decision: type-state. The builder's type records which concerns are decided; the runtime
// value is only a record of decisions.

export interface State {
  name: string;
  env: unknown;
  ctx: unknown;
  /** Parsed input the handler sees, and the raw input callers send. */
  in: unknown;
  inRaw: unknown;
  /** What the handler returns, and what callers receive after output parsing. */
  outRaw: unknown;
  out: unknown;
  err: string;
  done: Concern;
}

type Init<Env, N extends string> = {
  name: N; env: Env; ctx: unknown; in: unknown; inRaw: unknown; outRaw: unknown; out: unknown; err: never; done: never;
};

type Next<S extends State, K extends Concern, P = unknown> = {
  name: S['name'];
  env: S['env'];
  ctx: P extends { ctx: infer X } ? X : S['ctx'];
  in: P extends { in: infer X } ? X : S['in'];
  inRaw: P extends { inRaw: infer X } ? X : S['inRaw'];
  outRaw: P extends { outRaw: infer X } ? X : S['outRaw'];
  out: P extends { out: infer X } ? X : S['out'];
  err: P extends { err: infer X extends string } ? X : S['err'];
  done: S['done'] | K;
};

type Merge<S extends State, PS extends State> = {
  name: S['name'];
  env: S['env'];
  ctx: 'authn' extends PS['done'] ? PS['ctx'] : S['ctx'];
  in: 'input' extends PS['done'] ? PS['in'] : S['in'];
  inRaw: 'input' extends PS['done'] ? PS['inRaw'] : S['inRaw'];
  outRaw: 'output' extends PS['done'] ? PS['outRaw'] : S['outRaw'];
  out: 'output' extends PS['done'] ? PS['out'] : S['out'];
  err: 'errors' extends PS['done'] ? PS['err'] : S['err'];
  done: S['done'] | PS['done'];
};

type MissingList<Done, L extends ReadonlyArray<string> = typeof CONCERNS> = L extends readonly [
  infer H extends string,
  ...infer R extends Array<string>,
]
  ? H extends Done
    ? MissingList<Done, R>
    : [H, ...MissingList<Done, R>]
  : [];
type Join<T extends Array<string>> = T extends [infer A extends string, ...infer R extends Array<string>]
  ? R extends []
    ? A
    : `${A}, ${Join<R>}`
  : '';

/** Never when complete, otherwise the message the compiler prints at `.handler(...)`. */
export type Undecided<Done> = MissingList<Done>['length'] extends 0
  ? never
  : `Undecided: ${Join<MissingList<Done>>}. Decide each one (or opt out with a reason) before .handler()`;

export type AuthzOrderMessage = 'Decide authentication first: call .auth(provider) or .noAuth({ reason }) before .authz()';

type ReservedCode<E> = Extract<keyof E, BuiltinErrorCode>;
type CheckErrors<E> = [ReservedCode<E>] extends [never]
  ? unknown
  : { '~error': `Error code ${ReservedCode<E> & string} is reserved by the pipeline; pick another name` };

export type HandlerArgs<S extends State> = {
  input: S['in'];
  ctx: S['ctx'];
  env: S['env'];
  /** Ends the call with a declared error. Only codes passed to `.errors()` type-check. */
  fail: (code: S['err'], message?: string) => never;
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
  surface: Surface;
};
export type Handler<S extends State> = (args: HandlerArgs<S>) => Promise<S['outRaw']> | S['outRaw'];

type Kind = 'procedure' | 'profile';
type Ret<B extends Kind, S extends State> = B extends 'procedure' ? Builder<S> : Profile<S>;

type Methods<S extends State, B extends Kind> = {
  /** Require a signed-in caller. The provider's result becomes `ctx`. */
  auth: <C>(provider: AuthProvider<C, S['env']>) => Ret<B, Next<S, 'authn', { ctx: C }>>;
  /** Public procedure. `ctx` is null. */
  noAuth: <const R extends string>(opt: { reason: CheckReason<R> }) => Ret<B, Next<S, 'authn', { ctx: null }>>;
  /** Decide who may call this. Runs after input parsing, so the policy can read the input. */
  authz: 'authn' extends S['done']
    ? (policy: {
        /** Policy name for the audit, e.g. "org-member" or "admin-only". */
        policy: string;
        check: (ctx: S['ctx'], input: S['in']) => boolean | Promise<boolean>;
      }) => Ret<B, Next<S, 'authz'>>
    : (policy: AuthzOrderMessage) => never;
  /** Every authenticated (or anonymous) caller may call this. */
  noAuthz: <const R extends string>(opt: { reason: CheckReason<R> }) => Ret<B, Next<S, 'authz'>>;
  input: <I extends AnySchema>(schema: I) => Ret<B, Next<S, 'input', { in: InferOut<I>; inRaw: InferIn<I> }>>;
  noInput: () => Ret<B, Next<S, 'input', { in: undefined; inRaw: void }>>;
  /** Required for every procedure. There is no noOutput(); return an empty object instead. */
  output: <O extends AnySchema>(schema: O) => Ret<B, Next<S, 'output', { out: InferOut<O>; outRaw: InferIn<O> }>>;
  errors: <const E extends Record<string, ErrorSpec>>(
    map: E & CheckErrors<E>,
  ) => Ret<B, Next<S, 'errors', { err: Extract<keyof E, string> }>>;
  noErrors: <const R extends string>(opt: { reason: CheckReason<R> }) => Ret<B, Next<S, 'errors', { err: never }>>;
  analytics: (spec: {
    event: string;
    props?: (input: S['in'], ctx: S['ctx']) => AnalyticsProps;
  }) => Ret<B, Next<S, 'analytics'>>;
  noAnalytics: <const R extends string>(opt: { reason: CheckReason<R> }) => Ret<B, Next<S, 'analytics'>>;
  mcp: (spec: McpSpec) => Ret<B, Next<S, 'mcp'>>;
  noMcp: <const R extends string>(opt: { reason: CheckReason<R> }) => Ret<B, Next<S, 'mcp'>>;
  cli: (spec: CliSpec) => Ret<B, Next<S, 'cli'>>;
  noCli: <const R extends string>(opt: { reason: CheckReason<R> }) => Ret<B, Next<S, 'cli'>>;
  aiTool: (spec: AiToolSpec) => Ret<B, Next<S, 'aiTool'>>;
  noAiTool: <const R extends string>(opt: { reason: CheckReason<R> }) => Ret<B, Next<S, 'aiTool'>>;
  /** Apply a profile: a named bundle of decisions. It may not decide anything already decided here. */
  use: <P extends AnyProfile>(profile: P & CheckUse<S, P['~state']>) => Ret<B, Merge<S, P['~state']>>;
};

type Owner = {
  authn: 'auth' | 'noAuth';
  authz: 'authz' | 'noAuthz';
  input: 'input' | 'noInput';
  output: 'output';
  errors: 'errors' | 'noErrors';
  analytics: 'analytics' | 'noAnalytics';
  mcp: 'mcp' | 'noMcp';
  cli: 'cli' | 'noCli';
  aiTool: 'aiTool' | 'noAiTool';
};

/** Methods of concerns already decided are removed, so autocomplete only offers open decisions. */
type Open<S extends State, B extends Kind> = Omit<Methods<S, B>, Owner[S['done']]>;

type Overlap<S extends State, PS extends State> = Extract<PS['done'], S['done']>;
type CheckUse<S extends State, PS extends State> = [Overlap<S, PS>] extends [never]
  ? unknown
  : { '~error': `Already decided here and in the profile: ${Join<MissingList<Exclude<Concern, Overlap<S, PS>>>>}` };

export type Builder<S extends State> = Open<S, 'procedure'> & {
  readonly '~realtime': 'builder';
  /** The gate: until every concern is decided, the parameter type is a message naming what is missing. */
  handler: (fn: [Undecided<S['done']>] extends [never] ? Handler<S> : Undecided<S['done']>) => Procedure<S>;
};

export type Profile<S extends State> = Open<S, 'profile'> & {
  readonly '~realtime': 'profile';
  readonly '~state': S;
  readonly name: string;
  readonly decisions: Partial<Decisions>;
};
type AnyProfile = { readonly '~realtime': 'profile'; readonly '~state': State; readonly name: string };

export interface Procedure<S extends State = State> {
  readonly '~realtime': 'procedure';
  readonly name: S['name'];
  readonly decisions: Decisions;
  readonly profiles: ReadonlyArray<string>;
  readonly handler: Handler<State>;
  /** Phantom types for typed clients. Not present at runtime. */
  readonly '~types'?: { input: S['inRaw']; output: S['out']; errors: S['err'] };
}

export type AnyProcedure = Procedure;
export type InputOf<P> = P extends Procedure<infer S> ? S['inRaw'] : never;
export type OutputOf<P> = P extends Procedure<infer S> ? S['out'] : never;
export type ErrorsOf<P> = P extends Procedure<infer S> ? S['err'] : never;

// Decision: builders are immutable. Each call returns a new builder, so a partial chain can be
// shared without leaking decisions between procedures.

type RuntimeNode = { readonly '~realtime': 'builder' | 'profile' };

function make<S extends State>(kind: 'procedure', name: string, decisions: Partial<Decisions>, profiles: Array<string>): Builder<S>;
function make<S extends State>(kind: 'profile', name: string, decisions: Partial<Decisions>, profiles: Array<string>): Profile<S>;
function make(kind: Kind, name: string, decisions: Partial<Decisions>, profiles: Array<string>): Builder<State> | Profile<State>;
function make(kind: Kind, name: string, decisions: Partial<Decisions>, profiles: Array<string>): RuntimeNode {
  const label = kind === 'profile' ? `profile "${name}"` : `procedure "${name}"`;
  const decide = <C extends Concern>(c: C, d: Decisions[C]) => {
    const existing = decisions[c];
    if (existing) {
      const via = existing.via ? ` by profile "${existing.via}"` : '';
      throw new Error(`${label}: ${c} is already decided${via}`);
    }
    return make(kind, name, { ...decisions, [c]: d }, profiles);
  };
  const optOut = (c: Concern) => (opt: { reason: string }) => decide(c, { kind: 'none', reason: opt?.reason });

  const methods = {
    auth: (provider: AuthProvider) => decide('authn', { kind: 'auth', provider }),
    noAuth: optOut('authn'),
    authz: (p: { policy: string; check: (ctx: unknown, input: unknown) => boolean | Promise<boolean> }) =>
      decide('authz', { kind: 'policy', policy: p?.policy, check: p?.check }),
    noAuthz: optOut('authz'),
    input: (schema: AnySchema) => decide('input', { kind: 'schema', schema }),
    noInput: () => decide('input', { kind: 'none' }),
    output: (schema: AnySchema) => decide('output', { kind: 'schema', schema }),
    errors: (map: Record<string, ErrorSpec>) => decide('errors', { kind: 'map', map }),
    noErrors: optOut('errors'),
    analytics: (spec: { event: string; props?: (input: unknown, ctx: unknown) => AnalyticsProps }) =>
      decide('analytics', { kind: 'event', ...spec }),
    noAnalytics: optOut('analytics'),
    mcp: (spec: McpSpec) => decide('mcp', { kind: 'tool', ...spec }),
    noMcp: optOut('mcp'),
    cli: (spec: CliSpec) => decide('cli', { kind: 'command', ...spec }),
    noCli: optOut('cli'),
    aiTool: (spec: AiToolSpec) => decide('aiTool', { kind: 'tool', ...spec }),
    noAiTool: optOut('aiTool'),
    use: (profile: { '~realtime': string; name: string; decisions: Partial<Decisions> }) => {
      if (profile?.['~realtime'] !== 'profile') {throw new Error(`${label}: use() takes a profile made with profile(name)`);}
      const merged: Partial<Decisions> = { ...decisions };
      for (const c of CONCERNS) {
        const d = profile.decisions[c];
        if (!d) {continue;}
        if (merged[c]) {throw new Error(`${label}: ${c} is decided here and in profile "${profile.name}"`);}
        setDecision(merged, c, { ...d, via: d.via ?? profile.name });
      }
      return make(kind, name, merged, [...profiles, profile.name]);
    },
  };

  if (kind === 'profile') {
    const node = { ...methods, '~realtime': 'profile', '~state': undefined, name, decisions } as const;
    return node;
  }
  const node = {
    ...methods,
    '~realtime': 'builder',
    name,
    handler: (fn: Handler<State>) => {
      if (typeof fn !== 'function') {throw new Error(`${label}: handler() needs a function`);}
      // Decision: completeness is checked when the registry loads, so the error lists each problem at
      // once and also covers code that skipped the type checker.
      return Object.freeze({ '~realtime': 'procedure', name, decisions: { ...decisions }, profiles, handler: fn });
    },
  } as const;
  return node;
}

function setDecision<C extends Concern>(target: Partial<Decisions>, c: C, d: Decisions[C]): void {
  target[c] = d;
}

/** Typed entry points for one Worker. `Env` types `env` in handlers and providers. */
export function createProcedures<Env = unknown>() {
  return {
    procedure: <const N extends string>(name: N): Builder<Init<Env, N>> => make('procedure', name, {}, []),
    profile: (name: string): Profile<Init<Env, string>> => make('profile', name, {}, []),
  };
}

export const { procedure, profile } = createProcedures<unknown>();

/**
 * Gives an unnamed procedure (or an unfinished builder) its registered name. An explicit
 * `procedure('name')` keeps its own name.
 */
export function withProcedureName<P extends { readonly name: string }>(p: P, name: string): P {
  if (p.name) {
    return p;
  }
  const named = { ...p, name };
  return (Object.isFrozen(p) ? Object.freeze(named) : named);
}
