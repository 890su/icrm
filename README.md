# iCRM

CRM, в центре которой не задача, а **Разговор**; любая сущность — универсальная запись с наборами полей.
Состояние: подпроект 1 «Ядро записей» (`packages/core`, `packages/db`, `apps/server`). Архитектура:
`docs/superpowers/specs/2026-10-30-icrm-architecture-design.md`.

## Требования

Node 24, Docker (Docker Desktop на Windows), pnpm 9 через corepack.

## Локальный запуск

```sh
corepack enable
pnpm i
docker compose -f docker-compose.dev.yml up -d   # Postgres 16 на 127.0.0.1:54320
cp .env.example .env                             # затем замените ICRM_API_TOKEN своим токеном
pnpm --filter @icrm/server dev                   # http://127.0.0.1:3100
```

Токен — любая строка от 16 символов. Плейсхолдер `CHANGE_ME` из `.env.example` намеренно короче:
пока его не заменить, сервер не стартует. Сгенерировать токен:

```sh
node -e "console.log(crypto.randomUUID())"
```

`.env` в git не попадает. `pnpm --filter @icrm/server dev` сам читает `.env` из корня репозитория и берёт
конфиг из `config/`. При старте применяются миграции, создаётся рабочее пространство `default`
и конфиг синхронизируется с БД.

Проверка: сервер читает `.env` сам, а для `curl` токен нужен в переменной окружения текущей оболочки:

```sh
export ICRM_API_TOKEN=...   # то же значение, что в .env
curl -H "Authorization: Bearer $ICRM_API_TOKEN" http://127.0.0.1:3100/meta
```

Создание записи — задача с видом работ «монтаж» (набор `montage` включится правилом):

```sh
curl -X POST http://127.0.0.1:3100/records \
  -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Install cameras","sets":["task"],"data":{"kind":"montage","hours":3,"rate":100}}'
```

Остановка: `Ctrl+C`, затем `docker compose -f docker-compose.dev.yml down` (данные остаются в томе
`pgdata-dev`; `down -v` удалит и их).

`POSTGRES_INITDB_ARGS` (кодировка и локаль) применяются только при создании нового тома. Чтобы применить
их к уже созданной базе, пересоздайте том — данные разработки при этом пропадут:
`docker compose -f docker-compose.dev.yml down -v`, затем снова `up -d`.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `DATABASE_URL` | — (обязательна) | строка подключения к Postgres |
| `ICRM_API_TOKEN` | — (обязательна) | статический токен API, от 16 символов |
| `ICRM_CONFIG_DIR` | `<репозиторий>/config` | каталог с YAML-конфигом |
| `HOST` / `PORT` | `127.0.0.1` / `3100` | адрес сервера |

Пустое значение считается незаданным. **`ICRM_CONFIG_DIR` обязателен при любом запуске, кроме
`pnpm --filter @icrm/server dev`** (например, из собранного `dist`): умолчание считается от расположения
исходника. Относительный путь считается от текущего каталога процесса, надёжнее абсолютный.
Из корня репозитория: `ICRM_CONFIG_DIR=./config`.

## Конфиг

`config/*.yaml` читаются по алфавиту и собираются в один конфиг: `workspace.yaml` (часовой пояс),
`tasks.yaml` (поля, наборы, правила), `finance.yaml` (пример строк: расходы и доходы задачи). Это пример для разработки; системные наборы `conversation` и
`contact` появятся в подпроектах 2–3. Ошибки конфига выводятся с файлом и строкой, сервер при этом не стартует.
После изменения конфига перезапустите сервер: он пересчитает затронутые формулы и итоги.

## Строки (аналитики)

Строка — обычная запись со своими наборами, которая принадлежит записи-владельцу через поле-ссылку
с `owned: true` (как аналитики в Планфиксе: расходы, доходы, позиции сметы). Пример — `config/finance.yaml`:
у задачи поля `expenses` и `incomes`, итоги `expenses_total`, `incomes_total`, `transport_total`
(с `filter` по виду расхода) и `margin = incomes_total - expenses_total`. Строки сохраняются вместе
с владельцем одной транзакцией и одним каскадом пересчёта; ошибка любой строки откатывает весь пакет.

Создание: пакет `rows` в `POST /records` (строка — `{title?, data?, sets?}`). Вид расхода «транспортные»
сам включает набор `expense_transport` (`route`, `distance_km`):

```sh
curl -X POST http://127.0.0.1:3100/records   -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json"   -d '{"title":"Install cameras","sets":["task"],"rows":{
        "expenses":[
          {"sets":["expense"],"data":{"expense_kind":"транспортные","amount":40,"distance_km":120}},
          {"sets":["expense"],"data":{"expense_kind":"комплектующие","amount":200}}],
        "incomes":[{"sets":["income"],"data":{"amount":500}}]}}'
```

Изменение: тот же `rows` в `PATCH /records/:id`. Для каждого поля-владения в пакете можно смешивать три вида
операций: новая строка (без `id`), изменение (`id` и `version` строки) и удаление (`id` и `delete: true`).
Изменённые строки остаются на своих местах, новые добавляются в конец. `version` записи-владельца обязательна:

```sh
curl -X PATCH http://127.0.0.1:3100/records/<id>   -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json"   -d '{"version":1,"rows":{"expenses":[
        {"id":"<id строки>","version":1,"data":{"amount":55}},
        {"id":"<id другой строки>","delete":true},
        {"sets":["expense"],"data":{"expense_kind":"прочие","amount":15}}]}}'
```

Чтение: `GET /records/:id` отдаёт `rows: {expenses: [...], incomes: [...]}` (без вложенных строк) и итоги
владельца. Строки не попадают в `/query` по умолчанию; для отчётов по строкам всех записей передайте
`{"includeRows": true}` (например, `{"filter":"HAS_SET(\"expense\")","includeRows":true}`).
Переставить строки: `PUT /records/:id/links/expenses` с телом `{"targetIds":[...]}` в нужном порядке.
Удаление строки архивирует её, архивирование владельца архивирует и его строки.

## Проверки

```sh
pnpm typecheck
pnpm test        # интеграционные тесты db/server поднимают Postgres через Docker (testcontainers)
```

## Структура

| Путь | Что |
|---|---|
| `packages/core` | чистая доменная логика: конфиг, выражения, движок записи |
| `packages/db` | схема и миграции Postgres, сохранение записи, каскад итогов, синхронизация конфига |
| `apps/server` | Fastify API: `/meta`, `/records`, `/query` |
| `config/` | YAML-конфиг |
