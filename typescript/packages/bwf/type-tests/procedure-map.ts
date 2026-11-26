// Decision: bwf's codegen declares the app's procedures as an interface that apps extend by declaration merging, and pairs it with
// a Registry as Realtime 0.4 apps did. An interface has no implicit index signature, so this has to keep type checking.
import { expectTypeOf } from 'expect-type';
import type { Procedure, Registry } from '@builtbyfriends/realtime';
import { createClient } from '@builtbyfriends/realtime-http/client';
import { createBwfLive } from '../src/react.js';
import type { ConnectLiveStream } from '../src/react.js';

type Message = { id: string; body: string };

type Send = Procedure<{ name: 'messages.send'; env: unknown; ctx: unknown; in: { body: string }; inRaw: { body: string }; outRaw: Message; out: Message; err: 'TOO_LONG'; done: 'authn' }>;

interface ProcedureMap {
  'messages.send': Send;
}

type App = Omit<Registry, '~procedures'> & { readonly '~procedures': ProcedureMap };

declare const connect: ConnectLiveStream;

const client = createClient<App>('');

export const { useQuery, useMutation, live } = createBwfLive<App>({ client, connect, topics: { 'messages.send': (input) => [`messages:${input.body}`] } });

expectTypeOf(client.call('messages.send', { body: 'hi' })).resolves.toEqualTypeOf<Message>();

// @ts-expect-error The map lists only messages.send.
void client.call('messages.edit', { body: 'hi' });
