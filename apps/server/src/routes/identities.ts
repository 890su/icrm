import type { IdentityResult, IdentityService } from '@icrm/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { statusOf } from '../errors.js';

const idParams = z.strictObject({ id: z.guid() });
const addBody = z.strictObject({
  channel: z.string(), address: z.string(), label: z.string().nullable().optional(), verified: z.boolean().optional(),
});
const patchBody = z.strictObject({
  label: z.string().nullable().optional(), verified: z.boolean().optional(), display: z.string().optional(),
});
const moveBody = z.strictObject({ to: z.guid() });
const searchQuery = z.strictObject({ q: z.string() });

/** Sends the identity with `okStatus`, or the service's errors with the status they map to. */
function sendIdentity(reply: FastifyReply, res: IdentityResult, okStatus: number): FastifyReply {
  return res.ok ? reply.code(okStatus).send(res.identity) : reply.code(statusOf(res.errors)).send({ errors: res.errors });
}

export function registerIdentityRoutes(
  app: FastifyInstance, o: { identities: IdentityService; systemUserId: string },
): void {
  const userId = o.systemUserId;

  app.post('/records/:id/identities', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = addBody.parse(req.body);
    return sendIdentity(reply, await o.identities.add({ ownerId: id, userId, ...b }), 201);
  });

  app.patch('/identities/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = patchBody.parse(req.body);
    return sendIdentity(reply, await o.identities.update({ id, userId, ...b }), 200);
  });

  app.post('/identities/:id/move', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { to } = moveBody.parse(req.body);
    return sendIdentity(reply, await o.identities.move({ id, to, userId }), 200);
  });

  app.delete('/identities/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return sendIdentity(reply, await o.identities.archive({ id, userId }), 200);
  });

  app.get('/identities', async (req) => {
    const { q } = searchQuery.parse(req.query);
    return { items: await o.identities.search(q) };
  });
}
