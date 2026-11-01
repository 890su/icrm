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
`tasks.yaml` (поля, наборы, правила), `finance.yaml` (пример строк: расходы и доходы задачи), `contacts.yaml`
(расширение системных наборов контактов, см. ниже). Это пример для разработки; системный набор
`conversation` появится в подпроекте 3. Ошибки конфига
выводятся с файлом и строкой, сервер при этом не стартует.
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
curl -X POST http://127.0.0.1:3100/records \
  -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Install cameras","sets":["task"],"rows":{
        "expenses":[
          {"sets":["expense"],"data":{"expense_kind":"транспортные","amount":40,"distance_km":120}},
          {"sets":["expense"],"data":{"expense_kind":"комплектующие","amount":200}}],
        "incomes":[{"sets":["income"],"data":{"amount":500}}]}}'
```

Изменение: тот же `rows` в `PATCH /records/:id`. Для каждого поля-владения в пакете можно смешивать три вида
операций: новая строка (без `id`), изменение (`id` и `version` строки) и удаление (`id` и `delete: true`).
Изменённые строки остаются на своих местах, новые добавляются в конец. `version` записи-владельца обязательна:

```sh
curl -X PATCH http://127.0.0.1:3100/records/<id> \
  -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"version":1,"rows":{"expenses":[
        {"id":"<id строки>","version":1,"data":{"amount":55}},
        {"id":"<id другой строки>","delete":true},
        {"sets":["expense"],"data":{"expense_kind":"прочие","amount":15}}]}}'
```

На Windows тело с кириллицей надёжнее отправлять из файла в UTF-8: `curl ... --data-binary @body.json`
(строка в командной строке может уйти не в UTF-8).

Чтение: `GET /records/:id` отдаёт `rows: {expenses: [...], incomes: [...]}` (без вложенных строк)
и итоги владельца; у строки `ownerId` и `ownerField` указывают на владельца (у обычной записи — `null`).
Строки не попадают в `/query` по умолчанию; для отчётов по строкам всех записей передайте
`{"includeRows": true}`, например `{"filter":"HAS_SET(\"expense\")","includeRows":true}`.

Переставить строки: `PUT /records/:id/links/expenses` с телом `{"targetIds":[...]}` в нужном порядке.
**Строки, чьих `id` нет в `targetIds`, архивируются** (как удаление). Удаление строки архивирует её,
архивирование владельца архивирует и его строки. Правило `readonly` на поле-владении (по сохранённому
состоянию владельца) запрещает добавлять, удалять и исключать строки; значения строк подчиняются правилам
самой строки.

Ограничение: правило строки, зависящее от значения владельца (итог по обратной связи, например
`agg: first`), в рамках одного сохранения видит предыдущее значение владельца, а при создании — введённые
значения владельца (его формулы и итоги ещё не посчитаны). Сохранённые значения строки после этого всё равно
пересчитываются каскадом от нового значения владельца.

## Контакты и организации

Подробности — `docs/superpowers/specs/2026-10-31-contacts-organizations-design.md`.

**Системные наборы и `extend`.** Наборы `contact` (человек: `notes`, `needs_review`), `organization`
(фирма или частный клиент: `org_kind`, `nip`, `address`, `email_domains`) и `membership` (участие контакта
в организации: `contact`, `organization`, `role`, `position`, `active_from`, `active_to`, `is_primary`)
поставляются пакетом `core`. Свой YAML не объявляет их заново, а расширяет секцией `extend`: свои поля
в системные наборы и `label`/`options` системных полей (роли — в `config/contacts.yaml`):

```yaml
fields:
  birthday: {type: date, label: День рождения}
extend:
  sets:
    contact: {fields: [birthday]}
  fields:
    role: {options: [ЛПР, бухгалтер, техник, муж, жена, сын, дочь, другое]}
```

Служебные поля (`merged_into`) заполняет только код: запись их через API — `managed_field`. NIP организации
нормализуется до 10 цифр, проверяется (`nip_invalid`) и уникален среди живых записей (`nip_taken`);
у пары «контакт + организация» одно действующее участие (`membership_active_exists`), у контакта одно
основное (`primary_conflict`).

**Адреса.** Email, телефон и Telegram — адреса (identities) контакта, участия («телефон бухгалтера Firma X»)
или организации (общий ящик). Адрес нормализуется (телефон — в E.164, страна по умолчанию —
`workspace.phone_region`, `PL`) и уникален среди живых: второй владелец получает `identity_taken`
с `ownerId`/`ownerTitle`. WhatsApp — не отдельный канал: его адрес — телефон, поиск с `whatsapp` идёт по `phone`.
`GET /records/:id` у контакта, участия и организации отдаёт `identities`, у контакта и организации — `memberships`:

```sh
curl -X POST http://127.0.0.1:3100/records/<id контакта>/identities   -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json"   -d '{"channel":"phone","address":"600 100 200","label":"рабочий"}'
```

Перенести адрес — `POST /identities/:id/move` `{"to":"<id>"}`, архивировать — `DELETE /identities/:id`,
поиск по части адреса — `GET /identities?q=600100`.

**Сопоставление.** По адресу входящего находится, кто пишет и от какой организации: владелец-контакт
(организация — по его единственному или основному действующему участию), участие (контакт и организация
участия, `membershipEnded` для закрытого) или организация. Для незнакомого email `hints` — организации
с доменом адреса в `email_domains`:

```sh
curl "http://127.0.0.1:3100/identities/lookup?channel=whatsapp&address=%2B48600100200"   -H "Authorization: Bearer $ICRM_API_TOKEN"
```

**Уход из организации и передача дел.** `GET /memberships/:id/handover` показывает адреса участия и связи
на него (оборудование, учётки). `POST /memberships/:id/end` закрывает участие датой `date` и одной транзакцией
передаёт их преемнику (`{"membershipId"}` — существующее участие той же организации, `{"contactId"}` —
создать новое), организации, контакту, оставляет (`keep`) или архивирует адреса; по умолчанию всё уходит
преемнику, а без него — организации (связи из полей, не допускающих организацию, остаются). Отказ правила
записи-источника откатывает всё и называет её (`recordId`). Незакреплённое за людьми — `GET
/organizations/:id/unassigned`, закрепить — `POST /memberships/:id/take` `{"identities":[...],"links":[...]}`:

```sh
curl -X POST http://127.0.0.1:3100/memberships/<id>/end   -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json"   -d '{"version":3,"date":"2026-11-30","successor":{"contactId":"<id контакта>"},
       "identities":{"<id адреса>":"contact"},"links":{"<linkId>":"organization"}}'
```

**Слияние дублей.** Контакт сливается с контактом, организация с организацией (иначе `merge_kind_mismatch`;
сама с собой — `merge_self`; архивная — `merge_archived`). `GET /records/:a/merge-preview?into=:b` показывает
конфликты (поля, где у обоих разные непустые значения, и связи «одна» с разными целями) и что переедет:
адреса, участия (и какие схлопнутся с действующим участием `B` в той же организации), связи, строки.
`POST /records/:a/merge` одной транзакцией сначала включает у `B` вручную включённые наборы `A`, которых у `B`
нет (вместе со значениями `A` в полях только этих наборов), затем переносит всё это на `B`, перевешивает связи
других живых записей и пользователей, архивирует `A` с `merged_into = B` и заполняет у `B` пустые поля и
выбранные значения (по умолчанию в конфликте остаётся значение `B`); ответ — запись `B`. Схлопнутое участие `A`
закрывается сегодняшним днём (или днём своего начала, если оно ещё не началось) и архивируется. Слияние необратимо, история —
в журнале изменений:

```sh
curl -X POST http://127.0.0.1:3100/records/<id A>/merge   -H "Authorization: Bearer $ICRM_API_TOKEN" -H "Content-Type: application/json"   -d '{"into":"<id B>","values":{"notes":"source","nip":"target"}}'
```

## Дубли, NIP и импорт

Подробности — `docs/superpowers/specs/2026-10-31-contacts-organizations-design.md`, §7.

**Дубли.** Подсказка, не запрет: сохранение никогда не блокируется. `POST /records` контакта или организации
отвечает записью с `possibleDuplicates` (кандидаты с причинами). Имена сравниваются нормализованными (без регистра,
диакритики и знаков, у организаций — без правовой формы вроде `sp. z o.o.`); у организаций учитываются также общий
домен в `email_domains` и `address`. `GET /records/:id/duplicates` — кандидаты к записи, `GET /duplicates?set=contact|organization&limit=&offset=` —
пары по всей базе, `POST /duplicates/dismiss` `{"a","b"}` — «не дубль» (пара больше не предлагается). Слить найденное —
`POST /records/:id/merge` (см. выше).

```sh
curl "http://127.0.0.1:3100/duplicates?set=organization&limit=20" -H "Authorization: Bearer $ICRM_API_TOKEN"
```

**Заполнение по NIP.** Данные организации берутся из «белого списка» VAT Минфина (`wl-api.mf.gov.pl`, без ключа).
`GET /registry/nip/:nip` показывает данные, ничего не сохраняя (`nip_invalid`, `nip_not_found`);
`POST /records/:id/registry-refresh` записывает их в организацию через обычное сохранение: `title` и `address` —
только если пусты, `regon`, `krs`, `vat_status`, `bank_accounts`, `registry_checked_at` — перезаписываются.
Если реестр недоступен — 502 `registry_unavailable`. У сервиса суточный лимит запросов, поэтому вызывайте только
по действию человека, не массово.

```sh
curl -X POST http://127.0.0.1:3100/records/<id организации>/registry-refresh -H "Authorization: Bearer $ICRM_API_TOKEN"
```

**Импорт контактов.** Принимает vCard (`.vcf`), CSV и XLSX (первый лист); в CSV и XLSX первая строка — заголовки.
Запрос — `multipart/form-data` с файлом `file` и (для CSV/XLSX; для vCard игнорируется) полем `mapping` — JSON
«заголовок колонки → поле»: `contact.title`, `contact.<поле>`, `identity.email|phone|telegram`, `organization.title`,
`organization.nip`, `organization.<поле>`, `membership.role`, `membership.position`, `skip`. `POST /import/preview` —
пробный прогон без записи, `POST /import/commit` — то же с записью, каждая строка в своей транзакции (ошибка
строки не останавливает остальные). Ответ — `{"rows": [...]}`: по строке файла `action` (`create`, `update`, `skip`,
`error`), `reason` (`ambiguous_match`, `empty_row`), `contactId`, организация, участие и `warnings`. Контакт ищется по
адресам строки, организация — по NIP, иначе по названию, поэтому повторный импорт того же файла не создаёт дублей.
Лимиты: файл до 5 МБ и до 5000 строк (иначе 413 `import_too_large`); нет файла, плохой JSON в `mapping` или
неизвестный формат — 400 `bad_request`; неверное сопоставление (нет такой колонки, неизвестное поле) — 422 с `errors`.
Файл не сохраняется.

```sh
curl -X POST http://127.0.0.1:3100/import/preview -H "Authorization: Bearer $ICRM_API_TOKEN"   -F file=@contacts.csv   -F 'mapping={"Имя":"contact.title","Почта":"identity.email","Телефон":"identity.phone","Фирма":"organization.title","NIP":"organization.nip"}'
# если отчёт устраивает — тот же запрос на /import/commit
```

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
| `apps/server` | Fastify API: `/meta`, `/records`, `/query`, адреса, участия, слияние |
| `config/` | YAML-конфиг |
