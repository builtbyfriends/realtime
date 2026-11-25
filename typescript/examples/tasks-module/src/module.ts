import { z } from 'zod';
import { bearerAuth, implementContract, memoryRunOnce } from '@builtbyfriends/realtime';
import type { CommandArgs } from '@builtbyfriends/realtime';
import { tasks } from './contract.js';
import type { Task, TaskState } from './contract.js';

export type Env = { API_TOKENS: string };

export type Caller = { id: string; capabilities: ReadonlyArray<string> };

const Callers = z.record(z.string(), z.object({ id: z.string(), capabilities: z.array(z.string()) }));

const apiToken = bearerAuth<Caller, Env>({
  name: 'api-token',
  verify: (token, env) => {
    const callers = Callers.parse(JSON.parse(env.API_TOKENS));

    return Object.hasOwn(callers, token) ? (callers[token] ?? null) : null;
  },
  actorId: (caller) => caller.id,
});

// Decision: the example keeps its tasks in memory, so it runs with no setup. A real module keeps them with its owner, one Durable
// Object, and the run-once store sits next to them.
export class TaskStore {
  readonly tasks = new Map<string, Task>();
  private next = 0;

  add(title: string, createdBy: string, state: TaskState = 'open'): Task {
    this.next += 1;

    const task: Task = { id: `t-${this.next}`, title, state, createdBy };

    this.tasks.set(task.id, task);

    return task;
  }

  openWithTitle(title: string): Task | undefined {
    return [...this.tasks.values()].find((t) => t.title === title && t.state !== 'done');
  }
}

type MoveArgs = CommandArgs<typeof tasks, 'start' | 'finish' | 'reopen', Caller, Env>;

export function tasksModule(store: TaskStore) {
  const found = (id: string, fail: (code: 'NOT_FOUND') => never): Task => store.tasks.get(id) ?? fail('NOT_FOUND');

  const moveTask = ({ input, fail, move, emit }: MoveArgs): Task => {
    const task = found(input.id, fail);
    const next = { ...task, state: move(task.state) };

    store.tasks.set(task.id, next);
    emit('moved', { id: task.id, from: task.state, to: next.state });

    return next;
  };

  return implementContract(tasks).with({
    auth: apiToken,
    can: ({ ctx, capability }) => ctx.capabilities.includes(capability),
    analytics: { reason: 'The example runs without an analytics provider' },
    publish: { reason: 'The example has no live stream, and its tests read events from the module' },
    runOnce: memoryRunOnce(),
    commands: {
      create: ({ input, ctx, fail, emit }) => {
        if (store.openWithTitle(input.title)) {return fail('TITLE_TAKEN');}

        const task = store.add(input.title, ctx.id);

        emit('created', task);

        return task;
      },
      get: ({ input, fail }) => found(input.id, fail),
      list: ({ input }) =>
        [...store.tasks.values()].filter((t) => !input.state || t.state === input.state).toReversed(),
      start: (args) => moveTask(args),
      finish: (args) => moveTask(args),
      reopen: (args) => moveTask(args),
      remove: ({ input, fail, emit }) => {
        const task = found(input.id, fail);

        store.tasks.delete(task.id);
        emit('removed', { id: task.id });

        return { id: task.id };
      },
    },
  });
}
