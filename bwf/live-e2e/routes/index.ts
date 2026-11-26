import { defineHandler } from '@builtbyfriends/bwf';

export const GET = defineHandler((c) => c.html('<!doctype html><title>live e2e</title><div id="root"></div>'));
