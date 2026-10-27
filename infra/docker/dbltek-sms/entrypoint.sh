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
ROOT_PASS="${SMS_DB_ROOT_PASSWORD:-}"

# Names go into SQL as identifiers, where quoting rules differ from values;
# refusing anything unusual is simpler than escaping them correctly.
for pair in "SMS_DB_NAME=$DB_NAME" "SMS_DB_USER=$DB_USER"; do
  if ! [[ "${pair#*=}" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "[sms-server] ${pair%%=*} may only contain letters, digits and _" >&2
    exit 1
  fi
done
if ! [[ "$CRON_PORT" =~ ^[0-9]+$ ]]; then
  echo "[sms-server] SMS_GOIPCRON_PORT must be numeric" >&2
  exit 1
fi

# A single-quoted PHP literal. Interpolating raw values would let a password
# containing ' break config.inc.php — or append PHP of its own to it.
php_str() { V="$1" php -r 'echo var_export(getenv("V"), true);'; }
# A single-quoted SQL literal (MySQL treats \ as an escape inside quotes).
sql_str() {
  local v=${1//\\/\\\\}
  printf "'%s'" "${v//\'/\'\'}"
}

# Passwords go to the client through the environment, not argv: anything on a
# command line is visible to every process in the container via ps.
db() { MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -u "$DB_USER" "$@"; }
db_root() { MYSQL_PWD="$ROOT_PASS" mysql -h "$DB_HOST" -u root "$@"; }

CONFIG=/usr/local/goip/inc/config.inc.php

# The vendor hardcodes localhost credentials in config.inc.php. Rewrite it from
# the environment so the database can live in its own container.
cat > "$CONFIG" <<PHP
<?php
\$dbhost=$(php_str "$DB_HOST");
\$dbuser=$(php_str "$DB_USER");
\$dbpw=$(php_str "$DB_PASS");
\$dbname=$(php_str "$DB_NAME");
\$goipcronport='${CRON_PORT}';
\$charset='utf8';
\$endless_send=0;
\$re_ask_timer=3;
?>
PHP
# Apache reads it; nobody else in the container needs the database password.
chown root:www-data "$CONFIG"
chmod 640 "$CONFIG"

# Some vendor code calls mysql_real_escape_string() with no link argument. PHP
# then opens an *implicit* connection from php.ini's mysql.default_* settings,
# which are unset — so it tries localhost over a unix socket that does not exist
# here and the call fails. Where that happens inside a write path (USSD replies,
# for one) the result is silently dropped. Give PHP the same credentials the app
# uses so the implicit link resolves.
# PHP expands ${...} in ini files from its own environment, so the password is
# never parsed as ini syntax (a value with " or ; would otherwise be cut short).
export GOIP_INI_DB_HOST="$DB_HOST" GOIP_INI_DB_USER="$DB_USER" GOIP_INI_DB_PASS="$DB_PASS"
cat > /usr/local/etc/php/conf.d/zz-goip-db.ini <<'INI'
mysql.default_host = "${GOIP_INI_DB_HOST}"
mysql.default_user = "${GOIP_INI_DB_USER}"
mysql.default_password = "${GOIP_INI_DB_PASS}"
INI

# The vendor PHP is old and unauditable here; if any of it can be talked into
# running a command, these are the calls that would do it. Set
# SMS_PHP_DISABLE_FUNCTIONS= (empty) to lift the block if a vendor feature
# genuinely needs one of them.
DISABLE_FUNCTIONS="${SMS_PHP_DISABLE_FUNCTIONS-exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec,dl,show_source,phpinfo}"
if ! [[ "$DISABLE_FUNCTIONS" =~ ^[A-Za-z0-9_,]*$ ]]; then
  echo "[sms-server] SMS_PHP_DISABLE_FUNCTIONS must be a comma-separated list of names" >&2
  exit 1
fi
printf 'disable_functions = "%s"\n' "$DISABLE_FUNCTIONS" \
  > /usr/local/etc/php/conf.d/zz-goip-disable-functions.ini

echo "[sms-server] waiting for MySQL at ${DB_HOST}…"
for i in $(seq 1 60); do
  if db -e 'SELECT 1' >/dev/null 2>&1; then
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
TABLES=$(db -N -B \
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
  db_root < /usr/local/goip/goipinit.sql

  # The dump also grants only to goip@localhost with a hardcoded password,
  # which is useless when the database lives in its own container. Re-grant to
  # the real user so the app can reach it after the drop/create cycle.
  db_root -e \
    "GRANT ALL ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%' IDENTIFIED BY $(sql_str "$DB_PASS"); FLUSH PRIVILEGES;"
  echo "[sms-server] schema imported; web login is root/root — change it immediately"
else
  echo "[sms-server] database already has ${TABLES} table(s); leaving it alone"
fi

# Where the server posts inbound SMS and delivery reports. The vendor stores
# this in its own settings table and offers no API for it, so a fresh install
# would otherwise need someone to paste the URL into the web UI by hand — and
# inbound SMS would silently go nowhere until they did. Written on every start
# so rotating the webhook secret takes effect without touching the vendor UI.
# Compose the URL here rather than expecting a ready-made one. A pre-built
# value invites two silent failures: deployment UIs (Portainer's stack
# variables, for one) do not expand ${VAR} *inside* another variable's value,
# so the secret arrives as a literal placeholder; and a secret containing "+"
# is decoded as a space on the receiving side, so it never matches. Building it
# from the raw secret, URL-encoded, removes both.
if [ -z "${SMS_FORWARD_URL:-}" ] && [ -n "${DBSMS_WEBHOOK_SECRET:-}" ]; then
  ENCODED_SECRET=$(php -r 'echo rawurlencode(getenv("DBSMS_WEBHOOK_SECRET"));')
  SMS_FORWARD_URL="${UMG_API_URL:-http://umg-api:4000}/api/v1/webhooks/dbsms?secret=${ENCODED_SECRET}"
fi

if [ -n "${SMS_FORWARD_URL:-}" ]; then
  FORWARD_SQL=$(sql_str "$SMS_FORWARD_URL")
  db "$DB_NAME" \
    -e "UPDATE system SET json_recv_url=${FORWARD_SQL}, json_send_url=${FORWARD_SQL};" \
    && echo "[sms-server] forwarding URLs set to ${SMS_FORWARD_URL%%\?*}?secret=***" \
    || echo "[sms-server] WARNING: could not set forwarding URLs" >&2
else
  echo "[sms-server] SMS_FORWARD_URL not set — inbound SMS will not reach UMG" >&2
fi

# goipcron is the piece GoIP hardware actually talks to over UDP. Apache serves
# the UI and the JSON API; if the daemon dies the gateway silently goes offline,
# so take the container down with it rather than look healthy while deaf.
# Everything below — goipcron and every Apache worker — inherits this
# environment, and PHP exposes it through getenv()/$_SERVER. The root password
# and the webhook secret have done their job by now; keep them out of reach of
# the vendor code.
unset SMS_DB_ROOT_PASSWORD ROOT_PASS DBSMS_WEBHOOK_SECRET ENCODED_SECRET \
      SMS_FORWARD_URL FORWARD_SQL SMS_DB_PASSWORD

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

(
  # The vendor dump seeds the web UI with root/root, and that same account
  # authenticates the JSON API. Nothing forces anyone to change it, so say so
  # on every start until someone does.
  sleep 20
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -H 'content-type: application/json' \
    -d '{"auth":{"username":"root","password":"root"}}' \
    http://127.0.0.1/goip/querylines/ || true)
  if [ "$code" = "200" ]; then
    echo "[sms-server] WARNING: the SMS Server still accepts the default root/root login." \
         "Change it in the web UI and set DBSMS_PASSWORD to match." >&2
  fi
) &

exec "$@"
