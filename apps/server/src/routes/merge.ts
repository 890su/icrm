import type { ContactService } from '@icrm/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendSaved, statusOf } from '../errors.js';

const idParams = z.strictObject({ id: z.guid() });
const previewQuery = z.strictObject({ into: z.guid() });
const mergeBody = z.strictObject({
  into: z.guid(),
  values: z.record(z.string(), z.enum(['source', 'target'])).optional(),
});

/** Merging duplicate contacts and organizations (spec 2a §6): `:id` is merged into `into`. */
export function registerMergeRoutes(app: FastifyInstance, o: { contacts: ContactService; systemUserId: string }): void {
  app.get('/records/:id/merge-preview', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { into } = previewQuery.parse(req.query);
    const res = await o.contacts.mergePreview(id, into);
    return res.ok ? res.preview : reply.code(statusOf(res.errors)).send({ errors: res.errors });
  });

  app.post('/records/:id/merge', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = mergeBody.parse(req.body);
    return sendSaved(reply, await o.contacts.merge({ sourceId: id, targetId: b.into, values: b.values, userId: o.systemUserId }), 200);
  });
}
