# TalkAi — NovaAI on the phone

TalkAi answers AxiomPrint's phone line (+1 747 350 0012) with NovaAI. Callers ask about products and prices,
turnaround, design work, installation and delivery, and — once they prove who they are — their own orders.
NovaAI speaks the caller's language. It can take a message for the team, transfer the call to a person, and
escalate past-due orders, as the website chat does.

Admin page: **nova.axiomprint.com/talk-ai** (Admin menu → TalkAi, with an unread badge). Code: `talk-ai.js`
(server), `public/talk-ai.html` + `public/talk-ai.js` (page).

## How a call flows

```
Caller ─► Twilio number ─► POST /api/talk/twilio/voice        Nova: Twilio signature, call logged, mode
                              └─► ElevenLabs register-call ─► TwiML back to Twilio (audio → ElevenLabs)
ElevenLabs (listens + speaks) ─► POST /api/talk/llm/v1/chat/completions   every turn: "what do I say?"
                              ◄── Nova streams the words (Claude + the client bot's tools and rules)
After the call: ElevenLabs ─► POST /api/talk/hook/elevenlabs   transcript, summary, recording (HMAC)
                Twilio     ─► POST /api/talk/twilio/status      call ended, duration
```

- **Twilio** carries the call. The number's voice webhook points at Nova, so Nova decides what happens:
  NovaAI answers, the call is forwarded, or the closed message plays. If ElevenLabs is down, the call falls
  back to the forward number (or the closed message).
- **ElevenLabs** only listens (speech to text) and speaks (voice). Its agent uses a **Custom LLM**: Nova.
  The agent's own system prompt is a stub that carries `nova_call={{nova_call}}`,
  `conversation={{system__conversation_id}}` and `caller={{system__caller_id}}` so Nova knows which call a turn belongs to.
- **Nova** builds the real instructions on every turn (`phonePrompt()`): voice style, the fixed safety rules,
  the phone rules, the turnaround page, the design guide, and the client bot's house rules and knowledge
  (shared training, edited in Client ChatBot → Training). The fixed part is prompt-cached.

## What NovaAI can do on a call

| Tool | Notes |
|---|---|
| `search_products`, `newest_products`, `product_details`, `price_product` | The client bot's tools (`bot.runTool`), same results as the website chat |
| `estimate_design`, `estimate_installation`, `estimate_delivery` | Same as the chat |
| `verify_caller` | Order (E-number) or invoice number **plus** the account's email, ZIP (customerusers) or phone. Three tries per call. Never says which part failed. |
| `my_orders`, `order_status` | Only after `verify_caller` succeeded. Same deadline sentence and past-due escalation as the chat (the email links to the call). |
| `email_quote` | After a price, NovaAI offers to email it. A recognised or verified caller is offered the EMAIL ON FILE ("Should I send it to gary@axiomprint.com?" — the matched person's email, else the account's; `fileEmail()`); anyone else gives an address, read back once. The same quote to the same address is never sent twice in 15 minutes. The email (from order@axiomprint.com) lists every product priced on the call with its options, each quantity's price and ready date, an **Order now** button (the same option-preselected link the chat uses) and **See our conversation**. Max 3 emails and 2 addresses per call. |
| `take_message` | Emails the team (Training → Messages go to; default gary@axiomprint.com) and marks the call "Message". |
| `transfer_call` | Only when a transfer number is set and `TWILIO_ACCOUNT_SID` is in .env. NovaAI says one sentence, then Nova redirects the live call with Twilio's REST API (`<Dial>` the number, caller ID passed through; closed message if no one answers). |
| ElevenLabs system tools | `end_call`, language detection… are passed through to ElevenLabs as OpenAI tool calls. |

## Callers we know (caller ID)

Before NovaAI answers, `lookupCaller()` finds the accounts whose phone is the calling number (`customer.phone` /
`company_phone`, or a person in `customerusers`; exact 10-digit match), busiest account first. One number is often on
several accounts (duplicates, colleagues) — all count as the caller's. NovaAI greets them by first name with the
"Callers we know" greeting (`{name}`), stored as `talk_calls.caller_first`.

Order details for a known number (Training → Order details for a known number, `talk_settings.caller_id`):
- **carrier** (default): straight to their orders when Twilio's `StirVerstat` says the carrier verified the number
  (`TN-Validation-Passed-A` / `-B`) — `verified_by = 'caller_id'`. Otherwise NovaAI asks for ONE detail, the email or ZIP
  on the account (`verify_caller` with `proof` only; a phone number does not count, since that is the caller ID) —
  `verified_by = 'check+caller_id'`.
- **always**: any matching number is trusted (a faked caller ID could hear an order status).
- **never**: no name greeting; order number + email / ZIP / phone as before (`verified_by = 'check'`).

A recognised caller may hear about every account on their number (`allowedIds()`); `order_status` on a job of another
of those accounts is looked up as that account. Try it: put a customer's number in "Calling from" — it counts as
carrier-verified there.

## Live projects

`live_projects` lists the verified caller's jobs whose current stage (`estimate_stage`, one row per job) is one of:
CAD (`cad_template`), Design, Tier 1, Tier 2, Payment, Imposition, Production, Dispatch (`packing`), Pickup, Shipping,
Delivery / install, Job Merge — grouped by project (`estimate.estimate_projectid` → `project.projectname`); a project
whose jobs are at different stages is **Mixed**. NovaAI says "I see N live projects under your account", names them and
asks which one; `order_status` then gives that job's full status and deadline sentence.

Nova keeps per-call memory between turns (what was looked up, verification tries), because ElevenLabs sends
only the words back each turn.

## Hours: regular and after hours

Training → **Opening hours** (Los Angeles time, per weekday, plus closed days such as holidays) decides which setup
answers: **Regular hours** inside them, **After hours** outside them. Each has its own **who answers** (NovaAI · ring the
team first, then NovaAI · forward · closed message), greeting, greeting for callers we know, and rules for that time of
day (`talk_settings.hours` / `modes`, JSON; `hoursNow()`, `weekText()`). NovaAI's prompt gets an HOURS line ("the team
is IN until 6:00 PM" / "CLOSED now; we open again tomorrow at 9:00 AM") and the mode's rules; after hours there are no
transfers. Each call stores `hours_mode`. The Phone rules box still applies at all hours.

**Ring first** (`ring_ai`): Twilio `<Dial>`s the "Transfer to" number (or the account manager's phone) for
`TALKAI_RING_SECONDS` (default 20); `POST /api/talk/twilio/after-dial?call=<id>` (signed) hangs up if someone answered,
otherwise hands the call to NovaAI with "Hi {name}, {am} can't come to the phone right now…". Voicemail on the rung phone
counts as answered — keep it longer than the ring time or turn it off.

## Account managers (their own NovaAI)

Tab **Account managers** (`talk_lines`): pick a CRM user who manages clients (`customer.manager_id` → `user`), then:
- **Their own number** — a Twilio number (listed from the account; **Connect to Nova** sets its voice and status webhooks)
  that always answers as their NovaAI; and/or
- **Their clients on the main line** — a caller recognised by their number whose account's `manager_id` is this person
  gets their NovaAI on the main number (`routeLine()`).
- Their phone (rings first if ticked, and where transfers go), where messages go (default their email), an optional
  greeting (`{name}`, `{am}`), **their notes for NovaAI** (added to the prompt as "<NAME>'S NOTES"), an optional
  ElevenLabs voice ID (sent as a `tts.voice_id` override — allow **Voice** under the agent's Security → Overrides).
A call stores `line_id`; the Calls tab shows "<Name>'s line". Try it can test any line, any time of day, as any caller.

### Missed calls → their NovaAI, not voicemail

- A call to their own number greets with the missed-call greeting ("Hi Gus, Armine can't come to the phone right now…")
  unless the line has its own greeting.
- **Ring first** + **"Press 1 to take it"** (`talk_lines.screen`, on by default): their phone is dialled with
  `<Number url=/api/talk/twilio/screen>`, which says "AxiomPrint call from <caller>. Press 1 to take it." Only a 1
  (`/screen-ok`, sets `talk_calls.screen_ok = 1`) connects; voicemail or no key hangs up that leg, and `/after-dial`
  sees `screen_ok = 0` and gives the call to NovaAI even though Twilio reports it `completed`.
- Dialpad: set the person's unanswered-call forwarding to their NovaAI number and leave Ring first off.

### Their own assistant (the account manager calls their NovaAI)

Their phones (`talk_lines.own_numbers`, up to 3, unique across lines, never a TalkAi number). A call **from** one of
them to their NovaAI number or the main number (`ownerLineFor()`) skips hours, ring first and the caller check:

- **Trusted** when the carrier verified the number (STIR/SHAKEN `Passed-A`), unless "Ask for the PIN on every call".
  Otherwise, when a PIN is set, Twilio asks for it on the keypad (`/api/talk/twilio/pin`, never spoken, so never in a
  transcript; scrypt hash in `talk_lines.owner_pin`; 3 tries a call, 10 wrong in a day stops the PIN until the next day).
  No PIN and no carrier check, or the PIN not given: an ordinary call on their line (`talk_calls.owner = 2`; the prompt
  says the number is theirs but unverified, so no messages or client details).
- Verified (`owner = 1`, `verified_by` `owner_carrier` / `owner_pin` / `owner_try`): greeting `owner_greeting`
  (default "Hi {am}! {new}How can I help today?", `{new}` = "You have 2 new calls. " since `owner_seen_at`) and a
  different prompt (`ownerPrompt()`) and tools (`ownerTools()`): `my_calls` (calls on their line with caller, time,
  callback number, message taken, summary, prices given; hearing them moves `owner_seen_at`), `find_client` (name,
  company, email or phone → accounts with account manager and live project count), `client_projects`, `job_status`
  (any job, through the client bot's `order_status` as that job's customer), `email_me` (a note to their own email only,
  optionally with this call's prices laid out ready to forward to a client), plus the product / price / design /
  installation / delivery tools. Read-only: it never changes orders or contacts clients.
- Try it: type one of their phones in "Calling from".

## Languages

Training → **Languages**: English plus Spanish, Armenian, Russian (`talk_settings.languages`). There is **no key menu**:
NovaAI answers in the language the caller speaks. The prompt tells it to call ElevenLabs' `language_detection` system
tool the moment the caller switches (so ElevenLabs' listening and voice switch too), then answer in that language. A number
that spoke one of these languages before (`rememberedLang()`: a non-English call, or a key picked when the old menu was on)
starts in it: ElevenLabs `conversation_config_override.agent.language` (allow **Language** under the agent's Security →
Overrides; if refused Nova retries without it) plus that language's greeting (`lang_greetings`; check the Armenian with a
native speaker). The ElevenLabs agent needs the languages under **Additional languages** (each with a voice; Eleven v3
for Armenian) and **Detect language** turned on under System tools. The press-a-key menu (`/api/talk/twilio/lang`)
is still in the code, off unless `TALKAI_LANG_MENU=1`.

## Training and documents for calls

TalkAi is an agent row (`agents.slug = 'talk-ai'`, access `system` — never listed in a staff chat's agent menu by
`/api/agents`). Admin → Agents → TalkAi edits its role / rules / how to answer / knowledge and example answers;
Admin → Domain Knowledge documents (PDF, Word, text) can be shared with TalkAi. `loadTalkTraining()` (server.js, passed in
`deps`) joins them for the phone prompt (TALKAI TRAINING AND DOCUMENTS, cached a minute in talk-ai.js), using ONLY documents
shared with TalkAi by name (`loadAgentKnowledge(slug, { explicitOnly: true })`) — "All agents" documents are written for staff
and may hold internal details. The AM-assistant prompt gets the same block. Agents cards show usage (questions / chats /
people in 30 days, this week, last used; TalkAi: calls and callers) from `agentUsage()`. Deep links:
`/admin?tab=agents&agent=talk-ai`, `/admin?tab=knowledge`.

## Returning callers and price first

- **Short greeting** for callers who talked to NovaAI before (`isReturning()`: an earlier phone call from the number
  that the caller spoke on, or a website chat by an account the number belongs to). Each setup has its own
  `greeting_returning` (Training, under the greetings); AM lines and non-English callers get built-in short ones.
  On/off: `talk_settings.returning_short` (default on). The call is marked `talk_calls.returning = 1`.
- **Price first**: the prompt allows one round of questions (to tell the product) before the first price, with the
  defaults for everything not said. Enforced like the website chat: once a product was looked up and not priced,
  and the caller answered NovaAI's question, that turn is forced to `price_product` (`tool_choice`), unless the caller
  is talking about an order.

## Business hours missed calls

A third setup next to Regular and After hours (Training → "Business hours missed calls", `talk_settings.modes.missed`,
number in `talk_settings.missed_number`). A separate Twilio number, connected to Nova like the others; Dialpad sends
calls the team doesn't answer within 20 seconds to it. Every call to that number gets the missed setup whatever the
time: its own greeting ("sorry for the wait…", `{name}` for callers we know), its own rules (help at once, take a message
when a person is needed), always NovaAI, never rings anyone first, no transfers (the team just didn't pick up). A
known caller's account manager notes still apply, but not their line's greeting. Calls are tagged "Missed call"
(`talk_calls.hours_mode = 'missed'`). Dialpad must pass the caller's own number on forwarded calls, or caller ID
recognition can't work.

## Recordings

The post-call audio webhook (base64 MP3) is the fast path, but it is large and can be lost (a proxy body limit,
a missed delivery). So Nova also fetches the MP3 itself from ElevenLabs (`GET /v1/convai/conversations/:id/audio`,
`fetchAudio()`): 20 s, 2 min and 10 min after the transcript arrives, when an admin opens a call without one, and
every 15 minutes for calls of the last 3 days still missing it (`talk_calls.audio_tries`, up to 6). Needs
**Store Call Audio** on for the agent. Setup → Recent activity shows `recording` lines.

## Emails to callers

Every email NovaAI sends a caller (`email_quote`) is BCC'd to `talk_settings.email_bcc` (Training → Numbers and
messages; default `TALKAI_EMAIL_BCC` or gary@axiomprint.com; empty = no copy; tests are not copied) and saved exactly as
sent in SQLite `talk_emails` (to, bcc, subject, HTML, text, ok/error). The call shows an **Email sent** button that
opens it (sandboxed frame); the Calls list tags those calls "Email sent". `sendMail()` takes `bcc`.

## Sizes in feet

`price_product` takes `width` / `height` as the customer said them plus `size_unit` (`ft` / `in`); `sizeFromCustomer()`
in client-bot.js converts to inches (the size fields store inches even when the website shows feet, `configs.metric`
is only the display unit). With no unit: feet when the caller's last turns say feet/ft/foot, or the product is shown in
feet and the numbers are small; and whatever the unit, numbers below the product's minimum in inches that fit in feet
are feet (an "8 by 10" vinyl banner is 96 x 120 in). The result's `size_used` tells the model the size to say back.

## Several calls at once

Every call is its own ElevenLabs conversation and its own set of Nova requests, so calls are answered in parallel up to the
ElevenLabs plan's concurrency (Free 4, Starter 6, Creator 10, Pro 20, Scale 30, Business 40 at the time of writing). A call
over the limit makes `register-call` fail, and Nova falls back to the forward number (or the closed message).

## The caller's page

`/talk/c/<token>` — the link in the quote email (32 random hex characters, no sign-in, expires after `TALKAI_PAGE_DAYS`,
default 90). It shows the prices given on the call with Order now buttons and the conversation (the ElevenLabs
transcript once it arrives, else the live turns) — never Nova's lookups or internal events. `noindex`, `no-referrer`
(so the token never leaks to axiomprint.com), strict CSP. Prices given on a call are kept in `talk_calls.quotes`
(one entry per product + options, quantities merged); the Calls tab shows them, where they were emailed, and the page link.

## Admin page

- **Calls** — every call (phone, ElevenLabs tests, Try it tests), unread dots, search, filters. A call shows
  caller / verified customer, duration, language, outcome, ElevenLabs cost, the recording (played through
  the admin's sign-in), the summary, the transcript and the events (verification, message, transfer, escalation).
  "Show NovaAI's lookups" lists every tool Nova used turn by turn.
- **Try it** — the same phone brain in text (no call). Saved as a test call.
- **Training** — who answers (NovaAI / forward to the team / closed message), greeting (keep "AI assistant"
  and "this call is recorded" — California needs consent to record), phone rules, transfer and forward numbers,
  where messages go, optional summary email per call, closed message. Stored in SQLite `talk_settings`.
- **Setup** — key checklist, the URLs to paste into Twilio and ElevenLabs, the ElevenLabs agent settings,
  and the last 40 webhook hits with what went wrong (in memory; cleared on restart).

## Setup

`.env` (then `pm2 restart axiom-ai`):

```
TWILIO_ACCOUNT_SID=AC…            # transfers
TWILIO_AUTH_TOKEN=…               # checks every Twilio webhook
TALKAI_NUMBER=+17473500012
ELEVENLABS_API_KEY=…
ELEVENLABS_AGENT_ID=agent_…
ELEVENLABS_WEBHOOK_SECRET=…       # post-call webhook secret
TALKAI_LLM_KEY=…                  # openssl rand -hex 24; also saved as the agent's Custom LLM API key
# optional: TALKAI_MODEL, TALKAI_KEEP_DAYS (recordings, default 90), NOVA_PUBLIC_URL
```

Twilio number → Voice configuration: **A call comes in** → Webhook `https://nova.axiomprint.com/api/talk/twilio/voice`
(HTTP POST); **Call status changes** → `https://nova.axiomprint.com/api/talk/twilio/status`.

ElevenLabs agent: system prompt = the stub (Setup tab), first message `{{greeting}}`, dynamic variable
placeholders `nova_call=0` and `greeting`, LLM = Custom LLM `https://nova.axiomprint.com/api/talk/llm/v1`
with the `TALKAI_LLM_KEY` secret, μ-law 8000 Hz input and output audio, system tools End conversation +
Detect language (not Transfer to number). The number is **not** imported into ElevenLabs. Workspace
post-call webhook → `https://nova.axiomprint.com/api/talk/hook/elevenlabs` with transcription and audio on.

`server.js` skips its JSON parser for `/api/talk/hook/` so the webhook's raw body reaches the signature check
(and recordings can be large, up to 80 MB).

## Storage

SQLite: `talk_settings` (one row), `talk_calls` (one per call: numbers, source `phone` / `elevenlabs` / `try`,
answered_by, verified customer, caller_match, summary, transcript JSON, duration, cost, outcome), `talk_turns`
(caller / agent / event lines as Nova answered, with tools), `talk_reads` (read state per admin).
Recordings: `talk-recordings/YYYY-MM/*.mp3` (gitignored, admin-only, deleted after `TALKAI_KEEP_DAYS`).

## Not yet

Texting quotes or links (needs Twilio A2P 10DLC registration; quotes go by email for now), a language menu, 👍/👎 lessons for calls,
outbound calls (need prior consent), business-hours rules.


## Closed days

The phones follow the AxiomPrint calendar (production `holidays`, the website's Closed days panel) through
`closed-days.js`: on a closed day the After hours setup answers all day, the HOURS line says "closed today (<name>)",
and a CLOSED DAYS line lists the next 12 months so NovaAI can answer "are you open on …?". Training → Opening hours
shows the list read-only (edit it on the website); "Extra closed days for the phone only" adds dates for the phones alone.
