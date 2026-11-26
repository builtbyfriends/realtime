# Changes

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
