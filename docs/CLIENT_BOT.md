# Nova for clients — the customer-facing ChatBot

A second Nova, separate from the staff ChatBot, for customers on axiomprint.com.

- **Anyone** can ask about products, options and prices, and get an "Order now" link with the options preselected.
- **A signed-in customer** can also ask about **their own** orders and quotes: status from the latest
  production scan, shipped / ready-for-pickup, options, quantity, what they paid.
- Nobody can reach another customer's data.

Admin console: **https://nova.axiomprint.com/client-bot** (Admin → Client ChatBot). Tabs:
**Try it** (chat as an anonymous visitor or as any customer), **Conversations** (every conversation, with who it
was), **Training** (house rules, knowledge, greeting, hand-off contact, with version history), **Setup**.

Code: `client-bot.js` (server), `public/client-chat.js` (the chat), `public/client-bot.html` + `client-bot-admin.js`
(console), `public/client-chat.html` (the page the website embeds).

## How other customers' data stays out of reach

This is enforced in code; the prompt rules are a second layer.

| Guard | Where |
|---|---|
| No SQL / database tool. Fixed tools only: `search_products`, `product_details`, `price_product`, `get_template`, `estimate_installation`, `estimate_delivery`, `my_orders`, `order_status`. | `TOOLS` in client-bot.js |
| The customer id comes from the verified session. The order tools add `estimate_clientid = <session customer>` (and the linked invoice must be theirs and not void). The model cannot pass a customer id. | `ownOrdersSql()` |
| An order number that is not theirs returns "not on your account" — the same answer as one that does not exist. | `order_status` |
| Products: only active products listed for the `axiom_print` site; products reserved for specific customers (`available_for_customers`) only show to those customers. | `publicProductWhere()` |
| Visitor tokens are signed with their own key and carry `kind: 'client'`; the staff `auth` middleware rejects them, so they open no staff endpoint. | `CLIENT_KEY`, server.js `auth` |
| The conversation history the model sees is loaded from the server. A chat id only continues a conversation that belongs to the same visitor and the same customer. | `/api/client-bot/chat` |
| Limits: 25 messages / 10 min per visitor, 60 per address, 30 new sessions / 10 min per address, a daily cap on public messages (`CLIENT_BOT_DAILY_CAP`, default 3,000); messages capped at 2,000 characters. | `rateLimited()`, `overLimit()` |
| Prices use only the options customers can see on the website: hidden / internal fields and hidden choices are neither selectable nor shown; a choice that redirects to another product is re-checked. | `publicOptions()` |
| Attachments: checked by their first bytes (not the name), 25 MB each, 5 per message, 20 uploads / 10 min per visitor and 40 per address, 300 MB a day per sender and 2 GB in total. A file can only be attached by the visitor who uploaded it; visitors can never download files — only admins, from Conversations. Spreadsheets and PDFs are read in a separate worker with a memory and time limit. | `/api/client-bot/upload`, client-files.js |
| Edit on a quote reprices through the same public-options filter as the tool (30 / 10 min per visitor). | `/api/client-bot/reprice`, `priceCard()` |
| Every page load starts signed out; only a fresh sign-in from the website upgrades it, and visitor tokens last 2 hours. | client-chat.html |
| Until `CLIENT_BOT_PUBLIC=1`, only Nova admins can use it (preview). | `identify()` |

The fixed safety rules are shown read-only in the Training tab; the house rules and knowledge are editable and
cannot switch them off.

## Environment (`.env`)

| Variable | Meaning |
|---|---|
| `CLIENT_BOT_PUBLIC=1` | Open it to website visitors. Leave unset while testing — admins only. |
| `CLIENT_SSO_SECRET` | Shared secret for the signed sign-in handoff (option A). |
| `CUSTOMER_VERIFY_URL` | The website API's "who am I" for a customer token. Default `https://laravelapi.axiomprint.com/api/v1/customers/me`. |
| `CLIENT_CART_API` | The website cart API. Default `https://website.workroomapp.com/api/v1`. |
| `CLIENT_BOT_MODEL` | Optional model override (default: the light model used elsewhere). |
| `CLIENT_BOT_DAILY_CAP` | Most public messages per 24 hours (default 3000). |
| `CLIENT_BOT_REPRICE_DAILY_CAP` | Most quote edits per 24 hours (default 5000). |
| `CLIENT_BOT_UPLOAD_DIR` | Where attachments are kept (default `client-uploads/` next to server.js — not public). |
| `CLIENT_BOT_UPLOAD_MB_DAY` | Total attachment megabytes accepted per 24 hours (default 2048). |
| `CLIENT_BOT_UPLOAD_DAYS` | Days attachments are kept (default 90). Files never sent with a message go after a day. |

## Putting it on the website — the header script

Paste into the `<head>` of axiomprint.com (every page):

```html
<script>
  window.NovaClientChat = Object.assign(window.NovaClientChat || {}, {
    testKey: 'PASTE_CLIENT_BOT_TEST_KEY',   // test mode — remove this line when going live
    tokenKey: 'axiom-print-app'             // where the website keeps the customer's login
  });
</script>
<script src="https://nova.axiomprint.com/client-embed.js" defer></script>
```

It adds the chat launcher:

- **Desktop** — an **Ask NovaAI** button (with the AI sparkle) in the bottom-right corner; the chat opens as an 876 × 620 panel (chat on the
  left, "Your quote" on the right). Product suggestions list one per line: the best four, then **Show more products**
  (up to 12).
- **Phone** (under 700px) — a **full-width bar fixed to the bottom** of the screen ("Ask NovaAI · Chat ›"). Tap it and
  the chat opens full screen, sized to the visible area so the keyboard never covers the message box. Anything the
  site pins to the bottom of the screen (the sticky **Order Now / Add to Cart** bar, a cookie notice) is moved up above
  the bar automatically, and the page gets matching space at the end, so nothing is covered. Big overlays (menus,
  cart drawers) are left alone and open above the bar.

**Test mode** — with `CLIENT_BOT_PUBLIC=test` and `CLIENT_BOT_TEST_KEY=…` in Nova's `.env`, and the same key as
`testKey`: the button only appears in a browser that opened any page with **`?nova=test`** once (remembered;
`?nova=off` hides it again). Everyone else sees nothing, and the chat refuses sessions without the key. The key is
visible in the page source, so treat test mode as "hidden", not "secret" — the rate limits and daily cap still apply.
Test conversations show under Conversations as Website.

**Going live** — set `CLIENT_BOT_PUBLIC=1`, restart, and remove `testKey` from the snippet.

Optional settings in `window.NovaClientChat`:

| Setting | What it does |
|---|---|
| `signin: { payload, sig }` (or a function returning it) | Signed-in customer, option A below. |
| `customerToken: 'token'` (or a function) | Signed-in customer, option B below. If neither is given, the script looks for a customer token in the site's `localStorage` (`customer_token`, `access_token`, `token`, `auth_token`, or `tokenKey`). `customerToken: false` turns that off. |
| `login: async (email, password) => token` | Optional: turns on the email/password form inside the chat (see *Signing in from the chat*). |
| `onSignedIn: () => {}` | Optional: called after the customer signed in through the chat's login window. |
| `loginUrl` | Login page the chat's Sign in opens (default https://axiomprint.com/login). |
| `onCartChanged: () => {}` | Optional: called after Nova added something to the cart (the site's own listener already refreshes the count). |
| `position: 'left'` | Desktop button on the left. |
| `lift: false` | Phone: don't move the site's sticky bars up (then place them yourself). |
| `liftSelector: '.sticky-cart'` | Phone: also move these elements up, if the automatic check misses one. |
| `barTitle`, `barText` | Phone bar wording (default "Ask NovaAI" / "Prices, options, files & your orders"). |
| `zIndex: 999` | Stacking of the launcher (default 999 — under the site's own pop-ups). |

`NovaClientChatAPI.open()` opens the chat from any link or button on the site; `NovaClientChatAPI.refresh()` re-checks
the sticky bars after the page rearranges them; `NovaClientChatAPI.loginChanged()` re-reads the website login now.

The chat has a **microphone** button for voice typing (`public/axiom-voice.js`). Tapping it turns the message box
into a **recording bar** — Cancel, a red dot and timer, a live waveform, Done (✓). Nothing is typed while the customer
talks; on Done the words go into the box to check and send. Two minutes at most (it finishes by itself).

- **Server transcription (recommended):** the browser records the microphone itself (16 kHz mono WAV) and posts it to
  `POST /api/client-bot/transcribe` (visitor token; 4 MB; 30 per 10 min per visitor, 60 per address, daily cap).
  `speech-to-text.js` sends it to the service set in `.env` and returns the text. **Recordings are never stored.**
  - `OPENAI_API_KEY=…` → OpenAI `gpt-4o-mini-transcribe` (`STT_MODEL` to change; about $0.003 a minute). A print-shop
    word list (coroplast, Gatorboard, 16pt, saddle stitch…) is sent as a hint.
  - `STT_PROVIDER=google` → Google Cloud Speech-to-Text with the existing service account (`gmail-key.json`); the
    Speech-to-Text API must be enabled, with billing, on that account's Google Cloud project.
- **Without either:** `GET /api/client-bot/voice` says `server:false` and the chat uses the browser's own speech
  recognition behind the same bar (Chrome, Edge, Safari): it restarts when the browser stops on a pause, and Android's
  repeated growing phrases ("looking", "looking for"…) are merged. Firefox then has no mic button.

The frame is loaded with `allow="microphone"`; the browser asks the customer once. The message box stays one line
(shorter hint on narrow screens) and grows as the customer types.

## Recognising a signed-in customer

The website tells the chat who is signed in; Nova verifies it and loads the customer from `axiomprint_new.customer`.
Nothing the visitor types is ever taken as proof of identity.

### How it works on axiomprint.com (live)

The header script sets `tokenKey: 'axiom-print-app'` — where the website keeps the customer's login. That entry is the
site's saved state (JSON); the script finds the token inside it (`token`, `access_token`, `accessToken`, …) and posts
`{ type: 'nova-client:signin', customer_token }` to the chat when it opens, or `nova-client:signout` for a guest. It then
keeps watching that entry (the browser's `storage` event, and a check every 2.5 s while the chat is open), so logging in
or out on the website — in this tab or another — signs the chat in or out without a page refresh.

Nova checks the token on its server — never trusting it by itself:

```http
GET https://laravelapi.axiomprint.com/api/v1/customers/me      (CUSTOMER_VERIFY_URL; this is the default)
Authorization: Bearer <customer_token>
```

200 → signed in (`data.customer`); 401 → a guest. The email must match that customer in our database. The customer id
comes only from this answer. The token itself is never stored, logged or shown.

What a signed-in customer gets: greeted by first name ("Hi Gus! …", header "Signed in as …"); their own jobs
(`my_orders`, `order_status`: status from the latest production scan, shipped / pickup, options, quantity); their
contact person (`get_customer` → `manager` from the website account, else `customer.manager_id` in our database);
Add to Cart straight into their website cart. Guests get products, options and prices; anything that needs an account
gets the sign-in message (https://axiomprint.com/login, then refresh).

Signed-in customers see their **account discount** on every quote — the same rule the staff chats use (`discountFor`,
via quoteProduct's `client_id`): the regular price struck through and their price beside it. Nova never quotes the
percentage. The cart is sent the price before the discount (as the website's cart API expects); the website applies
the account pricing there.

### Signing in from the chat

A guest sees a **Sign in** button in the chat's top bar (beside the close button; it reads "Signing in…" while the
website's login window is open). Signed in, it gives way to **History**. It works in one of two ways; the conversation on screen is kept either way, and the greeting
switches to "Hi <first name>!".

1. **Login window (works today, nothing to build).** Sign in opens the website's own login page
   (`loginUrl`, default https://axiomprint.com/login) in a small window — opened by the chat inside the click, so
   pop-up blockers allow it (if the browser still refuses, the page opens it, or goes to the login page). When the website saves the login in
   `axiom-print-app`, the header script sees it, signs the chat in, closes that window and calls `onSignedIn()` if the
   site gave one. Because it is the website's own login, the customer is signed in on the website too.
2. **Email and password inside the chat (needs one function from the website).** If the website sets
   `window.NovaClientChat.login = async (email, password) => token`, the button opens a small form in the chat instead.
   The form sends the email and password **only to the website page** (postMessage, locked to the website's origin) —
   never to Nova's server and never to the AI. The website's function logs in exactly as its own login form does
   (saves the token, updates its header/cart), and returns the token (a string, or `{ token }` / `{ access_token }`); it
   throws or rejects with a readable message on a wrong password, which the form shows.

What to give the website developers:

```js
window.NovaClientChat = Object.assign(window.NovaClientChat || {}, {
  tokenKey: 'axiom-print-app',
  // Optional — in-chat email/password form. Use the site's normal login code so the header updates too.
  login: async (email, password) => {
    const r = await siteLogin(email, password);      // the website's own login call + store update
    return r.token;                                  // throw new Error('Wrong email or password') on failure
  },
  // Optional — after a sign-in done from the chat's login window, refresh the site's header / cart count.
  onSignedIn: () => { /* e.g. reload the user store, or location.reload() */ },
  loginUrl: 'https://axiomprint.com/login',          // optional, this is the default
});
// Optional — after the site's own login or logout, tell the chat straight away (it also notices within 2.5 s).
window.NovaClientChatAPI && NovaClientChatAPI.loginChanged();
```

Nova never asks for a password in the conversation; the AI cannot see the form.

### Option A — signed handoff (alternative)

The website's **server** signs the logged-in customer with the shared secret. Nothing secret reaches the browser.
The email must match that customer's email in our database, and each signed payload works once.

```php
$p = base64_encode(json_encode([
    'customer_id' => $customer->id, 'email' => $customer->email, 'name' => $customer->name,
    'ts' => time(), 'nonce' => bin2hex(random_bytes(16)),
]));
$sig = hash_hmac('sha256', $p, env('NOVA_CLIENT_SSO_SECRET'));   // same value as CLIENT_SSO_SECRET
```

Pass it as `window.NovaClientChat.signin = { payload: '…', sig: '…' }`.

Only `https://axiomprint.com` and `https://www.axiomprint.com` may send a sign-in to the chat page, and only those
sites may frame it.

## First-order coupon (SavewithNova10)

NovaAI's coupon is **SavewithNova10 — "Nova Chat Coupon", 10% off a first order** (no minimum, one use, valid until
October 2, 2027, entered at checkout). The terms are read live from `promo_code` (cached an hour), so a change on the
website changes what NovaAI says; an expired or deleted code is never offered. Another code: `CLIENT_BOT_WELCOME_CODE=…`.

- **Anyone who asks** about coupons, promo codes, discounts or deals is given it (as 10% off their first order).
- **First-time customers** (guests, and signed-in customers with no invoiced order) also hear it as a sales nudge: one
  short line after their first quote, again if they hesitate about price or say they will think about it, and when they
  are ready to order (Add to Cart → checkout). At most twice per conversation unless they ask; never pushy.
- **Returning customers** are not pitched it; if they ask, they get it with "for a first order".

NovaAI never invents or shares other codes and never says it combines with other discounts. Quotes show prices before
the code.

## Estimated ready date and its popup

Every quote ends with **Estimated Ready: Wed, Oct 14 · 5:00 PM** and a small **?** — the same line and popup as the staff
calculator. The ? opens a row of day tiles: Approved, Start Day, Day 1, Day 2 …, weekends and holidays greyed out
("not counted"), and the Ready day in purple, under "7 BUSINESS DAYS · PRODUCTION TIME ONLY", with the note "If
approved today before/after the 5PM cutoff. Counting starts the day after the start day; weekends and holidays don't
count. Shipping time comes after the due date." Hover on a computer; tap to open and close on a phone; it always
stays inside the window. The timeline is the same `buildTimeline()` the staff calculator uses, sent with each quote
row as `turn`. Same-day turnarounds say "Same day — the team confirms the time".

## Newest products

"What's new?" and similar questions call the `newest_products` tool: up to 12 products, newest first by product id (the order the CRM product list uses; `product.created` is not used because a copied product keeps the original's date), shown in the usual products list (photo, name, description, tap to price). Only products every visitor can see: active, on axiomprint.com, with a photo, not made for a customer (`available_for_customers` empty, and not in the **ClientProduct** category), and no test, demo or "Copy of …" products. A signed-in customer's own products are not listed here either. Prompt rule 11b tells NovaAI to use it instead of saying there is no list of new products. A question that plainly asks what is new ("Any new products?", "what's new", "latest items") also forces the tool (`tool_choice`, like `forcePrice`), so the model cannot skip it.

## Product lists: one list, not two

When NovaAI suggests products, the customer sees ONE list: photo, name and a one-line description under it (tap to
price, ↗ for the page). The model is told not to list the products again in its text. If it does anyway
(`- **Vinyl Banner** — durable vinyl`), `mergeProductList()` moves each line that names a product on the card into
the card as that product's description, keeps the model's order, and leaves a `[[products]]` marker so the list is
drawn where the lines were — intro above, question below. Products without a description from the model show the
first sentence of their website short description. The model later reads the marker as the products shown, in order,
with their ids, so "the second one" still works.


Each product in a search list carries a small **"70% match"** badge (green 75+, yellow 60+, grey below), worked out like the
staff chat's: the share of the customer's words the product covers (name or keywords), whether its name carries them, and
its orders in the last 12 months against the busiest product in the list. The list is sorted by it.

**Several products in one message** (rule 9b): NovaAI numbers them, starts with the first and shows only that one's list —
a second search in the same answer is refused by the tool (`not_shown`). The next product follows after the first is priced
or added to the cart (see Add to Cart).
## Conversations: read / unread, Refresh

The Conversations list works like a phone's messages. An unread conversation has a **blue dot** and a bold name;
opening it marks it read, and it turns unread again when the customer writes something new. Read state is per admin
(SQLite `client_chat_reads`: chat, admin, read time) — what you have read does not hide anything from a colleague. On
an admin's first visit everything older than 12 hours counts as read. **Unread (n)** filters to unread only; **Mark all
read** clears the dots; **Mark as unread** (top of an open conversation) puts the dot back. **Refresh** loads the
newest chats and the open conversation's newest messages; the list also refreshes itself every minute while the tab
is open ("Updated … ago" under the filters).

## Thumbs up / down and lessons

Every open conversation has a **👍 / 👎** bar at the top. 👍 saves straight away and offers an optional note ("what was
good"); 👎 opens a box for **what wasn't right**. The rating shows as a badge in the list; **Edit** changes the note, and
clicking the active thumb again clears the rating. Ratings live in SQLite `client_chat_ratings` (one per chat: rating,
note, active, who rated, when).

Ratings feed NovaAI's future answers through a **lessons layer** added to the system prompt (`lessonsLayer()`, cached
60 s and refreshed on every change):

- **AVOID** — up to 15 active 👎 ratings with a note, each written as the note plus the customer's first question for
  context.
- **GOOD EXAMPLES** — up to 4 active 👍 conversations, as the first customer message and NovaAI's first answer.

**Training → Lessons from rated conversations** lists them all, with **Use in answers** (on/off without deleting),
**Open conversation** and **Remove**. A 👎 without a note is kept for the record but teaches nothing — write the note.

## Past-due escalations

`my_orders` / `order_status` flag a job **past due** when its due time (`estimate.complete_by`, compared with the database's
own clock — both Los Angeles time) has passed and it is not finished or on its way (quotes and cancelled jobs never are).
The customer's job card shows "Past due · was due …" in red.

- **Past due and not waiting on the customer** → the tool tells NovaAI to say: *"It seems like this order is past due. I'm
  escalating it right away so we can get you an updated turnaround time."* (no old date, no new promise), and
  `escalatePastDue()` emails the job at once to `CLIENT_BOT_ESCALATE_TO` (default **gary@axiomprint.com**): customer,
  company, email, phone, account manager, what they asked, product, size, quantity, due date and days late, the three
  status steps, invoice, a CRM link and a link that opens the conversation in Nova (`/client-bot?chat=<id>`). Reply-To is the
  customer. At most one email per job per 24 hours (`client_escalations`); admin previews never send.
- **Past due but waiting on the customer** (files to upload, proof to review, re-upload) → no escalation; NovaAI says it is
  waiting on that step.
- Conversations shows an orange "⚠ Past due — escalated" line (email sent / already escalated today / red "email NOT sent"
  with the reason).

**Sending email** uses the Gmail API as order@axiomprint.com (`sendMail()` in server.js; `MAIL_FROM` changes the sender).
Google must allow it once: Google Admin → Security → Access and data control → API controls → **Manage Domain Wide
Delegation** → the service account's client ID (`client_id` in `/opt/axiom-ai/gmail-key.json`) → **Edit** → add
`https://www.googleapis.com/auth/gmail.send` to the existing scopes (keep `gmail.readonly` and `drive.readonly`) → Authorize.
Then Setup → **Send test email**.

## Graphic design services

NovaAI cannot design or edit files. When a customer asks for design, a new piece of artwork or a change to a file
(prompt rule 19), it says so, offers AxiomPrint's in-house designers at the hourly range, splits the request into
pieces with hours from the **design guide**, and calls `estimate_design` (`pieces: [{task, hours_low, hours_high}]`).
The tool works the money out — total low hours × lowest rate to total high hours × highest rate, e.g. 3–5 hours at
$65–$86 = **$195–$430** — so the model never does the arithmetic. It then offers to price the printing too, and points
to the hand-off contact to go ahead with design.

Everything is edited in **Training → Graphic design services**: lowest and highest hourly rate and the guide (one line
per kind of job with its hours). Stored in `client_bot_rules` (`design`, `design_min`, `design_max`; earlier versions in
the history), used from the next message. Empty fields fall back to the defaults ($65–$86 and the starting guide in
`DEFAULT_DESIGN`).

## Languages

NovaAI answers in the language of the customer's latest message (prompt rule 1a): Armenian, Spanish, Russian, Arabic,
Farsi, Kurdish or any other. Tools still work in English (search terms, option names), and product names, options,
prices, links and the coupon code stay as the website has them; the quote cards and the chat's own buttons are English.
Arabic-script text is shown right to left (`dir="auto"` on each paragraph and customer message).

Voice typing no longer assumes English. The chat sends a language hint (`/api/client-bot/transcribe?lang=`) when it can
tell: Armenian, Russian, Georgian or Hebrew letters in what the customer typed, else the browser's language if it is not
English; without a hint the speech service detects the language. `STT_LANGUAGE=en` in `.env` forces English again
(remove it, or set `auto`). Staff voice typing stays English. For better Armenian, `STT_MODEL=gpt-4o-transcribe`.

## The name: NovaAI

Customers always see the assistant as **NovaAI** with an AI sparkle and an "AI" badge in the header, so it is clear they
are talking to an AI: the launcher ("Ask NovaAI"), the header ("NovaAI · AxiomPrint's AI assistant"), each answer
("NovaAI" with the sparkle avatar) and the hint under the box ("NovaAI is an AI assistant and can make mistakes…").
The model calls itself NovaAI. A greeting saved in Setup that still says "Nova" is shown as "NovaAI" (and
"AxiomPrint's assistant" as "AxiomPrint's AI assistant").

## Moving, resizing and minimizing the chat window

On a computer the chat behaves like a desktop window:

- **Move** it by its title bar (the NovaAI logo and name). It can go partly off the screen on any side except the top;
  at least 100px of the title area always stays on screen so it can be pulled back. Double-click the title bar to put it
  back in the corner at its normal size.
- **Resize** it from any edge or corner (at least 380 × 420; at most the browser window). Under 800px wide the Quote
  pane folds into the conversation as usual.
- Position and size are remembered in that browser (`localStorage` `novaClientChatPos`: left, top, w, h).
- The header script places an invisible drag handle over the title area — the chat tells it how wide that area is
  (`nova-client:drag-area`), so the buttons on the right always work — and thin resize grips on the window's edges.
- **Minimize** (the "–" button, where the ✕ was) hides the window without ending anything. If the customer had started
  a conversation the launcher says **Back to chat** with a green dot (on phones the bottom bar says "Back to your
  chat"); opening it shows the same conversation. `nova-client:close` carries `active` for this.

Phones keep the full-screen chat.
## Visitor details (Conversations)

The top of each conversation shows who is chatting (`visitor-info.js`; never sent to the model):

- **Came from** — how they reached axiomprint.com, from the first page of their visit: ad click ids (`gclid`/`gbraid`/
  `wbraid` → Google Ads, `msclkid` → Microsoft Ads, `ttclid`, `li_fat_id`), UTM tags (`utm_source`, `utm_medium`,
  `utm_campaign`…; `utm_source=chatgpt.com` → ChatGPT, `gmb` → Google Business Profile), `fbclid`, `srsltid` (Google free
  product listings), else the referring site (Google, Bing, ChatGPT, Perplexity, Gemini, Yelp, Facebook, Instagram, …),
  else an in-app browser (Instagram app, Facebook app, Google app…), else **Direct**.
- **First visit** — the same for their first visit in that browser (kept 180 days), when it was a different visit.
- **Device** (one line of icon chips with tooltips: source, device + system, browser or app, screen, language, time zone, IP) — phone / tablet / computer, system, browser or app (from the user agent), plus screen size, language and
  time zone measured by the chat page.
- **IP address**, **Landed on** (with the referring site) and **Campaign tags**, and **Chatting from** (first and latest
  page). Long tracking values are hidden from the displayed addresses (the link keeps the full address); secret-looking
  query values are removed before anything is stored.

The website header script records the visit once per tab session (`sessionStorage` `novaClientVisit`; first visit in
`localStorage` `novaClientFirstVisit`) and sends it with `nova-client:page`; the chat sends it with the message that starts
a conversation (`visit`, `device`), stored as JSON in `client_chats.visit`. The list shows "📱 via ChatGPT" on each row.

**IP addresses need nginx to pass them.** Nova reads the last `X-Forwarded-For` entry, which nginx adds with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` in the `location` that proxies to port 3000. Without it every
visitor shows as `::1`/`127.0.0.1` — and they all share one per-address rate limit.

## Pages and Add to Cart in the transcript

The header script tells the chat which page the customer is on (`nova-client:page`, again whenever it changes,
including single-page navigation). Query values that could be secrets (token, password, key, code, session…) are
removed — in the browser and again on Nova's server. Each customer message is saved with its page; when the customer
moves to another page during a conversation, a "Moved to" line is saved too (`POST /api/client-bot/event`). In
**Conversations** the transcript shows "On page <title>" where the chat started and "Moved to <title>" at each change
(the link opens the page).

Every **Add to Cart** click is saved as well: *Added to cart* (with the job name), *Clicked Add to Cart — asked to sign
in* (guests), *Add to Cart failed* (with the reason) or *admin preview*. A cart click brings the conversation back up
as unread. Customers reopening a chat from History see "🛒 Added … to your cart" where it happened. None of this is
sent to the model.

## New chat

A **New chat** button in the top bar (everyone; a pencil icon on phones) starts a fresh conversation: the chat and the
Quote pane are cleared and the greeting shows again. For signed-in customers the previous conversation stays under
History.

Signing in (from the chat, or a page that loads already signed in) swaps the guest greeting for "Hi <first name>!"
instead of adding a second greeting; once the customer has written something, the sign-in greeting is added under the
conversation (`resume()` in client-chat.js).

## History (signed-in customers)

A **History** button in the header (signed-in customers only) lists their earlier chats, newest first, grouped Today /
Yesterday / This week / This month / Earlier, each with its first message and when it was last used. Tapping one shows
that conversation again — quotes back in the Quote pane — with a note that its prices are from that day (Edit → Update
price, or asking again, gives today's). Writing on carries on that same conversation; Nova reads it as before.
**New chat** starts a fresh one.

Who may open or continue a conversation (`ownsChat()` in client-bot.js): the visitor who had it, or — for a signed-in
website customer — that same customer on any device or visit. Guests' chats are never listed. Admin previews stay
with the admin. `GET /api/client-bot/history` lists, `GET /api/client-bot/history/:id` opens one (messages, quote cards
and attached file names; no internal notes).

## My projects (signed-in customers)

The right-hand pane has two tabs: **Quote** and **My projects**. My projects loads the customer's latest 10 jobs straight
away (`GET /api/client-bot/projects`, no model call); asking "where is my order?" fills it too (on a phone the cards
appear in the conversation). Each card is laid out like the order history on axiomprint.com:

- the invoice line: date placed, **INVOICE INV…**, **TOTAL** (`invoice_total_payment`), **PAID / UNPAID**;
- the job: picture (their artwork preview, else the product photo), job name, E-number, product, size, quantity;
- three steps: **Preflight check** (`prepress_status`: Approved / Proof Checking / Upload Files / Proof sent / Re-upload),
  **Production** (Complete once `estimate_stage` is complete or the job is ready / on its way, else the latest production
  scan, else Not Started; due date), and **Pick up / Shipping / Delivery / Installation** (`estimate_handle.shipping_method`
  and `handle_status`; tracking number when shipped);
- a link to the order history (to upload files, review a proof or pay).

Nova does not list the projects again in text; it says what needs the customer's attention.

## Test / Live

**Client ChatBot → Setup → Chat mode**: **Test** (only browsers that opened axiomprint.com with `?nova=test`) or **Live**
(every visitor). It is stored in Nova and overrides `CLIENT_BOT_PUBLIC`; the website snippet never changes — the loader
asks `GET /api/client-bot/mode` on each page (cached for a minute). Test mode needs `CLIENT_BOT_TEST_KEY` in `.env`
(the snippet's `testKey`).

## Templates, installation and delivery

- **Templates** — `get_template` finds a product's template / die line files (the same `die_line` records the
  staff chat uses), only on options customers can see, and never a die made for another customer
  (`die_line.customer_id`). Each comes with a **Download PDF** button. The file is streamed by Nova from Drive through
  a signed link (`/api/client-bot/template/:item/:customer/:sig/:name`), re-checked on every download, so the Drive
  files stay private.
- **Installation / local delivery** — `estimate_installation` and `estimate_delivery` use the same engine and the same
  admin-edited rates as the staff calculator (Admin → Installation Pricing), with the distance measured from the
  Glendale shop. The customer sees an **estimate** card: the total and what it covers (materials, crew, equipment,
  insurance, travel) — not our hourly or per-mile rates. Jobs the engine flags (too high, too far, crane) say our
  team will confirm or quote it.

## Attachments

The 📎 button, pasting (a screenshot straight from the clipboard) and drag & drop all attach files — up to 5 per
message: **JPG, PNG, GIF, WebP, TIFF, PDF, AI, EPS, PSD, Excel (xlsx / xls), CSV, TXT, MD**. Each file uploads as soon
as it is added; Send waits for any still uploading.

| File | What Nova gets |
|---|---|
| Images, screenshots | The picture (1568px), plus pixel size, dpi and print size |
| PDF | The PDF itself (up to 20 pages / 12 MB), otherwise its text; page count and page size |
| Illustrator (.ai) | Modern .ai files are PDF-compatible, so Nova reads them like a PDF; older ones are only noted |
| Photoshop (.psd) | The flattened image, decoded by Nova, plus size, dpi and colour mode (RGB / CMYK) |
| EPS | Noted only |
| Excel / CSV / TXT / MD | The text (first 2,000 rows of each sheet) |

Nova uses them to understand the request (sizes, quantities, a list of items to price) and may point out obvious
things (low resolution, RGB), but never approves artwork. Pictures and PDFs are re-shown to Nova for the latest two
messages that had them; older ones are described. If the model refuses a file, it is marked and the answer is
retried without it, so one bad file can't break the conversation. The team sees every attachment under
**Conversations** — Nova's preview and a **Download** of the original.

## Several designs: versions

Designs that share a size and options are priced as **one order with versions**, the way the website calculator does
it (Design 1: 100 + Design 2: 150 = one estimate of 250 with 2 versions) — `price_product` takes
`versions: [{name, quantity}]`. Designs in different sizes get one quote per size, each with its own versions. The
card lists the versions under the options; Edit changes each version's quantity. A product without versions is priced
as one run of the total, and Nova says so. Add to Cart passes the list as `item.versions` (the share link itself
carries the total quantity only).

## Quote cards: Specified / Default / Questionable, and Edit

Every option on a quote is tagged: **Specified** (the customer chose it), **Default** (the website default) or
**Questionable** (left on the default although it changes the price — the fields ticked "clarify for AI" on the
product, and the quantity when none was given).

**Price first, no questions.** NovaAI never asks a clarifying question before pricing: it prices straight away with
everything the customer said (Specified) and the website defaults for the rest (Default); with no quantity, the
default quantity. Questionable fields are **yellow dropdowns** right on the card (and an unstated quantity a yellow
box): picking one prices the card again at once (`/api/client-bot/reprice`, no model call) and that field becomes
Specified; the other yellow fields stay as they are. NovaAI asks only when it cannot tell which product is meant.
Rule 9a in the prompt overrides any house rule that says to confirm details first, and the server enforces it: when the
customer taps a product in a list ("… (product #163)"), or when NovaAI's last two answers were questions without a
price about a product already in the conversation, the next model call is made with
`tool_choice: price_product` — it has to price, with what it knows plus defaults.

On phones the message box is not focused after an answer (that opened the keyboard over half the reply); the customer
taps a product or the box when ready. On a computer the cursor goes back to the box as before.

**Edit** on the card turns the options into dropdowns (public options only, choices that fit the current selection)
and the quantities into a field. **Update price** prices it again on the server — no model call — and the new quote
replaces the old one. What changed is noted in the conversation (shown in Conversations), so Nova knows about it in
its next answer. Options the customer touched, or that were Specified or Questionable, become Specified.

**Short answers.** When the quote goes to the right-hand pane, the chat shows only Nova's words — no "on the quote at
the right" lines. After pricing, Nova answers in one line per product (name — price — ready date) and at most one
question; it does not describe the card or its buttons. It does not add "prices exclude shipping and tax" unless the
customer asked about shipping, tax or the total; `trimBoilerplate()` in client-bot.js takes that sentence out of a
reply if the model adds it anyway (never a sentence with a $ amount in it).

## Add to Cart — straight into the website cart

Signed-in customers only. The item goes into the customer's **real axiomprint.com cart** through the website's cart API
(`CLIENT_CART_API`, default `https://website.workroomapp.com/api/v1`); the chat never leaves the page.

**From a quote:** Add to Cart on a quantity row → a **Job name** box (pre-filled with a name from the conversation and the quantity, see below; checkout needs
one) → **Add … to cart**. The click is the customer's yes. The row turns into "✓ In cart" and Nova shows "Added to your
cart" with **Upload artwork & check out**. A guest gets "Sign in to add this to your cart" (login link), or the product
page with everything selected.

**From the conversation:** the `add_to_cart` tool, only after Nova has read the order back with the price and the
customer said yes.

What Nova's server does (it never takes a price, customer id or option from the browser or the model as given):

1. Prices the item again (`priceCard`, public options only) — list price, as the product page.
2. Loads the product from the website catalog, `GET /products/product-info/{id}` (cached 5 minutes), and builds the item in
   the website's own shape (`cartPayload()`, following the website team's guide, `docs/WEBSITE_CART_API.md`):
   - `selectedOption`: one key per catalog variable, the **exact** `variable.title`, hidden ones too; each value is the
     **full catalog option object** (`id` = numeric `variable_item_id`, `variable_id` numeric, `type`, `parent_order`,
     `preview_mode`, `multiple:false`, `dieLine:null`, `swap` ("true" for `size_new`), `calculation:0`, `material_id`,
     `value`; `_id`, `__v`, dates, `filters`, `material`, `variable_item_id` removed). The item is the one Nova priced
     with (same ids); otherwise the allowed default (`filters` respected); `Print_Color` follows the sides (n/n for
     "Front and Back", n/0 otherwise); Quantity is the listed item, or the default plus `customQuantity`.
   - `availableKeys` (variable titles in order), `printSides` (front, plus back when the sides title has "Back"),
     `customSize` `{width:"3.50", height:"2.00"}` from the `size_new` item or the custom size, `selectedMetric` (the
     size variable's `configs.metric`), `activeMode`, `designType` "Print Ready" (or "No File"), `proofOptions`,
     `artNotes`, `sample_base` / `sample_fee` / `sample_per_price`, `parentCategoryId`, `jobName`, and for versions
     `totalQuantity` + `versionObject`. `price` is the list price (the website applies the account discount).
3. `404 "User does not exist"` → `POST /axiom-user` (email, names, `userId`, the account record), then add once more.
4. The new item in the returned cart is checked against the guide's checklist (`cartItemProblems()`, logged as
   `CLIENT_BOT cart check`). If the job name did not stick, the whole item is sent again with it
   (`PUT /cart/update-item/<id>`) — never a partial update.
5. The chat posts `{ type: 'nova-client:add-to-cart', id, item: { alreadyAdded: true } }` to the page; the website
   refreshes its cart count and answers `nova-client:cart-result`. (`window.NovaClientChat.onCartChanged` is an
   optional extra hook.)

The admin preview (**Try it** as a customer) never touches a real cart: it shows **what would be sent**.

**To confirm with the web team:** the `versionObject` entries for a versions item (sent as `{ name, quantity }`), and
`customQuantity` with versions. One real versions item from `GET /cart/my-cart?userId=<id>` settles it.

Not yet: editing or removing cart items (→ https://axiomprint.com/my-cart).


**"✓ In cart"** (the row's button after an add) takes the website tab to the cart page (`SITE_URLS.cart`,
https://axiomprint.com/my-cart). Added rows stay "In cart" while the page is open, even when the pane is drawn again.

**Job name**: the Add to Cart box starts with NovaAI's suggestion for this quote (`job_name` on `price_product`, kept on the
card as `job_hint` across Edit) — e.g. "Grand Opening Cards - 500x" — else the product plus the options the customer chose,
then " - <qty>x". A name already used in the chat gets " (2)", " (3)". The customer can still change it.

**After the click** the chat shows one line — "✓ Added to Cart · 500 Business Cards · $32.97 · Check out ↗" — instead of a
bubble, then asks NovaAI for one more answer by itself (`POST /api/client-bot/chat` with `after: 'cart'`). The model gets
`AFTER_CART` and must call a tool (`tool_choice: any`): search_products for the next product the customer asked about (its
list to click), price_product if the product is known, or `nothing_pending` — then nothing is shown and the turn is deleted.
It never asks about size or quantity and does not repeat "added" (the green line says it). The automatic turn is
saved for the model, hidden from the customer's History and shown in Conversations as "↪ Automatic".
## Going live — checklist

1. Fill in **Training → What Nova knows** (hours, phone, shipping, pickup, artwork rules) and review the house rules.
2. Test in **Try it** as a few real customers, including asking for someone else's order.
3. Sign-in uses the website login (`tokenKey: 'axiom-print-app'` + `customers/me`); test it signed in and as a guest.
4. Add the header script to the website (and the sign-in / Add to Cart hooks).
5. Set `CLIENT_BOT_PUBLIC=1`, restart, and watch **Conversations**.
