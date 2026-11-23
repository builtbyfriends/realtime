#!/usr/bin/env node
import { run } from './index.js';

run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`realtime: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
