/**
 * reports.js — Nova's reports: read-only queries over the production database
 * that come back as one table shape the front end (public/nova-report.js)
 * knows how to draw, filter, sort and export.
 *
 *   const reports = require('./reports')({ openConn });
 *   reports.list()                         -> [{ id, title, description }]
 *   await reports.run(id, params)          -> result (see shape below)
 *
 * Every query is parameterised and SELECT-only. Tables without an index on
 * their date column (calls, email_from_system, invoice) are narrowed to an id
 * range first — see idFloor() — so a "last 3 months" filter never scans the
 * whole table.
 *
 * Result shape:
 *   { id, title, subtitle, params, controls[], range, summary[], columns[],
 *     filters[], rows[], sort, email_key, method, notes[], truncated, generated_at }
 */
'use strict';

module.exports = function makeReports(deps) {
  const openConn = deps.openConn;

  // ---------------------------------------------------------------- dates (UTC)
  const pad = n => String(n).padStart(2, '0');
  const parse = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  const iso = d => d.toISOString().slice(0, 10);
  const us = d => pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + '-' + d.getUTCFullYear();
  const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
  function addMonths(d, n) {                      // clamps to month end: 03-31 − 1 month = 02-28
    const day = d.getUTCDate();
    const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
    r.setUTCDate(Math.min(day, last));
    return r;
  }
  function todayLA() {
    return parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  }
  const sqlDate = d => iso(d) + ' 00:00:00';     // start of that day

  // Named periods, shared by the revenue reports.
  const PERIODS = [
    { v: 'this_month', l: 'This month' }, { v: 'last_month', l: 'Last month' },
    { v: 'last_3_months', l: 'Last 3 months' }, { v: 'ytd', l: 'Year to date' },
    { v: 'last_12_months', l: 'Last 12 months' }, { v: 'custom', l: 'Custom' }
  ];
  function periodRange(p) {
    const today = todayLA();
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    const end = addDays(today, 1);                                   // exclusive
    switch (p.period) {
      case 'this_month': return { from: new Date(Date.UTC(y, m, 1)), to: end };
      case 'last_month': return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
      case 'last_3_months': return { from: addMonths(today, -3), to: end };
      case 'ytd': return { from: new Date(Date.UTC(y, 0, 1)), to: end };
      case 'custom': {
        const f = parse(p.from) || addMonths(today, -1), t = parse(p.to) || today;
        return f <= t ? { from: f, to: addDays(t, 1) } : { from: t, to: addDays(f, 1) };
      }
      default: return { from: addMonths(today, -12), to: end };      // last_12_months
    }
  }
  const rangeLabel = r => us(r.from) + ' to ' + us(addDays(r.to, -1));
  const periodControl = p => ([
    { key: 'period', label: 'Period', type: 'pills', value: p.period, options: PERIODS },
    { key: 'from', label: 'From', type: 'date', value: p.from || '', show_if: { period: 'custom' } },
    { key: 'to', label: 'To', type: 'date', value: p.to || '', show_if: { period: 'custom' } }
  ]);

  // ---------------------------------------------------------------- helpers
  const int = (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : d; };
  const money = v => Math.round((Number(v) || 0) * 100) / 100;
  const fullName = (a, b) => [a, b].map(x => String(x || '').trim()).filter(Boolean).join(' ');
  const inList = ids => (ids.length ? ids : [0]);                    // IN () is invalid SQL

  // First id whose date column is on/after `date`, found by binary search on the
  // primary key — ~25 instant lookups instead of a full scan of an unindexed
  // date. Ids and dates rise together in these log tables; a margin covers rows
  // written slightly out of order, and every query still filters on the date.
  const floorCache = new Map();
  async function idFloor(conn, table, col, date) {
    const key = table + '|' + col + '|' + date;
    const hit = floorCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.id;
    const [[b]] = await conn.query('SELECT MIN(id) AS lo, MAX(id) AS hi FROM ' + table);
    let lo = Number(b.lo) || 0, hi = Number(b.hi) || 0;
    if (!hi) return 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const [[r]] = await conn.query('SELECT ' + col + ' AS d FROM ' + table + ' WHERE id >= ? ORDER BY id LIMIT 1', [mid]);
      if (!r || r.d == null || new Date(r.d) < new Date(date)) lo = mid + 1; else hi = mid;
    }
    const id = Math.max(0, lo - 5000);
    floorCache.set(key, { at: Date.now(), id });
    return id;
  }

  async function managers(conn, ids) {
    const uniq = [...new Set(ids.filter(x => x > 0))];
    if (!uniq.length) return {};
    const [rows] = await conn.query('SELECT id, name, last_name FROM user WHERE id IN (?)', [uniq]);
    const out = {};
    rows.forEach(u => { out[u.id] = fullName(u.name, u.last_name) || ('User #' + u.id); });
    return out;
  }

  async function customers(conn, ids) {
    if (!ids.length) return {};
    const [rows] = await conn.query(
      'SELECT id, name, last_name, email, phone, company_name, manager_id, verification_score ' +
      'FROM customer WHERE id IN (?)', [ids]);
    const out = {};
    rows.forEach(c => { out[c.id] = c; });
    return out;
  }

  // ================================================================ reports
  const REPORTS = {};

  // ---------------------------------------------------------------- client follow-up
  // Clients whose LAST order fell in a window: "no orders since N months", and
  // how far back from that mark. The people due a check-in.
  const ENG = { weights: { call_in: 1.5, email_in: 1, call_out: 0.5, email_out: 0.25 },
                points_for_10: 12, high_touch: 15, reprice_below: 300 };
  REPORTS.client_followup = {
    title: 'Client Follow-up',
    description: 'Clients whose last order fell in a chosen window — who is due a check-in. Includes manager, score, and 3-month call/email engagement with high-touch flags.',
    params: 'months (3 | 6 | any number: "no orders since" this many months), window ("1w" | "2w" | "1m" | "3m", or window_n + window_unit d/w/m), as_of (YYYY-MM-DD, default today), manager (name, optional)',
    normalize(p) {
      const months = p.months === 'custom' ? Math.max(1, int(p.months_n, 9)) : Math.max(1, int(p.months, 3));
      const presetM = [3, 6].indexOf(months) > -1;
      let win = String(p.window || '1w');
      if (['1w', '2w', '1m', '3m', 'custom'].indexOf(win) < 0) win = '1w';
      return {
        months: presetM && p.months !== 'custom' ? months : 'custom',
        months_n: months,
        window: win,
        window_n: Math.max(1, int(p.window_n, 10)),
        window_unit: ['d', 'w', 'm'].indexOf(p.window_unit) > -1 ? p.window_unit : 'd',
        as_of: parse(p.as_of) ? iso(parse(p.as_of)) : iso(todayLA()),
        manager: p.manager ? String(p.manager) : ''
      };
    },
    async run(conn, p) {
      const asOf = parse(p.as_of);
      const to = addMonths(asOf, -p.months_n);
      const from = p.window === '1w' ? addDays(to, -7) : p.window === '2w' ? addDays(to, -14)
        : p.window === '1m' ? addMonths(to, -1) : p.window === '3m' ? addMonths(to, -3)
        : p.window_unit === 'd' ? addDays(to, -p.window_n) : p.window_unit === 'w' ? addDays(to, -7 * p.window_n)
        : addMonths(to, -p.window_n);
      const toEx = addDays(to, 1);
      const winLabel = { '1w': '1 week', '2w': '2 weeks', '1m': '1 month', '3m': '3 months' }[p.window] ||
        (p.window_n + ' ' + { d: 'day', w: 'week', m: 'month' }[p.window_unit] + (p.window_n === 1 ? '' : 's'));

      // 1. Each client's last order (latest non-void invoice), kept when it lands in the window.
      const [lastRows] = await conn.query(
        'SELECT invoice_clientid AS cid, MAX(invoice_creation_date) AS last_at FROM invoice ' +
        "WHERE invoice_type = 'invoice' AND payment_status <> 'void' AND invoice_clientid > 0 " +
        'GROUP BY invoice_clientid HAVING last_at >= ? AND last_at < ? ORDER BY last_at DESC LIMIT 2000',
        [sqlDate(from), sqlDate(toEx)]);
      const cids = lastRows.map(r => r.cid);
      const cust = await customers(conn, cids);

      // 2. That last invoice, and its first line item for the product and E-number.
      const lastInv = {};
      if (cids.length) {
        const [inv] = await conn.query(
          'SELECT id, invoice_clientid AS cid, invoice_creation_date AS at, invoice_total_payment AS total FROM invoice ' +
          "WHERE invoice_clientid IN (?) AND invoice_type = 'invoice' AND payment_status <> 'void' " +
          'AND invoice_creation_date >= ? AND invoice_creation_date < ?', [cids, sqlDate(from), sqlDate(toEx)]);
        inv.forEach(r => {
          const cur = lastInv[r.cid];
          if (!cur || new Date(r.at) > new Date(cur.at) || (+new Date(r.at) === +new Date(cur.at) && r.id > cur.id)) lastInv[r.cid] = r;
        });
      }
      const invIds = Object.values(lastInv).map(r => r.id);
      const firstLine = {};
      if (invIds.length) {
        const [lines] = await conn.query(
          'SELECT ie.id, ie.invoice_id, ie.invoice_estimateid AS eid, p.title AS product FROM invoiceestimate ie ' +
          'LEFT JOIN product p ON p.id = ie.invoice_estproductid WHERE ie.invoice_id IN (?) ORDER BY ie.id', [invIds]);
        lines.forEach(l => { if (!firstLine[l.invoice_id]) firstLine[l.invoice_id] = l; });
      }

      // 3. Engagement: always the 3 months before the as-of date.
      const engFrom = addMonths(asOf, -3), engTo = addDays(asOf, 1);
      const touch = {};
      cids.forEach(id => { touch[id] = { call_in: 0, call_out: 0, email_in: 0, email_out: 0 }; });
      if (cids.length) {
        const callFloor = await idFloor(conn, 'calls', 'created_at', sqlDate(engFrom));
        const [calls] = await conn.query(
          'SELECT direction, from_customer_id AS f, to_customer_id AS t, COUNT(*) AS n FROM calls ' +
          'WHERE id >= ? AND created_at >= ? AND created_at < ? AND is_internal = 0 ' +
          'AND (from_customer_id IN (?) OR to_customer_id IN (?)) GROUP BY direction, from_customer_id, to_customer_id',
          [callFloor, sqlDate(engFrom), sqlDate(engTo), cids, cids]);
        calls.forEach(c => {
          if (c.direction === 'inbound' && touch[c.f]) touch[c.f].call_in += Number(c.n);
          if (c.direction === 'outbound' && touch[c.t]) touch[c.t].call_out += Number(c.n);
        });
        const byEmail = {};
        cids.forEach(id => { const e = String((cust[id] || {}).email || '').trim().toLowerCase(); if (e) byEmail[e] = id; });
        const emails = Object.keys(byEmail);
        if (emails.length) {
          const mailFloor = await idFloor(conn, 'email_from_system', 'created_at', sqlDate(engFrom));
          const [mails] = await conn.query(
            'SELECT LOWER(TRIM(to_email)) AS e, COUNT(*) AS n FROM email_from_system ' +
            'WHERE id >= ? AND created_at >= ? AND created_at < ? AND LOWER(TRIM(to_email)) IN (?) GROUP BY e',
            [mailFloor, sqlDate(engFrom), sqlDate(engTo), emails]);
          mails.forEach(m => { const id = byEmail[m.e]; if (id) touch[id].email_out += Number(m.n); });
        }
      }
      const mgr = await managers(conn, cids.map(id => (cust[id] || {}).manager_id));

      let rows = lastRows.map(r => {
        const c = cust[r.cid] || {};
        const inv = lastInv[r.cid] || {};
        const line = firstLine[inv.id] || {};
        const t = touch[r.cid];
        const W = ENG.weights;
        const pts = t.call_in * W.call_in + t.email_in * W.email_in + t.call_out * W.call_out + t.email_out * W.email_out;
        const inbound = t.call_in + t.email_in;
        const high = inbound >= ENG.high_touch;
        const total = inv.total == null ? null : money(inv.total);
        const eng = Math.min(10, Math.round(pts / ENG.points_for_10 * 10));
        const score = c.verification_score == null ? null : Number(c.verification_score);
        return {
          client_id: r.cid,
          name: fullName(c.name, c.last_name) || c.company_name || ('Client #' + r.cid),
          email: c.email || '', company: c.company_name || '', phone: c.phone || '',
          score: score,
          score_band: score == null ? 'na' : score >= 7 ? 'hi' : score >= 4 ? 'mid' : 'lo',
          manager: mgr[c.manager_id] || '',
          engagement: { score: eng, calls: t.call_in + t.call_out, emails: t.email_in + t.email_out, touches: t, high: high,
                        action: high ? ((total || 0) < ENG.reprice_below ? 'Reprice' : 'Train') : null },
          eng_sort: eng + (high ? 0.5 : 0),
          eng_tags: [eng >= 6 ? 'active' : eng >= 1 ? 'low' : 'none'].concat(high ? ['high'] : []),
          last_order: iso(new Date(r.last_at)),
          product: line.product || '',
          enumber: line.eid ? 'E' + line.eid : '',
          total: total
        };
      });
      if (p.manager) rows = rows.filter(r => r.manager.toLowerCase().indexOf(p.manager.toLowerCase()) > -1);

      return {
        subtitle: 'Clients whose last order landed in the window — the people due a check-in',
        range: { from: iso(from), to: iso(to),
                 html: 'Last order between <strong>' + us(from) + '</strong> and <strong>' + us(to) + '</strong>',
                 note: p.months_n + ' month' + (p.months_n === 1 ? '' : 's') + ' back, ' + winLabel + ' window' },
        controls: [
          { key: 'months', label: 'No orders since', type: 'pills', value: p.months,
            options: [{ v: 3, l: '3 months' }, { v: 6, l: '6 months' }, { v: 'custom', l: 'Custom' }],
            custom: { key: 'months_n', value: p.months_n, min: 1, max: 60, suffix: 'months' } },
          { key: 'window', label: 'Window', type: 'pills', value: p.window,
            options: [{ v: '1w', l: '1 week' }, { v: '2w', l: '2 weeks' }, { v: '1m', l: '1 month' }, { v: '3m', l: '3 months' }, { v: 'custom', l: 'Custom' }],
            custom: { key: 'window_n', value: p.window_n, min: 1, max: 365,
                      unit: { key: 'window_unit', value: p.window_unit, options: [{ v: 'd', l: 'days' }, { v: 'w', l: 'weeks' }, { v: 'm', l: 'months' }] } } },
          { key: 'as_of', label: 'As of', type: 'date', value: p.as_of, place: 'range' }
        ],
        summary: [
          { label: 'Clients to follow up', value: rows.length, fmt: 'int', tone: 'indigo' },
          { label: 'Last-order value', value: rows.reduce((s, r) => s + (r.total || 0), 0), fmt: 'money', tone: 'green' },
          { label: 'Score 7 and up', value: rows.filter(r => r.score >= 7).length, fmt: 'int', tone: 'amber' },
          { label: 'Reachable by phone', value: rows.filter(r => r.phone).length, fmt: 'int', tone: 'purple' },
          { label: 'High touch', value: rows.filter(r => r.engagement.high).length, fmt: 'int', tone: 'red' }
        ],
        columns: [
          { key: 'name', label: 'Customer', type: 'client', sort: true, compact: true },
          { key: 'company', label: 'Company', type: 'text', sort: true },
          { key: 'phone', label: 'Phone', type: 'text' },
          { key: 'score', label: 'Score', type: 'score', sort: true },
          { key: 'manager', label: 'Manager', type: 'text', sort: true },
          { key: 'eng_sort', label: 'Engagement (3 mo)', type: 'engagement', sort: true },
          { key: 'last_order', label: 'Last order', type: 'date_ago', sort: true, compact: true },
          { key: 'product', label: 'Last product', type: 'text', sort: true, empty: 'No product on the invoice' },
          { key: 'enumber', label: 'E-number', type: 'text' },
          { key: 'total', label: 'Invoice total', type: 'money', sort: true, compact: true }
        ],
        filters: [
          { key: 'score', label: 'All scores', field: 'score_band',
            options: [{ v: 'hi', l: 'Score 7–10' }, { v: 'mid', l: 'Score 4–6' }, { v: 'lo', l: 'Score 1–3' }, { v: 'na', l: 'No score' }] },
          { key: 'eng', label: 'All engagement', field: 'eng_tags',
            options: [{ v: 'active', l: 'Engaged (6–10)' }, { v: 'low', l: 'Low (1–5)' }, { v: 'none', l: 'No contact (0)' }, { v: 'high', l: 'High touch' }] },
          { key: 'manager', label: 'All managers', field: 'manager', from_rows: true }
        ],
        sort: { key: 'last_order', dir: 'desc' },
        email_key: 'email',
        search_keys: ['name', 'company', 'email', 'product', 'enumber'],
        as_of: p.as_of,
        method: 'Last order is the client’s latest invoice that is not void. Engagement always looks at the 3 months ' +
          'before the as-of date (' + us(engFrom) + ' to ' + us(asOf) + '), whatever window is selected. Contact the client ' +
          'started counts more than contact we started: inbound call 1.5, inbound email 1, outbound call 0.5, outbound ' +
          'email 0.25; 12 points = 10. High touch is ' + ENG.high_touch + '+ inbound calls and emails in those 3 months: ' +
          'Reprice when the last invoice was under $' + ENG.reprice_below + ', otherwise Train. Score is the CRM’s client score.',
        notes: ['Inbound emails are not counted yet — they live in Gmail, not the database. Outbound emails are the CRM’s ' +
                'system emails (invoices, proofs), matched on the client’s email address.'],
        truncated: lastRows.length >= 2000,
        rows: rows
      };
    }
  };

  // ---------------------------------------------------------------- top clients
  REPORTS.top_clients = {
    title: 'Top Clients',
    description: 'Clients ranked by paid revenue for a period, with order count, average order, share of revenue and last order.',
    params: 'period (this_month | last_month | last_3_months | ytd | last_12_months | custom with from/to YYYY-MM-DD), limit (default 100), manager (optional)',
    normalize(p) {
      const period = PERIODS.some(x => x.v === p.period) ? p.period : 'last_12_months';
      return { period, from: p.from || '', to: p.to || '', limit: Math.min(500, Math.max(10, int(p.limit, 100))),
               manager: p.manager ? String(p.manager) : '' };
    },
    async run(conn, p) {
      const r = periodRange(p);
      const floor = await idFloor(conn, 'invoice', 'invoice_creation_date', sqlDate(r.from));
      const where = "WHERE id >= ? AND invoice_type = 'invoice' AND payment_status = 'paid' AND invoice_clientid > 0 " +
                    'AND invoice_creation_date >= ? AND invoice_creation_date < ?';
      const args = [floor, sqlDate(r.from), sqlDate(r.to)];
      const [[tot]] = await conn.query('SELECT COUNT(DISTINCT invoice_clientid) AS clients, COUNT(*) AS orders, ' +
        'COALESCE(SUM(invoice_total_payment),0) AS revenue FROM invoice ' + where, args);
      const [top] = await conn.query('SELECT invoice_clientid AS cid, COUNT(*) AS orders, SUM(invoice_total_payment) AS revenue, ' +
        'MAX(invoice_creation_date) AS last_at FROM invoice ' + where + ' GROUP BY invoice_clientid ORDER BY revenue DESC LIMIT ?',
        args.concat([p.limit]));
      const cust = await customers(conn, top.map(x => x.cid));
      const mgr = await managers(conn, Object.values(cust).map(c => c.manager_id));
      const all = Number(tot.revenue) || 0;
      let rows = top.map((x, i) => {
        const c = cust[x.cid] || {};
        return {
          rank: i + 1, client_id: x.cid,
          name: fullName(c.name, c.last_name) || c.company_name || ('Client #' + x.cid),
          email: c.email || '', company: c.company_name || '', phone: c.phone || '',
          manager: mgr[c.manager_id] || '',
          orders: Number(x.orders), revenue: money(x.revenue),
          avg: money(Number(x.revenue) / Math.max(1, Number(x.orders))),
          share: all ? Math.round(Number(x.revenue) / all * 1000) / 10 : 0,
          last_order: iso(new Date(x.last_at))
        };
      });
      if (p.manager) rows = rows.filter(x => x.manager.toLowerCase().indexOf(p.manager.toLowerCase()) > -1);
      const shown = rows.reduce((s, x) => s + x.revenue, 0);
      return {
        subtitle: 'Who brought in the most paid revenue',
        range: { from: iso(r.from), to: iso(addDays(r.to, -1)), html: 'Paid invoices from <strong>' + us(r.from) +
                 '</strong> to <strong>' + us(addDays(r.to, -1)) + '</strong>', note: 'top ' + p.limit + ' clients' },
        controls: periodControl(p).concat([{ key: 'limit', label: 'Show', type: 'pills', value: p.limit,
          options: [{ v: 25, l: 'Top 25' }, { v: 100, l: 'Top 100' }, { v: 250, l: 'Top 250' }] }]),
        summary: [
          { label: 'Paid revenue', value: all, fmt: 'money', tone: 'green' },
          { label: 'Clients who paid', value: Number(tot.clients), fmt: 'int', tone: 'indigo' },
          { label: 'Paid orders', value: Number(tot.orders), fmt: 'int', tone: 'purple' },
          { label: 'Share from this list', value: all ? Math.round(shown / all * 1000) / 10 : 0, fmt: 'pct', tone: 'amber' }
        ],
        columns: [
          { key: 'rank', label: '#', type: 'int', sort: true },
          { key: 'name', label: 'Customer', type: 'client', sort: true, compact: true },
          { key: 'company', label: 'Company', type: 'text', sort: true },
          { key: 'manager', label: 'Manager', type: 'text', sort: true },
          { key: 'orders', label: 'Orders', type: 'int', sort: true, align: 'right' },
          { key: 'avg', label: 'Avg order', type: 'money', sort: true },
          { key: 'share', label: 'Share', type: 'bar_pct', sort: true },
          { key: 'last_order', label: 'Last paid order', type: 'date_ago', sort: true },
          { key: 'revenue', label: 'Revenue', type: 'money', sort: true, compact: true }
        ],
        filters: [{ key: 'manager', label: 'All managers', field: 'manager', from_rows: true }],
        sort: { key: 'revenue', dir: 'desc' },
        email_key: 'email',
        search_keys: ['name', 'company', 'email', 'manager'],
        method: 'Revenue is the total of paid invoices (invoice type “invoice”, status paid) created in the period, ' +
          'grouped by client. Share is each client’s part of all paid revenue in the period.',
        notes: [],
        truncated: false,
        rows: rows
      };
    }
  };

  // ---------------------------------------------------------------- unpaid invoices
  REPORTS.unpaid_invoices = {
    title: 'Unpaid Invoices',
    description: 'Open balances on unpaid and partly paid invoices, aged from the due date (or the invoice date when there is none).',
    params: 'status (all | unpaid | partial), since_months (only invoices created in the last N months, default 12), min_age (days overdue, default 0), manager (optional)',
    normalize(p) {
      return { status: ['all', 'unpaid', 'partial'].indexOf(p.status) > -1 ? p.status : 'all',
               since_months: [3, 6, 12, 24].indexOf(int(p.since_months, 12)) > -1 ? int(p.since_months, 12) : 12,
               min_age: [0, 30, 60, 90].indexOf(int(p.min_age, 0)) > -1 ? int(p.min_age, 0) : 0,
               manager: p.manager ? String(p.manager) : '' };
    },
    async run(conn, p) {
      const today = todayLA();
      const since = addMonths(today, -p.since_months);
      const statuses = p.status === 'all' ? ['unpaid', 'partial'] : [p.status];
      const [inv] = await conn.query(
        'SELECT id, invoice_clientid AS cid, invoice_managerid AS mid, invoice_creation_date AS created, payment_due_date AS due, ' +
        'invoice_total_payment AS total, invoice_total_payment_done AS paid, payment_status AS status FROM invoice ' +
        "WHERE invoice_type = 'invoice' AND payment_status IN (?) AND invoice_creation_date >= ? ORDER BY id DESC LIMIT 3000",
        [statuses, sqlDate(since)]);
      const cust = await customers(conn, [...new Set(inv.map(x => x.cid).filter(Boolean))]);
      const mgr = await managers(conn, inv.map(x => x.mid).concat(Object.values(cust).map(c => c.manager_id)));
      const bucket = d => d <= 0 ? 'current' : d <= 30 ? '1_30' : d <= 60 ? '31_60' : d <= 90 ? '61_90' : '90_plus';
      let rows = inv.map(x => {
        const c = cust[x.cid] || {};
        const from = x.due ? new Date(x.due) : new Date(x.created);
        const age = Math.floor((today - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / 864e5);
        const balance = money((Number(x.total) || 0) - (Number(x.paid) || 0));
        return {
          invoice: 'INV' + x.id, client_id: x.cid,
          name: fullName(c.name, c.last_name) || c.company_name || (x.cid ? 'Client #' + x.cid : 'No client'),
          email: c.email || '', company: c.company_name || '', phone: c.phone || '',
          manager: mgr[x.mid] || mgr[c.manager_id] || '',
          created: iso(new Date(x.created)), due: x.due ? iso(new Date(x.due)) : '',
          age: age, age_band: bucket(age), status: x.status,
          total: money(x.total), paid: money(x.paid), balance: balance
        };
      }).filter(x => x.balance > 0.009 && x.age >= p.min_age);
      if (p.manager) rows = rows.filter(x => x.manager.toLowerCase().indexOf(p.manager.toLowerCase()) > -1);
      const sum = (f) => rows.filter(f).reduce((s, x) => s + x.balance, 0);
      return {
        subtitle: 'Money still owed on invoices, oldest risk first',
        range: { html: 'Invoices created since <strong>' + us(since) + '</strong>', note: 'aged from the due date' },
        controls: [
          { key: 'status', label: 'Status', type: 'pills', value: p.status,
            options: [{ v: 'all', l: 'Unpaid + partial' }, { v: 'unpaid', l: 'Unpaid' }, { v: 'partial', l: 'Partly paid' }] },
          { key: 'min_age', label: 'Overdue by', type: 'pills', value: p.min_age,
            options: [{ v: 0, l: 'Any' }, { v: 30, l: '30+ days' }, { v: 60, l: '60+ days' }, { v: 90, l: '90+ days' }] },
          { key: 'since_months', label: 'Created in the last', type: 'pills', value: p.since_months,
            options: [{ v: 3, l: '3 months' }, { v: 6, l: '6 months' }, { v: 12, l: '12 months' }, { v: 24, l: '24 months' }] }
        ],
        summary: [
          { label: 'Open balance', value: sum(() => true), fmt: 'money', tone: 'indigo' },
          { label: 'Invoices', value: rows.length, fmt: 'int', tone: 'purple' },
          { label: 'Over 30 days', value: sum(x => x.age > 30), fmt: 'money', tone: 'amber' },
          { label: 'Over 90 days', value: sum(x => x.age > 90), fmt: 'money', tone: 'red' }
        ],
        columns: [
          { key: 'invoice', label: 'Invoice', type: 'text', sort: true },
          { key: 'name', label: 'Customer', type: 'client', sort: true, compact: true },
          { key: 'company', label: 'Company', type: 'text', sort: true },
          { key: 'manager', label: 'Manager', type: 'text', sort: true },
          { key: 'created', label: 'Invoiced', type: 'date', sort: true },
          { key: 'age', label: 'Overdue', type: 'age', sort: true, compact: true },
          { key: 'status', label: 'Status', type: 'status', sort: true },
          { key: 'total', label: 'Total', type: 'money', sort: true },
          { key: 'balance', label: 'Balance', type: 'money', sort: true, compact: true }
        ],
        filters: [
          { key: 'age', label: 'All ages', field: 'age_band',
            options: [{ v: 'current', l: 'Not yet due' }, { v: '1_30', l: '1–30 days' }, { v: '31_60', l: '31–60 days' },
                      { v: '61_90', l: '61–90 days' }, { v: '90_plus', l: '90+ days' }] },
          { key: 'manager', label: 'All managers', field: 'manager', from_rows: true }
        ],
        sort: { key: 'age', dir: 'desc' },
        email_key: 'email',
        search_keys: ['invoice', 'name', 'company', 'email', 'manager'],
        method: 'Unpaid and partly paid invoices (type “invoice”). Balance is the invoice total minus what has been paid. ' +
          'Overdue counts days past the due date, or past the invoice date when no due date is set.',
        notes: [],
        truncated: inv.length >= 3000,
        rows: rows
      };
    }
  };

  // ---------------------------------------------------------------- product sales
  REPORTS.product_sales = {
    title: 'Product Sales',
    description: 'Products ranked by paid revenue for a period, with orders, line items and units sold.',
    params: 'period (this_month | last_month | last_3_months | ytd | last_12_months | custom with from/to), limit (default 100)',
    normalize(p) {
      const period = PERIODS.some(x => x.v === p.period) ? p.period : 'last_3_months';
      return { period, from: p.from || '', to: p.to || '', limit: Math.min(500, Math.max(10, int(p.limit, 100))) };
    },
    async run(conn, p) {
      const r = periodRange(p);
      const floor = await idFloor(conn, 'invoice', 'invoice_creation_date', sqlDate(r.from));
      const [lines] = await conn.query(
        'SELECT ie.invoice_id, ie.invoice_estimateid AS eid, ie.invoice_estproductid AS pid, ie.invoice_estprice AS price ' +
        'FROM invoice i JOIN invoiceestimate ie ON ie.invoice_id = i.id ' +
        "WHERE i.id >= ? AND i.invoice_type = 'invoice' AND i.payment_status = 'paid' " +
        'AND i.invoice_creation_date >= ? AND i.invoice_creation_date < ? LIMIT 200000',
        [floor, sqlDate(r.from), sqlDate(r.to)]);
      // Units: the Quantity option of each line's estimate, fetched in chunks by the indexed estimate_id.
      const qty = {};
      const eids = [...new Set(lines.map(l => l.eid).filter(Boolean))];
      for (let i = 0; i < eids.length; i += 5000) {
        const [q] = await conn.query(
          "SELECT estimate_id, MAX(CAST(estimate_option_value AS DECIMAL(14,2))) AS q FROM estimateoption " +
          "WHERE estimate_id IN (?) AND estimate_option_name = 'Quantity' GROUP BY estimate_id", [eids.slice(i, i + 5000)]);
        q.forEach(x => { qty[x.estimate_id] = Number(x.q) || 0; });
      }
      const agg = {};
      lines.forEach(l => {
        const a = agg[l.pid] || (agg[l.pid] = { pid: l.pid, inv: new Set(), lines: 0, revenue: 0, units: 0 });
        a.inv.add(l.invoice_id); a.lines++; a.revenue += Number(l.price) || 0; a.units += qty[l.eid] || 0;
      });
      const total = Object.values(agg).reduce((s, a) => s + a.revenue, 0);
      const top = Object.values(agg).sort((a, b) => b.revenue - a.revenue).slice(0, p.limit);
      const pids = top.map(a => a.pid).filter(Boolean);
      const names = {};
      if (pids.length) {
        const [prods] = await conn.query('SELECT id, title FROM product WHERE id IN (?)', [pids]);
        prods.forEach(x => { names[x.id] = x.title; });
      }
      const rows = top.map((a, i) => ({
        rank: i + 1, product_id: a.pid, product: names[a.pid] || (a.pid ? 'Product #' + a.pid : 'No product'),
        orders: a.inv.size, lines: a.lines, units: Math.round(a.units), revenue: money(a.revenue),
        avg: money(a.revenue / Math.max(1, a.inv.size)),
        share: total ? Math.round(a.revenue / total * 1000) / 10 : 0
      }));
      return {
        subtitle: 'What sold, by paid revenue',
        range: { from: iso(r.from), to: iso(addDays(r.to, -1)), html: 'Paid invoices from <strong>' + us(r.from) +
                 '</strong> to <strong>' + us(addDays(r.to, -1)) + '</strong>', note: 'top ' + p.limit + ' products' },
        controls: periodControl(p).concat([{ key: 'limit', label: 'Show', type: 'pills', value: p.limit,
          options: [{ v: 25, l: 'Top 25' }, { v: 100, l: 'Top 100' }, { v: 250, l: 'Top 250' }] }]),
        summary: [
          { label: 'Paid product revenue', value: total, fmt: 'money', tone: 'green' },
          { label: 'Products sold', value: Object.keys(agg).length, fmt: 'int', tone: 'indigo' },
          { label: 'Line items', value: lines.length, fmt: 'int', tone: 'purple' },
          { label: 'Top product share', value: rows[0] ? rows[0].share : 0, fmt: 'pct', tone: 'amber' }
        ],
        columns: [
          { key: 'rank', label: '#', type: 'int', sort: true },
          { key: 'product', label: 'Product', type: 'text_strong', sort: true, compact: true },
          { key: 'orders', label: 'Orders', type: 'int', sort: true, align: 'right', compact: true },
          { key: 'lines', label: 'Line items', type: 'int', sort: true, align: 'right' },
          { key: 'units', label: 'Units', type: 'int', sort: true, align: 'right' },
          { key: 'avg', label: 'Avg per order', type: 'money', sort: true },
          { key: 'share', label: 'Share', type: 'bar_pct', sort: true },
          { key: 'revenue', label: 'Revenue', type: 'money', sort: true, compact: true }
        ],
        filters: [],
        sort: { key: 'revenue', dir: 'desc' },
        search_keys: ['product'],
        method: 'Line items on paid invoices created in the period, grouped by product. Revenue is the line price; ' +
          'units are each line’s Quantity option. Covers every product sold through the CRM.',
        notes: [],
        truncated: lines.length >= 200000,
        rows: rows
      };
    }
  };

  // ================================================================ public
  function list() {
    return Object.keys(REPORTS).map(id => ({ id, title: REPORTS[id].title, description: REPORTS[id].description, params: REPORTS[id].params }));
  }

  async function run(id, rawParams) {
    const def = REPORTS[id];
    if (!def) throw new Error('Unknown report "' + id + '". Available: ' + Object.keys(REPORTS).join(', '));
    const params = def.normalize(rawParams || {});
    const conn = await openConn();
    const started = Date.now();
    try {
      const out = await def.run(conn, params);
      return Object.assign({ id, title: def.title, params, generated_at: new Date().toISOString(),
                             ms: Date.now() - started }, out);
    } finally {
      try { await conn.end(); } catch (e) {}
    }
  }

  // Compact text for the model: the headline numbers and the first few rows.
  function digest(res, n) {
    const fmt = (s) => s.fmt === 'money' ? '$' + Number(s.value).toLocaleString('en-US', { maximumFractionDigits: 0 })
      : s.fmt === 'pct' ? s.value + '%' : Number(s.value).toLocaleString('en-US');
    const cols = res.columns.filter(c => c.compact || c.key === 'manager').map(c => c.key);
    return {
      report: res.title,
      range: (res.range && res.range.html || '').replace(/<[^>]+>/g, '') + (res.range && res.range.note ? ' (' + res.range.note + ')' : ''),
      summary: res.summary.map(s => s.label + ': ' + fmt(s)),
      row_count: res.rows.length,
      first_rows: res.rows.slice(0, n || 8).map(r => {
        const o = {};
        cols.forEach(k => { o[k] = typeof r[k] === 'object' && r[k] ? r[k].score : r[k]; });
        return o;
      }),
      notes: res.notes
    };
  }

  return { list, run, digest, REPORTS, _test: { addMonths, parse, iso, idFloor } };
};
