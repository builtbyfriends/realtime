#!/usr/bin/env node
import { run } from './index.js';

try {
  const code = await run({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
} catch (error) {
  process.stderr.write(`realtime: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
