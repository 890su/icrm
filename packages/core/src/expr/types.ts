import type { Pos } from './ast.js';

export type ScalarType = 'number' | 'text' | 'bool' | 'date' | 'datetime' | 'money';
export type ExprType = ScalarType | 'null' | { list: ScalarType };

/** Type environment the checker resolves `{field}` and HAS_SET("set") against. */
export interface TypeEnv {
  fieldType(key: string): ExprType | undefined;
  hasSet(key: string): boolean;
}

export class ExprTypeError extends Error {
  readonly pos: Pos;

  constructor(message: string, pos: Pos) {
    super(message);
    this.name = 'ExprTypeError';
    // Copy only the span: callers often pass a whole AST node.
    this.pos = { start: pos.start, end: pos.end };
  }
}

/** Runtime money value: decimal string amount + ISO currency (arithmetic via decimal.js). */
export type Money = { amount: string; currency: string };

/** Runtime value: date = "YYYY-MM-DD", datetime = ISO-8601 UTC with Z, null = empty. */
export type Value = null | number | string | boolean | Money | Value[];

export interface EvalCtx {
  get(key: string): Value;
  hasSet(key: string): boolean;
  now: Date;
  timezone: string;
}
