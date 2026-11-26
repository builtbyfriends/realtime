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
| `@builtbyfriends/realtime` | anywhere | Builder, profiles, registry, pipeline, audit, manifest, contracts and contract checks | `@standard-schema/spec` (types) |
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
bun run check        # build, type tests, compiler message snapshot, vitest tests
bun run e2e          # example Worker in wrangler dev: HTTP, CLI, MCP client, deploy gate
cd examples/contacts-worker && bun run dev
```

- `packages/core/type-tests/pass.ts`: positive types plus `@ts-expect-error` for each
  mistake the types must reject.
- `packages/core/type-tests/messages/messages.expected.txt`: the exact compiler messages
  an agent sees, snapshotted (`bun run test:types --update` to accept a change).
- `packages/core/type-tests/perf.ts`: 200 full procedures type-check in about 0.5 s.

Built and tested with TypeScript 7.0, Zod 4.6, Valibot 1.5, agents 0.34, MCP SDK 2.4,
wrangler 4.166 and vitest 5.1. The example Worker bundles to 1.26 MB (222 KB gzipped),
mostly the MCP SDK and Zod.

## Not done yet

- Session-cookie auth provider (the example uses API tokens; `anyOf()` combines providers).
- OAuth for MCP clients; MCP calls currently authenticate with the same bearer token.

## Contracts

A module's contract is one file that says what the module is: its records, its commands, its events and its states, as schemas.
`implementContract` turns it into ordinary procedures, so the app call, the MCP and AI tools, the CLI, the typed client, the audit
and the docs come from that one file. Hand-written procedures keep working next to it.

```ts
export const tasks = defineContract({
  name: 'tasks',
  description: 'A piece of work that someone opens, starts and finishes.',
  data: { Task },                                          // records, as schemas; types come from them
  states: { record: 'Task', field: 'state', list: ['open', 'doing', 'done'], initial: 'open',
    moves: { start: { from: ['open'], to: 'doing' } } },   // a move that isn't listed is refused
  requestIds: { keepHours: 24 },                           // how long a retry is recognised
  commands: {
    start: {
      description: 'Start working on an open task.',
      effect: 'write',                                     // writes take a requestId and run once per id
      input: z.object({ id: z.string() }),
      output: Task,
      errors: { NOT_FOUND: { status: 404, message: 'No task with this id' } },
      capability: 'tasks.write',                           // the right a caller needs, as plain data
      tool: { needsApproval: false },                      // or { reason } to keep it from bots
      cli: true,                                           // `tasks start`, or { reason }
      move: 'start',
      emits: ['moved'],
    },
  },
  events: { moved: { description: 'A task changed state.', topic: 'tasks:{id}', payload: Moved } },
});

export const module = implementContract(tasks).with({
  auth: apiToken,
  can: ({ ctx, capability }) => ctx.capabilities.includes(capability),
  analytics: true,
  publish: (event, env) => live.withEnv(env).publish(event.topic, event.payload),
  runOnce: memoryRunOnce(),
  commands: {
    start: ({ input, fail, move, emit }) => {
      const task = store.get(input.id) ?? fail('NOT_FOUND');
      const next = { ...task, state: move(task.state) };    // MOVE_NOT_ALLOWED unless the contract lists it
      emit('moved', { id: task.id, from: task.state, to: next.state });
      return next;
    },
  },
});
export const registry = defineRegistry([...module.procedures, ...otherProcedures]);
```

`defineContract` and `implementContract` throw one error that lists each problem and what to change, and the types catch most of
them first: a move or event the contract doesn't list, a failure a command doesn't list, a topic field that isn't in the payload, an
example that doesn't match the input. Events are checked against their schema and published after the handler succeeds, so a failed
or repeated call publishes nothing. An event's `topic` can be a list, such as `['tasks:{id}', 'tasks-by:{createdBy}']`, and the
event then goes out once on each topic, so a screen can follow one record or a whole group of them.

A write's `requestId` and first result live in a `RunOnceStore`. `storageRunOnce(ctx.storage)` keeps them in a Durable Object's own
SQLite, next to the state they guard, so a retry after a restart still gets the first result. `memoryRunOnce()` keeps them in memory,
for tests and examples. A handler's changes aren't rolled back when one of its events fails its schema afterwards: the call answers
500 and keeps nothing, so a retry runs the handler again. `contractChecks` runs each command, so a bad payload tends to show up there
before it ships.

Without an outbox, an event whose delivery fails is gone. Pass `outbox: storageOutbox(ctx.storage)` and each event is written to the
owner's SQLite right after the handler, then delivered, and removed once `publish` takes it. When `publish` throws, the event waits,
the outbox sets the object's alarm, and the owner's `alarm()` calls `module.events.deliver(env)` to try again. Delivery is then at
least once, so a listener has to cope with the same event twice, such as by keying on the record's id. Delivery stops at the first
event that fails and tries again later, so order is kept, and an event that can never be delivered holds the ones behind it. The
place to look is the `_realtime_outbox` table in the owner's SQLite.

Retries are spaced by the outbox, not by the module. `storageOutbox` sets the alarm `retryAfterMs` ahead (30 seconds unless you pass
another) when a delivery fails, unless an earlier alarm is already set, and the next try runs when the owner's `alarm()` calls
`events.deliver(env)`. The wait doesn't grow, and nothing stops the tries: an event is tried every 30 seconds until `publish` takes
it. There's no give-up count for now: that's an assumption, to change once a stuck event is seen. `memoryOutbox` sets no alarm, so
its events are tried again on the next command or the next `events.deliver`.

A failure is never silent. Pass `onDeliveryFailed(failure, env)` to `implementContract(...).with({...})` and it's called each time
`publish` throws for an event, with `failure.event`, `failure.error`, `failure.attempt` (how many times this event has failed as
this isolate has seen it, so it starts again from 1 after a restart) and `failure.retrying` (true when an outbox keeps the event).
Without an outbox the event is gone, and the hook is called once with `retrying: false`. Without the hook, each failure goes to
`console.warn` with the event, its topic and the error. The hook runs after the next try is asked for, and an error from it is
logged and goes no further, so it can't lose the event. `contractChecks` breaks delivery on purpose to check the outbox, so its runs
print those warnings.

A contract can be served from more than one place, such as each record's owner for writes and a shared index for a list across
owners. Each place gives a handler for the commands it serves and a reason for the rest: `list: { reason: 'The index serves it' }`.
Register the procedures of each place, and pass every place to `contractChecks(owner, index)`, which checks the whole contract and
fails a command that no place serves.

`contractDocs(tasks)` writes one short plain-text page for people and models. `contractChecks(module).with({ registry, callerWith,
arrange, causes })` lists tests that run from the outside through the registry: each command with good and bad input, a caller
without the capability, a repeated requestId (one after the other and at the same time), each listed move, each unlisted move and
each listed failure. [`examples/tasks-module`](examples/tasks-module/GUIDE.md) is a full module built this way.

`contractChecks` also tries random runs of commands made from the contract, with [fast-check](https://fast-check.dev). A run starts a
few records in random states and sends a random string of moves, other writes and repeats of earlier requests. A listed move has to
land in its state, an unlisted one has to be refused, and a repeated `requestId` has to get the first answer and publish nothing. A
failure shrinks to the fewest steps and prints a seed and a path: pass them back as `properties: { seed, path }` to run that case
again. The runs send one record's input to each of its move commands, so those need to take the same input, such as `{ id }`. They
repeat only requests that succeeded, since a failed command keeps nothing with its `requestId` and a retry runs it again. A
module adds its own properties, with `@fast-check/vitest`, only for what the contract can't say.

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
  optimistic: (store) => store.update('messages.list', { channel }, (list) => [...list, { _id: 'pending', _creationTime: Date.now(), channel, body }]),
});
```
`examples/chat-worker` runs the data layer in workerd (`bun run e2e`).
