import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import { RecordService } from '@icrm/db';
import { freshDb } from '@icrm/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { buildServer } from '../src/server.js';

const TOKEN = 'test-token-0123456789';
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const fixture = (...p: string[]): string => fileURLToPath(new URL(['fixtures', ...p].join('/'), import.meta.url));

let app: FastifyInstance;

beforeAll(async () => {
  const fresh = await freshDb();
  const cfg = await loadConfigDir(fixture('ok'));
  app = buildServer({
    db: fresh.db, cfg, workspaceId: fresh.workspaceId, systemUserId: fresh.userId, apiToken: TOKEN,
    now: () => new Date('2026-10-30T10:00:00Z'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Res = LightMyRequestResponse;

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<Res> =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { authorization: `Bearer ${TOKEN}` } });
const get = (url: string): Promise<Res> => call('GET', url);
const post = (url: string, payload?: unknown): Promise<Res> => call('POST', url, payload);
const patch = (url: string, payload: unknown): Promise<Res> => call('PATCH', url, payload);
const put = (url: string, payload: unknown): Promise<Res> => call('PUT', url, payload);

/** Creates a record and returns its view; fails the test if the create did not succeed. */
async function create(body: unknown): Promise<{ id: string; version: number }> {
  const r = await post('/records', body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}

describe('auth', () => {
  test('401 without token', async () => {
    expect((await app.inject({ method: 'GET', url: '/meta' })).statusCode).toBe(401);
  });

  test('401 for a wrong token (same length, other length) and a non-Bearer scheme, without echoing it', async () => {
    const sameLength = 'x'.repeat(TOKEN.length);
    const cases: [string, string | null][] = [
      [`Bearer ${sameLength}`, sameLength], ['Bearer short', 'short'], [`Basic ${TOKEN}`, TOKEN], ['Bearer ', null],
    ];
    for (const [authorization, secret] of cases) {
      const r = await app.inject({ method: 'GET', url: '/meta', headers: { authorization } });
      expect(r.statusCode, authorization).toBe(401);
      expect(r.json().errors[0].code).toBe('unauthorized');
      if (secret !== null) expect(r.body, authorization).not.toContain(secret);
      expect(r.body).not.toContain(TOKEN);
    }
  });

  test('401 also on unknown routes and writes', async () => {
    expect((await app.inject({ method: 'POST', url: '/records', payload: { title: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
  });
});

describe('meta', () => {
  test('meta lists sets and recomputing', async () => {
    const r = await get('/meta');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ timezone: 'Europe/Warsaw', recomputing: [] });
    expect(JSON.stringify(r.json())).not.toContain('"src"');

    const meta = r.json();
    expect(meta.sets.map((s: { key: string }) => s.key)).toEqual(['task', 'expense', 'montage']);
    expect(meta.sets.find((s: { key: string }) => s.key === 'montage')).toMatchObject({
      requires: ['task'], closure: ['montage', 'task'].sort(),
    });
    expect(meta.fields.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['title', 'notes', 'done', 'act_file', 'related']));
    expect(meta.fields.find((f: { key: string }) => f.key === 'related')).toMatchObject({ type: 'link', target_sets: ['task'] });
    expect(meta.rules).toEqual([expect.objectContaining({ id: 'act_required_on_done', require: ['act_file'] })]);
    // compiled internals stay on the server
    expect(JSON.stringify(meta)).not.toMatch(/whenAst|"deps"|"ast"/);
  });
});

describe('records', () => {
  test('create → patch → 409 on stale version', async () => {
    const c = await post('/records', { title: 'T', sets: ['task'] });
    expect(c.statusCode).toBe(201);
    const v = c.json().version;
    expect((await patch(`/records/${c.json().id}`, { version: v, data: { notes: 'a' } })).statusCode).toBe(200);
    const stale = await patch(`/records/${c.json().id}`, { version: v, data: { notes: 'b' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().errors[0].code).toBe('version_conflict');

    const now = await get(`/records/${c.json().id}`);
    expect(now.statusCode).toBe(200);
    expect(now.json()).toMatchObject({ title: 'T', data: { notes: 'a' }, version: v + 1 });
  });

  test('get and patch of an unknown record → 404', async () => {
    const id = '0198a000-0000-7000-8000-000000000000';
    const g = await get(`/records/${id}`);
    expect(g.statusCode).toBe(404);
    expect(g.json().errors[0].code).toBe('not_found');
    expect((await patch(`/records/${id}`, { version: 1, title: 'x' })).statusCode).toBe(404);
    expect((await post(`/records/${id}/archive`)).statusCode).toBe(404);
    expect((await put(`/records/${id}/links/related`, { targetIds: [] })).statusCode).toBe(404);
  });

  test('rule violation → 422 with field errors', async () => {
    const r = await post('/records', { title: 'Монтаж-откат', sets: ['montage'], data: { done: true } });
    expect(r.statusCode).toBe(422);
    expect(r.json().errors).toEqual([
      expect.objectContaining({ code: 'required', field: 'act_file', rule_id: 'act_required_on_done' }),
    ]);

    // the failed create left nothing behind
    const q = await post('/query', { filter: '{title} = "Монтаж-откат"' });
    expect(q.json().total).toBe(0);

    // the same rule on an update, with the value that satisfies it
    const ok = await create({ title: 'Монтаж', sets: ['montage'] });
    const bad = await patch(`/records/${ok.id}`, { version: ok.version, data: { done: true } });
    expect(bad.statusCode).toBe(422);
    const fixed = await patch(`/records/${ok.id}`, { version: ok.version, data: { done: true, act_file: '0198a000-0000-7000-8000-0000000000aa' } });
    expect(fixed.statusCode, fixed.body).toBe(200);
  });

  test('invalid values, unknown fields and sets → 422', async () => {
    const wrongType = await post('/records', { title: 'x', sets: ['task'], data: { done: 'maybe' } });
    expect(wrongType.statusCode).toBe(422);
    expect(wrongType.json().errors[0]).toMatchObject({ code: 'invalid_value', field: 'done' });
    expect((await post('/records', { title: 'x', sets: ['task'], data: { nope: 1 } })).json().errors[0].code).toBe('unknown_field');
    expect((await post('/records', { title: 'x', sets: ['nope'] })).json().errors[0].code).toBe('unknown_set');
  });

  test('enableSets / disableSets on patch', async () => {
    const c = await create({ title: 'S', sets: ['task'] });
    const on = await patch(`/records/${c.id}`, { version: c.version, enableSets: ['montage'] });
    expect(on.statusCode).toBe(200);
    expect(on.json().sets.map((s: { key: string }) => s.key)).toEqual(['montage', 'task']);
    const off = await patch(`/records/${c.id}`, { version: on.json().version, disableSets: ['montage'] });
    expect(off.json().sets.map((s: { key: string }) => s.key)).toEqual(['task']);
  });

  test('archive → 200, then the record is read-only', async () => {
    const c = await create({ title: 'A', sets: ['task'] });
    const a = await post(`/records/${c.id}/archive`);
    expect(a.statusCode).toBe(200);
    expect(a.json().archivedAt).not.toBeNull();
    const after = await patch(`/records/${c.id}`, { version: a.json().version, title: 'B' });
    expect(after.statusCode).toBe(422);
    expect(after.json().errors[0].code).toBe('archived');
  });

  test('links and query end-to-end', async () => {
    const a = await create({ title: 'Первая', sets: ['task'], data: { notes: 'alpha' } });
    const b = await create({ title: 'Вторая', sets: ['task'], data: { notes: 'beta' } });

    const linked = await put(`/records/${a.id}/links/related`, { targetIds: [b.id] });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().links.related).toEqual([b.id]);
    expect((await get(`/records/${a.id}`)).json().links.related).toEqual([b.id]);

    // links given at create time
    const c = await create({ title: 'Третья', sets: ['task'], data: { notes: 'gamma' }, links: { related: [a.id] } });
    expect((await get(`/records/${c.id}`)).json().links.related).toEqual([a.id]);

    // other tests share the database, so the queries are scoped to this test's records
    const mine = 'HAS_SET("task") AND ({notes} = "alpha" OR {notes} = "beta" OR {notes} = "gamma")';
    const all = await post('/query', { filter: mine });
    expect(all.statusCode).toBe(200);
    const ids = all.json().items.map((i: { id: string }) => i.id);
    expect(ids.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(all.json().total).toBe(3);

    const byText = await post('/query', { filter: '{notes} = "beta"', sort: [{ field: 'title', dir: 'asc' }] });
    expect(byText.json()).toMatchObject({ total: 1, items: [{ id: b.id, title: 'Вторая', data: { notes: 'beta' } }] });

    const page = await post('/query', { filter: mine, sort: [{ field: 'title', dir: 'asc' }], limit: 1, offset: 1 });
    expect(page.json().items.map((i: { id: string }) => i.id)).toEqual([a.id]); // Вторая, Первая, Третья
    expect(page.json().total).toBe(3);

    // an empty body is a valid query
    expect((await post('/query')).statusCode).toBe(200);

    // archived records drop out of queries unless asked for
    await post(`/records/${c.id}/archive`);
    const live = await post('/query', { filter: `HAS_SET("task") AND {title} = "Третья"` });
    expect(live.json().total).toBe(0);
    const withArchived = await post('/query', { filter: `{title} = "Третья"`, includeArchived: true });
    expect(withArchived.json().total).toBe(1);

    // clearing links
    const cleared = await put(`/records/${a.id}/links/related`, { targetIds: [] });
    expect(cleared.json().links.related).toEqual([]);
  });

  test('link errors → 422', async () => {
    const a = await create({ title: 'L', sets: ['task'] });
    const missing = await put(`/records/${a.id}/links/related`, { targetIds: ['0198a000-0000-7000-8000-000000000000'] });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors[0].code).toBe('link_target');
    const notLink = await put(`/records/${a.id}/links/notes`, { targetIds: [] });
    expect(notLink.statusCode).toBe(422);
    expect(notLink.json().errors[0].code).toBe('unknown_field');
  });
});

describe('rows', () => {
  const GHOST = '0198a000-0000-7000-8000-000000000000';
  type RowRef = { id: string; version: number };
  const task = async (extra: object = {}): Promise<{ id: string; version: number; rows: { expenses: RowRef[] } }> => {
    const r = await post('/records', { title: 'Задача с расходами', sets: ['task'], ...extra });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };

  test('meta exposes owned on the owned field only', async () => {
    const fields = (await get('/meta')).json().fields as { key: string; owned?: boolean }[];
    expect(fields.find((f) => f.key === 'expenses')).toMatchObject({ type: 'link', owned: true, target_sets: ['expense'] });
    expect(fields.find((f) => f.key === 'related')?.owned).not.toBe(true);
  });

  test('rows end-to-end: create with rows, patch rows, query', async () => {
    const c = await post('/records', {
      title: 'T-rows', sets: ['task'], rows: { expenses: [{ data: { amount: 4 }, sets: ['expense'] }] },
    });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().rows.expenses).toHaveLength(1);
    expect(c.json().rows.expenses[0]).toMatchObject({ data: { amount: 4 }, sets: [{ key: 'expense' }] });
    const rowId = c.json().rows.expenses[0].id;

    // GET shows the same rows
    expect((await get(`/records/${c.json().id}`)).json().rows.expenses.map((r: RowRef) => r.id)).toEqual([rowId]);

    // change one row and add another in one batch
    const ch = await patch(`/records/${c.json().id}`, {
      version: c.json().version,
      rows: { expenses: [
        { id: rowId, version: c.json().rows.expenses[0].version, data: { amount: 5 } },
        { data: { amount: 7 }, sets: ['expense'] },
      ] },
    });
    expect(ch.statusCode, ch.body).toBe(200);
    expect(ch.json().rows.expenses.map((r: { data: { amount: number } }) => r.data.amount)).toEqual([5, 7]);

    // delete the first
    const p = await patch(`/records/${c.json().id}`, {
      version: ch.json().version, rows: { expenses: [{ id: rowId, delete: true }] },
    });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().rows.expenses.map((r: { data: { amount: number } }) => r.data.amount)).toEqual([7]);

    // rows stay out of general queries unless asked for
    const plain = await post('/query', { filter: 'HAS_SET("expense")' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().total).toBe(0);
    const withRows = await post('/query', { filter: 'HAS_SET("expense")', includeRows: true });
    expect(withRows.json().total).toBeGreaterThan(0);

    // an owner patched without rows keeps them
    const keep = await patch(`/records/${c.json().id}`, { version: p.json().version, title: 'T-rows 2' });
    expect(keep.json().rows.expenses).toHaveLength(1);
  });

  test('rows key: present (possibly empty) when an owned field is enabled, omitted otherwise', async () => {
    const bare = await create({ title: 'bare' });
    expect((await get(`/records/${bare.id}`)).json()).not.toHaveProperty('rows');
    const t = await task();
    expect((await get(`/records/${t.id}`)).json().rows).toEqual({ expenses: [] });
  });

  test('row error → 422 with row pointer; the whole batch rolls back', async () => {
    const t = await task();
    const bad = await patch(`/records/${t.id}`, {
      version: t.version,
      title: 'must not stick',
      rows: { expenses: [{ data: { amount: 1 }, sets: ['expense'] }, { data: { amount: 'lots' }, sets: ['expense'] }] },
    });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().errors).toEqual([
      expect.objectContaining({ code: 'invalid_value', field: 'amount', row: { field: 'expenses', index: 1 } }),
    ]);
    const after = (await get(`/records/${t.id}`)).json();
    expect(after).toMatchObject({ title: 'Задача с расходами', version: t.version });
    expect(after.rows.expenses).toEqual([]);

    const create422 = await post('/records', { title: 'x', sets: ['task'], rows: { notes: [{}] } });
    expect(create422.statusCode).toBe(422);
    expect(create422.json().errors[0].code).toBe('unknown_field');
  });

  test('row version_conflict → 409; delete of a foreign or unknown row → 422 link_owned', async () => {
    const t = await task({ rows: { expenses: [{ data: { amount: 1 }, sets: ['expense'] }] } });
    const row = t.rows.expenses[0]!;
    const stale = await patch(`/records/${t.id}`, {
      version: t.version, rows: { expenses: [{ id: row.id, version: row.version + 5, data: { amount: 2 } }] },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().errors).toEqual([
      expect.objectContaining({ code: 'version_conflict', row: { field: 'expenses', index: 0 } }),
    ]);

    const other = await task();
    const foreign = await patch(`/records/${other.id}`, {
      version: other.version, rows: { expenses: [{ id: row.id, delete: true }] },
    });
    expect(foreign.statusCode, foreign.body).toBe(422);
    expect(foreign.json().errors[0]).toMatchObject({ code: 'link_owned', row: { field: 'expenses', index: 0 } });
    const ghost = await patch(`/records/${other.id}`, {
      version: other.version, rows: { expenses: [{ id: GHOST, delete: true }] },
    });
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().errors[0].code).toBe('link_owned');
  });

  test('mixed errors: any version_conflict makes the batch 409, and all errors are listed', async () => {
    const t = await task({ rows: { expenses: [{ data: { amount: 1 }, sets: ['expense'] }] } });
    const row = t.rows.expenses[0]!;
    const r = await patch(`/records/${t.id}`, {
      version: t.version,
      rows: { expenses: [
        { data: { amount: 'lots' }, sets: ['expense'] }, // a validation error
        { id: row.id, version: row.version + 5, data: { amount: 2 } }, // a conflict
      ] },
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().errors.map((e: { code: string; row: { index: number } }) => [e.code, e.row.index]).sort())
      .toEqual([['invalid_value', 0], ['version_conflict', 1]]);
  });

  test('malformed row ops → 400, never reaching the database', async () => {
    const t = await task();
    const rowsBodies: unknown[] = [
      { expenses: [{ id: 'x', delete: true }] }, // id is not a uuid
      { expenses: [{ id: 'x', version: 1 }] },
      { expenses: [{ id: GHOST, delete: false }] },
      { expenses: [{ id: GHOST, delete: 1 }] },
      { expenses: [{ id: GHOST, delete: true, version: 1 }] }, // delete allows only id
      { expenses: [{ id: GHOST, delete: true, data: {} }] },
      { expenses: [{ id: GHOST, data: { amount: 1 } }] }, // change without version
      { expenses: [{ id: GHOST, version: -1 }] },
      { expenses: [{ id: GHOST, version: 1.5 }] },
      { expenses: [{ id: GHOST, version: 'one' }] },
      { expenses: [{ data: { amount: 1 }, bogus: 1 }] }, // unknown key
      { expenses: [{ data: 'x' }] },
      { expenses: [{ sets: 'expense' }] },
      { expenses: [{ version: 1, data: {} }] }, // version without id
      { expenses: [{ enableSets: ['expense'] }] }, // change-only key on a new row
      { expenses: [{ id: GHOST, version: 1, sets: ['expense'] }] }, // new-row-only key on a change
      { expenses: {} }, // op list not an array
      { expenses: 'x' },
      { expenses: [null] },
      { expenses: [[]] },
    ];
    for (const rows of [...rowsBodies, 'x', [], [{ data: {} }], null, 5]) {
      const body = JSON.stringify(rows);
      const c = await post('/records', { title: 'x', sets: ['task'], rows });
      expect(c.statusCode, `create ${body}: ${c.body}`).toBe(400);
      expect(c.json().errors[0].code).toBe('bad_request');
      const p = await patch(`/records/${t.id}`, { version: t.version, rows });
      expect(p.statusCode, `patch ${body}: ${p.body}`).toBe(400);
      expect(p.json().errors[0].code).toBe('bad_request');
    }
    // includeRows must be a boolean
    expect((await post('/query', { includeRows: 'yes' })).statusCode).toBe(400);
    expect((await post('/query', { includeRows: 1 })).statusCode).toBe(400);
    // nothing leaked in
    expect((await get(`/records/${t.id}`)).json().version).toBe(t.version);
  });

  test('valid op shapes are accepted: empty rows, empty row list, a new row with only its set', async () => {
    const t = await task();
    const ok = await patch(`/records/${t.id}`, { version: t.version, rows: { expenses: [] } });
    expect(ok.statusCode, ok.body).toBe(200);
    const empty = await patch(`/records/${t.id}`, { version: ok.json().version, rows: {} });
    expect(empty.statusCode, empty.body).toBe(200);
    const n = await patch(`/records/${t.id}`, { version: empty.json().version, rows: { expenses: [{ sets: ['expense'] }] } });
    expect(n.statusCode, n.body).toBe(200);
    expect(n.json().rows.expenses).toHaveLength(1);
  });
});

describe('query errors', () => {
  test('bad filter → 400 with position', async () => {
    const r = await post('/query', { filter: '{notes} = = 1' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'syntax', pos: { start: expect.any(Number), end: expect.any(Number) } });
    expect(typeof r.json().error.message).toBe('string');
  });

  test('type error and unknown field in a filter → 400', async () => {
    const t = await post('/query', { filter: '{notes} + 1' });
    expect(t.statusCode).toBe(400);
    expect(t.json().error.code).toBe('type');
    expect((await post('/query', { filter: '{nope} = 1' })).statusCode).toBe(400);
  });

  test('negative limit and unknown sort field → 400', async () => {
    expect((await post('/query', { limit: -1 })).statusCode).toBe(400);
    expect((await post('/query', { sort: [{ field: 'nope', dir: 'asc' }] })).statusCode).toBe(400);
  });
});

describe('malformed requests are 400, never 500', () => {
  test('invalid JSON', async () => {
    const r = await app.inject({
      method: 'POST', url: '/records', payload: '{"title": ',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0].code).toBe('bad_request');
  });

  test('wrong body shapes', async () => {
    const bodies: [string, unknown][] = [
      ['/records', {}],
      ['/records', { title: 5 }],
      ['/records', { title: 'x', sets: 'task' }],
      ['/records', { title: 'x', data: { notes: { deep: 1 } } }],
      ['/records', { title: 'x', links: { related: ['not-a-uuid'] } }],
      ['/records', { title: 'x', extra: true }],
      ['/records', [1, 2]],
      ['/query', { filter: 5 }],
      ['/query', { sort: [{ field: 'title', dir: 'sideways' }] }],
      ['/query', { limit: 'ten' }],
      ['/query', { nope: 1 }],
    ];
    for (const [url, body] of bodies) {
      const r = await post(url, body);
      expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(400);
      expect(r.json().errors[0].code).toBe('bad_request');
    }
  });

  test('well-formed JSON the database cannot store → 400', async () => {
    const bodies: [string, unknown][] = [
      ['/records', { title: 'a\u0000b' }],
      ['/records', { title: 'x', sets: ['task'], data: { notes: 'a\u0000b' } }],
      ['/query', { filter: '{notes} = "a\u0000b"' }],
      ['/query', { offset: 1e20 }],
      ['/query', { offset: 1e21 }],
      ['/query', { limit: 1e21 }],
    ];
    for (const [url, body] of bodies) {
      const r = await post(url, body);
      expect(r.statusCode, `${url} ${JSON.stringify(body)}: ${r.body}`).toBe(400);
    }
    // NUL in a patch leaves the record untouched
    const c = await create({ title: 'N', sets: ['task'] });
    const bad = await patch(`/records/${c.id}`, { version: c.version, data: { notes: 'a\u0000b' } });
    expect(bad.statusCode).toBe(400);
    expect((await get(`/records/${c.id}`)).json().version).toBe(c.version);
  });

  test('an empty body with Content-Type: application/json is allowed where no body is needed', async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const c = await create({ title: 'E', sets: ['task'] });
    const archive = await app.inject({ method: 'POST', url: `/records/${c.id}/archive`, headers });
    expect(archive.statusCode, archive.body).toBe(200);
    const query = await app.inject({ method: 'POST', url: '/query', headers });
    expect(query.statusCode, query.body).toBe(200);
    // ...but not where a body is required
    const create400 = await app.inject({ method: 'POST', url: '/records', headers });
    expect(create400.statusCode).toBe(400);
    expect(create400.json().errors[0].code).toBe('bad_request');
  });

  test('patch and links bodies, bad ids', async () => {
    const c = await create({ title: 'P', sets: ['task'] });
    for (const body of [{}, { version: 'one' }, { version: -1 }, { version: 1.5 }, { version: c.version, data: 'x' }]) {
      expect((await patch(`/records/${c.id}`, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await put(`/records/${c.id}/links/related`, {})).statusCode).toBe(400);
    expect((await put(`/records/${c.id}/links/related`, { targetIds: ['x'] })).statusCode).toBe(400);
    expect((await get('/records/not-a-uuid')).statusCode).toBe(400);
    expect((await post('/records/not-a-uuid/archive')).statusCode).toBe(400);
  });
});

describe('error mapping', () => {
  test('a Postgres data exception → 400 with a generic message, logged as a warning', async () => {
    const lines: string[] = [];
    const fresh = await freshDb();
    const logged = buildServer({
      db: fresh.db, cfg: await loadConfigDir(fixture('ok')), workspaceId: fresh.workspaceId, systemUserId: fresh.userId,
      apiToken: TOKEN, logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line); } } },
    });
    try {
      const r = await logged.inject({
        method: 'POST', url: '/records', payload: { title: 'a\u0000b' }, headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().errors).toEqual([{ code: 'bad_request', message: 'Недопустимое значение в запросе или в данных' }]);
      const warnings = lines.map((l) => JSON.parse(l) as { level: number; code?: string; msg?: string })
        .filter((l) => l.level === 40);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.code).toMatch(/^22/);
      expect(warnings[0]!.msg).toContain('data exception');
    } finally {
      await logged.close();
    }
  });

  test('unknown route → 404', async () => {
    const r = await get('/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json().errors[0].code).toBe('not_found');
  });

  test.each(['40P01', '40001'])('postgres %s → 409 version_conflict', async (code) => {
    vi.spyOn(RecordService.prototype, 'create').mockRejectedValue(Object.assign(new Error('boom'), { code }));
    const r = await post('/records', { title: 'x' });
    expect(r.statusCode).toBe(409);
    expect(r.json().errors[0].code).toBe('version_conflict');
  });

  test('unexpected exception → 500 without internals', async () => {
    vi.spyOn(RecordService.prototype, 'create').mockRejectedValue(new Error('secret connection string'));
    const r = await post('/records', { title: 'x' });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('secret');
    expect(r.json().errors[0].code).toBe('internal');
  });
});

describe('main', () => {
  const VALID_TOKEN = 'a-valid-token-0123456789';

  /** Runs main.ts through tsx; every case here must exit before any connection is made. */
  function runMain(env: Record<string, string | undefined>): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ['--import', 'tsx', MAIN], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        ICRM_CONFIG_DIR: fixture('ok'),
        DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
        ICRM_API_TOKEN: VALID_TOKEN,
        PORT: undefined,
        ...env,
      },
    });
  }

  test('main refuses the placeholder token of .env.example', () => {
    const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    const placeholder = /^ICRM_API_TOKEN=(.*)$/m.exec(example)?.[1]?.trim();
    expect(placeholder).toBeTruthy();
    const r = runMain({ ICRM_API_TOKEN: placeholder });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('at least 16');
  }, 90_000);

  test('main exits 1 on broken config', () => {
    // The config is loaded before any connection is made, so the dummy DATABASE_URL never gets used.
    const r = runMain({ ICRM_CONFIG_DIR: fixture('broken') });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('b.yaml:');
    expect(r.stderr).toContain('no_such_field');
  }, 90_000);

  test.each([
    ['ICRM_API_TOKEN unset', { ICRM_API_TOKEN: undefined }, 'ICRM_API_TOKEN is required'],
    ['ICRM_API_TOKEN empty', { ICRM_API_TOKEN: '' }, 'ICRM_API_TOKEN is required'],
    ['ICRM_API_TOKEN too short', { ICRM_API_TOKEN: 'short' }, 'at least 16'],
    ['DATABASE_URL empty', { DATABASE_URL: '' }, 'DATABASE_URL is required'],
    ['PORT 0', { PORT: '0' }, 'Invalid PORT'],
    ['PORT not a number', { PORT: 'abc' }, 'Invalid PORT'],
    ['PORT too big', { PORT: '70000' }, 'Invalid PORT'],
  ])('main exits 1: %s', (_name, env, message) => {
    const r = runMain(env);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.stderr).not.toContain(VALID_TOKEN);
  }, 90_000);
});
