import { fc, test } from '@fast-check/vitest';
import { expect } from 'vitest';
import { z } from 'zod';
import { defineRegistry } from '@builtbyfriends/realtime';
import { TaskStore, tasksModule } from '../src/module.js';
import type { Env } from '../src/module.js';

const env: Env = { API_TOKENS: JSON.stringify({ t: { id: 'u-1', capabilities: ['tasks.read', 'tasks.write'] } }) };
const request = new Request('https://tasks.test/rpc', { headers: { authorization: 'Bearer t' } });
const title = fc.string({ minLength: 1, maxLength: 100, unit: 'binary' }).filter((t) => t.trim().length > 0);

// Decision: contractChecks already tries random runs of moves and repeated request ids. A module adds a property only for what its
// contract can't say, such as a task reading back as it was written.
test.prop([title])('a created task reads back with the title it was given, trimmed', async (given) => {
  const registry = defineRegistry(tasksModule(new TaskStore()).procedures);
  const call = async (name: string, input: { title?: string; id?: string; requestId?: string }) => registry.call(name, input, { request, env, surface: 'direct', waitUntil: () => undefined });
  const created = await call('tasks.create', { title: given, requestId: crypto.randomUUID() });

  expect(created).toMatchObject({ ok: true, value: { title: given.trim(), state: 'open' } });

  const id = created.ok ? z.object({ id: z.string() }).parse(created.value).id : '';

  expect(await call('tasks.get', { id })).toEqual(created);
});
