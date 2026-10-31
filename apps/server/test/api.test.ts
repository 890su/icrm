import { spawnSync } from 'node:child_process';
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
    for (const authorization of [`Bearer ${sameLength}`, 'Bearer short', `Basic ${TOKEN}`, 'Bearer ']) {
      const r = await app.inject({ method: 'GET', url: '/meta', headers: { authorization } });
      expect(r.statusCode, authorization).toBe(401);
      expect(r.json().errors[0].code).toBe('unauthorized');
      expect(r.body).not.toContain(sameLength);
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
    expect(meta.sets.map((s: { key: string }) => s.key)).toEqual(['task', 'montage']);
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
    const r = await post('/records', { title: 'Монтаж', sets: ['montage'], data: { done: true } });
    expect(r.statusCode).toBe(422);
    expect(r.json().errors).toEqual([
      expect.objectContaining({ code: 'required', field: 'act_file', rule_id: 'act_required_on_done' }),
    ]);

    // the failed create left nothing behind
    const q = await post('/query', { filter: 'HAS_SET("montage")' });
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
    expect(linked.json().links).toEqual({ related: [b.id] });
    expect((await get(`/records/${a.id}`)).json().links).toEqual({ related: [b.id] });

    // links given at create time
    const c = await create({ title: 'Третья', sets: ['task'], links: { related: [a.id] } });
    expect((await get(`/records/${c.id}`)).json().links).toEqual({ related: [a.id] });

    const all = await post('/query', { filter: 'HAS_SET("task")' });
    expect(all.statusCode).toBe(200);
    const ids = all.json().items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(all.json().total).toBe(ids.length);

    const byText = await post('/query', { filter: '{notes} = "beta"', sort: [{ field: 'title', dir: 'asc' }] });
    expect(byText.json()).toMatchObject({ total: 1, items: [{ id: b.id, title: 'Вторая', data: { notes: 'beta' } }] });

    const page = await post('/query', { filter: 'HAS_SET("task")', sort: [{ field: 'title', dir: 'asc' }], limit: 1, offset: 1 });
    expect(page.json().items).toHaveLength(1);
    expect(page.json().total).toBe(ids.length);

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
    expect(cleared.json().links).toEqual({ related: [] });
  });

  test('link errors → 422', async () => {
    const a = await create({ title: 'L', sets: ['task'] });
    const missing = await put(`/records/${a.id}/links/related`, { targetIds: ['0198a000-0000-7000-8000-000000000000'] });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors[0].code).toBe('link_target');
    const notLink = await put(`/records/${a.id}/links/notes`, { targetIds: [] });
    expect(notLink.statusCode).toBe(422);
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
  test('unknown route → 404', async () => {
    const r = await get('/nope');
    expect(r.statusCode).toBe(404);
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
  test('main exits 1 on broken config', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
      // The config is loaded before any connection is made, so these never get used.
      env: {
        ...process.env,
        ICRM_CONFIG_DIR: fixture('broken'),
        DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
        ICRM_API_TOKEN: 'dummy',
      },
    });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('b.yaml:');
    expect(r.stderr).toContain('no_such_field');
  }, 90_000);

  test('main exits 1 without ICRM_API_TOKEN', () => {
    const { ICRM_API_TOKEN: _token, ...env } = process.env;
    const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...env, ICRM_CONFIG_DIR: fixture('ok'), DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' },
    });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('ICRM_API_TOKEN');
  }, 90_000);
});
