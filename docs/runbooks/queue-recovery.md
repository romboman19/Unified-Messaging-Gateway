# Runbook: Queue Recovery (Redis / BullMQ)

Trigger: Redis restarted or evicted, queue depth stuck at 0 while messages
sit in `queued`, worker idle, or alert `queue.backlog`.

## 1. Principle

Redis holds BullMQ queue state and sessions only; **PostgreSQL is the
source of truth** (ADR-006). Every outbound job is backed by a `messages`
row in status `queued`/`scheduled` plus its `message_status_history`. After
any Redis incident the queue can always be rebuilt from the database.

## 2. Diagnose

```bash
docker compose ps redis
docker compose logs --tail=100 redis
docker compose exec redis redis-cli ping
docker compose exec redis redis-cli info persistence   # AOF should be on (--appendonly yes)
docker compose logs --tail=100 umg-worker
```

Check DB truth:

```sql
SELECT status, count(*) FROM messages GROUP BY status ORDER BY status;
SELECT * FROM messages WHERE status IN ('queued','scheduled') ORDER BY created_at LIMIT 20;
```

## 3. Recover

1. **Redis healthy, queue silently drained** — re-enqueue stranded jobs
   (target tooling: `npm run worker:requeue` / admin action). Manual
   equivalent: for each `messages.status = 'queued'` row whose latest
   status-history entry is older than the incident time, enqueue
   `enqueueSend(message.id)` again. Idempotency on the sender side and the
   (account, external_id) dedupe make double-processing safe (ADR-007).
2. **Redis AOF corrupted / volume lost**:

   ```bash
   docker compose stop redis
   docker volume rm umg_redis_data          # only after confirming DB truth above
   docker compose up -d redis
   docker compose restart umg-worker umg-api
   ```

   Then perform step 1 to re-enqueue. All admin sessions are dropped — log
   in again.
3. **Worker crashed mid-attempt**: BullMQ marks the job stalled and retries
   on restart automatically; messages left in `dispatching` for > 10 min can
   be reset to `queued` and re-enqueued:

   ```sql
   UPDATE messages SET status='queued', updated_at=now()
   WHERE status='dispatching' AND updated_at < now() - interval '10 minutes';
   ```

4. **Verify**: watch a new test message traverse
   `queued → dispatching → sent` and confirm the stranded backlog is
   draining (message counts + worker logs).

## 4. Webhook delivery queues (target state)

Delivery retries (0/60/300/900/3600 s) are likewise re-derivable: rows in
`webhook_deliveries` with `state='pending'` and `next_attempt_at <= now()`
are re-scheduled on worker start. Rows at attempt 5/5 were already
`dead_lettered` before any Redis loss — inspect and replay manually from the
UI.

## 5. Prevention / follow-up

- Keep `--appendonly yes` (already in `docker-compose.yml`) and monitor AOF
  rewrite errors.
- Alert on `queue.backlog` threshold (alert rules, UI).
- Do not store any business state in Redis keys beyond BullMQ and sessions.
