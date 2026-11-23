#!/usr/bin/env node
import { run } from './index.js';

// Decision: set the exit code and let the process end. process.exit() cuts off output that a pipe has not taken yet.
try {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
} catch (error) {
  process.stderr.write(`realtime: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
