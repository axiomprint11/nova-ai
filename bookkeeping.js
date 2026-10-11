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

module.exports = function mountBookkeeping(app, deps) {
  const { db, crypto, anthropic, auth, serveVersionedHtml, google, keyPath, runQuery } = deps;
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
    db.run(`CREATE TABLE IF NOT EXISTS bk_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, gmail_id TEXT UNIQUE, thread_id TEXT, from_addr TEXT,
      subject TEXT, received_at TEXT, snippet TEXT, body TEXT, attachments TEXT, status TEXT DEFAULT 'new', note TEXT,
      created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS bk_bills (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id INTEGER, vendor TEXT, vendor_id INTEGER, invoice_no TEXT,
      invoice_date TEXT, due_date TEXT, terms TEXT, subtotal REAL, tax REAL, total REAL, currency TEXT DEFAULT 'USD', kind TEXT DEFAULT 'invoice',
      duplicate_of INTEGER, lines TEXT, file TEXT, file_name TEXT, status TEXT DEFAULT 'draft', proposal_id INTEGER, note TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    ['scheduled_for TEXT', 'paid_at TEXT', 'paid_note TEXT'].forEach(c => db.run('ALTER TABLE bk_bills ADD COLUMN ' + c, () => {}));
    ['kind TEXT', 'confidence REAL', 'triaged_at TEXT', 'read_by TEXT', 'body_html TEXT', 'aside INTEGER DEFAULT 0'].forEach(c => db.run('ALTER TABLE bk_emails ADD COLUMN ' + c, () => {}));
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
    run_at: env('BOOKKEEPER_RUN_AT') || '07:00', poll_min: parseInt(env('BOOKKEEPER_POLL_MIN')) || 5, threshold: 0.75,
    triage_ad: 0.95, triage_bill: 0.8, triage_notice: 0.75, triage_message: 0.6,   // inbox triage: when BookkeeperAI acts on its own
    triage_auto: 0,   // 0 = BookkeeperAI only RATES emails; a person sets them aside ("Set aside all ads"). 1 = it sets aside by itself above the thresholds.
    categories: DEFAULT_CATEGORIES.join('\n'), chat_webhook: env('BOOKKEEPER_CHAT_WEBHOOK') || '', chat_space: '',
    backfill_days: parseInt(env('BOOKKEEPER_BACKFILL_DAYS')) || 30, gmail_history_id: '', gmail_watch_expires: '',
    notes: 'AxiomPrint is a print shop in Glendale, CA. Inks, paper, printing supplies and outsourced printing are cost of goods. Equipment over $2,500 is a fixed asset, not an expense. Transfers between our own accounts and credit card payments are not expenses.'
  };
  let settingsCache = null;
  async function settings() {
    if (settingsCache) return settingsCache;
    const rows = await dbAll('SELECT key, value FROM bk_settings');
    const s = Object.assign({}, SETTING_DEFAULTS);
    rows.forEach(r => { s[r.key] = r.value; });
    s.poll_min = Math.max(2, parseInt(s.poll_min) || 5); s.threshold = Number(s.threshold) || 0.75; s.backfill_days = parseInt(s.backfill_days) || 30;
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
      (Array.isArray(t.children) ? t.children : []).forEach(c => { const n = cleanName(c && c.name); if (n && !seen[n]) { seen[n] = 1; kids.push({ name: n, icon: iconKey(c.icon) }); } });
      out.push({ name, color, icon: iconKey(t.icon), children: kids });
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
    chartTree(s).forEach(t => { out.push({ name: t.name, parent: null, children: t.children.length, color: t.color, icon: t.icon }); t.children.forEach(c => out.push({ name: c.name, parent: t.name, color: t.color, icon: c.icon || '' })); });
    return out;
  }
  const categoriesOf = (s) => { const seen = {}; return chartOf(s).filter(c => c.parent || !c.children).map(c => c.name).filter(n => !seen[n] && (seen[n] = 1)); };
  const parentOf = (s, name) => { const c = chartOf(s).find(x => x.name === name && x.parent); return c ? c.parent : null; };
  // The chart as the AI reads it: "Cost of Goods Sold: Paper; Inks & Toner | Facilities: Rent; …"
  const chartText = (s) => chartTree(s).map(t => t.children.length ? t.name + ': ' + t.children.map(c => c.name).join('; ') : t.name).join(' | ');
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
    tree.forEach(t => { if (t.name === from) { t.name = to; hit = true; } t.children.forEach(c => { if (c.name === from) { c.name = to; hit = true; } }); });
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
    const rows = await dbAll('SELECT * FROM bk_accounts ORDER BY id');
    return rows.map(r => { let a = []; try { a = JSON.parse(r.accounts || '[]'); } catch (e) {} return Object.assign({}, r, { access_token: undefined, accounts: a }); });
  }
  // Pull new / changed / removed transactions for one bank connection (cursor-based, so nothing is missed or doubled).
  async function syncItem(row, who) {
    const token = dec(row.access_token);
    let cursor = row.cursor || undefined, added = 0, modified = 0, removed = 0, more = true, guardN = 0;
    while (more && guardN++ < 50) {
      const j = await plaid('/transactions/sync', { access_token: token, cursor: cursor, count: 500 });
      const names = {}; let accts = [];
      try { accts = JSON.parse(row.accounts || '[]'); } catch (e) {}
      accts.forEach(a => { names[a.account_id] = a.name; });
      for (const t of (j.added || []).concat(j.modified || [])) {
        const isNew = !(await dbGet('SELECT id FROM bk_transactions WHERE txn_id = ?', [t.transaction_id]));
        const cat = t.personal_finance_category ? (t.personal_finance_category.detailed || t.personal_finance_category.primary) : (t.category || []).join(' > ');
        if (isNew) {
          await dbRun('INSERT INTO bk_transactions (txn_id, item_id, account_ref, account_name, date, name, merchant, amount, pending, plaid_category, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [t.transaction_id, row.item_id, t.account_id, names[t.account_id] || null, t.date, t.name, t.merchant_name || null, Number(t.amount), t.pending ? 1 : 0, cat, JSON.stringify(t).slice(0, 20000)]);
          added++;
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
      return { ok: false, n: 0, error: scope ? SCOPE_HELP : 'Gmail refused: ' + msg.slice(0, 200), scope };
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
    if (!s.inbox_reset_1825) {   // once: everything closed before Closed meant "closed from here" goes (Gmail state untouched)
      await dbRun("DELETE FROM bk_emails WHERE status IN ('skipped', 'error') AND COALESCE(aside, 0) = 0 AND id NOT IN (SELECT email_id FROM bk_bills WHERE email_id IS NOT NULL)");
      await setSetting('inbox_reset_1825', 1, 'system');
    }
    const ids = unreadIds; let n = 0;
    const seen = new Set((await dbAll('SELECT gmail_id FROM bk_emails')).map(r => r.gmail_id));
    const unread = new Set(unreadIds);
    const open = await dbAll("SELECT id, gmail_id FROM bk_emails WHERE status IN ('new','message')");
    let readInGmail = 0, unreadAgain = 0;
    // Read in Gmail by someone (not from here) → it simply leaves this inbox; Closed is only what was closed from here.
    for (const o of open) if (o.gmail_id && !unread.has(o.gmail_id)) { await dbRun('DELETE FROM bk_emails WHERE id = ? AND id NOT IN (SELECT email_id FROM bk_bills WHERE email_id IS NOT NULL)', [o.id]); readInGmail++; }
    // ...and the other way: read here (or by the AI) but unread in Gmail again → open again. Gmail is the truth.
    const closed = await dbAll("SELECT id, gmail_id, kind FROM bk_emails WHERE status = 'skipped' AND COALESCE(aside, 0) = 0 AND gmail_id IS NOT NULL");
    for (const c of closed) if (unread.has(c.gmail_id)) { await dbRun("UPDATE bk_emails SET status = ?, read_by = NULL, note = COALESCE(note, '') || ' — unread again in Gmail' WHERE id = ?", [c.kind === 'message' ? 'message' : 'new', c.id]); unreadAgain++; }
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
        await dbRun('INSERT OR IGNORE INTO bk_emails (gmail_id, thread_id, from_addr, subject, received_at, snippet, body, body_html, attachments, status) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [id, m.threadId, from.slice(0, 200), subject.slice(0, 300), at, (m.snippet || '').slice(0, 300), emailText(m.payload), emailHtml(m.payload), JSON.stringify(atts), 'new']);
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
  // Keep the directory current by itself: the tab syncs when it opens and the last sync is older than 10 minutes,
  // the clock every hour, the daily run always.
  async function syncDirectoryIfStale(who, maxAgeMs) { if (runQuery && Date.now() - dirSync.at > maxAgeMs) { try { await syncDirectory(who); } catch (e) { dirSync.error = e.message; errlog('directory sync', e.message); } } }
  let dirCache = { at: 0, list: [] };
  async function directory() {
    if (Date.now() - dirCache.at < 60000) return dirCache.list;
    const rows = await dbAll('SELECT * FROM bk_vendors ORDER BY name');
    dirCache = { at: Date.now(), list: rows.map(v => Object.assign({}, v, { _n: normV(v.name), _al: String(v.aliases || '').split('\n').map(normV).filter(Boolean), _dom: domainOf(v.email) })) };
    return dirCache.list;
  }
  // The directory entry a bank line / bill belongs to: an alias or the full name inside the text, or the email domain.
  async function matchVendor(text, email) {
    const list = await directory();
    const n = normV(text), dom = domainOf(email);
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
        String(j.currency || 'USD').slice(0, 8), j.kind, dup ? dup.id : null, JSON.stringify((j.lines || []).slice(0, 60)), main ? main.file : null, main ? main.name : null, 'draft', String(j.note || '').slice(0, 500)]);
    const billId = ins.lastID;
    const conf = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    const newVendor = v && !v.approved;
    const title = (j.kind === 'credit_memo' ? 'Credit memo' : j.kind === 'statement' ? 'Statement' : 'Bill') + ' from ' + vendor + (invNo ? ' #' + invNo : '') + ' — $' + (Number(j.total) || 0).toFixed(2) +
      (dup ? ' (possible DUPLICATE of bill #' + dup.id + ')' : '') + (newVendor ? ' (NEW vendor — needs your approval)' : '');
    const p = await dbRun('INSERT INTO bk_proposals (type, ref_table, ref_id, title, payload, confidence, reason) VALUES (?,?,?,?,?,?,?)',
      ['bill', 'bk_bills', billId, title, JSON.stringify({ vendor, invoice_no: invNo, invoice_date: j.invoice_date, due_date: j.due_date, total: Number(j.total) || 0, kind: j.kind, duplicate_of: dup ? dup.id : null, new_vendor: !!newVendor, lines: (j.lines || []).slice(0, 60) }),
        conf, String(j.reason || '').slice(0, 300)]);
    await dbRun('UPDATE bk_bills SET proposal_id = ? WHERE id = ?', [p.lastID, billId]);
    await dbRun("UPDATE bk_emails SET status = 'parsed', note = ? WHERE id = ?", ['Bill draft #' + billId, em.id]);
    markReadInGmail([em.id], who).catch(() => {});   // it is handled: read in Gmail too (quietly; the scope may be missing)
    if (conf < s.threshold || dup || newVendor) {
      const q = dup ? 'This looks like a duplicate of bill #' + dup.id + ' (' + vendor + (invNo ? ' #' + invNo : '') + '). Is it the same bill?'
        : newVendor ? vendor + ' is a new vendor. Is this a real vendor of ours, and should I approve them for future bills?'
        : 'Can you check this draft from ' + vendor + '? I am only ' + Math.round(conf * 100) + '% sure.';
      await dbRun('INSERT INTO bk_questions (proposal_id, question) VALUES (?,?)', [p.lastID, q]);
    }
    await audit(who, 'bill.draft', billId, { vendor, total: j.total, confidence: conf });
    return billId;
  }
  // Triage before the expensive read: a cheap text-only look at every unread email (sender, subject, first lines).
  // Advertisements, newsletters, shipping / account notifications and payment receipts that the model is ≥ 95% sure
  // about are marked read ("skipped") with the reason; anything that might be a bill stays for parseEmail().
  // Every unread email gets a kind and a confidence (stored); what happens next depends on the thresholds in settings:
  //   advertisement / receipt ≥ triage_ad     → marked read by the AI (set aside)
  //   notification (delivery, tracking, alerts) ≥ triage_notice → marked read by the AI
  //   bill ≥ triage_bill                        → read in full by parseEmail() → a bill draft
  //   message (a person writing) ≥ triage_message → left for a person, tagged "message"
  //   anything else / unsure                    → read in full anyway (a missed bill costs more than a model call)
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
        const r = await anthropic.messages.create({ model: MODEL_LIGHT, max_tokens: 2000, system: 'You sort the accounting inbox of AxiomPrint, a print shop. For each email say what it is. Kinds: advertisement (marketing, promotions, newsletters, sales), notification (shipping, delivery and tracking confirmations, account alerts, calendar, system mail), receipt (confirmation of a payment already made), bill (an invoice, statement or credit memo asking for money, or anything with an invoice-like attachment), message (a real person writing to us — a question, a reply, a request), other (anything unclear). When in doubt between advertisement and anything else, say the other thing — a missed advertisement costs nothing, a missed bill or message does. Return ONLY JSON.',
          messages: [{ role: 'user', content: 'EMAILS\n' + listing + '\n\nReturn ONLY JSON: {"items": [{"id": <id>, "kind": "advertisement"|"notification"|"receipt"|"bill"|"message"|"other", "confidence": 0.0, "why": "<a few words>"}]}' }] });
        j = jsonOf((r.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
      } catch (e) { errlog('triage', e.message); break; }
      for (const m of batch) {
        out.looked++;
        const it = j && Array.isArray(j.items) ? j.items.find(x => Number(x.id) === m.id) : null;
        const kind = it && ['advertisement', 'notification', 'receipt', 'bill', 'message', 'other'].indexOf(it.kind) > -1 ? it.kind : 'other';
        const conf = it ? Math.max(0, Math.min(1, Number(it.confidence) || 0)) : 0;
        const why = it ? String(it.why || '').slice(0, 200) : '';
        out.by_kind[kind] = (out.by_kind[kind] || 0) + 1;
        const pct = Math.round(conf * 100) + '%';
        let status = m.status;
        if (m.status !== 'new') {   // already read in Gmail: rated for the Everything else basket, nothing else changes
          await dbRun("UPDATE bk_emails SET kind = ?, confidence = ?, triaged_at = datetime('now'), note = ? WHERE id = ?", [kind, conf, kind + ' — ' + why + ' (' + pct + ') — read in Gmail', m.id]);
        } else if (auto && ((kind === 'advertisement' || kind === 'receipt') && conf >= s.triage_ad || kind === 'notification' && conf >= s.triage_notice)) {
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
    const rows = s.triage_auto ? await dbAll("SELECT * FROM bk_emails WHERE status = 'new' ORDER BY id LIMIT 40")
      : await dbAll("SELECT * FROM bk_emails WHERE status = 'new' AND kind = 'bill' AND confidence >= ? ORDER BY id LIMIT 40", [s.triage_bill]);
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
    const txns = await dbAll("SELECT * FROM bk_transactions WHERE status = 'new' AND pending = 0 ORDER BY date LIMIT 80");
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
  let lastDailyDay = '', lastPoll = 0;
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
      inbox_new: (await dbGet("SELECT COUNT(*) AS n FROM bk_emails WHERE status = 'new'")).n,
      inbox_messages: (await dbGet("SELECT COUNT(*) AS n FROM bk_emails WHERE status = 'message'")).n,
      ai_read_today: (await dbGet("SELECT COUNT(*) AS n FROM bk_emails WHERE read_by = 'ai' AND triaged_at >= datetime('now', '-1 day')")).n,
      emails: (await dbGet('SELECT COUNT(*) AS n FROM bk_emails')).n, rules: (await dbGet('SELECT COUNT(*) AS n FROM bk_rules WHERE active = 1')).n
    };
    const lastRun = await dbGet('SELECT * FROM bk_runs ORDER BY id DESC LIMIT 1');
    // who is who, for the page to show a face instead of an email (members: photo from the CRM, else an initial)
    let people = []; try { people = (await dbAll('SELECT email, username, display_name, photo FROM members')).map(m => ({ email: m.email, username: m.username, name: m.display_name || m.username || m.email, photo: m.photo || null })); } catch (e) {}
    res.json({ ok: true, me: userId(req), people, settings: Object.assign({}, s, { chat_webhook: s.chat_webhook ? '(set)' : '' }), chart: chartOf(s), counts, brief, last_run: lastRun, running: !!running,
      connections: {
        plaid: { configured: plaidReady(), env: PLAID_ENV, items },
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
    if (st) { where.push('t.status = ?'); p.push(st); }
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
    const W = ' FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id WHERE ' + where.join(' AND ');
    const rows = await dbAll('SELECT t.id, t.txn_id, t.account_name, t.date, t.name, t.merchant, t.amount, t.pending, t.plaid_category, t.category, t.category_source, t.rule_id, t.proposal_id, t.status, t.vendor_id, v.name AS vendor_name, v.source AS vendor_source' + W + ' ORDER BY t.date DESC, t.id DESC LIMIT 500', p);
    const out = { ok: true, by_status, transactions: rows };
    if (st === 'categorized') {
      const parentOfName = {}; chartOf(await settings()).forEach(c => { if (c.parent) parentOfName[c.name] = c.parent; });
      const tot = await dbGet('SELECT COUNT(*) n, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) received' + W, p);
      const byCat = await dbAll('SELECT t.category, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) received, COUNT(*) n' + W + ' GROUP BY t.category ORDER BY spent DESC', p);
      const byType = {}; byCat.forEach(r => { const t = parentOfName[r.category] || r.category || '—'; const o = byType[t] || (byType[t] = { type: t, spent: 0, received: 0, n: 0 }); o.spent += r.spent; o.received += r.received; o.n += r.n; });
      const byMonth = await dbAll("SELECT substr(t.date, 1, 7) m, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) received, COUNT(*) n" + W + ' GROUP BY m ORDER BY m', p);
      const byVendor = await dbAll('SELECT COALESCE(v.name, t.merchant, t.name) vendor, t.vendor_id, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) spent, COUNT(*) n' + W + ' GROUP BY COALESCE(v.name, t.merchant, t.name), t.vendor_id ORDER BY spent DESC LIMIT 12', p);
      out.totals = { count: tot.n, spent: tot.spent || 0, received: tot.received || 0, by_type: Object.values(byType).sort((a, b) => b.spent - a.spent), by_category: byCat, by_month: byMonth, by_vendor: byVendor };
      out.accounts = (await dbAll("SELECT DISTINCT account_name FROM bk_transactions WHERE account_name IS NOT NULL ORDER BY 1")).map(r => r.account_name);
      out.vendors = await dbAll("SELECT DISTINCT v.id, v.name FROM bk_transactions t JOIN bk_vendors v ON v.id = t.vendor_id WHERE t.status = 'categorized' ORDER BY v.name");
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
    const rows = await dbAll('SELECT b.*, e.from_addr, e.subject, e.received_at, p.status AS proposal_status, p.confidence AS proposal_confidence, p.reason AS proposal_reason FROM bk_bills b LEFT JOIN bk_emails e ON e.id = b.email_id LEFT JOIN bk_proposals p ON p.id = b.proposal_id ORDER BY b.id DESC LIMIT 200');
    const dir = await directory();
    for (const r of rows) {
      try { r.lines = JSON.parse(r.lines || '[]'); } catch (e) { r.lines = []; }
      const v = r.vendor_id ? dir.find(x => x.id === r.vendor_id) : null;
      r.vendor_card = vendorCard(v);
      // not linked to a CRM entry yet (none, or only the bill-source row) → near matches to pair with
      r.suggestions = (!v || v.source === 'bill') ? (await suggestVendors(r.vendor, r.from_addr, 3)).map(x => Object.assign(vendorCard(x.vendor), { score: x.score })) : [];
      const q = r.proposal_id ? await dbGet('SELECT id, question, answer FROM bk_questions WHERE proposal_id = ? ORDER BY id DESC LIMIT 1', [r.proposal_id]) : null;
      r.question = q && !q.answer ? q : null;
    }
    res.json({ ok: true, bills: rows });
  });
  // Bill life after approval: approved → scheduled (a pay date) → paid (date + how). Until BILL / QuickBooks are
  // connected these are set by hand here; nothing moves money.
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
    const rows = await dbAll('SELECT id, gmail_id, from_addr, subject, received_at, snippet, attachments, status, note, kind, confidence, read_by, triaged_at, aside FROM bk_emails ORDER BY received_at DESC LIMIT 500');
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
    res.json({ ok: true, email: m, bill: bill || null, inbox: INBOX });
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
    if (em.status === 'parsed') return res.json({ ok: false, error: 'It is a bill draft already.' });
    const gm = await markReadInGmail([id], userId(req)); if (!gm.ok) return res.json({ ok: false, error: gm.error });   // Gmail is the truth: nothing changes here unless it changed there
    await dbRun("UPDATE bk_emails SET status = 'skipped', read_by = 'user', note = ? WHERE id = ?", ['marked read by ' + userId(req), id]);
    await audit(userId(req), 'email.read', id, null); res.json({ ok: true, gmail: gm });
  });
  app.post('/api/bookkeeping/emails/:id/unread', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), em = await dbGet('SELECT id, status, kind, gmail_id FROM bk_emails WHERE id = ?', [id]);
    if (!em) return res.json({ ok: false, error: 'No such email' });
    if (em.status === 'parsed') return res.json({ ok: false, error: 'It is a bill draft already.' });
    if (em.gmail_id) { try { await gmailMod().users.messages.batchModify({ userId: 'me', requestBody: { ids: [em.gmail_id], addLabelIds: ['UNREAD'] } }); } catch (e) { const msg = String(e.message || e); return res.json({ ok: false, error: /unauthorized_client|insufficient|403|scope/i.test(msg) ? SCOPE_HELP : 'Gmail refused: ' + msg.slice(0, 200) }); } }
    await dbRun("UPDATE bk_emails SET status = ?, read_by = NULL, aside = 0, note = ? WHERE id = ?", [em.kind === 'message' ? 'message' : 'new', 'marked unread by ' + userId(req), id]);
    await audit(userId(req), 'email.unread', id, null); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/emails/:id/parse', ...guard, async (req, res) => {
    const em = await dbGet('SELECT * FROM bk_emails WHERE id = ?', [parseInt(req.params.id)]);
    if (!em) return res.json({ ok: false, error: 'No such email' });
    try { const id = await parseEmail(em, userId(req)); res.json({ ok: true, bill_id: id }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
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
  app.post('/api/bookkeeping/directory/sync', ...guard, async (req, res) => { try { dirCache.at = 0; res.json(Object.assign({ ok: true }, await syncDirectory(userId(req)))); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/transactions/:id/vendor', ...guard, async (req, res) => {
    const vid = parseInt(req.body.vendor_id) || null;
    await dbRun('UPDATE bk_transactions SET vendor_id = ? WHERE id = ?', [vid, parseInt(req.params.id)]);
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
    for (const k of ['run_at', 'poll_min', 'threshold', 'notes', 'chat_webhook', 'backfill_days', 'triage_ad', 'triage_bill', 'triage_notice', 'triage_message', 'triage_auto']) if (b[k] !== undefined) await setSetting(k, b[k] === true ? 1 : b[k] === false ? 0 : b[k], userId(req));
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
    if (['advertisement', 'notification', 'receipt', 'bill', 'message', 'other', 'aside'].indexOf(kind) < 0) return res.json({ ok: false, error: 'Which basket?' });
    const em = await dbGet('SELECT id, status, read_by, aside FROM bk_emails WHERE id = ?', [id]); if (!em) return res.json({ ok: false, error: 'No such email' });
    if (em.status === 'parsed') return res.json({ ok: false, error: 'It is a bill draft already.' });
    if (kind === 'aside') {   // Set aside is the manual basket: parked by a person, rating kept, Gmail untouched
      await dbRun("UPDATE bk_emails SET status = 'skipped', aside = 1, read_by = 'user', note = ? WHERE id = ?", ['set aside by ' + userId(req), id]);
      await audit(userId(req), 'email.move', id, { kind }); return res.json({ ok: true });
    }
    // read in Gmail already → only the rating changes (it stays under Everything else); otherwise it is open again
    const status = em.read_by === 'gmail' && !em.aside ? em.status : kind === 'message' ? 'message' : 'new';
    await dbRun("UPDATE bk_emails SET kind = ?, confidence = 1, status = ?, aside = 0, triaged_at = COALESCE(triaged_at, datetime('now')), note = ? WHERE id = ?", [kind, status, 'moved to ' + kind + ' by ' + userId(req), id]);
    await audit(userId(req), 'email.move', id, { kind }); res.json({ ok: true });
  });
  app.post('/api/bookkeeping/inbox/fetch', ...guard, async (req, res) => { try { const r = await scanInbox(userId(req)); const left = await dbGet("SELECT COUNT(*) n FROM bk_emails WHERE " + TO_RATE); res.json({ ok: true, scan: r, to_rate: left.n }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/bookkeeping/inbox/rate', ...guard, async (req, res) => {
    try { const r = await triageEmails(userId(req), Math.min(50, parseInt(req.body && req.body.limit) || 25)); const left = await dbGet("SELECT COUNT(*) n FROM bk_emails WHERE " + TO_RATE); const s = await settings();
      const bills = await dbAll("SELECT id FROM bk_emails WHERE status = 'new' AND kind = 'bill' AND confidence >= ? ORDER BY id", [s.triage_bill]);
      res.json({ ok: true, items: r.items, remaining: left.n, bills_to_read: bills.map(b => b.id) }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Set aside every rated email of these kinds at or above the confidence (a person's decision, in one click).
  app.post('/api/bookkeeping/inbox/set-aside', ...guard, async (req, res) => {
    const kinds = (Array.isArray(req.body && req.body.kinds) ? req.body.kinds : []).filter(k => ['advertisement', 'notification', 'receipt', 'other', 'bill', 'message'].indexOf(k) > -1);
    const min = Math.max(0, Math.min(1, Number(req.body && req.body.min) || 0));
    if (!kinds.length) return res.json({ ok: false, error: 'Which kinds?' });
    const ids = (await dbAll("SELECT id FROM bk_emails WHERE status IN ('new', 'message') AND kind IN (" + kinds.map(() => '?').join(',') + ") AND COALESCE(confidence, 0) >= ?", kinds.concat([min]))).map(r => r.id);
    const gm = await markReadInGmail(ids, userId(req)); if (!gm.ok) return res.json({ ok: false, error: gm.error });   // Gmail first; nothing changes here unless it changed there
    const r = ids.length ? await dbRun("UPDATE bk_emails SET status = 'skipped', read_by = 'user', note = COALESCE(note, '') || ' — marked read by ' || ? WHERE id IN (" + ids.map(() => '?').join(',') + ")", [userId(req)].concat(ids)) : { changes: 0 };
    await audit(userId(req), 'email.set_aside', null, { kinds, min, n: r.changes });
    res.json({ ok: true, n: r.changes, gmail: gm });
  });
  app.post('/api/bookkeeping/scan', ...guard, async (req, res) => { try { const r = await scanInbox(userId(req)); const p = await parseNewEmails(userId(req)); res.json({ ok: true, scan: r, parsed: p }); } catch (e) { res.json({ ok: false, error: e.message }); } });
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
        webhook: NOVA_URL + '/api/bookkeeping/plaid/webhook', transactions: { days_requested: 90 } });
      res.json({ ok: true, link_token: j.link_token, env: PLAID_ENV });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/plaid/exchange', ...guard, async (req, res) => {
    try {
      const j = await plaid('/item/public_token/exchange', { public_token: String(req.body.public_token || '') });
      let inst = String((req.body.metadata && req.body.metadata.institution && req.body.metadata.institution.name) || 'Bank');
      const accts = (req.body.metadata && req.body.metadata.accounts || []).map(a => ({ account_id: a.id, name: a.name, mask: a.mask, type: a.subtype || a.type }));
      await dbRun('INSERT INTO bk_accounts (item_id, access_token, institution, accounts, created_by) VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET access_token = excluded.access_token, institution = excluded.institution, accounts = excluded.accounts',
        [j.item_id, enc(j.access_token), inst, JSON.stringify(accts), userId(req)]);
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
