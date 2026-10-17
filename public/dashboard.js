/* Dashboard (1.20.174) — NovaAI's home page. GET /api/dashboard draws: AM heads, period presets, Day / Week / Month (auto by the
   length of the period), the client's order number as four cards (All · New · 2–5 · 5+), Online vs Manual, By Inv. ($) / By Qty.
   (count), tiles against the period before, the CRM-style chart (Total Value next to Partially paid / Paid / Unpaid stacked, Bad
   debt + Estimates beside it) and the invoice list. A click on a bar narrows the list to that day / week / month. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd2 = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd0 = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const usdK = (n) => { n = Number(n) || 0; return n >= 1e6 ? '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : '$' + Math.round(n); };
  const int = (n) => (Number(n) || 0).toLocaleString('en-US');
  const token = () => { try { return localStorage.getItem('axiom_token') || ''; } catch (e) { return ''; } };

  // ---- the dates (Los Angeles)
  const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const addDays = (ymd, n) => new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5) + 1;
  const mondayOf = (ymd) => { const d = new Date(ymd + 'T12:00:00Z'); return addDays(ymd, -((d.getUTCDay() + 6) % 7)); };
  const md = (ymd, o) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', month: 'short', day: 'numeric' }, o || {}));
  const us = (ymd) => ymd.slice(5, 7) + '/' + ymd.slice(8, 10) + '/' + ymd.slice(0, 4);
  const PRESETS = [
    ['last7', 'Last 7 days', (t) => [addDays(t, -7), t]],
    ['lastweek', 'Last week', (t) => { const m = addDays(mondayOf(t), -7); return [m, addDays(m, 6)]; }],
    ['month', 'This month', (t) => [t.slice(0, 8) + '01', t]],
    ['prevmonth', 'Previous month', (t) => { const f = new Date(t.slice(0, 8) + '01T12:00:00Z'); f.setUTCMonth(f.getUTCMonth() - 1); const a = f.toISOString().slice(0, 10); return [a, addDays(t.slice(0, 8) + '01', -1)]; }],
    ['ytd', 'YTD', (t) => [t.slice(0, 4) + '-01-01', t]],
    ['lastyear', 'Last year', (t) => { const y = Number(t.slice(0, 4)) - 1; return [y + '-01-01', y + '-12-31']; }],
    ['custom', 'Custom', null]
  ];
  const autoGroup = (days) => days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';

  // ---- state (kept per browser)
  const DEF = { period: 'last7', from: '', to: '', group: 'auto', am: 'all', orders: 'all', online: 'all', by: 'inv' };
  let S = Object.assign({}, DEF);
  try { Object.assign(S, JSON.parse(localStorage.getItem('nova_dash_v1') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('nova_dash_v1', JSON.stringify(S)); } catch (e) {} };
  function range() {
    const t = todayLA(); const p = PRESETS.find(x => x[0] === S.period);
    if (S.period === 'custom' && S.from && S.to) return S.from <= S.to ? [S.from, S.to] : [S.to, S.from];
    return (p && p[2] ? p[2] : PRESETS[0][2])(t);
  }
  let D = null, sel = null, LF = { status: '', client: '' }, seq = 0;

  // ---- icons
  const IC = {
    all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.7-3 3.1-4.8 6-4.8s5.3 1.8 6 4.8"/><path d="M16 5a3 3 0 0 1 0 6M17.5 14.6c1.8.6 3 2.2 3.5 4.4"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>'
  };
  const face = (p, cls) => p && p.photo ? '<img class="face ' + (cls || '') + '" src="' + esc(p.photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;face ' + (cls || '') + '&quot;>' + esc(((p.first || p.name || '?')[0] || '?').toUpperCase()) + '</span>\'">' : '<span class="face ' + (cls || '') + '">' + esc(((p && (p.first || p.name)) || '?')[0].toUpperCase()) + '</span>';

  // ---- colors (the CRM chart's, a touch calmer)
  const C = { total: '#38bdf8', partial: '#f59e0b', paid: '#2563eb', unpaid: '#e11d48', bad: '#a8a29e', est: '#bae6fd' };
  const BANDS = [['all', 'All orders', 'every client', '#4f46e5'], ['new', 'New', '1st order', '#16a34a'], ['mid', '2–5', '2nd to 5th order', '#4338ca'], ['loyal', '5+', '6th order and up', '#9333ea']];

  // ---- the data
  async function load() {
    const [from, to] = range(); const my = ++seq;
    const qs = new URLSearchParams({ from, to, group: S.group === 'auto' ? '' : S.group, am: S.am, orders: S.orders, online: S.online });
    $('dbChart').innerHTML = '<div class="db-skel"></div>';
    let j;
    try {
      const r = await fetch('/api/dashboard?' + qs, { headers: { Authorization: 'Bearer ' + token() } });
      if (r.status === 401) { location.href = '/'; return; }
      j = await r.json();
    } catch (e) { j = { ok: false, error: 'Nova did not answer (' + e.message + ')' }; }
    if (my !== seq) return;
    if (!j.ok) { $('dbErr').innerHTML = '<div class="db-err">' + esc(j.error || 'Could not load the dashboard') + ' <button class="seg" style="margin-left:8px;padding:4px 10px;border:0;cursor:pointer" onclick="location.reload()">Reload</button></div>'; $('dbChart').innerHTML = ''; return; }
    $('dbErr').innerHTML = '';
    if (j.empty) { D = null; $('dbErr').innerHTML = '<div class="db-err" style="background:#fffbeb;border-color:#fde68a;color:#92400e">' + esc(j.reason) + '</div>'; $('dbChart').innerHTML = ''; $('dbTiles').innerHTML = ''; $('dbList').innerHTML = ''; return; }
    D = j; sel = null; paint();
  }

  // ---- filters
  function paintFilters() {
    const [from, to] = range(), days = daysBetween(from, to), auto = autoGroup(days);
    $('dbPeriod').innerHTML = PRESETS.map(p => '<button data-p="' + p[0] + '" class="' + (S.period === p[0] ? 'on' : '') + '">' + p[1] + '</button>').join('') +
      (S.period === 'custom' ? '<span class="db-custom"><input type="date" id="dbFrom" value="' + esc(S.from || from) + '" max="' + todayLA() + '"> to <input type="date" id="dbTo" value="' + esc(S.to || to) + '" max="' + todayLA() + '"></span>' : '') +
      '<span class="db-range">' + us(from) + ' – ' + us(to) + ' · ' + days + ' day' + (days === 1 ? '' : 's') + '</span>';
    const g = S.group === 'auto' ? auto : S.group;
    $('dbGroup').innerHTML = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']].map(x => '<button data-g="' + x[0] + '" class="' + (g === x[0] ? 'on' : '') + '" title="' + (x[0] === auto ? 'Picked by itself for ' + days + ' days' : 'Click to group by ' + x[1].toLowerCase()) + '">' + x[1] + (x[0] === auto ? ' <span class="auto">AUTO</span>' : '') + '</button>').join('');
    const of = D && D.online_f, cnt = (k) => of ? ' <small>' + (S.by === 'qty' ? int(of[k].n) : usdK(of[k].total)) + '</small>' : '';
    $('dbOnline').innerHTML = '<button data-o="all" class="' + (S.online === 'all' ? 'on' : '') + '">All' + cnt('all') + '</button><button data-o="online" class="' + (S.online === 'online' ? 'on' : '') + '" title="Ordered on axiomprint.com">' + IC.web + 'Online' + cnt('online') + '</button><button data-o="manual" class="' + (S.online === 'manual' ? 'on' : '') + '" title="Entered by the team in the CRM">' + IC.hand + 'Manual' + cnt('manual') + '</button>';
    const ofs = D && D.orders_f, maxT = ofs ? Math.max(1, ofs.all[S.by === 'qty' ? 'n' : 'total']) : 1;
    $('dbOrders').innerHTML = BANDS.map(b => { const f = ofs ? ofs[b[0]] : null; const v = f ? (S.by === 'qty' ? f.n : f.total) : 0;
      return '<button class="db-oc' + (S.orders === b[0] ? ' on' : '') + '" data-ord="' + b[0] + '" style="--c:' + b[3] + '"><span class="t"><i></i>' + b[1] + '</span><span class="v">' + (f ? (S.by === 'qty' ? int(f.n) + ' <small style="font-size:11px;font-weight:600;color:var(--muted)">invoices</small>' : usd0(f.total)) : '—') + '</span><span class="s">' + b[2] + (f ? ' · ' + (S.by === 'qty' ? usd0(f.total) : int(f.n) + ' invoices') : '') + '</span>' + (f ? '<span class="bar" style="width:' + Math.round(100 * v / maxT) + '%"></span>' : '') + '</button>'; }).join('');
    // AMs
    if (D && D.scope && !D.scope.admin) {
      $('dbAmBox').querySelector('.db-lab').textContent = 'Your invoices';
      const me = D.scope.me || { name: 'You' };
      $('dbAms').innerHTML = '<div class="db-am on" style="cursor:default">' + face(me) + '<span><b>' + esc(me.name) + '</b><small>the invoices where you are the AM</small></span></div>';
    } else if (D) {
      const tot = D.am_all || { n: 0, total: 0 };
      $('dbAms').innerHTML = '<button class="db-am' + (S.am === 'all' ? ' on' : '') + '" data-am="all"><span class="face all">' + IC.all + '</span><span><b>All AMs</b><small>' + (S.by === 'qty' ? int(tot.n) + ' invoices' : usd0(tot.total)) + '</small></span></button>' +
        D.ams.map(a => '<button class="db-am' + (String(S.am) === String(a.id) ? ' on' : '') + '" data-am="' + a.id + '" title="' + esc(a.name + ' · ' + int(a.n) + ' invoices · ' + usd2(a.total)) + '">' + face(a) + '<span><b>' + esc(a.name) + '</b><small>' + (S.by === 'qty' ? int(a.n) + ' invoices' : usd0(a.total)) + '</small></span></button>').join('') +
        (S.am !== 'all' && !D.ams.some(a => String(a.id) === String(S.am)) ? '<button class="db-am on" data-am="' + esc(S.am) + '">' + face(D.am_info && D.am_info[S.am]) + '<span><b>' + esc((D.am_info && D.am_info[S.am] && D.am_info[S.am].name) || 'This AM') + '</b><small>nothing in this period</small></span></button>' : '');
    }
    document.querySelectorAll('#dbBy button').forEach(b => b.classList.toggle('on', b.dataset.by === S.by));
  }

  // ---- tiles
  function chg(cur, prev) {
    if (!prev && !cur) return '<span class="chg eq">—</span>';
    if (!prev) return '<span class="chg up">new</span>';
    const p = Math.round((cur - prev) / Math.abs(prev) * 100);
    return '<span class="chg ' + (p > 0 ? 'up' : p < 0 ? 'dn' : 'eq') + '">' + (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p) + '%</span>';
  }
  function paintTiles() {
    const t = D.tiles, p = D.prev_tiles, q = S.by === 'qty';
    const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
    const T = [
      ['Invoiced', C.total, q ? int(t.n) : usd2(t.total), q ? chg(t.n, p.n) : chg(t.total, p.total), (q ? usd0(t.total) : int(t.n) + ' invoices') + ' · avg ' + usd0(t.avg)],
      ['Paid', C.paid, q ? int(t.n_paid) : usd2(t.paid), q ? chg(t.n_paid, p.n_paid) : chg(t.paid, p.paid), pct(t.paid, t.total) + ' of the invoiced ' + (q ? '$' : 'value') + ' · ' + (q ? usd0(t.paid) : int(t.n_paid) + ' invoices')],
      ['Partially paid', C.partial, q ? int(t.n_partial) : usd2(t.partial), q ? chg(t.n_partial, p.n_partial) : chg(t.partial, p.partial), usd0(t.partial_done) + ' received · ' + usd0(Math.max(0, t.partial - t.partial_done)) + ' still due'],
      ['Unpaid', C.unpaid, q ? int(t.n_unpaid) : usd2(t.unpaid), q ? chg(t.n_unpaid, p.n_unpaid) : chg(t.unpaid, p.unpaid), 'still due in all: ' + usd0(t.due)],
      ['New clients', '#16a34a', int(t.new_clients), chg(t.new_clients, p.new_clients), 'first orders · ' + pct(t.new_clients, t.n) + ' of invoices'],
      ['Ordered online', '#0891b2', pct(q ? t.n_online : t.online, q ? t.n : t.total), chg(q ? t.n_online : t.online, q ? p.n_online : p.online), (q ? int(t.n_online) + ' invoices' : usd0(t.online)) + ' · the rest entered by the team'],
      ['Estimates · Bad debt', '#64748b', q ? int(t.n_est) : usd0(t.estimates), '', (q ? int(t.n_bad) + ' bad debt' : usd0(t.bad_debt) + ' bad debt') + ' · not in Invoiced']
    ];
    $('dbTiles').innerHTML = T.map(x => '<div class="db-tile" style="--c:' + x[1] + '"><div class="l">' + x[0] + (x[3] ? ' ' + x[3] : '') + '</div><div class="v">' + x[2] + '</div><div class="s">' + x[4] + '</div></div>').join('');
    $('dbTiles').title = 'Changes are against ' + us(D.prev.from) + ' – ' + us(D.prev.to) + ', the same number of days just before';
  }

  // ---- chart
  function nice(max) { if (max <= 0) return [1, 0.25]; const p = Math.pow(10, Math.floor(Math.log10(max))); const n = max / p; const top = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; return [top, top / 4]; }
  const bucketLabel = (b, g, long) => g === 'day' ? md(b.key, long ? { weekday: 'short', year: 'numeric' } : {}) : g === 'week' ? (long ? 'Week of ' + md(b.from) + ' – ' + md(b.to) : md(b.key)) : new Date(b.key + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: long ? 'long' : 'short', year: long || b.key.slice(5, 7) === '01' ? 'numeric' : undefined });
  function paintChart() {
    const q = S.by === 'qty', g = D.range.group, ser = D.series;
    const v = (b) => q ? { total: b.n, partial: b.n_partial, paid: b.n_paid, unpaid: b.n_unpaid, bad: b.n_bad, est: b.n_est } : { total: b.total, partial: b.partial, paid: b.paid, unpaid: b.unpaid, bad: b.bad_debt, est: b.estimates };
    $('dbChartTitle').textContent = q ? 'Invoices' : 'Invoiced';
    $('dbChartSub').textContent = (g === 'day' ? 'daily' : g === 'week' ? 'weekly' : 'monthly') + ' · by the billed date (Los Angeles)';
    $('dbLegend').innerHTML = [['Total value', C.total], ['Partially paid', C.partial], ['Paid', C.paid], ['Unpaid', C.unpaid], ['Bad debt', C.bad], ['Estimates', C.est]].map(x => '<span><i style="background:' + x[1] + '"></i>' + x[0] + '</span>').join('');
    const box = $('dbChart'); const W = Math.max(320, box.clientWidth), H = window.innerWidth < 900 ? 260 : 320;
    const L = 58, R = 8, T = 10, B = 28, pw = W - L - R, ph = H - T - B;
    const maxV = Math.max(0, ...ser.map(b => { const x = v(b); return Math.max(x.total, x.partial + x.paid + x.unpaid, x.bad + x.est); }));
    const [top, step] = nice(maxV * 1.05);
    const y = (n) => T + ph - (n / top) * ph;
    const n = ser.length, gw = pw / Math.max(1, n), bw = Math.max(2, Math.min(30, gw * 0.27)), gap = Math.max(1, Math.min(4, bw * 0.15));
    let s = '';
    for (let t = 0; t <= top + 1e-9; t += step) s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="#eeeef5"/><text x="' + (L - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end" font-size="11" fill="#8a8aa3">' + (q ? int(t) : usdK(t)) + '</text>';
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 74))));
    ser.forEach((b, i) => {
      const x = v(b), gx = L + i * gw, cx = gx + gw / 2, x0 = cx - (bw * 1.5 + gap), has = x.bad + x.est > 0;
      const rect = (xx, from, val, col) => val > 0 ? '<rect x="' + xx.toFixed(1) + '" y="' + y(from + val).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, y(from) - y(from + val)).toFixed(1) + '" fill="' + col + '" rx="' + Math.min(3, bw / 4) + '"/>' : '';
      s += '<g class="bk' + (sel === i ? ' sel' : '') + '" data-i="' + i + '"><rect class="hov" x="' + gx + '" y="' + T + '" width="' + gw + '" height="' + ph + '" fill="transparent"/>' +
        rect(x0, 0, x.total, C.total) +
        rect(x0 + bw + gap, 0, x.partial, C.partial) + rect(x0 + bw + gap, x.partial, x.paid, C.paid) + rect(x0 + bw + gap, x.partial + x.paid, x.unpaid, C.unpaid) +
        (has ? rect(x0 + 2 * (bw + gap), 0, x.bad, C.bad) + rect(x0 + 2 * (bw + gap), x.bad, x.est, C.est) : '') + '</g>';
      if (i % every === 0) s += '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#6b6b85">' + esc(bucketLabel(b, g)) + '</text>';
    });
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="#c9c9da"/>';
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="height:' + H + 'px" role="img" aria-label="Invoices by ' + g + '">' + s + '</svg><div class="db-tip" id="dbTip"></div>' + (maxV ? '' : '<div class="db-empty" style="position:absolute;inset:0;padding-top:120px">Nothing billed with these filters</div>');
    const tip = $('dbTip');
    box.querySelectorAll('.bk').forEach(el => {
      el.addEventListener('mousemove', (ev) => {
        const b = ser[+el.dataset.i], x = v(b), r = box.getBoundingClientRect(), f = (n) => q ? int(n) : usd2(n);
        tip.innerHTML = '<b>' + esc(bucketLabel(b, g, true)) + '</b>' + [['Total value', C.total, x.total], ['Partially paid', C.partial, x.partial], ['Paid', C.paid, x.paid], ['Unpaid', C.unpaid, x.unpaid], ['Bad debt', C.bad, x.bad], ['Estimates', C.est, x.est]].filter((z, k) => k < 4 || z[2]).map(z => '<div class="r"><span><i style="background:' + z[1] + '"></i>' + z[0] + '</span><span>' + f(z[2]) + '</span></div>').join('') +
          '<div class="r tot"><span>' + (q ? 'Invoiced' : 'Invoices') + '</span><span>' + (q ? usd2(b.total) : int(b.n)) + '</span></div><div class="hint">Click to see these invoices below</div>';
        tip.style.display = 'block';
        const lx = ev.clientX - r.left + 14, tw = tip.offsetWidth;
        tip.style.left = (lx + tw > r.width ? ev.clientX - r.left - tw - 14 : lx) + 'px'; tip.style.top = Math.max(0, ev.clientY - r.top - 20) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      el.addEventListener('click', () => { const i = +el.dataset.i; sel = sel === i ? null : i; paintChart(); paintList(); if (sel != null) $('dbList').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    });
  }

  // ---- the list
  const STATUS = { paid: ['Paid', 'paid'], partial: ['Partial', 'partial'], unpaid: ['Unpaid', 'unpaid'], bad_debt: ['Bad debt', 'bad'], estimate: ['Estimate', 'est'] };
  const stOf = (r) => r.type === 'bad_debt' ? 'bad_debt' : r.type === 'estimate' ? 'estimate' : r.st;
  const timeLA = (utc) => new Date(String(utc).replace(' ', 'T') + 'Z').toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
  function paintList() {
    const g = D.range.group; let rows = D.rows;
    let selTxt = '';
    if (sel != null && D.series[sel]) { const b = D.series[sel]; rows = rows.filter(r => r.day >= b.from && r.day <= b.to); selTxt = '<span class="db-selchip">' + esc(bucketLabel(b, g, true)) + '<button id="dbSelX" title="Show the whole period">×</button></span>'; }
    if (LF.status) rows = rows.filter(r => stOf(r) === LF.status);
    if (LF.client) { const w = LF.client.toLowerCase(); rows = rows.filter(r => (r.client + ' ' + r.person + ' INV' + r.id).toLowerCase().indexOf(w) > -1); }
    $('dbSel').innerHTML = selTxt;
    $('dbListN').textContent = int(rows.length) + ' shown' + (D.row_count > D.rows.length ? ' · the newest ' + int(D.rows.length) + ' of ' + int(D.row_count) : '');
    const admin = D.scope && D.scope.admin, info = D.am_info || {};
    const specs = { status: Object.keys(STATUS).map(k => ({ v: k, l: STATUS[k][0] })), client: { type: 'text', value: LF.client } };
    const head = '<tr><th>Billed</th><th>Invoice</th><th>' + NovaTable.th('client', 'Client', specs.client, LF.client) + '</th>' + (admin ? '<th>AM</th>' : '') + '<th>Order #</th><th>Ordered</th><th>' + NovaTable.th('status', 'Status', specs.status, LF.status) + '</th><th class="r">Total</th><th class="r">Paid</th></tr>';
    const body = rows.map(r => {
      const st = STATUS[stOf(r)] || ['—', ''], am = info[r.am], b = r.band;
      return '<tr><td style="white-space:nowrap">' + esc(md(r.day, { year: 'numeric' })) + '<div class="db-muted">' + esc(timeLA(r.at)) + '</div></td>' +
        '<td style="white-space:nowrap;font-weight:600">INV' + r.id + '</td>' +
        '<td><div class="who"><div style="min-width:0"><b>' + esc(r.client || 'Client #' + (r.cid || '?')) + '</b>' + (r.person && r.person !== r.client ? '<small>' + esc(r.person) + '</small>' : '') + '</div></div></td>' +
        (admin ? '<td><span class="who" title="' + esc(am ? am.name : '') + '">' + face(am, 'sm') + '<small style="color:var(--ink-soft);font-size:12px">' + esc(am ? am.name.split(' ')[0] : '—') + '</small></span></td>' : '') +
        '<td><span class="pill ' + b + '" title="The client\'s ' + (r.order_n || 1) + ordinal(r.order_n || 1) + ' order">' + (b === 'new' ? 'New' : '#' + r.order_n) + '</span></td>' +
        '<td>' + (r.online ? '<span class="pill on">' + IC.web + 'Online</span>' : '<span class="pill man">' + IC.hand + 'Manual</span>') + '</td>' +
        '<td><span class="pill ' + st[1] + '">' + st[0] + '</span></td>' +
        '<td class="r">' + usd2(r.total) + '</td><td class="r">' + (r.type === 'invoice' ? usd2(r.done) : '—') + '</td></tr>';
    }).join('');
    $('dbList').innerHTML = rows.length ? '<table class="db-t"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' : '<table class="db-t"><thead>' + head + '</thead></table><div class="db-empty">No invoices with these filters</div>';
    const t = $('dbList').querySelector('table'); if (t) { NovaTable.bind(t, specs, (k, v) => { LF[k] = v || ''; paintList(); }); try { NovaTable.pin(t); } catch (e) {} }
    const x = $('dbSelX'); if (x) x.onclick = () => { sel = null; paintChart(); paintList(); };
  }
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; };

  function paint() { paintFilters(); paintTiles(); paintChart(); paintList(); }

  // ---- clicks
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.p) { S.period = b.dataset.p; if (S.period === 'custom') { const r = range(); S.from = S.from || r[0]; S.to = S.to || r[1]; } S.group = 'auto'; save(); paintFilters(); load(); return; }
    if (b.dataset.g) { const [from, to] = range(); S.group = b.dataset.g === autoGroup(daysBetween(from, to)) ? 'auto' : b.dataset.g; save(); paintFilters(); load(); return; }
    if (b.dataset.o) { S.online = b.dataset.o; save(); paintFilters(); load(); return; }
    if (b.dataset.ord) { S.orders = S.orders === b.dataset.ord ? 'all' : b.dataset.ord; save(); paintFilters(); load(); return; }
    if (b.dataset.am) { S.am = S.am === b.dataset.am && b.dataset.am !== 'all' ? 'all' : b.dataset.am; save(); paintFilters(); load(); return; }
    if (b.dataset.by) { S.by = b.dataset.by; save(); if (D) paint(); else paintFilters(); return; }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'dbFrom' || ev.target.id === 'dbTo') { S.from = $('dbFrom').value; S.to = $('dbTo').value; if (S.from && S.to) { S.group = 'auto'; save(); paintFilters(); load(); } }
  });
  let rt = 0; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (D) paintChart(); }, 120); });

  paintFilters(); load();
})();
