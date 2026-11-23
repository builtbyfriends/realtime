/** Codes the pipeline itself can return. Procedures may not redeclare them. */
export const BUILTIN_ERRORS = {
  UNAUTHENTICATED: { status: 401, message: 'Authentication required' },
  FORBIDDEN: { status: 403, message: 'Not allowed' },
  INVALID_INPUT: { status: 400, message: 'Input did not match the schema' },
  NOT_FOUND_PROCEDURE: { status: 404, message: 'No such procedure' },
  INTERNAL: { status: 500, message: 'Internal error' },
} as const;

export type BuiltinErrorCode = keyof typeof BUILTIN_ERRORS;

export type ErrorSpec = { status: number; message: string };

/** Thrown by `fail()`. The pipeline turns it into the declared status and message. */
export class ProcedureError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ProcedureError';
    this.code = code;
  }
}

export type Failure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  issues?: Array<{ message: string; path: string }>;
};

export function builtinFailure(code: BuiltinErrorCode, issues?: Failure['issues']): Failure {
  const spec = BUILTIN_ERRORS[code];
  const failure: Failure = { ok: false, status: spec.status, code, message: spec.message };
  if (issues) {
    failure.issues = issues;
  }
  return failure;
}
