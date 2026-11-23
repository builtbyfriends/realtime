import { expectTypeOf } from 'expect-type';
import { defineData, defineSchema, table } from '../src/index.js';

type Message = { channel: string; body: string; at: number };
const data = defineData({
  schema: defineSchema({ messages: table<Message>({ indexes: { by_channel: ['channel', 'at'] } }) }),
  functions: ({ query, mutation }) => ({
    send: mutation((ctx, a: { channel: string; body: string }) => ctx.db.insert('messages', { ...a, at: ctx.now })),
    list: query((ctx, a: { channel: string }) => ctx.db.query('messages').withIndex('by_channel', (q) => q.eq('channel', a.channel)).collect()),
    total: query((ctx) => ctx.db.query('messages').collect().length),
  }),
  jobs: (job) => ({
    cleanup: job(async (ctx, a: { channel: string }) => {
      expectTypeOf(ctx.data.query.list).parameter(0).toEqualTypeOf<{ channel: string }>();
      await ctx.data.mutate.send({ channel: a.channel, body: 'bye' });
    }),
  }),
});

declare const ns: { idFromName(n: string): string; get(id: string): any };
const client = data.client(ns);

expectTypeOf(client.mutate.send).parameter(0).toEqualTypeOf<{ channel: string; body: string }>();
expectTypeOf(client.mutate.send).returns.resolves.toBeString();
expectTypeOf(client.query.list).returns.resolves.items.toMatchTypeOf<Message & { _id: string; _creationTime: number }>();
expectTypeOf(client.query.total).parameters.toEqualTypeOf<[]>();
expectTypeOf(client.query.total).returns.resolves.toBeNumber();

// @ts-expect-error a mutation is not on the query side
void client.query.send;
// @ts-expect-error wrong argument
void client.mutate.send({ channel: 'a' });
