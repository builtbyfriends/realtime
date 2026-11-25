import { z } from 'zod';
import { defineContract } from '@builtbyfriends/realtime';
import type { RecordOf, StateOf } from '@builtbyfriends/realtime';

const states = ['open', 'doing', 'done'] as const;

const Task = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(states),
  createdBy: z.string(),
});

const ById = z.object({ id: z.string().min(1) });
const notFound = { NOT_FOUND: { status: 404, message: 'No task with this id' } } as const;
const asTool = { needsApproval: false } as const;

export const tasks = defineContract({
  name: 'tasks',
  description: 'A piece of work that someone opens, starts and finishes.',
  data: { Task },
  states: {
    record: 'Task',
    field: 'state',
    list: states,
    initial: 'open',
    moves: {
      start: { from: ['open'], to: 'doing' },
      finish: { from: ['doing'], to: 'done' },
      reopen: { from: ['doing', 'done'], to: 'open' },
    },
  },
  requestIds: { keepHours: 24 },
  commands: {
    create: {
      description: 'Add a task. It starts open.',
      effect: 'write',
      input: z.object({ title: z.string().trim().min(1).max(200) }),
      output: Task,
      errors: { TITLE_TAKEN: { status: 409, message: 'A task with this title is already open' } },
      capability: 'tasks.write',
      tool: asTool,
      cli: true,
      emits: ['created'],
      example: { title: 'Water the plants' },
    },
    get: {
      description: 'Show one task.',
      effect: 'read',
      input: ById,
      output: Task,
      errors: notFound,
      capability: 'tasks.read',
      tool: asTool,
      cli: true,
      example: { id: 't-1' },
    },
    list: {
      description: 'List tasks, newest first, optionally in one state.',
      effect: 'read',
      input: z.object({ state: z.enum(states).optional() }),
      output: z.array(Task),
      errors: {},
      capability: 'tasks.read',
      tool: asTool,
      cli: true,
      example: { state: 'doing' },
    },
    start: {
      description: 'Start working on an open task.',
      effect: 'write',
      input: ById,
      output: Task,
      errors: notFound,
      capability: 'tasks.write',
      tool: asTool,
      cli: true,
      move: 'start',
      emits: ['moved'],
      example: { id: 't-1' },
    },
    finish: {
      description: 'Mark a task in progress as done.',
      effect: 'write',
      input: ById,
      output: Task,
      errors: notFound,
      capability: 'tasks.write',
      tool: asTool,
      cli: true,
      move: 'finish',
      emits: ['moved'],
      example: { id: 't-1' },
    },
    reopen: {
      description: 'Open a task again after it was started or done.',
      effect: 'write',
      input: ById,
      output: Task,
      errors: notFound,
      capability: 'tasks.write',
      tool: { needsApproval: true },
      cli: true,
      move: 'reopen',
      emits: ['moved'],
      example: { id: 't-1' },
    },
    remove: {
      description: 'Delete a task for good.',
      effect: 'destructive',
      input: ById,
      output: z.object({ id: z.string() }),
      errors: notFound,
      capability: 'tasks.remove',
      tool: { reason: 'Deleting work stays a choice a person makes' },
      cli: true,
      emits: ['removed'],
      example: { id: 't-1' },
    },
  },
  events: {
    created: { description: 'A task was added.', topic: ['tasks:{id}', 'tasks-by:{createdBy}'], payload: Task },
    moved: {
      description: 'A task moved from one state to another.',
      topic: 'tasks:{id}',
      payload: z.object({ id: z.string(), from: z.enum(states), to: z.enum(states) }),
    },
    removed: { description: 'A task was deleted.', topic: 'tasks:{id}', payload: z.object({ id: z.string() }) },
  },
});

export type Task = RecordOf<typeof tasks, 'Task'>;

export type TaskState = StateOf<typeof tasks>;
