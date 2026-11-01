import { normalizeNip, todayIn, type CompiledConfig } from '@icrm/core';
import type { ContactService, RecordService, RegistryEntry } from '@icrm/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFoundBody, sendSaved } from '../errors.js';
import { RegistryUnavailable, type NipRegistry } from '../registry/nip-registry.js';

const idParams = z.strictObject({ id: z.guid() });
const nipParams = z.strictObject({ nip: z.string().max(40) });

const oneError = (code: string, message: string): { errors: { code: string; message: string }[] } => ({ errors: [{ code, message }] });

/**
 * Asks the registry about `nip` for the workspace's today. Sends the error reply and returns `null` when
 * there is no entry to use: `nip_invalid` (422), `nip_not_found` (404), `registry_unavailable` (502).
 */
async function lookup(
  o: { registry: NipRegistry; cfg: CompiledConfig; now: () => Date }, reply: FastifyReply, raw: string,
): Promise<RegistryEntry | null> {
  const nip = normalizeNip(raw);
  if (nip === null) {
    await reply.code(422).send(oneError('nip_invalid', 'Некорректный NIP'));
    return null;
  }
  try {
    const entry = await o.registry.lookup(nip, todayIn(o.now(), o.cfg.timezone));
    if (entry === null) await reply.code(404).send(oneError('nip_not_found', `NIP ${nip} не найден в реестре`));
    return entry;
  } catch (e) {
    if (!(e instanceof RegistryUnavailable)) throw e;
    await reply.code(502).send(oneError('registry_unavailable', 'Реестр NIP временно недоступен, повторите позже'));
    return null;
  }
}

/** Filling an organization from the VAT white list by NIP (spec 2b §7.2). */
export function registerRegistryRoutes(app: FastifyInstance, o: {
  contacts: ContactService; records: RecordService; registry: NipRegistry; cfg: CompiledConfig; now: () => Date; systemUserId: string;
}): void {
  app.get('/registry/nip/:nip', async (req, reply) => {
    const { nip } = nipParams.parse(req.params);
    const entry = await lookup(o, reply, nip);
    return entry === null ? reply : entry;
  });

  app.post('/records/:id/registry-refresh', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const org = await o.records.get(id);
    if (org === null || org.archivedAt !== null || !org.sets.some((s) => s.key === 'organization')) {
      return reply.code(404).send(notFoundBody(`Организация ${id} не найдена`));
    }
    const stored = org.data.nip;
    if (typeof stored !== 'string' || stored.trim() === '') return reply.code(422).send(oneError('nip_invalid', 'У организации нет NIP'));
    const entry = await lookup(o, reply, stored);
    if (entry === null) return reply;
    return sendSaved(reply, await o.contacts.applyRegistryEntry({ id, entry, userId: o.systemUserId }), 200);
  });
}
