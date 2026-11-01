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

describe('pairs and dismissals', () => {
  // The pair list is global to the workspace, so this block runs on its own database (the blocks above are done).
  beforeAll(async () => {
    ({ db, workspaceId, userId } = await freshDb());
    svc = createServices({ db, cfg: await loadConfigDir(CONFIG_DIR), workspaceId });
  });

  const ref = (r: RecordView) => ({ id: r.id, title: r.title });
  const ordered = (x: RecordView, y: RecordView): [RecordView, RecordView] => (x.id < y.id ? [x, y] : [y, x]);
  const errCode = async (p: Promise<{ ok: true } | { ok: false; errors: { code: string }[] }>): Promise<string> => {
    const r = await p;
    if (r.ok) throw new Error('expected a failure');
    return r.errors[0]!.code;
  };

  test('pairs list each pair once with a.id < b.id, by similarity then ids', async () => {
    const a = await contact('Anna Nowak');
    const b = await contact('Nowak Anna');
    const c = await contact('Piotr Lisowski Zbigniew');
    const d = await contact('Piotr Lisowski Zbigniew Jr');
    const firma = await organization('Firma Pl');
    await membership(c, firma);
    await membership(d, firma);

    const [lo, hi] = ordered(a, b);
    const [clo, chi] = ordered(c, d); // c and d are similar (< 1) and share an organization
    const pairs = await svc.duplicates.pairs('contact');
    expect(pairs).toEqual([
      { a: ref(lo), b: ref(hi), similarity: 1, reasons: ['same_name'] },
      { a: ref(clo), b: ref(chi), similarity: expect.any(Number), reasons: ['similar_name', 'shared_organization'] },
    ]);
    expect(pairs[1]!.similarity).toBeLessThan(1);
    expect(pairs.every((p) => p.a.id < p.b.id)).toBe(true);
    expect(await svc.duplicates.pairs('organization')).toEqual([]);
  });

  test('pairs of organizations, and pagination', async () => {
    const x = await organization('Dwa Razy Sp. z o.o.', { address: 'Lipowa 7' });
    const y = await organization('DWA RAZY', { address: 'Inna 1' });
    const z = await organization('Trzy Razy', { address: 'Lipowa 7' });
    const [pa, pb] = ordered(x, y);
    const all = await svc.duplicates.pairs('organization');
    expect(all.map((p) => [p.a.id, p.b.id]).sort()).toEqual([[pa.id, pb.id], ordered(x, z).map((r) => r.id)].sort());
    expect(all[0]!.reasons).toEqual(['same_name']); // similarity 1 first
    expect(await svc.duplicates.pairs('organization', { limit: 1 })).toEqual([all[0]]);
    expect(await svc.duplicates.pairs('organization', { limit: 1, offset: 1 })).toEqual([all[1]]);
    expect(await svc.duplicates.pairs('organization', { offset: 2 })).toEqual([]);
  });

  test('a dismissed pair stays dismissed after a rename', async () => {
    const a = await contact('Jan Odrzucony');
    const b = await contact('Odrzucony Jan');
    const before = (await svc.duplicates.pairs('contact')).filter((p) => [p.a.id, p.b.id].includes(a.id));
    expect(before).toHaveLength(1);
    expect(await svc.duplicates.dismiss({ a: b.id, b: a.id, userId })).toEqual({ ok: true }); // argument order is free
    expect(await svc.duplicates.dismiss({ a: a.id, b: b.id, userId })).toEqual({ ok: true }); // repeating is harmless
    const rows = await db.selectFrom('duplicate_dismissals').selectAll().where('workspace_id', '=', workspaceId).execute();
    const [lo, hi] = ordered(a, b);
    expect(rows.filter((r) => r.a_id === lo.id)).toEqual([expect.objectContaining({ a_id: lo.id, b_id: hi.id, created_by: userId })]);

    must(await svc.records.update({ id: a.id, userId, expectedVersion: a.version, title: 'Jan  Odrzucony' }));
    expect(await dup(a.id)).toEqual([]);
    expect((await svc.duplicates.pairs('contact')).filter((p) => [p.a.id, p.b.id].includes(a.id))).toEqual([]);
  });

  test('dismiss checks kind, self and liveness', async () => {
    const c = await contact('Kontakt Sprawdzany');
    const o = await organization('Organizacja Sprawdzana');
    const plain = await create('Zwykla', []);
    const gone = await contact('Kontakt Archiwalny');
    must(await svc.records.archive({ id: gone.id, userId }));
    const both = await create('Obie Role', ['contact', 'organization']);
    const d = (a: string, b: string) => svc.duplicates.dismiss({ a, b, userId });

    expect(await errCode(d(c.id, o.id))).toBe('merge_kind_mismatch');
    expect(await errCode(d(c.id, plain.id))).toBe('merge_kind_mismatch');
    expect(await errCode(d(c.id, c.id))).toBe('merge_self');
    expect(await errCode(d(c.id, gone.id))).toBe('not_found');
    expect(await errCode(d(c.id, '0198a000-0000-7000-8000-000000000000'))).toBe('not_found');
    expect(await d(c.id, both.id)).toEqual({ ok: true }); // both are contacts
    expect(await d(o.id, both.id)).toEqual({ ok: true }); // both are organizations
  });
});
