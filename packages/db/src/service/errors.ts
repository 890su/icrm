import type { ErrorCode, RecordError } from '@icrm/core';

/** Thrown inside a save transaction to roll it back; the service turns it into `{ok: false, errors}`. */
export class SaveFailed extends Error {
  constructor(readonly errors: RecordError[]) {
    super(errors.map((e) => e.message).join('; '));
    this.name = 'SaveFailed';
  }
}

export function recordError(
  code: ErrorCode, message: string,
  extra: Pick<RecordError, 'field' | 'rule_id' | 'recordId' | 'ownerId' | 'ownerTitle'> = {},
): RecordError {
  return { ...extra, code, message };
}

export const notFound = (id: string): RecordError => recordError('not_found', `Запись ${id} не найдена`);

export const archived = (id: string): RecordError => recordError('archived', `Запись ${id} в архиве, её нельзя изменить`);

export const versionConflict = (id: string): RecordError =>
  recordError('version_conflict', `Запись ${id} изменена другим пользователем, перечитайте её`);

/**
 * The error of a unique violation per name of the Postgres constraint (or unique index) behind it; `detail` is
 * Postgres' detail of the violation. Filled by the modules that own those constraints.
 */
export const UNIQUE_ERRORS: Record<string, (detail: string | undefined) => RecordError> = {};

UNIQUE_ERRORS.identities_live_address = () => recordError('identity_taken', 'Адрес уже принадлежит другой записи');

/** The error of a Postgres unique violation (23505) of a constraint in `UNIQUE_ERRORS`; null for anything else. */
export function uniqueViolation(e: unknown): RecordError | null {
  if (typeof e !== 'object' || e === null || !('code' in e) || e.code !== '23505') return null;
  const constraint = 'constraint' in e && typeof e.constraint === 'string' ? e.constraint : undefined;
  const make = constraint === undefined || !Object.hasOwn(UNIQUE_ERRORS, constraint) ? undefined : UNIQUE_ERRORS[constraint];
  if (make === undefined) return null;
  return make('detail' in e && typeof e.detail === 'string' ? e.detail : undefined);
}
