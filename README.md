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

## Smoke test

```bash
cd /srv/umg
export ADMIN_BOOTSTRAP_PASSWORD=$(grep ADMIN_BOOTSTRAP_PASSWORD .env | cut -d= -f2)
python3 tests/smoke-test.py
```

## Важливі файли

- `docs/ТЗ.md` — повне технічне завдання.
- `packages/database/prisma/schema.prisma` — схема БД.
- `apps/api/src/messages/` — API повідомлень.
- `apps/worker/src/processors/message-send.processor.ts` — worker.
- `apps/web/src/pages/` — React-сторінки.

## Наступні кроки

Додавати реальні транспортні адаптери (GoIP/SMS, WhatsApp, Signal) через UI/API — інтерфейс акаунтів та endpoint вже підготовлено.
