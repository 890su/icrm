import type { SyncReport } from '@icrm/db';

interface Log {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Records with recompute errors listed in the log line; the count covers all of them. */
const MAX_LISTED = 20;

/**
 * Logs the result of a config sync: a summary at info, and at warn (spec §1.11 «предупреждение») the keys
 * the config no longer defines and the records that violate the config after the recompute.
 */
export function logSyncReport(log: Log, report: SyncReport): void {
  const { recomputeErrors, ...summary } = report;
  log.info({ ...summary, recomputeErrors: recomputeErrors.length }, 'config synced');
  if (report.orphanKeys.length > 0) {
    log.warn({ orphanKeys: report.orphanKeys }, 'config sync: stored data has keys the config no longer defines');
  }
  if (recomputeErrors.length > 0) {
    log.warn(
      { count: recomputeErrors.length, records: recomputeErrors.slice(0, MAX_LISTED) },
      'config sync: recomputed records violate the config',
    );
  }
}
