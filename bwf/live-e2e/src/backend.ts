import type { ContractEvent, DeliveryFailure } from '@builtbyfriends/realtime';
import { live } from './live';
import { notesWorld } from '../../../typescript/packages/live/test/fixtures/notes';

export const notesCount = 30;

export const outage = { on: false };

export const failures: Array<{ topic: string; attempt: number; retrying: boolean; message: string }> = [];

export const world = notesWorld(
  async (event: ContractEvent) => {
    if (outage.on) {throw new Error('the stream is down');}

    await live.publish(event.topic, event, { type: event.name });
  },
  (failure: DeliveryFailure) => {
    failures.push({ topic: failure.event.topic, attempt: failure.attempt, retrying: failure.retrying, message: String(failure.error instanceof Error ? failure.error.message : failure.error) });
  },
);

world.store.addBoard('b-1', 'Plans');

for (let i = 1; i <= notesCount; i += 1) {world.store.add(`n-${i}`, 'b-1', `Note ${i}`);}

export const counters = { calls: 0 };
