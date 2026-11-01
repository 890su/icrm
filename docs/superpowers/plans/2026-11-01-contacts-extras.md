# Контакты и организации: добавки (подпроект 2b) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подсказка возможных дублей контактов и организаций, заполнение организации по NIP из «белого списка» VAT и импорт контактов из vCard / CSV / XLSX с пробным прогоном.

**Architecture:** `core` получает чистые функции нормализации имён, названий и адресов и приведения ячеек импорта к типам полей. `db` хранит нормализованные имена в таблице `record_search` (её поддерживает поведение наборов `contact`/`organization`) и ищет по ней кандидатов `pg_trgm`; отдельные сервисы `DuplicateService` и `ImportService`, применение данных реестра — в `ContactService`. `apps/server` разбирает файлы (vCard, CSV, XLSX через `exceljs`), ходит в реестр через интерфейс `NipRegistry` и отдаёт маршруты.

**Tech Stack:** как в 2a: Node 24, pnpm 9.15, TypeScript 7 strict ESM, vitest 5, zod 4, Kysely + pg, Postgres 16 (testcontainers `postgres:16-alpine`), Fastify 5. Новые зависимости `apps/server`: `exceljs@^4`, `@fastify/multipart@^9`. Расширение Postgres `pg_trgm`.

**Spec:** `docs/superpowers/specs/2026-10-31-contacts-organizations-design.md` — §7 (главное), §8 (`004_duplicates`), §9–§11 (части 2b); §2–§4 — на что опирается 2b. Решения 2a: `docs/superpowers/plans/2026-10-31-contacts-core-rulings.md`.

## Global Constraints

- Все таблицы имеют `workspace_id`; сервисы работают в рамках одного workspace.
- Ошибки — `{field?, rule_id?, code, message}`; HTTP-ошибки вне сохранения — `{errors: [{code, message}]}`.
- Кандидаты в дубли — только живые записи, без пар из `duplicate_dismissals`; пара хранится упорядоченной (`a_id < b_id`).
- Пороги сходства: контакты ≥ `0.6`, организации ≥ `0.7`.
- Реестр — `https://wl-api.mf.gov.pl/api/search/nip/{nip}?date=YYYY-MM-DD`, без ключа; тесты в сеть не ходят.
- Импорт: файл до 5 МБ, до 5000 строк (`import_too_large`); файл не сохраняется; каждая строка коммита — своя транзакция.
- Адреса импорта нормализуются по `cfg.phoneRegion`; `whatsapp` = `phone`.
- Postgres ≥ 16, UTF-8. Интеграционные тесты требуют запущенного Docker Desktop.

## Решения плана, которых нет в спецификации

- **Нормализованные имена хранятся в таблице `record_search`**, а не считаются в SQL через `unaccent`: `(record_id, kind)` → `name_norm`, `address_norm`. Нормализация — одна функция `core`, её же использует импорт для поиска организации по названию. Строку пишет `afterWrite` наборов `contact`/`organization`; запросы проверяют, что запись жива и набор всё ещё включён (устаревшие строки безвредны). Записи, сохранённые до `004`, индексирует `DuplicateService.reindex()` при старте сервера. Спецификация §7.1 и §8 правятся первым шагом Task 2.
- **Сходство** — оператор `%` `pg_trgm` с `set_config('pg_trgm.similarity_threshold', <порог>, true)` в той же транзакции (так работает GIN-индекс), в ответе — `similarity()`.
- **Почтовые домены контакта** — домены живых email-адресов самого контакта и его живых участий, кроме `PUBLIC_EMAIL_DOMAINS`. **Общая организация** — по живым участиям, в том числе закрытым.
- **`possibleDuplicates`** добавляет маршрут `POST /records` (после сохранения, вне транзакции) только для записей с набором `contact` или `organization`.
- **Реестр:** неуспешный HTTP-ответ, сетевая ошибка и тайм-аут 10 с — `registry_unavailable` (502); `subject: null` — `nip_not_found` (404). `statusVat` `Czynny`/`Zwolniony`/`Niezarejestrowany` → `czynny`/`zwolniony`/`niezarejestrowany`, иное → `null`. Адрес — `workingAddress ?? residenceAddress`. Запись не организация или не найдена → 404 `not_found`; у организации нет NIP → 422 `nip_invalid` («У организации нет NIP»).
- **Предпросмотр импорта не пишет в БД**: план строится чтением с наложением того, что создали бы предыдущие строки файла (адреса, NIP, названия), — поэтому две строки с одним новым адресом дают `create`, затем `update`. **Коммит** перепланирует каждую строку по текущей БД и выполняет её в одной транзакции `RecordService.transaction` (+ `IdentityService.addIn`).
- **Сопоставление колонок** — `Record<заголовок, цель>`; неуказанные колонки пропускаются; несколько колонок на `contact.title` склеиваются через пробел в порядке колонок («Imię» + «Nazwisko»); несколько колонок на `identity.*` и `membership.role` допустимы; повтор другой цели — ошибка сопоставления; одинаковые заголовки в файле — ошибка; неизвестная или недопустимая цель — ошибка. Ошибки сопоставления — 422 `{errors: [{code: 'invalid_value', field: 'mapping.<заголовок>', message}]}`.
- **Допустимые цели `contact.<поле>` / `organization.<поле>`** — поля этого набора (с `extend`) типов `text`, `number`, `date`, `bool`, `enum`, не `managed`; `organization.nip` — ключ поиска организации и значение.
- **Приведение ячейки** к типу поля (`coerceCell`, core): `text` — как есть (`multiple` — разбивка по `,`/`;`); `number` — с `,` как десятичным разделителем; `bool` — `tak/nie/yes/no/true/false/1/0`; `date` — `YYYY-MM-DD` или `DD.MM.YYYY`; `enum` — как есть (несовпадение с вариантами даст ошибку сохранения строки). Неприводимое значение — предупреждение, поле пропускается. Пустая ячейка — «нет значения».
- **Адрес, принадлежащий организации или участию другого контакта**, при импорте не считается совпадением с человеком: принадлежит организации — предупреждение, адрес пропускается; участию — совпадение с контактом этого участия.
- **Обновление при импорте** дописывает только пустые поля контакта и новые адреса; организация не обновляется, только находится или создаётся (без названия и без найденного NIP — предупреждение, организация пропускается).
- **`import_too_large`** — HTTP 413 и для размера файла, и для числа строк. Неподдерживаемый формат — 400 `bad_request`. Формат определяется по содержимому: `BEGIN:VCARD` → vCard, сигнатура ZIP `PK\x03\x04` → XLSX, иначе CSV.
- **Номер строки** результата: CSV/XLSX — номер строки файла (заголовок — 1); vCard — порядковый номер карточки с 1. Полностью пустые строки пропускаются без записи в отчёт.

## Review Focus

1. **CSV из польского Excel** (Windows-1250, разделитель `;`, «Łódź», поле в кавычках с `;` внутри и `""`) → верные значения, кодировка определена сама. Тест — Task 5.
2. **Повторный импорт того же файла** → все строки `update` без новых записей и адресов; число записей и адресов не изменилось. Тест — Task 6.
3. **Строка, где телефон у одного контакта, а почта у другого** → `skip` с `ambiguous_match`, ничего не изменено. Тест — Task 6.
4. **vCard 3.0 из телефона** со свёрнутыми строками, `TEL;TYPE=CELL`, `item1.EMAIL`, экранированными `\,` и `\n` → разобран верно. Тест — Task 5.
5. **Отклонённая пара после переименования одного из контактов** остаётся отклонённой; архивные записи и записи без набора не попадают в кандидаты. Тест — Task 3.

## Структура файлов

| Файл | Что |
|---|---|
| `packages/core/src/contacts/names.ts` | новый: `normalizeText`, `normalizePersonName`, `normalizeCompanyName`, `normalizeStreetAddress`, `LEGAL_FORMS` |
| `packages/core/src/contacts/cells.ts` | новый: `coerceCell` |
| `packages/core/src/config/system.ts` | поля реестра организации (Task 4) |
| `packages/db/src/migrations/004_duplicates.ts`, `migrate.ts`, `schema.ts` | `pg_trgm`, `record_search`, `duplicate_dismissals` |
| `packages/db/src/repo/search.ts` | новый: SQL `record_search` и кандидатов |
| `packages/db/src/contacts/duplicates.ts` | новый: `DuplicateService` |
| `packages/db/src/contacts/behaviors.ts` | запись `record_search` в `afterWrite` |
| `packages/db/src/contacts/registry.ts` | новый: `RegistryEntry`, применение к организации |
| `packages/db/src/contacts/import.ts` | новый: `ImportService` (сопоставление колонок, план, коммит) |
| `packages/db/src/contacts/identities.ts` | `addIn` |
| `packages/db/src/services.ts`, `index.ts` | `duplicates`, `imports` |
| `apps/server/src/registry/nip-registry.ts` | новый: `NipRegistry`, `MfWhiteList` |
| `apps/server/src/import/parse.ts` | новый: vCard, CSV, XLSX → строки/таблица |
| `apps/server/src/routes/duplicates.ts`, `registry.ts`, `import.ts`, `records.ts`, `server.ts`, `main.ts` | маршруты |
| `README.md` | раздел «Дубли, NIP и импорт» |

---

### Task 1: Нормализация имён и адресов, приведение ячеек

**Files:**
- Create: `packages/core/src/contacts/names.ts`, `packages/core/src/contacts/cells.ts`; Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/contacts/names.test.ts`, `packages/core/test/contacts/cells.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Lower case, diacritics removed (NFD + ł→l, Ł→l), every non-letter/digit → one space, trimmed. */
  export function normalizeText(s: string): string;
  /** normalizeText, words sorted: "Nowak Anna" = "anna nowák" = "anna nowak". */
  export function normalizePersonName(s: string): string;
  /** normalizeText, legal forms removed (LEGAL_FORMS, matched as whole word sequences), words sorted. */
  export function normalizeCompanyName(s: string): string;
  /** normalizeText, leading street prefixes ul|ulica|al|aleja|pl|plac|os|osiedle removed; word order kept. */
  export function normalizeStreetAddress(s: string): string;
  export const LEGAL_FORMS: readonly string[];
  // ['sp z o o', 'spolka z ograniczona odpowiedzialnoscia', 'sp k', 'spolka komandytowa', 'sp j', 'spolka jawna',
  //  's a', 'spolka akcyjna', 's c', 'spolka cywilna', 'jdg', 'p h u', 'phu', 'f h u', 'fhu'] — в нормализованном виде
  export type Coerced = { ok: true; value: Value } | { ok: false; message: string };
  /** Cell text → value of `field` (spec-free rules in the plan); '' → { ok: true, value: null }. */
  export function coerceCell(field: CompiledField, raw: string): Coerced;
  ```

- [ ] **Step 1: Тесты**

```ts
test.each([
  ['Nowak Anna', 'anna nowak'], ['anna Nowák', 'anna nowak'], ['  ŁUKASZ  Żółć ', 'lukasz zolc'], ['Jan-Paweł II', 'ii jan pawel'],
])('person %s → %s', (raw, n) => expect(normalizePersonName(raw)).toBe(n));
test.each([
  ['Firma X Sp. z o.o.', 'firma x'], ['FIRMA X SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', 'firma x'],
  ['P.H.U. Kowalski', 'kowalski'], ['Kowalski s.c.', 'kowalski'], ['Bud-Mar S.A.', 'bud mar'],
])('company %s → %s', (raw, n) => expect(normalizeCompanyName(raw)).toBe(n));
test('a legal form inside a word is kept', () => expect(normalizeCompanyName('Sacom')).toBe('sacom'));
test.each([['ul. Długa 5/2', 'dluga 5 2'], ['Aleja Róż 10', 'roz 10'], ['Długa 5/2', 'dluga 5 2']])('address %s', (raw, n) => expect(normalizeStreetAddress(raw)).toBe(n));
// cells.test.ts — поля строить через compile(...) из test/helpers.ts
test('number with comma, bool words, dates, multiple text, enum as is', () => {
  expect(coerceCell(num, '12,5')).toEqual({ ok: true, value: 12.5 });
  expect(coerceCell(flag, 'Tak')).toEqual({ ok: true, value: true });
  expect(coerceCell(flag, 'nie')).toEqual({ ok: true, value: false });
  expect(coerceCell(day, '31.10.2026')).toEqual({ ok: true, value: '2026-10-31' });
  expect(coerceCell(day, '2026-10-31')).toEqual({ ok: true, value: '2026-10-31' });
  expect(coerceCell(tags, 'a, b;c')).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  expect(coerceCell(kind, 'montage')).toEqual({ ok: true, value: 'montage' });
  expect(coerceCell(num, '')).toEqual({ ok: true, value: null });
});
test.each([['num', 'abc'], ['flag', 'może'], ['day', '31/10/2026'], ['day', '2026-02-30']])('%s %s is not coercible', (f, raw) => {
  expect(coerceCell(fields[f], raw).ok).toBe(false);
});
```

- [ ] **Step 2:** `pnpm vitest run packages/core/test/contacts` — падает.
- [ ] **Step 3:** Реализовать `names.ts`, `cells.ts`, экспорт из `index.ts`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(core): name, company and street normalisation; import cell coercion`

---

### Task 2: Индекс имён и кандидаты в дубли к записи

**Files:**
- Modify first: спецификация §7.1 и §8 (см. Step 1)
- Create: `packages/db/src/migrations/004_duplicates.ts`, `packages/db/src/repo/search.ts`, `packages/db/src/contacts/duplicates.ts`
- Modify: `packages/db/src/migrate.ts`, `schema.ts`, `contacts/behaviors.ts`, `services.ts`, `index.ts`, `apps/server/src/main.ts` (вызов `reindex()` после синхронизации конфига)
- Test: `packages/db/test/duplicates.test.ts`, `migrations.test.ts`

**Interfaces:**
- Consumes: Task 1 (`normalizePersonName`, `normalizeCompanyName`, `normalizeStreetAddress`); 2a `SetBehavior.afterWrite`, `PUBLIC_EMAIL_DOMAINS`, `RecordRef`.
- Produces:
  ```ts
  // 004_duplicates
  //   create extension if not exists pg_trgm;
  //   record_search (record_id uuid references records, workspace_id uuid, kind text check (kind in ('contact','organization')),
  //                  name_norm text not null, address_norm text null, primary key (record_id, kind));
  //   index record_search_name_trgm using gin (name_norm gin_trgm_ops); index (workspace_id, kind);
  //   duplicate_dismissals (workspace_id uuid, a_id uuid references records, b_id uuid references records,
  //                         created_by uuid null, created_at timestamptz default now(), primary key (workspace_id, a_id, b_id),
  //                         check (a_id < b_id))
  export type DuplicateKind = 'contact' | 'organization';
  export type DuplicateReason = 'same_name' | 'similar_name' | 'shared_organization' | 'shared_email_domain' | 'same_address';
  export interface DuplicateCandidate { id: string; title: string; similarity: number; reasons: DuplicateReason[] }
  export class DuplicateService {
    constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string });
    /** Candidates for a live contact/organization, by similarity desc then id; [] for other records. */
    duplicatesOf(recordId: string): Promise<DuplicateCandidate[]>;
    /** Upserts record_search for every live record with contact/organization; returns how many rows were written. */
    reindex(): Promise<number>;
  }
  export async function upsertSearch(tx: Db, workspaceId: string, rec: StoredRecord): Promise<void>; // repo/search.ts
  ```
  - Правила кандидатов — §7.1 спецификации и «Решения плана». Контакт: `same_name` (равные `name_norm`) или `similar_name` (`%` при 0.6) вместе с хотя бы одним из `shared_organization`/`shared_email_domain`; причины перечисляются все, что выполнились, в порядке типа. Организация: `similar_name` (`%` при 0.7; равные имена — `same_name`), или `shared_email_domain` (пересечение `email_domains`), или `same_address` (равные непустые `address_norm`).
  - `afterWrite` наборов `contact` и `organization` вызывает `upsertSearch` (имя — `normalizePersonName(title)` / `normalizeCompanyName(title)`, адрес — `normalizeStreetAddress(address)` у организаций).

- [ ] **Step 1:** Поправить спецификацию: в §7.1 после «Расширения Postgres…» — «Нормализованные имена хранятся в таблице `record_search` (её пишет поведение наборов `contact`/`organization`); нормализацию выполняет одна функция `core`.»; в §8 `004_duplicates` — «`create extension pg_trgm`; `record_search (record_id, workspace_id, kind, name_norm, address_norm)` с триграммным индексом по `name_norm`; `duplicate_dismissals`» вместо `unaccent` и обёртки.
- [ ] **Step 2: Тесты** (`duplicates.test.ts`; `createServices` над `loadConfigDir` фикстуры `packages/db/test/fixtures/contacts/`)

```ts
test('same normalised name is a candidate regardless of order and diacritics', async () => {
  const a = await contact('Nowak Anna'); const b = await contact('Anna Nowák');
  expect(await dup.duplicatesOf(a.id)).toEqual([{ id: b.id, title: 'Anna Nowák', similarity: 1, reasons: ['same_name'] }]);
});
test('a similar name needs a shared organization or email domain', async () => {
  const a = await contact('Katarzyna Wiśniewska'); const b = await contact('Katarzyna Wisniewsk');
  expect(await dup.duplicatesOf(a.id)).toEqual([]);
  await membership(a, firmaX); await membership(b, firmaX, { activeTo: '2026-01-01' }); // закрытое тоже считается
  expect(await dup.duplicatesOf(a.id)).toEqual([expect.objectContaining({ id: b.id, reasons: ['similar_name', 'shared_organization'] })]);
});
test('shared email domain, but not a public one', async () => { /* firma-x.pl → shared_email_domain; gmail.com → [] */ });
test('organizations: similar name without legal form, shared domain, same address', async () => {
  /* 'Firma X Sp. z o.o.' vs 'FIRMA X' → same_name; email_domains пересекаются → shared_email_domain;
     address 'ul. Długa 5' vs 'Długa 5' → same_address */
});
test('archived records and records that lost the set are never candidates', async () => { /* archive b → []; ... */ });
test('reindex indexes records saved before the index existed', async () => { /* delete from record_search; reindex() → кандидаты снова находятся */ });
```

- [ ] **Step 3:** `pnpm vitest run packages/db/test/duplicates.test.ts` — падает.
- [ ] **Step 4:** Реализовать миграцию, `repo/search.ts`, `DuplicateService` (`duplicatesOf`, `reindex`), запись в `afterWrite`, `Services.duplicates`, вызов `reindex()` в `main.ts` после `syncConfig` (с выводом числа строк в лог синхронизации).
- [ ] **Step 5:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 6: Commit** — `feat(db): name index and duplicate candidates of a record`

---

### Task 3: Список пар, «не дубль», маршруты и `possibleDuplicates`

**Files:**
- Modify: `packages/db/src/contacts/duplicates.ts`, `repo/search.ts`
- Create: `apps/server/src/routes/duplicates.ts`; Modify: `apps/server/src/routes/records.ts`, `server.ts`
- Test: `packages/db/test/duplicates.test.ts`, `apps/server/test/contacts-api.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  ```ts
  export interface DuplicatePair { a: RecordRef; b: RecordRef; similarity: number; reasons: DuplicateReason[] } // a.id < b.id
  DuplicateService.pairs(kind: DuplicateKind, page?: { limit?: number; offset?: number }): Promise<DuplicatePair[]>; // limit 50, max 200
  DuplicateService.dismiss(i: { a: string; b: string; userId: string }): Promise<{ ok: true } | { ok: false; errors: RecordError[] }>;
  ```
  - `pairs` — те же правила, что `duplicatesOf`, по всем живым записям вида; порядок — similarity убыв., затем `a.id`, `b.id`.
  - `dismiss`: обе записи живые, одного вида (оба `contact` или оба `organization`), разные — иначе `not_found` / `merge_kind_mismatch` / `merge_self`; повтор — `ok` без изменений.
  - HTTP: `GET /records/:id/duplicates` → `{items}` (404, если записи нет); `GET /duplicates?set=contact|organization&limit=&offset=` → `{items}`; `POST /duplicates/dismiss {a, b}` → 204 / 422 / 404; `POST /records` для записи с набором `contact` или `organization` возвращает вид записи плюс `possibleDuplicates: DuplicateCandidate[]`.

- [ ] **Step 1: Тесты**

```ts
test('pairs list each pair once with a.id < b.id', async () => { /* два дубля → одна пара; порядок по similarity */ });
test('a dismissed pair stays dismissed after a rename', async () => {
  await dup.dismiss({ a: b.id, b: a.id, userId });                    // порядок аргументов не важен
  must(await rec.update({ id: a.id, userId, expectedVersion: a.version, title: 'Anna  Nowak' }));
  expect(await dup.duplicatesOf(a.id)).toEqual([]);
  expect(await dup.pairs('contact')).toEqual([]);
});
test('dismiss checks kind, self and liveness', async () => { /* contact+org → merge_kind_mismatch; a=a → merge_self; archived → not_found */ });
// contacts-api.test.ts
test('POST /records of a contact returns possibleDuplicates; of a task it does not', async () => { /* ... */ });
test('GET /duplicates validates set and pagination', async () => { /* set=task → 400; limit=500 → 400 */ });
```

- [ ] **Step 2:** `pnpm vitest run packages/db/test/duplicates.test.ts apps/server/test/contacts-api.test.ts` — новые падают.
- [ ] **Step 3:** Реализовать `pairs`, `dismiss`, маршруты, `possibleDuplicates`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat: duplicate pairs, dismissals and possibleDuplicates on create`

---

### Task 4: Заполнение организации по NIP

**Files:**
- Modify: `packages/core/src/config/system.ts` (поля организации), core тесты системной части и `/meta`-тест сервера (если они перечисляют поля)
- Create: `packages/db/src/contacts/registry.ts`; Modify: `packages/db/src/contacts/contact-service.ts`, `index.ts`
- Create: `apps/server/src/registry/nip-registry.ts`, `apps/server/src/routes/registry.ts`; Modify: `apps/server/src/server.ts` (`ServerOptions.nipRegistry?: NipRegistry`, по умолчанию `new MfWhiteList()`)
- Test: `packages/db/test/registry.test.ts`, `apps/server/test/nip-registry.test.ts`, `apps/server/test/contacts-api.test.ts`

**Interfaces:**
- Produces:
  ```yaml
  # SYSTEM_CONFIG: поля и набор organization (дописать в конец fields набора)
  regon: {type: text, label: REGON}
  krs: {type: text, label: KRS}
  vat_status: {type: enum, label: Статус VAT, options: [czynny, zwolniony, niezarejestrowany]}
  bank_accounts: {type: text, label: Банковские счета, multiple: true}
  registry_checked_at: {type: datetime, label: Проверено в реестре, managed: true}
  ```
  ```ts
  // db contacts/registry.ts
  export interface RegistryEntry { nip: string; name: string; address: string | null; regon: string | null; krs: string | null;
    vatStatus: 'czynny' | 'zwolniony' | 'niezarejestrowany' | null; bankAccounts: string[] }
  ContactService.applyRegistryEntry(i: { id: string; entry: RegistryEntry; userId: string }): Promise<SaveResult>;
  // server registry/nip-registry.ts
  export class RegistryUnavailable extends Error {}
  export interface NipRegistry { lookup(nip: string, date: string): Promise<RegistryEntry | null> } // null = не найден
  export class MfWhiteList implements NipRegistry {
    constructor(o?: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }); // https://wl-api.mf.gov.pl, 10000
  }
  export function parseWhiteListResponse(body: unknown): RegistryEntry | null;
  ```
  - `applyRegistryEntry` — одна `records.transaction`: живая запись с `organization` (иначе `not_found`), у неё есть `nip` (иначе `nip_invalid` «У организации нет NIP»); `ops.update` с `system: true`, `expectedVersion` — текущая версия: `title` и `address` — только если пусты; `regon`, `krs`, `vat_status`, `bank_accounts`, `registry_checked_at` (= `now`) — всегда.
  - HTTP: `GET /registry/nip/:nip` — `normalizeNip` (неверный → 422 `nip_invalid`), дата — `todayIn(now, cfg.timezone)`; найдено → 200 `RegistryEntry`; `null` → 404 `nip_not_found`; `RegistryUnavailable` → 502 `registry_unavailable`. `POST /records/:id/registry-refresh` — берёт `nip` записи, вызывает реестр, затем `applyRegistryEntry` → 200 вид записи; ошибки — так же.

- [ ] **Step 1: Тесты**

```ts
// nip-registry.test.ts — без сети: fetch подменяется
test('parses a found subject', () => {
  expect(parseWhiteListResponse({ result: { subject: { name: 'FIRMA X SP. Z O.O.', nip: '5260250274', statusVat: 'Czynny',
    regon: '012345678', krs: '0000123456', workingAddress: 'DŁUGA 5, 00-001 WARSZAWA', residenceAddress: null,
    accountNumbers: ['12345678901234567890123456'] } } })).toEqual({ nip: '5260250274', name: 'FIRMA X SP. Z O.O.',
    address: 'DŁUGA 5, 00-001 WARSZAWA', regon: '012345678', krs: '0000123456', vatStatus: 'czynny',
    bankAccounts: ['12345678901234567890123456'] });
});
test('subject null → null; unknown status → null vatStatus', () => { /* ... */ });
test('requests the right URL and maps failures to RegistryUnavailable', async () => {
  /* fetch-заглушка проверяет URL `https://wl-api.mf.gov.pl/api/search/nip/5260250274?date=2026-11-01`;
     ответ 500, 429, отказ fetch, тайм-аут → RegistryUnavailable */
});
// registry.test.ts
test('fills empty title and address only, always overwrites registry fields', async () => { /* ... registry_checked_at = NOW */ });
test('not an organization → not_found; no nip → nip_invalid', async () => { /* ... */ });
// contacts-api.test.ts (buildServer с подделкой NipRegistry)
test('GET /registry/nip: 200, 404 nip_not_found, 422 nip_invalid, 502 registry_unavailable', async () => { /* ... */ });
test('registry down → 502 and the organization is unchanged', async () => { /* version и данные прежние */ });
```

- [ ] **Step 2:** `pnpm vitest run packages/db/test/registry.test.ts apps/server/test` — новые падают.
- [ ] **Step 3:** Реализовать системные поля, `registry.ts`, `applyRegistryEntry`, `MfWhiteList` (глобальный `fetch`, `AbortSignal.timeout`), маршруты.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat: fill an organization from the VAT white list by NIP`

---

### Task 5: Разбор файлов импорта

**Files:**
- Create: `apps/server/src/import/parse.ts`; Modify: `apps/server/package.json` (`exceljs`)
- Create: `packages/db/src/contacts/import.ts` (только типы `ImportTable`, `ImportRow` — остальное в Task 6); Modify: `packages/db/src/index.ts`
- Test: `apps/server/test/import-parse.test.ts` (образцы — строки в тесте; XLSX создаётся в тесте через `exceljs`; CSV в Windows-1250 — байты через `Buffer.from([...])` или кодирование в тесте)

**Interfaces:**
- Produces:
  ```ts
  // db contacts/import.ts
  export interface ImportTable { headers: string[]; rows: { line: number; cells: string[] }[] }
  export interface ImportRow {
    line: number;
    contact: { title: string | null; data: Record<string, string> };      // сырые ячейки по ключу поля
    identities: { channel: string; address: string }[];
    organization: { title: string | null; nip: string | null; data: Record<string, string> } | null;
    membership: { role: string[]; position: string | null } | null;
  }
  // server import/parse.ts
  export type ParsedFile = { kind: 'vcard'; rows: ImportRow[] } | { kind: 'table'; table: ImportTable };
  export class UnsupportedFormat extends Error {}
  export async function parseImportFile(bytes: Uint8Array): Promise<ParsedFile>;
  export function parseVcard(text: string): ImportRow[];
  export function parseCsv(bytes: Uint8Array): ImportTable;
  export async function parseXlsx(bytes: Uint8Array): Promise<ImportTable>;
  ```
  - vCard: развёртка строк (продолжение начинается с пробела или таба); имя свойства без группы (`item1.EMAIL` → `EMAIL`) и без параметров (`TEL;TYPE=CELL`); снятие экранирования `\,` `\;` `\n` `\\`; `FN` → `contact.title`, иначе `N` (`family;given;…` → «given family»); каждый `TEL` → `phone`, `EMAIL` → `email`; `ORG` — первая часть до `;` → `organization.title`; `TITLE` → `membership.position`; `NOTE` → `contact.data.notes`; членство — если есть `ORG`. Без `BEGIN:VCARD` — `UnsupportedFormat`.
  - CSV: снять BOM; `TextDecoder('utf-8', {fatal: true})`, при ошибке — `windows-1250`; разделитель — `;` или `,` по первой строке вне кавычек (больше `;` → `;`); кавычки с `""`, переводы строк внутри кавычек; первая строка — заголовки (обрезанные); полностью пустые строки отбрасываются.
  - XLSX: первый лист, первая строка — заголовки; значение ячейки: дата → `YYYY-MM-DD`, число → `String`, формула → её результат, rich text → текст.
  - Формат — по содержимому (см. «Решения плана»).

- [ ] **Step 1: Тесты**

```ts
test('vCard 3.0 from a phone', () => {
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Nowak;Anna;;;', 'FN:Anna Nowak', 'TEL;TYPE=CELL:+48 600 100 200',
    'item1.EMAIL;TYPE=INTERNET:anna@firma-x.pl', 'ORG:Firma X Sp. z o.o.;Księgowość', 'TITLE:Główna księgowa',
    'NOTE:Dzwonić po 10\\, nie w piątki\\nTel. biuro', '  wewn. 21', 'END:VCARD'].join('\r\n'); // свёрнутая строка: снимается один пробел
  expect(parseVcard(vcf)).toEqual([{ line: 1, contact: { title: 'Anna Nowak', data: { notes: 'Dzwonić po 10, nie w piątki\nTel. biuro wewn. 21' } },
    identities: [{ channel: 'phone', address: '+48 600 100 200' }, { channel: 'email', address: 'anna@firma-x.pl' }],
    organization: { title: 'Firma X Sp. z o.o.', nip: null, data: {} }, membership: { role: [], position: 'Główna księgowa' } }]);
});
test('vCard 4.0 without FN uses N; several cards get lines 1, 2', () => { /* ... */ });
test('CSV from Polish Excel: Windows-1250, semicolons, quotes', () => {
  const text = 'Imię;Nazwisko;Miasto;Uwagi\r\nAnna;Nowak;Łódź;"a; b ""c"""\r\n;;;\r\n';
  const bytes = encodeWindows1250(text);          // помощник теста: таблица для ąćęłńóśźżĄĆĘŁŃÓŚŹŻ
  expect(parseCsv(bytes)).toEqual({ headers: ['Imię', 'Nazwisko', 'Miasto', 'Uwagi'],
    rows: [{ line: 2, cells: ['Anna', 'Nowak', 'Łódź', 'a; b "c"'] }] });
});
test('CSV in UTF-8 with BOM and commas', () => { /* ... */ });
test('XLSX first sheet with a date, a number and a formula', async () => { /* workbook из exceljs → parseXlsx */ });
test('format detection and unsupported input', async () => {
  expect((await parseImportFile(utf8('BEGIN:VCARD\r\nFN:A\r\nEND:VCARD'))).kind).toBe('vcard');
  expect((await parseImportFile(xlsxBytes)).kind).toBe('table');          // начинается с PK\x03\x04
  expect((await parseImportFile(utf8('Imię;Tel\r\nAnna;1'))).kind).toBe('table');
  await expect(parseImportFile(new Uint8Array([0, 0, 0, 0]))).rejects.toBeInstanceOf(UnsupportedFormat); // нет непустых заголовков
});
```
  Файл, у которого после разбора нет ни одного непустого заголовка, — `UnsupportedFormat`; повреждённый XLSX (сигнатура ZIP, но `exceljs` не открыл) — тоже `UnsupportedFormat`.

- [ ] **Step 2:** `pnpm vitest run apps/server/test/import-parse.test.ts` — падает.
- [ ] **Step 3:** `pnpm --filter @icrm/server add exceljs@^4`; реализовать `parse.ts` и типы в `import.ts`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(server): parse vCard, CSV and XLSX contact files`

---

### Task 6: План и коммит импорта

**Files:**
- Modify: `packages/db/src/contacts/import.ts`, `contacts/identities.ts` (`addIn`), `services.ts`, `index.ts`
- Test: `packages/db/test/import.test.ts`

**Interfaces:**
- Consumes: Task 1 (`coerceCell`, `normalizeCompanyName`), Task 2 (`record_search`), Task 5 (`ImportTable`, `ImportRow`); 2a `normalizeAddress`, `identityChannel`, `normalizeNip`, `RecordService.transaction`, `membershipsOf`/`isActiveOn`.
- Produces:
  ```ts
  export type ImportTarget = string; // 'skip' | 'contact.title' | 'contact.<f>' | 'identity.email|phone|telegram'
                                     // | 'organization.title' | 'organization.nip' | 'organization.<f>' | 'membership.role' | 'membership.position'
  export type ImportMapping = Record<string, ImportTarget>;
  export type RowAction = 'create' | 'update' | 'skip' | 'error';
  export interface RowResult { line: number; action: RowAction; reason?: 'ambiguous_match' | 'empty_row';
    contactId?: string; organization?: { action: 'found' | 'create'; id?: string } | null; membership?: 'create' | 'exists' | null;
    warnings: string[]; errors?: RecordError[] }
  export type MappingResult = { ok: true; rows: ImportRow[] } | { ok: false; errors: RecordError[] };
  export class ImportService {
    constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date;
                     records: RecordService; identities: IdentityService });
    rowsFromTable(table: ImportTable, mapping: ImportMapping): MappingResult;
    preview(rows: ImportRow[]): Promise<RowResult[]>;
    commit(rows: ImportRow[], userId: string): Promise<RowResult[]>;
  }
  IdentityService.addIn(tx: Db, i: { ownerId: string; channel: string; address: string; userId: string }): Promise<IdentityView>; // ошибки — SaveFailed
  ```
  - Правила строки — §7.3 спецификации и «Решения плана» (адреса, совпадение, организация, участие, приведение ячеек, предупреждения). Предупреждения — строки на русском, называющие колонку или адрес.
  - `preview` и `commit` используют одну функцию планирования строки; `preview` накладывает результат предыдущих строк файла; `commit` для каждой строки — `records.transaction`: создать/обновить контакт, `addIn` новых адресов, найти/создать организацию, создать участие; `SaveFailed` → `action: 'error'` с ошибками, остальные строки продолжаются.

- [ ] **Step 1: Тесты**

```ts
test('mapping: joins title columns, rejects unknown targets and duplicate headers', () => {
  expect(imp.rowsFromTable(table(['Imię', 'Nazwisko', 'Tel'], [['Anna', 'Nowak', '600100200']]),
    { 'Imię': 'contact.title', 'Nazwisko': 'contact.title', Tel: 'identity.phone' }))
    .toEqual({ ok: true, rows: [expect.objectContaining({ contact: { title: 'Anna Nowak', data: {} },
      identities: [{ channel: 'phone', address: '600100200' }] })] });
  expect(imp.rowsFromTable(table(['A'], []), { A: 'contact.no_such' })).toEqual({ ok: false,
    errors: [expect.objectContaining({ code: 'invalid_value', field: 'mapping.A' })] });
  /* contact.merged_into (managed), organization.title дважды, заголовок «A» дважды в файле → ошибки */
});
test('preview creates then updates within one file and writes nothing', async () => {
  const before = await counts();
  const res = await imp.preview([row({ title: 'Anna', phone: '600100200' }), row({ title: 'Anna N.', phone: '+48600100200', email: 'a@x.pl' })]);
  expect(res.map((r) => r.action)).toEqual(['create', 'update']);
  expect(await counts()).toEqual(before);
});
test('importing the same file twice creates nothing the second time', async () => {
  const rows = [row({ title: 'Jan', email: 'jan@firma-x.pl', org: 'Firma X Sp. z o.o.', nip: '5260250274', role: 'бухгалтер' })];
  expect((await imp.commit(rows, userId)).map((r) => r.action)).toEqual(['create']);
  const after = await counts();
  expect((await imp.commit(rows, userId))).toEqual([expect.objectContaining({ action: 'update', membership: 'exists',
    organization: expect.objectContaining({ action: 'found' }) })]);
  expect(await counts()).toEqual(after);
});
test('phone of one contact and email of another → ambiguous_match, nothing changed', async () => { /* ... */ });
test('empty row and invalid addresses', async () => { /* без имени и адресов → skip empty_row; '12' как телефон → предупреждение */ });
test('update fills only empty fields and adds only new addresses', async () => { /* ... */ });
test('organization found by NIP, else by normalised name, else created; no title and no NIP → warning', async () => { /* ... */ });
test('an address owned by an organization is not a person match', async () => { /* предупреждение, адрес пропущен */ });
test('a failing row does not stop the others', async () => { /* enum вне вариантов в строке 2 → error; строки 1 и 3 — create */ });
```

- [ ] **Step 2:** `pnpm vitest run packages/db/test/import.test.ts` — падает.
- [ ] **Step 3:** Реализовать `addIn`, `ImportService`, `Services.imports`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(db): import preview and per-row commit with matching by address`

---

### Task 7: Маршруты импорта и README

**Files:**
- Create: `apps/server/src/routes/import.ts`; Modify: `apps/server/src/server.ts`, `apps/server/package.json` (`@fastify/multipart`), `README.md`
- Test: `apps/server/test/import-api.test.ts`

**Interfaces:**
- Consumes: Task 5 (`parseImportFile`, `UnsupportedFormat`), Task 6 (`ImportService`).
- Produces:
  - `POST /import/preview` и `POST /import/commit` — `multipart/form-data`: поле-файл `file`, поле `mapping` (JSON-строка `ImportMapping`; обязательно для CSV/XLSX, для vCard игнорируется). Ответ — 200 `{rows: RowResult[]}`.
  - Ошибки: файл > 5 МБ или строк > 5000 → 413 `import_too_large`; нет файла, плохой JSON сопоставления, `UnsupportedFormat` → 400 `bad_request`; ошибки сопоставления → 422 `{errors}`.
  - `@fastify/multipart` регистрируется с `limits: { fileSize: 5 * 1024 * 1024, files: 1 }`.
  - README: раздел «Дубли, NIP и импорт» — по абзацу с примером запроса (`curl -F file=@contacts.csv -F 'mapping={...}'`).

- [ ] **Step 1: Тесты**

```ts
test('preview and commit a CSV over HTTP', async () => { /* multipart с CSV и mapping → preview rows; commit → create; повтор → update */ });
test('vCard needs no mapping', async () => { /* ... */ });
test('too large file and too many rows → 413 import_too_large', async () => { /* 5 МБ + 1 байт; 5001 строка */ });
test('missing file, bad mapping JSON, unsupported format → 400; unknown target → 422', async () => { /* ... */ });
```
  Тело `multipart/form-data` для `app.inject` собрать помощником теста (граница, части `file` и `mapping`).

- [ ] **Step 2:** `pnpm vitest run apps/server/test/import-api.test.ts` — падает.
- [ ] **Step 3:** `pnpm --filter @icrm/server add @fastify/multipart@^9`; реализовать маршруты, README.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(server): import routes for contact files`
