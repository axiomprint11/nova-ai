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
  FILES=(server.js client-bot.js visitor-info.js public/admin.html speech-to-text.js public/axiom-voice.js public/axiom-cards.js public/client-embed.js public/client-chat.html public/client-chat.js
         public/client-bot-admin.js public/client-bot.html public/axiom-shared.css docs/CLIENT_BOT.md CLAUDE.md
         talk-ai.js public/talk-ai.html public/talk-ai.js docs/TALK_AI.md
         usage-stats.js public/nova-stats.js public/index.html public/chatbot.html public/chatbot.js public/nova-nav.js closed-days.js)
fi
B="bk-$(date +%Y-%m-%d-%H%M)"
cd "$LIVE" || { echo "!!! $LIVE not found"; exit 1; }

# 1) Everything present and valid in the new copy before anything is touched.
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "!!! $f is not in the GitHub copy — nothing changed"; exit 1; }
  case "$f" in *.js) node -c "$SRC/$f" >/dev/null 2>&1 || { echo "!!! $f has a syntax error — nothing changed"; exit 1; } ;; esac
done

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

rollback() {
  echo "!!! NOT UP — putting the previous files back"
  for f in "${CHANGED[@]}"; do if [ -f "$f.$B" ]; then cp "$f.$B" "$f"; else rm -f "$f"; fi; done
  pm2 restart axiom-ai >/dev/null; sleep 4
  pm2 logs axiom-ai --lines 30 --nostream
  exit 1
}

# 3) Restart only for server files, then check Nova answers.
if [ $RESTART -eq 1 ]; then
  pm2 restart axiom-ai >/dev/null || rollback
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    if curl -sf http://localhost:3000/api/version >/dev/null; then
      echo "=== NOVA IS UP ==="; curl -s http://localhost:3000/api/version; echo
      echo "Backups: <file>.$B"; exit 0
    fi
  done
  rollback
else
  echo "=== UPDATED (website files only — no restart needed; reload the page) ==="
  echo "Backups: <file>.$B"
fi
