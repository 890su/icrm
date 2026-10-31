import type { ContactService, HandoverResult } from '@icrm/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFoundBody, statusOf } from '../errors.js';

const idParams = z.strictObject({ id: z.guid() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата ГГГГ-ММ-ДД');
const successor = z.union([
  z.strictObject({ membershipId: z.guid() }),
  z.strictObject({ contactId: z.guid(), role: z.array(z.string()).optional(), position: z.string().nullable().optional() }),
  z.null(),
]);
const endBody = z.strictObject({
  version: z.number().int().min(0),
  date,
  successor,
  identities: z.record(z.string(), z.enum(['successor', 'organization', 'contact', 'keep', 'archive'])).optional(),
  links: z.record(z.string(), z.enum(['successor', 'organization', 'keep'])).optional(),
});
const takeBody = z.strictObject({ identities: z.array(z.guid()), links: z.array(z.guid()) });

/** Sends `{membership, successor}` with 200, or the service's errors with the status they map to. */
function sendHandover(reply: FastifyReply, res: HandoverResult): FastifyReply {
  return res.ok
    ? reply.code(200).send({ membership: res.membership, successor: res.successor })
    : reply.code(statusOf(res.errors)).send({ errors: res.errors });
}

/** Leaving an organization and handing over what hangs on the membership (spec 2a §5). */
export function registerMembershipRoutes(app: FastifyInstance, o: { contacts: ContactService; systemUserId: string }): void {
  const userId = o.systemUserId;

  app.get('/memberships/:id/handover', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const preview = await o.contacts.handover(id);
    return preview ?? reply.code(404).send(notFoundBody(`Участие ${id} не найдено`));
  });

  app.post('/memberships/:id/end', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = endBody.parse(req.body);
    return sendHandover(reply, await o.contacts.endMembership({ id, userId, ...b }));
  });

  app.get('/organizations/:id/unassigned', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const free = await o.contacts.unassigned(id);
    return free ?? reply.code(404).send(notFoundBody(`Организация ${id} не найдена`));
  });

  app.post('/memberships/:id/take', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = takeBody.parse(req.body);
    return sendHandover(reply, await o.contacts.take({ membershipId: id, userId, ...b }));
  });
}
