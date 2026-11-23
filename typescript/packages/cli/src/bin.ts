#!/usr/bin/env node
import { run } from './index.js';

run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then(
  // Decision: set the exit code and let the process end. process.exit() cuts off output that a pipe hasn't taken yet.
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`realtime: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
