import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const modules = fileURLToPath(new URL('./node_modules/', import.meta.url));
const pkgs = fileURLToPath(new URL('../../typescript/packages/', import.meta.url));

export async function bundle() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./client/main.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    alias: {
      react: `${modules}react`,
      'react-dom': `${modules}react-dom`,
      '@tanstack/db': `${modules}@tanstack/db`,
      '@tanstack/react-db': `${modules}@tanstack/react-db`,
      zod: `${modules}zod`,
      '@builtbyfriends/realtime-live/records/testing': `${pkgs}live/src/records-testing.ts`,
      '@builtbyfriends/realtime-live/records/react': `${pkgs}live/src/records-react.tsx`,
      '@builtbyfriends/realtime-live/records': `${pkgs}live/src/records.ts`,
      '@builtbyfriends/realtime-live': `${pkgs}live/src/index.ts`,
      '@builtbyfriends/realtime-bwf/live': `${pkgs}bwf/src/live.ts`,
      '@builtbyfriends/realtime': `${pkgs}core/src/index.ts`,
    },
    resolveExtensions: ['.ts', '.tsx', '.js'],
    logLevel: 'error',
  });

  return result.outputFiles[0].text;
}
