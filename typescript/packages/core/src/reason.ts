/**
 * Opt-outs (`noAuth`, `noCli`, ...) must say why. A literal reason is checked by the
 * type checker (at least three words, not a placeholder). Every reason is checked again
 * when the registry loads (at least 12 characters, three words, not on the deny-list),
 * which covers computed strings and code that skipped the type checker.
 */
export const JUNK_REASONS = [
  'n/a', 'na', 'none', 'no', 'todo', 'tbd', 'later', 'fixme', 'xxx', 'test', 'testing', 'temp',
  'temporary', 'not needed', 'not applicable', 'no reason', 'skip', 'skipped', 'whatever', 'unused',
  'not required', 'not necessary', 'none needed', 'no need', 'not relevant', 'internal',
] as const;

type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer R} ` ? Trim<R> : S;
type Junk = (typeof JUNK_REASONS)[number];

export type ReasonMessage =
  'Opt-out reason must say why in at least three words, e.g. "Public marketing data with no user context"';

/** Resolves to `R` when the literal reason is acceptable, otherwise to an explanatory message. */
export type CheckReason<R extends string> = string extends R
  ? R // Decision: not a literal, so the registry checks it when it loads
  : Lowercase<Trim<R>> extends Junk | `${Junk}.`
    ? ReasonMessage
    : Trim<R> extends `${string} ${string} ${string}`
      ? R
      : ReasonMessage;

export function reasonProblem(reason: unknown): string | null {
  if (typeof reason !== 'string') {return 'opt-out needs a reason string';}
  const r = reason.trim().replaceAll(/\s+/g, ' ');
  const lower = r.toLowerCase().replace(/[.!]+$/, '');
  if ((JUNK_REASONS as ReadonlyArray<string>).includes(lower)) {return `"${reason}" is a placeholder, not a reason`;}
  if (r.length < 12 || r.split(' ').length < 3) {return `"${reason}" is too short: say why in at least three words`;}
  return null;
}
