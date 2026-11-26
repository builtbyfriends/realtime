import { array, asyncModelRun, asyncProperty, check as checkProperty, commands, constant, constantFrom, nat, stringify } from 'fast-check';
import type { Arbitrary, AsyncCommand, Parameters, RunDetails } from 'fast-check';
import type { CommandSpec, Contract } from './contract.js';
import type { ContractEvent } from './contract-module.js';
import type { State } from './builder.js';
import { isRecord } from './json-schema.js';
import type { CallResult } from './registry.js';

type Sent = State['inRaw'];

/** One check. Each runs on its own, so a test runner can list them, as in `for (const c of checks) it(c.name, c.run)`. */
export type ContractCheck = { name: string; run: () => Promise<void> };

/** How the random runs go. Pass the `seed` and `path` a failure printed to run that case again. */
export type PropertySettings = { runs?: number; steps?: number; seed?: number; path?: string };

/** What a random run needs from the contract checks: calls through the registry and the fixtures' good inputs. */
export type Walker = {
  contract: Contract;
  serves: (command: string) => boolean;
  once: (command: string, input: Sent) => Promise<{ result: CallResult; events: Array<ContractEvent> }>;
  goodInput: (command: string, state?: string) => Promise<Sent>;
  send: (cmd: CommandSpec, input: Sent) => Sent;
  expectEmits: (label: string, cmd: CommandSpec, events: ReadonlyArray<ContractEvent>) => void;
};

export const shown = (r: CallResult) => (r.ok ? `ok ${JSON.stringify(r.value)}` : `${r.status} ${r.code}: ${r.message}${r.issues ? ` ${JSON.stringify(r.issues)}` : ''}`);

export function expectOk(label: string, r: CallResult): asserts r is Extract<CallResult, { ok: true }> {
  if (!r.ok) {throw new Error(`${label}: expected success, got ${shown(r)}. Check the handler, or the arrange fixture's input.`);}
}

export function expectCode(label: string, r: CallResult, code: string, hint: string): void {
  if (r.ok || r.code !== code) {throw new Error(`${label}: expected ${code}, got ${shown(r)}. ${hint}`);}
}

export function stateOf(contract: Contract, result: Extract<CallResult, { ok: true }>): string {
  const field = contract.states?.field ?? '';
  const value = result.value;

  return isRecord(value) ? String(value[field]) : '';
}

function expectQuiet(label: string, events: ReadonlyArray<ContractEvent>, what: string): void {
  if (events.length) {throw new Error(`${label}: published ${events.length} event(s) for ${what}`);}
}

type Done = { command: string; input: Sent; result: CallResult };

type Model = { states: Array<string>; done: Array<Done> };

type Real = { records: ReadonlyArray<Sent> };

type Step = AsyncCommand<Model, Real>;

const RECORDS = 3;

class MoveStep implements Step {
  constructor(
    readonly w: Walker,
    readonly command: string,
    readonly record: number,
  ) {}

  check(): boolean {
    return true;
  }

  async run(m: Model, r: Real): Promise<void> {
    const { contract } = this.w;
    const cmd = contract.commands[this.command];
    const move = cmd?.move === undefined ? undefined : contract.states?.moves[cmd.move];
    const at = this.record;
    const from = m.states[at];
    const record = r.records[at];

    if (!cmd || !move || from === undefined || record === undefined) {throw new Error(`${contract.name}.${this.command}: the run lost its record`);}

    const label = `${contract.name}.${this.command} on record #${at} in ${from}`;
    const input = this.w.send(cmd, record);
    const { result, events } = await this.w.once(this.command, input);

    if (!result.ok && result.code === 'INVALID_INPUT') {
      throw new Error(`${label}: refused the input arrange gave for another move on the same record. The random runs send one record's input to each move command, so they need to take the same input.`);
    }

    if (!move.from.includes(from)) {
      expectCode(label, result, 'MOVE_NOT_ALLOWED', `The contract doesn't list ${cmd.move} from ${from}, so the record has to stay where it is.`);
      expectQuiet(label, events, 'a refused move');

      return;
    }

    expectOk(label, result);

    const after = stateOf(contract, result);

    if (after !== move.to) {throw new Error(`${label}: output says ${contract.states?.field} is ${after}, the contract says ${move.to}. Return the moved record.`);}

    this.w.expectEmits(label, cmd, events);
    m.states[at] = move.to;
    m.done.push({ command: this.command, input, result });
  }

  toString(): string {
    return `${this.command} #${this.record}`;
  }
}

class WriteStep implements Step {
  constructor(
    readonly w: Walker,
    readonly command: string,
  ) {}

  check(): boolean {
    return true;
  }

  async run(m: Model): Promise<void> {
    const cmd = this.w.contract.commands[this.command];

    if (!cmd) {return;}

    const input = this.w.send(cmd, await this.w.goodInput(this.command));
    const { result } = await this.w.once(this.command, input);

    // Decision: a failed write is left alone here. The good-input check already fails it, and these runs only need its success to repeat.
    if (result.ok) {m.done.push({ command: this.command, input, result });}
  }

  toString(): string {
    return this.command;
  }
}

class RetryStep implements Step {
  constructor(
    readonly w: Walker,
    readonly pick: number,
  ) {}

  check(m: Readonly<Model>): boolean {
    return m.done.length > 0;
  }

  async run(m: Model): Promise<void> {
    const first = m.done[this.pick % m.done.length];

    if (!first) {return;}

    const label = `${this.w.contract.name}.${first.command} sent again with its requestId`;
    const { result, events } = await this.w.once(first.command, first.input);

    if (JSON.stringify(result) !== JSON.stringify(first.result)) {
      throw new Error(`${label}: got ${shown(result)}, not the first answer ${shown(first.result)}. Keep each requestId's result with runOnce for as long as requestIds.keepHours says.`);
    }

    expectQuiet(label, events, 'a repeated requestId');
  }

  toString(): string {
    return `again #${this.pick}`;
  }
}

function stepsFor(w: Walker, most: number): Array<Arbitrary<Step>> {
  const writes = Object.entries(w.contract.commands).filter(([name, cmd]) => cmd.effect !== 'read' && w.serves(name));
  const moves = w.contract.states ? writes.filter(([, cmd]) => cmd.move !== undefined) : [];

  if (!writes.length) {return [];}

  return [
    ...moves.map(([name]) => nat({ max: RECORDS - 1 }).map((at): Step => new MoveStep(w, name, at))),
    ...writes.filter(([, cmd]) => cmd.move === undefined).map(([name]): Arbitrary<Step> => constant(new WriteStep(w, name))),
    nat({ max: most - 1 }).map((pick): Step => new RetryStep(w, pick)),
  ];
}

function failure(details: RunDetails<[Array<string>, Iterable<Step>]>): Error {
  const cause = details.errorInstance instanceof Error ? details.errorInstance.message : String(details.errorInstance);
  const [starts, steps] = details.counterexample ?? [];
  const shownSteps = String(steps).replace(/\s*\/\*replayPath=.*?\*\//, '');
  const replay = `{ seed: ${details.seed}, path: '${details.counterexamplePath ?? ''}' }`;

  return new Error(
    `${cause}\n` +
      `Records started in: ${stringify(starts)}. Steps: ${shownSteps}.\n` +
      `Run this case again with properties: ${replay} in contractChecks' fixtures, and keep it in the test once it's fixed.`,
  );
}

/**
 * Random runs of commands, made from the contract. Each run starts a few records in random states, then sends a random string of moves,
 * other writes and repeats of earlier requests. A listed move has to land in its state, an unlisted one has to be refused and leave the
 * record where it was, and a repeated requestId has to give the first answer and publish nothing. A failure shrinks to the fewest steps
 * and prints the seed that runs it again.
 */
export function walkChecks(w: Walker, settings: PropertySettings = {}): Array<ContractCheck> {
  const most = settings.steps ?? 20;
  const steps = stepsFor(w, most);
  const states = w.contract.states;

  if (!steps.length) {return [];}

  const home = Object.entries(w.contract.commands).find(([name, cmd]) => states && cmd.move !== undefined && w.serves(name))?.[0];

  const name = home
    ? `${w.contract.name} stays inside its moves and answers a repeated requestId the same, over random runs of commands`
    : `${w.contract.name} answers a repeated requestId the same, over random runs of commands`;

  const property = asyncProperty(
    array(constantFrom(...(states?.list ?? ['none'])), { minLength: RECORDS, maxLength: RECORDS }),
    commands(steps, { maxCommands: most }),
    async (starts, run) => {
      const records = home ? await Promise.all(starts.map(async (state) => w.goodInput(home, state))) : [];

      await asyncModelRun(() => ({ model: { states: [...starts], done: [] }, real: { records } }), run);
    },
  );

  const parameters: Parameters<[Array<string>, Iterable<Step>]> = { numRuns: settings.runs ?? 100, endOnFailure: true };

  if (settings.seed !== undefined) {parameters.seed = settings.seed;}

  if (settings.path !== undefined) {parameters.path = settings.path;}

  return [
    {
      name,
      run: async () => {
        const details = await checkProperty(property, parameters);

        if (details.failed) {throw failure(details);}
      },
    },
  ];
}
