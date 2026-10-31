import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { loadConfigDir } from '../src/node.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'icrm-cfg-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test('loadConfigDir reads *.yaml and *.yml alphabetically and compiles', async () => {
  await writeFile(join(dir, 'b.yml'), 'sets:\n  task: {label: Задача, fields: [hours, cost]}\n');
  await writeFile(join(dir, 'a.yaml'), 'fields:\n  hours: {type: number, label: Часы}\n  cost: {type: formula, label: C, expr: "{hours} * 2"}\n');
  await writeFile(join(dir, 'ignored.txt'), 'not: [yaml');
  const c = await loadConfigDir(dir);
  expect(c.fields.get('cost')!.valueType).toBe('number');
  expect(c.sets.get('task')!.fields).toEqual(['hours', 'cost']);
  expect([...c.fields.keys()]).toEqual([
    'title', 'notes', 'needs_review', 'merged_into', 'org_kind', 'nip', 'address', 'email_domains',
    'contact', 'organization', 'role', 'position', 'active_from', 'active_to', 'is_primary', 'is_active',
    'hours', 'cost',
  ]);
  expect([...c.sets.keys()]).toEqual(['contact', 'organization', 'membership', 'task']);
});
