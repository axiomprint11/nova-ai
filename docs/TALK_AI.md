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
