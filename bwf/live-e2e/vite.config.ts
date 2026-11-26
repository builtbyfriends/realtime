import { defineConfig } from 'vite';
import { bwfPlugin } from '@builtbyfriends/bwf';

const pkgs = new URL('../../typescript/packages/', import.meta.url).pathname;

export default defineConfig({
  plugins: [bwfPlugin()],
  resolve: {
    alias: [
      { find: '@builtbyfriends/realtime-live/records/testing', replacement: `${pkgs}live/src/records-testing.ts` },
      { find: '@builtbyfriends/realtime-live/records/react', replacement: `${pkgs}live/src/records-react.tsx` },
      { find: '@builtbyfriends/realtime-live/records', replacement: `${pkgs}live/src/records.ts` },
      { find: '@builtbyfriends/realtime-live', replacement: `${pkgs}live/src/index.ts` },
      { find: '@builtbyfriends/realtime-bwf/live', replacement: `${pkgs}bwf/src/live.ts` },
      { find: '@builtbyfriends/realtime', replacement: `${pkgs}core/src/index.ts` },
    ],
    dedupe: ['@builtbyfriends/bwf', 'zod', 'hono', '@standard-schema/spec', 'react', 'react-dom', '@tanstack/db'],
  },
});
