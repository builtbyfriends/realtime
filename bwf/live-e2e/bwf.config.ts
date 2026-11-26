import { defineConfig } from '@builtbyfriends/bwf/config';

export default defineConfig({
  worker: { compatibility_date: '2026-11-01' },
  cloudflare: { name: 'realtime-live-e2e' },
});
