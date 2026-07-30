#!/bin/sh
set -e

echo "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if nc -z postgres 5432; then
    echo "DB ready."
    break
  fi
  echo "DB not ready, retrying..."
  sleep 2
done

exec "$@"
