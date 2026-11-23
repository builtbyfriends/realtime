import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import type { Manifest, ManifestEntry } from '@builtbyfriends/realtime';

type Io = {
  argv: Array<string>;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

type Prop = { type?: string | Array<string>; description?: string; enum?: Array<unknown>; items?: Prop; anyOf?: Array<Prop> };

const kebab = (s: string) => s.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-').toLowerCase();

function typeOf(p: Prop): string {
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
  if (t) {return t;}
  if (p.enum?.every((v) => typeof v === 'string')) {return 'string';}
  if (p.anyOf) {
    const types = p.anyOf.map(typeOf).filter((x) => x !== 'null');
    if (types.length === 1) {return types[0]!;}
  }
  return 'json';
}

class UsageError extends Error {}

const globalOptions: ParseArgsOptionsConfig = {
  url: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function optionsFor(entry: ManifestEntry): ParseArgsOptionsConfig {
  const props = (entry.input as { properties?: Record<string, Prop> } | undefined)?.properties ?? {};
  const own = Object.entries(props).map(([k, p]) => [kebab(k), { type: typeOf(p) === 'boolean' ? 'boolean' : 'string' }]);
  return { ...globalOptions, ...Object.fromEntries(own) };
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
    if (t.kind === 'positional' && open?.index === t.index - 1 && (!type || (type === 'boolean' && /^(true|false)$/.test(t.value)))) {
      flags.at(-1)![1] = t.value;
    } else if (t.kind === 'positional') {words.push(t.value);}
    open = undefined;
  }
  return { words, flags };
}

function coerce(name: string, prop: Prop, raw: string | true): unknown {
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
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`--${name} must be JSON`);
  }
}

function inputFromFlags(entry: ManifestEntry, flags: Array<[string, string | true]>): unknown {
  const schema = (entry.input ?? {}) as { properties?: Record<string, Prop>; required?: Array<string> };
  const props = schema.properties ?? {};
  const byFlag = new Map(Object.keys(props).map((k) => [kebab(k), k]));
  let input: Record<string, unknown> = {};
  for (const [flag, raw] of flags) {
    if (flag === 'json') {
      if (raw === true) {throw new UsageError('--json needs a value');}
      try {
        input = { ...input, ...JSON.parse(raw) };
      } catch {
        throw new UsageError('--json must be a JSON object');
      }
      continue;
    }
    const negated = flag.startsWith('no-') && byFlag.has(flag.slice(3));
    const key = byFlag.get(negated ? flag.slice(3) : flag);
    if (!key) {
      const known = [...byFlag.keys()].map((f) => `--${f}`).join(', ') || '(none)';
      throw new UsageError(`unknown flag --${flag} for "${entry.cli!.command}". Flags: ${known}`);
    }
    const prop = props[key]!;
    if (negated) {
      if (typeOf(prop) !== 'boolean') {throw new UsageError(`--${flag} only works for true/false flags`);}
      input[key] = false;
      continue;
    }
    const value = coerce(flag, prop, raw);
    input[key] = typeOf(prop) === 'array' && Array.isArray(input[key]) && !(typeof raw === 'string' && raw.trim().startsWith('['))
      ? [...(input[key] as Array<unknown>), ...(value as Array<unknown>)]
      : value;
  }
  const missing = (schema.required ?? []).filter((k) => input[k] === undefined);
  if (missing.length) {throw new UsageError(`missing ${missing.map((k) => `--${kebab(k)}`).join(', ')}`);}
  return entry.input ? input : undefined;
}

function commandHelp(entry: ManifestEntry): string {
  const schema = (entry.input ?? {}) as { properties?: Record<string, Prop>; required?: Array<string> };
  const lines = [`${entry.cli!.command}: ${entry.cli!.description}`, ''];
  const props = Object.entries(schema.properties ?? {});
  if (!props.length) {lines.push('  (no flags)');}
  for (const [k, p] of props) {
    const req = schema.required?.includes(k) ? ' (required)' : '';
    const t = p.enum ? p.enum.join('|') : typeOf(p);
    lines.push(`  --${kebab(k)} <${t}>${req}${p.description ? `  ${p.description}` : ''}`);
  }
  lines.push('  --json <object>  pass the whole input as JSON');
  const errs = Object.entries(entry.errors);
  if (errs.length) {lines.push('', 'Errors:', ...errs.map(([c, s]) => `  ${c} (${s.status}) ${s.message}`));}
  return lines.join('\n') + '\n';
}

function listHelp(manifest: Manifest): string {
  const cmds = manifest.procedures.map((p) => p.cli!).sort((a, b) => a.command.localeCompare(b.command));
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
  const url = (take('url') as string | undefined) ?? io.env.REALTIME_URL;
  const token = (take('token') as string | undefined) ?? io.env.REALTIME_TOKEN;
  const basePath = io.env.REALTIME_BASE_PATH ?? '/rpc';
  const help = take('help') !== undefined || words[0] === 'help';
  if (words[0] === 'help') {words.shift();}

  if (!url) {
    io.stderr('realtime: set --url or REALTIME_URL to your Worker, e.g. https://api.example.com\n');
    return 2;
  }
  const origin = url.replace(/\/$/, '');
  let manifest: Manifest;
  try {
    const res = await f(`${origin}${basePath}/manifest.json`);
    if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
    manifest = (await res.json()) as Manifest;
  } catch (error) {
    io.stderr(`realtime: could not load ${origin}${basePath}/manifest.json: ${(error as Error).message}\n`);
    return 1;
  }

  const entry = manifest.procedures
    .filter((p) => {
      const parts = p.cli!.command.split(' ');
      return parts.every((w, i) => words[i] === w);
    })
    .sort((a, b) => b.cli!.command.length - a.cli!.command.length)[0];

  if (!entry) {
    if (words.length && !help) {io.stderr(`realtime: unknown command "${words.join(' ')}"\n\n`);}
    (words.length && !help ? io.stderr : io.stdout)(listHelp(manifest));
    return words.length && !help ? 2 : 0;
  }
  const own = splitArgs(io.argv, optionsFor(entry));
  const extra = own.words.slice(entry.cli!.command.split(' ').length);
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
    input = inputFromFlags(entry, own.flags.filter(([k]) => !['url', 'token', 'help'].includes(k)));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`realtime: ${error.message}\n\n${commandHelp(entry)}`);
    return 2;
  }

  const res = await f(`${origin}${entry.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-realtime-surface': 'cli', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: input === undefined ? '' : JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown; error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } };
  if (res.ok && !body.error) {
    io.stdout(JSON.stringify(body.data, null, 2) + '\n');
    return 0;
  }
  const err = body.error ?? { code: 'INTERNAL', message: `HTTP ${res.status}` };
  io.stderr(`error ${err.code}: ${err.message}\n`);
  for (const i of err.issues ?? []) {io.stderr(`  ${i.path ? `--${kebab(i.path.split('.')[0]!)}` : 'input'}: ${i.message}\n`);}
  if (res.status === 401) {io.stderr('Set --token or REALTIME_TOKEN to an API token.\n');}
  return 1;
}
