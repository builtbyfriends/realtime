# Changes

## 0.7.0

- A contract can be served from more than one place. Each place gives a handler for the commands it serves and `{ reason }` for the rest, and registers only its own procedures. `contractChecks(owner, index)` checks the whole contract across the places, and fails a command that no place serves.
- `outbox` keeps each event until `publish` takes it. `storageOutbox(ctx.storage)` writes events to the owner's SQLite right after the handler, delivers them, removes each one once it's delivered, and sets the object's alarm when a delivery fails. The owner's `alarm()` calls `module.events.deliver(env)` to try again. Delivery is then at least once, so a listener has to cope with the same event twice. `memoryOutbox()` is the in-memory one for tests. `contractChecks` takes `breakDelivery` and checks that a failed delivery is kept and tried again.
- Moving up from 0.4: three types that got stricter between 0.4 and 0.6 by accident take what 0.4 took again, so an app on 0.4 moves up without edits.
  - A sync `view` can return any object again, such as a type built from interfaces. 0.6 asked for a `JsonObject`.
  - `data.client` takes a Durable Object namespace's stub without comparing the stub's `pull`, which made TypeScript stop with "excessively deep" on a real `DurableObjectStub`.
  - A live query plan's `output` takes anything with a Standard Schema `validate` again, as 0.4 did.
- A package built against Realtime 0.4, such as an older `@builtbyfriends/bwf`, has its own copy of Realtime's types, so its registry won't match 0.7's. Rebuild it against 0.7.0.

## 0.6.0

- An event's `topic` can be a list. The event goes out once on each topic.

## 0.5.0

- Contracts: `defineContract`, `implementContract`, `contractDocs` and `contractChecks`, with `memoryRunOnce` and `storageRunOnce`.
