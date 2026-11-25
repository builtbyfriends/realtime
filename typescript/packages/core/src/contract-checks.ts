import type { CommandSpec, CommandName, Contract, ContractSpec, GoodInput, MoveOf, StateOf } from './contract.js';
import { isReason } from './contract.js';
import type { ContractEvent, ContractModule } from './contract-module.js';
import type { State } from './builder.js';
import { fieldsOf, isRecord, typeOf, wordsAt } from './json-schema.js';
import type { CallResult, Registry } from './registry.js';
import { validate } from './schema.js';

type Errors<C extends ContractSpec, K extends CommandName<C>> = keyof C['commands'][K]['errors'] & string;

export type ContractFixtures<C extends ContractSpec> = {
  /** The registry the module's procedures are deployed in. */
  registry: Registry;
  env?: unknown;
  /** A request from a caller who holds exactly these capabilities. */
  callerWith: (capabilities: ReadonlyArray<string>) => Request;
  /** A good input for each command, without `requestId`. A command with a move gets the state its record has to be in first. */
  arrange: {
    [K in CommandName<C>]: (state: [MoveOf<C, K>] extends [never] ? undefined : StateOf<C>) => GoodInput<C, K> | Promise<GoodInput<C, K>>;
  };
  /** For each listed failure of each command, an input that causes it. */
  causes: {
    [K in CommandName<C> as [Errors<C, K>] extends [never] ? never : K]: {
      [E in Errors<C, K>]: () => GoodInput<C, K> | Promise<GoodInput<C, K>>;
    };
  };
};

/** What `contractChecks(module)` gives back: `with` takes the fixtures and lists the checks. */
export type ContractChecker<C extends ContractSpec> = { with(fixtures: ContractFixtures<C>): Array<ContractCheck> };

/** One check. Each runs on its own, so a test runner can list them, as in `for (const c of checks) it(c.name, c.run)`. */
export type ContractCheck = { name: string; run: () => Promise<void> };

type Sent = State['inRaw'];

type LooseModule = { contract: Contract; events: { subscribe(listener: (event: ContractEvent) => void): () => void } };

type LooseFixtures = {
  registry: Registry;
  env?: unknown;
  callerWith: (capabilities: ReadonlyArray<string>) => Request;
  arrange: Readonly<Record<string, (state?: string) => Sent | Promise<Sent>>>;
  causes: Readonly<Record<string, Readonly<Record<string, () => Sent | Promise<Sent>>>>>;
};

type LooseChecker = { with(fixtures: LooseFixtures): Array<ContractCheck> };

type Observed = { result: CallResult; events: Array<ContractEvent> };

const shown = (r: CallResult) => (r.ok ? `ok ${JSON.stringify(r.value)}` : `${r.status} ${r.code}: ${r.message}${r.issues ? ` ${JSON.stringify(r.issues)}` : ''}`);

function wrongValueFor(type: string | null): string | number | null {
  switch (type) {
    case 'string': {return 42;}

    case 'number':
    case 'integer': {return 'not a number';}

    case 'boolean': {return 'yes';}

    case 'array': {return 'not a list';}

    case 'object': {return 'not an object';}

    default: {return null;}
  }
}

const asObject = (value: Sent) => (isRecord(value) ? value : {});

class Run {
  readonly capabilities: Array<string>;
  private readonly callers = new Map<string, Request>();

  constructor(
    readonly module: LooseModule,
    readonly f: LooseFixtures,
  ) {
    const all = Object.values(module.contract.commands).flatMap((c) => (isReason(c.capability) ? [] : [c.capability]));

    this.capabilities = [...new Set(all)];
  }

  get contract() {
    return this.module.contract;
  }

  caller(capabilities: ReadonlyArray<string>): Request {
    const key = [...capabilities].toSorted().join(' ');
    const found = this.callers.get(key);

    if (found) {return found;}

    const request = this.f.callerWith(capabilities);

    this.callers.set(key, request);

    return request;
  }

  async observe(calls: () => Promise<Array<CallResult>>): Promise<{ results: Array<CallResult>; events: Array<ContractEvent> }> {
    const events: Array<ContractEvent> = [];
    const stop = this.module.events.subscribe((e) => void events.push(e));

    try {
      const results = await calls();

      return { results, events };
    } finally {
      stop();
    }
  }

  async call(command: string, input: Sent, capabilities = this.capabilities): Promise<CallResult> {
    const waits: Array<Promise<unknown>> = [];

    const result = await this.f.registry.call(`${this.contract.name}.${command}`, input, {
      request: this.caller(capabilities),
      env: this.f.env,
      surface: 'direct',
      waitUntil: (p) => void waits.push(p),
    });

    await Promise.all(waits);

    return result;
  }

  async once(command: string, input: Sent, capabilities = this.capabilities): Promise<Observed> {
    const { results, events } = await this.observe(async () => [await this.call(command, input, capabilities)]);
    const [result] = results;

    if (!result) {throw new Error(`${this.contract.name}.${command}: the call returned nothing`);}

    return { result, events };
  }

  async goodInput(command: string, state?: string): Promise<Sent> {
    const arrange = this.f.arrange[command];

    if (!arrange) {throw new Error(`arrange.${command} is missing: add a function that returns a good input for it`);}

    return arrange(state);
  }

  send(cmd: CommandSpec, input: Sent, requestId: string = crypto.randomUUID()): Sent {
    return cmd.effect === 'read' ? input : { ...asObject(input), requestId };
  }
}

function expectOk(label: string, r: CallResult): asserts r is Extract<CallResult, { ok: true }> {
  if (!r.ok) {throw new Error(`${label}: expected success, got ${shown(r)}. Check the handler, or the arrange fixture's input.`);}
}

function expectCode(label: string, r: CallResult, code: string, hint: string): void {
  if (r.ok || r.code !== code) {throw new Error(`${label}: expected ${code}, got ${shown(r)}. ${hint}`);}
}

function stateOf(contract: Contract, result: Extract<CallResult, { ok: true }>): string {
  const field = contract.states?.field ?? '';
  const value = result.value;

  return isRecord(value) ? String(value[field]) : '';
}

function goodChecks(run: Run, name: string, cmd: CommandSpec): Array<ContractCheck> {
  const label = `${run.contract.name}.${name}`;
  const move = cmd.move === undefined ? undefined : run.contract.states?.moves[cmd.move];

  const checks: Array<ContractCheck> = [
    {
      name: `${label} accepts good input`,
      run: async () => {
        const { result, events } = await run.once(name, run.send(cmd, await run.goodInput(name, move?.from[0])));

        expectOk(label, result);

        for (const e of cmd.emits ?? []) {
          if (!events.some((x) => x.name === e)) {throw new Error(`${label}: succeeded without emitting "${e}", which it lists in emits. Emit it, or take it out of emits.`);}
        }
      },
    },
  ];

  if (cmd.example !== undefined && cmd.input) {
    const schema = cmd.input;

    checks.push({
      name: `${label} accepts its example`,
      run: async () => {
        const r = await validate(schema, cmd.example);

        if (!r.ok) {throw new Error(`${label}: example doesn't match the input schema: ${JSON.stringify(r.issues)}. Fix the example in the contract.`);}
      },
    });
  }

  return checks;
}

type BadInput = { what: string; input: Sent };

function badFields(contract: Contract, name: string, base: Record<string, Sent>): Array<BadInput> {
  const json = contract.json.commands[name]?.input ?? null;
  const bad: Array<BadInput> = wordsAt(json, 'required').map((key) => ({ what: `no ${key}`, input: Object.fromEntries(Object.entries(base).filter(([k]) => k !== key)) }));

  for (const [key, field] of fieldsOf(json) ?? []) {
    const wrong = wrongValueFor(typeOf(field));

    if (wrong !== null) {bad.push({ what: `${key} of the wrong type`, input: { ...base, [key]: wrong } });}
  }

  return bad;
}

function badInputs(contract: Contract, name: string, cmd: CommandSpec, good: Sent): Array<BadInput> {
  const base = asObject(good);
  const withId = (input: Sent) => (cmd.effect === 'read' ? input : { ...asObject(input), requestId: crypto.randomUUID() });

  if (!cmd.input) {
    return cmd.effect === 'read' ? [{ what: 'input it doesn\'t take', input: { unexpected: true } }] : [{ what: 'no requestId', input: { ...base } }];
  }

  return [
    ...(cmd.effect === 'read' ? [] : [{ what: 'no requestId', input: { ...base } }]),
    { what: 'a value that is not an object', input: 'not an object' },
    ...badFields(contract, name, base).map((b) => ({ what: b.what, input: withId(b.input) })),
  ];
}

function badInputChecks(run: Run, name: string, cmd: CommandSpec): Array<ContractCheck> {
  const label = `${run.contract.name}.${name}`;
  const move = cmd.move === undefined ? undefined : run.contract.states?.moves[cmd.move];

  return [
    {
      name: `${label} refuses bad input`,
      run: async () => {
        const good = await run.goodInput(name, move?.from[0]);

        for (const b of badInputs(run.contract, name, cmd, good)) {
          const { result, events } = await run.once(name, b.input);

          expectCode(`${label} with ${b.what}`, result, 'INVALID_INPUT', 'The input schema has to refuse it.');

          if (events.length) {throw new Error(`${label} with ${b.what}: published ${events.length} event(s) for a refused call`);}
        }
      },
    },
  ];
}

function capabilityChecks(run: Run, name: string, cmd: CommandSpec): Array<ContractCheck> {
  const label = `${run.contract.name}.${name}`;
  const capability = cmd.capability;
  const move = cmd.move === undefined ? undefined : run.contract.states?.moves[cmd.move];

  if (isReason(capability)) {return [];}

  return [
    {
      name: `${label} refuses a caller without ${capability}`,
      run: async () => {
        const without = run.capabilities.filter((c) => c !== capability);
        const { result, events } = await run.once(name, run.send(cmd, await run.goodInput(name, move?.from[0])), without);

        expectCode(label, result, 'FORBIDDEN', `The capability check has to say no without "${capability}".`);

        if (events.length) {throw new Error(`${label}: published ${events.length} event(s) for a refused caller`);}
      },
    },
  ];
}

function retryChecks(run: Run, name: string, cmd: CommandSpec): Array<ContractCheck> {
  const label = `${run.contract.name}.${name}`;
  const move = cmd.move === undefined ? undefined : run.contract.states?.moves[cmd.move];

  if (cmd.effect === 'read') {return [];}

  const twice = (together: boolean) => async () => {
    const input = run.send(cmd, await run.goodInput(name, move?.from[0]), crypto.randomUUID());

    const { results, events } = await run.observe(async () =>
      together ? Promise.all([run.call(name, input), run.call(name, input)]) : [await run.call(name, input), await run.call(name, input)],
    );

    const [first, second] = results;

    if (!first || !second) {throw new Error(`${label}: a call returned nothing`);}

    expectOk(`${label} first call`, first);

    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error(`${label}: the repeat got ${shown(second)}, not the first result ${shown(first)}. Pass runOnce to implementContract.`);
    }

    const expected = cmd.emits?.length ?? 0;

    if (events.length > expected) {throw new Error(`${label}: published ${events.length} event(s) for one requestId, expected at most ${expected}`);}
  };

  return [
    { name: `${label} runs once when a requestId repeats`, run: twice(false) },
    { name: `${label} runs once when a requestId comes twice at the same time`, run: twice(true) },
  ];
}

function moveChecks(run: Run, name: string, cmd: CommandSpec): Array<ContractCheck> {
  const label = `${run.contract.name}.${name}`;
  const states = run.contract.states;
  const move = cmd.move === undefined ? undefined : states?.moves[cmd.move];

  if (!states || !move || cmd.move === undefined) {return [];}

  const moveName = cmd.move;

  return states.list.map((from) => {
    const listed = move.from.includes(from);

    return {
      name: listed ? `${label} moves ${moveName}: ${from} -> ${move.to}` : `${label} refuses ${moveName} from ${from}`,
      run: async () => {
        const { result } = await run.once(name, run.send(cmd, await run.goodInput(name, from)));

        if (!listed) {
          expectCode(`${label} from ${from}`, result, 'MOVE_NOT_ALLOWED', `The contract doesn't list ${moveName} from ${from}: call move(current) in the handler.`);

          return;
        }

        expectOk(`${label} from ${from}`, result);

        const after = stateOf(run.contract, result);

        if (after !== move.to) {throw new Error(`${label} from ${from}: output says ${states.field} is ${after}, the contract says ${move.to}. Return the moved record.`);}
      },
    };
  });
}

function causeChecks(run: Run, name: string, cmd: CommandSpec): Array<ContractCheck> {
  const label = `${run.contract.name}.${name}`;

  return Object.keys(cmd.errors).map((code) => ({
    name: `${label} fails with ${code}`,
    run: async () => {
      const cause = run.f.causes[name]?.[code];

      if (!cause) {throw new Error(`causes.${name}.${code} is missing: add a function that returns an input that causes it`);}

      const { result, events } = await run.once(name, run.send(cmd, await cause()));

      expectCode(label, result, code, `The input from causes.${name}.${code} has to make the handler call fail('${code}').`);

      if (events.length) {throw new Error(`${label}: published ${events.length} event(s) for a failed call`);}
    },
  }));
}

/**
 * Checks a build of a module against its contract from the outside, through the registry: each command with good and bad input, a
 * caller without the capability, a repeated requestId, each listed move, each unlisted move and each listed failure.
 *
 *   const checks = contractChecks(module).with({ registry, callerWith, arrange, causes });
 *   for (const check of checks) it(check.name, check.run);
 */
export function contractChecks<C extends ContractSpec>(module: ContractModule<C>): ContractChecker<C>;
export function contractChecks(module: LooseModule): LooseChecker {
  return {
    with(fixtures) {
      const run = new Run(module, fixtures);

      return Object.entries(module.contract.commands).flatMap(([name, cmd]) => [
        ...goodChecks(run, name, cmd),
        ...badInputChecks(run, name, cmd),
        ...capabilityChecks(run, name, cmd),
        ...retryChecks(run, name, cmd),
        ...moveChecks(run, name, cmd),
        ...causeChecks(run, name, cmd),
      ]);
    },
  };
}
