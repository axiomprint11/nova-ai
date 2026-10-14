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
  const { app, guard, dbAll, dbGet, dbRun, runQuery, mysql, audit, userId, nowIso, realCheckNo, errlog, people } = ctx;

  // 1.19.152: the queue
  ctx.db.serialize(() => {
    ctx.db.run(`CREATE TABLE IF NOT EXISTS bk_ar (id INTEGER PRIMARY KEY AUTOINCREMENT, txn_id INTEGER UNIQUE, status TEXT DEFAULT 'open',
      amount REAL, invoice_ids TEXT, customer_id INTEGER, customer_name TEXT, note TEXT, matched_by TEXT, matched_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    // 1.20.2: kind = 'match' (an open invoice — Match & Pay) or 'pair' (an invoice the CRM already shows as paid); pay_* = the
    // Dev team's pay webhook result once AR_PAY_WEBHOOK_URL is set
    ['kind TEXT', 'pay_status TEXT', 'pay_at TEXT', 'pay_ref TEXT'].forEach(c => ctx.db.run('ALTER TABLE bk_ar ADD COLUMN ' + c, () => {}));
  });
  const crypto = require('crypto');
  const env = (k) => String(process.env[k] || '').trim();

  // Which categories mean "a customer paid us": the chart's Customer Payment(s) / Client Payment(s) — name based, so a
  // renamed sub category keeps working as long as the words stay.
  const isArCategory = (c) => /\b(customer|client)\s+payments?\b/i.test(String(c || ''));

  // Put every categorized deposit filed as a customer payment into the queue; drop (void) open rows whose line was
  // re-filed somewhere else or uncategorized.
  async function syncQueue() {
    const rows = await dbAll("SELECT id, amount, category FROM bk_transactions WHERE status = 'categorized' AND amount < 0 AND category IS NOT NULL AND transfer_of IS NULL AND refund_of IS NULL");
    let added = 0;
    for (const t of rows) {
      if (!isArCategory(t.category)) continue;
      const r = await dbRun('INSERT OR IGNORE INTO bk_ar (txn_id, amount) VALUES (?, ?)', [t.id, Math.abs(Number(t.amount))]);
      if (r.changes) added++;
    }
    const keep = new Set(rows.filter(t => isArCategory(t.category)).map(t => t.id));
    const open = await dbAll("SELECT id, txn_id FROM bk_ar WHERE status = 'open'");
    for (const q of open) if (!keep.has(q.txn_id)) await dbRun("UPDATE bk_ar SET status = 'void', updated_at = ? WHERE id = ?", [nowIso(), q.id]);
    // a voided row whose line is a customer payment again comes back
    await dbRun("UPDATE bk_ar SET status = 'open', updated_at = ? WHERE status = 'void' AND txn_id IN (" + (keep.size ? Array.from(keep).join(',') : '0') + ")", [nowIso()]);
    return added;
  }

  // ---- open invoices from the production DB (read-only), cached 5 minutes
  const inv = { at: 0, rows: [], error: null }, sugCache = new Map();
  async function openInvoices(force) {
    if (!runQuery) return [];
    if (!force && Date.now() - inv.at < 5 * 60000) return inv.rows;
    // open invoices, plus the ones marked paid in the last 90 days (AR often marks the CRM before the bank posts — shown as "already paid in the CRM")
    // two queries, each on an index (payment_status; id range for the recent paid ones) — one OR over both made MySQL scan the table
    const SEL = "SELECT i.id, i.invoice_total_payment AS total, i.invoice_total_payment_done AS done, i.payment_status, i.invoice_creation_date AS created, i.payment_due_date AS due, i.PO_number AS po, i.invoice_clientid AS customer_id, i.updated_at, " +
      "c.company_name, c.name, c.last_name, c.email FROM invoice i LEFT JOIN customer c ON c.id = i.invoice_clientid WHERE i.invoice_type = 'invoice' AND i.invoice_total_payment > 0 AND ";
    const open = await runQuery(SEL + "i.payment_status IN ('unpaid', 'partial') ORDER BY i.id DESC LIMIT 20000");
    const maxId = (await runQuery('SELECT MAX(id) AS m FROM invoice'))[0].m || 0;
    const paid = await runQuery(SEL + "i.payment_status = 'paid' AND i.id > " + (Number(maxId) - 6000) + " AND i.invoice_creation_date >= DATE_SUB(NOW(), INTERVAL 120 DAY) ORDER BY i.id DESC LIMIT 6000");   // the last ~6k invoices cover several months
    const rows = open.concat(paid);
    inv.rows = rows.map(r => ({ id: r.id, no: 'INV' + r.id, total: Number(r.total) || 0, done: Number(r.done) || 0, balance: r.payment_status === 'paid' ? Number(r.total) || 0 : Math.round(((Number(r.total) || 0) - (Number(r.done) || 0)) * 100) / 100, status: r.payment_status, created: r.created, due: r.due, po: r.po || null, paid_at: r.payment_status === 'paid' ? r.updated_at : null,
      customer_id: r.customer_id, company: r.company_name || '', person: [r.name, r.last_name].filter(Boolean).join(' '), email: r.email || '' }));
    inv.rows.forEach(r => { r.customer = r.company || r.person || ('Customer #' + r.customer_id); r._k = keyWords(r.company + ' ' + r.person + ' ' + (r.email || '').split('@')[0]); });
    // words shared by many customers ("designs", "events", "church") say nothing about who paid — drop them from the keys
    const df = {}; const seen = {}; inv.rows.forEach(r => { if (seen[r.customer_id]) return; seen[r.customer_id] = 1; r._k.forEach(w => { df[w] = (df[w] || 0) + 1; }); });
    const common = new Set(Object.keys(df).filter(w => df[w] > 25));
    inv.rows.forEach(r => { r._k = r._k.filter(w => !common.has(w)); });
    inv.byId = new Map(inv.rows.map(r => [r.id, r]));
    inv.at = Date.now(); return inv.rows;
  }

  // words worth matching on, from either side
  const NOISE = new Set(['the', 'and', 'inc', 'llc', 'ltd', 'corp', 'co', 'company', 'deposit', 'mobile', 'online', 'transfer', 'from', 'ref', 'number', 'ach', 'credit', 'payment', 'payments', 'pmt', 'zelle', 'venmo', 'paypal', 'check', 'chk', 'wire', 'incoming', 'des', 'id', 'indn', 'ppd', 'ccd', 'web', 'trn', 'orig', 'name', 'axiom', 'axiomprint', 'print', 'printing', 'invoice', 'inv', 'bill', 'pay', 'to', 'of', 'for', 'business', 'account', 'merchant', 'merch', 'dep', 'stripe', 'square', 'intuit', 'quickbooks', 'bank', 'wells', 'fargo', 'chase', 'amex', 'usd']);
  function keyWords(s) {
    return Array.from(new Set(String(s || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').split(' ').filter(w => w.length >= 3 && !NOISE.has(w) && !/^\d+$/.test(w))));
  }
  // numbers in the wording that look like one of our invoice ids (6 digits, 1xxxxx) — a customer who typed the invoice number into the memo
  const invoiceNos = (s) => { const out = new Set(); const re = /(?:^|[^0-9])(1\d{5})(?![0-9])/g; let m; const str = String(s || ''); while ((m = re.exec(str))) out.add(Number(m[1])); return Array.from(out); };   // "INV129964", "#135244", "Inv 135244" — INV glued to the digits is no word boundary

  // the suggestions for one deposit (1.19.154 — the AR team's order of proof):
  //   1. the amount: the invoice's balance due (or its total) to the cent — the base of every real match (60)
  //   2. the date: an invoice created within 30 days before the payment (+25), within 60 days (+12), older (+0)
  //   3. the client: the payer's words on the bank line match the customer (+10)
  //   an invoice number typed in the memo (+30) and 2–3 invoices of one customer adding up (50 base) ride on the same scale;
  //   a payer we recognise but no amount fits is shown low ("payer name only" 15, or "partial payment" 30 when the deposit is
  //   smaller than their balance) so Karen still has a lead. An invoice already marked paid in the CRM is shown as such.
  const DAY = 864e5;
  function suggest(t, invoices) {
    const amt = Math.round(Math.abs(Number(t.amount)) * 100) / 100;
    const text = [t.name, t.merchant, t.orig_desc].filter(Boolean).join(' ');
    const words = keyWords(text), nos = invoiceNos(text);
    const paidOn = new Date(String(t.tx_date || t.date || '').slice(0, 10) + 'T12:00:00Z').getTime();
    const ageDays = (r) => { const c = r.created ? new Date(r.created).getTime() : NaN; return isNaN(c) || isNaN(paidOn) ? null : Math.round((paidOn - c) / DAY); };
    const datePts = (r) => { const d = ageDays(r); if (d == null) return [0, null]; if (d >= -3 && d <= 30) return [25, 'invoiced ' + d + ' day' + (d === 1 ? '' : 's') + ' before']; if (d > 30 && d <= 60) return [12, 'invoiced ' + d + ' days before']; return [0, d > 60 ? 'invoiced ' + d + ' days before' : 'invoiced after the payment']; };
    const out = [], keys = new Set();
    const push = (ids, score, why, cust) => { const key = ids.length > 1 ? ids.slice().sort().join(',') : null; if (key) { if (keys.has(key)) return; keys.add(key); } out.push({ invoice_ids: ids, score, why, customer: cust }); };
    const nameHit = (r) => { if (!words.length || !r._k.length) return 0; let n = 0; for (const w of words) for (const k of r._k) if (k === w || (w.length >= 5 && k.length >= 5 && (k.indexOf(w) === 0 || w.indexOf(k) === 0))) { n++; break; } return n; };
    for (const r of invoices) {
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
    const byCust = {}; invoices.forEach(r => { if (r.status !== 'paid') (byCust[r.customer_id] = byCust[r.customer_id] || []).push(r); });
    for (const cid of Object.keys(byCust)) {
      const list = byCust[cid].slice(0, 12); if (list.length < 2) continue;
      const nh = nameHit(list[0]);
      const combo = (ids, label) => { const rs = ids.map(id => list.find(x => x.id === id)); const dp = Math.min(...rs.map(r => datePts(r)[0])); push(ids, Math.min(100, 50 + dp + (nh ? 10 : 0)), [label, dp === 25 ? 'all invoiced within 30 days' : dp === 12 ? 'all invoiced within 60 days' : 'older invoices'].concat(nh ? ['client: ' + list[0].customer] : []), list[0]); };
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
  app.get('/api/bookkeeping/ar/me', ...guard, async (req, res) => {
    try { let pl = []; try { pl = people ? await people.list() : []; } catch (e) {} res.json({ ok: true, me: userId(req), people: pl, open: (await dbGet("SELECT COUNT(*) n FROM bk_ar WHERE status = 'open'")).n }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // GET /api/bookkeeping/ar?status=open|done&from&to&min&max&q
  app.get('/api/bookkeeping/ar', ...guard, async (req, res) => {
    try {
      await syncQueue();
      const st = req.query.status === 'done' ? 'done' : 'open';
      const where = [st === 'open' ? "q.status = 'open'" : "q.status IN ('matched', 'skipped')"], p = [];
      if (req.query.from) { where.push('date(t.created_at) >= ?'); p.push(String(req.query.from)); }   // 1.20.1: the Synced column is the date filter
      if (req.query.to) { where.push('date(t.created_at) <= ?'); p.push(String(req.query.to)); }
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
        const t = tx[r.txn_id] || {}; const row = Object.assign({}, r, { txn: t });
        if (q && [t.name, t.merchant, t.orig_desc, r.customer_name, r.invoice_ids, r.note, String(r.amount)].filter(Boolean).join(' ').toLowerCase().indexOf(q) < 0) continue;
        if (st === 'open') { const ck = r.txn_id + ':' + inv.at; row.suggestions = sugCache.has(ck) ? sugCache.get(ck) : null; }   // null = the page asks /ar/:id/suggest for it (1.19.159: the list never waits on the matching)
        else { const ids = String(r.invoice_ids || '').split(',').filter(Boolean).map(Number); row.invoices = ids.map(id => { const x = invoices.find(i => i.id === id); return x ? { id, no: x.no, total: x.total, balance: x.balance, status: x.status, customer: x.customer } : { id, no: 'INV' + id }; }); }
        out.push(row);
      }
      const counts = await dbGet("SELECT SUM(status = 'open') AS open, SUM(status IN ('matched', 'skipped')) AS done, SUM(CASE WHEN status = 'open' THEN amount ELSE 0 END) AS open_total FROM bk_ar");
      res.json({ ok: true, rows: out, counts: { open: counts.open || 0, done: counts.done || 0, open_total: Math.round((counts.open_total || 0) * 100) / 100 }, invoices_open: invoices.length, invoices_at: inv.at, crm_error });
    } catch (e) { errlog('ar list', e.message); res.json({ ok: false, error: e.message }); }
  });
  // GET /api/bookkeeping/ar/:id/suggest — the suggestions for one payment (the page asks row by row, a few at a time)
  app.get('/api/bookkeeping/ar/:id/suggest', ...guard, async (req, res) => {
    try {
      const q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [parseInt(req.params.id)]); if (!q) return res.json({ ok: false, error: 'No such payment' });
      let invoices; try { invoices = await openInvoices(); inv.error = null; } catch (e) { inv.error = e.message; return res.json({ ok: false, error: 'CRM not reachable: ' + e.message, crm_error: e.message }); }
      const ck = q.txn_id + ':' + inv.at;
      if (!sugCache.has(ck)) { const t = (await txFields([q.txn_id]))[q.txn_id] || {}; if (sugCache.size > 2000) sugCache.clear(); sugCache.set(ck, invoices.length ? suggest(t, invoices) : []); }
      res.json({ ok: true, suggestions: sugCache.get(ck), invoices_open: invoices.length, invoices_at: inv.at });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // GET /api/bookkeeping/ar/invoices?q= — look an invoice up by number, customer, company or PO for "Other invoice…"
  app.get('/api/bookkeeping/ar/invoices', ...guard, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase(); if (!q) return res.json({ ok: true, invoices: [] });
      const invoices = await openInvoices();
      const n = Number(q.replace(/^#/, '').replace(/^inv\s*/i, ''));
      const hits = invoices.filter(r => (n && String(r.id).indexOf(String(n)) === 0) || r.customer.toLowerCase().indexOf(q) > -1 || r.person.toLowerCase().indexOf(q) > -1 || (r.po && String(r.po).toLowerCase().indexOf(q) > -1) || (r.email && r.email.toLowerCase().indexOf(q) > -1)).slice(0, 25);
      res.json({ ok: true, invoices: hits.map(r => ({ id: r.id, no: r.no, total: r.total, balance: r.balance, status: r.status, created: r.created, due: r.due, po: r.po, customer: r.customer, customer_id: r.customer_id, paid_at: r.paid_at })) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // POST /api/bookkeeping/ar/:id/match {invoice_ids: [..], customer_id?, customer?, note?}
  app.post('/api/bookkeeping/ar/:id/match', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [id]); if (!q) return res.json({ ok: false, error: 'No such payment' });
      const ids = (Array.isArray(req.body.invoice_ids) ? req.body.invoice_ids : [req.body.invoice_id]).map(x => parseInt(x)).filter(Boolean);
      if (!ids.length) return res.json({ ok: false, error: 'Which invoice?' });
      let invoices = []; try { invoices = await openInvoices(); } catch (e) {}   // the CRM being down must not block a match the person typed
      const first = invoices.find(r => r.id === ids[0]);
      const customer = String(req.body.customer || (first ? first.customer : '')).slice(0, 160), cid = parseInt(req.body.customer_id) || (first ? first.customer_id : null);
      const kind = req.body.kind === 'pair' ? 'pair' : 'match';
      await dbRun("UPDATE bk_ar SET status = 'matched', kind = ?, invoice_ids = ?, customer_id = ?, customer_name = ?, note = ?, matched_by = ?, matched_at = ?, updated_at = ? WHERE id = ?", [kind, ids.join(','), cid, customer, String(req.body.note || '').slice(0, 500) || null, userId(req), nowIso(), nowIso(), id]);
      await audit(userId(req), kind === 'pair' ? 'ar.pair' : 'ar.match', id, { txn_id: q.txn_id, amount: q.amount, invoice_ids: ids, customer });
      // 1.20.2: Match & Pay tells the CRM to record the payment — once the Dev team's endpoint exists (AR_PAY_WEBHOOK_URL in .env).
      // A pair never pays: the CRM already has it.
      let pay = null;
      if (kind === 'match') pay = await payHook(id).catch(e => ({ sent: false, error: e.message }));
      res.json({ ok: true, kind, pay });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // POST {AR_PAY_WEBHOOK_URL} {event: 'ar.payment', payment: {...}, invoices: [ids], amount, paid_on, method, bank_line, matched_by},
  // signed like the TalkAi webhook (X-Nova-Signature t=…,v1=HMAC-SHA256(secret, t + '.' + body), secret AR_PAY_WEBHOOK_SECRET
  // else TALKAI_WEBHOOK_SECRET). Nothing is sent while the URL is not set — the match is still kept here.
  async function payHook(arId) {
    const url = env('AR_PAY_WEBHOOK_URL'), secret = env('AR_PAY_WEBHOOK_SECRET') || env('TALKAI_WEBHOOK_SECRET');
    const q = await dbGet('SELECT * FROM bk_ar WHERE id = ?', [arId]); if (!q) return { sent: false, error: 'No such payment' };
    if (!url) { await dbRun("UPDATE bk_ar SET pay_status = 'not configured' WHERE id = ?", [arId]); return { sent: false, error: 'AR_PAY_WEBHOOK_URL is not set — the CRM was not told' }; }
    if (!secret) { await dbRun("UPDATE bk_ar SET pay_status = 'no secret' WHERE id = ?", [arId]); return { sent: false, error: 'AR_PAY_WEBHOOK_SECRET is not in .env' }; }
    const t = (await txFields([q.txn_id]))[q.txn_id] || {};
    const body = JSON.stringify({ event: 'ar.payment', nova_ar_id: arId, invoice_ids: String(q.invoice_ids || '').split(',').filter(Boolean).map(Number), amount: q.amount, currency: 'USD',
      paid_on: t.tx_date || t.date || null, method: t.how || null, bank: { institution: t.institution || null, mask: t.mask || null, wording: t.orig_desc || t.name || null, check_no: t.check_no || null }, customer_id: q.customer_id, customer: q.customer_name, matched_by: q.matched_by, matched_at: q.matched_at });
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

  return { syncQueue, isArCategory, suggest, openInvoices, openCount: async () => (await dbGet("SELECT COUNT(*) n FROM bk_ar WHERE status = 'open'")).n };
};
