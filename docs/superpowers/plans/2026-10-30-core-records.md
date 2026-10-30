# Ядро записей (подпроект 1) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Универсальные записи с совмещаемыми наборами полей, правилами, формулами, итоговыми полями и связями, заданные YAML-конфигом, с атомарным сохранением в Postgres и минимальным HTTP API (`/meta`, `/records`, `/query`).

**Architecture:** `packages/core` — чистая логика без I/O (язык выражений, компиляция конфига, движок записи, агрегаты), работает и в Node, и в браузере. `packages/db` — схема Postgres (Kysely), конвейер сохранения записи с каскадом итогов, синхронизация конфига с БД, перевод фильтров в SQL. `apps/server` — тонкий Fastify-слой над `RecordService`.

**Tech Stack:** Node 24, pnpm (через corepack), TypeScript 5 strict ESM, Vitest, `yaml` 2 (позиции ошибок), `zod` 3, `decimal.js` 10, `kysely` 0.27 + `pg` 8, `uuidv7` 1, `@testcontainers/postgresql` 10, `fastify` 5.

**Spec:** `docs/superpowers/specs/2026-10-30-icrm-architecture-design.md` (§0–§2, §1.9–§1.11, §5). Системные наборы §3 и сообщения §4 — **не** в этом плане.

## Global Constraints

- Все таблицы имеют `workspace_id`; `RecordService` всегда работает в рамках одного workspace.
- Ключ поля — `^[a-z][a-z0-9_]*$`; метка — любая строка. Ключ `title` встроенный (тип `text`), в конфиге его переопределять нельзя.
- `money` в JSONB: `{amount: string, currency: string}`, amount `^-?\d+(\.\d+)?$`, currency `^[A-Z]{3}$`; арифметика только через `decimal.js`.
- `date` = `"YYYY-MM-DD"`, `datetime` = ISO-8601 UTC с `Z`.
- Пустое значение: `null`, `""`, строка из пробелов, `[]`. Арифметика с пустым → `null`; сравнение с пустым → `FALSE`; `&`/`CONCAT` считают пустое как `""`.
- Ошибка вычисления формулы во время работы (деление на 0, разные валюты) → значение `null`, сохранение не падает.
- Стабилизация записи — максимум **10** проходов, иначе ошибка `oscillation` и откат.
- Ошибки сохранения — `{field?, rule_id?, code, message}`.
- id записей — uuid v7.
- `change_log.source` ∈ `user | rule | cascade | system`.
- Порты сервера по умолчанию `127.0.0.1:3100`.
- Интеграционные тесты требуют запущенного Docker Desktop (testcontainers, образ `postgres:16-alpine`).

## Решения плана, которых нет в спецификации

- Формулы и итоги считаются только для полей, входящих хотя бы в один **включённый** набор записи; поля выключенных наборов не пересчитываются и не трогаются.
- Поле, упомянутое в каком-либо правиле `show`, по умолчанию скрыто и видно, только пока такое правило активно; `hide` скрывает.
- `readonly` проверяется по **сохранённому** (старому) состоянию записи: изменение поля, которое было readonly до правки, отклоняется. `required` и `validate` проверяются по новому состоянию.
- Проверка типа значения и допустимых вариантов (`options` поля и `options` правил) — только для ключей, изменённых в этом сохранении. Запись со «старым» значением, ставшим недопустимым после правки конфига, остаётся сохраняемой.
- Агрегаты по пустому множеству: `sum`/`count` → 0, `all` → TRUE, `any` → FALSE, `list` → `[]`, `min`/`max`/`avg`/`first` → `null`. Архивные записи в итоги не попадают.
- Подпись определения формулы/итога (`defSignature`) — канонический JSON-текст определения (без криптографии, чтобы `core` работал в браузере).
- Вход в API в этом подпроекте — статический Bearer-токен `ICRM_API_TOKEN`, все действия от системного пользователя `system@local`. Логин с паролем — подпроект 7.
- Вне плана (отмечено в PLAN.md): суточный пересчёт `TODAY()`-формул по расписанию (worker, подпроект 3+), загрузка файлов и `FileStorage`, системные наборы.

## Review Focus

1. **Значение enum, удалённое из конфига.** Запись с таким значением должна сохраняться при правке других полей — тест в Task 10 `saves record with stale enum value when other field changes`.
2. **`TODAY()` около полуночи.** Дата берётся в часовом поясе workspace (`Europe/Warsaw` по умолчанию), а не UTC — тест в Task 3 `TODAY uses workspace timezone`.
3. **Пробелы как значение обязательного поля.** `"   "` не удовлетворяет `require` — тест в Task 6 `whitespace does not satisfy required`.
4. **Архивирование связанной записи.** Итог родителя пересчитывается без неё — тест в Task 11 `archived child drops out of parent rollup`.
5. **Глубокое дерево задач.** Рекурсивный итог по цепочке из 30 уровней доходит до корня, лимит 10 проходов к каскаду не относится — тест в Task 11 `recursive rollup propagates through 30 levels`.

---

## Структура файлов

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts, .gitignore
docker-compose.dev.yml
config/                      стартовый конфиг workspace (Task 15)
packages/core/src/
  expr/ast.ts lexer.ts parser.ts types.ts functions.ts typecheck.ts evaluate.ts refs.ts
  config/schema.ts parse.ts compile.ts errors.ts
  engine/values.ts evaluate-record.ts aggregate.ts cascade-plan.ts
  node.ts                    loadConfigDir (единственный файл с fs; экспорт @icrm/core/node)
  index.ts
packages/db/src/
  schema.ts migrations/001_core.ts db.ts
  repo/records.ts repo/links.ts repo/change-log.ts
  service/record-service.ts service/cascade.ts service/errors.ts
  sync-config.ts query.ts seed.ts index.ts
packages/db/test/setup-pg.ts (globalSetup testcontainers), fixtures/config/*.yaml
apps/server/src/ server.ts routes/meta.ts routes/records.ts routes/query.ts auth.ts main.ts
```

---

### Task 1: Монорепозиторий и разбор выражений

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/expr/ast.ts`, `lexer.ts`, `parser.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/expr/parser.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Pos = { start: number; end: number };
  type BinOp = '+'|'-'|'*'|'/'|'&'|'='|'<>'|'<'|'<='|'>'|'>='|'AND'|'OR';
  type Expr = Pos & (
    | { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'bool'; v: boolean } | { k: 'null' }
    | { k: 'field'; key: string }
    | { k: 'neg'; e: Expr }
    | { k: 'bin'; op: BinOp; l: Expr; r: Expr }
    | { k: 'call'; fn: string; args: Expr[] } );   // fn — канонич. англ. имя в верхнем регистре
  class ExprSyntaxError extends Error { pos: Pos }
  function parse(src: string): Expr;
  ```

- [ ] **Step 1: Каркас репозитория**

`git init`; `corepack enable`; корневой `package.json` (`"private": true`, `"packageManager": "pnpm@9.15.0"`, scripts `test: vitest run`, `typecheck: tsc -b`); `pnpm-workspace.yaml` с `packages/*`, `apps/*`; `tsconfig.base.json` (`strict`, `module: NodeNext`, `target: ES2023`, `noUncheckedIndexedAccess`); `.gitignore` (`node_modules`, `dist`, `.env*`, `!.env.example`). `packages/core` — имя `@icrm/core`, `type: module`, exports `.` и `./node`.

- [ ] **Step 2: Тесты парсера**

```ts
test('precedence', () => {
  expect(parse('1 + 2 * 3')).toMatchObject({ k: 'bin', op: '+', r: { k: 'bin', op: '*' } });
});
test('field refs and strings', () => {
  expect(parse('{kind} = "montage"')).toMatchObject({ k: 'bin', op: '=', l: { k: 'field', key: 'kind' }, r: { k: 'str', v: 'montage' } });
});
test('infix AND binds weaker than comparison', () => {
  expect(parse('{done} AND HAS_SET("montage")')).toMatchObject({ k: 'bin', op: 'AND', r: { k: 'call', fn: 'HAS_SET' } });
});
test('russian aliases are canonicalized, case-insensitive', () => {
  expect(parse('если({a} > 1; "x"; "y")')).toMatchObject({ k: 'call', fn: 'IF', args: [{}, {}, {}] });
  expect(parse('{a} И {b}')).toMatchObject({ k: 'bin', op: 'AND' });
});
test('function-form AND with many args', () => {
  expect(parse('AND({a}, {b}, {c})')).toMatchObject({ k: 'call', fn: 'AND', args: [{}, {}, {}] });
});
test('TRUE/FALSE/NULL literals; unary minus; & concat', () => {
  expect(parse('-{x}')).toMatchObject({ k: 'neg' });
  expect(parse('{a} & "b"')).toMatchObject({ k: 'bin', op: '&' });
  expect(parse('TRUE')).toMatchObject({ k: 'bool', v: true });
});
test('syntax error carries position', () => {
  expect(() => parse('1 + * 2')).toThrow(ExprSyntaxError);
  try { parse('1 + * 2'); } catch (e) { expect((e as ExprSyntaxError).pos.start).toBe(4); }
});
test('decimal comma is a syntax error with hint', () => {
  expect(() => parse('1,5 + 1')).toThrow(/десятичн/);
});
```

- [ ] **Step 3: Запустить — падает**

Run: `pnpm vitest run packages/core/test/expr/parser.test.ts` → FAIL (`parse` не существует).

- [ ] **Step 4: Реализовать `lexer.ts` и `parser.ts`**

Рукописный лексер + Pratt-парсер. Разделитель аргументов — `,` и `;` (оба). Приоритеты (слабее → сильнее): `OR` < `AND` < сравнения < `&` < `+ -` < `* /` < унарный `-`. Синонимы: `ЕСЛИ→IF, И→AND, ИЛИ→OR, НЕ→NOT, ПУСТО→IS_EMPTY, ЕСТЬ_НАБОР→HAS_SET, СЕГОДНЯ→TODAY, ДНЕЙ_МЕЖДУ→DAYS_BETWEEN, ИСТИНА→TRUE, ЛОЖЬ→FALSE`; имена функций регистронезависимы. `NOT(x)` — обычный вызов. Число вида `1,5` (цифра-запятая-цифра без пробела) → `ExprSyntaxError("используйте точку как десятичный разделитель")`.

- [ ] **Step 5: Запустить — проходит**

Run: та же команда → PASS.

- [ ] **Step 6: Commit**

`git add -A && git commit -m "feat(core): monorepo scaffold and expression parser"`

---

### Task 2: Типизация выражений и реестр функций

**Files:**
- Create: `packages/core/src/expr/types.ts`, `functions.ts`, `typecheck.ts`, `refs.ts`
- Test: `packages/core/test/expr/typecheck.test.ts`

**Interfaces:**
- Consumes: `Expr`, `parse` (Task 1)
- Produces:
  ```ts
  type ScalarType = 'number'|'text'|'bool'|'date'|'datetime'|'money';
  type ExprType = ScalarType | 'null' | { list: ScalarType };
  interface TypeEnv { fieldType(key: string): ExprType | undefined; hasSet(key: string): boolean }
  class ExprTypeError extends Error { pos: Pos }
  function typecheck(e: Expr, env: TypeEnv): ExprType;
  function fieldRefs(e: Expr): Set<string>;
  function setRefs(e: Expr): Set<string>;      // строковые литералы в HAS_SET
  function usesClock(e: Expr): boolean;        // TODAY / NOW
  interface FnSpec { name: string; check(args: ExprType[], pos: Pos): ExprType; impl(args: Value[], ctx: EvalCtx): Value }
  const FUNCTIONS: Map<string, FnSpec>;        // impl заполняется в Task 3
  ```

- [ ] **Step 1: Тесты**

```ts
const env = mkEnv({ hours: 'number', rate: 'number', due_date: 'date', done: 'bool', kind: 'text', cost: 'money', tags: { list: 'text' } }, ['montage']);
test('arithmetic', () => expect(typecheck(parse('{hours} * {rate}'), env)).toBe('number'));
test('money * number = money', () => expect(typecheck(parse('{cost} * 2'), env)).toBe('money'));
test('money + number is error', () => expect(() => typecheck(parse('{cost} + 1'), env)).toThrow(ExprTypeError));
test('IF branches unify; null unifies with anything', () => {
  expect(typecheck(parse('IF({done}, "a", "b")'), env)).toBe('text');
  expect(typecheck(parse('IF({done}, {hours}, NULL)'), env)).toBe('number');
  expect(() => typecheck(parse('IF({done}, 1, "b")'), env)).toThrow(/ветк/);
});
test('comparison yields bool; date vs text is error', () => {
  expect(typecheck(parse('{due_date} < TODAY()'), env)).toBe('bool');
  expect(() => typecheck(parse('{due_date} < "x"'), env)).toThrow(ExprTypeError);
});
test('unknown field and unknown set are errors with position', () => {
  expect(() => typecheck(parse('{nope} + 1'), env)).toThrow(/nope/);
  expect(() => typecheck(parse('HAS_SET("ghost")'), env)).toThrow(/ghost/);
});
test('HAS_SET needs string literal', () => expect(() => typecheck(parse('HAS_SET({kind})'), env)).toThrow());
test('CONTAINS on list and text', () => {
  expect(typecheck(parse('CONTAINS({tags}, "vip")'), env)).toBe('bool');
  expect(typecheck(parse('CONTAINS({kind}, "mon")'), env)).toBe('bool');
});
test('refs', () => {
  const e = parse('IF(HAS_SET("montage"), {hours} * {rate}, DAYS_BETWEEN({due_date}, TODAY()))');
  expect([...fieldRefs(e)].sort()).toEqual(['due_date', 'hours', 'rate']);
  expect([...setRefs(e)]).toEqual(['montage']);
  expect(usesClock(e)).toBe(true);
});
```

- [ ] **Step 2: Запустить — падает.** Run: `pnpm vitest run packages/core/test/expr/typecheck.test.ts`

- [ ] **Step 3: Реализовать**

Сигнатуры функций (типы аргументов → результат):
`IF(bool,T,T)→T`; `AND/OR(bool…)→bool`; `NOT(bool)→bool`; `IS_EMPTY(any)→bool`; `HAS_SET(str-literal)→bool`; `IN(T, T…)→bool`; `CONTAINS(text,text)|(list<T>,T)→bool`; `TODAY()→date`; `NOW()→datetime`; `DAYS_BETWEEN(date|datetime, date|datetime)→number`; `ADD_DAYS(date,number)→date`; `ROUND(number[,number])→number`; `MIN/MAX(number|money|date…)→тот же`; `LEN(text|list)→number`; `CONCAT(any…)→text`; `COALESCE(T…)→T`; `DATE(str-literal)→date`.
Операторы: `+ -` для number/number, money/money; `- ` date−date запрещён (только `DAYS_BETWEEN`); `* /` number×number, money×number, money/number; `&` любые → text; `= <>` одинаковые типы; `< <= > >=` для number, money, date, datetime, text.

- [ ] **Step 4: Запустить — проходит.**

- [ ] **Step 5: Commit** — `feat(core): expression typechecker and function registry`

---

### Task 3: Вычисление выражений

**Files:**
- Create: `packages/core/src/expr/evaluate.ts`; modify `functions.ts` (impl)
- Test: `packages/core/test/expr/evaluate.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2
- Produces:
  ```ts
  type Money = { amount: string; currency: string };
  type Value = null | number | string | boolean | Money | Value[];
  interface EvalCtx { get(key: string): Value; hasSet(key: string): boolean; now: Date; timezone: string }
  function evaluate(e: Expr, ctx: EvalCtx): Value;   // никогда не бросает на данных: ошибка → null
  function isEmpty(v: Value): boolean;               // null, '', только пробелы, []
  function todayIn(now: Date, timezone: string): string;  // 'YYYY-MM-DD'
  ```

- [ ] **Step 1: Тесты**

```ts
const ctx = (data: Record<string, Value>, sets: string[] = [], now = new Date('2026-10-30T10:00:00Z')) =>
  ({ get: (k: string) => data[k] ?? null, hasSet: (s: string) => sets.includes(s), now, timezone: 'Europe/Warsaw' });
test('null propagates through arithmetic; comparison with null is FALSE', () => {
  expect(evaluate(parse('{a} + 1'), ctx({}))).toBeNull();
  expect(evaluate(parse('{a} > 1'), ctx({}))).toBe(false);
  expect(evaluate(parse('{a} = NULL'), ctx({}))).toBe(false);
});
test('IS_EMPTY treats whitespace and [] as empty', () => {
  expect(evaluate(parse('IS_EMPTY({a})'), ctx({ a: '  ' }))).toBe(true);
  expect(evaluate(parse('IS_EMPTY({a})'), ctx({ a: [] }))).toBe(true);
  expect(evaluate(parse('IS_EMPTY({a})'), ctx({ a: 0 }))).toBe(false);
});
test('money arithmetic is exact', () => {
  expect(evaluate(parse('{a} + {b}'), ctx({ a: { amount: '0.1', currency: 'PLN' }, b: { amount: '0.2', currency: 'PLN' } })))
    .toEqual({ amount: '0.3', currency: 'PLN' });
});
test('currency mismatch and division by zero give null', () => {
  expect(evaluate(parse('{a} + {b}'), ctx({ a: { amount: '1', currency: 'PLN' }, b: { amount: '1', currency: 'EUR' } }))).toBeNull();
  expect(evaluate(parse('1 / 0'), ctx({}))).toBeNull();
});
test('TODAY uses workspace timezone', () => {
  expect(evaluate(parse('TODAY()'), ctx({}, [], new Date('2026-10-30T23:30:00Z')))).toBe('2026-10-31');
});
test('DAYS_BETWEEN and ADD_DAYS', () => {
  expect(evaluate(parse('DAYS_BETWEEN(DATE("2026-10-01"), DATE("2026-10-30"))'), ctx({}))).toBe(29);
  expect(evaluate(parse('ADD_DAYS(DATE("2026-12-31"), 1)'), ctx({}))).toBe('2027-01-01');
});
test('AND/OR treat null as false; IF null condition takes else', () => {
  expect(evaluate(parse('{x} OR TRUE'), ctx({}))).toBe(true);
  expect(evaluate(parse('IF({x}, 1, 2)'), ctx({}))).toBe(2);
});
test('concat treats empty as ""', () => expect(evaluate(parse('{a} & "-" & {b}'), ctx({ a: 'x' }))).toBe('x-'));
test('HAS_SET, IN, CONTAINS', () => {
  expect(evaluate(parse('HAS_SET("montage")'), ctx({}, ['montage']))).toBe(true);
  expect(evaluate(parse('IN({k}, "a", "b")'), ctx({ k: 'b' }))).toBe(true);
  expect(evaluate(parse('CONTAINS({t}, "vip")'), ctx({ t: ['vip', 'x'] }))).toBe(true);
});
```

- [ ] **Step 2: Запустить — падает.**
- [ ] **Step 3: Реализовать `evaluate` и `impl` функций.** Даты — строки ISO, сравнение строк; `todayIn` через `Intl.DateTimeFormat('en-CA', { timeZone })`; money — `decimal.js`, результат `toString()` без экспоненты (`toFixed()`).
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat(core): expression evaluator with null and money semantics`

---

### Task 4: Схема и разбор YAML-конфига

**Files:**
- Create: `packages/core/src/config/schema.ts`, `parse.ts`, `errors.ts`, `packages/core/src/node.ts`
- Test: `packages/core/test/config/parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type FieldType = 'text'|'number'|'money'|'date'|'datetime'|'bool'|'enum'|'user'|'file'|'link'|'formula'|'rollup';
  type Agg = 'sum'|'count'|'min'|'max'|'avg'|'all'|'any'|'list'|'first';
  interface SourceRef { file: string; path: string; line?: number }   // path вида 'fields.work_cost.expr'
  interface FieldDef { key: string; label: string; type: FieldType; multiple?: boolean; options?: string[];
    precision?: number; multiline?: boolean; indexed?: boolean; was?: string;
    target_sets?: string[]; cardinality?: 'one'|'many'; inverse_label?: string; hierarchical?: boolean;
    expr?: string; via?: string; direction?: 'forward'|'inverse'; field?: string; agg?: Agg; filter?: string;
    src: SourceRef }
  interface SetDef { key: string; label: string; system: boolean; fields: string[]; requires: string[];
    activation: 'manual'|'rule'|'both'; src: SourceRef }
  interface RuleDef { id: string; when: string; enable_set?: string; show?: string[]; hide?: string[];
    require?: string[]; readonly?: string[]; options?: Record<string, string[]>; default?: Record<string, string>;
    validate?: string; message?: string; src: SourceRef }
  interface RawConfig { timezone: string; fields: FieldDef[]; sets: SetDef[]; rules: RuleDef[] }
  interface ConfigIssue { file: string; path: string; line?: number; message: string }
  class ConfigError extends Error { issues: ConfigIssue[] }
  function parseConfigFiles(files: { name: string; content: string }[]): RawConfig;  // бросает ConfigError
  // @icrm/core/node:
  function loadConfigDir(dir: string): Promise<CompiledConfig>;  // читает *.yaml по алфавиту → parse → compile (Task 5)
  ```
  Формат файла: верхние ключи `workspace: {timezone}`, `fields: {<key>: {...}}`, `sets: {<key>: {...}}`, `rules: [...]`; любой файл может содержать любые из них. Значения по умолчанию: `timezone: Europe/Warsaw`, `system: false`, `requires: []`, `activation: manual`, `cardinality: many`, `direction: forward`.

- [ ] **Step 1: Тесты**

```ts
test('merges several files', () => {
  const raw = parseConfigFiles([{ name: 'a.yaml', content: 'fields:\n  hours: {type: number, label: Часы}' },
                                { name: 'b.yaml', content: 'sets:\n  task: {label: Задача, fields: [hours]}' }]);
  expect(raw.fields[0]).toMatchObject({ key: 'hours', type: 'number' });
  expect(raw.sets[0]).toMatchObject({ key: 'task', activation: 'manual', requires: [] });
  expect(raw.timezone).toBe('Europe/Warsaw');
});
test('duplicate field key across files is an issue naming both files', () => {
  expect(() => parseConfigFiles([{ name: 'a.yaml', content: 'fields:\n  x: {type: text, label: X}' },
                                 { name: 'b.yaml', content: 'fields:\n  x: {type: text, label: X}' }]))
    .toThrow(expect.objectContaining({ issues: [expect.objectContaining({ file: 'b.yaml', path: 'fields.x' })] }));
});
test('schema violation reports file, path and line', () => {
  try { parseConfigFiles([{ name: 'a.yaml', content: 'fields:\n  x:\n    type: nope\n    label: X' }]); }
  catch (e) { expect((e as ConfigError).issues[0]).toMatchObject({ file: 'a.yaml', path: 'fields.x.type', line: 3 }); }
});
test('invalid key format and reserved title', () => {
  expect(() => parseConfigFiles([{ name: 'a.yaml', content: 'fields:\n  Сумма: {type: number, label: S}' }])).toThrow(/snake_case/);
  expect(() => parseConfigFiles([{ name: 'a.yaml', content: 'fields:\n  title: {type: text, label: T}' }])).toThrow(/title/);
});
test('YAML syntax error is a ConfigError', () => {
  expect(() => parseConfigFiles([{ name: 'a.yaml', content: 'fields: [' }])).toThrow(ConfigError);
});
```

- [ ] **Step 2: Запустить — падает.**
- [ ] **Step 3: Реализовать.** `yaml.parseDocument` + `LineCounter` для строк; zod-схемы по типу поля (`discriminatedUnion('type')`: `link` требует `target_sets`; `formula` — `expr`; `rollup` — `via`, `agg`, `field` (кроме `count`)); путь issue — из `zod` path. `loadConfigDir` в `node.ts` — единственное место с `fs`.
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat(core): YAML config parsing with positioned issues`

---

### Task 5: Компиляция конфига и граф зависимостей

**Files:**
- Create: `packages/core/src/config/compile.ts`
- Test: `packages/core/test/config/compile.test.ts`, fixtures `packages/core/test/fixtures/*.yaml`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces:
  ```ts
  interface CompiledField extends FieldDef { valueType: ExprType | 'link'; ast?: Expr; filterAst?: Expr;
    deps: Set<string>; clock: boolean; signature?: string }
  interface CompiledSet extends SetDef { closure: string[] }                  // сам набор + requires транзитивно
  interface CompiledRule extends RuleDef { whenAst: Expr; validateAst?: Expr; defaultAsts: Record<string, Expr> }
  interface CompiledRollup { key: string; via: string; direction: 'forward'|'inverse'; field?: string;
    agg: Agg; filterAst?: Expr; sourceKeys: Set<string> }  // sourceKeys = field + fieldRefs(filter)
  interface CompiledConfig {
    timezone: string;
    fields: Map<string, CompiledField>;          // включая встроенное title
    sets: Map<string, CompiledSet>;
    rules: CompiledRule[];
    formulaOrder: string[];                      // топологический порядок formula-полей
    rollups: CompiledRollup[];
    setsOfField: Map<string, Set<string>>;
    showTargets: Set<string>;                    // поля, упомянутые в каком-либо show
  }
  function compileConfig(raw: RawConfig): CompiledConfig;   // бросает ConfigError со всеми issues сразу
  ```

- [ ] **Step 1: Тесты**

```ts
test('formula type inferred and deps collected', () => {
  const c = compile(`fields: {hours: {type: number, label: H}, rate: {type: number, label: R},
    cost: {type: formula, label: C, expr: '{hours} * {rate}'}}`);
  expect(c.fields.get('cost')).toMatchObject({ valueType: 'number', deps: new Set(['hours', 'rate']) });
  expect(c.formulaOrder).toEqual(['cost']);
});
test('formula cycle is an issue listing the cycle', () => {
  expect(() => compile(`fields: {a: {type: formula, label: A, expr: '{b}+1'}, b: {type: formula, label: B, expr: '{a}+1'}}`))
    .toThrow(/a → b → a/);
});
test('rollup over hierarchical link may reference itself', () => {
  const c = compile(hierTaskYaml);   // parent_task: hierarchical; total = own + rollup(children.total)
  expect(c.rollups.find(r => r.key === 'children_total')).toMatchObject({ via: 'parent_task', direction: 'inverse' });
});
test('same self-reference over non-hierarchical link is an issue', () => {
  expect(() => compile(nonHierSelfRollupYaml)).toThrow(/цикл/);
});
test('rollup type by agg', () => {
  const c = compile(rollupTypesYaml);
  expect(c.fields.get('sum_cost')!.valueType).toBe('money');
  expect(c.fields.get('n')!.valueType).toBe('number');
  expect(c.fields.get('names')!.valueType).toEqual({ list: 'text' });
  expect(c.fields.get('org_addr')!.valueType).toBe('text');   // first
});
test('unknown references are all reported at once', () => {
  try { compile(`sets: {t: {label: T, fields: [ghost], requires: [nope]}}\nrules: [{id: r, when: '{zzz}', enable_set: t}]`); }
  catch (e) { expect((e as ConfigError).issues.map(i => i.path)).toEqual(
    expect.arrayContaining(['sets.t.fields', 'sets.t.requires', 'rules[0].when'])); }
});
test('rule enabling a manual-only set is an issue', () => {
  expect(() => compile(`fields: {k: {type: text, label: K}}\nsets: {m: {label: M, fields: [k]}}\nrules: [{id: r, when: '{k} = "x"', enable_set: m}]`))
    .toThrow(/activation/);
});
test('requires closure is transitive; requires cycle is an issue', () => {
  expect(compile(chainYaml).sets.get('c')!.closure.sort()).toEqual(['a', 'b', 'c']);
  expect(() => compile(requiresCycleYaml)).toThrow(/requires/);
});
test('signature changes when expr changes, not when label changes', () => {
  const s1 = compile(costYaml('{hours} * {rate}', 'C')).fields.get('cost')!.signature;
  expect(compile(costYaml('{hours} * {rate}', 'Другая')).fields.get('cost')!.signature).toBe(s1);
  expect(compile(costYaml('{hours} * 2', 'C')).fields.get('cost')!.signature).not.toBe(s1);
});
test('rule when must be bool; default type must match field', () => {
  expect(() => compile(nonBoolWhenYaml)).toThrow(/bool/);
  expect(() => compile(badDefaultYaml)).toThrow(/default/);
});
```
(`compile(yaml)` — хелпер: `compileConfig(parseConfigFiles([{name:'t.yaml',content}]))`; именованные YAML-фикстуры лежат в `test/fixtures`.)

- [ ] **Step 2: Запустить — падает.**
- [ ] **Step 3: Реализовать.** Проверки: поля наборов, `requires`, `target_sets`, `via` — существующее поле `link`, `field` rollup'а — существует; поля в эффектах правил существуют; `options` правила ⊆ `options` поля. Граф: вершины — formula/rollup-ключи; ребро `X → dep`. Ребро rollup → свой `field` через `hierarchical`-ссылку не считается циклом. Цикл ищется DFS, в сообщении — путь `a → b → a`. `signature` = `JSON.stringify` определения без `label`/`src`.
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat(core): config compiler with dependency graph`

---

### Task 6: Движок записи (стабилизация)

**Files:**
- Create: `packages/core/src/engine/values.ts`, `evaluate-record.ts`
- Test: `packages/core/test/engine/evaluate-record.test.ts`, `values.test.ts`

**Interfaces:**
- Consumes: `CompiledConfig`, `evaluate`, `isEmpty`
- Produces:
  ```ts
  interface RecordState { data: Record<string, Value>; sets: Map<string, string> }   // set → enabledBy ('manual' | 'rule:<id>'); title лежит в data.title
  interface FieldState { visible: boolean; required: boolean; readonly: boolean; options?: string[] }
  type ErrorCode = 'invalid_value'|'invalid_option'|'required'|'validation'|'readonly'|'oscillation'
    |'set_activation'|'set_required_by'|'unknown_set'|'unknown_field'|'link_target'|'link_cardinality'|'link_cycle'
    |'version_conflict'|'not_found'|'archived';
  interface RecordError { field?: string; rule_id?: string; code: ErrorCode; message: string }
  interface EvalResult { state: RecordState; fieldStates: Map<string, FieldState>; activeRules: string[];
    changedKeys: Set<string>; errors: RecordError[] }
  function validateValue(f: CompiledField, v: Value): string | null;   // null = ок; формат, options поля
  function evaluateRecord(cfg: CompiledConfig, prev: RecordState | null, next: RecordState,
    opts: { now: Date; userChangedKeys: Set<string> }): EvalResult;
  function fieldStatesOf(cfg: CompiledConfig, s: RecordState, now: Date): Map<string, FieldState>;
  ```
  `next` — состояние после применения правки пользователя (значения rollup'ов уже актуальны). `changedKeys` — ключи `data`, отличающиеся от `prev` (для создания — все непустые), включая формулы.

- [ ] **Step 1: Тесты**

```ts
// cfg из фикстуры montage.yaml: task(manual), montage(activation: rule, requires: [task]),
// contact(manual: notes), rules montage_by_kind, act_required_on_done (require act_file, readonly work_cost), dates_order,
// default warranty_months = 12 при montage, show invoice_no при {payment} = "transfer"
test('rule enables set with closure and marks enabledBy', () => {
  const r = run({ kind: 'montage' }, { task: 'manual' });
  expect(r.state.sets.get('montage')).toBe('rule:montage_by_kind');
});
test('rule-enabled set is disabled when condition flips; data kept', () => {
  const r1 = run({ kind: 'montage', address: 'Kraków' }, { task: 'manual' });
  const r2 = runFrom(r1.state, { kind: 'visit' });
  expect(r2.state.sets.has('montage')).toBe(false);
  expect(r2.state.data.address).toBe('Kraków');
});
test('manually enabled set survives false condition', () => {
  expect(run({ kind: 'visit' }, { task: 'manual', montage: 'manual' }).state.sets.get('montage')).toBe('manual');
});
test('default fills only empty field', () => {
  expect(run({ kind: 'montage' }, { task: 'manual' }).state.data.warranty_months).toBe(12);
  expect(run({ kind: 'montage', warranty_months: 24 }, { task: 'manual' }).state.data.warranty_months).toBe(24);
});
test('required on new state', () => {
  expect(run({ kind: 'montage', done: true }, { task: 'manual' }).errors).toContainEqual(
    expect.objectContaining({ code: 'required', field: 'act_file', rule_id: 'act_required_on_done' }));
});
test('whitespace does not satisfy required', () => {
  expect(run({ kind: 'montage', done: true, act_file: '   ' }, { task: 'manual' }).errors.map(e => e.code)).toContain('required');
});
test('readonly judged by previous state', () => {
  const prev = stateOf({ kind: 'montage', done: true, act_file: F, work_cost: 1 });
  const r = evaluateRecord(cfg, prev, withData(prev, { work_cost: 2 }), { now, userChangedKeys: new Set(['work_cost']) });
  expect(r.errors).toContainEqual(expect.objectContaining({ code: 'readonly', field: 'work_cost' }));
  const prevOpen = stateOf({ kind: 'montage', done: false, work_cost: 1 });
  expect(evaluateRecord(cfg, prevOpen, withData(prevOpen, { done: true, act_file: F, work_cost: 2 }),
    { now, userChangedKeys: new Set(['done', 'act_file', 'work_cost']) }).errors).toEqual([]);
});
test('validate message', () => {
  expect(run({ start: '2026-10-30', end: '2026-10-01' }, { task: 'manual' }).errors).toContainEqual(
    expect.objectContaining({ code: 'validation', rule_id: 'dates_order', message: 'Конец раньше начала' }));
});
test('formulas only for fields of enabled sets', () => {
  const r = run({ hours: 2, rate: 10 }, { contact: 'manual' });   // work_cost в наборе montage, не включён
  expect(r.state.data.work_cost).toBeUndefined();
});
test('show-target hidden until rule active', () => {
  expect(run({ payment: 'cash' }, { task: 'manual' }).fieldStates.get('invoice_no')!.visible).toBe(false);
  expect(run({ payment: 'transfer' }, { task: 'manual' }).fieldStates.get('invoice_no')!.visible).toBe(true);
});
test('oscillating rules rejected naming the rules', () => {
  const r = evaluateRecord(oscCfg, null, stateOf({}, { base: 'manual' }), { now, userChangedKeys: new Set() });
  expect(r.errors).toContainEqual(expect.objectContaining({ code: 'oscillation', message: expect.stringMatching(/r_on.*r_off|r_off.*r_on/) }));
});
test('invalid value checked only for user-changed keys', () => {
  const prev = stateOf({ kind: 'removed_option', notes: 'a' });
  expect(evaluateRecord(cfg, prev, withData(prev, { notes: 'b' }), { now, userChangedKeys: new Set(['notes']) }).errors).toEqual([]);
  expect(evaluateRecord(cfg, prev, withData(prev, { kind: 'bogus' }), { now, userChangedKeys: new Set(['kind']) }).errors
    .map(e => e.code)).toContain('invalid_option');
});
```
`values.test.ts`: по одному кейсу «ок/ошибка» на каждый тип из §1.2 (money `"1.5"/"PLN"` ок, `1.5` ошибка; date `"2026-02-30"` ошибка; enum `multiple` ждёт массив; user/file — uuid).

- [ ] **Step 2: Запустить — падает.**
- [ ] **Step 3: Реализовать `evaluateRecord`**

```
loop i = 1..10:
  formulas(formulaOrder ∩ поля включённых наборов) → data
  active = rules where evaluate(whenAst) === true
  desired = ∪ closure(enable_set) of active
  sets: удалить 'rule:*' не из desired (если не нужны closure ручного набора); добавить desired как 'rule:<id>' (ручные не трогать)
  defaults: для active, поле пусто → evaluate(defaultAst)
  если sets и data не изменились за проход → стабильно, break
если не стабильно → error oscillation с rule_id тех правил, чья активность менялась в последних 2 проходах
fieldStates = fieldStatesOf(cfg, state); ошибки: invalid_value/invalid_option (userChangedKeys), readonly (fieldStatesOf(prev) ∩ userChangedKeys), required и validate (по новому состоянию, только видимые поля)
```
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat(core): record evaluation engine with rules fixpoint`

---

### Task 7: Агрегаты и план каскада

**Files:**
- Create: `packages/core/src/engine/aggregate.ts`, `cascade-plan.ts`
- Test: `packages/core/test/engine/aggregate.test.ts`, `cascade-plan.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RelatedRecord { id: string; data: Record<string, Value>; sets: Set<string> }
  function computeRollup(cfg: CompiledConfig, r: CompiledRollup, related: RelatedRecord[], now: Date): Value;
  // какие rollup'ы ДРУГИХ записей надо пересчитать, когда у записи изменились ключи changedKeys
  function rollupsFedBy(cfg: CompiledConfig, changedKeys: Set<string>): CompiledRollup[];
  // какие rollup'ы зависят от поля-ссылки (при изменении связей)
  function rollupsVia(cfg: CompiledConfig, linkField: string): CompiledRollup[];
  ```

- [ ] **Step 1: Тесты**

```ts
test('sum skips nulls; empty set gives 0', () => {
  expect(computeRollup(cfg, sumHours, [rec({ hours: 2 }), rec({ hours: null }), rec({ hours: 3 })], now)).toBe(5);
  expect(computeRollup(cfg, sumHours, [], now)).toBe(0);
});
test('money sum exact, mixed currency gives null', () => {
  expect(computeRollup(cfg, sumCost, [rec({ cost: m('0.1') }), rec({ cost: m('0.2') })], now)).toEqual(m('0.3'));
  expect(computeRollup(cfg, sumCost, [rec({ cost: m('1') }), rec({ cost: m('1', 'EUR') })], now)).toBeNull();
});
test('filter applied to related record', () => {
  expect(computeRollup(cfg, openCount, [rec({ done: true }), rec({ done: false }), rec({})], now)).toBe(2);
});
test('empty-set semantics', () => {
  expect(computeRollup(cfg, allDone, [], now)).toBe(true);
  expect(computeRollup(cfg, anyDone, [], now)).toBe(false);
  expect(computeRollup(cfg, names, [], now)).toEqual([]);
  expect(computeRollup(cfg, firstAddr, [], now)).toBeNull();
});
test('min/max/avg on dates and numbers', () => {
  expect(computeRollup(cfg, maxDoneAt, [rec({ done_at: '2026-10-01T10:00:00Z' }), rec({ done_at: '2026-10-05T10:00:00Z' })], now))
    .toBe('2026-10-05T10:00:00Z');
});
test('rollupsFedBy matches field and filter refs', () => {
  expect(rollupsFedBy(cfg, new Set(['done'])).map(r => r.key)).toEqual(expect.arrayContaining(['open_count', 'all_done']));
  expect(rollupsFedBy(cfg, new Set(['unrelated']))).toEqual([]);
});
```
- [ ] **Step 2: Запустить — падает.** **Step 3: Реализовать.** **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat(core): rollup aggregation and cascade planning`

---

### Task 8: Схема БД, миграции, тестовый Postgres

**Files:**
- Create: `packages/db/package.json` (`@icrm/db`), `src/schema.ts`, `src/migrations/001_core.ts`, `src/db.ts`, `src/seed.ts`, `test/setup-pg.ts`, `vitest.config.ts`
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function createDb(url: string): Kysely<DB>;
  function migrateToLatest(db: Kysely<DB>): Promise<void>;
  function ensureWorkspace(db: Kysely<DB>, name: string): Promise<{ workspaceId: string; systemUserId: string }>;
  // test helper: freshDb(): Promise<{ db: Kysely<DB>; workspaceId: string; userId: string }> — отдельная схема/БД на тест-файл
  ```
  Таблицы ровно по §1.9 плюс `config_state (workspace_id, key, kind /* signature|rename */, value text, status /* ok|recomputing */, updated_at, pk(workspace_id, key, kind))`. Индексы: GIN `records(data jsonb_path_ops)`, `links(from_id, field_key)`, `links(to_id, field_key)`, `record_sets(set_key)`, `records(workspace_id, archived_at)`.

- [ ] **Step 1: Тест**

```ts
test('migrations create core tables and are idempotent', async () => {
  const { db } = await freshDb();
  await migrateToLatest(db);
  const t = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = current_schema()`.execute(db);
  expect(t.rows.map(r => r.table_name)).toEqual(expect.arrayContaining(
    ['workspaces', 'users', 'records', 'record_sets', 'links', 'change_log', 'files', 'config_state']));
});
test('ensureWorkspace is idempotent and seeds system@local', async () => {
  const { db } = await freshDb();
  const a = await ensureWorkspace(db, 'default'); const b = await ensureWorkspace(db, 'default');
  expect(a).toEqual(b);
});
test('links unique per (field, from, to)', async () => { /* второй insert того же триплета → ошибка 23505 */ });
```
- [ ] **Step 2: Запустить — падает** (`pnpm vitest run packages/db/test/migrations.test.ts`; Docker Desktop должен быть запущен).
- [ ] **Step 3: Реализовать.** `globalSetup` поднимает один `PostgreSqlContainer('postgres:16-alpine')`, `freshDb` создаёт новую БД `t_<random>` и мигрирует.
- [ ] **Step 4: Запустить — проходит.**
- [ ] **Step 5: Commit** — `feat(db): core schema, migrations, test postgres`

---

### Task 9: Репозитории записей, наборов, связей, журнала

**Files:**
- Create: `packages/db/src/repo/records.ts`, `repo/links.ts`, `repo/change-log.ts`
- Test: `packages/db/test/repo.test.ts`

**Interfaces:**
- Produces (все функции принимают `tx: Transaction<DB> | Kysely<DB>`):
  ```ts
  interface StoredRecord { id: string; workspaceId: string; title: string; data: Record<string, Value>;
    sets: Map<string, string>; version: number; createdAt: Date; updatedAt: Date; archivedAt: Date | null }
  loadRecords(tx, ids: string[], opts?: { forUpdate?: boolean }): Promise<Map<string, StoredRecord>>; // FOR UPDATE в порядке id
  insertRecord(tx, r: { id; workspaceId; title; data; sets: Map<string,string>; createdBy }): Promise<void>;
  writeRecord(tx, r: StoredRecord, expectedVersion: number): Promise<boolean>;  // false = версия не совпала; version+1
  writeSets(tx, recordId, before: Map<string,string>, after: Map<string,string>): Promise<void>;
  linksFrom(tx, fromId, field): Promise<string[]>;            // по position
  linksTo(tx, toId, field): Promise<string[]>;
  replaceLinks(tx, workspaceId, fromId, field, toIds: string[]): Promise<{ added: string[]; removed: string[] }>;
  ancestorsVia(tx, startId, field): Promise<string[]>;        // рекурсивный CTE вверх по иерархии
  appendChangeLog(tx, entries: ChangeEntry[]): Promise<void>;
  interface ChangeEntry { workspaceId; recordId; userId: string | null; kind: 'value'|'set'|'link'|'archive';
    fieldKey: string | null; old: unknown; new: unknown; source: 'user'|'rule'|'cascade'|'system' }
  ```
- [ ] **Step 1: Тесты** — round-trip записи с наборами; `writeRecord` с неверной версией → `false` и запись не изменилась; `replaceLinks` возвращает diff и сохраняет порядок; `ancestorsVia` на цепочке A←B←C даёт `[B, A]` для C.
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): record, link and change-log repositories`

---

### Task 10: RecordService — создание и изменение записи

**Files:**
- Create: `packages/db/src/service/record-service.ts`, `service/errors.ts`
- Test: `packages/db/test/record-service.test.ts`

**Interfaces:**
- Consumes: `evaluateRecord`, `validateValue`, репозитории (Task 9)
- Produces:
  ```ts
  interface RecordView { id: string; title: string; data: Record<string, Value>; sets: { key: string; enabledBy: string }[];
    links: Record<string, string[]>; version: number; fieldStates: Record<string, FieldState>;
    createdAt: string; updatedAt: string; archivedAt: string | null }
  type SaveResult = { ok: true; record: RecordView } | { ok: false; errors: RecordError[] };
  class RecordService {
    constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date });
    get(id: string): Promise<RecordView | null>;
    create(i: { userId: string; title: string; data?: Record<string, Value>; sets?: string[] }): Promise<SaveResult>;
    update(i: { id: string; userId: string; expectedVersion: number; title?: string;
      data?: Record<string, Value>; enableSets?: string[]; disableSets?: string[] }): Promise<SaveResult>;
  }
  ```
  Порядок `update` в одной транзакции: `loadRecords([id], forUpdate)` → версия (иначе `version_conflict`) → архивная запись → `archived` → применить `title`/`data`/ручные наборы (closure, `set_activation` если набор `activation: rule`, `set_required_by` если выключается набор, требуемый другим включённым) → свежие rollup'ы записи (Task 11 подключит) → `evaluateRecord` → ошибки → откат и `{ok:false}` → `writeRecord`, `writeSets`, `appendChangeLog` (значения — `user`, если ключ в userChangedKeys, иначе `rule`; наборы — `manual`→`user`, `rule:*`→`rule`).

- [ ] **Step 1: Тесты**

```ts
test('create with sets runs rules and logs', async () => {
  const r = await svc.create({ userId, title: 'Камера склад', sets: ['task'], data: { kind: 'montage' } });
  expect(r.ok && r.record.sets).toEqual(expect.arrayContaining([{ key: 'montage', enabledBy: 'rule:montage_by_kind' }]));
  expect(await changeLogKinds(r)).toEqual(expect.arrayContaining(['value', 'set']));
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
});
test('validation failure rolls back everything', async () => {
  const a = await created({ kind: 'montage' });
  const r = await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { done: true, notes: 'z' } });
  expect(r.ok).toBe(false);
  expect((await svc.get(a.id))!.data.notes).toBeUndefined();
});
test('manual enable of rule-only set is rejected', async () => {
  const a = await created();
  expect(await svc.update({ id: a.id, userId, expectedVersion: a.version, enableSets: ['montage'] }))
    .toMatchObject({ ok: false, errors: [{ code: 'set_activation' }] });
});
test('disable required set rejected', async () => { /* task нельзя выключить при включённом montage → set_required_by */ });
test('saves record with stale enum value when other field changes', async () => {
  const a = await created(); await rawSetData(a.id, { kind: 'removed_option' });
  expect((await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { notes: 'ok' } })).ok).toBe(true);
});
test('unknown field key rejected', async () => { /* data: {ghost: 1} → unknown_field */ });
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): RecordService create/update pipeline`

---

### Task 11: Связи, итоги и каскад

**Files:**
- Create: `packages/db/src/service/cascade.ts`; modify `record-service.ts` (методы `setLinks`, `archive`, вызов каскада в `create`/`update`)
- Test: `packages/db/test/cascade.test.ts`

**Interfaces:**
- Consumes: `computeRollup`, `rollupsFedBy`, `rollupsVia`, репозитории
- Produces:
  ```ts
  // RecordService:
  setLinks(i: { id: string; userId: string; field: string; targetIds: string[] }): Promise<SaveResult>;
  // create расширяется: i.links?: Record<string, string[]> — те же проверки, что у setLinks, в той же транзакции
  archive(i: { id: string; userId: string }): Promise<SaveResult>;
  // cascade.ts:
  function refreshOwnRollups(tx, cfg, rec: StoredRecord, now: Date): Promise<void>; // пересчитать rollup'ы записи перед evaluateRecord
  function runCascade(tx, cfg, seeds: { recordId: string; changedKeys: Set<string>; changedLinks: { field: string; otherIds: string[] }[] }[],
    now: Date, workspaceId: string): Promise<RecordError[]>;
  const CASCADE_LIMIT = 10_000;   // записей за один save; превышение → ошибка, откат
  ```
  Каскад волнами: для каждой изменённой записи R — `rollupsFedBy(changedKeys)` даёт rollup'ы; для `direction: inverse` по ссылке L затронуты `linksFrom(R, L)`, для `forward` — `linksTo(R, L)`. Изменение связей добавляет записи по `rollupsVia(field)` с обеих сторон (включая удалённые цели). Записи волны блокируются `FOR UPDATE` в порядке id, у каждой `refreshOwnRollups` → `evaluateRecord` (userChangedKeys пуст) → запись, журнал с `source: 'cascade'`; изменившиеся ключи идут в следующую волну. Ошибка валидации у затронутой записи **не** откатывает сохранение (записи-получатели не виноваты), а только у исходной. Архивные записи в `related` не попадают.
  Проверки `setLinks`: поле — `link` (`unknown_field`), `cardinality: one` и >1 цели → `link_cardinality`, цель без любого из `target_sets` → `link_target`, `hierarchical` и цель ∈ `{id} ∪ потомки` (через `ancestorsVia` от цели) → `link_cycle`.

- [ ] **Step 1: Тесты**

```ts
test('task cost rolls up to conversation', async () => {
  const conv = await mk(['conversation']); const t = await mk(['task'], { hours: 2, rate: 50 });
  await svc.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [conv.id] });
  expect((await svc.get(conv.id))!.data.tasks_cost_total).toBe(100);
});
test('changing child field updates parent in same transaction', async () => { /* update hours → итог 150 */ });
test('relinking moves amount between parents', async () => { /* t из conv1 в conv2: conv1 → 0, conv2 → 100 */ });
test('archived child drops out of parent rollup', async () => {
  await svc.archive({ id: t.id, userId });
  expect((await svc.get(conv.id))!.data.tasks_cost_total).toBe(0);
});
test('recursive rollup propagates through 30 levels', async () => {
  const chain = await mkChain(30);   // parent_task вверх, own_hours = 1 у каждого
  expect((await svc.get(chain[0].id))!.data.total_hours).toBe(30);
  await svc.update({ id: chain[29].id, userId, expectedVersion: chain[29].version, data: { own_hours: 5 } });
  expect((await svc.get(chain[0].id))!.data.total_hours).toBe(34);
});
test('hierarchical cycle rejected', async () => { /* A parent B, затем B parent A → link_cycle */ });
test('cardinality one and target sets enforced', async () => { /* две цели → link_cardinality; цель без conversation → link_target */ });
test('rollup feeds rule on parent', async () => {
  // правило на conversation: '{open_tasks_count} > 0' → enable_set 'has_work' (activation: rule)
  // закрытие последней задачи выключает набор у разговора через каскад
});
test('cascade entries logged with source cascade', async () => { /* change_log по conv: source = 'cascade' */ });
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): links, rollups and transactional cascade`

---

### Task 12: Синхронизация конфига с БД

**Files:**
- Create: `packages/db/src/sync-config.ts`
- Test: `packages/db/test/sync-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SyncReport { renamed: { from: string; to: string }[]; orphanKeys: string[]; recomputed: string[]; indexes: string[] }
  function syncConfig(db: Kysely<DB>, cfg: CompiledConfig, workspaceId: string, now: () => Date): Promise<SyncReport>;
  function recomputeFields(db: Kysely<DB>, cfg: CompiledConfig, workspaceId: string, keys: string[], now: () => Date): Promise<void>;
  function recomputingKeys(db: Kysely<DB>, workspaceId: string): Promise<string[]>;
  ```
  Шаги: (1) для каждого поля с `was`, если `config_state(rename, was→key)` ещё не записан — переименовать ключ в `records.data`, `links.field_key`, `record_sets` не трогать; записать `config_state`. (2) `orphanKeys` = ключи `data` вне `cfg.fields`. (3) для formula/rollup с `signature`, отличной от `config_state` (или новой): статус `recomputing`, затем `recomputeFields` пакетами по 500 записей, у которых включён набор с этим полем (через `RecordService`-движок с `source: 'system'`, каскад включён), затем статус `ok` и новая подпись. (4) `CREATE INDEX IF NOT EXISTS records_f_<key> ON records ((data->>'<key>'))` для `indexed: true`.

- [ ] **Step 1: Тесты**

```ts
test('rename via was moves data once', async () => { /* hours → work_hours; второй вызов ничего не меняет */ });
test('orphan keys reported', async () => { /* в data есть legacy_x → orphanKeys = ['legacy_x'] */ });
test('changed formula recomputed for affected records only', async () => {
  // cost = hours*rate → cost = hours*rate*2; задача с hours=1, rate=10 → 20; контакт без набора task не тронут
});
test('recomputing status visible during recompute and cleared after', async () => { /* recomputingKeys */ });
test('indexed field gets expression index', async () => { /* pg_indexes содержит records_f_due_date */ });
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): config sync — renames, orphans, recompute, indexes`

---

### Task 13: Запросы по фильтру (выражение → SQL)

**Files:**
- Create: `packages/db/src/query.ts`
- Test: `packages/db/test/query.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface QueryInput { filter?: string; sort?: { field: string; dir: 'asc'|'desc' }[]; limit?: number; offset?: number; includeArchived?: boolean }
  interface QueryOutput { items: Pick<RecordView, 'id'|'title'|'data'|'sets'|'version'>[]; total: number }
  class QueryError extends Error { code: 'syntax'|'type'|'unsupported_in_filter'; pos?: Pos }
  function queryRecords(db: Kysely<DB>, cfg: CompiledConfig, workspaceId: string, q: QueryInput, now: Date): Promise<QueryOutput>;
  ```
  `limit` по умолчанию 50, максимум 500. Фильтр: `parse` → `typecheck` (должен быть bool) → SQL. Поддерживается: литералы, поля (number/money-amount → `::numeric`, bool → `::boolean`, text/date/datetime → `->>`, list → `->`), `= <> < <= > >=`, `AND OR NOT`, `IS_EMPTY` (null, пустая/пробельная строка, `[]`), `HAS_SET` (`exists record_sets`), `IN`, `CONTAINS` (text — `ILIKE`, list — `@>`), `TODAY()`/`NOW()` (подставляются значением в часовом поясе workspace). Сравнение с NULL оборачивается `COALESCE(..., false)`, чтобы совпасть с семантикой `evaluate`. Остальное → `unsupported_in_filter`. Сортировка — только по скалярным полям; `title` — по колонке.

- [ ] **Step 1: Тесты**

```ts
const filters = ['{done}', 'NOT({done})', '{hours} > 1', 'IS_EMPTY({notes})', 'HAS_SET("montage")',
  'IN({kind}, "montage", "visit")', 'CONTAINS({title}, "кам")', '{due_date} < TODAY()', '{a} > 1 OR {done}'];
test.each(filters)('SQL result equals in-memory evaluate: %s', async f => {
  const all = await seedVariety();   // 20 записей с пустыми, пробельными, null и заполненными значениями
  const expected = all.filter(r => evaluate(parse(f), ctxOf(r)) === true).map(r => r.id).sort();
  const got = (await queryRecords(db, cfg, ws, { filter: f, limit: 500 }, now)).items.map(i => i.id).sort();
  expect(got).toEqual(expected);
});
test('unsupported function rejected with position', async () => {
  await expect(queryRecords(db, cfg, ws, { filter: 'LEN({title}) > 3' }, now)).rejects.toMatchObject({ code: 'unsupported_in_filter' });
});
test('non-bool filter rejected', async () => { /* '{hours}' → code 'type' */ });
test('archived excluded by default; paging and total', async () => { /* limit 5 offset 5; total = все неархивные */ });
test('sort by number desc puts nulls last', async () => {});
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(db): expression filters compiled to SQL`

---

### Task 14: HTTP API

**Files:**
- Create: `apps/server/package.json` (`@icrm/server`), `src/server.ts`, `src/auth.ts`, `src/routes/meta.ts`, `routes/records.ts`, `routes/query.ts`, `src/main.ts`
- Test: `apps/server/test/api.test.ts` (через `app.inject`, Postgres из testcontainers)

**Interfaces:**
- Consumes: `RecordService`, `queryRecords`, `recomputingKeys`, `syncConfig`, `loadConfigDir`
- Produces:
  ```ts
  function buildServer(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; systemUserId: string;
    apiToken: string; now?: () => Date }): FastifyInstance;
  ```
  Маршруты (все требуют `Authorization: Bearer <apiToken>`, иначе 401):
  | Метод | Путь | Тело / ответ |
  |---|---|---|
  | GET | `/meta` | `{timezone, fields[], sets[], rules[], recomputing: string[]}` — без `src` |
  | POST | `/records` | `{title, data?, sets?, links?}` → 201 `RecordView` |
  | GET | `/records/:id` | `RecordView` / 404 |
  | PATCH | `/records/:id` | `{version, title?, data?, enableSets?, disableSets?}` → 200 |
  | PUT | `/records/:id/links/:field` | `{targetIds}` → 200 |
  | POST | `/records/:id/archive` | → 200 |
  | POST | `/query` | `QueryInput` → `QueryOutput` |
  Ошибки: `{errors: RecordError[]}`; `version_conflict` → 409, `not_found` → 404, прочие `RecordError` → 422, `QueryError` → 400 `{error: {code, message, pos}}`. `main.ts`: env `DATABASE_URL`, `ICRM_API_TOKEN` (обязателен), `ICRM_CONFIG_DIR` (по умолчанию `<repo>/config`), `HOST=127.0.0.1`, `PORT=3100`; при `ConfigError` печатает issues `file:line path — message` и `process.exit(1)`; затем `migrateToLatest`, `ensureWorkspace('default')`, `syncConfig` **без await** (ошибки — в лог), `listen`.

- [ ] **Step 1: Тесты**

```ts
test('401 without token', async () => expect((await app.inject({ method: 'GET', url: '/meta' })).statusCode).toBe(401));
test('meta lists sets and recomputing', async () => {
  const r = await get('/meta'); expect(r.json()).toMatchObject({ timezone: 'Europe/Warsaw', recomputing: [] });
  expect(JSON.stringify(r.json())).not.toContain('"src"');
});
test('create → patch → 409 on stale version', async () => {
  const c = await post('/records', { title: 'T', sets: ['task'] }); expect(c.statusCode).toBe(201);
  const v = c.json().version;
  expect((await patch(`/records/${c.json().id}`, { version: v, data: { notes: 'a' } })).statusCode).toBe(200);
  expect((await patch(`/records/${c.json().id}`, { version: v, data: { notes: 'b' } })).statusCode).toBe(409);
});
test('rule violation → 422 with field errors', async () => { /* done без act_file */ });
test('links and query end-to-end', async () => { /* PUT links; POST /query {filter:'HAS_SET("task")'} */ });
test('bad filter → 400 with position', async () => {});
test('main exits 1 on broken config', async () => { /* spawn main с ICRM_CONFIG_DIR=fixtures/broken → exit code 1, stderr содержит 'b.yaml:' */ });
```
- [ ] **Step 2–4:** падает → реализовать → проходит.
- [ ] **Step 5: Commit** — `feat(server): minimal records API`

---

### Task 15: Стартовый конфиг и локальный запуск

**Files:**
- Create: `config/workspace.yaml`, `config/tasks.yaml`, `docker-compose.dev.yml`, `.env.example`, `README.md`
- Modify: `PLAN.md`, `CONTEXT.md` (Current state)
- Test: `packages/core/test/config/starter-config.test.ts`

**Interfaces:**
- Consumes: `loadConfigDir`
- Стартовый конфиг: `timezone: Europe/Warsaw`; наборы `task` (manual: description, responsible, due_date, done, kind enum [visit, montage, supply, consult], hours, rate, parent_task hierarchical, own_hours, total_hours rollup), `montage` (rule, requires task: address, warranty_months, act_file, work_cost formula); правила `montage_by_kind`, `act_required_on_done`, `warranty_default`. Это пример для разработки — системные наборы `conversation`/`contact` появятся в подпроектах 2–3.
- `docker-compose.dev.yml`: `postgres:16-alpine`, порт `127.0.0.1:54320:5432`, том `pgdata-dev`.

- [ ] **Step 1: Тест** — `expect(await loadConfigDir(repoConfigDir)).toBeTruthy()` и в `sets` есть `task`, `montage`.
- [ ] **Step 2: Запустить — падает** (каталога нет).
- [ ] **Step 3: Создать файлы.** README: `corepack enable`, `pnpm i`, `docker compose -f docker-compose.dev.yml up -d`, `cp .env.example .env`, `pnpm --filter @icrm/server dev`, пример `curl` с токеном.
- [ ] **Step 4: Проверка полного прогона**

Run: `pnpm typecheck && pnpm test` → всё зелёное.
Run: запустить сервер по README, `curl -H "Authorization: Bearer $ICRM_API_TOKEN" http://127.0.0.1:3100/meta` → JSON с `sets` `task`, `montage`.

- [ ] **Step 5: Обновить `PLAN.md`** (подпроект 1 → Done; в Backlog: суточный пересчёт `TODAY()`, FileStorage/загрузка файлов, логин) и `CONTEXT.md` → Current state.
- [ ] **Step 6: Commit** — `chore: starter config, dev compose, docs`
