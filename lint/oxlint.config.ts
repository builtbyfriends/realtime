import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

const effect = 'react-you-might-not-need-an-effect';

export default defineConfig({
  ...cloudflare,
  ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/.bwf/**', '**/bwf/demo/db/migrations/**'],
  jsPlugins: [...(cloudflare.jsPlugins ?? []), './comments.mjs', 'eslint-plugin-react-you-might-not-need-an-effect'],
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
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      // Decision: Tests and type tests call mocks and loose fixtures, and wait with bare promises.
      files: ['**/test/**', '**/type-tests/**', '**/*.test.*'],
      rules: {
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
      // Decision: These three report an error to the console when the app gives no handler of its own. The packages have no logger.
      files: ['**/packages/core/src/registry.ts', '**/packages/live/src/index.ts', '**/packages/data/src/deployment.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
});
