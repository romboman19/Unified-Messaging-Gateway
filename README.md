# Unified Messaging Gateway (UMG)

Внутрішній єдиний шлюз для SMS, WhatsApp та Signal. Milestone 0 — робочий скелет на NestJS + React, розгорнутий через Docker Compose.

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

## Важливі файли

- `docs/ТЗ.md` — повне технічне завдання.
- `packages/database/prisma/schema.prisma` — схема БД.
- `apps/api/src/transport-accounts/` — API акаунтів та endpoint.
- `apps/api/src/messages/` — API повідомлень.
- `apps/worker/src/processors/message-send.processor.ts` — worker.
- `apps/web/src/pages/Channels.tsx` — React-сторінка керування каналами.
- `apps/web/src/pages/` — інші React-сторінки.

## Наступні кроки

Реалізувати реальні транспортні адаптери (GoIP/SMS, WhatsApp, Signal) поверх існуючого API акаунтів та endpoint.
