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
  const cfg = await loadConfigDir(fixture('ok'));
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
