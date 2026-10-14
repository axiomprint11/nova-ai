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
  });

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
      if (r.status === 'paid') { score = Math.round(score * 0.8); why.push('already marked paid in the CRM'); }
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
    return top.map(o => ({ score: o.score, why: o.why, customer: o.customer.customer, customer_id: o.customer.customer_id,
      invoices: o.invoice_ids.map(id => { const r = byId.get(id); return r ? { id: r.id, no: r.no, total: r.total, balance: r.balance, status: r.status, created: r.created, due: r.due, po: r.po, customer: r.customer, paid_at: r.paid_at } : { id, no: 'INV' + id }; }) }));
  }
  const usd = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const txFields = async (ids) => {
    if (!ids.length) return {};
    const rows = await dbAll('SELECT t.id, t.date, t.created_at, t.name, t.merchant, t.amount, t.raw, t.account_name, t.account_ref, t.category, t.vendor_id, v.name AS vendor_name, v.photo AS vendor_photo, ba.institution, ba.logo AS bank_logo, ba.color AS bank_color, ba.accounts AS bank_accounts FROM bk_transactions t LEFT JOIN bk_vendors v ON v.id = t.vendor_id LEFT JOIN bk_accounts ba ON ba.item_id = t.item_id WHERE t.id IN (' + ids.map(() => '?').join(',') + ')', ids);
    const m = {};
    for (const r of rows) {
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
      if (req.query.from) { where.push('t.date >= ?'); p.push(String(req.query.from)); }
      if (req.query.to) { where.push('t.date <= ?'); p.push(String(req.query.to)); }
      if (req.query.min !== undefined && req.query.min !== '') { where.push('q.amount >= ?'); p.push(Number(req.query.min) || 0); }
      if (req.query.max !== undefined && req.query.max !== '') { where.push('q.amount <= ?'); p.push(Number(req.query.max) || 0); }
      const q = String(req.query.q || '').trim().toLowerCase();
      const rows = await dbAll('SELECT q.*, t.date FROM bk_ar q JOIN bk_transactions t ON t.id = q.txn_id WHERE ' + where.join(' AND ') + ' ORDER BY ' + (st === 'open' ? 't.date DESC' : 'q.matched_at DESC') + ' LIMIT 500', p);
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
      await dbRun("UPDATE bk_ar SET status = 'matched', invoice_ids = ?, customer_id = ?, customer_name = ?, note = ?, matched_by = ?, matched_at = ?, updated_at = ? WHERE id = ?", [ids.join(','), cid, customer, String(req.body.note || '').slice(0, 500) || null, userId(req), nowIso(), nowIso(), id]);
      await audit(userId(req), 'ar.match', id, { txn_id: q.txn_id, amount: q.amount, invoice_ids: ids, customer });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
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
      await dbRun("UPDATE bk_ar SET status = 'open', invoice_ids = NULL, customer_id = NULL, customer_name = NULL, matched_by = NULL, matched_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), id]);
      await audit(userId(req), 'ar.undo', id, {}); res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  return { syncQueue, isArCategory, suggest, openInvoices, openCount: async () => (await dbGet("SELECT COUNT(*) n FROM bk_ar WHERE status = 'open'")).n };
};
