// Dashboard (1.20.174) — NovaAI's home page: the invoices billed in a period, by the billed date (LA days), as the CRM's
// Dashboard chart draws them — Total Value next to Partially paid / Paid / Unpaid stacked, Bad debt and Estimates beside —
// filtered by account manager, by the client's order number (New = their 1st order · 2–5 · 5+ = 6th and up, `invoice.order_n`)
// and by Online (`invoice.create_by_order` = 1, ordered on the website) vs Manual (entered by the team).
// READ-ONLY on the CRM. Dates are stored in UTC; every day here is a Los Angeles day (Oct 16 = $81,239.76, as the CRM shows).
// Admins see every AM (and can pick one); a member sees only the invoices where they are the AM.
'use strict';

module.exports = function mountDashboard(app, deps) {
  const { db, auth, serveVersionedHtml, runQuery } = deps;
  const dbGet = (sql, p) => new Promise((res) => db.get(sql, p || [], (e, r) => res(e ? null : r)));
  const errlog = (w, m) => console.error('[dashboard] ' + w + ': ' + m);
  const staffPhoto = (ph) => !ph ? null : /^https?:\/\//.test(ph) ? ph : 'https://axiomprint.s3.us-west-1.amazonaws.com/MemberImages/' + String(ph).replace(/^\/+/, '');
  const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
  /* CRM-safe email literal (letters, digits and . _ % + - @ only) */
  const sqlEmail = (e) => "'" + String(e).replace(/[^a-z0-9._%+\-@]/gi, '') + "'";

  // ---- Los Angeles days
  const laOffset = (ymd) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', timeZoneName: 'shortOffset' }).formatToParts(new Date(ymd + 'T12:00:00Z')).find(x => x.type === 'timeZoneName'); const m = /GMT([+-]\d+)/.exec(f ? f.value : ''); return m ? parseInt(m[1]) : -7; };
  const laBound = (ymd, end) => new Date(new Date(ymd + 'T00:00:00Z').getTime() - laOffset(ymd) * 3600e3 + (end ? 864e5 : 0)).toISOString().slice(0, 19).replace('T', ' ');
  const laDay = (utcStr) => new Date(String(utcStr).replace(' ', 'T') + 'Z').toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const addDays = (ymd, n) => new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) + 1;
  const mondayOf = (ymd) => { const d = new Date(ymd + 'T12:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; return addDays(ymd, -wd); };
  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  // Day / Week / Month on its own: up to a month → days, up to six months → weeks, longer → months
  const autoGroup = (days) => days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';
  function buckets(from, to, group) {
    const out = []; let k = group === 'week' ? mondayOf(from) : group === 'month' ? from.slice(0, 7) + '-01' : from;
    for (let guard = 0; guard < 800; guard++) {
      let next = group === 'day' ? addDays(k, 1) : group === 'week' ? addDays(k, 7) : (() => { const d = new Date(k + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
      out.push({ key: k, from: k < from ? from : k, to: addDays(next, -1) > to ? to : addDays(next, -1) });
      if (next > to) break; k = next;
    }
    return out;
  }
  const keyOf = (day, group) => group === 'day' ? day : group === 'week' ? mondayOf(day) : day.slice(0, 7) + '-01';

  // ---- invoice has no index on its date: find the first id of a day by binary search on the PRIMARY key (cached)
  const floorCache = new Map();
  async function idFloor(utc) {
    const day = utc.slice(0, 10), hit = floorCache.get(day);
    if (hit && Date.now() - hit.at < 3600e3) return hit.id;
    const [b] = await runQuery('SELECT MIN(id) lo, MAX(id) hi FROM invoice');
    let lo = Number(b && b.lo) || 0, hi = Number(b && b.hi) || 0;
    if (!hi) return 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const [r] = await runQuery('SELECT DATE_FORMAT(invoice_creation_date, \'%Y-%m-%d %H:%i:%s\') d FROM invoice WHERE id >= ' + mid + ' ORDER BY id LIMIT 1');
      if (!r || !r.d || String(r.d) < day) lo = mid + 1; else hi = mid;
    }
    const id = Math.max(0, lo - 3000);   /* a little slack: ids are not perfectly in date order */
    floorCache.set(day, { at: Date.now(), id });
    return id;
  }

  // ---- the raw invoices of a range (cached a minute — every filter after this is done in memory)
  const rangeCache = new Map();
  async function load(from, to) {
    const b1 = laBound(from), b2 = laBound(to, true), key = b1 + '|' + b2;
    const hit = rangeCache.get(key); if (hit && Date.now() - hit.at < 60e3) return hit.rows;
    const floor = await idFloor(b1);
    const rows = await runQuery('SELECT i.id, DATE_FORMAT(i.invoice_creation_date, \'%Y-%m-%d %H:%i:%s\') at, i.invoice_total_payment total, i.invoice_total_payment_done done, i.payment_status st, i.invoice_type type, ' +
      'i.invoice_managerid am, i.create_by_order online, i.order_n, i.invoice_clientid cid, i.invoice_projectid pid, c.company_name company, c.name cname, c.last_name clast ' +
      'FROM invoice i LEFT JOIN customer c ON c.id = i.invoice_clientid WHERE i.id >= ' + floor + ' AND i.invoice_creation_date >= \'' + b1 + '\' AND i.invoice_creation_date < \'' + b2 + '\' AND i.payment_status <> \'void\' ORDER BY i.id DESC LIMIT 80000');
    const out = rows.map(r => ({ id: r.id, at: r.at, day: laDay(r.at), total: num(r.total), done: num(r.done), st: r.st, type: r.type, am: Number(r.am) || 0, online: Number(r.online) === 1, order_n: r.order_n == null ? null : Number(r.order_n), cid: r.cid, pid: r.pid, client: (r.company || [r.cname, r.clast].filter(Boolean).join(' ') || '').trim(), person: [r.cname, r.clast].filter(Boolean).join(' ').trim() }));
    rangeCache.set(key, { at: Date.now(), rows: out });
    if (rangeCache.size > 40) rangeCache.delete(rangeCache.keys().next().value);
    return out;
  }

  // order-number band: New = the client's 1st order, 2–5, 5+ = the 6th and up
  const band = (n) => n == null || n <= 1 ? 'new' : n <= 5 ? 'mid' : 'loyal';

  // ---- one set of figures
  const blank = () => ({ total: 0, paid: 0, partial: 0, partial_done: 0, unpaid: 0, due: 0, bad_debt: 0, estimates: 0, n: 0, n_paid: 0, n_partial: 0, n_unpaid: 0, n_bad: 0, n_est: 0, online: 0, n_online: 0, new_clients: 0 });
  function add(f, r) {
    if (r.type === 'bad_debt') { f.bad_debt += r.total; f.n_bad++; return; }
    if (r.type === 'estimate') { f.estimates += r.total; f.n_est++; return; }
    f.total += r.total; f.n++;
    if (r.online) { f.online += r.total; f.n_online++; }
    if (band(r.order_n) === 'new') f.new_clients++;
    if (r.st === 'paid') { f.paid += r.total; f.n_paid++; }
    else if (r.st === 'partial') { f.partial += r.total; f.partial_done += r.done; f.due += Math.max(0, r.total - r.done); f.n_partial++; }
    else { f.unpaid += r.total; f.due += r.total; f.n_unpaid++; }
  }
  const round = (f) => { Object.keys(f).forEach(k => { if (typeof f[k] === 'number') f[k] = num(f[k]); }); f.avg = f.n ? num(f.total / f.n) : 0; return f; };

  // who is asking: admins see everyone; a member only their own invoices (they are the AM)
  async function scopeOf(req) {
    const key = String(req.user && req.user.key || '');
    const email = key.replace(/^member:/, '').toLowerCase();
    let admin = !!(req.user && req.user.is_admin);
    let m = null;
    if (key.indexOf('member:') === 0) { m = await dbGet('SELECT is_admin, axiom_user_id FROM members WHERE lower(email) = ?', [email]); if (m && m.is_admin) admin = true; }
    let crmId = m && m.axiom_user_id ? Number(m.axiom_user_id) : 0;
    if (!crmId && email.indexOf('@') > 0) { try { const [u] = await runQuery('SELECT id FROM user WHERE email = ' + sqlEmail(email) + ' LIMIT 1'); crmId = u ? Number(u.id) : 0; } catch (e) {} }
    return { admin, crmId };
  }

  const amCache = { at: 0, map: {} };
  async function amInfo(ids) {
    const need = ids.filter(id => id > 0 && !(amCache.map[id] && Date.now() - amCache.at < 600e3));
    if (need.length) {
      try { (await runQuery('SELECT id, name, last_name, memberimage FROM user WHERE id IN (' + need.map(Number).join(',') + ')')).forEach(u => { amCache.map[u.id] = { id: u.id, name: [u.name, u.last_name].filter(Boolean).join(' ').trim() || ('User #' + u.id), first: u.name || '', photo: staffPhoto(u.memberimage) }; }); amCache.at = Date.now(); }
      catch (e) { errlog('ams', e.message); }
    }
    const out = {}; ids.forEach(id => { out[id] = amCache.map[id] || { id, name: id ? 'User #' + id : 'No AM', first: '', photo: null }; }); return out;
  }

  app.get('/dashboard', serveVersionedHtml('dashboard.html'));

  app.get('/api/dashboard', auth, async (req, res) => {
    try {
      const q = req.query || {};
      const today = todayLA();
      let from = isYmd(q.from) ? q.from : addDays(today, -7), to = isYmd(q.to) ? q.to : today;
      if (from > to) { const t = from; from = to; to = t; }
      if (daysBetween(from, to) > 800) from = addDays(to, -799);
      const days = daysBetween(from, to);
      const auto = autoGroup(days), group = ['day', 'week', 'month'].indexOf(q.group) > -1 ? q.group : auto;
      /* the period it is compared with: the same number of days just before, or (1.20.175) the same dates last year */
      const ly = q.compare === 'ly';
      const backYear = (ymd) => { const y = Number(ymd.slice(0, 4)) - 1, md = ymd.slice(5); return y + '-' + (md === '02-29' ? '02-28' : md); };
      const pFrom = ly ? backYear(from) : addDays(from, -days), pTo = ly ? backYear(to) : addDays(from, -1);

      const scope = await scopeOf(req);
      let am = q.am && q.am !== 'all' ? parseInt(q.am) || 0 : 0;
      if (!scope.admin) { if (!scope.crmId) return res.json({ ok: true, empty: true, reason: 'Your Nova account is not linked to an Axiom CRM user, so there are no invoices to show as your own.', scope: { admin: false } }); am = scope.crmId; }
      const orders = ['new', 'mid', 'loyal'].indexOf(q.orders) > -1 ? q.orders : 'all';
      const online = q.online === 'online' || q.online === 'manual' ? q.online : 'all';

      const [cur, prev] = await Promise.all([load(from, to), load(pFrom, pTo)]);
      const passAm = (r) => !am || r.am === am, passOrd = (r) => orders === 'all' || band(r.order_n) === orders, passOn = (r) => online === 'all' || (online === 'online' ? r.online : !r.online);
      const base = scope.admin ? (r) => true : (r) => r.am === scope.crmId;

      // facets: each one counts with every OTHER filter on, so the chips say what a click would show
      const facet = (rows, keep, keyFn) => { const m = {}; rows.forEach(r => { if (!keep(r) || r.type !== 'invoice') return; const k = keyFn(r); const f = m[k] || (m[k] = { n: 0, total: 0 }); f.n++; f.total += r.total; }); Object.keys(m).forEach(k => { m[k].total = num(m[k].total); }); return m; };
      const amF = scope.admin ? facet(cur, r => passOrd(r) && passOn(r), r => r.am) : {};
      /* 1.20.175: a snapshot per AM for the hover card — the full figures with the order / online filters on, and the compared period */
      const amFull = {}, amPrev = {};
      if (scope.admin) {
        cur.forEach(r => { if (passOrd(r) && passOn(r)) add(amFull[r.am] || (amFull[r.am] = blank()), r); });
        prev.forEach(r => { if (passOrd(r) && passOn(r)) add(amPrev[r.am] || (amPrev[r.am] = blank()), r); });
      }
      /* 1.20.181: each order-number card carries the full figures (invoices, estimates, bad debt, paid / partial / unpaid) for its hover */
      const ordFull = () => { const o = { all: blank(), new: blank(), mid: blank(), loyal: blank() };
        cur.forEach(r => { if (!(base(r) && passAm(r) && passOn(r))) return; add(o.all, r); const k = band(r.order_n); if (o[k]) add(o[k], r); });
        Object.keys(o).forEach(k => round(o[k])); return o; };
      const onF = facet(cur, r => base(r) && passAm(r) && passOrd(r), r => r.online ? 'online' : 'manual');
      const sum = (m) => Object.values(m).reduce((a, f) => ({ n: a.n + f.n, total: num(a.total + f.total) }), { n: 0, total: 0 });

      const keep = (r) => base(r) && passAm(r) && passOrd(r) && passOn(r);
      const rows = cur.filter(keep), prows = prev.filter(keep);
      const tiles = round(rows.reduce((f, r) => { add(f, r); return f; }, blank()));
      const ptiles = round(prows.reduce((f, r) => { add(f, r); return f; }, blank()));
      tiles.clients = new Set(rows.filter(r => r.type === 'invoice').map(r => r.cid)).size;
      ptiles.clients = new Set(prows.filter(r => r.type === 'invoice').map(r => r.cid)).size;

      const bs = buckets(from, to, group), byKey = {}; bs.forEach(b => { b.f = blank(); byKey[b.key] = b; });
      rows.forEach(r => { const b = byKey[keyOf(r.day, group)]; if (b) add(b.f, r); });
      const series = bs.map(b => Object.assign({ key: b.key, from: b.from, to: b.to }, round(b.f)));

      const amIds = Object.keys(amF).map(Number).concat(rows.map(r => r.am)).concat(am ? [am] : []);
      const info = await amInfo(Array.from(new Set(amIds)));
      const ams = Object.keys(amF).map(Number).map(id => { const f = round(amFull[id] || blank()), p = amPrev[id] ? round(amPrev[id]) : blank();
        return Object.assign({}, info[id], amF[id], { paid: f.paid, partial: f.partial, unpaid: f.unpaid, due: f.due, avg: f.avg, new_clients: f.new_clients, online: f.online, n_online: f.n_online, prev_total: num(p.total), prev_n: p.n }); }).sort((a, b) => b.total - a.total);
      /* last year's (or the period before's) figures bucket by bucket, lined up with this period's buckets by position */
      const pbs = buckets(pFrom, pTo, group), pByKey = {}; pbs.forEach(b => { b.f = blank(); pByKey[b.key] = b; });
      prows.forEach(r => { const b = pByKey[keyOf(r.day, group)]; if (b) add(b.f, r); });
      const prev_series = pbs.slice(0, series.length).map(b => ({ key: b.key, from: b.from, to: b.to, total: num(b.f.total), n: b.f.n, paid: num(b.f.paid), unpaid: num(b.f.unpaid), partial: num(b.f.partial) }));

      const list = rows.filter(r => r.type === 'invoice' || r.type === 'bad_debt' || r.type === 'estimate').slice(0, 3000).map(r => ({ id: r.id, at: r.at, day: r.day, client: r.client, person: r.person, cid: r.cid, pid: r.pid, am: r.am, order_n: r.order_n, band: band(r.order_n), online: r.online, type: r.type, st: r.st, total: r.total, done: r.done }));
      res.json({ ok: true, scope: { admin: scope.admin, am_locked: !scope.admin, me: scope.crmId ? info[scope.crmId] || null : null },
        range: { from, to, days, group, auto_group: auto, today }, prev: { from: pFrom, to: pTo, kind: ly ? 'ly' : 'before' }, prev_series,
        filters: { am, orders, online },
        ams, am_all: sum(amF), orders_f: ordFull(),
        online_f: { all: sum(onF), online: onF.online || { n: 0, total: 0 }, manual: onF.manual || { n: 0, total: 0 } },
        tiles, prev_tiles: ptiles, series, rows: list, row_count: rows.length, am_info: info });
    } catch (e) { errlog('data', e.message); res.json({ ok: false, error: 'CRM not reachable: ' + e.message }); }
  });

  return { autoGroup, buckets, laBound, laDay, band };
};
