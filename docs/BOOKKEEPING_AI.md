# Bookkeeping AI (BookkeeperAI)

Nova's bookkeeping agent, built from `nova-bookkeeper-spec.md`. **The agent proposes, a person approves, the
executor applies**, and every action is in the audit log. This is Phase 1 + 2 of the spec (bill intake from the
accounting inbox, Plaid sync, rules, daily categorization, the Daily Brief) plus the Google Chat conversation.
Receiving, inventory, QuickBooks and BILL (phases 3–4) are not built yet.

Files: `bookkeeping.js` (server), `public/bookkeeping.html` + `public/bookkeeping.js` (the tab at `/bookkeeping`),
tables `bk_*` in `users.db`, files in `bookkeeping-files/` (gitignored, never public).

## Who sees it

`BOOKKEEPER_USERS` in `.env` — emails or usernames, comma-separated, default `gary@axiomprint.com`. Nobody else gets
the menu item or the API (403), admins included. In Google Chat, `BOOKKEEPER_CHAT_USERS` (default `gary@axiomprint.com,
arsine@axiomprint.com`) can approve and answer; anyone else is told so politely.

## How it runs — cron and triggers, both

| What | When | Why |
|---|---|---|
| Daily run | `BOOKKEEPER_RUN_AT` (default 07:00 Los Angeles), or **Run now** | One brief a day: sync banks → scan inbox → read bills → categorize → write the brief → post it to Google Chat |
| Plaid webhook | the moment the bank has new transactions | `/api/bookkeeping/plaid/webhook` (signature verified with Plaid's key) syncs that connection and categorizes right away |
| Inbox poll | every `BOOKKEEPER_POLL_MIN` minutes (15) | Bills reach the pending queue during the day without Pub/Sub |
| Gmail push | instantly, when set up | Pub/Sub → `/api/bookkeeping/gmail/push?token=…` starts a scan (optional; the poll covers it otherwise) |

The clock is inside Nova (pm2), no Inngest / Trigger.dev: one process, one SQLite queue, every step idempotent
(cursor sync, `gmail_id` unique, duplicate bill check), so a missed webhook is caught by the next poll or daily run.
`BOOKKEEPER_CLOCK=0` turns the clock off (tests).

## Setup

### 1. Plaid (bank accounts)
1. dashboard.plaid.com → create the account, product **Transactions**. Sandbox first (`PLAID_ENV=sandbox`, test
   bank `user_good` / `pass_good`), then apply for Production.
2. `.env`: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox|production` → `pm2 reload axiom-ai`. **The Production
   secret is a different key from the Sandbox one** (dashboard → Developers → Keys → Production); the client id is the same.
3. No dashboard webhook to configure (Team Settings → Webhooks only lists Transfer / Wallet / Income events): the
   Transactions webhook `https://nova.axiomprint.com/api/bookkeeping/plaid/webhook` is set per connection by the Link
   token Nova creates. **Allowed redirect URIs** (Team Settings → API): add
   `https://nova.axiomprint.com/bookkeeping/plaid-oauth` — OAuth banks (Chase, Bank of America, Wells Fargo, Capital
   One, US Bank…) sign you in on their own page and send you back there; Nova keeps the Link token in the browser
   (`bk_plaid_link_token`) and resumes Link with `receivedRedirectUri` (1.19.46). Without it those banks cannot be connected.
4. Nova → Bookkeeping AI → Settings (the gear) → Bank accounts → **Connect a bank**, sign in to each bank (Plaid Link
   in the browser). Access tokens are stored AES-256-GCM encrypted (key derived from `JWT_SECRET`); the first 90 days
   sync at once. Each connection remembers the Plaid environment it was made in (`bk_accounts.env`); after the switch
   to production the old sandbox connections show **sandbox — reconnect**: Disconnect them and connect the real banks.
5. **Remove test data** (Settings → Bank accounts, shown while a sandbox connection exists under production): removes the
   sandbox connections, every transaction that came from them, the proposals / questions about those lines and the
   purchases that held only those lines. Bills and inbox emails are real and stay.

### Bank feed (1.19.54)
Its own top tab (Purchases · Bank feed · Bills · Inbox) with **All · New · Pending · Categorized** sub-tabs in the Bills
style, each with its count, **Stats** at the right (the charts: totals, spend by month, by type of expense, top vendors,
with a period row and a Filter… button that opens the filtered list) and a Search box; it opens on Pending. Every column header is a filter, and the AI rates every line. A freshly synced line shows "rating…"
under its Category picker; a few seconds later the AI's suggestion appears there — "✦ Paper 95% [Use]" — with its
reason on hover. Use picks it (same as choosing it yourself), or pick another category. Nothing is categorized
without a person. The Date column shows when the line was synced (the bank's own date, and whether it is still pending
at the bank, on hover). Description: the merchant, the bank's original memo line, and the category family in words with
the city / store number when the bank gives them. Under the amount: when the transaction happened and how it was paid —
Store, Online or Check #n. An unlinked vendor shows the merchant's logo from the bank; Link / Change are the icons beside
the name. The last column is **Status**: New (synced, not rated yet), Pending (the AI has a suggestion,
waiting for a person) or Categorized (with how it was set: approved / manual / rule). **Date** opens quick ranges (Last 30 days is the default, This month,
Last month, Last 90 days, This year, All time) or a From / To; **Vendor** lists every vendor seen on a bank line (and
"Not linked"); **Account** lists each bank account ("Wells Fargo - 6595"); **Amount** is a from / to range; and
**Category** lists the types of expense (and, in the Categorized view, the categories in use); the status comes from the sub-tabs — **Pending**
(no category yet — the default), **New** (synced today, Los Angeles day (the chip is called Today since 1.19.111; at midnight they move to Pending)ours), **Categorized** (the report), All.
The line above the table says what is shown ("12 pending lines in the last 30 days"; the list stops at 500). Each row: the date with the time Nova received it under it · the **vendor** (logo, name, SUPPLIER / VENDOR tag,
**Link** or **Change**) · the bank's description · the **account** as "Wells Fargo - 6595" with the bank's logo (from
Plaid's institution metadata) · amount · category. Vendor matching: an exact name / alias match or a near match of
95% or better links the line by itself ("matched 100%"); a weaker near match shows as "Looks like GPA Paper · 72%" with
**Use**. When a person links a line, the bank's wording becomes an alias of that vendor, so every future line with the
same wording links by itself, and other unlinked lines with that wording are linked right away. Change is always there.

### Ask BookkeeperAI (the bubble)
The ✦ button at the bottom right of every Bookkeeping tab opens a small chat with BookkeeperAI — the same
conversation as the Daily Brief tab and Google Chat. It knows the chart of accounts, the vendor directory and
what is pending, so "Where should Figma go?" gets one sub category from *your* chart and a line of reasoning, and
"make that Figma's usual category" sets it on the vendor (creating a Nova vendor if Figma is not in the directory yet)
so its bank lines file themselves from then on. Approve / reject / answer questions work here too.

### Category suggestions
Every uncategorized line gets a suggestion under its Category picker, best source first:
- **From history** (clock icon) — every past line from this company went to one category: 100% (≥3 lines; 90% when
  at least 8 in 10 did).
- **Company's usual** (building icon) — the usual category on the vendor record: one category → 95%; several →
  each shown at 85%, pick the one that fits.
- **AI** (✦) — the model's own reading of the line, when the company is unknown or has no history yet.
Use files the line and the Status column says how it was matched (manually matched / company's usual / from history /
AI, approved / by rule). Every pick becomes history, so a company that always lands in one place soon matches at 100%.

### Money in
In Accounts → Chart of Accounts a type of expense can be marked **Money in (income)** — the Income type is, by default.
A deposit or payment received in the Bank feed then offers only that type's categories in its picker (and money out never
offers them), and the AI files money in under an income category only; if it tries anything else the line gets a
question instead of a suggestion.

### Nova vendors
Not every company you pay belongs in the CRM's supplier / vendor lists — the landlord, LinkedIn, a one-off contractor.
Accounts → **Nova Vendors** keeps those in Nova only: company, website, email, phone, contact, address, **what we buy
from them** and the **usual category** from the chart of accounts (that is the map the AI uses when their lines come in),
how they appear on the bank statement, notes. "+ New vendor" there, or **+ New Nova vendor…** at the bottom of the
vendor picker on any bank line (prefilled with the bank's wording; the line is linked at once). They show everywhere a
CRM company does, tagged **Nova vendor**; the Bank feed's Vendor header filters by kind (Supplier / Vendor / Nova vendor /
from a bill / not linked) and by Company.

### Refunds
Money that comes back — a cancelled Uber ride, a returned order — is not income. Under the Category of any money-in
line there is **↩ Refund of a charge…**: it lists the charges of the last 120 days with the same amount and/or the
same merchant (best match first, "same amount + merchant" tagged), one click matches them. The refund takes the
charge's category (Travel, not Income), both lines show the link ("refund of 10-11-2026 · $37.31 Uber" / "refunded
10-12-2026"), and the Stats subtract it from what was spent instead of counting it as money received. × unmatches.

### Which accounts are in use
Settings → Bank accounts lists every account behind a connection with a checkbox. Untick an account (a personal
checking on the same bank login, say) and its lines disappear from the Bank feed, the counts, the AI's work, purchase
matching and the Account filter; nothing is deleted — tick it again and they come back exactly as they were. New lines
from an unticked account are hidden as they arrive. At least one account of a connection stays in use (otherwise
Disconnect the bank).

### 2. accounting@axiomprint.com
Read with the service account in `/opt/axiom-ai/gmail-key.json`, impersonating `BOOKKEEPER_INBOX` (default
`accounting@axiomprint.com`) exactly as Nova reads order@. Domain-wide delegation is per domain, so nothing new is
needed unless the scan logs `unauthorized_client` — then add `https://www.googleapis.com/auth/gmail.readonly` to the
client id's scopes in Google Admin → Security → API controls → Domain-wide delegation. PDF and image attachments are
saved; our own `@axiomprint.com` mail is skipped.

**Marking read in Gmail** (1.18.20): "Mark as read", "Mark all N … as read" and turning an email into a bill also remove
the UNREAD label in Gmail (`markReadInGmail()`, `users.messages.batchModify`, a second JWT client with the
`https://www.googleapis.com/auth/gmail.modify` scope), so the team's unread count follows Nova's. It needs that scope
on the service account's delegation: Google Admin → Security → Access and data control → API controls → Manage
Domain Wide Delegation → the client ID from `/opt/axiom-ai/gmail-key.json` → Edit → add `gmail.modify` next to
`gmail.readonly`, `gmail.send`, `drive.readonly` → Authorize (a few minutes to take effect). Until then Nova's own state
still changes and the page says "Marked read here, not in Gmail" with those steps. Nova never deletes, moves or
labels mail otherwise; every batch is audited as `gmail.mark_read`.

Optional push: Google Cloud project of the service account → enable Pub/Sub → topic → grant
`gmail-api-push@system.gserviceaccount.com` Publisher → push subscription to
`https://nova.axiomprint.com/api/bookkeeping/gmail/push?token=<BOOKKEEPER_PUSH_TOKEN>` → `.env`
`BOOKKEEPER_PUBSUB_TOPIC=projects/<p>/topics/<t>`, `BOOKKEEPER_PUSH_TOKEN=<random>` → Connections → **Start watch**
(Gmail watches expire after 7 days; the daily run renews when the topic is set).

### 3. Google Chat
Two ways; the tab's Connections card walks through both.
- **Webhook (10 minutes, one-way):** in the space with Gary and Arsine → space name → Apps & integrations → Add
  webhooks → "BookkeeperAI" → paste the URL in Connections. The brief is posted there; replies are made in Nova.
- **Chat app (two-way):** in the service account's Google Cloud project enable the **Google Chat API** → Configuration:
  name BookkeeperAI, avatar, "receive 1:1 messages", "join spaces and group conversations", HTTP endpoint
  `https://nova.axiomprint.com/api/bookkeeping/chat/events`, visibility: Gary and Arsine. `.env`
  `BOOKKEEPER_CHAT_AUDIENCE=<project number>` (events are verified as JWTs from chat@system.gserviceaccount.com for
  that audience). Add the app to the space and say hi: Nova stores the space (`bk_settings.chat_space`) and posts
  the brief there with the service account (scope `chat.bot`). Replies ("approve all", "#12 is Paper", "Q3: it was the
  new cutter") are answered by BookkeeperAI with its tools and applied by the executor.
  A `bookkeeperAI@axiomprint.com` mailbox is **not** needed — the app posts as itself.

The same conversation exists in the tab ("Talk to BookkeeperAI"), so Google Chat is optional on day one.

## Suppliers & vendors (the directory)
The CRM's `suppliers` and `vendors` tables are read (read-only) into `bk_vendors` (`source` = suppliers | vendors,
`crm_id`, email, phone, specialty, contact, address, `photo` = the CRM's `photo_url`, shown on the left) on every daily run and on
**Refresh from CRM**; they come in approved. The same company may be both a supplier and a vendor — `bk_vendors.name` is
not unique (the 1.15.3 UNIQUE constraint is dropped at boot by rebuilding the table, ids kept).
Each entry's **type** is the CRM list it is in (`bk_vendors.kind`: supplier / vendor) — read-only in Nova, shown as a tag and as
the Type filter above the list; a new CRM list is a new type (`BOOKKEEPER_CRM_LISTS=suppliers,vendors,<table>`, same columns).
Vendors first seen on a bill are in the same list, type "From a bill". The directory refreshes by itself: when the tab opens
and the last sync is older than 10 minutes, hourly from the clock, and with every daily run — a company added in the CRM
shows up without pressing anything. Sync errors are logged (`BOOKKEEPER directory sync`) and shown in the tab header.
The list shows the essentials; clicking a name or logo opens the full CRM record (`bk_vendors.details` JSON: address, unit,
city/state/zip, country, hours, list, CRM id). **Approved** = BookkeeperAI may link bank lines and bills to the company
without asking (CRM entries come approved; bill-seen ones wait); **Linked** = transactions / bills matched to it so far. A bank line is linked to a directory entry (`bk_transactions.vendor_id`) when the entry's name, one of its
bank-statement aliases, or (for bills) its email domain matches; the AI is told "OUR VENDOR: Veritiv — Paper → usually
Paper" and gets the whole directory as context. Approving a category for a linked transaction fills the vendor's
*usual category* (editable in the tab, with the aliases). Vendors first seen on a bill (`source` = bill) sit in the same list with an
"Approve" pill. The table autosaves: the usual category when picked (removing one asks first), bank-statement names on
blur, Approve on click (`POST /api/bookkeeping/vendors/:id` is a partial update — only the fields sent change). Type and
Approved filters live in the table header. Edit names, emails and specialties in the CRM, not here.

## Equipment (1.19.3)
Accounts → **Equipment** mirrors the CRM's machine list (`equipments`: name, `photo_url`, and the team through
`action_ids` → `actions.team_id` → `team.name`; operators and production steps stay in the CRM) into `bk_equipment`
on the same sync as the directory (tab open / hourly / daily; a machine removed from the CRM is kept, shown as retired).
The money side lives only here and is edited per machine (**Edit**): a vendor / lender from the directory and one of
three modes — **Owned outright** (purchase price, date, useful life — 7 years by default — and salvage: straight-line
depreciation, the book value on Jan 1 and today, `bookValue()`), **On a loan** (price, date, down payment, loan amount
(price − down if left empty), term, APR, first payment, monthly payment, useful life: depreciation plus the schedule —
months paid / left, what is still to pay; principal vs interest for the P&L is a later step from the rate), **Leased**
(start, term, monthly: no asset, every payment is an expense). A machine bought outside the CRM list can be added by
hand (**+ Add**, no `crm_id`).

**Payments find their machine by themselves**: a bank line (and the purchase made from it) or a bill from the machine's
vendor for its monthly amount to the cent — or the vendor's only financed machine — gets `equipment_id`
(`equipmentFor()`, called in `ensureTxnPurchases` and `parseEmail`; saving a machine links what is already in the
books). **Payments** on the row lists them (bank lines and bills) with a × to unlink. Endpoints:
`GET /api/bookkeeping/equipment` (rows + `payments`, `schedule`, `book`), `GET /equipment/:id/payments`,
`POST /equipment/:id` (financing), `POST /equipment` (add), `POST /equipment/:id/link {transaction_id|bill_id, off}`.
Audit: `equipment.update` (before / after), `equipment.add`, `equipment.link`.

## Materials & GEO types (the CRM materials catalog)
CRM → Products → Materials is mirrored read-only into `bk_materials` with every sync of the directory: name, `material`
(paper_cover, vinyl, foil…), `type` (sheet, role…), production step, **GEO type / sub type** (`geo_type`, `geo_sub_type`
tables — Sheets, Rolls, Boards, Wide Format, Book Binding, Products, Accessories, Coating, Tooling, Digital, Packing), the
production team(s) (`materials.department_ids` are `team` ids — the colored chips: Large Format Flatbed, Roll Labels,
Digital / Sheetfed…), manufacturer, cost, code, size, thickness, photo and the supplier. Rows deleted in the CRM are
dropped. The tab (Materials & GEO types) filters by GEO type → sub type, supplier and text; a vendor row / popup shows
"n materials: Sheets, Rolls" with a link to them.

`materials.supplier` is a **typed name** in the CRM today ("Kelly", "Kelly Paper", "KellyPaper"; "GWF"); `supplierFor()`
links it to a directory entry by normalised name, alias, prefix or a unique containment, and the tab lists the names it
could not link. When the CRM adds a real supplier id to materials, read that column in `syncMaterials()` instead.

The AI sees it two ways: `dirLine()` adds "— supplies 57 materials: Sheets ×50, Rolls ×7 [paper_text, paper_cover]" to each
vendor and a GEO TYPES line (purchases of catalog materials are production cost, not office supplies), and the chat has a
read-only `materials` tool (by supplier and/or a name / GEO type / manufacturer query).

## Accounts tab — Vendors & suppliers · Chart of Accounts · Rules
The fourth main tab, **Accounts**, holds the directory (Vendors & suppliers), the Chart of Accounts editor, the
categorization Rules and Materials & GEO types (`?tab=accounts&sub=chart`; `show('vendors')` etc. still work).
Connections and Activity stay in the small row.

### Chart of Accounts — a styled tree
**Expects delivery per sub category** (1.19.19): the checkbox on the type is only the default; every sub category and
sub-sub category has its own 📦 toggle in the editor (orange = goods that must arrive, grey = a service; a dashed border
means "same as the level above", solid means set for this one). Stored as `delivery` 0 / 1 / null on each node;
`chartOf()` resolves the effective value down the tree (`delivery`, with the own value in `delivery_own`), and
`expectsDelivery(category)` uses the effective value for the purchase's receiving status.

**Three levels** (1.19.17): a type of expense → sub categories → optional sub-sub categories (Cost of Goods Sold →
Paper → Coated / Uncoated). In the editor every sub category has a dashed "+ sub category under …" line (Enter adds),
and its sub-subs sit indented under it with the same rename / icon / order / remove controls (a sub with a used
sub-sub cannot be removed). Names stay unique across the whole chart. Pickers list sub-subs indented under their sub
(a search match shows its parent too); `catLabel` prints Type › Sub › Sub-sub. `chartOf()` rows carry `level: 3` and
`top`; `categoriesOf()` includes them; the AI's chart line reads "Paper (Coated, Uncoated)"; `addCategory(name, parent)`
with a sub as parent adds a third-level entry; `renameCategory` follows all three levels.

Canonical form `bk_settings.chart_json`: `[{ name, color, icon, children: [{ name, icon }] }]` — a **type of expense**
with its color and icon, and its **sub categories**. `bk_settings.categories` (the indented text) is regenerated from it
on every save for the AI prompt (`chartText()`: "Cost of Goods Sold: Paper; Inks & Toner | …", answer with the sub
category) and for anything that still reads the text; posting `categories` text to `/settings` rebuilds the tree keeping
colors by name. `chartTree()` / `chartOf()` (flat, with color/icon) / `categoriesOf()` (sub categories + childless types)
/ `addCategory()` / `renameCategory()` / `categoryUsage()`. The old flat list and the 1.16.0 text tree are upgraded once
at boot (`DEFAULT_STYLE`, `SUB_ICON` give the defaults their colors and icons). Icons are keys of one line-icon set
(`ICON_PATH` in public/bookkeeping.js, inline SVG, stroke 2); the 1.16.2 emoji are mapped to keys on load (`LEGACY_ICON`) and
its darker palette to the lighter one (`OLD_COLOR`). A type's color is used as text + border on a light tint of itself
(`tile()` → `.coa-ic`, CSS `color-mix`), the CRM's pill look.

Editor (Accounts → Chart of Accounts): types on the left (icon tile, reorder), the selected type on the right — big icon
button (emoji grid), name, color swatches + any color, the sub categories with icon / inline rename / reorder / delete,
add a sub category, delete the type. Every change autosaves (`POST /api/bookkeeping/chart {tree}`); a sub category in
use (transactions, rules, vendors' usual category) cannot vanish that way — the server answers "In use, rename instead" —
and **rename** (`POST /api/bookkeeping/chart/rename {from, to}`) follows the name into `bk_transactions`, `bk_rules`,
`bk_vendors.default_category` and pending proposals. `GET /api/bookkeeping/chart` returns the tree + usage counts.
"+ New category…" in any picker and the chat tool `add_category` go through `addCategory()`.

The category control everywhere is `catSelect()` in bookkeeping.js — a picker (button + hidden `input.<cls>` carrying the
value, so `querySelector('input.pick').value` reads it): a popover with search, the types as collapsible groups with their
icon and color, round marks for a single choice, checkboxes + Done for `{ multi: true }` (a vendor's usual categories,
stored "Paper; Freight & Shipping"), "+ New category…" in the footer. Transactions show "Type › Sub category".

## Inbox triage
The inbox is checked every `poll_min` minutes (default **5**, from the first boot — no longer gated on a first daily run).
**By default BookkeeperAI only rates** (`triage_auto` = 0): every email gets its kind + confidence tag, nothing is set aside
by itself, and only rated bills (≥ `triage_bill`) go to the full read. The person sets aside in one click — "Set aside all
ads / notices / receipts" (`POST /api/bookkeeping/inbox/set-aside {kinds, min}`, `read_by = 'user'`) — or one at a time.
Turning on "Let BookkeeperAI set emails aside by itself" (Connections) enables the threshold actions below. **Scan now** is
driven by the page so the rating is visible: `POST /inbox/fetch` → `POST /inbox/rate {limit: 25}` in a loop (each rated row
gets its tag live, progress line) → `POST /emails/:id/parse` for each rated bill.
`triageEmails()` gives every unread email a **kind** and a **confidence** with the light model (`modelLight` =
`MODEL_LIGHT`, text only, 25 per call, up to 150 per pass; stored in `bk_emails.kind / confidence / triaged_at`), then
acts by the thresholds in settings (Connections → "When BookkeeperAI acts on its own"):

| kind | threshold (default) | what happens |
|---|---|---|
| advertisement, receipt | `triage_ad` 95% | marked read: `status = 'skipped'`, `read_by = 'ai'`, note "advertisement — promotion (98%)" |
| notification (delivery, tracking, alerts) | `triage_notice` 75% | marked read the same way |
| bill | `triage_bill` 80% | read in full by `parseEmail()` → a bill draft (below the threshold it is still read in full — a missed bill costs more than a model call) |
| message (a person writing) | `triage_message` 60% | `status = 'message'`, kept for a person (purple in the inbox, counted in the Inbox badge) |
| other / unsure | — | read in full |

The full read (`parseEmail`, 40 per pass) that finds "not a bill" also sets `read_by = 'ai'`. The Inbox chips are Not read ·
Messages · Bills · **Set aside by AI** (the report of what it marked read on its own, with kind, confidence and why) ·
All set aside; "Mark as read" by hand sets `read_by = 'user'`. The daily run's summary line counts emails set aside and
messages kept; the overview has `inbox_messages` and `ai_read_today`.

### Open on top, Closed below (1.18.30)
**Open** = still unread in Gmail (`read_by IS NULL`, not set aside — bill drafts included until Gmail says read);
**Closed** = closed from here (Mark as read, Mark all, a bill draft once Gmail accepted the read). No Open / Closed
tabs: each basket lists open emails on top and the closed ones under a "Closed n" divider. Chips: **All** (every open email) · **New** (incoming mail since the last scan, not sorted yet) · New · Bills · Transactions (receipts) · Messages, then a **More baskets** dropdown (count = its baskets' open total) holding Ads · Notices · Other · Set aside; the chip takes the chosen basket's name and colour (1.18.55). A bill draft is tagged Bill whatever it was rated (`kind = 'bill'` on parse); a
rated email with no kind is Other. No heading on the Inbox card; Scan now sits left of the search and shows only on the Unscanned chip. Scan = fetch unread + rate (manual Scan now, or the poll — `poll_min`, now
60 by default; a one-time `inbox_reset_1830` cleared old closed marks and raised a lower poll to 60).

### Sender → vendor, Match, multi-select (1.18.37)
The reading pane's avatar *is* the vendor (hover: "Vendor · name · kind"; click: Link / Change vendor… / Unlink this address; Match… sits in the actions row). The sender's **vendor** (`bk_emails.vendor_id`, set on scan / open by `matchVendor()` — now also by
an exact address kept in `bk_vendors.aliases`, lines with an `@`, Nova-side only, never the CRM's contact). "Link … to a
vendor…" (`POST /api/bookkeeping/emails/:id/vendor {vendor_id}`) stores the address on the vendor so every later email from
it links by itself; Unlink (vendor_id 0) removes it. **Match…** (`GET /emails/:id/matches`) scores open bills (same vendor +3,
invoice number seen in subject/body +4, amount +2, paid −1) and bank lines of the last 45 days (vendor +3, amount +3, name +1);
one candidate asks to confirm, several open a chooser. `POST /emails/:id/match {bill_id | transaction_id | clear}`: a bill
becomes **paid** on the email's date (`paid_note`, `bk_bills.receipt_email_id`), a bank line keeps the email as its receipt
(`bk_transactions.receipt_email_id`); `bk_emails.matched_bill_id / matched_txn_id` show it in the pane. Every row and the pane show the sender as the vendor's logo when linked (`GET /emails` joins `bk_vendors` and links unlinked senders through `matchVendor()`), else a lettered circle (indigo when linked without a photo). Rows have a
checkbox (hover the dot): a selection bar offers Mark as read (`POST /inbox/read {ids}`, Gmail first) and Move to.

### Manual month (1.18.71)
Nothing becomes a bill by itself any more: `parseNewEmails` only rates (`triage_auto`, off, is the only automatic
full read), the UI scan no longer reads rated bills, and `/inbox/rate` returns no `bills_to_read`. A person presses
**Bill** (or Turn all) → draft under Bills; **Transaction** → matched to a bank line / bill; **Move to** → another basket.
Every such decision is stored on the email as the training signal for the AI — `bk_emails.decided_kind / decided_by /
decided_at` (`decideEmail()`): Bill = bill, Transaction = receipt, Move to = that kind, Mark as read = agrees with the
AI's rating (COALESCE, so an explicit decision is never overwritten by a later read). Compare `kind` (AI) with
`decided_kind` (person) to measure the rater. The triage prompt now says a human-written email that contains or chases
an invoice is a **message** (we may need to answer), while system / no-reply invoices are bills.

### Email history (1.18.57)
The clock button in the reading pane lists everything done with the email, newest first, with who did it (member
face, "AI" for BookkeeperAI, a sparkle for the scan): scanned, rated (kind + %), marked read / unread (also from
"Mark all" and picked rows — each email gets its own `bk_audit` row), moved to a basket, converted to bill #n
(`email.bill`, written by `parseEmail`), sender linked / unlinked, matched / unmatched.
`GET /api/bookkeeping/emails/:id/history` = `bk_audit` rows with `ref` = the email id and `action LIKE 'email.%'`,
plus synthetic rated / scanned entries from `triaged_at` / `created_at`.

### Gmail is the truth (1.18.22)
Open / closed follows Gmail's UNREAD label both ways: an open row no longer unread in Gmail (someone read it there) is
**deleted** from Nova (1.18.25 — Closed holds only what was closed from here; a one-time purge `inbox_reset_1825` emptied Closed), and the scan **re-opens** closed rows (not set-aside ones) that are unread in Gmail again (`unread_again` in the scan
result). "Mark as read" / "Mark all … as read" change Gmail **first** (`markReadInGmail`) and only then Nova — if Gmail
refuses (missing `gmail.modify` scope) nothing changes here and the dialog says why. "Mark as unread" (closed emails,
`POST /api/bookkeeping/emails/:id/unread`) adds UNREAD back and re-opens the row. Clicking an email never marks it read;
only the buttons do. Every basket has **Open** (unread in Gmail) / **Closed** (read) segments with counts, so a basket
keeps its history; the chip count is the open count, action bars show in Open only. A wrong count is fixed by Scan now.

### Basket definitions (1.19.7)
Settings → **Inbox** holds one sentence per basket (All · Bills · Transactions · Delivery · Messages · Ads · Other ·
Do Later; `bk_settings.baskets` JSON, defaults `BASKET_DEFAULTS`, `basketDefs()`), in the team's words. The same text
shows under the **(?)** beside the basket name on the Inbox action row, and is the sorting rule the light model gets
(`triageEmails` builds its system prompt from them) — change the words and the next scan sorts by them. Do Later is
never filled by the AI. The inbox is checked every **30 min** by default (`poll_min`; a 60 left from before is set to
30 once, `inbox_poll_30`). The action row ends with "Last scanned <when>" and a refresh-icon Scan button.

**Bill flow (1.19.7)**: pressing **Bill** on an email (or **Turn N into bills**, which walks the whole basket one email
at a time with Stop / Skip) first asks which purchase it belongs to — open purchases Nova found by order number, amount
or vendor — or "New purchase from this bill"; only then is the email read in full (`POST /emails/:id/bill`:
no choice → `extract` + `purchases`; `purchase_id` or `new:1` → `parseEmail` with that purchase, or just the join for an
email already read). Both basket buttons ask before they act.

### Baskets (1.19.5): All · Bills · Transactions · Delivery (shipped / tracking / delivered; kind `arrival`) · Messages · Ads · Other · Do Later (the manual basket, `aside`; was "Set aside"), all on one line — no "New" chip and no "More baskets" menu; Scan sits at the right of the action row under the search, and mail not yet rated shows under All until the next scan sorts it
The AI's kinds are `bill`, `receipt` (a purchase: an order confirmation, "thanks for your order", a payment receipt or
charge confirmation), `arrival` (a delivery notification: shipped, out for delivery, delivered, tracking), `message`,
`advertisement`, `other` (account alerts, system mail, anything unclear). The old `notification` kind and the Notices
basket are gone — everything of that sort is Other. In the reading pane the basket's own button is the **main** one
(outlined, bold): Bills → Bill, Transactions → Transaction, Arrivals → Arrival; the others stay as grey chips. One-time
relabel (`inbox_relabel_1910`, in the next scan): every open email the AI had rated is rated again with the new kinds;
a person's decisions (`decided_kind`) are kept, `notification` decisions become `other`.

### Baskets (1.18.13)
`scanInbox` lists `is:unread in:inbox` mail only (no date limit), so the inbox here follows the team's Gmail unread count — including our own `@axiomprint.com` mail (1.18.23; forwarded reports are unread too). Mail read in Gmail before Nova saw it is never imported, so Closed holds only what was dealt with from here (rows the 1.18.16–1.18.22 import brought in as read are deleted on the next scan);
open rows (`new` / `message`) whose Gmail id is no longer unread are set aside with `read_by = 'gmail'`. The first chip is **Not read** (every open email, the default); then the baskets by rating: **Bills** (kind bill, drafts excluded from the count), **Direct messages**, **Ads**,
**Confirmations** (notification + receipt), **Other**, **Not rated**, and **Set aside**; plus **Everything else** (read — in Gmail, marked read here, or by the AI) and **Set aside** (`bk_emails.aside = 1`: only what a person parks with Move to… → Set aside; nothing lands there by itself, Gmail untouched). Every basket chip is always shown, with its count. With no email selected the list takes the whole width, one line per email (`.ib-split.lines`); clicking opens the split view, × goes back. Each basket has its own action bar: "Mark all N ads / confirmations / other as read" (`POST /inbox/set-aside`, Nova
only — Gmail is never written), "Turn all N into bills" (parses each → Bills), "Rate them now". The reading pane has
**Turn into a bill** (or **Open in Bills →** for a draft), Mark as read, and **Move to…** (`POST /api/bookkeeping/emails/:id/kind`
— replaces the rating with confidence 1, `message` sets status `message`). `POST /api/bookkeeping/inbox/reset` (no button any more; curl it with a bookkeeper token) deletes every `bk_emails` row with no bill (and its saved attachments) and audits `gmail.reset`. People are shown as a face (`whoHtml`: the CRM photo — `user.memberimage` on S3, looked up by `axiom_user_id` or email for `overview.people` — or an initial) in notes ("moved to … by"), the Runs table and the audit log; the agent / executor / poll keep their word. No Plain text button — text is the fallback when an email has no HTML.
The last-checked time is the Scan now button's tooltip. Yes/no questions use the styled `ask()` dialog (title, text, named button), never the browser confirm().

### Reading pane
The Inbox is a split view: the list on the left (two-line rows: sender + time, subject, snippet + kind tag + attachments),
the selected email on the right. The pane shows the email the way Gmail shows it: subject, sender (name + address, "to accounting@"), date,
the rating / verdict line (and the bill it became), the HTML body in a sandboxed iframe (`bk_emails.body_html`, scripts / forms / handlers stripped by `emailHtml()`; rows
scanned before 1.18.7 fetch it once on open; "Plain text" falls back to `body`), attachment cards (image thumbnails,
PDF icon) that open a viewer (PDF in a frame, image as is, Download / Open in a tab), and Read it as a bill / Mark as read.
`GET /api/bookkeeping/emails/:id` (full record + `bill`), `GET /api/bookkeeping/emails/:id/att/:i` (the file, inline).
### Column filters (1.18.56)
Every table filter is a funnel on the column header (`thFilter(key, label, spec, cur)` / `thFilterBind`), CRM style:
a **list** spec (array of `{v, l, n}`) applies on click; `{type:'text'}` opens a "Contains" box with Clear / Apply;
`{type:'range', kind:'number'|'date', presets}` opens From / To (date ranges also offer period chips) with Clear / Apply;
the popover flips above when short of room. Vendors: Type (the tag sits under the 72px logo; the Approved column is gone — approval still exists in the data), Name, Contact, Specialty, Usual category.
Transactions (Categorized): Date (period presets + custom range), Vendor, Account, Amount (min–max), Category, Set by —
the old period / $ bar above the table is gone; a "Filtered · Clear filters" line shows when anything is set. An active header shows a red × that clears that one filter on the spot, and its popover (the Company picker too) has "× Clear" in its title (1.19.104).

### Purchases tab (1.19.0)
The Transactions tab became **Purchases**, with four views: **Purchases** · **Bank feed** (the old transactions views:
All / Pending / New / Categorized) · **Waiting for the bank** · **Not received**. A purchase (`bk_purchases`) is the hub
record everything we bought attaches to, with four slots — bill (`bill_id`), bank line (`txn_ids`), confirmation email
(`confirm_email_id`) and arrival emails (`arrival_email_ids`); `bk_emails`, `bk_bills` and `bk_transactions` carry
`purchase_id`. Status (`purchaseStatus()`): cancelled → no bank line and no bill paid → **awaiting payment** / bill paid or
confirmation only → **awaiting bank** → goods not here → **not received** / **partly received** → **closed**. Every
categorized bank line (amount > 0) that is in no purchase becomes one by itself (`ensureTxnPurchases`, `no_paperwork=1`),
so the list is the full spend; a bill made from the inbox opens a purchase at once.

**Goods or service** comes from the chart of accounts: each type of expense has an **Expects delivery** flag
(`chart_json`, `delivery`; default from the name — cost of goods, supplies, equipment, inventory, material, asset) and
the purchase copies it as `expects_delivery`; the row's icon button flips it for one purchase
(`POST /purchases/:id/flag`). Goods purchases show Received / Partly / Cancel buttons (`POST /purchases/:id/receive
{status: yes|partial|no|cancel|reopen, note}`); nothing is ever marked received by the AI.

**Inbox buttons.** Besides Bill, the reading pane has **Transaction** (an order confirmation / receipt: proof of a
payment) and **Arrival** (a delivery confirmation). Both read the email with the light model (`extractPayment`: vendor,
amount, date, order number, what) and ask: Transaction (`POST /emails/:id/transaction`) offers the bill with the same
number (becomes paid), bank lines with the same amount (to the cent, −10/+20 days, same vendor first — always ask,
there is no tolerance), open purchases, or **Wait for the bank**, which starts a purchase under *Waiting for the bank*;
when the bank line lands Nova proposes it on the row ("1 bank line matches" → `GET /purchases/:id/suggest`,
`POST /purchases/:id/attach`). Arrival (`POST /emails/:id/arrival`) lists purchases by order number, vendor and date;
**All here** / **Part** records the arrival (or starts a purchase when nothing matches). Arrival closes nothing else.
Both leave the email handled (closed, read in Gmail) and are logged (`email.transaction`, `email.arrival`, shown in the
email's history).

**Inside a purchase (1.19.5)** — click the vendor on a Purchases row (or the "1 email · 2 attachments · 3 items" line
under it; the email subjects show on hover). The view lists every email behind the purchase (confirmation, bill,
delivery — with attachment counts, click to open in the Inbox), the bank line it is **Paired** with (the pill also
shows on the row), and its **line items** (`bk_purchase_items`): when a Delivery / Transaction starts or joins a
purchase, the light model reads the email (`extractItems()`: HTML flattened with product pictures kept as `[IMG url]`
tokens, `emailForItems()`) into items with name, qty, unit price, amount and photo, plus Shipping and Sales tax lines
of their own `kind` (`fillItemsFromEmail`, only when the purchase has no items yet; a bill's own `lines` fill them via
`fillItemsFromBill`). Each line has a **Material** from the catalog (`materials/pick` search; left **Unknown** until
the material exists in the CRM) and a **Category** from the chart — so the small shipping part of an invoice can go to
Freight & Shipping (the chart category matching shipping/freight is preset). Lines are editable (+ Line, kind, ×,
"Read from email" to re-extract) and saved as a whole with `POST /purchases/:id/items`; `GET /purchases/:id` returns
the detail. The basket and button are called **Delivery** (shipped, tracking, delivered) since 1.19.5.

**Alerts** (Settings → Alerts): purchases waiting for the bank for more than `waiting_days` (30) and goods not received
after `notreceived_days` (30) are emailed as one list to `alert_to` (gary@axiomprint.com, `BOOKKEEPER_ALERT_TO`) every
morning at `alert_at` (08:00 LA) until handled; **Send now** / `POST /purchases/alert`. Sent as order@ via `sendMail`.
The Connections icon is now **Settings** (gear).

### Bank feed (the old Transactions tab)
Tabs All / **Pending** (the default — BookkeeperAI proposed a category or asked a question and waits for you) / New (synced from
the bank, not looked at yet) / Categorized, with counts (`by_status`) except on Categorized; the main-tab badge counts
transactions still without a decided category (`txn_open`). Open rows have no Set button — picking a category sets it.
The search sits at the right of the tab row, next to the "Sync with Bank" icon button (`POST /api/bookkeeping/sync`).
**Categorized is a report** (1.18.8): a period row (Last 30 days default, This month, Last month, Last 90 days, This year,
All time, Custom from/to), $ min–max, header filters on Vendor, Account, Category (type or sub category) and Set by
(rule / approved / manual), Clear filters; tiles (spent · count, received, net out), spend by month bars, by type of
expense bars (click to filter), top vendors (click to filter). Filters are query params of `GET /api/bookkeeping/transactions`
(`status, q, from, to, category, type, vendor_id` ('none' = unlinked), `source, min, max, account`); with
`status=categorized` the response adds `totals {count, spent, received, by_type, by_category, by_month, by_vendor}`,
`accounts` and `vendors` for the filter menus. Filter state is remembered per browser (`bk_txn_filters`).

### Page layout (1.18.8)
Main tabs left-aligned in the header, "Bookkeeping AI" + the last-run pill at the right, Connections / Activity icons
after them. Every view is left aligned and capped at 1120px (`.bk-view`), except the Inbox split view which keeps the full width. The email body frame grows to its content (`scrolling=no`, measured from the body's children, ResizeObserver) so the reading pane is the only scrollbar. Table headers (`table.bk th`) are 15.5px, dark, and **sticky**:
the list scrolls under them (`.bk-main` scrolls; its top padding lives on `.bk-view` so a stuck header sits flush).
Search boxes everywhere are regular weight and right-aligned on their row.

## Bills tab and vendor pairing
### The bill card (1.19.11)
Every card shows Nova's own number (**Bill #15**) next to the invoice number, so "possible duplicate of Bill #15" can
be followed: the red tag scrolls to that card (or says it is under another Bills tab), and **Merge into #15** folds the
duplicate in (`POST /api/bookkeeping/bills/:id/merge {into}`): the duplicate is rejected with a note and
`merged_into`, its proposal closed, its purchase cancelled unless it already has a bank line, its email kept on the
surviving bill (role **Duplicate**) and closed in the inbox. The survivor shows "+ 1 duplicate merged". Nothing is deleted.

No subtitle and no "Scan the inbox now" on Pending (scanning lives in the Inbox); no "Open the file" (the attachments
are on the email row). Dates in US format (10-10-2026). The AI's note is one clamped **AI Summary:** line with a chevron
that expands it (1.19.12); an open question is a small **AI question** button at the right of that line (popup,
"answer it in the Daily Brief"). Lines: description ·
**Category** (a picker — changing it saves the line, and the purchase item that came from this bill follows) ·
**Link…** (a material from the catalog via the materials picker, a **machine payment** — a lease or loan
instalment for one of our machines, `machinePicker` over Accounts → Equipment, which also puts the bill and its purchase on
that machine (`equipment_id`) — or a job by estimate number E1234567; `line.material_id / material_name / equipment_id /
equipment_name / estimate_no / material_photo / linked_by`). A linked material shows its photo beside the chip (hover for a
large one). **Nova remembers how lines were linked** (1.19.15): saving a link stores vendor + the line's wording (dates and
parentheses stripped, `lineKey()`) → material / machine / category in `bk_line_links` (`learnLineLink`; unlinking forgets
it), and every new bill from that vendor gets the same links applied on creation (`applyLineLinks`, exact wording first,
then the same start) — those chips carry an **auto** badge, `linked_by: 'rule'` · amount. `POST /api/bookkeeping/bills/:id/lines` saves the whole
line list. Under the lines, every email behind the bill (`bills[].emails`: the one it was read from, the receipt
that paid it, its purchase's confirmation and deliveries — role, subject, time, open / closed) with each attachment
as a chip (one click opens it). Clicking an email opens it in a popup (`emailModal`: header, body, attachments) with
**Take me to the Inbox**, which opens that email in the Inbox (All, open or closed) with the row scrolled into view.

The Bills tab has five sub-tabs by status — **Pending** (drafts), **Approved**, **Scheduled**, **Paid** and **Rejected**
(since 1.19.22 the sub-tabs of every tab are chips in the inbox-basket style — and since 1.19.29 the Inbox baskets and the Purchases views use the same sticky bar with a Search box at its right, the Purchases views being cards titled Purchases / Waiting for the bank / Not received with their description behind the (?); 1.19.30: each purchase row shows the US date with the time it was first seen under it, the vendor in the bill-card style — logo, SUPPLIER / VENDOR tag, "change", or "Not in the CRM directory — is it X?" with "link to a vendor" (`POST /api/bookkeeping/purchases/:id/vendor`, which also links the bill and bank lines behind it when they have none and remembers the name as an alias) — and the Paperwork icons open on click to list what each slot holds: the bill (click → Bills), the bank lines, the confirmation email and the delivery emails (click → the email), same size as the inbox chips since 1.19.28 — every count shown, 0 included — in a
sticky bar so only the list scrolls, with a **Search** box at its right, styled like the Inbox search (1.19.25: filters the cards on screen by vendor, invoice or bill number, amount, AI summary, line names / categories / links and email subjects — the header shows "n of N bills" and the matching total; the text stays when you switch sub-tab); the vendor's "change" / "link to a vendor" link sits beside the vendor name on the card)
(1.19.16: its own tab; a reject asks for a reason — required, multi-line — kept on the proposal as `decision`, shown on
the card as "Rejected by <who> · when — reason"; **Restore to Pending** puts it back, `POST /bills/:id/restore`; merged
duplicates stay merged) — each with a count. After approval a bill is moved by hand: "Schedule payment…" (a pay date →
`bk_bills.scheduled_for`), "Mark paid…" (date + how → `paid_at`, `paid_note`), and back (`POST
/api/bookkeeping/bills/:id/status {status, date, note}`, allowed moves approved ↔ scheduled ↔ paid, audited). Nothing
moves money; this is the ledger until BILL / QuickBooks are connected. **Bills** and **Inbox** are two main tabs (`?tab=inbox`; the Inbox tab carries a badge with the not-yet-read count;
emails not read yet sort to the top). Inbox is a Gmail-like list: status dot (green = read as a bill, grey = skipped, blue = not read,
red = error), sender, subject — snippet on one line, attachment count, time; All / Bills / Skipped / Not read chips and a
search box; a row opens in place with the full snippet, the files, BookkeeperAI's verdict and "Read it as a bill".
Bills are cards: vendor (logo, CRM type, specialty), kind + number, dates, total, status, the AI's note, an open question,
the line items with "Type › Sub category", Open the file, Approve / Reject (the bill's proposal). Decided bills fold under
"n decided bills"; the inbox table sits below. A bill's vendor is paired with the directory: `matchVendor()` (name,
alias, email domain — no first-word guessing, which once sent Pacific Office Automation to Pacific Engravers) at parse time, then `suggestVendors()` — a word-overlap / prefix / initials / domain score over CRM
entries — and a score ≥ 0.85 links by itself ("Pacific Office Automation" ↔ "Pacific Office Automation Inc"). Anything
weaker shows "Not in the CRM directory — is it X or Y?" with the near matches as one-click links and "pick another" (a
searchable picker, near matches first). `POST /api/bookkeeping/bills/:id/vendor {vendor_id, remember}` pairs it, keeps the
bill's vendor name as an alias on the entry (so the next bill links by itself), fixes the pending proposal's `new_vendor`,
and removes the bill-source row if nothing else points at it. `GET /api/bookkeeping/bills` returns `vendor_card`,
`suggestions` (with scores), `proposal_status` and the open `question` per bill.

## Questions and what they teach
A question is answered with a category alone (the answer is stored as "→ <category>" and the proposal is approved with
it), with words alone, or both. Written answers are the lessons: the categorizer gets the last 30 as "WHAT THE OWNER TOLD
US WHEN WE ASKED" (question + answer per transaction) and is told to apply them to similar transactions instead of asking
again — "Uber rides are personal" stops the next Uber question. Approved categories also reach it as "HOW WE CATEGORIZED
BEFORE", and vendor rules (made from approvals with "remember") run before the AI looks at all.

## What the agent may do (its only tools)
`list_pending`, `approve` (by id / all / with a corrected category), `reject`, `answer_question` (records the answer; with
a category it approves the proposal), `add_rule`, `add_category`, `run_now`, `balances`, `materials` (catalog lookup). No SQL, no vendor details, no payments.

## Data
`bk_accounts` (Plaid items), `bk_transactions`, `bk_rules` (vendor → category, keyword → category; made from approvals
with "remember"), `bk_vendors` (approved flag — new vendors always ask), `bk_emails`, `bk_bills` (+ `lines` JSON,
`duplicate_of`), `bk_proposals` (type `category` | `bill`; status pending → approved / edited / rejected), `bk_questions`,
`bk_purchases` (the purchase hub; `purchase_id` on emails, bills, transactions), `bk_briefs`, `bk_runs`, `bk_audit`, `bk_chat`, `bk_settings` (run_at, poll_min, threshold 0.75, categories = the chart
of accounts, notes for the AI, chat_webhook, chat_space, waiting_days, notreceived_days, alert_to, alert_at).

## Open decisions (from the spec, still open)
1. Source of truth for bills (BILL vs QuickBooks) — until decided, approved bills stay in Nova (`bk_bills.status =
   approved`); nothing is pushed.
2. Bill capture: Nova (this) vs BILL's inbox — this build assumes Nova.
3. Chart of accounts: the default list in Rules → "Chart of accounts" is a starting point for the CPA to confirm.
4. QuickBooks / BILL / production consumption: later phases.

## Rules from the bank feed, rule editing, vendor photos (1.19.77)

- **Create a rule** — a categorized line that no rule covers yet shows the link under its Category. It asks first, then
  makes a vendor rule (the linked company's name, else the merchant) with the line's category, ties the line to it, and
  files every pending line of that vendor / wording on the same money side by it. A second rule for the same vendor is refused.
- **Edit a rule** — Accounts → Rules, Edit on the row: kind, pattern and category inline. Changing the category asks
  whether the lines the rule already categorized follow it ("Yes, change all N" / "No, only new lines" / Cancel).
- **Vendor logo / photo** — the Nova vendor form shows the picture (the bank's logo when one was picked up) with a URL
  box, Upload — or paste a copied image (Ctrl+V) anywhere in the form, or drop one on the box — cropped to a centred
  square and shrunk to 160px in the browser, and × to remove.

## Customer payments → Accounts Receivable (1.19.79)

A deposit filed under an income category shows **Notify Accounts Receivable** under its category in the Bank feed. It asks,
then emails the payment's facts (amount, date, the bank's wording, account, channel / check number, linked company, category,
who sent it, a link back) To the AR address, Cc the payments address — Settings → Alerts, defaults gary@axiomprint.com and
paymentsupport@axiomprint.com. The row then reads "AR notified <date> · who", with "again" to resend.

## Transfers between our own accounts (1.19.92)

A credit card payment shows up twice: money out of Wells Fargo and money into the Amex card. Neither is an expense or
income. When the bank feed sees the same amount the other way on another account within a week it shows **⇄ Transfer? Match**
under the category; one click links the two lines, files both as *Credit Card Payment* (or *Transfer Between Accounts* when
no card is involved), and the Stats leave both out. "Transfer between our accounts…" opens a picker when there is no hint;
× on a matched line unmatches both.

## Loans & Leases (1.19.99)

Accounts → **Loans & Leases** is the one place for everything the company owes: loans you add here (SBA, line of credit,
vehicle, owner loan — date borrowed, amount, term, APR, monthly payment) and the machines financed under Equipment, which
appear automatically. The balance is amortized (the interest share of each payment shrinks over time); a lease is the
remaining payments. The strip on top is the balance-sheet view — equipment book value today against what is still owed.
In the Bank feed a payment that matches a loan's lender or monthly amount shows **Loan payment? Match**; matching files it
as *Loan Payment (Principal)* and the loan's "Paid (bank)" column counts it.

### Purchases list, Bank-feed style (1.19.141)

The Purchases table now reads like the Bank feed. Every header is a filter: **Date** (All time, last 30 days, this /
last month, last 90 days, this year, or a From / To range with the calendar picker), **Vendor** (supplier / vendor / Nova
vendor / from a bill / not linked) and **Company** side by side, **Amount** (From / To), **Category** (by type of expense
or a single category) and **Status**. The vendor cell shows the logo with its kind under it and the company name with a
pencil to change it; an unlinked purchase shows Nova's best match with a **Use** button. The amount has "paid 10-06-2026"
under it when the bank line is matched. The category is a picker that saves at once — on the purchase and on the bank lines
behind it. **Status** is two things: the money (awaiting bank / awaiting payment / **paid** / **closed** / cancelled) and a
**delivery dropdown** — *Not applicable* for a service or a fee (the purchase is then *closed* once paid), or *Not received →
Partially received → Received* for goods (the purchase is *paid* until it is received, then *closed*). Picking *Partially
received* asks what came.

### Loan payments connect themselves (1.19.144)

The first payment is the only click. In the Bank feed a line from the lender for the loan's monthly amount shows **Loan
payment? → Match**; matching it files the line under Loan Payment (Principal) and — when the loan has no lender yet — makes
the lender a Nova vendor from the bank line (Highland Capital, with the statement wording as its alias) and sets it on the
loan. From then on every line from that lender for the monthly amount (within 2%) links to the loan by itself, no click,
and the earlier ones are picked up at once. A loan with no lender never auto-links.

Each loan has a **payment calendar** in the Loans & Leases table, credit-report style: one square per contract month
(hatched = no payment due yet, green = paid, red = missed, amber = due this week, white = upcoming), "64 of 72 paid",
hover a square for the month, the due date and the bank line. Payments only mark the calendar — the balance stays the
contract's amortization. A month that passes its due day by a week with no payment seen at the bank is emailed to the
alerts address the next morning, once per loan-month.

### Loans from the agreement (1.19.135)

A loan can be entered the way the agreement reads: amount financed, **down payment / advance**, **months with no payment
first**, the number of monthly payments, the monthly amount and the **total to be paid back** — the APR can stay blank and
Nova works out the effective rate from the payments (the Screen L350 financing: 395,000 with 39,500 down, two months
skipped, 72 × 5,808 = 457,676 in all → 5.2% effective). Money fields show thousands separators ("395,000.00") and a line
under the form updates as you type with the financed amount, monthly, APR, total back and interest. A loan that finances a
machine shows on that machine's row under Equipment — pill, financing, monthly progress, payments and book value — with a
link back to Loans & Leases.

Taxes and documents (1.19.136): a loan records the **sales tax** on the deal and whether it was financed with the product
(inside the amount borrowed) or paid separately (how leases usually work), and the **property tax a leasing company adds to
the monthly payment** — Nova shows the bank payment (loan payment + property tax) beside the loan payment, matches either
figure in the Bank feed, and keeps the property tax out of the amortization. The edit form has a **Documents** area:
drop, choose or paste the signed agreement, terms and schedules (PDF, pictures, Word, Excel, up to 25 MB each); they are
kept on the server, listed with who added them and when, and can be opened, downloaded or removed. Every date field in
Bookkeeping now uses Nova's own calendar picker (month grid, month / year dropdowns, Today, Clear; dates read 10/01/2026
and can be typed as 10/1/26).

### Uncategorize (1.19.149)

In the Bank feed's **Categorized** view the Category picker ends with **↺ Uncategorize**: the line goes back to Pending with no category, and whatever the category came with (a rule, a team member, a loan, a transfer or refund match) is undone. Rules and the AI then leave that line alone until a person files it again. Only the Categorized view has the link.

### Rule amount conditions and "No rule" (1.19.112)

- A rule can be limited to lines **over**, **under**, **exactly** or (1.19.151) **between** two amounts (the line's absolute amount, money in or out). Blank = any amount, so existing rules are unchanged. When a vendor has both a plain rule and an amount rule, the amount rule is tried first.
- **Money side** (1.19.146, `bk_rules.side`): a rule can be limited to **Received** (deposits, money in) or **Paid** (charges, money out); **Any** (the default, and what every older rule has) matches both. The Rules form and the Edit row have the Any | Received | Paid select before the amount, and the table shows it in a Money column. A rule with a side or an amount is tried before a plain rule for the same vendor, so "Stripe · Received → Customer Payment" beats "Stripe → Merchant Fees" on a deposit. Rules made from the Bank feed's "Make it a rule?" start as Any.
- **No rule for vendor** (`bk_rules.kind = 'none'`): the vendor is never filed by rule and Nova stops offering "Make it a rule?" / "Create a rule" for it (eBay, where every purchase is different). Set it from Accounts → Rules, from the "Never for <vendor>" button on the Make-it-a-rule question, or the "· no rule" link beside Create a rule. Remove it under Accounts → Rules.

### Overseas Team (1.19.119)

**From the Axiom CRM (1.19.148).** "+ Add from Axiom" lists the CRM staff (name, title and team, country flag, start date; inactive accounts greyed, people already on the team marked). Adding one pulls the full name, department, start date and status from the CRM and keeps them in step on every visit — those fields are greyed in the form, as are pay, pay period, Wise reference, end date and notes, which the CRM will carry soon. What Nova fills in is **Files under** and the **Maintenance category**. A person who is not in the CRM can still be typed in by hand.

Accounts → **Overseas Team** lists the people paid through Wise — name, country (Armenia / Mexico / Philippines flags), department (graphic design, web development, customer service), pay per period, the category their payouts file under, and an optional maintenance category for web development (the main one being the capitalized build). Each person is also a Nova vendor.

Wise payouts reach the bank with no recipient name, so Nova recognises a person by the Wise reference code (when it stays the same for them) or by their exact pay. A matched payout is linked to the person and filed under their category on its own; when two people are on the same pay, the Bank feed shows **Who is this?** with a picker. Picking someone for a different amount can remember it as their new pay. Wise lines never get vendor aliases or rules — the team list is what files them.
