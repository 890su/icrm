import { fileURLToPath } from 'node:url';
import type { Value } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import type { Kysely } from 'kysely';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createServices, type DB, type ImportRow, type ImportTable, type RecordView, type SaveResult, type Services,
} from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts/', import.meta.url));
const NOW = new Date('2026-11-01T12:00:00Z');

let db: Kysely<DB>;
let workspaceId: string;
let userId: string;
let svc: Services;
let imp: Services['imports'];

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  svc = createServices({ db, cfg: await loadConfigDir(CONFIG_DIR), workspaceId, now: () => NOW });
  imp = svc.imports;
});

function must(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}
const create = async (title: string, sets: string[], data: Record<string, Value> = {}, links: Record<string, string[]> = {}):
  Promise<RecordView> => must(await svc.records.create({ userId, title, sets, data, links }));
async function address(ownerId: string, channel: string, value: string): Promise<void> {
  const r = await svc.identities.add({ ownerId, channel, address: value, userId });
  if (!r.ok) throw new Error(`identity failed: ${JSON.stringify(r.errors)}`);
}

const table = (headers: string[], rows: string[][]): ImportTable =>
  ({ headers, rows: rows.map((cells, i) => ({ line: i + 2, cells })) });

let nextLine = 1;
/** One import row; `org`/`nip`/`orgData` make an organization, `role`/`position` a membership. */
function row(o: {
  title?: string; phone?: string; email?: string; notes?: string; data?: Record<string, string>;
  org?: string; nip?: string; orgData?: Record<string, string>; role?: string; position?: string;
}): ImportRow {
  const identities: ImportRow['identities'] = [];
  if (o.phone !== undefined) identities.push({ channel: 'phone', address: o.phone });
  if (o.email !== undefined) identities.push({ channel: 'email', address: o.email });
  const hasOrg = o.org !== undefined || o.nip !== undefined || o.orgData !== undefined;
  return {
    line: nextLine++,
    contact: { title: o.title ?? null, data: { ...(o.notes === undefined ? {} : { notes: o.notes }), ...o.data } },
    identities,
    organization: hasOrg ? { title: o.org ?? null, nip: o.nip ?? null, data: o.orgData ?? {} } : null,
    membership: o.role !== undefined || o.position !== undefined
      ? { role: o.role === undefined ? [] : [o.role], position: o.position ?? null } : null,
  };
}

async function counts(): Promise<Record<string, number>> {
  const n = async (t: 'records' | 'identities' | 'links' | 'change_log'): Promise<number> =>
    Number((await db.selectFrom(t).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  return { records: await n('records'), identities: await n('identities'), links: await n('links'), log: await n('change_log') };
}

const identitiesOf = async (ownerId: string): Promise<string[]> =>
  (await svc.identities.liveOf(db, [ownerId])).map((i) => i.address);

describe('rowsFromTable', () => {
  test('mapping: joins title columns, rejects unknown targets and duplicate headers', () => {
    expect(imp.rowsFromTable(table(['Imię', 'Nazwisko', 'Tel'], [['Anna', 'Nowak', '600100200']]),
      { 'Imię': 'contact.title', 'Nazwisko': 'contact.title', Tel: 'identity.phone' }))
      .toEqual({ ok: true, rows: [expect.objectContaining({ contact: { title: 'Anna Nowak', data: {} },
        identities: [{ channel: 'phone', address: '600100200' }] })] });
    expect(imp.rowsFromTable(table(['A'], []), { A: 'contact.no_such' })).toEqual({ ok: false,
      errors: [expect.objectContaining({ code: 'invalid_value', field: 'mapping.A' })] });
    expect(imp.rowsFromTable(table(['A'], []), { A: 'contact.merged_into' })).toEqual({ ok: false,
      errors: [expect.objectContaining({ code: 'invalid_value', field: 'mapping.A' })] });
    expect(imp.rowsFromTable(table(['A', 'B'], []), { A: 'organization.title', B: 'organization.title' })).toEqual({ ok: false,
      errors: [expect.objectContaining({ code: 'invalid_value', field: 'mapping.B' })] });
    expect(imp.rowsFromTable(table(['A', 'A'], []), { A: 'contact.title' })).toEqual({ ok: false,
      errors: [expect.objectContaining({ code: 'invalid_value', field: 'mapping.A' })] });
    expect(imp.rowsFromTable(table(['A'], []), { A: 'identity.fax' })).toEqual({ ok: false,
      errors: [expect.objectContaining({ code: 'invalid_value', field: 'mapping.A' })] });
    expect(imp.rowsFromTable(table(['A'], []), { Z: 'contact.title' })).toEqual({ ok: false,
      errors: [expect.objectContaining({ code: 'invalid_value', field: 'mapping.Z' })] });
  });

  test('mapping: organization, membership, repeated address and role columns; extra cells and skip ignored', () => {
    const res = imp.rowsFromTable(
      table(['Name', 'Mail', 'Mail 2', 'Firma', 'NIP', 'Typ', 'Rola', 'Rola 2', 'Stanowisko', 'Uwagi', 'X'], [
        ['Jan', 'jan@x.pl', 'j@x.pl', 'Firma X', '526-025-02-74', 'фирма', 'ЛПР', 'бухгалтер', 'CEO', 'notatka', 'pomiń', 'extra'],
        ['Ola', '', '', '', '', '', '', '', '', '', ''],
      ]),
      {
        Name: 'contact.title', Mail: 'identity.email', 'Mail 2': 'identity.email', Firma: 'organization.title',
        NIP: 'organization.nip', Typ: 'organization.org_kind', Rola: 'membership.role', 'Rola 2': 'membership.role',
        Stanowisko: 'membership.position', Uwagi: 'contact.notes', X: 'skip',
      });
    expect(res).toEqual({ ok: true, rows: [
      expect.objectContaining({
        line: 2,
        contact: { title: 'Jan', data: { notes: 'notatka' } },
        identities: [{ channel: 'email', address: 'jan@x.pl' }, { channel: 'email', address: 'j@x.pl' }],
        organization: { title: 'Firma X', nip: '526-025-02-74', data: { org_kind: 'фирма' } },
        membership: { role: ['ЛПР', 'бухгалтер'], position: 'CEO' },
      }),
      expect.objectContaining({ line: 3, contact: { title: 'Ola', data: {} }, identities: [], organization: null, membership: null }),
    ] });
  });
});

describe('preview', () => {
  test('preview creates then updates within one file and writes nothing', async () => {
    const before = await counts();
    const res = await imp.preview([row({ title: 'Anna', phone: '600100200' }), row({ title: 'Anna N.', phone: '+48600100200', email: 'a@x.pl' })]);
    expect(res.map((r) => r.action)).toEqual(['create', 'update']);
    expect(await counts()).toEqual(before);
  });

  test('an organization created by an earlier row is found by NIP and by name, with one membership', async () => {
    const res = await imp.preview([
      row({ title: 'Piotr', email: 'piotr@omega.pl', org: 'Omega Sp. z o.o.', nip: '1111190300' }),
      row({ title: 'Piotr', email: 'piotr@omega.pl', org: 'Omega', nip: '1111190300' }),
      row({ title: 'Ewa', email: 'ewa@omega.pl', org: 'OMEGA S.A.' }),
    ]);
    expect(res).toEqual([
      expect.objectContaining({ action: 'create', organization: { action: 'create' }, membership: 'create' }),
      expect.objectContaining({ action: 'update', organization: { action: 'found' }, membership: 'exists' }),
      expect.objectContaining({ action: 'create', organization: { action: 'found' }, membership: 'create' }),
    ]);
  });

  test('a cell that does not fit its field is a warning naming the column', async () => {
    const mapped = imp.rowsFromTable(table(['Kto', 'Sprawdzić'], [['Zenon', 'może']]),
      { Kto: 'contact.title', 'Sprawdzić': 'contact.needs_review' });
    if (!mapped.ok) throw new Error('mapping failed');
    const [res] = await imp.preview(mapped.rows);
    expect(res).toEqual(expect.objectContaining({ action: 'create' }));
    expect(res!.warnings).toEqual([expect.stringContaining('«Sprawdzić»')]);
  });
});

describe('commit', () => {
  test('importing the same file twice creates nothing the second time', async () => {
    const rows = [row({ title: 'Jan', email: 'jan@firma-x.pl', org: 'Firma X Sp. z o.o.', nip: '5260250274', role: 'бухгалтер' })];
    const first = await imp.commit(rows, userId);
    expect(first.map((r) => r.action)).toEqual(['create']);
    expect(first[0]).toEqual(expect.objectContaining({ membership: 'create', organization: expect.objectContaining({ action: 'create' }) }));
    const after = await counts();
    expect((await imp.commit(rows, userId))).toEqual([expect.objectContaining({ action: 'update', membership: 'exists',
      organization: expect.objectContaining({ action: 'found' }) })]);
    expect(await counts()).toEqual(after);

    const contact = must({ ok: true, record: (await svc.records.get(first[0]!.contactId!))! });
    expect(contact.memberships).toEqual([expect.objectContaining({
      organizationId: first[0]!.organization!.id, role: ['бухгалтер'], title: 'Jan — Firma X Sp. z o.o.' })]);
    expect(await identitiesOf(contact.id)).toEqual(['jan@firma-x.pl']);
    const org = await svc.records.get(first[0]!.organization!.id!);
    expect(org?.data.nip).toBe('5260250274');
  });

  test('phone of one contact and email of another → ambiguous_match, nothing changed', async () => {
    const a = await create('Adam', ['contact']);
    const b = await create('Bogdan', ['contact']);
    await address(a.id, 'phone', '600200300');
    await address(b.id, 'email', 'bogdan@x.pl');
    const before = await counts();
    const res = await imp.commit([row({ title: 'Adam B.', phone: '600 200 300', email: 'BOGDAN@x.pl', org: 'Nowa firma' })], userId);
    expect(res).toEqual([expect.objectContaining({ action: 'skip', reason: 'ambiguous_match' })]);
    expect(await counts()).toEqual(before);
  });

  test('empty row and invalid addresses', async () => {
    const res = await imp.preview([row({}), row({ notes: 'tylko notatka' }), row({ title: 'Kazimierz', phone: '12' })]);
    expect(res.map((r) => [r.action, r.reason])).toEqual([['skip', 'empty_row'], ['skip', 'empty_row'], ['create', undefined]]);
    expect(res[2]!.warnings).toEqual([expect.stringContaining('«12»')]);

    const [done] = await imp.commit([row({ title: 'Kazimierz', phone: '12' })], userId);
    expect(done).toEqual(expect.objectContaining({ action: 'create' }));
    expect(await identitiesOf(done!.contactId!)).toEqual([]);
  });

  test('a contact without a name is created from its address', async () => {
    const [done] = await imp.commit([row({ email: 'anonim@x.pl' })], userId);
    expect(done).toEqual(expect.objectContaining({ action: 'create' }));
    expect((await svc.records.get(done!.contactId!))?.title).toBe('anonim@x.pl');
  });

  test('update fills only empty fields and adds only new addresses', async () => {
    const c = await create('Celina', ['contact'], { notes: 'stare' });
    await address(c.id, 'phone', '600300400');
    const res = await imp.commit([row({ title: 'Celina Inna', phone: '+48 600 300 400', email: 'celina@x.pl', notes: 'nowe',
      data: { needs_review: 'tak' } })], userId);
    expect(res).toEqual([expect.objectContaining({ action: 'update', contactId: c.id, organization: null, membership: null })]);
    const after = await svc.records.get(c.id);
    expect(after?.title).toBe('Celina');
    expect(after?.data).toEqual(expect.objectContaining({ notes: 'stare', needs_review: true }));
    expect(await identitiesOf(c.id)).toEqual(['+48600300400', 'celina@x.pl']);
  });

  test('organization found by NIP, else by normalised name, else created; no title and no NIP → warning', async () => {
    const alfa = await create('Alfa Sp. z o.o.', ['organization'], { nip: '1111269496' });
    const res = await imp.commit([
      row({ title: 'Org 1', org: 'Zupełnie inna nazwa', nip: '111-126-94-96' }),
      row({ title: 'Org 2', org: 'ALFA, sp. z o.o' }),
      row({ title: 'Org 3', org: 'Beta' }),
      row({ title: 'Org 4', nip: '123' }),
      row({ title: 'Org 5', nip: '1111348681' }),
      row({ title: 'Org 6', org: 'Sp. z o.o.' }),
    ], userId);
    expect(res.map((r) => r.action)).toEqual(['create', 'create', 'create', 'create', 'create', 'create']);
    expect(res[0]!.organization).toEqual({ action: 'found', id: alfa.id });
    expect(res[1]!.organization).toEqual({ action: 'found', id: alfa.id });
    expect(res[2]!.organization).toEqual({ action: 'create', id: expect.any(String) });
    expect(res[2]!.membership).toBe('create');
    expect(res[3]!.organization).toBeNull();
    expect(res[3]!.warnings).toEqual([expect.stringContaining('«123»'), expect.stringContaining('организац')]);
    expect(res[4]!.organization).toBeNull();
    expect(res[4]!.warnings).toEqual([expect.stringContaining('организац')]);
    // A name that is only a legal form has no key: never matches, and "Sp. z o.o." is created as is.
    expect(res[5]!.organization).toEqual({ action: 'create', id: expect.any(String) });
    expect((await svc.records.get(alfa.id))?.title).toBe('Alfa Sp. z o.o.');
  });

  test('an address owned by an organization is not a person match', async () => {
    const org = await create('Firma Biuro', ['organization']);
    await address(org.id, 'email', 'biuro@firma-biuro.pl');
    const [res] = await imp.commit([row({ title: 'Ola', email: 'biuro@firma-biuro.pl' })], userId);
    expect(res).toEqual(expect.objectContaining({ action: 'create' }));
    expect(res!.warnings).toEqual([expect.stringContaining('biuro@firma-biuro.pl')]);
    expect(await identitiesOf(res!.contactId!)).toEqual([]);
    expect(await identitiesOf(org.id)).toEqual(['biuro@firma-biuro.pl']);
  });

  test('an address owned by a membership matches its contact', async () => {
    const person = await create('Dorota', ['contact']);
    const org = await create('Firma Dorota', ['organization']);
    const m = await create('', ['membership'], {}, { contact: [person.id], organization: [org.id] });
    await address(m.id, 'phone', '600400500');
    const [res] = await imp.commit([row({ title: 'Dorota', phone: '600400500', org: 'Firma Dorota' })], userId);
    expect(res).toEqual(expect.objectContaining({ action: 'update', contactId: person.id, membership: 'exists',
      organization: { action: 'found', id: org.id } }));
    expect(await identitiesOf(person.id)).toEqual([]);
  });

  test('a failing row does not stop the others', async () => {
    const res = await imp.commit([
      row({ title: 'R1', email: 'r1@x.pl' }),
      row({ title: 'R2', email: 'r2@x.pl', org: 'Gamma', orgData: { org_kind: 'нет такого' } }),
      row({ title: 'R3' }),
    ], userId);
    expect(res.map((r) => r.action)).toEqual(['create', 'error', 'create']);
    expect(res[1]!.errors).toEqual([expect.objectContaining({ field: 'org_kind' })]);
    const r2 = await db.selectFrom('records').select('id').where('title', 'in', ['R2', 'Gamma']).execute();
    expect(r2).toEqual([]);
    expect((await svc.contacts.resolveAddress('email', 'r2@x.pl'))).toEqual(expect.objectContaining({ identity: null }));
  });
});
