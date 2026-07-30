# Runbook: одноразове відновлення контрольної суми baseline-міграції

## Коли застосовувати

Цей крок виконується **один раз** на існуючому сервері розробки після відтворення
втраченої baseline-міграції `20260729204843_init`.

Якщо ви розгортаєте UMG з нуля у новому середовищі, цей крок **не потрібен** —
`prisma migrate deploy` створить запис `_prisma_migrations` із правильною сумою під час
першого старту.

## Контекст

Baseline-міграцію `20260729204843_init` було відтворено вручну під час Milestone 1.
Через відмінність у форматуванні/коментарях її SHA-256 відрізнялася від запису в таблиці
`_prisma_migrations`. Без оновлення суми `prisma migrate deploy` в entrypoint падає й API
не стартує.

## Виконані дії (зафіксовано 2026-07-30)

На сервері `192.168.10.11` виконано:

```bash
ssh root@192.168.10.11
CS=$(sha256sum /srv/umg/packages/database/prisma/migrations/20260729204843_init/migration.sql | cut -d' ' -f1)
docker exec umg-postgres psql -U umg -d umg -c \
  "UPDATE _prisma_migrations SET checksum='$CS' WHERE migration_name='20260729204843_init';"
```

Після цього:

```bash
cd /srv/umg && docker compose up -d --build
```

Усі 6 контейнерів стартували зі статусом `healthy` (api/worker/web).

## Перевірка

```bash
ssh root@192.168.10.11 'docker exec umg-postgres psql -U umg -d umg -c "SELECT migration_name, checksum FROM _prisma_migrations WHERE migration_name = '\''20260729204843_init'\'';"'
```

Сума має відповідати:

```bash
sha256sum /srv/umg/packages/database/prisma/migrations/20260729204843_init/migration.sql
```

## Smoke-тест після відновлення

```bash
ssh root@192.168.10.11 'bash -lc "set -a; source /srv/umg/.env; set +a; cd /srv/umg; python3 tests/smoke-test.py"'
```

Очікуваний результат: `ALL SMOKE TESTS PASSED`.
