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
3. Dashboard → Team Settings → Webhooks: `https://nova.axiomprint.com/api/bookkeeping/plaid/webhook` (Nova also
   passes it with every Link token).
4. Nova → Bookkeeping AI → Connections → **Connect a bank**, sign in to each bank (Plaid Link in the browser).
   Access tokens are stored AES-256-GCM encrypted (key derived from `JWT_SECRET`); the first 90 days sync at once.

### 2. accounting@axiomprint.com
Read with the service account in `/opt/axiom-ai/gmail-key.json`, impersonating `BOOKKEEPER_INBOX` (default
`accounting@axiomprint.com`) exactly as Nova reads order@. Domain-wide delegation is per domain, so nothing new is
needed unless the scan logs `unauthorized_client` — then add `https://www.googleapis.com/auth/gmail.readonly` to the
client id's scopes in Google Admin → Security → API controls → Domain-wide delegation. PDF and image attachments are
saved; the first scan looks back `backfill_days` (7); our own `@axiomprint.com` mail is skipped.

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
`crm_id`, email, phone, specialty, contact, address) on every daily run and on **Refresh from CRM**; they come in
approved. A bank line is linked to a directory entry (`bk_transactions.vendor_id`) when the entry's name, one of its
bank-statement aliases, or (for bills) its email domain matches; the AI is told "OUR VENDOR: Veritiv — Paper → usually
Paper" and gets the whole directory as context. Approving a category for a linked transaction fills the vendor's
*usual category* (editable in the tab, with the aliases). Vendors first seen on a bill (`source` = bill) wait for
approval in the tab's second list. Edit names, emails and specialties in the CRM, not here.

## What the agent may do (its only tools)
`list_pending`, `approve` (by id / all / with a corrected category), `reject`, `answer_question` (records the answer; with
a category it approves the proposal), `add_rule`, `run_now`, `balances`. No SQL, no vendor details, no payments.

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
