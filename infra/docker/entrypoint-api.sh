#!/bin/sh
set -e

echo "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if npx prisma migrate deploy --schema packages/database/prisma/schema.prisma 2>/dev/null; then
    echo "Migrations applied."
    break
  fi
  echo "DB not ready, retrying..."
  sleep 2
done

exec "$@"
