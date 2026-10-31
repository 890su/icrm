import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import { compileConfig, parseConfigFiles, type Value } from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, test } from 'vitest';
import { RecordService, type DB, type RecordView, type SaveResult } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/config/', import.meta.url));
const NOW = new Date('2026-10-30T10:00:00Z');

let db: Kysely<DB>;
let workspaceId: string;
let userId: string;
let svc: RecordService;

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  const cfg = await loadConfigDir(CONFIG_DIR);
  svc = new RecordService({ db, cfg, workspaceId, now: () => NOW });
});

/** Writes `data` keys straight into the stored JSON, bypassing the service (no version bump). */
async function rawSetData(database: Kysely<DB>, id: string, data: Record<string, Value>): Promise<void> {
  await sql`update records set data = data || ${JSON.stringify(data)}::jsonb where id = ${id}`.execute(database);
}

function record(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}

async function created(data: Record<string, Value> = {}): Promise<RecordView> {
  return record(await svc.create({ userId, title: 'Задача', sets: ['task'], data }));
}

async function changeLog(id: string) {
  return db.selectFrom('change_log').selectAll().where('record_id', '=', id).orderBy('id').execute();
}

async function changeLogKinds(r: SaveResult): Promise<string[]> {
  return (await changeLog(record(r).id)).map((e) => e.kind);
}

describe('RecordService.create', () => {
  test('create with sets runs rules and logs', async () => {
    const r = await svc.create({ userId, title: 'Камера склад', sets: ['task'], data: { kind: 'montage' } });
    expect(r.ok && r.record.sets).toEqual(expect.arrayContaining([{ key: 'montage', enabledBy: 'rule:montage_by_kind' }]));
    expect(await changeLogKinds(r)).toEqual(expect.arrayContaining(['value', 'set']));
  });

  test('returns the stored view: uuid v7 id, title, data, sets, version 1, field states, ISO timestamps', async () => {
    const r = record(await svc.create({ userId, title: 'Камера', sets: ['task'], data: { kind: 'montage' } }));
    expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(r).toMatchObject({ title: 'Камера', version: 1, archivedAt: null, links: {} });
    expect(r.data).toMatchObject({ kind: 'montage', warranty_months: 12 });
    expect(r.sets).toEqual([
      { key: 'montage', enabledBy: 'rule:montage_by_kind' },
      { key: 'task', enabledBy: 'manual' },
    ]);
    expect(r.fieldStates.title).toEqual({ visible: true, required: false, readonly: false });
    expect(r.fieldStates.kind).toMatchObject({ options: ['visit', 'montage'] });
    expect(r.fieldStates.act_file).toBeDefined();
    expect(new Date(r.createdAt).toISOString()).toBe(r.createdAt);
    expect(new Date(r.updatedAt).toISOString()).toBe(r.updatedAt);
    expect(await svc.get(r.id)).toEqual(r);

    const row = await db.selectFrom('records').select(['title', 'workspace_id', 'created_by'])
      .where('id', '=', r.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ title: 'Камера', workspace_id: workspaceId, created_by: userId });
  });

  test('change log: user values, rule values and sets with their sources', async () => {
    const r = record(await svc.create({ userId, title: 'Лог', sets: ['task'], data: { kind: 'montage' } }));
    const log = (await changeLog(r.id)).map((e) => ({
      kind: e.kind, field: e.field_key, old: e.old, new: e.new, source: e.source, user: e.user_id,
    }));
    expect(log).toEqual(expect.arrayContaining([
      { kind: 'value', field: 'title', old: null, new: 'Лог', source: 'user', user: userId },
      { kind: 'value', field: 'kind', old: null, new: 'montage', source: 'user', user: userId },
      { kind: 'value', field: 'warranty_months', old: null, new: 12, source: 'rule', user: userId },
      { kind: 'set', field: 'task', old: null, new: 'manual', source: 'user', user: userId },
      { kind: 'set', field: 'montage', old: null, new: 'rule:montage_by_kind', source: 'rule', user: userId },
    ]));
    expect(log).toHaveLength(5);
  });

  test('manual set is enabled as manual and lists its link fields', async () => {
    const r = record(await svc.create({ userId, title: 'x', sets: ['contact'] }));
    expect(r.sets).toEqual([{ key: 'contact', enabledBy: 'manual' }]);
    expect(r.links).toEqual({ related: [] }); // link fields of enabled sets are listed
  });

  test('unknown set and rule-only set are rejected and nothing is stored', async () => {
    const before = await db.selectFrom('records').select('id').execute();
    expect(await svc.create({ userId, title: 'x', sets: ['ghost'] }))
      .toMatchObject({ ok: false, errors: [{ code: 'unknown_set' }] });
    expect(await svc.create({ userId, title: 'x', sets: ['montage'] }))
      .toMatchObject({ ok: false, errors: [{ code: 'set_activation' }] });
    expect(await db.selectFrom('records').select('id').execute()).toHaveLength(before.length);
  });

  test('unknown field key rejected', async () => {
    expect(await svc.create({ userId, title: 'x', sets: ['task'], data: { ghost: 1 } }))
      .toEqual({ ok: false, errors: [expect.objectContaining({ field: 'ghost', code: 'unknown_field' })] });
  });

  test('"" and whitespace become null for non-text fields; text keeps the string', async () => {
    const r = record(await svc.create({ userId, title: 'x', sets: ['task', 'contact'], data: { start: '', notes: '' } }));
    expect(r.data.start ?? null).toBeNull();
    expect(r.data.notes).toBe('');
    const u = record(await svc.update({ id: r.id, userId, expectedVersion: r.version, data: { start: '   ', notes: '  ' } }));
    expect(u.data.start ?? null).toBeNull();
    expect(u.data.notes).toBe('  ');
  });
});

describe('RecordService.update', () => {
  test('applies data and title, bumps version, logs only what changed', async () => {
    const a = await created({ kind: 'visit' });
    const r = record(await svc.update({
      id: a.id, userId, expectedVersion: a.version, title: 'Новое', data: { kind: 'visit', start: '2026-11-01' },
    }));
    expect(r).toMatchObject({ title: 'Новое', version: 2, data: { kind: 'visit', start: '2026-11-01' } });
    const log = (await changeLog(a.id)).slice(-2).map((e) => [e.field_key, e.old, e.new, e.source]);
    expect(log).toEqual(expect.arrayContaining([
      ['title', 'Задача', 'Новое', 'user'],
      ['start', null, '2026-11-01', 'user'],
    ]));
    expect(await changeLog(a.id)).toHaveLength(5); // create: title, kind, task; update: title, start
    const row = await db.selectFrom('records').select('title').where('id', '=', a.id).executeTakeFirstOrThrow();
    expect(row.title).toBe('Новое');
  });

  test('stale version rejected, record unchanged', async () => {
    const a = await created(); await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { notes: 'x' } });
    const r = await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { notes: 'y' } });
    expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'version_conflict' })] });
    expect((await svc.get(a.id))!.data.notes).toBe('x');
  });

  test('concurrent updates with same version: exactly one wins', async () => {
    const a = await created();
    const rs = await Promise.all([1, 2].map(n => svc.update({ id: a.id, userId, expectedVersion: a.version, data: { notes: String(n) } })));
    expect(rs.filter(r => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'version_conflict' })] });
    expect((await svc.get(a.id))!.version).toBe(2);
  });

  test('validation failure rolls back everything', async () => {
    const a = await created({ kind: 'montage' });
    const logBefore = (await changeLog(a.id)).length;
    const r = await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { done: true, notes: 'z' } });
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'required', field: 'act_file', rule_id: 'act_required_on_done' }] });
    const after = (await svc.get(a.id))!;
    expect(after.data.notes).toBeUndefined();
    expect(after.version).toBe(a.version);
    expect(await changeLog(a.id)).toHaveLength(logBefore);
  });

  test('manual enable of rule-only set is rejected', async () => {
    const a = await created();
    expect(await svc.update({ id: a.id, userId, expectedVersion: a.version, enableSets: ['montage'] }))
      .toMatchObject({ ok: false, errors: [{ code: 'set_activation' }] });
  });

  test('enable unknown set rejected', async () => {
    const a = await created();
    expect(await svc.update({ id: a.id, userId, expectedVersion: a.version, enableSets: ['ghost'] }))
      .toMatchObject({ ok: false, errors: [{ code: 'unknown_set', message: expect.any(String) }] });
  });

  test('enable and disable manual sets, logged as user changes', async () => {
    const a = await created();
    const on = record(await svc.update({ id: a.id, userId, expectedVersion: a.version, enableSets: ['contact'] }));
    expect(on.sets).toEqual([{ key: 'contact', enabledBy: 'manual' }, { key: 'task', enabledBy: 'manual' }]);
    const off = record(await svc.update({ id: a.id, userId, expectedVersion: on.version, disableSets: ['contact', 'ghost'] }));
    expect(off.sets).toEqual([{ key: 'task', enabledBy: 'manual' }]);
    const sets = (await changeLog(a.id)).filter((e) => e.kind === 'set' && e.field_key === 'contact')
      .map((e) => [e.old, e.new, e.source]);
    expect(sets).toEqual([[null, 'manual', 'user'], ['manual', null, 'user']]);
  });

  test('disable required set rejected', async () => {
    const a = await created({ kind: 'montage' });
    expect(a.sets).toContainEqual({ key: 'montage', enabledBy: 'rule:montage_by_kind' });
    const r = await svc.update({ id: a.id, userId, expectedVersion: a.version, disableSets: ['task'] });
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'set_required_by' }] });
    expect((await svc.get(a.id))!.sets).toContainEqual({ key: 'task', enabledBy: 'manual' });
  });

  test('rule removes its set when its condition stops holding', async () => {
    const a = await created({ kind: 'montage' });
    const r = record(await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { kind: 'visit' } }));
    expect(r.sets).toEqual([{ key: 'task', enabledBy: 'manual' }]);
    expect(r.data.warranty_months).toBe(12); // data of a disabled set stays
    const montage = (await changeLog(a.id)).filter((e) => e.kind === 'set' && e.field_key === 'montage').at(-1);
    expect(montage).toMatchObject({ old: 'rule:montage_by_kind', new: null, source: 'rule' });
  });

  test('saves record with stale enum value when other field changes', async () => {
    const a = await created(); await rawSetData(db, a.id, { kind: 'removed_option' });
    expect((await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { notes: 'ok' } })).ok).toBe(true);
  });

  test('unknown field key rejected', async () => {
    const a = await created();
    expect(await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { ghost: 1 } }))
      .toEqual({ ok: false, errors: [expect.objectContaining({ field: 'ghost', code: 'unknown_field' })] });
  });

  test('resending an unchanged readonly value succeeds; changing it is rejected', async () => {
    const act = uuidv7();
    const a = await created({ kind: 'montage', done: true, act_file: act, work_cost: 100 });
    const r = await svc.update({
      id: a.id, userId, expectedVersion: a.version, data: { kind: 'montage', work_cost: 100, notes: 'n' },
    });
    expect(record(r).data).toMatchObject({ work_cost: 100, notes: 'n' });
    expect(await svc.update({ id: a.id, userId, expectedVersion: record(r).version, data: { work_cost: 200 } }))
      .toMatchObject({ ok: false, errors: [{ code: 'readonly', field: 'work_cost' }] });
  });

  test('missing record → not_found; archived record → archived', async () => {
    expect(await svc.update({ id: uuidv7(), userId, expectedVersion: 1, data: { notes: 'x' } }))
      .toMatchObject({ ok: false, errors: [{ code: 'not_found' }] });
    const a = await created();
    await db.updateTable('records').set({ archived_at: new Date() }).where('id', '=', a.id).execute();
    expect(await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { notes: 'x' } }))
      .toMatchObject({ ok: false, errors: [{ code: 'archived' }] });
  });

  test('a record of another workspace is not visible', async () => {
    const other = new RecordService({ db, cfg: await loadConfigDir(CONFIG_DIR), workspaceId: uuidv7() });
    const a = await created();
    expect(await other.get(a.id)).toBeNull();
    expect(await other.update({ id: a.id, userId, expectedVersion: a.version, data: { notes: 'x' } }))
      .toMatchObject({ ok: false, errors: [{ code: 'not_found' }] });
  });
});

describe('RecordService.get', () => {
  test('missing id gives null', async () => {
    expect(await svc.get(uuidv7())).toBeNull();
  });
});

describe('link fields in rules', () => {
  const LINK_RULES = `
fields:
  done: {type: bool, label: Готово}
  locked: {type: bool, label: Закрыто}
  conversation: {type: link, label: Разговор, target_sets: [conv]}
  parent: {type: link, label: Родитель, target_sets: [task]}
sets:
  task: {label: Задача, fields: [title, done, locked, conversation, parent]}
  conv: {label: Разговор, fields: [title]}
rules:
  - {id: conv_on_done, when: '{done}', require: [conversation]}
  - {id: frozen, when: '{locked}', readonly: [parent]}
`;
  let ls: RecordService;
  beforeAll(() => {
    ls = new RecordService({
      db, cfg: compileConfig(parseConfigFiles([{ name: 'rules.yaml', content: LINK_RULES }])), workspaceId, now: () => NOW,
    });
  });
  const conv = async (): Promise<RecordView> => record(await ls.create({ userId, title: 'Р', sets: ['conv'] }));

  test('require on a link field: create rejects without the link, accepts with it', async () => {
    const c = await conv();
    expect(await ls.create({ userId, title: 'T', sets: ['task'], data: { done: true } }))
      .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'required', field: 'conversation', rule_id: 'conv_on_done' })] });
    const t = record(await ls.create({ userId, title: 'T', sets: ['task'], data: { done: true }, links: { conversation: [c.id] } }));
    expect(t.links.conversation).toEqual([c.id]);
  });

  test('require on a link field: setLinks satisfies it, removing the link is rejected', async () => {
    const c = await conv();
    const t = record(await ls.create({ userId, title: 'T', sets: ['task'] }));
    expect(await ls.update({ id: t.id, userId, expectedVersion: t.version, data: { done: true } }))
      .toMatchObject({ ok: false, errors: [{ code: 'required', field: 'conversation' }] });
    const linked = record(await ls.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [c.id] }));
    const done = record(await ls.update({ id: t.id, userId, expectedVersion: linked.version, data: { done: true } }));
    expect(done.data.done).toBe(true);
    expect(await ls.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [] }))
      .toMatchObject({ ok: false, errors: [{ code: 'required', field: 'conversation', rule_id: 'conv_on_done' }] });
    expect((await ls.get(t.id))!.links.conversation).toEqual([c.id]);
  });

  test('readonly on a link field: setLinks is rejected while the rule holds (judged by the stored state)', async () => {
    const p = record(await ls.create({ userId, title: 'P', sets: ['task'] }));
    const t = record(await ls.create({ userId, title: 'T', sets: ['task'], data: { locked: true } }));
    expect(await ls.setLinks({ id: t.id, userId, field: 'parent', targetIds: [p.id] })).toEqual({
      ok: false,
      errors: [{ field: 'parent', rule_id: 'frozen', code: 'readonly', message: 'Поле «Родитель» сейчас только для чтения' }],
    });
    const after = (await ls.get(t.id))!;
    expect(after.links.parent).toEqual([]);
    expect(after.version).toBe(t.version);
    // Setting the targets it already has is still a no-op, not an error.
    expect((await ls.setLinks({ id: t.id, userId, field: 'parent', targetIds: [] })).ok).toBe(true);
    const open = record(await ls.update({ id: t.id, userId, expectedVersion: t.version, data: { locked: false } }));
    expect(record(await ls.setLinks({ id: open.id, userId, field: 'parent', targetIds: [p.id] })).links.parent).toEqual([p.id]);
  });
});
