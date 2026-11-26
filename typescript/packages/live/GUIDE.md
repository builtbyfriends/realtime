# Live records in a window

A window gets a module's records live, typed from the contract, with one copy of each record. It changes them through the contract's commands, and a retry runs once. A feature writes a few lines for this and no plumbing.

This is the `records` part of `@builtbyfriends/realtime-live`. The older `createLive` layer, which tells a query it may be stale and asks again, sits next to it and still works. Pick one per feature.

## What a feature writes

Say what the module's records look like to the window, once, next to the feature:

```ts
export const noteRecords = defineRecords(notes, {
  records: {
    Note: {
      key: 'id',
      version: 'updatedAt',
      reads: { list: { boardId: 'boardId' }, get: { id: 'id' } },
      upserts: ['renamed'],
      removes: ['removed'],
    },
  },
  commands: {
    rename: { answers: 'Note', optimistic: ({ id, title }, { Note }) => Note.has(id) && Note.update(id, (d) => void (d.title = title)) },
    remove: { removes: 'Note', optimistic: ({ id }, { Note }) => Note.has(id) && Note.delete(id) },
  },
  views: { can: { events: ['renamed'], commands: ['rename'] } },
});
```

- `key` is the field that names a record. `version` is a field that gets bigger when the record changes. It's how a late or repeated event does no harm: a record only moves forward.
- `reads` lists the read commands that load the record, and which input field matches which record field. A list read takes `{ boardId }`, so a query for `boardId = 'b-1'` calls it.
- `upserts` lists events whose payload is the record after the change. `removes` lists events that carry the key of a record that's gone.
- A command with `answers` puts its answer into the collection. One with `removes` deletes the record named in its answer. `optimistic` shows the change at once, and it's undone when the command fails.

Then draw it:

```tsx
const { collections, commands } = useRecords(noteRecords);
const notes = useLiveQuery({ query: (q) => q.from({ n: collections.Note }).where(({ n }) => eq(n.boardId, boardId)) });
const one = useLiveQuery({ query: (q) => q.from({ n: collections.Note }).where(({ n }) => eq(n.id, id)) });
const can = useView(noteRecords, 'can', { id });

const intent = commands.rename({ id, title });
const result = await intent.result;
if (!result.ok) { /* result.error.code is a code the contract lists for rename */ }
```

The shell puts a `RecordsProvider` above the features, with the client and the event transport, once:

```tsx
<RecordsProvider client={client} transport={bwfTransport({ connect })}>
```

The list and the single view hold the same record. Rename it and both change in the same tick. If the command fails, both change back.

## How it works

- **One collection per record type.** It holds each record once, by `key`. It loads on demand: a query for `boardId = 'b-1'` calls the read that matches, and listens to the topics that read's input fills in. When the last query for it goes away, it stops listening.
- **One subscription for each topic.** Collections and views that follow the same topic share one subscription, and it ends when the last of them lets go. A feature never counts them.
- **Events carry the record.** The window applies the payload, checked against the contract. It listens to the topics of the events you list, filled from the read's input. A topic is used when all of its fields are in that input.
- **Newer wins.** A record replaces one with a smaller `version`. With an equal version it replaces the old one when the row differs, because a lost change is worse than a repeated one. A removed record needs a strictly newer version to come back. A contract whose version is a counter (1, 2, 3) has no ties, so prefer one when a record can change twice in the same millisecond. With ties, a stale repeat of an older tied row can win again; the counter avoids that too.
- **A reconnect loads again.** Every watched read runs again. A read also drops the records it listed last time and no longer lists, and a single read that answers `NOT_FOUND` drops its record. This holds when a screen was gone while the record was removed: what each read loaded is kept until the collection is cleaned up, so the next load can compare. A record that another watched read still lists stays.
- **A command is one intent.** `commands.rename(input)` makes one request id and gives it back as `requestId`. Pass `{ requestId }` as the second argument to retry: the module answers with the first result and runs nothing twice. The answer goes into the collection before the command settles.
- **Answers and events are checked** against the contract's schemas where they come in. A mismatch fails the load and is logged for an event. It's on in production too, since the cost is a schema parse per message. Turn it off only if it shows up in a profile.
- **Errors are typed.** `result.error.code` is one of the codes the command lists, plus the codes the pipeline adds (`UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_INPUT`, `INTERNAL`). A `switch` on it is checked by the compiler.

## What may I do now

A read that depends on who's asking sits beside the record as a view, because it isn't a property of the record. `useView(noteRecords, 'can', { id })` calls the read and keeps the answer. It loads again when:

- an event named in `views.can.events` arrives on a topic whose fields are all in the read's input,
- a command named in `views.can.commands` settles, or
- the connection comes back.

A view listens only while a component uses it. If a change can't be seen from either an event or a command of this window, the answer can be stale until the next one of those. A screen that needs it sooner calls `refresh()` on the handle (`runtime.views.can(input).refresh()`).

## When the server ends a subscription

An app can end a person's subscriptions with bwf's `stream.revoke()`, for example when they leave a project. bwf (1.13.8 or later) tells the window and doesn't subscribe the topic again, not after a reconnect either. `bwfTransport` handles that for live records:

- It asks for the topic again, once. The server's `onSubscribe` answers for the person as they are now, so the answer is yes or no for each topic.
- If the answer is yes, events keep coming. The ones published in between are lost, so every watched read loads again once, after all the topics that were asked for again.
- If the answer is no, the listeners of the topic hear about it once, and nothing asks again. The record keeps the rows it has and gets no more events. The same goes for a subscribe that the server refuses the first time.

The app hears a refusal in `onRefused`, on `RecordsProvider` or in the options of `createRuntime`:

```tsx
<RecordsProvider client={client} transport={transport} onRefused={({ name, topic, error }) => showNoAccess(topic, error)}>
```

It gets the record (`<contract>.<record>`), the topic and the error, which carries the server's `code`, such as `FORBIDDEN`. It's called once for each record and topic, until the record starts listening to that topic again, which happens when its last query lets go and a new one starts. Without it a warning goes to the console. A view that listens to the topic goes to its `error` state and keeps its last data. The records stay as they were: a feature that shouldn't show them any more removes them or hides the screen.

`fakeBackend` has `refuse(topic, error?)` for a test.

## Who acted

A module's event can say who ran the command (`actor`) and what acted for them (`via`, such as a thread that ran it for a person). The sign-in gives both, with `actorId` and `viaOf` on its auth provider, and Realtime treats them as plain text: rights stay with the caller.

Both labels go to each reader of the topic, so a sign-in shouldn't put anything private in them. `actor` is missing when the sign-in names no one, and on events an outbox kept before 0.10.0. `via` is missing when it names nothing.

bwf's transport passes the whole event on, but a feature can't see it yet. Live records read the payload, check it and keep the record, and no hook hands the checked event to a screen. When a screen needs to tell a person's tap from a thread's act, the first step is an optional `onEvent` in the options of the provider and `createRuntime`, called with the whole event after it passed the contract check.

## Tests and the dev page

`fakeBackend` from `@builtbyfriends/realtime-live/records/testing` runs a real module in the same process. Give it the registry and the module, and use its `client` and `transport` in the provider. Commands go through the module's own auth, schema checks, handlers and request id store, so a feature's test needs no backend. `deliver(event)` sends an event by hand, `reconnect()` simulates a drop, and `listenerCount()` shows what's still listening.

## Size

The records code is small: about 250 lines of ours. TanStack DB is not. Measured on 2026-11-26 with esbuild, minified and gzipped, with React and Realtime left out:

| Entry | Gzipped |
| --- | --- |
| `@builtbyfriends/realtime-live` (the older layer) | about 2 KB |
| `@builtbyfriends/realtime-live/records` | about 39 KB |
| `@builtbyfriends/realtime-live/records/react` (adds live queries) | about 85 KB |

An app that only imports the older layer doesn't bundle any of it. TanStack DB still installs, because it is a dependency of the package.

## Version

The records part is built on TanStack DB `1.0.0-rc.1.5` and `@tanstack/react-db` `1.0.0-rc.1.5`, both pinned exactly, read on 2026-11-26. It's pre-1.0, so move the pin on purpose and run the tests.

Where it had already moved, for the next bump:

- The package's bundled skill pages describe 0.6.17. `isPersisted.promise` on a transaction is gone; use `tx.when('settled')`.
- A collection's `gcTime: 0` turns garbage collection off, it doesn't mean "at once". A test that needs a query to let go uses `gcTime: 1`.
- A transaction with no change to show is never persisted, so its `mutationFn` doesn't run. `commands` sends the command itself in that case, otherwise a rename of a record that isn't loaded would do nothing.
- A sync commit made while a command is out is held until the command settles, then applied with the end of the optimistic change, so the screen doesn't flicker.
- A row from `collection.get` carries extra `$`-prefixed fields.

## What it can't do, or does badly

- A query with no `eq` or `in` filter that a read covers throws, such as a whole collection with no `where`. The message says which fields it saw. The first source of a join needs a `where` for this reason.
- A query it has no read for throws. A query on `title` for a list read that only takes `boardId` is a mistake in the feature, and the message says which fields it saw. Only `eq` and `in` filters map to reads.
- An optimistic change on a record that isn't loaded fails inside TanStack DB. Guard it with `Note.has(id)`, as above.
- The versions seen, the keys each read loaded and each view handle are kept in memory and only cleared when the collection is cleaned up. For a window with a few thousand records that's small. Clear them per subset when that stops being true.
- A removed record's version is gone once the collection is cleaned up.
- Thirty views of thirty different notes make thirty `get` requests at once, one for each view, and a browser queues them behind its six connections to a host. They finish and a command still comes back, but a screen with that many views of different records would do better to read them with one list. Loading them in one request is a later job, tracked in DED-560.
- When a subscribe call fails or is refused, the listeners of that topic stay with nothing feeding them until a record starts listening to the topic again. The app hears about it in `onRefused`, or the console gets a warning. A reconnect loads the reads again but doesn't ask for the topic again. If this shows up in real use, the fix is to subscribe again on reconnect.

## Assumptions for later

- **Paging.** The Thread screen doesn't need it. A list read returns everything in its scope. TanStack DB passes limits and cursors to a read when it's on demand, so adding it should mean a read with `limit` and `cursor` inputs and a line in the spec.
- **Offline writes and saving across restarts.** Not part of this. TanStack DB has persistence and an offline queue for them.
- **Catching up from a position.** The older sync path (change index and sync sockets) can ask for what happened after a position, which loads less than a full read after a drop. This layer loads again in full. Worth taking later when a list gets long.
- **Joins across modules.** Live queries can join two record types' collections, so a screen can show a thread with its ask without one feature reaching into the other. A test joins a note with its board and updates when either side changes. The side that is joined on loads with a list of keys, and each key calls the read once.
