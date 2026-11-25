import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { contractChecks, contractDocs, defineContract, defineRegistry, implementContract, memoryRunOnce, storageRunOnce } from '@builtbyfriends/realtime';
import type { ContractEvent, RunOnceStorage, RunOnceStore } from '@builtbyfriends/realtime';

const states = ['draft', 'sent'] as const;
const Note = z.object({ id: z.string(), body: z.string(), state: z.enum(states) });
const off = { reason: 'Covered by a unit test only' } as const;

const notes = defineContract({
  name: 'notes',
  description: 'A short note that can be sent once.',
  data: { Note },
  states: { record: 'Note', field: 'state', list: states, initial: 'draft', moves: { send: { from: ['draft'], to: 'sent' } } },
  requestIds: { keepHours: 1 },
  commands: {
    write: {
      description: 'Write a note.',
      effect: 'write',
      input: z.object({ body: z.string().min(1) }),
      output: Note,
      errors: {},
      capability: 'notes.write',
      tool: { needsApproval: false },
      cli: true,
      emits: ['written'],
    },
    send: {
      description: 'Send a note.',
      effect: 'write',
      input: z.object({ id: z.string() }),
      output: Note,
      errors: { NOT_FOUND: { status: 404, message: 'No such note' } },
      capability: 'notes.send',
      tool: off,
      cli: off,
      move: 'send',
    },
  },
  events: { written: { description: 'A note was written.', topic: ['notes:{id}', 'notes:{state}'], payload: Note } },
});

type Note = z.infer<typeof Note>;

type Mistakes = { skipMove?: boolean; skipEmit?: boolean; ignoreCapability?: boolean; badEvent?: boolean; dropTopic?: boolean };

type Caller = { id: string; caps: ReadonlyArray<string> };

function build(mistakes: Mistakes = {}, runOnce: RunOnceStore = memoryRunOnce()) {
  const store = new Map<string, Note>();
  let seq = 0;

  const add = (body: string, state: Note['state'] = 'draft') => {
    seq += 1;
    const note: Note = { id: `n-${seq}`, body, state };
    store.set(note.id, note);

    return note;
  };

  const callers = new Map<string, Caller>();

  const module = implementContract(notes).with({
    auth: { name: 'test', resolve: (request) => callers.get(request.headers.get('x-caller') ?? '') ?? null, actorId: (c: Caller) => c.id },
    can: ({ ctx, capability }) => mistakes.ignoreCapability === true || ctx.caps.includes(capability),
    analytics: off,
    publish: off,
    runOnce,
    commands: {
      write: ({ input, emit }) => {
        const note = add(input.body);

        if (mistakes.badEvent) {
          // Decision: the types refuse this payload, so the cast stands in for a build that bypassed them.
          emit('written', { id: note.id, body: note.body, state: 'lost' as 'draft' });
        } else if (!mistakes.skipEmit) {
          emit('written', note);
        }

        return note;
      },
      send: ({ input, fail, move }) => {
        const note = store.get(input.id) ?? fail('NOT_FOUND');
        const next: Note = { ...note, state: mistakes.skipMove ? 'sent' : move(note.state) };
        store.set(note.id, next);

        return next;
      },
    },
  });

  const registry = defineRegistry(module.procedures);

  const seenBy = (listener: (e: ContractEvent) => void) => (e: ContractEvent) => (mistakes.dropTopic && e.topic === 'notes:draft' ? undefined : listener(e));
  const observed = { ...module, events: { subscribe: (listener: (e: ContractEvent) => void) => module.events.subscribe(seenBy(listener)) } };

  const checks = contractChecks(observed).with({
    registry,
    callerWith: (caps) => {
      const id = `c-${callers.size + 1}`;
      callers.set(id, { id, caps });

      return new Request('https://notes.test/rpc', { headers: { 'x-caller': id } });
    },
    arrange: {
      write: () => ({ body: 'Hello' }),
      send: (state) => ({ id: add('Hello', state).id }),
    },
    causes: { send: { NOT_FOUND: () => ({ id: 'missing' }) } },
  });

  return { module, registry, checks, callers };
}

async function failures(mistakes: Mistakes): Promise<Array<string>> {
  const failed: Array<string> = [];

  for (const check of build(mistakes).checks) {
    try {
      await check.run();
    } catch (error) {
      failed.push(`${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return failed;
}

describe('defineContract', () => {
  it('lists each problem with what to change', () => {
    // Decision: the types refuse this contract, so the cast stands in for plain JavaScript that skipped them.
    expect(() =>
      defineContract({
        name: 'Bad Name',
        description: '',
        data: { note: Note },
        states: { record: 'Note', field: 'status', list: states, initial: 'gone', moves: { send: { from: ['nowhere'], to: 'sent' } } },
        commands: {
          send: {
            description: 'Send it.',
            effect: 'write',
            input: z.object({ id: z.string() }),
            output: z.object({ id: z.string() }),
            errors: {},
            capability: 'notes.send',
            tool: off,
            cli: off,
            move: 'archive',
            emits: ['archived'],
          },
        },
        events: {},
      } as any),
    ).toThrowErrorMatchingInlineSnapshot(`
      [Error: contract "Bad Name" has 10 problem(s):
        - name "Bad Name" has to be one lowercase word or camelCase, such as "tasks"
        - description is empty: say what the module is in one sentence
        - data.note: name a record in PascalCase, such as "Task"
        - commands.send.emits lists "archived", which is not in events (none)
        - commands.send writes, so the contract needs requestIds: { keepHours } to say how long a retry is recognised
        - commands.send.move "archive" is not in states.moves (send)
        - commands.send moves state, so its output has to carry the "status" field: return the Note
        - states.initial "gone" is not in states.list (draft, sent)
        - states.moves.send.from lists "nowhere", which is not in states.list (draft, sent)
        - states.record "Note" is not a record in data (note)]
    `);
  });

  it('checks that the state field is an enum of the listed states', () => {
    expect(() =>
      defineContract({
        name: 'notes',
        description: 'Notes.',
        data: { Note: z.object({ id: z.string(), state: z.string() }) },
        states: { record: 'Note', field: 'state', list: states, initial: 'draft', moves: {} },
        commands: {},
        events: {},
      }),
    ).toThrow('Note.state has to be an enum of exactly states.list (draft, sent), such as z.enum(states)');
  });

  it('checks each topic in a list against the payload', () => {
    const events = (topic: ReadonlyArray<string>) => ({ name: 'notes', description: 'Notes.', data: { Note }, commands: {}, events: { written: { description: 'A note was written.', topic, payload: Note } } });
    // Decision: the types refuse a topic field the payload doesn't have, so the cast stands in for plain JavaScript that skipped them.
    expect(() => defineContract(events(['notes:{id}', 'notes-by:{author}']) as any)).toThrow('events.written.topic[1] uses {author}, which is not a payload field (id, body, state)');
    expect(() => defineContract(events([]))).toThrow('events.written.topic is an empty list: name at least one topic');
    expect(() => defineContract(events(['notes:{id}', 'notes:{id}']))).toThrow('events.written.topic lists a topic twice');
  });
});

describe('implementContract', () => {
  it('lists what the implementation is missing', () => {
    // Decision: the types refuse this implementation, so the cast stands in for plain JavaScript that skipped them.
    expect(() => implementContract(notes).with({ auth: off, analytics: off, publish: off, commands: { extra: () => null } } as any)).toThrowErrorMatchingInlineSnapshot(`
      [Error: implementation of contract "notes" has 7 problem(s):
        - commands.write: add its handler
        - commands.write needs the capability "notes.write": pass can()
        - commands.write writes: pass runOnce, such as memoryRunOnce()
        - commands.send: add its handler
        - commands.send needs the capability "notes.send": pass can()
        - commands.send writes: pass runOnce, such as memoryRunOnce()
        - commands.extra is not in the contract: add it there or remove the handler]
    `);
  });

  it('publishes nothing and answers 500 when an event payload breaks its schema', async () => {
    const { module, registry, callers } = build({ badEvent: true });
    const seen: Array<ContractEvent> = [];
    module.events.subscribe((e) => seen.push(e));
    callers.set('c', { id: 'c', caps: ['notes.write'] });
    const errors: Array<unknown> = [];
    const quiet = defineRegistry(module.procedures, { onError: (e) => errors.push(e) });
    const result = await quiet.call('notes.write', { body: 'Hi', requestId: 'r1' }, { request: new Request('https://x', { headers: { 'x-caller': 'c' } }), env: {}, surface: 'direct' });
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(String(errors[0])).toContain('commands.write emitted "written" with a payload that doesn\'t match events.written.payload');
    expect(seen).toEqual([]);
    expect(registry.procedures.size).toBe(2);
  });

  it('publishes the event once on each topic, filled from the payload', async () => {
    const { module, callers } = build();
    const registry = defineRegistry(module.procedures);
    const seen: Array<ContractEvent> = [];
    module.events.subscribe((e) => seen.push(e));
    callers.set('c', { id: 'c', caps: ['notes.write'] });
    const waits: Array<Promise<unknown>> = [];
    await registry.call('notes.write', { body: 'Hi', requestId: 'r1' }, { request: new Request('https://x', { headers: { 'x-caller': 'c' } }), env: {}, surface: 'direct', waitUntil: (p) => void waits.push(p) });
    await Promise.all(waits);
    const payload = { id: 'n-1', body: 'Hi', state: 'draft' };
    expect(seen).toEqual([
      { module: 'notes', name: 'written', event: 'notes.written', topic: 'notes:n-1', payload },
      { module: 'notes', name: 'written', event: 'notes.written', topic: 'notes:draft', payload },
    ]);
  });
});

describe('memoryRunOnce', () => {
  it('shares one run between calls with the same key, at the same time or later', async () => {
    const store = memoryRunOnce();
    let runs = 0;
    const start = async () => ({ value: ++runs });
    const [a, b] = await Promise.all([store.run('k', 1000, start), store.run('k', 1000, start)]);
    const c = await store.run('k', 1000, start);
    expect([a, b, c, runs]).toEqual([{ value: 1 }, { value: 1 }, { value: 1 }, 1]);
  });

  it('keeps nothing from a run that throws, and lets a key go after its time', async () => {
    let now = 0;
    const store = memoryRunOnce(() => now);
    await expect(store.run('k', 1000, () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await store.run('k', 1000, async () => ({ value: 'second' }))).toEqual({ value: 'second' });
    now = 1000;
    expect(await store.run('k', 1000, async () => ({ value: 'third' }))).toEqual({ value: 'third' });
  });
});

function sqliteStorage(db = new DatabaseSync(':memory:')): RunOnceStorage {
  // Decision: node:sqlite rows have the same columns a Durable Object's SQLite returns for these queries.
  return { sql: { exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) as Array<any> }) } };
}

describe('storageRunOnce', () => {
  it('gives the first result after a restart, and lets a key go after its time', async () => {
    const db = new DatabaseSync(':memory:');
    let now = 0;
    const first = storageRunOnce(sqliteStorage(db), () => now);
    expect(await first.run('k', 1000, async () => ({ value: { id: 'n-1' } }))).toEqual({ value: { id: 'n-1' } });
    const restarted = storageRunOnce(sqliteStorage(db), () => now);
    expect(await restarted.run('k', 1000, async () => ({ value: 'second' }))).toEqual({ value: { id: 'n-1' } });
    now = 1000;
    expect(await restarted.run('k', 1000, async () => ({ value: 'third' }))).toEqual({ value: 'third' });
    expect(db.prepare('SELECT count(*) AS n FROM _realtime_run_once').get()).toEqual({ n: 1 });
  });

  it('keeps nothing from a run that throws', async () => {
    const store = storageRunOnce(sqliteStorage());
    await expect(store.run('k', 1000, () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await store.run('k', 1000, async () => ({ value: 'again' }))).toEqual({ value: 'again' });
  });

  it('passes the retry checks', async () => {
    const retries = build({}, storageRunOnce(sqliteStorage())).checks.filter((c) => c.name.includes('runs once'));
    expect(retries).toHaveLength(4);

    for (const check of retries) {await check.run();}
  });
});

describe('contractChecks', () => {
  it('passes a build that keeps the contract', async () => {
    expect(await failures({})).toEqual([]);
  });

  it('names the check and what to change when a build skips the state list', async () => {
    expect(await failures({ skipMove: true })).toEqual([
      'notes.send refuses send from sent: notes.send from sent: expected MOVE_NOT_ALLOWED, got ok {"id":"n-10","body":"Hello","state":"sent"}. The contract doesn\'t list send from sent: call move(current) in the handler.',
    ]);
  });

  it('fails a build that leaves out a listed event', async () => {
    expect(await failures({ skipEmit: true })).toEqual([
      'notes.write accepts good input: notes.write: succeeded without emitting "written", which it lists in emits. Emit it, or take it out of emits.',
    ]);
  });

  it('fails a build that leaves out one of an event\'s topics', async () => {
    expect(await failures({ dropTopic: true })).toEqual([
      'notes.write accepts good input: notes.write: emitted "written" without publishing it on notes:{state}, which events.written.topic lists',
    ]);
  });

  it('fails a build that ignores the capability', async () => {
    const failed = await failures({ ignoreCapability: true });
    expect(failed.map((f) => f.split(':')[0])).toEqual(['notes.write refuses a caller without notes.write', 'notes.send refuses a caller without notes.send']);
  });

  it('covers each command, bad input, capability, retry, move and listed failure', () => {
    expect(build().checks.map((c) => c.name)).toEqual([
      'notes.write accepts good input',
      'notes.write refuses bad input',
      'notes.write refuses a caller without notes.write',
      'notes.write runs once when a requestId repeats',
      'notes.write runs once when a requestId comes twice at the same time',
      'notes.send accepts good input',
      'notes.send refuses bad input',
      'notes.send refuses a caller without notes.send',
      'notes.send runs once when a requestId repeats',
      'notes.send runs once when a requestId comes twice at the same time',
      'notes.send moves send: draft -> sent',
      'notes.send refuses send from sent',
      'notes.send fails with NOT_FOUND',
    ]);
  });
});

describe('contractDocs', () => {
  it('writes one plain-text page from the contract', () => {
    expect(contractDocs(notes)).toMatchSnapshot();
  });
});
