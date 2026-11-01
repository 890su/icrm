import type { Value } from '@icrm/core';
import type { DuplicateService, RecordService } from '@icrm/db';
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

// A row op is one of three strict, mutually exclusive shapes (spec §1.12); anything else is a 400.
const newRow = z.strictObject({ title: z.string().optional(), data: data.optional(), sets: keys.optional() });
const changeRow = z.strictObject({
  id: z.guid(),
  version: z.number().int().min(0),
  title: z.string().optional(),
  data: data.optional(),
  enableSets: keys.optional(),
  disableSets: keys.optional(),
});
const deleteRow = z.strictObject({ id: z.guid(), delete: z.literal(true) });
const rows = z.record(z.string(), z.array(z.union([newRow, changeRow, deleteRow])));

const createBody = z.strictObject({
  title: z.string(), data: data.optional(), sets: keys.optional(), links: z.record(z.string(), ids).optional(),
  rows: rows.optional(),
});
const patchBody = z.strictObject({
  version: z.number().int().min(0),
  title: z.string().optional(),
  data: data.optional(),
  enableSets: keys.optional(),
  disableSets: keys.optional(),
  rows: rows.optional(),
});
const linksBody = z.strictObject({ targetIds: ids });

export function registerRecordRoutes(
  app: FastifyInstance, o: { service: RecordService; duplicates: DuplicateService; systemUserId: string },
): void {
  const userId = o.systemUserId;

  app.post('/records', async (req, reply) => {
    const b = createBody.parse(req.body);
    const res = await o.service.create({ userId, ...b });
    // A hint for a new contact/organization, looked up after the save: it never blocks or fails the save.
    if (res.ok && res.record.sets.some((s) => s.key === 'contact' || s.key === 'organization')) {
      // The record is already committed: a failing lookup must not turn that into an error (a retry would duplicate it).
      let possibleDuplicates: Awaited<ReturnType<DuplicateService['duplicatesOf']>> = [];
      try {
        possibleDuplicates = await o.duplicates.duplicatesOf(res.record.id);
      } catch (err) {
        req.log.warn({ err, recordId: res.record.id }, 'possibleDuplicates lookup failed after a successful save');
      }
      return reply.code(201).send({ ...res.record, possibleDuplicates });
    }
    return sendSaved(reply, res, 201);
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
