# Unified Messaging Gateway (UMG)

Внутрішній єдиний шлюз для SMS, WhatsApp та Signal. NestJS + React, розгорнутий через Docker Compose. Milestone 0 (скелет: авторизація, канали, повідомлення) та Milestone 1 (маршрутизація, вебхуки, вкладення, алерти) виконані.

## Швидкий старт

```bash
cp .env.example .env          # задай сильні секрети
sed -i 's/change-me-.*//' .env # <-- обов'язково заміни значення

docker compose up -d
```

Інтерфейс доступний на порту `8083`.

## Авторизація

- Адмін-веб: логін `admin`, пароль у `.env` (`ADMIN_BOOTSTRAP_PASSWORD`).
- API: створіть Bearer token через UI або `POST /api/v1/api-tokens` у сесії адміна.

## Основні компоненти

| Сервіс | Призначення |
|---|---|
| `reverse-proxy` | nginx на 8083 |
| `umg-web` | React 18 + Vite + Tailwind |
| `umg-api` | NestJS 10 API |
| `umg-worker` | BullMQ worker для відправки |
| `postgres` | PostgreSQL 17 + Prisma |
| `redis` | Redis 8 + BullMQ + сесії |

## Керування каналами

Веб-інтерфейс для створення транспортних акаунтів та endpoint доступний за адресою `/channels` після входу:

- Створення акаунта: тип (`mock`, `sms`, `whatsapp`, `signal`), адаптер, назва, статус.
- Додавання endpoint до акаунта: назва, ID лінії/номер, телефон.
- Увімкнення/вимкнення акаунта чи endpoint, видалення.

Еквівалентні операції доступні через API:

- `GET /api/v1/transport-accounts`
- `POST /api/v1/transport-accounts`
- `PATCH /api/v1/transport-accounts/:id`
- `DELETE /api/v1/transport-accounts/:id`
- `POST /api/v1/transport-accounts/:id/endpoints`
- `PATCH /api/v1/endpoints/:id`
- `DELETE /api/v1/endpoints/:id`

## Smoke test

```bash
cd /srv/umg
export ADMIN_BOOTSTRAP_PASSWORD=$(grep ADMIN_BOOTSTRAP_PASSWORD .env | cut -d= -f2)
python3 tests/smoke-test.py
```

Smoke test перевіряє: веб-вхід, логін адміна, створення API-токена, створення транспортного акаунта, створення endpoint, відправку mock-повідомлення та його доставку.

## E2E UI test

Для перевірки створення каналу через браузер (потрібен встановлений Playwright):

```bash
cd /srv/umg
export UMG_ADMIN_PASSWORD=$(grep ADMIN_BOOTSTRAP_PASSWORD .env | cut -d= -f2)
node tests/e2e-channels.js ./screenshots-channels
```

## Документація

- **API**
  - [docs/api/openapi.yaml](docs/api/openapi.yaml) — OpenAPI 3.0: живі ендпоінти + заплановані (позначені `[Planned]`).
- **Архітектура**
  - [docs/architecture/overview.md](docs/architecture/overview.md) — модульний моноліт + worker, компоненти, ADR, потоки даних.
  - [docs/architecture/adapters.md](docs/architecture/adapters.md) — контракт адаптерів: mock (поточний), GoIP/DBLtek, UnoAPI, Signal.
  - [docs/architecture/data-model.md](docs/architecture/data-model.md) — схема PostgreSQL/Prisma + заплановані сутності.
  - [docs/architecture/security.md](docs/architecture/security.md) — модель безпеки (доступ, секрети, ізоляція, SSRF, аудит).
- **Експлуатація**
  - [docs/operator-guide/uk.md](docs/operator-guide/uk.md) — посібник оператора (українською): встановлення, перший вхід, токени, канали, маршрутизація, типові проблеми.
  - [docs/runbooks/backup-restore.md](docs/runbooks/backup-restore.md) — резервне копіювання та відновлення.
  - [docs/runbooks/channel-down.md](docs/runbooks/channel-down.md) — канал недоступний/деградований.
  - [docs/runbooks/queue-recovery.md](docs/runbooks/queue-recovery.md) — відновлення черг після інциденту з Redis.
  - [docs/runbooks/goip-rollback.md](docs/runbooks/goip-rollback.md), [signal-relink.md](docs/runbooks/signal-relink.md), [whatsapp-reconnect.md](docs/runbooks/whatsapp-reconnect.md) — заглушки, будуть заповнені в Milestone 2/4/5.
- **Ліцензії**: [docs/licensing/third-party.md](docs/licensing/third-party.md) — UnoAPI (GPL-3.0), signal-cli (MIT/власні умови), DBLtek (обмеження редистрибуції).
- **Історія змін**: [CHANGELOG.md](CHANGELOG.md).
- **Повне технічне завдання**: [docs/ТЗ.md](docs/ТЗ.md).

## Важливі файли

- `docs/ТЗ.md` — повне технічне завдання.
- `packages/database/prisma/schema.prisma` — схема БД.
- `apps/api/src/transport-accounts/` — API акаунтів та endpoint.
- `apps/api/src/messages/` — API повідомлень.
- `apps/worker/src/processors/message-send.processor.ts` — worker.
- `apps/web/src/pages/Channels.tsx` — React-сторінка керування каналами.
- `apps/web/src/pages/` — інші React-сторінки.

## Наступні кроки

Milestone 1 завершено: рушій маршрутизації, призначення вебхуків (webhook/email/telegram/internal_log) із HMAC-підписом, доставки з DLQ та ручним replay, вкладення з підписаними URL і ретенцією, алерти, нові сторінки UI, повний набір документації.

Далі за [docs/ТЗ.md](docs/ТЗ.md):

- **Milestone 2** — адаптер GoIP/DBLtek SMS Server (sidecar-контейнер, vendor API, rollback runbook).
- **Milestone 4** — адаптер Signal (signal-cli-rest-api, relink runbook).
- **Milestone 5** — адаптер WhatsApp через UnoAPI (reconnect runbook).

Деталі контрактів адаптерів: [docs/architecture/adapters.md](docs/architecture/adapters.md).
