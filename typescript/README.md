# realtime (TypeScript)

A procedure builder for Cloudflare Workers where every procedure must decide nine
concerns before it compiles: authentication, authorization, input, output, errors,
analytics, MCP, CLI and AI tool exposure. Skipping one is not possible by omission.
Opting out is a decision too, and it needs a reason.

The goal is to force whoever writes the code, especially an AI agent, to make each
choice, and to make every choice visible in review. The packages are
`@builtbyfriends/realtime` and `@builtbyfriends/realtime-*` on npm.

```ts
export const getContact = procedure('contacts.get')
  .use(orgMember)                                         // profile: decides auth
  .input(z.object({ orgId: z.string(), id: z.string() }))
  .authz({ policy: 'same-org', check: (user, input) => user.orgId === input.orgId })
  .output(Contact)
  .errors({ NOT_FOUND: { status: 404, message: 'No such contact' } })
  .analytics({ event: 'contact.viewed', props: (input) => ({ orgId: input.orgId }) })
  .mcp({ description: 'Look up one contact by id', effect: 'read' })
  .cli({ command: 'contacts get', description: 'Print one contact as JSON' })
  .noAiTool({ reason: 'Returns PII; agents use contacts.search, which redacts email' })
  .handler(({ input, fail }) => contacts.get(input.id) ?? fail('NOT_FOUND'));
```

If something is missing, `.handler()` will not type-check, and the message says what to do:

```
Argument of type '() => Promise<{ ids: never[]; }>' is not assignable to parameter of type
'"Undecided: authz, errors, analytics, cli, aiTool. Decide each one (or opt out with a reason) before .handler()"'.
```

## Packages

| Package | Runs on | What it does | Dependencies |
| --- | --- | --- | --- |
| `@builtbyfriends/realtime` | anywhere | Builder, profiles, registry, pipeline, audit, manifest | `@standard-schema/spec` (types) |
| `@builtbyfriends/realtime-http` | Worker | `POST /rpc/{name}` fetch handler, `manifest.json`, `openapi.json`; `@builtbyfriends/realtime-http/client` is a typed fetch client | none |
| `@builtbyfriends/realtime-mcp` | Worker | Stateless MCP over Streamable HTTP via Cloudflare's `createMcpHandler` (agents/mcp/server + MCP SDK v2) | peers: `agents`, `@modelcontextprotocol/server` |
| `@builtbyfriends/realtime-ai` | Worker | Tool definitions for the Anthropic API and the AI SDK, with approval holds | none |
| `@builtbyfriends/realtime-analytics` | Worker | Workers Analytics Engine (default), PostHog, fan-out, in-memory | none |
| `@builtbyfriends/realtime-cli` | Node 20+ / Bun | `realtime` command driven by the Worker's manifest, bearer token auth | none |
| `@builtbyfriends/realtime-data` | Durable Object | One object per deployment: transactional SQLite documents, indexes, FTS5, exact vector search, delayed and cancellable jobs on alarms | none |
| `@builtbyfriends/realtime-live` | Browser | `useQuery`/`useMutation` over any transport: an RPC call plus topic subscriptions, refetched on events and reconnects | peer: `react` (optional) |
| `@builtbyfriends/realtime-bwf` | Vite / bwf | The only package that knows bwf: plugin and middleware, `bwfTransport`, `createBwfLive`, `publishTopics`, `topicPolicy` | peers: `@builtbyfriends/bwf`, `vite` |

The Worker side uses Web APIs only, with no `nodejs_compat`.

## The nine decisions

| Concern | Decide with | Opt out with | At runtime |
| --- | --- | --- | --- |
| authn | `auth(provider)` | `noAuth({ reason })` | 401 when the provider returns null; `ctx` is the caller |
| authz | `authz({ policy, check })` | `noAuthz({ reason })` | 403 when `check(ctx, input)` is false; runs after input parsing |
| input | `input(schema)` | `noInput()` | 400 with issues; `noInput()` rejects a non-empty body |
| output | `output(schema)` | none | Validated before it leaves; a mismatch is a logged 500 |
| errors | `errors({ CODE: { status, message } })` | `noErrors({ reason })` | `fail()` only accepts declared codes; any other throw is a 500 with no details |
| analytics | `analytics({ event, props })` | `noAnalytics({ reason })` | One event per call that reached the handler, sent through `waitUntil` |
| mcp | `mcp({ description, effect })` | `noMcp({ reason })` | Listed in `tools/list`; `effect` (read, write, destructive) sets the annotations |
| cli | `cli({ command, description })` | `noCli({ reason })` | A subcommand with flags generated from the input schema |
| aiTool | `aiTool({ description, needsApproval })` | `noAiTool({ reason })` | A tool definition; `needsApproval: true` holds the call until approved |

Order is free, with one exception: `authz` needs authentication decided first, because
its `check` is typed by the caller. A profile (`profile('admin-only').auth(...).authz(...)`)
fills several slots at once, and applying it with `.use()` is still an explicit choice
that shows up in the audit.

`mcp({ effect })` and `aiTool({ needsApproval })` are required fields on purpose: whether
a tool is destructive, and whether a person must approve it, should never be a default.

## Three gates

1. **Types.** The handler gate, hidden methods for decided concerns, typed `fail()` codes,
   and reason checks on literal strings (three words, not "n/a" or "todo").
2. **Load.** `defineRegistry([...])` checks every procedure again and throws one error
   listing every problem: missing decisions (from `as any` or plain JS), weak reasons,
   duplicate names or commands, reserved error codes, analytics with no provider, and
   schemas that cannot become JSON Schema. Build the registry at module scope: a throw
   there fails `wrangler deploy` with error 10021, because wrangler bundles with esbuild
   and never runs the type checker. The example's deploy script is
   `tsc --noEmit && wrangler deploy` so the type gate runs first.
3. **Review.** `registry.auditTable()` prints every decision for every procedure. The
   example snapshots it to `test/audit.md`, so a change that turns `contacts.get` into
   `noAuth` is a visible line in the pull request.

## Schemas

Any [Standard Schema](https://standardschema.dev) works for validation. Procedures
exposed to MCP, the CLI or AI tools also need JSON Schema, read through Standard JSON
Schema (`~standard.jsonSchema`): Zod 4.2+ and ArkType provide it, and Valibot schemas
are wrapped with `toStandardJsonSchema()` from `@valibot/to-json-schema`. Conversion
happens when the registry loads, so an unsupported schema (for example `z.date()`)
fails the deploy instead of the first `tools/list`.

## Worker setup

```ts
// registry.ts
export const registry = defineRegistry([getContact, searchContacts, deleteContact, status], {
  analytics: analyticsEngine({ binding: 'ANALYTICS' }),
});

// index.ts
const rpc = rpcHandler(registry, { openapi: { title: 'Contacts API', version: '0.1.0' } });
const mcp = mcpHandler(registry, { name: 'contacts', version: '0.1.0' });

export default {
  fetch(request, env, ctx) {
    if (mcp.matches(request)) return mcp(request, env, ctx);
    if (rpc.matches(request)) return rpc(request, env, ctx);
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

Wire format: success is `200 { "data": ... }`, failure is
`{ "error": { "code", "message", "issues"? } }` with the status from the table above or
from the declared error.

AI tools run inside the Worker with the user's own request, so an agent gets exactly
that user's permissions:

```ts
const tools = anthropicTools(registry);                    // pass to messages.create
const run = await runTool(registry, block.name, block.input, { request, env, waitUntil });
const { content, is_error } = toolResultContent(run);      // tool_result block
```

## CLI

```
$ REALTIME_URL=https://api.example.com REALTIME_TOKEN=... realtime
Commands:
  contacts get     Print one contact as JSON
  contacts search  Search contacts by name
  status           Check that the API is up

$ realtime contacts search --org-id o1 --query tur
{ "results": [{ "id": "c2", "name": "Alan Turing" }] }
```

The CLI downloads `/rpc/manifest.json` (procedures that chose `.cli()`, with JSON Schema)
and calls the Worker over HTTP with `Authorization: Bearer`. It never imports handler
code. Flags come from top-level input properties in kebab-case, with numbers, booleans
(`--flag`, `--no-flag`), enums and repeated array flags; `--json '{...}'` passes the whole
input. Exit codes: 0 success, 1 call failed, 2 usage error.

## Analytics Engine layout

`index1` = procedure; `blob1..7` = event, procedure, surface (http, mcp, cli, ai),
outcome, error code, actor id, props as JSON; `double1` = HTTP status, `double2` =
handler duration in ms.

## Development

```
bun install
bun run check        # build, type tests, compiler message snapshot, 45 vitest tests
bun run e2e          # example Worker in wrangler dev: HTTP, CLI, MCP client, deploy gate
cd examples/contacts-worker && bun run dev
```

- `packages/core/type-tests/pass.ts`: positive types plus `@ts-expect-error` for each
  mistake the types must reject.
- `packages/core/type-tests/messages/messages.expected.txt`: the exact compiler messages
  an agent sees, snapshotted (`bun run test:types --update` to accept a change).
- `packages/core/type-tests/perf.ts`: 200 full procedures type-check in about 0.5 s.

Built and tested with TypeScript 7.0, Zod 4.6, Valibot 1.5, agents 0.33, MCP SDK 2.4,
wrangler 4.160 and vitest 5.1. The example Worker bundles to 1.26 MB (222 KB gzipped),
mostly the MCP SDK and Zod.

## Not done yet

- Session-cookie auth provider (the example uses API tokens; `anyOf()` combines providers).
- OAuth for MCP clients; MCP calls currently authenticate with the same bearer token.
- Publishing to npm (needs a real name).

## Data and live queries

`@builtbyfriends/realtime-data` replaces the document store a Convex-style backend gives you. Functions run
inside one Durable Object, so a mutation is one SQLite transaction (`transactionSync`),
and anything it schedules commits or rolls back with it. Procedures stay the only API: they
call the typed client.

```ts
export const data = defineData({
  schema: defineSchema({
    messages: table<Message>({
      indexes: { by_channel: ['channel', 'at'] },
      search: { body: { field: 'body', filters: ['channel'] } },     // FTS5
      topics: (m) => [`messages:channel:${m.channel}`],              // live topics on change
    }),
  }),
  functions: ({ query, mutation }) => ({
    send: mutation((ctx, a: { channel: string; body: string }) => {
      const id = ctx.db.insert('messages', { ...a, at: ctx.now });
      ctx.scheduler.runAfter(60_000, 'nudge', { id }, { id: `nudge:${a.channel}` }); // debounce by id
      return id;
    }),
    list: query((ctx, a: { channel: string }) =>
      ctx.db.query('messages').withIndex('by_channel', (q) => q.eq('channel', a.channel)).order('desc').take(50)),
  }),
  jobs: (job) => ({ nudge: job(async (ctx, a: { id: string }) => { /* may be async; retried with backoff */ }) }),
  onCommit: publishTopics(live),     // from @builtbyfriends/realtime-bwf/data; any (topics, env) => void works
});
export class Deployment extends data.durableObject(DurableObject) {}   // bind it, new_sqlite_classes
// in a procedure: data.client(env.DEPLOYMENT).mutate.send(input)
```

Every write reports the topics it touched (`table`, `table:id`, plus the table's `topics`).
`onCommit` publishes them. The write answers without waiting for the publish, so a slow
listener doesn't slow the write down. No client can subscribe to `table` or `table:id` unless
a rule allows it, so `publishTopics(live, { only: policy.subscribable })` skips those, where
`policy` is your `topicPolicy(...)`. That saves a Durable Object per topic. Jobs are at least once: a job that throws is retried with
backoff and then parked as `failed`; give a job a stable `id` to replace a pending one or
`scheduler.cancel(id)` it. Search and vector indexes rebuild from the documents when their
definition changes. Vector search is exact (cosine over the filtered rows).

`@builtbyfriends/realtime-live` is the client half. bwf's live streams deliver at most once and replay
nothing, so an event only means "this query may be stale": the store refetches, collapses
bursts, shares one fetch between components asking the same thing, keeps the last good data
on an error, and refetches everything when the transport reconnects or the tab is shown again.

```ts
// src/live.ts
import { connectLiveStream } from '@builtbyfriends/bwf/live/client';
import { createBwfLive } from '@builtbyfriends/realtime-bwf/react';
export const { useQuery, useMutation, live } = createBwfLive<typeof registry>({
  client: createClient<typeof registry>('/rpc'),
  connect: connectLiveStream,
  topics: { 'messages.list': (i) => [`messages:channel:${i.channel}`] },
});
// component: const messages = useQuery('messages.list', { channel });
// server: defineLiveStream({ id: 'app', onSubscribe: topicPolicy([{ pattern: /^messages:channel:(.+)$/, allow: ... }]) })
```

Always set `onSubscribe` (`topicPolicy` refuses any topic without a matching rule).

A mutation can show its result before the server answers. `optimistic` changes the data of watched
queries right away. If the call fails, they go back to what they showed. Either way they fetch
again, so the server's answer replaces the guess:

```ts
const send = useMutation('messages.send');
send.mutate({ channel, body }, {
  optimistic: (store) => store.update('messages.list', { channel }, (list) => [...list, body]),
});
```
`examples/chat-worker` runs the data layer in workerd (`bun run e2e`).
