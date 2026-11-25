# Realtime

Realtime helps you build procedures for Cloudflare Workers. A procedure is one typed function that your app calls. For each procedure, you choose these nine things:

- authentication
- authorization
- input
- output
- errors
- analytics
- MCP
- CLI
- AI tools

The procedure doesn't compile until you choose all nine. To leave one out, you write down why. This makes each choice easy to see in a review.

A module can also start from a contract: one file with its records, commands, events and states as schemas. The procedures, tools, command line entries, types and a plain-text docs page come from it, and a set of contract checks tests any build of the module against it. See [Contracts](typescript/README.md#contracts).

The packages are `@builtbyfriends/realtime` and `@builtbyfriends/realtime-*` on npm. The code is in [`typescript/`](typescript/README.md). It has the builder, an HTTP handler, MCP, AI tools, analytics, a CLI, a Durable Object data layer and live queries.

## Use it with bwf

[bwf](https://github.com/builtbyfriends/platform) builds and deploys apps to Cloudflare Workers. `@builtbyfriends/realtime-bwf` connects Realtime to a bwf app. It's the only package here that knows about bwf, and a test checks that.

`@builtbyfriends/realtime-bwf` gives a bwf app:

- a Vite plugin that finds the procedures in `src/procedures/` and stops the build when a bwf route doesn't make the nine choices
- one middleware file that serves `/rpc`, `/mcp` and the AI tool endpoints
- live queries over bwf's live streams, and the link to `@builtbyfriends/realtime-data`

Native apps that sign in with a bearer token can listen to the same live streams. [The protocol notes](docs/live-protocol.md) describe the wire format, and there are small clients for [Swift](swift/README.md) and [Kotlin](kotlin/README.md). In JavaScript, pass `headers` to `createBwfLive`.

[`bwf/demo`](bwf/demo/README.md) is a full bwf app. Run `npm run demo` there to try each part against a real dev server. It needs Node.js 24.22 or newer.

## Install

```sh
npm install @builtbyfriends/realtime
```

Add the parts you need, such as `@builtbyfriends/realtime-http`, `@builtbyfriends/realtime-mcp` or `@builtbyfriends/realtime-bwf`.

## Try it

```sh
cd typescript
bun install
bun run check
```

## Folders

| Folder | What's in it |
| --- | --- |
| `typescript/` | The packages, examples and tests |
| `bwf/` | A demo bwf app and test code for the adapter |
| `docs/` | The live stream's wire protocol, for native clients |
| `swift/` | A Swift client for bwf live streams |
| `kotlin/` | A Kotlin client for bwf live streams |

## License

[MIT](LICENSE)
