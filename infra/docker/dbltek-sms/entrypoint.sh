#!/bin/bash
# Boots the DBLtek SMS Server inside a container.
#
# The vendor's installer assumes a long-lived host: it edits rc.local to start
# the daemon and leaves the database seeded by hand. A container has neither,
# so this script does both on every start — idempotently, because the volume
# and the database survive restarts.
set -euo pipefail

DB_HOST="${SMS_DB_HOST:-dbsms-db}"
DB_NAME="${SMS_DB_NAME:-goip}"
DB_USER="${SMS_DB_USER:-goip}"
DB_PASS="${SMS_DB_PASSWORD:-goip}"
CRON_PORT="${SMS_GOIPCRON_PORT:-44444}"

CONFIG=/usr/local/goip/inc/config.inc.php

# The vendor hardcodes localhost credentials in config.inc.php. Rewrite it from
# the environment so the database can live in its own container.
cat > "$CONFIG" <<PHP
<?php
\$dbhost='${DB_HOST}';
\$dbuser='${DB_USER}';
\$dbpw='${DB_PASS}';
\$dbname='${DB_NAME}';
\$goipcronport='${CRON_PORT}';
\$charset='utf8';
\$endless_send=0;
\$re_ask_timer=3;
?>
PHP

ROOT_PASS="${SMS_DB_ROOT_PASSWORD:-}"

echo "[sms-server] waiting for MySQL at ${DB_HOST}…"
for i in $(seq 1 60); do
  if mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" -e 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = "60" ]; then
    echo "[sms-server] MySQL did not become reachable in time" >&2
    exit 1
  fi
  sleep 2
done

# Seed the schema once, and only when the tables are genuinely absent: the
# vendor dump opens with `DROP DATABASE goip`, so re-running it would wipe every
# GoIP definition and message the admin has accumulated.
TABLES=$(mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" -N -B \
  -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}'" 2>/dev/null || echo 0)
if [ "${TABLES:-0}" = "0" ]; then
  if [ -z "$ROOT_PASS" ]; then
    echo "[sms-server] SMS_DB_ROOT_PASSWORD is required to import the schema" >&2
    exit 1
  fi
  # The dump creates the database and grants, which the application user is not
  # allowed to do — it has to go in as root.
  echo "[sms-server] empty database — importing goipinit.sql as root"
  # NOTE: the archive ships two dumps with the same name. `inc/goipinit.sql`
  # is an older 15-table schema; the installer uses the 20-table one at the
  # package root, and only that one has the columns the PHP actually reads
  # (login fails with "Bad query: (SELECT session_time from system)" on the
  # other). Keep this path.
  mysql -h "$DB_HOST" -u root -p"$ROOT_PASS" < /usr/local/goip/goipinit.sql

  # The dump also grants only to goip@localhost with a hardcoded password,
  # which is useless when the database lives in its own container. Re-grant to
  # the real user so the app can reach it after the drop/create cycle.
  mysql -h "$DB_HOST" -u root -p"$ROOT_PASS" -e \
    "GRANT ALL ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASS}'; FLUSH PRIVILEGES;"
  echo "[sms-server] schema imported; web login is root/root — change it immediately"
else
  echo "[sms-server] database already has ${TABLES} table(s); leaving it alone"
fi

# goipcron is the piece GoIP hardware actually talks to over UDP. Apache serves
# the UI and the JSON API; if the daemon dies the gateway silently goes offline,
# so take the container down with it rather than look healthy while deaf.
echo "[sms-server] starting goipcron on udp/${CRON_PORT}"
cd /usr/local/goip
# goipcron daemonises: it forks and the process we launch returns immediately,
# so its exit status says nothing about whether the daemon is alive. Watch for
# the process by name instead.
./goipcron inc/config.inc.php
sleep 2
if ! pgrep -x goipcron >/dev/null; then
  echo "[sms-server] goipcron failed to start" >&2
  exit 1
fi

term() {
  pkill -x goipcron 2>/dev/null || true
  exit 0
}
trap term TERM INT

(
  # If the daemon dies the gateway silently goes offline, so bring the
  # container down rather than keep serving a web UI that cannot send anything.
  while sleep 15; do
    if ! pgrep -x goipcron >/dev/null; then
      echo "[sms-server] goipcron is gone — stopping container" >&2
      kill 1 2>/dev/null || true
      break
    fi
  done
) &

exec "$@"
