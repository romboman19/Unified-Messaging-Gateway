# HANDOFF — Milestone 1 (стан на 2026-07-30)

> Документ для наступного агента/сесії: що зроблено, на чому зупинились, як прийняти й продовжити роботу.

## Контекст

- **Проєкт**: UMG — Unified Messaging Gateway (SMS/WhatsApp/Signal шлюз). ТЗ: `docs/ТЗ.md`.
- **GitHub**: https://github.com/romboman19/Unified-Messaging-Gateway (гілка `main`).
- **Сервер розробки**: `ssh root@192.168.10.11`, репо `/srv/umg`, застосунок http://192.168.10.11:8083/
  (Docker Compose: reverse-proxy :8083, umg-api :4000, umg-worker, postgres, redis; мережі frontend/backend).
- На сервері `gh` авторизовано як `romboman19` — push на GitHub робиться **з сервера** (локально токена нема).
- Локальна копія репо (машина розробника Windows): `C:\Users\DELL\rakamakafo\umg`.

## Що ЗРОБЛЕНО (запушено на GitHub, гілка main, задеплойовано на 192.168.10.11:8083)

Milestone 1 «Core messaging» з ТЗ §37 + UI + розширені smoke-тести. Коміти:

1. `b4a8e5d feat(db,api)` — схема БД + API:
   - Prisma: RoutingRule, RuleDestinationLink, WebhookDestination (webhook/email/telegram/internal_log),
     WebhookDelivery (pending/delivering/delivered/failed/dlq), Attachment, Alert, AlertRule, MessageEvent.
   - **Відтворено втрачену baseline-міграцію** `20260729204843_init` + нова `20260730190000_milestone1_routing`.
   - contracts: CloudEvents envelope (§15.3), EVENT_TYPES (§15.2), routing/alerts DTO.
   - API: routing-rules CRUD, destinations CRUD + `POST /:id/test`, deliveries list + `POST /:id/replay`,
     media upload/signed-url/delete, alerts, audit-logs, events, conversations,
     messages: retry/cancel/filters/idempotency-409/attachments/`ui-send` (session), SessionOrTokenGuard, EventEmitter.
2. `495eb09 feat(worker)` — EventsService (outbox §28), RoutingService (§15.1 + field selector + шаблони без eval),
   WebhookDeliverProcessor (HMAC-SHA256 §15.4, retry [60,300,900,3600]c, 4xx=permanent, DLQ+alert після 5 спроб), ScheduledSendScheduler
   (**багфікс: scheduled-повідомлення раніше ніколи не відправлялись**), ReconciliationScheduler §28,
   MediaRetentionScheduler (60 днів, `media.deleted`), message.sent/failed events, final-failure alert.
3. `8eff2ad docs` — повний набір документації за ТЗ §41.
4. `00b7f9f feat(web)` — Milestone 1 UI: Layout+навігація, Dashboard, Messages, TestChat, Routing, Deliveries, Alerts, ApiTokens, Logs. TestChat використовує `POST /api/v1/messages/ui-send` (session). Всі рядки — українською.
5. `7525955 feat(tests)` — розширено `tests/smoke-test.py`: webhook sink, routing rule, delivered/failed (4xx permanent), destination test, delivery replay, media upload/download/signed-url, events/audit-logs.
6. `a9e5090 fix(api,gitignore)` — `.gitignore` ігнорував `apps/api/src/media/` через правило `media/`; виправлено на `/media/` (лише корінь репо), додано відсутні файли модуля медіа.
7. `37b8728 fix(tests)` — прибрано stderr від `docker rm -f` у cleanup smoke-тесту.

Локально та на сервері всі збірки зелені. Smoke-тести на сервері проходять (`python3 tests/smoke-test.py` після `source /srv/umg/.env`).

**Одноразовий фікс міграції вже виконано**: контрольна сума `20260729204843_init` оновлена в `_prisma_migrations` перед деплоєм; деталі в `docs/runbooks/migration-checksum-fix.md`.

## НА ЧОМУ ЗУПИНИЛИСЬ

- Milestones 2–6 (GoIP, Signal, WhatsApp, hardening) НЕ розпочато — потребують реального заліза/креденшелів
  (ТЗ §36 Phase 0 discovery: IP GoIP SMS Server, логін/пароль, line IDs, UnoAPI, signal-cli тощо).
- Playwright e2e UI-тест не автоматизовано; поточна перевірка UI — ручна/браузерна.

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
