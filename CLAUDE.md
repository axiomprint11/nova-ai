# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Axiom AI ("Nova") — an internal AI assistant for AxiomPrint, a print shop. Staff log in, paste a client
email or ask a question, and the app identifies the client, reads the shared order inbox, prices the job
against the live production database, and drafts a reply. It also exposes the production database to
external Claude clients over MCP.

Vanilla Node + Express serving vanilla-JS static pages. No framework, no bundler, no build step, no
test suite, and **not a git repository** — the running code on this box is the only copy.

## Running and deploying

Production and development are the same machine and the same files. There is no staging.

```bash
pm2 restart axiom-ai      # required after ANY server.js / mcp.js change
pm2 logs axiom-ai         # runtime errors, "Schema loaded: N tables", MCP mount line
pm2 list                  # axiom-ai is process 0 (design-tool is an unrelated app)

node create-user.js <username> <password>   # add a local admin account to users.db
```

Frontend files under `public/` need **no restart** — `serveVersionedHtml` (server.js:20) rewrites every
local `.js`/`.css` reference to `?v=<file mtime>` on each request, so a browser reload always fetches
fresh assets. Never hand-bump version query strings.

nginx (`/etc/nginx/sites-enabled/dbhub`) terminates TLS for `nova.axiomprint.com` and proxies everything
to `localhost:3000`. `.env` supplies `PORT`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `MYSQL_*`, `MCP_TOKEN`.

Because there is no VCS, the convention here is a manual timestamped copy before a risky edit —
`server.js.backup-2026-07-28-0107`, `order-assist.js.backup-...`. Follow it, and clean up stale ones.
`patch_turnaround.py` is an example of the other convention used for large frontend edits: a
verify-anchors-then-patch script that refuses to write if any anchor is missing.

## Two databases — know which one you are touching

| | Purpose | Access |
|---|---|---|
| `users.db` (SQLite, local) | App state only: users, members, chats, messages, agents, training_examples, knowledge_docs | Read/write, schema auto-created and auto-migrated at boot (server.js:51-166) |
| `axiomprint_new` (MySQL, remote) | Live production business data: estimates, customers, products, invoices, QR scans | **Read-only by convention** — everything goes through `runQuery()` (server.js:393) |

SQLite migrations are additive `ALTER TABLE ... , () => {}` calls that swallow the "duplicate column"
error — that is the intended idiom for adding a column, not a bug.

`schema.sql` is a 109-table mysqldump of the production schema, kept for reference. Do not run it.
It is **out of date** — check the live DB (MCP `describe_schema`) before trusting it. Known drift:
there is **no `invoiceestimate` table** (estimates link to invoices only by `estimate.estimate_invoiceid`,
and to projects by `estimate.estimate_projectid`); the `calls` table stopped in May 2024 — phone calls are
in `dialpad_calls` (count `DISTINCT conversation_key`, skip `call_type='internal'`); `email_from_system`
has `customer_id` and `sent_at`, and newer rows leave `created_at` NULL; `customer` has `discount_option_id` but **no
`discount_options`** column (selecting it made `discountFor()` fail silently — account discounts were off until 1.6.10). A client's "last order" in the
reports is their newest `project.created_at`.

## Authentication

JWT bearer tokens (30d) with two identity sources, resolved in `/api/login` (server.js:1684):

1. Local account in SQLite `users` → token key `user:<username>`.
2. Otherwise an AxiomPrint staff member: the username/email is resolved against the **MySQL `user`
   table**, its `password_hash` is bcrypt-compared (PHP `$2y$` prefix rewritten to `$2a$`), and the
   person must also exist and be enabled in the local `members` table → token key `member:<email>`.

`auth` gates every API route; `adminOnly` re-checks the live DB so a just-promoted member does not have
to re-login; `knowledgeGuard`/`knowledgeAccessLevel` implement the `none`/`own`/`all` Domain Knowledge tiers.
Per-member agent access is default-allow: no rows in `member_agents` means all active agents.

## The three AI surfaces

All model calls use `claude-haiku-4-5-20251001` and the Anthropic SDK client created at server.js:177.

**1. `/api/chat` (server.js:2384) — classic agentic loop.** SSE stream. Up to 10 iterations of
model → tool_use → tool_result. Ten tools: `query_database`, `get_client`, `show_client`, `get_product`,
`suggest_products`, `open_calculator`, `generate_quote`, `search_email`, `view_attachment`,
`view_job_files`. Several tools are *UI commands* — `show_client`, `open_calculator`, `suggest_products`
push an SSE event that the frontend renders as a widget, and the tool_result text tells the model not to
repeat the content in prose. The system prompt is cached (`cache_control: ephemeral`).

**2. `/api/flow` (server.js:1726) — the stepped flow, and the default UI path.** The frontend
(`runSteppedFlow`, order-assist.js:1457) drives a numbered sequence, gating each step behind user
confirmation. Only steps 1, 6 and 7 call a model; the rest are pure DB/Gmail lookups, which is what makes
it fast:

- `job_lookup` / step 1 — understand the request (step 1 fast-paths to job lookup on a bare `E1234567`)
- 2 identify client in CRM · 3 recent client emails · 4 job history · 5 product match — all deterministic
- 6 reason out every calculator field (model) · 7 new-client welcome reply (model) · 8 build quote (no model)
- `reorder` — decode a past estimate back into calculator selections

**3. `/mcp` (mcp.js)** — a hand-rolled Streamable-HTTP MCP server exposing `query_database`,
`describe_schema`, `get_job` to external Claude clients, authed by `MCP_TOKEN` in the URL path or a
Bearer header. Two constraints are load-bearing and commented in the file: it must be mounted **before**
the SPA catch-all (server.js:2991) or every request returns `index.html`, and the
`/.well-known/oauth*` 404 handler must stay, or Claude treats the endpoint as a broken auth server.

### System prompt assembly

`fullSystemPrompt = base + agentLayer + exampleLayer` (server.js:2528-2662). `DATA_DICTIONARY`
(server.js:716) is the authoritative schema guide injected into both `/api/chat` and MCP `describe_schema`
— **when you learn something new about the production schema or a data quirk, update DATA_DICTIONARY**,
that is how the models find out. `agentLayer` is admin-editable role/rules/workflow/knowledge text from
the SQLite `agents` row; `exampleLayer` is up to 6 good + 4 bad `training_examples` promoted from
thumbs-up/thumbs-down ratings via the admin UI. Both are per-agent and hot — no restart needed.

## Pricing engine — duplicated on purpose, keep in sync

AxiomPrint prices a job by substituting selected option values into a per-product `formula` string.
That evaluator exists **twice**, and the two must agree or the quote the model sends differs from the
number the widget shows:

- Server: server.js:400-715 (`evalFormula`, `loadCalc`, `priceWith`, `buildQuote`, `turnaroundDays`)
- Browser: public/order-assist.js:629-745 (`evalFormula`, `calcEnvBase`, `computePrice`)

Both tokenize the formula from variable titles, substitute `value`/`base`, zero out unknown identifiers,
and support `floor()`/`round()`. Product config lives in `product.formula`, `product_variables`,
`product_variable_item` (`default=1` is the preselected option, respect it) and
`product_variable_filters` (dependency rules referencing item ids, not names).

## Frontend

No framework. Global functions, `innerHTML` string templates, `esc()` for escaping, shared styling in
`axiom-shared.css`.
Money is always shown as `$1,678.54`: use `usd2(n)` (defined in server.js, client-bot.js, chatbot.js, axiom-cards.js,
order-assist.js and index.html), never `'$' + n.toFixed(2)`. The prompts tell the models the same.

- `index.html` — login + legacy all-in-one chat + admin panel, with its JS inline in the file
- `order-assist.html` + `order-assist.js` (~2700 lines) — the real product: stepped flow, calculator
  widget, quote boxes, reorder, file upload/paste, Drive thumbnails
- `admin.html` — members, agent training, knowledge docs, connection status
- `chatbot.html` + `chatbot.js` — the ChatBot page: chat on the left; client, cart, calculator and saved
  items in the right-hand pane
  The cart is switched off (`CART_ON = false` in chatbot.js): the price card's third button is **Save**,
  which files the product with every quantity quoted for it under **Saved**, at the top of the pane.
  Connecting a client re-prices every quote in the conversation — on screen, saved, and behind chat
  markers — via `repriceForClient()`; cards report new figures back through `AxiomCards` `onChange`, which
  keeps Saved, the markers and the draft in step. A card re-price sends only the specs the person asked
  for (`source` requested), so defaults and auto-linked fields resolve as they did the first time.
  **Order now links**: every priced quantity (price card, chat marker, Saved row, Draft table, drafted
  email, card Copy) can open the product on axiomprint.com with its options preselected.
  `POST /api/chatbot/order-links` builds `config.selections` keyed by the **exact** `product_variables.title`
  (underscores kept) → chosen item id (internal variables skipped; an unlisted quantity becomes
  `isCustomQuantity`), posts it to the product-shares API (`PRODUCT_SHARE_API`, default
  website.workroomapp.com) for a tracked `?shareId=` link on `product.url`, and falls back to an inline
  `?config=` link if that API fails. See `docs/NOVA_AI_URL_GENERATOR.md`. "Draft an email" is built from
  Saved (or the product on screen), not the cart.
  **Help to draft email** (Saved, beside "Send all to CRM", and under the calculator) drafts the reply
  *in the conversation* (`draftReplyInChat`). `POST /api/chatbot/draft-reply` writes only the words —
  subject, greeting ("Hi <first name>," when the client is known), intro, outro, sign-off — reading the last
  30 days of shared-inbox mail with the client's email (`gmailSearch`, quoted text stripped) for tone.
  The quote tables and Order now links come from Saved, so the model never retypes a price. The draft is
  stored with the chat as an `email_draft` card and is kept out of the model's history on reopen.
  **Attachments are saved**: a sent message's pictures (the browser's 1600px JPEG), PDFs and extracted document
  text go with `POST /api/chats/message` `files` → SQLite `chat_files` + `chat-uploads/` (gitignored; `CHAT_UPLOAD_DIR`;
  type checked by magic bytes) and `messages.files`; `GET /api/chats/:id` returns them with signed, 7-day links
  (`/api/chat-files/<ref>?e=&s=`, no bearer needed for `<img>`). The user row shows thumbnails / document chips; on
  reopen the last two messages with files go back to the model as image/document blocks.
  **Read-only view** `/chatbot?chat=<id>&view=1` (`VIEW` in chatbot.js): no top bar, sidebar or composer, every
  write to the chat refused in the page (a `fetch` wrapper; pricing look-ups, reports, order links and
  `/api/admin/train-from-chat` still go through), admins get "Use as a good example / Mark as a bad one" under each
  answer. CRM Chat → History opens a conversation in it (an iframe in the wide panel), so History looks like the chat.
- `widget.html` + `widget.js` — the CRM widget (framed by `embed.js`). It is the ChatBot page inside a
  compact header: `widget.html` repeats chatbot.html's split markup with the **same element ids** and loads
  `chatbot.js` with `window.NOVA_EMBED = true`, so Save, Saved, Draft and the client bar are the same code.
  `widget.js` is only the shell — CRM single sign-on, login form, recent chats, appearance settings,
  reopening the chat after a CRM page change (`NovaEmbedHooks.chat`), talking to the host page. The two
  scripts share one global scope: never declare a name in `widget.js` that `chatbot.js` already declares.
  The panel opens 1080×700 (server `WIDGET_DEFAULTS`; saved sizes from before `WIDGET_LAYOUT` 2 are reset);
  the pane shows above 700px wide, below that the client/cart bar sits on top and cards go inline.
- `prepress.html` + `prepress.js` — **orphaned**: it calls `/api/prepress/chat`, which does not exist in
  server.js. The `prepress-ai` agent is seeded as `coming_soon`.

The stepped flow is the default; `sendMessage(forceClassic)` or the `steppedToggle` checkbox falls back
to `/api/chat` for debugging.

**One chat agent.** Since 1.9.11 only `chatbot` (and `talk-ai`, a training target with access `system`) are live:
every other `agents` row is set to status `retired` at boot (rows kept so old chats keep their agent's name), hidden
from `/api/agents` and `/api/admin/agents`, and `/order-assist` / `/prepress` redirect to `/chatbot`. The main page
(`/`, after sign-in) lands on `/admin?tab=history&mine=1`: everyone's own chats (members only ever see their own;
admins can switch the user filter), "+ New chat" opens ChatBot, and a row of your own has "Continue in ChatBot"
(`/chatbot?chat=<id>`). The ChatBot page has no agent dropdown, just "← History" and the title. The Admin menu
has no Agents tab and Users has no per-member agents column: ChatBot's training opens from CRM Chat ("Train ChatBot",
`trainAgent('chatbot')`) and TalkAi's from its page (`/admin?tab=agents&agent=talk-ai`).

**One left menu.** `public/nova-nav.js` (`NovaNav.mount`) draws the same grouped menu on `/admin`, `/talk-ai` and
`/client-bot`: CRM Chat · Client ChatBot · TalkAi (each with its unread count) / Users · Domain Knowledge · Connectors /
Installation Pricing · Delivery Pricing and Templates (both "Soon"); at the bottom New chat and who is signed in (photo or
initial, name, email — from `/api/me`) with **Sign out** (`NovaNav.signOut()`: clears `axiom_token` / `axiom_user` /
`axiom_admin` from this browser and goes to `/`; a 401 from `/api/me` — the 30-day token expired or the member was
disabled — does the same). On admin.html it fills `#novaNav` and its tabs switch in
place (`onTab`); on the other two pages it moves the page into a column beside itself. Icons only at 761–1100px, a strip
across the top on phones. Members see CRM Chat and Domain Knowledge (when they have access). Pages update a count with
`NovaNav.set(key, n)`. CRM Chat read state (admins): SQLite `crm_chat_reads`; a chat someone else had is unread until
opened in CRM Chat (`/api/crm/unread-count`, `/api/admin/crm/chats/:id/read`, `/unread`, `/read-all`; History rows carry
`unread`, filter `rating=unread`). First visit counts everything older than 12 hours as read.

**Usage overviews.** CRM Chat (the History tab, renamed), TalkAi (Calls, right pane until a call is picked) and Client
ChatBot (Conversations, likewise) open with tiles (today / this week / this month vs the period before, plus a few of
the month's outcomes) and a Daily / Weekly / Monthly bar chart: `public/nova-stats.js` (`NovaStats.mount`) draws what
`GET /api/stats/crm` (chats started; members their own, admins all or the user filter), `GET /api/admin/talk/stats`
(phone calls) and `GET /api/admin/client-bot/stats` (website conversations with a message) return. `usage-stats.js`
buckets timestamps by Los Angeles day / Monday week / month.

## Nova for clients (customer-facing bot)

`client-bot.js` mounts a **separate** bot for axiomprint.com customers: its own SQLite tables (`client_chats`,
`client_messages`, `client_bot_rules` + `_history`), its own tokens (signed with a key derived from `JWT_SECRET`,
`kind:'client'` — staff `auth` rejects them), its own tools (no SQL; `newest_products` lists the newest public products by product id (not `product.created` — copies keep the old date), with a photo, without client-linked, ClientProduct-category, test/demo or "Copy of" products). The customer id always comes from the
session: `my_orders` / `order_status` filter on `estimate_clientid` themselves; products are limited to active
`axiom_print` products and `available_for_customers` is honoured. Admin console at `/client-bot` (Conversations is the first tab; Try it as any
customer, Conversations — read/unread per admin in SQLite `client_chat_reads`, Refresh, Unread filter, Mark as unread /
Mark all read, 👍/👎 per conversation with a "what wasn't right" note in SQLite `client_chat_ratings`, fed back into the
prompt by `lessonsLayer()` as AVOID notes + good examples and managed under Training → Lessons — Training, Setup); public page `/client-chat` for the website iframe. Admins only until
`CLIENT_BOT_PUBLIC=1`. Website sign-in: the header script reads the customer token from the site's saved
state (`tokenKey: 'axiom-print-app'`, JSON) and Nova verifies it with `CUSTOMER_VERIFY_URL` (default laravelapi
`/api/v1/customers/me`); a signed handoff (`CLIENT_SSO_SECRET`) also works. First name and the contact person (`manager`)
ride in the visitor token; the account record stays in memory only. Signed-in customers get their account discount on quotes
(quoteProduct `client_id`, as the staff chats); the cart is sent the pre-discount price. **Add to Cart** puts the item in the real website cart: `addToCart()` re-prices, builds the
`cart/add-item` payload in the website's own item shape (`cartPayload()`: catalog `GET /products/product-info/{id}`, `selectedOption` = full catalog option objects keyed by exact variable titles, every variable, plus printSides/customSize/sample fees — `docs/WEBSITE_CART_API.md`), creates the cart user on a 404, names the job
with `update-item`; `POST /api/client-bot/cart` (button) and the `add_to_cart` tool both use it; the admin preview only
returns the would-be payload. Full write-up: `docs/CLIENT_BOT.md`. Never give it a tool that takes a customer id or SQL.
`price_product` takes `quantities` — or `versions: [{name, quantity}]` for several designs of one size, priced as ONE
order through quoteProduct's `version_list` — and returns one card (`rows` of qty/price/cart data); `client-chat.js` merges cards
with the same product+options into a "Your quote" pane (≥800px) with Qty · Price · Add to Cart. Spec rows carry `tag`
(`specified` / `default` / `questionable` — questionable = a `clarify_for_ai` field left on its default, or no quantity
given). The bot prices first and never asks (prompt rule 9a, enforced with `tool_choice: price_product` after a product pick or
two unanswered questions — `forcePrice` in the chat handler); questionable fields are yellow dropdowns on the card (an
unstated quantity a yellow box) that re-price on change via `/api/client-bot/reprice`. Rows carry `turn` (the
schedule timeline); the card ends with "Estimated Ready: <day> · 5:00 PM" and a "?" that opens the staff calculator's
day-tile popup (shared `.sch-*` styles; `dueLine()` / `dueTip()` in client-chat.js, floating `.cc-due-pop`). Cards have **Edit**: `POST /api/client-bot/reprice` re-runs `priceCard()` (the same function the tool uses,
public options only, no model call) and saves a `role='note'` row that is folded into the model's next user turn.
**Attachments**: `POST /api/client-bot/upload` (raw body, token + limits checked before the body is read) →
`client-files.js` (type by magic bytes; sharp previews; a hand-written PSD decoder; PDFs and spreadsheets read in
`client-files-worker.js` with memory/time limits) → `client_files` rows + files in `client-uploads/` (gitignored,
never public). The chat sends `files: [ref]`; only the uploader's unsent files attach. History re-sends pictures/PDFs
for the latest two file messages within a byte/page budget; if the API refuses one, the files are marked `blocked`
and the answer is retried text-only. Admins get files at `/api/admin/client-bot/files/:ref{/preview}`. After an add the chat posts
`nova-client:add-to-cart {item:{alreadyAdded:true}}` so the website refreshes its cart count.
**Sign in from the chat**: the header's Sign in button (guests) opens the website login in a window (`loginUrl`), and the loader's
`followLogin()` (storage event + 2.5 s poll; `NovaClientChatAPI.loginChanged()`) signs the chat in when `axiom-print-app`
changes; if the site defines `NovaClientChat.login(email, password) → token`, an in-chat form is shown instead and the
credentials go only to the parent page (`nova-client:login` / `login-result`), never to Nova or the model. `resume()`
keeps the conversation on screen across a sign-in. Desktop: the window drags by its title bar (loader handle sized by
`nova-client:drag-area`; may go partly off screen, title strip kept reachable), resizes from edges/corners, and minimizes
("Back to chat" launcher); position + size in website `localStorage`. The loader also records how the visitor arrived (referrer, UTM, ad click ids; per tab session + first visit) and the chat
sends it with a new conversation (`client_chats.visit`); `visitor-info.js` turns it and the user agent into source / device
for the admin view. The loader reports the page (`nova-client:page`); user
messages store `page_url`/`page_title`, and `role='event'` rows (page moves, Add to Cart clicks with outcome) come
from `POST /api/client-bot/event` — shown in the admin transcript, never sent to the model. **The page they are on**: the product page the customer writes from (`/product/<product.url>`, the slug ends in
`-<product id>`) is resolved by `pageProduct()` (public products only, cached 10 min) and put in front of their message as
`[PAGE: …]` with the product's name, id, description and options (`pageNote()`; earlier messages get a one-line tag where the
page changed). Prompt rule 9c: "this / it / will it stick" with no other product named means that product. **Customer rating**: after the first answer the chat asks "How is NovaAI doing so far?" (1–5 stars; 3 or less asks "What could be better?"), once per conversation (remembered in the browser's `localStorage` `nova-rate-<chat>`; "×" = not now). `POST /api/client-bot/rate` (ownsChat) saves `client_chats.cust_rating / cust_note / cust_rated_at` (latest wins) and one `role='event'` rating line (updated in place for the note); the admin list shows "★ n/5", the conversation header the stars, the Rated filter (`rated=any|low`), and the overview a Customer rating tile. Separate from the team's 👍/👎 (`client_chat_ratings`). Product lists are shown once: `mergeProductList()` moves the model's
"- **Name** — desc" lines into the products card (desc under the name; else `oneLine(short_description)`) and leaves a
`[[products]]` marker where the list goes; past answers give the model the listed names and ids in its place. Customers see the assistant as **NovaAI** (sparkle mark, "AI" badge;
saved greetings saying "Nova" are shown as "NovaAI"). **History** (signed-in only): `GET /api/client-bot/history{/:id}`;
`ownsChat()` lets the same verified customer continue a chat from any device; `ClientChat.load(id)`. Voice typing: `public/axiom-voice.js` shows a recording bar (waveform, timer, Cancel/Done), records 16 kHz WAV and
posts it to `POST /api/client-bot/transcribe` → `speech-to-text.js` (OpenAI with `OPENAI_API_KEY`, or
`STT_PROVIDER=google`; never stored); with no service it falls back to browser SpeechRecognition behind the same bar
(`GET /api/client-bot/voice`). The staff ChatBot page and CRM widget use the same recording bar (`GET /api/voice`,
`POST /api/transcribe`, staff `auth`); `axiom-speech.js` is no longer loaded anywhere. Iframe `allow="microphone"`.
Order status answers use the deadline sentence from `deadlineFacts()` (approved date, turnaround, ready date, pick-up or shipping method — no payment, no transit time); turnaround questions are answered from axiomprint.com/pages/turnaround (`turnaroundInfo()`, daily, with a built-in fallback). Past-due jobs (`complete_by` < NOW(), not finished, not waiting on the customer) are escalated by the order tools:
NovaAI tells the customer, `escalatePastDue()` emails CLIENT_BOT_ESCALATE_TO (default gary@axiomprint.com) via `sendMail()`
(Gmail API, needs the `gmail.send` delegation scope), once per job per day (`client_escalations`). Graphic design: prompt rule 19 + `estimate_design` (hours from the editable guide × the hourly range, Training →
Graphic design services; `client_bot_rules.design / design_min / design_max`). Save with Nova coupon: prompt rule 18 from `couponRule(who, channel)` — SavewithNova10, 10% off (`CLIENT_BOT_WELCOME_CODE`), terms read
live from `promo_code`; ONE use per customer (`multiple_use = 0` means once per customer, not once overall — the website records a use as
`invoice.invoice_promo_code_id`, checked by `usedCoupon()`). It is the answer when a customer negotiates or asks for a discount; pitched
after a quote to guests and customers with no invoiced estimate (`hasOrdered()`); never offered to an account that used it ("you've already
used the Save with Nova coupon"). The phone prompt gets the same rule as its COUPON line.
It also has `get_template` (die lines of visible options; customer-specific dies only for that customer; PDFs streamed
by Nova through a signed `/api/client-bot/template/...` link) and `estimate_installation` / `estimate_delivery` (the
shared `InstallPricing` engine and live admin config via `getInstallPricing()`; customers see totals and line names,
not rates). Website loader: `public/client-embed.js` (header script; `window.NovaClientChat` config; handles
sign-in, cart-ready / add-to-cart and close over postMessage). Phones (<700px) get a full-width bar fixed to the bottom;
it moves the site's own bottom-pinned bars up by its height (`lift()`), and the open chat follows `visualViewport` so
the keyboard never covers it. Test / Live is an admin switch (Setup tab →
`POST /api/admin/client-bot/mode`, stored in `client_bot_rules.mode`, overrides `CLIENT_BOT_PUBLIC`); the loader reads
`GET /api/client-bot/mode` and in Test shows the chat only after `?nova=test`; test sessions need `CLIENT_BOT_TEST_KEY`
(passed as `?k=`) and carry `t:1`. The pane has **Quote** and **My projects** tabs: `projectCards()` builds website-style
job snapshots (invoice line, picture, E-number, size, qty, Preflight / Production / Pick up-Shipping-Installation steps
from `prepress_status`, `estimate_stage`, scans, `estimate_handle`), served by `GET /api/client-bot/projects` and the
order tools. Express 5 route syntax: optional segments are `{/:name}`, not `:name?` — the latter crashes at boot.

## TalkAi (NovaAI on the phone)

`talk-ai.js` answers the Twilio number with NovaAI. Twilio's voice webhook hits Nova (`POST /api/talk/twilio/voice`,
`X-Twilio-Signature` checked with `TWILIO_AUTH_TOKEN`), Nova calls ElevenLabs `register-call` and returns its TwiML;
ElevenLabs listens and speaks, and asks Nova for every answer as a **Custom LLM** (`POST /api/talk/llm/v1/chat/completions`,
OpenAI-style SSE, `TALKAI_LLM_KEY`). Nova answers with Claude and the client bot's own tools and rules —
`mountClientBot` returns `{ TOOLS, runTool, loadRules, turnaroundInfo, … }` for it — plus `verify_caller`
(order number + account email / ZIP / phone, or just email / ZIP when the number is on an account; order tools refuse until it passes), caller ID recognition before answering (`lookupCaller()`: greets by first name; a STIR/SHAKEN-verified number — Twilio `StirVerstat` Passed-A/B — skips the check, setting `talk_settings.caller_id`), `live_projects` (jobs by project in the live `estimate_stage` substages, "Mixed" when they differ), `take_message` (emails the team; `for_person` = someone asked for by name, found in the production `user` table by `team-directory.js` and sent the call summary after the call by `relayStaff()` in talk-handoff.js; once per call — a repeat only adds to the same message) and
`transfer_call` (Twilio REST redirect) and `email_quote` (the call's prices with Order now links + a link to the caller's page `/talk/c/<token>`, which shows the quotes and the conversation; prices kept in `talk_calls.quotes`). ElevenLabs system tools (end_call…) pass through as tool calls. After the call the
ElevenLabs post-call webhook (`/api/talk/hook/elevenlabs`, HMAC `ELEVENLABS_WEBHOOK_SECRET`; server.js skips its JSON
parser for `/api/talk/hook/`) stores the transcript, summary and MP3 (`talk-recordings/`, gitignored). SQLite `talk_settings`,
`talk_calls`, `talk_turns`, `talk_reads`. Opening hours pick the setup — Training shows three tabs, **Regular Hours Agent** (`regular`), **Regular Hours Team Missed** (`missed`, the missed-call number) and **After Hours** (`after`), each with its number, when it answers and the call steps (`paintLogic()`), then its greetings and rules (`talk_settings.hours/modes`). There is no "Who answers" choice any more: the page saves `answer: 'ai'` for every setup (an account manager's ring-first still rings them first via `/api/talk/twilio/after-dial`). Try it starts a test call only on "Start test call" or a first message, **languages** (follows the caller's language via ElevenLabs' language_detection tool; a returning number starts in its language with an ElevenLabs language override + that greeting; the key menu `/api/talk/twilio/lang` is off unless `TALKAI_LANG_MENU=1`), and **account managers** get their own NovaAI (`talk_lines`: own Twilio number and/or their clients on the main line by `customer.manager_id`, ring first with "press 1 to take it" so voicemail can't answer, notes, voice) — and when they call it from one of their own phones (`own_numbers`; carrier-verified or keypad PIN) it is their personal assistant (`ownerPrompt`/`ownerTools`: `my_calls`, `find_client`, `client_projects`, `job_status`, `email_me`). **Hand-off** (`talk-handoff.js`): Dialpad logs every call NovaAI answers as missed (clients dial the main line (747) 888-7777; Dialpad passes missed calls to the missed-call number and after-hours calls to the TalkAi number), so after each real call NovaAI answered (post-call transcript webhook) it writes an AI summary + callback yes/no (`talk_calls.ai_summary / callback / callback_reason`, Claude, from transcript + quotes + messages), emails the CSR team (`talk_settings.csr_to`, saved as a `talk_emails` row of kind `csr` — not counted as "Email sent"). Every email a call causes is a `talk_emails` row (`quote`, `message` = the take_message team email, `summary` = Setup's "email a summary of every call", `csr`, `relay`, `notes`) and the call page shows each one in the conversation where it went out (team ones under "After the call"), and ~90 s later POSTs the call to the CRM webhook (`talk_settings.webhook_url`, HMAC with `TALKAI_WEBHOOK_SECRET`, retried 1/5/30/120 min, `X-Nova-Delivery: talkai-call-<id>`) with a signed, expiring recording link (`/api/talk/rec/<id>/<exp>/<sig>.mp3`). Spec for the web team: `docs/TALKAI_CRM_WEBHOOK.md`. Admin: `GET/POST /api/admin/talk/calls/:id/handoff` (payload preview; rewrite summary, resend CSR / webhook). **Call ratings**: Good / Bad + a note per call (SQLite `talk_ratings`, `POST /api/admin/talk/calls/:id/rate`, one per call, latest wins) — `callLessons()` puts Bad notes into the phone prompt as AVOID lines and Good calls as short examples (LESSONS FROM RATED CALLS; cached a minute), the list shows a 👍/👎 tag. Admin page `/talk-ai` (Calls · Try it · Training · Account managers · Setup), linked after Client ChatBot
in the Admin menu with an unread badge. Full write-up: `docs/TALK_AI.md`.

## Bookkeeping AI (BookkeeperAI)

`bookkeeping.js` mounts `/bookkeeping` (+ `public/bookkeeping.html/.js`) for `BOOKKEEPER_USERS` only (default
gary@axiomprint.com; `/api/me` returns `bookkeeper`, the menu item is gated on it, not on admin). The agent **proposes**
(`bk_proposals` with confidence + reason, `bk_questions` below the threshold), a person **approves** (tab or Google Chat),
the executor applies (category → transaction + a vendor rule; bill draft → approved bill) and logs to `bk_audit`. No SQL
tools for the AI. The chart of accounts is a styled tree in `bk_settings.chart_json` (type of expense with color + icon → sub categories; `categories` text regenerated for the prompt): `chartTree()` / `chartOf()` / `categoriesOf()` / `addCategory()` / `renameCategory()`; edited in the Accounts tab (`POST /api/bookkeeping/chart`, `/chart/rename` follows a name into transactions, rules, vendors, pending proposals; a used sub category cannot be removed); pickers (`catSelect`) end with "+ New category…". Intake: Plaid `transactions/sync` (access tokens AES-GCM encrypted; webhook `/api/bookkeeping/plaid/webhook`
verified with Plaid's JWK over the raw body — that route is excluded from the JSON parser), the accounting inbox
(`BOOKKEEPER_INBOX`, same service-account key as order@, polled every `poll_min`, optional Pub/Sub push
`/api/bookkeeping/gmail/push?token=`), Claude reads PDF/image attachments into `bk_bills` (duplicates, new vendors and low
confidence become questions). The CRM `suppliers` + `vendors` tables are synced (read-only) into `bk_vendors` (`source`, `crm_id`, `photo`, `kind` = the type (the CRM list, read-only; `BOOKKEEPER_CRM_LISTS` adds lists), synced on tab open (10 min), hourly and daily, aliases, default_category; `name` is NOT unique — a company can be in both lists); `matchVendor()` links bank lines / bill senders by name, alias or email domain and the AI gets the directory as context. The CRM `materials` catalog (with `geo_type` / `geo_sub_type` names and `team` names for `department_ids`) is mirrored into `bk_materials` on the same sync; `materials.supplier` is free text, linked to the directory by `supplierFor()` until the CRM adds a supplier id; the AI gets what each vendor supplies + a GEO TYPES line and a read-only `materials` tool. Daily run at `run_at` (LA) builds `bk_briefs` and posts to Google Chat — a space webhook
(post only) or a Chat app (`/api/bookkeeping/chat/events`, JWT audience `BOOKKEEPER_CHAT_AUDIENCE`; only
`BOOKKEEPER_CHAT_USERS` may act). `BOOKKEEPER_CLOCK=0` disables the clock. Full write-up: `docs/BOOKKEEPING_AI.md`.

## Installation & local delivery pricing

Separate from the product formula engine, and **not** duplicated: `public/install-pricing.js` is one UMD file
that `server.js` requires and the browser loads. Every rate lives in the config it is given — never put a price
in code. The live config is the single row of SQLite `install_pricing` (history in `install_pricing_history`),
cached in memory as `installPricing`, edited in Admin → Installation Pricing (`GET /api/install-pricing` for any
signed-in user; `POST /api/admin/install-pricing` and `/restore` for admins). Missing keys fall back to
`DEFAULTS`, which mirror `docs/install-pricing-training.md`.

In `/api/chatbot/chat` the `quote_installation` / `quote_delivery` tools price with it and send an
`install_quote` SSE event carrying the input, the quote and the config; `public/install-calc.js` renders it as
an editable calculator by `chatbot.js` (the ChatBot page and the CRM widget). If a turn asks for an install/delivery price and
the model never called the tool, an empty calculator is sent anyway. Tool enums (materials, equipment,
insurance, traffic) and the prompt's hand-off thresholds are built from the live config.

Distance and drive time are always measured from the shop (`origin` in the config) by `routeLookup()` in
server.js, exposed as `GET /api/route` and called by the tools whenever an address is given. With
`GOOGLE_ROUTES_API_KEY` in `.env` (or `GOOGLE_MAPS_API_KEY`) it uses the Google **Routes API** `computeRoutes`
(`TRAFFIC_UNAWARE`, or `TRAFFIC_AWARE` with Google's prediction when a future date and time are known). If Google
refuses (key restriction, billing, outage) it logs `ROUTE google failed` and falls back to OpenStreetMap. Without a key,
OpenStreetMap (Nominatim + the public OSRM server) for road miles and road time, with the admin
traffic factors applied. Results are cached in memory for 6 hours. On the ChatBot page the calculator opens
in the right-hand calc pane (`showInstallInPane`) with a live "Estimated price is $…" line in the chat; the
CRM widget uses the same pane whenever it is wider than 700px.

## Reports

`reports.js` (server) defines Nova's reports — `client_followup`, `top_clients`, `unpaid_invoices`, `product_sales` —
as parameterised, read-only queries that all return one table shape (controls, range, summary cards, columns,
filters, rows, method, notes). `GET /api/reports` lists them; `POST /api/reports/:id {params}` runs one. In
`/api/chatbot/chat` the `run_report` tool runs a report and sends a `report` SSE event; `public/nova-report.js`
draws it as a compact card (right-hand pane, or inline when the window is too narrow for it) with a full-screen view. Changing a
report setting re-runs it; search, filters and sorting are client-side. Saved chat messages keep only the
report's settings (`NovaReport.toSaved`) and re-run it on reopen.

`calls`, `email_from_system` and `invoice` have no index on their date column: date-bounded queries first find
an id floor by binary search on the primary key (`idFloor()`), then filter on the date as well. Keep that
pattern for any new report over a large log table. To add a report, add an entry to `REPORTS` with
`normalize()` and `run()`; the tool description, the endpoints and the viewer pick it up automatically.

## Known quirks worth respecting

- **Canceled jobs** are `estimate_stage` = `complete` + `estimate_substage` = `canceled`. They keep their old prepress /
  production status, lose `estimate_invoiceid`, and their invoice stays only on the project (`invoice_projectid`, total 0,
  `payment_status` may still say paid). The client bot's `projectCards()` marks them CANCELED, `my_orders` returns
  `latest_order` = newest job that is neither canceled nor a quote, and the staff job card / hover use `boardStatus()`.
- **Office hours are company data, not the TalkAi routing hours.** `office-hours.js` (SQLite `company_info`, key
  `office_hours`; Admin → Domain Knowledge → Company info; `GET /api/office-hours`, `POST /api/admin/office-hours`)
  holds what customers are told (default Mon–Fri 9–6, Sat 10–2, Sun closed + a note); `officeHours.line(closedDays)`
  is an OFFICE HOURS line in the CRM Chat, website chat and TalkAi prompts (the only hours they may state). TalkAi's
  `talk_settings.hours` (8:00–6:55) only decides which setup answers — the phone is answered 24/7 — and reaches the
  prompt as an internal TEAM AVAILABILITY line, never as opening hours.
- **Closed days come from the production `holidays` table** (the website's "Closed days" panel), not a hard-coded
  list. `closed-days.js` expands each row (one-off, or `recurrence` yearly / monthly / weekly) into dates for last
  year .. three years ahead, keeps them in memory and reloads hourly. `usHolidays(year)` in server.js returns those
  dates (the old built-in federal list only until the first load), so every business-day count — quote timelines,
  due dates, `calculate_turnaround`, the client bot's "Estimated Ready" — skips them. The CRM Chat, client bot and
  TalkAi prompts get the next 12 months as a CLOSED DAYS line; TalkAi treats a closed day as After hours all day
  (plus any phone-only extra dates in Setup). `GET /api/closed-days` lists them.
- **Artwork specs are per product**: `product.safe` (safe area), `product.bleed`, `product.dpi`. Safe and bleed are
  inches as TOTALS across a dimension (0.25 = 0.125 in per edge; a 3.5×2 card with 0.25 bleed is a 3.75×2.25 file);
  0 = none. `artwork-specs.js` (`artworkSpecs()` / `artworkLine()`) turns them into per-edge sentences for the client
  bot's `product_details` (`artwork`), the `[PAGE]` note, and staff `get_product_options`. Rule: a specific product's
  values beat the general artwork guide (Domain Knowledge doc), which is only for general questions (client rule 11c,
  TalkAi ARTWORK SPECS line, staff prompt). Domain Knowledge docs reach the website chat when shared with the
  `client-bot` agent ("Client ChatBot", access `system`) by name (`loadClientTraining()`); Word files are read by
  `docxText()` (mammoth if installed, else word/document.xml via xlsx's CFB).
- **`estimate.production_status` is stale.** True production state is the newest `qr_scan_history` row
  for that `estimate_id`. This is stated in DATA_DICTIONARY and enforced in the `get_job` MCP tool.
- **"Related to" rules** (`product_variable_filters`) decide when a field or option exists at all — Scoring on Book
  Dust Jackets only with 100# Gloss Cover. `relatedRules(pids)` (server.js) turns them into sentences; the staff
  `get_product_options` / `find_option` return them as `only_when` / `related_to_rules`, `calculate_price` reports
  requested options a rule dropped as `not_applied`, and the client bot's `product_details` gives the public ones as
  `conditions`. Answers about an option must state its condition. `get_product_options` also flags fields the
  product formula never mentions (`not_in_price_formula`) — those cost nothing on the site whatever their values say.
- **Number fields** (`product_variables.type = 'number'`, no items — Pages_Per_Set on Document Copies #362, Die_Fee…)
  are typed-in numbers the formula uses directly. `quoteProduct` fills them from `options` by name or name prefix
  ("Pages" → Pages_Per_Set) or `numbers` {variable_id: n} (card re-prices), as whole numbers; not given, the field's
  CRM Default (`product_variables.default_value`; a count left on it is flagged to confirm). They show as spec rows
  with `isNumber`; Order now links carry them as raw values (`"Pages_Per_Set": 120`); the website cart payload does not yet. Options with the **same title twice** (Document Copies' two "Full Color",
  one per side count, split by a Related-to rule) resolve to the twin the other choices allow.
- **Plain printing** of pages / sheets / documents (no booklet or other product named) is Document Printing & Copies:
  the client bot's `search_products` adds "document copies" and ranks it first (`PLAIN_PRINT` / `BOUND_PRODUCT`), and
  prompt rule 9d (TalkAi: the EVERYTHING THEY SAID line) says to price with every spec said anywhere in the
  conversation — a page count goes in the pages field, never quantity. `priceCard` matches a choice exactly, then by
  its leading number ("120" → "120 (Cover=4, Inside=116)"), then the one choice containing it; it tells the model when
  the asked quantity is below the product's smallest.
- **Order quantity lives in `estimateoption`** (`estimate_option_name='Quantity'`), not
  `invoiceestimate.invoice_estcount`, which is often 0. Sizes are often internal numeric codes.
- Job number `E1169106` = `estimate.id` 1169106. Strip the `E`.
- SQL in server.js is **string-concatenated**. Every interpolated value must go through `parseInt()` or
  `mysql.escape()` — match the surrounding code, do not introduce a raw interpolation.
- `mcp.js` enforces read-only SQL via `assertReadOnly()`. The `/api/chat` `query_database` tool does
  **not** — it relies on the system prompt. Add the guard rather than assuming it exists.
- Google Gmail/Drive access is read-only, via the `gmail-key.json` service account using domain-wide
  delegation to impersonate `order@axiomprint.com` (server.js:180-209).
- Clients are always the **external** party; any `@axiomprint.com` address is staff and is explicitly
  filtered out when extracting a client email (server.js:1809).
