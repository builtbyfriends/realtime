import type { AuthProvider, Concern, Decisions, Handler, HandlerArgs, Procedure, State, Surface } from './builder.js';
import { MOVE_NOT_ALLOWED, fillTopic, isReason, kebab, topicsOf } from './contract.js';
import type {
  CommandError,
  CommandInput,
  CommandName,
  CommandOutput,
  CommandSpec,
  Contract,
  ContractSpec,
  EmitsOf,
  HandlerOutput,
  MoveOf,
  ParsedInput,
  Reason,
  StateOf,
  StatesSpec,
} from './contract.js';
import { isRequestToken, requestIdSchema, requestInput } from './request-id.js';
import type { EventOutbox } from './outbox.js';
import type { RunOnceStore, Settled } from './run-once.js';
import type { InferIn } from './schema.js';
import { validate } from './schema.js';

/** One event a module published. `event` is "<module>.<name>", and `topic` is one of the contract's topics filled from the payload. An event with several topics is published once on each. */
export type ContractEvent = {
  module: string;
  name: string;
  event: string;
  topic: string;
  payload: unknown;
  /** Who ran the command, when the sign-in names them. Left out otherwise, and on events kept before this field existed. */
  actor?: string;
  /** What acted for the caller, when the sign-in names one. Plain text. Rights stay with the caller. */
  via?: string;
};

type Ctx0 = null;

type ToOf<C extends ContractSpec, K extends CommandName<C>> = C['states'] extends StatesSpec
  ? C['states']['moves'][MoveOf<C, K>]['to']
  : never;

export type CommandArgs<C extends ContractSpec, K extends CommandName<C>, Ctx, Env> = {
  input: ParsedInput<C, K>;
  ctx: Ctx;
  env: Env;
  request: Request;
  surface: Surface;
  waitUntil: (promise: Promise<void>) => void;
  /** Ends the call with one of the command's listed failures. */
  fail: (code: CommandError<C, K>, message?: string) => never;
  /** Queues an event the command lists in `emits`. It's checked and published once the handler returns. */
  emit: <E extends EmitsOf<C, K>>(event: E, payload: InferIn<C['events'][E]['payload']>) => void;
  /** The state after this command's move, or MOVE_NOT_ALLOWED when the contract doesn't list a move from `from`. */
  move: [MoveOf<C, K>] extends [never] ? never : (from: StateOf<C>) => ToOf<C, K>;
};

export type CommandHandler<C extends ContractSpec, K extends CommandName<C>, Ctx, Env> = (
  args: CommandArgs<C, K, Ctx, Env>,
) => Promise<HandlerOutput<C, K>> | HandlerOutput<C, K>;

/** What the capability check is asked: does this caller hold this right for this input? */
export type CapabilityQuestion<C extends ContractSpec, Ctx> = {
  [K in CommandName<C>]: { ctx: Ctx; capability: string; command: K; input: ParsedInput<C, K> };
}[CommandName<C>];

export type Implementation<C extends ContractSpec, Ctx, Env> = {
  /** Who is calling. Every command of a module shares it. */
  auth: AuthProvider<Ctx, Env> | Reason;
  /** The one capability check. Needed when a command names a capability. */
  can?: (question: CapabilityQuestion<C, Ctx>) => boolean | Promise<boolean>;
  /** True sends one analytics event per command, named after the command. */
  analytics: true | Reason;
  /** Where events go, such as a live stream. Runs after the command succeeds, through `waitUntil`. */
  publish: ((event: ContractEvent, env: Env) => void | Promise<void>) | Reason;
  /** Needed when a command writes. */
  runOnce?: RunOnceStore;
  /**
   * Keeps each event until `publish` takes it, and tries again when it throws, such as `storageOutbox(ctx.storage)`. Without it, an
   * event whose delivery fails is gone. With it, delivery is at least once, so a listener can get the same event twice.
   */
  outbox?: EventOutbox;
  /** A handler for each command this place serves, or a reason for one that another place serves, such as a shared index. */
  commands: { [K in CommandName<C>]: CommandHandler<C, K, Ctx, Env> | Reason };
};

export type ContractProcedure<C extends ContractSpec, K extends CommandName<C>> = K extends string
  ? Procedure<{
      name: `${C['name']}.${K}`;
      env: unknown;
      ctx: unknown;
      in: ParsedInput<C, K>;
      inRaw: CommandInput<C, K>;
      outRaw: HandlerOutput<C, K>;
      out: CommandOutput<C, K>;
      err: CommandError<C, K>;
      done: Concern;
    }>
  : never;

export type ContractModule<C extends ContractSpec> = {
  readonly contract: Contract<C>;
  /** One procedure per command this place serves. Pass them to `defineRegistry` with the rest of the app's procedures. */
  readonly procedures: Array<ContractProcedure<C, CommandName<C>>>;
  readonly events: ModuleEvents;
};

export type ModuleEvents = {
  /** Each event as a command emits it. For tests and dev tools. */
  subscribe(listener: (event: ContractEvent) => void): () => void;
  /** Tries the events the outbox still holds, oldest first, and says how many are left. Call it from the owner's `alarm()`. */
  deliver(env: State['env']): Promise<number>;
  /** True when an outbox keeps each event until it's delivered. */
  readonly kept: boolean;
};

/** What `implementContract(contract)` gives back: `with` takes the handlers and the ports. */
export type ContractImplementer<C extends ContractSpec> = {
  with<Ctx = Ctx0, Env = unknown>(impl: Implementation<C, Ctx, Env>): ContractModule<C>;
};

type EventListener = (event: ContractEvent) => void;

type LooseArgs = Omit<HandlerArgs<State>, 'fail' | 'waitUntil'> & {
  waitUntil: (promise: Promise<void>) => void;
  fail: (code: string, message?: string) => never;
  emit: <P>(event: string, payload: P) => void;
  move: (from: string) => string;
};

type LooseImplementation = {
  auth: AuthProvider | Reason;
  can?: (question: { ctx: State['ctx']; capability: string; command: string; input: State['in'] }) => boolean | Promise<boolean>;
  analytics: true | Reason;
  publish: ((event: ContractEvent, env: State['env']) => void | Promise<void>) | Reason;
  runOnce?: RunOnceStore;
  outbox?: EventOutbox;
  commands: Readonly<Record<string, ((args: LooseArgs) => State['outRaw']) | Reason>>;
};

type LooseModule = {
  readonly contract: Contract;
  readonly procedures: Array<Procedure>;
  readonly events: ModuleEvents;
};

type LooseImplementer = { with(impl: LooseImplementation): LooseModule };

type Pending = { name: string; payload: ContractEvent['payload'] };

const NO_ERRORS = 'The contract lists no ways for this command to fail';

function procedureName<M extends string, K extends string>(module: M, command: K): `${M}.${K}` {
  return `${module}.${command}`;
}

function commandInput(raw: State['in']): State['in'] {
  return isRequestToken(raw) ? requestInput(raw)?.input : raw;
}

function errorsFor(cmd: CommandSpec) {
  return cmd.move === undefined ? { ...cmd.errors } : { ...cmd.errors, MOVE_NOT_ALLOWED: { ...MOVE_NOT_ALLOWED } };
}

function authzFor(name: string, cmd: CommandSpec, impl: LooseImplementation): Decisions['authz'] {
  const capability = cmd.capability;
  const can = impl.can;

  if (isReason(capability)) {return { kind: 'none', reason: capability.reason };}

  return {
    kind: 'policy',
    policy: capability,
    check: async (ctx, raw) => (can ? (await can({ ctx, capability, command: name, input: commandInput(raw) })) === true : false),
  };
}

function inputFor(contract: Contract, name: string, cmd: CommandSpec): Decisions['input'] {
  if (cmd.effect !== 'read') {return { kind: 'schema', schema: requestIdSchema(cmd.input, contract.json.commands[name]?.input ?? null) };}

  return cmd.input ? { kind: 'schema', schema: cmd.input } : { kind: 'none' };
}

function surfacesFor(contract: Contract, name: string, cmd: CommandSpec): Pick<Decisions, 'mcp' | 'cli' | 'aiTool'> {
  const tool = cmd.tool;

  const cli: Decisions['cli'] =
    cmd.cli === true ? { kind: 'command', command: `${kebab(contract.name)} ${kebab(name)}`, description: cmd.description } : { kind: 'none', reason: cmd.cli.reason };

  if ('reason' in tool) {return { mcp: { kind: 'none', reason: tool.reason }, cli, aiTool: { kind: 'none', reason: tool.reason } };}

  return {
    mcp: { kind: 'tool', description: cmd.description, effect: cmd.effect, idempotent: true },
    cli,
    aiTool: { kind: 'tool', description: cmd.description, needsApproval: tool.needsApproval },
  };
}

function decisionsFor(contract: Contract, name: string, cmd: CommandSpec, impl: LooseImplementation): Decisions {
  const errors = errorsFor(cmd);

  return {
    authn: 'reason' in impl.auth ? { kind: 'none', reason: impl.auth.reason } : { kind: 'auth', provider: impl.auth },
    authz: authzFor(name, cmd, impl),
    input: inputFor(contract, name, cmd),
    output: { kind: 'schema', schema: cmd.output },
    errors: Object.keys(errors).length ? { kind: 'map', map: errors } : { kind: 'none', reason: NO_ERRORS },
    analytics: impl.analytics === true ? { kind: 'event', event: procedureName(contract.name, name) } : { kind: 'none', reason: impl.analytics.reason },
    ...surfacesFor(contract, name, cmd),
  };
}

function setupProblems(contract: Contract, impl: LooseImplementation): Array<string> {
  const problems: Array<string> = [];

  for (const [name, cmd] of Object.entries(contract.commands)) {
    const handler = Object.hasOwn(impl.commands, name) ? impl.commands[name] : undefined;

    if (!handler) {problems.push(`commands.${name}: add its handler, or { reason } when another place serves it`);}

    if (!handler || 'reason' in handler) {continue;}

    if (!isReason(cmd.capability) && !impl.can) {problems.push(`commands.${name} needs the capability "${cmd.capability}": pass can()`);}

    if (cmd.effect !== 'read' && !impl.runOnce) {problems.push(`commands.${name} writes: pass runOnce, such as memoryRunOnce()`);}
  }

  for (const name of Object.keys(impl.commands).filter((n) => !Object.hasOwn(contract.commands, n))) {
    problems.push(`commands.${name} is not in the contract: add it there or remove the handler`);
  }

  if (impl.outbox && 'reason' in impl.publish) {problems.push('outbox keeps events for publish, which is off: pass publish, or drop the outbox');}

  return problems;
}

function moveFor(states: StatesSpec | undefined, move: string | undefined, fail: LooseArgs['fail']) {
  return (from: string): string => {
    const spec = move === undefined ? undefined : states?.moves[move];

    if (!spec) {return fail('MOVE_NOT_ALLOWED', 'This command makes no move');}

    if (!spec.from.includes(from)) {return fail('MOVE_NOT_ALLOWED', `Can't ${move} from ${from}. It's allowed from ${spec.from.join(', ')}.`);}

    return spec.to;
  };
}

type Who = { actor?: string; via?: string };

async function checkedEvents(contract: Contract, command: string, cmd: CommandSpec, pending: Pending, who: Who): Promise<Array<ContractEvent>> {
  const spec = Object.hasOwn(contract.events, pending.name) ? contract.events[pending.name] : undefined;
  const listed = cmd.emits ?? [];

  if (!spec || !listed.includes(pending.name)) {
    throw new Error(`commands.${command} emitted "${pending.name}", which its contract doesn't list in emits (${listed.join(', ') || 'none'})`);
  }

  const r = await validate(spec.payload, pending.payload);

  if (!r.ok) {
    const issues = r.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ');

    throw new Error(`commands.${command} emitted "${pending.name}" with a payload that doesn't match events.${pending.name}.payload: ${issues}`);
  }

  const event = `${contract.name}.${pending.name}`;

  return topicsOf(spec).map((topic) => ({ module: contract.name, name: pending.name, event, topic: fillTopic(topic, r.value), payload: r.value, ...who }));
}

class Built {
  readonly listeners = new Set<EventListener>();
  readonly keepMs: number;
  private delivering: Promise<number> | null = null;
  private again = false;

  constructor(
    readonly contract: Contract,
    readonly impl: LooseImplementation,
  ) {
    this.keepMs = (contract.requestIds?.keepHours ?? 0) * 3_600_000;
  }

  actorOf(ctx: State['ctx']): string {
    const auth = this.impl.auth;

    return 'reason' in auth ? 'anyone' : (auth.actorId?.(ctx) ?? 'anyone');
  }

  whoActed(ctx: State['ctx']): Who {
    const auth = this.impl.auth;

    if ('reason' in auth) {return {};}

    // Decision: both labels are for readers of an event, so a provider that throws doesn't fail the command, as with the actor id in traces.
    const label = (read: ((ctx: State['ctx']) => string | undefined) | undefined) => {
      try {
        return read?.(ctx) || undefined;
      } catch {
        return undefined;
      }
    };

    const who: Who = {};
    const actor = label(auth.actorId?.bind(auth));
    const via = label(auth.viaOf?.bind(auth));

    if (actor) {who.actor = actor;}

    if (via) {who.via = via;}

    return who;
  }

  async publishAll(name: string, cmd: CommandSpec, pending: Array<Pending>, args: HandlerArgs<State>): Promise<void> {
    const who = this.whoActed(args.ctx);
    const events = (await Promise.all(pending.map((p) => checkedEvents(this.contract, name, cmd, p, who)))).flat();
    const publish = this.impl.publish;
    const outbox = this.impl.outbox;

    if (outbox && events.length) {outbox.keep(events);}

    for (const e of events) {
      for (const listener of this.listeners) {args.waitUntil(Promise.resolve().then(() => listener(e)));}

      if (!outbox && !('reason' in publish)) {args.waitUntil(Promise.resolve().then(() => publish(e, args.env)));}
    }

    if (outbox && events.length) {args.waitUntil(this.deliver(args.env).then(() => undefined));}
  }

  async deliver(env: State['env']): Promise<number> {
    if (this.delivering) {
      this.again = true;

      return this.delivering;
    }

    this.delivering = this.deliverAll(env).finally(() => {
      this.delivering = null;
    });

    return this.delivering;
  }

  private async deliverAll(env: State['env']): Promise<number> {
    const outbox = this.impl.outbox;
    const publish = this.impl.publish;

    if (!outbox || 'reason' in publish) {return 0;}

    do {
      this.again = false;

      for (const kept of outbox.pending()) {
        try {
          await publish(kept.event, env);
        } catch {
          await outbox.retryLater();

          return outbox.pending().length;
        }

        outbox.delivered(kept.id);
      }
    } while (this.again);

    return outbox.pending().length;
  }

  async run(name: string, cmd: CommandSpec, args: HandlerArgs<State>, input: State['in']): Promise<Settled> {
    const pending: Array<Pending> = [];
    const handle = this.impl.commands[name];

    if (!handle || 'reason' in handle) {throw new Error(`commands.${name} is served elsewhere (${handle?.reason ?? 'no handler'})`);}

    const value = await handle({
      input,
      ctx: args.ctx,
      env: args.env,
      request: args.request,
      surface: args.surface,
      waitUntil: args.waitUntil,
      fail: args.fail,
      emit: (event, payload) => void pending.push({ name: event, payload }),
      move: moveFor(this.contract.states, cmd.move, args.fail),
    });

    await this.publishAll(name, cmd, pending, args);

    return { value };
  }

  procedure(name: string, cmd: CommandSpec): Procedure {
    const full = procedureName(this.contract.name, name);
    const runOnce = this.impl.runOnce;

    const handler: Handler<State> = async (args) => {
      const write = isRequestToken(args.input) ? requestInput(args.input) : undefined;

      if (!write || !runOnce) {return (await this.run(name, cmd, args, args.input)).value;}

      const key = `${full}|${this.actorOf(args.ctx)}|${write.requestId}`;

      return (await runOnce.run(key, this.keepMs, () => this.run(name, cmd, args, write.input))).value;
    };

    return Object.freeze({ '~realtime': 'procedure', name: full, decisions: decisionsFor(this.contract, name, cmd, this.impl), profiles: [], handler });
  }

  serves(name: string): boolean {
    const handler = this.impl.commands[name];

    return handler !== undefined && !('reason' in handler);
  }

  module(): LooseModule {
    const listeners = this.listeners;

    return {
      contract: this.contract,
      procedures: Object.entries(this.contract.commands).filter(([name]) => this.serves(name)).map(([name, cmd]) => this.procedure(name, cmd)),
      events: {
        subscribe(listener) {
          listeners.add(listener);

          return () => void listeners.delete(listener);
        },
        deliver: async (env) => this.deliver(env),
        kept: this.impl.outbox !== undefined,
      },
    };
  }
}

/**
 * Turns a contract and its handlers into procedures. Each command becomes `<module>.<command>` with its decisions taken from the
 * contract: HTTP, MCP, AI tools, the CLI, typed clients and the audit all follow from it. Throws one error listing what's missing.
 *
 *   export const tasksModule = implementContract(tasks).with({ auth, can, analytics, publish, runOnce, commands: { ... } });
 */
export function implementContract<C extends ContractSpec>(contract: Contract<C>): ContractImplementer<C>;
export function implementContract(contract: Contract): LooseImplementer {
  return {
    with(impl) {
      const problems = setupProblems(contract, impl);

      if (problems.length) {
        throw new Error(`implementation of contract "${contract.name}" has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
      }

      return new Built(contract, impl).module();
    },
  };
}
