# Строки записи (подпроект 1b) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Аналитики Планфикса без новой сущности: строка — обычная запись, принадлежащая записи-владельцу через поле-ссылку `owned: true`, с общим жизненным циклом, пакетным сохранением «владелец + строки» в одной транзакции и скрытием строк из общих списков.

**Architecture:** `core` учит конфиг признаку `owned` и новым кодам ошибок. `db` получает колонки `records.owner_id/owner_field`, а `RecordService` — пакет `rows` в `create`/`update`, правила удаления и архивирования строк и строки в `get`. Формулы, правила, итоги и каскад не меняются: строки — записи, итоги владельца — обычные `rollup` по владеемой ссылке. `apps/server` пропускает `rows` и `includeRows`. Перед этим `record-service.ts` разбирается на переиспользуемые шаги сохранения, иначе пакет строк продублировал бы конвейер.

**Tech Stack:** как в подпроекте 1: Node 24, pnpm 9.15, TypeScript 7 strict ESM, vitest 5, zod 4, Kysely + pg, Postgres 16 (testcontainers `postgres:16-alpine`), Fastify 5.

**Spec:** `docs/superpowers/specs/2026-10-30-icrm-architecture-design.md` — §1.12 (главное), §1.5, §1.7, §1.8, §1.9. Решения подпроекта 1: `docs/superpowers/plans/2026-10-30-core-records-rulings.md`.

## Global Constraints

- Все таблицы имеют `workspace_id`; `RecordService` работает в рамках одного workspace.
- Ошибки сохранения — `{field?, rule_id?, code, message}`; ошибка строки пакета дополнительно несёт `row: {field, index}` (§1.12 п. 3).
- id записей — uuid v7.
- `change_log.source` ∈ `user | rule | cascade | system`.
- Каскад — синхронный, в транзакции сохранения, лимит `CASCADE_LIMIT` = 10000; блокировки `FOR UPDATE` в порядке id; 40P01/40001 — повтор транзакции (`withRetry`), после исчерпания — HTTP 409.
- `owned` несовместим с `hierarchical`; целевые наборы владеемого поля не могут быть `system: true` (§1.12).
- Postgres ≥ 16, кодировка UTF-8.
- Интеграционные тесты требуют запущенного Docker Desktop.

## Решения плана, которых нет в спецификации

- **Владеемое поле должно принадлежать набору владельца, включённому до вычисления** (сохранённые наборы плюс `sets`/`enableSets` этого сохранения). Строки для набора, который правило включает в этом же сохранении, добавляются вторым сохранением. Иначе пришлось бы вычислять владельца до строк, а итоги владельца зависят от строк.
- **Порядок в транзакции пакета:** владелец блокируется первым; затем все упомянутые существующие строки — одним `loadRecords(..., {forUpdate: true})` (порядок id); строки вычисляются и пишутся; затем владеемые связи; затем вычисляется и пишется владелец (его итоги видят новые строки); затем один каскад с семенами всех строк и владельца. Обратные итоги строк по владельцу (`agg: first`) обновляет этот каскад.
- **Новая строка** получает наборы из `sets` операции (с замыканием `requires`) и должна в итоговом состоянии иметь один из `target_sets` поля — иначе `link_target` с `row`.
- **Архивирование строки — источник `cascade`** в журнале, когда оно следует из архивирования владельца; `user` — когда это `delete`, прямой `archive` строки или исключение из `PUT …/links`.
- **Прямой `PATCH /records/:id` строки разрешён** (это запись); его каскад обновит итоги владельца. Конкуренция с пакетом владельца разрешается блокировками и `withRetry`.
- **`GET` строк** — один уровень: строки строк не раскрываются (у строки свой `GET`).
- **`RecordView.rows`** есть только у `get` и у результата сохранения владельца; `queryRecords` строки не раскрывает.

## Review Focus

1. **Ошибка в одной строке пакета** (обязательное поле пусто у строки №2 из 3) → откат всего пакета: ни владелец, ни строки №1/№3 не изменились, версии прежние; ошибка несёт `row: {field: 'expenses', index: 1}`. Тест — Task 4.
2. **Устаревший пакет** (повтор `{id, delete: true}` или `{id, version}` по уже удалённой строке) → `archived`/`not_found`/`version_conflict` с `row`, без частичных изменений. Тест — Task 5.
3. **Смена значения владельца, которое строки берут обратным итогом** (`rate` → `task_rate` в строках) → строки пересчитаны в той же транзакции, итог владельца по строкам тоже. Тест — Task 4.
4. **Архивирование владельца** → строки в архиве, `/query` их не показывает даже с `includeRows: true` (без `includeArchived`), прямой `PATCH` строки → `archived`. Тест — Task 5.
5. **Попытка «присвоить» чужую или самостоятельную запись** через `PUT /records/:id/links/expenses` → `link_owned`, запись не стала строкой. Тест — Task 5.

## Структура файлов

| Файл | Что меняется |
|---|---|
| `packages/core/src/config/schema.ts` | `owned` у поля `link` |
| `packages/core/src/config/compile.ts` | проверки `owned`, `ownedFieldsOf` |
| `packages/core/src/engine/evaluate-record.ts` | `ErrorCode` + `link_owned`, `RecordError.row` |
| `packages/db/src/migrations/002_rows.ts`, `migrate.ts`, `schema.ts` | `owner_id`, `owner_field` |
| `packages/db/src/repo/records.ts` | `StoredRecord.ownerId/ownerField`, `insertRecord(owner)` |
| `packages/db/src/service/record-service.ts` | разбор на шаги (Task 1), пакет строк (Task 4), жизненный цикл (Task 5), `rows` в виде (Task 6) |
| `packages/db/src/service/rows.ts` | новый: применение пакета `rows` |
| `packages/db/src/service/fields.ts` | новый: общие `sameValue`, `fieldInEnabledSet` |
| `packages/db/src/query.ts` | `includeRows` |
| `apps/server/src/routes/records.ts`, `routes/query.ts`, `errors.ts` | `rows`, `includeRows`, общий `isRetryable` |
| `config/finance.yaml`, `config/tasks.yaml` | пример: расходы и доходы задачи |

---

### Task 1: Разбор `record-service.ts` на шаги сохранения (без изменения поведения)

**Files:**
- Create: `packages/db/src/service/fields.ts`
- Modify: `packages/db/src/service/record-service.ts`, `packages/db/src/service/cascade.ts`, `packages/db/src/index.ts`, `apps/server/src/errors.ts`
- Test: существующие `packages/db/test/*.test.ts`, `apps/server/test/*.test.ts` — без изменений, все зелёные

**Interfaces:**
- Produces:
  ```ts
  // service/fields.ts
  export function sameValue(a: Value | undefined, b: Value | undefined): boolean;            // из record-service.ts
  export function fieldInEnabledSet(cfg: CompiledConfig, sets: Map<string, string>, key: string): boolean; // заменяет hasField (cascade.ts) и inEnabledSet (linkErrors)
  // record-service.ts, приватные шаги, каждый работает в чужой транзакции и НЕ запускает каскад:
  createIn(tx, i: CreateInput, owner?: { id: string; field: string }): Promise<{ id: string; seed: CascadeSeed }>;
  updateIn(tx, i: UpdateInput, stored: StoredRecord): Promise<{ seed: CascadeSeed }>;   // stored уже заблокирован
  persist(tx, stored: StoredRecord, prev: RecordState | null, res: EvalResult, userId: string,
          userChangedKeys: Set<string>, expectedVersion: number): Promise<void>;          // writeRecord + writeSets + appendChangeLog
  // retry.ts: isRetryable экспортируется из @icrm/db; apps/server/src/errors.ts импортирует его вместо своей копии
  ```
  Публичные `create`/`update`/`setLinks` = `inTransaction(шаг + cascade(seeds) + reload)`. Последовательность «записать, наборы, журнал» встречается в файле ровно один раз (`persist`).

- [ ] **Step 1:** `pnpm test` — зелёный (база отсчёта, записать число тестов).
- [ ] **Step 2:** Вынести `sameValue`, `fieldInEnabledSet` в `fields.ts`; `cascade.ts` и `record-service.ts` используют их.
- [ ] **Step 3:** Выделить `persist`, `createIn`, `updateIn`; `create`/`update`/`setLinks` через них.
- [ ] **Step 4:** `isRetryable` из `@icrm/db` в `apps/server/src/errors.ts`.
- [ ] **Step 5:** `pnpm typecheck && pnpm test` — то же число тестов, всё зелёное; `git diff --stat` не трогает `test/`.
- [ ] **Step 6: Commit** — `refactor(db): reusable save steps in RecordService`

---

### Task 2: Признак `owned` в конфиге

**Files:**
- Modify: `packages/core/src/config/schema.ts`, `compile.ts`, `packages/core/src/engine/evaluate-record.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/config/compile.test.ts`, `packages/core/test/config/parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // schema.ts: FieldDef.owned?: boolean; zod link: owned: z.boolean().optional()
  // compile.ts:
  export function ownedFieldsOf(cfg: CompiledConfig, sets: Iterable<string>): string[]; // owned-поля включённых наборов, по ключу
  // evaluate-record.ts:
  type ErrorCode = … | 'link_owned';
  interface RecordError { field?; rule_id?; code; message; row?: { field: string; index: number } }
  ```
  Ошибки конфига (как прочие, с `file:line path`):
  - `owned: true` + `hierarchical: true` → путь `<field>.owned`, сообщение `владеемая связь не может быть иерархической`;
  - набор из `target_sets` владеемого поля имеет `system: true` → путь `<field>.target_sets`, сообщение `строки не могут иметь системный набор "<set>"`.

- [ ] **Step 1: Тесты**

```ts
test('owned link compiles and is listed per set', () => {
  const cfg = compile(`fields: {expenses: {type: link, label: Расходы, target_sets: [expense], owned: true}, amount: {type: number, label: Сумма}}
sets: {task: {label: Задача, fields: [expenses]}, expense: {label: Расход, fields: [amount]}}`);
  expect(cfg.fields.get('expenses')!.owned).toBe(true);
  expect(ownedFieldsOf(cfg, ['task'])).toEqual(['expenses']);
  expect(ownedFieldsOf(cfg, ['expense'])).toEqual([]);
});
test('owned + hierarchical is a config error', () => {
  expect(issuesOf(`fields: {sub: {type: link, label: S, target_sets: [t], owned: true, hierarchical: true}}
sets: {t: {label: T, fields: [sub]}}`)).toContainEqual(expect.objectContaining({ path: 'fields.sub.owned' }));
});
test('owned rows cannot carry a system set', () => {
  expect(issuesOf(`fields: {rows: {type: link, label: R, target_sets: [conv], owned: true}}
sets: {t: {label: T, fields: [rows]}, conv: {label: C, system: true, fields: []}}`))
    .toContainEqual(expect.objectContaining({ path: 'fields.rows.target_sets' }));
});
test('owned is rejected on non-link fields', () => { /* {type: text, owned: true} → ошибка разбора */ });
```
(`compile`/`issuesOf` — хелперы из существующих тестов `compile.test.ts`; если их нет — завести там же.)
- [ ] **Step 2–4:** падает → реализовать → проходит (`pnpm vitest run packages/core`).
- [ ] **Step 5: Commit** — `feat(core): owned link fields`

---

### Task 3: Колонки владельца в БД

**Files:**
- Create: `packages/db/src/migrations/002_rows.ts`
- Modify: `packages/db/src/migrate.ts`, `schema.ts`, `repo/records.ts`
- Test: `packages/db/test/migrations.test.ts`, `packages/db/test/repo.test.ts`

**Interfaces:**
- Produces:
  ```sql
  alter table records add column owner_id uuid references records(id), add column owner_field text,
    add constraint records_owner_pair check ((owner_id is null) = (owner_field is null));
  create index records_owner on records (owner_id) where owner_id is not null;
  ```
  ```ts
  // schema.ts RecordsTable: owner_id: string | null; owner_field: string | null
  // StoredRecord: ownerId: string | null; ownerField: string | null
  insertRecord(tx, r: { …; owner?: { id: string; field: string } }): Promise<void>;
  ```
  `writeRecord` колонки владельца не меняет (владелец задаётся только при вставке).

- [ ] **Step 1: Тесты**

```ts
test('migration 002 adds owner columns and the pair check', async () => {
  const { db } = await freshDb();
  await expect(sql`insert into records (id, workspace_id, title, owner_field) values (${uuidv7()}, ${ws}, 'x', 'expenses')`.execute(db))
    .rejects.toThrow(/records_owner_pair/);
});
test('insertRecord stores owner, loadRecords returns it', async () => {
  await insertRecord(db, { id: row, workspaceId, title: '', data: {}, sets: new Map(), createdBy: null, owner: { id: owner, field: 'expenses' } });
  expect((await loadRecords(db, [row])).get(row)).toMatchObject({ ownerId: owner, ownerField: 'expenses' });
  expect((await loadRecords(db, [owner])).get(owner)).toMatchObject({ ownerId: null, ownerField: null });
});
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): owner columns for record rows`

---

### Task 4: Пакет `rows` при создании и изменении

**Files:**
- Create: `packages/db/src/service/rows.ts`
- Modify: `packages/db/src/service/record-service.ts`, `packages/db/test/fixtures/config/` (новый файл `rows.yaml`), `packages/db/src/index.ts`
- Test: `packages/db/test/rows.test.ts`

**Interfaces:**
- Consumes: `createIn`, `updateIn`, `persist` (Task 1), `ownedFieldsOf`, `RecordError.row`, `link_owned` (Task 2), `insertRecord(owner)` (Task 3)
- Produces:
  ```ts
  export type RowOp =
    | { title?: string; data?: Record<string, Value>; sets?: string[] }                       // новая строка
    | { id: string; version: number; title?: string; data?: Record<string, Value>;
        enableSets?: string[]; disableSets?: string[] }                                         // изменение
    | { id: string; delete: true };                                                             // удаление (Task 5)
  // CreateInput.rows?: Record<string, RowOp[]>;  UpdateInput.rows?: Record<string, RowOp[]>
  ```
  Проверки (ошибки строки несут `row: {field, index}`; ошибки поля — `field`):
  - поле `rows` — владеемое поле набора владельца, включённого до вычисления, иначе `unknown_field` (`field`);
  - `{id, …}` — строка этого владельца по этому полю (`owner_id`, `owner_field`), иначе `link_owned`; не в архиве (`archived`); версия совпадает (`version_conflict`);
  - новая строка в итоге имеет один из `target_sets` (`link_target`);
  - `cardinality: one` и строк после пакета > 1 → `link_cardinality` (`field`);
  - любая ошибка строки или владельца откатывает всё; `SaveResult.errors` содержит все найденные ошибки строк.
  Новые строки получают `owner_id`/`owner_field` при вставке и добавляются в конец владеемой связи в порядке пакета; изменённые остаются на местах. Связь логируется у владельца (`kind: link`), значения строк — у строк.

В `rows.test.ts` завести хелпер `ownerOf(id)` → `{ownerId, ownerField}` прямо из таблицы `records`.

Фикстура `rows.yaml` (в фикстуре `expense` получает и `note`, нужен в Task 6): набор `task` (`rate`, `expenses` owned many → `expense`, `expenses_total` rollup sum по `amount`, `transport_total` rollup sum с `filter: '{expense_kind} = "транспортные"'`); набор `expense` (`expense_kind` enum, `amount` number, `task_rate` inverse rollup `first` по `expenses` поля `rate`, `cost` formula `{amount} * {task_rate}`); набор `expense_transport` (rule, requires `expense`: `distance_km`) с правилом `{expense_kind} = "транспортные"`; правило `expense_amount_required`: `when: 'HAS_SET("expense")'`, `require: [amount]`.

- [ ] **Step 1: Тесты**

```ts
test('create owner with rows: rows owned, ordered, totals computed', async () => {
  const r = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { rate: 2 }, rows: { expenses: [
    { data: { expense_kind: 'транспортные', amount: 10 }, sets: ['expense'] },
    { data: { expense_kind: 'комплектующие', amount: 5 }, sets: ['expense'] },
  ] } }));
  expect(r.data).toMatchObject({ expenses_total: 15, transport_total: 10 });
  expect(r.links.expenses).toHaveLength(2);
  const [a, b] = await Promise.all(r.links.expenses!.map((id) => svc.get(id)));
  expect(a).toMatchObject({ data: { amount: 10, task_rate: 2, cost: 20 } });
  expect(a!.sets.map((s) => s.key)).toContain('expense_transport');
  expect(b!.sets.map((s) => s.key)).not.toContain('expense_transport');
  expect(await ownerOf(a!.id)).toEqual({ ownerId: r.id, ownerField: 'expenses' });
});
test('update: add, change rows in one save; changed keep place, new go last', async () => { /* v → 2 строки, пакет [{id:b,version,data:{amount:7}}, {data:{amount:1}, sets:['expense']}] → порядок [a,b,c], итог 18 */ });
test('owner value used by rows is propagated in the same save', async () => {
  // update owner data {rate: 3} без rows → у строк task_rate 3, cost пересчитан; один save
});
test('row error rolls back the whole batch and points at the row', async () => {
  const before = await svc.get(owner.id);
  const res = await svc.update({ id: owner.id, userId, expectedVersion: before!.version, data: { rate: 9 }, rows: { expenses: [
    { data: { amount: 1 }, sets: ['expense'] }, { data: { amount: null }, sets: ['expense'] }, { data: { amount: 2 }, sets: ['expense'] } ] } });
  expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'required', field: 'amount', row: { field: 'expenses', index: 1 } })] });
  expect(await svc.get(owner.id)).toEqual(before);
});
test('foreign or standalone record in a row op → link_owned', async () => { /* {id: standalone.id, version} → link_owned с row */ });
test('stale row version → version_conflict with row', async () => {});
test('new row without a target set → link_target with row', async () => {});
test('rows for a field outside the owner\'s enabled sets → unknown_field', async () => {});
test('cardinality one allows one row', async () => {});
```
- [ ] **Step 2–4:** падает → реализовать (`rows.ts`: разбор и применение пакета по «Порядку в транзакции» из «Решений плана»; `record-service.ts` вызывает его из `create`/`update`) → проходит.
- [ ] **Step 5:** `pnpm test` целиком — зелёный.
- [ ] **Step 6: Commit** — `feat(db): save rows together with their owner`

---

### Task 5: Удаление строк и общий жизненный цикл

**Files:**
- Modify: `packages/db/src/service/rows.ts`, `record-service.ts` (`archive`, `setLinks`), `service/cascade.ts` (`archiveSeeds` при необходимости)
- Test: `packages/db/test/rows.test.ts`

**Interfaces:**
- Consumes: Task 4
- Produces (поведение, сигнатуры прежние):
  - `{id, delete: true}` в пакете → строка в архив (журнал `archive`, `source: user`), исключена из владеемой связи, итоги владельца пересчитаны;
  - `archive(row)` напрямую → то же, плюс версия владельца растёт (запись связи у владельца);
  - `archive(owner)` → все неархивные строки его владеемых полей (рекурсивно, строки строк) в архив с `source: cascade`, связи остаются; лимит `CASCADE_LIMIT` распространяется и на них;
  - `setLinks(owner, ownedField, ids)`: `ids` ⊆ текущих неархивных строк поля — перестановка и удаление (удалённые → архив); id вне этого множества → `link_owned` (`field`);
  - `update`/`setLinks`/`archive` строки, у которой владелец в архиве, или самой архивной строки → `archived`.

- [ ] **Step 1: Тесты**

```ts
test('delete op archives the row and drops it from the owner', async () => {
  const res = record(await svc.update({ id: o.id, userId, expectedVersion: o.version, rows: { expenses: [{ id: a, delete: true }] } }));
  expect(res.links.expenses).toEqual([b]);
  expect(res.data.expenses_total).toBe(5);
  expect((await svc.get(a))!.archivedAt).not.toBeNull();
});
test('repeating a stale batch fails without partial changes', async () => {
  // тот же пакет [{id:a, delete:true}, {data:{amount:1}, sets:['expense']}] второй раз → archived с row index 0; новая строка не создана
});
test('archiving the owner archives its rows, recursively', async () => {
  // строка со своим owned-полем и подстрокой; archive(owner) → все три в архиве; change_log строк source 'cascade'
  // queryRecords({includeRows: true}) их не возвращает; update строки → archived
});
test('direct archive of a row updates the owner', async () => { /* версия владельца +1, итог пересчитан, links без строки */ });
test('PUT links on an owned field reorders and deletes, never adopts', async () => {
  expect(record(await svc.setLinks({ id: o.id, userId, field: 'expenses', targetIds: [b, a] })).links.expenses).toEqual([b, a]);
  const adopt = await svc.setLinks({ id: o.id, userId, field: 'expenses', targetIds: [b, a, standalone.id] });
  expect(adopt).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_owned', field: 'expenses' })] });
  expect(await ownerOf(standalone.id)).toEqual({ ownerId: null, ownerField: null });
});
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): row deletion and owner lifecycle`

---

### Task 6: Строки в чтении: `get` и `includeRows`

**Files:**
- Modify: `packages/db/src/service/record-service.ts` (`view`), `packages/db/src/query.ts`
- Test: `packages/db/test/rows.test.ts`, `packages/db/test/query.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // RecordView.rows?: Record<string, RowView[]>;  RowView = Omit<RecordView, 'rows'>
  //   — для каждого owned-поля включённых наборов, в порядке links.position, только неархивные; у get и у результата сохранения
  // QueryInput.includeRows?: boolean   // по умолчанию записи с owner_id is not null исключены
  ```

- [ ] **Step 1: Тесты**

```ts
test('get returns rows of owned fields, one level deep', async () => {
  const v = (await svc.get(o.id))!;
  expect(v.rows!.expenses!.map((r) => r.id)).toEqual(v.links.expenses);
  expect(v.rows!.expenses![0]).not.toHaveProperty('rows');
});
test('query hides rows unless includeRows', async () => {
  // владелец с двумя строками, у строк note = 'q-mark' (уникально в файле)
  const f = { filter: 'HAS_SET("expense") AND {note} = "q-mark"' };
  expect((await queryRecords(db, cfg, workspaceId, f, NOW)).total).toBe(0);
  expect((await queryRecords(db, cfg, workspaceId, { ...f, includeRows: true }, NOW)).total).toBe(2);
});
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): rows in record views and queries`

---

### Task 7: HTTP API для строк

**Files:**
- Modify: `apps/server/src/routes/records.ts`, `routes/query.ts`
- Test: `apps/server/test/api.test.ts`, `apps/server/test/fixtures/ok/` (owned-поле и набор строки)

**Interfaces:**
- Produces: `POST /records` и `PATCH /records/:id` принимают `rows: Record<string, RowOp[]>` (zod: объединение трёх `strictObject`; `delete` — литерал `true`); `POST /query` — `includeRows?: boolean`. Ответы — `RecordView` с `rows`; ошибки строк — 422 `{errors: [{…, row}]}`; `version_conflict` строки → 409 (как у записи). `/meta` показывает `owned` у поля.

- [ ] **Step 1: Тесты**

```ts
test('rows end-to-end: create with rows, patch rows, query', async () => {
  const c = await post('/records', { title: 'T', sets: ['task'], rows: { expenses: [{ data: { amount: 4 }, sets: ['expense'] }] } });
  expect(c.statusCode).toBe(201); expect(c.json().rows.expenses).toHaveLength(1);
  const p = await patch(`/records/${c.json().id}`, { version: c.json().version, rows: { expenses: [{ id: c.json().rows.expenses[0].id, delete: true }] } });
  expect(p.statusCode).toBe(200); expect(p.json().rows.expenses).toEqual([]);
  expect((await post('/query', { filter: 'HAS_SET("expense")', includeRows: true })).json().total).toBeGreaterThan(0);
});
test('row error → 422 with row pointer', async () => {});
test('malformed row op → 400', async () => { /* {id: 'x', delete: false}, лишний ключ, rows не объект */ });
test('meta exposes owned', async () => {});
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(server): rows in records API`

---

### Task 8: Пример в стартовом конфиге и документация

**Files:**
- Create: `config/finance.yaml`
- Modify: `config/tasks.yaml` (поля набора `task`), `README.md`, `PLAN.md`, `CONTEXT.md`
- Test: `packages/core/test/config/starter-config.test.ts`

**Interfaces:**
- Стартовый конфиг: у `task` поля `expenses`, `incomes` (owned many), `expenses_total`, `incomes_total`, `transport_total` (rollup с `filter`), `margin` = `{incomes_total} - {expenses_total}`; наборы `expense` (`expense_kind` enum [транспортные, комплектующие, накладные, агентские, прочие], `amount`, `expense_date`, `note`), `expense_transport` (rule: `route`, `distance_km`), `expense_agent` (rule: `agent`, `agent_percent`), `income` (`amount`, `payer_account`, `received_date`, `note`). Деньги в примере — `number` (политика округления `money` отложена, см. PLAN.md).

- [ ] **Step 1: Тест** — стартовый конфиг компилируется; `ownedFieldsOf(cfg, ['task'])` = `['expenses', 'incomes']`; движок на строке с `expense_kind: 'транспортные'` включает `expense_transport`; итог `margin` типа number.
- [ ] **Step 2–3:** падает → создать конфиг → проходит.
- [ ] **Step 4:** README: раздел «Строки (аналитики)» с примером `PATCH` с `rows` и `curl`. Ручная проверка по README против dev-compose: создать задачу с двумя расходами и доходом, `GET` показывает `rows` и `margin`.
- [ ] **Step 5:** `PLAN.md`: подпроект 1b → Done; рефакторинг record-service → Done. `CONTEXT.md` → Current state. `ROADMAP.md` не трогать.
- [ ] **Step 6:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 7: Commit** — `chore: rows example config and docs`
