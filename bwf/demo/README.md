# realtime on bwf: the demo

A small contacts API built the way the [adapter](../../typescript/packages/bwf) is meant to be used: a bwf app with the `realtime()` Vite plugin, one middleware file, and one Analytics Engine line. Eight procedures cover every concern, every opt-out, profiles, a webhook, and all four surfaces (HTTP, MCP, CLI, AI tools). Data is in D1 through `@builtbyfriends/bwf/db`.

Everything below was run for real on 2026-11-13. Full transcripts are in [output/demo.txt](output/demo.txt) and [output/failures.txt](output/failures.txt).

## Run it

Needs Node 24.22 or later (bwf requires it).

```sh
npm install          # also links ../../typescript/node_modules, so the demo uses this repo's source
npx bwf db seed     # creates the local D1 database: 3 contacts, 3 API tokens
npm run demo         # starts `vite dev`, calls every surface, prints what came back
npm run failures     # shows every way an incomplete procedure gets stopped
npm run dev          # just the app, at http://localhost:5173 (call visualizers at /__realtime)
npm run visualize    # starts the app, sends traffic on every surface, then open /__realtime
```

Tokens: `demo-alice` (admin, org o1), `demo-bob` (member, org o1), `demo-grace` (member, org o2).

## What the app author writes

The setup is three small pieces:

| File | What it is |
| --- | --- |
| `vite.config.ts` | `plugins: [bwfPlugin(), realtime()]`. The source aliases below that are there so the demo runs on this repo's source. |
| `middleware/00.realtime.ts` | One line, written by `npx realtime init`: `export { default } from '@builtbyfriends/realtime-bwf/middleware'` |
| `bwf.config.ts` | The Analytics Engine line. bwf can't infer that binding from an import. |

The rest is ordinary app code: procedures in `src/procedures/`, schema in `db/schema.ts`. There's no registry file, no route files and no Worker `fetch`, and `env` is typed without a generic.

## The procedures

| Procedure | Shows |
| --- | --- |
| `contacts.get` | Every concern decided, using the `signed-in` profile. Has a declared `NOT_FOUND` error. Opts out of AI tools with a reason (returns PII). |
| `contacts.search` | Exposed everywhere. Input defaults (`limit = 10`). AI tool with `needsApproval: false`. `noErrors` with a reason. |
| `contacts.create` | A write: `DUPLICATE_EMAIL` (409), analytics props, MCP `effect: 'write'`, AI tool with `needsApproval: true`. |
| `contacts.delete` | The `admin-only` profile, which decides auth, authz (`admin`) and `noCli` in one `.use()`. MCP `effect: 'destructive'`. |
| `me` | `noInput()`, `noAuthz` and `noAnalytics`, each with a reason. |
| `status` | Opts out of everything that allows it. `output` has no opt-out. |
| `assistant.ask` | An agent inside the app: calls Claude with the app's AI tools as the signed-in user, pauses when a tool needs approval. Opts out of MCP, CLI and AI tools with reasons. |
| `billing.paymentReceived` | A webhook: `noAuth`, but still validated input and output, a declared 422, and analytics. HTTP only. |

Every decision for every procedure is in [audit.md](audit.md), which the demo regenerates. A pull request that changes a decision (say, `contacts.get` switching to `noAuth`) shows up there as a one-line diff.

## What the demo shows (excerpts from output/demo.txt)

**HTTP.** Each outcome the pipeline can produce, from the real dev server:

```
POST /rpc/contacts.get  (Bearer demo-bob)  {"orgId":"o1","id":"c1"}   200 {"data":{"id":"c1",...,"name":"Ada Lovelace"}}
POST /rpc/contacts.get  {"orgId":"o1","id":"c1"}                      401 UNAUTHENTICATED
POST /rpc/contacts.get  (Bearer demo-bob)  {"orgId":1}                400 INVALID_INPUT, issues for orgId and id
POST /rpc/contacts.get  (Bearer demo-bob)  {"orgId":"o2","id":"c3"}   403 FORBIDDEN (policy same-org)
POST /rpc/contacts.get  (Bearer demo-bob)  {"orgId":"o1","id":"nope"} 404 NOT_FOUND (declared)
POST /rpc/contacts.create  (same email twice)                         409 DUPLICATE_EMAIL (declared)
POST /rpc/contacts.delete  (Bearer demo-bob, a member)                403 FORBIDDEN (admin-only profile)
POST /rpc/me  {"sneaky":true}                                         400 "This procedure takes no input"
POST /rpc/billing.paymentReceived  {"orgId":"x9",...}                 422 UNKNOWN_ORG (declared)
```

**MCP** (`/mcp`, real MCP client). Only the five procedures that chose `.mcp()` are listed. The `effect` decision sets the annotations, so `contacts_delete` carries `destructiveHint: true`. Calls go through the same auth, validation and authz as HTTP.

**CLI** (`realtime`, built from the Worker's manifest). `contacts delete` doesn't exist because the `admin-only` profile chose `noCli`. Flags come from the input schema:

```
$ realtime contacts search --help
contacts search: Search contacts by name

  --org-id <string> (required)
  --query <string> (required)
  --limit <integer>
  --json <object>  pass the whole input as JSON

$ realtime contacts get --org-id o2 --id c3
error FORBIDDEN: Not allowed          (exit code 1)
```

**AI tools.** `GET /rpc/ai/tools.json` returns definitions you can pass straight to `messages.create({ tools })`, for the four procedures that chose `.aiTool()`. `POST /rpc/ai/run` runs one tool call as the token's user:
- `contacts_create` returns `needs_approval`. The caller can't approve its own call: the request body carries no approval. An app that wants held tools to run over HTTP calls `approveAiRuns()` from `@builtbyfriends/realtime-bwf` and answers from an approval a person stored.
- Grace (org o2) searching org o1 gets `FORBIDDEN`.
- `contacts_get` doesn't exist as a tool.

**Analytics.** One event per call that reached the handler, tagged with the surface it came from:

```
contacts.searched  http ok    200  actor=u-bob {"orgId":"o1","limit":10}
contact.created    http error 409  actor=u-bob {"orgId":"o1"}
contacts.searched  mcp  ok    200  actor=u-bob {"orgId":"o1","limit":10}
contacts.searched  cli  ok    200  actor=u-bob {"orgId":"o1","limit":1}
contact.created    ai   ok    200  actor=u-bob {"orgId":"o1"}
```

## What an agent sees when it cuts corners (output/failures.txt)

**1. Type gate** (`tsc`, run before `bwf deploy`). The mistakes in [failures/type-mistakes.ts](failures/type-mistakes.ts) each get a message that says what to do:

```
'"Undecided: authz, errors, analytics, cli, aiTool. Decide each one (or opt out with a reason) before .handler()"'
'"Opt-out reason must say why in at least three words, e.g. \"Public marketing data with no user context\""'
Argument of type '"ALREADY_ARCHIVED"' is not assignable to parameter of type '"NOT_FOUND"'.
'"Decide authentication first: call .auth(provider) or .noAuth({ reason }) before .authz()"'
Property 'input' does not exist on type 'Builder<...>'                 (deciding twice)
Property 'effect' is missing in type '{ description: string; }' but required in type 'McpSpec'.
Property 'needsApproval' is missing in type '{ description: string; }' but required in type 'AiToolSpec'.
Type 'string' is not assignable to type 'number'.                     (handler output vs output schema)
```

**2. Load gate.** [failures/hidden-with-any.ts](failures/hidden-with-any.ts) hides its gaps with `as any`. `vite build` succeeds because bundlers don't type-check, but the built Worker refuses to start, so Cloudflare rejects the deploy:

```
Uncaught Error: realtime registry has 8 problem(s):
  - "contacts.sneaky": undecided: authz, input, errors, analytics, mcp, cli, aiTool
  - "contacts.weak": authn opt-out: "todo" is a placeholder, not a reason
  ...
```

**3. Route guard.** A plain bwf route in `routes/` would skip all nine decisions, so the build fails:

```
realtime found 1 problem(s):
  - routes/api/contacts.ts is a plain bwf route, so it skips auth, authz, input, output, errors, analytics,
    MCP, CLI and AI tool decisions. Move it to src/procedures/ as a procedure, or keep it and add
    "// realtime-allow: <why this must be a raw route>" (at least three words).
```

**4. Escape hatch.** The same route builds fine once it states a reason, for example `// realtime-allow: Stripe needs a raw body for signature checks`.

**5. Missing middleware file.** Nothing would serve `/rpc` or load the registry at startup, so the build fails and says how to fix it.

## Where the code is

- `../../typescript/packages/bwf/`: the new `@builtbyfriends/realtime-bwf` package (about 180 lines). It has three parts:
  - `plugin.ts` finds procedures and runs the route guard and stub check.
  - `middleware.ts` serves `/rpc`, `/mcp`, the AI tool endpoints and the dev-only `audit.md` and `/__realtime`.
  - `devtools.ts` and `devtools.html` are the call visualizers (dev only).
  - `index.ts` exports `procedure` and `profile` typed with bwf's env, plus the `apiTokens()` provider.
- The other Realtime packages are used unchanged.

## Call visualizers (/__realtime)

Under `vite dev`, the realtime middleware serves a devtools page at `/__realtime`, and Vite prints its URL next to its own. There's nothing to configure. `vite build` drops it: the bundle has no trace of the page or the recorder (checked by grepping the built Worker).

It has three views. Each call shows its journey through the decisions: the surface it came in on, authentication, input, authorization, the handler, output, errors and the analytics event. Steps that failed are red, opt-outs show their reason, and steps after a failure show as not reached.

- **Network.** Every request realtime answered (HTTP, CLI, MCP, AI tools) and every outbound fetch the Worker made, including model API calls. Filter by surface or name. Shows headers (tokens masked) and both bodies.
- **MCP.** One row per JSON-RPC message: `initialize`, `tools/list` (tools with their read, write or destructive effect) and each `tools/call` with its arguments, what the client got back, and the journey.
- **AI chat.** Conversations rebuilt from the Anthropic Messages calls the Worker makes: the person's messages, the model's replies, and each tool call inline with its approval state (runs without approval, waiting, approved), its result and its journey. Agents outside the app that call `/rpc/ai/run` show as tool calls grouped by token.

`npm run visualize` fills it with real traffic. The in-app assistant talks to a scripted stand-in model (`scripts/fake-model.mjs`) so it runs without an API key. Set `ANTHROPIC_API_KEY` in `.env` and it talks to Claude instead.

| | |
| --- | --- |
| ![Network: a 403 from the same-org policy](output/visualizers/1-network-403.png) | ![Network: a declared 409](output/visualizers/2-network-409.png) |
| ![MCP: tools/list](output/visualizers/3-mcp-tools-list.png) | ![MCP: a forbidden tool call](output/visualizers/4-mcp-call-forbidden.png) |
| ![AI chat: approved tool call](output/visualizers/5-chat-approved.png) | ![AI chat: waiting for approval](output/visualizers/6-chat-waiting.png) |

How it works: the registry has a `trace` channel that records each step of a call, but only while something subscribes, so production pays nothing. The AI tool runner reports the approval gate on the same channel. The middleware ties each step to the request that carried it.

## Not in this demo yet

- **Better Auth.** Tokens are SHA-256 hashes in a D1 table read by `apiTokens()`. Sessions and Better Auth API keys come next.
- **Names from file paths.** Procedures still name themselves (`procedure('contacts.get')`). That needs a small core change.
- **`npx realtime init`.** The middleware file and config line are written by hand here.
- **Real deploy.** Not run with `bwf deploy` to Cloudflare, which needs your account. The load gate was checked by starting the built Worker in Miniflare, which uses the same runtime as Cloudflare.
- **Dev analytics logging.** In dev, analytics events are also printed to the console. That's how the demo collects them; production writes only to Analytics Engine.
