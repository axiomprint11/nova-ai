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
  if (Notify) Notify.register('ra.onboarding', () => (emailSettingsSync().to || 'gary@axiomprint.com'));
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
  app.get('/api/reports-ai/products', auth, adminOnly, async (req, res) => {
    try {
      const today = ymd(new Date()); const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
      const to = ok(req.query.to) ? req.query.to : today, from = ok(req.query.from) ? req.query.from : new Date(new Date(to + 'T12:00:00Z').getTime() - 29 * 864e5).toISOString().slice(0, 10);
      if (from > to) return res.json({ ok: false, error: 'from is after to' });
      const t0 = Date.now(); const out = await productReport(from, to); out.ms = Date.now() - t0; out.ok = true; res.json(out);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---------------------------------------------------------------- the monthly email (1.20.97)
  // Settings (SQLite ra_settings key 'onboarding_email'): enabled, span ('month' = the previous calendar month, '30' = the last 30
  // days, 'week' = the previous Mon–Sun week), day (day of month to send, 1), at ('07:00' LA), to (the owner), cc (comma list),
  // per_am (each AM who onboarded gets their own list). The owner's mail: the leaderboard, the sources, every onboarding; an AM's mail:
  // their count, rank and their own list. Every send is logged in ra_sent; the clock sends once per period key.
  const EMAIL_DEFAULTS = { enabled: true, span: 'month', day: 1, at: '07:00', to: 'gary@axiomprint.com', cc: 'luciana@axiomprint.com', per_am: true };
  let emailCache = null;
  async function emailSettings() { const r = await dbGet("SELECT value FROM ra_settings WHERE key = 'onboarding_email'").catch(() => null); let v = {}; try { v = r && r.value ? JSON.parse(r.value) : {}; } catch (e) {} emailCache = Object.assign({}, EMAIL_DEFAULTS, v); return emailCache; }
  function emailSettingsSync() { return emailCache || EMAIL_DEFAULTS; }
  emailSettings().catch(() => {});
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
  // Send the report for `today` (LA day). who = 'clock' | the admin's id. Returns what went out.
  async function sendOnboardingReport(who, opts) {
    const st = await emailSettings(); const today = (opts && opts.today) || laDay(); const range = spanRange((opts && opts.span) || st.span, today);
    if (Notify && !Notify.on('ra.onboarding')) return { sent: false, error: 'The "Onboarding Report" email is switched off under Admin → Emails.' };
    const rows = await onboardingRows(range.from, range.to);
    const by = {}; rows.forEach(r => { const k = String(r.am.id); if (!by[k]) by[k] = Object.assign({ n: 0 }, r.am); by[k].n++; });
    const ams = Object.values(by).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const to = (Notify ? Notify.to('ra.onboarding', st.to) : st.to) || st.to, cc = String(st.cc || '').split(/[,;]\s*/).map(x => x.trim()).filter(Boolean);
    const out = { sent: true, period: range.label, from: range.from, to: range.to, n: rows.length, owner: null, ams: [] };
    const subj = 'Client onboardings — ' + range.label + ' (' + rows.length + ')';
    await sendMail({ to, cc: cc.join(', ') || undefined, subject: subj, html: ownerHtml(rows, range, ams), text: rows.length + ' onboardings in ' + range.label + '. ' + ams.map(a => a.name + ': ' + a.n).join(', ') });
    await dbRun('INSERT INTO ra_sent (report, period_key, kind, to_addr, cc, n, at, by) VALUES (?,?,?,?,?,?,?,?)', ['onboarding', range.key, 'owner', to, cc.join(', '), rows.length, new Date().toISOString(), who]);
    out.owner = { to, cc };
    if (st.per_am && !(opts && opts.owner_only)) {
      for (let i = 0; i < ams.length; i++) {
        const a = ams[i]; if (!a.email || !a.id) continue;
        const mine = rows.filter(r => String(r.am.id) === String(a.id));
        try { await sendMail({ to: a.email, subject: 'Your client onboardings — ' + range.label + ' (' + mine.length + ')', html: amHtml(a, mine, i + 1, ams.length, range), text: 'You onboarded ' + mine.length + ' clients in ' + range.label + '.' }); out.ams.push({ name: a.name, to: a.email, n: mine.length }); await dbRun('INSERT INTO ra_sent (report, period_key, kind, to_addr, cc, n, at, by) VALUES (?,?,?,?,?,?,?,?)', ['onboarding', range.key, 'am', a.email, '', mine.length, new Date().toISOString(), who]); }
        catch (e) { out.ams.push({ name: a.name, to: a.email, error: e.message }); }
      }
    }
    return out;
  }
  // the clock: once a minute — on the configured day of the month at the configured LA time, once per period
  if (String(process.env.REPORTS_CLOCK || '1') !== '0') {
    setInterval(async () => {
      try {
        const st = emailSettingsSync(); if (!st.enabled) return;
        const o = laParts(), today = o.year + '-' + o.month + '-' + o.day, hm = o.hour + ':' + o.minute;
        const dueDay = st.span === 'week' ? (new Date(today + 'T12:00:00Z').getUTCDay() === 1) : (+o.day === (+st.day || 1));
        if (!dueDay || hm !== (st.at || '07:00')) return;
        const range = spanRange(st.span, today);
        if (await dbGet("SELECT id FROM ra_sent WHERE report = 'onboarding' AND kind = 'owner' AND period_key = ?", [range.key])) return;
        const r = await sendOnboardingReport('clock'); console.log('REPORTS onboarding email ' + (r.sent ? 'sent for ' + r.period + ' (' + r.n + ')' : 'not sent: ' + r.error));
      } catch (e) { console.error('REPORTS clock: ' + e.message); }
    }, 60000).unref();
  }
  app.get('/api/reports-ai/onboarding/email', auth, adminOnly, async (req, res) => {
    try { const st = await emailSettings(); const sent = await new Promise((r2) => db.all("SELECT * FROM ra_sent WHERE report = 'onboarding' ORDER BY id DESC LIMIT 12", [], (e, rows) => r2(rows || []))); const next = spanRange(st.span, laDay()); res.json({ ok: true, settings: st, sent, preview: next.label, notify_on: Notify ? Notify.on('ra.onboarding') : true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/reports-ai/onboarding/email', auth, adminOnly, async (req, res) => {
    try {
      const b = req.body || {}, cur = await emailSettings();
      const mail = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
      const to = String(b.to == null ? cur.to : b.to).trim(); if (!mail.test(to)) return res.json({ ok: false, error: 'Send to: one email address.' });
      const cc = String(b.cc == null ? cur.cc : b.cc).split(/[,;]\s*/).map(x => x.trim()).filter(Boolean); if (cc.some(x => !mail.test(x))) return res.json({ ok: false, error: 'CC: email addresses separated by commas.' });
      const next = { enabled: b.enabled == null ? !!cur.enabled : !!b.enabled, span: ['month', '30', 'week'].indexOf(b.span) > -1 ? b.span : cur.span, day: Math.min(28, Math.max(1, parseInt(b.day) || cur.day || 1)), at: /^\d{2}:\d{2}$/.test(b.at || '') ? b.at : cur.at, to, cc: cc.join(', '), per_am: b.per_am == null ? !!cur.per_am : !!b.per_am };
      await dbRun("INSERT INTO ra_settings (key, value, updated_by, updated_at) VALUES ('onboarding_email', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", [JSON.stringify(next), (req.user && (req.user.key || req.user.username)) || 'admin', new Date().toISOString()]);
      emailCache = Object.assign({}, EMAIL_DEFAULTS, next);
      res.json({ ok: true, settings: emailCache });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Send now — the owner's report for the configured span as of today (a test, or a missed month); owner_only=1 skips the AMs' mails
  app.post('/api/reports-ai/onboarding/email/send', auth, adminOnly, async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await sendOnboardingReport((req.user && (req.user.key || req.user.username)) || 'admin', { owner_only: !!(req.body && req.body.owner_only), span: req.body && req.body.span }))); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
};
