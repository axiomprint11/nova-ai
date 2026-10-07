#!/bin/bash
# TalkAi: check the keys in .env really work (never prints a secret).
#   rm -rf /tmp/nova-ai && git clone -q https://github.com/axiomprint11/nova-ai.git /tmp/nova-ai && bash /tmp/nova-ai/scripts/talk-check.sh
ENVF=${NOVA_LIVE:-/opt/axiom-ai}/.env
URL=${NOVA_PUBLIC_URL:-https://nova.axiomprint.com}
[ -f "$ENVF" ] || { echo "!!! $ENVF not found"; exit 1; }
v() { grep -m1 "^$1=" "$ENVF" | cut -d= -f2- | tr -d '\r"'"'" | sed 's/[[:space:]]*$//'; }
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$@"; }
say() { if [ "$2" = "200" ]; then echo "  ✓ $1"; else echo "  ✗ $1 — $3 (HTTP $2)"; fi; }

echo "1) Keys in $ENVF"
for k in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TALKAI_NUMBER ELEVENLABS_API_KEY ELEVENLABS_AGENT_ID ELEVENLABS_WEBHOOK_SECRET TALKAI_LLM_KEY; do
  [ -n "$(v $k)" ] && echo "  ✓ $k" || echo "  · $k — not added yet"
done

echo "2) Do they work?"
SID=$(v TWILIO_ACCOUNT_SID); TOK=$(v TWILIO_AUTH_TOKEN)
if [ -n "$SID" ] && [ -n "$TOK" ]; then
  say "Twilio Account SID + Auth Token" "$(code -u "$SID:$TOK" "https://api.twilio.com/2010-04-01/Accounts/$SID.json")" "Twilio refused them — re-copy both from Account Info"
  NUM=$(v TALKAI_NUMBER)
  if [ -n "$NUM" ]; then
    J=$(curl -s --max-time 15 -u "$SID:$TOK" "https://api.twilio.com/2010-04-01/Accounts/$SID/IncomingPhoneNumbers.json?PhoneNumber=$(printf %s "$NUM" | sed 's/+/%2B/')")
    if echo "$J" | grep -q "\"voice_url\": *\"$URL/api/talk/twilio/voice\""; then echo "  ✓ $NUM sends calls to Nova"
    elif echo "$J" | grep -q '"phone_number"'; then echo "  ? $NUM is in Twilio, but its webhook could not be confirmed here — a test call will tell (TalkAi → Setup → Recent activity)"
    else echo "  ✗ $NUM was not found in this Twilio account"; fi
  fi
fi
EK=$(v ELEVENLABS_API_KEY); AG=$(v ELEVENLABS_AGENT_ID)
if [ -n "$EK" ]; then
  say "ElevenLabs API key (Agents access)" "$(code -H "xi-api-key: $EK" "https://api.elevenlabs.io/v1/convai/agents?page_size=1")" "ElevenLabs refused the key — it needs ElevenAgents: Write"
  [ -n "$AG" ] && say "ElevenLabs agent $AG" "$(code -H "xi-api-key: $EK" "https://api.elevenlabs.io/v1/convai/agents/$AG")" "agent not found — check ELEVENLABS_AGENT_ID"
fi
LK=$(v TALKAI_LLM_KEY)
if [ -n "$LK" ]; then
  C=$(code -X POST "$URL/api/talk/llm/v1/chat/completions" -H "Authorization: Bearer $LK" -H 'Content-Type: application/json' \
    -d '{"stream":false,"messages":[{"role":"system","content":"conversation=keycheck caller=+10000000000"},{"role":"user","content":"Just say: OK"}]}')
  say "Nova answers ElevenLabs with TALKAI_LLM_KEY" "$C" "Nova refused — run pm2 restart axiom-ai after editing .env"
fi
echo "3) Nova: $(curl -s --max-time 10 "$URL/api/version")"
echo "Missing or ✗ lines: fix .env, run  pm2 restart axiom-ai,  and run this again."
