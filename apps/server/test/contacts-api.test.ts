import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import { freshDb } from '@icrm/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';

const TOKEN = 'test-token-0123456789';
const fixture = (...p: string[]): string => fileURLToPath(new URL(['fixtures', ...p].join('/'), import.meta.url));
const MISSING = '0198a000-0000-7000-8000-000000000000';

let app: FastifyInstance;

beforeAll(async () => {
  const fresh = await freshDb();
  const cfg = await loadConfigDir(fixture('contacts'));
  app = buildServer({
    db: fresh.db, cfg, workspaceId: fresh.workspaceId, systemUserId: fresh.userId, apiToken: TOKEN,
    now: () => new Date('2026-10-31T10:00:00Z'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

type Res = LightMyRequestResponse;

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<Res> =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${TOKEN}` } });

async function create(title: string, sets: string[]): Promise<{ id: string; version: number }> {
  const r = await call('POST', '/records', { title, sets });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}

describe('identities', () => {
  test('add → 201, taken → 422 with the current owner, view carries identities', async () => {
    const anna = await create('Anna', ['contact']);
    const jan = await create('Jan', ['contact']);
    const added = await call('POST', `/records/${anna.id}/identities`, { channel: 'phone', address: '600 100 200', label: 'work' });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({
      ownerId: anna.id, channel: 'phone', address: '+48600100200', display: '600 100 200', label: 'work', verified: false, archivedAt: null });

    const taken = await call('POST', `/records/${jan.id}/identities`, { channel: 'phone', address: '+48 600-100-200' });
    expect(taken.statusCode).toBe(422);
    expect(taken.json().errors).toEqual([expect.objectContaining({ code: 'identity_taken', ownerId: anna.id, ownerTitle: 'Anna' })]);

    const view = await call('GET', `/records/${anna.id}`);
    expect(view.json().identities).toEqual([added.json()]);
  });

  test('invalid address and owner → 422; malformed body → 400', async () => {
    const task = await create('Task', ['task']);
    const bad = await call('POST', `/records/${task.id}/identities`, { channel: 'email', address: 'x@y.pl' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].code).toBe('invalid_owner');
    const c = await create('Bad', ['contact']);
    const invalid = await call('POST', `/records/${c.id}/identities`, { channel: 'email', address: 'nope' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().errors[0].code).toBe('invalid_address');
    expect((await call('POST', `/records/${c.id}/identities`, { channel: 'email' })).statusCode).toBe(400);
    expect((await call('POST', `/records/${c.id}/identities`, { channel: 'email', address: 'a@b.pl', extra: 1 })).statusCode).toBe(400);
    expect((await call('POST', '/records/not-a-guid/identities', { channel: 'email', address: 'a@b.pl' })).statusCode).toBe(400);
  });

  test('search, patch, move and archive', async () => {
    const c = await create('Searched', ['contact']);
    const org = await create('Firma S', ['organization']);
    const added = (await call('POST', `/records/${c.id}/identities`, { channel: 'email', address: 'Find.Me@apitest.pl' })).json();

    const found = await call('GET', '/identities?q=apitest');
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ items: [{ ...added, ownerTitle: 'Searched' }] });
    expect((await call('GET', '/identities')).statusCode).toBe(400);

    const patched = await call('PATCH', `/identities/${added.id}`, { label: 'main', verified: true });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ label: 'main', verified: true });
    const unknownKey = await call('PATCH', `/identities/${added.id}`, { address: 'other@x.pl' });
    expect(unknownKey.statusCode).toBe(400);

    const moved = await call('POST', `/identities/${added.id}/move`, { to: org.id });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().ownerId).toBe(org.id);
    expect((await call('POST', `/identities/${added.id}/move`, {})).statusCode).toBe(400);

    const archived = await call('DELETE', `/identities/${added.id}`);
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().archivedAt).toBe('2026-10-31T10:00:00.000Z');
    expect((await call('GET', '/identities?q=apitest')).json()).toEqual({ items: [] });
    const again = await call('DELETE', `/identities/${added.id}`);
    expect(again.statusCode).toBe(422);
    expect(again.json().errors[0].code).toBe('archived');
  });

  test('unknown identity → 404', async () => {
    for (const r of [
      await call('PATCH', `/identities/${MISSING}`, { label: 'x' }),
      await call('POST', `/identities/${MISSING}/move`, { to: MISSING }),
      await call('DELETE', `/identities/${MISSING}`),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().errors[0].code).toBe('not_found');
    }
  });
});

describe('address lookup', () => {
  test('known address → owner and counterparty; unknown email → domain hints; bad input → 422 / 400', async () => {
    const anna = await create('Anna L', ['contact']);
    const org = (await call('POST', '/records', {
      title: 'Firma L', sets: ['organization'], data: { email_domains: ['firma-l.pl'] } })).json();
    await call('POST', '/records', { title: '', sets: ['membership'], links: { contact: [anna.id], organization: [org.id] } });
    await call('POST', `/records/${anna.id}/identities`, { channel: 'email', address: 'anna.l@prywatna-l.pl' });

    const found = await call('GET', '/identities/lookup?channel=email&address=Anna.L%40Prywatna-L.pl');
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json()).toMatchObject({
      identity: { ownerId: anna.id, address: 'anna.l@prywatna-l.pl' }, contact: { id: anna.id, title: 'Anna L' },
      membership: null, organization: { id: org.id, title: 'Firma L' }, membershipEnded: false, hints: [] });
    expect(found.json()).not.toHaveProperty('ok');

    const unknown = await call('GET', '/identities/lookup?channel=email&address=nowy%40firma-l.pl');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({
      identity: null, contact: null, membership: null, organization: null, membershipEnded: false,
      hints: [{ id: org.id, title: 'Firma L' }] });

    const invalid = await call('GET', '/identities/lookup?channel=phone&address=12');
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().errors[0].code).toBe('invalid_address');
    expect((await call('GET', '/identities/lookup?channel=phone')).statusCode).toBe(400);
    expect((await call('GET', '/identities/lookup')).statusCode).toBe(400);
  });
});

describe('organizations and memberships', () => {
  test('a bad NIP → 422 nip_invalid; a taken one names its owner; a good one is normalised', async () => {
    const bad = await call('POST', '/records', { title: 'Firma API', sets: ['organization'], data: { nip: '5260250275' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors).toEqual([expect.objectContaining({ code: 'nip_invalid', field: 'nip' })]);

    const ok = await call('POST', '/records', { title: 'Firma API', sets: ['organization'], data: { nip: 'PL 526-025-02-74' } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().data.nip).toBe('5260250274');
    const taken = await call('POST', '/records', { title: 'Druga', sets: ['organization'], data: { nip: '5260250274' } });
    expect(taken.statusCode).toBe(422);
    expect(taken.json().errors).toEqual([expect.objectContaining({
      code: 'nip_taken', ownerId: ok.json().id, ownerTitle: 'Firma API' })]);
  });

  test('a membership gets a title and shows up in the views of its contact and organization', async () => {
    const anna = await create('Anna API', ['contact']);
    const org = await create('Firma M', ['organization']);
    const m = await call('POST', '/records', { title: '', sets: ['membership'], links: { contact: [anna.id], organization: [org.id] } });
    expect(m.statusCode, m.body).toBe(201);
    expect(m.json().title).toBe('Anna API — Firma M');
    const again = await call('POST', '/records', { title: '', sets: ['membership'], links: { contact: [anna.id], organization: [org.id] } });
    expect(again.statusCode).toBe(422);
    expect(again.json().errors[0].code).toBe('membership_active_exists');
    for (const id of [anna.id, org.id]) {
      const view = (await call('GET', `/records/${id}`)).json();
      expect(view.memberships).toEqual([expect.objectContaining({
        id: m.json().id, contactTitle: 'Anna API', organizationTitle: 'Firma M', active: true })]);
    }
  });
});

describe('handover', () => {
  test('preview, end with a successor (200 / 422), unassigned and take', async () => {
    const olga = await create('Olga', ['contact']);
    const piotr = await create('Piotr', ['contact']);
    const org = await create('Firma H', ['organization']);
    const m = (await call('POST', '/records', {
      title: '', sets: ['membership'], data: { role: ['техник'] }, links: { contact: [olga.id], organization: [org.id] } })).json();
    const phone = (await call('POST', `/records/${m.id}/identities`, { channel: 'phone', address: '600 700 800' })).json();
    const laptop = (await call('POST', '/records', { title: 'Laptop H', sets: ['equipment'], links: { holder: [m.id] } })).json();

    const preview = await call('GET', `/memberships/${m.id}/handover`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({
      identities: [phone],
      links: [{ linkId: expect.any(String), field: 'holder', fromId: laptop.id, fromTitle: 'Laptop H', organizationAllowed: true }],
    });
    expect((await call('GET', `/memberships/${MISSING}/handover`)).statusCode).toBe(404);

    const invalid = await call('POST', `/memberships/${m.id}/end`, {
      version: m.version, date: '2026-11-30', successor: null, identities: { [phone.id]: 'successor' } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().errors[0].code).toBe('handover_target_invalid');
    expect((await call('POST', `/memberships/${m.id}/end`, { version: m.version, date: '2026-11-30' })).statusCode).toBe(400);
    expect((await call('POST', `/memberships/${m.id}/end`, {
      version: m.version, date: '2026-11-30', successor: null, extra: 1 })).statusCode).toBe(400);
    const stale = await call('POST', `/memberships/${m.id}/end`, { version: m.version + 1, date: '2026-11-30', successor: null });
    expect(stale.statusCode).toBe(409);

    const ended = await call('POST', `/memberships/${m.id}/end`, {
      version: m.version, date: '2026-11-30', successor: { contactId: piotr.id }, links: { [preview.json().links[0].linkId]: 'organization' } });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({
      membership: { id: m.id, data: { active_to: '2026-11-30' } },
      successor: { title: 'Piotr — Firma H', data: { role: ['техник'] } } });
    const successorId = ended.json().successor.id;
    expect((await call('GET', `/records/${laptop.id}`)).json().links.holder).toEqual([org.id]);
    expect((await call('GET', `/records/${successorId}`)).json().identities).toEqual([expect.objectContaining({ id: phone.id })]);

    const free = await call('GET', `/organizations/${org.id}/unassigned`);
    expect(free.statusCode, free.body).toBe(200);
    expect(free.json()).toEqual({
      identities: [],
      links: [{ linkId: expect.any(String), field: 'holder', fromId: laptop.id, fromTitle: 'Laptop H', organizationAllowed: true }],
    });
    expect((await call('GET', `/organizations/${MISSING}/unassigned`)).statusCode).toBe(404);

    const taken = await call('POST', `/memberships/${successorId}/take`, { identities: [], links: [free.json().links[0].linkId] });
    expect(taken.statusCode, taken.body).toBe(200);
    expect(taken.json()).toMatchObject({ membership: { id: successorId }, successor: null });
    expect((await call('GET', `/records/${laptop.id}`)).json().links.holder).toEqual([successorId]);
    expect((await call('POST', `/memberships/${successorId}/take`, { identities: [MISSING], links: [] })).statusCode).toBe(422);
    expect((await call('POST', `/memberships/${MISSING}/take`, { identities: [], links: [] })).statusCode).toBe(404);
    expect((await call('POST', `/memberships/${successorId}/take`, { identities: [] })).statusCode).toBe(400);
  });
});

describe('merge', () => {
  test('preview (200 / 422 / 404), merge (200 / 422 / 404 / 400)', async () => {
    const a = (await call('POST', '/records', { title: 'Kasia', sets: ['contact'], data: { notes: 'A' } })).json();
    const b = (await call('POST', '/records', { title: 'Kasia', sets: ['contact'], data: { notes: 'B' } })).json();
    const org = await create('Firma Merge', ['organization']);
    const phone = (await call('POST', `/records/${a.id}/identities`, { channel: 'phone', address: '600 900 100' })).json();

    const preview = await call('GET', `/records/${a.id}/merge-preview?into=${b.id}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({
      kind: 'contact', conflicts: [{ field: 'notes', source: 'A', target: 'B' }], identities: 1, memberships: [], links: 0, rows: 0 });
    const mismatch = await call('GET', `/records/${a.id}/merge-preview?into=${org.id}`);
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().errors[0].code).toBe('merge_kind_mismatch');
    expect((await call('GET', `/records/${a.id}/merge-preview?into=${MISSING}`)).statusCode).toBe(404);
    expect((await call('GET', `/records/${a.id}/merge-preview`)).statusCode).toBe(400);

    expect((await call('POST', `/records/${a.id}/merge`, { into: a.id })).json().errors[0].code).toBe('merge_self');
    expect((await call('POST', `/records/${MISSING}/merge`, { into: b.id })).statusCode).toBe(404);
    expect((await call('POST', `/records/${a.id}/merge`, { into: b.id, values: { notes: 'mine' } })).statusCode).toBe(400);
    expect((await call('POST', `/records/${a.id}/merge`, { into: b.id, extra: 1 })).statusCode).toBe(400);

    const merged = await call('POST', `/records/${a.id}/merge`, { into: b.id, values: { notes: 'source' } });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json()).toMatchObject({ id: b.id, data: { notes: 'A' }, identities: [expect.objectContaining({ id: phone.id })] });
    const source = (await call('GET', `/records/${a.id}`)).json();
    expect(source).toMatchObject({ archivedAt: expect.any(String), links: { merged_into: [b.id] } });
    const again = await call('POST', `/records/${a.id}/merge`, { into: b.id });
    expect(again.statusCode).toBe(422);
    expect(again.json().errors[0].code).toBe('merge_archived');
  });
});

describe('duplicates', () => {
  test('POST /records of a contact returns possibleDuplicates; of a task it does not', async () => {
    const first = await call('POST', '/records', { title: 'Zofia Dubel', sets: ['contact'] });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().possibleDuplicates).toEqual([]);

    const second = await call('POST', '/records', { title: 'Dubel Zofia', sets: ['contact'] });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().possibleDuplicates).toEqual([
      { id: first.json().id, title: 'Zofia Dubel', similarity: 1, reasons: ['same_name'] }]);

    const firm = await call('POST', '/records', { title: 'Firma Dubel', sets: ['organization'] });
    expect(firm.json().possibleDuplicates).toEqual([]);
    const firm2 = await call('POST', '/records', { title: 'FIRMA DUBEL Sp. z o.o.', sets: ['organization'] });
    expect(firm2.json().possibleDuplicates).toEqual([expect.objectContaining({ id: firm.json().id, reasons: ['same_name'] })]);

    const task = await call('POST', '/records', { title: 'Zofia Dubel', sets: ['task'] });
    expect(task.statusCode, task.body).toBe(201);
    expect(task.json()).not.toHaveProperty('possibleDuplicates');

    // a failed save is still the usual error body, and a PATCH carries no hint
    expect((await call('POST', '/records', { title: 'X', sets: ['nope'] })).json()).not.toHaveProperty('possibleDuplicates');
    const patched = await call('PATCH', `/records/${second.json().id}`, { version: second.json().version, title: 'Dubel Zofia 2' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).not.toHaveProperty('possibleDuplicates');
  });

  test('GET /records/:id/duplicates → items, 404 for an unknown record, 400 for a bad id', async () => {
    const a = await create('Ignacy Podobny', ['contact']);
    const b = await create('Podobny Ignacy', ['contact']);
    const res = await call('GET', `/records/${a.id}/duplicates`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: b.id, title: 'Podobny Ignacy', similarity: 1, reasons: ['same_name'] }] });
    expect((await call('GET', `/records/${MISSING}/duplicates`)).statusCode).toBe(404);
    expect((await call('GET', '/records/nope/duplicates')).statusCode).toBe(400);
  });

  test('GET /duplicates lists pairs; validates set and pagination', async () => {
    const a = await create('Walenty Parowy', ['contact']);
    const b = await create('Parowy Walenty', ['contact']);
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    const res = await call('GET', '/duplicates?set=contact&limit=200');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toContainEqual({
      a: { id: lo.id, title: lo.id === a.id ? 'Walenty Parowy' : 'Parowy Walenty' },
      b: { id: hi.id, title: hi.id === a.id ? 'Walenty Parowy' : 'Parowy Walenty' },
      similarity: 1, reasons: ['same_name'] });
    expect((await call('GET', '/duplicates?set=organization&limit=1&offset=0')).json().items.length).toBeLessThanOrEqual(1);

    for (const bad of ['', '?set=task', '?set=contact&limit=500', '?set=contact&limit=0', '?set=contact&offset=-1',
      '?set=contact&limit=x', '?set=contact&extra=1']) {
      expect((await call('GET', `/duplicates${bad}`)).statusCode, bad).toBe(400);
    }
  });

  test('POST /duplicates/dismiss → 204, then the pair is gone; 422 / 404 / 400', async () => {
    const a = await create('Hubert Odrzucany', ['contact']);
    const b = await create('Odrzucany Hubert', ['contact']);
    const org = await create('Firma Odrzucana', ['organization']);
    expect((await call('GET', `/records/${a.id}/duplicates`)).json().items).toHaveLength(1);

    const done = await call('POST', '/duplicates/dismiss', { a: b.id, b: a.id });
    expect(done.statusCode, done.body).toBe(204);
    expect(done.body).toBe('');
    expect((await call('POST', '/duplicates/dismiss', { a: a.id, b: b.id })).statusCode).toBe(204);
    expect((await call('GET', `/records/${a.id}/duplicates`)).json()).toEqual({ items: [] });
    const pairs = (await call('GET', '/duplicates?set=contact&limit=200')).json().items as { a: { id: string } }[];
    expect(pairs.filter((p) => p.a.id === a.id || p.a.id === b.id)).toEqual([]);

    const mismatch = await call('POST', '/duplicates/dismiss', { a: a.id, b: org.id });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().errors[0].code).toBe('merge_kind_mismatch');
    expect((await call('POST', '/duplicates/dismiss', { a: a.id, b: a.id })).json().errors[0].code).toBe('merge_self');
    expect((await call('POST', '/duplicates/dismiss', { a: a.id, b: MISSING })).statusCode).toBe(404);
    expect((await call('POST', '/duplicates/dismiss', { a: a.id })).statusCode).toBe(400);
    expect((await call('POST', '/duplicates/dismiss', { a: a.id, b: b.id, extra: 1 })).statusCode).toBe(400);
    expect((await call('POST', '/duplicates/dismiss', { a: 'x', b: b.id })).statusCode).toBe(400);
  });
});
