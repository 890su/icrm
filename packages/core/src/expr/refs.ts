import type { Expr } from './ast.js';

function walk(e: Expr, visit: (n: Expr) => void): void {
  visit(e);
  switch (e.k) {
    case 'neg': walk(e.e, visit); break;
    case 'bin': walk(e.l, visit); walk(e.r, visit); break;
    case 'call': for (const a of e.args) walk(a, visit); break;
    default: break;
  }
}

/** Keys of all `{field}` references. */
export function fieldRefs(e: Expr): Set<string> {
  const out = new Set<string>();
  walk(e, (n) => { if (n.k === 'field') out.add(n.key); });
  return out;
}

/** Set keys named by string literals in HAS_SET("…"). */
export function setRefs(e: Expr): Set<string> {
  const out = new Set<string>();
  walk(e, (n) => {
    if (n.k === 'call' && n.fn === 'HAS_SET') {
      const a = n.args[0];
      if (a?.k === 'str') out.add(a.v);
    }
  });
  return out;
}

/** True when the value depends on the clock (TODAY / NOW), i.e. is not a pure function of the record. */
export function usesClock(e: Expr): boolean {
  let found = false;
  walk(e, (n) => { if (n.k === 'call' && (n.fn === 'TODAY' || n.fn === 'NOW')) found = true; });
  return found;
}
