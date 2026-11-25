// Decision: these are the shapes apps on Realtime 0.4 wrote. They have to keep type checking, so an app moves up without edits.
import { DurableObject } from 'cloudflare:workers';
import { defineData, defineSchema, table } from '../src/index.js';
import type { SyncQueryPlan } from '../src/index.js';

type Message = { channel: string; body: string; at: number };

const data = defineData({
  schema: defineSchema({ messages: table<Message>({ indexes: { by_channel: ['channel', 'at'] } }) }),
  functions: ({ query, mutation }) => ({
    send: mutation((ctx, a: { channel: string; body: string }) => ctx.db.insert('messages', { ...a, at: ctx.now })),
    list: query((ctx, a: { channel: string }) => ctx.db.query('messages').withIndex('by_channel', (q) => q.eq('channel', a.channel)).collect()),
  }),
});

export class Deployment extends data.durableObject(DurableObject) {}

declare const ns: DurableObjectNamespace<Deployment>;
export const remote = data.client({ idFromName: (n: string) => n, get: (n: string) => ns.get(ns.idFromName(n)) });

interface Reply { by: string; at: Date }

type Shown = { id: string; reply: Reply | null };

defineSchema({
  messages: table<Message>({ indexes: {}, sync: { group: (m) => m.channel, view: (m): Shown => ({ id: m.channel, reply: null }) } }),
});

type Validation = { value?: string; issues?: ReadonlyArray<unknown> };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the shape an app on Realtime 0.4 wrote, kept to prove it still fits
type LooseSchema = { '~standard': { validate(value: unknown): Validation | Promise<Validation> } };

declare const loose: LooseSchema;
export const plan: SyncQueryPlan = { fn: 'list', args: {}, output: loose };
