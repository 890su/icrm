import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { describe, expect, test } from 'vitest';
import {
  ancestorsVia,
  appendChangeLog,
  insertRecord,
  linksFrom,
  linksTo,
  loadRecords,
  replaceLinks,
  writeRecord,
  writeSets,
} from '../src/index.js';
import { freshDb } from './setup-pg.js';

async function setup() {
  const ctx = await freshDb();
  const mk = async (title = 'rec', data: Record<string, never> = {}, sets: [string, string][] = []) => {
    const id = uuidv7();
    await insertRecord(ctx.db, {
      id,
      workspaceId: ctx.workspaceId,
      title,
      data,
      sets: new Map(sets),
      createdBy: ctx.userId,
    });
    return id;
  };
  return { ...ctx, mk };
}

describe('records repo', () => {
  test('insert + load round-trips title, data, sets and metadata', async () => {
    const { db, workspaceId, mk } = await setup();
    const id = await mk('Hello', { price: { amount: '10.50', currency: 'PLN' }, tags: ['a', 'b'], n: 3 } as never, [
      ['task', 'user'],
      ['project', 'rule:x'],
    ]);
    const got = (await loadRecords(db, [id])).get(id);
    expect(got).toBeDefined();
    expect(got).toMatchObject({
      id,
      workspaceId,
      title: 'Hello',
      data: { price: { amount: '10.50', currency: 'PLN' }, tags: ['a', 'b'], n: 3 },
      version: 1,
      archivedAt: null,
    });
    expect(got!.sets).toEqual(new Map([['task', 'user'], ['project', 'rule:x']]));
    expect(got!.createdAt).toBeInstanceOf(Date);
    expect(got!.updatedAt).toBeInstanceOf(Date);
  });

  test('insertRecord stores owner, loadRecords returns it, writeRecord keeps it', async () => {
    const { db, workspaceId, mk } = await setup();
    const owner = await mk('owner');
    const row = uuidv7();
    await insertRecord(db, {
      id: row, workspaceId, title: '', data: {}, sets: new Map(), createdBy: null,
      owner: { id: owner, field: 'expenses' },
    });
    const loaded = await loadRecords(db, [row, owner]);
    expect(loaded.get(row)).toMatchObject({ ownerId: owner, ownerField: 'expenses' });
    expect(loaded.get(owner)).toMatchObject({ ownerId: null, ownerField: null });

    expect(await writeRecord(db, { ...loaded.get(row)!, title: 'changed' }, 1)).toBe(true);
    expect((await loadRecords(db, [row])).get(row)).toMatchObject({ title: 'changed', ownerId: owner, ownerField: 'expenses' });
  });

  test('record without sets loads with empty sets map', async () => {
    const { db, mk } = await setup();
    const id = await mk();
    expect((await loadRecords(db, [id])).get(id)!.sets.size).toBe(0);
  });

  test('loadRecords: empty ids and missing ids are absent from the map', async () => {
    const { db, mk } = await setup();
    expect((await loadRecords(db, [])).size).toBe(0);
    const id = await mk();
    const missing = uuidv7();
    const m = await loadRecords(db, [id, missing]);
    expect([...m.keys()]).toEqual([id]);
    expect(m.has(missing)).toBe(false);
  });

  test('loadRecords with forUpdate locks rows in id order', async () => {
    const { db, mk } = await setup();
    const ids = [await mk(), await mk(), await mk()];
    const asked = [ids[2]!, ids[0]!, ids[1]!];
    const sorted = [...ids].sort();
    await db.transaction().execute(async (tx) => {
      const m = await loadRecords(tx, asked, { forUpdate: true });
      expect([...m.keys()]).toEqual(sorted);
      // the rows are locked: NOWAIT from another connection fails
      await expect(
        sql`select id from records where id = ${ids[0]!} for update nowait`.execute(db),
      ).rejects.toMatchObject({ code: '55P03' });
    });
    // lock released after commit
    await sql`select id from records where id = ${ids[0]!} for update nowait`.execute(db);
  });

  test('writeRecord with matching version updates fields and bumps version', async () => {
    const { db, mk } = await setup();
    const id = await mk('old', { a: 1 } as never);
    const r = (await loadRecords(db, [id])).get(id)!;
    const archived = new Date('2026-01-02T03:04:05Z');
    const ok = await writeRecord(db, { ...r, title: 'new', data: { a: 2, b: 'x' }, archivedAt: archived }, 1);
    expect(ok).toBe(true);
    const after = (await loadRecords(db, [id])).get(id)!;
    expect(after).toMatchObject({ title: 'new', data: { a: 2, b: 'x' }, version: 2 });
    expect(after.archivedAt?.toISOString()).toBe(archived.toISOString());
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(r.updatedAt.getTime());
    // the input object is not mutated
    expect(r.version).toBe(1);
  });

  test('writeRecord with wrong version returns false and leaves the record untouched', async () => {
    const { db, mk } = await setup();
    const id = await mk('keep', { a: 1 } as never);
    const r = (await loadRecords(db, [id])).get(id)!;
    expect(await writeRecord(db, { ...r, title: 'changed', data: { a: 99 } }, 7)).toBe(false);
    const after = (await loadRecords(db, [id])).get(id)!;
    expect(after).toMatchObject({ title: 'keep', data: { a: 1 }, version: 1 });
    expect(after.updatedAt.getTime()).toBe(r.updatedAt.getTime());
  });

  test('writeRecord: second write with the stale version fails', async () => {
    const { db, mk } = await setup();
    const id = await mk();
    const r = (await loadRecords(db, [id])).get(id)!;
    expect(await writeRecord(db, { ...r, title: 'one' }, 1)).toBe(true);
    expect(await writeRecord(db, { ...r, title: 'two' }, 1)).toBe(false);
    expect((await loadRecords(db, [id])).get(id)!.title).toBe('one');
  });

  test('writeSets inserts added, deletes removed and updates changed enabled_by', async () => {
    const { db, mk } = await setup();
    const id = await mk('r', {}, [['a', 'user'], ['b', 'user'], ['c', 'user']]);
    const before = (await loadRecords(db, [id])).get(id)!.sets;
    const enabledAtBefore = await db.selectFrom('record_sets').select(['set_key', 'enabled_at'])
      .where('record_id', '=', id).execute();

    const after = new Map([['a', 'user'], ['c', 'rule:r1'], ['d', 'user']]);
    await writeSets(db, id, before, after);

    const got = (await loadRecords(db, [id])).get(id)!.sets;
    expect(got).toEqual(after);
    expect(got.has('b')).toBe(false);
    // untouched key keeps its enabled_at
    const a0 = enabledAtBefore.find((r) => r.set_key === 'a')!.enabled_at;
    const a1 = (await db.selectFrom('record_sets').select('enabled_at')
      .where('record_id', '=', id).where('set_key', '=', 'a').executeTakeFirstOrThrow()).enabled_at;
    expect(a1.getTime()).toBe(a0.getTime());
  });

  test('writeSets with identical before/after is a no-op', async () => {
    const { db, mk } = await setup();
    const id = await mk('r', {}, [['a', 'user']]);
    const same = new Map([['a', 'user']]);
    await writeSets(db, id, same, same);
    expect((await loadRecords(db, [id])).get(id)!.sets).toEqual(same);
  });

  test('transactions: functions work inside tx and roll back with it', async () => {
    const { db, workspaceId, userId } = await setup();
    const id = uuidv7();
    await expect(
      db.transaction().execute(async (tx) => {
        await insertRecord(tx, { id, workspaceId, title: 't', data: {}, sets: new Map([['x', 'user']]), createdBy: userId });
        expect((await loadRecords(tx, [id])).has(id)).toBe(true);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await loadRecords(db, [id])).has(id)).toBe(false);
  });
});

describe('links repo', () => {
  test('replaceLinks returns diff and preserves order', async () => {
    const { db, workspaceId, mk } = await setup();
    const from = await mk('from');
    const [a, b, c, d] = [await mk('a'), await mk('b'), await mk('c'), await mk('d')] as [string, string, string, string];

    const r1 = await replaceLinks(db, workspaceId, from, 'rel', [c, a, b]);
    expect(r1).toEqual({ added: [c, a, b], removed: [] });
    expect(await linksFrom(db, from, 'rel')).toEqual([c, a, b]);

    const r2 = await replaceLinks(db, workspaceId, from, 'rel', [b, d, c]);
    expect(r2).toEqual({ added: [d], removed: [a] });
    expect(await linksFrom(db, from, 'rel')).toEqual([b, d, c]);

    const r3 = await replaceLinks(db, workspaceId, from, 'rel', [b, d, c]);
    expect(r3).toEqual({ added: [], removed: [] });

    const r4 = await replaceLinks(db, workspaceId, from, 'rel', []);
    expect(r4.added).toEqual([]);
    expect([...r4.removed].sort()).toEqual([b, c, d].sort());
    expect(await linksFrom(db, from, 'rel')).toEqual([]);
  });

  test('replaceLinks keeps the existing row (id, created_at) for targets that stay', async () => {
    const { db, workspaceId, mk } = await setup();
    const from = await mk();
    const [a, b] = [await mk(), await mk()] as [string, string];
    await replaceLinks(db, workspaceId, from, 'rel', [a, b]);
    const before = await db.selectFrom('links').selectAll().where('from_id', '=', from).where('to_id', '=', a)
      .executeTakeFirstOrThrow();
    await replaceLinks(db, workspaceId, from, 'rel', [b, a]);
    const after = await db.selectFrom('links').selectAll().where('from_id', '=', from).where('to_id', '=', a)
      .executeTakeFirstOrThrow();
    expect(after.id).toBe(before.id);
    expect(after.created_at.getTime()).toBe(before.created_at.getTime());
    expect(after.position).toBe(1);
    expect(before.position).toBe(0);
  });

  test('replaceLinks deduplicates repeated targets (first occurrence wins)', async () => {
    const { db, workspaceId, mk } = await setup();
    const from = await mk();
    const [a, b] = [await mk(), await mk()] as [string, string];
    const r = await replaceLinks(db, workspaceId, from, 'rel', [a, b, a]);
    expect(r.added).toEqual([a, b]);
    expect(await linksFrom(db, from, 'rel')).toEqual([a, b]);
  });

  test('links are scoped by field and by source record', async () => {
    const { db, workspaceId, mk } = await setup();
    const [f1, f2, t] = [await mk(), await mk(), await mk()] as [string, string, string];
    await replaceLinks(db, workspaceId, f1, 'rel', [t]);
    await replaceLinks(db, workspaceId, f1, 'other', [t]);
    await replaceLinks(db, workspaceId, f2, 'rel', [t]);
    // replacing one scope does not touch the others
    await replaceLinks(db, workspaceId, f1, 'rel', []);
    expect(await linksFrom(db, f1, 'rel')).toEqual([]);
    expect(await linksFrom(db, f1, 'other')).toEqual([t]);
    expect(await linksFrom(db, f2, 'rel')).toEqual([t]);
  });

  test('linksTo returns sources ordered by created_at then from_id', async () => {
    const { db, workspaceId, mk } = await setup();
    const target = await mk('target');
    const sources = [await mk(), await mk(), await mk()];
    // insert in reverse id order, in separate statements so created_at differs by statement time
    for (const s of [...sources].reverse()) {
      await replaceLinks(db, workspaceId, s, 'rel', [target]);
    }
    const expected = await db.selectFrom('links').select('from_id')
      .where('to_id', '=', target).where('field_key', '=', 'rel')
      .orderBy('created_at').orderBy('from_id').execute();
    const got = await linksTo(db, target, 'rel');
    expect(got).toEqual(expected.map((r) => r.from_id));
    expect([...got].sort()).toEqual([...sources].sort());
    expect(await linksTo(db, target, 'nothing')).toEqual([]);
  });

  test('linksTo tie-break on equal created_at is from_id', async () => {
    const { db, workspaceId, mk } = await setup();
    const target = await mk();
    const sources = [await mk(), await mk(), await mk()];
    // a single transaction: now() is constant, so created_at ties
    await db.transaction().execute(async (tx) => {
      for (const s of [...sources].reverse()) await replaceLinks(tx, workspaceId, s, 'rel', [target]);
    });
    expect(await linksTo(db, target, 'rel')).toEqual([...sources].sort());
  });

  test('ancestorsVia on chain A<-B<-C gives [B, A] for C', async () => {
    const { db, workspaceId, mk } = await setup();
    const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')] as [string, string, string];
    await replaceLinks(db, workspaceId, b, 'parent', [a]);
    await replaceLinks(db, workspaceId, c, 'parent', [b]);
    expect(await ancestorsVia(db, c, 'parent')).toEqual([b, a]);
    expect(await ancestorsVia(db, b, 'parent')).toEqual([a]);
    expect(await ancestorsVia(db, a, 'parent')).toEqual([]);
  });

  test('ancestorsVia only follows the requested field', async () => {
    const { db, workspaceId, mk } = await setup();
    const [a, b, c] = [await mk(), await mk(), await mk()] as [string, string, string];
    await replaceLinks(db, workspaceId, c, 'parent', [b]);
    await replaceLinks(db, workspaceId, b, 'other', [a]);
    expect(await ancestorsVia(db, c, 'parent')).toEqual([b]);
  });

  test('ancestorsVia terminates on cycles and excludes the start', async () => {
    const { db, workspaceId, mk } = await setup();
    const [a, b, c] = [await mk(), await mk(), await mk()] as [string, string, string];
    await replaceLinks(db, workspaceId, a, 'parent', [b]);
    await replaceLinks(db, workspaceId, b, 'parent', [c]);
    await replaceLinks(db, workspaceId, c, 'parent', [a]);
    expect(await ancestorsVia(db, a, 'parent')).toEqual([b, c]);
  });

  test('ancestorsVia with several parents lists each ancestor once, nearest first', async () => {
    const { db, workspaceId, mk } = await setup();
    const [top, mid, p1, start] = [await mk(), await mk(), await mk(), await mk()] as [string, string, string, string];
    // start -> p1 -> top and start -> mid -> p1 -> top (top reachable at two depths)
    await replaceLinks(db, workspaceId, start, 'parent', [p1, mid]);
    await replaceLinks(db, workspaceId, mid, 'parent', [p1]);
    await replaceLinks(db, workspaceId, p1, 'parent', [top]);
    const got = await ancestorsVia(db, start, 'parent');
    expect(got).toHaveLength(3);
    expect(new Set(got)).toEqual(new Set([p1, mid, top]));
    expect(got[2]).toBe(top);
  });
});

describe('change log repo', () => {
  test('appendChangeLog batch-inserts entries in order with all columns', async () => {
    const { db, workspaceId, userId, mk } = await setup();
    const id = await mk();
    await appendChangeLog(db, [
      { workspaceId, recordId: id, userId, kind: 'value', fieldKey: 'price', old: { amount: '1', currency: 'PLN' }, new: { amount: '2', currency: 'PLN' }, source: 'user' },
      { workspaceId, recordId: id, userId: null, kind: 'set', fieldKey: null, old: ['a'], new: ['a', 'b'], source: 'rule' },
      { workspaceId, recordId: id, userId: null, kind: 'archive', fieldKey: null, old: false, new: true, source: 'cascade' },
    ]);
    const rows = await db.selectFrom('change_log').selectAll().where('record_id', '=', id).orderBy('id').execute();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      workspace_id: workspaceId, user_id: userId, kind: 'value', field_key: 'price', source: 'user',
      old: { amount: '1', currency: 'PLN' }, new: { amount: '2', currency: 'PLN' },
    });
    expect(rows[1]).toMatchObject({ user_id: null, kind: 'set', field_key: null, old: ['a'], new: ['a', 'b'], source: 'rule' });
    expect(rows[2]).toMatchObject({ kind: 'archive', old: false, new: true, source: 'cascade' });
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });

  test('null and undefined old/new are stored as JSON null, never SQL NULL', async () => {
    const { db, workspaceId, mk } = await setup();
    const id = await mk();
    await appendChangeLog(db, [
      { workspaceId, recordId: id, userId: null, kind: 'value', fieldKey: 'f', old: null, new: 'x', source: 'system' },
      { workspaceId, recordId: id, userId: null, kind: 'value', fieldKey: 'f', old: undefined, new: undefined, source: 'system' },
    ]);
    const r = await sql<{ id: string; old_t: string | null; new_t: string | null }>`
      select id, jsonb_typeof(old) as old_t, jsonb_typeof(new) as new_t
      from change_log where record_id = ${id} order by id`.execute(db);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ old_t: 'null', new_t: 'string' });
    expect(r.rows[1]).toMatchObject({ old_t: 'null', new_t: 'null' });
    const raw = await sql<{ c: string }>`
      select count(*)::text as c from change_log where record_id = ${id} and (old is null or new is null)`.execute(db);
    expect(raw.rows[0]!.c).toBe('0');
  });

  test('appendChangeLog with no entries does nothing', async () => {
    const { db } = await setup();
    await expect(appendChangeLog(db, [])).resolves.toBeUndefined();
  });

  test('appendChangeLog participates in the surrounding transaction', async () => {
    const { db, workspaceId, mk } = await setup();
    const id = await mk();
    await expect(
      db.transaction().execute(async (tx) => {
        await appendChangeLog(tx, [
          { workspaceId, recordId: id, userId: null, kind: 'value', fieldKey: 'f', old: 1, new: 2, source: 'user' },
        ]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const n = await db.selectFrom('change_log').select('id').where('record_id', '=', id).execute();
    expect(n).toHaveLength(0);
  });
});
