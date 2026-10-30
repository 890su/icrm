import type { Expr } from './ast.js';
import { FUNCTIONS } from './functions.js';
import type { EvalCtx, Value } from './types.js';
import { binaryOp, isEmpty, negate, todayIn } from './value.js';

export { isEmpty, todayIn };

/**
 * Evaluates a (type-checked) expression against a record.
 *
 * Never throws on data: division by zero, currency mismatch, an invalid date string, an unknown
 * timezone, a throwing context... all produce `null` for the node that hit the problem, and
 * enclosing nodes see it as an ordinary empty value (so `COALESCE({bad}, 1)` still yields 1).
 */
export function evaluate(e: Expr, ctx: EvalCtx): Value {
  try {
    return ev(e, ctx);
  } catch {
    return null; // last resort, e.g. stack exhaustion on a pathologically deep expression
  }
}

function ev(e: Expr, ctx: EvalCtx): Value {
  switch (e.k) {
    case 'num': return e.v;
    case 'str': return e.v;
    case 'bool': return e.v;
    case 'null': return null;
    case 'field': return guarded(() => ctx.get(e.key));
    case 'neg': return negate(ev(e.e, ctx));
    case 'bin': return binaryOp(e.op, ev(e.l, ctx), ev(e.r, ctx));
    case 'call': {
      const spec = FUNCTIONS.get(e.fn);
      if (spec === undefined) return null;
      const args = e.args.map((a) => ev(a, ctx));
      return guarded(() => spec.impl(args, ctx));
    }
  }
}

function guarded(f: () => Value | undefined): Value {
  try {
    return f() ?? null;
  } catch {
    return null;
  }
}
