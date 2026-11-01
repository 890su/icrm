import type { DuplicateService, RecordService } from '@icrm/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFoundBody, statusOf } from '../errors.js';

const idParams = z.strictObject({ id: z.guid() });
const listQuery = z.strictObject({
  set: z.enum(['contact', 'organization']),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const dismissBody = z.strictObject({ a: z.guid(), b: z.guid() });

/** Duplicate hints for contacts and organizations (spec 2b §7.1). */
export function registerDuplicateRoutes(
  app: FastifyInstance, o: { duplicates: DuplicateService; records: RecordService; systemUserId: string },
): void {
  app.get('/records/:id/duplicates', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if ((await o.records.get(id)) === null) return reply.code(404).send(notFoundBody(`Запись ${id} не найдена`));
    return { items: await o.duplicates.duplicatesOf(id) };
  });

  app.get('/duplicates', async (req) => {
    const { set, limit, offset } = listQuery.parse(req.query);
    return { items: await o.duplicates.pairs(set, { limit, offset }) };
  });

  app.post('/duplicates/dismiss', async (req, reply) => {
    const b = dismissBody.parse(req.body);
    const res = await o.duplicates.dismiss({ a: b.a, b: b.b, userId: o.systemUserId });
    return res.ok ? reply.code(204).send() : reply.code(statusOf(res.errors)).send({ errors: res.errors });
  });
}
