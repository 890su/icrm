/** Attempts in total for a transaction that Postgres aborted as a deadlock victim or serialization failure. */
export const RETRY_ATTEMPTS = 3;

/** Postgres deadlock_detected / serialization_failure: the transaction was rolled back, a re-run may succeed. */
export const isRetryable = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e.code === '40P01' || e.code === '40001');

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `transaction` (which must open its own transaction and have no effects outside it) and re-runs it
 * from scratch when Postgres aborted it with a retryable error, up to `RETRY_ATTEMPTS` in total, with a
 * jittered pause of 10–50 ms × attempt in between. Any other error, or the last retryable one, is rethrown.
 */
export async function withRetry<T>(transaction: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction();
    } catch (e) {
      if (attempt >= RETRY_ATTEMPTS || !isRetryable(e)) throw e;
      await pause(attempt * (10 + Math.random() * 40));
    }
  }
}
