# Runbook: Backup and Restore

Spec §31. A backup counts as working **only after a test restore and a
send/receive smoke test**.

## 1. What must be backed up

| Asset | Where | Mandatory |
|---|---|---|
| PostgreSQL database | volume `umg-postgres-data` (dump via `pg_dump`) | Yes |
| Media / attachments | volume `umg-media-data` | Yes |
| UnoAPI sessions/config | volume `umg-unoapi-data` (target state) | Yes, when WhatsApp enabled |
| Signal keys/registration | volume `umg-signal-data` (target state) — **sensitive** | Yes, when Signal enabled |
| DBLtek SMS Server data/config | volume `umg-goip-vendor-data` (target state) | Yes, when GoIP enabled |
| `.env` / Docker secrets | repository server filesystem | Yes — stored **separately** and protected (not with the DB dumps) |
| Image/version manifest | generated per backup | Yes |

Redis is **not** backed up. Redis never holds the only copy of important
state (ADR-006): sessions can be re-created by logging in again, and queues
are re-enqueueable from PostgreSQL.

## 2. Backup procedure

The repository ships `infra/backup/backup.sh` (target). Manual equivalent:

```bash
TS=$(date -u +%Y%m%d-%H%M%S)
DEST=/srv/backups/umg/$TS
mkdir -p "$DEST"

# 1. Consistent database dump
docker exec umg-postgres pg_dump -U umg -Fc umg > "$DEST/postgres.dump"

# 2. Filesystem volumes (after the dump, same minute window)
docker run --rm -v umg_media_data:/data -v "$DEST":/backup alpine \
  tar czf /backup/media.tar.gz -C /data .
# Repeat for umg-unoapi-data / umg-signal-data / umg-goip-vendor-data
# when those services are enabled.

# 3. Image/version manifest
docker compose images > "$DEST/images.txt"
docker compose config --no-interpolate > "$DEST/compose.resolved.yml"

# 4. Checksums
(cd "$DEST" && sha256sum * > SHA256SUMS)

# 5. .env — archive separately, encrypted
gpg -c -o "$DEST.env.gpg" /srv/umg/.env
```

Notes:

- The `pg_dump -Fc` (custom format) is consistent by itself; the volume
  tars taken immediately after the dump are operationally consistent for
  UMT-scale writes. For strict consistency, pause the worker
  (`docker compose stop umg-worker`) during the DB dump.
- Encrypt backups at rest where policy requires; restrict directory
  permissions (`chmod 700 /srv/backups/umg`).
- Rotate/retain per local policy; `umg-backups` volume holds scheduled
  output in the target deployment.

## 3. Verify backup

`verify-backup.sh` (target) or manually: checksum match **and** a full test
restore (below) in a separate environment ending with the smoke test:

```bash
cd /srv/umg-restore-test
python3 tests/smoke-test.py
```

## 4. Restore procedure

On a fresh (or quarantined) machine:

```bash
# 1. Restore .env from its separate protected archive FIRST
gpg -d /path/to/<TS>.env.gpg > /srv/umg/.env && chmod 600 /srv/umg/.env

# 2. Bring up empty infrastructure
cd /srv/umg
docker compose up -d postgres redis
docker compose exec postgres pg_isready -U umg -d umg   # wait until ready

# 3. Restore database
docker exec -i umg-postgres \
  pg_restore -U umg -d umg --clean --if-exists < /path/to/<TS>/postgres.dump

# 4. Restore media volume
docker run --rm -v umg_media_data:/data -v /path/to/<TS>:/backup alpine \
  sh -c 'tar xzf /backup/media.tar.gz -C /data'
# Repeat for umg-unoapi-data / umg-signal-data / umg-goip-vendor-data
# matching the exact image tags from images.txt.

# 5. Start the stack
docker compose up -d
curl http://localhost:8083/api/v1/health/ready

# 6. Smoke test (login, token, mock send/delivery)
python3 tests/smoke-test.py
```

## 5. After restore

- Verify queued messages: those stuck in a Redis that was lost are
  re-enqueued from the database — see `queue-recovery.md`.
- Rotate the global API token if the restore followed a compromise.
- Confirm audit log continuity (`created_at` order intact).
