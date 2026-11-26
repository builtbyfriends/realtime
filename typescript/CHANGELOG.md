# Changes

## 0.10.0

- A module's event says who ran the command and what acted for them. `ContractEvent` has two new optional fields, `actor` and `via`.
  - `actor` is the id the auth provider's `actorId` gives for the caller. It's left out when the sign-in names no one, and it's missing on events an outbox kept before this release.
  - `via` is a plain label for what acted for the caller, such as a thread that ran a command for a person. An auth provider gives it with the new optional `viaOf(ctx)`, and `bearerAuth` takes it as an option. `anyOf` asks the provider that resolved the caller, as it does for `actorId`. Realtime doesn't read it, compare it or use it for rights: those stay with the caller. It's left out when the sign-in names nothing.
  - A provider that throws while naming either doesn't fail the command; the event goes out without that label.
  - The run-once key is unchanged: the caller and the request id, without `via`.
  - Both labels go to everyone who reads the topic, so a sign-in shouldn't put anything private in them.
- `contractChecks` takes `callerLabels` in its fixtures. With it, an event from a named caller has to carry that caller's `actor`, an event from an unnamed one carries none, and `via` follows the same way.
- The page `contractDocs` prints says that each event carries both.
- bwf's transport and live records already pass the whole event on. A browser run in `bwf/live-e2e` publishes through a sign-in that names `via` and sees both labels in the window.

## 0.9.2

- bwf's transport gives live records the event a module published. bwf delivers it inside an envelope (`{ subscriptionId, topic, type, data }`), and records read the envelope as the record, so every live event failed the contract check and the window only changed when it loaded again. The unit tests missed it because their fake hands over the module's event as it is. A browser run against a real bwf stream found it. The transport now passes `data` when it holds a module event, names a bare payload by the envelope's `type`, and leaves anything else as it was.
- New: `bwf/live-e2e`, a small bwf app and a Chromium run (`npm test` there, and a `live-browser` job in CI). It runs live records on the real bwf transport and counts what the browser opens:
  - Three views and sixty views of one note open one stream, send two subscribe operations and make two requests for the same counts.
  - Thirty views of thirty notes keep to one stream and one subscription for each topic, and a command comes back while they're open.
  - An event another window caused changes the record and makes no new request.
  - A cut connection that comes back loads again and leaves the newest record.

## 0.9.1

- Live records keep one subscription for each topic. Before, a record with three events and a view on the same topic opened four, and with a transport that opens a stream for each subscription a browser ran out of its six connections to a host, so commands waited behind them. Every collection and view of one transport now shares one subscription for each topic and one reconnect listener, and the subscription ends when the last listener goes. A test counts them. bwf's transport already shared one subscription for each topic.

## 0.9.0

- `@builtbyfriends/realtime-live` has a new `records` part: one typed copy of each record in a window, loaded and kept live from a contract, with commands that show their change at once, roll back on a failure, and run once when retried. It's built on TanStack DB, pinned at `1.0.0-rc.1.5`. Read `packages/live/GUIDE.md`.
  - `defineRecords(contract, spec)` and `createRuntime` in `@builtbyfriends/realtime-live/records`.
  - `RecordsProvider`, `useRecords`, `useView` and `useLiveQuery` in `@builtbyfriends/realtime-live/records/react`.
  - `fakeBackend` in `@builtbyfriends/realtime-live/records/testing`, which runs a real module in the same process.
- It adds about 39 KB gzipped (85 KB with the React entry) to an app that imports it. An app that imports only the older layer doesn't bundle it.
- `LiveTransport.subscribe` passes the published event to its callback when the transport has it, and bwf's transport does. The older layer ignores it.
- The older live layer is unchanged and sits beside the new one.

## 0.8.1

- A `Registry` of no particular procedures types `~procedures` as `object` again, not as a string index of procedures. An app whose procedure map is an interface, as bwf's codegen writes it, fits `createClient<App>` and `createBwfLive<App>` again, as on 0.4. Between 0.7.0 and 0.8.0 it failed with "Index signature for type 'string' is missing". A registry built from its procedures types its map from them, as before.

## 0.8.0

- `contractChecks` also tries random runs of commands, made from the contract with fast-check. Each run starts a few records in random states, then sends a random string of moves, the other writes and repeats of earlier requests. A listed move has to land in its state, an unlisted one has to be refused and leave the record where it was, and a request sent again with its `requestId` has to get the first answer and publish nothing. This finds orders nobody wrote a test for, such as a repeat that comes after the record has moved on.
- A failure shrinks to the fewest steps and prints them with a seed and a path. Pass them back as `properties: { seed, path }` in the fixtures to run that case again, and keep them in the test once it's fixed. `properties.runs` (100 by default) and `properties.steps` (20 by default) set how much it tries. The tasks example runs 100 in about 20 ms.
- Assumption: the move commands of one record take the same input, such as `{ id }`. The runs make each record with `arrange` of the first move command and send that input to each move. A contract whose moves need different inputs gets a failure that says so, and the fixtures will get a way to say how once one turns up.
- A failed command keeps nothing with its `requestId`, as before, so the runs only repeat requests that succeeded.
- `fast-check` is now a dependency of `@builtbyfriends/realtime`. The tasks example shows a property of its own with `@fast-check/vitest`, for what the contract can't say.

## 0.7.0

- A contract can be served from more than one place. Each place gives a handler for the commands it serves and `{ reason }` for the rest, and registers only its own procedures. `contractChecks(owner, index)` checks the whole contract across the places, and fails a command that no place serves.
- `outbox` keeps each event until `publish` takes it. `storageOutbox(ctx.storage)` writes events to the owner's SQLite right after the handler, delivers them, removes each one once it's delivered, and sets the object's alarm when a delivery fails. The owner's `alarm()` calls `module.events.deliver(env)` to try again. Delivery is then at least once, so a listener has to cope with the same event twice. `memoryOutbox()` is the in-memory one for tests. `contractChecks` takes `breakDelivery` and checks that a failed delivery is kept and tried again.
- Moving up from 0.4: three types that got stricter between 0.4 and 0.6 by accident take what 0.4 took again, so an app on 0.4 moves up without edits.
  - A sync `view` can return any object again, such as a type built from interfaces. 0.6 asked for a `JsonObject`.
  - `data.client` takes a Durable Object namespace's stub without comparing the stub's `pull`, which made TypeScript stop with "excessively deep" on a real `DurableObjectStub`.
  - A live query plan's `output` takes anything with a Standard Schema `validate` again, as 0.4 did.
- Delivery stops at the first event that fails and tries again later, so order is kept, and an event that can never be delivered holds the ones behind it. Look in the `_realtime_outbox` table. There is no give-up count yet.
- A package built against Realtime 0.4, such as an older `@builtbyfriends/bwf`, has its own copy of Realtime's types, so its registry won't match 0.7's. Rebuild it against 0.7.0.

## 0.6.0

- An event's `topic` can be a list. The event goes out once on each topic.

## 0.5.0

- Contracts: `defineContract`, `implementContract`, `contractDocs` and `contractChecks`, with `memoryRunOnce` and `storageRunOnce`.
