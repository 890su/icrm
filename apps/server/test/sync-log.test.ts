import type { SyncReport } from '@icrm/db';
import { describe, expect, test } from 'vitest';
import { logSyncReport } from '../src/sync-log.js';

/** A logger that records `[level, object, message]`. */
function fakeLog() {
  const calls: [string, Record<string, unknown>, string][] = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg: string): void => {
    calls.push([level, obj, msg]);
  };
  return { calls, log: { info: at('info'), warn: at('warn') } };
}

const EMPTY: SyncReport = { renamed: [], orphanKeys: [], recomputed: [], recomputeErrors: [], indexes: [] };

describe('logSyncReport', () => {
  test('a clean sync is one info line', () => {
    const { calls, log } = fakeLog();
    logSyncReport(log, { ...EMPTY, recomputed: ['cost'] });
    expect(calls).toEqual([['info', expect.objectContaining({ recomputed: ['cost'] }), 'config synced']]);
  });

  test('orphan keys and recompute errors are warnings', () => {
    const { calls, log } = fakeLog();
    const recomputeErrors = [{ recordId: 'r1', errors: [{ code: 'validation' as const, message: 'Слишком дорого' }] }];
    logSyncReport(log, { ...EMPTY, orphanKeys: ['legacy'], recomputeErrors });
    expect(calls.map(([level]) => level)).toEqual(['info', 'warn', 'warn']);
    expect(calls[1]![1]).toEqual({ orphanKeys: ['legacy'] });
    expect(calls[2]![1]).toEqual({ count: 1, records: recomputeErrors });
  });

  test('at most 20 records are listed, the count says how many there are', () => {
    const { calls, log } = fakeLog();
    const recomputeErrors = Array.from({ length: 25 }, (_, n) => ({
      recordId: `r${n}`, errors: [{ code: 'required' as const, message: 'x' }],
    }));
    logSyncReport(log, { ...EMPTY, recomputeErrors });
    const warn = calls.find(([level]) => level === 'warn')!;
    expect(warn[1]).toMatchObject({ count: 25 });
    expect(warn[1].records).toHaveLength(20);
  });
});
