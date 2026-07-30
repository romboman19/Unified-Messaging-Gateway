# HANDOFF — Milestone 1 (стан на 2026-07-30)

> Документ для наступного агента/сесії: що зроблено, на чому зупинились, як прийняти й продовжити роботу.

## Контекст

- **Проєкт**: UMG — Unified Messaging Gateway (SMS/WhatsApp/Signal шлюз). ТЗ: `docs/ТЗ.md`.
- **GitHub**: https://github.com/romboman19/Unified-Messaging-Gateway (гілка `main`).
- **Сервер розробки**: `ssh root@192.168.10.11`, репо `/srv/umg`, застосунок http://192.168.10.11:8083/
  (Docker Compose: reverse-proxy :8083, umg-api :4000, umg-worker, postgres, redis; мережі frontend/backend).
- На сервері `gh` авторизовано як `romboman19` — push на GitHub робиться **з сервера** (локально токена нема).
- Локальна копія репо (машина розробника Windows): `C:\Users\DELL\rakamakafo\umg`.

## Що ЗРОБЛЕНО (запушено на GitHub, гілка main)

Milestone 1 «Core messaging» з ТЗ §37. Коміти:

1. `b4a8e5d feat(db,api)` — схема БД + API:
   - Prisma: RoutingRule, RuleDestinationLink, WebhookDestination (webhook/email/telegram/internal_log),
     WebhookDelivery (pending/delivering/delivered/failed/dlq), Attachment, Alert, AlertRule, MessageEvent.
   - **Відтворено втрачену baseline-міграцію** `20260729204843_init` + нова `20260730190000_milestone1_routing`.
   - contracts: CloudEvents envelope (§15.3), EVENT_TYPES (§15.2), routing/alerts DTO.
   - API: routing-rules CRUD, destinations CRUD + `POST /:id/test`, deliveries list + `POST /:id/replay`,
     media upload/signed-url/delete, alerts, audit-logs, events, conversations,
     messages: retry/cancel/filters/idempotency-409/attachments/`ui-send` (session), SessionOrTokenGuard, EventEmitter.
2. `495eb09 feat(worker)` — EventsService (outbox §28), RoutingService (§15.1 + field selector + шаблони без eval),
   WebhookDeliverProcessor (HMAC-SHA256 §15.4: `X-UMG-Signature: sha256=${HMAC(secret, timestamp + "." + body)}`,
   retry [60,300,900,3600]c, 4xx=permanent, DLQ+alert після 5 спроб), ScheduledSendScheduler
   (**багфікс: scheduled-повідомлення раніше ніколи не відправлялись**), ReconciliationScheduler §28,
   MediaRetentionScheduler (60 днів, `media.deleted`), message.sent/failed events, final-failure alert.
3. `8eff2ad docs` — повний набір документації за ТЗ §41: OpenAPI, architecture (4 файли), operator-guide (укр),
   runbooks, licensing, CHANGELOG, оновлений README.

Локально всі збірки зелені: `npm run build --workspace=packages/database --workspace=apps/api --workspace=apps/worker` — 0 помилок.

## НА ЧОМУ ЗУПИНИЛИСЬ

- **UI (apps/web) — у роботі, НЕ закомічено.** Тло-агент будує сторінки: Layout+навігація, Messages, TestChat,
  Routing, Deliveries, Alerts, ApiTokens, Logs, оновлений Dashboard. Файли в робочому дереві локального репо
  (`apps/web/src/...` — modified/untracked). Збірку web ще не верифіковано.
- **Smoke-тести не розширено** (поточний `tests/smoke-test.py` покриває лише M0).
- **Передеплой на сервері не виконано** — на сервері досі старий код (cb4ae21).
- Milestones 2–6 (GoIP, Signal, WhatsApp, hardening) НЕ розпочато — потребують реального заліза/креденшелів
  (ТЗ §36 Phase 0 discovery: IP GoIP SMS Server, логін/пароль, line IDs, UnoAPI, signal-cli тощо).

## ЯК ПРИЙНЯТИ РОБОТУ (чеклист для наступного агента)

### 1. Доробити й закомітити UI
```bash
cd C:\Users\DELL\rakamakafo\umg
npm install
npm run build --workspace=apps/web   # має бути 0 помилок
git add apps/web && git commit -m "feat(web): Milestone 1 UI pages..."
```
Перевірити: композер TestChat використовує `POST /api/v1/messages/ui-send` (session). Всі рядки — українською.

### 2. Розширити tests/smoke-test.py (запускається НА СЕРВЕРІ)
Нові сценарії (після існуючих 7 кроків):
- підняти приймач вебхуків: `docker run --rm -d --network umg_backend --name umg-hook-sink hashicorp/http-echo -listen=:5678 -text=ok`
- створити destination (webhook, url=http://umg-hook-sink:5678/, secret=smoke-secret) і routing rule
  з eventTypes=[message.queued,message.sent,message.delivered] → відправити mock → зачекати →
  `GET /deliveries?destinationId=` має показати `delivered`
- destination з url=http://umg-api:4000/no-such-route → delivery стає `failed` (4xx permanent) за ~15с
- `POST /destinations/:id/test` → delivered
- `POST /deliveries/:id/replay` → новий delivery id, той самий eventId
- media: upload (JSON base64) → GET назад побайтово → signed-url працює
- `GET /events` містить message.queued; `GET /audit-logs` не порожній
- прибрати sink-контейнер у finally

### 3. Запушити на GitHub (з локальної машини через сервер)
```bash
cd C:\Users\DELL\rakamakafo\umg
git bundle create "$TMP/umg.bundle" origin/main..main        # або останній спільний коміт..main
scp "$TMP/umg.bundle" root@192.168.10.11:/tmp/umg.bundle
ssh root@192.168.10.11 'cd /srv/umg && git fetch /tmp/umg.bundle main && git merge --ff-only FETCH_HEAD && git push origin main'
```

### 4. Передеплой на сервері — КРИТИЧНО: спочатку фікс checksum міграції!
Baseline-міграцію відтворено; її SHA-256 відрізняється від запису в `_prisma_migrations`. Без фіксу
`prisma migrate deploy` у entrypoint ВПАДЕ і API не стартує:
```bash
ssh root@192.168.10.11
cd /srv/umg && git pull --ff-only
CS=$(sha256sum packages/database/prisma/migrations/20260729204843_init/migration.sql | cut -d' ' -f1)
docker exec umg-postgres psql -U umg -d umg -c \
  "UPDATE _prisma_migrations SET checksum='$CS' WHERE migration_name='20260729204843_init';"
docker compose up -d --build
docker ps   # усі 6 контейнерів Up (api/worker/web healthy)
export ADMIN_BOOTSTRAP_PASSWORD=$(grep ADMIN_BOOTSTRAP_PASSWORD .env | cut -d= -f2)
python3 tests/smoke-test.py
```
Після цього видалити цей розділ з HANDOFF і доповнити docs/runbooks (крок одноразовий).

### 5. Перевірка UI в браузері
Playwright MCP або `tests/e2e-channels.js`: логін admin → пройти по сторінках навігації →
створити destination + rule через UI → TestChat відправка → Deliveries показує delivered.

## Відомі технічні рішення/обмеження

- Секрети destinations (`secretEnc`, botToken, SMTP) зберігаються відкрито в БД (шифрування AES-256-GCM
  за §8.3 — окрема задача; потрібен MASTER_KEY у .env). API їх ніколи не повертає (hasSecret/маскування).
- DLQ перевіряється вручну/integration (повний цикл 5 спроб ~85 хв — поза smoke-тестом).
- HMAC-підпис верифіковано читанням коду; e2e-перевірка підпису — бажано додати в smoke (sink з перевіркою).
- `docs/architecture/data-model.md` маркує нові сутності як [Planned] — після деплою прибрати маркери.
- git identity у локальному репо: `UMG Admin <umg@local>` (як у історії). НЕ запускати паралельні
  git-команди в одному репо (був race на index lock).

## Далі після деплою M1

- Milestone 3 залишок: alert rules engine (thresholds, cooldown, recovery), health dashboard повний.
- Milestone 2/4/5 — лише після отримання від замовника: IP/креденшели GoIP SMS Server, UnoAPI, signal-cli
  (див. ТЗ §36 «Phase 0 — mandatory technical discovery» — список того, що треба запитати).
