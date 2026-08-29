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

- `index.html` — login + legacy all-in-one chat + admin panel, with its JS inline in the file
- `order-assist.html` + `order-assist.js` (~2700 lines) — the real product: stepped flow, calculator
  widget, quote boxes, reorder, file upload/paste, Drive thumbnails
- `admin.html` — members, agent training, knowledge docs, connection status
- `prepress.html` + `prepress.js` — **orphaned**: it calls `/api/prepress/chat`, which does not exist in
  server.js. The `prepress-ai` agent is seeded as `coming_soon`.

The stepped flow is the default; `sendMessage(forceClassic)` or the `steppedToggle` checkbox falls back
to `/api/chat` for debugging.

## Known quirks worth respecting

- **`estimate.production_status` is stale.** True production state is the newest `qr_scan_history` row
  for that `estimate_id`. This is stated in DATA_DICTIONARY and enforced in the `get_job` MCP tool.
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
