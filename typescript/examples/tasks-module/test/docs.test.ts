import { expect, it } from 'vitest';
import { contractDocs } from '@builtbyfriends/realtime';
import { tasks } from '../src/contract.js';
import { registry } from '../src/worker.js';

// Decision: the docs page and the audit are generated from the contract and checked in, so a change to the contract shows up in the
// pull request as a change to what people and models read.
it('matches the checked-in docs page', async () => {
  await expect(contractDocs(tasks)).toMatchFileSnapshot('../tasks.txt');
});

it('matches the checked-in audit', async () => {
  await expect(registry.auditTable()).toMatchFileSnapshot('./audit.md');
});
