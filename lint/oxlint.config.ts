import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

const effect = 'react-you-might-not-need-an-effect';

export default defineConfig({
  ...cloudflare,
  ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/.bwf/**', '**/bwf/demo/db/migrations/**'],
  jsPlugins: [
    ...(cloudflare.jsPlugins ?? []),
    './comments.mjs',
    'eslint-plugin-react-you-might-not-need-an-effect',
    { name: 'anti-slop', specifier: '@aranlucas/oxlint-plugin-anti-slop' },
  ],
  rules: {
    ...cloudflare.rules,
    'realtime/no-comments': 'error',
    [`${effect}/no-derived-state`]: 'error',
    [`${effect}/no-chain-state-updates`]: 'error',
    [`${effect}/no-event-handler`]: 'error',
    [`${effect}/no-adjust-state-on-prop-change`]: 'error',
    [`${effect}/no-reset-all-state-on-prop-change`]: 'error',
    [`${effect}/no-pass-live-state-to-parent`]: 'error',
    [`${effect}/no-pass-data-to-parent`]: 'error',
    [`${effect}/no-external-store-subscription`]: 'error',
    [`${effect}/no-initialize-state`]: 'error',
    // Decision: Dillon Mulroy's anti-slop rules that Cloudflare's preset doesn't carry yet (it has the rest as `quality/*`),
    // from a packaged copy of his repository. A cast is justified with a `Decision:` line, the one comment the comment rule keeps.
    // They warn while older code still has reports. Fix the ones in the files you touch, and move a rule to error at zero.
    'anti-slop/no-module-mocking': 'warn',
    'anti-slop/no-runtime-typeof': 'warn',
    'anti-slop/no-shape-in-symbol-names': 'warn',
    'anti-slop/no-unknown-parameters': 'warn',
    'anti-slop/require-readable-spacing': 'warn',
    'anti-slop/require-safety-comment-for-type-assertion': ['warn', { markers: ['Decision'] }],
    // Decision: Limits that point at functions to split. They warn, so the list shows what to split first.
    complexity: ['warn', { max: 15 }],
    'max-depth': ['warn', 4],
    'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
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
        'unicorn/consistent-function-scoping': 'off',
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
