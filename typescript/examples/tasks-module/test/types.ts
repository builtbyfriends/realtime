import { expectTypeOf } from 'expect-type';
import type { CommandInput, CommandOutput, InputOf } from '@builtbyfriends/realtime';
import type { tasks } from '../src/contract.js';
import type { Task } from '../src/contract.js';
import type { registry } from '../src/worker.js';

expectTypeOf<Task>().toEqualTypeOf<{ id: string; title: string; state: 'open' | 'doing' | 'done'; createdBy: string }>();

expectTypeOf<CommandInput<typeof tasks, 'create'>>().toEqualTypeOf<{ title: string } & { requestId: string }>();

expectTypeOf<CommandInput<typeof tasks, 'list'>>().toEqualTypeOf<{ state?: 'open' | 'doing' | 'done' | undefined }>();

expectTypeOf<CommandOutput<typeof tasks, 'list'>>().toEqualTypeOf<Array<Task>>();

type P = NonNullable<(typeof registry)['~procedures']>;

expectTypeOf<keyof P>().toEqualTypeOf<'tasks.create' | 'tasks.get' | 'tasks.list' | 'tasks.start' | 'tasks.finish' | 'tasks.reopen' | 'tasks.remove'>();

expectTypeOf<InputOf<P['tasks.start']>>().toEqualTypeOf<{ id: string } & { requestId: string }>();
