'use strict';
// Nova AR (1.19.152) — Accounts Receivable queue for Karen.
//
// Every bank deposit filed as a customer payment lands here instead of in an email to payments@. Nova reads the
// open invoices from the production DB (read-only), suggests the invoice(s) the money most likely pays — by amount
// (balance to the cent, or the invoice total), by the payer's name in the bank wording, and by a few invoices of
// one customer adding up — and a person clicks Matched. Nothing is written to the production DB: the match is kept
// in SQLite `bk_ar` and the CRM is still updated by the AR team in the CRM itself.
//
// Tabs: Unmatched (status open) · Matched (matched + skipped, the history). Filters: date range, amount range, search.

module.exports = function mountAr(ctx) {
  const { app, guard, agingGuard, isAr, dbAll, dbGet, dbRun, runQuery, mysql, audit, userId, nowIso, realCheckNo, errlog, people } = ctx;

  // 1.19.152: the queue
  ctx.db.serialize(() => {
    ctx.db.run(`CREATE TABLE IF NOT EXISTS bk_ar (id INTEGER PRIMARY KEY AUTOINCREMENT, txn_id INTEGER UNIQUE, status TEXT DEFAULT 'open',
      amount REAL, invoice_ids TEXT, customer_id INTEGER, customer_name TEXT, note TEXT, matched_by TEXT, matched_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    // 1.20.2: kind = 'match' (an open invoice — Match & Pay) or 'pair' (an invoice the CRM already shows as paid); pay_* = the
    // Dev team's pay webhook result once AR_PAY_WEBHOOK_URL is set
    ['kind TEXT', 'pay_status TEXT', 'pay_at TEXT', 'pay_ref TEXT', 'inv_json TEXT'].forEach(c => ctx.db.run('ALTER TABLE bk_ar ADD COLUMN ' + c, () => {}));
    // 1.20.83: AR rules — the payer words of a bank line → a CRM customer. Learned from every match / pair the AR team makes
    // (and typed by hand under Rules). A rule only narrows the matching to that customer's invoices; it never pairs by itself.
    ctx.db.run(`CREATE TABLE IF NOT EXISTS bk_ar_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT, customer_id INTEGER, customer_name TEXT,
      source TEXT DEFAULT 'learned', made_by TEXT, hits INTEGER DEFAULT 0, last_hit_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    ctx.db.run('CREATE UNIQUE INDEX IF NOT EXISTS bk_ar_rules_pat ON bk_ar_rules(pattern)', () => {});
    // 1.20.84: one payer can be several CRM accounts (Peace & Haight × 5 contacts) — customer_ids is the comma list; customer_id = the first
    ctx.db.run('ALTER TABLE bk_ar_rules ADD COLUMN customer_ids TEXT', () => {});
  });
  const crypto = require('crypto');
  const env = (k) => String(process.env[k] || '').trim();

  // Which categories mean "a customer paid us": the chart's Customer Payment(s) / Client Payment(s) — name based, so a
  // renamed sub category keeps working as long as the words stay.
  const isArCategory = (c) => /\b(customer|client)\s+payments?\b/i.test(String(c || ''));

  // Put every categorized deposit filed as a customer payment into the queue; drop (void) open rows whose line was
  // re-filed somewhere else or uncategorized.
  // 1.20.3: the queue starts at AR_FROM (bank date; .env, default 2026-10-01) — older deposits were handled by email before Nova AR
  // and only cloud the list. Rows already queued from before the cut-off are set aside as 'old' (never shown, never counted).
  const AR_FROM = /^\d{4}-\d{2}-\d{2}$/.test(env('AR_FROM')) ? env('AR_FROM') : '2026-10-01';
  // 1.20.86: Acct Aging starts at AR_AGING_FROM (invoice date; default 2025-01-01) — 2024 and older are not chased any more
  const AR_AGING_FROM = /^\d{4}-\d{2}-\d{2}$/.test(env('AR_AGING_FROM')) ? env('AR_AGING_FROM') : '2025-01-01';
  const ymdOf = (v) => v instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(v) : String(v || '').slice(0, 10);
  // 1.20.5: a Los Angeles calendar day as an ISO instant — its start, or (end) the start of the next day; matched_at is UTC ISO
  function laBound(ymd, end) {
    const [y, m, d] = ymd.split('-').map(Number);
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const la = (t) => { const o = {}; f.formatToParts(new Date(t)).forEach(x => { o[x.type] = x.value; }); return Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour), Number(o.minute), Number(o.second)); };
    const want = Date.UTC(y, m - 1, d + (end ? 1 : 0), 0);
    let guess = want;
    for (let i = 0; i < 2; i++) guess += want - la(guess);
    return new Date(guess).toISOString();
  }
  const bankDate = (t) => { let d = t.tx_date; if (!d && t.raw) { try { const raw = JSON.parse(t.raw); d = raw.authorized_date || raw.date; } catch (e) {} } return String(d || t.date || '').slice(0, 10); };
  async function syncQueue() {
    const rows = await dbAll("SELECT id, amount, category, date, raw FROM bk_transactions WHERE status = 'categorized' AND amount < 0 AND category IS NOT NULL AND transfer_of IS NULL AND refund_of IS NULL");
    let added = 0;
    const fresh = rows.filter(t => isArCategory(t.category) && bankDate(t) >= AR_FROM), stale = rows.filter(t => isArCategory(t.category) && bankDate(t) < AR_FROM);
    for (const t of fresh) {
      const r = await dbRun('INSERT OR IGNORE INTO bk_ar (txn_id, amount) VALUES (?, ?)', [t.id, Math.abs(Number(t.amount))]);
      if (r.changes) added++;
    }
    if (stale.length) await dbRun("UPDATE bk_ar SET status = 'old', updated_at = ? WHERE status IN ('open', 'void') AND txn_id IN (" + stale.map(t => t.id).join(',') + ')', [nowIso()]);
    const keep = new Set(fresh.map(t => t.id));
    const open = await dbAll("SELECT id, txn_id FROM bk_ar WHERE status = 'open'");
    for (const q of open) if (!keep.has(q.txn_id)) await dbRun("UPDATE bk_ar SET status = 'void', updated_at = ? WHERE id = ?", [nowIso(), q.id]);
    // a voided row whose line is a customer payment again comes back
    await dbRun("UPDATE bk_ar SET status = 'open', updated_at = ? WHERE status = 'void' AND txn_id IN (" + (keep.size ? Array.from(keep).join(',') : '0') + ")", [nowIso()]);
    return added;
  }

  // ---- open invoices from the production DB (read-only), cached 5 minutes
  const SEL_ONE = "SELECT i.id, i.invoice_type AS type, i.invoice_total_payment AS total, i.invoice_total_payment_done AS done, i.payment_status, i.invoice_creation_date AS created, i.payment_due_date AS due, i.PO_number AS po, i.invoice_clientid AS customer_id, i.updated_at, " +
    "c.company_name, c.name, c.last_name, c.email, c.manager_id FROM invoice i LEFT JOIN customer c ON c.id = i.invoice_clientid";
  function shapeInvoice(r) {
    const o = { id: r.id, no: 'INV' + r.id, type: r.type || 'invoice', total: Number(r.total) || 0, done: Number(r.done) || 0, balance: r.payment_status === 'paid' ? Number(r.total) || 0 : Math.round(((Number(r.total) || 0) - (Number(r.done) || 0)) * 100) / 100, status: r.payment_status, created: r.created, due: r.due, po: r.po || null, paid_at: r.payment_status === 'paid' ? r.updated_at : null,
      customer_id: r.customer_id, company: r.company_name || '', person: [r.name, r.last_name].filter(Boolean).join(' '), email: r.email || '', manager_id: r.manager_id || null };
    o.customer = o.company || o.person || (o.customer_id ? 'Customer #' + o.customer_id : 'No customer on the invoice');
    o._k = keyWords(o.company + ' ' + o.person + ' ' + (o.email || '').split('@')[0]);
    o._c = compact(o.company); if (o._c.length < 5) o._c = '';   // 1.20.10: "4Over" against "4 OVER, LLC PAYMENTS…", "WILD WEST SOCIAL" against "Wild West Social House"

    return o;
  }
  const inv = { at: 0, rows: [], error: null }, sugCache = new Map();
  async function openInvoices(force) {
    if (!runQuery) return [];
    if (!force && Date.now() - inv.at < 5 * 60000) return inv.rows;
    // open invoices, plus the ones marked paid in the last 90 days (AR often marks the CRM before the bank posts — shown as "already paid in the CRM")
    // two queries, each on an index (payment_status; id range for the recent paid ones) — one OR over both made MySQL scan the table
    const SEL = SEL_ONE + " WHERE i.invoice_type = 'invoice' AND i.invoice_total_payment > 0 AND ";
    const open = await runQuery(SEL + "i.payment_status IN ('unpaid', 'partial') ORDER BY i.id DESC LIMIT 20000");
    const maxId = (await runQuery('SELECT MAX(id) AS m FROM invoice'))[0].m || 0;
    const paid = await runQuery(SEL + "i.payment_status = 'paid' AND i.id > " + (Number(maxId) - 6000) + " AND i.invoice_creation_date >= DATE_SUB(NOW(), INTERVAL 120 DAY) ORDER BY i.id DESC LIMIT 6000");   // the last ~6k invoices cover several months
    const rows = open.concat(paid);
    inv.rows = rows.map(shapeInvoice);
    // words shared by many customers ("designs", "events", "church") say nothing about who paid — drop them from the keys
    const df = {}; const seen = {}; inv.rows.forEach(r => { if (seen[r.customer_id]) return; seen[r.customer_id] = 1; r._k.forEach(w => { df[w] = (df[w] || 0) + 1; }); });
    const common = new Set(Object.keys(df).filter(w => df[w] > 25));
    inv.rows.forEach(r => { r._k = r._k.filter(w => !common.has(w)); });
    inv.byId = new Map(inv.rows.map(r => [r.id, r])); inv.common = common; inv.extra = new Map();
    inv.at = Date.now(); return inv.rows;
  }
  // 1.20.10: invoices the 5-minute set does not hold but this deposit points at — read from the CRM on the spot and kept
  // beside the set (`inv.extra`, so byId / snapshots find them): the invoice numbers typed in the memo, and every invoice
  // whose total or balance equals the deposit to the cent, whatever its age or status (the amount is the first proof —
  // INV125839 from May, paid in the CRM on 10/06, was outside the paid window and never suggested)
  async function extraFor(t, invoices) {
    if (!runQuery || !inv.byId) return [];
    const amt = Math.round(Math.abs(Number(t.amount)) * 100) / 100;
    const text = [t.name, t.merchant, t.orig_desc].filter(Boolean).join(' ');
    const want = invoiceNos(text).filter(id => !inv.byId.has(id) && !inv.extra.has(id));
    const add = (rows) => rows.map(shapeInvoice).filter(r => !inv.byId.has(r.id)).map(r => { r._k = r._k.filter(w => !inv.common.has(w)); inv.extra.set(r.id, r); inv.byId.set(r.id, r); return r; });
    const out = [];
    try {
      if (want.length) out.push(...add(await runQuery(SEL_ONE + ' WHERE i.id IN (' + want.map(n => Math.floor(n)).join(',') + ')')));
      if (amt >= 1) {
        const a = amt.toFixed(2);
        const hit = await runQuery(SEL_ONE + " WHERE i.invoice_type = 'invoice' AND i.payment_status IN ('unpaid', 'partial', 'paid') AND (i.invoice_total_payment = " + a + " OR ROUND(i.invoice_total_payment - i.invoice_total_payment_done, 2) = " + a + ") ORDER BY i.id DESC LIMIT 20");
        out.push(...add(hit)); hit.forEach(r => { const x = inv.byId.get(r.id); if (x && out.indexOf(x) < 0 && invoices.indexOf(x) < 0) out.push(x); });
      }
    } catch (e) { errlog('ar extra', e.message); }
    return out;
  }

  // words worth matching on, from either side
  const NOISE = new Set(['the', 'and', 'inc', 'llc', 'ltd', 'corp', 'co', 'company', 'deposit', 'mobile', 'online', 'transfer', 'from', 'ref', 'number', 'ach', 'credit', 'payment', 'payments', 'pmt', 'zelle', 'venmo', 'paypal', 'check', 'chk', 'wire', 'incoming', 'des', 'id', 'indn', 'ppd', 'ccd', 'web', 'trn', 'orig', 'name', 'axiom', 'axiomprint', 'print', 'printing', 'invoice', 'inv', 'bill', 'pay', 'to', 'of', 'for', 'business', 'account', 'merchant', 'merch', 'dep', 'stripe', 'square', 'intuit', 'quickbooks', 'bank', 'wells', 'fargo', 'chase', 'amex', 'usd']);
  const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(inc|llc|ltd|corp|co)$/, '');
  function keyWords(s) {
    return Array.from(new Set(String(s || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').split(' ').filter(w => w.length >= 3 && !NOISE.has(w) && !/^\d+$/.test(w))));
  }
  // numbers in the wording that look like one of our invoice ids (6 digits, 1xxxxx) — a customer who typed the invoice number into the memo
  const invoiceNos = (s) => { const out = new Set(); const re = /(?:^|[^0-9])(1\d{5})(?![0-9])/g; let m; const str = String(s || ''); while ((m = re.exec(str))) out.add(Number(m[1])); return Array.from(out); };   // "INV129964", "#135244", "Inv 135244" — INV glued to the digits is no word boundary

  // ---- 1.20.83: AR rules. pattern = the payer words of the bank wording (keyWords: no numbers, no bank / payment noise), so
  // "PEACE & HAIGHT I PAYMENT 261014 20261014AC" → "peace haight". A deposit matches a rule when every word of the rule is in it.
  const payerPattern = (t) => keyWords([t.name, t.merchant, t.orig_desc].filter(Boolean).join(' ')).filter(w => !/\d/.test(w)).slice(0, 5).join(' ');   // no reference codes (996pvahlt1cant3) — only the payer's words
  let rulesCache = { at: 0, rows: [] };
  const ruleIds = (r) => { const ids = String(r.customer_ids || '').split(',').map(Number).filter(Boolean); if (!ids.length && r.customer_id) ids.push(Number(r.customer_id)); return ids; };
  async function arRules(force) {
    if (force || Date.now() - rulesCache.at > 60000) { rulesCache = { at: Date.now(), rows: await dbAll('SELECT * FROM bk_ar_rules ORDER BY LENGTH(pattern) DESC, id') }; }
    return rulesCache.rows;
  }
  async function ruleFor(t) {
    const words = new Set(keyWords([t.name, t.merchant, t.orig_desc].filter(Boolean).join(' ')));
    if (!words.size) return null;
    for (const r of await arRules()) { const w = String(r.pattern || '').split(' ').filter(Boolean); if (w.length && w.every(x => words.has(x))) return r; }
    return null;
  }
  // learned on every match / pair / manual entry: the payer words of this deposit → the customer the AR team chose
  async function learnRule(t, customerId, customerName, who) {
    const pat = payerPattern(t); if (!pat || !customerId) return null;
    if (pat.split(' ').length < 1 || pat.length < 4) return null;
    const cur = await dbGet('SELECT * FROM bk_ar_rules WHERE pattern = ?', [pat]);
    // 1.20.84: a second account chosen for the same payer words joins the rule (several CRM accounts, one payer) instead of replacing it
    if (cur) { const ids = ruleIds(cur); if (ids.indexOf(Number(customerId)) < 0) { ids.push(Number(customerId)); const names = String(cur.customer_name || '').split(' · ').filter(Boolean); if (customerName && names.indexOf(customerName) < 0) names.push(customerName); await dbRun('UPDATE bk_ar_rules SET customer_ids = ?, customer_name = ?, made_by = ?, updated_at = ? WHERE id = ?', [ids.join(','), names.join(' · ') || null, who, nowIso(), cur.id]); } }
    else await dbRun('INSERT INTO bk_ar_rules (pattern, customer_id, customer_ids, customer_name, source, made_by, updated_at) VALUES (?,?,?,?,?,?,?)', [pat, customerId, String(customerId), customerName || null, 'learned', who, nowIso()]);
    rulesCache.at = 0; return pat;
  }
  // the suggestions for one deposit (1.19.154 — the AR team's order of proof):
  //   1. the amount: the invoice's balance due (or its total) to the cent — the base of every real match (60)
  //   2. the date: an invoice created within 30 days before the payment (+25), within 60 days (+12), older (+0)
  //   3. the client: the payer's words on the bank line match the customer (+10)
  //   an invoice number typed in the memo (+30) and 2–3 invoices of one customer adding up (50 base) ride on the same scale;
  //   a payer we recognise but no amount fits is shown low ("payer name only" 15, or "partial payment" 30 when the deposit is
  //   smaller than their balance) so Karen still has a lead. An invoice already marked paid in the CRM is shown as such.
  const DAY = 864e5;
  function suggest(t, invoices, rule) {
    const amt = Math.round(Math.abs(Number(t.amount)) * 100) / 100;
    const text = [t.name, t.merchant, t.orig_desc].filter(Boolean).join(' ');
    const words = keyWords(text), nos = invoiceNos(text), ctext = compact(text);
    // 1.20.83: a payer rule narrows the field to that customer's invoices (+ any invoice number typed in the memo) and lifts them;
    // with nothing of theirs open the general matching runs as before. Never a pair by itself — the person still clicks.
    if (rule) {
      const rids = ruleIds(rule), isMine = (cid) => rids.indexOf(Number(cid)) > -1;
      const mine = invoices.filter(r => isMine(r.customer_id) || nos.indexOf(r.id) > -1);
      if (mine.length) {
        const out = suggest(t, mine, null).map(s => Object.assign({}, s, { score: Math.min(100, s.score + (isMine(s.customer_id) ? 20 : 0)), why: (isMine(s.customer_id) ? ['payer rule: ' + (s.customer || rule.customer_name)] : []).concat(s.why), rule: true }));
        // a known payer with no amount fit: still show their open invoices so the AR person can pick (partial / bulk)
        if (!out.length) { const open = mine.filter(r => r.status !== 'paid').sort((a, b) => String(b.created || '').localeCompare(String(a.created || ''))).slice(0, 3);
          open.forEach(r => out.push({ score: 35, why: ['payer rule: ' + (r.customer || rule.customer_name), amt < r.balance - 0.005 ? 'partial payment? ' + usd(amt) + ' of ' + usd(r.balance) : 'amount does not fit this invoice'], customer: r.customer, customer_id: r.customer_id, kind: 'match', rule: true,
            invoices: [{ id: r.id, no: r.no, total: r.total, balance: r.balance, status: r.status, created: r.created, due: r.due, po: r.po, customer: r.customer, paid_at: r.paid_at }] })); }
        if (out.length) return out.slice(0, 5);
      }
    }
    const paidOn = new Date(String(t.tx_date || t.date || '').slice(0, 10) + 'T12:00:00Z').getTime();
    const ageDays = (r) => { const c = r.created ? new Date(r.created).getTime() : NaN; return isNaN(c) || isNaN(paidOn) ? null : Math.round((paidOn - c) / DAY); };
    // 1.20.3: fresh = within 30 days (+25); 31–60 days 10 points less (+15); older nothing
    const datePts = (r) => { const d = ageDays(r); if (d == null) return [0, null]; if (d >= -3 && d <= 30) return [25, 'invoiced ' + d + ' day' + (d === 1 ? '' : 's') + ' before']; if (d > 30 && d <= 60) return [15, 'invoiced ' + d + ' days before']; return [0, d > 60 ? 'invoiced ' + d + ' days before' : 'invoiced after the payment']; };
    const out = [], keys = new Set();
    const push = (ids, score, why, cust) => { const key = ids.length > 1 ? ids.slice().sort().join(',') : null; if (key) { if (keys.has(key)) return; keys.add(key); } out.push({ invoice_ids: ids, score, why, customer: cust }); };
    const nameHit = (r) => { if (r._c && ctext.indexOf(r._c) > -1) return 1; if (!words.length || !r._k.length) return 0; let n = 0; for (const w of words) for (const k of r._k) if (k === w || (w.length >= 5 && k.length >= 5 && (k.indexOf(w) === 0 || w.indexOf(k) === 0))) { n++; break; } return n; };
    for (const r of invoices) {
      const age = ageDays(r); if (age != null && age > 730) continue;   // 1.20.4: an invoice open for over two years is not what a fresh deposit pays
      const exactBal = Math.abs(r.balance - amt) < 0.005, exactTot = !exactBal && Math.abs(r.total - amt) < 0.005;
      const nh = nameHit(r), memo = nos.indexOf(r.id) > -1;
      let score = 0; const why = [];
      if (exactBal || exactTot) {
        score += exactBal ? 60 : 50; why.push(exactBal ? (r.status === 'partial' ? 'balance due to the cent' : 'amount to the cent') : 'invoice total to the cent');
        const [dp, dw] = datePts(r); score += dp; if (dw) why.push(dw);
      }
      if (memo) { score += 30; why.unshift('invoice number in the memo'); }
      if (nh) { score += 10; why.push('client: ' + r.customer); }
      if (!exactBal && !exactTot && !memo && nh) {   // the payer is a known client but no invoice fits the amount
        if (r.status !== 'paid' && amt < r.balance - 0.005) { score = 30; why.push('partial payment? ' + usd(amt) + ' of ' + usd(r.balance)); }
        else score = 15, why.push('payer name only');
      }
      if (r.status === 'paid') why.push('already paid in the CRM — pair it');   // 1.20.2: full score; the button becomes Pair
      if (score >= 15) push([r.id], Math.min(100, score), why, r);
    }
    // 2–3 invoices of one customer adding up to the deposit
    // 1.20.10: paid invoices of the customer count too — 4 Over's $3,545.76 was INV132547 + INV132523, both already marked paid (→ Pair)
    const byCust = {}; invoices.forEach(r => { if (r.customer_id && (ageDays(r) == null || ageDays(r) <= 365)) (byCust[r.customer_id] = byCust[r.customer_id] || []).push(r); });
    for (const cid of Object.keys(byCust)) {
      const list = byCust[cid].slice(0, 12); if (list.length < 2) continue;
      const nh = nameHit(list[0]);
      const combo = (ids, label) => { const rs = ids.map(id => list.find(x => x.id === id)); const dp = Math.min(...rs.map(r => datePts(r)[0])); const paidN = rs.filter(r => r.status === 'paid').length; push(ids, Math.min(100, 50 + dp + (nh ? 10 : 0)), [label, dp === 25 ? 'all invoiced within 30 days' : dp === 15 ? 'all invoiced within 60 days' : 'older invoices'].concat(nh ? ['client: ' + list[0].customer] : []).concat(paidN ? [paidN === rs.length ? 'all already paid in the CRM — pair them' : paidN + ' of them already paid in the CRM'] : []), list[0]); };
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        if (Math.abs(list[i].balance + list[j].balance - amt) < 0.005) combo([list[i].id, list[j].id], 'two invoices add up');
        else for (let k = j + 1; k < list.length; k++) if (Math.abs(list[i].balance + list[j].balance + list[k].balance - amt) < 0.005) combo([list[i].id, list[j].id, list[k].id], 'three invoices add up');
      }
    }
    out.sort((a, b) => b.score - a.score || b.invoice_ids[0] - a.invoice_ids[0]);
    const top = out.slice(0, 5), byId = inv.byId || new Map(invoices.map(r => [r.id, r]));
    return top.map(o => ({ score: o.score, why: o.why, customer: o.customer.customer, customer_id: o.customer.customer_id, kind: o.invoice_ids.every(id => { const r = byId.get(id); return r && r.status === 'paid'; }) ? 'pair' : 'match',
      invoices: o.invoice_ids.map(id => { const r = byId.get(id); return r ? { id: r.id, no: r.no, total: r.total, balance: r.balance, status: r.status, created: r.created, due: r.due, po: r.po, customer: r.customer, paid_at: r.paid_at } : { id, no: 'INV' + id }; }) }));
  }
  const usd = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 1.20.1: Credit card / ACH / Check / Zelle / Wire / Mobile deposit / Online — from the bank wording first, Plaid's channel second
  function payMethod(r) {
    let raw = null; try { raw = r.raw ? JSON.parse(r.raw) : null; } catch (e) {}
    const w = [r.name, r.merchant, raw && raw.original_description].filter(Boolean).join(' ').toLowerCase();
    const cn = raw ? realCheckNo(raw, r) : null;
    if (/\bzelle\b/.test(w)) return 'Zelle';
    if (/\bvenmo\b/.test(w)) return 'Venmo';
    if (/\bpaypal\b/.test(w)) return 'PayPal';
    if (/\bwire\b|\bfedwire\b|\bwt fed\b|\bintl wire\b/.test(w)) return 'Wire';
    if (/mobile deposit|remote deposit|\brdc\b/.test(w)) return 'Mobile deposit (check)';
    if (cn || /\bcheck\b|\bchk\b|deposited check|check deposit/.test(w)) return 'Check' + (cn ? ' #' + cn : '');
    if (/merchant account|merch dep|merchant dep|bankcard|bnkcrd|\bstripe\b|\bsquare\b|\bauthnet\b|authorize\.net|\bclover\b|\bpaymentech\b|\bamex\b|\bvisa\b|\bmastercard\b|\bcard\b/.test(w)) return 'Credit card';
    if (/\bach\b|\bintachtrn\b|bill\.com|\bppd\b|\bccd\b|\bb2b\b|business to business|\beft\b|direct dep|\bdeposit\b.*\bref\b/.test(w)) return 'ACH';
    if (raw && raw.payment_channel === 'in store') return 'In branch';
    if (raw && raw.payment_channel === 'online') return 'Online';
    if (/\bdeposit\b/.test(w)) return 'Deposit';
    return '';
  }
  const txFields = async (ids) => {
    if (!ids.length) return {};
    const rows = await dbAll('SELECT t.id, t.date, t.created_at, t.updated_at, t.name, t.merchant, t.amount, t.raw, t.account_name, t.account_ref, t.category, t.category_source, t.category_by, t.rule_id, t.vendor_id, v.name AS vendor_name, v.photo AS vendor_photo, ba.institution, ba.logo AS bank_logo, ba.color AS bank_color, ba.accounts AS bank_accounts, ru.kind AS rule_kind, ru.pattern AS rule_pattern FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id LEFT JOIN bk_rules ru ON ru.id = t.rule_id WHERE t.id IN (' + ids.map(() => '?').join(',') + ')', ids);
    // who filed the line as a customer payment, for lines categorized before category_by existed: the audit trail
    const audits = {}; try { (await dbAll("SELECT ref, who FROM bk_audit WHERE action IN ('category.manual', 'category.apply') AND ref IN (" + ids.map(() => '?').join(',') + ') ORDER BY id', ids.map(String))).forEach(a => { audits[a.ref] = a.who; }); } catch (e) {}
    const m = {};
    for (const r of rows) {
      // 1.20.1: how the money came in, from the wording and Plaid's channel
      r.how = payMethod(r); r.synced_at = r.created_at;
      // 1.20.1: who / what filed it as a customer payment
      const src = r.category_source || '';
      r.filed = src === 'rule' ? { kind: 'rule', label: 'Auto rule', detail: r.rule_pattern ? (r.rule_kind === 'keyword' ? 'contains "' + r.rule_pattern + '"' : 'vendor is ' + r.rule_pattern) : '' }
        : src === 'approved' || src === 'ai' ? { kind: 'person', label: 'AI, approved by', who: r.category_by || audits[String(r.id)] || '' }
        : src === 'manual' || src === 'vendor' || src === 'history' ? { kind: 'person', label: 'Manually by', who: r.category_by || audits[String(r.id)] || '' }
        : src === 'refund' ? { kind: 'rule', label: 'Refund match', detail: '' } : { kind: 'rule', label: src ? src.charAt(0).toUpperCase() + src.slice(1) : 'Auto', detail: '' };
      r.filed_at = r.updated_at || null;
      let accts = []; try { accts = JSON.parse(r.bank_accounts || '[]'); } catch (e) {}
      const a = accts.find(x => x.account_id === r.account_ref); r.mask = a && a.mask ? a.mask : null; delete r.bank_accounts;
      let raw = null; try { raw = r.raw ? JSON.parse(r.raw) : null; } catch (e) {} delete r.raw;
      if (raw) { r.orig_desc = raw.original_description || null; const cn = realCheckNo(raw, r); r.check_no = cn; r.channel = cn ? 'check' : raw.payment_channel === 'in store' ? 'store' : raw.payment_channel === 'online' ? 'online' : (raw.payment_channel || null); r.tx_date = raw.authorized_date || raw.date || null; }
      m[r.id] = r;
    }
    return m;
  };

  // GET /api/bookkeeping/ar/me — what the AR-only page needs instead of the full Bookkeeping overview (1.19.153)
  app.get('/api/bookkeeping/ar/me', ...agingGuard, async (req, res) => {   /* 1.20.88: aging-only people open the page too — `ar` says whether the queue is theirs */
    try { const ar = isAr(req); let pl = []; try { pl = people && ar ? await people.list() : []; } catch (e) {} res.json({ ok: true, me: userId(req), ar, people: pl, open: ar ? (await dbGet("SELECT COUNT(*) n FROM bk_ar WHERE status IN ('open', 'review')")).n : 0 }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // 1.20.14: the left menu's badge — the open queue (synced first, so a fresh customer payment counts at once)
  app.get('/api/bookkeeping/ar/unread-count', ...agingGuard, async (req, res) => {
    if (!isAr(req)) return res.json({ ok: true, unread: 0 });   /* 1.20.88: no queue badge for aging-only people */
    try { await syncQueue(); res.json({ ok: true, unread: (await dbGet("SELECT COUNT(*) n FROM bk_ar WHERE status IN ('open', 'review')")).n }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // GET /api/bookkeeping/ar?status=open|done&from&to&min&max&q
  app.get('/api/bookkeeping/ar', ...guard, async (req, res) => {
    try {
      await syncQueue();
      const st = req.query.status === 'done' ? 'done' : 'open';
      const where = [st === 'open' ? "q.status IN ('open', 'review')" : "q.status IN ('matched', 'skipped')"], p = [];   // 1.20.83: review = matched, waiting for Match & Pay
      if (req.query.from) { where.push('date(t.created_at) >= ?'); p.push(String(req.query.from)); }   // 1.20.1: the Synced column is the date filter
      if (req.query.to) { where.push('date(t.created_at) <= ?'); p.push(String(req.query.to)); }
      if (st === 'done') {   // 1.20.5: the Matched tab is filtered on when the match was made (LA calendar days; default last 30 on the page)
        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.mfrom || '')) { where.push('q.matched_at >= ?'); p.push(laBound(req.query.mfrom, false)); }
        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.mto || '')) { where.push('q.matched_at < ?'); p.push(laBound(req.query.mto, true)); }
      }
      if (req.query.min !== undefined && req.query.min !== '') { where.push('q.amount >= ?'); p.push(Number(req.query.min) || 0); }
      if (req.query.max !== undefined && req.query.max !== '') { where.push('q.amount <= ?'); p.push(Number(req.query.max) || 0); }
      const q = String(req.query.q || '').trim().toLowerCase();
      const rows = await dbAll('SELECT q.*, t.date FROM bk_ar q JOIN bk_transactions t ON t.id = q.txn_id WHERE ' + where.join(' AND ') + ' ORDER BY ' + (st === 'open' ? 't.created_at DESC, t.date DESC' : 'q.matched_at DESC') + ' LIMIT 500', p);
      const tx = await txFields(rows.map(r => r.txn_id));
      // 1.19.159: the list itself never touches the CRM — the invoices are read when the first row asks for its suggestions
      // (or here when the cache is warm / a refresh was asked), so the page shows the queue at once
      let invoices = inv.rows; let crm_error = inv.error || null;
      if (req.query.fresh === '1') { try { invoices = await openInvoices(true); crm_error = null; } catch (e) { crm_error = e.message; } }
      const out = [];
      for (const r of rows) {
        if (!tx[r.txn_id]) { if (r.status === 'open') dbRun("UPDATE bk_ar SET status = 'void', updated_at = ? WHERE id = ?", [nowIso(), r.id]).catch(() => {}); continue; }   // 1.20.11: a bank line that is gone leaves no empty row
        const t = tx[r.txn_id]; const row = Object.assign({}, r, { txn: t });
        if (q && [t.name, t.merchant, t.orig_desc, r.customer_name, r.invoice_ids, r.note, String(r.amount)].filter(Boolean).join(' ').toLowerCase().indexOf(q) < 0) continue;
        if (st === 'open') { row.suggestions = null; if (r.status === 'review') { try { row.invoices = r.inv_json ? JSON.parse(r.inv_json) : []; } catch (e) { row.invoices = []; } delete row.inv_json; } }   // null = the page asks /ar/:id/suggest for it (1.19.159: the list never waits on the matching; 1.20.83: the cache key carries the rule, so the row route decides)
        else {   // 1.20.6: from the local snapshot taken at match time; older rows fall back to the warm cache (never a CRM call)
          let snap = null; try { snap = r.inv_json ? JSON.parse(r.inv_json) : null; } catch (e) {}
          const ids = String(r.invoice_ids || '').split(',').filter(Boolean).map(Number);
          row.invoices = ids.map(id => { const s = snap && snap.find(x => x.id === id); if (s) return s; const x = inv.byId ? inv.byId.get(id) : null; return x ? pick(x) : { id, no: 'INV' + id }; });
          if (!snap && ids.length && row.invoices.every(i => i.customer_id !== undefined)) dbRun('UPDATE bk_ar SET inv_json = ? WHERE id = ?', [JSON.stringify(row.invoices), r.id]).catch(() => {});   // older matches: keep the snapshot once the cache has it
          delete row.inv_json;
        }
        out.push(row);
      }
      const counts = await dbGet("SELECT SUM(status IN ('open', 'review')) AS open, SUM(status = 'review') AS review, SUM(status IN ('matched', 'skipped')) AS done, SUM(CASE WHEN status IN ('open', 'review') THEN amount ELSE 0 END) AS open_total FROM bk_ar");
      res.json({ ok: true, rows: out, counts: { open: counts.open || 0, review: counts.review || 0, done: counts.done || 0, open_total: Math.round((counts.open_total || 0) * 100) / 100 }, invoices_open: invoices.length, invoices_at: inv.at, crm_error, from: AR_FROM });
    } catch (e) { errlog('ar list', e.message); res.json({ ok: false, error: e.message }); }
  });
  // GET /api/bookkeeping/ar/:id/suggest — the suggestions for one payment (the page asks row by row, a few at a time)
  app.get('/api/bookkeeping/ar/:id/suggest', ...guard, async (req, res) => {
    try {
      const q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [parseInt(req.params.id)]); if (!q) return res.json({ ok: false, error: 'No such payment' });
      let invoices; try { invoices = await openInvoices(); inv.error = null; } catch (e) { inv.error = e.message; return res.json({ ok: false, error: 'CRM not reachable: ' + e.message, crm_error: e.message }); }
      const ck = q.txn_id + ':' + inv.at;
      const t0 = (await txFields([q.txn_id]))[q.txn_id] || {}; const rule = await ruleFor(t0);
      const ck2 = ck + ':' + (rule ? rule.id + '.' + (rule.updated_at || '') : '0');
      if (!sugCache.has(ck2)) { if (sugCache.size > 2000) sugCache.clear(); const extra = await extraFor(t0, invoices); sugCache.set(ck2, invoices.length || extra.length ? suggest(t0, invoices.concat(extra), rule) : []); if (rule) dbRun("UPDATE bk_ar_rules SET hits = hits + 1, last_hit_at = ? WHERE id = ?", [nowIso(), rule.id]).catch(() => {}); }
      res.json({ ok: true, suggestions: sugCache.get(ck2), rule: rule ? { id: rule.id, customer: rule.customer_name, customer_id: rule.customer_id, customer_ids: ruleIds(rule), pattern: rule.pattern } : null, invoices_open: invoices.length, invoices_at: inv.at });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // GET /api/bookkeeping/ar/invoices?q= — look an invoice up by number, customer, company or PO for "Other invoice…"
  app.get('/api/bookkeeping/ar/invoices', ...guard, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase(); if (!q) return res.json({ ok: true, invoices: [] });
      const invoices = await openInvoices();
      // 1.20.10: several numbers at once ("125839, 125840 125841") — a bulk payment typed in by hand; each read from the CRM when needed
      const many = q.split(/[\s,;]+/).map(x => Number(x.replace(/^#/, '').replace(/^inv/i, ''))).filter(n => n >= 100000);
      if (many.length > 1 && runQuery) {
        const found = []; const miss = many.filter(id => { const x = inv.byId && inv.byId.get(id); if (x) found.push(x); return !x; });
        if (miss.length) (await runQuery(SEL_ONE + ' WHERE i.id IN (' + miss.map(n => Math.floor(n)).join(',') + ')')).map(shapeInvoice).forEach(r => { found.push(r); if (inv.byId && !inv.byId.has(r.id)) { inv.byId.set(r.id, r); inv.extra && inv.extra.set(r.id, r); } });
        const lost = many.filter(id => !found.some(r => r.id === id));
        return res.json({ ok: true, invoices: found.map(r => ({ id: r.id, no: r.no, total: r.total, balance: r.balance, status: r.status, created: r.created, due: r.due, po: r.po, customer: r.customer, customer_id: r.customer_id, paid_at: r.paid_at })), note: lost.length ? 'Not in the CRM: INV' + lost.join(', INV') : null, many: true });
      }
      const n = Number(q.replace(/^#/, '').replace(/^inv\s*/i, ''));
      let hits = invoices.filter(r => (n && String(r.id).indexOf(String(n)) === 0) || r.customer.toLowerCase().indexOf(q) > -1 || r.person.toLowerCase().indexOf(q) > -1 || (r.po && String(r.po).toLowerCase().indexOf(q) > -1) || (r.email && r.email.toLowerCase().indexOf(q) > -1)).slice(0, 25);
      let note = null;
      // 1.20.4: a full invoice number Nova's set does not hold is read from the CRM on the spot — and the reply says why the
      // matcher never saw it (paid long ago, void, an estimate…), which is the diagnosis when a match "should have" happened
      if (n >= 100000 && !hits.some(r => r.id === n) && runQuery) {
        const rows = await runQuery(SEL_ONE + ' WHERE i.id = ' + Math.floor(n));
        if (rows.length) { const r = shapeInvoice(rows[0]); hits = [r].concat(hits); note = 'INV' + r.id + ' is in the CRM as ' + r.status + (r.type !== 'invoice' ? ' (type ' + r.type + ')' : '') + ', created ' + String(r.created || '').slice(0, 10) + ' — not in Nova\'s matching set (' + (r.type !== 'invoice' ? 'not an invoice' : r.status === 'paid' ? 'paid invoices are read only for the last ~6,000 numbers created within 120 days' : r.status === 'void' ? 'void' : 'outside the set') + ')'; }
        else note = 'INV' + n + ' is not in the CRM.';
      }
      res.json({ ok: true, invoices: hits.map(r => ({ id: r.id, no: r.no, total: r.total, balance: r.balance, status: r.status, created: r.created, due: r.due, po: r.po, customer: r.customer, customer_id: r.customer_id, paid_at: r.paid_at })), note });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // POST /api/bookkeeping/ar/:id/match {invoice_ids: [..], customer_id?, customer?, note?}
  app.post('/api/bookkeeping/ar/:id/match', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [id]); if (!q) return res.json({ ok: false, error: 'No such payment' });
      const ids = (Array.isArray(req.body.invoice_ids) ? req.body.invoice_ids : [req.body.invoice_id]).map(x => parseInt(x)).filter(Boolean);
      if (!ids.length) return res.json({ ok: false, error: 'Which invoice?' });
      // 1.20.6: the matched invoices are snapshotted into bk_ar.inv_json — from the warm cache, else one read per id — so the
      // Matched tab never asks the CRM again (and a cold cache never makes the click wait on the 15k-invoice load)
      const snap = await snapshotInvoices(ids);
      const first = snap[0] && snap[0].customer_id != null ? snap[0] : null;
      const customer = String(req.body.customer || (first ? first.customer : '')).slice(0, 160), cid = parseInt(req.body.customer_id) || (first ? first.customer_id : null);
      const kind = req.body.kind === 'pair' ? 'pair' : req.body.kind === 'manual' ? 'manual' : 'match';   // 1.20.10: manual = typed in by hand (a bulk payment) — recorded only, the CRM is not told
      // 1.20.83: a match is a two-step: Match (status 'review' — the row shows paid / balance open per invoice) then Match & Pay
      // (/pay-confirm → status 'matched' + the CRM webhook). Pair and manual go straight to matched, nothing is sent.
      const status = kind === 'match' ? 'review' : 'matched';
      await dbRun("UPDATE bk_ar SET status = ?, kind = ?, invoice_ids = ?, inv_json = ?, customer_id = ?, customer_name = ?, note = ?, matched_by = ?, matched_at = ?, pay_status = NULL, pay_at = NULL, pay_ref = NULL, updated_at = ? WHERE id = ?", [status, kind, ids.join(','), JSON.stringify(snap), cid, customer, String(req.body.note || '').slice(0, 500) || null, userId(req), nowIso(), nowIso(), id]);
      await audit(userId(req), kind === 'pair' ? 'ar.pair' : kind === 'match' ? 'ar.review' : 'ar.match', id, { txn_id: q.txn_id, amount: q.amount, invoice_ids: ids, customer });
      // learn the payer → customer rule from what the AR person chose (never used to pair by itself)
      let learned = null; try { const t = (await txFields([q.txn_id]))[q.txn_id]; if (t && cid) learned = await learnRule(t, cid, customer, userId(req)); } catch (e) { errlog('ar learn', e.message); }
      res.json({ ok: true, kind, status, invoices: snap, learned, pay: null });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // POST /api/bookkeeping/ar/:id/pay-confirm — the second step: the reviewed match is final and the CRM is told (1.20.83)
  app.post('/api/bookkeeping/ar/:id/pay-confirm', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [id]); if (!q) return res.json({ ok: false, error: 'No such payment' });
      if (q.status !== 'review') return res.json({ ok: false, error: 'This payment is not waiting for Match & Pay.' });
      await dbRun("UPDATE bk_ar SET status = 'matched', matched_by = ?, matched_at = ?, updated_at = ? WHERE id = ?", [userId(req), nowIso(), nowIso(), id]);
      await audit(userId(req), 'ar.match', id, { txn_id: q.txn_id, amount: q.amount, invoice_ids: String(q.invoice_ids || '').split(',').filter(Boolean).map(Number), customer: q.customer_name });
      const pay = await payHook(id).catch(e => ({ sent: false, error: e.message }));
      res.json({ ok: true, pay });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // ---- 1.20.83: the Rules sub-tab
  app.get('/api/bookkeeping/ar/rules', ...guard, async (req, res) => {
    try { res.json({ ok: true, rules: (await arRules(true)).map(r => Object.assign({}, r, { ids: ruleIds(r) })) }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/ar/rules', ...guard, async (req, res) => {
    try {
      const pat = keyWords(String(req.body.pattern || '')).filter(w => !/\d/.test(w)).slice(0, 5).join(' ');
      // 1.20.84: several accounts at once — customer_ids[] + customer_names[] (the old single customer_id / customer still works)
      const ids = (Array.isArray(req.body.customer_ids) ? req.body.customer_ids : [req.body.customer_id]).map(x => parseInt(x)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
      const names = (Array.isArray(req.body.customer_names) ? req.body.customer_names : [req.body.customer]).map(x => String(x || '').trim().slice(0, 120)).filter(Boolean);
      if (!pat) return res.json({ ok: false, error: 'Type the payer words as they show on the bank line (e.g. "peace haight").' });
      if (!ids.length) return res.json({ ok: false, error: 'Pick at least one customer.' });
      const label = names.filter((x, i, a) => a.indexOf(x) === i).join(' · ').slice(0, 400);
      // 1.20.85: Edit sends the rule's id — the row is rewritten (pattern included) unless another rule already has the new words
      const editId = parseInt(req.body.id) || 0;
      let cur = await dbGet('SELECT id FROM bk_ar_rules WHERE pattern = ?', [pat]);
      if (editId && cur && cur.id !== editId) return res.json({ ok: false, error: 'Another rule already uses the words "' + pat + '" — edit that one instead.' });
      if (editId && !cur) cur = { id: editId };
      if (cur) await dbRun("UPDATE bk_ar_rules SET pattern = ?, customer_id = ?, customer_ids = ?, customer_name = ?, source = 'manual', made_by = ?, updated_at = ? WHERE id = ?", [pat, ids[0], ids.join(','), label, userId(req), nowIso(), cur.id]);
      else await dbRun("INSERT INTO bk_ar_rules (pattern, customer_id, customer_ids, customer_name, source, made_by, updated_at) VALUES (?,?,?,?,'manual',?,?)", [pat, ids[0], ids.join(','), label, userId(req), nowIso()]);
      rulesCache.at = 0; sugCache.clear(); await audit(userId(req), 'ar.rule', cur ? cur.id : 0, { pattern: pat, customer_ids: ids });
      res.json({ ok: true, pattern: pat });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/bookkeeping/ar/rules/:id/delete', ...guard, async (req, res) => {
    try { await dbRun('DELETE FROM bk_ar_rules WHERE id = ?', [parseInt(req.params.id)]); rulesCache.at = 0; sugCache.clear(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // customers for the rule form (the CRM, read-only)
  app.get('/api/bookkeeping/ar/customers', ...guard, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim(); if (q.length < 2 || !runQuery) return res.json({ ok: true, customers: [] });
      const like = mysql.escape('%' + q + '%');
      const rows = await runQuery('SELECT id, company_name, name, last_name, email FROM customer WHERE company_name LIKE ' + like + ' OR name LIKE ' + like + ' OR last_name LIKE ' + like + ' OR email LIKE ' + like + ' ORDER BY id DESC LIMIT 20');
      res.json({ ok: true, customers: rows.map(r => ({ id: r.id, name: r.company_name || [r.name, r.last_name].filter(Boolean).join(' ') || ('Customer #' + r.id), person: [r.name, r.last_name].filter(Boolean).join(' '), email: r.email || '' })) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // ---- 1.20.83: Acct Aging — every open invoice (unpaid / partial, type invoice) bucketed by age, per customer
  let amCache = { at: 0, by: {} };
  async function managers() {
    if (Date.now() - amCache.at < 600000) return amCache.by;
    const photo = (ph) => !ph ? null : /^https?:\/\//.test(ph) ? ph : 'https://axiomprint.s3.us-west-1.amazonaws.com/MemberImages/' + String(ph).replace(/^\/+/, '');   /* user.memberimage is an S3 key */
    const by = {}; try { (await runQuery('SELECT id, name, last_name, memberimage FROM user WHERE id IN (SELECT DISTINCT manager_id FROM customer WHERE manager_id > 0)')).forEach(r => { by[r.id] = { name: [r.name, r.last_name].filter(Boolean).join(' ').trim(), photo: photo(r.memberimage) }; }); } catch (e) {}
    amCache = { at: Date.now(), by }; return by;
  }
  app.get('/api/bookkeeping/ar/aging', ...agingGuard, async (req, res) => {   /* 1.20.88: AR people and the Acct Aging role */
    try {
      const invoices = await openInvoices(req.query.fresh === '1'); const ams = await managers();
      const today = Date.now(); const B = ['0-30', '31-60', '61-90', '90+'];
      const bucket = (d) => d == null ? '0-30' : d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';
      const byCust = {};
      /* 1.20.86: invoices before AR_AGING_FROM (default 2025-01-01) are not chased any more — 2024 and older are left out */
      const floorIso = AR_AGING_FROM; let dropped = 0;
      for (const r of invoices) {
        if (r.status === 'paid' || r.balance <= 0.005) continue;
        const c = r.created ? new Date(r.created).getTime() : NaN; const age = isNaN(c) ? null : Math.max(0, Math.round((today - c) / DAY));
        if (r.created && ymdOf(r.created) < floorIso) { dropped++; continue; }   /* the LA calendar day — no time-zone slip at midnight */
        const b = bucket(age);
        const k = r.customer_id || 'none';
        const g = byCust[k] = byCust[k] || { customer_id: r.customer_id, customer: r.customer, company: r.company, person: r.person, email: r.email, am: (ams[r.manager_id] || {}).name || '', am_photo: (ams[r.manager_id] || {}).photo || null, buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }, total: 0, invoiced: 0, paid: 0, n: 0, oldest: 0, invoices: [] };
        g.buckets[b] += r.balance; g.total += r.balance; g.invoiced += r.total; g.paid += r.done; g.n++;   /* 1.20.89: invoiced / paid so far beside the balance */ if (age != null && age > g.oldest) g.oldest = age;
        g.invoices.push({ id: r.id, no: r.no, created: r.created, due: r.due, total: r.total, done: r.done, balance: r.balance, status: r.status, po: r.po, age, bucket: b });
      }
      const rows = Object.values(byCust).map(g => { B.forEach(k => { g.buckets[k] = Math.round(g.buckets[k] * 100) / 100; }); g.total = Math.round(g.total * 100) / 100; g.invoiced = Math.round(g.invoiced * 100) / 100; g.paid = Math.round(g.paid * 100) / 100; g.invoices.sort((a, b) => (b.age || 0) - (a.age || 0)); return g; }).sort((a, b) => b.total - a.total);
      const totals = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, total: 0, invoiced: 0, paid: 0, n: 0, customers: rows.length };
      rows.forEach(g => { B.forEach(k => { totals[k] += g.buckets[k]; }); totals.total += g.total; totals.invoiced += g.invoiced; totals.paid += g.paid; totals.n += g.n; });
      Object.keys(totals).forEach(k => { totals[k] = Math.round(totals[k] * 100) / 100; });
      res.json({ ok: true, rows, totals, at: inv.at, from: floorIso, dropped, crm_error: inv.error || null });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // POST {AR_PAY_WEBHOOK_URL} {event: 'ar.payment', payment: {...}, invoices: [ids], amount, paid_on, method, bank_line, matched_by},
  // signed like the TalkAi webhook (X-Nova-Signature t=…,v1=HMAC-SHA256(secret, t + '.' + body), secret AR_PAY_WEBHOOK_SECRET
  // else TALKAI_WEBHOOK_SECRET). Nothing is sent while the URL is not set — the match is still kept here.
  const pick = (x) => ({ id: x.id, no: x.no, total: x.total, balance: x.balance, status: x.status, created: x.created, customer: x.customer, company: x.company || '', person: x.person || '', customer_id: x.customer_id == null ? null : x.customer_id });
  async function snapshotInvoices(ids) {
    const out = [];
    for (const id of ids) {
      let x = inv.byId ? inv.byId.get(id) : null;
      if (!x) { try { const r = await runQuery(SEL_ONE + ' WHERE i.id = ' + Math.floor(id)); if (r && r[0]) x = shapeInvoice(r[0]); } catch (e) { errlog('ar snapshot', e.message); } }
      out.push(x ? pick(x) : { id, no: 'INV' + id });
    }
    return out;
  }
  async function payHook(arId) {
    const url = env('AR_PAY_WEBHOOK_URL'), secret = env('AR_PAY_WEBHOOK_SECRET') || env('TALKAI_WEBHOOK_SECRET');
    const q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [arId]); if (!q) return { sent: false, error: 'No such payment' };
    if (!url) { await dbRun("UPDATE bk_ar SET pay_status = 'not configured' WHERE id = ?", [arId]); return { sent: false, error: 'AR_PAY_WEBHOOK_URL is not set — the CRM was not told' }; }
    if (!secret) { await dbRun("UPDATE bk_ar SET pay_status = 'no secret' WHERE id = ?", [arId]); return { sent: false, error: 'AR_PAY_WEBHOOK_SECRET is not in .env' }; }
    const t = (await txFields([q.txn_id]))[q.txn_id] || {};
    // Who clicked Match & Pay — the signed-in person's email, their name, and their CRM user id when they are a CRM staff member
    // (the CRM keeps the payment's "recorded by" on it). A Nova-local admin account has no CRM id.
    const who = { email: q.matched_by || null, name: null, crm_user_id: null };
    if (who.email && who.email.indexOf('@') > 0) {
      const m = await dbGet('SELECT display_name FROM members WHERE LOWER(email) = ?', [who.email]).catch(() => null);
      if (m && m.display_name) who.name = m.display_name;
      const u = await runQuery('SELECT id, name, last_name FROM user WHERE LOWER(email) = ' + mysql.escape(who.email) + ' LIMIT 1').catch(() => []);
      if (u[0]) { who.crm_user_id = Number(u[0].id); if (!who.name) who.name = [u[0].name, u[0].last_name].filter(Boolean).join(' ').trim() || null; }
    } else if (who.email) who.name = who.email;
    const body = JSON.stringify({ event: 'ar.payment', nova_ar_id: arId, invoice_ids: String(q.invoice_ids || '').split(',').filter(Boolean).map(Number), amount: q.amount, currency: 'USD',
      paid_on: t.tx_date || t.date || null, method: t.how || null, bank: { institution: t.institution || null, mask: t.mask || null, wording: t.orig_desc || t.name || null, check_no: t.check_no || null }, customer_id: q.customer_id, customer: q.customer_name,
      matched_by: who.email, matched_by_name: who.name, matched_by_crm_user_id: who.crm_user_id, matched_at: q.matched_at });
    const ts = Math.floor(Date.now() / 1000), sig = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
    let status = 0, err = null, ref = null;
    try {
      const r = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'User-Agent': 'NovaAI-AR/1', 'X-Nova-Event': 'ar.payment', 'X-Nova-Delivery': 'nova-ar-' + arId, 'X-Nova-Signature': 't=' + ts + ',v1=' + sig } });
      status = r.status; const txt = await r.text().catch(() => '');
      if (!r.ok) err = 'HTTP ' + r.status + ' ' + txt.slice(0, 120); else { try { const j = JSON.parse(txt); ref = j.payment_id || j.id || j.ref || null; } catch (e) {} }
    } catch (e) { err = e.message; }
    await dbRun("UPDATE bk_ar SET pay_status = ?, pay_at = ?, pay_ref = ? WHERE id = ?", [err ? 'failed: ' + err.slice(0, 160) : 'sent', nowIso(), ref ? String(ref).slice(0, 80) : null, arId]);
    await audit('system', 'ar.pay_hook', arId, { status, err, ref });
    return { sent: !err, status, error: err, ref };
  }
  // POST /api/bookkeeping/ar/:id/pay — resend the pay webhook for a matched payment (after the URL is set, or a failure)
  app.post('/api/bookkeeping/ar/:id/pay', ...guard, async (req, res) => {
    try { const q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [parseInt(req.params.id)]); if (!q || q.status !== 'matched' || q.kind === 'pair') return res.json({ ok: false, error: 'Only a matched (not paired) payment can be sent.' }); res.json({ ok: true, pay: await payHook(q.id) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // POST /api/bookkeeping/ar/:id/skip {note} — not a customer payment after all / handled elsewhere; kept in the history
  app.post('/api/bookkeeping/ar/:id/skip', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id); const q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [id]); if (!q) return res.json({ ok: false, error: 'No such payment' });
      await dbRun("UPDATE bk_ar SET status = 'skipped', note = ?, matched_by = ?, matched_at = ?, updated_at = ? WHERE id = ?", [String(req.body.note || '').slice(0, 500) || null, userId(req), nowIso(), nowIso(), id]);
      await audit(userId(req), 'ar.skip', id, { txn_id: q.txn_id, amount: q.amount, note: req.body.note || '' });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // POST /api/bookkeeping/ar/:id/undo — back to Unmatched
  app.post('/api/bookkeeping/ar/:id/undo', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await dbRun("UPDATE bk_ar SET status = 'open', kind = NULL, pay_status = NULL, pay_at = NULL, pay_ref = NULL, invoice_ids = NULL, customer_id = NULL, customer_name = NULL, matched_by = NULL, matched_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), id]);
      await audit(userId(req), 'ar.undo', id, {}); res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  return { syncQueue, isArCategory, suggest, openInvoices, extraFor, _inv: inv, _shape: shapeInvoice, openCount: async () => (await dbGet("SELECT COUNT(*) n FROM bk_ar WHERE status = 'open'")).n };
};
