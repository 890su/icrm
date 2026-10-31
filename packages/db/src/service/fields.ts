import type { CompiledConfig, Value } from '@icrm/core';

/** Structural equality of stored values; a missing key equals `null`. */
export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (Array.isArray(x) || Array.isArray(y)) {
    return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
  }
  const kx = Object.keys(x) as (keyof typeof x)[];
  return kx.length === Object.keys(y).length && kx.every((k) => Object.hasOwn(y, k) && sameValue(x[k], y[k]));
}

/** True when field `key` belongs to at least one of the record's enabled `sets`. */
export function fieldInEnabledSet(cfg: CompiledConfig, sets: Map<string, string>, key: string): boolean {
  return [...(cfg.setsOfField.get(key) ?? [])].some((s) => sets.has(s));
}
