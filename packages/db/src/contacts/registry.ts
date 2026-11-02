import { isEmpty, normalizeNip, type Value } from '@icrm/core';
import { loadRecords } from '../repo/records.js';
import { notFound, recordError, SaveFailed } from '../service/errors.js';
import type { RecordService, SaveResult } from '../service/record-service.js';

/** What the VAT white list knows about a taxpayer (spec 2b §7.2). */
export interface RegistryEntry {
  nip: string;
  name: string;
  address: string | null;
  regon: string | null;
  krs: string | null;
  vatStatus: 'czynny' | 'zwolniony' | 'niezarejestrowany' | null;
  bankAccounts: string[];
}

export interface ApplyRegistryDeps {
  records: RecordService;
  workspaceId: string;
  now: () => Date;
}

const emptyAsNull = (v: Value | undefined): Value => (v === undefined || isEmpty(v) ? null : v);

/**
 * Fills an organization from a registry entry in one transaction (spec 2b §7.2): its title and address only
 * when empty, the registry's own fields (`regon`, `krs`, `vat_status`, `bank_accounts`) always, and
 * `registry_checked_at` with the time of the check. `not_found` for a record that is not a live organization,
 * `nip_invalid` for one without a NIP, `version_conflict` when its NIP is no longer the entry's. The result is the view of the organization after commit.
 */
export async function applyRegistryEntry(
  d: ApplyRegistryDeps, i: { id: string; entry: RegistryEntry; userId: string },
): Promise<SaveResult> {
  const { entry } = i;
  const res = await d.records.transaction(i.userId, async (ops) => {
    const org = (await loadRecords(ops.tx, [i.id], { workspaceId: d.workspaceId, forUpdate: true })).get(i.id);
    if (org === undefined || org.archivedAt !== null || !org.sets.has('organization')) throw new SaveFailed([notFound(i.id)]);
    if (isEmpty(org.data.nip ?? null)) throw new SaveFailed([recordError('nip_invalid', 'У организации нет NIP', { field: 'nip' })]);
    // The entry was looked up before the lock: a NIP changed since then makes it another taxpayer's.
    // Both sides normalised: the registry's answer is passed on as the service wrote it.
    if (normalizeNip(String(org.data.nip)) !== normalizeNip(entry.nip)) {
      throw new SaveFailed([recordError('version_conflict', 'NIP организации изменился во время проверки, повторите', { field: 'nip' })]);
    }

    const data: Record<string, Value> = {
      regon: emptyAsNull(entry.regon),
      krs: emptyAsNull(entry.krs),
      vat_status: emptyAsNull(entry.vatStatus),
      bank_accounts: emptyAsNull(entry.bankAccounts),
      registry_checked_at: d.now().toISOString(),
    };
    if (isEmpty(org.data.address ?? null) && entry.address !== null) data.address = entry.address;
    const title = isEmpty(org.title) ? entry.name : undefined;
    await ops.update({
      id: i.id, userId: i.userId, expectedVersion: org.version, data, system: true, ...(title === undefined ? {} : { title }),
    });
  });
  if (!res.ok) return res;
  const record = await d.records.get(i.id);
  return record === null ? { ok: false, errors: [notFound(i.id)] } : { ok: true, record };
}
