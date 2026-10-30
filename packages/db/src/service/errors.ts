import type { ErrorCode, RecordError } from '@icrm/core';

/** Thrown inside a save transaction to roll it back; the service turns it into `{ok: false, errors}`. */
export class SaveFailed extends Error {
  constructor(readonly errors: RecordError[]) {
    super(errors.map((e) => e.message).join('; '));
    this.name = 'SaveFailed';
  }
}

export function recordError(
  code: ErrorCode, message: string, extra: { field?: string; rule_id?: string } = {},
): RecordError {
  return { ...extra, code, message };
}

export const notFound = (id: string): RecordError => recordError('not_found', `Запись ${id} не найдена`);

export const archived = (id: string): RecordError => recordError('archived', `Запись ${id} в архиве, её нельзя изменить`);

export const versionConflict = (id: string): RecordError =>
  recordError('version_conflict', `Запись ${id} изменена другим пользователем, перечитайте её`);
