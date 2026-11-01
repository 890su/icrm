import { fileURLToPath } from 'node:url';
import type { Value } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import { beforeAll, expect, test } from 'vitest';
import { createServices, type RecordView, type RegistryEntry, type SaveResult, type Services } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts/', import.meta.url));
const NOW = new Date('2026-11-01T09:30:00Z');
const CHECKED = '2026-11-01T09:30:00.000Z';

let userId: string;
let svc: Services;

beforeAll(async () => {
  const fresh = await freshDb();
  userId = fresh.userId;
  svc = createServices({ db: fresh.db, cfg: await loadConfigDir(CONFIG_DIR), workspaceId: fresh.workspaceId, now: () => NOW });
});

function must(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}
const create = async (title: string, sets: string[], data: Record<string, Value> = {}): Promise<RecordView> =>
  must(await svc.records.create({ userId, title, sets, data }));

const ENTRY: RegistryEntry = {
  nip: '5260250274', name: 'FIRMA X SP. Z O.O.', address: 'DŁUGA 5, 00-001 WARSZAWA', regon: '012345678', krs: '0000123456',
  vatStatus: 'czynny', bankAccounts: ['12345678901234567890123456'],
};

test('fills empty title and address only, always overwrites registry fields', async () => {
  const empty = await create('', ['organization'], { nip: '5260250274' });
  const filled = must(await svc.contacts.applyRegistryEntry({ id: empty.id, entry: ENTRY, userId }));
  expect(filled.title).toBe('FIRMA X SP. Z O.O.');
  expect(filled.version).toBe(empty.version + 1);
  expect(filled.data).toMatchObject({
    nip: '5260250274', address: 'DŁUGA 5, 00-001 WARSZAWA', regon: '012345678', krs: '0000123456', vat_status: 'czynny',
    bank_accounts: ['12345678901234567890123456'], registry_checked_at: CHECKED,
  });

  const named = await create('Moja nazwa', ['organization'], {
    nip: '5252344078', address: 'Mój adres 1', regon: 'stary', vat_status: 'zwolniony', bank_accounts: ['1', '2'] });
  const kept = must(await svc.contacts.applyRegistryEntry({
    id: named.id, entry: { ...ENTRY, nip: '5252344078', regon: null, krs: null, vatStatus: null, bankAccounts: [] }, userId }));
  expect(kept.title).toBe('Moja nazwa');
  expect(kept.data.address).toBe('Mój adres 1');
  expect(kept.data.regon ?? null).toBeNull();
  expect(kept.data.vat_status ?? null).toBeNull();
  expect(kept.data.bank_accounts ?? null).toBeNull();
  expect(kept.data.registry_checked_at).toBe(CHECKED);
});

test('not an organization → not_found; no nip → nip_invalid; unknown id → not_found', async () => {
  const anna = await create('Anna', ['contact']);
  const r1 = await svc.contacts.applyRegistryEntry({ id: anna.id, entry: ENTRY, userId });
  expect(r1).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'not_found' })] });

  const nonip = await create('Bez NIP', ['organization']);
  const r2 = await svc.contacts.applyRegistryEntry({ id: nonip.id, entry: ENTRY, userId });
  expect(r2).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'nip_invalid', message: 'У организации нет NIP' })] });
  expect((await svc.records.get(nonip.id))!.version).toBe(nonip.version);

  const r3 = await svc.contacts.applyRegistryEntry({ id: '0198a000-0000-7000-8000-000000000000', entry: ENTRY, userId });
  expect(r3).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'not_found' })] });
});

test('an archived organization → not_found', async () => {
  const org = await create('Archiwalna', ['organization'], { nip: '1234563218' });
  must(await svc.records.archive({ id: org.id, userId }));
  const r = await svc.contacts.applyRegistryEntry({ id: org.id, entry: { ...ENTRY, nip: '1234563218' }, userId });
  expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'not_found' })] });
});

test('an entry for another NIP than the organization has now → version_conflict, nothing written', async () => {
  const org = await create('Zmieniony NIP', ['organization'], { nip: '7740001454' });
  const r = await svc.contacts.applyRegistryEntry({ id: org.id, entry: { ...ENTRY, nip: '1111503006' }, userId });
  expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'version_conflict' })] });
  const after = await svc.records.get(org.id);
  expect(after!.version).toBe(org.version);
  expect(after!.data.registry_checked_at ?? null).toBeNull();
  // the same NIP written differently is the same NIP
  must(await svc.contacts.applyRegistryEntry({ id: org.id, entry: { ...ENTRY, nip: '7740001454' }, userId }));
});
