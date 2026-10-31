import { fileURLToPath } from 'node:url';
import type { Value } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import { beforeAll, expect, test } from 'vitest';
import {
  createServices, type ContactService, type IdentityView, type RecordService, type RecordView, type SaveResult, type Services,
} from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts-handover/', import.meta.url));
const NOW = new Date('2026-10-31T10:00:00Z');
const MISSING = '0198a000-0000-7000-8000-000000000000';

let userId: string;
let svc: Services;
let rec: RecordService;
let cs: ContactService;

beforeAll(async () => {
  let workspaceId: string;
  let db;
  ({ db, workspaceId, userId } = await freshDb());
  const cfg = await loadConfigDir(CONFIG_DIR);
  svc = createServices({ db, cfg, workspaceId, now: () => NOW });
  rec = svc.records;
  cs = svc.contacts;
});

function must(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}
const create = async (title: string, sets: string[], data: Record<string, Value> = {}, links: Record<string, string[]> = {}):
  Promise<RecordView> => must(await rec.create({ userId, title, sets, data, links }));
const membership = (c: RecordView, o: RecordView, data: Record<string, Value> = {}): Promise<RecordView> =>
  create('', ['membership'], data, { contact: [c.id], organization: [o.id] });

let phoneNo = 100;
const nextPhone = (): string => `+48 600 000 ${String(phoneNo++)}`;

async function addIdentity(ownerId: string, channel: string, address: string): Promise<IdentityView> {
  const r = await svc.identities.add({ ownerId, channel, address, userId });
  if (!r.ok) throw new Error(`identity failed: ${JSON.stringify(r.errors)}`);
  return r.identity;
}

/** Anna works at Firma X as an accountant; the membership holds a phone, a laptop and an account. */
async function scene(): Promise<{
  firmaX: RecordView; anna: RecordView; ewa: RecordView; m: RecordView; phone: IdentityView; phoneOfM: string;
  laptop: RecordView; account: RecordView; laptopLinkId: string; accountLinkId: string;
}> {
  const firmaX = await create('Firma X', ['organization']);
  const anna = await create('Anna', ['contact']);
  const ewa = await create('Ewa', ['contact']);
  const m0 = await membership(anna, firmaX, { role: ['бухгалтер'], position: 'Główna księgowa' });
  const phoneOfM = nextPhone();
  const phone = await addIdentity(m0.id, 'phone', phoneOfM);
  const laptop = await create('Laptop', ['equipment'], {}, { holder: [m0.id] });
  const account = await create('Konto', ['account'], {}, { user_of: [m0.id] });
  const preview = (await cs.handover(m0.id))!;
  const linkOf = (fromId: string): string => preview.links.find((l) => l.fromId === fromId)!.linkId;
  const m = (await rec.get(m0.id))!;
  return { firmaX, anna, ewa, m, phone, phoneOfM, laptop, account, laptopLinkId: linkOf(laptop.id), accountLinkId: linkOf(account.id) };
}

test('preview lists identities and incoming links', async () => {
  const { m, firmaX, phone, laptop, account } = await scene();
  expect(await cs.handover(m.id)).toEqual({
    identities: [phone],
    links: expect.arrayContaining([
      { linkId: expect.any(String), field: 'holder', fromId: laptop.id, fromTitle: 'Laptop', organizationAllowed: true },
      { linkId: expect.any(String), field: 'user_of', fromId: account.id, fromTitle: 'Konto', organizationAllowed: false },
    ]),
  });
  expect((await cs.handover(m.id))!.links).toHaveLength(2);
  expect(await cs.handover(MISSING)).toBeNull();
  expect(await cs.handover(firmaX.id)).toBeNull();
});

test('end with a new successor: phone and laptop go to the successor', async () => {
  const { m, ewa, phoneOfM, laptop, account } = await scene();
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: { contactId: ewa.id } });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.ok && r.successor!.title).toBe('Ewa — Firma X');
  expect(r.ok && r.successor!.data.role).toEqual(['бухгалтер']);
  expect(r.ok && r.successor!.data.position).toBe('Główna księgowa');
  expect(r.ok && r.membership.data.active_to).toBe('2026-11-30');
  expect((await rec.get(m.id))!.data.active_to).toBe('2026-11-30');
  expect(await cs.resolveAddress('phone', phoneOfM)).toMatchObject({ contact: { id: ewa.id } });
  expect((await rec.get(laptop.id))!.links.holder).toEqual([r.ok ? r.successor!.id : '']);
  expect((await rec.get(account.id))!.links.user_of).toEqual([r.ok ? r.successor!.id : '']);
});

test('end with an existing successor and its own role', async () => {
  const { m, firmaX, ewa, phoneOfM, laptop } = await scene();
  const mEwa = await membership(ewa, firmaX, { role: ['техник'] });
  const r = await cs.endMembership({
    id: m.id, version: m.version, date: '2026-11-30', userId, successor: { membershipId: mEwa.id }, links: { } });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.ok && r.successor).toMatchObject({ id: mEwa.id, data: { role: ['техник'] } });
  expect(await cs.resolveAddress('phone', phoneOfM)).toMatchObject({ membership: { id: mEwa.id }, contact: { id: ewa.id } });
  expect((await rec.get(laptop.id))!.links.holder).toEqual([mEwa.id]);
});

test('end without successor: identities and organization-capable links go to the organization, the rest stay', async () => {
  const { m, firmaX, phoneOfM, laptop, account } = await scene();
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.ok && r.successor).toBeNull();
  expect(await cs.resolveAddress('phone', phoneOfM)).toMatchObject({ contact: null, organization: { id: firmaX.id } });
  expect((await rec.get(laptop.id))!.links.holder).toEqual([firmaX.id]);
  expect((await rec.get(account.id))!.links.user_of).toEqual([m.id]); // keep: the field does not allow an organization
});

test('explicit organization for a link that does not allow it is rejected, nothing changes', async () => {
  const { m, phone, accountLinkId } = await scene();
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null,
    links: { [accountLinkId]: 'organization' } });
  expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });
  expect(!r.ok && r.errors[0]!.message).toContain('Konto');
  expect((await rec.get(m.id))!.data.active_to ?? null).toBeNull();

  const noSuccessor = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null,
    identities: { [phone.id]: 'successor' } });
  expect(noSuccessor).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });
  expect(!noSuccessor.ok && noSuccessor.errors[0]!.message).toContain(phone.display);

  const unknown = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null,
    links: { [MISSING]: 'keep' } });
  expect(unknown).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });
  expect((await rec.get(m.id))!.version).toBe(m.version);
});

test('contact takes the phone; archive and keep', async () => {
  const { m, anna, phone, phoneOfM } = await scene();
  const email = await addIdentity(m.id, 'email', 'anna@firma-x.pl');
  const other = nextPhone();
  const desk = await addIdentity(m.id, 'phone', other);
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-10-30', userId, successor: null,
    identities: { [phone.id]: 'contact', [email.id]: 'archive', [desk.id]: 'keep' } });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(await cs.resolveAddress('phone', phoneOfM)).toMatchObject({ contact: { id: anna.id }, membership: null });
  expect(await cs.resolveAddress('email', 'anna@firma-x.pl')).toMatchObject({ identity: null, contact: null });
  expect(await cs.resolveAddress('phone', other)).toMatchObject({ membership: { id: m.id }, membershipEnded: true });
});

test('a rule of the source record rejecting the relink rolls everything back and names the record', async () => {
  const { m, ewa, phoneOfM, account, accountLinkId } = await scene();
  must(await rec.update({ id: account.id, userId, expectedVersion: account.version, data: { locked: true } }));
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId,
    successor: { contactId: ewa.id }, links: { [accountLinkId]: 'successor' } });
  expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'readonly', recordId: account.id, field: 'user_of' })] });
  expect((await rec.get(m.id))!.data.active_to ?? null).toBeNull();
  expect((await rec.get(ewa.id))!.memberships).toEqual([]);
  expect(await cs.resolveAddress('phone', phoneOfM)).toMatchObject({ membership: { id: m.id } });
});

test('already ended membership and a successor from another organization are rejected', async () => {
  const { m, ewa } = await scene();
  const ended = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null });
  expect(ended.ok).toBe(true);
  const again = await cs.endMembership({
    id: m.id, version: ended.ok ? ended.membership.version : 0, date: '2026-12-01', userId, successor: null });
  expect(again).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'membership_ended' })] });

  const s = await scene();
  const firmaY = await create('Firma Y', ['organization']);
  const elsewhere = await membership(ewa, firmaY);
  const wrongOrg = await cs.endMembership({
    id: s.m.id, version: s.m.version, date: '2026-11-30', userId, successor: { membershipId: elsewhere.id } });
  expect(wrongOrg).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });
  const self = await cs.endMembership({
    id: s.m.id, version: s.m.version, date: '2026-11-30', userId, successor: { membershipId: s.m.id } });
  expect(self).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });
  const missing = await cs.endMembership({ id: MISSING, version: 0, date: '2026-11-30', userId, successor: null });
  expect(missing).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'not_found' })] });
  const stale = await cs.endMembership({ id: s.m.id, version: s.m.version + 1, date: '2026-11-30', userId, successor: null });
  expect(stale).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'version_conflict' })] });
});

test('unassigned and take', async () => {
  const { m, firmaX, ewa, anna, phone, phoneOfM, laptop } = await scene();
  expect((await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null })).ok).toBe(true);
  const free = (await cs.unassigned(firmaX.id))!;
  expect(free.identities.map((i) => i.id)).toEqual([phone.id]);
  expect(free.links).toEqual([
    { linkId: expect.any(String), field: 'holder', fromId: laptop.id, fromTitle: 'Laptop', organizationAllowed: true }]);
  expect(await cs.unassigned(MISSING)).toBeNull();

  const mEwa = await membership(ewa, firmaX);
  const annaPhone = await addIdentity(anna.id, 'phone', nextPhone());
  const foreign = await cs.take({ membershipId: mEwa.id, identities: [annaPhone.id], links: [], userId });
  expect(foreign).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });

  const r = await cs.take({ membershipId: mEwa.id, identities: [phone.id], links: [free.links[0]!.linkId], userId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.ok && r.membership.id).toBe(mEwa.id);
  expect(r.ok && r.successor).toBeNull();
  expect(await cs.resolveAddress('phone', phoneOfM)).toMatchObject({ membership: { id: mEwa.id }, contact: { id: ewa.id } });
  expect((await rec.get(laptop.id))!.links.holder).toEqual([mEwa.id]);
  expect(await cs.unassigned(firmaX.id)).toEqual({ identities: [], links: [] });

  const firmaZ = await create('Firma Z', ['organization']);
  const past = await membership(anna, firmaZ, { active_to: '2026-10-01' });
  const zPhone = await addIdentity(firmaZ.id, 'phone', nextPhone());
  const closed = await cs.take({ membershipId: past.id, identities: [zPhone.id], links: [], userId });
  expect(closed).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });
  const missing = await cs.take({ membershipId: MISSING, identities: [], links: [], userId });
  expect(missing).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'not_found' })] });
});
