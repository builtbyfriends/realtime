import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = 'packages/core/type-tests/messages';
const expectedPath = `${root}${dir}/messages.expected.txt`;
let out = '';
try {
  execFileSync(`${root}node_modules/.bin/tsc`, ['-p', `${dir}/tsconfig.json`, '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
} catch (error) {
  out = error.stdout;
}
const actual = out.replaceAll('\r\n', '\n').trim() + '\n';
if (process.argv.includes('--update') || !existsSync(expectedPath)) {
  writeFileSync(expectedPath, actual);
  console.log(`wrote ${dir}/messages.expected.txt (${actual.split('\n').filter((l) => l.includes('error TS')).length} errors)`);
} else if (readFileSync(expectedPath, 'utf8') !== actual) {
  console.error('Compiler messages changed. Diff against messages.expected.txt:\n');
  console.error(actual);
  console.error('Run `npm run test:types -- --update` if the change is intended.');
  process.exit(1);
} else {
  console.log(`compiler messages match (${actual.split('\n').filter((l) => l.includes('error TS')).length} errors)`);
}
