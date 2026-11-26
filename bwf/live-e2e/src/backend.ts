import type { ContractEvent } from '@builtbyfriends/realtime';
import { live } from './live';
import { notesWorld } from '../../../typescript/packages/live/test/fixtures/notes';

export const notesCount = 30;

const pending: Array<Promise<unknown>> = [];

export const world = notesWorld((event: ContractEvent) => {
  pending.push(live.publish(event.topic, event, { type: event.name }));
});

world.store.addBoard('b-1', 'Plans');

for (let i = 1; i <= notesCount; i += 1) {world.store.add(`n-${i}`, 'b-1', `Note ${i}`);}

export const counters = { calls: 0 };

export async function settlePublishes() {
  await Promise.all(pending.splice(0));
}
