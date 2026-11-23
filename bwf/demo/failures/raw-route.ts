import { defineHandler } from '@builtbyfriends/bwf';
import { db } from '@builtbyfriends/bwf/db';
import { contacts } from '@schema';

export const GET = defineHandler(() => db.select().from(contacts));
