/**
 * Bookkeeping AI ("BookkeeperAI") — Nova's bookkeeping agent. Spec: docs/BOOKKEEPING_AI.md.
 *
 * The agent PROPOSES, a person APPROVES, the executor applies. Every proposal has a confidence and a reason;
 * nothing touches the books, a vendor's details or money without an approval, and every action is logged in
 * bk_audit. The AI never runs SQL: it only has the narrow tools below (list / approve / reject / answer / rule).
 *
 * Intake
 *   Plaid     — bank transactions (transactions/sync with a cursor). Webhook SYNC_UPDATES_AVAILABLE triggers a
 *               sync straight away (signature verified with Plaid's JWK); the daily run syncs anyway.
 *   Gmail     — the accounting inbox (BOOKKEEPER_INBOX, default accounting@axiomprint.com), read with the same
 *               service-account key Nova already uses for order@ (domain-wide delegation; add the inbox's mailbox
 *               to nothing — delegation covers every user of the domain). Polled every BOOKKEEPER_POLL_MIN
 *               minutes; Gmail push (Pub/Sub → /api/bookkeeping/gmail/push) triggers a scan immediately when set up.
 *   Daily run — BOOKKEEPER_RUN_AT (default 07:00 Los Angeles): sync, scan, categorize, write the Daily Brief,
 *               post it to Google Chat.
 *
 * Google Chat — the brief and the conversation with Gary and Arsine. Either a Chat app (two-way: Nova posts
 * with the service account, Google POSTs the people's messages to /api/bookkeeping/chat/events) or, until that
 * is set up, a space's incoming-webhook URL (post only). The same conversation runs in the Nova tab.
 *
 * Who: BOOKKEEPER_USERS (emails / usernames; default gary@axiomprint.com) open the tab and the API; in Google
 * Chat only BOOKKEEPER_CHAT_USERS (default gary@ and arsine@axiomprint.com) can approve or answer.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');   // only for mysql.escape() in the read-only CRM look-ups

module.exports = function mountBookkeeping(app, deps) {
  const { db, crypto, anthropic, auth, serveVersionedHtml, google, keyPath, runQuery, sendMail } = deps;
  const MODEL = process.env.BOOKKEEPER_MODEL || deps.model;
  const MODEL_LIGHT = process.env.BOOKKEEPER_MODEL_LIGHT || deps.modelLight || MODEL;   // triage: cheap, text only
  const env = (k) => String(process.env[k] || '').trim();
  const NOVA_URL = (env('NOVA_PUBLIC_URL') || 'https://nova.axiomprint.com').replace(/\/+$/, '');
  const FILES = process.env.BOOKKEEPER_FILES_DIR || path.join(deps.dataDir, 'bookkeeping-files');
  const INBOX = env('BOOKKEEPER_INBOX') || 'accounting@axiomprint.com';
  const USERS = (env('BOOKKEEPER_USERS') || 'gary@axiomprint.com').toLowerCase().split(/\s*,\s*/).filter(Boolean);
  const CHAT_USERS = (env('BOOKKEEPER_CHAT_USERS') || 'gary@axiomprint.com,arsine@axiomprint.com').toLowerCase().split(/\s*,\s*/).filter(Boolean);
  const PLAID_ENV = env('PLAID_ENV') || 'sandbox';
  const PLAID_BASE = 'https://' + PLAID_ENV + '.plaid.com';
  const log = (...a) => console.log('BOOKKEEPER', ...a);
  const errlog = (...a) => console.error('BOOKKEEPER', ...a);

  // ---------------------------------------------------------------- tables
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS bk_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS bk_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE, access_token TEXT, institution TEXT,
      accounts TEXT, cursor TEXT, status TEXT DEFAULT 'ok', error TEXT, last_sync_at TEXT, created_at TEXT DEFAULT (datetime('now')), created_by TEXT)`);
    db.run('ALTER TABLE bk_accounts ADD COLUMN env TEXT', () => {});   // 1.19.46: sandbox | production — a sandbox connection is useless once PLAID_ENV is production
    db.run("UPDATE bk_accounts SET env = 'sandbox' WHERE env IS NULL", () => {});   // every connection made before 1.19.46 was a sandbox one (Production was approved on 10-12-2026)
    ['institution_id TEXT', 'logo TEXT', 'color TEXT'].forEach(c => db.run('ALTER TABLE bk_accounts ADD COLUMN ' + c, () => {}));   // 1.19.47: the bank's logo (Plaid institution metadata)
    db.run("ALTER TABLE bk_accounts ADD COLUMN excluded TEXT DEFAULT '[]'", () => {});   // 1.19.57: account_ids not in use (a personal account on the same login)
    db.run('ALTER TABLE bk_transactions ADD COLUMN prev_status TEXT', () => {});        // status before the account was excluded
    db.run('ALTER TABLE bk_transactions ADD COLUMN refund_of INTEGER', () => {});       // 1.19.60: a money-in line that gives back this charge (id)
    db.run('ALTER TABLE bk_transactions ADD COLUMN ar_notified_at TEXT', () => {});     // 1.19.79: Accounts Receivable told about this customer payment
    db.run('ALTER TABLE bk_transactions ADD COLUMN ar_notified_by TEXT', () => {});
    db.run('ALTER TABLE bk_transactions ADD COLUMN check_image TEXT', () => {});
    db.run('ALTER TABLE bk_transactions ADD COLUMN transfer_of INTEGER', () => {});       // 1.19.92: the other side of a transfer between our own accounts (id)        // 1.19.89: a photo of the check, attached by a person (data URL)
    ['vendor_by TEXT', 'vendor_score REAL', 'suggest_vendor_id INTEGER', 'suggest_score REAL'].forEach(c => db.run('ALTER TABLE bk_transactions ADD COLUMN ' + c, () => {}));   // 1.19.47: who linked the vendor (auto ≥ 95% / person) and the best near match
    db.run(`CREATE TABLE IF NOT EXISTS bk_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, txn_id TEXT UNIQUE, item_id TEXT, account_ref TEXT,
      account_name TEXT, date TEXT, name TEXT, merchant TEXT, amount REAL, pending INTEGER DEFAULT 0, plaid_category TEXT,
      category TEXT, category_source TEXT, rule_id INTEGER, proposal_id INTEGER, status TEXT DEFAULT 'new', raw TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    db.run('CREATE INDEX IF NOT EXISTS bk_txn_date ON bk_transactions(date)');
    db.run(`CREATE TABLE IF NOT EXISTS bk_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, pattern TEXT, category TEXT, vendor TEXT,
      note TEXT, source TEXT, created_by TEXT, hits INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`);
    // 1.19.112: an optional amount condition ("over" / "under" $n on the line's absolute amount; blank = any amount), and
    // kind 'none' = "No rule" for a vendor: never file it by rule and never offer "Make it a rule?" / "Create a rule" for it.
    ['amount_op TEXT', 'amount_val REAL'].forEach(c => db.run('ALTER TABLE bk_rules ADD COLUMN ' + c, () => {}));
    db.run(`CREATE TABLE IF NOT EXISTS bk_vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, approved INTEGER DEFAULT 0, email TEXT,
      default_category TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), approved_by TEXT, approved_at TEXT)`);
    // 1.15.3 made bk_vendors.name UNIQUE; a company can be both a supplier and a vendor in the CRM, so the first
    // CRM sync failed. Rebuild the table without the constraint (ids kept).
    db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bk_vendors'", (e, row) => {
      if (e || !row || !/UNIQUE/i.test(row.sql || '')) return;
      const NEW = ['id', 'name', 'approved', 'email', 'default_category', 'notes', 'created_at', 'approved_by', 'approved_at', 'source', 'crm_id', 'phone', 'specialty', 'contact', 'address', 'aliases', 'synced_at', 'photo', 'kind', 'details'];
      db.all('PRAGMA table_info(bk_vendors)', (e2, cols) => {
        if (e2) return console.error('BK vendors migration', e2.message);
        const keep = NEW.filter(c => (cols || []).some(x => x.name === c)).join(', ');
        db.serialize(() => {
          db.run('ALTER TABLE bk_vendors RENAME TO bk_vendors_old');
          db.run(`CREATE TABLE bk_vendors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, approved INTEGER DEFAULT 0, email TEXT, default_category TEXT, notes TEXT,
            created_at TEXT DEFAULT (datetime('now')), approved_by TEXT, approved_at TEXT, source TEXT, crm_id INTEGER, phone TEXT, specialty TEXT, contact TEXT, address TEXT, aliases TEXT, synced_at TEXT, photo TEXT, kind TEXT, details TEXT)`);
          db.run(`INSERT INTO bk_vendors (${keep}) SELECT ${keep} FROM bk_vendors_old`);
          db.run('DROP TABLE bk_vendors_old', er => console.log(er ? 'BK vendors migration failed: ' + er.message : 'BK vendors table rebuilt without the name constraint'));
        });
      });
    });
    // The CRM materials catalog (CRM → Products → Materials): every material with its GEO type / sub type, production
    // team, step and the supplier it is bought from. Read-only mirror, synced with the directory.
    db.run(`CREATE TABLE IF NOT EXISTS bk_materials (id INTEGER PRIMARY KEY AUTOINCREMENT, crm_id INTEGER UNIQUE, name TEXT, material TEXT, type TEXT, step TEXT,
      geo_type_id INTEGER, geo_type TEXT, geo_sub_type_id INTEGER, geo_sub_type TEXT, teams TEXT, supplier_text TEXT, vendor_id INTEGER, manufacturer TEXT,
      cost REAL, stock INTEGER, location TEXT, code TEXT, axiom_id TEXT, size TEXT, thickness REAL, color TEXT, photo TEXT, synced_at TEXT)`);
    db.run('CREATE INDEX IF NOT EXISTS bk_mat_vendor ON bk_materials(vendor_id)');
    // Equipment: the CRM's machine list (name, photo, team — read-only mirror) plus how each one is financed, kept here:
    // owned outright (depreciation), on a loan (price, down payment, loan amount, term, rate → balance sheet; the monthly
    // payment is split later into principal and interest), or leased (every payment is an expense on the P&L).
    db.run(`CREATE TABLE IF NOT EXISTS bk_equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, crm_id INTEGER UNIQUE, name TEXT, photo TEXT, team TEXT, active INTEGER DEFAULT 1,
      vendor_id INTEGER, mode TEXT, purchase_price REAL, purchase_date TEXT, down_payment REAL, loan_amount REAL, loan_term INTEGER, loan_rate REAL, loan_start TEXT, monthly_payment REAL,
      lease_term INTEGER, lease_start TEXT, lease_monthly REAL, life_years REAL, salvage REAL, notes TEXT, updated_by TEXT, updated_at TEXT, synced_at TEXT)`);
    ['bk_bills', 'bk_transactions', 'bk_purchases'].forEach(t => db.run('ALTER TABLE ' + t + ' ADD COLUMN equipment_id INTEGER', () => {}));
    // 1.19.99: loans and leases that are not a machine's financing (SBA loan, line of credit, vehicle, owner loan) — or that
    // finance a machine when `equipment_id` is set; bank lines link to one with loan_id
    db.run(`CREATE TABLE IF NOT EXISTS bk_loans (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT DEFAULT 'loan', lender TEXT, vendor_id INTEGER, equipment_id INTEGER,
      principal REAL, start_date TEXT, term_months INTEGER, apr REAL, monthly REAL, balloon REAL, notes TEXT, status TEXT DEFAULT 'active',
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    db.run('ALTER TABLE bk_transactions ADD COLUMN loan_id INTEGER', () => {});
    // 1.19.135: a loan can start with a down / advance payment, skip some months before the regular payments, and be
    // entered from the agreement's "total finance amount" instead of an APR (the effective rate is then solved).
    // sales tax (inside the financed amount, or paid separately — leases usually) and the lender's monthly property-tax charge
    // 1.19.136: documents behind a loan — the signed agreement, terms, schedules (PDF / image / Word / Excel) in FILES/loans
    db.run(`CREATE TABLE IF NOT EXISTS bk_files (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, name TEXT, mime TEXT, size INTEGER, file TEXT NOT NULL, label TEXT, uploaded_by TEXT, created_at TEXT NOT NULL)`);
    db.run('CREATE INDEX IF NOT EXISTS idx_bk_files_ref ON bk_files(kind, ref_id)', () => {});
    ['down_payment REAL', 'deferred_months INTEGER', 'total_payback REAL', 'sales_tax REAL', 'tax_in INTEGER', 'property_tax_monthly REAL', 'down_to TEXT'].forEach(c => db.run('ALTER TABLE bk_loans ADD COLUMN ' + c, () => {}));
    // 1.19.119: the overseas team — people paid through Wise (graphic design, web development, customer service…).
    // Each member is also a Nova vendor (vendor_id) so the feed shows the person; `pay` per period and `wise_ref` match the
    // bank line (Wise puts no recipient name on the statement), `category` files it, `category_alt` is the web-dev
    // maintenance category (the default `category` being the capitalized build).
    db.run(`CREATE TABLE IF NOT EXISTS bk_team (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, country TEXT, department TEXT, pay REAL, period TEXT DEFAULT 'semi',
      category TEXT, category_alt TEXT, wise_ref TEXT, vendor_id INTEGER, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'active', notes TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    db.run('ALTER TABLE bk_transactions ADD COLUMN team_id INTEGER', () => {});
    db.run('ALTER TABLE bk_bills ADD COLUMN merged_into INTEGER', () => {});
    // How bill lines were linked by hand: vendor + the line's wording → material / machine. The next bill from that
    // vendor with the same wording links by itself (1.19.15).
    db.run(`CREATE TABLE IF NOT EXISTS bk_line_links (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER, pattern TEXT, material_id INTEGER, material_name TEXT, material_photo TEXT,
      equipment_id INTEGER, equipment_name TEXT, category TEXT, uses INTEGER DEFAULT 1, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(vendor_id, pattern))`);   // a duplicate folded into the bill it repeats (1.19.14)
    // What is inside a purchase: the line items the AI read from its email / bill (name, qty, amount, picture), each one
    // linked to a material in the catalog (or left Unknown) and to a chart-of-accounts category; shipping / tax / fees
    // are rows of their own kind, so the small shipping part of an invoice can go to Shipping.
    db.run(`CREATE TABLE IF NOT EXISTS bk_purchase_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER, pos INTEGER DEFAULT 0, kind TEXT DEFAULT 'item', name TEXT, qty REAL, unit_price REAL, amount REAL,
      photo TEXT, material_id INTEGER, category TEXT, email_id INTEGER, source TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    db.run('CREATE INDEX IF NOT EXISTS bk_pitem_p ON bk_purchase_items(purchase_id)');
    db.run(`CREATE TABLE IF NOT EXISTS bk_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, gmail_id TEXT UNIQUE, thread_id TEXT, from_addr TEXT,
      subject TEXT, received_at TEXT, snippet TEXT, body TEXT, attachments TEXT, status TEXT DEFAULT 'new', note TEXT,
      created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS bk_bills (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id INTEGER, vendor TEXT, vendor_id INTEGER, invoice_no TEXT,
      invoice_date TEXT, due_date TEXT, terms TEXT, subtotal REAL, tax REAL, total REAL, currency TEXT DEFAULT 'USD', kind TEXT DEFAULT 'invoice',
      duplicate_of INTEGER, lines TEXT, file TEXT, file_name TEXT, status TEXT DEFAULT 'draft', proposal_id INTEGER, note TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    ['scheduled_for TEXT', 'paid_at TEXT', 'paid_note TEXT', 'receipt_email_id INTEGER'].forEach(c => db.run('ALTER TABLE bk_bills ADD COLUMN ' + c, () => {}));
    db.run('ALTER TABLE bk_transactions ADD COLUMN receipt_email_id INTEGER', () => {});
    // Purchases (1.19): the hub one money event's paperwork hangs off — the bill, the bank line(s), the confirmation
    // email, the arrival email(s). Status and receiving are derived from what is attached.
    db.run(`CREATE TABLE IF NOT EXISTS bk_purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER, vendor TEXT, amount REAL, date TEXT, order_no TEXT,
      category TEXT, bill_id INTEGER, confirm_email_id INTEGER, txn_ids TEXT DEFAULT '[]', arrival_email_ids TEXT DEFAULT '[]',
      expects_delivery INTEGER, received TEXT DEFAULT 'no', received_at TEXT, received_note TEXT, no_paperwork INTEGER DEFAULT 0,
      cancelled INTEGER DEFAULT 0, note TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT, alerted_at TEXT)`);
    ['bk_emails', 'bk_bills', 'bk_transactions'].forEach(t => db.run('ALTER TABLE ' + t + ' ADD COLUMN purchase_id INTEGER', () => {}));
    ['kind TEXT', 'confidence REAL', 'triaged_at TEXT', 'read_by TEXT', 'body_html TEXT', 'aside INTEGER DEFAULT 0', 'vendor_id INTEGER', 'matched_bill_id INTEGER', 'matched_txn_id INTEGER', 'decided_kind TEXT', 'decided_by TEXT', 'decided_at TEXT'].forEach(c => db.run('ALTER TABLE bk_emails ADD COLUMN ' + c, () => {}));
    db.run(`CREATE TABLE IF NOT EXISTS bk_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, ref_table TEXT, ref_id INTEGER, title TEXT,
      payload TEXT, confidence REAL, reason TEXT, status TEXT DEFAULT 'pending', decided_by TEXT, decided_at TEXT, decision TEXT,
      created_at TEXT DEFAULT (datetime('now')))`);
    db.run('CREATE INDEX IF NOT EXISTS bk_prop_status ON bk_proposals(status)');
    db.run(`CREATE TABLE IF NOT EXISTS bk_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id INTEGER, question TEXT, answer TEXT,
      answered_by TEXT, answered_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS bk_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, started_at TEXT DEFAULT (datetime('now')), finished_at TEXT,
      ok INTEGER, summary TEXT, started_by TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS bk_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT (datetime('now')), who TEXT, action TEXT, ref TEXT, detail TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS bk_briefs (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT UNIQUE, text TEXT, stats TEXT, posted_at TEXT,
      post_error TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    // The vendor directory: the CRM's `suppliers` and `vendors` tables (read-only, synced), plus vendors first seen on a bill.
    ['source TEXT', 'crm_id INTEGER', 'phone TEXT', 'specialty TEXT', 'contact TEXT', 'address TEXT', 'aliases TEXT', 'synced_at TEXT', 'photo TEXT', 'kind TEXT', 'details TEXT'].forEach(c => db.run('ALTER TABLE bk_vendors ADD COLUMN ' + c, () => {}));
    db.run('ALTER TABLE bk_transactions ADD COLUMN vendor_id INTEGER', () => {});
    db.run(`CREATE TABLE IF NOT EXISTS bk_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT (datetime('now')), channel TEXT, space TEXT,
      thread TEXT, sender TEXT, sender_email TEXT, direction TEXT, text TEXT, tools TEXT)`);
  });
  const dbGet = (sql, p) => new Promise((ok, no) => db.get(sql, p || [], (e, r) => e ? no(e) : ok(r)));
  const dbAll = (sql, p) => new Promise((ok, no) => db.all(sql, p || [], (e, r) => e ? no(e) : ok(r)));
  const dbRun = (sql, p) => new Promise((ok, no) => db.run(sql, p || [], function (e) { e ? no(e) : ok(this); }));
  const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  // ---------------------------------------------------------------- settings, audit, access
  // The chart of accounts is a tree: a line with no indent is a parent (type of expense), an indented line ("  Paper" or
  // "- Paper") is a sub category under it. Only sub categories (and parents without children) are used on transactions.
  const OLD_FLAT_CATEGORIES = [
    'Paper', 'Inks & Toner', 'Printing Supplies', 'Outsourced Printing', 'Freight & Shipping', 'Equipment Repairs & Maintenance',
    'Rent', 'Utilities', 'Payroll', 'Payroll Taxes', 'Insurance', 'Software & Subscriptions', 'Advertising & Marketing', 'Office Supplies',
    'Vehicle & Fuel', 'Meals', 'Travel', 'Professional Fees', 'Bank Fees & Interest', 'Merchant Fees', 'Taxes & Licenses',
    'Equipment (Fixed Asset)', 'Software Development (Capitalized)', 'Leasehold Improvements', 'Loan Payment (Principal)',
    'Owner Distribution', 'Transfer Between Accounts', 'Credit Card Payment', 'Customer Payment (Income)', 'Sales Tax Payable', 'Refund'
  ];
  const DEFAULT_CHART = [
    'Cost of Goods Sold', '  Paper', '  Inks & Toner', '  Printing Supplies', '  Outsourced Printing', '  Freight & Shipping', '  Local Delivery', '  Packaging',
    'Facilities', '  Rent', '  Utilities', '  Equipment Repairs & Maintenance', '  Janitorial & Building',
    'People', '  Payroll', '  Payroll Taxes', '  Employee Benefits', '  Contractors',
    'Insurance', '  Business Insurance', '  Workers Comp', '  Vehicle Insurance',
    'Operations', '  Software & Subscriptions', '  Office Supplies', '  Telephone & Internet',
    'Vehicles', '  Vehicle & Fuel', '  Vehicle Repairs', '  Parking & Tolls',
    'Sales & Marketing', '  Advertising & Marketing', '  Website & SEO', '  Samples & Promotion',
    'Travel & Meals', '  Travel', '  Meals',
    'Fees & Taxes', '  Professional Fees', '  Bank Fees & Interest', '  Merchant Fees', '  Taxes & Licenses',
    'Assets & Capital', '  Equipment (Fixed Asset)', '  Software Development (Capitalized)', '  Leasehold Improvements',
    'Not an expense', '  Loan Payment (Principal)', '  Owner Distribution', '  Transfer Between Accounts', '  Credit Card Payment', '  Sales Tax Payable',
    'Income', '  Customer Payment (Income)', '  Refund', '  Other Income'
  ];
  const DEFAULT_CATEGORIES = DEFAULT_CHART;
  const SETTING_DEFAULTS = {
    run_at: env('BOOKKEEPER_RUN_AT') || '07:00', poll_min: parseInt(env('BOOKKEEPER_POLL_MIN')) || 30, threshold: 0.75,
    triage_ad: 0.95, triage_bill: 0.8, triage_notice: 0.75, triage_message: 0.6,   // inbox triage: when BookkeeperAI acts on its own
    triage_auto: 0,   // 0 = BookkeeperAI only RATES emails; a person sets them aside ("Set aside all ads"). 1 = it sets aside by itself above the thresholds.
    categories: DEFAULT_CATEGORIES.join('\n'), chat_webhook: env('BOOKKEEPER_CHAT_WEBHOOK') || '', chat_space: '',
    backfill_days: parseInt(env('BOOKKEEPER_BACKFILL_DAYS')) || 30,
    notreceived_days: 30, waiting_days: 30, alert_to: env('BOOKKEEPER_ALERT_TO') || 'gary@axiomprint.com', alert_at: '08:00', ar_to: env('BOOKKEEPER_AR_TO') || 'gary@axiomprint.com', ar_cc: env('BOOKKEEPER_AR_CC') || 'paymentsupport@axiomprint.com', gmail_history_id: '', gmail_watch_expires: '',
    notes: 'AxiomPrint is a print shop in Glendale, CA. Inks, paper, printing supplies and outsourced printing are cost of goods. Equipment over $2,500 is a fixed asset, not an expense. Transfers between our own accounts and credit card payments are not expenses.'
  };
  let settingsCache = null;
  // The inbox baskets: what each one means, in the team's words. Shown under the (?) of every basket, edited under
  // Settings → Inbox, and given to the light model as the sorting rules — change the words and the sorting follows.
  const BASKET_DEFAULTS = {
    all: 'Everything is sorted. Incoming mail is checked every {poll} min (or press Scan).',
    bill: 'Any incoming email is categorized as a bill if there is a future payment to be made. Mostly will have a PDF attachment.',
    receipt: 'Any incoming email that is related to payments is categorized here. It can be a subscription payment, a QuickBooks scheduled payment, any "thank you for your payment" email, or an order confirmation.',
    arrival: 'Any email that is related to delivery, shipment or arrival notices (shipped, tracking number, out for delivery, delivered) goes here.',
    message: 'Emails that come directly from people to our accounting team. It can be about filling out forms, requesting a 1099, a question, a reply.',
    advertisement: 'Emails that contain advertising, promotions, subscription-based marketing and newsletters.',
    other: 'Any email that could not be placed in one of the other baskets (account notices, system mail, anything unclear).',
    aside: 'We push emails here by hand to deal with later. The AI never puts anything here.' };
  const BASKET_ORDER = ['all', 'bill', 'receipt', 'arrival', 'message', 'advertisement', 'other', 'aside'];
  function basketDefs(s) { let o = {}; try { o = JSON.parse(s.baskets || '{}') || {}; } catch (e) {} const out = {}; BASKET_ORDER.forEach(k => { out[k] = String(o[k] || BASKET_DEFAULTS[k]).slice(0, 600); }); return out; }
  async function settings() {
    if (settingsCache) return settingsCache;
    const rows = await dbAll('SELECT key, value FROM bk_settings');
    const s = Object.assign({}, SETTING_DEFAULTS);
    rows.forEach(r => { s[r.key] = r.value; });
    s.poll_min = Math.max(2, parseInt(s.poll_min) || 30); s.threshold = Number(s.threshold) || 0.75; s.backfill_days = parseInt(s.backfill_days) || 30;
    ['triage_ad', 'triage_bill', 'triage_notice', 'triage_message'].forEach(k => { s[k] = Math.max(0.3, Math.min(1, Number(s[k]) || SETTING_DEFAULTS[k])); });
    s.triage_auto = String(s.triage_auto) === '1' || s.triage_auto === true ? 1 : 0;
    settingsCache = s;
    return s;
  }
  async function setSetting(key, value, who) {
    await dbRun('INSERT INTO bk_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      [key, value == null ? '' : String(value), nowIso(), who || 'system']);
    settingsCache = null;
  }
  // ---------------------------------------------------------------- chart of accounts (a tree with colors and icons)
  // Canonical form: bk_settings.chart_json = [{ name, color, icon, children: [{ name, icon }] }] (a type of expense and its
  // sub categories). bk_settings.categories (the indented text) is kept in step for the AI prompt and old readers.
  const PALETTE = ['#2563eb', '#0ea5e9', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#8b5cf6', '#64748b', '#0d9488', '#d946ef'];
  // Icons are keys of the line-icon set in public/bookkeeping.js (ICON_PATH); emoji from 1.16.2 are mapped to keys.
  const DEFAULT_STYLE = { 'Cost of Goods Sold': ['#6366f1', 'printer'], 'Facilities': ['#0ea5e9', 'building'], 'People': ['#22c55e', 'users'], 'Insurance': ['#64748b', 'shield'], 'Operations': ['#2563eb', 'laptop'],
    'Vehicles': ['#f97316', 'car'], 'Sales & Marketing': ['#ec4899', 'megaphone'], 'Travel & Meals': ['#eab308', 'plane'], 'Fees & Taxes': ['#a855f7', 'receipt'], 'Assets & Capital': ['#14b8a6', 'hammer'],
    'Not an expense': ['#64748b', 'arrows'], 'Income': ['#22c55e', 'dollar'], 'Delivery': ['#f97316', 'truck'] };
  const SUB_ICON = { Paper: 'file', 'Inks & Toner': 'droplet', 'Printing Supplies': 'briefcase', 'Outsourced Printing': 'factory', 'Freight & Shipping': 'package', 'Local Delivery': 'truck', Packaging: 'box', Rent: 'home', Utilities: 'zap', 'Equipment Repairs & Maintenance': 'wrench',
    'Janitorial & Building': 'sparkles', Payroll: 'banknote', 'Payroll Taxes': 'landmark', 'Employee Benefits': 'gift', Contractors: 'hardhat', 'Business Insurance': 'shield', 'Workers Comp': 'hardhat', 'Vehicle Insurance': 'car',
    'Software & Subscriptions': 'laptop', 'Office Supplies': 'paperclip', 'Telephone & Internet': 'phone', 'Vehicle & Fuel': 'fuel', 'Vehicle Repairs': 'wrench', 'Parking & Tolls': 'parking', 'Advertising & Marketing': 'megaphone', 'Website & SEO': 'globe', 'Samples & Promotion': 'gift',
    Travel: 'plane', Meals: 'utensils', 'Professional Fees': 'scale', 'Bank Fees & Interest': 'landmark', 'Merchant Fees': 'card', 'Taxes & Licenses': 'receipt', 'Equipment (Fixed Asset)': 'hammer', 'Software Development (Capitalized)': 'monitor', 'Leasehold Improvements': 'building',
    'Loan Payment (Principal)': 'landmark', 'Owner Distribution': 'banknote', 'Transfer Between Accounts': 'arrows', 'Credit Card Payment': 'card', 'Sales Tax Payable': 'percent', 'Customer Payment (Income)': 'dollar', Refund: 'undo', 'Other Income': 'trendup' };
  const LEGACY_ICON = { '🖨️': 'printer', '📄': 'file', '🎨': 'droplet', '🧰': 'briefcase', '🏭': 'factory', '📦': 'package', '🚚': 'truck', '🚐': 'car', '⛽': 'fuel', '🅿️': 'parking', '🏠': 'home', '🏢': 'building', '⚡': 'zap', '💡': 'bulb', '🛠️': 'wrench', '🧹': 'sparkles', '👥': 'users', '👷': 'hardhat', '💰': 'banknote', '🏛️': 'landmark', '🎁': 'gift', '🛡️': 'shield', '💻': 'laptop', '📎': 'paperclip', '📞': 'phone', '🌐': 'globe', '📣': 'megaphone', '🎯': 'target', '✈️': 'plane', '🍽️': 'utensils', '☕': 'coffee', '⚖️': 'scale', '🏦': 'landmark', '💳': 'card', '🧾': 'receipt', '🏗️': 'hammer', '🖥️': 'monitor', '↔️': 'arrows', '↩️': 'undo', '💵': 'dollar', '📈': 'trendup', '📉': 'trenddown', '🧮': 'calculator', '🔧': 'wrench', '🏷️': 'tag', '📬': 'mail', '🗂️': 'folder', '📚': 'book', '🎓': 'cap', '🚗': 'car', '🛒': 'cart', '🔌': 'plug', '🔑': 'key', '⭐': 'star', '❓': 'help' };
  const OLD_COLOR = { '#4f46e5': '#6366f1', '#0891b2': '#0ea5e9', '#059669': '#22c55e', '#475569': '#64748b', '#d97706': '#f97316', '#db2777': '#ec4899', '#ea580c': '#eab308', '#7c3aed': '#a855f7', '#0d9488': '#14b8a6', '#16a34a': '#22c55e', '#b45309': '#f97316', '#dc2626': '#ef4444', '#2563eb': '#2563eb', '#65a30d': '#84cc16', '#9333ea': '#a855f7', '#be123c': '#ec4899', '#0369a1': '#0ea5e9' };
  const iconKey = (ic) => { ic = String(ic || '').slice(0, 12); return /^[a-z]+$/.test(ic) ? ic : (LEGACY_ICON[ic] || ''); };
  const cleanName = (n) => String(n || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  // Text → tree ("Type" line, "  Sub" lines); colors and icons from `style` (an older tree) by name, else the defaults.
  function parseChartText(text, style) {
    const tree = []; let cur = null; const st = {}; (style || []).forEach(t => { st[t.name] = t; (t.children || []).forEach(c => { st['>' + t.name + '>' + c.name] = c; }); });
    String(text || '').split('\n').forEach(line => {
      if (!line.trim()) return;
      const sub = /^(\s+|-\s*|\*\s*|>\s*)/.test(line) && cur;
      const name = cleanName(line.replace(/^[\s\-\*>]+/, '')); if (!name) return;
      if (sub) { if (!cur.children.some(c => c.name === name)) { const o = st['>' + cur.name + '>' + name]; cur.children.push({ name, icon: o ? o.icon || '' : (SUB_ICON[name] || '') }); } }
      else { const o = st[name] || null, d = DEFAULT_STYLE[name]; cur = { name, color: o ? o.color : (d ? d[0] : PALETTE[tree.length % PALETTE.length]), icon: o ? o.icon || '' : (d ? d[1] : ''), children: [] }; tree.push(cur); }
    });
    return tree;
  }
  const treeToText = (tree) => tree.map(t => [t.name].concat((t.children || []).map(c => '  ' + c.name)).join('\n')).join('\n');
  function normTree(tree) {
    const out = []; const seenTop = {};
    (Array.isArray(tree) ? tree : []).forEach((t, i) => {
      const name = cleanName(t && t.name); if (!name || seenTop[name]) return; seenTop[name] = 1;
      let color = /^#[0-9a-f]{6}$/i.test(String(t.color || '')) ? String(t.color).toLowerCase() : PALETTE[i % PALETTE.length];
      if (OLD_COLOR[color]) color = OLD_COLOR[color];            // the 1.16.2 darker palette → its lighter twin
      const kids = []; const seen = {};
      (Array.isArray(t.children) ? t.children : []).forEach(c => { const n = cleanName(c && c.name); if (n && !seen[n]) { seen[n] = 1;
        const dl = (x) => x.delivery === 0 || x.delivery === false ? 0 : x.delivery === 1 || x.delivery === true ? 1 : null;   // per sub category (1.19.19): 0 / 1 explicit, null = same as the level above
        const gk = []; (Array.isArray(c.children) ? c.children : []).forEach(g => { const gn = cleanName(g && g.name); if (gn && !seen[gn]) { seen[gn] = 1; gk.push({ name: gn, icon: iconKey(g.icon), delivery: dl(g) }); } });   // third level (1.19.17)
        kids.push({ name: n, icon: iconKey(c.icon), delivery: dl(c), children: gk }); } });
      // delivery: does money under this type buy something that has to arrive? (goods → receiving status on the purchase)
      const delivery = t.delivery === 0 || t.delivery === false ? 0 : t.delivery === 1 || t.delivery === true ? 1 : (/cost of goods|supplies|equipment|inventory|material|asset/i.test(name) ? 1 : 0);
      // income: money that comes IN belongs under this type (1.19.59); a type named Income is one unless switched off
      const income = t.income === 0 || t.income === false ? 0 : t.income === 1 || t.income === true ? 1 : (/\bincome\b|\brevenue\b|\bsales\b(?!.*marketing)/i.test(name) ? 1 : 0);
      out.push({ name, color, icon: iconKey(t.icon), delivery, income, children: kids });
    });
    return out;
  }
  function chartTree(s) {
    if (s.chart_json) { try { const t = JSON.parse(s.chart_json); if (Array.isArray(t)) return normTree(t); } catch (e) {} }
    return parseChartText(s.categories);
  }
  // Flat view: [{ name, parent, children, color, icon }] — parents first, their subs after each (file order).
  function chartOf(s) {
    const out = [];
    chartTree(s).forEach(t => { out.push({ name: t.name, parent: null, children: t.children.length, color: t.color, icon: t.icon, delivery: t.delivery, income: t.income ? 1 : 0 }); t.children.forEach(c => { const cd = c.delivery == null ? t.delivery : c.delivery; out.push({ name: c.name, parent: t.name, top: t.name, children: (c.children || []).length, color: t.color, icon: c.icon || t.icon, delivery: cd, delivery_own: c.delivery, income: t.income ? 1 : 0 }); (c.children || []).forEach(g => out.push({ name: g.name, parent: c.name, top: t.name, level: 3, color: t.color, icon: g.icon || c.icon || t.icon, income: t.income ? 1 : 0, delivery: g.delivery == null ? cd : g.delivery, delivery_own: g.delivery })); }); }); return out; }
  const categoriesOf = (s) => { const seen = {}; return chartOf(s).filter(c => c.parent || !c.children).map(c => c.name).filter(n => !seen[n] && (seen[n] = 1)); };
  const parentOf = (s, name) => { const c = chartOf(s).find(x => x.name === name && x.parent); return c ? c.parent : null; };
  // The chart as the AI reads it: "Cost of Goods Sold: Paper; Inks & Toner | Facilities: Rent; …"
  const chartText = (s) => chartTree(s).map(t => t.children.length ? t.name + ': ' + t.children.map(c => c.name + ((c.children || []).length ? ' (' + c.children.map(g => g.name).join(', ') + ')' : '')).join('; ') : t.name).join(' | ');
  async function saveChart(tree, who) {
    tree = normTree(tree);
    await setSetting('chart_json', JSON.stringify(tree), who);
    await setSetting('categories', treeToText(tree), who);
    return tree;
  }
  // Add a sub category under a type (created when new), or a type on its own.
  async function addCategory(name, parent, who) {
    name = cleanName(name); parent = cleanName(parent);
    const tree = chartTree(await settings());
    if (!name) return tree;
    if (!parent) { if (!tree.some(t => t.name === name)) tree.push({ name, color: DEFAULT_STYLE[name] ? DEFAULT_STYLE[name][0] : PALETTE[tree.length % PALETTE.length], icon: DEFAULT_STYLE[name] ? DEFAULT_STYLE[name][1] : '', children: [] }); }
    else {
      const sub = tree.flatMap(x => x.children.map(c => Object.assign({ _top: x }, { ref: c }))).find(k => k.ref.name === parent);
      if (sub) { sub.ref.children = sub.ref.children || []; if (!sub.ref.children.some(g => g.name === name)) sub.ref.children.push({ name, icon: '' }); return saveChart(tree, who); }
      let t = tree.find(x => x.name === parent);
      if (!t) { t = { name: parent, color: DEFAULT_STYLE[parent] ? DEFAULT_STYLE[parent][0] : PALETTE[tree.length % PALETTE.length], icon: DEFAULT_STYLE[parent] ? DEFAULT_STYLE[parent][1] : '', children: [] }; tree.push(t); }
      if (!t.children.some(c => c.name === name)) t.children.push({ name, icon: SUB_ICON[name] || '' });
    }
    return saveChart(tree, who);
  }
  // Where a category name is in use (so a rename follows it and a delete is refused).
  async function categoryUsage(name) {
    const t = await dbGet('SELECT COUNT(*) n FROM bk_transactions WHERE category = ?', [name]);
    const r = await dbGet('SELECT COUNT(*) n FROM bk_rules WHERE category = ?', [name]);
    const v = await dbGet("SELECT COUNT(*) n FROM bk_vendors WHERE default_category = ? OR default_category LIKE ? OR default_category LIKE ? OR default_category LIKE ?", [name, name + ';%', '%; ' + name, '%; ' + name + ';%']);
    return { txns: t ? t.n : 0, rules: r ? r.n : 0, vendors: v ? v.n : 0 };
  }
  async function renameCategory(from, to, who) {
    from = cleanName(from); to = cleanName(to);
    if (!from || !to || from === to) return { ok: false, error: 'Nothing to rename' };
    const tree = chartTree(await settings());
    let hit = false;
    tree.forEach(t => { if (t.name === from) { t.name = to; hit = true; } t.children.forEach(c => { if (c.name === from) { c.name = to; hit = true; } (c.children || []).forEach(g => { if (g.name === from) { g.name = to; hit = true; } }); }); });
    if (!hit) return { ok: false, error: 'Not in the chart' };
    await saveChart(tree, who);
    await dbRun('UPDATE bk_transactions SET category = ? WHERE category = ?', [to, from]);
    await dbRun('UPDATE bk_rules SET category = ? WHERE category = ?', [to, from]);
    const vs = await dbAll("SELECT id, default_category FROM bk_vendors WHERE default_category LIKE ?", ['%' + from + '%']);
    for (const v of vs) { const parts = String(v.default_category).split(/\s*;\s*/).map(x => x === from ? to : x); await dbRun('UPDATE bk_vendors SET default_category = ? WHERE id = ?', [parts.join('; '), v.id]); }
    // pending proposals carry the category in their payload and title
    const ps = await dbAll("SELECT id, title, payload FROM bk_proposals WHERE status = 'pending' AND type = 'category' AND payload LIKE ?", ['%' + from + '%']);
    for (const pr of ps) { let pl = {}; try { pl = JSON.parse(pr.payload || '{}'); } catch (e) {} if (pl.category === from) { pl.category = to; await dbRun('UPDATE bk_proposals SET payload = ?, title = ? WHERE id = ?', [JSON.stringify(pl), String(pr.title || '').replace(new RegExp('→ ' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '→ ' + to), pr.id]); } }
    dirCache.at = 0;
    await audit(who, 'category.rename', null, { from, to });
    return { ok: true, tree };
  }
  // 1.15.x shipped a flat list, 1.16.0 the text tree; both become the styled tree once.
  (async () => { try {
    const s = await settings();
    if (!s.chart_json) await saveChart(s.categories === OLD_FLAT_CATEGORIES.join('\n') || !s.categories ? parseChartText(DEFAULT_CHART.join('\n')) : parseChartText(s.categories), 'system');
  } catch (e) { errlog('chart migration', e.message); } })();
  async function audit(who, action, ref, detail) {
    try { await dbRun('INSERT INTO bk_audit (who, action, ref, detail) VALUES (?,?,?,?)', [who || 'system', action, ref == null ? null : String(ref), detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 4000)]); } catch (e) {}
  }
  const userId = (req) => String((req.user && (req.user.key || req.user.username)) || '').replace(/^(member|user):/, '').toLowerCase();
  function isBookkeeper(req) {
    const key = String((req.user && req.user.key) || '').toLowerCase();
    const email = key.replace(/^(member|user):/, '');
    const uname = String((req.user && req.user.username) || '').toLowerCase();
    return USERS.indexOf(email) > -1 || USERS.indexOf(uname) > -1;
  }
  function bookkeeperOnly(req, res, next) {
    if (!isBookkeeper(req)) return res.status(403).json({ ok: false, error: 'Bookkeeping AI is not open to this account.' });
    next();
  }
  const guard = [auth, bookkeeperOnly];

  // ---------------------------------------------------------------- secrets at rest
  const encKey = crypto.createHash('sha256').update('bookkeeper:' + String(process.env.JWT_SECRET || 'nova')).digest();
  function enc(text) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const out = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + out.toString('hex');
  }
  function dec(blob) {
    const [iv, tag, data] = String(blob || '').split(':');
    if (!iv || !tag || !data) return '';
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
  }

  // ---------------------------------------------------------------- Plaid
  const plaidReady = () => !!(env('PLAID_CLIENT_ID') && env('PLAID_SECRET'));
  async function plaid(pathPart, body) {
    const r = await fetch(PLAID_BASE + pathPart, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ client_id: env('PLAID_CLIENT_ID'), secret: env('PLAID_SECRET') }, body || {})), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Plaid ' + pathPart + ': ' + (j.error_message || j.error_code || r.status));
    return j;
  }
  async function plaidItems() {
    if (plaidReady()) await ensureLogos().catch(() => {});
    const rows = await dbAll('SELECT * FROM bk_accounts ORDER BY id');
    return rows.map(r => { let a = [], x = []; try { a = JSON.parse(r.accounts || '[]'); } catch (e) {} try { x = JSON.parse(r.excluded || '[]'); } catch (e) {} return Object.assign({}, r, { access_token: undefined, accounts: a, excluded: x }); });
  }
  // 1.19.47: the bank's logo and colour from Plaid, fetched once per connection (old connections get their
  // institution_id from /item/get). Logo is a small base64 PNG served inline to the page.
  const logoTried = new Set();
  async function ensureLogos() {
    const rows = await dbAll('SELECT id, item_id, access_token, institution_id, logo, env FROM bk_accounts WHERE logo IS NULL');
    for (const r of rows) {
      if (logoTried.has(r.id) || (r.env && r.env !== PLAID_ENV)) continue; logoTried.add(r.id);
      try {
        let iid = r.institution_id;
        if (!iid) { const it = await plaid('/item/get', { access_token: dec(r.access_token) }); iid = it.item && it.item.institution_id; if (iid) await dbRun('UPDATE bk_accounts SET institution_id = ? WHERE id = ?', [iid, r.id]); }
        if (!iid) continue;
        const j = await plaid('/institutions/get_by_id', { institution_id: iid, country_codes: ['US'], options: { include_optional_metadata: true } });
        const inst = j.institution || {};
        await dbRun("UPDATE bk_accounts SET logo = ?, color = ?, institution = COALESCE(NULLIF(institution, 'Bank'), ?) WHERE id = ?", [inst.logo ? 'data:image/png;base64,' + inst.logo : '', inst.primary_color || null, inst.name || null, r.id]);
      } catch (e) { errlog('bank logo', e.message); }
    }
  }
  // Which supplier / vendor a bank line is: an exact name or alias match links it; a near match of 95% or better links it too
  // (vendor_by 'auto'); anything weaker is kept as a suggestion with its score for a person to confirm. A person's choice
  // (vendor_by 'person') is never overwritten.
  async function autoVendor(t) {
    if (t.vendor_id) return;
    const text = t.merchant || t.name;
    if (isWise(text)) return;   // 1.19.119: a Wise payout is matched to a team member by amount / reference, never by wording
    const exact = await matchVendor(text);
    if (exact) { await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = 'auto', vendor_score = 1, suggest_vendor_id = NULL, suggest_score = NULL WHERE id = ? AND vendor_id IS NULL", [exact.id, t.id]); return; }
    const near = await suggestVendors(text, null, 1);
    const best = near[0];
    if (best && best.score >= 0.95) await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = 'auto', vendor_score = ?, suggest_vendor_id = NULL, suggest_score = NULL WHERE id = ? AND vendor_id IS NULL", [best.vendor.id, best.score, t.id]);
    else await dbRun('UPDATE bk_transactions SET suggest_vendor_id = ?, suggest_score = ? WHERE id = ?', [best && best.score >= 0.4 ? best.vendor.id : null, best ? Math.round(best.score * 100) / 100 : 0, t.id]);
  }
  // Pull new / changed / removed transactions for one bank connection (cursor-based, so nothing is missed or doubled).
  async function syncItem(row, who) {
    const token = dec(row.access_token);
    let cursor = row.cursor || undefined, added = 0, modified = 0, removed = 0, more = true, guardN = 0;
    while (more && guardN++ < 50) {
      const j = await plaid('/transactions/sync', { access_token: token, cursor: cursor, count: 500, options: { include_original_description: true } });   // 1.19.56: the bank's own memo line too
      const names = {}; let accts = [];
      try { accts = JSON.parse(row.accounts || '[]'); } catch (e) {}
      accts.forEach(a => { names[a.account_id] = a.name; });
      let excl = []; try { excl = JSON.parse(row.excluded || '[]'); } catch (e) {}
      for (const t of (j.added || []).concat(j.modified || [])) {
        const isNew = !(await dbGet('SELECT id FROM bk_transactions WHERE txn_id = ?', [t.transaction_id]));
        const cat = t.personal_finance_category ? (t.personal_finance_category.detailed || t.personal_finance_category.primary) : (t.category || []).join(' > ');
        if (isNew) {
          const ins = await dbRun('INSERT INTO bk_transactions (txn_id, item_id, account_ref, account_name, date, name, merchant, amount, pending, plaid_category, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [t.transaction_id, row.item_id, t.account_id, names[t.account_id] || null, t.date, t.name, t.merchant_name || null, Number(t.amount), t.pending ? 1 : 0, cat, JSON.stringify(t).slice(0, 20000)]);
          added++;
          if (excl.indexOf(t.account_id) > -1) await dbRun("UPDATE bk_transactions SET status = 'excluded', prev_status = 'new' WHERE id = ?", [ins.lastID]);
          // 1.19.51: a posted line replaces its pending one — keep the category, vendor and the AI's suggestion the pending line had
          const prev = t.pending_transaction_id ? await dbGet('SELECT * FROM bk_transactions WHERE txn_id = ?', [t.pending_transaction_id]) : null;
          if (prev && (prev.category || prev.vendor_id || prev.proposal_id)) {
            await dbRun('UPDATE bk_transactions SET category = ?, category_source = ?, rule_id = ?, proposal_id = ?, status = ?, vendor_id = ?, vendor_by = ?, vendor_score = ?, purchase_id = ? WHERE id = ?',
              [prev.category, prev.category_source, prev.rule_id, prev.proposal_id, prev.status === 'removed' ? 'new' : prev.status, prev.vendor_id, prev.vendor_by, prev.vendor_score, prev.purchase_id, ins.lastID]);
            if (prev.proposal_id) await dbRun('UPDATE bk_proposals SET ref_id = ? WHERE id = ? AND ref_table = ?', [ins.lastID, prev.proposal_id, 'bk_transactions']);
            if (prev.purchase_id) { const pu = await dbGet('SELECT txn_ids FROM bk_purchases WHERE id = ?', [prev.purchase_id]); if (pu) { let ids = []; try { ids = JSON.parse(pu.txn_ids || '[]'); } catch (e) {} ids = ids.filter(x => x !== prev.id); ids.push(ins.lastID); await dbRun('UPDATE bk_purchases SET txn_ids = ? WHERE id = ?', [JSON.stringify(ids), prev.purchase_id]); } }
          }
          if (!prev || !prev.vendor_id) { try { await autoVendor({ id: ins.lastID, name: t.name, merchant: t.merchant_name || null }); } catch (e) { errlog('auto vendor', e.message); } }
        } else {
          await dbRun("UPDATE bk_transactions SET date = ?, name = ?, merchant = ?, amount = ?, pending = ?, plaid_category = ?, raw = ?, updated_at = datetime('now') WHERE txn_id = ?",
            [t.date, t.name, t.merchant_name || null, Number(t.amount), t.pending ? 1 : 0, cat, JSON.stringify(t).slice(0, 20000), t.transaction_id]);
          modified++;
        }
      }
      for (const t of (j.removed || [])) {
        await dbRun("UPDATE bk_transactions SET status = 'removed', updated_at = datetime('now') WHERE txn_id = ?", [t.transaction_id]);
        removed++;
      }
      cursor = j.next_cursor; more = !!j.has_more;
      await dbRun("UPDATE bk_accounts SET cursor = ?, last_sync_at = datetime('now'), status = 'ok', error = NULL WHERE id = ?", [cursor, row.id]);
    }
    await audit(who, 'plaid.sync', row.item_id, { added, modified, removed });
    return { added, modified, removed };
  }
  async function syncAll(who) {
    const out = { added: 0, modified: 0, removed: 0, items: 0, errors: [] };
    for (const row of await dbAll('SELECT * FROM bk_accounts')) {
      try { const r = await syncItem(row, who); out.added += r.added; out.modified += r.modified; out.removed += r.removed; out.items++; }
      catch (e) { out.errors.push(row.institution + ': ' + e.message); await dbRun("UPDATE bk_accounts SET status = 'error', error = ? WHERE id = ?", [e.message.slice(0, 300), row.id]); errlog('plaid sync', e.message); }
    }
    return out;
  }
  async function balances() {
    const out = [];
    for (const row of await dbAll('SELECT * FROM bk_accounts')) {
      try {
        const j = await plaid('/accounts/balance/get', { access_token: dec(row.access_token) });
        (j.accounts || []).forEach(a => out.push({ institution: row.institution, name: a.name, mask: a.mask, type: a.subtype || a.type,
          available: a.balances.available, current: a.balances.current }));
      } catch (e) { out.push({ institution: row.institution, error: e.message }); }
    }
    return out;
  }
  // Plaid signs webhooks with ES256 (header Plaid-Verification); the key comes from /webhook_verification_key/get.
  const plaidKeys = new Map();
  async function verifyPlaidWebhook(req) {
    const jwtTok = String(req.headers['plaid-verification'] || '');
    if (!jwtTok) return false;
    const [h, p, sig] = jwtTok.split('.');
    if (!h || !p || !sig) return false;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header.alg !== 'ES256' || !header.kid) return false;
    let key = plaidKeys.get(header.kid);
    if (!key) { const j = await plaid('/webhook_verification_key/get', { key_id: header.kid }); key = j.key; plaidKeys.set(header.kid, key); }
    const pub = crypto.createPublicKey({ key: key, format: 'jwk' });
    const ok = crypto.verify('sha256', Buffer.from(h + '.' + p), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    if (!ok) return false;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (Math.abs(Date.now() / 1000 - Number(claims.iat || 0)) > 5 * 60) return false;
    const bodyHash = crypto.createHash('sha256').update(req.rawBody || JSON.stringify(req.body)).digest('hex');
    return bodyHash === claims.request_body_sha256;
  }


  // ---------------------------------------------------------------- purchases (the hub)
  // One money event. Documents attach in any order: bill (bk_bills), bank line(s) (bk_transactions), the confirmation /
  // receipt email, arrival email(s). Nothing links by itself: a person presses Bill / Transaction / Arrival, or confirms
  // a proposal. Goods (by the chart's `delivery` flag on the type) carry a receiving status; services do not.
  const jarr = (t) => { try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  async function expectsDelivery(category) { if (!category) return null; const c = chartOf(await settings()).find(x => x.name === category); return c ? (c.delivery ? 1 : 0) : null; }
  const today = () => nowIso().slice(0, 10);
  async function newPurchase(f, who) {
    const exp = f.expects_delivery != null ? (f.expects_delivery ? 1 : 0) : await expectsDelivery(f.category);
    const r = await dbRun('INSERT INTO bk_purchases (vendor_id, vendor, amount, date, order_no, category, bill_id, confirm_email_id, txn_ids, arrival_email_ids, expects_delivery, received, no_paperwork, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [f.vendor_id || null, f.vendor || null, f.amount != null ? Math.abs(Number(f.amount)) || 0 : null, f.date || today(), f.order_no || null, f.category || null, f.bill_id || null, f.confirm_email_id || null,
       JSON.stringify(f.txn_ids || []), JSON.stringify(f.arrival_email_ids || []), exp, exp ? 'no' : 'na', f.no_paperwork ? 1 : 0, f.note || null, who || null]);
    const id = r.lastID;
    if (f.bill_id) await dbRun('UPDATE bk_bills SET purchase_id = ? WHERE id = ?', [id, f.bill_id]);
    if (f.confirm_email_id) await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [id, f.confirm_email_id]);
    for (const t of (f.txn_ids || [])) await dbRun('UPDATE bk_transactions SET purchase_id = ? WHERE id = ?', [id, t]);
    for (const e of (f.arrival_email_ids || [])) await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [id, e]);
    await audit(who, 'purchase.new', id, { vendor: f.vendor, amount: f.amount, from: f.bill_id ? 'bill' : f.confirm_email_id ? 'confirmation' : (f.txn_ids || []).length ? 'bank' : (f.arrival_email_ids || []).length ? 'arrival' : 'hand' });
    return id;
  }
  async function attachTo(pid, a, who) {
    const p = await dbGet('SELECT * FROM bk_purchases WHERE id = ?', [pid]); if (!p) throw new Error('No such purchase');
    const sets = [], args = [];
    if (a.bill_id) { sets.push('bill_id = ?'); args.push(a.bill_id); await dbRun('UPDATE bk_bills SET purchase_id = ? WHERE id = ?', [pid, a.bill_id]); }
    if (a.confirm_email_id) { sets.push('confirm_email_id = ?'); args.push(a.confirm_email_id); await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [pid, a.confirm_email_id]); }
    if (a.txn_id) { const t = jarr(p.txn_ids); if (t.indexOf(a.txn_id) < 0) t.push(a.txn_id); sets.push('txn_ids = ?'); args.push(JSON.stringify(t)); await dbRun('UPDATE bk_transactions SET purchase_id = ? WHERE id = ?', [pid, a.txn_id]);
      const tx = await dbGet('SELECT category, vendor_id, amount, date FROM bk_transactions WHERE id = ?', [a.txn_id]);
      if (tx) { if (!p.category && tx.category) { sets.push('category = ?'); args.push(tx.category); const exp = await expectsDelivery(tx.category); if (p.expects_delivery == null && exp != null) { sets.push('expects_delivery = ?'); args.push(exp); sets.push('received = ?'); args.push(exp ? (p.received === 'na' ? 'no' : p.received) : 'na'); } }
        if (!p.vendor_id && tx.vendor_id) { sets.push('vendor_id = ?'); args.push(tx.vendor_id); } if (p.amount == null) { sets.push('amount = ?'); args.push(Math.abs(tx.amount)); } } }
    if (a.arrival_email_id) { const e = jarr(p.arrival_email_ids); if (e.indexOf(a.arrival_email_id) < 0) e.push(a.arrival_email_id); sets.push('arrival_email_ids = ?'); args.push(JSON.stringify(e)); await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [pid, a.arrival_email_id]);
      if (a.received) { sets.push('received = ?'); args.push(a.received); sets.push('received_at = ?'); args.push(today()); if (a.note) { sets.push('received_note = ?'); args.push(a.note); } if (p.expects_delivery == null) { sets.push('expects_delivery = 1'); } } }
    if (a.category && !p.category) { sets.push('category = ?'); args.push(a.category); }
    if (sets.length) { sets.push("updated_at = datetime('now')"); await dbRun('UPDATE bk_purchases SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([pid])); }
    await audit(who, 'purchase.attach', pid, a);
  }
  // Derived status for a row.
  function purchaseStatus(p, bill) {
    if (p.cancelled) return 'cancelled';
    const txns = jarr(p.txn_ids);
    if (!txns.length && !p.no_paperwork) { if (bill && bill.status !== 'paid') return 'awaiting payment'; return 'awaiting bank'; }
    if (p.expects_delivery && p.received !== 'yes') return p.received === 'partial' ? 'partly received' : 'not received';
    return 'closed';
  }
  // Bank lines that were categorized without any paperwork are purchases too (no_paperwork), so the list is complete.
  // 1.19.48: purchases whose bank lines are gone (test data removed, lines removed by the bank) and that hold no bill
  // or email are leftovers — drop them; a purchase that still has paperwork just loses the dead references.
  async function dropOrphanPurchases() {
    let dropped = 0;
    for (const pu of await dbAll("SELECT id, txn_ids, bill_id, confirm_email_id, arrival_email_ids FROM bk_purchases WHERE txn_ids <> '[]'")) {
      const tx = jarr(pu.txn_ids).map(Number).filter(Boolean); if (!tx.length) continue;
      const alive = (await dbAll('SELECT id FROM bk_transactions WHERE id IN (' + tx.map(() => '?').join(',') + ')', tx)).map(r => r.id);
      if (alive.length === tx.length) continue;
      if (!alive.length && !pu.bill_id && !pu.confirm_email_id && !jarr(pu.arrival_email_ids).length) { await dbRun('DELETE FROM bk_purchase_items WHERE purchase_id = ?', [pu.id]); await dbRun('DELETE FROM bk_purchases WHERE id = ?', [pu.id]); dropped++; }
      else await dbRun('UPDATE bk_purchases SET txn_ids = ? WHERE id = ?', [JSON.stringify(alive), pu.id]);
    }
    return dropped;
  }
  async function ensureTxnPurchases() {
    await dropOrphanPurchases().catch(() => {});
    const rows = await dbAll("SELECT id, vendor_id, name, merchant, amount, date, category FROM bk_transactions WHERE purchase_id IS NULL AND category IS NOT NULL AND status NOT IN ('new', 'pending', 'removed', 'excluded') AND amount > 0 AND transfer_of IS NULL LIMIT 300");
    for (const t of rows) { const v = t.vendor_id ? await dbGet('SELECT name FROM bk_vendors WHERE id = ?', [t.vendor_id]) : null; const pid = await newPurchase({ vendor_id: t.vendor_id, vendor: v ? v.name : (t.merchant || t.name), amount: t.amount, date: t.date, category: t.category, txn_ids: [t.id], no_paperwork: 1 }, 'bank');  const eq = await equipmentFor(t.vendor_id, t.amount); if (eq) { await dbRun('UPDATE bk_transactions SET equipment_id = ? WHERE id = ? AND equipment_id IS NULL', [eq, t.id]); await dbRun('UPDATE bk_purchases SET equipment_id = ? WHERE id = ?', [eq, pid]); } }
    return rows.length;
  }
  // Bank lines that could be the purchase's payment: same amount to the cent, not in a purchase, within 10 days; same vendor first.
  async function suggestTxns(p) {
    if (p.amount == null) return [];
    const rows = await dbAll("SELECT id, date, name, merchant, amount, category, vendor_id, account_name FROM bk_transactions WHERE purchase_id IS NULL AND status NOT IN ('removed', 'excluded') AND ABS(ABS(amount) - ?) < 0.005 AND date BETWEEN date(?, '-10 days') AND date(?, '+20 days') ORDER BY date DESC LIMIT 10", [Math.abs(p.amount), p.date || today(), p.date || today()]);
    return rows.map(t => Object.assign(t, { same_vendor: !!(p.vendor_id && t.vendor_id === p.vendor_id) })).sort((a, b) => (b.same_vendor ? 1 : 0) - (a.same_vendor ? 1 : 0));
  }
  const laDayOf = (ts) => { const d = new Date(String(ts || '').replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(String(ts || '')) ? '' : 'Z')); return isNaN(d) ? today() : d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); };
  // What an email says about a payment: vendor, amount, date, order number (the light model, text only).
  async function extractPayment(em) {
    const text = 'From: ' + em.from_addr + '\nSubject: ' + em.subject + '\nDate: ' + em.received_at + '\n\n' + String(em.body || em.snippet || '').slice(0, 5000);
    try {
      const r = await anthropic.messages.create({ model: MODEL_LIGHT, max_tokens: 300, system: 'You read one email from the accounting inbox of a print shop and pull out the payment facts. Return ONLY JSON.',
        messages: [{ role: 'user', content: text + '\n\nReturn ONLY JSON: {"vendor": "<company that was paid or will ship>", "amount": <total charged, number, or null>, "date": "YYYY-MM-DD or null", "order_no": "<order / invoice / confirmation number or empty>", "what": "<a few words: what was bought>"}' }] });
      const j = jsonOf((r.content || []).filter(b => b.type === 'text').map(b => b.text).join('')) || {};
      return { vendor: String(j.vendor || '').slice(0, 120), amount: j.amount != null && isFinite(Number(j.amount)) ? Math.abs(Number(j.amount)) : null, date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || '')) ? j.date : laDayOf(em.received_at), order_no: String(j.order_no || '').slice(0, 60), what: String(j.what || '').slice(0, 120) };
    } catch (e) { errlog('extract payment', e.message); return { vendor: '', amount: null, date: laDayOf(em.received_at), order_no: '', what: '' }; }
  }
  // The HTML of an order / delivery email as text the light model can read, with product pictures kept as [IMG url]
  // tokens next to their lines (tracking pixels, spacers and logos dropped) so each item can carry its photo.
  function emailForItems(em) {
    let h = String(em.body_html || '');
    if (!h) return String(em.body || em.snippet || '').slice(0, 12000);
    h = h.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ');
    h = h.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = (/\bsrc=["']([^"']+)["']/i.exec(tag) || [])[1] || '';
      const w = parseInt((/\bwidth=["']?(\d+)/i.exec(tag) || [])[1] || '0'), hgt = parseInt((/\bheight=["']?(\d+)/i.exec(tag) || [])[1] || '0');
      if (!/^https?:\/\//.test(src) || (w && w < 40) || (hgt && hgt < 40) || /pixel|spacer|1x1|logo|icon|badge|tracking|beacon|\.gif(\?|$)/i.test(src)) return ' ';
      return ' [IMG ' + src + '] ';
    });
    h = h.replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return h.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, 14000);
  }
  // The line items of a purchase, read from one email (order confirmation, delivery notice, receipt) by the light model.
  async function extractItems(em) {
    const text = 'From: ' + em.from_addr + '\nSubject: ' + em.subject + '\n\n' + emailForItems(em);
    try {
      const r = await anthropic.messages.create({ model: MODEL_LIGHT, max_tokens: 1500, system: 'You read one email from the accounting inbox of a print shop and list what was bought. Product pictures appear as [IMG url] tokens near their lines — give each item the picture that belongs to it (never a logo). Shipping, tax and fees are separate lines. Return ONLY JSON.',
        messages: [{ role: 'user', content: text + '\n\nReturn ONLY JSON: {"items": [{"name": "<product as written>", "qty": 1, "unit_price": null, "amount": null, "image": "<url or empty>"}], "shipping": null, "tax": null, "total": null, "order_no": "<order / confirmation number or empty>"}' }] });
      const j = jsonOf((r.content || []).filter(b => b.type === 'text').map(b => b.text).join('')) || {};
      const num = (x) => x == null || x === '' || !isFinite(Number(x)) ? null : Math.round(Math.abs(Number(x)) * 100) / 100;
      const items = (Array.isArray(j.items) ? j.items : []).filter(i => i && i.name).slice(0, 40).map(i => ({ name: String(i.name).slice(0, 200), qty: num(i.qty) || 1, unit_price: num(i.unit_price), amount: num(i.amount), photo: /^https?:\/\//.test(String(i.image || '')) ? String(i.image).slice(0, 500) : null }));
      return { items, shipping: num(j.shipping), tax: num(j.tax), total: num(j.total), order_no: String(j.order_no || '').slice(0, 60) };
    } catch (e) { errlog('extract items', e.message); return { items: [], shipping: null, tax: null, total: null, order_no: '' }; }
  }
  // The chart's category for shipping / tax lines, if the chart has one.
  async function categoryLike(re) { const s = await settings(); return categoriesOf(s).find(n => re.test(n)) || null; }
  // Fill a purchase's items from an email (only when it has none yet — a second email never duplicates the list).
  async function fillItemsFromEmail(pid, em, who) {
    const have = await dbGet('SELECT COUNT(*) AS n FROM bk_purchase_items WHERE purchase_id = ?', [pid]); if (have && have.n) return 0;
    const x = await extractItems(em); if (!x.items.length && x.shipping == null) return 0;
    const p = await dbGet('SELECT category, amount, order_no FROM bk_purchases WHERE id = ?', [pid]);
    let pos = 0;
    for (const i of x.items) await dbRun('INSERT INTO bk_purchase_items (purchase_id, pos, kind, name, qty, unit_price, amount, photo, category, email_id, source, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [pid, pos++, 'item', i.name, i.qty, i.unit_price, i.amount != null ? i.amount : (i.unit_price != null ? Math.round(i.unit_price * i.qty * 100) / 100 : null), i.photo, p && p.category || null, em.id, 'email', who]);
    if (x.shipping) await dbRun('INSERT INTO bk_purchase_items (purchase_id, pos, kind, name, qty, amount, category, email_id, source, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)', [pid, pos++, 'shipping', 'Shipping', 1, x.shipping, await categoryLike(/shipping|freight|postage|delivery/i), em.id, 'email', who]);
    if (x.tax) await dbRun('INSERT INTO bk_purchase_items (purchase_id, pos, kind, name, qty, amount, category, email_id, source, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)', [pid, pos++, 'tax', 'Sales tax', 1, x.tax, await categoryLike(/sales tax|^tax/i), em.id, 'email', who]);
    const sets = [], args = [];
    if (p && p.amount == null && x.total) { sets.push('amount = ?'); args.push(x.total); }
    if (p && !p.order_no && x.order_no) { sets.push('order_no = ?'); args.push(x.order_no); }
    if (sets.length) await dbRun('UPDATE bk_purchases SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([pid]));
    return x.items.length;
  }
  // Fill from a bill's own lines (the full read already has them).
  async function fillItemsFromBill(pid, bill, who) {
    const have = await dbGet('SELECT COUNT(*) AS n FROM bk_purchase_items WHERE purchase_id = ?', [pid]); if (have && have.n) return 0;
    const lines = jarr(bill.lines); let pos = 0;
    for (const l of lines) { if (!l || !(l.description || l.name)) continue; const nm = String(l.description || l.name); const ship = /shipping|freight|postage|delivery/i.test(nm), tax = /\btax\b/i.test(nm);
      await dbRun('INSERT INTO bk_purchase_items (purchase_id, pos, kind, name, qty, unit_price, amount, category, email_id, source, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [pid, pos++, ship ? 'shipping' : tax ? 'tax' : 'item', nm.slice(0, 200), Number(l.qty) || 1, l.unit_price != null ? Number(l.unit_price) : null, l.amount != null ? Number(l.amount) : null, l.category || null, bill.email_id || null, 'bill', who]); }
    if (bill.shipping && !lines.some(l => /shipping|freight/i.test(l.description || ''))) await dbRun('INSERT INTO bk_purchase_items (purchase_id, pos, kind, name, qty, amount, category, source, created_by) VALUES (?,?,?,?,?,?,?,?,?)', [pid, pos++, 'shipping', 'Shipping', 1, Number(bill.shipping), await categoryLike(/shipping|freight|postage|delivery/i), 'bill', who]);
    if (bill.tax && !lines.some(l => /\btax\b/i.test(l.description || ''))) await dbRun('INSERT INTO bk_purchase_items (purchase_id, pos, kind, name, qty, amount, category, source, created_by) VALUES (?,?,?,?,?,?,?,?,?)', [pid, pos++, 'tax', 'Sales tax', 1, Number(bill.tax), await categoryLike(/sales tax|^tax/i), 'bill', who]);
    return pos;
  }
  // One purchase in full: its slots, every email behind it (with attachment counts), its items and bank lines.
  async function purchaseDetail(pid) {
    const p = await dbGet('SELECT p.*, v.name AS vendor_name, v.photo AS vendor_photo FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE p.id = ?', [pid]); if (!p) return null;
    const bill = p.bill_id ? await dbGet('SELECT id, status, invoice_no, invoice_date, total, email_id, paid_at FROM bk_bills WHERE id = ?', [p.bill_id]) : null;
    const emailIds = [p.confirm_email_id, bill && bill.email_id].concat(jarr(p.arrival_email_ids)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
    const emails = emailIds.length ? await dbAll('SELECT id, subject, from_addr, received_at, kind, decided_kind, attachments FROM bk_emails WHERE id IN (' + emailIds.map(() => '?').join(',') + ') ORDER BY received_at', emailIds) : [];
    emails.forEach(e => { const a = jarr(e.attachments); e.attachments = a.length; e.attachment_names = a.map(x => x.name).slice(0, 6); e.role = e.id === p.confirm_email_id ? 'confirmation' : (bill && e.id === bill.email_id) ? 'bill' : 'delivery'; });
    const txns = jarr(p.txn_ids); const tx = txns.length ? await dbAll('SELECT id, date, name, merchant, amount, account_name, category FROM bk_transactions WHERE id IN (' + txns.map(() => '?').join(',') + ')', txns) : [];
    const items = await dbAll('SELECT i.*, m.name AS material_name, m.photo AS material_photo, m.geo_type FROM bk_purchase_items i LEFT JOIN bk_materials m ON m.id = i.material_id WHERE i.purchase_id = ? ORDER BY i.pos, i.id', [pid]);
    const eq = p.equipment_id ? await dbGet('SELECT id, name FROM bk_equipment WHERE id = ?', [p.equipment_id]) : null;
    return Object.assign({}, p, { vendor: p.vendor_name || p.vendor, bill, emails, txns: tx, items, equipment: eq, status: purchaseStatus(p, bill), paired: tx.length > 0 });
  }
  // An email is handled: read in Gmail (first), closed here, the person's decision kept.
  async function handleEmail(em, kind, who, note) {
    const gm = await markReadInGmail([em.id], who); if (!gm.ok) throw new Error(gm.error);
    await dbRun("UPDATE bk_emails SET status = CASE WHEN status = 'parsed' THEN 'parsed' ELSE 'skipped' END, read_by = 'user', note = ? WHERE id = ?", [note, em.id]);
    await decideEmail(em.id, kind, who);
  }
  // Rows for the Purchases views, with their slots and status.
  async function purchaseRows(view, q) {
    await ensureTxnPurchases();
    const s = await settings();
    const dir = await directory();
    const where = ['1=1'], args = [];
    if (view === 'waiting') where.push("p.confirm_email_id IS NOT NULL AND p.txn_ids = '[]' AND p.cancelled = 0");
    if (view === 'notreceived') where.push("p.expects_delivery = 1 AND p.received IN ('no', 'partial') AND p.cancelled = 0");
    if (q) { where.push('(LOWER(COALESCE(p.vendor, \'\')) LIKE ? OR LOWER(COALESCE(p.order_no, \'\')) LIKE ? OR LOWER(COALESCE(p.category, \'\')) LIKE ?)'); const l = '%' + q.toLowerCase() + '%'; args.push(l, l, l); }
    const rows = await dbAll('SELECT p.*, v.name AS vendor_name, v.photo AS vendor_photo FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE ' + where.join(' AND ') + ' ORDER BY p.date DESC, p.id DESC LIMIT 400', args);
    const out = [];
    for (const p of rows) {
      const bill = p.bill_id ? await dbGet('SELECT id, status, invoice_no, total, due_date, paid_at FROM bk_bills WHERE id = ?', [p.bill_id]) : null;
      const txns = jarr(p.txn_ids), arr = jarr(p.arrival_email_ids);
      const tx = txns.length ? await dbAll('SELECT id, date, name, amount, account_name FROM bk_transactions WHERE id IN (' + txns.map(() => '?').join(',') + ')', txns) : [];
      const confirm = p.confirm_email_id ? await dbGet('SELECT id, subject, received_at FROM bk_emails WHERE id = ?', [p.confirm_email_id]) : null;
      const status = purchaseStatus(p, bill);
      const age = Math.floor((Date.now() - new Date((p.date || p.created_at) + 'T12:00:00Z').getTime()) / 86400000);
      const emailIds = [p.confirm_email_id].concat(arr).filter(Boolean);
      const ems = emailIds.length ? await dbAll('SELECT id, subject, received_at, attachments FROM bk_emails WHERE id IN (' + emailIds.map(() => '?').join(',') + ')', emailIds) : [];
      const atts = ems.reduce((a, e) => a + jarr(e.attachments).length, 0) + (bill && bill.id ? (await dbGet('SELECT attachments FROM bk_emails WHERE id = (SELECT email_id FROM bk_bills WHERE id = ?)', [bill.id]).then(r => r ? jarr(r.attachments).length : 0)) : 0);
      const its = await dbGet('SELECT COUNT(*) AS n, SUM(kind = \'item\') AS items, SUM(material_id IS NOT NULL) AS linked FROM bk_purchase_items WHERE purchase_id = ?', [p.id]);
      // 1.19.30: the vendor as the bill card shows it (logo, directory tag, near matches when unlinked) and the time the purchase was first seen
      const vd = p.vendor_id ? dir.find(x => x.id === p.vendor_id) : null;
      const vendor_card = vendorCard(vd);
      const suggestions = (!vd || vd.source === 'bill') && (p.vendor_name || p.vendor) ? (await suggestVendors(p.vendor_name || p.vendor, null, 3)).map(x => Object.assign(vendorCard(x.vendor), { score: x.score })) : [];
      const firstArr = arr.length ? ems.filter(e => arr.indexOf(e.id) > -1).map(e => e.received_at).sort()[0] : null;
      const when = (confirm && confirm.received_at) || firstArr || p.created_at;
      out.push(Object.assign({}, p, { vendor: p.vendor_name || p.vendor, vendor_card, suggestions, when, bill, txns: tx, confirm, arrivals: arr.length, status, days: age, paired: tx.length > 0,
        emails: ems.length + (bill && bill.id ? 1 : 0), email_subjects: ems.map(e => e.subject).slice(0, 5), attachments: atts, items: its ? its.items || 0 : 0, items_linked: its ? its.linked || 0 : 0,
        late: (status === 'awaiting bank' && age >= s.waiting_days) || ((status === 'not received' || status === 'partly received') && age >= s.notreceived_days),
        suggest: status === 'awaiting bank' ? (await suggestTxns(p)).length : 0 }));
    }
    return out;
  }
  // The 30-day email: everything still waiting for the bank or not received, once a day, to alert_to.
  async function alertOverdue(who) {
    const s = await settings();
    const rows = (await purchaseRows('all', '')).filter(r => r.late);
    if (!rows.length || !sendMail) return { sent: 0, n: 0 };
    const line = (r) => '• ' + (r.vendor || '?') + ' — ' + (r.amount != null ? '$' + Number(r.amount).toFixed(2) : 'no amount') + (r.order_no ? ' · #' + r.order_no : '') + ' · ' + r.date + ' · ' + r.status + ' for ' + r.days + ' days';
    const waiting = rows.filter(r => r.status === 'awaiting bank'), notrec = rows.filter(r => r.status !== 'awaiting bank');
    const text = 'BookkeeperAI — purchases waiting more than ' + s.waiting_days + ' / ' + s.notreceived_days + ' days\n\n' +
      (waiting.length ? 'WAITING FOR THE BANK (' + waiting.length + ')\n' + waiting.map(line).join('\n') + '\n\n' : '') +
      (notrec.length ? 'NOT RECEIVED (' + notrec.length + ')\n' + notrec.map(line).join('\n') + '\n\n' : '') +
      'Open Purchases: ' + NOVA_URL + '/bookkeeping?tab=purchases\nThis email goes out once a day while anything is overdue. Change the days or the address under Bookkeeping → Settings → Alerts.';
    try { await sendMail({ to: s.alert_to, subject: 'BookkeeperAI: ' + rows.length + ' purchase' + (rows.length === 1 ? '' : 's') + ' overdue', text }); } catch (e) { errlog('alert mail', e.message); return { sent: 0, n: rows.length, error: e.message }; }
    for (const r of rows) await dbRun("UPDATE bk_purchases SET alerted_at = datetime('now') WHERE id = ?", [r.id]);
    await audit(who || 'clock', 'purchase.alert', null, { n: rows.length, to: s.alert_to });
    return { sent: 1, n: rows.length };
  }

  // ---------------------------------------------------------------- the accounting inbox (Gmail)
  let gmailClient = null;
  function gmail() {
    if (gmailClient) return gmailClient;
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const a = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/gmail.readonly'], subject: INBOX });
    gmailClient = google.gmail({ version: 'v1', auth: a });
    return gmailClient;
  }
  // Marking read in Gmail itself (removes the UNREAD label), so the team's unread count drops with ours. Needs the
  // gmail.modify scope on the service account's domain-wide delegation; until Google has it, this returns the reason
  // and Nova's own state is still updated. Never deletes, moves or sends.
  let gmailModClient = null;
  function gmailMod() {
    if (gmailModClient) return gmailModClient;
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const a = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/gmail.modify'], subject: INBOX });
    gmailModClient = google.gmail({ version: 'v1', auth: a });
    return gmailModClient;
  }
  const SCOPE_HELP = 'Google has not allowed Nova to change read state yet: in Google Admin → Security → API controls → Domain-wide delegation, add https://www.googleapis.com/auth/gmail.modify to the service account\'s scopes (keep the others).';
  async function markReadInGmail(emailIds, who) {
    const rows = emailIds.length ? await dbAll('SELECT id, gmail_id FROM bk_emails WHERE id IN (' + emailIds.map(() => '?').join(',') + ') AND gmail_id IS NOT NULL', emailIds) : [];
    if (!rows.length) return { ok: true, n: 0 };
    try {
      const g = gmailMod();
      for (let i = 0; i < rows.length; i += 500) await g.users.messages.batchModify({ userId: 'me', requestBody: { ids: rows.slice(i, i + 500).map(r => r.gmail_id), removeLabelIds: ['UNREAD'] } });
      await audit(who, 'gmail.mark_read', INBOX, { n: rows.length });
      return { ok: true, n: rows.length };
    } catch (e) {
      const msg = String(e.message || e);
      const scope = /unauthorized_client|insufficient|insufficientPermissions|403|scope/i.test(msg);
      errlog('gmail mark read', msg);
      return { ok: false, n: 0, error: (scope ? SCOPE_HELP + ' ' : '') + 'Gmail said: ' + msg.slice(0, 300), scope };
    }
  }
  const b64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  function partsOf(payload) { const out = []; (function walk(p) { if (!p) return; out.push(p); (p.parts || []).forEach(walk); })(payload); return out; }
  // The HTML part, cleaned for the reading pane (scripts, forms and event handlers out; images and links stay).
  function emailHtml(payload) {
    const html = partsOf(payload).find(p => p.mimeType === 'text/html' && p.body && p.body.data);
    if (!html) return null;
    return b64url(html.body.data).toString('utf8').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<(iframe|object|embed|form|input|button)[\s\S]*?(<\/\1>|>)/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').slice(0, 400000);
  }
  function emailText(payload) {
    const parts = partsOf(payload);
    const plain = parts.find(p => p.mimeType === 'text/plain' && p.body && p.body.data);
    const html = parts.find(p => p.mimeType === 'text/html' && p.body && p.body.data);
    let t = plain ? b64url(plain.body.data).toString('utf8') : html ? b64url(html.body.data).toString('utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ') : '';
    return t.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, 8000);
  }
  // New mail in the inbox (since the last scan, or the last backfill_days days the first time) → bk_emails rows with
  // their PDF / image attachments saved in FILES. Returns how many were new.
  async function scanInbox(who) {
    const s = await settings();
    try { fs.mkdirSync(FILES, { recursive: true }); } catch (e) {}
    const g = gmail();
    // Only what is still UNREAD in Gmail: the inbox here mirrors the team's unread count. An email someone reads in
    // Gmail drops out of the unread list and is set aside here too (read_by = 'gmail'), so the two stay in step.
    // No date limit: unread is unread, however old (backfill_days only applied when read mail was scanned too).
    const list = async (q, cap) => { let pageToken, ids = []; do { const r = await g.users.messages.list({ userId: 'me', q: q, maxResults: 100, pageToken: pageToken }); ids = ids.concat((r.data.messages || []).map(m => m.id)); pageToken = r.data.nextPageToken; } while (pageToken && ids.length < cap); return ids; };
    const unreadIds = await list('is:unread in:inbox -in:spam -in:trash', 1000);
    // Only unread mail comes in. Closed is what was dealt with from here on; mail read in Gmail before Nova ever saw it
    // is not imported (1.18.23 — rows the earlier import brought in as read are dropped once).
    await dbRun("DELETE FROM bk_emails WHERE read_by = 'gmail' AND COALESCE(aside, 0) = 0 AND id NOT IN (SELECT email_id FROM bk_bills WHERE email_id IS NOT NULL)");
    if (!s.inbox_poll_30) { if (parseInt(s.poll_min) === 60) await setSetting('poll_min', 30, 'system'); await setSetting('inbox_poll_30', 1, 'system'); }   // once (1.19.7): the hourly check becomes half-hourly
    if (!s.inbox_reset_1830) {   // once (1.18.30): Closed starts empty — open = unread in Gmail, closed = closed from here, bill drafts included
      await dbRun("DELETE FROM bk_emails WHERE status IN ('skipped', 'error') AND COALESCE(aside, 0) = 0 AND id NOT IN (SELECT email_id FROM bk_bills WHERE email_id IS NOT NULL)");
      await dbRun("UPDATE bk_emails SET read_by = NULL WHERE COALESCE(aside, 0) = 0");
      if (parseInt(s.poll_min) < 60) await setSetting('poll_min', 60, 'system');
      await setSetting('inbox_reset_1830', 1, 'system');
    }
    await dbRun("UPDATE bk_emails SET kind = 'bill' WHERE status = 'parsed' AND kind IS NULL");
    await dbRun("UPDATE bk_emails SET kind = 'other' WHERE triaged_at IS NOT NULL AND kind IS NULL");
    if (!s.inbox_relabel_1910) {   // once (1.19.1): Notices basket gone, Arrivals added — every open email the AI rated is rated again with the new kinds
      await dbRun("UPDATE bk_emails SET kind = 'other' WHERE kind = 'notification'");
      await dbRun("UPDATE bk_emails SET decided_kind = 'other' WHERE decided_kind = 'notification'");
      await dbRun("UPDATE bk_emails SET kind = NULL, confidence = NULL, triaged_at = NULL, status = 'new', note = NULL WHERE status IN ('new', 'message') AND read_by IS NULL AND COALESCE(aside, 0) = 0 AND decided_kind IS NULL");
      await setSetting('inbox_relabel_1910', 1, 'system');
    }
    const ids = unreadIds; let n = 0;
    const seen = new Set((await dbAll('SELECT gmail_id FROM bk_emails')).map(r => r.gmail_id));
    const unread = new Set(unreadIds);
    const open = await dbAll("SELECT id, gmail_id, status FROM bk_emails WHERE read_by IS NULL AND COALESCE(aside, 0) = 0");
    let readInGmail = 0, unreadAgain = 0;
    // Read in Gmail by someone (not from here) → it simply leaves this inbox; Closed is only what was closed from here.
    for (const o of open) if (o.gmail_id && !unread.has(o.gmail_id)) { if (o.status === 'parsed') await dbRun("UPDATE bk_emails SET read_by = 'gmail' WHERE id = ?", [o.id]); else await dbRun('DELETE FROM bk_emails WHERE id = ? AND id NOT IN (SELECT email_id FROM bk_bills WHERE email_id IS NOT NULL)', [o.id]); readInGmail++; }
    // ...and the other way: read here (or by the AI) but unread in Gmail again → open again. Gmail is the truth.
    const closed = await dbAll("SELECT id, gmail_id, kind, status FROM bk_emails WHERE read_by IS NOT NULL AND COALESCE(aside, 0) = 0 AND gmail_id IS NOT NULL");
    for (const c of closed) if (unread.has(c.gmail_id)) { await dbRun("UPDATE bk_emails SET status = ?, read_by = NULL, note = COALESCE(note, '') || ' — unread again in Gmail' WHERE id = ?", [c.status === 'parsed' ? 'parsed' : c.kind === 'message' ? 'message' : 'new', c.id]); unreadAgain++; }
    for (const id of ids) {
      if (seen.has(id)) continue;
      try {
        const m = (await g.users.messages.get({ userId: 'me', id: id, format: 'full' })).data;
        const hdr = (name) => ((m.payload && m.payload.headers) || []).find(h => h.name.toLowerCase() === name.toLowerCase());
        const from = (hdr('From') || {}).value || '', subject = (hdr('Subject') || {}).value || '';
        const at = new Date(Number(m.internalDate)).toISOString().replace('T', ' ').slice(0, 19);
        const atts = [];
        for (const p of partsOf(m.payload)) {
          const fn = p.filename || '';
          const mt = String(p.mimeType || '').toLowerCase();
          if (!fn || !p.body || !p.body.attachmentId) continue;
          if (!/pdf|image\/(png|jpe?g|webp|tiff?)/.test(mt) && !/\.(pdf|png|jpe?g)$/i.test(fn)) continue;
          if (atts.length >= 6) break;
          const a = (await g.users.messages.attachments.get({ userId: 'me', messageId: id, id: p.body.attachmentId })).data;
          const buf = b64url(a.data);
          if (buf.length > 25 * 1024 * 1024) continue;
          const file = crypto.randomBytes(10).toString('hex') + (/pdf/.test(mt) || /\.pdf$/i.test(fn) ? '.pdf' : path.extname(fn).toLowerCase() || '.bin');
          fs.writeFileSync(path.join(FILES, file), buf);
          atts.push({ file: file, name: fn, mime: mt, size: buf.length });
        }
        // Unread is unread — our own mail (a forwarded report, a teammate's note) is open too and rated like the rest.
        const vend = await matchVendor(from.replace(/<.*$/, ''), from);
        await dbRun('INSERT OR IGNORE INTO bk_emails (gmail_id, thread_id, from_addr, subject, received_at, snippet, body, body_html, attachments, status, vendor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [id, m.threadId, from.slice(0, 200), subject.slice(0, 300), at, (m.snippet || '').slice(0, 300), emailText(m.payload), emailHtml(m.payload), JSON.stringify(atts), 'new', vend ? vend.id : null]);
        n++;
      } catch (e) { errlog('gmail message', id, e.message); }
    }
    await audit(who, 'gmail.scan', INBOX, { unread: unreadIds.length, new: n, read_in_gmail: readInGmail, unread_again: unreadAgain });
    return { looked_at: ids.length, unread: unreadIds.length, new: n, read_in_gmail: readInGmail, unread_again: unreadAgain };
  }
  // Start fresh: forget every scanned email that did not become a bill (and its saved attachments), then scan the
  // unread mail again. Bills keep their email. A person's decision, audited.
  async function resetInbox(who) {
    const rows = await dbAll('SELECT id, attachments FROM bk_emails WHERE id NOT IN (SELECT email_id FROM bk_bills WHERE email_id IS NOT NULL)');
    let files = 0;
    for (const r of rows) { let atts = []; try { atts = JSON.parse(r.attachments || '[]'); } catch (e) {} for (const a of atts) { if (!a.file) continue; const full = path.resolve(FILES, a.file); if (full.indexOf(path.resolve(FILES)) === 0) { try { fs.unlinkSync(full); files++; } catch (e) {} } } }
    await dbRun('DELETE FROM bk_emails WHERE id NOT IN (SELECT email_id FROM bk_bills WHERE email_id IS NOT NULL)');
    await audit(who, 'gmail.reset', INBOX, { removed: rows.length, files });
    return { removed: rows.length, files };
  }
  // Gmail push (users.watch → Pub/Sub → this URL). The token in the URL is the only check; the body is not trusted
  // — a push just starts a scan, which reads the inbox itself.
  async function startWatch() {
    const topic = env('BOOKKEEPER_PUBSUB_TOPIC');
    if (!topic) throw new Error('BOOKKEEPER_PUBSUB_TOPIC is not set in .env (projects/<project>/topics/<topic>).');
    const r = await gmail().users.watch({ userId: 'me', requestBody: { topicName: topic, labelIds: ['INBOX'] } });
    await setSetting('gmail_history_id', r.data.historyId || '', 'system');
    await setSetting('gmail_watch_expires', r.data.expiration ? new Date(Number(r.data.expiration)).toISOString() : '', 'system');
    return r.data;
  }

  // ---------------------------------------------------------------- the vendor directory (CRM suppliers + vendors)
  // Pulled from the production `suppliers` and `vendors` tables (read-only). They are our known partners, so they come
  // in approved; a transaction or bill that matches one is linked to it (vendor_id) and the AI is told who they are.
  // 1.19.91: the bank's wording minus its per-payment codes — "STRIPE TRANSFER ST-W7G8K4C7T1Q6 AXIOMPRINT INC" and
  // "STRIPE TRANSFER ST-K2P9… AXIOMPRINT INC" are the same payer. Tokens with a digit, and 1-letter tokens, are dropped.
  const stableV = (t) => normV(t).split(' ').filter(w => w.length > 1 && !/\d/.test(w)).join(' ');
  // 1.19.130: the part of a bank line that IS the vendor — the longest run of the vendor's own name words found in the
  // wording ("BUSINESS TO BUSINESS ACH ZIGMUEMPERORSTEE BILL_PAY 092226 EMPEROR STEEL D WELLS FARGO" + "Emperor Steel Dies"
  // → "emperor steel"). Learned as the alias when a person links a line, so every payment carrying those words links too,
  // whatever random code sits beside them. '' when the name and the wording share nothing usable.
  function vendorPhrase(vendorName, text) {
    const GEN = /^(inc|llc|co|corp|corporation|company|the|of|and|ltd|group|services|service|usa|us|international|bank|na|ach|payment|pay|bill|business|to|des|id)$/;
    const nw = normV(vendorName).split(' ').filter(Boolean), tw = normV(text).split(' ').filter(Boolean);
    let best = [];
    for (let i = 0; i < nw.length; i++) for (let j = 0; j < tw.length; j++) {
      let k = 0; while (i + k < nw.length && j + k < tw.length && nw[i + k] === tw[j + k]) k++;
      if (k > best.length) best = nw.slice(i, i + k);
    }
    const real = best.filter(w => !GEN.test(w) && w.length >= 3);
    if (!real.length || real.join('').length < 5) return '';
    return best.join(' ');
  }
  // 1.19.130: after a vendor's bank names change (an alias learned from a link, or typed into the vendor card), every
  // unlinked line that now matches this vendor links to it — no waiting for the next sync. Wise lines stay out (the team list files those).
  async function relinkVendor(vid) {
    dirCache.at = 0; let n = 0;
    for (const o of await dbAll("SELECT id, name, merchant FROM bk_transactions WHERE vendor_id IS NULL AND status NOT IN ('removed', 'excluded') ORDER BY id DESC LIMIT 3000")) {
      const text = o.merchant || o.name; if (isWise(text)) continue;
      const m = await matchVendor(text); if (!m || m.id !== vid) continue;
      await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = 'auto', vendor_score = 1, suggest_vendor_id = NULL, suggest_score = NULL WHERE id = ? AND vendor_id IS NULL", [vid, o.id]); n++;
    }
    return n;
  }
  const normV = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(inc|llc|corp|corporation|co|company|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const domainOf = (e) => { const m = String(e || '').toLowerCase().match(/@([a-z0-9.-]+)/); return m ? m[1].replace(/^(www|mail|e)\./, '') : ''; };
  const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn)\./;
  // The CRM lists that make up the directory. Each table is a type (suppliers → Supplier, vendors → Vendor); a new
  // list in the CRM is added with BOOKKEEPER_CRM_LISTS=suppliers,vendors,contractors — same columns expected.
  const CRM_LISTS = String(env('BOOKKEEPER_CRM_LISTS') || 'suppliers,vendors').split(',').map(x => x.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean);
  const kindOf = (t) => t === 'suppliers' ? 'supplier' : t === 'vendors' ? 'vendor' : t === 'bill' ? 'bill' : t === 'nova' ? 'nova' : String(t || '').replace(/s$/, '') || 'other';
  let dirSync = { at: 0, running: null, error: null };
  async function syncDirectory(who) {
    if (!runQuery) return { error: 'No CRM connection' };
    if (dirSync.running) return dirSync.running;                        // one at a time (the tab, the clock and the daily run may ask together)
    dirSync.running = (async () => {
    let n = 0, errors = [];
    for (const t of CRM_LISTS) {
      let rows = [];
      try { rows = await runQuery('SELECT id, company_name, contact_name, email, phone, specialty, address, unit, city, state, zip, hours, country_iso, photo_url FROM ' + t + ' ORDER BY id'); }
      catch (e) { errors.push(t + ': ' + e.message); continue; }
      for (const r of rows) {
        const name = String(r.company_name || r.contact_name || '').trim().slice(0, 120);
        if (!name) continue;
        try {
        const addr = [r.address, r.unit, r.city, r.state, r.zip].filter(Boolean).join(', ').slice(0, 200);
        // Everything else the CRM knows, for the details popup (no bank or payment details exist in the CRM; none are ever stored here).
        const details = JSON.stringify({ address: r.address || '', unit: r.unit || '', city: r.city || '', state: r.state || '', zip: r.zip || '', country: r.country_iso || '', hours: r.hours || '', list: t, crm_id: r.id });
        const photo = /^https?:\/\//.test(String(r.photo_url || '')) ? String(r.photo_url).slice(0, 300) : null;
        // The same CRM row again, or a vendor first seen on a bill that this CRM row is; never another CRM row.
        const ex = await dbGet('SELECT id FROM bk_vendors WHERE (source = ? AND crm_id = ?) OR (LOWER(name) = LOWER(?) AND (source IS NULL OR source = ?))', [t, r.id, name, 'bill']);
        // kind (the Type column) is the CRM list the row is in — read-only here, the CRM decides.
        const kind = kindOf(t);
        if (ex) await dbRun("UPDATE bk_vendors SET name = ?, source = ?, crm_id = ?, email = ?, phone = ?, specialty = ?, contact = ?, address = ?, photo = ?, kind = ?, details = ?, approved = 1, synced_at = datetime('now') WHERE id = ?",
          [name, t, r.id, String(r.email || '').slice(0, 200), String(r.phone || '').slice(0, 40), String(r.specialty || '').slice(0, 200), String(r.contact_name || '').slice(0, 120), addr, photo, kind, details, ex.id]);
        else await dbRun("INSERT INTO bk_vendors (name, approved, email, source, crm_id, phone, specialty, contact, address, photo, kind, details, approved_by, approved_at, synced_at) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))",
          [name, String(r.email || '').slice(0, 200), t, r.id, String(r.phone || '').slice(0, 40), String(r.specialty || '').slice(0, 200), String(r.contact_name || '').slice(0, 120), addr, photo, kind, details, 'crm']);
        n++;
        } catch (e) { errors.push(t + ' #' + r.id + ' ' + name + ': ' + e.message); }
      }
    }
    dirCache.at = 0;
    let materials = 0;
    try { materials = await syncMaterials(); } catch (e) { errors.push('materials: ' + e.message); }
    try { await syncEquipment(); } catch (e) { errors.push('equipment: ' + e.message); }
    dirSync.at = Date.now(); dirSync.error = errors.length ? errors.slice(0, 3).join(' · ') : null; dirCache.at = 0;
    if (errors.length) errlog('directory sync', errors.join(' | '));
    await audit(who, 'directory.sync', null, { synced: n, materials, errors });
    return { synced: n, materials, errors };
    })();
    try { return await dirSync.running; } finally { dirSync.running = null; }
  }
  // Materials: CRM `materials` with geo_type / geo_sub_type names and the production team names (`team`, the colored
  // department chips). `materials.supplier` is free text today ("Kelly", "Kelly Paper", "KellyPaper" all mean Kelly Paper)
  // — it is linked to the directory by name until the CRM gives it a supplier id (then use that column here).
  const matNorm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|co|corp|corporation|company|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const lineKey = (t) => matNorm(String(t || '').replace(/\(.*?\)/g, ' ').replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ')).slice(0, 120);   // wording without dates / parentheses
  // Remember how a person linked a line (and forget when they unlink).
  async function learnLineLink(vendorId, line, who) {
    const key = lineKey(line.description); if (!vendorId || !key) return;
    if (!line.material_id && !line.equipment_id) { await dbRun('DELETE FROM bk_line_links WHERE vendor_id = ? AND pattern = ?', [vendorId, key]); return; }
    await dbRun(`INSERT INTO bk_line_links (vendor_id, pattern, material_id, material_name, material_photo, equipment_id, equipment_name, category, created_by) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vendor_id, pattern) DO UPDATE SET material_id = excluded.material_id, material_name = excluded.material_name, material_photo = excluded.material_photo, equipment_id = excluded.equipment_id, equipment_name = excluded.equipment_name, category = excluded.category, uses = uses + 1, updated_at = datetime('now')`,
      [vendorId, key, line.material_id || null, line.material_name || null, line.material_photo || null, line.equipment_id || null, line.equipment_name || null, line.category || null, who]);
  }
  // Apply what was learned to a new bill's lines (exact wording first, then a line that starts the same way).
  async function applyLineLinks(vendorId, lines) {
    if (!vendorId || !lines.length) return lines;
    const known = await dbAll('SELECT * FROM bk_line_links WHERE vendor_id = ?', [vendorId]); if (!known.length) return lines;
    return lines.map(l => { if (!l || l.material_id || l.equipment_id) return l; const k = lineKey(l.description); if (!k) return l;
      const hit = known.find(x => x.pattern === k) || known.find(x => k.startsWith(x.pattern + ' ') || x.pattern.startsWith(k + ' '));
      if (!hit) return l;
      return Object.assign({}, l, { material_id: hit.material_id || null, material_name: hit.material_name || null, material_photo: hit.material_photo || null, equipment_id: hit.equipment_id || null, equipment_name: hit.equipment_name || null, category: l.category || hit.category || null, linked_by: 'rule' }); });
  }
  function supplierFor(text, list) {
    const n = matNorm(text); if (!n) return null;
    const cands = list.filter(v => v.source !== 'bill' && v._m);
    let hit = cands.find(v => v._m === n) || cands.find(v => v._al.some(a => matNorm(a) === n));
    if (!hit) { const starts = cands.filter(v => v._m.startsWith(n + ' ') || n.startsWith(v._m + ' ') || v._m.replace(/ /g, '') === n.replace(/ /g, '')); if (starts.length) hit = starts.sort((a, b) => a._m.length - b._m.length)[0]; }
    if (!hit && n.length >= 4) { const inside = cands.filter(v => (' ' + v._m + ' ').indexOf(' ' + n + ' ') > -1 || (' ' + n + ' ').indexOf(' ' + v._m + ' ') > -1); if (inside.length === 1) hit = inside[0]; }
    return hit || null;
  }
  async function syncMaterials() {
    const rows = await runQuery('SELECT m.id, m.name, m.material, m.type, m.production_step, m.geo_type_id, gt.name AS geo_type, m.geo_sub_type_id, gs.name AS geo_sub_type, m.department_ids, m.supplier, m.manufacturer, m.cost, m.stock, m.location, m.code, m.axiom_id, m.size, m.size_w, m.size_h, m.thickness, m.color_name, m.photo_url ' +
      'FROM materials m LEFT JOIN geo_type gt ON gt.id = m.geo_type_id LEFT JOIN geo_sub_type gs ON gs.id = m.geo_sub_type_id ORDER BY m.id');
    let teams = {}; try { (await runQuery('SELECT id, name FROM team')).forEach(t => { teams[t.id] = t.name; }); } catch (e) {}
    const list = (await dbAll('SELECT id, name, source, aliases FROM bk_vendors')).map(v => Object.assign(v, { _m: matNorm(v.name), _al: String(v.aliases || '').split('\n').filter(Boolean) }));
    let n = 0;
    const seen = [];
    for (const r of rows) {
      const name = String(r.name || '').trim().slice(0, 200); if (!name) continue;
      let ids = []; try { ids = Array.isArray(r.department_ids) ? r.department_ids : JSON.parse(r.department_ids || '[]'); } catch (e) {}
      const teamNames = (ids || []).map(id => teams[id] || null).filter(Boolean).join(', ');
      const sup = supplierFor(r.supplier, list);
      const size = String(r.size || '').trim() || (r.size_w && r.size_h ? Number(r.size_w) + ' × ' + Number(r.size_h) : '');
      const photo = /^https?:\/\//.test(String(r.photo_url || '')) ? String(r.photo_url).slice(0, 300) : null;
      await dbRun(`INSERT INTO bk_materials (crm_id, name, material, type, step, geo_type_id, geo_type, geo_sub_type_id, geo_sub_type, teams, supplier_text, vendor_id, manufacturer, cost, stock, location, code, axiom_id, size, thickness, color, photo, synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(crm_id) DO UPDATE SET name = excluded.name, material = excluded.material, type = excluded.type, step = excluded.step, geo_type_id = excluded.geo_type_id, geo_type = excluded.geo_type,
          geo_sub_type_id = excluded.geo_sub_type_id, geo_sub_type = excluded.geo_sub_type, teams = excluded.teams, supplier_text = excluded.supplier_text, vendor_id = excluded.vendor_id, manufacturer = excluded.manufacturer,
          cost = excluded.cost, stock = excluded.stock, location = excluded.location, code = excluded.code, axiom_id = excluded.axiom_id, size = excluded.size, thickness = excluded.thickness, color = excluded.color, photo = excluded.photo, synced_at = excluded.synced_at`,
        [r.id, name, r.material || null, r.type || null, r.production_step || null, r.geo_type_id || null, r.geo_type || null, r.geo_sub_type_id || null, r.geo_sub_type || null, teamNames || null,
          String(r.supplier || '').trim().slice(0, 200) || null, sup ? sup.id : null, String(r.manufacturer || '').trim().slice(0, 100) || null, r.cost != null ? Number(r.cost) : null, r.stock != null ? Number(r.stock) : null,
          r.location || null, r.code || null, r.axiom_id || null, size || null, r.thickness != null ? Number(r.thickness) : null, r.color_name || null, photo]);
      seen.push(r.id); n++;
    }
    if (seen.length) await dbRun('DELETE FROM bk_materials WHERE crm_id NOT IN (' + seen.map(() => '?').join(',') + ')', seen);   // deleted in the CRM
    matCache.at = 0;
    return n;
  }
  let matCache = { at: 0, byVendor: {} };
  // What each vendor supplies, from the catalog: { vendor_id: { n, geo: {Sheets: 57, …}, materials: {paper_cover: 3, …} } }
  async function suppliesByVendor() {
    if (Date.now() - matCache.at < 60000) return matCache.byVendor;
    const rows = await dbAll('SELECT vendor_id, geo_type, material FROM bk_materials WHERE vendor_id IS NOT NULL');
    const by = {};
    rows.forEach(r => { const v = by[r.vendor_id] || (by[r.vendor_id] = { n: 0, geo: {}, materials: {} }); v.n++; if (r.geo_type) v.geo[r.geo_type] = (v.geo[r.geo_type] || 0) + 1; if (r.material) v.materials[r.material] = (v.materials[r.material] || 0) + 1; });
    matCache = { at: Date.now(), byVendor: by };
    return by;
  }
  const topKeys = (o, k) => Object.keys(o).sort((a, b) => o[b] - o[a]).slice(0, k);
  // Equipment from the CRM (`equipments`: name, photo_url, action_ids → the team(s) through `actions.team_id`). Only the
  // machine itself is copied — operators and production steps stay in the CRM. Financing columns are never touched here.
  async function syncEquipment() {
    const rows = await runQuery('SELECT e.id, e.name, e.photo_url, e.action_ids FROM equipments e ORDER BY e.id');
    let teamOf = {}; try { (await runQuery('SELECT a.id, t.name FROM actions a JOIN team t ON t.id = a.team_id')).forEach(r => { teamOf[r.id] = r.name; }); } catch (e) {}
    const seen = [];
    for (const r of rows) {
      const name = String(r.name || '').trim().slice(0, 200); if (!name) continue;
      let ids = []; try { ids = Array.isArray(r.action_ids) ? r.action_ids : JSON.parse(r.action_ids || '[]'); } catch (e) {}
      const team = Array.from(new Set((ids || []).map(id => teamOf[id]).filter(Boolean))).join(', ') || null;
      const photo = /^https?:\/\//.test(String(r.photo_url || '')) ? String(r.photo_url).slice(0, 300) : null;
      await dbRun(`INSERT INTO bk_equipment (crm_id, name, photo, team, active, synced_at) VALUES (?,?,?,?,1,datetime('now'))
        ON CONFLICT(crm_id) DO UPDATE SET name = excluded.name, photo = excluded.photo, team = excluded.team, active = 1, synced_at = excluded.synced_at`, [r.id, name, photo, team]);
      seen.push(r.id);
    }
    if (seen.length) await dbRun('UPDATE bk_equipment SET active = 0 WHERE crm_id IS NOT NULL AND crm_id NOT IN (' + seen.map(() => '?').join(',') + ')', seen);   // deleted in the CRM: kept (its payments and depreciation stay), shown as retired
    return rows.length;
  }
  // Months from a YYYY-MM-DD to today (whole months, never negative).
  const monthsSince = (d, to) => { if (!d) return 0; const a = new Date(d + 'T00:00:00'), b = to ? new Date(to + 'T00:00:00') : new Date(); if (isNaN(a)) return 0; return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0)); };
  const addMonths = (d, n) => { if (!d) return null; const a = new Date(d + 'T00:00:00'); if (isNaN(a)) return null; a.setMonth(a.getMonth() + n); return a.toISOString().slice(0, 10); };
  // Straight-line book value of an owned / financed machine at a date: price − (price − salvage) × months / life.
  function bookValue(e, at) {
    const price = Number(e.purchase_price) || 0; if (!price || !e.purchase_date) return null;
    const life = (Number(e.life_years) || 7) * 12, salvage = Number(e.salvage) || 0;
    const m = Math.min(life, monthsSince(e.purchase_date, at));
    return Math.max(salvage, Math.round((price - (price - salvage) * m / life) * 100) / 100);
  }
  // Everything the page shows per machine: the CRM facts, the financing, and what the books say so far.
  async function equipmentRows() {
    const rows = await dbAll('SELECT e.*, v.name AS vendor_name, v.photo AS vendor_photo FROM bk_equipment e LEFT JOIN bk_vendors v ON v.id = e.vendor_id ORDER BY e.active DESC, e.team, e.name');
    const paid = {}; (await dbAll('SELECT equipment_id, COUNT(*) AS n, SUM(ABS(amount)) AS total, MAX(date) AS last FROM bk_transactions WHERE equipment_id IS NOT NULL GROUP BY equipment_id')).forEach(r => { paid[r.equipment_id] = r; });
    const bills = {}; (await dbAll("SELECT equipment_id, COUNT(*) AS n, SUM(total) AS total FROM bk_bills WHERE equipment_id IS NOT NULL AND status <> 'rejected' GROUP BY equipment_id")).forEach(r => { bills[r.equipment_id] = r; });
    const y0 = new Date().getFullYear() + '-01-01';
    // 1.19.135: a loan from Loans & Leases that finances a machine shows on the machine's row (financing, monthly, paid, value)
    const byEq = {}; (await dbAll("SELECT l.*, v.name AS vendor_name, v.photo AS vendor_photo FROM bk_loans l LEFT JOIN bk_vendors v ON v.id = l.vendor_id WHERE l.equipment_id IS NOT NULL ORDER BY l.status = 'active' DESC, l.id DESC")).forEach(l => { if (!byEq[l.equipment_id]) byEq[l.equipment_id] = l; });
    const loanPaid = {}; (await dbAll('SELECT loan_id, COUNT(*) AS n, SUM(ABS(amount)) AS total, MAX(date) AS last FROM bk_transactions WHERE loan_id IS NOT NULL AND equipment_id IS NULL GROUP BY loan_id')).forEach(r => { loanPaid[r.loan_id] = r; });
    return rows.map(e => {
      const out = Object.assign({}, e);
      const p = paid[e.id] || { n: 0, total: 0, last: null }, b = bills[e.id] || { n: 0, total: 0 };
      out.payments = { n: p.n, total: Math.round((p.total || 0) * 100) / 100, last: p.last, bills: b.n, billed: Math.round((b.total || 0) * 100) / 100 };
      const L = byEq[e.id];
      if (L) {   // a linked loan wins over the machine's own financing fields
        const m = loanMath(L), isLease = L.kind === 'lease', done = Math.min((m.term + m.deferred) || 9999, monthsSince(L.start_date)), left = Math.max(0, (m.term + m.deferred) - done);
        const a = isLease ? { balance: left * m.monthly } : amort(m.financed, m.apr, m.term, m.monthly, Math.max(0, done - m.deferred));
        const lp = loanPaid[L.id]; if (lp) { out.payments.n += lp.n; out.payments.total = Math.round((out.payments.total + (lp.total || 0)) * 100) / 100; if (!out.payments.last || (lp.last && lp.last > out.payments.last)) out.payments.last = lp.last; }
        out.mode = isLease ? 'lease' : 'loan';
        out.loan = { id: L.id, name: L.name, kind: L.kind, lender: L.vendor_name || L.lender || null, status: L.status, principal: m.principal, down: m.down, financed: m.financed, deferred: m.deferred, apr: m.apr, apr_given: m.apr_given, total_payback: m.total_payback, total_interest: m.total_interest, term: m.term, sales_tax: m.sales_tax, tax_in: m.tax_in, property_tax: m.property_tax, payment: m.payment };
        if (!out.vendor_id && L.vendor_id) { out.vendor_id = L.vendor_id; out.vendor_name = L.vendor_name; out.vendor_photo = L.vendor_photo; }
        out.schedule = { start: L.start_date, end: m.term ? addMonths(L.start_date, m.term + m.deferred) : null, months_done: done, months_left: left, monthly: m.monthly, property_tax: m.property_tax, payment: m.payment, remaining: Math.round((a.balance || 0) * 100) / 100 };
        if (!isLease) { const ee = Object.assign({}, e, { purchase_price: Number(e.purchase_price) || m.principal, purchase_date: e.purchase_date || L.start_date }); out.purchase_price = ee.purchase_price; out.purchase_date = ee.purchase_date; out.book = { year_start: bookValue(ee, y0), now: bookValue(ee, null), yearly: ee.purchase_price && ee.life_years !== 0 ? Math.round(((Number(ee.purchase_price) || 0) - (Number(ee.salvage) || 0)) / (Number(ee.life_years) || 7) * 100) / 100 : null }; }
        return out;
      }
      if (e.mode === 'loan') {
        const start = e.loan_start || e.purchase_date, term = Number(e.loan_term) || 0, done = Math.min(term, monthsSince(start)), left = Math.max(0, term - done);
        out.schedule = { start, end: term ? addMonths(start, term) : null, months_done: done, months_left: left, monthly: Number(e.monthly_payment) || 0, remaining: Math.round(left * (Number(e.monthly_payment) || 0) * 100) / 100 };
      } else if (e.mode === 'lease') {
        const start = e.lease_start, term = Number(e.lease_term) || 0, done = Math.min(term, monthsSince(start)), left = Math.max(0, term - done);
        out.schedule = { start, end: term ? addMonths(start, term) : null, months_done: done, months_left: left, monthly: Number(e.lease_monthly) || 0, remaining: Math.round(left * (Number(e.lease_monthly) || 0) * 100) / 100 };
      }
      if (e.mode === 'owned' || e.mode === 'loan') out.book = { year_start: bookValue(e, y0), now: bookValue(e, null), yearly: e.purchase_price && e.life_years !== 0 ? Math.round(((Number(e.purchase_price) || 0) - (Number(e.salvage) || 0)) / (Number(e.life_years) || 7) * 100) / 100 : null };
      return out;
    });
  }
  // 1.19.99: loan arithmetic. Standard amortization: balance after n payments of M on principal P at monthly rate i is
  // P(1+i)^n − M((1+i)^n − 1)/i; the interest part of payment k is the balance before it × i. A lease / 0% loan is straight-line.
  const amort = (P, apr, term, monthly, n) => {
    P = Number(P) || 0; const i = (Number(apr) || 0) / 100 / 12; term = Number(term) || 0; n = Math.max(0, Math.min(term || n, n));
    let M = Number(monthly) || 0; if (!M && term) M = i ? P * i / (1 - Math.pow(1 + i, -term)) : P / term;
    let bal = P, interest = 0, principal = 0;
    for (let k = 0; k < n; k++) { const int = i ? bal * i : 0; const pr = Math.min(bal, M - int); interest += int; principal += pr; bal = Math.max(0, bal - pr); if (bal <= 0.005) { bal = 0; break; } }
    return { monthly: Math.round(M * 100) / 100, balance: Math.round(bal * 100) / 100, interest_paid: Math.round(interest * 100) / 100, principal_paid: Math.round(principal * 100) / 100,
      total_interest: term ? Math.round((M * term - P) * 100) / 100 : null };
  };
  // 1.19.135: the effective annual rate behind "N payments of M on P, after D months with no payment" — bisection on the
  // monthly rate so that P grown over the deferred months equals the present value of the payments (+ a balloon).
  function solveApr(P, term, monthly, deferred, balloon) {
    P = Number(P) || 0; term = Number(term) || 0; monthly = Number(monthly) || 0; deferred = Number(deferred) || 0; balloon = Number(balloon) || 0;
    if (!P || !term || !monthly) return null;
    const pv = (i) => { const f = Math.pow(1 + i, -deferred); return f * (monthly * (1 - Math.pow(1 + i, -term)) / i + balloon * Math.pow(1 + i, -term)); };
    if (monthly * term + balloon <= P + 0.005) return 0;
    let lo = 1e-7, hi = 0.1;   // 0.00001% .. 120% APR
    for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (pv(mid) > P) lo = mid; else hi = mid; }
    return Math.round(((lo + hi) / 2) * 12 * 100 * 1000) / 1000;
  }
  // what a loan row amounts to: financed principal, the monthly payment (given, or from the total, or from the APR),
  // the APR (given, or solved from the payments), the total to be paid back and the interest
  function loanMath(l) {
    const principal = Number(l.principal) || 0, down = Number(l.down_payment) || 0, deferred = Number(l.deferred_months) || 0, term = Number(l.term_months) || 0, balloon = Number(l.balloon) || 0;
    const financed = Math.max(0, principal - down);
    let monthly = Number(l.monthly) || 0, apr = l.apr === '' || l.apr == null ? null : Number(l.apr), total = Number(l.total_payback) || 0;
    if (!monthly && total && term) monthly = Math.max(0, (total - down - balloon) / term);
    if (!monthly && apr != null && term) { const i = apr / 100 / 12; const g = financed * Math.pow(1 + i, deferred); monthly = i ? g * i / (1 - Math.pow(1 + i, -term)) : g / term; }
    let effective = apr; if (effective == null && monthly && term) effective = solveApr(financed, term, monthly, deferred, balloon);
    if (!total && monthly && term) total = down + monthly * term + balloon;
    const tax = Number(l.sales_tax) || 0, taxIn = tax ? (l.tax_in == null ? 1 : Number(l.tax_in) ? 1 : 0) : null, propTax = Number(l.property_tax_monthly) || 0;
    return { principal, down, deferred, term, balloon, financed, monthly: Math.round(monthly * 100) / 100, apr: effective, apr_given: apr != null, total_payback: Math.round(total * 100) / 100, total_interest: Math.round((total - principal) * 100) / 100,
      sales_tax: tax, tax_in: taxIn, property_tax: propTax, payment: Math.round((monthly + propTax) * 100) / 100,   // payment = what leaves the bank each month
      total_cost: Math.round((total + (tax && !taxIn ? tax : 0) + propTax * term) * 100) / 100 };   // everything paid over the term: payback + separate tax + property tax
  }
  async function loanRows() {
    const own = await dbAll('SELECT l.*, v.name AS vendor_name, v.photo AS vendor_photo, e.name AS equipment_name, e.photo AS equipment_photo FROM bk_loans l LEFT JOIN bk_vendors v ON v.id = l.vendor_id LEFT JOIN bk_equipment e ON e.id = l.equipment_id ORDER BY l.status, l.start_date DESC, l.id DESC');
    const paid = {}; (await dbAll('SELECT loan_id, COUNT(*) AS n, SUM(ABS(amount)) AS total, MAX(date) AS last FROM bk_transactions WHERE loan_id IS NOT NULL GROUP BY loan_id')).forEach(r => { paid[r.loan_id] = r; });
    const nFiles = {}; (await dbAll("SELECT ref_id, COUNT(*) AS n FROM bk_files WHERE kind = 'loan' GROUP BY ref_id")).forEach(r => { nFiles[r.ref_id] = r.n; });
    const out = own.map(l => {
      const lm = loanMath(l), done = Math.min((lm.term + lm.deferred) || 9999, monthsSince(l.start_date)), left = Math.max(0, (lm.term + lm.deferred) - done);
      const a = l.kind === 'lease' ? { monthly: Number(l.monthly) || 0, balance: Math.round(left * (Number(l.monthly) || 0) * 100) / 100, interest_paid: 0, principal_paid: Math.round(done * (Number(l.monthly) || 0) * 100) / 100, total_interest: null } : (() => { const m = loanMath(l); const r = amort(m.financed, m.apr, m.term, m.monthly, Math.max(0, done - m.deferred)); r.monthly = m.monthly; r.total_interest = m.total_interest; return r; })();   // 1.19.135: down payment, deferred months, solved APR
      const p = paid[l.id] || { n: 0, total: 0, last: null };
      return Object.assign({}, l, { source: 'loan', files: nFiles[l.id] || 0, math: loanMath(l), schedule: { start: l.start_date, end: lm.term ? addMonths(l.start_date, lm.term + lm.deferred) : null, months_done: done, months_left: left, monthly: a.monthly, next: l.status === 'active' && left ? addMonths(l.start_date, done + 1) : null },
        balance: a.balance, interest_paid: a.interest_paid, principal_paid: a.principal_paid, total_interest: a.total_interest, payments: { n: p.n, total: Math.round((p.total || 0) * 100) / 100, last: p.last } });
    });
    // machines financed through the Equipment tab appear here too, read-only (edit them under Equipment)
    const linked = new Set(own.map(l => l.equipment_id).filter(Boolean));
    for (const e of (await equipmentRows()).filter(e => (e.mode === 'loan' || e.mode === 'lease') && !e.loan && !linked.has(e.id))) {
      const isLoan = e.mode === 'loan', P = isLoan ? (Number(e.loan_amount) || Math.max(0, (Number(e.purchase_price) || 0) - (Number(e.down_payment) || 0))) : 0;
      const sch = e.schedule || { months_done: 0, months_left: 0, monthly: 0 };
      const a = isLoan ? amort(P, e.loan_rate, e.loan_term, e.monthly_payment, sch.months_done) : { monthly: sch.monthly, balance: sch.remaining || 0, interest_paid: 0, principal_paid: Math.round(sch.months_done * sch.monthly * 100) / 100, total_interest: null };
      out.push({ id: 'e' + e.id, source: 'equipment', equipment_id: e.id, equipment_name: e.name, equipment_photo: e.photo, name: e.name, kind: e.mode, lender: e.vendor_name || null, vendor_id: e.vendor_id, vendor_name: e.vendor_name, vendor_photo: e.vendor_photo,
        principal: P || null, start_date: sch.start, term_months: isLoan ? e.loan_term : e.lease_term, apr: isLoan ? e.loan_rate : null, monthly: a.monthly, status: sch.months_left || !sch.start ? 'active' : 'paid', notes: e.notes,
        schedule: Object.assign({}, sch, { next: sch.months_left ? addMonths(sch.start, sch.months_done + 1) : null }), balance: a.balance, interest_paid: a.interest_paid, principal_paid: a.principal_paid, total_interest: a.total_interest, payments: e.payments, book: e.book || null });
    }
    return out;
  }
  // A payment to a vendor that finances a machine belongs to that machine: same monthly amount to the cent, or the
  // vendor's only financed machine. Used for bank lines (and the purchase made from them) and for bills.
  async function equipmentFor(vendorId, amount) {
    if (!vendorId) return null;
    const list = await dbAll("SELECT id, mode, monthly_payment, lease_monthly FROM bk_equipment WHERE vendor_id = ? AND mode IN ('loan', 'lease')", [vendorId]);
    if (!list.length) return null;
    const amt = Math.abs(Number(amount) || 0);
    const exact = list.filter(e => { const m = Number(e.mode === 'lease' ? e.lease_monthly : e.monthly_payment) || 0; return m && Math.abs(m - amt) < 0.005; });
    if (exact.length === 1) return exact[0].id;
    if (!exact.length && list.length === 1) return list[0].id;
    return null;
  }
  // Keep the directory current by itself: the tab syncs when it opens and the last sync is older than 10 minutes,
  // the clock every hour, the daily run always.
  async function syncDirectoryIfStale(who, maxAgeMs) { if (runQuery && Date.now() - dirSync.at > maxAgeMs) { try { await syncDirectory(who); } catch (e) { dirSync.error = e.message; errlog('directory sync', e.message); } } }
  let dirCache = { at: 0, list: [] };
  async function directory() {
    if (Date.now() - dirCache.at < 60000) return dirCache.list;
    const rows = await dbAll('SELECT * FROM bk_vendors ORDER BY name');
    dirCache = { at: Date.now(), list: rows.map(v => Object.assign({}, v, { _n: normV(v.name), _al: String(v.aliases || '').split('\n').filter(a => a.indexOf('@') < 0).map(normV).filter(Boolean), _als: String(v.aliases || '').split('\n').filter(a => a.indexOf('@') < 0).map(stableV).filter(a => a.length >= 6), _em: String(v.aliases || '').split('\n').map(a => a.trim().toLowerCase()).filter(a => a.indexOf('@') > 0), _dom: domainOf(v.email) })) };
    return dirCache.list;
  }
  // The directory entry a bank line / bill belongs to: an alias or the full name inside the text, or the email domain.
  async function matchVendor(text, email) {
    const list = await directory();
    const n = normV(text), dom = domainOf(email);
    // an address someone linked from the inbox (kept here in bk_vendors.aliases, not in the CRM) wins
    const addr = String(email || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/); if (addr) { const byAddr = list.find(v => v._em.indexOf(addr[0]) > -1); if (byAddr) return byAddr; }
    if (dom && !FREE_MAIL.test(dom)) { const byDom = list.find(v => v._dom && (v._dom === dom || dom.endsWith('.' + v._dom))); if (byDom) return byDom; }
    if (!n) return null;
    const hits = list.filter(v => v._n.length >= 3 && (n === v._n || (' ' + n + ' ').indexOf(' ' + v._n + ' ') > -1 || v._al.some(a => a.length >= 3 && (' ' + n + ' ').indexOf(' ' + a + ' ') > -1)));
    if (hits.length) return hits.sort((a, b) => b._n.length - a._n.length)[0];
    // 1.19.91: an alias whose stable wording (codes dropped) equals, or sits inside, the line's stable wording
    const ns = stableV(text);
    if (ns.length >= 6) { const byStable = list.filter(v => (v._als || []).some(a => a === ns || (' ' + ns + ' ').indexOf(' ' + a + ' ') > -1)); if (byStable.length) return byStable.sort((a, b) => b._n.length - a._n.length)[0]; }
    // (No first-word guessing here: "Pacific Office Automation" must not land on "Pacific Engravers". Near matches are
    // offered by suggestVendors() for a person to confirm.)
    return null;
  }
  // Near matches for a bill's vendor name: scored by shared name words (less the generic ones), prefix, and the email
  // domain; CRM entries only (a bill-source row is what we are trying to replace). [{ vendor, score }], best first.
  const GENERIC = /^(inc|llc|co|corp|corporation|company|the|of|and|ltd|group|services|service|usa|us|international)$/;
  const words = (t) => matNorm(t).split(' ').filter(w => w && !GENERIC.test(w));
  async function suggestVendors(name, email, n) {
    const list = (await directory()).filter(v => v.source && v.source !== 'bill');
    const W = words(name), nn = W.join(' '), dom = domainOf(email);
    const out = [];
    list.forEach(v => {
      const VW = words(v.name), vn = VW.join(' ');
      let score = 0;
      if (nn && vn) {
        if (nn === vn) score = 1;
        else {
          const hit = W.filter(w => VW.indexOf(w) > -1).length;
          score = hit ? hit / Math.max(W.length, VW.length) : 0;
          if (vn.startsWith(nn) || nn.startsWith(vn)) score = Math.max(score, 0.85);
          const al = (v._al || []).map(a => words(a).join(' '));
          if (al.indexOf(nn) > -1) score = 1;
          // initials: "POA" ~ Pacific Office Automation
          if (!score && W.length === 1 && W[0].length >= 3 && VW.length >= 3 && VW.map(x => x[0]).join('') === W[0]) score = 0.7;
        }
      }
      if (dom && !FREE_MAIL.test(dom) && v._dom && (v._dom === dom || dom.endsWith('.' + v._dom))) score = Math.max(score, 0.95);
      if (score >= 0.3) out.push({ vendor: v, score: Math.round(score * 100) / 100 });
    });
    return out.sort((a, b) => b.score - a.score).slice(0, n || 5);
  }
  const vendorCard = (v) => v ? { id: v.id, name: v.name, kind: v.kind || (v.source === 'suppliers' ? 'supplier' : v.source === 'vendors' ? 'vendor' : v.source === 'bill' ? 'bill' : 'other'), source: v.source, photo: v.photo || null, approved: !!v.approved, specialty: v.specialty || '' } : null;
  const dirLine = async () => {
    const list = (await directory()).filter(v => v.approved);
    if (!list.length) return '';
    const sup = await suppliesByVendor();
    const geo = await dbAll('SELECT geo_type, COUNT(*) n FROM bk_materials WHERE geo_type IS NOT NULL GROUP BY geo_type ORDER BY n DESC');
    return 'OUR SUPPLIERS AND VENDORS (from the CRM; a transaction or bill from one of these is a normal purchase — use the specialty and what they supply to pick the category):\n' +
      list.slice(0, 120).map(v => { const s = sup[v.id]; return '- ' + v.name + (v.specialty ? ' (' + v.specialty + ')' : '') + (s ? ' — supplies ' + s.n + ' material' + (s.n === 1 ? '' : 's') + ': ' + topKeys(s.geo, 3).map(g => g + ' ×' + s.geo[g]).join(', ') + (Object.keys(s.materials).length ? ' [' + topKeys(s.materials, 3).join(', ') + ']' : '') : '') + (v.default_category ? ' → ' + v.default_category : ''); }).join('\n') +
      (geo.length ? '\nMATERIALS CATALOG — GEO TYPES (how AxiomPrint groups what it buys for production; a purchase of any of these is cost of goods / production materials, not office supplies): ' + geo.map(g => g.geo_type + ' (' + g.n + ')').join(', ') + '.' : '');
  };

  // ---------------------------------------------------------------- Claude: bills and categories
  const SYS = (s) => 'You are BookkeeperAI, the bookkeeping assistant of AxiomPrint (a print shop in Glendale, CA). You never decide anything: ' +
    'you PROPOSE, with a confidence from 0 to 1 and a one-line reason, and a person approves. Be precise, use only what is in the documents and data, never invent amounts or dates. ' +
    'CHART OF ACCOUNTS — type of expense: its sub categories (always answer with the SUB category name exactly as written; a type with no sub categories is used by its own name): ' + chartText(s) + '. NOTES FROM THE OWNER: ' + String(s.notes || '');
  async function fileBlock(att) {
    const full = path.join(FILES, att.file);
    if (!fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    if (/\.pdf$/i.test(att.file)) return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
    const mt = /\.png$/i.test(att.file) ? 'image/png' : /\.webp$/i.test(att.file) ? 'image/webp' : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: mt, data: buf.toString('base64') } };
  }
  const jsonOf = (txt) => { try { const m = String(txt).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };
  // One email → is it a bill? → a bill draft + a proposal (or skipped with a note).
  async function parseEmail(em, who) {
    const s = await settings();
    let atts = []; try { atts = JSON.parse(em.attachments || '[]'); } catch (e) {}
    const content = [];
    for (const a of atts.slice(0, 4)) { const b = await fileBlock(a); if (b) content.push(b); }
    content.push({ type: 'text', text: 'EMAIL\nFrom: ' + em.from_addr + '\nSubject: ' + em.subject + '\nReceived: ' + em.received_at + '\nAttachments: ' + (atts.map(a => a.name).join(', ') || 'none') +
      '\n\n' + String(em.body || '').slice(0, 6000) +
      '\n\nIs this a bill (vendor invoice), a statement, a credit memo, a receipt for something already paid, or not a bill at all (marketing, a reply, a notification)? ' +
      'Return ONLY JSON: {"is_bill": true|false, "kind": "invoice"|"statement"|"credit_memo"|"receipt"|"other", "vendor": "", "invoice_no": "", "invoice_date": "YYYY-MM-DD", "due_date": "YYYY-MM-DD" or null, "terms": "", ' +
      '"subtotal": 0, "tax": 0, "total": 0, "currency": "USD", "lines": [{"description": "", "qty": 1, "unit_price": 0, "amount": 0, "category": "<from the chart of accounts>"}], ' +
      '"confidence": 0.0, "reason": "", "note": "anything odd (handwritten, partial, foreign currency, past due)"}' });
    const r = await anthropic.messages.create({ model: MODEL, max_tokens: 1800, system: SYS(s) + '\n' + await dirLine(), messages: [{ role: 'user', content: content }] });
    const j = jsonOf((r.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
    if (!j) { await dbRun("UPDATE bk_emails SET status = 'error', note = ? WHERE id = ?", ['The AI gave no usable answer.', em.id]); return null; }
    if (!j.is_bill || ['invoice', 'credit_memo', 'statement'].indexOf(j.kind) === -1) {
      if (s.triage_auto) await dbRun("UPDATE bk_emails SET status = 'skipped', read_by = 'ai', kind = COALESCE(kind, ?), note = ? WHERE id = ?", [j.kind === 'receipt' ? 'receipt' : 'other', (j.kind || 'other') + (j.reason ? ' — ' + j.reason : ''), em.id]);
      else await dbRun("UPDATE bk_emails SET kind = ?, confidence = ?, triaged_at = COALESCE(triaged_at, datetime('now')), note = ? WHERE id = ?", [j.kind === 'receipt' ? 'receipt' : 'other', Math.max(0, Math.min(1, Number(j.confidence) || 0)), 'read in full: ' + (j.kind || 'other') + (j.reason ? ' — ' + j.reason : ''), em.id]);
      return null;
    }
    const vendor = String(j.vendor || '').trim().slice(0, 120) || 'Unknown vendor';
    const invNo = String(j.invoice_no || '').trim().slice(0, 80);
    const dup = invNo ? await dbGet('SELECT id FROM bk_bills WHERE LOWER(vendor) = LOWER(?) AND invoice_no = ? AND status <> ?', [vendor, invNo, 'rejected'])
      : await dbGet('SELECT id FROM bk_bills WHERE LOWER(vendor) = LOWER(?) AND ABS(total - ?) < 0.01 AND invoice_date = ? AND status <> ?', [vendor, Number(j.total) || 0, j.invoice_date || '', 'rejected']);
    let v = (await matchVendor(vendor, em.from_addr)) || await dbGet('SELECT * FROM bk_vendors WHERE LOWER(name) = LOWER(?)', [vendor]);
    if (!v) { const sug = await suggestVendors(vendor, em.from_addr, 1); if (sug.length && sug[0].score >= 0.85) v = sug[0].vendor; }   // "Pacific Office Automation" ↔ "Pacific Office Automation Inc"
    if (!v) { await dbRun('INSERT INTO bk_vendors (name, approved, source) VALUES (?, 0, ?)', [vendor, 'bill']); v = await dbGet('SELECT * FROM bk_vendors WHERE LOWER(name) = LOWER(?)', [vendor]); dirCache.at = 0; }
    const main = atts[0] || null;
    const ins = await dbRun('INSERT INTO bk_bills (email_id, vendor, vendor_id, invoice_no, invoice_date, due_date, terms, subtotal, tax, total, currency, kind, duplicate_of, lines, file, file_name, status, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [em.id, vendor, v ? v.id : null, invNo || null, j.invoice_date || null, j.due_date || null, String(j.terms || '').slice(0, 60), Number(j.subtotal) || null, Number(j.tax) || null, Number(j.total) || 0,
        String(j.currency || 'USD').slice(0, 8), j.kind, dup ? dup.id : null, JSON.stringify(await applyLineLinks(v ? v.id : null, (j.lines || []).slice(0, 60))), main ? main.file : null, main ? main.name : null, 'draft', String(j.note || '').slice(0, 500)]);
    const billId = ins.lastID;
    const conf = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    const newVendor = v && !v.approved;
    const title = (j.kind === 'credit_memo' ? 'Credit memo' : j.kind === 'statement' ? 'Statement' : 'Bill') + ' from ' + vendor + (invNo ? ' #' + invNo : '') + ' — $' + (Number(j.total) || 0).toFixed(2) +
      (dup ? ' (possible DUPLICATE of bill #' + dup.id + ')' : '') + (newVendor ? ' (NEW vendor — needs your approval)' : '');
    const p = await dbRun('INSERT INTO bk_proposals (type, ref_table, ref_id, title, payload, confidence, reason) VALUES (?,?,?,?,?,?,?)',
      ['bill', 'bk_bills', billId, title, JSON.stringify({ vendor, invoice_no: invNo, invoice_date: j.invoice_date, due_date: j.due_date, total: Number(j.total) || 0, kind: j.kind, duplicate_of: dup ? dup.id : null, new_vendor: !!newVendor, lines: (j.lines || []).slice(0, 60) }),
        conf, String(j.reason || '').slice(0, 300)]);
    await dbRun('UPDATE bk_bills SET proposal_id = ? WHERE id = ?', [p.lastID, billId]);
    await dbRun("UPDATE bk_emails SET status = 'parsed', kind = 'bill', note = ? WHERE id = ?", ['Bill draft #' + billId, em.id]);
    const eqId = await equipmentFor(v ? v.id : null, Number(j.total) || 0); if (eqId) await dbRun('UPDATE bk_bills SET equipment_id = ? WHERE id = ?', [eqId, billId]);   // a loan / lease payment bill belongs to its machine
    // the bill's purchase: new, or the one its email already belongs to (an arrival or a confirmation came first)
    if (em.purchase_id) { await attachTo(em.purchase_id, { bill_id: billId }, who); try { await fillItemsFromBill(em.purchase_id, Object.assign({}, j, { lines: JSON.stringify(j.lines || []), email_id: em.id }), who); } catch (e) {} }
    else { const firstCat = ((j.lines || []).find(l => l && l.category) || {}).category || null; const pid = await newPurchase({ vendor_id: v ? v.id : null, vendor, amount: Number(j.total) || 0, date: j.invoice_date || today(), order_no: invNo || null, category: firstCat, bill_id: billId }, who); await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [pid, em.id]); if (eqId) await dbRun('UPDATE bk_purchases SET equipment_id = ? WHERE id = ?', [eqId, pid]);  try { await fillItemsFromBill(pid, Object.assign({}, j, { lines: JSON.stringify(j.lines || []), email_id: em.id }), who); } catch (e) {} }
    markReadInGmail([em.id], who).then(r => { if (r.ok && r.n) return dbRun("UPDATE bk_emails SET read_by = 'user' WHERE id = ?", [em.id]); }).catch(() => {});   // handled → read in Gmail → closed here (quietly; the scope may be missing)
    if (conf < s.threshold || dup || newVendor) {
      const q = dup ? 'This looks like a duplicate of bill #' + dup.id + ' (' + vendor + (invNo ? ' #' + invNo : '') + '). Is it the same bill?'
        : newVendor ? vendor + ' is a new vendor. Is this a real vendor of ours, and should I approve them for future bills?'
        : 'Can you check this draft from ' + vendor + '? I am only ' + Math.round(conf * 100) + '% sure.';
      await dbRun('INSERT INTO bk_questions (proposal_id, question) VALUES (?,?)', [p.lastID, q]);
    }
    await audit(who, 'bill.draft', billId, { vendor, total: j.total, confidence: conf });
    if (em.id) { await audit(who, 'email.bill', em.id, { bill_id: billId, vendor, total: j.total }); await decideEmail(em.id, 'bill', who); }
    return billId;
  }
  // Triage before the expensive read: a cheap text-only look at every unread email (sender, subject, first lines).
  // Advertisements, newsletters, shipping / account notifications and payment receipts that the model is ≥ 95% sure
  // about are marked read ("skipped") with the reason; anything that might be a bill stays for parseEmail().
  // Every unread email gets a kind and a confidence (stored); what happens next depends on the thresholds in settings:
  //   advertisement / receipt ≥ triage_ad     → marked read by the AI (set aside)
  //   arrival (shipped / delivered notifications) ≥ triage_notice → marked read by the AI
  //   bill ≥ triage_bill                        → read in full by parseEmail() → a bill draft
  //   message (a person writing) ≥ triage_message → left for a person, tagged "message"
  //   anything else / unsure                    → read in full anyway (a missed bill costs more than a model call)
  // A person's decision about an email (the training signal for the AI): what they said it is, who, when.
  const decideEmail = (id, kind, who) => dbRun("UPDATE bk_emails SET decided_kind = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?", [kind, who, id]);
  // What still needs a rating: new mail, and mail already read in Gmail (rated for the Everything else basket only).
  const TO_RATE = "triaged_at IS NULL AND status = 'new'";
  async function triageEmails(who, limit) {
    const s = await settings();
    const rows = await dbAll("SELECT id, status, read_by, from_addr, subject, snippet, body, attachments FROM bk_emails WHERE " + TO_RATE + " ORDER BY id LIMIT ?", [limit || 150]);
    const out = { looked: 0, read: 0, bills: 0, messages: 0, unsure: 0, by_kind: {}, items: [] };
    const auto = !!s.triage_auto;
    for (let i = 0; i < rows.length; i += 25) {
      const batch = rows.slice(i, i + 25);
      const listing = batch.map(m => { let atts = []; try { atts = JSON.parse(m.attachments || '[]'); } catch (e) {} return m.id + ' | from: ' + m.from_addr + ' | subject: ' + m.subject + ' | attachments: ' + (atts.map(a => a.name).join(', ') || 'none') + ' | text: ' + String(m.body || m.snippet || '').replace(/\s+/g, ' ').slice(0, 400); }).join('\n');
      let j = null;
      try {
        const B = basketDefs(s);
        const r = await anthropic.messages.create({ model: MODEL_LIGHT, max_tokens: 2000, system: 'You sort the accounting inbox of AxiomPrint, a print shop, into these baskets (the team\'s own definitions):\n' +
          'bill — ' + B.bill + '\nreceipt — ' + B.receipt + '\narrival — ' + B.arrival + '\nmessage — ' + B.message + ' A human-written email that contains or chases an invoice is a message, not a bill, since we may need to answer them.\nadvertisement — ' + B.advertisement + '\nother — ' + B.other +
          '\nFor each email say which basket. When in doubt between advertisement and anything else, say the other thing — a missed advertisement costs nothing, a missed bill or message does. Return ONLY JSON.',
          messages: [{ role: 'user', content: 'EMAILS\n' + listing + '\n\nReturn ONLY JSON: {"items": [{"id": <id>, "kind": "advertisement"|"receipt"|"arrival"|"bill"|"message"|"other", "confidence": 0.0, "why": "<a few words>"}]}' }] });
        j = jsonOf((r.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
      } catch (e) { errlog('triage', e.message); break; }
      for (const m of batch) {
        out.looked++;
        const it = j && Array.isArray(j.items) ? j.items.find(x => Number(x.id) === m.id) : null;
        const kind = it && ['advertisement', 'receipt', 'arrival', 'bill', 'message', 'other'].indexOf(it.kind) > -1 ? it.kind : it && it.kind === 'notification' ? 'other' : 'other';
        const conf = it ? Math.max(0, Math.min(1, Number(it.confidence) || 0)) : 0;
        const why = it ? String(it.why || '').slice(0, 200) : '';
        out.by_kind[kind] = (out.by_kind[kind] || 0) + 1;
        const pct = Math.round(conf * 100) + '%';
        let status = m.status;
        if (m.status !== 'new') {   // already read in Gmail: rated for the Everything else basket, nothing else changes
          await dbRun("UPDATE bk_emails SET kind = ?, confidence = ?, triaged_at = datetime('now'), note = ? WHERE id = ?", [kind, conf, kind + ' — ' + why + ' (' + pct + ') — read in Gmail', m.id]);
        } else if (auto && ((kind === 'advertisement' || kind === 'receipt') && conf >= s.triage_ad || kind === 'arrival' && conf >= s.triage_notice)) {
          await dbRun("UPDATE bk_emails SET status = 'skipped', kind = ?, confidence = ?, triaged_at = datetime('now'), read_by = 'ai', note = ? WHERE id = ?", [kind, conf, kind + ' — ' + why + ' (' + pct + ')', m.id]); out.read++; status = 'skipped';
        } else if (kind === 'message' && conf >= s.triage_message) {
          await dbRun("UPDATE bk_emails SET status = 'message', kind = ?, confidence = ?, triaged_at = datetime('now'), note = ? WHERE id = ?", [kind, conf, 'message — ' + why + ' (' + pct + ') — for a person to answer', m.id]); out.messages++; status = 'message';
        } else {
          // rated only (and, with auto on, bills and anything unsure go to the full read next)
          await dbRun("UPDATE bk_emails SET kind = ?, confidence = ?, triaged_at = datetime('now'), note = ? WHERE id = ?", [kind, conf, kind + ' — ' + why + ' (' + pct + ')', m.id]);
          if (kind === 'bill' && conf >= s.triage_bill) out.bills++; else out.unsure++;
        }
        out.items.push({ id: m.id, kind, confidence: conf, why, status });
      }
    }
    if (out.looked) await audit(who, 'gmail.triage', null, out);
    return out;
  }
  async function parseNewEmails(who) {
    const triage = await triageEmails(who);
    const s = await settings();
    // Nothing becomes a bill by itself: a person presses Bill (or Turn all) in the inbox. Only triage_auto (off) reads
    // everything in full. The AI's rating and the person's decision are both kept (bk_emails.kind vs decided_kind).
    const rows = s.triage_auto ? await dbAll("SELECT * FROM bk_emails WHERE status = 'new' ORDER BY id LIMIT 40") : [];
    let bills = 0;
    for (const em of rows) { try { if (await parseEmail(em, who)) bills++; } catch (e) { errlog('parse email', em.id, e.message); await dbRun("UPDATE bk_emails SET status = 'error', note = ? WHERE id = ?", [e.message.slice(0, 300), em.id]); } }
    return { emails: rows.length, bills, triage };
  }

  // Rules first (deterministic), then the AI for what is left, in one call per batch.
  const normName = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  function ruleMatch(rules, t) {
    const name = normName(t.merchant || t.name), full = normName(t.name + ' ' + (t.merchant || '')), vn = t._vendor ? normName(t._vendor.name) : (t.vendor_name ? normName(t.vendor_name) : '');
    // 1.19.91: a vendor rule also matches through the linked company ("Vendor is Stripe" files every line linked to Stripe, whatever the transfer id says)
    // 1.19.94: a vendor rule made from a bank line carries that line's wording — compared with the per-payment codes dropped
    // ("PEACE & HAIGHT I PAYMENT 261008 20261007AC …" ≡ "… 261001 20261001AC …")
    const st = stableV(t.merchant || t.name);
    const byVendor = (r) => normName(r.pattern) === name || (vn && normName(r.pattern) === vn) || (st.length >= 6 && stableV(r.pattern) === st);
    // 1.19.112: an amount condition narrows a rule ("Vendor is Amazon over $500 → Equipment"); a rule with one is tried before
    // the same vendor's plain rule, so the specific one wins. Kind 'none' ("No rule") never categorizes — see noRuleFor().
    const amt = Math.abs(Number(t.amount) || 0);
    const amountOk = (r) => !r.amount_op || r.amount_val == null ? true : r.amount_op === 'over' ? amt > Number(r.amount_val) : r.amount_op === 'under' ? amt < Number(r.amount_val) : r.amount_op === 'equal' ? Math.abs(amt - Number(r.amount_val)) < 0.005 : true;   // 1.19.114: 'equal' = exactly this amount (a fixed monthly fee)
    const live = rules.filter(r => r.kind !== 'none' && r.category);
    const ordered = live.filter(r => r.amount_op && r.amount_val != null).concat(live.filter(r => !(r.amount_op && r.amount_val != null)));
    return ordered.find(r => amountOk(r) && (r.kind === 'vendor' ? byVendor(r) : full.indexOf(normName(r.pattern)) > -1)) || null;
  }
  // 1.19.112: read an amount condition from a form: {amount_op: 'over'|'under'|'', amount_val: n}; blank = none
  const amountCond = (b) => {
    const op = String(b.amount_op || '').trim(), val = b.amount_val === '' || b.amount_val == null ? null : Number(b.amount_val);
    if (!op) return { op: null, val: null };
    if (op !== 'over' && op !== 'under' && op !== 'equal') return { error: 'Amount condition must be over, under or equal.' };
    if (val == null || !isFinite(val) || val < 0) return { error: 'Give the amount for "' + op + '".' };
    return { op, val: Math.round(val * 100) / 100 };
  };
  // 1.19.112: the "No rule" entry for this line's vendor, if one exists (kind 'none', matched like a vendor rule)
  function noRuleFor(rules, t) {
    const name = normName(t.merchant || t.name), vn = t._vendor ? normName(t._vendor.name) : (t.vendor_name ? normName(t.vendor_name) : ''), st = stableV(t.merchant || t.name);
    return rules.find(r => r.kind === 'none' && (normName(r.pattern) === name || (vn && normName(r.pattern) === vn) || (st.length >= 6 && stableV(r.pattern) === st))) || null;
  }
  // 1.19.94 / 1.19.98: rules sweep every unfiled line (new or already rated) with no model call — run inside categorize() and on
  // every Bank feed load (throttled), so a rule made today catches yesterday's lines without waiting for an AI pass.
  // 1.19.127: Plaid sets `check_number` on some lines that are not checks — on "MERCHANT ACCOUNT MERCH DEP 260916
  // 934600000141895 …" it reports 141895, the tail of the merchant ID. A check number is real only when the digits are a
  // token of their own in the wording (not the end of a longer number) and the line is money out or says check / chk.
  function realCheckNo(raw, t) {
    const cn = String(raw && raw.check_number || '').trim(); if (!cn) return null;
    const text = [t.name, t.merchant, raw.original_description].filter(Boolean).join(' ');
    const longer = (text.match(/\d{5,}/g) || []).some(d => d !== cn && d.endsWith(cn));
    if (longer && !new RegExp('(^|[^0-9])' + cn + '([^0-9]|$)').test(text)) return null;
    const saysCheck = /\b(check|chk|cheque)\b/i.test(text);
    if (Number(t.amount) < 0 && !saysCheck) return null;   // a deposit is a check only when it says so
    if (/\b(merch dep|merchant account|card settlement|stripe|square|paypal)\b/i.test(text) && !saysCheck) return null;
    return cn;
  }
  // ---------------------------------------------------------------- 1.19.119: overseas team (Wise payouts)
  // Wise batch payouts reach the bank as "Wise Ltd Sep 15-30 261006 XXXXX9740 AxiomPrint Inc." — no recipient name. A person is
  // recognised by the reference code (`wise_ref`, when Wise keeps it stable per recipient) or by their exact pay; two people on
  // the same pay are left for a human (the feed shows the team picker).
  const isWise = (text) => /\bwise\b/i.test(String(text || ''));
  const DEPTS = { design: 'Graphic design', web: 'Web development', csr: 'Customer service', other: 'Other' };
  const COUNTRIES = { AM: 'Armenia', MX: 'Mexico', PH: 'Philippines' };
  async function teamMembers() { return dbAll('SELECT * FROM bk_team ORDER BY status, name COLLATE NOCASE'); }
  const teamActiveOn = (m, date) => m.status === 'active' && (!m.start_date || !date || m.start_date <= date) && (!m.end_date || !date || m.end_date >= date);
  // → { member } | { ambiguous: [members] } | null — for a money-out Wise line only
  function teamMatch(members, t) {
    if (!(Number(t.amount) > 0) || !isWise((t.merchant || '') + ' ' + (t.name || ''))) return null;
    const amt = Math.abs(Number(t.amount)), live = members.filter(m => teamActiveOn(m, t.date));
    const wording = String(t.name || '') + ' ' + String(t.merchant || '');
    const byRef = live.filter(m => m.wise_ref && String(m.wise_ref).trim() && wording.indexOf(String(m.wise_ref).trim()) > -1);
    if (byRef.length === 1) return { member: byRef[0], how: 'ref' };
    const byPay = live.filter(m => m.pay != null && Math.abs(Number(m.pay) - amt) < 0.005);
    if (byPay.length === 1) return { member: byPay[0], how: 'pay' };
    if (byPay.length > 1) return { ambiguous: byPay };
    return null;
  }
  async function linkTeam(t, m, who, how) {
    await dbRun("UPDATE bk_transactions SET team_id = ?, vendor_id = COALESCE(?, vendor_id), vendor_by = CASE WHEN ? IS NULL THEN vendor_by ELSE 'team' END, vendor_score = 1, suggest_vendor_id = NULL, suggest_score = NULL, category = COALESCE(?, category), category_source = CASE WHEN ? IS NULL THEN category_source ELSE 'team' END, status = CASE WHEN ? IS NULL THEN status ELSE 'categorized' END, updated_at = datetime('now') WHERE id = ?",
      [m.id, m.vendor_id, m.vendor_id, m.category, m.category, m.category, t.id]);
    if (m.category) await dbRun("UPDATE bk_proposals SET status = 'edited' WHERE ref_table = 'bk_transactions' AND ref_id = ? AND status = 'pending'", [t.id]);
    await audit(who || 'nova', 'txn.team', t.id, { team_id: m.id, how: how || 'auto', category: m.category });
  }
  // sweep every open Wise line (no team member yet) — run with the rules sweep, so new payouts file themselves
  async function applyTeam() {
    const members = await teamMembers(); if (!members.length) return 0;
    let n = 0;
    for (const t of await dbAll("SELECT * FROM bk_transactions WHERE status IN ('new', 'pending') AND team_id IS NULL AND amount > 0 AND (name LIKE '%wise%' OR merchant LIKE '%wise%') ORDER BY date DESC LIMIT 400")) {
      const hit = teamMatch(members, t); if (!hit || !hit.member) continue;
      await linkTeam(t, hit.member, 'nova', hit.how); n++;
    }
    return n;
  }
  async function applyRules(rules) {
    rules = rules || await dbAll('SELECT * FROM bk_rules WHERE active = 1 ORDER BY kind DESC, id');
    let n = 0;
    if (!rules.length) { try { n += await applyTeam(); } catch (e) { errlog('team sweep', e.message); } return n; }
    for (const t of await dbAll("SELECT t.*, v.name AS vendor_name FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id WHERE t.status IN ('new', 'pending') AND (t.category IS NULL OR t.category = '') ORDER BY t.date DESC LIMIT 800")) {
      const r = ruleMatch(rules, t); if (!r) continue;
      await dbRun("UPDATE bk_transactions SET category = ?, category_source = 'rule', rule_id = ?, status = 'categorized', updated_at = datetime('now') WHERE id = ?", [r.category, r.id, t.id]);
      await dbRun("UPDATE bk_proposals SET status = 'edited' WHERE ref_table = 'bk_transactions' AND ref_id = ? AND status = 'pending'", [t.id]);
      await dbRun('UPDATE bk_rules SET hits = hits + 1 WHERE id = ?', [r.id]); n++;
    }
    try { n += await applyTeam(); } catch (e) { errlog('team sweep', e.message); }   // 1.19.119
    return n;
  }
  let rulesSweptAt = 0;
  async function categorize(who) {
    const s = await settings();
    const rules = await dbAll('SELECT * FROM bk_rules WHERE active = 1 ORDER BY kind DESC, id');
    const txns = await dbAll("SELECT * FROM bk_transactions WHERE status = 'new' ORDER BY date DESC LIMIT 80");   // 1.19.51: lines still pending at the bank get a suggestion too
    let byRule = await applyRules(rules), proposed = 0, asked = 0;
    const open = [];
    for (const t of txns) {
      const dv = t.vendor_id ? ((await directory()).find(v => v.id === t.vendor_id) || null) : await matchVendor(t.merchant || t.name);
      if (dv && !t.vendor_id) { await dbRun('UPDATE bk_transactions SET vendor_id = ? WHERE id = ?', [dv.id, t.id]); t.vendor_id = dv.id; }
      if (dv) t._vendor = dv;
      const r = ruleMatch(rules, t);
      if (r) {
        await dbRun("UPDATE bk_transactions SET category = ?, category_source = 'rule', rule_id = ?, status = 'categorized', updated_at = datetime('now') WHERE id = ?", [r.category, r.id, t.id]);
        await dbRun('UPDATE bk_rules SET hits = hits + 1 WHERE id = ?', [r.id]);
        byRule++;
      } else open.push(t);
    }
    for (let i = 0; i < open.length; i += 40) {
      const batch = open.slice(i, i + 40);
      const listing = batch.map(t => t.id + ' | ' + t.date + ' | ' + (t.amount >= 0 ? '-' : '+') + '$' + Math.abs(t.amount).toFixed(2) + ' | ' + t.name + (t.merchant ? ' (' + t.merchant + ')' : '') +
        (t._vendor ? ' | OUR VENDOR: ' + t._vendor.name + (t._vendor.specialty ? ' — ' + t._vendor.specialty : '') + (t._vendor.default_category ? ' → usually ' + t._vendor.default_category : '') : '') +
        (t.plaid_category ? ' | bank says: ' + t.plaid_category : '') + (t.account_name ? ' | ' + t.account_name : '')).join('\n');
      const incomeCats = chartOf(s).filter(c => c.income && (c.parent || !c.children)).map(c => c.name);
      const prior = (await dbAll("SELECT merchant, name, category FROM bk_transactions WHERE status = 'categorized' ORDER BY updated_at DESC LIMIT 60"))
        .map(x => (x.merchant || x.name) + ' → ' + x.category).filter((v, k, a) => a.indexOf(v) === k).slice(0, 40).join('\n');
      // What the owner answered when asked before — the words matter ("Uber rides are personal", "SparkFun is parts for the cutter").
      const lessons = (await dbAll("SELECT q.question, q.answer, p.title FROM bk_questions q JOIN bk_proposals p ON p.id = q.proposal_id WHERE q.answer IS NOT NULL AND q.answer <> '' AND q.answer NOT LIKE '→ %' ORDER BY q.answered_at DESC LIMIT 30"))
        .map(x => '- ' + x.title.replace(/ → .*$/, '') + ': asked "' + x.question + '" — answer: ' + x.answer).join('\n');
      let j = null;
      try {
        const r = await anthropic.messages.create({ model: MODEL, max_tokens: 2500, system: SYS(s) + '\n' + await dirLine(), messages: [{ role: 'user', content:
          'Bank transactions (amount: - means money out, + means money in). Propose a category for each from the chart of accounts.' +
          (incomeCats.length ? ' Money IN (+) always gets one of the INCOME categories: ' + incomeCats.join('; ') + ' — never an expense category. Money OUT (-) never gets an income category.' : '') + '\n' + listing +
          (prior ? '\n\nHOW WE CATEGORIZED BEFORE (approved):\n' + prior : '') +
          (lessons ? '\n\nWHAT THE OWNER TOLD US WHEN WE ASKED (apply these to similar transactions instead of asking again):\n' + lessons : '') +
          '\n\nReturn ONLY JSON: {"items": [{"id": <id>, "category": "", "vendor": "<clean vendor name>", "confidence": 0.0, "reason": "<one short line>", "ask": "<a question for the owner ONLY if you cannot tell, else empty>"}]}' }] });
        j = jsonOf((r.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
      } catch (e) { errlog('categorize', e.message); }
      for (const t of batch) {
        const it = j && Array.isArray(j.items) ? j.items.find(x => Number(x.id) === t.id) : null;
        const cats = categoriesOf(s);
        let category = it && cats.indexOf(String(it.category)) > -1 ? String(it.category) : (it && it.category ? String(it.category).slice(0, 80) : 'Uncategorized');
        if (incomeCats.length && it && ((t.amount < 0) !== (incomeCats.indexOf(category) > -1))) { category = 'Uncategorized'; it.confidence = 0; it.ask = it.ask || ('Money ' + (t.amount < 0 ? 'in' : 'out') + ' from ' + (t.merchant || t.name) + ' — which ' + (t.amount < 0 ? 'income' : 'expense') + ' category?'); }   // 1.19.59: income and expense never cross
        const conf = it ? Math.max(0, Math.min(1, Number(it.confidence) || 0)) : 0;
        const title = (t.amount >= 0 ? '-' : '+') + '$' + Math.abs(t.amount).toFixed(2) + ' ' + (t.merchant || t.name) + ' on ' + t.date + ' → ' + category;
        const p = await dbRun('INSERT INTO bk_proposals (type, ref_table, ref_id, title, payload, confidence, reason) VALUES (?,?,?,?,?,?,?)',
          ['category', 'bk_transactions', t.id, title, JSON.stringify({ category, vendor: it && it.vendor ? String(it.vendor).slice(0, 120) : (t.merchant || t.name), amount: t.amount, date: t.date, name: t.name }), conf, it ? String(it.reason || '').slice(0, 300) : 'The AI could not categorize this.']);
        await dbRun("UPDATE bk_transactions SET proposal_id = ?, status = 'pending', updated_at = datetime('now') WHERE id = ?", [p.lastID, t.id]);
        proposed++;
        if (conf < s.threshold || (it && it.ask)) {
          await dbRun('INSERT INTO bk_questions (proposal_id, question) VALUES (?,?)', [p.lastID, (it && it.ask) || ('What is this ' + (t.amount >= 0 ? 'payment to ' : 'deposit from ') + (t.merchant || t.name) + ' for? I guessed "' + category + '".')]);
          asked++;
        }
      }
    }
    await audit(who, 'categorize', null, { by_rule: byRule, proposed, asked });
    return { by_rule: byRule, proposed, asked };
  }

  // 1.19.71: lines synced before we asked for the bank's own memo line get it now — /transactions/get with
  // include_original_description over the last 180 days, merged into `raw` by transaction id. Once per boot, in the background.
  let descBackfilled = false;
  function backfillOriginalDesc() {
    if (descBackfilled || !plaidReady()) return; descBackfilled = true;
    (async () => {
      const rows = await dbAll("SELECT id, item_id, access_token, env FROM bk_accounts WHERE status = 'ok' AND (env IS NULL OR env = ?)", [PLAID_ENV]);
      const end = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
      for (const r of rows) {
        const missing = (await dbGet("SELECT COUNT(*) n FROM bk_transactions WHERE item_id = ? AND status NOT IN ('removed') AND (raw IS NULL OR raw NOT LIKE '%original_description%')", [r.item_id])).n;
        if (!missing) continue;
        let offset = 0, total = 1, updated = 0;
        while (offset < total && offset < 5000) {
          const j = await plaid('/transactions/get', { access_token: dec(r.access_token), start_date: start, end_date: end, options: { count: 500, offset, include_original_description: true } });
          total = j.total_transactions || 0;
          for (const t of (j.transactions || [])) {
            if (!t.original_description) continue;
            const cur = await dbGet('SELECT id, raw FROM bk_transactions WHERE txn_id = ?', [t.transaction_id]); if (!cur) continue;
            let raw = {}; try { raw = JSON.parse(cur.raw || '{}'); } catch (e) {}
            if (raw.original_description) continue;
            raw.original_description = t.original_description;
            await dbRun('UPDATE bk_transactions SET raw = ? WHERE id = ?', [JSON.stringify(raw).slice(0, 20000), cur.id]); updated++;
          }
          offset += (j.transactions || []).length || 500;
        }
        if (updated) await audit('system', 'plaid.backfill_desc', r.item_id, { updated });
      }
    })().catch(e => errlog('backfill original_description', e.message));
  }

  // 1.19.51: the AI rates every new bank line in the background (80 a call) so the Bank feed can show its suggestion
  // under the Category picker. Triggered by the list; never two at once; at most `rounds` batches per trigger.
  let catBusy = false;
  function categorizeBacklog(who, rounds) {
    if (catBusy) return;
    catBusy = true;
    (async () => {
      for (let i = 0; i < (rounds || 6); i++) {
        const left = (await dbGet("SELECT COUNT(*) n FROM bk_transactions WHERE status = 'new'")).n;
        if (!left) break;
        const r = await categorize(who);
        if (!r.by_rule && !r.proposed) break;
      }
    })().catch(e => errlog('categorize backlog', e.message)).finally(() => { catBusy = false; });
  }

  // ---------------------------------------------------------------- the executor (approvals)
  async function proposalView(p) {
    let payload = {}; try { payload = JSON.parse(p.payload || '{}'); } catch (e) {}
    const q = await dbGet('SELECT * FROM bk_questions WHERE proposal_id = ? ORDER BY id DESC LIMIT 1', [p.id]);
    return Object.assign({}, p, { payload, question: q || null });
  }
  async function pending() {
    const rows = await dbAll("SELECT * FROM bk_proposals WHERE status = 'pending' ORDER BY type, id");
    const out = [];
    for (const p of rows) out.push(await proposalView(p));
    return out;
  }
  // Approve: category → the transaction is categorized (and a vendor rule is saved when asked); bill → the draft becomes
  // an approved bill (and the vendor is approved when asked). Nothing is pushed to QuickBooks or BILL yet (later phases).
  async function decide(id, action, who, opts) {
    opts = opts || {};
    const p = await dbGet('SELECT * FROM bk_proposals WHERE id = ?', [id]);
    if (!p) return { ok: false, error: 'No proposal #' + id };
    if (p.status !== 'pending') return { ok: false, error: 'Proposal #' + id + ' is already ' + p.status + '.' };
    let payload = {}; try { payload = JSON.parse(p.payload || '{}'); } catch (e) {}
    const now = nowIso();
    if (action === 'reject') {
      await dbRun('UPDATE bk_proposals SET status = ?, decided_by = ?, decided_at = ?, decision = ? WHERE id = ?', ['rejected', who, now, String(opts.note || '').slice(0, 500), id]);
      if (p.type === 'category') await dbRun("UPDATE bk_transactions SET status = 'new', proposal_id = NULL, updated_at = datetime('now') WHERE id = ?", [p.ref_id]);
      if (p.type === 'bill') await dbRun("UPDATE bk_bills SET status = 'rejected', updated_at = datetime('now') WHERE id = ?", [p.ref_id]);
      await audit(who, 'proposal.reject', id, { type: p.type, note: opts.note });
      return { ok: true, status: 'rejected' };
    }
    if (p.type === 'category') {
      const s = await settings();
      const category = String(opts.category || payload.category || '').trim();
      if (!category) return { ok: false, error: 'No category.' };
      const edited = category !== payload.category;
      await dbRun("UPDATE bk_transactions SET category = ?, category_source = 'approved', status = 'categorized', updated_at = datetime('now') WHERE id = ?", [category, p.ref_id]);
      let rule = null;
      if (opts.remember !== false) {
        const vendor = String(opts.vendor || payload.vendor || '').trim();
        if (vendor && !(await dbGet("SELECT id FROM bk_rules WHERE kind IN ('vendor', 'none') AND LOWER(pattern) = LOWER(?) AND active = 1", [vendor]))) {   // 1.19.112: a "No rule" vendor stays without one
          const r = await dbRun('INSERT INTO bk_rules (kind, pattern, category, vendor, source, created_by) VALUES (?,?,?,?,?,?)', ['vendor', vendor, category, vendor, 'approval', who]);
          rule = r.lastID;
        }
      }
      await dbRun('UPDATE bk_proposals SET status = ?, decided_by = ?, decided_at = ?, decision = ? WHERE id = ?', [edited ? 'edited' : 'approved', who, now, JSON.stringify({ category, rule }), id]);
      const tx = await dbGet('SELECT vendor_id FROM bk_transactions WHERE id = ?', [p.ref_id]);
      if (tx && tx.vendor_id) { await dbRun('UPDATE bk_vendors SET default_category = ? WHERE id = ? AND (default_category IS NULL OR default_category = ?)', [category, tx.vendor_id, '']); dirCache.at = 0; }
      await audit(who, 'category.apply', p.ref_id, { category, edited, rule });
      if (categoriesOf(s).indexOf(category) === -1) await addCategory(category, opts.parent || '', who);
      return { ok: true, status: edited ? 'edited' : 'approved', category, rule };
    }
    if (p.type === 'bill') {
      await dbRun("UPDATE bk_bills SET status = 'approved', updated_at = datetime('now') WHERE id = ?", [p.ref_id]);
      if (opts.approve_vendor || payload.new_vendor) {
        const b = await dbGet('SELECT vendor_id FROM bk_bills WHERE id = ?', [p.ref_id]);
        if (b && b.vendor_id && opts.approve_vendor !== false) await dbRun('UPDATE bk_vendors SET approved = 1, approved_by = ?, approved_at = ? WHERE id = ?', [who, now, b.vendor_id]);
      }
      await dbRun('UPDATE bk_proposals SET status = ?, decided_by = ?, decided_at = ?, decision = ? WHERE id = ?', ['approved', who, now, String(opts.note || '').slice(0, 500), id]);
      await audit(who, 'bill.approve', p.ref_id, { vendor: payload.vendor, total: payload.total });
      return { ok: true, status: 'approved' };
    }
    return { ok: false, error: 'Unknown proposal type.' };
  }
  async function answerQuestion(qid, answer, who) {
    const q = await dbGet('SELECT * FROM bk_questions WHERE id = ?', [qid]);
    if (!q) return { ok: false, error: 'No question #' + qid };
    await dbRun('UPDATE bk_questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?', [String(answer).slice(0, 1000), who, nowIso(), qid]);
    await audit(who, 'question.answer', qid, answer);
    return { ok: true };
  }

  // ---------------------------------------------------------------- the Daily Brief
  const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  async function composeBrief(day, runSummary) {
    const list = await pending();
    const qs = list.filter(p => p.question && !p.question.answer);
    const cats = list.filter(p => p.type === 'category' && !(p.question && !p.question.answer));
    const bills = list.filter(p => p.type === 'bill' && !(p.question && !p.question.answer));
    let bal = []; try { bal = plaidReady() && (await dbGet('SELECT COUNT(*) AS n FROM bk_accounts')).n ? await balances() : []; } catch (e) { errlog('balances', e.message); }
    const lines = ['*BookkeeperAI — Daily Brief ' + day + '*'];
    if (bal.length) lines.push('Cash: ' + bal.filter(b => !b.error).map(b => b.name + (b.mask ? ' ••' + b.mask : '') + ' ' + usd(b.available != null ? b.available : b.current)).join(' · '));
    if (runSummary) lines.push('Overnight: ' + runSummary);
    lines.push('');
    lines.push('*Questions (' + qs.length + ')*' + (qs.length ? '' : ' — none'));
    qs.slice(0, 15).forEach(p => lines.push('• Q' + p.question.id + ' · ' + p.question.question + '  _(' + p.title + ')_'));
    lines.push('');
    lines.push('*Suggestions (' + (cats.length + bills.length) + ')*' + (cats.length + bills.length ? '' : ' — none'));
    cats.slice(0, 25).forEach(p => lines.push('• #' + p.id + ' ' + p.title + ' (' + Math.round(p.confidence * 100) + '%)'));
    bills.slice(0, 15).forEach(p => lines.push('• #' + p.id + ' ' + p.title + ' (' + Math.round(p.confidence * 100) + '%)'));
    const extra = (cats.length - 25) + (bills.length - 15);
    if (cats.length > 25 || bills.length > 15) lines.push('• …and more in Nova');
    lines.push('');
    lines.push('*Payments* — not connected yet (BILL comes in a later phase).');
    lines.push('');
    lines.push('Reply here: "approve all", "approve #12 #14", "reject #15", "#12 is Paper", "Q3: that was the new cutter", or open ' + NOVA_URL + '/bookkeeping');
    const text = lines.join('\n');
    const stats = { questions: qs.length, categories: cats.length, bills: bills.length };
    await dbRun('INSERT INTO bk_briefs (day, text, stats) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET text = excluded.text, stats = excluded.stats', [day, text, JSON.stringify(stats)]);
    return { text, stats };
  }
  const laDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  // 1.19.108/1.19.111: the Today / Pending cut-off as the UTC 'YYYY-MM-DD HH:MM:SS' SQLite's created_at uses:
  // midnight of today in Los Angeles. Today = synced today; at midnight the rest become Pending. No other cut-off.
  function newCutoff(now) {
    now = now || new Date();
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const la = (d) => { const o = {}; f.formatToParts(d).forEach(x => { o[x.type] = x.value; }); return o; };
    const n = la(now);
    const y = Number(n.year), m = Number(n.month), d = Number(n.day);
    let guess = Date.UTC(y, m - 1, d, 0);   // midnight as if LA were UTC, then shift by LA's offset at that moment
    for (let i = 0; i < 2; i++) { const g = la(new Date(guess)); const wall = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour), Number(g.minute), Number(g.second)); guess += Date.UTC(y, m - 1, d, 0) - wall; }
    return new Date(guess).toISOString().slice(0, 19).replace('T', ' ');
  }

  // ---------------------------------------------------------------- Google Chat
  let chatClient = null;
  function chatApi() {
    if (chatClient) return chatClient;
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const a = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/chat.bot'] });
    chatClient = google.chat({ version: 'v1', auth: a });
    return chatClient;
  }
  // Post to the space: the Chat app when a space is known (someone has messaged it), else the incoming webhook URL.
  async function postChat(text, thread) {
    const s = await settings();
    if (s.chat_space) {
      const r = await chatApi().spaces.messages.create({ parent: s.chat_space, requestBody: Object.assign({ text: text }, thread ? { thread: { name: thread } } : {}),
        messageReplyOption: thread ? 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : undefined });
      await dbRun('INSERT INTO bk_chat (channel, space, thread, sender, direction, text) VALUES (?,?,?,?,?,?)', ['chat-app', s.chat_space, thread || null, 'BookkeeperAI', 'out', text]);
      return { via: 'chat-app', name: r.data && r.data.name };
    }
    if (s.chat_webhook) {
      const r = await fetch(s.chat_webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Google Chat webhook ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
      await dbRun('INSERT INTO bk_chat (channel, sender, direction, text) VALUES (?,?,?,?)', ['webhook', 'BookkeeperAI', 'out', text]);
      return { via: 'webhook' };
    }
    throw new Error('Google Chat is not connected: add the Chat app to a space and message it, or paste a space webhook URL in Connections.');
  }
  // Google signs Chat app events with a JWT from chat@system.gserviceaccount.com for the audience = the project number.
  let googleCerts = { at: 0, certs: {} };
  async function verifyChatEvent(req) {
    const aud = env('BOOKKEEPER_CHAT_AUDIENCE');
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!aud || !tok) return env('BOOKKEEPER_CHAT_INSECURE') === '1';
    try {
      if (Date.now() - googleCerts.at > 60 * 60 * 1000) {
        const r = await fetch('https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com', { signal: AbortSignal.timeout(10000) });
        googleCerts = { at: Date.now(), certs: await r.json() };
      }
      const header = JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString('utf8'));
      const cert = googleCerts.certs[header.kid];
      if (!cert) return false;
      const claims = deps.jwt.verify(tok, cert, { algorithms: ['RS256'], audience: aud, issuer: 'chat@system.gserviceaccount.com' });
      return !!claims;
    } catch (e) { errlog('chat event verify', e.message); return false; }
  }

  // ---------------------------------------------------------------- the conversation (Google Chat and the Nova tab)
  const CHAT_TOOLS = [
    { name: 'list_pending', description: 'The pending proposals and open questions (what the Daily Brief lists).', input_schema: { type: 'object', properties: {} } },
    { name: 'approve', description: 'Approve proposals by id (a category is applied to its transaction and a vendor rule is saved; a bill draft becomes an approved bill).',
      input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, all: { type: 'boolean', description: 'Every pending proposal that has no open question.' }, category: { type: 'string', description: 'For ONE category proposal: the category the person said instead.' } }, required: [] } },
    { name: 'reject', description: 'Reject proposals by id.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, note: { type: 'string' } }, required: ['ids'] } },
    { name: 'answer_question', description: 'Record the person\u2019s answer to an open question (Q<id>). When the answer names a category, also approve its proposal with that category.',
      input_schema: { type: 'object', properties: { question_id: { type: 'integer' }, answer: { type: 'string' }, category: { type: 'string', description: 'The category their answer amounts to, from the chart of accounts, if any.' } }, required: ['question_id', 'answer'] } },
    { name: 'add_rule', description: 'Save a categorization rule: this vendor (or any transaction containing this keyword) is always this category.',
      input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['vendor', 'keyword'] }, pattern: { type: 'string' }, category: { type: 'string' } }, required: ['kind', 'pattern', 'category'] } },
    { name: 'run_now', description: 'Sync the banks, scan the inbox and categorize now, then rebuild the brief.', input_schema: { type: 'object', properties: {} } },
    { name: 'balances', description: 'Current bank balances.', input_schema: { type: 'object', properties: {} } },
    { name: 'add_category', description: 'Add a category to the chart of accounts: a sub category under a type of expense (the type is created if new).',
      input_schema: { type: 'object', properties: { name: { type: 'string', description: 'The sub category' }, parent: { type: 'string', description: 'The type of expense it belongs to' } }, required: ['name'] } },
    { name: 'find_vendor', description: 'Look up a company in the vendor directory (CRM suppliers / vendors and Nova vendors): its kind, usual category, what we buy from them, and how many bank lines / bills are linked. Read-only.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    { name: 'set_vendor_category', description: 'Set a company\'s usual category (from the chart of accounts) so its bank lines get that suggestion. Creates it as a Nova vendor if it is not in the directory yet.',
      input_schema: { type: 'object', properties: { name: { type: 'string' }, category: { type: 'string', description: 'A sub category name exactly as in the chart' }, what_we_buy: { type: 'string', description: 'One line on what we buy from them (new Nova vendors)' } }, required: ['name', 'category'] } },
    { name: 'materials', description: 'Look up the CRM materials catalog (GEO types): what a supplier supplies, or which materials / suppliers match a name or GEO type. Read-only.',
      input_schema: { type: 'object', properties: { supplier: { type: 'string', description: 'Supplier / vendor name' }, query: { type: 'string', description: 'Material name, GEO type, sub type, material kind or manufacturer' } }, required: [] } }
  ];
  async function runChatTool(name, input, who) {
    input = input || {};
    if (name === 'list_pending') {
      const list = await pending();
      return { pending: list.map(p => ({ id: p.id, type: p.type, title: p.title, confidence: p.confidence, reason: p.reason, question: p.question && !p.question.answer ? { id: p.question.id, text: p.question.question } : null })) };
    }
    if (name === 'approve') {
      let ids = (input.ids || []).map(Number).filter(Boolean);
      if (input.all) ids = (await pending()).filter(p => !(p.question && !p.question.answer)).map(p => p.id);
      const out = [];
      for (const id of ids) out.push(Object.assign({ id }, await decide(id, 'approve', who, ids.length === 1 && input.category ? { category: input.category } : {})));
      return { results: out };
    }
    if (name === 'reject') { const out = []; for (const id of (input.ids || [])) out.push(Object.assign({ id }, await decide(Number(id), 'reject', who, { note: input.note }))); return { results: out }; }
    if (name === 'answer_question') {
      const r = await answerQuestion(Number(input.question_id), input.answer, who);
      if (!r.ok) return r;
      const q = await dbGet('SELECT proposal_id FROM bk_questions WHERE id = ?', [Number(input.question_id)]);
      if (input.category && q) return Object.assign(r, { approved: await decide(q.proposal_id, 'approve', who, { category: input.category }) });
      return r;
    }
    if (name === 'add_rule') {
      if (await dbGet("SELECT id FROM bk_rules WHERE kind = 'none' AND LOWER(pattern) = LOWER(?) AND active = 1", [String(input.pattern || '')])) return { ok: false, error: '"No rule" is set for ' + input.pattern + ' — the team decided never to file it by rule.' };   // 1.19.112
      const r = await dbRun('INSERT INTO bk_rules (kind, pattern, category, vendor, source, created_by) VALUES (?,?,?,?,?,?)', [input.kind === 'keyword' ? 'keyword' : 'vendor', String(input.pattern).slice(0, 120), String(input.category).slice(0, 80), input.kind === 'vendor' ? String(input.pattern).slice(0, 120) : null, 'chat', who]);
      await audit(who, 'rule.add', r.lastID, input);
      return { ok: true, rule_id: r.lastID };
    }
    if (name === 'run_now') return await runDaily('manual', who, { post: false });
    if (name === 'balances') return { balances: await balances() };
    if (name === 'add_category') {
      const nm = String(input.name || '').trim().slice(0, 80), parent = String(input.parent || '').trim().slice(0, 80);
      if (!nm) return { error: 'A name is needed' };
      await addCategory(nm, parent, who); await audit(who, 'category.add', null, { name: nm, parent, via: 'chat' });
      return { ok: true, chart: chartText(await settings()) };
    }
    if (name === 'find_vendor') {
      const n = normName(input.name); const list = await directory();
      const hits = list.filter(v => normName(v.name).indexOf(n) > -1 || (v.aliases && normName(v.aliases).indexOf(n) > -1)).slice(0, 5);
      const out = [];
      for (const v of hits) { const c = await dbGet("SELECT COUNT(*) n FROM bk_transactions WHERE vendor_id = ? AND status NOT IN ('removed','excluded')", [v.id]); const b = await dbGet("SELECT COUNT(*) n FROM bk_bills WHERE vendor_id = ?", [v.id]);
        out.push({ id: v.id, name: v.name, kind: kindOf(v.source), usual_category: v.default_category || null, what_we_buy: v.specialty || null, bank_lines: c.n, bills: b.n }); }
      return { vendors: out, note: out.length ? undefined : 'Not in the directory — set_vendor_category can add it as a Nova vendor.' };
    }
    if (name === 'set_vendor_category') {
      const s2 = await settings(), cats = categoriesOf(s2), cat = String(input.category || '').trim();
      if (cats.indexOf(cat) < 0) return { error: 'Not a sub category in the chart: ' + cat, chart: chartText(s2) };
      const n = normName(input.name); const list = await directory();
      let v = list.find(x => normName(x.name) === n) || list.find(x => normName(x.name).indexOf(n) > -1);
      if (!v) {
        const r = await dbRun('INSERT INTO bk_vendors (name, source, kind, approved, approved_by, approved_at, default_category, specialty, details) VALUES (?,?,?,?,?,?,?,?,?)', [String(input.name).trim().slice(0, 120), 'nova', 'nova', 1, who, nowIso(), cat, String(input.what_we_buy || '').slice(0, 500) || null, '{}']);
        dirCache.at = 0; await audit(who, 'vendor.new', r.lastID, { name: input.name, by: 'chat' });
        return { created: true, vendor: input.name, usual_category: cat };
      }
      await dbRun('UPDATE bk_vendors SET default_category = ? WHERE id = ?', [cat, v.id]); dirCache.at = 0;
      await audit(who, 'vendor.update', v.id, { default_category: cat, by: 'chat' });
      return { updated: true, vendor: v.name, usual_category: cat };
    }
    if (name === 'materials') {
      const q = String(input.query || '').trim().toLowerCase(), supN = String(input.supplier || '').trim();
      let where = [], args = [];
      if (supN) { const v = supplierFor(supN, (await directory()).map(x => Object.assign({}, x, { _m: matNorm(x.name), _al: x._al || [] }))); if (v) { where.push('m.vendor_id = ?'); args.push(v.id); } else { where.push('LOWER(m.supplier_text) LIKE ?'); args.push('%' + supN.toLowerCase() + '%'); } }
      if (q) { where.push('(LOWER(m.name) LIKE ? OR LOWER(m.geo_type) LIKE ? OR LOWER(m.geo_sub_type) LIKE ? OR LOWER(m.material) LIKE ? OR LOWER(m.manufacturer) LIKE ?)'); for (let i = 0; i < 5; i++) args.push('%' + q + '%'); }
      const rows = await dbAll('SELECT m.name, m.geo_type, m.geo_sub_type, m.material, m.type, m.step, m.teams, m.supplier_text, m.manufacturer, m.cost, m.code, v.name AS supplier FROM bk_materials m LEFT JOIN bk_vendors v ON v.id = m.vendor_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY m.geo_type, m.name LIMIT 60', args);
      const total = await dbGet('SELECT COUNT(*) n FROM bk_materials');
      return { catalog_size: total ? total.n : 0, matches: rows.length, materials: rows.map(r => ({ name: r.name, geo_type: r.geo_type, sub_type: r.geo_sub_type, material: r.material, form: r.type, production_step: r.step, team: r.teams, supplier: r.supplier || r.supplier_text, manufacturer: r.manufacturer, cost: r.cost, code: r.code })) };
    }
    return { error: 'Unknown tool' };
  }
  async function chatHistory(channel, n) {
    return (await dbAll('SELECT sender, direction, text, at FROM bk_chat WHERE channel = ? ORDER BY id DESC LIMIT ?', [channel, n || 12])).reverse();
  }
  // One message from a person → BookkeeperAI's answer (Claude with the narrow tools). `who` is the person's email.
  async function converse(channel, who, text, meta) {
    const s = await settings();
    const may = CHAT_USERS.indexOf(String(who).toLowerCase()) > -1 || USERS.indexOf(String(who).toLowerCase()) > -1;
    await dbRun('INSERT INTO bk_chat (channel, space, thread, sender, sender_email, direction, text) VALUES (?,?,?,?,?,?,?)', [channel, meta && meta.space || null, meta && meta.thread || null, meta && meta.name || who, who, 'in', String(text).slice(0, 4000)]);
    if (!may) return 'Sorry — only ' + CHAT_USERS.join(' and ') + ' can work with me here.';
    const brief = await dbGet('SELECT text FROM bk_briefs ORDER BY day DESC LIMIT 1');
    const hist = await chatHistory(channel, 12);
    const messages = [];
    hist.slice(0, -1).forEach(m => messages.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: (m.direction === 'in' ? m.sender + ': ' : '') + m.text }));
    messages.push({ role: 'user', content: (meta && meta.name ? meta.name + ': ' : '') + text });
    // Two people share the thread; turns must alternate for the API.
    const merged = [];
    messages.forEach(m => { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += '\n' + m.content; else merged.push(Object.assign({}, m)); });
    if (merged[0] && merged[0].role !== 'user') merged.shift();
    const system = SYS(s) + '\n' + await dirLine() + '\nYou are talking with ' + (meta && meta.name || who) + ' in ' + (channel === 'nova' ? 'the Nova Bookkeeping tab' : 'Google Chat') + '. Short, plain answers (no markdown headings; a short list is fine). Use the materials tool for questions about what we buy, from whom, or GEO types. ' +
      'When asked where a company or a purchase belongs ("where do I put Figma?"), answer with ONE sub category exactly as written in the chart of accounts and one line why, name the runner-up only if it is a real contender, and offer to set it as the company\'s usual category (set_vendor_category) so its bank lines file themselves. Rule of thumb: categories say WHAT was bought, never WHO was paid; marketing tools (Mailchimp, Canva) are marketing, not software; a refund is not income. ' +
      'Use the tools for anything that changes state; never claim you approved or saved something without calling the tool. Proposal ids are "#12"; questions are "Q3". ' +
      'When they answer a question, record it with answer_question (with the category when it is one). "Approve all" = approve with all: true. Money never moves through you: payments are approved in BILL by a person.\n' +
      (brief ? 'TODAY\u2019S BRIEF:\n' + brief.text.slice(0, 6000) : 'No brief yet today.');
    let reply = '', used = [];
    for (let i = 0; i < 6; i++) {
      const r = await anthropic.messages.create({ model: MODEL, max_tokens: 900, system: system, tools: CHAT_TOOLS, messages: merged });
      const uses = (r.content || []).filter(b => b.type === 'tool_use');
      const said = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!uses.length) { reply = said; break; }
      merged.push({ role: 'assistant', content: r.content });
      const results = [];
      for (const tu of uses) {
        let out; try { out = await runChatTool(tu.name, tu.input, who); } catch (e) { out = { error: e.message }; }
        used.push({ tool: tu.name, input: tu.input });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      merged.push({ role: 'user', content: results });
      reply = said;
    }
    reply = reply || 'Done.';
    await dbRun('INSERT INTO bk_chat (channel, space, thread, sender, direction, text, tools) VALUES (?,?,?,?,?,?,?)', [channel, meta && meta.space || null, meta && meta.thread || null, 'BookkeeperAI', 'out', reply, used.length ? JSON.stringify(used) : null]);
    return reply;
  }

  // ---------------------------------------------------------------- the daily run and the clock
  let running = null;
  async function runDaily(kind, who, opts) {
    if (running) return { ok: false, error: 'A run is already going.' };
    opts = opts || {};
    const run = await dbRun('INSERT INTO bk_runs (kind, started_by) VALUES (?,?)', [kind, who || 'clock']);
    running = run.lastID;
    const parts = [], summary = {};
    try {
      try { summary.directory = await syncDirectory(who); } catch (e) { parts.push('vendor directory: ' + e.message); }
      if (plaidReady()) { try { summary.plaid = await syncAll(who); parts.push(summary.plaid.added + ' new transaction' + (summary.plaid.added === 1 ? '' : 's') + (summary.plaid.errors.length ? ' (' + summary.plaid.errors.join('; ') + ')' : '')); } catch (e) { parts.push('bank sync failed: ' + e.message); } }
      else parts.push('banks not connected');
      try { summary.gmail = await scanInbox(who); parts.push(summary.gmail.new + ' new email' + (summary.gmail.new === 1 ? '' : 's')); } catch (e) { parts.push('inbox scan failed: ' + e.message); errlog('scan', e.message); }
      try { summary.bills = await parseNewEmails(who); parts.push(summary.bills.bills + ' bill draft' + (summary.bills.bills === 1 ? '' : 's') + (summary.bills.triage && summary.bills.triage.read ? ', ' + summary.bills.triage.read + ' email' + (summary.bills.triage.read === 1 ? '' : 's') + ' set aside' : '') + (summary.bills.triage && summary.bills.triage.messages ? ', ' + summary.bills.triage.messages + ' message' + (summary.bills.triage.messages === 1 ? '' : 's') + ' for a person' : '')); } catch (e) { parts.push('bill parsing failed: ' + e.message); }
      try { summary.cat = await categorize(who); parts.push(summary.cat.by_rule + ' by rule, ' + summary.cat.proposed + ' proposed, ' + summary.cat.asked + ' question' + (summary.cat.asked === 1 ? '' : 's')); } catch (e) { parts.push('categorizing failed: ' + e.message); }
      const brief = await composeBrief(laDay(), parts.join(' · '));
      summary.brief = brief.stats;
      if (opts.post !== false) {
        try { await postChat(brief.text); await dbRun("UPDATE bk_briefs SET posted_at = datetime('now'), post_error = NULL WHERE day = ?", [laDay()]); }
        catch (e) { await dbRun('UPDATE bk_briefs SET post_error = ? WHERE day = ?', [e.message.slice(0, 300), laDay()]); parts.push('not posted to Google Chat: ' + e.message); }
      }
      await dbRun("UPDATE bk_runs SET finished_at = datetime('now'), ok = 1, summary = ? WHERE id = ?", [parts.join(' · '), run.lastID]);
      return { ok: true, summary: parts.join(' · '), detail: summary };
    } catch (e) {
      await dbRun("UPDATE bk_runs SET finished_at = datetime('now'), ok = 0, summary = ? WHERE id = ?", [e.message.slice(0, 500), run.lastID]);
      return { ok: false, error: e.message };
    } finally { running = null; }
  }
  // Every minute: the daily run at run_at (Los Angeles); the inbox poll every poll_min minutes (bills reach the queue
  // during the day, the brief still comes once a day).
  let lastDailyDay = '', lastPoll = 0, lastAlertDay = '';
  async function tick() {
    try {
      const s = await settings();
      const nowLA = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
      const day = laDay();
      if (nowLA === (s.run_at || '07:00') && lastDailyDay !== day) {
        lastDailyDay = day;
        const done = await dbGet('SELECT id FROM bk_runs WHERE kind = ? AND started_at >= ?', ['daily', day + ' 00:00:00']);
        if (!done) runDaily('daily', 'clock').catch(e => errlog('daily', e.message));
        return;
      }
      if (!running) syncDirectoryIfStale('clock', 3600000);
      if (nowLA === (s.alert_at || '08:00') && lastAlertDay !== day) { lastAlertDay = day; alertOverdue('clock').catch(e => errlog('alert', e.message)); }
      if (Date.now() - lastPoll > s.poll_min * 60000 && !running) {
        lastPoll = Date.now();
        try { await scanInbox('poll'); if (await dbGet("SELECT 1 FROM bk_emails WHERE status = 'new' OR " + TO_RATE + " LIMIT 1")) await parseNewEmails('poll'); } catch (e) { errlog('poll', e.message); }
      }
    } catch (e) { errlog('tick', e.message); }
  }
  if (env('BOOKKEEPER_CLOCK') !== '0') setInterval(tick, 60000).unref();

  // ---------------------------------------------------------------- webhooks (no sign-in: verified their own way)
  app.post('/api/bookkeeping/plaid/webhook', require('express').raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    (async () => {
      req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
      try { req.body = JSON.parse(req.rawBody.toString('utf8') || '{}'); } catch (e) { req.body = {}; }
      let ok = false;
      try { ok = await verifyPlaidWebhook(req); } catch (e) { errlog('plaid webhook verify', e.message); }
      if (!ok) { await audit('plaid', 'webhook.rejected', null, req.body && req.body.webhook_code); return res.status(401).json({ ok: false }); }
      const b = req.body || {};
      await audit('plaid', 'webhook', b.item_id, { type: b.webhook_type, code: b.webhook_code });
      if (b.webhook_type === 'TRANSACTIONS' && /SYNC_UPDATES_AVAILABLE|DEFAULT_UPDATE|INITIAL_UPDATE|HISTORICAL_UPDATE/.test(b.webhook_code)) {
        const row = await dbGet('SELECT * FROM bk_accounts WHERE item_id = ?', [b.item_id]);
        if (row) setTimeout(() => syncItem(row, 'webhook').then(() => categorize('webhook')).catch(e => errlog('webhook sync', e.message)), 500).unref();
      }
      if (b.webhook_type === 'ITEM' && b.webhook_code === 'ERROR') await dbRun("UPDATE bk_accounts SET status = 'error', error = ? WHERE item_id = ?", [JSON.stringify(b.error || {}).slice(0, 300), b.item_id]);
      res.json({ ok: true });
    })().catch(e => res.status(500).json({ ok: false, error: e.message }));
  });
  app.post('/api/bookkeeping/gmail/push', (req, res) => {
    const want = env('BOOKKEEPER_PUSH_TOKEN');
    if (!want || String(req.query.token || '') !== want) return res.status(401).json({ ok: false });
    res.json({ ok: true });
    if (!running) setTimeout(() => scanInbox('push').then(r => r.new ? parseNewEmails('push') : null).catch(e => errlog('push', e.message)), 200).unref();
  });
  app.post('/api/bookkeeping/chat/events', (req, res) => {
    (async () => {
      if (!(await verifyChatEvent(req))) return res.status(401).json({ text: 'Unverified' });
      const ev = req.body || {};
      const space = ev.space && ev.space.name;
      if (space) { const s = await settings(); if (s.chat_space !== space) await setSetting('chat_space', space, 'chat'); }
      if (ev.type === 'ADDED_TO_SPACE') return res.json({ text: 'Hi — I\u2019m BookkeeperAI. I\u2019ll post the Daily Brief here every morning; reply to approve, reject or answer my questions.' });
      if (ev.type !== 'MESSAGE') return res.json({});
      const who = String((ev.user && ev.user.email) || '').toLowerCase();
      const name = (ev.user && ev.user.displayName) || who;
      const text = String((ev.message && (ev.message.argumentText || ev.message.text)) || '').trim();
      const thread = ev.message && ev.message.thread && ev.message.thread.name;
      const reply = await converse('google-chat', who, text, { name, space, thread });
      res.json({ text: reply });
    })().catch(e => { errlog('chat event', e.message); res.json({ text: 'Sorry, something went wrong on my side.' }); });
  });

  // ---------------------------------------------------------------- the page and its API
  app.get('/bookkeeping', serveVersionedHtml('bookkeeping.html'));
  app.get('/bookkeeping/plaid-oauth', serveVersionedHtml('bookkeeping.html'));   // Plaid Link's OAuth return (the page re-opens Link to finish)
  app.get('/api/bookkeeping/overview', ...guard, async (req, res) => {
    const s = await settings();
    const items = await plaidItems();
    const brief = await dbGet('SELECT * FROM bk_briefs ORDER BY day DESC LIMIT 1');
    const counts = {
      pending: (await dbGet("SELECT COUNT(*) AS n FROM bk_proposals WHERE status = 'pending'")).n,
      questions: (await dbGet("SELECT COUNT(*) AS n FROM bk_questions WHERE answer IS NULL AND proposal_id IN (SELECT id FROM bk_proposals WHERE status = 'pending')")).n,
      transactions: (await dbGet('SELECT COUNT(*) AS n FROM bk_transactions')).n,
      txn_open: (await dbGet("SELECT COUNT(*) AS n FROM bk_transactions WHERE status IN ('new', 'pending')")).n,
      bills: (await dbGet("SELECT COUNT(*) AS n FROM bk_bills WHERE status <> 'rejected'")).n,
      bill_drafts: (await dbGet("SELECT COUNT(*) AS n FROM bk_bills WHERE status = 'draft'")).n,
      bills_by_status: Object.fromEntries((await dbAll('SELECT status, COUNT(*) n FROM bk_bills GROUP BY status')).map(r => [r.status, r.n])),
      inbox_new: (await dbGet("SELECT COUNT(*) AS n FROM bk_emails WHERE read_by IS NULL AND COALESCE(aside, 0) = 0 AND status <> 'message'")).n,
      inbox_messages: (await dbGet("SELECT COUNT(*) AS n FROM bk_emails WHERE status = 'message'")).n,
      ai_read_today: (await dbGet("SELECT COUNT(*) AS n FROM bk_emails WHERE read_by = 'ai' AND triaged_at >= datetime('now', '-1 day')")).n,
      emails: (await dbGet('SELECT COUNT(*) AS n FROM bk_emails')).n, rules: (await dbGet('SELECT COUNT(*) AS n FROM bk_rules WHERE active = 1')).n
    };
    const lastRun = await dbGet('SELECT * FROM bk_runs ORDER BY id DESC LIMIT 1');
    // who is who, for the page to show a face instead of an email (members: photo from the CRM, else an initial)
    let people = []; try {
      const ms = await dbAll('SELECT email, username, display_name, photo, axiom_user_id FROM members');
      // the CRM holds the team photos (user.memberimage, an S3 key); members.photo is only filled at sign-in
      const ids = ms.map(m => parseInt(m.axiom_user_id)).filter(Boolean); const img = {}, img2 = {};
      if (ids.length) { try { (await runQuery('SELECT id, email, memberimage FROM user WHERE id IN (' + ids.join(',') + ')')).forEach(r => { img[r.id] = r.memberimage || null; }); } catch (e) {} }
      const noId = ms.filter(m => !m.axiom_user_id && m.email).map(m => mysql.escape(String(m.email).toLowerCase()));
      if (noId.length) { try { (await runQuery('SELECT email, memberimage FROM user WHERE LOWER(email) IN (' + noId.join(',') + ')')).forEach(r => { img2[String(r.email).toLowerCase()] = r.memberimage || null; }); } catch (e) {} }
      const url = (ph) => !ph ? null : /^https?:\/\//.test(ph) ? ph : 'https://axiomprint.s3.us-west-1.amazonaws.com/MemberImages/' + String(ph).replace(/^\/+/, '');
      people = ms.map(m => ({ email: m.email, username: m.username, name: m.display_name || m.username || m.email, photo: url(m.photo || img[m.axiom_user_id] || img2[String(m.email || '').toLowerCase()] || null) }));
    } catch (e) {}
    res.json({ ok: true, me: userId(req), people, settings: Object.assign({}, s, { chat_webhook: s.chat_webhook ? '(set)' : '' }), baskets: basketDefs(s), basket_defaults: BASKET_DEFAULTS, chart: chartOf(s), counts, brief, last_run: lastRun, running: !!running,
      connections: {
        plaid: { configured: plaidReady(), env: PLAID_ENV, items, leftovers: items.some(i => i.env && i.env !== PLAID_ENV) || !!(await dbGet("SELECT 1 FROM bk_transactions t WHERE t.status <> 'removed' AND (t.item_id NOT IN (SELECT item_id FROM bk_accounts) OR t.account_name LIKE 'Plaid %')")) || !!(await dbGet("SELECT 1 FROM bk_purchases p WHERE p.txn_ids <> '[]' AND p.bill_id IS NULL AND p.confirm_email_id IS NULL AND NOT EXISTS (SELECT 1 FROM bk_transactions t WHERE p.txn_ids LIKE '%' || t.id || '%') LIMIT 1").catch(() => null)) },
        gmail: { inbox: INBOX, key: fs.existsSync(keyPath), last_scan: (await dbGet("SELECT at FROM bk_audit WHERE action = 'gmail.scan' ORDER BY id DESC LIMIT 1") || {}).at || null,
          push: !!env('BOOKKEEPER_PUSH_TOKEN'), topic: !!env('BOOKKEEPER_PUBSUB_TOPIC'), watch_expires: s.gmail_watch_expires || null, poll_min: s.poll_min },
        chat: { app_audience: !!env('BOOKKEEPER_CHAT_AUDIENCE'), space: s.chat_space || null, webhook: !!s.chat_webhook, events_url: NOVA_URL + '/api/bookkeeping/chat/events',
          plaid_webhook_url: NOVA_URL + '/api/bookkeeping/plaid/webhook', push_url: NOVA_URL + '/api/bookkeeping/gmail/push?token=…' },
        users: USERS, chat_users: CHAT_USERS
      } });
  });
  app.get('/api/bookkeeping/pending', ...guard, async (req, res) => res.json({ ok: true, pending: await pending() }));
  app.post('/api/bookkeeping/proposals/:id/decide', ...guard, async (req, res) => {
    const b = req.body || {};
    res.json(await decide(parseInt(req.params.id), b.action === 'reject' ? 'reject' : 'approve', userId(req), b));
  });
  app.post('/api/bookkeeping/proposals/decide-all', ...guard, async (req, res) => {
    const list = (await pending()).filter(p => !(p.question && !p.question.answer) && (!req.body.type || p.type === req.body.type));
    const out = []; for (const p of list) out.push(Object.assign({ id: p.id }, await decide(p.id, 'approve', userId(req), {})));
    res.json({ ok: true, results: out });
  });
  app.post('/api/bookkeeping/questions/:id/answer', ...guard, async (req, res) => {
    const cat = String(req.body.category || '').trim();
    const text = String(req.body.answer || '').trim();
    if (!text && !cat) return res.json({ ok: false, error: 'Pick a category or write an answer.' });
    const r = await answerQuestion(parseInt(req.params.id), text || ('→ ' + cat), userId(req));
    if (r.ok && cat) { const q = await dbGet('SELECT proposal_id FROM bk_questions WHERE id = ?', [parseInt(req.params.id)]); r.approved = await decide(q.proposal_id, 'approve', userId(req), { category: req.body.category }); }
    res.json(r);
  });
  app.get('/api/bookkeeping/transactions', ...guard, async (req, res) => {
    // Filters: status, q, from/to (dates), category (sub category name), type (type of expense → all its sub categories),
    // vendor_id, source (manual / approved / rule), min / max (absolute amount). Categorized views also get totals.
    const st = String(req.query.status || ''), q = String(req.query.q || '').trim(), g = (k) => String(req.query[k] || '').trim();
    if (Date.now() - rulesSweptAt > 20000) { rulesSweptAt = Date.now(); try { await applyRules(); } catch (e) { errlog('rules sweep', e.message); } }
    const where = ["t.status NOT IN ('removed', 'excluded')"], p = [];
    // 1.19.83: New = not categorized and freshly synced; Pending = not categorized and older (the cut-off is below);
    // Categorized = done (by rule, the AI approved, or by hand). The three never overlap.
    // 1.19.100: 90+ = not categorized and the bank date is older than 90 days (the backlog); Pending stops there
    // 1.19.111: Today = synced today (Los Angeles day); at midnight they move to Pending
    const cut = newCutoff();
    if (st === 'pending') { where.push("t.status IN ('new', 'pending') AND t.created_at < ? AND t.date >= date('now', '-90 days')"); p.push(cut); }
    else if (st === 'old') where.push("t.status IN ('new', 'pending') AND t.date < date('now', '-90 days')");
    else if (st === 'new') { where.push("t.status IN ('new', 'pending') AND t.created_at >= ?"); p.push(cut); }   // 1.19.115: Today = synced today and still open; a categorized line moves to Categorized
    else if (st) { where.push('t.status = ?'); p.push(st); }
    if (q) { where.push('(t.name LIKE ? OR t.merchant LIKE ? OR t.category LIKE ? OR v.name LIKE ?)'); p.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(g('from'))) { where.push('t.date >= ?'); p.push(g('from')); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(g('to'))) { where.push('t.date <= ?'); p.push(g('to')); }
    if (g('category')) { where.push('t.category = ?'); p.push(g('category')); }
    if (g('type')) { const subs = chartOf(await settings()).filter(c => c.parent === g('type')).map(c => c.name); if (subs.length) { where.push('t.category IN (' + subs.map(() => '?').join(',') + ')'); p.push(...subs); } else { where.push('t.category = ?'); p.push(g('type')); } }
    if (g('vendor_id')) { if (g('vendor_id') === 'none') where.push('t.vendor_id IS NULL'); else { where.push('t.vendor_id = ?'); p.push(parseInt(g('vendor_id')) || 0); } }
    if (g('vkind')) { const src = { supplier: 'suppliers', vendor: 'vendors', nova: 'nova', bill: 'bill' }[g('vkind')]; if (g('vkind') === 'none') where.push('t.vendor_id IS NULL'); else if (src) { where.push('v.source = ?'); p.push(src); } }   // 1.19.63
    if (g('source')) { where.push('t.category_source = ?'); p.push(g('source')); }
    if (g('min')) { where.push('ABS(t.amount) >= ?'); p.push(Number(g('min')) || 0); }
    if (g('max')) { where.push('ABS(t.amount) <= ?'); p.push(Number(g('max')) || 0); }
    // 1.19.124: money in / out and how it was paid (Plaid payment_channel: online / in store / other; a check carries check_number)
    if (g('side') === 'in') where.push('t.amount < 0'); else if (g('side') === 'out') where.push('t.amount > 0');
    const how = g('how');
    if (how === 'online') where.push("json_extract(t.raw, '$.payment_channel') = 'online'");
    else if (how === 'store') where.push("json_extract(t.raw, '$.payment_channel') = 'in store'");
    else if (how === 'check') where.push("json_extract(t.raw, '$.check_number') IS NOT NULL AND json_extract(t.raw, '$.check_number') <> '' AND (t.amount > 0 OR t.name LIKE '%check%' OR t.name LIKE '%chk%') AND t.name NOT LIKE '%MERCH DEP%'");   // 1.19.127: see realCheckNo()
    else if (how === 'other') where.push("COALESCE(json_extract(t.raw, '$.payment_channel'), 'other') NOT IN ('online', 'in store') AND (json_extract(t.raw, '$.check_number') IS NULL OR json_extract(t.raw, '$.check_number') = '')");
    if (g('account')) { where.push('t.account_name = ?'); p.push(g('account')); }
    const by_status = Object.fromEntries((await dbAll("SELECT status, COUNT(*) n FROM bk_transactions WHERE status NOT IN ('removed', 'excluded') GROUP BY status")).map(r => [r.status, r.n]));
    by_status.new_status = by_status.new || 0;   // lines the AI has not rated yet
    by_status.new = (await dbGet("SELECT COUNT(*) n FROM bk_transactions WHERE status IN ('new', 'pending') AND created_at >= ?", [cut])).n;
    by_status.new_open = by_status.new;
    by_status.old = (await dbGet("SELECT COUNT(*) n FROM bk_transactions WHERE status IN ('new', 'pending') AND date < date('now', '-90 days')")).n;
    by_status.pending = (by_status.new_status || 0) + (by_status.pending || 0) - by_status.new_open - by_status.old;   // the open lines older than a day, within 90 days
    const W = ' FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id LEFT JOIN bk_vendors sv ON sv.id = t.suggest_vendor_id LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id LEFT JOIN bk_transactions tr ON tr.id = t.transfer_of LEFT JOIN bk_accounts tra ON tra.item_id = tr.item_id LEFT JOIN bk_loans lo ON lo.id = t.loan_id LEFT JOIN bk_proposals pr ON pr.id = t.proposal_id LEFT JOIN bk_transactions ro ON ro.id = t.refund_of LEFT JOIN bk_transactions rb ON rb.refund_of = t.id WHERE ' + where.join(' AND ');
    const rows = await dbAll('SELECT t.id, t.txn_id, t.team_id, t.account_name, t.account_ref, t.date, t.created_at, t.name, t.raw, t.merchant, t.amount, t.pending, t.plaid_category, t.category, t.category_source, t.rule_id, t.proposal_id, t.status, t.vendor_id, t.vendor_by, t.vendor_score, t.suggest_vendor_id, t.suggest_score, ' +
      't.refund_of, t.ar_notified_at, t.ar_notified_by, t.updated_at, t.loan_id, lo.name AS loan_name, (t.check_image IS NOT NULL) AS has_check_image, t.transfer_of, tr.date AS transfer_date, tr.amount AS transfer_amount, tr.account_name AS transfer_account, tr.name AS transfer_name, tra.institution AS transfer_institution, ro.date AS refund_of_date, ro.amount AS refund_of_amount, ro.merchant AS refund_of_merchant, ro.name AS refund_of_name, ro.category AS refund_of_category, rb.id AS refunded_by, rb.date AS refunded_by_date, rb.amount AS refunded_by_amount, ' +
      'v.name AS vendor_name, v.source AS vendor_source, v.photo AS vendor_photo, v.kind AS vendor_kind, sv.name AS suggest_name, sv.photo AS suggest_photo, ba.institution, ba.logo AS bank_logo, ba.color AS bank_color, ba.accounts AS bank_accounts, pr.payload AS ai_payload, pr.confidence AS ai_conf, pr.reason AS ai_reason, pr.status AS ai_status' + W + ' ORDER BY ' + (st === 'categorized' ? 'COALESCE(t.updated_at, t.created_at) DESC, t.id DESC' : 't.date DESC, t.id DESC') + ' LIMIT 500', p)   // 1.19.90: Categorized = most recent work first;
    // the account's last digits ("Wells Fargo - 6595") and the near-match vendor for rows that never got one
    const VSEL = 'SELECT t.vendor_id, t.vendor_by, t.vendor_score, t.suggest_vendor_id, t.suggest_score, v.name AS vendor_name, v.source AS vendor_source, v.photo AS vendor_photo, v.kind AS vendor_kind, sv.name AS suggest_name, sv.photo AS suggest_photo FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id LEFT JOIN bk_vendors sv ON sv.id = t.suggest_vendor_id WHERE t.id = ?';
    let backfilled = 0;
    for (const r of rows) {
      let accts = []; try { accts = JSON.parse(r.bank_accounts || '[]'); } catch (e) {}
      const a = accts.find(x => x.account_id === r.account_ref); r.mask = a && a.mask ? a.mask : null; delete r.bank_accounts;
      // 1.19.56: what else Plaid told us — the bank's memo line, how it was paid, when it happened, the category family
      let raw = null; try { raw = r.raw ? JSON.parse(r.raw) : null; } catch (e) {} delete r.raw;
      if (raw) {
        r.orig_desc = raw.original_description || null;
        const cn = realCheckNo(raw, r);   // 1.19.127: Plaid's check_number is not always a check (merchant-ID tails on card deposits)
        r.channel = cn ? 'check' : raw.payment_channel === 'in store' ? 'store' : raw.payment_channel === 'online' ? 'online' : (raw.payment_channel || null);
        r.check_no = cn;
        r.tx_time = raw.authorized_datetime || raw.datetime || null;
        r.tx_date = raw.authorized_date || raw.date || null;
        r.plaid_primary = raw.personal_finance_category ? raw.personal_finance_category.primary : null;
        r.plaid_logo = raw.logo_url || null;
        r.website = raw.website || null;
        r.place = raw.location ? [raw.location.city, raw.location.region].filter(Boolean).join(', ') + (raw.location.store_number ? ' #' + raw.location.store_number : '') : '';
      }
      if (r.vendor_id && !r.vendor_photo && r.plaid_logo && (r.vendor_source === 'nova' || r.vendor_source === 'bill')) { await dbRun('UPDATE bk_vendors SET photo = ? WHERE id = ? AND photo IS NULL', [r.plaid_logo, r.vendor_id]).catch(() => {}); r.vendor_photo = r.plaid_logo; dirCache.at = 0; }   // backfill: lines linked before 1.19.65
      // the AI's suggestion (its proposal), shown under the picker while the line is not categorized
      let pl = null; try { pl = r.ai_payload ? JSON.parse(r.ai_payload) : null; } catch (e) {}
      r.ai_category = pl && pl.category && pl.category !== 'Uncategorized' ? pl.category : null; delete r.ai_payload;
      if (!r.vendor_id && r.suggest_score == null && backfilled < 150) { backfilled++; try { await autoVendor(r); Object.assign(r, (await dbGet(VSEL, [r.id])) || {}); } catch (e) {} }
    }
    const matched = rows.length < 500 ? rows.length : (await dbGet('SELECT COUNT(*) n' + W, p)).n;   // how many the filters match (the list stops at 500)
    // 1.19.72: a category suggestion for every uncategorized line — the linked company's own history first (every
    // past line in one category → 100%), then the company's usual category (one → 95%, several → 85% each), then the AI
    // Money in and money out never share a suggestion: a charge gets the company's expense history / categories, a
    // deposit its income ones (a refund matched to a charge carries the charge's category and is left out of history).
    const sugCache = {}; const chartRows = chartOf(await settings()); const isIncomeCat = (name) => { const c = chartRows.find(x => x.name === name); return !!(c && c.income); };
    for (const r of rows) {
      if (r.category || !r.vendor_id) { r.cat_suggest = r.category ? [] : (r.ai_category ? [{ category: r.ai_category, conf: r.ai_conf, why: 'ai' }] : []); continue; }
      const moneyIn = Number(r.amount) < 0, key = r.vendor_id + (moneyIn ? ':in' : ':out');
      if (!sugCache[key]) {
        const hist = (await dbAll("SELECT category, COUNT(*) n FROM bk_transactions WHERE vendor_id = ? AND status = 'categorized' AND category IS NOT NULL AND category <> 'Uncategorized' AND refund_of IS NULL AND (amount < 0) = ? GROUP BY category ORDER BY n DESC", [r.vendor_id, moneyIn ? 1 : 0]))
          .filter(h => isIncomeCat(h.category) === moneyIn);
        const total = hist.reduce((a, h) => a + h.n, 0);
        const v = await dbGet('SELECT default_category FROM bk_vendors WHERE id = ?', [r.vendor_id]);
        const usual = String(v && v.default_category || '').split(/\s*[;|\n]\s*/).map(x => x.trim()).filter(Boolean).filter(c => isIncomeCat(c) === moneyIn);
        let out = [];
        if (total >= 3 && hist[0].n === total) out = [{ category: hist[0].category, conf: 1, why: 'history', n: total }];
        else if (total >= 3 && hist[0].n / total >= 0.8) out = [{ category: hist[0].category, conf: 0.9, why: 'history', n: hist[0].n }];
        else if (usual.length === 1) out = [{ category: usual[0], conf: 0.95, why: 'vendor' }];
        else if (usual.length > 1) out = usual.slice(0, 3).map(c => ({ category: c, conf: 0.85, why: 'vendor' }));
        else if (total >= 1) out = hist.slice(0, 2).map(h => ({ category: h.category, conf: Math.min(0.8, 0.5 + h.n / Math.max(total, 1) * 0.3), why: 'history', n: h.n }));
        sugCache[key] = out;
      }
      r.cat_suggest = sugCache[key].length ? sugCache[key] : (r.ai_category && isIncomeCat(r.ai_category) === moneyIn ? [{ category: r.ai_category, conf: r.ai_conf, why: 'ai' }] : []);
    }
    // 1.19.77: a categorized line that no rule covers yet offers "Create a rule" — `can_rule` says so
    const liveRules = await dbAll('SELECT * FROM bk_rules WHERE active = 1 ORDER BY kind DESC, id');
    for (const r of rows) {
      // 1.19.96: `rule_exists` for every row (so Use never offers "Make it a rule?" for a company that has one); `can_rule` only on filed lines
      r.no_rule = !!noRuleFor(liveRules, r);   // 1.19.112: "No rule" set for this vendor — never ask again
      r.rule_exists = !!(r.rule_id || r.no_rule || ruleMatch(liveRules, r) || liveRules.some(x => x.kind !== 'keyword' && r.vendor_name && normName(x.pattern) === normName(r.vendor_name)));
      r.can_rule = !!(r.category && r.category !== 'Uncategorized' && !r.refund_of && !r.transfer_of && !r.rule_exists && !r.team_id && !isWise((r.merchant || '') + ' ' + (r.name || '')));   // 1.19.119: never a rule on a Wise payout — the team list files those
    }
    // 1.19.92: a line that looks like the other half of a transfer between our own accounts — same amount, opposite sign, a
    // different account, within 7 days, neither side matched yet — carries `transfer_hint` (id, account, date) for a one-click match
    if (rows.length) {
      const open = rows.filter(r => !r.transfer_of && !r.refund_of && Math.abs(Number(r.amount)) >= 50);
      if (open.length) {
        const dates = open.map(r => r.date).sort(), lo = dates[0], hi = dates[dates.length - 1];
        const pool = await dbAll("SELECT t.id, t.date, t.amount, t.account_ref, t.account_name, t.name, ba.institution FROM bk_transactions t LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id WHERE t.status NOT IN ('removed', 'excluded') AND t.transfer_of IS NULL AND t.refund_of IS NULL AND ABS(t.amount) >= 50 AND t.date BETWEEN date(?, '-7 days') AND date(?, '+7 days')", [lo, hi]);
        const byAmt = {}; pool.forEach(x => { const k = Math.abs(Number(x.amount)).toFixed(2); (byAmt[k] = byAmt[k] || []).push(x); });
        for (const r of open) {
          const c = (byAmt[Math.abs(Number(r.amount)).toFixed(2)] || []).filter(x => x.id !== r.id && x.account_ref !== r.account_ref && (Number(x.amount) < 0) !== (Number(r.amount) < 0) && Math.abs(new Date(x.date) - new Date(r.date)) <= 7 * 86400000);
          if (c.length) { const x = c.sort((a, b) => Math.abs(new Date(a.date) - new Date(r.date)) - Math.abs(new Date(b.date) - new Date(r.date)))[0]; r.transfer_hint = { id: x.id, date: x.date, amount: x.amount, account_name: x.account_name, institution: x.institution, name: x.name }; }
        }
      }
    }
    // 1.19.99: a money-out line that looks like a loan payment — the lender's company, or the exact monthly amount of an active loan
    const activeLoans = (await dbAll("SELECT * FROM bk_loans WHERE status = 'active'")).map(l => { const m = loanMath(l); return Object.assign(l, { monthly: m.payment || m.monthly, monthly_base: m.monthly }); });   // 1.19.136: the bank sees monthly + property tax
    if (activeLoans.length) for (const r of rows) {
      if (r.loan_id || r.transfer_of || r.refund_of || !(Number(r.amount) > 0)) continue;
      const amt = Number(r.amount);
      const hit = activeLoans.find(l => r.vendor_id && l.vendor_id === r.vendor_id && (!l.monthly || Math.abs(Number(l.monthly) - amt) <= Math.max(1, amt * 0.02))) || activeLoans.find(l => (l.monthly && Math.abs(Number(l.monthly) - amt) < 0.005) || (l.monthly_base && Math.abs(Number(l.monthly_base) - amt) < 0.005));
      if (hit) r.loan_hint = { id: hit.id, name: hit.name };
    }
    // 1.19.119: overseas team — a linked line carries the person (flag, department); an open Wise payout carries `team_hint`
    // (the candidates by pay, or everyone when nobody's pay matches) so the person can be picked in the row
    const team = await teamMembers();
    if (team.length) {
      const byId = {}; team.forEach(m => { byId[m.id] = m; });
      for (const r of rows) {
        r.is_wise = isWise((r.merchant || '') + ' ' + (r.name || ''));
        if (r.team_id && byId[r.team_id]) { const m = byId[r.team_id]; r.team = { id: m.id, name: m.name, country: m.country, department: m.department, dept: DEPTS[m.department] || m.department, category: m.category, category_alt: m.category_alt }; continue; }
        if (!r.is_wise || !(Number(r.amount) > 0) || r.transfer_of || r.refund_of) continue;
        const hit = teamMatch(team, r);
        const cands = hit && hit.ambiguous ? hit.ambiguous : team.filter(m => teamActiveOn(m, r.date));
        r.team_hint = { ambiguous: !!(hit && hit.ambiguous), members: cands.map(m => ({ id: m.id, name: m.name, country: m.country, dept: DEPTS[m.department] || m.department, pay: m.pay })) };
      }
    }
    if (rows.some(r => !r.orig_desc)) backfillOriginalDesc();
    const out = { ok: true, by_status, matched, transactions: rows, categorizing: catBusy, new_since: cut };   // 1.19.108: the page's Status tags use the same cut-off (midnight LA)
    if ((by_status.new_status || 0) > 0 && !catBusy) { categorizeBacklog(userId(req)); out.categorizing = true; }
    if (st === 'categorized') {
      const parentOfName = {}; chartOf(await settings()).forEach(c => { if (c.parent) parentOfName[c.name] = c.parent; });
      const tot = await dbGet('SELECT COUNT(*) n, SUM(CASE WHEN t.transfer_of IS NOT NULL THEN 0 WHEN t.amount > 0 THEN t.amount WHEN t.refund_of IS NOT NULL THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 AND t.refund_of IS NULL AND t.transfer_of IS NULL THEN -t.amount ELSE 0 END) received' + W, p);
      const byCat = await dbAll('SELECT t.category, SUM(CASE WHEN t.transfer_of IS NOT NULL THEN 0 WHEN t.amount > 0 THEN t.amount WHEN t.refund_of IS NOT NULL THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 AND t.refund_of IS NULL AND t.transfer_of IS NULL THEN -t.amount ELSE 0 END) received, COUNT(*) n' + W + ' GROUP BY t.category ORDER BY spent DESC', p);
      const byType = {}; byCat.forEach(r => { const t = parentOfName[r.category] || r.category || '—'; const o = byType[t] || (byType[t] = { type: t, spent: 0, received: 0, n: 0 }); o.spent += r.spent; o.received += r.received; o.n += r.n; });
      const byMonth = await dbAll("SELECT substr(t.date, 1, 7) m, SUM(CASE WHEN t.transfer_of IS NOT NULL THEN 0 WHEN t.amount > 0 THEN t.amount WHEN t.refund_of IS NOT NULL THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 AND t.refund_of IS NULL AND t.transfer_of IS NULL THEN -t.amount ELSE 0 END) received, COUNT(*) n" + W + ' GROUP BY m ORDER BY m', p);
      const byVendor = await dbAll('SELECT COALESCE(v.name, t.merchant, t.name) vendor, t.vendor_id, SUM(CASE WHEN t.amount > 0 AND t.transfer_of IS NULL THEN t.amount ELSE 0 END) spent, COUNT(*) n' + W + ' GROUP BY COALESCE(v.name, t.merchant, t.name), t.vendor_id ORDER BY spent DESC LIMIT 12', p);
      out.totals = { count: tot.n, spent: tot.spent || 0, received: tot.received || 0, by_type: Object.values(byType).sort((a, b) => b.spent - a.spent), by_category: byCat, by_month: byMonth, by_vendor: byVendor };
    }
    if (st === 'categorized' || req.query.lists) {
      // 1.19.49: the Account filter shows "Wells Fargo - 6595", the Vendor filter every vendor seen on a bank line
      const accs = await dbAll("SELECT DISTINCT t.account_name, t.account_ref, ba.institution, ba.accounts, ba.excluded, ba.logo, ba.color FROM bk_transactions t JOIN bk_accounts ba ON ba.item_id = t.item_id WHERE t.account_name IS NOT NULL ORDER BY 1");
      out.accounts = accs.filter(r => { let x = []; try { x = JSON.parse(r.excluded || '[]'); } catch (e) {} return x.indexOf(r.account_ref) < 0; })
        .map(r => { let a = null; try { a = JSON.parse(r.accounts || '[]').find(x => x.account_id === r.account_ref); } catch (e) {} const short = (r.institution || 'Bank') + (a && a.mask ? ' - ' + a.mask : ''); return { account_name: r.account_name, short, label: short + (r.account_name ? ' · ' + r.account_name : ''), institution: r.institution, mask: a && a.mask ? a.mask : '', logo: r.logo, color: r.color }; });
      out.vendors = await dbAll("SELECT DISTINCT v.id, v.name FROM bk_transactions t JOIN bk_vendors v ON v.id = t.vendor_id ORDER BY v.name");
    }
    res.json(out);
  });
  // 1.19.60: a refund matched to the charge it gives back. The refund takes the charge's category (so the books show the
  // net spend, not fake income) and the Stats net it against what was spent.
  app.get('/api/bookkeeping/transactions/:id/refund-candidates', ...guard, async (req, res) => {
    try {
      const t = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [parseInt(req.params.id)]);
      if (!t) return res.json({ ok: false, error: 'No such line' });
      const amt = Math.abs(Number(t.amount)), who = normName(t.merchant || t.name);
      const rows = await dbAll("SELECT t.id, t.date, t.name, t.merchant, t.amount, t.category, t.account_name, t.vendor_id, v.name AS vendor_name FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id LEFT JOIN bk_transactions rb ON rb.refund_of = t.id " +
        "WHERE t.id <> ? AND t.amount > 0 AND t.status NOT IN ('removed', 'excluded') AND rb.id IS NULL AND t.date BETWEEN date(?, '-120 days') AND date(?, '+7 days') ORDER BY t.date DESC LIMIT 400", [t.id, t.date, t.date]);
      const score = (r) => (Math.abs(Math.abs(Number(r.amount)) - amt) < 0.005 ? 2 : 0) + (normName(r.merchant || r.name) === who || (t.vendor_id && r.vendor_id === t.vendor_id) ? 1 : 0);
      const out = rows.map(r => Object.assign(r, { score: score(r) })).filter(r => r.score > 0).sort((a, b) => b.score - a.score || String(b.date).localeCompare(a.date)).slice(0, 12);
      res.json({ ok: true, candidates: out });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 1.19.92: transfers between our own accounts — a credit card payment is money out at the bank and money in at the card,
  // neither an expense nor income. Both lines point at each other (transfer_of), are filed under the chart's
  // "Credit Card Payment" / "Transfer Between Accounts" (whichever exists), and the Stats leave both out.
  app.get('/api/bookkeeping/transactions/:id/transfer-candidates', ...guard, async (req, res) => {
    try {
      const t = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [parseInt(req.params.id)]);
      if (!t) return res.json({ ok: false, error: 'No such line' });
      const rows = await dbAll("SELECT t.id, t.date, t.name, t.merchant, t.amount, t.category, t.account_name, t.account_ref, ba.institution, ba.logo AS bank_logo FROM bk_transactions t LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id " +
        "WHERE t.id <> ? AND t.status NOT IN ('removed', 'excluded') AND t.transfer_of IS NULL AND t.refund_of IS NULL AND ((t.amount < 0) <> (? < 0)) AND t.date BETWEEN date(?, '-14 days') AND date(?, '+14 days') ORDER BY t.date DESC LIMIT 300", [t.id, Number(t.amount), t.date, t.date]);
      const amt = Math.abs(Number(t.amount));
      const out = rows.map(r => Object.assign(r, { same_amount: Math.abs(Math.abs(Number(r.amount)) - amt) < 0.005, other_account: r.account_ref !== t.account_ref, days: Math.round(Math.abs(new Date(r.date) - new Date(t.date)) / 86400000) }))
        .filter(r => r.same_amount).sort((a, b) => (b.other_account - a.other_account) || (a.days - b.days)).slice(0, 12);
      res.json({ ok: true, candidates: out });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/transactions/:id/transfer', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), w = req.body.with == null ? null : parseInt(req.body.with);
      const t = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [id]);
      if (!t) return res.json({ ok: false, error: 'No such line' });
      if (w == null) {
        const other = t.transfer_of;
        await dbRun("UPDATE bk_transactions SET transfer_of = NULL, category = CASE WHEN category_source = 'transfer' THEN NULL ELSE category END, category_source = CASE WHEN category_source = 'transfer' THEN NULL ELSE category_source END, status = CASE WHEN category_source = 'transfer' THEN 'pending' ELSE status END, updated_at = datetime('now') WHERE id IN (?, ?)", [id, other || -1]);
        await audit(userId(req), 'txn.transfer', id, { with: null, was: other });
        return res.json({ ok: true });
      }
      const o = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [w]);
      if (!o || o.id === id) return res.json({ ok: false, error: 'No such line' });
      if ((Number(t.amount) < 0) === (Number(o.amount) < 0)) return res.json({ ok: false, error: 'A transfer is money out of one account and the same money into another.' });
      if (Math.abs(Math.abs(Number(t.amount)) - Math.abs(Number(o.amount))) > 0.005) return res.json({ ok: false, error: 'The two amounts differ.' });
      if (t.transfer_of || o.transfer_of) return res.json({ ok: false, error: 'One of them is already matched.' });
      // which category: a credit card on either side → Credit Card Payment, else Transfer Between Accounts (only names the chart has)
      const names = chartOf(await settings()).map(c => c.name);
      const isCard = async (x) => { const a = await dbGet('SELECT accounts FROM bk_accounts WHERE item_id = ?', [x.item_id]); let L = []; try { L = JSON.parse(a && a.accounts || '[]'); } catch (e) {} const acc = L.find(y => y.account_id === x.account_ref); return !!(acc && /credit/i.test(acc.type || '') || acc && /credit/i.test(acc.subtype || '')); };
      const card = (await isCard(t)) || (await isCard(o)) || /amex|american express|card|visa|mastercard/i.test((t.account_name || '') + ' ' + (o.account_name || '') + ' ' + t.name + ' ' + o.name);
      const want = card ? ['Credit Card Payment', 'Transfer Between Accounts'] : ['Transfer Between Accounts', 'Credit Card Payment'];
      const cat = want.find(n => names.indexOf(n) > -1) || null;
      for (const x of [[id, w], [w, id]]) {
        await dbRun("UPDATE bk_transactions SET transfer_of = ?, updated_at = datetime('now')" + (cat ? ", category = ?, category_source = 'transfer', status = 'categorized'" : '') + ' WHERE id = ?', cat ? [x[1], cat, x[0]] : [x[1], x[0]]);
        await dbRun("UPDATE bk_proposals SET status = 'edited', decided_by = ?, decided_at = ? WHERE ref_table = 'bk_transactions' AND ref_id = ? AND status = 'pending'", [userId(req), nowIso(), x[0]]);
      }
      await audit(userId(req), 'txn.transfer', id, { with: w, category: cat });
      res.json({ ok: true, category: cat });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/transactions/:id/refund', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), of = req.body.of == null ? null : parseInt(req.body.of);
      const t = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [id]);
      if (!t) return res.json({ ok: false, error: 'No such line' });
      if (of == null) {
        await dbRun("UPDATE bk_transactions SET refund_of = NULL, updated_at = datetime('now') WHERE id = ?", [id]);
        await audit(userId(req), 'txn.refund', id, { of: null });
        return res.json({ ok: true });
      }
      const o = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [of]);
      if (!o || o.id === id) return res.json({ ok: false, error: 'No such charge' });
      if (!(Number(t.amount) < 0 && Number(o.amount) > 0)) return res.json({ ok: false, error: 'A refund is money in matched to money out' });
      const sets = ['refund_of = ?', "updated_at = datetime('now')"], args = [of];
      // 1.19.80: a category the person picked by hand (e.g. Income › Refund) stays; only an unfiled / machine-filed line takes the charge's
      const keep = !!(t.category && ['manual', 'vendor', 'history'].indexOf(t.category_source) > -1);
      if (o.category && !keep) { sets.push('category = ?', "category_source = 'refund'", "status = 'categorized'"); args.push(o.category); }
      else if (t.category) sets.push("status = 'categorized'");
      args.push(id);
      await dbRun('UPDATE bk_transactions SET ' + sets.join(', ') + ' WHERE id = ?', args);
      await audit(userId(req), 'txn.refund', id, { of, category: o.category || null });
      res.json({ ok: true, category: o.category || null });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/transactions/:id/category', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), category = String(req.body.category || '').trim();
    if (!category) return res.json({ ok: false, error: 'No category' });
    // 1.19.72: a picked suggestion keeps where it came from (vendor's usual / history / ai); a hand pick is 'manual'
    const src = ['vendor', 'history', 'ai'].indexOf(String(req.body.source || '')) > -1 ? String(req.body.source) : 'manual';
    await dbRun("UPDATE bk_transactions SET category = ?, category_source = ?, status = 'categorized', updated_at = datetime('now') WHERE id = ?", [category, src, id]);
    await dbRun("UPDATE bk_proposals SET status = 'edited', decided_by = ?, decided_at = ? WHERE ref_table = 'bk_transactions' AND ref_id = ? AND status = 'pending'", [userId(req), nowIso(), id]);
    await audit(userId(req), 'category.manual', id, category);
    res.json({ ok: true });
  });
  // 1.19.77: "Create a rule" on a categorized bank line — a vendor rule (the linked company's name, else the merchant) with the
  // line's category; the line is tied to it, and every pending line the rule matches is categorized by it on the spot.
  app.post('/api/bookkeeping/transactions/:id/rule', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {};
    const t = await dbGet('SELECT t.*, v.name AS vendor_name FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id WHERE t.id = ?', [id]);
    if (!t) return res.json({ ok: false, error: 'No such line.' });
    const pattern = String(t.vendor_name || t.merchant || t.name || '').trim().slice(0, 120);
    if (!pattern) return res.json({ ok: false, error: 'No vendor name on this line.' });
    const dup = await dbGet("SELECT id, kind, category FROM bk_rules WHERE kind IN ('vendor', 'none') AND LOWER(pattern) = LOWER(?) AND active = 1", [pattern]);
    if (b.none) {   // 1.19.112: "No rule" — remember never to ask for this vendor (eBay: every purchase is different)
      if (dup) return res.json({ ok: false, error: dup.kind === 'none' ? 'No rule is already set for ' + pattern + '.' : 'There is already a rule for ' + pattern + ' → ' + dup.category + ' (Accounts → Rules) — remove it first.' });
      const n = await dbRun('INSERT INTO bk_rules (kind, pattern, category, vendor, source, created_by) VALUES (?,?,?,?,?,?)', ['none', pattern, null, pattern, 'manual', userId(req)]);
      await audit(userId(req), 'rule.none', n.lastID, { from_txn: id, pattern });
      return res.json({ ok: true, id: n.lastID, pattern, none: true });
    }
    if (!t.category) return res.json({ ok: false, error: 'Categorize the line first.' });
    if (dup) return res.json({ ok: false, error: dup.kind === 'none' ? 'No rule is set for ' + pattern + ' (Accounts → Rules) — remove that first.' : 'There is already a rule for ' + pattern + ' → ' + dup.category + ' (Accounts → Rules).' });
    const r = await dbRun('INSERT INTO bk_rules (kind, pattern, category, vendor, source, created_by) VALUES (?,?,?,?,?,?)', ['vendor', pattern, t.category, pattern, 'manual', userId(req)]);
    await dbRun('UPDATE bk_transactions SET rule_id = ? WHERE id = ?', [r.lastID, id]);
    // the vendor's bank wording is often not its name — the rule also matches by the linked vendor, so apply by vendor id or wording
    const rule = { id: r.lastID, kind: 'vendor', pattern, category: t.category };
    const open = await dbAll("SELECT * FROM bk_transactions WHERE status IN ('new', 'pending') AND (category IS NULL OR category = '')");
    let applied = 0;
    for (const o of open) {
      if (!((t.vendor_id && o.vendor_id === t.vendor_id) || ruleMatch([rule], o))) continue;
      if ((Number(o.amount) < 0) !== (Number(t.amount) < 0)) continue;   // never across the money-in / money-out line
      await dbRun("UPDATE bk_transactions SET category = ?, category_source = 'rule', rule_id = ?, status = 'categorized', updated_at = datetime('now') WHERE id = ?", [t.category, rule.id, o.id]);
      await dbRun("UPDATE bk_proposals SET status = 'edited', decided_by = ?, decided_at = ? WHERE ref_table = 'bk_transactions' AND ref_id = ? AND status = 'pending'", [userId(req), nowIso(), o.id]);
      applied++;
    }
    if (applied) await dbRun('UPDATE bk_rules SET hits = hits + ? WHERE id = ?', [applied, rule.id]);
    await audit(userId(req), 'rule.add', rule.id, { from_txn: id, pattern, category: t.category, applied });
    res.json({ ok: true, id: rule.id, pattern, category: t.category, applied });
  });
  // 1.19.79: a money-in line filed as customer income → tell Accounts Receivable. One email (Settings → Alerts: ar_to, Cc ar_cc)
  // with the bank's facts about the payment; the line remembers who sent it and when, so it is offered once.
  app.post('/api/bookkeeping/transactions/:id/notify-ar', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), s = await settings();
    const t = await dbGet('SELECT t.*, v.name AS vendor_name, ba.institution FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id WHERE t.id = ?', [id]);
    if (!t) return res.json({ ok: false, error: 'No such line' });
    if (!(Number(t.amount) < 0)) return res.json({ ok: false, error: 'Only money in can be a customer payment.' });
    if (!t.category) return res.json({ ok: false, error: 'Categorize the line first.' });
    if (t.ar_notified_at && !req.body.again) return res.json({ ok: false, error: 'Accounts Receivable was told on ' + t.ar_notified_at + ' by ' + (t.ar_notified_by || '?') + '.', already: true });
    let raw = {}; try { raw = JSON.parse(t.raw || '{}') || {}; } catch (e) {}
    const amount = Math.abs(Number(t.amount)), who = userId(req), note = String(req.body.note || '').trim().slice(0, 500);
    const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const lines = [
      ['Amount', usd(amount)], ['Date', t.date + (t.pending ? ' (still pending at the bank)' : '')],
      ['From', t.merchant || t.name], ['Bank description', raw.original_description || t.name],
      ['Deposited to', [t.institution, t.account_name].filter(Boolean).join(' · ') || '—'],
      ['Payment channel', raw.payment_channel && raw.payment_channel !== 'other' ? raw.payment_channel : null], ['Check #', raw.check_number || null],
      ['Linked company', t.vendor_name || null], ['Filed as', t.category], ['Sent by', who], ['Note', note || null]
    ].filter(l => l[1]);
    const text = 'A customer payment landed in the bank and was filed as ' + t.category + ' in BookkeeperAI. Please apply it to the customer\'s open invoices.\n\n' +
      lines.map(l => l[0] + ': ' + l[1]).join('\n') + '\n\nhttps://nova.axiomprint.com/bookkeeping?tab=bank&sub=categorized';
    const html = '<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111"><p>A customer payment landed in the bank and was filed as <b>' + esc(t.category) + '</b> in BookkeeperAI. Please apply it to the customer\'s open invoices.</p>' +
      '<table style="border-collapse:collapse">' + lines.map(l => '<tr><td style="padding:3px 14px 3px 0;color:#666;white-space:nowrap">' + esc(l[0]) + '</td><td style="padding:3px 0"><b>' + esc(l[1]) + '</b></td></tr>').join('') + '</table>' +
      '<p style="margin-top:14px"><a href="https://nova.axiomprint.com/bookkeeping?tab=bank&sub=categorized">Open the bank feed</a></p></div>';
    try { await sendMail({ to: s.ar_to, cc: s.ar_cc || undefined, subject: 'Customer payment received: ' + usd(amount) + ' from ' + (t.vendor_name || t.merchant || t.name) + ' (' + t.date + ')', text, html }); }
    catch (e) { errlog('ar mail', e.message); return res.json({ ok: false, error: 'Could not send: ' + e.message }); }
    await dbRun('UPDATE bk_transactions SET ar_notified_at = ?, ar_notified_by = ? WHERE id = ?', [nowIso(), who, id]);
    await audit(who, 'ar.notify', id, { to: s.ar_to, cc: s.ar_cc, amount, note });
    res.json({ ok: true, to: s.ar_to, cc: s.ar_cc });
  });
  // 1.19.89: a photo of a check. Plaid never delivers check images, so a person pastes / uploads one (the browser shrinks it to
  // 1400px JPEG); GET streams it, POST {image} stores it, POST {image:null} removes it.
  app.get('/api/bookkeeping/transactions/:id/check-image', ...guard, async (req, res) => {
    const t = await dbGet('SELECT check_image FROM bk_transactions WHERE id = ?', [parseInt(req.params.id)]);
    const m = t && t.check_image && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(t.check_image);
    if (!m) return res.status(404).json({ ok: false, error: 'No check image' });
    res.set('Content-Type', m[1]); res.set('Cache-Control', 'private, max-age=300'); res.send(Buffer.from(m[2], 'base64'));
  });
  app.post('/api/bookkeeping/transactions/:id/check-image', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), img = req.body.image;
    if (img === null || img === '') { await dbRun('UPDATE bk_transactions SET check_image = NULL WHERE id = ?', [id]); await audit(userId(req), 'txn.check_image', id, { removed: true }); return res.json({ ok: true }); }
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(img || '')) || String(img).length > 1500000) return res.json({ ok: false, error: 'Send a PNG / JPEG picture under 1 MB.' });
    await dbRun('UPDATE bk_transactions SET check_image = ? WHERE id = ?', [img, id]);
    await audit(userId(req), 'txn.check_image', id, { bytes: img.length });
    res.json({ ok: true });
  });
  app.get('/api/bookkeeping/bills', ...guard, async (req, res) => {
    const rows = await dbAll('SELECT b.*, e.from_addr, e.subject, e.received_at, p.status AS proposal_status, p.confidence AS proposal_confidence, p.reason AS proposal_reason, p.decision AS rejected_note, p.decided_by AS rejected_by, p.decided_at AS rejected_at FROM bk_bills b LEFT JOIN bk_emails e ON e.id = b.email_id LEFT JOIN bk_proposals p ON p.id = b.proposal_id ORDER BY b.id DESC LIMIT 200');
    const dir = await directory();
    for (const r of rows) {
      try { r.lines = JSON.parse(r.lines || '[]'); } catch (e) { r.lines = []; }
      for (const l of r.lines) { if (l && l.material_id && !l.material_photo) { const m = await dbGet('SELECT name, photo FROM bk_materials WHERE id = ?', [l.material_id]); if (m) { l.material_photo = m.photo || null; if (!l.material_name) l.material_name = m.name; } } }   // links made before photos were kept
      const v = r.vendor_id ? dir.find(x => x.id === r.vendor_id) : null;
      r.vendor_card = vendorCard(v);
      // not linked to a CRM entry yet (none, or only the bill-source row) → near matches to pair with
      r.suggestions = (!v || v.source === 'bill') ? (await suggestVendors(r.vendor, r.from_addr, 3)).map(x => Object.assign(vendorCard(x.vendor), { score: x.score })) : [];
      const q = r.proposal_id ? await dbGet('SELECT id, question, answer FROM bk_questions WHERE proposal_id = ? ORDER BY id DESC LIMIT 1', [r.proposal_id]) : null;
      r.question = q && !q.answer ? q : null;
      // every email behind the bill: the one it was read from, the receipt that paid it, and its purchase's confirmation / deliveries — each with its attachments
      const pu = r.purchase_id ? await dbGet('SELECT confirm_email_id, arrival_email_ids FROM bk_purchases WHERE id = ?', [r.purchase_id]) : null;
      const dups = await dbAll('SELECT id, email_id FROM bk_bills WHERE merged_into = ?', [r.id]); r.merged = dups.map(d => d.id);
      const ids = [r.email_id, r.receipt_email_id, pu && pu.confirm_email_id].concat(pu ? jarr(pu.arrival_email_ids) : [], dups.map(d => d.email_id)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
      r.emails = ids.length ? (await dbAll('SELECT id, subject, from_addr, received_at, kind, status, read_by, attachments FROM bk_emails WHERE id IN (' + ids.map(() => '?').join(',') + ') ORDER BY received_at', ids)).map(e => {
        const atts = jarr(e.attachments).map((a, i) => ({ i, name: a.name, kind: /\.pdf$/i.test(a.file || a.name || '') || /pdf/.test(a.mime || '') ? 'pdf' : 'image' }));
        return { id: e.id, subject: e.subject, from_addr: e.from_addr, received_at: e.received_at, open: !e.read_by, role: e.id === r.email_id ? 'bill' : e.id === r.receipt_email_id ? 'receipt' : e.id === (pu && pu.confirm_email_id) ? 'confirmation' : dups.some(d => d.email_id === e.id) ? 'duplicate' : 'delivery', attachments: atts };
      }) : [];
    }
    res.json({ ok: true, bills: rows });
  });
  // Bill life after approval: approved → scheduled (a pay date) → paid (date + how). Until BILL / QuickBooks are
  // connected these are set by hand here; nothing moves money.
  // Fix the lines of a bill by hand: category, and what each line is — a material from the catalog or a job (estimate number).
  app.post('/api/bookkeeping/bills/:id/lines', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), who = userId(req); const b = await dbGet('SELECT id, purchase_id, vendor_id, lines FROM bk_bills WHERE id = ?', [id]); if (!b) return res.json({ ok: false, error: 'No such bill' });
    const lines = (Array.isArray(req.body && req.body.lines) ? req.body.lines : []).slice(0, 80).map(l => ({ description: String(l.description || '').slice(0, 300), qty: l.qty != null && l.qty !== '' ? Number(l.qty) : null, unit_price: l.unit_price != null && l.unit_price !== '' ? Number(l.unit_price) : null, amount: l.amount != null && l.amount !== '' ? Number(l.amount) : null,
      category: String(l.category || '').slice(0, 120) || null, material_id: parseInt(l.material_id) || null, material_name: l.material_id ? String(l.material_name || '').slice(0, 200) : null, estimate_no: String(l.estimate_no || '').replace(/[^0-9]/g, '').slice(0, 12) || null, equipment_id: parseInt(l.equipment_id) || null, equipment_name: l.equipment_id ? String(l.equipment_name || '').slice(0, 200) : null, material_photo: l.material_id && /^https?:\/\//.test(String(l.material_photo || '')) ? String(l.material_photo).slice(0, 500) : null, linked_by: l.linked_by === 'rule' && (l.material_id || l.equipment_id) ? 'rule' : ((l.material_id || l.equipment_id) ? 'hand' : null) }));
    await dbRun("UPDATE bk_bills SET lines = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(lines), id]);
    for (const l of lines) { try { await learnLineLink(b.vendor_id, l, who); } catch (e) {} }
    // a line that is a machine payment (lease / loan) puts the bill on that machine, so its payment history is complete
    const eqLine = lines.find(l => l.equipment_id);
    await dbRun('UPDATE bk_bills SET equipment_id = ? WHERE id = ?', [eqLine ? eqLine.equipment_id : null, id]);
    if (b.purchase_id) await dbRun('UPDATE bk_purchases SET equipment_id = ? WHERE id = ?', [eqLine ? eqLine.equipment_id : null, b.purchase_id]);
    if (b.purchase_id) {   // the purchase's items that came from this bill follow (same position)
      const items = await dbAll("SELECT id, pos FROM bk_purchase_items WHERE purchase_id = ? AND source = 'bill' ORDER BY pos, id", [b.purchase_id]);
      items.forEach((it, i) => { const l = lines[i]; if (l) dbRun("UPDATE bk_purchase_items SET category = ?, material_id = ?, updated_at = datetime('now') WHERE id = ?", [l.category, l.material_id, it.id]); });
    }
    await audit(who, 'bill.lines', id, { n: lines.length }); res.json({ ok: true });
  });
  // A duplicate: fold this bill into the one it repeats. The duplicate is rejected with a note, its proposal closed, its
  // email kept on the surviving bill (shown as DUPLICATE) and handled in the inbox. Nothing is deleted.
  app.post('/api/bookkeeping/bills/:id/merge', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), into = parseInt(req.body && req.body.into), who = userId(req);
    const b = await dbGet('SELECT * FROM bk_bills WHERE id = ?', [id]), t = await dbGet('SELECT * FROM bk_bills WHERE id = ?', [into]);
    if (!b || !t || id === into) return res.json({ ok: false, error: 'Which two bills?' });
    if (t.status === 'rejected' || t.merged_into) return res.json({ ok: false, error: 'Bill #' + into + ' is itself rejected or merged — merge into the one that stays.' });
    try {
      await dbRun("UPDATE bk_bills SET status = 'rejected', merged_into = ?, note = ?, updated_at = datetime('now') WHERE id = ?", [into, 'Duplicate of bill #' + into + ' — merged by ' + who, id]);
      if (b.proposal_id) await dbRun("UPDATE bk_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, decision = ? WHERE id = ? AND status = 'pending'", [who, nowIso(), 'duplicate of bill #' + into, b.proposal_id]);
      if (b.purchase_id && b.purchase_id !== t.purchase_id) {   // the duplicate's purchase goes too, unless it already has a bank line of its own
        const pu = await dbGet('SELECT txn_ids FROM bk_purchases WHERE id = ?', [b.purchase_id]);
        if (pu && !jarr(pu.txn_ids).length) { await dbRun('DELETE FROM bk_purchase_items WHERE purchase_id = ?', [b.purchase_id]); await dbRun("UPDATE bk_purchases SET cancelled = 1, note = ?, updated_at = datetime('now') WHERE id = ?", ['duplicate of bill #' + into, b.purchase_id]); }
      }
      if (b.email_id) { const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [b.email_id]); if (em) { await dbRun('UPDATE bk_emails SET purchase_id = COALESCE(?, purchase_id) WHERE id = ?', [t.purchase_id || null, em.id]); if (!em.read_by) { try { await handleEmail(em, 'bill', who, 'duplicate of bill #' + into + ' — merged by ' + who); } catch (e) {} } } }
      await audit(who, 'bill.merge', id, { into }); res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // A rejected bill back to Pending (its proposal pending again). Merged duplicates stay merged.
  app.post('/api/bookkeeping/bills/:id/restore', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), who = userId(req); const b = await dbGet('SELECT * FROM bk_bills WHERE id = ?', [id]);
    if (!b || b.status !== 'rejected') return res.json({ ok: false, error: 'Only a rejected bill can be restored.' });
    if (b.merged_into) return res.json({ ok: false, error: 'This one was merged into Bill #' + b.merged_into + '.' });
    await dbRun("UPDATE bk_bills SET status = 'draft', updated_at = datetime('now') WHERE id = ?", [id]);
    if (b.proposal_id) await dbRun("UPDATE bk_proposals SET status = 'pending', decided_by = NULL, decided_at = NULL, decision = NULL WHERE id = ?", [b.proposal_id]);
    await audit(who, 'bill.restore', id, {}); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/bills/:id/status', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), to = String(req.body && req.body.status || ''), date = String(req.body && req.body.date || '').slice(0, 10), note = String(req.body && req.body.note || '').slice(0, 200);
    const b = await dbGet('SELECT * FROM bk_bills WHERE id = ?', [id]); if (!b) return res.json({ ok: false, error: 'No such bill' });
    const allowed = { approved: ['scheduled', 'paid'], scheduled: ['paid', 'approved'], paid: ['approved'] };
    if (!(allowed[b.status] || []).includes(to)) return res.json({ ok: false, error: 'A ' + b.status + ' bill cannot become ' + to + '.' });
    if (to === 'scheduled') await dbRun("UPDATE bk_bills SET status = 'scheduled', scheduled_for = ?, updated_at = datetime('now') WHERE id = ?", [date || null, id]);
    else if (to === 'paid') await dbRun("UPDATE bk_bills SET status = 'paid', paid_at = ?, paid_note = ?, updated_at = datetime('now') WHERE id = ?", [date || nowIso().slice(0, 10), note || null, id]);
    else await dbRun("UPDATE bk_bills SET status = 'approved', scheduled_for = NULL, paid_at = NULL, paid_note = NULL, updated_at = datetime('now') WHERE id = ?", [id]);
    await audit(userId(req), 'bill.' + to, id, { date, note, was: b.status });
    res.json({ ok: true, status: to });
  });
  // Pair a bill with a directory entry: { vendor_id, remember } — remember keeps the bill's vendor name as an alias so
  // the next bill from them links by itself. A bill-source row left with nothing pointing at it is removed.
  app.post('/api/bookkeeping/bills/:id/vendor', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), vid = parseInt(req.body && req.body.vendor_id) || null;
    const b = await dbGet('SELECT * FROM bk_bills WHERE id = ?', [id]); if (!b) return res.json({ ok: false, error: 'No such bill' });
    const v = vid ? await dbGet('SELECT * FROM bk_vendors WHERE id = ?', [vid]) : null; if (vid && !v) return res.json({ ok: false, error: 'No such vendor' });
    const old = b.vendor_id;
    await dbRun('UPDATE bk_bills SET vendor_id = ?, updated_at = datetime(\'now\') WHERE id = ?', [vid, id]);
    if (v && req.body.remember !== false && b.vendor && normV(b.vendor) !== normV(v.name)) {
      const al = String(v.aliases || '').split('\n').filter(Boolean); if (al.indexOf(b.vendor) < 0) { al.push(String(b.vendor).slice(0, 120)); await dbRun('UPDATE bk_vendors SET aliases = ? WHERE id = ?', [al.join('\n'), vid]); }
    }
    if (old && old !== vid) { const o = await dbGet('SELECT id, source FROM bk_vendors WHERE id = ?', [old]); if (o && o.source === 'bill') { const used = await dbGet('SELECT (SELECT COUNT(*) FROM bk_bills WHERE vendor_id = ?) + (SELECT COUNT(*) FROM bk_transactions WHERE vendor_id = ?) + (SELECT COUNT(*) FROM bk_materials WHERE vendor_id = ?) AS n', [old, old, old]); if (!used.n) await dbRun('DELETE FROM bk_vendors WHERE id = ?', [old]); } }
    if (b.proposal_id && v) { const p = await dbGet('SELECT payload FROM bk_proposals WHERE id = ?', [b.proposal_id]); if (p) { let pl = {}; try { pl = JSON.parse(p.payload || '{}'); } catch (e) {} pl.new_vendor = !v.approved; pl.vendor_id = vid; await dbRun('UPDATE bk_proposals SET payload = ? WHERE id = ?', [JSON.stringify(pl), b.proposal_id]); } }
    dirCache.at = 0; matCache.at = 0;
    await audit(userId(req), 'bill.vendor', id, { vendor_id: vid, was: old, remember: req.body.remember !== false });
    res.json({ ok: true, vendor: vendorCard(v) });
  });
  app.get('/api/bookkeeping/bills/:id/file', ...guard, async (req, res) => {
    const b = await dbGet('SELECT file, file_name FROM bk_bills WHERE id = ?', [parseInt(req.params.id)]);
    if (!b || !b.file) return res.status(404).type('text/plain').send('No file');
    const full = path.resolve(FILES, b.file);
    if (full.indexOf(path.resolve(FILES)) !== 0 || !fs.existsSync(full)) return res.status(404).type('text/plain').send('No file');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(b.file_name || b.file).replace(/["\\]/g, '') + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(/\.pdf$/i.test(b.file) ? 'application/pdf' : /\.png$/i.test(b.file) ? 'image/png' : 'image/jpeg');
    fs.createReadStream(full).pipe(res);
  });
  app.get('/api/bookkeeping/emails', ...guard, async (req, res) => {
    const rows = await dbAll('SELECT e.id, e.gmail_id, e.from_addr, e.subject, e.received_at, e.snippet, e.attachments, e.status, e.note, e.kind, e.confidence, e.read_by, e.triaged_at, e.aside, e.vendor_id, e.matched_bill_id, e.matched_txn_id, v.name AS vendor_name, v.photo AS vendor_photo FROM bk_emails e LEFT JOIN bk_vendors v ON v.id = e.vendor_id ORDER BY e.received_at DESC LIMIT 500');
    // senders not linked yet: try the directory (an address alias someone added, or the domain) so the logo shows
    for (const r of rows) { if (r.vendor_id) continue; const vend = await matchVendor(String(r.from_addr || '').replace(/<.*$/, ''), r.from_addr); if (vend) { r.vendor_id = vend.id; r.vendor_name = vend.name; r.vendor_photo = vend.photo; await dbRun('UPDATE bk_emails SET vendor_id = ? WHERE id = ?', [vend.id, r.id]); } }
    rows.forEach(r => { try { r.attachments = JSON.parse(r.attachments || '[]'); } catch (e) { r.attachments = []; } });
    res.json({ ok: true, emails: rows });
  });
  // One email in full (the reading pane) and its attachments (inline, for the viewer).
  app.get('/api/bookkeeping/emails/:id', ...guard, async (req, res) => {
    const m = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [parseInt(req.params.id)]); if (!m) return res.json({ ok: false, error: 'No such email' });
    try { m.attachments = JSON.parse(m.attachments || '[]'); } catch (e) { m.attachments = []; }
    m.attachments = m.attachments.map((a, i) => ({ i, name: a.name, mime: a.mime, size: a.size, kind: /\.pdf$/i.test(a.file || '') || /pdf/.test(a.mime || '') ? 'pdf' : 'image' }));
    if (!m.body_html && m.gmail_id && google && fs.existsSync(keyPath)) {   // rows scanned before 1.18.7: fetch the HTML once
      try { const g = gmail(); const full = (await g.users.messages.get({ userId: 'me', id: m.gmail_id, format: 'full' })).data; const h = emailHtml(full.payload); if (h) { await dbRun('UPDATE bk_emails SET body_html = ? WHERE id = ?', [h, m.id]); m.body_html = h; } } catch (e) { errlog('email html', e.message); }
    }
    const bill = await dbGet('SELECT id, status FROM bk_bills WHERE email_id = ? ORDER BY id DESC LIMIT 1', [m.id]);
    if (!m.vendor_id) { const vend = await matchVendor(String(m.from_addr || '').replace(/<.*$/, ''), m.from_addr); if (vend) { m.vendor_id = vend.id; await dbRun('UPDATE bk_emails SET vendor_id = ? WHERE id = ?', [vend.id, m.id]); } }
    const vendor = m.vendor_id ? await dbGet('SELECT id, name, kind, photo, email FROM bk_vendors WHERE id = ?', [m.vendor_id]) : null;
    const matched = { bill: m.matched_bill_id ? await dbGet('SELECT id, vendor, invoice_no, total, status, paid_at FROM bk_bills WHERE id = ?', [m.matched_bill_id]) : null, txn: m.matched_txn_id ? await dbGet('SELECT id, date, name, amount, category FROM bk_transactions WHERE id = ?', [m.matched_txn_id]) : null };
    res.json({ ok: true, email: m, bill: bill || null, vendor: vendor || null, matched, inbox: INBOX });
  });
  app.get('/api/bookkeeping/emails/:id/att/:i', ...guard, async (req, res) => {
    const m = await dbGet('SELECT attachments FROM bk_emails WHERE id = ?', [parseInt(req.params.id)]); let atts = []; try { atts = JSON.parse(m && m.attachments || '[]'); } catch (e) {}
    const a = atts[parseInt(req.params.i)]; if (!a || !a.file) return res.status(404).type('text/plain').send('No file');
    const full = path.resolve(FILES, a.file);
    if (full.indexOf(path.resolve(FILES)) !== 0 || !fs.existsSync(full)) return res.status(404).type('text/plain').send('No file');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(a.name || a.file).replace(/["\\]/g, '') + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(/\.pdf$/i.test(a.file) ? 'application/pdf' : /\.png$/i.test(a.file) ? 'image/png' : /\.webp$/i.test(a.file) ? 'image/webp' : 'image/jpeg');
    fs.createReadStream(full).pipe(res);
  });
  app.post('/api/bookkeeping/emails/:id/read', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), em = await dbGet('SELECT id, status FROM bk_emails WHERE id = ?', [id]);
    if (!em) return res.json({ ok: false, error: 'No such email' });
    const gm = await markReadInGmail([id], userId(req)); if (!gm.ok) return res.json({ ok: false, error: gm.error });   // Gmail is the truth: nothing changes here unless it changed there
    if (em.status === 'parsed') await dbRun("UPDATE bk_emails SET read_by = 'user' WHERE id = ?", [id]);
    else await dbRun("UPDATE bk_emails SET status = 'skipped', read_by = 'user', note = ? WHERE id = ?", ['marked read by ' + userId(req), id]);
    await dbRun("UPDATE bk_emails SET decided_kind = COALESCE(decided_kind, kind), decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, datetime('now')) WHERE id = ?", [userId(req), id]);   // read as-is = the rating was right
    await audit(userId(req), 'email.read', id, null); res.json({ ok: true, gmail: gm });
  });
  // Link the sender to a directory vendor: the address goes into bk_vendors.aliases (ours, not the CRM's contact), so
  // every future email from it links by itself. vendor_id 0 unlinks this email.
  app.post('/api/bookkeeping/emails/:id/vendor', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), vid = parseInt(req.body && req.body.vendor_id) || 0;
    const em = await dbGet('SELECT id, from_addr FROM bk_emails WHERE id = ?', [id]); if (!em) return res.json({ ok: false, error: 'No such email' });
    const addr = (String(em.from_addr || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/) || [])[0];
    if (vid) {
      const v = await dbGet('SELECT id, aliases FROM bk_vendors WHERE id = ?', [vid]); if (!v) return res.json({ ok: false, error: 'No such vendor' });
      if (addr) { const al = String(v.aliases || '').split('\n').filter(Boolean); if (al.indexOf(addr) < 0) { al.push(addr); await dbRun('UPDATE bk_vendors SET aliases = ? WHERE id = ?', [al.join('\n').slice(0, 1000), vid]); dirCache.at = 0; } }
      await dbRun('UPDATE bk_emails SET vendor_id = ? WHERE id = ? OR (vendor_id IS NULL AND LOWER(from_addr) LIKE ?)', [vid, id, '%' + (addr || '\u0000') + '%']);
    } else {
      if (addr) { const v = await dbGet('SELECT id, aliases FROM bk_vendors WHERE id = (SELECT vendor_id FROM bk_emails WHERE id = ?)', [id]); if (v) { await dbRun('UPDATE bk_vendors SET aliases = ? WHERE id = ?', [String(v.aliases || '').split('\n').filter(a => a.trim().toLowerCase() !== addr).join('\n') || null, v.id]); dirCache.at = 0; } }
      await dbRun('UPDATE bk_emails SET vendor_id = NULL WHERE id = ?', [id]);
    }
    await audit(userId(req), 'email.vendor', id, { vendor_id: vid, address: addr }); res.json({ ok: true });
  });
  // What a receipt / payment email could belong to: open bills and bank lines by vendor, invoice number and amount.
  app.get('/api/bookkeeping/emails/:id/matches', ...guard, async (req, res) => {
    const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [parseInt(req.params.id)]); if (!em) return res.json({ ok: false, error: 'No such email' });
    const text = (em.subject || '') + '\n' + (em.body || em.snippet || '');
    const nums = Array.from(new Set((text.match(/\b[A-Z]{0,4}-?\d{4,}(?:-\d+)?\b/gi) || []).map(x => x.toUpperCase())));
    const amts = Array.from(new Set((text.match(/\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g) || []).map(x => Number(x.replace(/[^0-9.]/g, ''))).filter(n => n > 0)));
    const bills = await dbAll("SELECT b.id, b.vendor, b.vendor_id, b.invoice_no, b.total, b.status, b.invoice_date, b.due_date, b.paid_at FROM bk_bills b WHERE b.status <> 'rejected' ORDER BY b.id DESC LIMIT 400");
    const score = (b) => { let sc = 0, why = []; if (em.vendor_id && b.vendor_id === em.vendor_id) { sc += 3; why.push('same vendor'); } const inv = String(b.invoice_no || '').toUpperCase().replace(/\s+/g, ''); if (inv && nums.some(n => n.replace(/-/g, '') === inv.replace(/-/g, '') || inv.indexOf(n) > -1 || n.indexOf(inv) > -1)) { sc += 4; why.push('invoice # ' + b.invoice_no); } if (b.total && amts.some(a => Math.abs(a - b.total) < 0.01)) { sc += 2; why.push('amount ' + b.total); } if (b.status === 'paid') sc -= 1; return { sc, why }; };
    const billHits = bills.map(b => Object.assign({}, b, score(b))).filter(b => b.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 8);
    const since = String(em.received_at || nowIso()).slice(0, 10);
    const txns = await dbAll("SELECT id, date, name, merchant, amount, category, status, vendor_id FROM bk_transactions WHERE status NOT IN ('removed', 'excluded') AND date >= date(?, '-45 days') AND date <= date(?, '+10 days') AND amount < 0 ORDER BY date DESC LIMIT 600", [since, since]);
    const tscore = (t) => { let sc = 0, why = []; if (em.vendor_id && t.vendor_id === em.vendor_id) { sc += 3; why.push('same vendor'); } if (amts.some(a => Math.abs(a - Math.abs(t.amount)) < 0.01)) { sc += 3; why.push('amount ' + Math.abs(t.amount)); } const vn = normV((em.from_addr || '').replace(/<.*$/, '')); if (vn && normV(t.name + ' ' + (t.merchant || '')).indexOf(vn.split(' ')[0]) > -1 && vn.split(' ')[0].length > 3) { sc += 1; why.push('name'); } return { sc, why }; };
    const txnHits = txns.map(t => Object.assign({}, t, tscore(t))).filter(t => t.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 8);
    res.json({ ok: true, numbers: nums.slice(0, 10), amounts: amts.slice(0, 10), bills: billHits, transactions: txnHits });
  });
  // Match the email to a bill (→ paid, paid_at = the email's date) or to a bank line (the receipt for it).
  app.post('/api/bookkeeping/emails/:id/match', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), bid = parseInt(req.body && req.body.bill_id) || 0, tid = parseInt(req.body && req.body.transaction_id) || 0;
    const em = await dbGet('SELECT id, received_at FROM bk_emails WHERE id = ?', [id]); if (!em) return res.json({ ok: false, error: 'No such email' });
    if (bid) {
      const b = await dbGet('SELECT id, status FROM bk_bills WHERE id = ?', [bid]); if (!b) return res.json({ ok: false, error: 'No such bill' });
      const day = String(em.received_at || nowIso()).slice(0, 10);
      if (b.status !== 'paid') await dbRun("UPDATE bk_bills SET status = 'paid', paid_at = ?, paid_note = ?, receipt_email_id = ?, updated_at = datetime('now') WHERE id = ?", [day, 'receipt email matched by ' + userId(req), id, bid]);
      else await dbRun("UPDATE bk_bills SET receipt_email_id = ?, updated_at = datetime('now') WHERE id = ?", [id, bid]);
      await dbRun('UPDATE bk_emails SET matched_bill_id = ? WHERE id = ?', [bid, id]);
      await audit(userId(req), 'email.match', id, { bill_id: bid, was: b.status }); await decideEmail(id, 'receipt', userId(req));
    } else if (tid) {
      const t = await dbGet('SELECT id FROM bk_transactions WHERE id = ?', [tid]); if (!t) return res.json({ ok: false, error: 'No such transaction' });
      await dbRun("UPDATE bk_transactions SET receipt_email_id = ?, updated_at = datetime('now') WHERE id = ?", [id, tid]);
      await dbRun('UPDATE bk_emails SET matched_txn_id = ? WHERE id = ?', [tid, id]);
      await audit(userId(req), 'email.match', id, { transaction_id: tid }); await decideEmail(id, 'receipt', userId(req));
    } else if (req.body && req.body.clear) {
      const cur = await dbGet('SELECT matched_bill_id, matched_txn_id FROM bk_emails WHERE id = ?', [id]);
      if (cur.matched_bill_id) await dbRun('UPDATE bk_bills SET receipt_email_id = NULL WHERE id = ? AND receipt_email_id = ?', [cur.matched_bill_id, id]);
      if (cur.matched_txn_id) await dbRun('UPDATE bk_transactions SET receipt_email_id = NULL WHERE id = ? AND receipt_email_id = ?', [cur.matched_txn_id, id]);
      await dbRun('UPDATE bk_emails SET matched_bill_id = NULL, matched_txn_id = NULL WHERE id = ?', [id]);
      await audit(userId(req), 'email.unmatch', id, cur);
    } else return res.json({ ok: false, error: 'Match to what?' });
    res.json({ ok: true });
  });
  // Several picked emails at once: read in Gmail first, then closed here.
  app.post('/api/bookkeeping/inbox/read', ...guard, async (req, res) => {
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(x => parseInt(x)).filter(Boolean).slice(0, 500);
    if (!ids.length) return res.json({ ok: false, error: 'Nothing picked.' });
    const open = (await dbAll("SELECT id FROM bk_emails WHERE id IN (" + ids.map(() => '?').join(',') + ") AND read_by IS NULL AND COALESCE(aside, 0) = 0", ids)).map(r => r.id);
    const gm = await markReadInGmail(open, userId(req)); if (!gm.ok) return res.json({ ok: false, error: gm.error });
    if (open.length) await dbRun("UPDATE bk_emails SET status = CASE WHEN status = 'parsed' THEN 'parsed' ELSE 'skipped' END, read_by = 'user', note = COALESCE(note, '') || ' — marked read by ' || ?, decided_kind = COALESCE(decided_kind, kind), decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, datetime('now')) WHERE id IN (" + open.map(() => '?').join(',') + ")", [userId(req), userId(req)].concat(open));
    for (const i of open) await audit(userId(req), 'email.read', i, { picked: true });
    res.json({ ok: true, n: open.length });
  });
  // What happened to this email, newest first: people's actions (bk_audit, ref = the email), the rating, the scan.
  app.get('/api/bookkeeping/emails/:id/history', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), em = await dbGet('SELECT id, received_at, created_at, triaged_at, kind, confidence, note, read_by, status FROM bk_emails WHERE id = ?', [id]);
    if (!em) return res.json({ ok: false, error: 'No such email' });
    const rows = await dbAll("SELECT at, who, action, detail FROM bk_audit WHERE ref = ? AND action LIKE 'email.%' ORDER BY id DESC", [String(id)]);
    const out = rows.map(r => { let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch (e) {} return { at: r.at, who: r.who, action: r.action.replace(/^email\./, ''), detail: d }; });
    if (em.triaged_at) out.push({ at: em.triaged_at, who: 'BookkeeperAI', action: 'rated', detail: { kind: em.kind, confidence: em.confidence, note: em.note } });
    if (em.created_at) out.push({ at: em.created_at, who: 'scan', action: 'scanned', detail: {} });
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({ ok: true, history: out });
  });
  // Transaction: the email is proof of a payment. GET-like first call (no choice) → the facts + candidates; with a choice →
  // attach to that bank line's / bill's purchase, or start a purchase that waits for the bank. Then the email is handled.
  app.post('/api/bookkeeping/emails/:id/transaction', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {}, who = userId(req);
    const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [id]); if (!em) return res.json({ ok: false, error: 'No such email' });
    try {
      if (!b.transaction_id && !b.bill_id && !b.wait && !b.purchase_id) {
        const x = await extractPayment(em);
        const vend = em.vendor_id ? await dbGet('SELECT id, name FROM bk_vendors WHERE id = ?', [em.vendor_id]) : null;
        const fake = { amount: x.amount, date: x.date, vendor_id: em.vendor_id };
        const txns = x.amount != null ? await suggestTxns(fake) : [];
        const bills = x.order_no ? await dbAll("SELECT id, vendor, invoice_no, total, status, purchase_id FROM bk_bills WHERE status <> 'rejected' AND REPLACE(UPPER(invoice_no), '-', '') = ? LIMIT 5", [x.order_no.toUpperCase().replace(/-/g, '')]) : [];
        const open = await dbAll("SELECT id, vendor, amount, date, order_no, received FROM bk_purchases WHERE cancelled = 0 AND confirm_email_id IS NULL AND (vendor_id = ? OR (order_no IS NOT NULL AND order_no = ?)) ORDER BY id DESC LIMIT 5", [em.vendor_id || -1, x.order_no || '']);
        return res.json({ ok: true, extract: x, vendor: vend, transactions: txns, bills, purchases: open });
      }
      let pid = parseInt(b.purchase_id) || 0; const x = b.extract || {};
      if (b.bill_id) { const bill = await dbGet('SELECT * FROM bk_bills WHERE id = ?', [parseInt(b.bill_id)]); if (!bill) throw new Error('No such bill');
        pid = bill.purchase_id || await newPurchase({ vendor_id: bill.vendor_id, vendor: bill.vendor, amount: bill.total, date: bill.invoice_date, order_no: bill.invoice_no, bill_id: bill.id }, who);
        await attachTo(pid, { confirm_email_id: id }, who);
        if (bill.status !== 'paid') await dbRun("UPDATE bk_bills SET status = 'paid', paid_at = ?, paid_note = ?, receipt_email_id = ?, updated_at = datetime('now') WHERE id = ?", [String(em.received_at || today()).slice(0, 10), 'receipt email matched by ' + who, id, bill.id]);
        await dbRun('UPDATE bk_emails SET matched_bill_id = ? WHERE id = ?', [bill.id, id]);
      } else if (b.transaction_id) { const tx = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [parseInt(b.transaction_id)]); if (!tx) throw new Error('No such transaction');
        pid = tx.purchase_id || await newPurchase({ vendor_id: tx.vendor_id || em.vendor_id, vendor: x.vendor || tx.merchant || tx.name, amount: tx.amount, date: tx.date, order_no: x.order_no || null, category: tx.category, txn_ids: [tx.id] }, who);
        await attachTo(pid, { confirm_email_id: id }, who);
        await dbRun('UPDATE bk_transactions SET receipt_email_id = ? WHERE id = ?', [id, tx.id]); await dbRun('UPDATE bk_emails SET matched_txn_id = ? WHERE id = ?', [tx.id, id]);
      } else if (pid) { await attachTo(pid, { confirm_email_id: id }, who); }
      else { pid = await newPurchase({ vendor_id: em.vendor_id, vendor: x.vendor || String(em.from_addr || '').replace(/<.*$/, '').trim(), amount: x.amount, date: x.date, order_no: x.order_no || null, confirm_email_id: id, note: x.what || null }, who); }
      try { await fillItemsFromEmail(pid, em, who); } catch (e) { errlog('items', e.message); }
      await handleEmail(em, 'receipt', who, 'transaction — purchase #' + pid + ' by ' + who);
      await audit(who, 'email.transaction', id, { purchase_id: pid, bill_id: b.bill_id || null, transaction_id: b.transaction_id || null });
      res.json({ ok: true, purchase_id: pid });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Arrival: the goods came. No choice → candidates (open purchases: order number, then same vendor, newest); with a
  // purchase → attach and set receiving (yes / partial), handle the email. A purchase can also be started by an arrival.
  app.post('/api/bookkeeping/emails/:id/arrival', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {}, who = userId(req);
    const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [id]); if (!em) return res.json({ ok: false, error: 'No such email' });
    try {
      if (!b.purchase_id && !b.start) {
        const x = await extractPayment(em);
        const byNo = x.order_no ? await dbAll("SELECT p.*, v.name AS vendor_name FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE p.cancelled = 0 AND p.received <> 'yes' AND p.order_no IS NOT NULL AND REPLACE(UPPER(p.order_no), '-', '') = ? ORDER BY p.id DESC LIMIT 5", [x.order_no.toUpperCase().replace(/-/g, '')]) : [];
        const byVendor = await dbAll("SELECT p.*, v.name AS vendor_name FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE p.cancelled = 0 AND p.received <> 'yes' AND p.vendor_id = ? AND p.date >= date('now', '-90 days') ORDER BY p.id DESC LIMIT 8", [em.vendor_id || -1]);
        const recent = await dbAll("SELECT p.*, v.name AS vendor_name FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE p.cancelled = 0 AND p.received <> 'yes' AND p.expects_delivery = 1 AND p.date >= date('now', '-60 days') ORDER BY p.id DESC LIMIT 15");
        const seen = {}; const list = [].concat(byNo.map(p => Object.assign(p, { why: 'order #' + x.order_no })), byVendor.map(p => Object.assign(p, { why: 'same vendor' })), recent.map(p => Object.assign(p, { why: '' }))).filter(p => !seen[p.id] && (seen[p.id] = 1));
        return res.json({ ok: true, extract: x, purchases: list.map(p => ({ id: p.id, vendor: p.vendor_name || p.vendor, amount: p.amount, date: p.date, order_no: p.order_no, received: p.received, why: p.why })) });
      }
      const received = b.received === 'partial' ? 'partial' : 'yes'; let pid = parseInt(b.purchase_id) || 0; const x = b.extract || {};
      if (!pid) pid = await newPurchase({ vendor_id: em.vendor_id, vendor: x.vendor || String(em.from_addr || '').replace(/<.*$/, '').trim(), amount: x.amount, date: x.date, order_no: x.order_no || null, arrival_email_ids: [id], expects_delivery: 1 }, who);
      await attachTo(pid, { arrival_email_id: id, received, note: b.note ? String(b.note).slice(0, 300) : null }, who);
      try { await fillItemsFromEmail(pid, em, who); } catch (e) { errlog('items', e.message); }
      await handleEmail(em, 'arrival', who, 'arrival — purchase #' + pid + ' (' + received + ') by ' + who);
      await audit(who, 'email.arrival', id, { purchase_id: pid, received });
      res.json({ ok: true, purchase_id: pid });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Purchases views + actions.
  app.get('/api/bookkeeping/purchases', ...guard, async (req, res) => { try { const view = String(req.query.view || 'all'); const q = String(req.query.q || '').trim(); const rows = await purchaseRows(view, q); const all = view === 'list' && !q ? rows : await purchaseRows('list', ''); res.json({ ok: true, purchases: rows, counts: { waiting: all.filter(r => r.status === 'awaiting bank').length, notreceived: all.filter(r => r.status === 'not received' || r.status === 'partly received').length } }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  // 1.19.30: link a purchase to a CRM supplier / vendor (the bill and bank lines behind it follow when they have none).
  app.post('/api/bookkeeping/purchases/:id/vendor', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), vid = parseInt(req.body && req.body.vendor_id) || null;
    const p = await dbGet('SELECT * FROM bk_purchases WHERE id = ?', [id]); if (!p) return res.json({ ok: false, error: 'No such purchase' });
    const v = vid ? await dbGet('SELECT * FROM bk_vendors WHERE id = ?', [vid]) : null; if (vid && !v) return res.json({ ok: false, error: 'No such vendor' });
    await dbRun("UPDATE bk_purchases SET vendor_id = ?, vendor = COALESCE(?, vendor), updated_at = datetime('now') WHERE id = ?", [vid, v ? v.name : null, id]);
    if (vid) {
      if (p.bill_id) await dbRun("UPDATE bk_bills SET vendor_id = ? WHERE id = ? AND (vendor_id IS NULL OR vendor_id IN (SELECT id FROM bk_vendors WHERE source = 'bill'))", [vid, p.bill_id]);
      const txns = jarr(p.txn_ids); if (txns.length) await dbRun('UPDATE bk_transactions SET vendor_id = ? WHERE vendor_id IS NULL AND id IN (' + txns.map(() => '?').join(',') + ')', [vid].concat(txns));
      if (p.vendor && req.body.remember !== false && normV(p.vendor) !== normV(v.name)) { const al = String(v.aliases || '').split('\n').filter(Boolean); if (al.indexOf(p.vendor) < 0) { al.push(String(p.vendor).slice(0, 120)); await dbRun('UPDATE bk_vendors SET aliases = ? WHERE id = ?', [al.join('\n'), vid]); dirCache.at = 0; } }
    }
    await audit(userId(req), 'purchase.vendor', id, { vendor_id: vid });
    res.json({ ok: true });
  });
  // One purchase in full, its items, and edits to them.
  app.get('/api/bookkeeping/purchases/:id', ...guard, async (req, res) => { const d = await purchaseDetail(parseInt(req.params.id)); if (!d) return res.json({ ok: false, error: 'No such purchase' }); res.json({ ok: true, purchase: d }); });
  app.post('/api/bookkeeping/purchases/:id/items', ...guard, async (req, res) => {   // the whole list, as shown: rows with an id are updated, without one inserted, missing ones removed
    const pid = parseInt(req.params.id), who = userId(req); const p = await dbGet('SELECT id FROM bk_purchases WHERE id = ?', [pid]); if (!p) return res.json({ ok: false, error: 'No such purchase' });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 80) : [];
    const keep = []; let pos = 0;
    for (const i of items) {
      const kind = ['item', 'shipping', 'tax', 'fee', 'discount'].indexOf(i.kind) > -1 ? i.kind : 'item', name = String(i.name || '').trim().slice(0, 200); if (!name) continue;
      const num = (x) => x == null || x === '' || !isFinite(Number(x)) ? null : Math.round(Number(x) * 100) / 100;
      const vals = [pos++, kind, name, num(i.qty) || 1, num(i.unit_price), num(i.amount), parseInt(i.material_id) || null, String(i.category || '').slice(0, 120) || null, /^https?:\/\//.test(String(i.photo || '')) ? String(i.photo).slice(0, 500) : null];
      if (i.id && (await dbGet('SELECT id FROM bk_purchase_items WHERE id = ? AND purchase_id = ?', [parseInt(i.id), pid]))) { await dbRun("UPDATE bk_purchase_items SET pos = ?, kind = ?, name = ?, qty = ?, unit_price = ?, amount = ?, material_id = ?, category = ?, photo = ?, updated_at = datetime('now') WHERE id = ?", vals.concat([parseInt(i.id)])); keep.push(parseInt(i.id)); }
      else { const r = await dbRun("INSERT INTO bk_purchase_items (purchase_id, pos, kind, name, qty, unit_price, amount, material_id, category, photo, source, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,'hand',?)", [pid].concat(vals, [who])); keep.push(r.lastID); }
    }
    await dbRun('DELETE FROM bk_purchase_items WHERE purchase_id = ?' + (keep.length ? ' AND id NOT IN (' + keep.map(() => '?').join(',') + ')' : ''), [pid].concat(keep));
    await audit(who, 'purchase.items', pid, { n: keep.length });
    res.json({ ok: true, purchase: await purchaseDetail(pid) });
  });
  app.post('/api/bookkeeping/purchases/:id/items/extract', ...guard, async (req, res) => {   // read the items again from one of the purchase's emails (replaces the list)
    const pid = parseInt(req.params.id), who = userId(req); const d = await purchaseDetail(pid); if (!d) return res.json({ ok: false, error: 'No such purchase' });
    const emId = parseInt(req.body && req.body.email_id) || (d.emails[0] || {}).id; if (!emId) return res.json({ ok: false, error: 'This purchase has no email to read.' });
    const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [emId]); if (!em) return res.json({ ok: false, error: 'No such email' });
    await dbRun('DELETE FROM bk_purchase_items WHERE purchase_id = ?', [pid]);
    const n = await fillItemsFromEmail(pid, em, who); await audit(who, 'purchase.items.extract', pid, { email_id: emId, n });
    res.json({ ok: true, n, purchase: await purchaseDetail(pid) });
  });
  app.get('/api/bookkeeping/materials/pick', ...guard, async (req, res) => {   // a short list for the item → material picker
    const q = String(req.query.q || '').trim().toLowerCase(); const l = '%' + q + '%';
    const rows = await dbAll('SELECT id, name, photo, geo_type, geo_sub_type, code FROM bk_materials WHERE ? = \'\' OR LOWER(name) LIKE ? OR LOWER(COALESCE(code, \'\')) LIKE ? OR LOWER(COALESCE(geo_type, \'\')) LIKE ? ORDER BY name LIMIT 40', [q, l, l, l]);
    res.json({ ok: true, materials: rows });
  });
  app.get('/api/bookkeeping/purchases/:id/suggest', ...guard, async (req, res) => { const p = await dbGet('SELECT * FROM bk_purchases WHERE id = ?', [parseInt(req.params.id)]); if (!p) return res.json({ ok: false, error: 'No such purchase' }); res.json({ ok: true, transactions: await suggestTxns(p) }); });
  app.post('/api/bookkeeping/purchases/:id/attach', ...guard, async (req, res) => { try { const pid = parseInt(req.params.id), tid = parseInt(req.body && req.body.transaction_id); if (!tid) return res.json({ ok: false, error: 'Which bank line?' }); const tx = await dbGet('SELECT id, purchase_id FROM bk_transactions WHERE id = ?', [tid]); if (!tx) return res.json({ ok: false, error: 'No such transaction' }); if (tx.purchase_id && tx.purchase_id !== pid) return res.json({ ok: false, error: 'That bank line already belongs to purchase #' + tx.purchase_id }); await attachTo(pid, { txn_id: tid }, userId(req)); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/purchases/:id/receive', ...guard, async (req, res) => {
    const pid = parseInt(req.params.id), b = req.body || {}, st = String(b.status || ''); const p = await dbGet('SELECT id FROM bk_purchases WHERE id = ?', [pid]); if (!p) return res.json({ ok: false, error: 'No such purchase' });
    if (st === 'cancel') await dbRun("UPDATE bk_purchases SET cancelled = 1, note = ?, updated_at = datetime('now') WHERE id = ?", [String(b.note || '').slice(0, 300) || null, pid]);
    else if (st === 'reopen') await dbRun("UPDATE bk_purchases SET cancelled = 0, updated_at = datetime('now') WHERE id = ?", [pid]);
    else if (['yes', 'partial', 'no'].indexOf(st) > -1) await dbRun("UPDATE bk_purchases SET received = ?, received_at = ?, received_note = ?, expects_delivery = 1, updated_at = datetime('now') WHERE id = ?", [st, st === 'no' ? null : today(), String(b.note || '').slice(0, 300) || null, pid]);
    else return res.json({ ok: false, error: 'yes, partial, no, cancel or reopen' });
    await audit(userId(req), 'purchase.receive', pid, { status: st, note: b.note || null }); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/purchases/:id/flag', ...guard, async (req, res) => {
    const pid = parseInt(req.params.id), b = req.body || {}; const sets = [], args = [];
    if (b.expects_delivery != null) { const e = b.expects_delivery ? 1 : 0; sets.push('expects_delivery = ?'); args.push(e); sets.push('received = ?'); args.push(e ? 'no' : 'na'); }
    if (b.no_paperwork != null) { sets.push('no_paperwork = ?'); args.push(b.no_paperwork ? 1 : 0); }
    if (!sets.length) return res.json({ ok: false, error: 'Nothing to change' });
    await dbRun('UPDATE bk_purchases SET ' + sets.join(', ') + ", updated_at = datetime('now') WHERE id = ?", args.concat([pid])); await audit(userId(req), 'purchase.flag', pid, b); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/purchases/alert', ...guard, async (req, res) => { try { res.json(Object.assign({ ok: true }, await alertOverdue(userId(req)))); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/emails/:id/unread', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), em = await dbGet('SELECT id, status, kind, gmail_id FROM bk_emails WHERE id = ?', [id]);
    if (!em) return res.json({ ok: false, error: 'No such email' });
    if (em.gmail_id) { try { await gmailMod().users.messages.batchModify({ userId: 'me', requestBody: { ids: [em.gmail_id], addLabelIds: ['UNREAD'] } }); } catch (e) { const msg = String(e.message || e); return res.json({ ok: false, error: (/unauthorized_client|insufficient|403|scope/i.test(msg) ? SCOPE_HELP + ' ' : '') + 'Gmail said: ' + msg.slice(0, 300) }); } }
    await dbRun("UPDATE bk_emails SET status = ?, read_by = NULL, aside = 0, note = ? WHERE id = ?", [em.status === 'parsed' ? 'parsed' : em.kind === 'message' ? 'message' : 'new', 'marked unread by ' + userId(req), id]);
    await audit(userId(req), 'email.unread', id, null); res.json({ ok: true });
  });
  // Bill: file the email as a bill. No choice → what Nova reads from it and the open purchases it could belong to
  // (same order number, then same vendor); with purchase_id (join) or new:1 → the full read (or, already read, just the
  // join) and the bill's purchase. Nothing is filed without this choice.
  app.post('/api/bookkeeping/emails/:id/bill', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {}, who = userId(req);
    const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [id]); if (!em) return res.json({ ok: false, error: 'No such email' });
    try {
      const bill = em.status === 'parsed' ? await dbGet('SELECT id, vendor, vendor_id, invoice_no, invoice_date, total, status, purchase_id FROM bk_bills WHERE email_id = ? ORDER BY id DESC LIMIT 1', [id]) : null;
      if (!b.purchase_id && !b.new) {
        const x = bill ? { vendor: bill.vendor, amount: bill.total, date: bill.invoice_date, order_no: bill.invoice_no || '', what: '' } : await extractPayment(em);
        const vid = (bill && bill.vendor_id) || em.vendor_id || -1;
        const byNo = x.order_no ? await dbAll("SELECT p.*, v.name AS vendor_name FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE p.cancelled = 0 AND p.bill_id IS NULL AND p.order_no IS NOT NULL AND REPLACE(UPPER(p.order_no), '-', '') = ? ORDER BY p.id DESC LIMIT 5", [x.order_no.toUpperCase().replace(/-/g, '')]) : [];
        const byVendor = await dbAll("SELECT p.*, v.name AS vendor_name FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE p.cancelled = 0 AND p.bill_id IS NULL AND p.vendor_id = ? AND p.date >= date('now', '-120 days') ORDER BY p.id DESC LIMIT 8", [vid]);
        const byAmount = x.amount ? await dbAll("SELECT p.*, v.name AS vendor_name FROM bk_purchases p LEFT JOIN bk_vendors v ON v.id = p.vendor_id WHERE p.cancelled = 0 AND p.bill_id IS NULL AND ABS(p.amount - ?) < 0.005 AND p.date >= date('now', '-120 days') ORDER BY p.id DESC LIMIT 5", [x.amount]) : [];
        const seen = {}; const list = [].concat(byNo.map(p => Object.assign(p, { why: 'order #' + x.order_no })), byAmount.map(p => Object.assign(p, { why: 'same amount' })), byVendor.map(p => Object.assign(p, { why: 'same vendor' }))).filter(p => !seen[p.id] && (seen[p.id] = 1));
        return res.json({ ok: true, extract: x, bill, already: !!bill, purchases: list.map(p => ({ id: p.id, vendor: p.vendor_name || p.vendor, amount: p.amount, date: p.date, order_no: p.order_no, status: purchaseStatus(p, null), why: p.why })) });
      }
      let pid = parseInt(b.purchase_id) || 0, billId = bill ? bill.id : null;
      if (pid && !(await dbGet('SELECT id FROM bk_purchases WHERE id = ?', [pid]))) throw new Error('No such purchase');
      if (!bill) { if (pid) await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [pid, id]); billId = await parseEmail(Object.assign({}, em, { purchase_id: pid || em.purchase_id }), who); const nb = await dbGet('SELECT purchase_id FROM bk_bills WHERE id = ?', [billId]); pid = nb && nb.purchase_id || pid; }
      else if (pid) { await attachTo(pid, { bill_id: bill.id }, who); await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [pid, id]); try { await fillItemsFromBill(pid, await dbGet('SELECT * FROM bk_bills WHERE id = ?', [bill.id]), who); } catch (e) {} }
      else if (!bill.purchase_id) { pid = await newPurchase({ vendor_id: bill.vendor_id, vendor: bill.vendor, amount: bill.total, date: bill.invoice_date, order_no: bill.invoice_no, bill_id: bill.id }, who); await dbRun('UPDATE bk_emails SET purchase_id = ? WHERE id = ?', [pid, id]); try { await fillItemsFromBill(pid, await dbGet('SELECT * FROM bk_bills WHERE id = ?', [bill.id]), who); } catch (e) {} }
      else pid = bill.purchase_id;
      await audit(who, 'email.bill.purchase', id, { bill_id: billId, purchase_id: pid, joined: !!b.purchase_id });
      res.json({ ok: true, bill_id: billId, purchase_id: pid });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/emails/:id/parse', ...guard, async (req, res) => {
    const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [parseInt(req.params.id)]);
    if (!em) return res.json({ ok: false, error: 'No such email' });
    try { const id = await parseEmail(em, userId(req)); res.json({ ok: true, bill_id: id }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/bookkeeping/vendors/pick', ...guard, async (req, res) => res.json({ ok: true, vendors: await dbAll('SELECT id, name, kind, photo, email FROM bk_vendors ORDER BY name') }));
  app.get('/api/bookkeeping/rules', ...guard, async (req, res) => res.json({ ok: true, rules: await dbAll('SELECT * FROM bk_rules WHERE active = 1 ORDER BY id DESC'), vendors: await dbAll('SELECT * FROM bk_vendors ORDER BY name') }));
  app.post('/api/bookkeeping/rules', ...guard, async (req, res) => {
    const b = req.body || {};
    if (b.kind === 'none') {   // 1.19.112: "No rule for vendor"
      const pat = String(b.pattern || '').trim().slice(0, 120); if (!pat) return res.json({ ok: false, error: 'A vendor name is needed.' });
      const dup = await dbGet("SELECT id FROM bk_rules WHERE kind IN ('vendor', 'none') AND LOWER(pattern) = LOWER(?) AND active = 1", [pat]);
      if (dup) return res.json({ ok: false, error: 'There is already a rule for ' + pat + ' — remove it first.' });
      const n = await dbRun('INSERT INTO bk_rules (kind, pattern, category, vendor, source, created_by) VALUES (?,?,?,?,?,?)', ['none', pat, null, pat, 'manual', userId(req)]);
      await audit(userId(req), 'rule.none', n.lastID, { pattern: pat });
      return res.json({ ok: true, id: n.lastID, applied: 0 });
    }
    if (!b.pattern || !b.category) return res.json({ ok: false, error: 'Pattern and category are needed.' });
    const am = amountCond(b); if (am.error) return res.json({ ok: false, error: am.error });
    const r = await dbRun('INSERT INTO bk_rules (kind, pattern, category, vendor, note, source, created_by, amount_op, amount_val) VALUES (?,?,?,?,?,?,?,?,?)', [b.kind === 'keyword' ? 'keyword' : 'vendor', String(b.pattern).slice(0, 120), String(b.category).slice(0, 80), b.kind === 'keyword' ? null : String(b.pattern).slice(0, 120), String(b.note || '').slice(0, 300), 'manual', userId(req), am.op, am.val]);
    const applied = await applyRules();
    await audit(userId(req), 'rule.add', r.lastID, Object.assign({ applied }, b));
    res.json({ ok: true, id: r.lastID, applied });
  });
  // 1.19.77: edit a rule. GET …/:id/scope says what an edit would touch; POST …/:id {kind, pattern, category, apply} changes
  // it and, with apply, re-categorizes every bank line the rule categorized (category_source 'rule') to the new category —
  // without apply those lines keep what they have and only future lines follow the new rule.
  app.get('/api/bookkeeping/rules/:id/scope', ...guard, async (req, res) => {
    const id = parseInt(req.params.id);
    const r = await dbGet('SELECT * FROM bk_rules WHERE id = ? AND active = 1', [id]);
    if (!r) return res.json({ ok: false, error: 'No such rule' });
    const by = await dbGet("SELECT COUNT(*) n, COALESCE(SUM(amount), 0) total FROM bk_transactions WHERE rule_id = ? AND category_source = 'rule' AND status = 'categorized'", [id]);
    res.json({ ok: true, rule: r, lines: by.n, total: by.total });
  });
  app.post('/api/bookkeeping/rules/:id', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {};
    const r = await dbGet('SELECT * FROM bk_rules WHERE id = ? AND active = 1', [id]);
    if (!r) return res.json({ ok: false, error: 'No such rule' });
    const kind = b.kind === 'keyword' ? 'keyword' : b.kind === 'none' ? 'none' : 'vendor', pattern = String(b.pattern || r.pattern).trim().slice(0, 120), category = kind === 'none' ? null : String(b.category || r.category || '').trim().slice(0, 80);
    if (!pattern || (kind !== 'none' && !category)) return res.json({ ok: false, error: 'Pattern and category are needed.' });
    if (category && !chartOf(await settings()).some(c => c.name === category)) return res.json({ ok: false, error: 'Not a category in the chart of accounts: ' + category });
    const am = kind === 'none' ? { op: null, val: null } : amountCond(b); if (am.error) return res.json({ ok: false, error: am.error });
    await dbRun('UPDATE bk_rules SET kind = ?, pattern = ?, category = ?, vendor = ?, amount_op = ?, amount_val = ? WHERE id = ?', [kind, pattern, category, kind === 'keyword' ? null : pattern, am.op, am.val, id]);
    let applied = 0;
    if (b.apply && category && category !== r.category) {
      const u = await dbRun("UPDATE bk_transactions SET category = ?, updated_at = datetime('now') WHERE rule_id = ? AND category_source = 'rule' AND status = 'categorized'", [category, id]);
      applied = u.changes || 0;
    }
    applied += await applyRules();
    await audit(userId(req), 'rule.edit', id, { from: { kind: r.kind, pattern: r.pattern, category: r.category, amount_op: r.amount_op, amount_val: r.amount_val }, to: { kind, pattern, category, amount_op: am.op, amount_val: am.val }, applied });
    res.json({ ok: true, applied });
  });
  app.delete('/api/bookkeeping/rules/:id', ...guard, async (req, res) => { await dbRun('UPDATE bk_rules SET active = 0 WHERE id = ?', [parseInt(req.params.id)]); await audit(userId(req), 'rule.remove', req.params.id); res.json({ ok: true }); });
  app.get('/api/bookkeeping/directory', ...guard, async (req, res) => {
    if (req.query.fresh !== '0') await syncDirectoryIfStale(userId(req), 10 * 60000);
    const rows = await dbAll("SELECT v.*, CASE v.source WHEN 'suppliers' THEN 'supplier' WHEN 'vendors' THEN 'vendor' WHEN 'bill' THEN 'bill' WHEN 'nova' THEN 'nova' ELSE COALESCE(v.kind, 'other') END AS kind, (SELECT COUNT(*) FROM bk_transactions t WHERE t.vendor_id = v.id) AS txns, (SELECT COUNT(*) FROM bk_bills b WHERE b.vendor_id = v.id AND b.status <> ?) AS bills FROM bk_vendors v ORDER BY v.name", ['rejected']);
    const last = await dbGet("SELECT at FROM bk_audit WHERE action = 'directory.sync' ORDER BY id DESC LIMIT 1");
    const sup = await suppliesByVendor();
    rows.forEach(v => { const s = sup[v.id]; v.materials = s ? s.n : 0; v.geo_types = s ? topKeys(s.geo, 4) : []; });
    res.json({ ok: true, vendors: rows, synced_at: last ? last.at : null, sync_error: dirSync.error, lists: CRM_LISTS.map(kindOf), crm: !!runQuery });
  });
  // The materials catalog with its GEO types (read-only mirror of CRM → Materials).
  app.get('/api/bookkeeping/materials', ...guard, async (req, res) => {
    if (req.query.fresh !== '0') await syncDirectoryIfStale(userId(req), 10 * 60000);
    const rows = await dbAll('SELECT m.*, v.name AS supplier, v.photo AS supplier_photo FROM bk_materials m LEFT JOIN bk_vendors v ON v.id = m.vendor_id ORDER BY m.geo_type, m.geo_sub_type, m.name');
    const geo = {}; rows.forEach(r => { const g = r.geo_type || '— no GEO type —'; (geo[g] = geo[g] || {}); const sb = r.geo_sub_type || '—'; geo[g][sb] = (geo[g][sb] || 0) + 1; });
    const unlinked = {}; rows.filter(r => r.supplier_text && !r.vendor_id).forEach(r => { unlinked[r.supplier_text] = (unlinked[r.supplier_text] || 0) + 1; });
    const last = await dbGet("SELECT at FROM bk_audit WHERE action = 'directory.sync' ORDER BY id DESC LIMIT 1");
    res.json({ ok: true, materials: rows, geo, unlinked, synced_at: last ? last.at : null, sync_error: dirSync.error, crm: !!runQuery });
  });
  // Equipment: the machine list with its financing. The CRM part syncs with the directory; the money part is edited here.
  // 1.19.99: Loans & leases — every liability in one list (standalone loans + machines financed under Equipment) with the
  // amortized balance, and a small balance-sheet view: equipment book value against what is still owed.
  app.get('/api/bookkeeping/loans', ...guard, async (req, res) => {
    try {
      const loans = await loanRows();
      const eq = await equipmentRows();
      const assets = eq.filter(e => e.book && e.book.now != null).reduce((n, e) => n + e.book.now, 0);
      const active = loans.filter(l => l.status === 'active');
      const owed = active.reduce((n, l) => n + (l.balance || 0), 0), monthly = active.reduce((n, l) => n + ((l.math && l.math.payment) || l.schedule.monthly || 0), 0);
      res.json({ ok: true, loans, vendors: await dbAll('SELECT id, name, photo FROM bk_vendors ORDER BY name COLLATE NOCASE'), equipment: eq.map(e => ({ id: e.id, name: e.name, photo: e.photo, mode: e.mode })),
        sheet: { equipment_value: Math.round(assets * 100) / 100, owed: Math.round(owed * 100) / 100, monthly: Math.round(monthly * 100) / 100, net: Math.round((assets - owed) * 100) / 100, loans: active.length } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  const LOAN_F = ['name', 'kind', 'lender', 'vendor_id', 'equipment_id', 'principal', 'down_payment', 'deferred_months', 'start_date', 'term_months', 'apr', 'monthly', 'balloon', 'total_payback', 'sales_tax', 'tax_in', 'property_tax_monthly', 'down_to', 'notes', 'status'];   // down_to: who got the down payment — finance (the lender) or manufacturer (1.19.137)
  const loanBody = (b) => { const o = {}; LOAN_F.forEach(k => { if (b[k] === undefined) return; let v = b[k]; if (['vendor_id', 'equipment_id', 'term_months', 'deferred_months', 'tax_in'].indexOf(k) > -1) v = v === '' || v == null ? null : parseInt(String(v).replace(/[^0-9-]/g, '')); else if (['principal', 'apr', 'monthly', 'balloon', 'down_payment', 'total_payback', 'sales_tax', 'property_tax_monthly'].indexOf(k) > -1) { v = v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')); if (v != null && !isFinite(v)) v = null; } else v = v == null ? null : String(v).trim().slice(0, 500); o[k] = v; }); if (o.kind && ['loan', 'lease', 'credit_line'].indexOf(o.kind) < 0) o.kind = 'loan'; if (o.status && ['active', 'paid'].indexOf(o.status) < 0) o.status = 'active'; return o; };
  app.post('/api/bookkeeping/loans', ...guard, async (req, res) => {
    const o = loanBody(req.body || {}); if (!o.name) return res.json({ ok: false, error: 'Give the loan a name.' });
    const keys = Object.keys(o); const r = await dbRun('INSERT INTO bk_loans (' + keys.join(', ') + ', created_by, updated_at) VALUES (' + keys.map(() => '?').join(', ') + ', ?, ?)', keys.map(k => o[k]).concat([userId(req), nowIso()]));
    await audit(userId(req), 'loan.add', r.lastID, o); res.json({ ok: true, id: r.lastID });
  });
  app.post('/api/bookkeeping/loans/:id', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), o = loanBody(req.body || {}); const keys = Object.keys(o); if (!keys.length) return res.json({ ok: false, error: 'Nothing to change' });
    await dbRun('UPDATE bk_loans SET ' + keys.map(k => k + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?', keys.map(k => o[k]).concat([nowIso(), id]));
    await audit(userId(req), 'loan.edit', id, o); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/loans/:id/delete', ...guard, async (req, res) => {
    const id = parseInt(req.params.id); await dbRun('UPDATE bk_transactions SET loan_id = NULL WHERE loan_id = ?', [id]); await dbRun('DELETE FROM bk_loans WHERE id = ?', [id]);
    for (const f of await dbAll("SELECT * FROM bk_files WHERE kind = 'loan' AND ref_id = ?", [id])) removeFile(f);
    await dbRun("DELETE FROM bk_files WHERE kind = 'loan' AND ref_id = ?", [id]);
    await audit(userId(req), 'loan.delete', id); res.json({ ok: true });
  });
  // 1.19.136: documents on a loan — the signed contract, the terms, payment schedules. Raw body (the page sends the file as is,
  // its name in X-File-Name); the type is read from the first bytes, never from the browser; 25 MB each; kept in FILES/loans.
  const FILE_KINDS = [[/^%PDF/, 'application/pdf', 'pdf'], [/^\x89PNG/, 'image/png', 'png'], [/^\xff\xd8\xff/, 'image/jpeg', 'jpg'], [/^PK\x03\x04/, null, 'zip']];
  function sniffFile(buf, name) {
    const head = buf.slice(0, 8).toString('latin1');
    for (const [re, mime, ext] of FILE_KINDS) if (re.test(head)) {
      if (ext !== 'zip') return { mime, ext };
      const zipHas = (s) => buf.indexOf(s) > -1 && buf.indexOf(s) < 4000;   // the first local header names the first entry
      if (zipHas('word/')) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
      if (zipHas('xl/')) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
      return null;
    }
    return null;
  }
  const removeFile = (f) => { const full = path.resolve(FILES, f.file); if (full.indexOf(path.resolve(FILES)) === 0) { try { fs.unlinkSync(full); } catch (e) {} } };
  const fileRow = (f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, label: f.label, uploaded_by: f.uploaded_by, created_at: f.created_at, ext: String(f.file).split('.').pop() });
  app.get('/api/bookkeeping/loans/:id/files', ...guard, async (req, res) => {
    res.json({ ok: true, files: (await dbAll("SELECT * FROM bk_files WHERE kind = 'loan' AND ref_id = ? ORDER BY id", [parseInt(req.params.id)])).map(fileRow) });
  });
  app.post('/api/bookkeeping/loans/:id/files', ...guard, require('express').raw({ type: () => true, limit: 25 * 1024 * 1024 + 1024 }), async (req, res) => {
    try {
      const id = parseInt(req.params.id); const loan = await dbGet('SELECT id FROM bk_loans WHERE id = ?', [id]); if (!loan) return res.status(404).json({ ok: false, error: 'No such loan' });
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); if (!buf.length) return res.json({ ok: false, error: 'Empty file' });
      if (buf.length > 25 * 1024 * 1024) return res.json({ ok: false, error: 'Files up to 25 MB' });
      const kind = sniffFile(buf); if (!kind) return res.json({ ok: false, error: 'PDF, picture (PNG / JPG), Word or Excel files only' });
      let name = decodeURIComponent(String(req.get('x-file-name') || '')).replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 160) || ('document.' + kind.ext);
      const dir = path.join(FILES, 'loans'); fs.mkdirSync(dir, { recursive: true });
      const file = 'loans/' + id + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + kind.ext;
      fs.writeFileSync(path.join(FILES, file), buf);
      const label = String(req.get('x-file-label') || '').slice(0, 80) || null;
      const r = await dbRun('INSERT INTO bk_files (kind, ref_id, name, mime, size, file, label, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['loan', id, name, kind.mime, buf.length, file, label, userId(req), nowIso()]);
      await audit(userId(req), 'loan.file', id, { file_id: r.lastID, name, size: buf.length });
      res.json({ ok: true, file: fileRow(await dbGet('SELECT * FROM bk_files WHERE id = ?', [r.lastID])) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/bookkeeping/files/:id', ...guard, async (req, res) => {
    const f = await dbGet('SELECT * FROM bk_files WHERE id = ?', [parseInt(req.params.id)]);
    if (!f) return res.status(404).type('text/plain').send('No file');
    const full = path.resolve(FILES, f.file);
    if (full.indexOf(path.resolve(FILES)) !== 0 || !fs.existsSync(full)) return res.status(404).type('text/plain').send('No file');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + '; filename="' + String(f.name || f.file).replace(/["\\]/g, '') + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.type(f.mime || 'application/octet-stream');
    fs.createReadStream(full).pipe(res);
  });
  app.post('/api/bookkeeping/files/:id/delete', ...guard, async (req, res) => {
    const f = await dbGet('SELECT * FROM bk_files WHERE id = ?', [parseInt(req.params.id)]); if (!f) return res.json({ ok: false, error: 'No such file' });
    removeFile(f); await dbRun('DELETE FROM bk_files WHERE id = ?', [f.id]);
    await audit(userId(req), 'loan.file.delete', f.ref_id, { file_id: f.id, name: f.name }); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/files/:id', ...guard, async (req, res) => {   // rename / relabel
    const f = await dbGet('SELECT * FROM bk_files WHERE id = ?', [parseInt(req.params.id)]); if (!f) return res.json({ ok: false, error: 'No such file' });
    await dbRun('UPDATE bk_files SET name = ?, label = ? WHERE id = ?', [String(req.body.name || f.name).slice(0, 160), req.body.label == null ? f.label : String(req.body.label).slice(0, 80) || null, f.id]); res.json({ ok: true });
  });
  // a bank line is a payment on a loan: link it and file it under the chart's Loan Payment (Principal) when that exists
  app.post('/api/bookkeeping/transactions/:id/loan', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), lid = req.body.loan_id == null ? null : parseInt(req.body.loan_id);
    if (!lid) { await dbRun('UPDATE bk_transactions SET loan_id = NULL WHERE id = ?', [id]); await audit(userId(req), 'txn.loan', id, { loan_id: null }); return res.json({ ok: true }); }
    const l = await dbGet('SELECT * FROM bk_loans WHERE id = ?', [lid]); if (!l) return res.json({ ok: false, error: 'No such loan' });
    const names = chartOf(await settings()).map(c => c.name), cat = ['Loan Payment (Principal)', 'Loan Payment'].find(n => names.indexOf(n) > -1) || null;
    await dbRun("UPDATE bk_transactions SET loan_id = ?, updated_at = datetime('now')" + (cat ? ", category = ?, category_source = 'manual', status = 'categorized'" : '') + ' WHERE id = ?', cat ? [lid, cat, id] : [lid, id]);
    if (l.vendor_id) await dbRun('UPDATE bk_transactions SET vendor_id = ?, vendor_by = COALESCE(vendor_by, ?) WHERE id = ? AND vendor_id IS NULL', [l.vendor_id, 'auto', id]);
    await audit(userId(req), 'txn.loan', id, { loan_id: lid, category: cat }); res.json({ ok: true, category: cat });
  });
  // 1.19.119: overseas team endpoints
  const TEAM_F = ['name', 'country', 'department', 'pay', 'period', 'category', 'category_alt', 'wise_ref', 'start_date', 'end_date', 'status', 'notes'];
  const teamBody = (b) => { const o = {}; TEAM_F.forEach(k => { if (b[k] === undefined) return; let v = b[k]; if (k === 'pay') v = v === '' || v == null ? null : Math.round(Number(v) * 100) / 100; else v = v == null ? null : String(v).trim().slice(0, k === 'notes' ? 1000 : 120) || null; o[k] = v; }); if (o.department && !DEPTS[o.department]) o.department = 'other'; if (o.period && o.period !== 'monthly') o.period = 'semi'; if (o.status && o.status !== 'left') o.status = 'active'; return o; };
  async function teamRows() {
    const rows = await teamMembers();
    for (const m of rows) {
      m.dept = DEPTS[m.department] || m.department || ''; m.country_name = COUNTRIES[m.country] || m.country || '';
      const p = await dbGet("SELECT COUNT(*) n, SUM(amount) total, MAX(date) last, MIN(date) first FROM bk_transactions WHERE team_id = ? AND status NOT IN ('removed', 'excluded')", [m.id]);
      m.paid = { n: p.n || 0, total: Math.round((p.total || 0) * 100) / 100, last: p.last || null, first: p.first || null };
      const lastLine = await dbGet("SELECT amount FROM bk_transactions WHERE team_id = ? AND status NOT IN ('removed', 'excluded') ORDER BY date DESC LIMIT 1", [m.id]);
      m.last_amount = lastLine ? Number(lastLine.amount) : null;
    }
    return rows;
  }
  app.get('/api/bookkeeping/team', ...guard, async (req, res) => {
    try {
      const open = await dbGet("SELECT COUNT(*) n, SUM(amount) total FROM bk_transactions WHERE status IN ('new', 'pending') AND team_id IS NULL AND amount > 0 AND (name LIKE '%wise%' OR merchant LIKE '%wise%')");
      res.json({ ok: true, members: await teamRows(), depts: DEPTS, countries: COUNTRIES, open_wise: { n: open.n || 0, total: Math.round((open.total || 0) * 100) / 100 } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  async function ensureTeamVendor(m, who) {
    if (m.vendor_id) { await dbRun('UPDATE bk_vendors SET name = ?, specialty = ?, default_category = ? WHERE id = ? AND source = ?', [m.name, (DEPTS[m.department] || 'Team') + ' · overseas team', m.category || null, m.vendor_id, 'nova']); dirCache.at = 0; return m.vendor_id; }
    const dup = await dbGet('SELECT id FROM bk_vendors WHERE lower(name) = lower(?) AND source = ?', [m.name, 'nova']);
    if (dup) { dirCache.at = 0; return dup.id; }
    const r = await dbRun('INSERT INTO bk_vendors (name, source, kind, approved, approved_by, approved_at, default_category, specialty, notes) VALUES (?,?,?,?,?,?,?,?,?)', [m.name, 'nova', 'team', 1, who, nowIso(), m.category || null, (DEPTS[m.department] || 'Team') + ' · overseas team', 'Overseas team member (paid through Wise). Made by the Overseas Team tab.']);
    dirCache.at = 0; return r.lastID;
  }
  app.post('/api/bookkeeping/team', ...guard, async (req, res) => {
    try {
      const o = teamBody(req.body || {}); if (!o.name) return res.json({ ok: false, error: 'Give the person a name.' });
      if (o.category && !chartOf(await settings()).some(c => c.name === o.category)) return res.json({ ok: false, error: 'Not a category in the chart of accounts: ' + o.category });
      const keys = Object.keys(o); const r = await dbRun('INSERT INTO bk_team (' + keys.join(', ') + ', created_by, updated_at) VALUES (' + keys.map(() => '?').join(', ') + ', ?, ?)', keys.map(k => o[k]).concat([userId(req), nowIso()]));
      const vid = await ensureTeamVendor(Object.assign({ id: r.lastID }, o), userId(req)); await dbRun('UPDATE bk_team SET vendor_id = ? WHERE id = ?', [vid, r.lastID]);
      const linked = await applyTeam();
      await audit(userId(req), 'team.add', r.lastID, Object.assign({ linked }, o)); res.json({ ok: true, id: r.lastID, linked });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/team/:id', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), m = await dbGet('SELECT * FROM bk_team WHERE id = ?', [id]); if (!m) return res.json({ ok: false, error: 'No such team member' });
      const o = teamBody(req.body || {}); const keys = Object.keys(o); if (!keys.length) return res.json({ ok: false, error: 'Nothing to change' });
      if (o.category && !chartOf(await settings()).some(c => c.name === o.category)) return res.json({ ok: false, error: 'Not a category in the chart of accounts: ' + o.category });
      await dbRun('UPDATE bk_team SET ' + keys.map(k => k + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?', keys.map(k => o[k]).concat([nowIso(), id]));
      const after = Object.assign({}, m, o); const vid = await ensureTeamVendor(after, userId(req)); if (vid !== m.vendor_id) await dbRun('UPDATE bk_team SET vendor_id = ? WHERE id = ?', [vid, id]);
      const linked = await applyTeam();
      await audit(userId(req), 'team.edit', id, Object.assign({ linked }, o)); res.json({ ok: true, linked });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/team/:id/delete', ...guard, async (req, res) => {
    const id = parseInt(req.params.id); await dbRun('UPDATE bk_transactions SET team_id = NULL WHERE team_id = ?', [id]); await dbRun('DELETE FROM bk_team WHERE id = ?', [id]);
    await audit(userId(req), 'team.delete', id); res.json({ ok: true });
  });
  // a bank line is a payout to this person: link + file it; `remember` stores the line's amount as the person's pay from now on
  app.post('/api/bookkeeping/transactions/:id/team', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), tid = req.body.team_id == null ? null : parseInt(req.body.team_id);
      const t = await dbGet('SELECT * FROM bk_transactions WHERE id = ?', [id]); if (!t) return res.json({ ok: false, error: 'No such line' });
      if (!tid) { await dbRun("UPDATE bk_transactions SET team_id = NULL, vendor_id = CASE WHEN vendor_by = 'team' THEN NULL ELSE vendor_id END, vendor_by = CASE WHEN vendor_by = 'team' THEN NULL ELSE vendor_by END, category = CASE WHEN category_source = 'team' THEN NULL ELSE category END, category_source = CASE WHEN category_source = 'team' THEN NULL ELSE category_source END, status = CASE WHEN category_source = 'team' THEN 'pending' ELSE status END, updated_at = datetime('now') WHERE id = ?", [id]); await audit(userId(req), 'txn.team', id, { team_id: null }); return res.json({ ok: true }); }
      const m = await dbGet('SELECT * FROM bk_team WHERE id = ?', [tid]); if (!m) return res.json({ ok: false, error: 'No such team member' });
      if (!m.vendor_id) { m.vendor_id = await ensureTeamVendor(m, userId(req)); await dbRun('UPDATE bk_team SET vendor_id = ? WHERE id = ?', [m.vendor_id, tid]); }
      await linkTeam(t, m, userId(req), 'person');
      if (req.body.remember) { await dbRun('UPDATE bk_team SET pay = ?, updated_at = ? WHERE id = ?', [Math.abs(Number(t.amount)), nowIso(), tid]); await applyTeam(); }
      res.json({ ok: true, category: m.category });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/bookkeeping/equipment', ...guard, async (req, res) => {
    if (req.query.fresh !== '0') await syncDirectoryIfStale(userId(req), 10 * 60000);
    try { res.json({ ok: true, equipment: await equipmentRows(), vendors: await dbAll('SELECT id, name, kind, photo FROM bk_vendors ORDER BY name'), crm: !!runQuery }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // The payments the books link to one machine (bank lines and bills), newest first.
  app.get('/api/bookkeeping/equipment/:id/payments', ...guard, async (req, res) => {
    const id = parseInt(req.params.id);
    const txns = await dbAll('SELECT id, date, name, merchant, amount, category, account_name, purchase_id FROM bk_transactions WHERE equipment_id = ? ORDER BY date DESC LIMIT 200', [id]);
    const bills = await dbAll('SELECT id, vendor, invoice_no, invoice_date, due_date, total, status FROM bk_bills WHERE equipment_id = ? ORDER BY invoice_date DESC LIMIT 200', [id]);
    res.json({ ok: true, transactions: txns, bills });
  });
  app.post('/api/bookkeeping/equipment/:id', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {};
    const e = await dbGet('SELECT * FROM bk_equipment WHERE id = ?', [id]); if (!e) return res.json({ ok: false, error: 'No such machine' });
    const mode = ['owned', 'loan', 'lease'].indexOf(b.mode) > -1 ? b.mode : null;
    const num = (k) => b[k] === '' || b[k] == null ? null : (isFinite(Number(b[k])) ? Number(b[k]) : null);
    const day = (k) => /^\d{4}-\d{2}-\d{2}$/.test(String(b[k] || '')) ? b[k] : null;
    const vendorId = parseInt(b.vendor_id) || null;
    if (vendorId && !(await dbGet('SELECT id FROM bk_vendors WHERE id = ?', [vendorId]))) return res.json({ ok: false, error: 'No such vendor' });
    const row = { vendor_id: vendorId, mode, purchase_price: num('purchase_price'), purchase_date: day('purchase_date'), down_payment: num('down_payment'), loan_amount: num('loan_amount'), loan_term: num('loan_term'), loan_rate: num('loan_rate'), loan_start: day('loan_start'), monthly_payment: num('monthly_payment'),
      lease_term: num('lease_term'), lease_start: day('lease_start'), lease_monthly: num('lease_monthly'), life_years: num('life_years'), salvage: num('salvage'), notes: String(b.notes || '').slice(0, 1000) || null };
    if (mode === 'loan' && row.loan_amount == null && row.purchase_price != null) row.loan_amount = Math.round(((row.purchase_price || 0) - (row.down_payment || 0)) * 100) / 100;   // the loan is what was not paid down
    if (mode === 'loan' && !row.loan_start) row.loan_start = row.purchase_date;
    const keys = Object.keys(row);
    await dbRun('UPDATE bk_equipment SET ' + keys.map(k => k + ' = ?').join(', ') + ", updated_by = ?, updated_at = datetime('now') WHERE id = ?", keys.map(k => row[k]).concat([userId(req), id]));
    await audit(userId(req), 'equipment.update', id, { name: e.name, before: keys.reduce((o, k) => { o[k] = e[k]; return o; }, {}), after: row });
    // link the payments already in the books that now belong to this machine (same vendor, the monthly amount)
    let linked = 0;
    if (vendorId && (mode === 'loan' || mode === 'lease')) {
      const monthly = mode === 'lease' ? row.lease_monthly : row.monthly_payment;
      if (monthly) {
        const r1 = await dbRun('UPDATE bk_transactions SET equipment_id = ? WHERE equipment_id IS NULL AND vendor_id = ? AND ABS(ABS(amount) - ?) < 0.005', [id, vendorId, monthly]);
        const r2 = await dbRun("UPDATE bk_bills SET equipment_id = ? WHERE equipment_id IS NULL AND vendor_id = ? AND ABS(total - ?) < 0.005 AND status <> 'rejected'", [id, vendorId, monthly]);
        await dbRun("UPDATE bk_purchases SET equipment_id = ? WHERE equipment_id IS NULL AND (bill_id IN (SELECT id FROM bk_bills WHERE equipment_id = ?) OR EXISTS (SELECT 1 FROM bk_transactions t WHERE t.equipment_id = ? AND bk_purchases.txn_ids LIKE '%' || t.id || '%'))", [id, id, id]);
        linked = (r1.changes || 0) + (r2.changes || 0);
      }
    }
    res.json({ ok: true, linked });
  });
  // A machine bought outside the CRM list (or before it existed) — a row of our own, no crm_id.
  app.post('/api/bookkeeping/equipment', ...guard, async (req, res) => {
    const name = String(req.body && req.body.name || '').trim().slice(0, 200); if (!name) return res.json({ ok: false, error: 'A name is needed.' });
    const r = await dbRun("INSERT INTO bk_equipment (name, team, active, updated_by, updated_at) VALUES (?,?,1,?,datetime('now'))", [name, String(req.body.team || '').slice(0, 100) || null, userId(req)]);
    await audit(userId(req), 'equipment.add', r.lastID, { name }); res.json({ ok: true, id: r.lastID });
  });
  app.post('/api/bookkeeping/equipment/:id/link', ...guard, async (req, res) => {   // attach / detach one bank line or bill by hand
    const id = parseInt(req.params.id), b = req.body || {}, on = b.off ? null : id;
    if (b.transaction_id) await dbRun('UPDATE bk_transactions SET equipment_id = ? WHERE id = ?', [on, parseInt(b.transaction_id)]);
    if (b.bill_id) await dbRun('UPDATE bk_bills SET equipment_id = ? WHERE id = ?', [on, parseInt(b.bill_id)]);
    await audit(userId(req), 'equipment.link', id, b); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/directory/sync', ...guard, async (req, res) => { try { dirCache.at = 0; res.json(Object.assign({ ok: true }, await syncDirectory(userId(req)))); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/transactions/:id/vendor', ...guard, async (req, res) => {
    const vid = parseInt(req.body.vendor_id) || null, id = parseInt(req.params.id);
    const t = await dbGet('SELECT id, name, merchant, raw FROM bk_transactions WHERE id = ?', [id]);
    await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = ?, vendor_score = ?, suggest_vendor_id = NULL, suggest_score = NULL WHERE id = ?", [vid, vid ? 'person' : null, vid ? 1 : null, id]);
    // 1.19.65: a Nova / bill vendor without a photo takes the merchant logo and website the bank knows for this line
    if (vid && t) { try { const raw = JSON.parse(t.raw || '{}'), v = await dbGet('SELECT id, source, photo, details FROM bk_vendors WHERE id = ?', [vid]);
      if (v && (v.source === 'nova' || v.source === 'bill')) { const sets = [], args = []; let d = {}; try { d = JSON.parse(v.details || '{}') || {}; } catch (e) {}
        if (!v.photo && raw.logo_url) { sets.push('photo = ?'); args.push(raw.logo_url); }
        let dChanged = false;
        if (!d.website && raw.website) { d.website = raw.website; dChanged = true; }
        const loc = raw.location || {};
        if (!d.plaid && (raw.merchant_entity_id || loc.city || loc.address)) { d.plaid = { entity_id: raw.merchant_entity_id || undefined, address: loc.address || undefined, city: loc.city || undefined, region: loc.region || undefined, postal_code: loc.postal_code || undefined, category: raw.personal_finance_category ? raw.personal_finance_category.primary : undefined }; dChanged = true; }
        if (dChanged) { sets.push('details = ?'); args.push(JSON.stringify(d)); }
        if (sets.length) { await dbRun('UPDATE bk_vendors SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([vid])); dirCache.at = 0; } } } catch (e) {} }
    // 1.19.47: the same bank wording elsewhere (unlinked, or linked by the machine) follows — and every future line too, through the alias.
    if (vid && t && isWise(t.merchant || t.name)) req.body.alias = false;   // 1.19.119: every Wise payout shares the same wording — never learn it as an alias
    let learned = null, relinked = 0;
    if (vid && t && req.body.alias !== false) { const text = t.merchant || t.name;
      // 1.19.130: learn the vendor's own words from the line, not the whole line — "emperor steel", not the ACH noise around it
      if (!req.body.alias) { const vn = await dbGet('SELECT name FROM bk_vendors WHERE id = ?', [vid]); const ph = vn ? vendorPhrase(vn.name, text) : ''; if (ph && ph !== normV(vn.name)) { req.body.alias = ph; learned = ph; } }
      req.body.alias = req.body.alias || text;

      await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = 'auto', vendor_score = 1, suggest_vendor_id = NULL, suggest_score = NULL WHERE id <> ? AND (vendor_id IS NULL OR vendor_by = 'auto') AND LOWER(COALESCE(merchant, name)) = LOWER(?)", [vid, id, text]); }
      // 1.19.91: and every line whose wording differs only by a per-payment code (Stripe transfer ids, check / ref numbers)
      const ns = stableV(t.merchant || t.name); if (ns.length >= 6) { const open = await dbAll("SELECT id, name, merchant FROM bk_transactions WHERE id <> ? AND vendor_id IS NULL AND status NOT IN ('removed', 'excluded')", [id]);
        for (const o of open) if (stableV(o.merchant || o.name) === ns) await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = 'auto', vendor_score = 1, suggest_vendor_id = NULL, suggest_score = NULL WHERE id = ? AND vendor_id IS NULL", [vid, o.id]); }
    // Remember the bank line as an alias of that vendor, so the next one matches by itself.
    if (vid && req.body.alias) { const v = await dbGet('SELECT aliases FROM bk_vendors WHERE id = ?', [vid]); const al = String(v && v.aliases || '').split('\n').filter(Boolean); if (al.indexOf(req.body.alias) < 0) { al.push(String(req.body.alias).slice(0, 120)); await dbRun('UPDATE bk_vendors SET aliases = ? WHERE id = ?', [al.join('\n'), vid]); dirCache.at = 0; } }
    if (vid) { try { relinked = await relinkVendor(vid); } catch (e) { errlog('relink', e.message); } }   // 1.19.130: the alias just learned catches the rest
    await audit(userId(req), 'transaction.vendor', req.params.id, { vendor_id: vid, alias: req.body.alias, learned, relinked });
    res.json({ ok: true, learned, relinked });
  });
  // 1.19.63: Nova vendors — companies kept only here (the landlord, LinkedIn, a one-off contractor…), not in the CRM lists.
  // source 'nova'; the chart of accounts is their map: `default_category` = what we buy from them, `specialty` = in words.
  const VFIELDS = ['email', 'phone', 'contact', 'address', 'specialty', 'notes'];
  // 1.19.77: a vendor photo is an https URL or a small data: image (the form shrinks uploads to 160px) — anything else is dropped
  const vendorPhoto = (p) => { p = String(p || '').trim(); if (/^https?:\/\/\S{4,500}$/.test(p)) return p; if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(p) && p.length <= 200000) return p; return null; };
  app.post('/api/bookkeeping/vendors', ...guard, async (req, res) => {
    try {
      const b = req.body || {}, name = String(b.name || '').trim().slice(0, 120);
      if (!name) return res.json({ ok: false, error: 'Give the company a name' });
      const dup = await dbGet('SELECT id, name, source FROM bk_vendors WHERE lower(name) = lower(?)', [name]);
      if (dup && !b.force) return res.json({ ok: false, error: '"' + dup.name + '" is already in the directory' + (dup.source === 'nova' ? ' as a Nova vendor' : ' (from the CRM)'), duplicate: dup });
      const details = JSON.stringify({ website: String(b.website || '').trim().slice(0, 200) || undefined });
      const r = await dbRun('INSERT INTO bk_vendors (name, source, kind, approved, approved_by, approved_at, default_category, aliases, details, photo, ' + VFIELDS.join(', ') + ') VALUES (?,?,?,?,?,?,?,?,?,?' + VFIELDS.map(() => ',?').join('') + ')',
        [name, 'nova', 'nova', 1, userId(req), nowIso(), String(b.default_category || '').slice(0, 300) || null, String(b.aliases || '').slice(0, 1000) || null, details, vendorPhoto(b.photo)].concat(VFIELDS.map(k => String(b[k] || '').slice(0, 500) || null)));
      dirCache.at = 0;
      await audit(userId(req), 'vendor.new', r.lastID, { name });
      res.json({ ok: true, vendor: await dbGet('SELECT * FROM bk_vendors WHERE id = ?', [r.lastID]) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 1.19.66: the Nova vendors with everything the bank has told us about them — logo, website, place, bank category,
  // how they are paid, how much and how often.
  app.get('/api/bookkeeping/vendors/nova', ...guard, async (req, res) => {
    try {
      const rows = await dbAll("SELECT v.*, (SELECT COUNT(*) FROM bk_transactions t WHERE t.vendor_id = v.id AND t.status NOT IN ('removed','excluded')) AS txns, (SELECT COUNT(*) FROM bk_bills b WHERE b.vendor_id = v.id AND b.status <> 'rejected') AS bills, " +
        "(SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) FROM bk_transactions t WHERE t.vendor_id = v.id AND t.status NOT IN ('removed','excluded')) AS spent, (SELECT MAX(date) FROM bk_transactions t WHERE t.vendor_id = v.id AND t.status NOT IN ('removed','excluded')) AS last_date, (SELECT MIN(date) FROM bk_transactions t WHERE t.vendor_id = v.id AND t.status NOT IN ('removed','excluded')) AS first_date " +
        "FROM bk_vendors v WHERE v.source = 'nova' ORDER BY v.name COLLATE NOCASE");
      for (const v of rows) {
        let d = {}; try { d = JSON.parse(v.details || '{}') || {}; } catch (e) {}
        const last = await dbGet("SELECT raw, account_name FROM bk_transactions WHERE vendor_id = ? AND status NOT IN ('removed','excluded') ORDER BY date DESC LIMIT 1", [v.id]);
        let raw = null; try { raw = last && last.raw ? JSON.parse(last.raw) : null; } catch (e) {}
        const loc = raw && raw.location || {};
        const chans = await dbAll("SELECT json_extract(raw, '$.payment_channel') ch, COUNT(*) n FROM bk_transactions WHERE vendor_id = ? AND status NOT IN ('removed','excluded') GROUP BY ch ORDER BY n DESC", [v.id]).catch(() => []);
        const accts = await dbAll("SELECT ba.institution, t.account_name, COUNT(*) n FROM bk_transactions t LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id WHERE t.vendor_id = ? AND t.status NOT IN ('removed','excluded') GROUP BY ba.institution, t.account_name ORDER BY n DESC LIMIT 3", [v.id]).catch(() => []);
        v.bank = {
          website: d.website || (raw && raw.website) || null,
          logo: v.photo || (raw && raw.logo_url) || null,
          place: [loc.address, [loc.city, loc.region].filter(Boolean).join(', '), loc.postal_code].filter(Boolean).join(' · ') || (d.plaid ? [d.plaid.address, [d.plaid.city, d.plaid.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : ''),
          category: raw && raw.personal_finance_category ? (raw.personal_finance_category.detailed || raw.personal_finance_category.primary) : (d.plaid && d.plaid.category) || null,
          channels: chans.filter(c => c.ch).map(c => ({ channel: c.ch, n: c.n })),
          accounts: accts.map(a => ({ bank: a.institution, account: a.account_name, n: a.n })),
          spent: v.spent || 0, txns: v.txns, first: v.first_date, last: v.last_date,
          monthly: v.spent && v.first_date && v.last_date ? Math.round(v.spent / Math.max(1, (new Date(v.last_date) - new Date(v.first_date)) / 2629800000 + 1)) : null
        };
        if (!v.photo && v.bank.logo) { await dbRun('UPDATE bk_vendors SET photo = ? WHERE id = ? AND photo IS NULL', [v.bank.logo, v.id]).catch(() => {}); v.photo = v.bank.logo; }
      }
      res.json({ ok: true, vendors: rows });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/vendors/:id/delete', ...guard, async (req, res) => {
    try {
      const v = await dbGet('SELECT * FROM bk_vendors WHERE id = ?', [parseInt(req.params.id)]);
      if (!v) return res.json({ ok: false, error: 'No such vendor' });
      if (v.source !== 'nova' && v.source !== 'bill') return res.json({ ok: false, error: 'CRM companies are removed in the CRM' });
      const used = (await dbGet('SELECT (SELECT COUNT(*) FROM bk_transactions WHERE vendor_id = ?) + (SELECT COUNT(*) FROM bk_bills WHERE vendor_id = ?) + (SELECT COUNT(*) FROM bk_purchases WHERE vendor_id = ?) n', [v.id, v.id, v.id])).n;
      if (used) return res.json({ ok: false, error: 'Still linked to ' + used + ' line' + (used === 1 ? '' : 's') + ' — unlink those first' });
      await dbRun('DELETE FROM bk_vendors WHERE id = ?', [v.id]); dirCache.at = 0;
      await audit(userId(req), 'vendor.delete', v.id, { name: v.name });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/vendors/:id', ...guard, async (req, res) => {
    // Partial update: only the fields sent change (the tab autosaves one field at a time).
    const b = req.body || {}, sets = [], args = [];
    const cur = await dbGet('SELECT source, details FROM bk_vendors WHERE id = ?', [parseInt(req.params.id)]);
    if (cur && (cur.source === 'nova' || cur.source === 'bill')) {   // the CRM owns these fields for its own companies
      if (b.name !== undefined && String(b.name).trim()) { sets.push('name = ?'); args.push(String(b.name).trim().slice(0, 120)); }
      VFIELDS.forEach(k => { if (b[k] !== undefined) { sets.push(k + ' = ?'); args.push(String(b[k] || '').slice(0, 500) || null); } });
      if (b.website !== undefined) { let d = {}; try { d = JSON.parse(cur.details || '{}') || {}; } catch (e) {} d.website = String(b.website || '').trim().slice(0, 200) || undefined; sets.push('details = ?'); args.push(JSON.stringify(d)); }
      if (b.photo !== undefined) { sets.push('photo = ?'); args.push(vendorPhoto(b.photo)); }   // 1.19.77: a logo URL or a small picture uploaded from the form
    }
    if (b.default_category !== undefined) { sets.push('default_category = ?'); args.push(String(b.default_category || '').slice(0, 300) || null); }
    if (b.notes !== undefined) { sets.push('notes = ?'); args.push(String(b.notes || '').slice(0, 500) || null); }
    if (b.aliases !== undefined) { sets.push('aliases = ?'); args.push(String(b.aliases || '').slice(0, 1000) || null); }
    if (b.approved !== undefined) { sets.push('approved = ?, approved_by = ?, approved_at = ?'); args.push(b.approved ? 1 : 0, userId(req), nowIso()); }
    if (!sets.length) return res.json({ ok: false, error: 'Nothing to change' });
    await dbRun('UPDATE bk_vendors SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([parseInt(req.params.id)]));
    dirCache.at = 0;
    let relinked = 0; if (b.aliases !== undefined || b.name !== undefined) { try { relinked = await relinkVendor(parseInt(req.params.id)); } catch (e) { errlog('relink', e.message); } }   // 1.19.130: a bank name typed in links the open lines now
    await audit(userId(req), 'vendor.update', req.params.id, Object.assign({ relinked }, b)); res.json({ ok: true, relinked });
  });
  app.get('/api/bookkeeping/activity', ...guard, async (req, res) => res.json({ ok: true, runs: await dbAll('SELECT * FROM bk_runs ORDER BY id DESC LIMIT 40'), audit: await dbAll('SELECT * FROM bk_audit ORDER BY id DESC LIMIT 200'), briefs: await dbAll('SELECT day, stats, posted_at, post_error FROM bk_briefs ORDER BY day DESC LIMIT 30') }));
  app.post('/api/bookkeeping/settings', ...guard, async (req, res) => {
    const b = req.body || {};
    for (const k of ['run_at', 'poll_min', 'threshold', 'notes', 'chat_webhook', 'backfill_days', 'triage_ad', 'triage_bill', 'triage_notice', 'triage_message', 'triage_auto', 'notreceived_days', 'waiting_days', 'alert_to', 'alert_at', 'ar_to', 'ar_cc', 'baskets']) if (b[k] !== undefined) await setSetting(k, b[k] === true ? 1 : b[k] === false ? 0 : b[k], userId(req));
    if (b.categories !== undefined) await saveChart(parseChartText(b.categories, chartTree(await settings())), userId(req));
    await audit(userId(req), 'settings', null, Object.keys(b));
    res.json({ ok: true, settings: await settings() });
  });
  // The chart as a tree with colors / icons, and where each name is used.
  app.get('/api/bookkeeping/chart', ...guard, async (req, res) => {
    const tree = chartTree(await settings()); const usage = {};
    for (const n of categoriesOf({ chart_json: JSON.stringify(tree) })) usage[n] = await categoryUsage(n);
    res.json({ ok: true, tree, usage });
  });
  // Replace the whole tree (order, colors, icons, additions). A sub category that is in use cannot vanish this way —
  // rename it (POST /chart/rename) or keep it; this keeps every categorized transaction pointing at a real category.
  app.post('/api/bookkeeping/chart', ...guard, async (req, res) => {
    const next = normTree(req.body && req.body.tree);
    if (!next.length) return res.json({ ok: false, error: 'The chart cannot be empty.' });
    const before = categoriesOf(await settings()), after = categoriesOf({ chart_json: JSON.stringify(next) });
    const gone = [];
    for (const n of before) if (after.indexOf(n) < 0) { const u = await categoryUsage(n); if (u.txns || u.rules || u.vendors) gone.push(n + ' (' + [u.txns && u.txns + ' transactions', u.rules && u.rules + ' rules', u.vendors && u.vendors + ' vendors'].filter(Boolean).join(', ') + ')'); }
    if (gone.length) return res.json({ ok: false, error: 'In use, rename instead of removing: ' + gone.join('; ') });
    const tree = await saveChart(next, userId(req));
    await audit(userId(req), 'chart.save', null, { types: tree.length, categories: after.length });
    const s = await settings();
    res.json({ ok: true, tree, chart: chartOf(s) });
  });
  app.post('/api/bookkeeping/chart/rename', ...guard, async (req, res) => {
    const r = await renameCategory(req.body && req.body.from, req.body && req.body.to, userId(req));
    if (!r.ok) return res.json(r);
    res.json({ ok: true, tree: r.tree, chart: chartOf(await settings()) });
  });
  // Add a category: { name, parent } — a sub category under a type of expense (the parent is created when new), or a new type on its own.
  app.post('/api/bookkeeping/categories', ...guard, async (req, res) => {
    const name = String(req.body && req.body.name || '').trim().slice(0, 80), parent = String(req.body && req.body.parent || '').trim().slice(0, 80);
    if (!name) return res.json({ ok: false, error: 'A name is needed.' });
    const s = await settings();
    if (chartOf(s).some(c => c.name === name && (c.parent || '') === parent)) return res.json({ ok: true, settings: s, chart: chartOf(s), category: name });
    await addCategory(name, parent, userId(req));
    await audit(userId(req), 'category.add', null, { name, parent });
    const s2 = await settings();
    res.json({ ok: true, settings: Object.assign({}, s2, { chat_webhook: s2.chat_webhook ? '(set)' : '' }), chart: chartOf(s2), category: name });
  });
  app.post('/api/bookkeeping/run', ...guard, async (req, res) => res.json(await runDaily('manual', userId(req), { post: !!(req.body && req.body.post) })));
  // The tab drives the rating itself so the person can watch: fetch → rate 25 at a time → read the rated bills one by one.
  app.post('/api/bookkeeping/inbox/reset', ...guard, async (req, res) => { try { const r = await resetInbox(userId(req)); res.json({ ok: true, reset: r }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  // Move an email to another basket by hand (ad / confirmation / message / bill / other). The rating is replaced,
  // the note says who moved it; a bill still has to be read with "Turn into a bill".
  app.post('/api/bookkeeping/emails/:id/kind', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), kind = String(req.body && req.body.kind || '');
    if (['advertisement', 'arrival', 'receipt', 'bill', 'message', 'other', 'aside'].indexOf(kind) < 0) return res.json({ ok: false, error: 'Which basket?' });
    const em = await dbGet('SELECT id, status, read_by, aside FROM bk_emails WHERE id = ?', [id]); if (!em) return res.json({ ok: false, error: 'No such email' });
    if (em.status === 'parsed') return res.json({ ok: false, error: 'It is a bill draft already.' });
    if (kind === 'aside') {   // Set aside is the manual basket: parked by a person, rating kept, Gmail untouched
      await dbRun("UPDATE bk_emails SET status = 'skipped', aside = 1, read_by = 'user', note = ? WHERE id = ?", ['do later by ' + userId(req), id]);
      await audit(userId(req), 'email.move', id, { kind }); return res.json({ ok: true });
    }
    // read in Gmail already → only the rating changes (it stays under Everything else); otherwise it is open again
    const status = em.read_by === 'gmail' && !em.aside ? em.status : kind === 'message' ? 'message' : 'new';
    await dbRun("UPDATE bk_emails SET kind = ?, confidence = 1, status = ?, aside = 0, triaged_at = COALESCE(triaged_at, datetime('now')), note = ? WHERE id = ?", [kind, status, 'moved to ' + kind + ' by ' + userId(req), id]);
    await audit(userId(req), 'email.move', id, { kind }); await decideEmail(id, kind, userId(req)); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/inbox/fetch', ...guard, async (req, res) => { try { const r = await scanInbox(userId(req)); const left = await dbGet("SELECT COUNT(*) n FROM bk_emails WHERE " + TO_RATE); res.json({ ok: true, scan: r, to_rate: left.n }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/inbox/rate', ...guard, async (req, res) => {
    try { const r = await triageEmails(userId(req), Math.min(50, parseInt(req.body && req.body.limit) || 25)); const left = await dbGet("SELECT COUNT(*) n FROM bk_emails WHERE " + TO_RATE); const s = await settings();
      res.json({ ok: true, items: r.items, remaining: left.n, bills_to_read: [] }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Set aside every rated email of these kinds at or above the confidence (a person's decision, in one click).
  app.post('/api/bookkeeping/inbox/set-aside', ...guard, async (req, res) => {
    const kinds = (Array.isArray(req.body && req.body.kinds) ? req.body.kinds : []).filter(k => ['advertisement', 'arrival', 'receipt', 'other', 'bill', 'message'].indexOf(k) > -1);
    const min = Math.max(0, Math.min(1, Number(req.body && req.body.min) || 0));
    if (!kinds.length) return res.json({ ok: false, error: 'Which kinds?' });
    const ids = (await dbAll("SELECT id FROM bk_emails WHERE read_by IS NULL AND COALESCE(aside, 0) = 0 AND status <> 'error' AND kind IN (" + kinds.map(() => '?').join(',') + ") AND COALESCE(confidence, 0) >= ?", kinds.concat([min]))).map(r => r.id);
    const gm = await markReadInGmail(ids, userId(req)); if (!gm.ok) return res.json({ ok: false, error: gm.error });   // Gmail first; nothing changes here unless it changed there
    const r = ids.length ? await dbRun("UPDATE bk_emails SET status = CASE WHEN status = 'parsed' THEN 'parsed' ELSE 'skipped' END, read_by = 'user', note = COALESCE(note, '') || ' — marked read by ' || ?, decided_kind = COALESCE(decided_kind, kind), decided_by = COALESCE(decided_by, ?), decided_at = COALESCE(decided_at, datetime('now')) WHERE id IN (" + ids.map(() => '?').join(',') + ")", [userId(req), userId(req)].concat(ids)) : { changes: 0 };
    await audit(userId(req), 'email.set_aside', null, { kinds, min, n: r.changes });
    for (const i of ids) await audit(userId(req), 'email.read', i, { basket: kinds.join('/') });
    res.json({ ok: true, n: r.changes, gmail: gm });
  });
  app.post('/api/bookkeeping/scan', ...guard, async (req, res) => { try { const r = await scanInbox(userId(req)); const p = await parseNewEmails(userId(req)); res.json({ ok: true, scan: r, parsed: p }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  // 1.19.47: the sandbox test data goes away once real banks are connected — sandbox connections, their bank lines, the
  // proposals / questions about those lines, and purchases that held only those lines (bills and emails are real, they stay).
  // 1.19.57: which accounts of a connection are in use. Excluded accounts' lines are kept but hidden everywhere (status
  // 'excluded', their old status in prev_status) and come back as they were when the account is ticked again.
  app.post('/api/bookkeeping/plaid/items/:id/accounts', ...guard, async (req, res) => {
    try {
      const row = await dbGet('SELECT * FROM bk_accounts WHERE id = ?', [parseInt(req.params.id)]);
      if (!row) return res.json({ ok: false, error: 'No such connection' });
      let all = []; try { all = JSON.parse(row.accounts || '[]').map(a => a.account_id); } catch (e) {}
      const excluded = (Array.isArray(req.body.excluded) ? req.body.excluded : []).map(String).filter(id => all.indexOf(id) > -1);
      if (excluded.length === all.length && all.length) return res.json({ ok: false, error: 'Keep at least one account in use — or Disconnect the bank.' });
      await dbRun('UPDATE bk_accounts SET excluded = ? WHERE id = ?', [JSON.stringify(excluded), row.id]);
      let off = 0, on = 0;
      for (const id of all) {
        if (excluded.indexOf(id) > -1) off += (await dbRun("UPDATE bk_transactions SET prev_status = status, status = 'excluded', updated_at = datetime('now') WHERE item_id = ? AND account_ref = ? AND status NOT IN ('removed', 'excluded')", [row.item_id, id])).changes || 0;
        else on += (await dbRun("UPDATE bk_transactions SET status = COALESCE(prev_status, 'new'), prev_status = NULL, updated_at = datetime('now') WHERE item_id = ? AND account_ref = ? AND status = 'excluded'", [row.item_id, id])).changes || 0;
      }
      await audit(userId(req), 'plaid.accounts', row.item_id, { excluded, hidden: off, restored: on });
      res.json({ ok: true, excluded, hidden: off, restored: on });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/plaid/purge-sandbox', ...guard, async (req, res) => {
    try {
      const items = await dbAll("SELECT id, item_id, institution FROM bk_accounts WHERE env = 'sandbox' OR env IS NULL");
      let txns = 0, purchases = 0;
      // 1.19.55: test lines also survive as orphans — their connection already removed, or Plaid's sandbox account
      // names ("Plaid Checking", "Plaid CD") — so sweep those too, not only the connections still listed
      const groups = items.map(it => ({ it, where: 't.item_id = ?', args: [it.item_id] }));
      groups.push({ it: null, where: "(t.item_id NOT IN (SELECT item_id FROM bk_accounts) OR t.account_name LIKE 'Plaid %')", args: [] });
      for (const g of groups) {
        const it = g.it;
        const ids = (await dbAll('SELECT t.id FROM bk_transactions t WHERE ' + g.where, g.args)).map(r => r.id);
        if (ids.length) {
          const inList = '(' + ids.map(() => '?').join(',') + ')';
          await dbRun("DELETE FROM bk_proposals WHERE ref_table = 'bk_transactions' AND ref_id IN " + inList, ids).catch(() => {});
          await dbRun("DELETE FROM bk_questions WHERE proposal_id IS NOT NULL AND proposal_id NOT IN (SELECT id FROM bk_proposals)", []).catch(() => {});
          for (const pu of await dbAll('SELECT id, txn_ids, bill_id, confirm_email_id, arrival_email_ids FROM bk_purchases')) {
            const tx = jarr(pu.txn_ids); if (!tx.length) continue;
            const left = tx.filter(x => ids.indexOf(Number(x)) < 0);
            if (left.length === tx.length) continue;
            if (!left.length && !pu.bill_id && !pu.confirm_email_id && !jarr(pu.arrival_email_ids).length) { await dbRun('DELETE FROM bk_purchase_items WHERE purchase_id = ?', [pu.id]); await dbRun('DELETE FROM bk_purchases WHERE id = ?', [pu.id]); purchases++; }
            else await dbRun('UPDATE bk_purchases SET txn_ids = ? WHERE id = ?', [JSON.stringify(left), pu.id]);
          }
          await dbRun('DELETE FROM bk_transactions WHERE id IN ' + inList, ids); txns += ids.length;
        }
        if (it) await dbRun('DELETE FROM bk_accounts WHERE id = ?', [it.id]);
      }
      purchases += await dropOrphanPurchases();
      await dbRun("DELETE FROM bk_proposals WHERE ref_table = 'bk_transactions' AND ref_id NOT IN (SELECT id FROM bk_transactions)").catch(() => {});
      await audit(userId(req), 'plaid.purge_sandbox', null, { connections: items.map(i => i.institution), transactions: txns, purchases });
      res.json({ ok: true, connections: items.length, transactions: txns, purchases });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/sync', ...guard, async (req, res) => { try { res.json({ ok: true, sync: await syncAll(userId(req)), categorized: await categorize(userId(req)) }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/brief', ...guard, async (req, res) => {
    const b = await composeBrief(laDay(), null);
    let posted = null;
    if (req.body && req.body.post) { try { posted = await postChat(b.text); await dbRun("UPDATE bk_briefs SET posted_at = datetime('now'), post_error = NULL WHERE day = ?", [laDay()]); } catch (e) { posted = { error: e.message }; } }
    res.json({ ok: true, brief: b, posted });
  });
  app.post('/api/bookkeeping/chat/test', ...guard, async (req, res) => { try { res.json({ ok: true, posted: await postChat('Hello from BookkeeperAI — the connection works. ' + userId(req) + ' sent this test from Nova.') }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/gmail/watch', ...guard, async (req, res) => { try { res.json({ ok: true, watch: await startWatch() }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  // The conversation in the tab (same brain as Google Chat).
  app.get('/api/bookkeeping/chat', ...guard, async (req, res) => res.json({ ok: true, messages: await dbAll('SELECT id, at, channel, sender, direction, text FROM bk_chat ORDER BY id DESC LIMIT 60').then(r => r.reverse()) }));
  app.post('/api/bookkeeping/chat', ...guard, async (req, res) => {
    try { res.json({ ok: true, reply: await converse('nova', userId(req), String(req.body.text || ''), { name: req.user.username || userId(req) }) }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Plaid Link: a link token for the browser, then the public token comes back and is swapped for the access token.
  app.post('/api/bookkeeping/plaid/link-token', ...guard, async (req, res) => {
    if (!plaidReady()) return res.json({ ok: false, error: 'PLAID_CLIENT_ID and PLAID_SECRET are not in .env yet.' });
    try {
      const j = await plaid('/link/token/create', { user: { client_user_id: 'axiomprint-books' }, client_name: 'AxiomPrint BookkeeperAI', products: ['transactions'], country_codes: ['US'], language: 'en',
        webhook: NOVA_URL + '/api/bookkeeping/plaid/webhook', transactions: { days_requested: 90 },
        // 1.19.46: OAuth banks (Chase, Bank of America, Wells Fargo, Capital One…) send the person back here after
        // signing in at the bank. The same address must be in the Plaid dashboard: Team Settings → API → Allowed redirect URIs.
        redirect_uri: NOVA_URL + '/bookkeeping/plaid-oauth' });
      res.json({ ok: true, link_token: j.link_token, env: PLAID_ENV });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/plaid/exchange', ...guard, async (req, res) => {
    try {
      const j = await plaid('/item/public_token/exchange', { public_token: String(req.body.public_token || '') });
      let inst = String((req.body.metadata && req.body.metadata.institution && req.body.metadata.institution.name) || 'Bank');
      const instId = String((req.body.metadata && req.body.metadata.institution && req.body.metadata.institution.institution_id) || '') || null;
      const accts = (req.body.metadata && req.body.metadata.accounts || []).map(a => ({ account_id: a.id, name: a.name, mask: a.mask, type: a.subtype || a.type }));
      await dbRun('INSERT INTO bk_accounts (item_id, access_token, institution, accounts, created_by, env, institution_id) VALUES (?,?,?,?,?,' + JSON.stringify(PLAID_ENV) + ',?) ON CONFLICT(item_id) DO UPDATE SET access_token = excluded.access_token, institution = excluded.institution, accounts = excluded.accounts, env = excluded.env, institution_id = excluded.institution_id, logo = NULL',
        [j.item_id, enc(j.access_token), inst, JSON.stringify(accts), userId(req), instId]);
      ensureLogos().catch(() => {});
      await audit(userId(req), 'plaid.connect', j.item_id, { institution: inst, accounts: accts.map(a => a.name) });
      const row = await dbGet('SELECT * FROM bk_accounts WHERE item_id = ?', [j.item_id]);
      let first = null; try { first = await syncItem(row, userId(req)); await categorize(userId(req)); } catch (e) { first = { error: e.message }; }
      res.json({ ok: true, item_id: j.item_id, institution: inst, first_sync: first });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.delete('/api/bookkeeping/plaid/:id', ...guard, async (req, res) => {
    const row = await dbGet('SELECT * FROM bk_accounts WHERE id = ?', [parseInt(req.params.id)]);
    if (!row) return res.json({ ok: false, error: 'No such connection' });
    try { await plaid('/item/remove', { access_token: dec(row.access_token) }); } catch (e) {}
    await dbRun('DELETE FROM bk_accounts WHERE id = ?', [row.id]);
    await audit(userId(req), 'plaid.disconnect', row.item_id, row.institution);
    res.json({ ok: true });
  });

  return { isBookkeeper, runDaily, converse, settings, runChatTool };
};
