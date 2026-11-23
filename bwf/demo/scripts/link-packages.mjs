import { existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs';
const link = new URL('../../../typescript/node_modules', import.meta.url).pathname;
if (existsSync(link) && !lstatSync(link).isSymbolicLink()) {process.exit(0);}
try { unlinkSync(link); } catch {}
symlinkSync('../bwf/demo/node_modules', link);
