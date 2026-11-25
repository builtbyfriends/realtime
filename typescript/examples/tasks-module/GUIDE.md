# tasks

A small example module built from one contract file. Copy it to start a new module.

## Files

| File | What it holds |
| --- | --- |
| `src/contract.ts` | The contract: records, commands, events and states, as schemas. The types come from here too. |
| `src/module.ts` | The handlers and the ports: who's calling, the capability check, where events go and where request ids live. |
| `src/worker.ts` | The registry and the Worker that serves `/rpc` and `/mcp`. |
| `tasks.txt` | The plain-text docs page, generated from the contract. Don't edit it by hand. |
| `test/contract.test.ts` | The contract checks, run against this build of the module. |
| `test/audit.md` | Every decision for every command, generated from the contract. |

## States

A task is open, doing or done. `start` moves it from open to doing, `finish` from doing to done, and `reopen` from doing or done back to open. A move the contract doesn't list is refused with MOVE_NOT_ALLOWED.

## Rules the types can't show

- A handler changes state only through `move(current)`, so the contract's list is the one place moves are allowed.
- A write takes a `requestId`. A repeat with the same id gets the first result and publishes nothing.
- Events go out after the handler returns, and only when it succeeds. `created` goes out on two topics: the task's own and its creator's.
- The tasks live in memory, so they go when the Worker restarts. A real module keeps them with its own Durable Object.

## Check it

From `typescript/`:

```sh
npx vitest run examples/tasks-module
npx tsc -p examples/tasks-module/tsconfig.json
```

After a change to the contract, run the tests with `-u` to write the new `tasks.txt` and `audit.md`, and read the diff.
