import type { CommandSpec, Contract, EventSpec } from './contract.js';
import { MOVE_NOT_ALLOWED, isReason, kebab, topicsOf } from './contract.js';
import { fieldsOf, schemaAt, schemasAt, typeOf, wordsAt } from './json-schema.js';
import type { JsonSchema } from './schema.js';

function typeText(json: JsonSchema | null, nested = false): string {
  if (!json) {return 'anything';}

  const values = wordsAt(json, 'enum');

  if (values.length) {return values.join(' | ');}

  if (Object.hasOwn(json, 'const')) {return JSON.stringify(json.const);}

  const options = [...schemasAt(json, 'anyOf'), ...schemasAt(json, 'oneOf')];

  if (options.length) {return options.map((o) => typeText(o, nested)).join(' or ');}

  const type = typeOf(json) ?? 'anything';

  if (type === 'array') {return `list of ${typeText(schemaAt(json, 'items'), nested)}`;}

  if (type === 'object' && !nested) {return `{ ${fieldsText(json, true) || '...'} }`;}

  return json.format === undefined ? type : `${type} (${String(json.format)})`;
}

function fieldLines(json: JsonSchema | null, nested = false): Array<string> {
  const required = new Set(wordsAt(json, 'required'));

  return [...(fieldsOf(json) ?? [])].map(([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${typeText(value, nested)}`);
}

function fieldsText(json: JsonSchema | null, nested = false): string {
  return fieldLines(json, nested).join('; ');
}

function recordName(contract: Contract, json: JsonSchema | null): string | null {
  const text = JSON.stringify(json);
  const found = Object.entries(contract.json.data).find(([, record]) => JSON.stringify(record) === text);

  return found ? found[0] : null;
}

function valueText(contract: Contract, json: JsonSchema | null): string {
  const record = recordName(contract, json);

  if (record) {return record;}

  const itemRecord = typeOf(json) === 'array' ? recordName(contract, schemaAt(json, 'items')) : null;

  return itemRecord ? `list of ${itemRecord}` : typeText(json);
}

function inputText(contract: Contract, name: string, cmd: CommandSpec): string {
  const json = contract.json.commands[name]?.input ?? null;
  const own = cmd.input ? fieldsText(json) || typeText(json) : '';
  const parts = cmd.effect === 'read' ? [own] : [own, 'requestId: string'];

  return parts.filter(Boolean).join('; ') || 'none';
}

function failsText(cmd: CommandSpec): string {
  const errors = Object.entries(cmd.errors).map(([code, spec]) => `${code} (${spec.status}) ${spec.message}`);

  if (cmd.move !== undefined) {errors.push(`MOVE_NOT_ALLOWED (${MOVE_NOT_ALLOWED.status}) when the current state isn't one it moves from`);}

  return errors.length ? errors.join('; ') : 'only with the pipeline\'s own errors';
}

function toolText(cmd: CommandSpec): string {
  if ('reason' in cmd.tool) {return `no (${cmd.tool.reason})`;}

  return cmd.tool.needsApproval ? 'yes, a person approves each call' : 'yes';
}

function exampleText(cmd: CommandSpec): string | null {
  if (cmd.example === undefined) {return null;}

  return JSON.stringify(cmd.effect === 'read' ? cmd.example : { ...Object(cmd.example), requestId: 'r-1' });
}

function commandText(contract: Contract, name: string, cmd: CommandSpec): string {
  const move = cmd.move === undefined ? undefined : contract.states?.moves[cmd.move];
  const example = exampleText(cmd);

  const lines = [
    `${contract.name}.${name} (${cmd.effect})`,
    `  ${cmd.description}`,
    `  Needs: ${isReason(cmd.capability) ? `no capability (${cmd.capability.reason})` : cmd.capability}`,
    `  Input: ${inputText(contract, name, cmd)}`,
    `  Output: ${valueText(contract, contract.json.commands[name]?.output ?? null)}`,
    move ? `  Moves: ${cmd.move}, ${move.from.join(' or ')} -> ${move.to}` : '',
    `  Fails: ${failsText(cmd)}`,
    cmd.emits?.length ? `  Emits: ${cmd.emits.join(', ')}` : '',
    `  Bot tool: ${toolText(cmd)}`,
    `  Command line: ${cmd.cli === true ? `${kebab(contract.name)} ${kebab(name)}` : `no (${cmd.cli.reason})`}`,
    example ? `  Example: ${example}` : '',
  ];

  return lines.filter(Boolean).join('\n');
}

function eventText(contract: Contract, name: string, ev: EventSpec): string {
  return [`${contract.name}.${name} on ${topicsOf(ev).join(' and ')}`, `  ${ev.description}`, `  Payload: ${valueText(contract, contract.json.events[name] ?? null)}`].join('\n');
}

function statesText(contract: Contract): Array<string> {
  const states = contract.states;

  if (!states) {return [];}

  return [
    '## States',
    '',
    `${states.record}.${states.field} is one of ${states.list.join(', ')}, and starts at ${states.initial}.`,
    ...Object.entries(states.moves).map(([name, move]) => `  ${name}: ${move.from.join(' or ')} -> ${move.to}`),
    `A move that isn't listed is refused with MOVE_NOT_ALLOWED (${MOVE_NOT_ALLOWED.status}).`,
    '',
  ];
}

function retriesText(contract: Contract): Array<string> {
  const hours = contract.requestIds?.keepHours;

  if (hours === undefined) {return [];}

  const kept = hours === 1 ? '1 hour' : `${hours} hours`;

  return [
    '## Retries',
    '',
    `A write command takes a requestId. The module keeps each id with the first call's result for ${kept}, for each caller, next to its own state.`,
    'A call with an id it still keeps, at the same time or later, gets the first result and publishes no event. A call that failed keeps nothing, so a retry runs again.',
    '',
  ];
}

/** One short plain-text page for a module, from its contract: records, states, commands and events. It reads well for a model. */
export function contractDocs(contract: Contract): string {
  const records = Object.keys(contract.data).flatMap((name) => [name, ...fieldLines(contract.json.data[name] ?? null).map((f) => `  ${f}`)]);
  const commands = Object.entries(contract.commands).map(([name, cmd]) => commandText(contract, name, cmd));
  const events = Object.entries(contract.events).map(([name, ev]) => eventText(contract, name, ev));

  return [
    `# ${contract.name}`,
    '',
    contract.description,
    '',
    '## Records',
    '',
    ...records,
    '',
    ...statesText(contract),
    '## Commands',
    '',
    commands.join('\n\n'),
    '',
    '## Events',
    '',
    ...(events.length ? ['Each event also says who ran the command (`actor`, when the sign-in names them) and what acted for them (`via`, when the sign-in names one). Both go to everyone who reads the topic.', ''] : []),
    events.join('\n\n') || 'None.',
    '',
    ...retriesText(contract),
  ].join('\n');
}
