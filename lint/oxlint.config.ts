import bwf from '@builtbyfriends/bwf/lint';
import { defineConfig } from 'oxlint';

// Decision: The shared checks come from bwf's lint config, so every repository runs the same ones. This file adds the
// rules only this repository needs and turns a rule to `warn` while older code still has reports.
export default defineConfig({
  ...bwf,
  ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/.bwf/**', '**/bwf/demo/db/migrations/**'],
  jsPlugins: [...(bwf.jsPlugins ?? []), './comments.mjs'],
  rules: {
    ...bwf.rules,
    'realtime/no-comments': 'error',
    // Decision: Dillon Mulroy's anti-slop rules warn while older code still has reports. Fix the ones in the files you
    // touch, and move a rule back to error at zero.
    'anti-slop/no-module-mocking': 'warn',
    'anti-slop/no-runtime-typeof': 'warn',
    'anti-slop/no-shape-in-symbol-names': 'warn',
    'anti-slop/no-unknown-parameters': 'warn',
    'anti-slop/require-readable-spacing': 'warn',
    'anti-slop/require-safety-comment-for-type-assertion': ['warn', { markers: ['Decision'] }],
  },
  overrides: [
    ...(bwf.overrides ?? []),
    {
      // Decision: Tests and type tests call mocks and loose fixtures, and wait with bare promises. A describe block holds a
      // whole file's tests, so the function size limit doesn't fit there.
      files: ['**/test/**', '**/type-tests/**', '**/*.test.*'],
      rules: {
        'max-lines-per-function': 'off',
        'no-promise-executor-return': 'off',
        'typescript/no-explicit-any': 'off',
        'typescript/no-non-null-assertion': 'off',
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
        'anti-slop/require-safety-comment-for-type-assertion': 'off',
        'unicorn/consistent-function-scoping': 'off',
      },
    },
    {
      // Decision: These files take what comes over the wire, a published event or a command's answer, and check it with the
      // contract's own schemas before anything uses it. The input is unknown on purpose until that check runs, and the
      // packages have no logger, so a failed event goes to the console.
      files: ['**/packages/live/src/records*.ts', '**/packages/live/src/record-store.ts', '**/packages/live/src/view-store.ts', '**/packages/live/src/commands.ts'],
      rules: {
        'anti-slop/no-runtime-typeof': 'off',
        'anti-slop/no-unknown-parameters': 'off',
        'no-console': 'off',
        'quality/no-unknown-returns': 'off',
        'quality/no-unsafe-dictionary-type': 'off',
      },
    },
    {
      // Decision: Scripts, the command line tool and the demos print to the terminal on purpose.
      files: ['**/scripts/**', '**/packages/cli/**', '**/bwf/**'],
      rules: { 'no-console': 'off' },
    },
    {
      // Decision: These files report an error to the console when the app gives no handler of its own. The packages have no logger.
      files: ['**/packages/core/src/registry.ts', '**/packages/live/src/index.ts', '**/packages/data/src/deployment.ts', '**/packages/data/src/sockets.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
});
