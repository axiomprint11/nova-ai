#!/usr/bin/env bash
# Locks the `novaai` MySQL user down to what Nova needs:
#   read-only on the CRM database (MYSQL_DB in .env, axiomprint_new)
#   full access on Nova's own database (nova_ai)
# Run on the Nova Droplet as root:  bash lock-novaai.sh
# Asks once for the doadmin password, saves the current grants first (the undo),
# shows who is connected, and changes nothing unless you type "yes".
set -u
ENV=/opt/axiom-ai/.env
NEW_DB=nova_ai

get() { grep -E "^$1=" "$ENV" | head -1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//"; }
HOST=$(get MYSQL_HOST); PORT=$(get MYSQL_PORT); PORT=${PORT:-25060}
NOVA_USER=$(get MYSQL_USER); NOVA_PASS=$(get MYSQL_PASS); CRM_DB=$(get MYSQL_DB)

[ "$NOVA_USER" = novaai ] || { echo "Expected MYSQL_USER=novaai in $ENV, found '$NOVA_USER'. Stopping."; exit 1; }
[ -n "$CRM_DB" ] || { echo "MYSQL_DB is empty in $ENV. Stopping."; exit 1; }
command -v mysql >/dev/null || { echo "Installing the mysql client..."; apt-get install -y mysql-client >/dev/null; }

read -rsp "doadmin password: " ADMIN_PASS; echo
adm() { MYSQL_PWD="$ADMIN_PASS" mysql -h "$HOST" -P "$PORT" -u doadmin --ssl-mode=REQUIRED "$@"; }
adm -e "SELECT 1" >/dev/null || { echo "Could not log in as doadmin. Check the password."; exit 1; }

BK=/root/novaai-grants-before-$(date +%F-%H%M).txt
adm -N -e "SHOW GRANTS FOR 'novaai'@'%'" | sed 's/$/;/' > "$BK"
echo "1. Saved novaai's current grants (your undo) to $BK"

echo; echo "2. Who is connected to the database right now:"
adm -t -e "SELECT user, SUBSTRING_INDEX(host,':',1) AS from_ip, db, COUNT(*) AS connections
           FROM information_schema.processlist GROUP BY 1,2,3 ORDER BY 1,2"
MINE=$(hostname -I | tr ' ' '\n' | sed '/^$/d')
echo "   This server's addresses: $(echo $MINE)"

OTHER=$(adm -N -e "SELECT DISTINCT SUBSTRING_INDEX(host,':',1) FROM information_schema.processlist WHERE user='novaai'" \
        | grep -vxF -f <(echo "$MINE") || true)
if [ -n "$OTHER" ]; then
  echo; echo "STOP: novaai is also connected from another address: $OTHER"
  echo "Something else uses this user. Nothing was changed. Send Claude a screenshot."; exit 1
fi
adm -N -e "SHOW DATABASES LIKE '$NEW_DB'" | grep -qx "$NEW_DB" || { echo "Database $NEW_DB not found. Nothing was changed."; exit 1; }

echo; read -rp "3. novaai is only used by Nova. Lock it down now? Type yes: " A
[ "$A" = yes ] || { echo "Nothing was changed."; exit 0; }

adm -e "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'novaai'@'%';
        GRANT SELECT, SHOW VIEW ON \`$CRM_DB\`.* TO 'novaai'@'%';
        GRANT ALL PRIVILEGES ON \`$NEW_DB\`.* TO 'novaai'@'%';" \
  || { echo "The change failed (error above). To undo: mysql ... -u doadmin -p < $BK"; exit 1; }

echo; echo "4. novaai now has:"; adm -N -e "SHOW GRANTS FOR 'novaai'@'%'"

echo; echo "5. Checking as novaai:"
nova() { MYSQL_PWD="$NOVA_PASS" mysql -h "$HOST" -P "$PORT" -u novaai --ssl-mode=REQUIRED -N "$@" 2>/dev/null; }
if nova -e "SELECT COUNT(*) FROM \`$CRM_DB\`.estimate" >/dev/null; then echo "   OK    can read the CRM"
else echo "   FAIL  cannot read the CRM. Undo with: mysql -h $HOST -P $PORT -u doadmin -p --ssl-mode=REQUIRED < $BK"; fi
if nova -e "CREATE TABLE \`$NEW_DB\`._lock_check (id INT); DROP TABLE \`$NEW_DB\`._lock_check;"; then echo "   OK    can write $NEW_DB"
else echo "   FAIL  cannot write $NEW_DB"; fi
if nova -e "CREATE TABLE \`$CRM_DB\`._lock_check (id INT)"; then
  nova -e "DROP TABLE \`$CRM_DB\`._lock_check"; echo "   FAIL  can still write the CRM"
else echo "   OK    cannot write the CRM (blocked, as intended)"; fi
echo; echo "Done. Now sign in to Nova and run a quote or a report to confirm it works."
