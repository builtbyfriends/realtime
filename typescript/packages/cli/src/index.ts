import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

type Io = {
  argv: Array<string>;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

type Prop = { type?: string | Array<string>; description?: string; enum?: Array<unknown>; items?: Prop; anyOf?: Array<Prop> };
type Shape = { properties: Map<string, Prop>; required: Array<string> };
type CliProcedure = {
  path: string;
  command: string;
  description: string;
  input: Shape | null;
  errors: Array<{ code: string; status: number; message: string }>;
};
type JsonValue = string | number | boolean | null | Array<JsonValue> | { [key: string]: JsonValue };
type InputObject = { [key: string]: JsonValue };
type Failure = { code: string; message: string; issues?: Array<{ path: string; message: string }> };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {return true;}
  if (Array.isArray(value)) {return value.every((item: unknown) => isJsonValue(item));}
  if (typeof value === 'object') {return Object.values(value).every((item: unknown) => isJsonValue(item));}
  return false;
}

function isJsonObject(value: JsonValue): value is InputObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, message: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(message);
  }
  if (!isJsonValue(parsed)) {throw new UsageError(message);}
  return parsed;
}

function toProp(value: unknown): Prop {
  const prop: Prop = {};
  if (typeof value !== 'object' || value === null) {return prop;}
  if ('type' in value) {
    if (typeof value.type === 'string') {prop.type = value.type;}
    else if (Array.isArray(value.type)) {prop.type = value.type.filter((t: unknown): t is string => typeof t === 'string');}
  }
  if ('description' in value && typeof value.description === 'string') {prop.description = value.description;}
  if ('enum' in value && Array.isArray(value.enum)) {prop.enum = value.enum;}
  if ('items' in value) {prop.items = toProp(value.items);}
  if ('anyOf' in value && Array.isArray(value.anyOf)) {prop.anyOf = value.anyOf.map((item: unknown) => toProp(item));}
  return prop;
}

function toShape(input: unknown): Shape | null {
  if (typeof input !== 'object' || input === null) {return null;}
  const shape: Shape = { properties: new Map(), required: [] };
  if ('properties' in input && typeof input.properties === 'object' && input.properties !== null) {
    for (const entry of Object.entries(input.properties)) {
      const value: unknown = entry[1];
      shape.properties.set(entry[0], toProp(value));
    }
  }
  if ('required' in input && Array.isArray(input.required)) {
    for (const key of input.required as Array<unknown>) {
      if (typeof key === 'string') {shape.required.push(key);}
    }
  }
  return shape;
}

function toErrors(raw: unknown): CliProcedure['errors'] {
  const errors: CliProcedure['errors'] = [];
  if (typeof raw !== 'object' || raw === null) {return errors;}
  for (const entry of Object.entries(raw)) {
    const spec: unknown = entry[1];
    if (typeof spec === 'object' && spec !== null && 'status' in spec && 'message' in spec && typeof spec.status === 'number' && typeof spec.message === 'string') {
      errors.push({ code: entry[0], status: spec.status, message: spec.message });
    }
  }
  return errors;
}

function toProcedure(raw: unknown): Array<CliProcedure> {
  if (typeof raw !== 'object' || raw === null || !('path' in raw) || !('cli' in raw) || typeof raw.path !== 'string') {return [];}
  const cli = raw.cli;
  if (typeof cli !== 'object' || cli === null || !('command' in cli) || !('description' in cli)) {return [];}
  if (typeof cli.command !== 'string' || typeof cli.description !== 'string') {return [];}
  const input: unknown = 'input' in raw ? raw.input : undefined;
  const errors: unknown = 'errors' in raw ? raw.errors : undefined;
  return [{ path: raw.path, command: cli.command, description: cli.description, input: toShape(input), errors: toErrors(errors) }];
}

function toManifest(body: unknown): Array<CliProcedure> {
  if (typeof body !== 'object' || body === null || !('procedures' in body) || !Array.isArray(body.procedures)) {throw new Error('not a manifest');}
  return body.procedures.flatMap((raw: unknown) => toProcedure(raw));
}

function isIssues(value: unknown): value is NonNullable<Failure['issues']> {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'object' && item !== null && 'path' in item && typeof item.path === 'string' && 'message' in item && typeof item.message === 'string')
  );
}

function toFailure(body: unknown): Failure | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) {return undefined;}
  const raw = body.error;
  if (typeof raw !== 'object' || raw === null || !('code' in raw) || !('message' in raw)) {return undefined;}
  if (typeof raw.code !== 'string' || typeof raw.message !== 'string') {return undefined;}
  const failure: Failure = { code: raw.code, message: raw.message };
  if ('issues' in raw && isIssues(raw.issues)) {failure.issues = raw.issues;}
  return failure;
}

const kebab = (s: string) => s.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-').toLowerCase();

function typeOf(p: Prop): string {
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
  if (t) {return t;}
  if (p.enum?.every((v) => typeof v === 'string')) {return 'string';}
  if (p.anyOf) {
    const types = p.anyOf.map(typeOf).filter((x) => x !== 'null');
    const [only] = types;
    if (types.length === 1 && only !== undefined) {return only;}
  }
  return 'json';
}

class UsageError extends Error {}

const ownFlags = new Set(['url', 'token', 'help']);

const globalOptions: ParseArgsOptionsConfig = {
  url: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function optionsFor(entry: CliProcedure): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = { ...globalOptions };
  for (const [k, p] of entry.input?.properties ?? []) {
    options[kebab(k)] = { type: typeOf(p) === 'boolean' ? 'boolean' : 'string' };
  }
  return options;
}

// Decision: a flag parseArgs doesn't know takes the next word as its value, and so does a true/false
// flag when that word is `true` or `false`, so `--org o1` reaches the unknown-flag message and
// `--exact false` still works.
function splitArgs(argv: Array<string>, options: ParseArgsOptionsConfig) {
  const { tokens } = parseArgs({ args: argv, options, strict: false, allowPositionals: true, tokens: true });
  const words: Array<string> = [];
  const flags: Array<[string, string | true]> = [];
  let open: { index: number; name: string } | undefined;
  for (const t of tokens) {
    if (t.kind === 'option') {
      flags.push([t.name, t.value ?? true]);
      open = t.value === undefined ? { index: t.index, name: t.name } : undefined;
      continue;
    }
    const type = open && options[open.name]?.type;
    const last = flags.at(-1);
    if (t.kind === 'positional' && last && open?.index === t.index - 1 && (!type || (type === 'boolean' && /^(true|false)$/.test(t.value)))) {
      last[1] = t.value;
    } else if (t.kind === 'positional') {words.push(t.value);}
    open = undefined;
  }
  return { words, flags };
}

function coerce(name: string, prop: Prop, raw: string | true): JsonValue {
  const t = typeOf(prop);
  if (t === 'boolean') {
    if (raw === true || raw === 'true') {return true;}
    if (raw === 'false') {return false;}
    throw new UsageError(`--${name} takes true or false`);
  }
  if (raw === true) {throw new UsageError(`--${name} needs a value`);}
  if (t === 'number' || t === 'integer') {
    const n = Number(raw);
    if (!Number.isFinite(n) || (t === 'integer' && !Number.isInteger(n))) {throw new UsageError(`--${name} must be ${t === 'integer' ? 'an integer' : 'a number'}`);}
    return n;
  }
  if (t === 'string') {
    if (prop.enum && !prop.enum.includes(raw)) {throw new UsageError(`--${name} must be one of: ${prop.enum.join(', ')}`);}
    return raw;
  }
  if (t === 'array' && !raw.trim().startsWith('[')) {return [coerce(name, prop.items ?? {}, raw)];}
  return parseJson(raw, `--${name} must be JSON`);
}

function inputFromFlags(entry: CliProcedure, flags: Array<[string, string | true]>): InputObject | undefined {
  const props = entry.input?.properties ?? new Map<string, Prop>();
  const byFlag = new Map([...props.keys()].map((k) => [kebab(k), k]));
  const input: InputObject = {};
  for (const [flag, raw] of flags) {
    if (flag === 'json') {
      if (raw === true) {throw new UsageError('--json needs a value');}
      const parsed = parseJson(raw, '--json must be a JSON object');
      if (!isJsonObject(parsed)) {throw new UsageError('--json must be a JSON object');}
      Object.assign(input, parsed);
      continue;
    }
    const negated = !byFlag.has(flag) && flag.startsWith('no-') && byFlag.has(flag.slice(3));
    const key = byFlag.get(negated ? flag.slice(3) : flag);
    if (!key) {
      const known = [...byFlag.keys()].map((f) => `--${f}`).join(', ') || '(none)';
      throw new UsageError(`unknown flag --${flag} for "${entry.command}". Flags: ${known}`);
    }
    const prop = props.get(key) ?? {};
    if (negated) {
      if (typeOf(prop) !== 'boolean') {throw new UsageError(`--${flag} only works for true/false flags`);}
      input[key] = false;
      continue;
    }
    const value = coerce(flag, prop, raw);
    const existing = input[key];
    input[key] = typeOf(prop) === 'array' && Array.isArray(existing) && !(typeof raw === 'string' && raw.trim().startsWith('['))
      ? [...existing, ...(Array.isArray(value) ? value : [value])]
      : value;
  }
  const missing = (entry.input?.required ?? []).filter((k) => input[k] === undefined);
  if (missing.length) {throw new UsageError(`missing ${missing.map((k) => `--${kebab(k)}`).join(', ')}`);}
  return entry.input ? input : undefined;
}

function commandHelp(entry: CliProcedure): string {
  const lines = [`${entry.command}: ${entry.description}`, ''];
  const props = [...(entry.input?.properties ?? [])];
  if (!props.length) {lines.push('  (no flags)');}
  for (const [k, p] of props) {
    const req = entry.input?.required.includes(k) ? ' (required)' : '';
    const t = p.enum ? p.enum.join('|') : typeOf(p);
    lines.push(`  --${kebab(k)} <${t}>${req}${p.description ? `  ${p.description}` : ''}`);
  }
  lines.push('  --json <object>  pass the whole input as JSON');
  if (entry.errors.length) {lines.push('', 'Errors:', ...entry.errors.map((e) => `  ${e.code} (${e.status}) ${e.message}`));}
  return lines.join('\n') + '\n';
}

function listHelp(procedures: Array<CliProcedure>): string {
  const cmds = [...procedures].sort((a, b) => a.command.localeCompare(b.command));
  const width = Math.max(0, ...cmds.map((c) => c.command.length));
  return [
    'Usage: realtime [--url URL] [--token TOKEN] <command> [flags]',
    '       REALTIME_URL and REALTIME_TOKEN are read from the environment.',
    '',
    'Commands:',
    ...cmds.map((c) => `  ${c.command.padEnd(width)}  ${c.description}`),
    '',
    'Run "realtime <command> --help" for its flags.',
  ].join('\n') + '\n';
}

/**
 * Runs the CLI and returns the exit code: 0 on success, 1 when the call failed, 2 for usage errors.
 * The CLI never imports handlers. It downloads the manifest and calls the Worker over HTTP.
 */
export async function run(io: Io): Promise<number> {
  const f = io.fetch ?? fetch;
  // Decision: a first pass for the global flags and the command words. The command's own flags are
  // only known once the manifest is in, so they're split again below.
  const { words, flags } = splitArgs(io.argv, globalOptions);
  const take = (name: string) => flags.find(([k]) => k === name)?.[1];
  const takeString = (name: string) => {
    const value = take(name);
    return typeof value === 'string' ? value : undefined;
  };
  for (const name of ['url', 'token']) {
    if (take(name) === true) {
      io.stderr(`realtime: --${name} needs a value\n`);
      return 2;
    }
  }
  const url = takeString('url') ?? io.env.REALTIME_URL;
  const token = takeString('token') ?? io.env.REALTIME_TOKEN;
  const basePath = io.env.REALTIME_BASE_PATH ?? '/rpc';
  const help = take('help') !== undefined || words[0] === 'help';
  if (words[0] === 'help') {words.shift();}

  if (!url) {
    io.stderr('realtime: set --url or REALTIME_URL to your Worker, e.g. https://api.example.com\n');
    return 2;
  }
  const origin = url.replace(/\/$/, '');
  let procedures: Array<CliProcedure>;
  try {
    const res = await f(`${origin}${basePath}/manifest.json`);
    if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
    const body: unknown = await res.json();
    procedures = toManifest(body);
  } catch (error) {
    io.stderr(`realtime: could not load ${origin}${basePath}/manifest.json: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const entry = procedures
    .filter((p) => p.command.split(' ').every((w, i) => words[i] === w))
    .sort((a, b) => b.command.length - a.command.length)[0];

  if (!entry) {
    if (words.length && !help) {io.stderr(`realtime: unknown command "${words.join(' ')}"\n\n`);}
    (words.length && !help ? io.stderr : io.stdout)(listHelp(procedures));
    return words.length && !help ? 2 : 0;
  }
  const own = splitArgs(io.argv, optionsFor(entry));
  const extra = own.words.slice(entry.command.split(' ').length);
  if (help) {
    io.stdout(commandHelp(entry));
    return 0;
  }
  if (extra.length) {
    io.stderr(`realtime: unexpected argument "${extra[0]}". Pass values as flags.\n\n${commandHelp(entry)}`);
    return 2;
  }

  let input: unknown;
  try {
    const props = entry.input?.properties ?? new Map<string, Prop>();
    const required = entry.input?.required ?? [];
    const clash = [...props.keys()].find((k) => ownFlags.has(kebab(k)) && required.includes(k));
    if (clash && !own.flags.some(([f]) => f === 'json')) {
      throw new UsageError(`"${clash}" is also a flag of the CLI, so --${kebab(clash)} can't set it. Pass it with --json '{"${clash}": ...}'`);
    }
    input = inputFromFlags(entry, own.flags.filter(([k]) => !ownFlags.has(k)));
  } catch (error) {
    if (!(error instanceof UsageError)) {throw error;}
    io.stderr(`realtime: ${error.message}\n\n${commandHelp(entry)}`);
    return 2;
  }

  const authorization = token ? { authorization: `Bearer ${token}` } : undefined;
  const res = await f(`${origin}${entry.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-realtime-surface': 'cli', ...authorization },
    body: input === undefined ? '' : JSON.stringify(input),
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok && body === undefined) {
    io.stderr(`realtime: the server sent a response that isn't JSON (HTTP ${res.status})\n`);
    return 1;
  }
  const failure = toFailure(body);
  if (res.ok && !failure) {
    const data: unknown = typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined;
    io.stdout(JSON.stringify(data, null, 2) + '\n');
    return 0;
  }
  const err = failure ?? { code: 'INTERNAL', message: `HTTP ${res.status}` };
  io.stderr(`error ${err.code}: ${err.message}\n`);
  for (const i of failure?.issues ?? []) {io.stderr(`  ${i.path ? `--${kebab(i.path.split('.')[0] ?? '')}` : 'input'}: ${i.message}\n`);}
  if (res.status === 401) {io.stderr('Set --token or REALTIME_TOKEN to an API token.\n');}
  return 1;
}
