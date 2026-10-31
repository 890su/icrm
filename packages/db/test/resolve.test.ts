import { fileURLToPath } from 'node:url';
import type { Value } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import type { Kysely } from 'kysely';
import { beforeAll, expect, test } from 'vitest';
import { createServices, type DB, type RecordView, type SaveResult, type Services } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts/', import.meta.url));
const NOW = new Date('2026-10-31T10:00:00Z');

let userId: string;
let db: Kysely<DB>;
let svc: Services;

beforeAll(async () => {
  let workspaceId: string;
  ({ db, workspaceId, userId } = await freshDb());
  const cfg = await loadConfigDir(CONFIG_DIR);
  svc = createServices({ db, cfg, workspaceId, now: () => NOW });
});

function must(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}
const person = async (title: string): Promise<RecordView> => must(await svc.records.create({ userId, title, sets: ['contact'] }));
const firm = async (title: string, data: Record<string, Value> = {}): Promise<RecordView> =>
  must(await svc.records.create({ userId, title, sets: ['organization'], data }));
const membership = async (c: RecordView, o: RecordView, data: Record<string, Value> = {}): Promise<RecordView> =>
  must(await svc.records.create({
    userId, title: '', sets: ['membership'], data, links: { contact: [c.id], organization: [o.id] },
  }));
const end = async (m: RecordView, date: string): Promise<RecordView> =>
  must(await svc.records.update({ id: m.id, userId, expectedVersion: m.version, data: { active_to: date } }));

test('address of a contact → contact and its single active counterparty', async () => {
  const anna = await person('Anna'); const firmaX = await firm('Firma X');
  await svc.identities.add({ ownerId: anna.id, channel: 'email', address: 'anna@prywatna.pl', userId });
  await membership(anna, firmaX);
  expect(await svc.contacts.resolveAddress('email', 'Anna@Prywatna.pl')).toMatchObject({
    ok: true, identity: { address: 'anna@prywatna.pl' }, contact: { id: anna.id, title: 'Anna' }, membership: null,
    organization: { id: firmaX.id, title: 'Firma X' }, membershipEnded: false, hints: [],
  });
});

test('address of a membership → person and organization; ended membership is flagged', async () => {
  const anna = await person('Anna M'); const firmaY = await firm('Firma Y');
  const m = await membership(anna, firmaY);
  await svc.identities.add({ ownerId: m.id, channel: 'whatsapp', address: '+48 602 000 002', userId });
  expect(await svc.contacts.resolveAddress('phone', '602000002')).toMatchObject({
    contact: { id: anna.id }, membership: { id: m.id }, organization: { id: firmaY.id }, membershipEnded: false });
  await end(m, '2026-10-01');
  expect(await svc.contacts.resolveAddress('whatsapp', '+48602000002')).toMatchObject({
    contact: { id: anna.id }, membership: { id: m.id }, organization: { id: firmaY.id }, membershipEnded: true });
});

test('address of an organization → organization without a person', async () => {
  const firmaZ = await firm('Firma Z');
  await svc.identities.add({ ownerId: firmaZ.id, channel: 'phone', address: '22 100 20 30', userId });
  expect(await svc.contacts.resolveAddress('phone', '+48221002030')).toMatchObject({
    ok: true, contact: null, membership: null, organization: { id: firmaZ.id, title: 'Firma Z' }, membershipEnded: false });
});

test('unknown email → hints by email domain; unknown phone → no hints', async () => {
  const firmaH = await firm('Firma H', { email_domains: ['firma-h.pl'] });
  await firm('Firma Other', { email_domains: ['other.pl'] });
  expect(await svc.contacts.resolveAddress('email', 'nowy@Firma-H.pl')).toMatchObject({
    ok: true, identity: null, contact: null, membership: null, organization: null,
    hints: [{ id: firmaH.id, title: 'Firma H' }] });
  expect(await svc.contacts.resolveAddress('phone', '+48 699 999 999')).toMatchObject({
    ok: true, identity: null, hints: [] });
});

test('archived organizations are not hinted', async () => {
  const gone = await firm('Firma Gone', { email_domains: ['gone.pl'] });
  expect(await svc.contacts.resolveAddress('email', 'a@gone.pl')).toMatchObject({ hints: [{ id: gone.id }] });
  await svc.records.archive({ id: gone.id, userId });
  expect(await svc.contacts.resolveAddress('email', 'a@gone.pl')).toMatchObject({ hints: [] });
});

test('invalid address', async () => {
  expect(await svc.contacts.resolveAddress('phone', '12')).toEqual({
    ok: false, errors: [expect.objectContaining({ code: 'invalid_address' })] });
  expect(await svc.contacts.resolveAddress('fax', '123456789')).toEqual({
    ok: false, errors: [expect.objectContaining({ code: 'invalid_address' })] });
});

test('counterpartyOf: none, one, several with and without a primary one', async () => {
  const c = await person('Multi'); const x = await firm('M-X'); const y = await firm('M-Y'); const z = await firm('M-Z');
  const svcC = svc.contacts;
  expect(await svcC.counterpartyOf(c.id)).toBeNull();
  const mx = await membership(c, x);
  expect(await svcC.counterpartyOf(c.id)).toEqual({ id: x.id, title: 'M-X' });
  await membership(c, y);
  expect(await svcC.counterpartyOf(c.id)).toBeNull();
  const mz = await membership(c, z, { is_primary: true });
  expect(await svcC.counterpartyOf(c.id)).toEqual({ id: z.id, title: 'M-Z' });
  await end(mz, '2026-10-01');
  expect(await svcC.counterpartyOf(c.id)).toBeNull();
  await end(mx, '2026-10-02');
  expect(await svcC.counterpartyOf(c.id)).toEqual({ id: y.id, title: 'M-Y' });
});

test('archived organization is not a counterparty or the organization of a membership', async () => {
  const c = await person('Arch'); const gone = await firm('Firma Arch');
  const m = await membership(c, gone);
  await svc.identities.add({ ownerId: c.id, channel: 'email', address: 'arch@prywatna.pl', userId });
  await svc.identities.add({ ownerId: m.id, channel: 'phone', address: '+48 603 000 003', userId });
  await svc.records.archive({ id: gone.id, userId });
  expect(await svc.contacts.resolveAddress('email', 'arch@prywatna.pl')).toMatchObject({
    contact: { id: c.id }, organization: null });
  expect(await svc.contacts.resolveAddress('phone', '603000003')).toMatchObject({
    contact: { id: c.id }, membership: { id: m.id }, organization: null });
  expect(await svc.contacts.counterpartyOf(c.id)).toBeNull();
});

test('a live organization is still the counterparty when the other one is archived', async () => {
  const c = await person('Arch2'); const gone = await firm('Firma Gone2'); const live = await firm('Firma Live2');
  await membership(c, gone); await membership(c, live);
  expect(await svc.contacts.counterpartyOf(c.id)).toBeNull();
  await svc.records.archive({ id: gone.id, userId });
  expect(await svc.contacts.counterpartyOf(c.id)).toEqual({ id: live.id, title: 'Firma Live2' });
});

test('archived contact of a membership is not returned as its contact', async () => {
  const c = await person('Arch3'); const f = await firm('Firma Arch3');
  const m = await membership(c, f);
  await svc.identities.add({ ownerId: m.id, channel: 'phone', address: '+48 604 000 004', userId });
  await svc.records.archive({ id: c.id, userId });
  expect(await svc.contacts.resolveAddress('phone', '604000004')).toMatchObject({
    contact: null, membership: { id: m.id }, organization: { id: f.id } });
});

test('an address whose owner is archived resolves as not found', async () => {
  const c = await person('Arch4');
  await svc.identities.add({ ownerId: c.id, channel: 'email', address: 'arch4@prywatna.pl', userId });
  // Archived behind the services' back, so that the address is still live.
  await db.updateTable('records').set({ archived_at: NOW }).where('id', '=', c.id).execute();
  expect(await svc.contacts.resolveAddress('email', 'arch4@prywatna.pl')).toMatchObject({
    ok: true, identity: null, contact: null, organization: null });
});

test('an email whose owner is archived gets the domain hints of an unknown one', async () => {
  const firmaK = await firm('Firma K', { email_domains: ['firma-k.pl'] });
  const c = await person('Arch5');
  await svc.identities.add({ ownerId: c.id, channel: 'email', address: 'arch5@firma-k.pl', userId });
  await db.updateTable('records').set({ archived_at: NOW }).where('id', '=', c.id).execute();
  expect(await svc.contacts.resolveAddress('email', 'arch5@firma-k.pl')).toEqual({
    ok: true, identity: null, contact: null, membership: null, organization: null, membershipEnded: false,
    hints: [{ id: firmaK.id, title: 'Firma K' }] });
});

test('an owner that is neither a contact, a membership nor an organization resolves as not found', async () => {
  const firmaL = await firm('Firma L', { email_domains: ['firma-l.pl'] });
  const o = await firm('Firma Lost');
  await svc.identities.add({ ownerId: o.id, channel: 'email', address: 'biuro@firma-l.pl', userId });
  // The set is dropped behind the services' back, so that the address is still live.
  await db.deleteFrom('record_sets').where('record_id', '=', o.id).where('set_key', '=', 'organization').execute();
  expect(await svc.contacts.resolveAddress('email', 'biuro@firma-l.pl')).toEqual({
    ok: true, identity: null, contact: null, membership: null, organization: null, membershipEnded: false,
    hints: [{ id: firmaL.id, title: 'Firma L' }] });
});
