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
2. `.env`: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox|production` → `pm2 restart axiom-ai`.
3. No dashboard webhook to configure (Team Settings → Webhooks only lists Transfer / Wallet / Income events): the
   Transactions webhook `https://nova.axiomprint.com/api/bookkeeping/plaid/webhook` is set per connection by the Link
   token Nova creates.
4. Nova → Bookkeeping AI → Connections → **Connect a bank**, sign in to each bank (Plaid Link in the browser).
   Access tokens are stored AES-256-GCM encrypted (key derived from `JWT_SECRET`); the first 90 days sync at once.

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

### Gmail is the truth (1.18.22)
Open / closed follows Gmail's UNREAD label both ways: the scan closes open rows no longer unread in Gmail (`read_by =
'gmail'`) and **re-opens** closed rows (not set-aside ones) that are unread in Gmail again (`unread_again` in the scan
result). "Mark as read" / "Mark all … as read" change Gmail **first** (`markReadInGmail`) and only then Nova — if Gmail
refuses (missing `gmail.modify` scope) nothing changes here and the dialog says why. "Mark as unread" (closed emails,
`POST /api/bookkeeping/emails/:id/unread`) adds UNREAD back and re-opens the row. Clicking an email never marks it read;
only the buttons do. Every basket has **Open** (unread in Gmail) / **Closed** (read) segments with counts, so a basket
keeps its history; the chip count is the open count, action bars show in Open only. A wrong count is fixed by Scan now.

### Baskets (1.18.13)
`scanInbox` lists `is:unread in:inbox` mail (no date limit), so the inbox here follows the team's Gmail unread count, plus mail already read in Gmail from the last `backfill_days` (default 30) stored as `skipped` / `read_by = 'gmail'` for the **Everything else** basket (rated too — `TO_RATE` — but never moved);
open rows (`new` / `message`) whose Gmail id is no longer unread are set aside with `read_by = 'gmail'`. The first chip is **Not read** (every open email, the default); then the baskets by rating: **Bills** (kind bill, drafts excluded from the count), **Direct messages**, **Ads**,
**Confirmations** (notification + receipt), **Other**, **Not rated**, and **Set aside**; plus **Everything else** (read — in Gmail, marked read here, or by the AI) and **Set aside** (`bk_emails.aside = 1`: only what a person parks with Move to… → Set aside; nothing lands there by itself, Gmail untouched). Every basket chip is always shown, with its count. With no email selected the list takes the whole width, one line per email (`.ib-split.lines`); clicking opens the split view, × goes back. Each basket has its own action bar: "Mark all N ads / confirmations / other as read" (`POST /inbox/set-aside`, Nova
only — Gmail is never written), "Turn all N into bills" (parses each → Bills), "Rate them now". The reading pane has
**Turn into a bill** (or **Open in Bills →** for a draft), Mark as read, and **Move to…** (`POST /api/bookkeeping/emails/:id/kind`
— replaces the rating with confidence 1, `message` sets status `message`). `POST /api/bookkeeping/inbox/reset` (no button any more; curl it with a bookkeeper token) deletes every `bk_emails` row with no bill (and its saved attachments) and audits `gmail.reset`. People are shown as a face (`whoHtml`: member photo or initial, from `overview.people`) in notes ("moved to … by"), the Runs table and the audit log; the agent / executor / poll keep their word. No Plain text button — text is the fallback when an email has no HTML.
The last-checked time is the Scan now button's tooltip. Yes/no questions use the styled `ask()` dialog (title, text, named button), never the browser confirm().

### Reading pane
The Inbox is a split view: the list on the left (two-line rows: sender + time, subject, snippet + kind tag + attachments),
the selected email on the right. The pane shows the email the way Gmail shows it: subject, sender (name + address, "to accounting@"), date,
the rating / verdict line (and the bill it became), the HTML body in a sandboxed iframe (`bk_emails.body_html`, scripts / forms / handlers stripped by `emailHtml()`; rows
scanned before 1.18.7 fetch it once on open; "Plain text" falls back to `body`), attachment cards (image thumbnails,
PDF icon) that open a viewer (PDF in a frame, image as is, Download / Open in a tab), and Read it as a bill / Mark as read.
`GET /api/bookkeeping/emails/:id` (full record + `bill`), `GET /api/bookkeeping/emails/:id/att/:i` (the file, inline).
### Transactions tab
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
The Bills tab has four sub-tabs by status — **Pending** (drafts; rejected folded below), **Approved**, **Scheduled**,
**Paid** — each with a count. After approval a bill is moved by hand: "Schedule payment…" (a pay date →
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
`bk_briefs`, `bk_runs`, `bk_audit`, `bk_chat`, `bk_settings` (run_at, poll_min, threshold 0.75, categories = the chart
of accounts, notes for the AI, chat_webhook, chat_space).

## Open decisions (from the spec, still open)
1. Source of truth for bills (BILL vs QuickBooks) — until decided, approved bills stay in Nova (`bk_bills.status =
   approved`); nothing is pushed.
2. Bill capture: Nova (this) vs BILL's inbox — this build assumes Nova.
3. Chart of accounts: the default list in Rules → "Chart of accounts" is a starting point for the CPA to confirm.
4. QuickBooks / BILL / production consumption: later phases.
