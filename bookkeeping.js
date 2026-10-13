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
    ['vendor_by TEXT', 'vendor_score REAL', 'suggest_vendor_id INTEGER', 'suggest_score REAL'].forEach(c => db.run('ALTER TABLE bk_transactions ADD COLUMN ' + c, () => {}));   // 1.19.47: who linked the vendor (auto ≥ 95% / person) and the best near match
    db.run(`CREATE TABLE IF NOT EXISTS bk_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, txn_id TEXT UNIQUE, item_id TEXT, account_ref TEXT,
      account_name TEXT, date TEXT, name TEXT, merchant TEXT, amount REAL, pending INTEGER DEFAULT 0, plaid_category TEXT,
      category TEXT, category_source TEXT, rule_id INTEGER, proposal_id INTEGER, status TEXT DEFAULT 'new', raw TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    db.run('CREATE INDEX IF NOT EXISTS bk_txn_date ON bk_transactions(date)');
    db.run(`CREATE TABLE IF NOT EXISTS bk_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, pattern TEXT, category TEXT, vendor TEXT,
      note TEXT, source TEXT, created_by TEXT, hits INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`);
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
    notreceived_days: 30, waiting_days: 30, alert_to: env('BOOKKEEPER_ALERT_TO') || 'gary@axiomprint.com', alert_at: '08:00', gmail_history_id: '', gmail_watch_expires: '',
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
      out.push({ name, color, icon: iconKey(t.icon), delivery, children: kids });
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
    chartTree(s).forEach(t => { out.push({ name: t.name, parent: null, children: t.children.length, color: t.color, icon: t.icon, delivery: t.delivery }); t.children.forEach(c => { const cd = c.delivery == null ? t.delivery : c.delivery; out.push({ name: c.name, parent: t.name, top: t.name, children: (c.children || []).length, color: t.color, icon: c.icon || t.icon, delivery: cd, delivery_own: c.delivery }); (c.children || []).forEach(g => out.push({ name: g.name, parent: c.name, top: t.name, level: 3, color: t.color, icon: g.icon || c.icon || t.icon, delivery: g.delivery == null ? cd : g.delivery, delivery_own: g.delivery })); }); }); return out; }
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
    return rows.map(r => { let a = []; try { a = JSON.parse(r.accounts || '[]'); } catch (e) {} return Object.assign({}, r, { access_token: undefined, accounts: a }); });
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
      for (const t of (j.added || []).concat(j.modified || [])) {
        const isNew = !(await dbGet('SELECT id FROM bk_transactions WHERE txn_id = ?', [t.transaction_id]));
        const cat = t.personal_finance_category ? (t.personal_finance_category.detailed || t.personal_finance_category.primary) : (t.category || []).join(' > ');
        if (isNew) {
          const ins = await dbRun('INSERT INTO bk_transactions (txn_id, item_id, account_ref, account_name, date, name, merchant, amount, pending, plaid_category, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [t.transaction_id, row.item_id, t.account_id, names[t.account_id] || null, t.date, t.name, t.merchant_name || null, Number(t.amount), t.pending ? 1 : 0, cat, JSON.stringify(t).slice(0, 20000)]);
          added++;
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
    const rows = await dbAll("SELECT id, vendor_id, name, merchant, amount, date, category FROM bk_transactions WHERE purchase_id IS NULL AND category IS NOT NULL AND status NOT IN ('new', 'pending') AND amount > 0 LIMIT 300");
    for (const t of rows) { const v = t.vendor_id ? await dbGet('SELECT name FROM bk_vendors WHERE id = ?', [t.vendor_id]) : null; const pid = await newPurchase({ vendor_id: t.vendor_id, vendor: v ? v.name : (t.merchant || t.name), amount: t.amount, date: t.date, category: t.category, txn_ids: [t.id], no_paperwork: 1 }, 'bank');  const eq = await equipmentFor(t.vendor_id, t.amount); if (eq) { await dbRun('UPDATE bk_transactions SET equipment_id = ? WHERE id = ? AND equipment_id IS NULL', [eq, t.id]); await dbRun('UPDATE bk_purchases SET equipment_id = ? WHERE id = ?', [eq, pid]); } }
    return rows.length;
  }
  // Bank lines that could be the purchase's payment: same amount to the cent, not in a purchase, within 10 days; same vendor first.
  async function suggestTxns(p) {
    if (p.amount == null) return [];
    const rows = await dbAll("SELECT id, date, name, merchant, amount, category, vendor_id, account_name FROM bk_transactions WHERE purchase_id IS NULL AND ABS(ABS(amount) - ?) < 0.005 AND date BETWEEN date(?, '-10 days') AND date(?, '+20 days') ORDER BY date DESC LIMIT 10", [Math.abs(p.amount), p.date || today(), p.date || today()]);
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
  const normV = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(inc|llc|corp|corporation|co|company|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const domainOf = (e) => { const m = String(e || '').toLowerCase().match(/@([a-z0-9.-]+)/); return m ? m[1].replace(/^(www|mail|e)\./, '') : ''; };
  const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn)\./;
  // The CRM lists that make up the directory. Each table is a type (suppliers → Supplier, vendors → Vendor); a new
  // list in the CRM is added with BOOKKEEPER_CRM_LISTS=suppliers,vendors,contractors — same columns expected.
  const CRM_LISTS = String(env('BOOKKEEPER_CRM_LISTS') || 'suppliers,vendors').split(',').map(x => x.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean);
  const kindOf = (t) => t === 'suppliers' ? 'supplier' : t === 'vendors' ? 'vendor' : t === 'bill' ? 'bill' : String(t || '').replace(/s$/, '') || 'other';
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
    return rows.map(e => {
      const out = Object.assign({}, e);
      const p = paid[e.id] || { n: 0, total: 0, last: null }, b = bills[e.id] || { n: 0, total: 0 };
      out.payments = { n: p.n, total: Math.round((p.total || 0) * 100) / 100, last: p.last, bills: b.n, billed: Math.round((b.total || 0) * 100) / 100 };
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
    dirCache = { at: Date.now(), list: rows.map(v => Object.assign({}, v, { _n: normV(v.name), _al: String(v.aliases || '').split('\n').filter(a => a.indexOf('@') < 0).map(normV).filter(Boolean), _em: String(v.aliases || '').split('\n').map(a => a.trim().toLowerCase()).filter(a => a.indexOf('@') > 0), _dom: domainOf(v.email) })) };
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
    const name = normName(t.merchant || t.name), full = normName(t.name + ' ' + (t.merchant || ''));
    return rules.find(r => r.kind === 'vendor' ? normName(r.pattern) === name : full.indexOf(normName(r.pattern)) > -1) || null;
  }
  async function categorize(who) {
    const s = await settings();
    const rules = await dbAll('SELECT * FROM bk_rules WHERE active = 1 ORDER BY kind DESC, id');
    const txns = await dbAll("SELECT * FROM bk_transactions WHERE status = 'new' ORDER BY date DESC LIMIT 80");   // 1.19.51: lines still pending at the bank get a suggestion too
    let byRule = 0, proposed = 0, asked = 0;
    const open = [];
    for (const t of txns) {
      const dv = await matchVendor(t.merchant || t.name);
      if (dv && !t.vendor_id) { await dbRun('UPDATE bk_transactions SET vendor_id = ? WHERE id = ?', [dv.id, t.id]); t.vendor_id = dv.id; t._vendor = dv; }
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
      const prior = (await dbAll("SELECT merchant, name, category FROM bk_transactions WHERE status = 'categorized' ORDER BY updated_at DESC LIMIT 60"))
        .map(x => (x.merchant || x.name) + ' → ' + x.category).filter((v, k, a) => a.indexOf(v) === k).slice(0, 40).join('\n');
      // What the owner answered when asked before — the words matter ("Uber rides are personal", "SparkFun is parts for the cutter").
      const lessons = (await dbAll("SELECT q.question, q.answer, p.title FROM bk_questions q JOIN bk_proposals p ON p.id = q.proposal_id WHERE q.answer IS NOT NULL AND q.answer <> '' AND q.answer NOT LIKE '→ %' ORDER BY q.answered_at DESC LIMIT 30"))
        .map(x => '- ' + x.title.replace(/ → .*$/, '') + ': asked "' + x.question + '" — answer: ' + x.answer).join('\n');
      let j = null;
      try {
        const r = await anthropic.messages.create({ model: MODEL, max_tokens: 2500, system: SYS(s) + '\n' + await dirLine(), messages: [{ role: 'user', content:
          'Bank transactions (amount: - means money out, + means money in). Propose a category for each from the chart of accounts.\n' + listing +
          (prior ? '\n\nHOW WE CATEGORIZED BEFORE (approved):\n' + prior : '') +
          (lessons ? '\n\nWHAT THE OWNER TOLD US WHEN WE ASKED (apply these to similar transactions instead of asking again):\n' + lessons : '') +
          '\n\nReturn ONLY JSON: {"items": [{"id": <id>, "category": "", "vendor": "<clean vendor name>", "confidence": 0.0, "reason": "<one short line>", "ask": "<a question for the owner ONLY if you cannot tell, else empty>"}]}' }] });
        j = jsonOf((r.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
      } catch (e) { errlog('categorize', e.message); }
      for (const t of batch) {
        const it = j && Array.isArray(j.items) ? j.items.find(x => Number(x.id) === t.id) : null;
        const cats = categoriesOf(s);
        const category = it && cats.indexOf(String(it.category)) > -1 ? String(it.category) : (it && it.category ? String(it.category).slice(0, 80) : 'Uncategorized');
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
        if (vendor && !(await dbGet('SELECT id FROM bk_rules WHERE kind = ? AND LOWER(pattern) = LOWER(?) AND active = 1', ['vendor', vendor]))) {
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
    const where = ["t.status <> 'removed'"], p = [];
    // 1.19.47: Pending = nothing decided yet (new or proposed); New = synced in the last 24 hours; Categorized = done.
    if (st === 'pending') where.push("t.status IN ('new', 'pending')");
    else if (st === 'new') where.push("t.created_at >= datetime('now', '-1 day')");
    else if (st) { where.push('t.status = ?'); p.push(st); }
    if (q) { where.push('(t.name LIKE ? OR t.merchant LIKE ? OR t.category LIKE ? OR v.name LIKE ?)'); p.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(g('from'))) { where.push('t.date >= ?'); p.push(g('from')); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(g('to'))) { where.push('t.date <= ?'); p.push(g('to')); }
    if (g('category')) { where.push('t.category = ?'); p.push(g('category')); }
    if (g('type')) { const subs = chartOf(await settings()).filter(c => c.parent === g('type')).map(c => c.name); if (subs.length) { where.push('t.category IN (' + subs.map(() => '?').join(',') + ')'); p.push(...subs); } else { where.push('t.category = ?'); p.push(g('type')); } }
    if (g('vendor_id')) { if (g('vendor_id') === 'none') where.push('t.vendor_id IS NULL'); else { where.push('t.vendor_id = ?'); p.push(parseInt(g('vendor_id')) || 0); } }
    if (g('source')) { where.push('t.category_source = ?'); p.push(g('source')); }
    if (g('min')) { where.push('ABS(t.amount) >= ?'); p.push(Number(g('min')) || 0); }
    if (g('max')) { where.push('ABS(t.amount) <= ?'); p.push(Number(g('max')) || 0); }
    if (g('account')) { where.push('t.account_name = ?'); p.push(g('account')); }
    const by_status = Object.fromEntries((await dbAll("SELECT status, COUNT(*) n FROM bk_transactions WHERE status <> 'removed' GROUP BY status")).map(r => [r.status, r.n]));
    by_status.new_status = by_status.new || 0;   // lines the AI has not rated yet
    by_status.pending = (by_status.new || 0) + (by_status.pending || 0);
    by_status.new = (await dbGet("SELECT COUNT(*) n FROM bk_transactions WHERE status <> 'removed' AND created_at >= datetime('now', '-1 day')")).n;
    const W = ' FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id LEFT JOIN bk_vendors sv ON sv.id = t.suggest_vendor_id LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id LEFT JOIN bk_proposals pr ON pr.id = t.proposal_id WHERE ' + where.join(' AND ');
    const rows = await dbAll('SELECT t.id, t.txn_id, t.account_name, t.account_ref, t.date, t.created_at, t.name, t.raw, t.merchant, t.amount, t.pending, t.plaid_category, t.category, t.category_source, t.rule_id, t.proposal_id, t.status, t.vendor_id, t.vendor_by, t.vendor_score, t.suggest_vendor_id, t.suggest_score, ' +
      'v.name AS vendor_name, v.source AS vendor_source, v.photo AS vendor_photo, v.kind AS vendor_kind, sv.name AS suggest_name, sv.photo AS suggest_photo, ba.institution, ba.logo AS bank_logo, ba.color AS bank_color, ba.accounts AS bank_accounts, pr.payload AS ai_payload, pr.confidence AS ai_conf, pr.reason AS ai_reason, pr.status AS ai_status' + W + ' ORDER BY t.date DESC, t.id DESC LIMIT 500', p);
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
        r.channel = raw.check_number ? 'check' : raw.payment_channel === 'in store' ? 'store' : raw.payment_channel === 'online' ? 'online' : (raw.payment_channel || null);
        r.check_no = raw.check_number || null;
        r.tx_time = raw.authorized_datetime || raw.datetime || null;
        r.tx_date = raw.authorized_date || raw.date || null;
        r.plaid_primary = raw.personal_finance_category ? raw.personal_finance_category.primary : null;
        r.plaid_logo = raw.logo_url || null;
        r.website = raw.website || null;
        r.place = raw.location ? [raw.location.city, raw.location.region].filter(Boolean).join(', ') + (raw.location.store_number ? ' #' + raw.location.store_number : '') : '';
      }
      // the AI's suggestion (its proposal), shown under the picker while the line is not categorized
      let pl = null; try { pl = r.ai_payload ? JSON.parse(r.ai_payload) : null; } catch (e) {}
      r.ai_category = pl && pl.category && pl.category !== 'Uncategorized' ? pl.category : null; delete r.ai_payload;
      if (!r.vendor_id && r.suggest_score == null && backfilled < 150) { backfilled++; try { await autoVendor(r); Object.assign(r, (await dbGet(VSEL, [r.id])) || {}); } catch (e) {} }
    }
    const matched = rows.length < 500 ? rows.length : (await dbGet('SELECT COUNT(*) n' + W, p)).n;   // how many the filters match (the list stops at 500)
    const out = { ok: true, by_status, matched, transactions: rows, categorizing: catBusy };
    if ((by_status.new_status || 0) > 0 && !catBusy) { categorizeBacklog(userId(req)); out.categorizing = true; }
    if (st === 'categorized') {
      const parentOfName = {}; chartOf(await settings()).forEach(c => { if (c.parent) parentOfName[c.name] = c.parent; });
      const tot = await dbGet('SELECT COUNT(*) n, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) received' + W, p);
      const byCat = await dbAll('SELECT t.category, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) received, COUNT(*) n' + W + ' GROUP BY t.category ORDER BY spent DESC', p);
      const byType = {}; byCat.forEach(r => { const t = parentOfName[r.category] || r.category || '—'; const o = byType[t] || (byType[t] = { type: t, spent: 0, received: 0, n: 0 }); o.spent += r.spent; o.received += r.received; o.n += r.n; });
      const byMonth = await dbAll("SELECT substr(t.date, 1, 7) m, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) received, COUNT(*) n" + W + ' GROUP BY m ORDER BY m', p);
      const byVendor = await dbAll('SELECT COALESCE(v.name, t.merchant, t.name) vendor, t.vendor_id, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, COUNT(*) n' + W + ' GROUP BY COALESCE(v.name, t.merchant, t.name), t.vendor_id ORDER BY spent DESC LIMIT 12', p);
      out.totals = { count: tot.n, spent: tot.spent || 0, received: tot.received || 0, by_type: Object.values(byType).sort((a, b) => b.spent - a.spent), by_category: byCat, by_month: byMonth, by_vendor: byVendor };
    }
    if (st === 'categorized' || req.query.lists) {
      // 1.19.49: the Account filter shows "Wells Fargo - 6595", the Vendor filter every vendor seen on a bank line
      const accs = await dbAll("SELECT DISTINCT t.account_name, t.account_ref, ba.institution, ba.accounts FROM bk_transactions t LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id WHERE t.account_name IS NOT NULL ORDER BY 1");
      out.accounts = accs.map(r => { let a = null; try { a = JSON.parse(r.accounts || '[]').find(x => x.account_id === r.account_ref); } catch (e) {} return { account_name: r.account_name, label: (r.institution || 'Bank') + (a && a.mask ? ' - ' + a.mask : '') + (r.account_name ? ' · ' + r.account_name : '') }; });
      out.vendors = await dbAll("SELECT DISTINCT v.id, v.name FROM bk_transactions t JOIN bk_vendors v ON v.id = t.vendor_id ORDER BY v.name");
    }
    res.json(out);
  });
  app.post('/api/bookkeeping/transactions/:id/category', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), category = String(req.body.category || '').trim();
    if (!category) return res.json({ ok: false, error: 'No category' });
    await dbRun("UPDATE bk_transactions SET category = ?, category_source = 'manual', status = 'categorized', updated_at = datetime('now') WHERE id = ?", [category, id]);
    await dbRun("UPDATE bk_proposals SET status = 'edited', decided_by = ?, decided_at = ? WHERE ref_table = 'bk_transactions' AND ref_id = ? AND status = 'pending'", [userId(req), nowIso(), id]);
    await audit(userId(req), 'category.manual', id, category);
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
    const txns = await dbAll("SELECT id, date, name, merchant, amount, category, status, vendor_id FROM bk_transactions WHERE date >= date(?, '-45 days') AND date <= date(?, '+10 days') AND amount < 0 ORDER BY date DESC LIMIT 600", [since, since]);
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
    if (!b.pattern || !b.category) return res.json({ ok: false, error: 'Pattern and category are needed.' });
    const r = await dbRun('INSERT INTO bk_rules (kind, pattern, category, vendor, note, source, created_by) VALUES (?,?,?,?,?,?,?)', [b.kind === 'keyword' ? 'keyword' : 'vendor', String(b.pattern).slice(0, 120), String(b.category).slice(0, 80), b.kind === 'keyword' ? null : String(b.pattern).slice(0, 120), String(b.note || '').slice(0, 300), 'manual', userId(req)]);
    await audit(userId(req), 'rule.add', r.lastID, b);
    res.json({ ok: true, id: r.lastID });
  });
  app.delete('/api/bookkeeping/rules/:id', ...guard, async (req, res) => { await dbRun('UPDATE bk_rules SET active = 0 WHERE id = ?', [parseInt(req.params.id)]); await audit(userId(req), 'rule.remove', req.params.id); res.json({ ok: true }); });
  app.get('/api/bookkeeping/directory', ...guard, async (req, res) => {
    if (req.query.fresh !== '0') await syncDirectoryIfStale(userId(req), 10 * 60000);
    const rows = await dbAll("SELECT v.*, CASE v.source WHEN 'suppliers' THEN 'supplier' WHEN 'vendors' THEN 'vendor' WHEN 'bill' THEN 'bill' ELSE COALESCE(v.kind, 'other') END AS kind, (SELECT COUNT(*) FROM bk_transactions t WHERE t.vendor_id = v.id) AS txns, (SELECT COUNT(*) FROM bk_bills b WHERE b.vendor_id = v.id AND b.status <> ?) AS bills FROM bk_vendors v ORDER BY v.name", ['rejected']);
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
    const t = await dbGet('SELECT id, name, merchant FROM bk_transactions WHERE id = ?', [id]);
    await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = ?, vendor_score = ?, suggest_vendor_id = NULL, suggest_score = NULL WHERE id = ?", [vid, vid ? 'person' : null, vid ? 1 : null, id]);
    // 1.19.47: the same bank wording elsewhere (unlinked, or linked by the machine) follows — and every future line too, through the alias.
    if (vid && t && req.body.alias !== false) { const text = t.merchant || t.name; req.body.alias = req.body.alias || text;
      await dbRun("UPDATE bk_transactions SET vendor_id = ?, vendor_by = 'auto', vendor_score = 1, suggest_vendor_id = NULL, suggest_score = NULL WHERE id <> ? AND (vendor_id IS NULL OR vendor_by = 'auto') AND LOWER(COALESCE(merchant, name)) = LOWER(?)", [vid, id, text]); }
    // Remember the bank line as an alias of that vendor, so the next one matches by itself.
    if (vid && req.body.alias) { const v = await dbGet('SELECT aliases FROM bk_vendors WHERE id = ?', [vid]); const al = String(v && v.aliases || '').split('\n').filter(Boolean); if (al.indexOf(req.body.alias) < 0) { al.push(String(req.body.alias).slice(0, 120)); await dbRun('UPDATE bk_vendors SET aliases = ? WHERE id = ?', [al.join('\n'), vid]); dirCache.at = 0; } }
    await audit(userId(req), 'transaction.vendor', req.params.id, { vendor_id: vid, alias: req.body.alias });
    res.json({ ok: true });
  });
  app.post('/api/bookkeeping/vendors/:id', ...guard, async (req, res) => {
    // Partial update: only the fields sent change (the tab autosaves one field at a time).
    const b = req.body || {}, sets = [], args = [];
    if (b.default_category !== undefined) { sets.push('default_category = ?'); args.push(String(b.default_category || '').slice(0, 300) || null); }
    if (b.notes !== undefined) { sets.push('notes = ?'); args.push(String(b.notes || '').slice(0, 500) || null); }
    if (b.aliases !== undefined) { sets.push('aliases = ?'); args.push(String(b.aliases || '').slice(0, 1000) || null); }
    if (b.approved !== undefined) { sets.push('approved = ?, approved_by = ?, approved_at = ?'); args.push(b.approved ? 1 : 0, userId(req), nowIso()); }
    if (!sets.length) return res.json({ ok: false, error: 'Nothing to change' });
    await dbRun('UPDATE bk_vendors SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([parseInt(req.params.id)]));
    dirCache.at = 0;
    await audit(userId(req), 'vendor.update', req.params.id, b); res.json({ ok: true });
  });
  app.get('/api/bookkeeping/activity', ...guard, async (req, res) => res.json({ ok: true, runs: await dbAll('SELECT * FROM bk_runs ORDER BY id DESC LIMIT 40'), audit: await dbAll('SELECT * FROM bk_audit ORDER BY id DESC LIMIT 200'), briefs: await dbAll('SELECT day, stats, posted_at, post_error FROM bk_briefs ORDER BY day DESC LIMIT 30') }));
  app.post('/api/bookkeeping/settings', ...guard, async (req, res) => {
    const b = req.body || {};
    for (const k of ['run_at', 'poll_min', 'threshold', 'notes', 'chat_webhook', 'backfill_days', 'triage_ad', 'triage_bill', 'triage_notice', 'triage_message', 'triage_auto', 'notreceived_days', 'waiting_days', 'alert_to', 'alert_at', 'baskets']) if (b[k] !== undefined) await setSetting(k, b[k] === true ? 1 : b[k] === false ? 0 : b[k], userId(req));
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
