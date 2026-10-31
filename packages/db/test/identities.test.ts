import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { beforeAll, expect, test } from 'vitest';
import { createServices, type DB, type IdentityService, type RecordView, type Services } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts/', import.meta.url));
const NOW = new Date('2026-10-31T10:00:00Z');
const MISSING = '018f0000-0000-7000-8000-000000000000';

let db: Kysely<DB>;
let userId: string;
let workspaceId: string;
let svc: Services;
let ids: IdentityService;

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  const cfg = await loadConfigDir(CONFIG_DIR);
  svc = createServices({ db, cfg, workspaceId, now: () => NOW });
  ids = svc.identities;
});

async function make(title: string, sets: string[]): Promise<RecordView> {
  const r = await svc.records.create({ userId, title, sets });
  if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}
const contact = (title: string): Promise<RecordView> => make(title, ['contact']);

async function changeKinds(recordId: string): Promise<{ kind: string; source: string }[]> {
  return db.selectFrom('change_log').select(['kind', 'source']).where('record_id', '=', recordId).orderBy('id').execute();
}

async function identityLog(recordId: string): Promise<{ old: unknown; new: unknown; source: string }[]> {
  return db.selectFrom('change_log').select(['old', 'new', 'source'])
    .where('record_id', '=', recordId).where('kind', '=', 'identity').orderBy('id').execute();
}

test('one phone in different spellings is one address', async () => {
  const anna = await contact('Anna'); const jan = await contact('Jan');
  expect((await ids.add({ ownerId: anna.id, channel: 'phone', address: '600 100 200', userId })).ok).toBe(true);
  for (const spelling of ['+48 600-100-200', '0048600100200']) {
    expect(await ids.add({ ownerId: jan.id, channel: 'phone', address: spelling, userId })).toEqual({ ok: false, errors: [
      expect.objectContaining({ code: 'identity_taken', ownerId: anna.id, ownerTitle: 'Anna', message: 'Адрес уже принадлежит «Anna»' })] });
  }
});

test('whatsapp is stored as phone', async () => {
  const r = await ids.add({ ownerId: (await contact('W')).id, channel: 'whatsapp', address: '+48 601 000 001', userId });
  expect(r).toMatchObject({ ok: true, identity: { channel: 'phone', address: '+48601000001', display: '+48 601 000 001' } });
});

test('two concurrent adds of one address: one wins, the other is identity_taken', async () => {
  const owners = [await contact('A'), await contact('B')];
  const res = await Promise.all(owners.map((c) => ids.add({ ownerId: c.id, channel: 'email', address: 'race@firma.pl', userId })));
  expect(res.filter((r) => r.ok)).toHaveLength(1);
  const winner = owners[res.findIndex((r) => r.ok)]!;
  expect(res.find((r) => !r.ok)).toEqual({ ok: false, errors: [
    expect.objectContaining({ code: 'identity_taken', ownerId: winner.id, ownerTitle: winner.title })] });
});

test('archiving the owner frees its addresses', async () => {
  const old = await contact('Old'); await ids.add({ ownerId: old.id, channel: 'email', address: 'x@firma.pl', userId });
  expect((await svc.records.archive({ id: old.id, userId })).ok).toBe(true);
  const fresh = await contact('New');
  expect((await ids.add({ ownerId: fresh.id, channel: 'email', address: 'X@firma.pl', userId })).ok).toBe(true);
  expect(await changeKinds(old.id)).toContainEqual({ kind: 'identity', source: 'cascade' });
  expect(await ids.liveOf(db, [old.id])).toEqual([]);
});

test('a record with several of the owner sets has its addresses archived and logged once', async () => {
  const both = await make('Both', ['contact', 'organization']);
  await ids.add({ ownerId: both.id, channel: 'email', address: 'both@firma.pl', userId });
  expect((await svc.records.archive({ id: both.id, userId })).ok).toBe(true);
  expect((await identityLog(both.id)).filter((e) => e.source === 'cascade')).toHaveLength(1);
});

test('owner must be a live contact, membership or organization', async () => {
  const task = await make('Task', []);
  expect(await ids.add({ ownerId: task.id, channel: 'email', address: 'a@b.pl', userId })).toEqual({
    ok: false,
    errors: [expect.objectContaining({ code: 'invalid_owner', message: 'Владельцем адреса может быть контакт, участие или организация' })],
  });
  const gone = await contact('Gone');
  await svc.records.archive({ id: gone.id, userId });
  expect(await ids.add({ ownerId: gone.id, channel: 'email', address: 'a@b.pl', userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_owner' })] });
  expect(await ids.add({ ownerId: MISSING, channel: 'email', address: 'a@b.pl', userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_owner' })] });
});

test('an organization and a membership can own addresses', async () => {
  const org = await make('Firma', ['organization']);
  expect((await ids.add({ ownerId: org.id, channel: 'email', address: 'biuro@firma.pl', userId })).ok).toBe(true);
  const c = await contact('Person');
  const m = await svc.records.create({ userId, title: '', sets: ['membership'], links: { contact: [c.id], organization: [org.id] } });
  if (!m.ok) throw new Error(JSON.stringify(m.errors));
  expect((await ids.add({ ownerId: m.record.id, channel: 'telegram', address: '@person_one', userId })).ok).toBe(true);
});

test('move logs both owners and keeps the owner versions', async () => {
  const c = await contact('Mover'); const org = await make('Firma M', ['organization']);
  const added = await ids.add({ ownerId: c.id, channel: 'email', address: 'move@firma.pl', userId });
  if (!added.ok) throw new Error('add failed');
  const moved = await ids.move({ id: added.identity.id, to: org.id, userId });
  expect(moved).toMatchObject({ ok: true, identity: { id: added.identity.id, ownerId: org.id } });
  const obj = { identityId: added.identity.id, channel: 'email', address: 'move@firma.pl' };
  expect(await identityLog(c.id)).toEqual([
    { old: null, new: obj, source: 'user' }, { old: obj, new: null, source: 'user' }]);
  expect(await identityLog(org.id)).toEqual([{ old: null, new: obj, source: 'user' }]);
  expect((await svc.records.get(c.id))!.version).toBe(c.version);
  expect((await svc.records.get(org.id))!.version).toBe(org.version);
  expect((await svc.records.get(org.id))!.identities).toHaveLength(1);
  expect((await svc.records.get(c.id))!.identities).toEqual([]);
  // to the same owner: nothing changes
  expect(await ids.move({ id: added.identity.id, to: org.id, userId })).toMatchObject({ ok: true, identity: { ownerId: org.id } });
  expect(await identityLog(org.id)).toHaveLength(1);
  // to a record that cannot own
  const task = await make('T', []);
  expect(await ids.move({ id: added.identity.id, to: task.id, userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_owner' })] });
});

test('archive keeps the row, logs, and frees the address; archived ones cannot change', async () => {
  const c = await contact('Arch'); const d = await contact('Other');
  const added = await ids.add({ ownerId: c.id, channel: 'email', address: 'arch@firma.pl', userId });
  if (!added.ok) throw new Error('add failed');
  const done = await ids.archive({ id: added.identity.id, userId });
  expect(done).toMatchObject({ ok: true, identity: { archivedAt: NOW.toISOString() } });
  const obj = { identityId: added.identity.id, channel: 'email', address: 'arch@firma.pl' };
  expect(await identityLog(c.id)).toEqual([{ old: null, new: obj, source: 'user' }, { old: obj, new: null, source: 'user' }]);
  for (const r of [await ids.archive({ id: added.identity.id, userId }), await ids.update({ id: added.identity.id, label: 'x', userId }),
    await ids.move({ id: added.identity.id, to: d.id, userId })]) {
    expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'archived' })] });
  }
  expect((await ids.add({ ownerId: d.id, channel: 'email', address: 'arch@firma.pl', userId })).ok).toBe(true);
  expect(await ids.archive({ id: MISSING, userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'not_found' })] });
});

test('update changes label, verified and display', async () => {
  const c = await contact('Upd');
  const added = await ids.add({ ownerId: c.id, channel: 'phone', address: '601 222 333', label: 'work', userId });
  if (!added.ok) throw new Error('add failed');
  expect(added.identity).toMatchObject({ label: 'work', verified: false });
  const r = await ids.update({ id: added.identity.id, label: null, verified: true, display: '+48 601-222-333', userId });
  expect(r).toMatchObject({ ok: true, identity: { label: null, verified: true, display: '+48 601-222-333', address: '+48601222333' } });
  expect(await ids.update({ id: added.identity.id, display: '+48 602 222 333', userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_address' })] });
});

test('invalid address and unknown channel', async () => {
  const c = await contact('Bad');
  expect(await ids.add({ ownerId: c.id, channel: 'phone', address: '12', userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_address', message: 'Не похоже на номер телефона' })] });
  expect(await ids.add({ ownerId: c.id, channel: 'sms', address: '+48 600 100 200', userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_address' })] });
});

test('views carry live identities; search finds by part of the address', async () => {
  const c = await contact('Viewed');
  await ids.add({ ownerId: c.id, channel: 'phone', address: '777 100 200', userId });
  const mail = await ids.add({ ownerId: c.id, channel: 'email', address: 'viewed@searchfirma.pl', userId });
  if (!mail.ok) throw new Error('add failed');
  const view = await svc.records.get(c.id);
  expect(view!.identities!.map((i) => i.channel)).toEqual(['phone', 'email']);
  const found = await ids.search('100 200');
  expect(found).toContainEqual(expect.objectContaining({ ownerId: c.id, address: '+48777100200', ownerTitle: 'Viewed' }));
  expect((await ids.search('searchfirma')).map((i) => i.id)).toEqual([mail.identity.id]);
  expect(await ids.search('+48777')).toHaveLength(1);
  expect(await ids.search('100%200')).toEqual([]);
  expect(await ids.search('  ')).toEqual([]);
  await ids.archive({ id: mail.identity.id, userId });
  expect(await ids.search('searchfirma')).toEqual([]);
  expect((await svc.records.get(c.id))!.identities).toHaveLength(1);
  expect((await svc.records.get((await make('Plain', [])).id))!.identities).toBeUndefined();
});

test('the live address and NIP unique indexes exist', async () => {
  const r = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename in ('identities', 'records')`.execute(db);
  expect(r.rows.map((x) => x.indexname)).toEqual(expect.arrayContaining(['identities_live_address', 'identities_owner', 'records_live_nip']));
});
