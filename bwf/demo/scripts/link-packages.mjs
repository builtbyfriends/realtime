import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
const link = new URL('../../../typescript/node_modules', import.meta.url).pathname;
if (existsSync(link) && !lstatSync(link).isSymbolicLink()) {process.exit(0);}
rmSync(link, { force: true });
symlinkSync('../bwf/demo/node_modules', link);
