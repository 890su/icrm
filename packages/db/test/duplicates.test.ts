import { fileURLToPath } from 'node:url';
import type { Value } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import { sql, type Kysely } from 'kysely';
import { beforeAll, describe, expect, test } from 'vitest';
import { createServices, type DB, type RecordView, type SaveResult, type Services } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/contacts/', import.meta.url));

let db: Kysely<DB>;
let workspaceId: string;
let userId: string;
let svc: Services;

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  svc = createServices({ db, cfg: await loadConfigDir(CONFIG_DIR), workspaceId });
});

function must(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}
const create = async (title: string, sets: string[], data: Record<string, Value> = {}, links: Record<string, string[]> = {}):
  Promise<RecordView> => must(await svc.records.create({ userId, title, sets, data, links }));
const contact = (title: string): Promise<RecordView> => create(title, ['contact']);
const organization = (title: string, data: Record<string, Value> = {}): Promise<RecordView> =>
  create(title, ['organization'], data);
const membership = (c: RecordView, o: RecordView, data: Record<string, Value> = {}): Promise<RecordView> =>
  create('', ['membership'], data, { contact: [c.id], organization: [o.id] });
async function email(ownerId: string, address: string): Promise<void> {
  const r = await svc.identities.add({ ownerId, channel: 'email', address, userId });
  if (!r.ok) throw new Error(`identity failed: ${JSON.stringify(r.errors)}`);
}
const dup = (id: string) => svc.duplicates.duplicatesOf(id);

describe('contacts', () => {
  test('same normalised name is a candidate regardless of order and diacritics', async () => {
    const a = await contact('Nowak Anna');
    const b = await contact('Anna Nowák');
    expect(await dup(a.id)).toEqual([{ id: b.id, title: 'Anna Nowák', similarity: 1, reasons: ['same_name'] }]);
    expect(await dup(b.id)).toEqual([{ id: a.id, title: 'Nowak Anna', similarity: 1, reasons: ['same_name'] }]);
  });

  test('a similar name needs a shared organization or email domain', async () => {
    const a = await contact('Katarzyna Wiśniewska');
    const b = await contact('Katarzyna Wisniewsk');
    const firmaX = await organization('Firma Kw');
    expect(await dup(a.id)).toEqual([]);
    await membership(a, firmaX);
    await membership(b, firmaX, { active_to: '2026-01-01' }); // a closed one counts too
    expect(await dup(a.id)).toEqual([expect.objectContaining({ id: b.id, reasons: ['similar_name', 'shared_organization'] })]);
    const [found] = await dup(a.id);
    expect(found!.similarity).toBeGreaterThanOrEqual(0.6);
    expect(found!.similarity).toBeLessThan(1);
  });

  test('shared email domain, but not a public one', async () => {
    const a = await contact('Tomasz Zielinski');
    const b = await contact('Tomasz Zielinsky');
    expect(await dup(a.id)).toEqual([]);
    await email(a.id, 'tomasz@gmail.com');
    await email(b.id, 'tz@gmail.com');
    expect(await dup(a.id)).toEqual([]);
    await email(a.id, 'tomasz@firma-tz.pl');
    expect(await dup(a.id)).toEqual([]);
    await email(b.id, 'tz@firma-tz.pl');
    expect(await dup(a.id)).toEqual([expect.objectContaining({ id: b.id, reasons: ['similar_name', 'shared_email_domain'] })]);
  });

  test('the domain of an address owned by a membership counts for its contact', async () => {
    const a = await contact('Marcin Wojciechowski');
    const b = await contact('Marcin Wojciechowsk');
    const firma = await organization('Firma Mw');
    const m = await membership(b, firma);
    await email(m.id, 'marcin@mw-firma.pl');
    await email(a.id, 'm.wojciechowski@mw-firma.pl');
    expect(await dup(a.id)).toEqual([expect.objectContaining({
      id: b.id, reasons: ['similar_name', 'shared_email_domain'] })]);
  });

  test('all reasons that hold are listed, in order', async () => {
    const a = await contact('Ewa Lewandowska');
    const b = await contact('Lewandowska Ewa');
    const firma = await organization('Firma El');
    await membership(a, firma);
    await membership(b, firma);
    await email(a.id, 'ewa@el-firma.pl');
    await email(b.id, 'e.l@el-firma.pl');
    expect(await dup(a.id)).toEqual([{
      id: b.id, title: 'Lewandowska Ewa', similarity: 1,
      reasons: ['same_name', 'shared_organization', 'shared_email_domain'],
    }]);
  });

  test('candidates are ordered by similarity, then id', async () => {
    const a = await contact('Piotr Kaminski Zbigniew');
    const exact = await contact('Zbigniew Kaminski Piotr');
    const near = await contact('Piotr Kaminski Zbigniew Jr');
    const firma = await organization('Firma Pk');
    await membership(a, firma);
    await membership(near, firma);
    const found = await dup(a.id);
    expect(found.map((c) => c.id)).toEqual([exact.id, near.id]);
    expect(found[0]!.similarity).toBe(1);
  });

  test('an empty normalised name matches nothing', async () => {
    const a = await contact('...');
    await contact('---');
    expect(await dup(a.id)).toEqual([]);
  });

  test('pairs in duplicate_dismissals are not offered', async () => {
    const a = await contact('Jan Dismissed');
    const b = await contact('Dismissed Jan');
    expect(await dup(a.id)).toHaveLength(1);
    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await db.insertInto('duplicate_dismissals').values({ workspace_id: workspaceId, a_id: lo!, b_id: hi! }).execute();
    expect(await dup(a.id)).toEqual([]);
    expect(await dup(b.id)).toEqual([]);
  });
});

describe('organizations', () => {
  test('same name without legal form, shared domain, same address', async () => {
    const a = await organization('Firma X Sp. z o.o.', { email_domains: ['firma-x.pl'], address: 'ul. Długa 5' });
    const b = await organization('FIRMA X', { email_domains: ['firma-x.pl', 'x.com.pl'], address: 'Długa 5' });
    expect(await dup(a.id)).toEqual([{
      id: b.id, title: 'FIRMA X', similarity: 1, reasons: ['same_name', 'shared_email_domain', 'same_address'] }]);
  });

  test('similar name needs 0.7; a shared domain or address alone is enough', async () => {
    const a = await organization('Budimex Instalacje', { email_domains: ['bi.pl'], address: 'Krótka 1' });
    const similar = await organization('Budimex Instalacja'); // trigram similarity above 0.7
    const farName = await organization('Zupelnie Inna Nazwa', { email_domains: ['bi.pl'] });
    const sameAddress = await organization('Cos Innego', { address: 'ul. Krótka 1' });
    const unrelated = await organization('Trzecia Firma', { email_domains: ['trzecia.pl'], address: 'Inna 9' });
    const found = await dup(a.id);
    expect(found.map((c) => [c.id, c.reasons])).toEqual(expect.arrayContaining([
      [similar.id, ['similar_name']], [farName.id, ['shared_email_domain']], [sameAddress.id, ['same_address']],
    ]));
    expect(found.map((c) => c.id)).not.toContain(unrelated.id);
    expect(found).toHaveLength(3);
  });

  test('a name of 0.4..0.7 similarity is not enough for an organization', async () => {
    const a = await organization('Alfa Beta Gamma Delta');
    const b = await organization('Alfa Beta Gamma Epsilon Zeta');
    const sim = (await sql<{ s: number }>`select similarity('alfa beta delta gamma', 'alfa beta epsilon gamma zeta') as s`
      .execute(db)).rows[0]!.s;
    expect(sim).toBeGreaterThan(0.4);
    expect(sim).toBeLessThan(0.7);
    expect((await dup(a.id)).map((c) => c.id)).not.toContain(b.id);
  });

  test('a name that is only a legal form has no key', async () => {
    const a = await organization('Sp. z o.o.');
    await organization('S.A.');
    expect(await dup(a.id)).toEqual([]);
  });
});

describe('liveness and the index', () => {
  test('archived records and records that lost the set are never candidates', async () => {
    const a = await contact('Halina Archiwalna');
    const b = await contact('Archiwalna Halina');
    const c = await create('Archiwalna Halina', ['contact', 'organization']);
    expect((await dup(a.id)).map((x) => x.id).sort()).toEqual([b.id, c.id].sort());
    must(await svc.records.archive({ id: b.id, userId }));
    expect((await dup(a.id)).map((x) => x.id)).toEqual([c.id]);
    await sql`delete from record_sets where record_id = ${c.id} and set_key = 'contact'`.execute(db);
    expect(await dup(a.id)).toEqual([]);
    expect(await dup(b.id)).toEqual([]); // the archived record itself has no candidates
  });

  test('other records and unknown ids give no candidates', async () => {
    const plain = await create('Nowak Anna', []);
    expect(await dup(plain.id)).toEqual([]);
    expect(await dup('0198a000-0000-7000-8000-000000000000')).toEqual([]);
  });

  test('a rename and a new address are indexed on save', async () => {
    const a = await organization('Stara Nazwa', { address: 'Lipowa 1' });
    const b = await organization('Zupelnie Inny', { address: 'Lipowa 1' });
    expect((await dup(a.id)).map((x) => x.reasons)).toEqual([['same_address']]);
    must(await svc.records.update({
      id: b.id, userId, expectedVersion: b.version, title: 'Stara Nazwa', data: { address: 'Klonowa 2' } }));
    expect(await dup(a.id)).toEqual([expect.objectContaining({ id: b.id, reasons: ['same_name'] })]);
  });

  test('reindex indexes records saved before the index existed', async () => {
    const a = await contact('Roman Reindeksowy');
    const b = await contact('Reindeksowy Roman');
    await sql`delete from record_search`.execute(db);
    expect(await dup(a.id)).toEqual([]);
    const n = await svc.duplicates.reindex();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await dup(a.id)).toEqual([expect.objectContaining({ id: b.id })]);
    expect(await svc.duplicates.reindex()).toBe(n); // idempotent
    const rows = await db.selectFrom('record_search').select('record_id').execute();
    expect(rows.length).toBe(n);
  });
});
