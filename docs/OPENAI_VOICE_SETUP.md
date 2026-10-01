# Set up an OpenAI API key for Nova's voice typing

> **Note to ChatGPT:** I run AxiomPrint, a print shop. Our website chat assistant, Nova, needs an **OpenAI API key**
> for speech-to-text. Please walk me through the setup below **one step at a time**, using the current
> platform.openai.com screens, and tell me if any screen or permission name has changed. I am not a developer, so
> please be specific about where to click. **I will never paste the key itself into this chat.**

## What the key is for

Customers on axiomprint.com tap a microphone in the Nova chat, speak, and tap Done. Our own server sends that
recording to OpenAI and puts the text it gets back into the customer's message box. That is the only thing this key
will do.

Technical details, so you can choose the right settings:

| | |
|---|---|
| API endpoint | `POST https://api.openai.com/v1/audio/transcriptions` (Audio → Transcriptions) |
| Model | `gpt-4o-mini-transcribe` |
| Audio | WAV files, 16 kHz mono, at most 2 minutes each, in English |
| Called from | Our server only (Node.js). The key sits in the server's `.env` file and never reaches a browser. |
| Recordings | Our side never stores them. They are sent once and dropped. |
| Expected use | Roughly 50–300 voice messages a day, about 20 seconds each, so about 15–100 minutes of audio a day |
| Expected cost | About $0.003 per minute (please check the current pricing page), so roughly **$2–10 a month** |

## What I need you to help me do

1. **Create an API account** at https://platform.openai.com. The API is separate from a ChatGPT subscription; please
   confirm whether I can sign in with my existing ChatGPT login, and that ChatGPT Plus/Team does not include API
   credit. Set the organization name to **AxiomPrint**. Do any verification steps it asks for.
2. **Billing:** add a company card and buy a small amount of **prepaid credit**, for example $10–20. If I turn on
   auto-recharge, help me set a low monthly cap.
3. **Create a Project** called **Nova voice**, so this usage is kept separate from anything else.
4. **Set a spending limit** on that project, for example **$25 a month**, plus an email alert at around $10. If that
   isn't available on my account, tell me what the closest option is.
5. **Create a restricted API key** inside the **Nova voice** project:
   - Name: `nova-server-stt`
   - Permissions: **only** what `/v1/audio/transcriptions` needs. Everything else should be off or None. Tell me the
     exact permission label the current screen uses for audio.
   - If restricted keys aren't offered for this, a normal project key is OK. The project spending limit is then the
     safety net.
   - Copy the key **once** and keep it somewhere safe until I add it to the server. OpenAI won't show it again.
6. **Data settings:** please confirm that API data is not used to train OpenAI's models by default, and tell me how
   long OpenAI keeps audio sent to the transcription endpoint. Also tell me whether I need to change anything for
   customers' voice recordings.

## What I do after I have the key (on our server)

Add the key to the server's settings and restart Nova:

```bash
echo 'OPENAI_API_KEY=sk-PASTE-THE-KEY-HERE' >> /opt/axiom-ai/.env
pm2 restart axiom-ai
```

Then check it:

```bash
# 1) Nova sees the key: should print {"ok":true,"server":true}
curl -s http://localhost:3000/api/client-bot/voice; echo

# 2) The key works and is allowed to transcribe. The file is empty on purpose:
#    an "invalid file" / "audio" error (400) means the KEY IS GOOD.
#    401 = wrong key; 403 = the key is missing the audio permission; 429 "insufficient_quota" = add credit.
KEY=$(grep '^OPENAI_API_KEY=' /opt/axiom-ai/.env | cut -d= -f2-)
printf '' > /tmp/empty.wav
curl -s https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer $KEY" \
  -F model=gpt-4o-mini-transcribe -F file=@/tmp/empty.wav; echo
rm -f /tmp/empty.wav
```

3. Open the chat on axiomprint.com, tap the mic, say a sentence, and tap ✓. The words should appear in the box.

If it fails, `pm2 logs axiom-ai --lines 50 --nostream | grep -i transcribe` shows OpenAI's error. A line like
`CLIENT_BOT transcribe openai 401 …` means the key is wrong, 403 means a missing permission, and 429 means credit
or rate limits.

## Settings Nova understands (optional)

| `.env` line | What it does |
|---|---|
| `OPENAI_API_KEY=sk-…` | Turns on server speech-to-text (required) |
| `STT_MODEL=gpt-4o-transcribe` | A more accurate model, at about twice the price (the default is `gpt-4o-mini-transcribe`) |
| `STT_LANGUAGE=en` | The spoken language (default English) |
| `STT_PROVIDER=browser` | Switches server speech-to-text off; the chat falls back to the browser's own recognition |

## Safety rules

- Never paste the key into email, Slack, a chat (this one included), or the website's code. It belongs only in
  `/opt/axiom-ai/.env`.
- If the key is ever exposed, delete it in the OpenAI dashboard, create a new one, replace the line in `.env`, and
  run `pm2 restart axiom-ai`.
- Check the usage page once in the first week, to compare the real cost with the estimate above.
