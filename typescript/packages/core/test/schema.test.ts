import { describe, expect, it } from 'vitest';
import { validate } from '../src/schema.js';

const thenable = (result: unknown) => ({
  '~standard': { version: 1, vendor: 'test', validate: () => ({ then: (resolve: (r: unknown) => void) => resolve(result) }) },
});

describe('validate', () => {
  it('waits for a thenable result, not only a Promise', async () => {
    expect(await validate(thenable({ value: 5 }) as any, 1)).toEqual({ ok: true, value: 5 });
    expect(await validate(thenable({ issues: [{ message: 'nope' }] }) as any, 1)).toEqual({ ok: false, issues: [{ message: 'nope', path: '' }] });
  });
});
