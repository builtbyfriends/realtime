import { defineHandler } from '@builtbyfriends/bwf';
import { world } from '../src/backend';

export const POST = defineHandler(async (c) => c.json({ left: await world.module.events.deliver(c.env) }));
