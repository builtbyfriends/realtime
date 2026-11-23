import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Decision: this repository takes an app as input and doesn't know which app it is, so no app's name
// belongs in code, tests, docs or package manifests. That keeps it reusable and ready to open up.
// The name is built from two parts so that this file passes its own check.
const appName = ['ded', 'worc'].join('');

// Decision: a deliberate mention goes here with its reason. A row that matches no file fails, so the list stays current.
const allowed: Array<{ file: string; reason: string }> = [];

function filesThatNameTheApp(): Array<string> {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  try {
    return execFileSync('git', ['grep', '-Iil', appName], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    // Decision: git grep exits with 1 when nothing matches.
    if ((error as { status?: number }).status === 1) {return [];}
    throw error;
  }
}

describe('product code stays free of app-specific names', () => {
  const found = filesThatNameTheApp();

  it('names no specific app outside the allowed list', () => {
    const allowedFiles = new Set(allowed.map((row) => row.file));
    expect(found.filter((file) => !allowedFiles.has(file))).toEqual([]);
  });

  it('has no allowed row that matches nothing', () => {
    expect(allowed.filter((row) => !found.includes(row.file))).toEqual([]);
  });
});
