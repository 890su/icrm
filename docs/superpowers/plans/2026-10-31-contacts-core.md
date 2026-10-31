# Контакты и организации: основа (подпроект 2a) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Системные наборы `contact` / `organization` / `membership`, встроенные в код и расширяемые YAML; адреса каналов с владельцем «контакт / участие / организация»; сопоставление адреса с человеком и контрагентом; уход из организации с передачей дел; слияние дублей.

**Architecture:** `core` получает встроенную системную часть конфига (секция `extend`, служебные поля `managed`, `workspace.phone_region`) и чистые функции нормализации адресов и NIP. `db` получает транзакционные операции `RecordService.transaction` (несколько сохранений — один каскад), точки подключения поведения системных наборов (`SetBehavior`), таблицу `identities` и сервисы `IdentityService` и `ContactService` (сопоставление, передача дел, слияние), собираемые фабрикой `createServices`. `apps/server` — тонкие маршруты к ним.

**Tech Stack:** как в подпроектах 1 и 1b: Node 24, pnpm 9.15, TypeScript 7 strict ESM, vitest 5, zod 4, Kysely + pg, Postgres 16 (testcontainers `postgres:16-alpine`), Fastify 5. Новая зависимость `core`: `libphonenumber-js` (работает и в браузере).

**Spec:** `docs/superpowers/specs/2026-10-31-contacts-organizations-design.md` — §1–§6, §8 (только `003_contacts`), §9–§11 (части 2a). Основная спецификация: `docs/superpowers/specs/2026-10-30-icrm-architecture-design.md` §1.5, §1.8, §1.12, §3. Решения прошлых планов: `docs/superpowers/plans/2026-10-30-core-records-rulings.md`, `2026-10-31-record-rows-rulings.md`.

## Global Constraints

- Все таблицы имеют `workspace_id`; сервисы работают в рамках одного workspace.
- Ошибки — `{field?, rule_id?, code, message}` (+ `row` у строк 1b); новые поля ошибки этого плана: `recordId?` (ошибка другой записи внутри передачи дел / слияния), `ownerId?`, `ownerTitle?` (у `identity_taken`).
- id — uuid v7.
- `change_log.source` ∈ `user | rule | cascade | system`; новый `kind` — `identity`, `old`/`new` = `{identityId, channel, address}`.
- Каскад — синхронный, один на транзакцию, лимит `CASCADE_LIMIT`; блокировки `FOR UPDATE` в порядке id; 40P01/40001 — повтор (`withRetry`).
- Каналы адресов: `email | phone | telegram`; `whatsapp` на входе всегда означает `phone`.
- `workspace.phone_region` — двухбуквенный код страны, по умолчанию `PL`.
- Владелец адреса — живая запись с набором `contact`, `membership` или `organization`.
- Postgres ≥ 16, UTF-8. Интеграционные тесты требуют запущенного Docker Desktop.

## Решения плана, которых нет в спецификации

- **Системная часть подмешивается только загрузчиком** (`withSystem(files)`, `loadConfigDir`). `compileConfig(parseConfigFiles(files))` без неё — как раньше (модульные тесты ядра). Системность определяется файлом: определения из файла `SYSTEM_FILE = '<system>'` получают `system: true`; ключ `system:` у набора в пользовательском YAML больше не принимается.
- **`notes` — только у контакта** (как в спецификации); организации добавляют своё поле через `extend`.
- **Поведение системных наборов** — три точки в `RecordService`: `beforeEvaluate` (может поправить ввод, асинхронно, с транзакцией), `afterWrite` (после записи значений, наборов, связей — до каскада) и `archived` (после архивирования). Плюс `extendView` для дополнительных полей вида.
- **Служебные поля** (`managed`) пишет только код: вход `CreateInput`/`UpdateInput`/`SetLinksInput` с `system: true`; HTTP никогда его не ставит.
- **Изменение адреса не меняет `version` владельца**: адреса — не значения записи.
- **Нарушения уникальности** (`23505`) переводятся в ошибки по имени ограничения: `identities_live_address` → `identity_taken`, `records_live_nip` → `nip_taken`.
- **Ограничения участия** (одно активное на пару, один `is_primary`) проверяются в `afterWrite` под транзакционной advisory-блокировкой по контакту: `hashtext(<ws> || ':membership:' || <contactId>)`. «Активно» = `active_to` пусто или `>= todayIn(cfg.timezone, now)`; хранимое `is_active` не используется.
- **`POST /memberships/:id/end` требует `version`** участия (как `PATCH`).
- **Слияние меняет `owner_id` строк** записи `A` на `B`. Это единственное место, где `owner_id` меняется после вставки; `lockWithOwner` после блокировки строки сверяет её `ownerId` с заблокированным владельцем и при расхождении блокирует нового владельца и перечитывает строку. §1.12 основной спецификации дополняется этой оговоркой (Task 9).
- **Слияние не трогает ссылки из архивных записей** на `A`: они остаются историей.
- **Порядок слияния:** адреса → участия → входящие ссылки → строки → собственные ссылки `A` → пользователи → `MergeStep` → `merged_into` и архивирование `A` → значения и наборы `B` (после архивирования `A`, поэтому общий NIP не мешает).

## Review Focus

1. **Один номер в разных записях** («600 100 200», «+48 600-100-200», «0048600100200») → один нормализованный адрес; второе добавление → `identity_taken` с `ownerId`/`ownerTitle`; два одновременных добавления → одно успешно, второе `identity_taken`, а не 500. Тест — Task 5.
2. **Адрес архивного контакта** добавляется новому контакту → успешно (архивирование владельца освободило адрес). Тест — Task 5.
3. **Перевешивание участия через `PUT /records/:id/links/contact`** на контакт, у которого уже есть активное участие в той же организации → `membership_active_exists`, откат: связь осталась прежней. Тест — Task 6.
4. **Уход без преемника, ссылка из поля, которое не допускает организацию** → по умолчанию `keep`, без ошибки; явное `organization` для неё → `handover_target_invalid`, ничего не изменено. Тест — Task 8.
5. **Слияние контактов, у обоих активное участие в одной организации** → одно участие (то, что было у `B`), роли объединены, адреса участия `A` на нём; ошибки `membership_active_exists` нет. Тест — Task 9.

## Структура файлов

| Файл | Что |
|---|---|
| `packages/core/src/config/schema.ts`, `parse.ts`, `compile.ts` | `extend`, `managed`, `system` по файлу, `phone_region` |
| `packages/core/src/config/system.ts` | новый: `SYSTEM_FILE`, `SYSTEM_CONFIG` (YAML), `withSystem` |
| `packages/core/src/node.ts` | `loadConfigDir` через `withSystem` |
| `packages/core/src/contacts/normalize.ts` | новый: адреса, NIP, домены |
| `packages/core/src/engine/evaluate-record.ts` | новые `ErrorCode`, поля `RecordError` |
| `packages/db/src/service/record-service.ts` | `transaction`, `SetBehavior`-точки, `managed`, проверка владельца строки |
| `packages/db/src/service/behaviors.ts` | новый: `SetBehavior`, `BehaviorContext` |
| `packages/db/src/service/errors.ts` | `uniqueViolation` → ошибка по имени ограничения |
| `packages/db/src/migrations/003_contacts.ts`, `migrate.ts`, `schema.ts` | `identities`, индекс NIP, `ChangeKind` |
| `packages/db/src/repo/identities.ts` | новый: SQL адресов |
| `packages/db/src/contacts/identities.ts` | новый: `IdentityService` |
| `packages/db/src/contacts/behaviors.ts` | новый: поведение `contact`/`organization`/`membership` |
| `packages/db/src/contacts/memberships.ts` | новый: запросы участий |
| `packages/db/src/contacts/contact-service.ts` | новый: сопоставление, передача дел, слияние |
| `packages/db/src/services.ts` | новый: `createServices` |
| `apps/server/src/routes/identities.ts`, `memberships.ts`, `merge.ts`, `server.ts` | маршруты |
| `config/tasks.yaml`, `config/contacts.yaml`, `README.md` | `site_address`, пример `extend`, раздел README |

---

### Task 1: Системная часть конфига: `extend`, `managed`, `phone_region`

**Files:**
- Modify: `packages/core/src/config/schema.ts`, `parse.ts`, `compile.ts`, `packages/core/src/index.ts`
- Create: `packages/core/src/config/system.ts` (пока только `SYSTEM_FILE` и `withSystem` с пустой системной частью; содержимое — Task 2)
- Test: `packages/core/test/config/parse.test.ts`, `compile.test.ts`, новый `packages/core/test/config/extend.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // schema.ts
  FieldDef.system?: boolean;   // из SYSTEM_FILE
  FieldDef.managed?: boolean;  // пишет только код; допустим только в SYSTEM_FILE
  SetDef.system: boolean;      // по файлу, не по YAML
  RawConfig.phoneRegion: string;                     // 'PL' по умолчанию
  RawConfig.extendSets: { set: string; fields: string[]; src: SourceRef }[];
  RawConfig.extendFields: { field: string; label?: string; options?: string[]; src: SourceRef }[];
  // zod: fields.* += managed?: boolean; workspace += phone_region: /^[A-Z]{2}$/;
  //      extend?: { sets?: Record<string, {fields: string[]}>, fields?: Record<string, {label?: string, options?: string[] (min 1)}> }
  //      sets.*.system — удалён (Unrecognized key)
  // compile.ts
  CompiledConfig.phoneRegion: string;
  // system.ts
  export const SYSTEM_FILE = '<system>';
  export function withSystem(files: { name: string; content: string }[], system?: string): { name: string; content: string }[];
  // ставит { name: SYSTEM_FILE, content: system ?? SYSTEM_CONFIG } первым; файл с именем SYSTEM_FILE среди files — ошибка (throw Error)
  ```
  Ошибки конфига (`ConfigIssue`, путь и строка как у прочих):
  - поле/набор пользовательского файла с ключом из `SYSTEM_FILE` → `"<key>" — системное поле (набор); его можно только расширить через extend` (вместо обычного «duplicate»);
  - `managed` вне `SYSTEM_FILE` → путь `fields.<key>.managed`, `managed допускается только во встроенной части`;
  - `extend.sets.<set>`: набор не найден → `набор "<set>" не найден`; набор не системный → `extend расширяет только системные наборы`; поле не найдено → `поле "<f>" не найдено`;
  - `extend.fields.<f>`: поле не системное → `extend меняет только системные поля`; `options` у не-`enum` → `options допустимы только у enum`;
  - два `extend` одного поля в разных файлах → `extend поля "<f>" уже есть в <file>`.
  `extend.sets` дописывает поля в конец `fields` набора (без повторов); `extend.fields` заменяет `label` и/или `options` целиком. Применяется до проверок наборов и правил, так что правила видят расширенные наборы и варианты.

- [ ] **Step 1: Тесты** (`extend.test.ts`; системная часть — тестовая строка через `withSystem(files, SYS)`)

```ts
const SYS = `fields:
  role: {type: enum, label: Роль, options: [a, b], multiple: true}
  notes: {type: text, label: Заметки}
  merged: {type: link, label: Слит, target_sets: [person], cardinality: one, managed: true}
sets:
  person: {label: Человек, fields: [notes, merged]}`;
const build = (...user: string[]) =>
  compileConfig(parseConfigFiles(withSystem(user.map((content, n) => ({ name: `u${n}.yaml`, content })), SYS)));

test('system definitions are marked system, user ones are not', () => {
  const cfg = build('fields: {age: {type: number, label: Возраст}}\nsets: {task: {label: T, fields: [age]}}');
  expect(cfg.sets.get('person')!.system).toBe(true);
  expect(cfg.fields.get('notes')!.system).toBe(true);
  expect(cfg.fields.get('merged')!.managed).toBe(true);
  expect(cfg.sets.get('task')!.system).toBe(false);
  expect(cfg.fields.get('age')!.system).toBeUndefined();
});
test('extend appends fields to a system set and replaces label/options', () => {
  const cfg = build(`fields: {birthday: {type: date, label: ДР}}
extend:
  sets: {person: {fields: [birthday, notes]}}
  fields: {role: {label: Должность в семье, options: [муж, жена]}}`);
  expect(cfg.sets.get('person')!.fields).toEqual(['notes', 'merged', 'birthday']);
  expect(cfg.fields.get('role')).toMatchObject({ label: 'Должность в семье', options: ['муж', 'жена'] });
});
test('a rule may use options added by extend', () => {
  expect(() => build(`extend: {fields: {role: {options: [муж]}}}
rules: [{id: r, when: 'CONTAINS({role}, "муж")', require: [notes]}]`)).not.toThrow();
});
test.each([
  ['fields: {notes: {type: text, label: N}}', 'fields.notes', 'системное поле'],
  ['sets: {person: {label: P, fields: []}}', 'sets.person', 'системный набор'],
  ['fields: {x: {type: text, label: X, managed: true}}', 'fields.x.managed', 'только во встроенной части'],
  ['sets: {t: {label: T, system: true, fields: []}}', 'sets.t.system', 'Unrecognized key'],
  ['extend: {sets: {nope: {fields: []}}}', 'extend.sets.nope', 'набор "nope" не найден'],
  ['sets: {t: {label: T, fields: []}}\nextend: {sets: {t: {fields: []}}}', 'extend.sets.t', 'только системные наборы'],
  ['extend: {sets: {person: {fields: [zzz]}}}', 'extend.sets.person.fields', 'поле "zzz" не найдено'],
  ['fields: {age: {type: number, label: A}}\nextend: {fields: {age: {label: B}}}', 'extend.fields.age', 'только системные поля'],
  ['extend: {fields: {notes: {options: [a]}}}', 'extend.fields.notes.options', 'только у enum'],
])('config error: %s', (yaml, path, message) => {
  expect(issuesOf(() => build(yaml))).toContainEqual(expect.objectContaining({ path, message: expect.stringContaining(message) }));
});
test('extend of one field in two files is an error', () => {
  expect(issuesOf(() => build('extend: {fields: {role: {label: A}}}', 'extend: {fields: {role: {label: B}}}')))
    .toContainEqual(expect.objectContaining({ path: 'extend.fields.role', message: expect.stringContaining('уже есть в u0.yaml') }));
});
test('phone_region defaults to PL and is validated', () => {
  expect(build('').phoneRegion).toBe('PL');
  expect(build('workspace: {phone_region: DE}').phoneRegion).toBe('DE');
  expect(issuesOf(() => build('workspace: {phone_region: pl}'))).toContainEqual(expect.objectContaining({ path: 'workspace.phone_region' }));
});
test('a file named <system> among user files is rejected', () => {
  expect(() => withSystem([{ name: SYSTEM_FILE, content: '' }])).toThrow();
});
```

  `issuesOf(fn)` — локальный помощник: ловит `ConfigError`, возвращает `issues`. Существующие тесты `compile.test.ts` с `system: true` в пользовательском YAML (наборы `conv`) переводятся на `withSystem(..., 'sets: {conv: {label: C, fields: []}}')`; `parse.test.ts:23` больше не ждёт `system: false` из YAML, а получает его по файлу (значение то же).

- [ ] **Step 2:** `pnpm vitest run packages/core/test/config` — новые тесты падают.
- [ ] **Step 3:** Реализовать: схема (`schema.ts`), сбор `extend`/`managed`/`system` по файлу (`parse.ts`), применение `extend` и `phoneRegion` (`compile.ts`), `system.ts` с `SYSTEM_CONFIG = ''` (заполнит Task 2), экспорт `SYSTEM_FILE`, `withSystem` из `index.ts`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — всё зелёное.
- [ ] **Step 5: Commit** — `feat(core): system config part with extend, managed fields and phone_region`

---

### Task 2: Встроенные наборы `contact`, `organization`, `membership`

**Files:**
- Modify: `packages/core/src/config/system.ts` (`SYSTEM_CONFIG`), `packages/core/src/node.ts`
- Modify (переименование конфликтующих ключей в тестовых конфигах, которые грузятся через `loadConfigDir`, и в тестах, которые на них ссылаются): `packages/db/test/fixtures/config/montage.yaml` (набор `contact` → `person`, поле `notes` → `memo`), `packages/db/test/fixtures/cascade/config.yaml` (набор `contact` → `person`), `apps/server/test/fixtures/ok/config.yaml` и `broken/*.yaml` (`notes` → `memo`, набор `contact` → `person`), `packages/core/test/node.test.ts` (ожидаемый список ключей)
- Modify: `config/tasks.yaml` (`address` → `site_address` с `was: address`), Create: `config/contacts.yaml`
- Test: `packages/core/test/config/system.test.ts`, `starter-config.test.ts`

**Interfaces:**
- Consumes: Task 1 (`withSystem`, `extend`, `managed`).
- Produces: `SYSTEM_CONFIG` ровно с этим содержимым (порядок и метки — как здесь):
  ```yaml
  fields:
    notes: {type: text, label: Заметки, multiline: true}
    needs_review: {type: bool, label: Проверить}
    merged_into: {type: link, label: Слита в, target_sets: [contact, organization], cardinality: one, managed: true, inverse_label: Слитые записи}
    org_kind: {type: enum, label: Тип, options: [фирма, частный клиент]}
    nip: {type: text, label: NIP}
    address: {type: text, label: Адрес, multiline: true}
    email_domains: {type: text, label: Почтовые домены, multiple: true}
    contact: {type: link, label: Контакт, target_sets: [contact], cardinality: one, inverse_label: Участия}
    organization: {type: link, label: Организация, target_sets: [organization], cardinality: one, inverse_label: Участники}
    role: {type: enum, label: Роль, options: [ЛПР, бухгалтер, техник, другое], multiple: true}
    position: {type: text, label: Должность}
    active_from: {type: date, label: Действует с}
    active_to: {type: date, label: Действует по}
    is_primary: {type: bool, label: Основное}
    is_active: {type: formula, label: Действует, expr: 'IS_EMPTY({active_to}) OR {active_to} >= TODAY()'}
  sets:
    contact: {label: Контакт, fields: [notes, needs_review, merged_into]}
    organization: {label: Организация, fields: [org_kind, nip, address, email_domains, merged_into]}
    membership: {label: Участие, fields: [contact, organization, role, position, active_from, active_to, is_primary, is_active]}
  rules:
    - id: membership_links_required
      when: 'HAS_SET("membership")'
      require: [contact, organization]
    - id: membership_dates_order
      when: 'HAS_SET("membership") AND NOT(IS_EMPTY({active_from})) AND NOT(IS_EMPTY({active_to}))'
      validate: '{active_to} >= {active_from}'
      message: Дата окончания раньше даты начала
  ```
  `loadConfigDir(dir)` = `compileConfig(parseConfigFiles(withSystem(files)))`.
  `config/contacts.yaml` (стартовый пример):
  ```yaml
  # Contacts (spec 2026-10-31-contacts-organizations-design.md §2): the system sets come from @icrm/core;
  # this file only extends them.
  extend:
    fields:
      role: {options: [ЛПР, бухгалтер, техник, муж, жена, сын, дочь, другое]}
  ```

- [ ] **Step 1: Тесты**

```ts
// system.test.ts
const cfg = compileConfig(parseConfigFiles(withSystem([])));
test('system sets and fields compile on their own', () => {
  expect([...cfg.sets.keys()]).toEqual(['contact', 'organization', 'membership']);
  expect(cfg.fields.get('is_active')!.clock).toBe(true);
  expect(cfg.fields.get('merged_into')).toMatchObject({ managed: true, cardinality: 'one', target_sets: ['contact', 'organization'] });
});
test('membership requires contact and organization', () => {
  const res = evaluateRecord(cfg, null, { data: { title: 'm' }, sets: new Map([['membership', 'manual']]) }, { now: NOW, links: new Set() });
  expect(res.errors.map((e) => [e.code, e.field])).toEqual([['required', 'contact'], ['required', 'organization']]);
});
test('membership end before start is a validation error', () => {
  const res = evaluateRecord(cfg, null, {
    data: { title: 'm', active_from: '2026-11-02', active_to: '2026-11-01' }, sets: new Map([['membership', 'manual']]),
  }, { now: NOW, links: new Set(['contact', 'organization']) });
  expect(res.errors).toContainEqual(expect.objectContaining({ code: 'validation', rule_id: 'membership_dates_order' }));
});
test('is_active: empty or future end is active, past end is not', () => { /* active_to null → true; '2026-10-31' при NOW 2026-10-31 → true; '2026-10-30' → false */ });

// starter-config.test.ts (дополнить)
test('starter config extends roles and renames montage address', () => {
  expect(cfg.fields.get('role')!.options).toContain('жена');
  expect(cfg.fields.get('site_address')!.was).toBe('address');
  expect(cfg.fields.get('address')!.system).toBe(true);
});
```
  Сигнатуру `evaluateRecord` и форму `links` взять из `packages/core/test/engine/evaluate-record.test.ts` (как там задаётся наличие ссылок); `NOW = new Date('2026-10-31T10:00:00Z')`.

- [ ] **Step 2:** `pnpm vitest run packages/core` — новые тесты падают.
- [ ] **Step 3:** Заполнить `SYSTEM_CONFIG`, перевести `loadConfigDir` на `withSystem`, переименовать ключи в фикстурах и тестах (поиск по `contact`/`notes` в затронутых тестах), `config/tasks.yaml`, `config/contacts.yaml`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — всё зелёное (число тестов не меньше, чем до задачи, плюс новые).
- [ ] **Step 5: Commit** — `feat(core): built-in contact, organization and membership sets`

---

### Task 3: Нормализация адресов, NIP и доменов

**Files:**
- Create: `packages/core/src/contacts/normalize.ts`; Modify: `packages/core/src/index.ts`, `packages/core/package.json` (`libphonenumber-js`)
- Test: `packages/core/test/contacts/normalize.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Channel = 'email' | 'phone' | 'telegram';
  export type Normalized = { ok: true; normalized: string; display: string } | { ok: false; message: string };
  /** 'email'|'phone'|'telegram' as is, 'whatsapp' → 'phone', anything else → null. */
  export function identityChannel(channel: string): Channel | null;
  export function normalizeAddress(channel: Channel, raw: string, region: string): Normalized; // display = raw.trim()
  export function emailDomainOf(normalizedEmail: string): string;
  /** 10 digits with a valid checksum, from input with spaces, dashes and an optional "PL" prefix; null otherwise. */
  export function normalizeNip(raw: string): string | null;
  /** Lower case, no leading "@", a valid domain name; null otherwise. */
  export function normalizeEmailDomain(raw: string): string | null;
  export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string>;
  // gmail.com, googlemail.com, wp.pl, o2.pl, onet.pl, op.pl, interia.pl, poczta.fm, tlen.pl, gazeta.pl,
  // outlook.com, hotmail.com, live.com, yahoo.com, icloud.com, me.com, proton.me, protonmail.com, gmx.com, gmx.de
  ```
  Правила: email — `trim().toLowerCase()`, ровно один `@`, непустые части, в домене есть точка. Телефон — `parsePhoneNumberFromString(raw, region)`, годен при `isValid()`, результат `.number` (E.164). Telegram — только цифры → как есть; `@name` или `name` из 5–32 символов `[A-Za-z0-9_]`, начинается с буквы → `@` + нижний регистр; иначе ошибка. Сообщения ошибок: `Не похоже на адрес почты`, `Не похоже на номер телефона`, `Не похоже на Telegram id или @username`. NIP — веса `6 5 7 2 3 4 5 6 7`, контрольная цифра = сумма mod 11 (10 → недействителен).

- [ ] **Step 1: Тесты**

```ts
test.each([
  ['+48 600 100 200', '+48600100200'], ['600-100-200', '+48600100200'], ['0048600100200', '+48600100200'],
  ['(+48) 600 100 200', '+48600100200'], ['+44 20 7946 0958', '+442079460958'],
])('phone %s → %s', (raw, e164) => expect(normalizeAddress('phone', raw, 'PL')).toEqual({ ok: true, normalized: e164, display: raw.trim() }));
test.each(['12', 'abc', '+48 600'])('phone %s is invalid', (raw) => expect(normalizeAddress('phone', raw, 'PL').ok).toBe(false));
test('region decides national numbers', () => expect(normalizeAddress('phone', '030 901820', 'DE')).toMatchObject({ ok: true, normalized: '+4930901820' }));
test('email', () => {
  expect(normalizeAddress('email', ' Jan.Kowalski@Firma.PL ', 'PL')).toEqual({ ok: true, normalized: 'jan.kowalski@firma.pl', display: 'Jan.Kowalski@Firma.PL' });
  for (const bad of ['jan@', '@firma.pl', 'a@b@c.pl', 'jan@localhost', '']) expect(normalizeAddress('email', bad, 'PL').ok).toBe(false);
});
test('telegram', () => {
  expect(normalizeAddress('telegram', '123456789', 'PL')).toMatchObject({ normalized: '123456789' });
  expect(normalizeAddress('telegram', '@Jan_Kowalski', 'PL')).toMatchObject({ normalized: '@jan_kowalski' });
  expect(normalizeAddress('telegram', 'jan_kowalski', 'PL')).toMatchObject({ normalized: '@jan_kowalski' });
  for (const bad of ['@abc', '@1abcdef', 'jan kowalski']) expect(normalizeAddress('telegram', bad, 'PL').ok).toBe(false);
});
test('channels', () => {
  expect(identityChannel('whatsapp')).toBe('phone');
  expect(identityChannel('email')).toBe('email');
  expect(identityChannel('sms')).toBeNull();
});
test('nip', () => {
  expect(normalizeNip('5260250274')).toBe('5260250274');
  expect(normalizeNip('PL 526-025-02-74')).toBe('5260250274');
  expect(normalizeNip('5260250275')).toBeNull();
  expect(normalizeNip('526025027')).toBeNull();
});
test('email domains', () => {
  expect(normalizeEmailDomain(' @Firma.PL ')).toBe('firma.pl');
  expect(normalizeEmailDomain('firma')).toBeNull();
  expect(PUBLIC_EMAIL_DOMAINS.has('gmail.com')).toBe(true);
  expect(emailDomainOf('jan@firma.pl')).toBe('firma.pl');
});
```
  Если метаданные `libphonenumber-js` не считают какой-то пример действительным, заменить его другим номером той же страны и формы записи и отметить это в отчёте.

- [ ] **Step 2:** `pnpm vitest run packages/core/test/contacts` — падает.
- [ ] **Step 3:** `pnpm --filter @icrm/core add libphonenumber-js`; реализовать `normalize.ts`; экспорт из `index.ts`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(core): address, NIP and email domain normalisation`

---

### Task 4: `RecordService`: транзакционные операции, поведение наборов, служебные поля

**Files:**
- Create: `packages/db/src/service/behaviors.ts`
- Modify: `packages/db/src/service/record-service.ts`, `packages/db/src/service/errors.ts`, `packages/db/src/index.ts`, `packages/core/src/engine/evaluate-record.ts`, `packages/core/src/index.ts`
- Test: новый `packages/db/test/transaction.test.ts`; существующие тесты — без изменений, зелёные

**Interfaces:**
- Produces:
  ```ts
  // core: ErrorCode += 'managed_field' | 'invalid_address' | 'identity_taken' | 'invalid_owner' | 'nip_invalid'
  //   | 'nip_taken' | 'public_domain' | 'membership_active_exists' | 'primary_conflict' | 'membership_ended'
  //   | 'handover_target_invalid' | 'merge_kind_mismatch' | 'merge_self' | 'merge_archived';
  // RecordError += recordId?: string; ownerId?: string; ownerTitle?: string;

  // behaviors.ts
  export interface BehaviorContext { tx: Db; cfg: CompiledConfig; workspaceId: string; now: Date; userId: string }
  export interface SetBehavior {
    set: string;
    /** Before evaluation of a record whose pre-evaluation sets include `set`; may change `input` in place
     *  (links of a new record are already stored). `prev` is null on create. */
    beforeEvaluate?(ctx: BehaviorContext, r: { id: string; prev: RecordState | null; input: Record<string, Value>;
                    sets: Map<string, string> }): Promise<RecordError[]>;
    /** After values, sets and links of the save are written (every `persist`), before the cascade, for a
     *  record whose evaluated sets include `set`. */
    afterWrite?(ctx: BehaviorContext, r: { record: StoredRecord; prev: RecordState | null }): Promise<RecordError[]>;
    /** After `archiveIn` archived records; `records` are those of them that had `set`. */
    archived?(ctx: BehaviorContext, records: StoredRecord[]): Promise<void>;
    /** Extra properties of the view of a record that has `set`. */
    extendView?(tx: Db, rec: StoredRecord, view: RecordView): Promise<void>;
  }

  // record-service.ts
  constructor(o: { …; behaviors?: SetBehavior[] });
  CreateInput.system?: boolean; UpdateInput.system?: boolean; SetLinksInput.system?: boolean;
  export interface TxOps {
    readonly tx: Db;
    create(i: CreateInput): Promise<StoredRecord>;   // stored state after the write; no cascade
    update(i: UpdateInput): Promise<StoredRecord>;
    setLinks(i: SetLinksInput): Promise<StoredRecord>;
    archive(i: ArchiveInput): Promise<StoredRecord>;
    view(id: string): Promise<RecordView>;
  }
  transaction<T>(userId: string, work: (ops: TxOps) => Promise<T>):
    Promise<{ ok: true; value: T } | { ok: false; errors: RecordError[] }>;
  // seeds and budget of every op are collected; ONE cascade runs after `work`, before commit; withRetry
  // re-runs `work` from scratch. Public create/update/setLinks/archive = transaction(ops => ops.X(i)) + view.

  // errors.ts
  export const UNIQUE_ERRORS: Record<string, (detail: string | undefined) => RecordError>;  // filled by Tasks 5, 6
  export function uniqueViolation(e: unknown): RecordError | null; // 23505 with a known constraint → its error
  ```
  `managed_field`: без `system: true` — ключ `managed`-поля в `data` (create/update), в `links` (create) или как `field` у `setLinks` → `{code: 'managed_field', field, message: 'Поле «<label>» заполняется системой'}`; проверка до любых записей. `inTransaction`/`transaction` превращают `uniqueViolation(e) !== null` в `{ok: false, errors: [err]}`.

- [ ] **Step 1: Тесты** (`transaction.test.ts`; конфиг — `compileConfig(parseConfigFiles(withSystem([...], SYS)))` с тестовой системной частью: набор `person` (поля `memo`, `merged` — `managed` link → `person`), обычный набор `task` (`hours`, `total` — rollup sum по `items`, `items` — link many → `task`))

```ts
test('several saves in one transaction run one cascade and commit together', async () => {
  const res = await svc.transaction(userId, async (ops) => {
    const a = await ops.create({ userId, title: 'a', sets: ['task'], data: { hours: 2 } });
    const b = await ops.create({ userId, title: 'b', sets: ['task'], data: { hours: 3 } });
    const p = await ops.create({ userId, title: 'p', sets: ['task'], links: { items: [a.id, b.id] } });
    return p.id;
  });
  expect(res.ok).toBe(true);
  expect((await svc.get(res.ok ? res.value : ''))!.data.total).toBe(5);
});
test('an error in a later op rolls back the earlier ones', async () => {
  const before = await countRecords();
  const res = await svc.transaction(userId, async (ops) => {
    await ops.create({ userId, title: 'x', sets: ['task'] });
    await ops.create({ userId, title: 'y', sets: ['nope'] });
  });
  expect(res).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'unknown_set' })] });
  expect(await countRecords()).toBe(before);
});
test('managed fields are rejected from users and accepted from the system', async () => {
  const p = must(await svc.create({ userId, title: 'p', sets: ['person'] }));
  const q = must(await svc.create({ userId, title: 'q', sets: ['person'] }));
  expect(await svc.setLinks({ id: p.id, userId, field: 'merged', targetIds: [q.id] }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'managed_field', field: 'merged' })] });
  expect((await svc.setLinks({ id: p.id, userId, field: 'merged', targetIds: [q.id], system: true })).ok).toBe(true);
  expect(await svc.create({ userId, title: 'r', sets: ['person'], links: { merged: [q.id] } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'managed_field' })] });
});
test('behaviours run at their points, and their errors fail the save', async () => {
  const calls: string[] = [];
  const s = new RecordService({ db, cfg, workspaceId, now: () => NOW, behaviors: [{
    set: 'person',
    beforeEvaluate: async (_c, r) => { calls.push(`before:${r.prev === null}`); r.input.memo = String(r.input.memo ?? '').trim(); return []; },
    afterWrite: async (_c, r) => { calls.push('after'); return r.record.data.memo === 'bad' ? [{ code: 'validation', message: 'bad' }] : []; },
    archived: async (_c, recs) => { calls.push(`archived:${recs.length}`); },
    extendView: async (_tx, _rec, view) => { (view as RecordView & { extra?: number }).extra = 1; },
  }] });
  const p = must(await s.create({ userId, title: 'p', sets: ['person'], data: { memo: '  hi ' } }));
  expect(p.data.memo).toBe('hi');
  expect((p as RecordView & { extra?: number }).extra).toBe(1);
  expect((await s.update({ id: p.id, userId, expectedVersion: p.version, data: { memo: 'bad' } })).ok).toBe(false);
  await s.archive({ id: p.id, userId });
  expect(calls).toEqual(['before:true', 'after', 'before:false', 'after', 'archived:1']);
});
test('a unique violation with a known constraint becomes its error', async () => { /* зарегистрировать в UNIQUE_ERRORS
  тестовое ограничение (создать уникальный индекс в тесте), спровоцировать 23505 → {ok:false, errors:[ожидаемая ошибка]} */ });
```

- [ ] **Step 2:** `pnpm vitest run packages/db/test/transaction.test.ts` — падает.
- [ ] **Step 3:** Реализовать: `ErrorCode`/`RecordError` (core); `behaviors.ts`; в `RecordService` — накопитель семян и бюджета на транзакцию, `TxOps`, публичные методы через `transaction`; вызов `beforeEvaluate` в `finishCreateIn`/`finishUpdateIn` до подсчёта `userChangedKeys`, `afterWrite` — в конце `persist`, `archived` — в конце `archiveIn` (по всем архивированным записям, сгруппированным по наборам), `extendView` — в `view` (кроме строк внутри владельца); `managed`; `UNIQUE_ERRORS`/`uniqueViolation`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное; существующие тесты не менялись.
- [ ] **Step 5: Commit** — `feat(db): transactional record ops, set behaviours and managed fields`

---

### Task 5: Адреса (identities)

**Files:**
- Create: `packages/db/src/migrations/003_contacts.ts`, `packages/db/src/repo/identities.ts`, `packages/db/src/contacts/identities.ts`, `packages/db/src/contacts/behaviors.ts` (здесь — только `archived` и `extendView` адресов для трёх наборов), `packages/db/src/services.ts`, `apps/server/src/routes/identities.ts`, `packages/db/test/fixtures/contacts/workspace.yaml` (`workspace: {timezone: Europe/Warsaw}`)
- Modify: `packages/db/src/migrate.ts`, `schema.ts` (`IdentitiesTable`, `ChangeKind += 'identity'`), `service/errors.ts` (`identities_live_address`), `record-service.ts` (`RecordView.identities?`), `index.ts`, `apps/server/src/server.ts`
- Test: `packages/db/test/identities.test.ts`, `migrations.test.ts`, `apps/server/test/contacts-api.test.ts` (новый; конфиг — `loadConfigDir` фикстуры `apps/server/test/fixtures/ok`)

**Interfaces:**
- Consumes: Task 3 (`identityChannel`, `normalizeAddress`), Task 4 (`SetBehavior`, `TxOps`, `UNIQUE_ERRORS`).
- Produces:
  ```ts
  // 003_contacts: identities (§3.1 spec) + check (channel in ('email','phone','telegram'));
  //   unique index identities_live_address (workspace_id, channel, address_normalized) where archived_at is null;
  //   index identities_owner (owner_id);
  //   unique index records_live_nip on records (workspace_id, (data->>'nip')) where archived_at is null and data ? 'nip'
  export interface IdentityView { id: string; ownerId: string; channel: Channel; address: string; display: string;
    label: string | null; verified: boolean; createdAt: string; archivedAt: string | null }
  export type IdentityResult = { ok: true; identity: IdentityView } | { ok: false; errors: RecordError[] };
  export class IdentityService {
    constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date });
    add(i: { ownerId: string; channel: string; address: string; label?: string | null; verified?: boolean; userId: string }): Promise<IdentityResult>;
    update(i: { id: string; label?: string | null; verified?: boolean; display?: string; userId: string }): Promise<IdentityResult>;
    move(i: { id: string; to: string; userId: string }): Promise<IdentityResult>;
    archive(i: { id: string; userId: string }): Promise<IdentityResult>;
    search(q: string, limit?: number): Promise<(IdentityView & { ownerTitle: string })[]>;  // limit 20; ILIKE по normalized и display
    liveOf(tx: Db, ownerIds: string[]): Promise<IdentityView[]>;
    /** Inside the caller's transaction: owner check + lock, moves, logs; used by Tasks 8, 9. */
    moveIn(tx: Db, identityId: string, toOwnerId: string, userId: string): Promise<void>;
    archiveOfOwnersIn(tx: Db, ownerIds: string[], userId: string, source: 'user' | 'cascade'): Promise<void>;
  }
  export function contactBehaviors(identities: IdentityService): SetBehavior[];   // дополняется в Task 6
  export interface Services { records: RecordService; identities: IdentityService }  // дополняется в Tasks 6–9
  export function createServices(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date }): Services;
  ```
  - Владелец (`add`, `move.to`): живая запись этого workspace с набором `contact`, `membership` или `organization`, блокируется `FOR UPDATE`; иначе `invalid_owner` (`Владельцем адреса может быть контакт, участие или организация`).
  - Канал: `identityChannel`; `null` или ошибка нормализации → `invalid_address` (сообщение нормализации).
  - Занятость: живой адрес с тем же `(channel, normalized)` → `identity_taken` с `ownerId`, `ownerTitle`, сообщение `Адрес уже принадлежит «<title>»`; гонка (23505 `identities_live_address`) → то же, `ownerId`/`ownerTitle` дочитываются после отката.
  - `move` на того же владельца — без изменений; на архивный адрес — `archived`. `update` архивного — `archived`.
  - Журнал `identity`: `add` — у владельца `old: null, new: {identityId, channel, address}`; `move` — у старого `old: obj, new: null`, у нового `old: null, new: obj`; `archive` — `old: obj, new: null`; `source` — `user`, при архивировании вместе с владельцем — `cascade`.
  - `RecordView.identities` — живые адреса, порядок `created_at`, у записей с любым из трёх наборов.
  - HTTP (§3.4 спецификации): `POST /records/:id/identities` → 201 `IdentityView`; `PATCH /identities/:id`, `POST /identities/:id/move` `{to}`, `DELETE /identities/:id` → 200; `GET /identities?q=` → `{items}`; ошибки — `{errors}` со статусом `statusOf` (`not_found` → 404). `server.ts` строит сервисы через `createServices`.

- [ ] **Step 1: Тесты** (`identities.test.ts`; `createServices` над `loadConfigDir` фикстуры `packages/db/test/fixtures/contacts/` — пустой каталог с `workspace.yaml`, только системная часть)

```ts
test('one phone in different spellings is one address', async () => {
  const anna = await contact('Anna'); const jan = await contact('Jan');
  expect((await ids.add({ ownerId: anna.id, channel: 'phone', address: '600 100 200', userId })).ok).toBe(true);
  for (const spelling of ['+48 600-100-200', '0048600100200']) {
    expect(await ids.add({ ownerId: jan.id, channel: 'phone', address: spelling, userId })).toEqual({ ok: false, errors: [
      expect.objectContaining({ code: 'identity_taken', ownerId: anna.id, ownerTitle: 'Anna' })] });
  }
});
test('whatsapp is stored as phone', async () => {
  const r = await ids.add({ ownerId: (await contact('W')).id, channel: 'whatsapp', address: '+48 601 000 001', userId });
  expect(r).toMatchObject({ ok: true, identity: { channel: 'phone', address: '+48601000001', display: '+48 601 000 001' } });
});
test('two concurrent adds of one address: one wins, the other is identity_taken', async () => {
  const [a, b] = [await contact('A'), await contact('B')];
  const res = await Promise.all([a, b].map((c) => ids.add({ ownerId: c.id, channel: 'email', address: 'race@firma.pl', userId })));
  expect(res.filter((r) => r.ok)).toHaveLength(1);
  expect(res.find((r) => !r.ok)).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'identity_taken' })] });
});
test('archiving the owner frees its addresses', async () => {
  const old = await contact('Old'); await ids.add({ ownerId: old.id, channel: 'email', address: 'x@firma.pl', userId });
  await svc.records.archive({ id: old.id, userId });
  const fresh = await contact('New');
  expect((await ids.add({ ownerId: fresh.id, channel: 'email', address: 'X@firma.pl', userId })).ok).toBe(true);
  expect(await changeKinds(old.id)).toContainEqual({ kind: 'identity', source: 'cascade' });
});
test('owner must be a live contact, membership or organization', async () => {
  const task = /* запись без системных наборов */;
  expect(await ids.add({ ownerId: task.id, channel: 'email', address: 'a@b.pl', userId }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_owner' })] });
});
test('move logs both owners and keeps the owner versions', async () => { /* move contact→organization; журнал у обоих; version обоих прежние */ });
test('invalid address and unknown channel', async () => { /* 'phone','12' → invalid_address; channel 'sms' → invalid_address */ });
test('views carry live identities; search finds by part of the address', async () => { /* get(contact).identities; search('100 200') и search('firma') */ });
```
  `apps/server/test/contacts-api.test.ts`: `POST /records/:id/identities` 201 и 422 (`identity_taken`), `GET /identities?q=`, `POST /identities/:id/move`, `DELETE /identities/:id`, `PATCH` с неизвестным ключом → 400.

- [ ] **Step 2:** `pnpm vitest run packages/db/test/identities.test.ts` — падает.
- [ ] **Step 3:** Реализовать миграцию, репозиторий, `IdentityService`, поведение `archived`/`extendView`, `createServices`, маршруты.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(db): channel identities with normalised unique addresses`

---

### Task 6: Поведение организации и участия

**Files:**
- Create: `packages/db/src/contacts/memberships.ts`
- Modify: `packages/db/src/contacts/behaviors.ts`, `service/errors.ts` (`records_live_nip`), `record-service.ts` (`RecordView.memberships?`)
- Test: `packages/db/test/contacts-behaviors.test.ts`, `apps/server/test/contacts-api.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces:
  ```ts
  // memberships.ts
  export interface MembershipView { id: string; title: string; contactId: string | null; contactTitle: string | null;
    organizationId: string | null; organizationTitle: string | null; role: string[]; position: string | null;
    activeFrom: string | null; activeTo: string | null; isPrimary: boolean; active: boolean }
  export function isActiveOn(activeTo: Value | undefined, today: string): boolean;   // пусто или >= today
  /** Live memberships linked to `contactId` (field `contact`) or `organizationId` (field `organization`). */
  export async function membershipsOf(tx: Db, cfg: CompiledConfig, workspaceId: string, by: { contactId: string } | { organizationId: string }, today: string): Promise<MembershipView[]>;
  // RecordView.memberships?: MembershipView[] — у контакта (по полю contact) и у организации (по полю organization),
  //   порядок: активные, затем закрытые; внутри — по activeFrom убыв., затем id
  ```
  Поведение (`contactBehaviors` дополняется):
  - **organization.beforeEvaluate:** `nip` во вводе — непустая строка → `normalizeNip`; `null` → `{code: 'nip_invalid', field: 'nip', message: 'Неверный NIP'}`; нормализованное значение записывается во ввод. Затем живая запись этого workspace (не эта) с тем же `data->>'nip'` → `nip_taken`, сообщение `NIP уже у «<title>»`, `ownerId`/`ownerTitle`. `email_domains` во вводе — каждое через `normalizeEmailDomain` (`null` → `invalid_value`, field `email_domains`), публичный → `public_domain` (`Домен <d> — публичная почта, по нему нельзя узнать организацию`); результат — без повторов, в порядке ввода.
  - **23505 `records_live_nip`** → `nip_taken` (field `nip`).
  - **membership.beforeEvaluate** на создании: пустой `title` → `<title контакта> — <title организации>` (по ссылкам `contact`, `organization`; если одной нет — заголовок не трогается, правило `membership_links_required` даст ошибку).
  - **membership.afterWrite** для живой записи: advisory-блокировка по контакту; если запись активна (`isActiveOn(active_to, today)`): другое активное участие той же пары → `{code: 'membership_active_exists', field: 'organization', message: 'У контакта уже есть действующее участие в этой организации'}`; `is_primary` и другое активное с `is_primary` у этого контакта → `{code: 'primary_conflict', field: 'is_primary', message: 'У контакта уже есть основное участие'}`. `today = todayIn(cfg.timezone, now)`.

- [ ] **Step 1: Тесты**

```ts
test('nip is normalised, validated and unique among live organizations', async () => {
  const a = must(await rec.create({ userId, title: 'Firma A', sets: ['organization'], data: { nip: 'PL 526-025-02-74' } }));
  expect(a.data.nip).toBe('5260250274');
  expect(await rec.create({ userId, title: 'B', sets: ['organization'], data: { nip: '5260250275' } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'nip_invalid', field: 'nip' })] });
  expect(await rec.create({ userId, title: 'C', sets: ['organization'], data: { nip: '5260250274' } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'nip_taken', ownerId: a.id, ownerTitle: 'Firma A' })] });
  await rec.archive({ id: a.id, userId });
  expect((await rec.create({ userId, title: 'D', sets: ['organization'], data: { nip: '5260250274' } })).ok).toBe(true);
});
test('email domains are normalised; public ones are rejected', async () => {
  const o = must(await rec.create({ userId, title: 'O', sets: ['organization'], data: { email_domains: ['@Firma.PL', 'firma.pl', 'biuro.firma.pl'] } }));
  expect(o.data.email_domains).toEqual(['firma.pl', 'biuro.firma.pl']);
  expect(await rec.create({ userId, title: 'P', sets: ['organization'], data: { email_domains: ['gmail.com'] } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'public_domain', field: 'email_domains' })] });
});
test('a new membership gets a title from its contact and organization', async () => {
  const m = await membership(anna, firmaX);           // помощник: create с links {contact, organization}, title ''
  expect(m.title).toBe('Anna Nowak — Firma X');
});
test('one active membership per contact and organization; leaving and returning is allowed', async () => {
  const m1 = await membership(anna, firmaX);
  expect(await rawMembership(anna, firmaX)).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'membership_active_exists' })] });
  must(await rec.update({ id: m1.id, userId, expectedVersion: m1.version, data: { active_to: '2026-10-01' } }));
  expect((await rawMembership(anna, firmaX)).ok).toBe(true);
});
test('relinking a membership to a contact who already works there is rejected and rolled back', async () => {
  const mJan = await membership(jan, firmaX); const mAnna = await membership(anna, firmaY);
  expect(await rec.setLinks({ id: mAnna.id, userId, field: 'organization', targetIds: [firmaX.id] }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'membership_active_exists' })] });
  expect((await rec.get(mAnna.id))!.links.organization).toEqual([firmaY.id]);
  void mJan;
});
test('one primary active membership per contact', async () => { /* второе с is_primary → primary_conflict; закрытое не мешает */ });
test('contact and organization views list memberships', async () => { /* get(anna).memberships: активные первыми; get(firmaX).memberships с contactTitle */ });
```
  API: `POST /records` организации с плохим NIP → 422 `nip_invalid`.

- [ ] **Step 2:** `pnpm vitest run packages/db/test/contacts-behaviors.test.ts` — падает.
- [ ] **Step 3:** Реализовать `memberships.ts`, поведение, маппинг `records_live_nip`, `extendView` участий.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(db): organization and membership behaviour`

---

### Task 7: Сопоставление адреса

**Files:**
- Create: `packages/db/src/contacts/contact-service.ts`
- Modify: `packages/db/src/services.ts` (`Services.contacts`), `index.ts`, `apps/server/src/routes/identities.ts`
- Test: `packages/db/test/resolve.test.ts`, `apps/server/test/contacts-api.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6 (`membershipsOf`, `isActiveOn`, `IdentityView`).
- Produces:
  ```ts
  export interface RecordRef { id: string; title: string }
  export type ResolveResult =
    | { ok: false; errors: RecordError[] }                    // invalid_address
    | { ok: true; identity: IdentityView | null; contact: RecordRef | null; membership: RecordRef | null;
        organization: RecordRef | null; membershipEnded: boolean; hints: RecordRef[] };
  export class ContactService {
    constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date;
                     records: RecordService; identities: IdentityService }); // Task 9 добавляет mergeSteps?: MergeStep[]
    resolveAddress(channel: string, address: string): Promise<ResolveResult>;
    counterpartyOf(contactId: string): Promise<RecordRef | null>;
  }
  ```
  Таблица результатов — §4 спецификации. `hints` — только при ненайденном email: живые записи с набором `organization`, у которых `data->'email_domains' ? <домен>`, по `title`; иначе `[]`. `counterpartyOf`: активные участия контакта; одно → его организация; несколько → организация единственного активного с `is_primary`; иначе `null`. HTTP: `GET /identities/lookup?channel=&address=` → 200 с телом результата без `ok`; `invalid_address` → 422 `{errors}`.

- [ ] **Step 1: Тесты**

```ts
test('address of a contact → contact and its single active counterparty', async () => {
  await ids.add({ ownerId: anna.id, channel: 'email', address: 'anna@prywatna.pl', userId });
  await membership(anna, firmaX);
  expect(await cs.resolveAddress('email', 'Anna@Prywatna.pl')).toMatchObject({ ok: true,
    contact: { id: anna.id }, membership: null, organization: { id: firmaX.id }, membershipEnded: false });
});
test('address of a membership → person and organization; ended membership is flagged', async () => {
  const m = await membership(anna, firmaY);
  await ids.add({ ownerId: m.id, channel: 'whatsapp', address: '+48 602 000 002', userId });
  expect(await cs.resolveAddress('phone', '602000002')).toMatchObject({ contact: { id: anna.id }, membership: { id: m.id }, organization: { id: firmaY.id }, membershipEnded: false });
  await end(m, '2026-10-01');
  expect(await cs.resolveAddress('whatsapp', '+48602000002')).toMatchObject({ membershipEnded: true });
});
test('address of an organization → organization without a person', async () => { /* contact null, organization firmaX */ });
test('unknown email → hints by email domain', async () => {
  /* firmaX.email_domains = ['firma-x.pl'] */
  expect(await cs.resolveAddress('email', 'nowy@firma-x.pl')).toMatchObject({ identity: null, contact: null, hints: [{ id: firmaX.id }] });
  expect(await cs.resolveAddress('phone', '+48 699 999 999')).toMatchObject({ identity: null, hints: [] });
});
test('invalid address', async () => { expect(await cs.resolveAddress('phone', '12')).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'invalid_address' })] }); });
test('counterpartyOf: none, one, several with/without primary', async () => { /* null; X; X+Y → null; X+Y(primary) → Y */ });
```

- [ ] **Step 2:** `pnpm vitest run packages/db/test/resolve.test.ts` — падает.
- [ ] **Step 3:** Реализовать `ContactService` (сопоставление), подключить в `createServices`, маршрут `lookup` (регистрируется до `GET /identities/:id`-подобных маршрутов, если такие есть).
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(db): resolve a channel address to contact and counterparty`

---

### Task 8: Уход из организации и передача дел

**Files:**
- Modify: `packages/db/src/contacts/contact-service.ts`, `index.ts`
- Create: `apps/server/src/routes/memberships.ts`; Modify: `apps/server/src/server.ts`
- Create: `packages/db/test/fixtures/contacts-handover/assets.yaml` (тестовые наборы: `equipment` с `holder: {type: link, target_sets: [membership, organization], cardinality: one}`, `account` с `user_of: {type: link, target_sets: [membership], cardinality: one}` и правилом `readonly: [user_of]` при `{locked}`)
- Test: `packages/db/test/handover.test.ts`, `apps/server/test/contacts-api.test.ts`

**Interfaces:**
- Consumes: Task 4 (`transaction`, `TxOps`), Task 5 (`moveIn`), Task 6 (`membershipsOf`, `isActiveOn`).
- Produces:
  ```ts
  export interface HandoverLink { linkId: string; field: string; fromId: string; fromTitle: string; organizationAllowed: boolean }
  export interface Handover { identities: IdentityView[]; links: HandoverLink[] }
  export type IdentityTarget = 'successor' | 'organization' | 'contact' | 'keep' | 'archive';
  export type LinkTarget = 'successor' | 'organization' | 'keep';
  export interface EndMembershipInput {
    id: string; version: number; date: string; userId: string;
    successor: { membershipId: string } | { contactId: string; role?: string[]; position?: string | null } | null;
    identities?: Record<string, IdentityTarget>; links?: Record<string, LinkTarget>;
  }
  export type HandoverResult = { ok: true; membership: RecordView; successor: RecordView | null } | { ok: false; errors: RecordError[] };
  ContactService.handover(membershipId: string): Promise<Handover | null>;     // null — нет такого участия
  ContactService.endMembership(i: EndMembershipInput): Promise<HandoverResult>;
  ContactService.unassigned(organizationId: string): Promise<Handover | null>; // адреса организации + ссылки на неё из полей, чьи target_sets включают membership
  ContactService.take(i: { membershipId: string; identities: string[]; links: string[]; userId: string }): Promise<HandoverResult>; // successor: null
  ```
  - `links` предпросмотра: строки `links` с `to_id` = участию, источник живой; `organizationAllowed` = `target_sets` поля включают `organization`.
  - `endMembership` — одна `records.transaction`, шаги §5.2 спецификации в этом порядке: закрыть участие (`ops.update` `active_to = date`, `expectedVersion = version`; уже есть `active_to` → `membership_ended`); преемник (существующий: живой, `membership`, та же организация, активный на `date` — иначе `handover_target_invalid`; новый: `ops.create` с `title: ''`, `sets: ['membership']`, `links: {contact: [contactId], organization: [org]}`, `data: {role, position}` — по умолчанию с уходящего); адреса; связи.
  - Значения по умолчанию — §5.2 п.5. Ключ карты, которого нет в предпросмотре, `successor` без преемника, `organization` для ссылки без `organizationAllowed` → `handover_target_invalid` с сообщением, называющим адрес или ссылку; проверяется до любых изменений.
  - Связь перевешивается `ops.setLinks(from, field, <цели с заменой id участия на новую цель, без повторов>)`; ошибка этого сохранения возвращается с `recordId = from` (и полем).
  - `take`: участие живое и активное; каждый адрес принадлежит его организации, каждая ссылка ведёт на неё из поля, допускающего `membership` — иначе `handover_target_invalid`.
  - HTTP: `GET /memberships/:id/handover`, `POST /memberships/:id/end` (тело — `EndMembershipInput` без `id`/`userId`), `GET /organizations/:id/unassigned`, `POST /memberships/:id/take`; результат — `{membership, successor}` 200, ошибки — `{errors}` по `statusOf`, `null` → 404.

- [ ] **Step 1: Тесты** (конфиг: `contacts-handover/` = системная часть + `assets.yaml`)

```ts
test('preview lists identities and incoming links', async () => { /* адрес участия; equipment.holder → m (organizationAllowed true); account.user_of → m (false) */ });
test('end with a new successor: phone and laptop go to the successor', async () => {
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: { contactId: ewa.id } });
  expect(r.ok && r.successor!.title).toBe('Ewa — Firma X');
  expect(r.ok && r.successor!.data.role).toEqual(['бухгалтер']);
  expect((await rec.get(m.id))!.data.active_to).toBe('2026-11-30');
  expect((await cs.resolveAddress('phone', phoneOfM))).toMatchObject({ contact: { id: ewa.id } });
  expect((await rec.get(laptop.id))!.links.holder).toEqual([r.ok ? r.successor!.id : '']);
});
test('end without successor: identities and organization-capable links go to the organization, the rest stay', async () => {
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null });
  expect(r.ok).toBe(true);
  expect(await cs.resolveAddress('phone', phoneOfM)).toMatchObject({ contact: null, organization: { id: firmaX.id } });
  expect((await rec.get(laptop.id))!.links.holder).toEqual([firmaX.id]);
  expect((await rec.get(account.id))!.links.user_of).toEqual([m.id]);       // keep: поле не допускает организацию
});
test('explicit organization for a link that does not allow it is rejected, nothing changes', async () => {
  const r = await cs.endMembership({ id: m.id, version: m.version, date: '2026-11-30', userId, successor: null,
    links: { [accountLinkId]: 'organization' } });
  expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'handover_target_invalid' })] });
  expect((await rec.get(m.id))!.data.active_to ?? null).toBeNull();
});
test('contact takes the phone; archive and keep', async () => { /* identities: {a: 'contact', b: 'archive', c: 'keep'} */ });
test('a rule of the source record rejecting the relink rolls everything back and names the record', async () => {
  /* account.locked = true (readonly user_of); links: {accountLinkId: 'successor'} →
     {ok:false, errors:[{code:'readonly', recordId: account.id, field:'user_of'}]}; m не закрыто, преемник не создан */
});
test('already ended membership and a successor from another organization are rejected', async () => { /* membership_ended; handover_target_invalid */ });
test('unassigned and take', async () => {
  /* после end без преемника: unassigned(firmaX) = адрес + ссылка laptop; take новым участием → адрес и ссылка на нём; unassigned пуст */
});
```
  API: `GET /memberships/:id/handover` 200 / 404, `POST /memberships/:id/end` 200 и 422, `GET /organizations/:id/unassigned`, `POST /memberships/:id/take`.

- [ ] **Step 2:** `pnpm vitest run packages/db/test/handover.test.ts` — падает.
- [ ] **Step 3:** Реализовать в `ContactService`, маршруты.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(db): membership end with handover to successor or organization`

---

### Task 9: Слияние дублей

**Files:**
- Modify: `docs/superpowers/specs/2026-10-30-icrm-architecture-design.md` §1.12 (оговорка о слиянии — первым шагом), `packages/db/src/contacts/contact-service.ts`, `packages/db/src/service/record-service.ts` (`lockWithOwner`), `packages/db/src/repo/records.ts` (`setOwner`), `index.ts`
- Create: `apps/server/src/routes/merge.ts`; Modify: `apps/server/src/server.ts`, `README.md` (раздел «Контакты и организации»)
- Test: `packages/db/test/merge.test.ts`, `rows.test.ts` (перечитывание владельца), `apps/server/test/contacts-api.test.ts`

**Interfaces:**
- Consumes: Tasks 4–8.
- Produces:
  ```ts
  export type MergeKind = 'contact' | 'organization';
  export type MergeStep = (tx: Db, kind: MergeKind, sourceId: string, targetId: string) => Promise<void>;
  export interface MergeConflict { field: string; source: Value | string[]; target: Value | string[] }
  export interface MergePreview { kind: MergeKind; conflicts: MergeConflict[]; identities: number;
    memberships: { id: string; title: string; collapsesInto: string | null }[]; links: number; rows: number }
  export type MergeChoice = Record<string, 'source' | 'target'>;
  ContactService.mergePreview(sourceId: string, targetId: string): Promise<{ ok: true; preview: MergePreview } | { ok: false; errors: RecordError[] }>;
  ContactService.merge(i: { sourceId: string; targetId: string; values?: MergeChoice; userId: string }): Promise<SaveResult>; // record = вид B
  // repo/records.ts
  export async function setOwner(tx: Db, rowIds: string[], ownerId: string): Promise<void>;
  // createServices(o: { …; mergeSteps?: MergeStep[] })
  ```
  - Вид: оба с `contact` → `contact`; оба с `organization` → `organization`; иначе `merge_kind_mismatch`; `sourceId === targetId` → `merge_self`; любой архивный → `merge_archived`; не найден → `not_found`. Проверки — до блокировок изменений.
  - Конфликты: обычные (не вычисляемые, не `managed`) поля и `title`, где у обоих непустые разные значения; связи `cardinality: one` с разными целями. Выбор по умолчанию — `target`.
  - Шаги и порядок — «Решения плана» выше и §6.2 спецификации. `A` и `B` блокируются первыми, в порядке id. Схлопывание участий — до перевешивания: участие от `A` с тем же партнёром, что у активного участия `B`, → его адреса (`moveIn`) и входящие ссылки — на участие `B`, роли объединяются (`ops.update` участия `B`), участие от `A` — `active_to = today`, `ops.archive`. Если после переноса у контакта два `is_primary`, у участия от `A` снимается `is_primary` до перевешивания.
  - Входящие ссылки: все `links` с `to_id = A` из живых записей, кроме `merged_into`; `ops.setLinks(from, field, <замена A на B без повторов>)`; ошибка — с `recordId`.
  - Строки `A`: `setOwner(rows, B)` и перенос целей владеемых полей `A` в конец тех же полей `B` (`ops.setLinks` с `system: true` не нужен — поля не `managed`; владеемые цели проверяются `link_owned` уже после `setOwner`).
  - `users.contact_record_id = A` → `B`. Затем `mergeSteps` по порядку. Затем `ops.setLinks(A, 'merged_into', [B], system: true)`, `ops.archive(A)`. Затем `ops.update(B)`: выбранные и пустые значения, ручные наборы `A`, которых нет у `B`.
  - `lockWithOwner`: после `lockEditable(row)` — если `row.ownerId` не совпадает с заблокированным владельцем, заблокировать нового владельца и перечитать строку (не больше одного раза за попытку; иначе `version_conflict`).
  - HTTP: `GET /records/:id/merge-preview?into=` → 200 `MergePreview` / 422; `POST /records/:id/merge` `{into, values?}` → 200 вид `B` / 422 / 404.
  - README: системные наборы и `extend`, адреса и `whatsapp`, сопоставление, передача дел, слияние — по одному абзацу с примером запроса.

- [ ] **Step 1: Тесты**

```ts
test('contacts: identities, memberships, incoming links and users move; A is archived with merged_into', async () => {
  const r = await cs.merge({ sourceId: a.id, targetId: b.id, userId });
  expect(r.ok).toBe(true);
  const aNow = (await rec.get(a.id))!;
  expect(aNow.archivedAt).not.toBeNull();
  expect(aNow.links.merged_into).toEqual([b.id]);
  expect((await cs.resolveAddress('email', emailOfA))).toMatchObject({ contact: { id: b.id } });
  expect((await rec.get(laptop.id))!.links.holder).toEqual([b.id]);
  expect(await userContact(userOfA)).toBe(b.id);
});
test('two active memberships in one organization collapse into the one of B', async () => {
  /* mA(a, X, роль бухгалтер, адрес p), mB(b, X, роль ЛПР) → после слияния: живое одно mB, role ['ЛПР','бухгалтер'],
     адрес p на mB; mA архивно, active_to = today; ошибок нет */
});
test('conflicts default to target, choice takes source; empty B fields are filled', async () => {
  const p = await cs.mergePreview(a.id, b.id);
  expect(p.ok && p.preview.conflicts).toContainEqual({ field: 'notes', source: 'A notes', target: 'B notes' });
  const r = await cs.merge({ sourceId: a.id, targetId: b.id, values: { notes: 'source' }, userId });
  expect(r.ok && r.record.data).toMatchObject({ notes: 'A notes', needs_review: true /* было пусто у B */ });
});
test('organizations with the same NIP merge; memberships move to B', async () => { /* nip у обоих разный: values {nip: 'source'} → B получает NIP A без nip_taken */ });
test('rows of A move to B', async () => { /* контакт с owned-полем (тестовый набор); строки A → owner_id B, в links B */ });
test('merge steps run inside the transaction', async () => { /* mergeSteps: [(tx, kind, s, t) => записать в тестовую таблицу]; ошибка шага откатывает всё */ });
test('kind mismatch, self, archived', async () => { /* merge_kind_mismatch (контакт↔организация), merge_self, merge_archived */ });
test('a rule of a source record rejecting the relink rolls the merge back and names the record', async () => { /* readonly у account.user_of → recordId */ });
// rows.test.ts
test('a row save locks the new owner when the owner changed meanwhile', async () => { /* setOwner между peek и lock недетерминирован —
  проверить ветку прямым вызовом: строка, затем setOwner на другого владельца, затем update строки → ok, owner_id новый, версия нового владельца не менялась */ });
```

- [ ] **Step 2:** Дописать в §1.12 основной спецификации (п. про `owner_id`): «меняется только при слиянии дублей (подпроект 2): строки записи `A` переходят к `B`». `pnpm vitest run packages/db/test/merge.test.ts` — падает.
- [ ] **Step 3:** Реализовать слияние, `setOwner`, `lockWithOwner`, маршруты, README.
- [ ] **Step 4:** `pnpm typecheck && pnpm test` — зелёное.
- [ ] **Step 5: Commit** — `feat(db): merge duplicate contacts and organizations`
