import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { Manifest, ManifestEntry } from '@builtbyfriends/realtime';

type Io = {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

type Prop = { type?: string | string[]; description?: string; enum?: unknown[]; items?: Prop; anyOf?: Prop[] };

// Decision: text from the server is printed without control characters, so a response can't drive the terminal.
const plain = (s: unknown) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

function typeOf(p: Prop): string {
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
  if (t) return t;
  if (p.enum?.every((v) => typeof v === 'string')) return 'string';
  if (p.anyOf) {
    const types = p.anyOf.map(typeOf).filter((x) => x !== 'null');
    if (types.length === 1) return types[0]!;
  }
  return 'json';
}

class UsageError extends Error {}

const ownFlags = ['url', 'token', 'help'];

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
function splitArgs(argv: string[], options: ParseArgsOptionsConfig) {
  const { tokens } = parseArgs({ args: argv, options, strict: false, allowPositionals: true, tokens: true });
  const words: string[] = [];
  const flags: [string, string | true][] = [];
  let open: { index: number; name: string } | undefined;
  for (const t of tokens) {
    if (t.kind === 'option') {
      flags.push([t.name, t.value ?? true]);
      open = t.value === undefined ? { index: t.index, name: t.name } : undefined;
      continue;
    }
    const type = open && options[open.name]?.type;
    if (t.kind === 'positional' && open?.index === t.index - 1 && (!type || (type === 'boolean' && /^(true|false)$/.test(t.value)))) {
      flags[flags.length - 1]![1] = t.value;
    } else if (t.kind === 'positional') words.push(t.value);
    open = undefined;
  }
  return { words, flags };
}

function coerce(name: string, prop: Prop, raw: string | true): unknown {
  const t = typeOf(prop);
  if (t === 'boolean') {
    if (raw === true || raw === 'true') return true;
    if (raw === 'false') return false;
    throw new UsageError(`--${name} takes true or false`);
  }
  if (raw === true) throw new UsageError(`--${name} needs a value`);
  if (t === 'number' || t === 'integer') {
    const n = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(n) || (t === 'integer' && !Number.isInteger(n))) throw new UsageError(`--${name} must be ${t === 'integer' ? 'an integer' : 'a number'}`);
    return n;
  }
  if (t === 'string') {
    if (prop.enum && !prop.enum.includes(raw)) throw new UsageError(`--${name} must be one of: ${prop.enum.join(', ')}`);
    return raw;
  }
  if (t === 'array' && !raw.trim().startsWith('[')) return [coerce(name, prop.items ?? {}, raw)];
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`--${name} must be JSON`);
  }
}

function inputFromFlags(entry: ManifestEntry, flags: [string, string | true][]): unknown {
  const schema = (entry.input ?? {}) as { properties?: Record<string, Prop>; required?: string[] };
  const props = schema.properties ?? {};
  const byFlag = new Map(Object.keys(props).map((k) => [kebab(k), k]));
  let input: Record<string, unknown> = {};
  for (const [flag, raw] of flags) {
    if (flag === 'json') {
      if (raw === true) throw new UsageError('--json needs a value');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new UsageError('--json must be a JSON object');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UsageError('--json must be a JSON object');
      input = { ...input, ...parsed };
      continue;
    }
    const negated = !byFlag.has(flag) && flag.startsWith('no-') && byFlag.has(flag.slice(3));
    const key = byFlag.get(negated ? flag.slice(3) : flag);
    if (!key) {
      const known = [...byFlag.keys()].map((f) => `--${f}`).join(', ') || '(none)';
      throw new UsageError(`unknown flag --${flag} for "${entry.cli!.command}". Flags: ${known}`);
    }
    const prop = props[key]!;
    if (negated) {
      if (typeOf(prop) !== 'boolean') throw new UsageError(`--${flag} only works for true/false flags`);
      input[key] = false;
      continue;
    }
    const value = coerce(flag, prop, raw);
    input[key] = typeOf(prop) === 'array' && Array.isArray(input[key]) && !(typeof raw === 'string' && raw.trim().startsWith('['))
      ? [...(input[key] as unknown[]), ...(value as unknown[])]
      : value;
  }
  const missing = (schema.required ?? []).filter((k) => input[k] === undefined);
  if (missing.length) throw new UsageError(`missing ${missing.map((k) => `--${kebab(k)}`).join(', ')}`);
  return entry.input ? input : undefined;
}

function commandHelp(entry: ManifestEntry): string {
  const schema = (entry.input ?? {}) as { properties?: Record<string, Prop>; required?: string[] };
  const lines = [`${entry.cli!.command}: ${entry.cli!.description}`, ''];
  const props = Object.entries(schema.properties ?? {});
  if (!props.length) lines.push('  (no flags)');
  for (const [k, p] of props) {
    const req = schema.required?.includes(k) ? ' (required)' : '';
    const t = p.enum ? p.enum.join('|') : typeOf(p);
    lines.push(`  --${kebab(k)} <${t}>${req}${p.description ? `  ${p.description}` : ''}`);
  }
  lines.push('  --json <object>  pass the whole input as JSON');
  const errs = Object.entries(entry.errors);
  if (errs.length) lines.push('', 'Errors:', ...errs.map(([c, s]) => `  ${c} (${s.status}) ${s.message}`));
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
  for (const name of ['url', 'token']) {
    if (take(name) === true) {
      io.stderr(`realtime: --${name} needs a value\n`);
      return 2;
    }
  }
  const url = (take('url') as string | undefined) ?? io.env.REALTIME_URL;
  const token = (take('token') as string | undefined) ?? io.env.REALTIME_TOKEN;
  const basePath = io.env.REALTIME_BASE_PATH ?? '/rpc';
  const help = take('help') !== undefined || words[0] === 'help';
  if (words[0] === 'help') words.shift();

  if (!url) {
    io.stderr('realtime: set --url or REALTIME_URL to your Worker, e.g. https://api.example.com\n');
    return 2;
  }
  const origin = url.replace(/\/$/, '');
  let manifest: Manifest;
  try {
    const res = await f(`${origin}${basePath}/manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()) as Manifest;
  } catch (e) {
    io.stderr(`realtime: could not load ${origin}${basePath}/manifest.json: ${(e as Error).message}\n`);
    return 1;
  }

  const entry = manifest.procedures
    .filter((p) => {
      const parts = p.cli!.command.split(' ');
      return parts.every((w, i) => words[i] === w);
    })
    .sort((a, b) => b.cli!.command.length - a.cli!.command.length)[0];

  if (!entry) {
    if (words.length && !help) io.stderr(`realtime: unknown command "${words.join(' ')}"\n\n`);
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
    const props = (entry.input as { properties?: Record<string, Prop> } | undefined)?.properties ?? {};
    const required = (entry.input as { required?: string[] } | undefined)?.required ?? [];
    const clash = Object.keys(props).find((k) => ownFlags.includes(kebab(k)) && required.includes(k));
    if (clash && !own.flags.some(([f]) => f === 'json')) {
      throw new UsageError(`"${clash}" is also a flag of the CLI, so --${kebab(clash)} can't set it. Pass it with --json '{"${clash}": ...}'`);
    }
    input = inputFromFlags(entry, own.flags.filter(([k]) => !ownFlags.includes(k)));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr(`realtime: ${e.message}\n\n${commandHelp(entry)}`);
    return 2;
  }

  // Decision: the path comes from the server's manifest, and the token goes with the request, so the request stays on the
  // host the user named.
  const target = new URL(entry.path, `${origin}/`);
  if (!entry.path.startsWith('/') || target.origin !== new URL(origin).origin) {
    io.stderr(`realtime: the server listed a path on another host for this command, so nothing was sent\n`);
    return 1;
  }
  const res = await f(target.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-realtime-surface': 'cli', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: input === undefined ? '' : JSON.stringify(input),
  });
  const body = (await res.json().catch(() => undefined)) as { data?: unknown; error?: { code: string; message: string; issues?: { path: string; message: string }[] } } | undefined;
  if (res.ok && body === undefined) {
    io.stderr(`realtime: the server sent a response that isn't JSON (HTTP ${res.status})\n`);
    return 1;
  }
  if (res.ok && !body?.error) {
    io.stdout(JSON.stringify(body?.data ?? null, null, 2) + '\n');
    return 0;
  }
  const err = typeof body?.error === 'object' && body.error !== null && typeof body.error.code === 'string' ? body.error : { code: 'INTERNAL', message: `HTTP ${res.status}` };
  io.stderr(`error ${plain(err.code)}: ${plain(err.message)}\n`);
  for (const i of Array.isArray(err.issues) ? err.issues : []) io.stderr(`  ${typeof i.path === 'string' && i.path ? `--${kebab(plain(i.path).split('.')[0]!)}` : 'input'}: ${plain(i.message)}\n`);
  if (res.status === 401) io.stderr('Set --token or REALTIME_TOKEN to an API token.\n');
  return 1;
}
