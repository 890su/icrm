import type { CompiledConfig, CompiledRollup } from '../config/compile.js';
import { evaluate } from '../expr/evaluate.js';
import type { EvalCtx, Value } from '../expr/types.js';
import { arithmetic, compareValues, isEmpty, isMoney } from '../expr/value.js';

/** A record on the other end of a link, as the aggregation sees it. */
export interface RelatedRecord {
  id: string;
  data: Record<string, Value>;
  sets: Set<string>;
}

/**
 * Value of rollup `r` over `related` (already non-archived and in link order).
 *
 * Empty set: sum/count -> 0, all -> TRUE, any -> FALSE, list -> [], min/max/avg/first -> null.
 * Empty values are skipped. A money sum/min/max/avg over mixed currencies is null (a runtime problem,
 * never an error); a money sum with no values is null too, as there is no currency to put on a zero.
 */
export function computeRollup(cfg: CompiledConfig, r: CompiledRollup, related: RelatedRecord[], now: Date): Value {
  const passing = r.filterAst === undefined ? related : related.filter((rec) => passes(cfg, r, rec, now));
  if (r.agg === 'count') return passing.length;

  const key = r.field;
  if (key === undefined) return null;
  const values = passing.map((rec) => rec.data[key] ?? null);

  switch (r.agg) {
    case 'all': return values.every((v) => v === true);
    case 'any': return values.some((v) => v === true);
    case 'list': return values.filter((v) => !isEmpty(v));
    case 'first': return values.find((v) => !isEmpty(v)) ?? null;
    default: break;
  }

  const present = values.filter((v) => !isEmpty(v));
  switch (r.agg) {
    case 'sum':
      if (present.length === 0) return cfg.fields.get(r.key)?.valueType === 'money' ? null : 0;
      return sumOf(present);
    case 'avg': {
      if (present.length === 0) return null;
      const total = sumOf(present);
      return total === null ? null : arithmetic('/', total, present.length);
    }
    case 'min': return extreme(present, -1);
    case 'max': return extreme(present, 1);
    default: return null;
  }
}

function passes(cfg: CompiledConfig, r: CompiledRollup, rec: RelatedRecord, now: Date): boolean {
  const ctx: EvalCtx = {
    get: (k) => rec.data[k] ?? null,
    hasSet: (k) => rec.sets.has(k),
    now,
    timezone: cfg.timezone,
  };
  return evaluate(r.filterAst!, ctx) === true;
}

/** Exact sum via the shared decimal arithmetic; null on currency mismatch or a non-numeric value. */
function sumOf(values: Value[]): Value {
  let acc: Value = null;
  for (const [i, v] of values.entries()) {
    if (i === 0) {
      // The first value never goes through arithmetic: it must itself be a number or money.
      if (typeof v !== 'number' && !isMoney(v)) return null;
      acc = v;
    } else {
      acc = arithmetic('+', acc, v);
      if (acc === null) return null;
    }
  }
  return acc;
}

/** Smallest (`dir` -1) or largest (`dir` 1) value; the first of equals wins; incomparable values -> null. */
function extreme(values: Value[], dir: -1 | 1): Value {
  let best: Value = null;
  for (const v of values) {
    if (best === null) { best = v; continue; }
    const c = compareValues(v, best);
    if (c === null) return null;
    if (c * dir > 0) best = v;
  }
  return best;
}
