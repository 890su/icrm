import { fileURLToPath } from 'node:url';
import type { Value } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import type { Kysely } from 'kysely';
import { beforeAll, expect, test } from 'vitest';
import { createServices, type DB, type RecordService, type RecordView, type SaveResult } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts/', import.meta.url));
const NOW = new Date('2026-10-31T10:00:00Z');

let db: Kysely<DB>;
let userId: string;
let rec: RecordService;

beforeAll(async () => {
  let workspaceId: string;
  ({ db, workspaceId, userId } = await freshDb());
  const cfg = await loadConfigDir(CONFIG_DIR);
  rec = createServices({ db, cfg, workspaceId, now: () => NOW }).records;
});

function must(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}

const person = async (title: string): Promise<RecordView> => must(await rec.create({ userId, title, sets: ['contact'] }));
const firm = async (title: string): Promise<RecordView> => must(await rec.create({ userId, title, sets: ['organization'] }));

const rawMembership = (
  c: RecordView, o: RecordView, data: Record<string, Value> = {},
): Promise<SaveResult> =>
  rec.create({ userId, title: '', sets: ['membership'], data, links: { contact: [c.id], organization: [o.id] } });
const membership = async (
  c: RecordView, o: RecordView, data: Record<string, Value> = {},
): Promise<RecordView> => must(await rawMembership(c, o, data));

test('nip is normalised, validated and unique among live organizations', async () => {
  const a = must(await rec.create({ userId, title: 'Firma A', sets: ['organization'], data: { nip: 'PL 526-025-02-74' } }));
  expect(a.data.nip).toBe('5260250274');
  expect(await rec.create({ userId, title: 'B', sets: ['organization'], data: { nip: '5260250275' } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'nip_invalid', field: 'nip', message: 'Неверный NIP' })] });
  expect(await rec.create({ userId, title: 'C', sets: ['organization'], data: { nip: '5260250274' } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({
      code: 'nip_taken', field: 'nip', ownerId: a.id, ownerTitle: 'Firma A', message: 'NIP уже у «Firma A»' })] });
  await rec.archive({ id: a.id, userId });
  expect((await rec.create({ userId, title: 'D', sets: ['organization'], data: { nip: '5260250274' } })).ok).toBe(true);
});

test('nip is checked on update too; a record keeps its own nip', async () => {
  const x = must(await rec.create({ userId, title: 'X', sets: ['organization'], data: { nip: '7740001454' } }));
  const y = await firm('Y');
  expect(await rec.update({ id: y.id, userId, expectedVersion: y.version, data: { nip: '774-000-14-54' } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'nip_taken', ownerId: x.id })] });
  const same = must(await rec.update({ id: x.id, userId, expectedVersion: x.version, data: { nip: 'PL7740001454', address: 'ul. Długa 5' } }));
  expect(same.data.nip).toBe('7740001454');
  const cleared = must(await rec.update({ id: same.id, userId, expectedVersion: same.version, data: { nip: null } }));
  expect(cleared.data.nip).toBeNull();
  expect((await rec.create({ userId, title: 'Z', sets: ['organization'], data: { nip: '7740001454' } })).ok).toBe(true);
});

test('two concurrent creates with one nip: one wins, the other is nip_taken', async () => {
  const res = await Promise.all(['R1', 'R2'].map((title) =>
    rec.create({ userId, title, sets: ['organization'], data: { nip: '5252344078' } })));
  expect(res.filter((r) => r.ok)).toHaveLength(1);
  expect(res.find((r) => !r.ok)).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'nip_taken', field: 'nip' })] });
});

test('email domains are normalised; public ones are rejected', async () => {
  const o = must(await rec.create({ userId, title: 'O', sets: ['organization'], data: { email_domains: ['@Firma.PL', 'firma.pl', 'biuro.firma.pl'] } }));
  expect(o.data.email_domains).toEqual(['firma.pl', 'biuro.firma.pl']);
  expect(await rec.create({ userId, title: 'P', sets: ['organization'], data: { email_domains: ['gmail.com'] } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({
      code: 'public_domain', field: 'email_domains',
      message: 'Домен gmail.com — публичная почта, по нему нельзя узнать организацию' })] });
  expect(await rec.create({ userId, title: 'Q', sets: ['organization'], data: { email_domains: ['not a domain'] } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_value', field: 'email_domains' })] });
});

test('a new membership gets a title from its contact and organization', async () => {
  const m = await membership(await person('Anna Nowak'), await firm('Firma X'));
  expect(m.title).toBe('Anna Nowak — Firma X');
  const own = must(await rec.create({
    userId, title: 'Własny', sets: ['membership'],
    links: { contact: [(await person('Ewa')).id], organization: [(await firm('Firma E')).id] } }));
  expect(own.title).toBe('Własny');
});

test('a membership without a contact or organization is rejected', async () => {
  const c = await person('Bez Firmy');
  const r = await rec.create({ userId, title: '', sets: ['membership'], links: { contact: [c.id] } });
  expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'required', field: 'organization' })] });
});

test('one active membership per contact and organization; leaving and returning is allowed', async () => {
  const anna = await person('Anna'); const firmaX = await firm('Firma X1');
  const m1 = await membership(anna, firmaX);
  expect(await rawMembership(anna, firmaX)).toEqual({ ok: false, errors: [expect.objectContaining({
    code: 'membership_active_exists', field: 'organization',
    message: 'У контакта уже есть действующее участие в этой организации' })] });
  // a future end date is still active
  expect((await rawMembership(anna, firmaX, { active_to: '2026-10-31' })).ok).toBe(false);
  must(await rec.update({ id: m1.id, userId, expectedVersion: m1.version, data: { active_to: '2026-10-01' } }));
  expect((await rawMembership(anna, firmaX)).ok).toBe(true);
  // a closed membership may be created next to an active one
  expect((await rawMembership(anna, firmaX, { active_to: '2026-01-01' })).ok).toBe(true);
});

test('reopening a closed membership next to an active one is rejected', async () => {
  const c = await person('Reopen'); const o = await firm('Firma Reopen');
  const closed = await membership(c, o, { active_to: '2026-01-01' });
  await membership(c, o);
  expect(await rec.update({ id: closed.id, userId, expectedVersion: closed.version, data: { active_to: null } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'membership_active_exists' })] });
});

test('relinking a membership to a contact who already works there is rejected and rolled back', async () => {
  const jan = await person('Jan'); const anna = await person('Anna R');
  const firmaX = await firm('Firma RX'); const firmaY = await firm('Firma RY');
  await membership(jan, firmaX); const mAnna = await membership(anna, firmaY);
  const mJanY = await membership(jan, firmaY);
  expect(await rec.setLinks({ id: mJanY.id, userId, field: 'organization', targetIds: [firmaX.id] }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'membership_active_exists' })] });
  expect((await rec.get(mJanY.id))!.links.organization).toEqual([firmaY.id]);
  expect((await rec.get(mAnna.id))!.links.organization).toEqual([firmaY.id]);
});

test('relinking a membership\'s contact to one who already works there is rejected and rolled back', async () => {
  const jan = await person('Jan C'); const anna = await person('Anna C');
  const firmaX = await firm('Firma CX');
  const mJan = await membership(jan, firmaX); const mAnna = await membership(anna, firmaX);
  expect(await rec.setLinks({ id: mAnna.id, userId, field: 'contact', targetIds: [jan.id] }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'membership_active_exists' })] });
  const after = (await rec.get(mAnna.id))!;
  expect(after.links.contact).toEqual([anna.id]);
  expect(after.version).toBe(mAnna.version);
  expect((await rec.get(jan.id))!.memberships!.map((m) => m.id)).toEqual([mJan.id]);
});

test('one primary active membership per contact', async () => {
  const c = await person('Primary'); const o1 = await firm('P1'); const o2 = await firm('P2'); const o3 = await firm('P3');
  const first = await membership(c, o1, { is_primary: true });
  expect(await rawMembership(c, o2, { is_primary: true })).toEqual({ ok: false, errors: [expect.objectContaining({
    code: 'primary_conflict', field: 'is_primary', message: 'У контакта уже есть основное участие' })] });
  expect((await rawMembership(c, o2)).ok).toBe(true);
  // a closed primary does not get in the way, and neither does another contact's
  must(await rec.update({ id: first.id, userId, expectedVersion: first.version, data: { active_to: '2026-01-01' } }));
  expect((await rawMembership(c, o3, { is_primary: true })).ok).toBe(true);
  expect((await rawMembership(await person('Other'), o1, { is_primary: true })).ok).toBe(true);
});

test('contact and organization views list memberships', async () => {
  const anna = await person('Anna V'); const jan = await person('Jan V');
  const firmaV = await firm('Firma V'); const firmaW = await firm('Firma W');
  const old = await membership(anna, firmaV, { active_from: '2020-01-01', active_to: '2021-01-01' });
  const current = await membership(anna, firmaW, { active_from: '2024-05-01', role: ['ЛПР'], position: 'Dyrektor', is_primary: true });
  const janV = await membership(jan, firmaV, { active_from: '2025-01-01' });
  const archived = await membership(await person('Gone'), firmaV);
  must(await rec.archive({ id: archived.id, userId }));

  expect((await rec.get(anna.id))!.memberships).toEqual([
    {
      id: current.id, title: 'Anna V — Firma W', contactId: anna.id, contactTitle: 'Anna V',
      organizationId: firmaW.id, organizationTitle: 'Firma W', role: ['ЛПР'], position: 'Dyrektor',
      activeFrom: '2024-05-01', activeTo: null, isPrimary: true, active: true },
    {
      id: old.id, title: 'Anna V — Firma V', contactId: anna.id, contactTitle: 'Anna V',
      organizationId: firmaV.id, organizationTitle: 'Firma V', role: [], position: null,
      activeFrom: '2020-01-01', activeTo: '2021-01-01', isPrimary: false, active: false },
  ]);
  const ofFirm = (await rec.get(firmaV.id))!.memberships!;
  expect(ofFirm.map((m) => m.id)).toEqual([janV.id, old.id]);
  expect(ofFirm[0]).toMatchObject({ contactTitle: 'Jan V', active: true });
  expect((await rec.get(jan.id))!.memberships!.map((m) => m.id)).toEqual([janV.id]);
  expect((await rec.get(firmaV.id))!.links).not.toHaveProperty('memberships');
});

test('two concurrent memberships of one contact and organization: one wins, one live membership remains', async () => {
  const c = await person('Race C'); const o = await firm('Firma Race');
  const res = await Promise.all([rawMembership(c, o), rawMembership(c, o)]);
  expect(res.filter((r) => r.ok)).toHaveLength(1);
  expect(res.find((r) => !r.ok)).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'membership_active_exists' })] });
  expect((await rec.get(c.id))!.memberships).toHaveLength(1);
});

test('two concurrent primary memberships of one contact: one wins, the other is primary_conflict', async () => {
  const c = await person('Race P'); const o1 = await firm('Firma RP1'); const o2 = await firm('Firma RP2');
  const res = await Promise.all([rawMembership(c, o1, { is_primary: true }), rawMembership(c, o2, { is_primary: true })]);
  expect(res.filter((r) => r.ok)).toHaveLength(1);
  expect(res.find((r) => !r.ok)).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'primary_conflict' })] });
  expect((await rec.get(c.id))!.memberships!.filter((m) => m.isPrimary)).toHaveLength(1);
});
