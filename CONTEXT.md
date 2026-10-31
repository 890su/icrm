---
project_id: icrm
project_type: umbrella
status: active
domain:
aliases: [icrm, ай-црм, своя crm, crm разговоров]
stack: [typescript, node, fastify, postgres, pg-boss, react, vite, docker]
updated: 2026-10-31
---

# iCRM

## What and why

Собственная CRM, работающая как Планфикс, но с другим центральным объектом:
не задача, а **Разговор** — тема общения с человеком (и через него с
контрагентом), которая ведётся через любые каналы (email, Telegram, WhatsApp,
звонки). Из разговора рождаются задачи и подразговоры; проект — это разговор
с набором «Проект».

Архитектурная основа — **универсальная запись**: любая сущность — это запись
с набором включённых наборов полей (задача, разговор, контакт, организация,
оборудование...). Поля, правила активации наборов, вычисляемые и итоговые поля
задаются YAML-конфигом.

Сначала — внутренний инструмент для JDG (IT-услуги), архитектура заложена под
будущий SaaS (workspace_id везде).

## Stack

TypeScript monorepo (pnpm workspaces): `packages/core` (чистая доменная логика,
общая для сервера и браузера), `packages/db` (Postgres: схема, сохранение записи,
каскад итогов), `apps/server` (Fastify), `config/` (YAML). Запланированы:
`worker` (каналы, фоновые задачи на pg-boss) и `web` (React + Vite) — пока не созданы.

## Current state

Подпроекты 1 «Ядро записей» и 1b «Строки записи (аналитики)» реализованы и слиты в `main`:
`packages/core`, `packages/db`, `apps/server` (минимальный API `/meta`, `/records`, `/query`);
владеемые связи (`owned: true`), пакет `rows`, `includeRows`; стартовый конфиг в `config/`.
Подпроект 2a «Контакты и организации: основа» реализован (ветка `feat/contacts-core`):
системные наборы `contact`/`organization`/`membership` встроены в `@icrm/core` (расширяются
секцией `extend`), адреса каналов, сопоставление, передача дел, слияние дублей
(спецификация `docs/superpowers/specs/2026-10-31-contacts-organizations-design.md`).
Запуск и переменные окружения — `README.md`. Дальше: подпроект 2b (дубли, NIP, импорт),
затем 3 «Разговоры».
Архитектурная спецификация: `docs/superpowers/specs/2026-10-30-icrm-architecture-design.md`.

## Sub-projects

| Module | Responsibility | Exports |
|--------|----------------|---------|
| 1. Ядро записей | записи, наборы, поля, правила, формулы, итоги, связи, YAML-конфиг | пакет `core`, схема БД записей |
| 2. Контакты и организации | участие, канальные идентификаторы, сопоставление | системные наборы |
| 3. Разговоры | лента, участники, адресаты, «Ход», жизненный цикл | системный набор Разговор |
| 4. Каналы | Email, Telegram, WhatsApp адаптеры | `worker` |
| 5. Задачи и планировщик | задачи, автоматизации | системный набор Задача |
| 6. Отчёты и документы | фильтры, отчёты, шаблоны документов | — |
| 7. Веб-интерфейс | UI, параллельно с 3+ | `web` |

## Deployment

domain: (TBD, например icrm.sekond.pl)
deploy_target_id:
server: srv-150
server_path:
source_path: D:\aibrain\04_projects\icrm
deploy: Docker Compose, порты на 127.0.0.1, Cloudflare Tunnel
health_check:
secrets_ref:

## Navigation

| Need | Open |
|---|---|
| Current tasks | `PLAN.md` |
| Direction | `ROADMAP.md` |
| Decisions and reasons | `decisions.md` |
| Architecture spec | `docs/superpowers/specs/` |

## Agent Rules

- Read `CONTEXT.md` and `PLAN.md` before starting.
- Spec is the source of truth for domain model; change spec first, then code.
- Update `PLAN.md` after completed work; durable decisions → `decisions.md`.
- Do not edit `ROADMAP.md` unless explicitly asked.

## Do not

- Do not store secrets in project files; use `secrets_ref`.
- Do not hard-code entity types as separate tables — everything is a record
  with field sets (see spec).
- Do not read `.library/`, `node_modules/`, `dist/`, `.git/`.
