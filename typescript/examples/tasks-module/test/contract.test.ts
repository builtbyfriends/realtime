import { describe, it } from 'vitest';
import { contractChecks, defineRegistry } from '@builtbyfriends/realtime';
import { TaskStore, tasksIndex, tasksModule } from '../src/module.js';
import type { Env } from '../src/module.js';

const store = new TaskStore();
const module = tasksModule(store);
const index = tasksIndex(store);
const registry = defineRegistry([...module.procedures, ...index.procedures]);
const callers = new Map<string, { id: string; capabilities: ReadonlyArray<string> }>();
const env: Env = { get API_TOKENS() { return JSON.stringify(Object.fromEntries(callers)); } };

const checks = contractChecks(module, index).with({
  registry,
  env,
  breakDelivery: () => {
    store.feedDown = true;

    return () => {
      store.feedDown = false;
    };
  },
  callerWith: (capabilities) => {
    const token = `t-${callers.size + 1}`;

    callers.set(token, { id: `u-${callers.size + 1}`, capabilities });

    return new Request('https://tasks.test/rpc', { headers: { authorization: `Bearer ${token}` } });
  },
  arrange: {
    create: () => ({ title: `Task ${crypto.randomUUID()}` }),
    get: () => ({ id: store.add('Read me', 'u-0').id }),
    list: () => ({ state: 'open' }),
    start: (state) => ({ id: store.add('Start me', 'u-0', state).id }),
    finish: (state) => ({ id: store.add('Finish me', 'u-0', state).id }),
    reopen: (state) => ({ id: store.add('Reopen me', 'u-0', state).id }),
    remove: () => ({ id: store.add('Remove me', 'u-0').id }),
  },
  causes: {
    create: { TITLE_TAKEN: () => ({ title: store.add(`Taken ${crypto.randomUUID()}`, 'u-0').title }) },
    get: { NOT_FOUND: () => ({ id: 'missing' }) },
    start: { NOT_FOUND: () => ({ id: 'missing' }) },
    finish: { NOT_FOUND: () => ({ id: 'missing' }) },
    reopen: { NOT_FOUND: () => ({ id: 'missing' }) },
    remove: { NOT_FOUND: () => ({ id: 'missing' }) },
  },
});

describe('tasks keeps its contract', () => {
  for (const check of checks) {it(check.name, check.run);}
});
