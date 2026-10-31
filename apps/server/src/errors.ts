import type { RecordError } from '@icrm/core';
import { QueryError, type SaveResult } from '@icrm/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

interface ErrorBody {
  errors: { code: string; message: string }[];
}

/** HTTP status of a failed save: a conflict beats not-found, everything else is a validation failure. */
export function statusOf(errors: RecordError[]): number {
  if (errors.some((e) => e.code === 'version_conflict')) return 409;
  if (errors.some((e) => e.code === 'not_found')) return 404;
  return 422;
}

const oneError = (code: string, message: string): ErrorBody => ({ errors: [{ code, message }] });

export const notFoundBody = (message: string): ErrorBody => oneError('not_found', message);

/** Sends the saved record with `okStatus`, or the service's errors with the status they map to. */
export function sendSaved(reply: FastifyReply, res: SaveResult, okStatus: number): FastifyReply {
  return res.ok ? reply.code(okStatus).send(res.record) : reply.code(statusOf(res.errors)).send({ errors: res.errors });
}

/** Postgres deadlock_detected / serialization_failure: the transaction was rolled back, a retry may succeed. */
const isRetryable = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e.code === '40P01' || e.code === '40001');

/**
 * Postgres class 22 (data exception): usually well-formed JSON carrying a value the database cannot store or
 * compare (NUL characters, numbers out of range, ...), but possibly a cast over stored data the query
 * compiler failed to guard, so it is logged.
 */
const isDataException = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' && e.code.startsWith('22');

/** Maps whatever a route throws to the API's error bodies; unexpected errors never leak their message. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(notFoundBody('Маршрут не найден')));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof QueryError) {
      return reply.code(400).send({ error: { code: err.code, message: err.message, pos: err.pos } });
    }
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => `${i.path.join('.') || 'тело запроса'}: ${i.message}`).join('; ');
      return reply.code(400).send(oneError('bad_request', `Некорректный запрос — ${detail}`));
    }
    if (isRetryable(err)) {
      return reply.code(409).send(oneError('version_conflict', 'Конфликт одновременных изменений, повторите'));
    }
    if (isDataException(err)) {
      req.log.warn({ code: (err as { code: string }).code, message: (err as Error).message }, 'data exception mapped to 400');
      return reply.code(400).send(oneError('bad_request', 'Недопустимое значение в запросе или в данных'));
    }
    // Fastify's own client errors (malformed JSON, unsupported content type, body too large).
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send(oneError('bad_request', 'Некорректный запрос'));
    }
    req.log.error(err);
    return reply.code(500).send(oneError('internal', 'Внутренняя ошибка сервера'));
  });
}
