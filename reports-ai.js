// ReportsAI (1.20.96) — the owner's reports page, one report at a time. The first is Onboarding: every client welcome form the
// account managers filled in the CRM (customer_welcome_forms), who onboarded whom, when, and where the client came from —
// so the AMs can be rewarded for the onboarding work. Everything here is READ-ONLY on the production DB.
'use strict';

module.exports = function mountReportsAi(app, deps) {
  const { db, auth, adminOnly, serveVersionedHtml, runQuery, mysql, sendMail, Notify } = deps;
  const dbGet = (sql, p) => new Promise((res, rej) => db.get(sql, p || [], (e, r) => e ? rej(e) : res(r)));
  const dbRun = (sql, p) => new Promise((res, rej) => db.run(sql, p || [], function (e) { e ? rej(e) : res(this); }));
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  db.run('CREATE TABLE IF NOT EXISTS ra_settings (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS ra_sent (id INTEGER PRIMARY KEY AUTOINCREMENT, report TEXT, period_key TEXT, kind TEXT, to_addr TEXT, cc TEXT, n INTEGER, at TEXT, by TEXT)');
  if (Notify) Notify.register('ra.onboarding', () => (emailSettingsSync('onboarding').to || 'gary@axiomprint.com'));
  const staffPhoto = (ph) => !ph ? null : /^https?:\/\//.test(ph) ? ph : 'https://axiomprint.s3.us-west-1.amazonaws.com/MemberImages/' + String(ph).replace(/^\/+/, '');
  const ymd = (v) => v instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(v) : String(v || '').slice(0, 10);

  app.get('/reports-ai', serveVersionedHtml('reports-ai.html'));

  // Where the client came from. The form has had two lives: codes since Aug 2026 (google, google_ads, chatgpt, existing_client with the
  // client in hear_about_us_who, employee_referral with referred_by_manager_id, other with free text, instagram, our_website) and free
  // text before that ("Google ", "Chat GPT", "Personal Referral", "word of mouth", "Repeat customer"…). sourceOf() folds both into one
  // short kind + who it came from, for the table's second line and the Source filter.
  function sourceOf(f, refName) {
    const raw = String(f.how_did_they_hear_about_us || '').trim(), who = String(f.hear_about_us_who || '').trim(), low = raw.toLowerCase();
    const other = String(f.onboarding_type_other || '').trim();
    if (!raw) return { kind: 'Unknown', who: '', raw: '' };
    if (low === 'existing_client' || /existing|current client|another client|client referr?al/.test(low)) return { kind: 'Client referral', who, raw };
    if (low === 'employee_referral' || /employee|team referr?al|staff/.test(low)) return { kind: 'Team referral', who: refName || who, raw };
    if (low === 'google_ads' || /google ads|adwords|\bppc\b/.test(low)) return { kind: 'Google Ads', who: '', raw };
    if (/google|\bgmb\b|maps/.test(low)) return { kind: 'Google', who: '', raw };
    if (/chat ?gpt|openai|\bai\b|claude|gemini|perplexity|copilot/.test(low) || /chat ?gpt|claude|gemini|perplexity/.test(who.toLowerCase())) return { kind: 'ChatGPT / AI', who: /chat ?gpt|claude|gemini|perplexity/.test(who.toLowerCase()) ? who : '', raw };
    if (/instagram|facebook|linkedin|tiktok|social/.test(low)) return { kind: 'Social', who: raw.replace(/_/g, ' '), raw };
    if (/yelp/.test(low)) return { kind: 'Yelp', who: '', raw };
    if (/reddit/.test(low)) return { kind: 'Reddit', who: '', raw };
    if (/our_website|website|online|internet|web/.test(low)) return { kind: 'Website', who: '', raw };
    if (/previous|repeat|returning|old client|used us|worked with us|past customer/.test(low) || /past customer|previous/.test(other.toLowerCase())) return { kind: 'Returning client', who: who || other, raw };
    if (/referr?al|friend|word of mouth|recommend|mouth/.test(low) || /referr?al|word.of.mouth|recommend/.test(who.toLowerCase())) return { kind: 'Referral', who: /^(personal referral|referral|friend|word of mouth|recommendation)$/i.test(raw) ? who : (who || raw), raw };
    if (low === 'other') { if (/team referr?al/.test(other.toLowerCase())) return { kind: 'Team referral', who, raw }; if (/cold call|walk.?in|trade ?show|event/.test(who.toLowerCase())) return { kind: 'Outreach', who, raw }; return { kind: 'Other', who, raw }; }
    return { kind: 'Other', who: who || raw, raw };
  }
  const VIA = { call: 'Call', in_person: 'In person', loom_video: 'Loom video', other: 'Other', did_not_onboard: 'Did not onboard' };

  // GET /api/reports-ai/onboarding?from&to&all=1 — every welcome form in the range (date_onboarded, LA days), the AM with their face,
  // the client, the source folded by sourceOf(), the onboarding method, lead rating, budget. `all=1` keeps the "did not onboard" forms.
  app.get('/api/reports-ai/onboarding', auth, adminOnly, async (req, res) => {
    try {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null, to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
      const where = ['f.date_onboarded IS NOT NULL'];
      if (from) where.push('f.date_onboarded >= ' + mysql.escape(from)); if (to) where.push('f.date_onboarded <= ' + mysql.escape(to));
      if (req.query.all !== '1') where.push("(f.onboarding_type IS NULL OR f.onboarding_type <> 'did_not_onboard')");
      const rows = await runQuery('SELECT f.id, f.customer_id, f.date_onboarded, f.onboarding_type, f.onboarding_type_other, f.lead_rating, f.how_did_they_hear_about_us, f.hear_about_us_who, f.referred_by_manager_id, ' +
        'f.annual_print_budget, f.estimated_order_value, f.onboarding_outcome, f.created_at, f.created_by_manager_id, ' +
        'c.company_name, c.name AS c_name, c.last_name AS c_last, c.email AS c_email, c.manager_id AS c_manager_id, ' +
        'u.name AS am_name, u.last_name AS am_last, u.memberimage AS am_photo, r.name AS ref_name, r.last_name AS ref_last ' +
        'FROM customer_welcome_forms f LEFT JOIN customer c ON c.id = f.customer_id LEFT JOIN user u ON u.id = f.created_by_manager_id LEFT JOIN user r ON r.id = f.referred_by_manager_id ' +
        'WHERE ' + where.join(' AND ') + ' ORDER BY f.date_onboarded DESC, f.id DESC LIMIT 5000');
      const ams = {};
      const out = rows.map(r => {
        const amName = [r.am_name, r.am_last].filter(Boolean).join(' ').trim() || (r.created_by_manager_id ? 'User #' + r.created_by_manager_id : 'Nobody');
        const am = { id: r.created_by_manager_id || 0, name: amName, photo: staffPhoto(r.am_photo) };
        if (!ams[am.id]) ams[am.id] = Object.assign({ n: 0 }, am); ams[am.id].n++;
        const refName = [r.ref_name, r.ref_last].filter(Boolean).join(' ').trim();
        return { id: r.id, date: ymd(r.date_onboarded), created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
          customer: { id: r.customer_id, company: r.company_name || '', person: [r.c_name, r.c_last].filter(Boolean).join(' ').trim(), email: r.c_email || '', manager_id: r.c_manager_id || null },
          am, via: VIA[r.onboarding_type] || (r.onboarding_type ? String(r.onboarding_type).replace(/_/g, ' ') : ''), via_code: r.onboarding_type || '', via_other: r.onboarding_type_other || '',
          source: sourceOf(r, refName), rating: r.lead_rating || '', budget: r.annual_print_budget || '', value: r.estimated_order_value || null, outcome: r.onboarding_outcome || '', not_onboarded: r.onboarding_type === 'did_not_onboard' };
      });
      res.json({ ok: true, rows: out, ams: Object.values(ams).sort((a, b) => b.n - a.n), from, to });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---------------------------------------------------------------- Product Report (1.20.98)
  // What sells: per product, for the period and the equal period before it — invoiced jobs, units (the Quantity option; a custom
  // quantity wins), revenue, clients, NEW clients (the customer's first invoiced job ever was this one), reorders, express, quotes
  // that did not become orders, and production time (production_started_at → the last 'complete' QR scan; order → ready from the
  // job's creation; on time = ready by complete_by). Canceled jobs (estimate_stage complete/canceled) are left out of everything.
  // Every query is bounded by an estimate id floor (estimate.created has no index), the done scans by one pass over
  // qr_scan_history (no estimate_id index there either — never a correlated subquery), the first-order-per-customer map cached 10 min.
  const laBound = (day, end) => { const d = new Date(day + 'T12:00:00Z'); const off = (() => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', timeZoneName: 'shortOffset' }).formatToParts(d).find(x => x.type === 'timeZoneName'); const m = /GMT([+-]\d+)/.exec(f ? f.value : ''); return m ? parseInt(m[1]) : -7; })(); const t = new Date(day + 'T00:00:00Z').getTime() - off * 3600e3 + (end ? 864e5 : 0); return new Date(t).toISOString().slice(0, 19).replace('T', ' '); };
  const floors = {};
  async function idFloorAt(dt) {
    const k = String(dt).slice(0, 10); const f = floors[k]; if (f && Date.now() - f.at < 3600e3) return f.id;
    const r = await runQuery('SELECT MIN(id) id FROM estimate WHERE created >= ' + mysql.escape(dt));
    const id = (r[0] && Number(r[0].id)) || 0; floors[k] = { id, at: Date.now() }; return id;
  }
  let firstOrders = null, firstOrdersAt = 0;
  async function firstOrderMap() {
    if (firstOrders && Date.now() - firstOrdersAt < 600e3) return firstOrders;
    const rows = await runQuery('SELECT estimate_clientid cid, MIN(id) id FROM estimate WHERE estimate_invoiceid > 0 AND estimate_clientid > 0 GROUP BY estimate_clientid');
    const m = {}; rows.forEach(r => { m[r.cid] = Number(r.id); }); firstOrders = m; firstOrdersAt = Date.now(); return m;
  }
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const r1 = (n) => n == null ? null : Math.round(n * 10) / 10;
  async function productReport(from, to) {
    // the period and the one before it, same length, back to back
    const days = Math.max(1, Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 864e5) + 1);
    const pFrom = new Date(new Date(from + 'T12:00:00Z').getTime() - days * 864e5).toISOString().slice(0, 10);
    const b0 = laBound(pFrom), b1 = laBound(from), b2 = laBound(to, true);
    const floor = await idFloorAt(b0);
    const [rows, qtys, dones, cancels, first] = await Promise.all([
      runQuery('SELECT e.id, e.estimate_productid pid, e.estimate_clientid cid, e.estimate_price price, e.created, e.estimate_type typ, e.express, e.estimate_invoiceid inv, e.production_started_at started, e.complete_by, e.design_price, e.outsource_cost, e.sample_only ' +
        'FROM estimate e WHERE e.id >= ' + floor + ' AND e.created >= ' + mysql.escape(b0) + ' AND e.created < ' + mysql.escape(b2) + ' AND e.estimate_productid > 0'),
      runQuery("SELECT estimate_id id, COALESCE(NULLIF(estimate_option_custom_value, ''), estimate_option_value) q FROM estimateoption WHERE estimate_id >= " + floor + " AND estimate_option_name = 'Quantity'"),
      runQuery("SELECT estimate_id id, MAX(created_at) d FROM qr_scan_history WHERE estimate_id >= " + floor + " AND production_step = 'complete' GROUP BY estimate_id"),
      runQuery("SELECT estimate_id id FROM estimate_stage WHERE estimate_id >= " + floor + " AND estimate_stage = 'complete' AND estimate_substage = 'canceled'"),
      firstOrderMap()
    ]);
    const qty = {}; qtys.forEach(r => { const n = parseInt(String(r.q).replace(/[^\d]/g, '')); if (n > 0) qty[r.id] = n; });
    const done = {}; dones.forEach(r => { done[r.id] = new Date(r.d).getTime(); });
    const canceled = new Set(cancels.map(r => Number(r.id)));
    const cur0 = new Date(b1.replace(' ', 'T') + 'Z').getTime();
    const P = {}; const prod = (pid) => P[pid] || (P[pid] = { pid, cur: blank(), prev: blank() });
    function blank() { return { orders: 0, qty: 0, rev: 0, clients: new Set(), new_clients: 0, new_rev: 0, reorders: 0, express: 0, quotes: 0, design: 0, outsource: 0, prod: [], o2r: [], ontime: 0, timed: 0, big: 0 }; }
    rows.forEach(r => {
      if (canceled.has(Number(r.id))) return;
      const t = new Date(r.created).getTime(), side = t >= cur0 ? 'cur' : 'prev', s = prod(r.pid)[side];
      if (!(r.inv > 0)) { if (!r.sample_only) s.quotes++; return; }
      s.orders++; s.rev += Number(r.price) || 0; s.qty += qty[r.id] || 0; if (r.cid > 0) s.clients.add(r.cid);
      if (r.cid > 0 && first[r.cid] === Number(r.id)) { s.new_clients++; s.new_rev += Number(r.price) || 0; }
      if (r.typ === 'reorder') s.reorders++; if (r.express) s.express++; if (Number(r.design_price) > 0) s.design++; if (Number(r.outsource_cost) > 0) s.outsource++;
      if ((Number(r.price) || 0) >= 1000) s.big++;
      const d = done[r.id];
      if (d) {
        const st = r.started ? new Date(r.started).getTime() : null;
        if (st && d > st) { const days = (d - st) / 864e5; if (days <= 90) s.prod.push(days); }
        const o = (d - t) / 864e5; if (o > 0 && o <= 120) s.o2r.push(o);
        if (r.complete_by) { s.timed++; if (d <= new Date(r.complete_by).getTime() + 7 * 3600e3) s.ontime++; }
      }
    });
    const pids = Object.keys(P).map(Number); if (!pids.length) return { products: [], from, to, prev_from: pFrom, prev_to: new Date(new Date(from + 'T12:00:00Z').getTime() - 864e5).toISOString().slice(0, 10), days };
    const info = await runQuery('SELECT p.id, COALESCE(NULLIF(p.public_title, \'\'), p.title) title, p.image, p.active, p.available_for_customers pub, pc.title category FROM product p LEFT JOIN productcategory pc ON pc.id = p.product_category_id WHERE p.id IN (' + pids.join(',') + ')');
    const I = {}; info.forEach(r => { I[r.id] = r; });
    const pack = (s) => ({ orders: s.orders, qty: s.qty, rev: Math.round(s.rev * 100) / 100, clients: s.clients.size, new_clients: s.new_clients, new_rev: Math.round(s.new_rev), reorders: s.reorders, express: s.express, quotes: s.quotes, design: s.design, outsource: s.outsource, big: s.big,
      avg_order: s.orders ? Math.round(s.rev / s.orders * 100) / 100 : null, unit_price: s.qty ? Math.round(s.rev / s.qty * 10000) / 10000 : null,
      prod_avg: s.prod.length ? r1(s.prod.reduce((a, b) => a + b, 0) / s.prod.length) : null, prod_med: r1(median(s.prod)), prod_n: s.prod.length, prod_max: s.prod.length ? r1(Math.max.apply(null, s.prod)) : null,
      o2r_med: r1(median(s.o2r)), ontime: s.timed ? Math.round(s.ontime / s.timed * 100) : null, timed: s.timed });
    const products = pids.map(pid => { const p = P[pid], i = I[pid] || {}; const cur = pack(p.cur), prev = pack(p.prev);
      const pct = (a, b) => b ? Math.round((a - b) / b * 100) : (a ? null : 0);
      return { pid, title: i.title || ('Product #' + pid), image: i.image || null, category: i.category || '', active: i.active == null ? null : !!Number(i.active), cur, prev,
        trend: { orders: pct(cur.orders, prev.orders), rev: pct(cur.rev, prev.rev), qty: pct(cur.qty, prev.qty), unit: cur.unit_price && prev.unit_price ? Math.round((cur.unit_price - prev.unit_price) / prev.unit_price * 100) : null } };
    }).filter(p => p.cur.orders || p.prev.orders || p.cur.quotes).sort((a, b) => b.cur.rev - a.cur.rev);
    return { products, from, to, prev_from: pFrom, prev_to: new Date(new Date(from + 'T12:00:00Z').getTime() - 864e5).toISOString().slice(0, 10), days };
  }
  // GET /api/reports-ai/products?from&to (LA days; default the last 30 days)
  // GET /api/reports-ai/products/:pid/jobs?from&to — the jobs behind one product's row (1.20.104): E-number, name, client, created,
  // production started / done, production days, order → ready, on time, price, quantity, type — so a production figure can be analysed.
  app.get('/api/reports-ai/products/:pid/jobs', auth, adminOnly, async (req, res) => {
    try {
      const pid = parseInt(req.params.pid); if (!pid) return res.json({ ok: false, error: 'product id' });
      const today = ymd(new Date()); const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
      const to = ok(req.query.to) ? req.query.to : today, from = ok(req.query.from) ? req.query.from : new Date(new Date(to + 'T12:00:00Z').getTime() - 29 * 864e5).toISOString().slice(0, 10);
      const b1 = laBound(from), b2 = laBound(to, true), floor = await idFloorAt(b1);
      const rows = await runQuery('SELECT e.id, e.estimate_name name, e.estimate_clientid cid, e.estimate_price price, e.created, e.estimate_type typ, e.express, e.estimate_invoiceid inv, e.production_started_at started, e.complete_by, c.company_name, c.name c_name, c.last_name c_last ' +
        'FROM estimate e LEFT JOIN customer c ON c.id = e.estimate_clientid WHERE e.id >= ' + floor + ' AND e.created >= ' + mysql.escape(b1) + ' AND e.created < ' + mysql.escape(b2) + ' AND e.estimate_productid = ' + pid + ' ORDER BY e.id DESC LIMIT 2000');
      const ids = rows.map(r => r.id); if (!ids.length) return res.json({ ok: true, jobs: [] });
      const [qtys, dones, cancels] = await Promise.all([
        runQuery("SELECT estimate_id id, COALESCE(NULLIF(estimate_option_custom_value, ''), estimate_option_value) q FROM estimateoption WHERE estimate_option_name = 'Quantity' AND estimate_id IN (" + ids.join(',') + ')'),
        runQuery("SELECT estimate_id id, MAX(created_at) d FROM qr_scan_history WHERE estimate_id >= " + floor + " AND production_step = 'complete' AND estimate_id IN (" + ids.join(',') + ') GROUP BY estimate_id'),
        runQuery("SELECT estimate_id id FROM estimate_stage WHERE estimate_stage = 'complete' AND estimate_substage = 'canceled' AND estimate_id IN (" + ids.join(',') + ')')
      ]);
      const qty = {}; qtys.forEach(r => { const n = parseInt(String(r.q).replace(/[^\d]/g, '')); if (n > 0) qty[r.id] = n; });
      const done = {}; dones.forEach(r => { done[r.id] = new Date(r.d); }); const canceled = new Set(cancels.map(r => Number(r.id)));
      const jobs = rows.map(r => { const d = done[r.id] || null, st = r.started ? new Date(r.started) : null, cr = new Date(r.created);
        return { id: r.id, e: 'E' + r.id, name: r.name || '', client: r.company_name || [r.c_name, r.c_last].filter(Boolean).join(' ') || (r.cid ? 'Customer #' + r.cid : ''), cid: r.cid, price: Number(r.price) || 0, qty: qty[r.id] || null, type: r.typ, express: !!r.express,
          invoiced: r.inv > 0, canceled: canceled.has(Number(r.id)), created: cr.toISOString(), started: st ? st.toISOString() : null, done: d ? d.toISOString() : null, complete_by: r.complete_by ? new Date(r.complete_by).toISOString() : null,
          prod_days: st && d && d > st ? Math.round((d - st) / 864e5 * 10) / 10 : null, o2r_days: d && d > cr ? Math.round((d - cr) / 864e5 * 10) / 10 : null, on_time: d && r.complete_by ? d.getTime() <= new Date(r.complete_by).getTime() + 7 * 3600e3 : null }; });
      res.json({ ok: true, jobs, from, to });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/reports-ai/products', auth, adminOnly, async (req, res) => {
    try {
      const today = ymd(new Date()); const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
      const to = ok(req.query.to) ? req.query.to : today, from = ok(req.query.from) ? req.query.from : new Date(new Date(to + 'T12:00:00Z').getTime() - 29 * 864e5).toISOString().slice(0, 10);
      if (from > to) return res.json({ ok: false, error: 'from is after to' });
      const t0 = Date.now(); const out = await productReport(from, to); out.ms = Date.now() - t0; out.ok = true; res.json(out);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---------------------------------------------------------------- New Clients + Referral Report (1.20.100)
  // Every customer account created in the period (customer.created, LA days): who made it — the website (self sign-up,
  // created_from_website = 1; the CRM logs those under the "CSR Team" user) or the team member whose customer_logs
  // 'customer_created' row it is — the account manager it was given, where the client came from (the welcome form's answer when
  // there is one, else the sign-up form's refered_by code), the referral behind it (referred_by_client_id / referred_by_manager_id on
  // the account, or the welcome form's existing_client / employee_referral), the onboarding, and whether they have ordered yet
  // (invoiced estimates: count, revenue, first order). The Referral Report is the same rows narrowed to the ones with a referral,
  // plus welcome forms in the period that name a referral for an older account.
  const SIGNUP = { google: 'Google', googleads: 'Google Ads', google_ads: 'Google Ads', linkedin: 'LinkedIn', chat_gpt: 'ChatGPT / AI', chatgpt: 'ChatGPT / AI', personalreferral: 'Client referral', axiom_referral: 'Team referral', trade_show_expo: 'Trade show', reddit: 'Reddit', youtube: 'YouTube', facebook: 'Social', instagram: 'Social', tiktok: 'Social', yelp: 'Yelp', other: 'Other' };
  const signupSource = (code, custom) => { const c = String(code || '').toLowerCase().trim(); if (!c) return { kind: 'Unknown', who: '', raw: '' }; if (c === 'other') { const o = sourceOf({ how_did_they_hear_about_us: custom || 'other' }); return o.kind === 'Unknown' || o.kind === 'Other' ? { kind: 'Other', who: custom || '', raw: custom || 'other' } : o; } return { kind: SIGNUP[c] || c.replace(/_/g, ' '), who: '', raw: c }; };
  const fullName = (a, b) => [a, b].filter(Boolean).join(' ').trim();
  async function inChunks(ids, fn) { const out = []; for (let i = 0; i < ids.length; i += 2000) out.push.apply(out, await fn(ids.slice(i, i + 2000))); return out; }
  async function clientsReport(from, to) {
    const b1 = laBound(from), b2 = laBound(to, true);
    const days = Math.max(1, Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 864e5) + 1);
    const pFrom = new Date(new Date(from + 'T12:00:00Z').getTime() - days * 864e5).toISOString().slice(0, 10), b0 = laBound(pFrom);
    const [rows, logs, prev, older] = await Promise.all([
      runQuery('SELECT c.id, c.created, c.company_name, c.name, c.last_name, c.email, c.manager_id, c.created_from_website web, c.refered_by, c.refered_by_custom, c.referred_by_client_id, c.referred_by_manager_id, c.biz_dev_type, c.signupper_id, c.verified, c.status, ' +
        'rc.company_name rc_company, rc.name rc_name, rc.last_name rc_last, ru.name ru_name, ru.last_name ru_last, ru.memberimage ru_photo, ru.title ru_title, ' +
        'am.name am_name, am.last_name am_last, am.memberimage am_photo, am.email am_email, ' +
        'f.id f_id, f.date_onboarded, f.created_by_manager_id f_by, f.onboarding_type, f.how_did_they_hear_about_us, f.hear_about_us_who, f.referred_by_manager_id f_ref_mgr, f.lead_rating, ' +
        'fr.name fr_name, fr.last_name fr_last, fr.memberimage fr_photo, fr.title fr_title, fb.name fb_name, fb.last_name fb_last ' +
        'FROM customer c LEFT JOIN customer rc ON rc.id = c.referred_by_client_id LEFT JOIN user ru ON ru.id = c.referred_by_manager_id LEFT JOIN user am ON am.id = c.manager_id ' +
        'LEFT JOIN customer_welcome_forms f ON f.id = (SELECT MAX(id) FROM customer_welcome_forms w WHERE w.customer_id = c.id) LEFT JOIN user fr ON fr.id = f.referred_by_manager_id LEFT JOIN user fb ON fb.id = f.created_by_manager_id ' +
        'WHERE c.created >= ' + mysql.escape(b1) + ' AND c.created < ' + mysql.escape(b2) + ' ORDER BY c.created DESC LIMIT 20000'),
      runQuery("SELECT l.client_id cid, l.user_id uid, u.name, u.last_name, u.memberimage photo, u.type FROM customer_logs l LEFT JOIN user u ON u.id = l.user_id WHERE l.event_type = 'customer_created' AND l.created_at >= " + mysql.escape(b1) + ' AND l.created_at < ' + mysql.escape(b2)),
      runQuery('SELECT COUNT(*) n, SUM(created_from_website = 1) web, SUM(referred_by_client_id > 0 OR referred_by_manager_id > 0 OR refered_by IN (\'personalreferral\', \'axiom_referral\')) refs FROM customer WHERE created >= ' + mysql.escape(b0) + ' AND created < ' + mysql.escape(b1)),
      runQuery("SELECT f.id f_id, f.customer_id id, f.date_onboarded, f.how_did_they_hear_about_us, f.hear_about_us_who, f.referred_by_manager_id f_ref_mgr, f.created_by_manager_id f_by, c.created, c.company_name, c.name, c.last_name, c.email, c.manager_id, c.created_from_website web, " +
        'am.name am_name, am.last_name am_last, am.memberimage am_photo, fr.name fr_name, fr.last_name fr_last, fr.memberimage fr_photo, fr.title fr_title, fb.name fb_name, fb.last_name fb_last ' +
        'FROM customer_welcome_forms f JOIN customer c ON c.id = f.customer_id LEFT JOIN user am ON am.id = c.manager_id LEFT JOIN user fr ON fr.id = f.referred_by_manager_id LEFT JOIN user fb ON fb.id = f.created_by_manager_id ' +
        'WHERE f.date_onboarded >= ' + mysql.escape(from) + ' AND f.date_onboarded <= ' + mysql.escape(to) + ' AND c.created < ' + mysql.escape(b1) + " AND f.how_did_they_hear_about_us IN ('existing_client', 'employee_referral')")
    ]);
    const creator = {}; logs.forEach(l => { if (!creator[l.cid]) creator[l.cid] = { id: l.uid, name: fullName(l.name, l.last_name) || ('User #' + l.uid), photo: staffPhoto(l.photo), type: l.type || '' }; });
    const ids = rows.map(r => r.id).concat(older.map(r => r.id));
    const ord = {}; (await inChunks(ids, (part) => part.length ? runQuery('SELECT estimate_clientid cid, COUNT(*) n, SUM(estimate_price) rev, MIN(created) first FROM estimate WHERE estimate_invoiceid > 0 AND estimate_clientid IN (' + part.map(Number).join(',') + ') GROUP BY estimate_clientid') : [])).forEach(o => { ord[o.cid] = { n: Number(o.n), rev: Math.round(Number(o.rev) * 100) / 100, first: ymd(new Date(o.first)) }; });
    function shape(r, olderAccount) {
      const web = Number(r.web) === 1, cr = creator[r.id];
      const made = web ? { kind: 'web', name: 'Website sign-up' } : cr ? Object.assign({ kind: 'team' }, cr) : { kind: 'unknown', name: 'Not logged' };
      const form = r.f_id ? sourceOf(r, fullName(r.fr_name, r.fr_last)) : null, signup = signupSource(r.refered_by, r.refered_by_custom);
      const source = form && form.kind !== 'Unknown' ? Object.assign({ from: 'form' }, form) : Object.assign({ from: 'signup' }, signup.kind === 'Unknown' && form ? form : signup);
      let referral = null;
      if (r.referred_by_client_id > 0) referral = { kind: 'client', who: r.rc_company || fullName(r.rc_name, r.rc_last) || ('Customer #' + r.referred_by_client_id), who_id: r.referred_by_client_id, from: 'account' };
      else if (r.referred_by_manager_id > 0) referral = { kind: 'team', who: fullName(r.ru_name, r.ru_last) || ('User #' + r.referred_by_manager_id), who_id: r.referred_by_manager_id, photo: staffPhoto(r.ru_photo), title: r.ru_title || '', from: 'account' };
      else if (r.how_did_they_hear_about_us === 'existing_client') referral = { kind: 'client', who: String(r.hear_about_us_who || '').trim() || 'a client (name not written)', who_id: null, from: 'form' };
      else if (r.how_did_they_hear_about_us === 'employee_referral' || r.f_ref_mgr > 0) referral = { kind: 'team', who: fullName(r.fr_name, r.fr_last) || ('User #' + r.f_ref_mgr), who_id: r.f_ref_mgr || null, photo: staffPhoto(r.fr_photo), title: r.fr_title || '', from: 'form' };
      else if (/personalreferral/.test(r.refered_by || '')) referral = { kind: 'client', who: (form && form.who) || 'not written', who_id: null, from: 'signup' };
      else if (/axiom_referral/.test(r.refered_by || '')) referral = { kind: 'team', who: (form && form.who) || 'not written', who_id: null, from: 'signup' };
      else if (form && /referral/i.test(form.kind)) referral = { kind: /client/i.test(form.kind) ? 'client' : /team/i.test(form.kind) ? 'team' : 'other', who: form.who || 'not written', who_id: null, from: 'form' };
      return { id: r.id, created: new Date(r.created).toISOString(), date: ymd(new Date(r.created)), company: r.company_name || '', person: fullName(r.name, r.last_name), email: r.email || '', web, made,
        am: r.manager_id ? { id: r.manager_id, name: fullName(r.am_name, r.am_last) || ('User #' + r.manager_id), photo: staffPhoto(r.am_photo), email: r.am_email || '' } : null,
        signup: { code: r.refered_by || '', custom: r.refered_by_custom || '' }, source, referral, bizdev: r.biz_dev_type || '', verified: r.verified == null ? null : Number(r.verified), status: r.status,
        onboarded: r.f_id ? { date: ymd(r.date_onboarded), by: fullName(r.fb_name, r.fb_last), not: r.onboarding_type === 'did_not_onboard', rating: r.lead_rating || '' } : null,
        orders: ord[r.id] || null, older_account: !!olderAccount };
    }
    const out = rows.map(r => shape(r, false));
    const olderRows = older.filter(r => !rows.some(x => x.id === r.id)).map(r => shape(r, true)).filter(r => r.referral);
    const p = prev[0] || {};
    return { rows: out, older_referrals: olderRows, from, to, prev: { from: pFrom, to: new Date(new Date(from + 'T12:00:00Z').getTime() - 864e5).toISOString().slice(0, 10), n: Number(p.n) || 0, web: Number(p.web) || 0, refs: Number(p.refs) || 0 }, days };
  }
  app.get('/api/reports-ai/clients', auth, adminOnly, async (req, res) => {
    try {
      const today = ymd(new Date()); const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
      const to = ok(req.query.to) ? req.query.to : today, from = ok(req.query.from) ? req.query.from : today.slice(0, 8) + '01';
      if (from > to) return res.json({ ok: false, error: 'from is after to' });
      const t0 = Date.now(); const out = await clientsReport(from, to); out.ms = Date.now() - t0; out.ok = true; res.json(out);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // the account managers = the CRM team "Account Managers" (team.members JSON), active users — the "send to all AMs" list
  let amTeamCache = null, amTeamAt = 0;
  async function amTeam() {
    if (amTeamCache && Date.now() - amTeamAt < 600e3) return amTeamCache;
    try {
      const rows = await runQuery("SELECT u.id, u.name, u.last_name, u.email, u.memberimage FROM team t JOIN user u ON JSON_CONTAINS(t.members, CAST(u.id AS JSON)) WHERE t.name = 'Account Managers' AND u.status = 10 AND u.type = 'member' AND u.email LIKE '%@%'");
      amTeamCache = rows.map(r => ({ id: r.id, name: fullName(r.name, r.last_name), email: r.email, photo: staffPhoto(r.memberimage) })); amTeamAt = Date.now();
    } catch (e) { amTeamCache = amTeamCache || []; }
    return amTeamCache;
  }
  app.get('/api/reports-ai/ams', auth, adminOnly, async (req, res) => { res.json({ ok: true, ams: await amTeam() }); });

  // ---------------------------------------------------------------- the monthly email (1.20.97)
  // Settings (SQLite ra_settings key 'onboarding_email'): enabled, span ('month' = the previous calendar month, '30' = the last 30
  // days, 'week' = the previous Mon–Sun week), day (day of month to send, 1), at ('07:00' LA), to (the owner), cc (comma list),
  // per_am (each AM who onboarded gets their own list). The owner's mail: the leaderboard, the sources, every onboarding; an AM's mail:
  // their count, rank and their own list. Every send is logged in ra_sent; the clock sends once per period key.
  // 1.20.100: one mail setup per report — MAIL[report] = { kind (Admin → Emails), defaults, build(range) }; settings live in
  // ra_settings key '<report>_email'. onboarding: per_am = each AM gets their own list; clients: all_ams = every account manager
  // (the CRM team "Account Managers") gets the same report, the owner + CC get the copy.
  const EMAIL_DEFAULTS = { enabled: true, span: 'month', day: 1, at: '07:00', to: 'gary@axiomprint.com', cc: 'luciana@axiomprint.com', per_am: true };
  const CLIENTS_DEFAULTS = { enabled: true, span: 'month', day: 1, at: '07:00', to: 'gary@axiomprint.com', cc: 'arsine@axiomprint.com, luciana@axiomprint.com', all_ams: true };
  const MAIL = { onboarding: { kind: 'ra.onboarding', defaults: EMAIL_DEFAULTS }, clients: { kind: 'ra.clients', defaults: CLIENTS_DEFAULTS } };
  const emailCaches = {};
  async function emailSettings(report) { report = MAIL[report] ? report : 'onboarding'; const r = await dbGet('SELECT value FROM ra_settings WHERE key = ?', [report + '_email']).catch(() => null); let v = {}; try { v = r && r.value ? JSON.parse(r.value) : {}; } catch (e) {} emailCaches[report] = Object.assign({}, MAIL[report].defaults, v); return emailCaches[report]; }
  function emailSettingsSync(report) { report = MAIL[report] ? report : 'onboarding'; return emailCaches[report] || MAIL[report].defaults; }
  Object.keys(MAIL).forEach(k => emailSettings(k).catch(() => {}));
  if (Notify) Notify.register('ra.clients', () => (emailSettingsSync('clients').to || 'gary@axiomprint.com'));
  const LA = 'America/Los_Angeles';
  const laParts = (d) => { const o = {}; new Intl.DateTimeFormat('en-US', { timeZone: LA, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d || new Date()).forEach(x => { o[x.type] = x.value; }); return o; };
  const laDay = (d) => { const o = laParts(d); return o.year + '-' + o.month + '-' + o.day; };
  const addDays = (k, n) => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // the period a mail sent on `today` (LA day) covers
  function spanRange(span, today) {
    const y = +today.slice(0, 4), m = +today.slice(5, 7);
    if (span === 'week') { const d = new Date(today + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; const mon = addDays(today, -dow - 7); return { from: mon, to: addDays(mon, 6), key: 'week:' + mon, label: 'the week of ' + usD(mon) + ' – ' + usD(addDays(mon, 6)) }; }
    if (span === '30') return { from: addDays(today, -30), to: addDays(today, -1), key: '30:' + today, label: 'the last 30 days (' + usD(addDays(today, -30)) + ' – ' + usD(addDays(today, -1)) + ')' };
    const first = new Date(Date.UTC(y, m - 2, 1)), last = new Date(Date.UTC(y, m - 1, 0));
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), key: 'month:' + first.toISOString().slice(0, 7), label: MON[first.getUTCMonth()] + ' ' + first.getUTCFullYear() };
  }
  const usD = (k) => k ? k.slice(5, 7) + '-' + k.slice(8, 10) + '-' + k.slice(0, 4) : '';
  async function onboardingRows(from, to) {
    const rows = await runQuery('SELECT f.id, f.customer_id, f.date_onboarded, f.onboarding_type, f.onboarding_type_other, f.lead_rating, f.how_did_they_hear_about_us, f.hear_about_us_who, f.referred_by_manager_id, f.created_by_manager_id, ' +
      'c.company_name, c.name AS c_name, c.last_name AS c_last, u.name AS am_name, u.last_name AS am_last, u.email AS am_email, u.memberimage AS am_photo, r.name AS ref_name, r.last_name AS ref_last ' +
      'FROM customer_welcome_forms f LEFT JOIN customer c ON c.id = f.customer_id LEFT JOIN user u ON u.id = f.created_by_manager_id LEFT JOIN user r ON r.id = f.referred_by_manager_id ' +
      "WHERE f.date_onboarded >= " + mysql.escape(from) + ' AND f.date_onboarded <= ' + mysql.escape(to) + " AND (f.onboarding_type IS NULL OR f.onboarding_type <> 'did_not_onboard') ORDER BY f.date_onboarded, f.id");
    return rows.map(r => ({ date: ymd(r.date_onboarded), customer: r.company_name || [r.c_name, r.c_last].filter(Boolean).join(' ') || ('Customer #' + r.customer_id), person: r.company_name ? [r.c_name, r.c_last].filter(Boolean).join(' ') : '',
      am: { id: r.created_by_manager_id || 0, name: [r.am_name, r.am_last].filter(Boolean).join(' ').trim() || 'Nobody', email: r.am_email || '', photo: staffPhoto(r.am_photo) },
      via: VIA[r.onboarding_type] || (r.onboarding_type ? String(r.onboarding_type).replace(/_/g, ' ') : ''), via_other: r.onboarding_type_other || '', source: sourceOf(r, [r.ref_name, r.ref_last].filter(Boolean).join(' ').trim()), rating: r.lead_rating || '' }));
  }
  const RATING = { high_potential: 'High potential', developing_opportunity: 'Developing', limited_opportunity: 'Limited' };
  function tableHtml(rows, withAm) {
    return '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px"><tr style="background:#f3f4f8;color:#555"><th align="left" style="padding:6px 8px">Date</th><th align="left" style="padding:6px 8px">Client</th>' + (withAm ? '<th align="left" style="padding:6px 8px">AM</th>' : '') + '<th align="left" style="padding:6px 8px">Source</th><th align="left" style="padding:6px 8px">Via</th><th align="left" style="padding:6px 8px">Rating</th></tr>' +
      rows.map(r => '<tr><td style="padding:6px 8px;border-top:1px solid #eee;white-space:nowrap">' + usD(r.date) + '</td><td style="padding:6px 8px;border-top:1px solid #eee"><b>' + esc(r.customer) + '</b>' + (r.person ? '<br><span style="color:#777">' + esc(r.person) + '</span>' : '') + '</td>' + (withAm ? '<td style="padding:6px 8px;border-top:1px solid #eee">' + esc(r.am.name) + '</td>' : '') +
        '<td style="padding:6px 8px;border-top:1px solid #eee">' + esc(r.source.kind) + (r.source.who ? '<br><span style="color:#777">from ' + esc(r.source.who) + '</span>' : '') + '</td><td style="padding:6px 8px;border-top:1px solid #eee">' + esc(r.via) + (r.via_other ? '<br><span style="color:#777">' + esc(r.via_other) + '</span>' : '') + '</td><td style="padding:6px 8px;border-top:1px solid #eee">' + esc(RATING[r.rating] || r.rating.replace(/_/g, ' ')) + '</td></tr>').join('') + '</table>';
  }
  function ownerHtml(rows, range, ams) {
    const src = {}; rows.forEach(r => { src[r.source.kind] = (src[r.source.kind] || 0) + 1; });
    const srcRows = Object.keys(src).sort((a, b) => src[b] - src[a]).map(k => '<tr><td style="padding:4px 8px">' + esc(k) + '</td><td align="right" style="padding:4px 8px"><b>' + src[k] + '</b></td></tr>').join('');
    return '<div style="font-family:Inter,Arial,sans-serif;color:#1c1c28;max-width:860px">' +
      '<h2 style="margin:0 0 4px">Client onboardings — ' + esc(range.label) + '</h2><div style="color:#777;margin-bottom:16px">' + rows.length + ' onboarding' + (rows.length === 1 ? '' : 's') + ' by ' + ams.length + ' account manager' + (ams.length === 1 ? '' : 's') + ' · from the CRM welcome forms · <a href="https://nova.axiomprint.com/reports-ai">open in NovaAI</a></div>' +
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px"><tr style="background:#f3f4f8;color:#555"><th align="left" style="padding:6px 8px">#</th><th align="left" style="padding:6px 8px">Account manager</th><th align="right" style="padding:6px 8px">Onboardings</th></tr>' +
      ams.map((a, i) => '<tr><td style="padding:6px 8px;border-top:1px solid #eee">' + (i + 1) + '</td><td style="padding:6px 8px;border-top:1px solid #eee">' + (a.photo ? '<img src="' + esc(a.photo) + '" width="24" height="24" style="border-radius:12px;vertical-align:middle;margin-right:6px">' : '') + esc(a.name) + '</td><td align="right" style="padding:6px 8px;border-top:1px solid #eee"><b>' + a.n + '</b></td></tr>').join('') + '</table>' +
      '<h3 style="margin:0 0 6px;font-size:14px">Where the clients came from</h3><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px">' + srcRows + '</table>' +
      '<h3 style="margin:0 0 6px;font-size:14px">Every onboarding</h3>' + tableHtml(rows, true) + '</div>';
  }
  function amHtml(a, mine, rank, total, range) {
    return '<div style="font-family:Inter,Arial,sans-serif;color:#1c1c28;max-width:860px"><h2 style="margin:0 0 4px">Your client onboardings — ' + esc(range.label) + '</h2>' +
      '<div style="color:#777;margin-bottom:16px">Hi ' + esc(a.name.split(' ')[0]) + ' — you onboarded <b style="color:#1c1c28">' + mine.length + '</b> client' + (mine.length === 1 ? '' : 's') + ' (#' + rank + ' of ' + total + ' on the team). Thank you!</div>' + tableHtml(mine, false) + '</div>';
  }
  // the New Clients mail: the month's numbers, who made the accounts, where they came from, the referrals, every new client
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  function clientsHtml(d, range) {
    const rows = d.rows, web = rows.filter(r => r.web).length, team = rows.filter(r => r.made.kind === 'team').length, ordered = rows.filter(r => r.orders).length, rev = rows.reduce((a, r) => a + (r.orders ? r.orders.rev : 0), 0);
    const count = (f) => { const m = {}; rows.forEach(r => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; }); return Object.keys(m).sort((a, b) => m[b] - m[a]).map(k => [k, m[k]]); };
    const th = (t, right) => '<th align="' + (right ? 'right' : 'left') + '" style="padding:6px 8px">' + t + '</th>', td = (t, right) => '<td align="' + (right ? 'right' : 'left') + '" style="padding:6px 8px;border-top:1px solid #eee">' + t + '</td>';
    const tbl = (head, body) => '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px;font-size:13px"><tr style="background:#f3f4f8;color:#555">' + head + '</tr>' + body + '</table>';
    const makers = {}; rows.forEach(r => { if (r.made.kind !== 'team') return; const k = r.made.id; if (!makers[k]) makers[k] = Object.assign({ n: 0 }, r.made); makers[k].n++; });
    const mk = Object.values(makers).sort((a, b) => b.n - a.n);
    const refs = rows.filter(r => r.referral).concat(d.older_referrals || []);
    const refBy = {}; refs.forEach(r => { const k = r.referral.kind + ':' + (r.referral.who_id || r.referral.who); if (!refBy[k]) refBy[k] = { kind: r.referral.kind, who: r.referral.who, n: 0 }; refBy[k].n++; });
    const rb = Object.values(refBy).sort((a, b) => b.n - a.n);
    const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
    return '<div style="font-family:Inter,Arial,sans-serif;color:#1c1c28;max-width:900px">' +
      '<h2 style="margin:0 0 4px">New clients — ' + esc(range.label) + '</h2><div style="color:#777;margin-bottom:14px">' + rows.length + ' new account' + (rows.length === 1 ? '' : 's') + (d.prev && d.prev.n ? ' (' + d.prev.n + ' the period before)' : '') + ' · <a href="https://nova.axiomprint.com/reports-ai?tab=clients">open in NovaAI</a></div>' +
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px;font-size:13px"><tr>' +
      [['New clients', rows.length], ['Signed up on the website', web + ' · ' + pct(web, rows.length)], ['Created by the team', team], ['Already ordered', ordered + ' · ' + pct(ordered, rows.length)], ['Revenue from them so far', money(rev)], ['Referrals', refs.length]].map(x => '<td style="padding:8px 14px 8px 0"><div style="font-size:11px;color:#777;text-transform:uppercase">' + x[0] + '</div><div style="font-size:20px;font-weight:700">' + x[1] + '</div></td>').join('') + '</tr></table>' +
      '<h3 style="margin:0 0 6px;font-size:14px">Who created the accounts</h3>' + tbl(th('#') + th('Team member') + th('Accounts', 1) + th('Ordered', 1), mk.map((a, i) => '<tr>' + td(i + 1) + td((a.photo ? '<img src="' + esc(a.photo) + '" width="24" height="24" style="border-radius:12px;vertical-align:middle;margin-right:6px">' : '') + esc(a.name)) + td('<b>' + a.n + '</b>', 1) + td(rows.filter(r => r.made.id === a.id && r.orders).length, 1) + '</tr>').join('') + '<tr>' + td('') + td('Website sign-ups') + td('<b>' + web + '</b>', 1) + td(rows.filter(r => r.web && r.orders).length, 1) + '</tr>') +
      '<h3 style="margin:0 0 6px;font-size:14px">Where they came from</h3>' + tbl(th('Source') + th('Clients', 1), count(r => r.source.kind).map(x => '<tr>' + td(esc(x[0])) + td('<b>' + x[1] + '</b>', 1) + '</tr>').join('')) +
      '<h3 style="margin:0 0 6px;font-size:14px">Account managers — new clients given to</h3>' + tbl(th('Account manager') + th('New clients', 1) + th('Ordered', 1), count(r => r.am ? r.am.name : 'Nobody').map(x => '<tr>' + td(esc(x[0])) + td('<b>' + x[1] + '</b>', 1) + td(rows.filter(r => (r.am ? r.am.name : 'Nobody') === x[0] && r.orders).length, 1) + '</tr>').join('')) +
      (rb.length ? '<h3 style="margin:0 0 6px;font-size:14px">Referrals — who sent them</h3>' + tbl(th('Referred by') + th('Kind') + th('Clients', 1), rb.map(x => '<tr>' + td(esc(x.who)) + td(x.kind === 'client' ? 'Client' : x.kind === 'team' ? 'Axiom team' : 'Referral') + td('<b>' + x.n + '</b>', 1) + '</tr>').join('')) : '') +
      '<h3 style="margin:0 0 6px;font-size:14px">Every new client</h3>' + tbl(th('Date') + th('Client') + th('Made by') + th('Source') + th('AM') + th('Orders', 1),
        rows.map(r => '<tr>' + td(usD(r.date)) + td('<b>' + esc(r.company || r.person || ('Customer #' + r.id)) + '</b>' + (r.company && r.person ? '<br><span style="color:#777">' + esc(r.person) + '</span>' : '')) + td(esc(r.made.name)) + td(esc(r.source.kind) + (r.referral ? '<br><span style="color:#777">' + (r.referral.kind === 'team' ? 'team: ' : 'from ') + esc(r.referral.who) + '</span>' : r.source.who ? '<br><span style="color:#777">' + esc(r.source.who) + '</span>' : '')) + td(esc(r.am ? r.am.name : '—')) + td(r.orders ? r.orders.n + ' · ' + money(r.orders.rev) : '—', 1) + '</tr>').join('')) + '</div>';
  }
  // Send a report for `today` (LA day). who = 'clock' | the admin's id. Returns what went out.
  async function sendReport(report, who, opts) {
    report = MAIL[report] ? report : 'onboarding'; const kind = MAIL[report].kind;
    const st = await emailSettings(report); const today = (opts && opts.today) || laDay(); const range = spanRange((opts && opts.span) || st.span, today);
    if (Notify && !Notify.on(kind)) return { sent: false, error: 'This report\'s email is switched off under Admin → Emails.' };
    const to = (Notify ? Notify.to(kind, st.to) : st.to) || st.to, cc = String(st.cc || '').split(/[,;]\s*/).map(x => x.trim()).filter(Boolean);
    const log = (k, addr, c, n) => dbRun('INSERT INTO ra_sent (report, period_key, kind, to_addr, cc, n, at, by) VALUES (?,?,?,?,?,?,?,?)', [report, range.key, k, addr, c || '', n, new Date().toISOString(), who]);
    const out = { sent: true, period: range.label, from: range.from, to: range.to, n: 0, owner: null, ams: [] };
    if (report === 'clients') {
      const d = await clientsReport(range.from, range.to); out.n = d.rows.length;
      const subj = 'New clients — ' + range.label + ' (' + d.rows.length + ')', html = clientsHtml(d, range), text = d.rows.length + ' new clients in ' + range.label + '.';
      await sendMail({ to, cc: cc.join(', ') || undefined, subject: subj, html, text }); await log('owner', to, cc.join(', '), d.rows.length); out.owner = { to, cc };
      if (st.all_ams && !(opts && opts.owner_only)) {
        const seen = [to].concat(cc).map(x => x.toLowerCase());
        for (const a of await amTeam()) { if (seen.indexOf(a.email.toLowerCase()) > -1) continue; try { await sendMail({ to: a.email, subject: subj, html, text }); out.ams.push({ name: a.name, to: a.email, n: d.rows.length }); await log('am', a.email, '', d.rows.length); } catch (e) { out.ams.push({ name: a.name, to: a.email, error: e.message }); } }
      }
      return out;
    }
    const rows = await onboardingRows(range.from, range.to); out.n = rows.length;
    const by = {}; rows.forEach(r => { const k = String(r.am.id); if (!by[k]) by[k] = Object.assign({ n: 0 }, r.am); by[k].n++; });
    const ams = Object.values(by).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const subj = 'Client onboardings — ' + range.label + ' (' + rows.length + ')';
    await sendMail({ to, cc: cc.join(', ') || undefined, subject: subj, html: ownerHtml(rows, range, ams), text: rows.length + ' onboardings in ' + range.label + '. ' + ams.map(a => a.name + ': ' + a.n).join(', ') });
    await log('owner', to, cc.join(', '), rows.length); out.owner = { to, cc };
    if (st.per_am && !(opts && opts.owner_only)) {
      for (let i = 0; i < ams.length; i++) {
        const a = ams[i]; if (!a.email || !a.id) continue;
        const mine = rows.filter(r => String(r.am.id) === String(a.id));
        try { await sendMail({ to: a.email, subject: 'Your client onboardings — ' + range.label + ' (' + mine.length + ')', html: amHtml(a, mine, i + 1, ams.length, range), text: 'You onboarded ' + mine.length + ' clients in ' + range.label + '.' }); out.ams.push({ name: a.name, to: a.email, n: mine.length }); await log('am', a.email, '', mine.length); }
        catch (e) { out.ams.push({ name: a.name, to: a.email, error: e.message }); }
      }
    }
    return out;
  }
  const sendOnboardingReport = (who, opts) => sendReport('onboarding', who, opts);
  // the clock: once a minute — on each report's configured day of the month at its LA time, once per period
  if (String(process.env.REPORTS_CLOCK || '1') !== '0') {
    setInterval(async () => {
      for (const report of Object.keys(MAIL)) {
        try {
          const st = emailSettingsSync(report); if (!st.enabled) continue;
          const o = laParts(), today = o.year + '-' + o.month + '-' + o.day, hm = o.hour + ':' + o.minute;
          const dueDay = st.span === 'week' ? (new Date(today + 'T12:00:00Z').getUTCDay() === 1) : (+o.day === (+st.day || 1));
          if (!dueDay || hm !== (st.at || '07:00')) continue;
          const range = spanRange(st.span, today);
          if (await dbGet("SELECT id FROM ra_sent WHERE report = ? AND kind = 'owner' AND period_key = ?", [report, range.key])) continue;
          const r = await sendReport(report, 'clock'); console.log('REPORTS ' + report + ' email ' + (r.sent ? 'sent for ' + r.period + ' (' + r.n + ')' : 'not sent: ' + r.error));
        } catch (e) { console.error('REPORTS clock ' + report + ': ' + e.message); }
      }
    }, 60000).unref();
  }
  const reportOf = (req) => MAIL[req.params.report] ? req.params.report : null;
  app.get('/api/reports-ai/:report/email', auth, adminOnly, async (req, res) => {
    try { const report = reportOf(req); if (!report) return res.json({ ok: false, error: 'no such report' }); const st = await emailSettings(report); const sent = await new Promise((r2) => db.all('SELECT * FROM ra_sent WHERE report = ? ORDER BY id DESC LIMIT 12', [report], (e, rows) => r2(rows || []))); const next = spanRange(st.span, laDay()); res.json({ ok: true, settings: st, sent, preview: next.label, notify_on: Notify ? Notify.on(MAIL[report].kind) : true, ams: report === 'clients' ? await amTeam() : undefined }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/reports-ai/:report/email', auth, adminOnly, async (req, res) => {
    try {
      const report = reportOf(req); if (!report) return res.json({ ok: false, error: 'no such report' });
      const b = req.body || {}, cur = await emailSettings(report);
      const mail = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
      const to = String(b.to == null ? cur.to : b.to).trim(); if (!mail.test(to)) return res.json({ ok: false, error: 'Send to: one email address.' });
      const cc = String(b.cc == null ? cur.cc : b.cc).split(/[,;]\s*/).map(x => x.trim()).filter(Boolean); if (cc.some(x => !mail.test(x))) return res.json({ ok: false, error: 'CC: email addresses separated by commas.' });
      const next = { enabled: b.enabled == null ? !!cur.enabled : !!b.enabled, span: ['month', '30', 'week'].indexOf(b.span) > -1 ? b.span : cur.span, day: Math.min(28, Math.max(1, parseInt(b.day) || cur.day || 1)), at: /^\d{2}:\d{2}$/.test(b.at || '') ? b.at : cur.at, to, cc: cc.join(', ') };
      if (report === 'clients') next.all_ams = b.all_ams == null ? !!cur.all_ams : !!b.all_ams; else next.per_am = b.per_am == null ? !!cur.per_am : !!b.per_am;
      await dbRun('INSERT INTO ra_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at', [report + '_email', JSON.stringify(next), (req.user && (req.user.key || req.user.username)) || 'admin', new Date().toISOString()]);
      emailCaches[report] = Object.assign({}, MAIL[report].defaults, next);
      res.json({ ok: true, settings: emailCaches[report] });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Send now — the report for the configured span as of today (a test, or a missed month); owner_only=1 skips the AMs' mails
  app.post('/api/reports-ai/:report/email/send', auth, adminOnly, async (req, res) => {
    try { const report = reportOf(req); if (!report) return res.json({ ok: false, error: 'no such report' }); res.json(Object.assign({ ok: true }, await sendReport(report, (req.user && (req.user.key || req.user.username)) || 'admin', { owner_only: !!(req.body && req.body.owner_only), span: req.body && req.body.span }))); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
};
