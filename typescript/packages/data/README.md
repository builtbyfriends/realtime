# @builtbyfriends/realtime-data

One Durable Object per deployment: transactional SQLite documents, indexes, FTS5, vectors and cancellable scheduled jobs.

It's part of [Realtime](https://github.com/builtbyfriends/realtime), a procedure builder for Cloudflare Workers.

```sh
npm install @builtbyfriends/realtime-data
```

## Sync

Sync keeps a device's copy of your data current. The device opens one WebSocket to the data object. It loads what it can read, then hears about each commit as it happens. A device that was offline asks for what it missed with `pull`.

Sync tends to fit things people watch, like a chat or a task board. The object sends the changed documents in the message, so the device doesn't refetch.

### Mark a table for sync

Give a table a `sync` option. `group` says which group each document belongs to. Return `null` to keep a document off devices. Return an array to put it in several groups.

```ts
import { defineData, defineSchema, table } from '@builtbyfriends/realtime-data';

type Note = { room: string; text: string; secret?: string };

const schema = defineSchema({
  notes: table<Note>({
    sync: {
      group: (note) => `room:${note.room}`,
      fields: ['room', 'text'],
      view: (note, reader) => (note.secret && reader.actor !== 'admin' ? null : note),
    },
  }),
});
```

- `fields` lists what a device gets. Leave it out to send every field. `_id` and `_creationTime` are sent either way.
- `view` shapes a document for one reader, or returns `null` to leave the change out. It runs once per reader for each change, so keep its reads few.

### Hooks on defineData

```ts
const data = defineData({
  schema,
  functions: ({ mutation }) => ({
    add: mutation((ctx, a: { room: string; text: string }) => ctx.db.insert('notes', a)),
  }),
  syncAccess: (ctx, actor, group) => group.startsWith('room:'),
  syncRecheck: (topics) => topics.includes('members'),
  syncTopics: (ctx, actor, topic) => topic.startsWith('notes'),
  syncQuery: (actor, name, input) => (name === 'notes.list' ? { fn: 'list', args: input } : null),
  onChanges: (batch, env) => {},
});
```

| Hook | What it does |
| --- | --- |
| `syncAccess(ctx, actor, group)` | Says if `actor` may read a group. The object asks it when a device sends `watch`. Without it, devices read only the groups the door gave them. |
| `syncRecheck(topics)` | Runs after a commit, with the topics it touched. Say `false` when nobody's access changed. Only a plain `false` skips the check. Anything else, including nothing or a promise, checks every open socket's groups again with `syncAccess`. |
| `syncTopics(ctx, actor, topic)` | Says if `actor` may hear a live topic. Without it, every `listen` is refused. |
| `syncQuery(actor, name, input)` | Picks the query function that answers a live query. It returns `{ fn, args, output? }`, or `null` to refuse. `output` is a Standard Schema checked before the answer goes out. |
| `onChanges(batch, env)` | Runs after a commit that touched synced tables. It's started and not awaited, and devices that miss it catch up with `pull`. |

### Open a socket from the door

The door is the Worker in front of the data object. It decides who the caller is and which groups they start with. `syncRequest` builds the request to forward. It replaces any sync header the device sent.

```ts
import { syncRequest } from '@builtbyfriends/realtime-data';

export default {
  async fetch(request: Request, env: Env) {
    const actor = await whoIsCalling(request);
    if (!actor) return new Response('unauthorized', { status: 401 });
    const stub = env.DEPLOYMENT.get(env.DEPLOYMENT.idFromName('main'));
    return stub.fetch(syncRequest(request, { actor, groups: [`user:${actor}`] }));
  },
};
```

The request has to be a WebSocket upgrade, or the object answers 426.

### Messages

All messages are JSON text frames. Messages with an `id` get an answer with the same `id`.

| Message | From | What it does |
| --- | --- | --- |
| `pull` | device | Asks for changes after position `after`. The answer is `pull` with `seq`, `changes` and `more`. |
| `watch` | device | Asks to read more groups, with an optional `after`. The answer is `watching`, with the groups allowed, the `denied` ones and the first changes. |
| `unwatch` | device | Stops reading some groups. |
| `changes` | object | Sent after a commit that touches the socket's groups. |
| `groups` | object | Says which groups were `added` and `removed`. Drop what's in `removed`. |
| `listen` | device | Asks to hear live topics. The answer is `listening`. |
| `unlisten` | device | Stops hearing topics. |
| `topics` | object | A commit touched topics you hear. Refetch what reads them. |
| `unheard` | object | Topics you may no longer hear. Get them some other way. |
| `query` | device | Asks a live query by `name`, `input` and `topics`. |
| `result` | object | The answer, sent again when a commit changes it. It can say `denied` or carry an `error`. |
| `unquery` | device | Stops live queries by `ids`. |

`pull` and `watching` answers carry an `epoch`. A position only means something inside its epoch. When a device sees a new one, it should drop its positions and load its groups again.

### Limits

- A socket attachment holds up to 16,000 bytes. Too many groups for that makes the object refuse the socket.
- One live query result holds up to 900,000 bytes. A bigger one is sent as an `error`, and the device fetches it another way.
- One message checks up to 1000 groups or topics. The rest are refused.
- A pull page holds up to 500 changes, and fewer when they wouldn't fit in one message.
- Close code 1011 means the object couldn't serve the socket. The device should load what it shows again and reconnect.

## Mutations

A mutation runs in one SQLite transaction, so a throw rolls back its writes and any jobs it scheduled. That also means it's synchronous. If it returns a promise, the object refuses it, so do async work in a job. Don't write after an `await`: the transaction has ended by then, and the database is closed to writes.

## Jobs

Jobs come from `scheduler.runAfter(ms, name, args)` and may be async.

- Jobs tend to run one at a time. Mark one `concurrent` to start it at once without holding up the rest.
- A plain job that hangs gives up its place in line after `laneMs`, which is two minutes unless you change it.
- A job that throws is retried with a growing delay, up to `maxJobAttempts` tries (5 unless you change it). After that it's parked as failed.
- A run that never ended, because the object went down or a deploy cut it short, also counts. After ten of those the job is parked.

```ts
const data = defineData({
  schema,
  functions: ({ mutation }) => ({
    remind: mutation((ctx, a: { id: string }) => void ctx.scheduler.runAfter(60_000, 'sendReminder', a)),
  }),
  jobs: (job) => ({
    sendReminder: job(async (ctx, args: { id: string }) => {}, { concurrent: true }),
  }),
  maxJobAttempts: 3,
});
```

MIT license.
