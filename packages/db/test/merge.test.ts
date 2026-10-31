import { fileURLToPath } from 'node:url';
import type { Value } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import { sql, type Kysely } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { beforeAll, expect, test } from 'vitest';
import {
  createServices, type ContactService, type DB, type IdentityView, type MergeKind, type RecordService, type RecordView,
  type SaveResult, type Services,
} from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts-merge/', import.meta.url));
const NOW = new Date('2026-10-31T10:00:00Z');
const TODAY = '2026-10-31';
const MISSING = '0198a000-0000-7000-8000-000000000000';

let db: Kysely<DB>;
let workspaceId: string;
let userId: string;
let svc: Services;
let rec: RecordService;
let cs: ContactService;
/** What the merge step of these services does: log the merge into `merge_log`, or fail. */
let stepMode: 'log' | 'fail' = 'log';

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  await sql`create table merge_log (kind text not null, source_id uuid not null, target_id uuid not null)`.execute(db);
  const cfg = await loadConfigDir(CONFIG_DIR);
  svc = createServices({
    db, cfg, workspaceId, now: () => NOW,
    mergeSteps: [async (tx, kind: MergeKind, sourceId, targetId) => {
      await sql`insert into merge_log (kind, source_id, target_id) values (${kind}, ${sourceId}, ${targetId})`.execute(tx);
      if (stepMode === 'fail') throw new Error('merge step failed');
    }],
  });
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
const get = async (id: string): Promise<RecordView> => (await rec.get(id))!;

let phoneNo = 100;
const nextPhone = (): string => `+48 601 000 ${String(phoneNo++)}`;

async function addIdentity(ownerId: string, channel: string, address: string): Promise<IdentityView> {
  const r = await svc.identities.add({ ownerId, channel, address, userId });
  if (!r.ok) throw new Error(`identity failed: ${JSON.stringify(r.errors)}`);
  return r.identity;
}

/** A user of the workspace whose contact record is `contactId`. */
async function userFor(contactId: string): Promise<string> {
  const id = uuidv7();
  await db.insertInto('users').values({
    id, workspace_id: workspaceId, email: `${id}@example.test`, name: 'User', contact_record_id: contactId }).execute();
  return id;
}
const userContact = async (id: string): Promise<string | null> =>
  (await db.selectFrom('users').select('contact_record_id').where('id', '=', id).executeTakeFirstOrThrow()).contact_record_id;

const liveMembershipsOf = async (contactId: string): Promise<string[]> =>
  ((await get(contactId)).memberships ?? []).map((m) => m.id);

test('contacts: identities, memberships, incoming links and users move; A is archived with merged_into', async () => {
  const a = await create('Anna Kowalska', ['contact']);
  const b = await create('Anna Kowalska', ['contact']);
  const firma = await create('Firma M', ['organization']);
  const emailOfA = `anna.${String(phoneNo)}@firma-m.pl`;
  await addIdentity(a.id, 'email', emailOfA);
  const phoneOfA = nextPhone();
  await addIdentity(a.id, 'phone', phoneOfA);
  const m = await membership(a, firma, { role: ['техник'] });
  const laptop = await create('Laptop', ['asset'], {}, { assigned: [a.id] });
  const userOfA = await userFor(a.id);

  const p = await cs.mergePreview(a.id, b.id);
  expect(p).toEqual({ ok: true, preview: {
    kind: 'contact', conflicts: [], identities: 2, links: 1, rows: 0,
    memberships: [{ id: m.id, title: 'Anna Kowalska — Firma M', collapsesInto: null }],
  } });

  const r = await cs.merge({ sourceId: a.id, targetId: b.id, userId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.ok && r.record.id).toBe(b.id);
  const aNow = await get(a.id);
  expect(aNow.archivedAt).not.toBeNull();
  expect(aNow.links.merged_into).toEqual([b.id]);
  expect(await cs.resolveAddress('email', emailOfA)).toMatchObject({ contact: { id: b.id } });
  expect(await cs.resolveAddress('phone', phoneOfA)).toMatchObject({ contact: { id: b.id }, organization: { id: firma.id } });
  expect((await get(laptop.id)).links.assigned).toEqual([b.id]);
  expect((await get(m.id)).links.contact).toEqual([b.id]);
  expect(r.ok && r.record.memberships!.map((x) => x.id)).toEqual([m.id]);
  expect(await userContact(userOfA)).toBe(b.id);
  const log = await db.selectFrom('change_log').select(['kind', 'field_key']).where('record_id', '=', a.id).execute();
  expect(log).toEqual(expect.arrayContaining([{ kind: 'link', field_key: 'merged_into' }, { kind: 'archive', field_key: null }]));
});

test('two active memberships in one organization collapse into the one of B', async () => {
  const a = await create('Jan', ['contact']);
  const b = await create('Jan N.', ['contact']);
  const x = await create('Firma X', ['organization']);
  const y = await create('Firma Y', ['organization']);
  const z = await create('Firma Z', ['organization']);
  const mA = await membership(a, x, { role: ['бухгалтер'] });
  const mB = await membership(b, x, { role: ['ЛПР'] });
  const p = nextPhone();
  await addIdentity(mA.id, 'phone', p);
  const kit = await create('Kit', ['asset'], {}, { kit: [mA.id] });
  // both are primary elsewhere: the flag stays with B's membership
  const mA2 = await membership(a, y, { is_primary: true });
  const mB2 = await membership(b, z, { is_primary: true });

  const preview = await cs.mergePreview(a.id, b.id);
  expect(preview.ok && preview.preview.memberships).toEqual(expect.arrayContaining([
    { id: mA.id, title: 'Jan — Firma X', collapsesInto: mB.id },
    { id: mA2.id, title: 'Jan — Firma Y', collapsesInto: null },
  ]));

  const r = await cs.merge({ sourceId: a.id, targetId: b.id, userId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(new Set(await liveMembershipsOf(b.id))).toEqual(new Set([mB.id, mA2.id, mB2.id]));
  expect((await get(mB.id)).data.role).toEqual(['ЛПР', 'бухгалтер']);
  expect(await cs.resolveAddress('phone', p)).toMatchObject({ membership: { id: mB.id }, contact: { id: b.id } });
  expect((await get(kit.id)).links.kit).toEqual([mB.id]);
  const mANow = await get(mA.id);
  expect(mANow.archivedAt).not.toBeNull();
  expect(mANow.data.active_to).toBe(TODAY);
  expect((await get(mA2.id)).data.is_primary).toBe(false);
  expect((await get(mB2.id)).data.is_primary).toBe(true);
  expect(await cs.counterpartyOf(b.id)).toEqual({ id: z.id, title: 'Firma Z' });
});

test('conflicts default to target, choice takes source; empty B fields are filled', async () => {
  const x = await create('X', ['contact']);
  const y = await create('Y', ['contact']);
  const w = await create('W', ['contact']);
  const a = await create('Ola', ['contact', 'vip'], { notes: 'A notes', needs_review: true, vip_level: 3 },
    { referrer: [x.id], friends: [w.id] });
  const b = await create('Ola B.', ['contact'], { notes: 'B notes' }, { referrer: [y.id], friends: [x.id] });

  const p = await cs.mergePreview(a.id, b.id);
  expect(p.ok, JSON.stringify(p)).toBe(true);
  expect(p.ok && p.preview.conflicts).toContainEqual({ field: 'notes', source: 'A notes', target: 'B notes' });
  expect(p.ok && p.preview.conflicts).toContainEqual({ field: 'title', source: 'Ola', target: 'Ola B.' });
  expect(p.ok && p.preview.conflicts).toContainEqual({ field: 'referrer', source: [x.id], target: [y.id] });
  expect(p.ok && p.preview.conflicts).toHaveLength(3);

  const r = await cs.merge({ sourceId: a.id, targetId: b.id, values: { notes: 'source' }, userId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) return;
  expect(r.record.title).toBe('Ola B.');
  expect(r.record.data).toMatchObject({ notes: 'A notes', needs_review: true, vip_level: 3 });
  expect(r.record.sets.map((s) => s.key)).toEqual(['contact', 'vip']);
  expect(r.record.links.referrer).toEqual([y.id]);
  expect(r.record.links.friends).toEqual([x.id, w.id]);

  // a link of one, chosen from the source; a link to B itself is dropped
  const c = await create('Piotr', ['contact'], {}, { referrer: [x.id], friends: [w.id] });
  const d = await create('Piotr P.', ['contact'], {}, { referrer: [y.id], friends: [c.id] });
  const r2 = await cs.merge({ sourceId: d.id, targetId: c.id, values: { referrer: 'source', title: 'source' }, userId });
  expect(r2.ok, JSON.stringify(r2)).toBe(true);
  expect(r2.ok && r2.record).toMatchObject({ title: 'Piotr P.', links: { referrer: [y.id], friends: [w.id] } });

  const unknown = await cs.merge({ sourceId: x.id, targetId: y.id, values: { no_such_field: 'source' }, userId });
  expect(unknown).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'unknown_field', field: 'no_such_field' })] });
});

test('organizations with the same NIP merge; memberships move to B', async () => {
  const a = await create('Firma NIP', ['organization'], { nip: '525-000-00-09', org_kind: 'фирма' });
  const b = await create('Firma NIP sp. z o.o.', ['organization'], { nip: '5260000011' });
  const ewa = await create('Ewa', ['contact']);
  const olek = await create('Olek', ['contact']);
  const mEwaA = await membership(ewa, a, { role: ['техник'], is_primary: true });
  const mEwaB = await membership(ewa, b, { role: ['ЛПР'] });
  const mOlekA = await membership(olek, a);
  const office = nextPhone();
  await addIdentity(a.id, 'phone', office);

  const p = await cs.mergePreview(a.id, b.id);
  expect(p.ok && p.preview).toMatchObject({ kind: 'organization', identities: 1 });
  expect(p.ok && p.preview.conflicts).toContainEqual({ field: 'nip', source: '5250000009', target: '5260000011' });
  expect(p.ok && p.preview.memberships).toEqual(expect.arrayContaining([
    { id: mEwaA.id, title: 'Ewa — Firma NIP', collapsesInto: mEwaB.id },
    { id: mOlekA.id, title: 'Olek — Firma NIP', collapsesInto: null },
  ]));

  const r = await cs.merge({ sourceId: a.id, targetId: b.id, values: { nip: 'source' }, userId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) return;
  expect(r.record.data).toMatchObject({ nip: '5250000009', org_kind: 'фирма' });
  expect(new Set(r.record.memberships!.map((m) => m.id))).toEqual(new Set([mEwaB.id, mOlekA.id]));
  expect((await get(mEwaB.id)).data.role).toEqual(['ЛПР', 'техник']);
  expect((await get(mEwaB.id)).data.is_primary).toBe(true); // the primary flag of the collapsed one conflicts with nothing
  expect((await get(mEwaA.id)).archivedAt).not.toBeNull();
  expect(await cs.resolveAddress('phone', office)).toMatchObject({ organization: { id: b.id } });
  expect(await cs.counterpartyOf(olek.id)).toEqual({ id: b.id, title: 'Firma NIP sp. z o.o.' });
  // B holds the NIP of A now
  const again = await rec.create({ userId, title: 'Copy', sets: ['organization'], data: { nip: '5250000009' } });
  expect(again).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'nip_taken', ownerId: b.id })] });
});

test('rows of A move to B', async () => {
  const a = must(await rec.create({ userId, title: 'Marta', sets: ['contact'], rows: { devices: [
    { sets: ['device'], data: { serial: 'A1' } }, { sets: ['device'], data: { serial: 'A2' } }] } }));
  const b = must(await rec.create({ userId, title: 'Marta', sets: ['contact'], rows: { devices: [
    { sets: ['device'], data: { serial: 'B1' } }] } }));
  const [a1, a2] = a.links.devices!;
  const [b1] = b.links.devices!;

  const p = await cs.mergePreview(a.id, b.id);
  expect(p.ok && p.preview.rows).toBe(2);

  const r = await cs.merge({ sourceId: a.id, targetId: b.id, userId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) return;
  expect(r.record.links.devices).toEqual([b1, a1, a2]);
  expect(r.record.rows!.devices!.map((d) => d.data.serial)).toEqual(['B1', 'A1', 'A2']);
  const owners = await db.selectFrom('records').select(['id', 'owner_id', 'archived_at']).where('id', 'in', [a1!, a2!]).execute();
  expect(owners.map((o) => [o.owner_id, o.archived_at])).toEqual([[b.id, null], [b.id, null]]);
  const row = await get(a1!);
  must(await rec.update({ id: row.id, userId, expectedVersion: row.version, data: { serial: 'A1-x' } }));
  expect((await get(a.id)).archivedAt).not.toBeNull();
});

test('merge steps run inside the transaction', async () => {
  const a = await create('Step A', ['contact']);
  const b = await create('Step B', ['contact']);
  const r = await cs.merge({ sourceId: a.id, targetId: b.id, userId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const logged = await sql<{ kind: string; source_id: string; target_id: string }>`
    select kind, source_id, target_id from merge_log where source_id = ${a.id}`.execute(db);
  expect(logged.rows).toEqual([{ kind: 'contact', source_id: a.id, target_id: b.id }]);

  const c = await create('Step C', ['contact']);
  const d = await create('Step D', ['contact']);
  const phone = nextPhone();
  await addIdentity(c.id, 'phone', phone);
  stepMode = 'fail';
  try {
    await expect(cs.merge({ sourceId: c.id, targetId: d.id, userId })).rejects.toThrow('merge step failed');
  } finally {
    stepMode = 'log';
  }
  expect((await get(c.id)).archivedAt).toBeNull();
  expect(await cs.resolveAddress('phone', phone)).toMatchObject({ contact: { id: c.id } });
  const none = await sql`select 1 from merge_log where source_id = ${c.id}`.execute(db);
  expect(none.rows).toEqual([]);
});

test('kind mismatch, self, archived', async () => {
  const c = await create('Kind C', ['contact']);
  const o = await create('Kind O', ['organization']);
  const gone = await create('Kind gone', ['contact']);
  must(await rec.archive({ id: gone.id, userId }));
  const task = await create('Plain', ['device']);

  const code = async (p: Promise<{ ok: boolean; errors?: { code: string }[] }>): Promise<string | undefined> =>
    (await p).errors?.[0]?.code;
  expect(await code(cs.merge({ sourceId: c.id, targetId: o.id, userId }))).toBe('merge_kind_mismatch');
  expect(await code(cs.mergePreview(c.id, o.id))).toBe('merge_kind_mismatch');
  expect(await code(cs.merge({ sourceId: task.id, targetId: c.id, userId }))).toBe('merge_kind_mismatch');
  expect(await code(cs.merge({ sourceId: c.id, targetId: c.id, userId }))).toBe('merge_self');
  expect(await code(cs.mergePreview(c.id, c.id))).toBe('merge_self');
  expect(await code(cs.merge({ sourceId: gone.id, targetId: c.id, userId }))).toBe('merge_archived');
  expect(await code(cs.merge({ sourceId: c.id, targetId: gone.id, userId }))).toBe('merge_archived');
  expect(await code(cs.merge({ sourceId: MISSING, targetId: c.id, userId }))).toBe('not_found');
  expect(await code(cs.mergePreview(c.id, MISSING))).toBe('not_found');
  expect((await get(c.id)).archivedAt).toBeNull();
});

test('a rule of a source record rejecting the relink rolls the merge back and names the record', async () => {
  const a = await create('Rule A', ['contact']);
  const b = await create('Rule B', ['contact']);
  const phone = nextPhone();
  await addIdentity(a.id, 'phone', phone);
  const account = await create('Konto', ['account'], { locked: true }, { user_of: [a.id] });
  const r = await cs.merge({ sourceId: a.id, targetId: b.id, userId });
  expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'readonly', recordId: account.id, field: 'user_of' })] });
  expect((await get(a.id)).archivedAt).toBeNull();
  expect((await get(account.id)).links.user_of).toEqual([a.id]);
  expect(await cs.resolveAddress('phone', phone)).toMatchObject({ contact: { id: a.id } });
});
