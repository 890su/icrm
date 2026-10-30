import type { CompiledConfig, CompiledRollup } from '../config/compile.js';
import { setRefs } from '../expr/refs.js';

/**
 * Rollups (of OTHER records) to recompute when this record's `changedKeys` fields changed or
 * the sets in `changedSets` were enabled/disabled on it. A rollup is fed by the field it
 * aggregates and by the refs of its filter, including `HAS_SET("...")` in the filter.
 */
export function rollupsFedBy(
  cfg: CompiledConfig,
  changedKeys: Set<string>,
  changedSets: Set<string> = new Set(),
): CompiledRollup[] {
  return cfg.rollups.filter((r) => {
    for (const k of r.sourceKeys) if (changedKeys.has(k)) return true;
    if (r.filterAst === undefined || changedSets.size === 0) return false;
    for (const s of setRefs(r.filterAst)) if (changedSets.has(s)) return true;
    return false;
  });
}

/** Rollups that depend on the link field `linkField` (to recompute when the links change). */
export function rollupsVia(cfg: CompiledConfig, linkField: string): CompiledRollup[] {
  return cfg.rollups.filter((r) => r.via === linkField);
}
