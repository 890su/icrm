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
cp .env.example .env                             # затем впишите свой ICRM_API_TOKEN
pnpm --filter @icrm/server dev                   # http://127.0.0.1:3100
```

Токен — любая строка от 16 символов; сгенерировать:

```sh
node -e "console.log(crypto.randomUUID())"
```

`.env` в git не попадает. `pnpm --filter @icrm/server dev` сам читает `.env` из корня репозитория и берёт
конфиг из `config/`. При старте применяются миграции, создаётся рабочее пространство `default`
и конфиг синхронизируется с БД.

Проверка (токен — значение `ICRM_API_TOKEN` из `.env`):

```sh
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
`tasks.yaml` (поля, наборы, правила). Это пример для разработки; системные наборы `conversation` и
`contact` появятся в подпроектах 2–3. Ошибки конфига выводятся с файлом и строкой, сервер при этом не стартует.
После изменения конфига перезапустите сервер: он пересчитает затронутые формулы и итоги.

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
