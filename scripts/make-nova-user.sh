#!/usr/bin/env bash
# Creates the MySQL user Nova should run as, with only what it needs:
#   read-only on the CRM database (MYSQL_DB in .env, axiomprint_new)
#   full access on Nova's own database (nova_ai)
# then switches Nova over to it. Run on the Nova Droplet as root:  bash make-nova-user.sh
#
# Why a new user: users made in the DigitalOcean panel (novaai) get server-wide rights that doadmin
# is not allowed to take away (ERROR 3879 on metrics_user_telegraf). A user created here starts with nothing.
# novaai is left untouched as the fallback; delete it in the panel once Nova has run a day on the new one.
set -u
ENV=/opt/axiom-ai/.env
NEW_USER=nova_ai_app
NEW_DB=nova_ai
APP=axiom-ai

get() { grep -E "^$1=" "$ENV" | head -1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//"; }
HOST=$(get MYSQL_HOST); PORT=$(get MYSQL_PORT); PORT=${PORT:-25060}; CRM_DB=$(get MYSQL_DB)
[ -n "$HOST" ] && [ -n "$CRM_DB" ] || { echo "MYSQL_HOST / MYSQL_DB missing in $ENV. Stopping."; exit 1; }
command -v mysql >/dev/null || apt-get install -y mysql-client >/dev/null

read -rsp "doadmin password: " ADMIN_PASS; echo
adm() { MYSQL_PWD="$ADMIN_PASS" mysql -h "$HOST" -P "$PORT" -u doadmin --ssl-mode=REQUIRED "$@"; }
adm -e "SELECT 1" >/dev/null || { echo "Could not log in as doadmin. Check the password."; exit 1; }
adm -N -e "SHOW DATABASES LIKE '$NEW_DB'" | grep -qx "$NEW_DB" || { echo "Database $NEW_DB not found. Nothing was changed."; exit 1; }

# 1. The user (a new random password each run; letters and digits only, so .env needs no quoting)
PASS=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
adm -e "CREATE USER IF NOT EXISTS '$NEW_USER'@'%' IDENTIFIED BY '$PASS';
        ALTER USER '$NEW_USER'@'%' IDENTIFIED BY '$PASS';
        GRANT SELECT, SHOW VIEW ON \`$CRM_DB\`.* TO '$NEW_USER'@'%';
        GRANT ALL PRIVILEGES ON \`$NEW_DB\`.* TO '$NEW_USER'@'%';" \
  || { echo "Creating the user failed (error above). Nova was not touched."; exit 1; }
echo "1. Created $NEW_USER. It has:"; adm -N -e "SHOW GRANTS FOR '$NEW_USER'@'%'" | sed 's/^/   /'

# 2. Prove it before Nova uses it
echo; echo "2. Checking as $NEW_USER:"
nu() { MYSQL_PWD="$PASS" mysql -h "$HOST" -P "$PORT" -u "$NEW_USER" --ssl-mode=REQUIRED -N "$@" 2>/dev/null; }
ok=1
if nu -e "SELECT COUNT(*) FROM \`$CRM_DB\`.estimate" >/dev/null; then echo "   OK    can read the CRM"; else echo "   FAIL  cannot read the CRM"; ok=0; fi
if nu -e "CREATE TABLE \`$NEW_DB\`._check (id INT); DROP TABLE \`$NEW_DB\`._check;"; then echo "   OK    can write $NEW_DB"; else echo "   FAIL  cannot write $NEW_DB"; ok=0; fi
if nu -e "CREATE TABLE \`$CRM_DB\`._check (id INT)"; then nu -e "DROP TABLE \`$CRM_DB\`._check"; echo "   FAIL  can write the CRM"; ok=0
else echo "   OK    cannot write the CRM (blocked, as intended)"; fi
[ $ok = 1 ] || { echo; echo "Something is off. Nova was not switched. Send Claude a screenshot."; exit 1; }

# 3. Switch Nova
echo; read -rp "3. Switch Nova to $NEW_USER now? (a few seconds, no downtime) Type yes: " A
[ "$A" = yes ] || { echo "Nova not switched. Run the script again when ready (it makes a fresh password)."; exit 0; }
BK="$ENV.backup-$(date +%F-%H%M)"
cp -p "$ENV" "$BK"
sed -i -E "s/^MYSQL_USER=.*/MYSQL_USER=$NEW_USER/; s/^MYSQL_PASS=.*/MYSQL_PASS=$PASS/" "$ENV"
grep -q "^MYSQL_USER=$NEW_USER\$" "$ENV" && grep -q "^MYSQL_PASS=$PASS\$" "$ENV" \
  || { cp -p "$BK" "$ENV"; echo "Could not update $ENV — put the old one back. Nova not switched."; exit 1; }
echo "   .env updated (old copy: $BK)"
pm2 reload "$APP" --update-env >/dev/null && echo "   Nova reloaded" || echo "   pm2 reload failed — run: pm2 reload $APP"

echo; echo "4. Waiting 20 s for Nova to reconnect..."; sleep 20
adm -t -e "SELECT user, SUBSTRING_INDEX(host,':',1) AS from_ip, COUNT(*) AS connections
           FROM information_schema.processlist WHERE user IN ('$NEW_USER','novaai') GROUP BY 1,2"
echo
echo "You should see $NEW_USER above (novaai may linger a minute, then disappears)."
echo "Now sign in to Nova and run a quote or a report."
echo "To go back:  cp $BK $ENV && pm2 reload $APP --update-env"
