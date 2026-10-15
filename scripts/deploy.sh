#!/bin/bash
# Deploy Nova from GitHub to /opt/axiom-ai, safely.
#
#   rm -rf /tmp/nova-ai && git clone -q https://github.com/axiomprint11/nova-ai.git /tmp/nova-ai && bash /tmp/nova-ai/scripts/deploy.sh
#
# Copies only the listed files (default: the server and client-bot files), backs up each one first
# (<file>.bk-<date>-<time>), checks the JavaScript, restarts Nova only when a server file changed, and puts
# the backups back by itself if Nova does not answer after the restart.
# Pass file names to deploy other files:  bash /tmp/nova-ai/scripts/deploy.sh public/chatbot.js public/chatbot.html

LIVE=${NOVA_LIVE:-/opt/axiom-ai}
SRC=${NOVA_SRC:-/tmp/nova-ai}
FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  FILES=(server.js ecosystem.config.js client-bot.js quote-pdf.js visitor-info.js public/admin.html speech-to-text.js public/axiom-voice.js public/axiom-cards.js public/client-embed.js public/client-chat.html public/client-chat.js
         public/client-bot-admin.js public/client-bot.html public/axiom-shared.css docs/CLIENT_BOT.md CLAUDE.md
         talk-ai.js public/talk-ai.html public/talk-ai.js docs/TALK_AI.md
         usage-stats.js public/nova-stats.js public/index.html public/chatbot.html public/chatbot.js public/nova-nav.js closed-days.js talk-handoff.js docs/TALKAI_CRM_WEBHOOK.md artwork-specs.js team-directory.js office-hours.js bookkeeping.js public/bookkeeping.html public/bookkeeping.js docs/BOOKKEEPING_AI.md
         shipping.js design-services.js public/nova-date.js bookkeeping-ar.js docs/NOVA_AR_PAY_WEBHOOK.md docs/DESIGNER_AI_AUTOASSIGN.md website-knowledge.js docs/NOVA_WEBSITE_KNOWLEDGE.md)
  # 1.19.143: any tracked code / page file that does not exist in the live copy yet is new — take it along, so a new
  # module (shipping.js, nova-date.js) never leaves server.js unable to start.
  # 1.20.7: and any tracked code / page file that DIFFERS from the live copy — bookkeeping-ar.js was deployed once as a
  # new file and then never again, so three weeks of AR server changes reached only the page. GitHub is the source.
  if git -C "$SRC" rev-parse >/dev/null 2>&1; then
    while IFS= read -r nf; do
      case "$nf" in scripts/*|node_modules/*|*.md) continue ;; esac
      [ -f "$LIVE/$nf" ] && cmp -s "$SRC/$nf" "$LIVE/$nf" && continue
      skip=0; for f in "${FILES[@]}"; do [ "$f" = "$nf" ] && skip=1 && break; done
      [ $skip -eq 1 ] || FILES+=("$nf")
    done < <(git -C "$SRC" ls-files | grep -E '^(public/)?[^/]+\.(js|html|css)$')
  fi
fi
B="bk-$(date +%Y-%m-%d-%H%M)"
cd "$LIVE" || { echo "!!! $LIVE not found"; exit 1; }

# 1) Everything present and valid in the new copy before anything is touched.
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "!!! $f is not in the GitHub copy — nothing changed"; exit 1; }
  case "$f" in *.js) node -c "$SRC/$f" >/dev/null 2>&1 || { echo "!!! $f has a syntax error — nothing changed"; exit 1; } ;; esac
done
# 1.20.73: a // comment that swallowed a trailing + passes node -c and breaks the page at runtime (1.20.13, 1.20.66, 1.20.72)
bash "$SRC/scripts/check-comments.sh" "$SRC"/public/*.js "$SRC"/*.js || { echo "!!! a comment swallowed code — nothing changed"; exit 1; }

# 2) Back up and copy only what differs.
CHANGED=(); RESTART=0
for f in "${FILES[@]}"; do
  if [ -f "$f" ] && cmp -s "$SRC/$f" "$f"; then continue; fi
  [ -f "$f" ] && cp "$f" "$f.$B"
  mkdir -p "$(dirname "$f")" && cp "$SRC/$f" "$f"
  CHANGED+=("$f")
  case "$f" in public/*|docs/*|*.md) ;; *) RESTART=1 ;; esac
done
if [ ${#CHANGED[@]} -eq 0 ]; then echo "=== Already up to date — nothing to do ==="; grep -o "NOVA_VERSION = '[^']*'" server.js; exit 0; fi
echo "Updated: ${CHANGED[*]}"

# Zero-downtime swap (1.19.34): in cluster mode `pm2 reload` boots the new copy, waits for its 'ready', then stops the
# old one — the site never answers 502. A process still in the old fork mode is moved over once (a few seconds down,
# the last time).
restart_nova() {
  if pm2 describe axiom-ai 2>/dev/null | grep -q "exec mode.*cluster"; then
    pm2 reload axiom-ai --update-env >/dev/null
  else
    echo "--- moving axiom-ai to cluster mode (one-time, a few seconds down)"
    pm2 delete axiom-ai >/dev/null 2>&1; pm2 start "$LIVE/ecosystem.config.js" >/dev/null && pm2 save >/dev/null
  fi
}
rollback() {
  echo "!!! NOT UP — putting the previous files back"
  for f in "${CHANGED[@]}"; do if [ -f "$f.$B" ]; then cp "$f.$B" "$f"; else rm -f "$f"; fi; done
  restart_nova; sleep 4
  pm2 logs axiom-ai --lines 30 --nostream
  exit 1
}

# 3) Restart only for server files, then check Nova answers with the new version.
#    First a trial boot of the new code on a spare port: a copy that crashes at start never replaces the live one
#    (pm2 reload would otherwise take the old copy down and loop on the broken one).
if [ $RESTART -eq 1 ]; then
  WANT=$(grep -o "NOVA_VERSION = '[^']*'" server.js | cut -d"'" -f2)
  TRIAL=3101; echo "--- trial boot on port $TRIAL"
  PORT=$TRIAL BOOKKEEPER_CLOCK=0 NOVA_TRIAL=1 node server.js > /tmp/nova-trial.log 2>&1 &
  TP=$!; TRIAL_OK=0
  for i in $(seq 1 20); do sleep 2; if curl -sf http://localhost:$TRIAL/api/version >/dev/null 2>&1; then TRIAL_OK=1; break; fi; kill -0 $TP 2>/dev/null || break; done
  kill $TP 2>/dev/null; wait $TP 2>/dev/null
  if [ $TRIAL_OK -ne 1 ]; then echo "!!! the new server.js does not start — live copy untouched:"; tail -20 /tmp/nova-trial.log; for f in "${CHANGED[@]}"; do if [ -f "$f.$B" ]; then cp "$f.$B" "$f"; else rm -f "$f"; fi; done; exit 1; fi
  restart_nova || rollback
  for i in $(seq 1 20); do
    sleep 2
    GOT=$(curl -sf http://localhost:3000/api/version 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$GOT" ] && { [ -z "$WANT" ] || [ "$GOT" = "$WANT" ]; }; then
      echo "=== NOVA IS UP ==="; curl -s http://localhost:3000/api/version; echo
      echo "Backups: <file>.$B"; exit 0
    fi
  done
  rollback
else
  echo "=== UPDATED (website files only — no restart needed; reload the page) ==="
  echo "Backups: <file>.$B"
fi
