import type { Value } from '@icrm/core';
import type { RecordService } from '@icrm/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFoundBody, sendSaved } from '../errors.js';

// Only the shape of a value is checked here; whether it fits the field is up to the engine (422).
const value: z.ZodType<Value> = z.lazy(() => z.union([
  z.null(), z.number(), z.string(), z.boolean(),
  z.strictObject({ amount: z.string(), currency: z.string() }),
  z.array(value),
]));

const data = z.record(z.string(), value);
const keys = z.array(z.string());
const ids = z.array(z.guid());

const idParams = z.strictObject({ id: z.guid() });
const linkParams = z.strictObject({ id: z.guid(), field: z.string() });

const createBody = z.strictObject({
  title: z.string(), data: data.optional(), sets: keys.optional(), links: z.record(z.string(), ids).optional(),
});
const patchBody = z.strictObject({
  version: z.number().int().min(0),
  title: z.string().optional(),
  data: data.optional(),
  enableSets: keys.optional(),
  disableSets: keys.optional(),
});
const linksBody = z.strictObject({ targetIds: ids });

export function registerRecordRoutes(
  app: FastifyInstance, o: { service: RecordService; systemUserId: string },
): void {
  const userId = o.systemUserId;

  app.post('/records', async (req, reply) => {
    const b = createBody.parse(req.body);
    return sendSaved(reply, await o.service.create({ userId, ...b }), 201);
  });

  app.get('/records/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const record = await o.service.get(id);
    return record ?? reply.code(404).send(notFoundBody(`Запись ${id} не найдена`));
  });

  app.patch('/records/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { version, ...b } = patchBody.parse(req.body);
    return sendSaved(reply, await o.service.update({ id, userId, expectedVersion: version, ...b }), 200);
  });

  app.put('/records/:id/links/:field', async (req, reply) => {
    const { id, field } = linkParams.parse(req.params);
    const { targetIds } = linksBody.parse(req.body);
    return sendSaved(reply, await o.service.setLinks({ id, userId, field, targetIds }), 200);
  });

  app.post('/records/:id/archive', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return sendSaved(reply, await o.service.archive({ id, userId }), 200);
  });
}
