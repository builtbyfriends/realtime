import type { ContractEvent } from './contract-module.js';
import type { ErrorSpec } from './errors.js';
import { toJsonSchema } from './schema.js';
import type { AnySchema, InferIn, InferOut, JsonSchema } from './schema.js';
import { fieldsOf, isRecord, typeOf, wordsAt } from './json-schema.js';

/** An opt-out with the reason it was left out. The registry checks the reason when it loads. */
export type Reason = { reason: string };

/** What a command does to the module: read changes nothing, write and destructive change it and take a `requestId`. */
export type Effect = 'read' | 'write' | 'destructive';

export type CommandSpec = {
  /** One sentence for people and models. It is the MCP, AI tool and CLI description. */
  description: string;
  effect: Effect;
  /** Leave out for a command that takes nothing. A write still takes its `requestId`. */
  input?: AnySchema;
  output: AnySchema;
  /** The listed ways this command fails. `{}` means none beyond the pipeline's own. */
  errors: Readonly<Record<string, ErrorSpec>>;
  /** The right a caller needs, as a searchable name such as "tasks.write". */
  capability: string | Reason;
  /** Whether a bot can call it as a tool (MCP and AI tools), and whether a person approves each call. */
  tool: { needsApproval: boolean } | Reason;
  /** Whether it's a command line entry. The command is the module name and the command name in kebab case. */
  cli: true | Reason;
  /** The listed state move this command makes. Its output carries the record's state field. */
  move?: string;
  /** Events this command publishes each time it succeeds. */
  emits?: ReadonlyArray<string>;
  /** A good input for the docs, without the `requestId`. The contract checks prove it's accepted. */
  example?: unknown;
};

export type EventSpec = {
  description: string;
  /**
   * A named topic, or a list of them. `{field}` is filled from the payload, as in "tasks:{id}".
   * With a list, the event is published once on each topic, such as its record's own topic and its parent's.
   */
  topic: string | ReadonlyArray<string>;
  payload: AnySchema;
};

export type MoveSpec = { readonly from: ReadonlyArray<string>; readonly to: string };

export type StatesSpec = {
  /** The record in `data` that holds the state, and its field. */
  record: string;
  field: string;
  list: ReadonlyArray<string>;
  initial: string;
  /** The allowed moves. A move that isn't listed is refused with MOVE_NOT_ALLOWED. */
  moves: Readonly<Record<string, MoveSpec>>;
};

export type ContractSpec = {
  /** One lowercase word or camelCase name. Commands are called `<name>.<command>`. */
  name: string;
  description: string;
  data: Readonly<Record<string, AnySchema>>;
  commands: Readonly<Record<string, CommandSpec>>;
  events: Readonly<Record<string, EventSpec>>;
  states?: StatesSpec;
  /** How long the module keeps a write's `requestId` with its first result. Required when a command writes. */
  requestIds?: { keepHours: number };
};

export type Contract<C extends ContractSpec = ContractSpec> = C & {
  readonly '~realtime': 'contract';
  /** JSON Schema for each record, command and event, worked out once when the contract is defined. */
  readonly json: ContractJson;
};

export type ContractJson = {
  data: Readonly<Record<string, JsonSchema | null>>;
  commands: Readonly<Record<string, { input: JsonSchema | null; output: JsonSchema | null }>>;
  events: Readonly<Record<string, JsonSchema | null>>;
};

export const MOVE_NOT_ALLOWED = { status: 409, message: 'This move is not allowed from the current state' } as const;

type Cmds<C extends ContractSpec> = C['commands'];

type Cmd<C extends ContractSpec, K extends keyof Cmds<C>> = Cmds<C>[K];

export type CommandName<C extends ContractSpec> = keyof Cmds<C> & string;

export type EventName<C extends ContractSpec> = keyof C['events'] & string;

/** A record's type, from its schema in `data`. */
export type RecordOf<C extends ContractSpec, K extends keyof C['data']> = InferOut<C['data'][K]>;

/** The state names, or never when the contract has no states. */
export type StateOf<C extends ContractSpec> = C['states'] extends StatesSpec ? C['states']['list'][number] : never;

/** The input a handler sees, after the schema parsed it. */
export type ParsedInput<C extends ContractSpec, K extends keyof Cmds<C>> =
  Cmd<C, K> extends { input: infer I extends AnySchema } ? InferOut<I> : undefined;

/** The input a test or a fixture gives, without the `requestId`. */
export type GoodInput<C extends ContractSpec, K extends keyof Cmds<C>> =
  Cmd<C, K> extends { input: infer I extends AnySchema } ? InferIn<I> : undefined;

/** What a caller sends. A write carries a `requestId` so that a retry runs once. */
export type CommandInput<C extends ContractSpec, K extends keyof Cmds<C>> =
  Cmd<C, K> extends { effect: 'read' }
    ? Cmd<C, K> extends { input: infer I extends AnySchema }
      ? InferIn<I>
      : void
    : (Cmd<C, K> extends { input: infer I extends AnySchema } ? InferIn<I> : unknown) & { requestId: string };

export type CommandOutput<C extends ContractSpec, K extends keyof Cmds<C>> = InferOut<Cmd<C, K>['output']>;

/** What a handler returns, before the output schema parses it. */
export type HandlerOutput<C extends ContractSpec, K extends keyof Cmds<C>> = InferIn<Cmd<C, K>['output']>;

export type MoveOf<C extends ContractSpec, K extends keyof Cmds<C>> = Cmd<C, K> extends { move: infer M extends string } ? M : never;

/** The listed failures of a command, plus MOVE_NOT_ALLOWED when it moves state. */
export type CommandError<C extends ContractSpec, K extends keyof Cmds<C>> =
  | (keyof Cmd<C, K>['errors'] & string)
  | ([MoveOf<C, K>] extends [never] ? never : 'MOVE_NOT_ALLOWED');

export type EmitsOf<C extends ContractSpec, K extends keyof Cmds<C>> =
  Cmd<C, K> extends { emits: ReadonlyArray<infer E extends string> } ? E : never;

export type EventPayload<C extends ContractSpec, E extends keyof C['events']> = InferOut<C['events'][E]['payload']>;

type TopicFields<T extends string> = T extends `${string}{${infer F}}${infer Rest}` ? F | TopicFields<Rest> : never;

type Problem<M extends string> = { '~error': M };

type TopicText<T> = T extends ReadonlyArray<infer S extends string> ? S : T extends string ? T : never;

type CheckTopic<Ev> = Ev extends { topic: infer T; payload: infer P extends AnySchema }
  ? [Exclude<TopicFields<TopicText<T>>, keyof InferOut<P> & string>] extends [never]
    ? unknown
    : { topic: Problem<`topic field {${Exclude<TopicFields<TopicText<T>>, keyof InferOut<P> & string>}} is not a field of the payload`> }
  : unknown;

type MoveNames<C extends ContractSpec> = C['states'] extends StatesSpec ? keyof C['states']['moves'] & string : never;

type CheckMove<C extends ContractSpec, Cm> = Cm extends { move: infer M extends string }
  ? M extends MoveNames<C>
    ? unknown
    : { move: Problem<`move "${M}" is not in states.moves`> }
  : unknown;

type CheckEmits<C extends ContractSpec, Cm> = Cm extends { emits: ReadonlyArray<infer E extends string> }
  ? [Exclude<E, keyof C['events'] & string>] extends [never]
    ? unknown
    : { emits: Problem<`emits lists "${Exclude<E, keyof C['events'] & string>}", which is not in events`> }
  : unknown;

type CheckExample<Cm> = Cm extends { example: infer X; input: infer I extends AnySchema }
  ? [X] extends [InferIn<I>]
    ? unknown
    : { example: Problem<'example does not match the input schema'> }
  : unknown;

type CheckRefs<C extends ContractSpec> = {
  commands: { [K in keyof Cmds<C>]: CheckMove<C, Cmd<C, K>> & CheckEmits<C, Cmd<C, K>> & CheckExample<Cmd<C, K>> };
  events: { [E in keyof C['events']]: CheckTopic<C['events'][E]> };
};

const NAME_RE = /^[a-z][a-zA-Z0-9]*$/;
const KEY_RE = /^[a-z][a-zA-Z0-9]*$/;
const RECORD_RE = /^[A-Z][a-zA-Z0-9]*$/;
const TOPIC_FIELD_RE = /\{([^{}]+)\}/g;
const EFFECTS = new Set<string>(['read', 'write', 'destructive']);

export function topicFields(topic: string): Array<string> {
  return [...topic.matchAll(TOPIC_FIELD_RE)].map((m) => m[1] ?? '');
}

/** The event's topics as a list, whether the contract gives one or several. */
export function topicsOf(ev: EventSpec): Array<string> {
  return [ev.topic].flat();
}

/** A topic with each `{field}` filled from the payload. */
export function fillTopic(topic: string, payload: ContractEvent['payload']): string {
  const fields = isRecord(payload) ? payload : {};

  return topicFields(topic).reduce((t, field) => t.replace(`{${field}}`, String(fields[field])), topic);
}

export function isReason(value: string | Reason): value is Reason {
  return isRecord(value);
}

export function kebab(name: string): string {
  return name.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function jsonOrNull(schema: AnySchema | undefined, io: 'input' | 'output', where: string, problems: Array<string>): JsonSchema | null {
  if (!schema) {return null;}

  try {
    return toJsonSchema(schema, io);
  } catch (error) {
    problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);

    return null;
  }
}

const listText = (items: Iterable<string>) => [...items].join(', ') || 'none';

function checkMoves(states: StatesSpec, problems: Array<string>): void {
  const listed = new Set(states.list);
  const notListed = `which is not in states.list (${listText(states.list)})`;

  if (!listed.has(states.initial)) {problems.push(`states.initial "${states.initial}" is not in states.list (${listText(states.list)})`);}

  for (const [name, move] of Object.entries(states.moves)) {
    const where = `states.moves.${name}`;

    if (!KEY_RE.test(name)) {problems.push(`${where}: name a move with a camelCase verb, such as "start"`);}

    if (!move.from.length) {problems.push(`${where}.from is empty: list the states this move starts from`);}

    for (const from of move.from.filter((f) => !listed.has(f))) {problems.push(`${where}.from lists "${from}", ${notListed}`);}

    if (!listed.has(move.to)) {problems.push(`${where}.to is "${move.to}", ${notListed}`);}
  }
}

function checkStateField(spec: ContractSpec, states: StatesSpec, data: ContractJson['data'], problems: Array<string>): void {
  if (!Object.hasOwn(spec.data, states.record)) {
    problems.push(`states.record "${states.record}" is not a record in data (${listText(Object.keys(spec.data))})`);

    return;
  }

  const field = fieldsOf(data[states.record])?.get(states.field);

  if (!field) {
    problems.push(`states.field "${states.field}" is not a field of ${states.record}: add it to the ${states.record} schema`);

    return;
  }

  const values = new Set(wordsAt(field, 'enum'));
  const same = values.size === states.list.length && states.list.every((s) => values.has(s));

  if (!same) {
    problems.push(`${states.record}.${states.field} has to be an enum of exactly states.list (${listText(states.list)}), such as z.enum(states)`);
  }
}

function checkCommandBasics(spec: ContractSpec, where: string, name: string, cmd: CommandSpec, problems: Array<string>): void {
  if (!KEY_RE.test(name)) {problems.push(`${where}: name a command with a camelCase verb, such as "create"`);}

  if (!cmd.description.trim()) {problems.push(`${where}.description is empty: say what it does in one sentence`);}

  if (!EFFECTS.has(cmd.effect)) {problems.push(`${where}.effect has to be read, write or destructive`);}

  if (Object.hasOwn(cmd.errors, 'MOVE_NOT_ALLOWED')) {problems.push(`${where}.errors lists MOVE_NOT_ALLOWED: leave it out, a command with a move gets it`);}

  for (const e of (cmd.emits ?? []).filter((x) => !Object.hasOwn(spec.events, x))) {
    problems.push(`${where}.emits lists "${e}", which is not in events (${listText(Object.keys(spec.events))})`);
  }
}

function checkCommandInput(spec: ContractSpec, where: string, cmd: CommandSpec, input: JsonSchema | null, problems: Array<string>): void {
  if (cmd.effect === 'read') {return;}

  if (!spec.requestIds) {problems.push(`${where} writes, so the contract needs requestIds: { keepHours } to say how long a retry is recognised`);}

  if (input && typeOf(input) !== 'object') {problems.push(`${where}.input has to be an object schema, because a write adds requestId to it`);}

  if (fieldsOf(input)?.has('requestId')) {problems.push(`${where}.input has its own requestId field: remove it, the contract adds it to writes`);}
}

function checkCommandMove(spec: ContractSpec, where: string, move: string, output: JsonSchema | null, problems: Array<string>): void {
  const states = spec.states;

  if (!states) {
    problems.push(`${where}.move "${move}" needs states in the contract`);

    return;
  }

  if (!Object.hasOwn(states.moves, move)) {problems.push(`${where}.move "${move}" is not in states.moves (${listText(Object.keys(states.moves))})`);}

  if (!fieldsOf(output)?.has(states.field)) {
    problems.push(`${where} moves state, so its output has to carry the "${states.field}" field: return the ${states.record}`);
  }
}

function checkEvent(name: string, ev: EventSpec, json: JsonSchema | null, problems: Array<string>): void {
  const where = `events.${name}`;
  const fields = fieldsOf(json);

  if (!KEY_RE.test(name)) {problems.push(`${where}: name an event with a camelCase past tense, such as "created"`);}

  if (!ev.description.trim()) {problems.push(`${where}.description is empty: say what happened in one sentence`);}

  const topics = topicsOf(ev);

  if (!topics.length) {problems.push(`${where}.topic is an empty list: name at least one topic`);}

  if (new Set(topics).size !== topics.length) {problems.push(`${where}.topic lists a topic twice: each is published once, so list it once`);}

  topics.forEach((topic, i) => {
    const at = Array.isArray(ev.topic) ? `${where}.topic[${i}]` : `${where}.topic`;

    for (const field of topicFields(topic).filter((f) => fields && !fields.has(f))) {
      problems.push(`${at} uses {${field}}, which is not a payload field (${listText(fields?.keys() ?? [])})`);
    }
  });
}

function commandsJson(spec: ContractSpec, problems: Array<string>): ContractJson['commands'] {
  const commands: Record<string, { input: JsonSchema | null; output: JsonSchema | null }> = {};

  for (const [name, cmd] of Object.entries(spec.commands)) {
    const where = `commands.${name}`;
    const json = { input: jsonOrNull(cmd.input, 'input', `${where}.input`, problems), output: jsonOrNull(cmd.output, 'output', `${where}.output`, problems) };

    commands[name] = json;
    checkCommandBasics(spec, where, name, cmd, problems);
    checkCommandInput(spec, where, cmd, json.input, problems);

    if (cmd.move !== undefined) {checkCommandMove(spec, where, cmd.move, json.output, problems);}
  }

  return commands;
}

/**
 * Checks a module's contract and works out its JSON Schema. Throws one error that lists each problem and what to change, so call it at
 * module scope: a broken contract then fails the deploy.
 */
export function defineContract<const C extends ContractSpec>(spec: C & CheckRefs<C>): Contract<C> {
  const problems: Array<string> = [];

  if (!NAME_RE.test(spec.name)) {problems.push(`name "${spec.name}" has to be one lowercase word or camelCase, such as "tasks"`);}

  if (!spec.description.trim()) {problems.push('description is empty: say what the module is in one sentence');}

  const data: Record<string, JsonSchema | null> = {};

  for (const [name, schema] of Object.entries(spec.data)) {
    if (!RECORD_RE.test(name)) {problems.push(`data.${name}: name a record in PascalCase, such as "Task"`);}

    data[name] = jsonOrNull(schema, 'output', `data.${name}`, problems);
  }

  const commands = commandsJson(spec, problems);
  const events: Record<string, JsonSchema | null> = {};

  for (const [name, ev] of Object.entries(spec.events)) {
    events[name] = jsonOrNull(ev.payload, 'output', `events.${name}.payload`, problems);
    checkEvent(name, ev, events[name], problems);
  }

  if (spec.states) {
    checkMoves(spec.states, problems);
    checkStateField(spec, spec.states, data, problems);
  }

  if (spec.requestIds && !(spec.requestIds.keepHours > 0)) {problems.push('requestIds.keepHours has to be more than 0');}

  if (problems.length) {
    throw new Error(`contract "${spec.name}" has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }

  return Object.freeze({ ...spec, '~realtime': 'contract' as const, json: { data, commands, events } });
}
