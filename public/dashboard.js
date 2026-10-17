/* Dashboard (1.20.175) — NovaAI's home page. GET /api/dashboard draws: AM heads, period presets, Day / Week / Month (auto by the
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
    ['last30', 'Last 30 days', (t) => [addDays(t, -29), t]],
    ['last90', 'Last 90 days', (t) => [addDays(t, -89), t]],
    ['custom', 'Pick dates…', null]
  ];
  /* 1.20.175: the bar shows Last 7 days and YTD; everything else lives in the Custom ▾ menu */
  const BAR = ['last7', 'ytd'], MENU = ['lastweek', 'month', 'prevmonth', 'last30', 'last90', 'lastyear', 'custom'];
  const autoGroup = (days) => days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';

  // ---- state (kept per browser)
  const DEF = { period: 'last7', from: '', to: '', group: 'auto', am: 'all', orders: 'all', online: 'all', by: 'inv', ly: false };
  let S = Object.assign({}, DEF);
  try { Object.assign(S, JSON.parse(localStorage.getItem('nova_dash_v1') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('nova_dash_v1', JSON.stringify(S)); } catch (e) {} };
  function range() {
    const t = todayLA(); const p = PRESETS.find(x => x[0] === S.period);
    if (S.period === 'custom' && S.from && S.to) return S.from <= S.to ? [S.from, S.to] : [S.to, S.from];
    return (p && p[2] ? p[2] : PRESETS[0][2])(t);
  }
  /* 1.20.176: the top 12 AMs by total; "Show n more" opens the rest (the picked one always shows) */
  const AM_LIMIT = 12; let amMore = false;
  let D = null, sel = null, LF = { status: '', client: '' }, seq = 0;
  /* 1.20.182: /invoices shows the list with the same filters (state shared in nova_dash_v1); /dashboard shows the chart and no list.
     A bar on the dashboard opens /invoices?d=<from>&e=<to> — the list narrowed to that day / week / month (SUB, × shows the whole period). */
  const INV = /^\/invoices\/?$/.test(location.pathname);
  let SUB = null;
  if (INV) { const st0 = new URLSearchParams(location.search).get('st'); if (/^(paid|partial|unpaid|bad_debt|estimate)$/.test(st0 || '')) LF.status = st0; }
  if (INV) { const u = new URLSearchParams(location.search), d = u.get('d'), e = u.get('e'); if (/^\d{4}-\d\d-\d\d$/.test(d || '') && /^\d{4}-\d\d-\d\d$/.test(e || '')) SUB = { from: d, to: e }; }

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
    const qs = new URLSearchParams({ from, to, group: S.group === 'auto' ? '' : S.group, am: S.am, orders: S.orders, online: S.online, compare: S.ly ? 'ly' : '', rows: INV ? '' : '0' });
    if (!INV) $('dbChart').innerHTML = '<div class="db-skel"></div>';
    else $('dbList').innerHTML = '<div class="db-skel"></div>';
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
    const inMenu = MENU.indexOf(S.period) > -1, pl = (k) => (PRESETS.find(p => p[0] === k) || [])[1];
    const caret = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
    $('dbPeriod').innerHTML = BAR.map(k => '<button data-p="' + k + '" class="' + (S.period === k ? 'on' : '') + '">' + pl(k) + '</button>').join('') +
      '<span class="db-pm"><button id="dbCustom" class="db-pmore' + (inMenu ? ' on' : '') + '" aria-haspopup="true" aria-expanded="false">' + (inMenu ? (S.period === 'custom' ? us(from) + ' – ' + us(to) : pl(S.period)) : 'Custom') + caret + '</button>' +
      '<div class="db-pmenu" id="dbPMenu" hidden>' + MENU.map(k => (k === 'custom' ? '<div class="sep"></div>' : '') + '<button data-pm="' + k + '" class="' + (S.period === k ? 'on' : '') + '">' + pl(k) + '</button>').join('') +
      '</div><div class="db-cal" id="dbCal" hidden></div></span>' +
      '<span class="db-range">' + us(from) + ' – ' + us(to) + ' · ' + days + ' day' + (days === 1 ? '' : 's') + '</span>';
    const g = S.group === 'auto' ? auto : S.group;
    $('dbGroup').innerHTML = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']].map(x => '<button data-g="' + x[0] + '" class="' + (g === x[0] ? 'on' : '') + '" title="' + (x[0] === auto ? 'Picked by itself for ' + days + ' days' : 'Click to group by ' + x[1].toLowerCase()) + '">' + x[1] + '</button>').join('');
    const of = D && D.online_f, cnt = (k) => of ? ' <small>' + (S.by === 'qty' ? int(of[k].n) : usdK(of[k].total)) + '</small>' : '';
    $('dbOnline').innerHTML = '<button data-o="all" class="' + (S.online === 'all' ? 'on' : '') + '">All' + cnt('all') + '</button><button data-o="online" class="' + (S.online === 'online' ? 'on' : '') + '" title="Ordered on axiomprint.com">' + IC.web + 'Online' + cnt('online') + '</button><button data-o="manual" class="' + (S.online === 'manual' ? 'on' : '') + '" title="Entered by the team in the CRM">' + IC.hand + 'Manual' + cnt('manual') + '</button>';
    const ofs = D && D.orders_f, maxT = ofs ? Math.max(1, ofs.all[S.by === 'qty' ? 'n' : 'total']) : 1;
    $('dbOrders').innerHTML = BANDS.map(b => { const f = ofs ? ofs[b[0]] : null; const v = f ? (S.by === 'qty' ? f.n : f.total) : 0;
      return '<button class="db-oc' + (S.orders === b[0] ? ' on' : '') + '" data-ord="' + b[0] + '" data-snap="ord:' + b[0] + '" style="--c:' + b[3] + '"><span class="t"><i></i>' + b[1] + '</span><span class="v">' + (f ? (S.by === 'qty' ? int(f.n) + ' <small>inv.</small>' : usd0(f.total)) : '—') + '</span>' + (f ? '<span class="bar" style="width:' + Math.round(100 * v / maxT) + '%"></span>' : '') + '</button>'; }).join('');
    // AMs
    if (D && D.scope && !D.scope.admin) {
      $('dbAmBox').querySelector('.db-lab').textContent = 'Your invoices';
      const me = D.scope.me || { name: 'You' };
      $('dbAms').innerHTML = '<div class="db-am on" style="cursor:default">' + face(me) + '<span><b>' + esc(me.name) + '</b><small>the invoices where you are the AM</small></span></div>';
    } else if (D) {
      /* 1.20.175: heads only — hover for a snapshot, click to see only that AM (click again for everyone) */
      const missing = S.am !== 'all' && !D.ams.some(a => String(a.id) === String(S.am));
      $('dbAms').innerHTML = '<button class="db-head all' + (S.am === 'all' ? ' on' : '') + '" data-am="all" data-snap="all" aria-label="All account managers"><span class="face all">' + IC.all + '</span></button>' +
        D.ams.filter((a, i) => amMore || i < AM_LIMIT || String(S.am) === String(a.id)).map(a => '<button class="db-head' + (String(S.am) === String(a.id) ? ' on' : '') + (S.am !== 'all' && String(S.am) !== String(a.id) ? ' dim' : '') + '" data-am="' + a.id + '" data-snap="' + a.id + '" aria-label="' + esc(a.name) + '">' + face(a) + '</button>').join('') +
        (missing ? '<button class="db-head on" data-am="' + esc(S.am) + '" data-snap="' + esc(S.am) + '">' + face(D.am_info && D.am_info[S.am]) + '</button>' : '') +
        (D.ams.length > AM_LIMIT ? '<button class="db-hmore" id="dbAmMore">' + (amMore ? 'Show less' : 'Show ' + (D.ams.length - AM_LIMIT) + ' more') + '</button>' : '');
      const cur = S.am === 'all' ? null : D.ams.find(a => String(a.id) === String(S.am)) || (D.am_info && D.am_info[S.am]);
      $('dbAmPick').innerHTML = cur ? 'Showing <b>' + esc(cur.name) + '</b> · <a href="#" id="dbAmAll">everyone</a>' : '';
    }
    document.querySelectorAll('#dbBy button').forEach(b => b.classList.toggle('on', b.dataset.by === S.by));
    const ly = $('dbLy'); if (ly) ly.checked = !!S.ly;
  }

  // ---- the range calendar (1.20.179): two months side by side, click the first day then the last
  const CAL = { a: null, b: null, hover: null, view: null };
  const ymOf = (ymd) => ymd.slice(0, 7) + '-01';
  const addMonths = (ym, n) => { const d = new Date(ym + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
  function openCal() {
    const [from, to] = range(); CAL.a = from; CAL.b = to; CAL.hover = null;
    CAL.view = addMonths(ymOf(to), -1);   /* the end month on the right */
    if (window.innerWidth < 640) CAL.view = ymOf(to);
    $('dbPMenu').hidden = true; $('dbCal').hidden = false; paintCal();
  }
  function closeCal() { const c = $('dbCal'); if (c) c.hidden = true; }
  function monthHTML(ym) {
    const d0 = new Date(ym + 'T12:00:00Z'), first = (d0.getUTCDay() + 7) % 7, days = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0)).getUTCDate();
    const today = todayLA(), a = CAL.a, b = CAL.b || (CAL.hover && CAL.a && !CAL.b ? CAL.hover : null);
    const lo = a && b ? (a < b ? a : b) : a, hi = a && b ? (a < b ? b : a) : a;
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<i></i>';
    for (let n = 1; n <= days; n++) {
      const day = ym.slice(0, 8) + String(n).padStart(2, '0'), fut = day > today;
      const cls = [day === lo || day === hi ? 'end' : '', lo && hi && day > lo && day < hi ? 'mid' : '', day === lo && hi && hi !== lo ? 'lo' : '', day === hi && lo && hi !== lo ? 'hi' : '', day === today ? 'today' : '', !CAL.b && CAL.hover && CAL.a ? 'preview' : ''].filter(Boolean).join(' ');
      cells += '<button type="button" data-day="' + day + '" class="' + cls + '"' + (fut ? ' disabled' : '') + '>' + n + '</button>';
    }
    return '<div class="cal"><div class="cal-h"><b>' + d0.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long' }) + '</b> ' + d0.getUTCFullYear() + '</div><div class="cal-w">' + ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(w => '<i>' + w + '</i>').join('') + '</div><div class="cal-g">' + cells + '</div></div>';
  }
  function paintCal() {
    const one = window.innerWidth < 640, right = addMonths(CAL.view, 1), canNext = (one ? CAL.view : right) < ymOf(todayLA());
    const a = CAL.a, b = CAL.b, lo = a && b ? (a < b ? a : b) : a, hi = a && b ? (a < b ? b : a) : null;
    const nav = (d, dis, svg) => '<button type="button" class="cal-nav" data-nav="' + d + '"' + (dis ? ' disabled' : '') + ' aria-label="' + (d < 0 ? 'Earlier' : 'Later') + '"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + svg + '"/></svg></button>';
    $('dbCal').innerHTML = '<div class="cal-top">' + nav(-1, false, 'M15 6l-6 6 6 6') + '<div class="cal-ms">' + monthHTML(CAL.view) + (one ? '' : monthHTML(right)) + '</div>' + nav(1, !canNext, 'M9 6l6 6-6 6') + '</div>' +
      '<div class="cal-f"><span class="cal-sum">' + (lo && hi ? '<b>' + us(lo) + ' – ' + us(hi) + '</b> · ' + daysBetween(lo, hi) + ' days' : lo ? '<b>' + us(lo) + '</b> · now click the last day' : 'Click the first day') + '</span>' +
      '<button type="button" class="cal-btn" id="dbCalClear">Clear</button><button type="button" class="cal-btn pri" id="dbCalApply"' + (lo && hi ? '' : ' disabled') + '>Apply</button></div>';
  }
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('#dbCal button'); if (!t) return;
    ev.stopPropagation();
    if (t.dataset.day) { const d = t.dataset.day; if (!CAL.a || CAL.b) { CAL.a = d; CAL.b = null; } else { CAL.b = d; if (CAL.b < CAL.a) { const x = CAL.a; CAL.a = CAL.b; CAL.b = x; } } CAL.hover = null; paintCal(); return; }
    if (t.dataset.nav) { CAL.view = addMonths(CAL.view, +t.dataset.nav); paintCal(); return; }
    if (t.id === 'dbCalClear') { CAL.a = CAL.b = CAL.hover = null; paintCal(); return; }
    if (t.id === 'dbCalApply' && CAL.a && CAL.b) { S.period = 'custom'; S.from = CAL.a; S.to = CAL.b; S.group = 'auto'; closeCal(); closeMenu(); save(); paintFilters(); load(); }
  });
  document.addEventListener('mouseover', (ev) => {
    const t = ev.target.closest && ev.target.closest('#dbCal [data-day]'); if (!t || !CAL.a || CAL.b || CAL.hover === t.dataset.day) return;
    CAL.hover = t.dataset.day; paintCal();
  });

  // ---- the AM snapshot (hover card)
  function snapHTML(key) {
    const q = S.by === 'qty', lyTxt = D.prev.kind === 'ly' ? 'last year' : 'the ' + D.range.days + ' days before';
    if (key.indexOf('ord:') === 0) { return ordSnap(key.slice(4)); }
    if (key === 'all') { const t = D.am_all || { n: 0, total: 0 };
      return '<div class="sn-h"><span class="face all">' + IC.all + '</span><div><b>All account managers</b><small>' + int(D.ams.length) + ' AMs with invoices</small></div></div><div class="sn-big">' + usd2(t.total) + '</div><div class="sn-sub">' + int(t.n) + ' invoices · ' + us(D.range.from) + ' – ' + us(D.range.to) + '</div><div class="sn-hint">Click to see everyone</div>'; }
    const a = D.ams.find(x => String(x.id) === String(key)); if (!a) return '';
    const all = (D.am_all && D.am_all.total) || 1, rank = D.ams.indexOf(a) + 1, w = (v) => a.total ? Math.max(0, Math.round(100 * v / a.total)) : 0;
    const ch = a.prev_total ? Math.round((a.total - a.prev_total) / a.prev_total * 100) : null;
    return '<div class="sn-h">' + face(a) + '<div><b>' + esc(a.name) + '</b><small>#' + rank + ' of ' + D.ams.length + ' · ' + Math.round(100 * a.total / all) + '% of all invoiced</small></div></div>' +
      '<div class="sn-big">' + (q ? int(a.n) + ' invoices' : usd2(a.total)) + (ch == null ? '' : ' <span class="chg ' + (ch > 0 ? 'up' : ch < 0 ? 'dn' : 'eq') + '">' + (ch > 0 ? '▲ ' : ch < 0 ? '▼ ' : '') + Math.abs(ch) + '%</span>') + '</div>' +
      '<div class="sn-sub">' + (q ? usd0(a.total) : int(a.n) + ' invoices') + ' · avg ' + usd0(a.avg) + (a.prev_total ? ' · ' + usd0(a.prev_total) + ' ' + lyTxt : '') + '</div>' +
      '<div class="sn-bar"><i style="width:' + w(a.partial) + '%;background:' + C.partial + '"></i><i style="width:' + w(a.paid) + '%;background:' + C.paid + '"></i><i style="width:' + w(a.unpaid) + '%;background:' + C.unpaid + '"></i></div>' +
      '<div class="sn-rows"><span><i style="background:' + C.paid + '"></i>Paid</span><b>' + usd0(a.paid) + '</b><span><i style="background:' + C.partial + '"></i>Partially paid</span><b>' + usd0(a.partial) + '</b><span><i style="background:' + C.unpaid + '"></i>Unpaid</span><b>' + usd0(a.unpaid) + '</b>' +
      '<span>Still due</span><b>' + usd0(a.due) + '</b><span>New clients</span><b>' + int(a.new_clients) + '</b><span>Ordered online</span><b>' + (a.total ? Math.round(100 * a.online / a.total) : 0) + '%</b></div>' +
      '<div class="sn-hint">' + (String(S.am) === String(a.id) ? 'Click to see everyone again' : 'Click to see only ' + esc(a.first || a.name.split(' ')[0]) + '\'s invoices') + '</div>';
  }
  /* 1.20.181: the order-number card's hover: what the band is, invoices, estimates, bad debt, paid / unpaid */
  function ordSnap(k) {
    const b = BANDS.find(x => x[0] === k), f = D.orders_f && D.orders_f[k]; if (!b || !f) return '';
    const all = (D.orders_f.all && D.orders_f.all.total) || 0, w = (v) => f.total ? Math.max(0, Math.round(100 * v / f.total)) : 0;
    return '<div class="sn-h"><span class="sn-dot" style="background:' + b[3] + '"></span><div><b>' + esc(b[1]) + '</b><small>' + esc(b[2] === 'every client' ? 'Every client, any order number' : 'The client\'s ' + b[2]) + '</small></div></div>' +
      '<div class="sn-big">' + usd2(f.total) + '</div>' +
      '<div class="sn-sub">' + int(f.n) + ' invoice' + (f.n === 1 ? '' : 's') + ' · avg ' + usd0(f.avg) + (k !== 'all' && all ? ' · ' + Math.round(100 * f.total / all) + '% of all' : '') + '</div>' +
      '<div class="sn-bar"><i style="width:' + w(f.partial) + '%;background:' + C.partial + '"></i><i style="width:' + w(f.paid) + '%;background:' + C.paid + '"></i><i style="width:' + w(f.unpaid) + '%;background:' + C.unpaid + '"></i></div>' +
      '<div class="sn-rows"><span>Invoices</span><b>' + int(f.n) + '</b><span>Estimates</span><b>' + int(f.n_est || 0) + (f.n_est ? ' · ' + usd0(f.estimates) : '') + '</b>' +
      (f.n_bad ? '<span>Bad debt</span><b>' + int(f.n_bad) + ' · ' + usd0(f.bad_debt) + '</b>' : '') +
      '<span><i style="background:' + C.paid + '"></i>Paid</span><b>' + int(f.n_paid || 0) + ' · ' + usd0(f.paid) + '</b><span><i style="background:' + C.partial + '"></i>Partially paid</span><b>' + int(f.n_partial || 0) + ' · ' + usd0(f.partial) + '</b><span><i style="background:' + C.unpaid + '"></i>Unpaid</span><b>' + int(f.n_unpaid || 0) + ' · ' + usd0(f.unpaid) + '</b>' +
      '<span>Ordered online</span><b>' + (f.total ? Math.round(100 * f.online / f.total) : 0) + '%</b></div>' +
      '<div class="sn-hint">' + (S.orders === k && k !== 'all' ? 'Click to see all orders again' : k === 'all' ? 'Click to see every order' : 'Click to see only these') + '</div>';
  }
  let snapT = 0;
  document.addEventListener('mouseover', (ev) => {
    const h = ev.target.closest && ev.target.closest('[data-snap]'); const card = $('dbSnap');
    if (!h) { if (card && !(ev.target.closest && ev.target.closest('#dbSnap'))) { clearTimeout(snapT); snapT = setTimeout(() => { card.hidden = true; }, 120); } return; }
    if (!D) return; clearTimeout(snapT);
    card.innerHTML = snapHTML(h.dataset.snap); card.hidden = false;
    const r = h.getBoundingClientRect(), cw = card.offsetWidth;
    card.style.left = Math.max(8, Math.min(innerWidth - cw - 8, r.left + r.width / 2 - cw / 2)) + 'px'; card.style.top = (r.bottom + 8) + 'px';
  });
  function closeMenu() { const m = $('dbPMenu'); if (m) m.hidden = true; closeCal(); const b = $('dbCustom'); if (b) b.setAttribute('aria-expanded', 'false'); }

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
      ['Invoiced', C.total, q ? int(t.n) : usd2(t.total), q ? chg(t.n, p.n) : chg(t.total, p.total), (q ? usd0(t.total) : int(t.n) + ' invoices') + ' · avg ' + usd0(t.avg), ''],
      ['Paid', C.paid, q ? int(t.n_paid) : usd2(t.paid), q ? chg(t.n_paid, p.n_paid) : chg(t.paid, p.paid), pct(t.paid, t.total) + ' of the invoiced ' + (q ? '$' : 'value') + ' · ' + (q ? usd0(t.paid) : int(t.n_paid) + ' invoices'), 'st:paid'],
      ['Partially paid', C.partial, q ? int(t.n_partial) : usd2(t.partial), q ? chg(t.n_partial, p.n_partial) : chg(t.partial, p.partial), usd0(t.partial_done) + ' received · ' + usd0(Math.max(0, t.partial - t.partial_done)) + ' still due', 'st:partial'],
      ['Unpaid', C.unpaid, q ? int(t.n_unpaid) : usd2(t.unpaid), q ? chg(t.n_unpaid, p.n_unpaid) : chg(t.unpaid, p.unpaid), 'still due in all: ' + usd0(t.due), 'st:unpaid'],
      ['New clients', '#16a34a', int(t.new_clients), chg(t.new_clients, p.new_clients), 'first orders · ' + pct(t.new_clients, t.n) + ' of invoices', 'ord:new'],
      ['Ordered online', '#0891b2', pct(q ? t.n_online : t.online, q ? t.n : t.total), chg(q ? t.n_online : t.online, q ? p.n_online : p.online), (q ? int(t.n_online) + ' invoices' : usd0(t.online)) + ' · the rest entered by the team', 'on:online'],
      ['Estimates · Bad debt', '#64748b', q ? int(t.n_est) : usd0(t.estimates), '', (q ? int(t.n_bad) + ' bad debt' : usd0(t.bad_debt) + ' bad debt') + ' · not in Invoiced', 'st:estimate']
    ];
    /* 1.20.182: a tile opens the Invoices page narrowed to it (status, New, Online) */
    $('dbTiles').innerHTML = T.map(x => '<div class="db-tile go" data-tgo="' + x[5] + '" title="See these invoices" style="--c:' + x[1] + '"><div class="l">' + x[0] + (x[3] ? ' ' + x[3] : '') + '</div><div class="v">' + x[2] + '</div><div class="s">' + x[4] + '</div></div>').join('');
    $('dbTiles').title = 'Changes are against ' + us(D.prev.from) + ' – ' + us(D.prev.to) + (D.prev.kind === 'ly' ? ', the same dates last year' : ', the same number of days just before');
    $('dbVs').textContent = 'vs ' + (D.prev.kind === 'ly' ? 'last year' : 'the ' + D.range.days + ' days before') + ' (' + us(D.prev.from) + ' – ' + us(D.prev.to) + ')';
  }

  // ---- chart
  function nice(max) { if (max <= 0) return [1, 0.25]; const p = Math.pow(10, Math.floor(Math.log10(max))); const n = max / p; const top = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; return [top, top / 4]; }
  const bucketLabel = (b, g, long) => g === 'day' ? md(b.key, long ? { weekday: 'short', year: 'numeric' } : {}) : g === 'week' ? (long ? 'Week of ' + md(b.from) + ' – ' + md(b.to) : md(b.key)) : new Date(b.key + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: long ? 'long' : 'short', year: long || b.key.slice(5, 7) === '01' ? 'numeric' : undefined });
  function paintChart() {
    const q = S.by === 'qty', g = D.range.group, ser = D.series;
    const v = (b) => q ? { total: b.n, partial: b.n_partial, paid: b.n_paid, unpaid: b.n_unpaid, bad: b.n_bad, est: b.n_est } : { total: b.total, partial: b.partial, paid: b.paid, unpaid: b.unpaid, bad: b.bad_debt, est: b.estimates };
    $('dbChartTitle').textContent = q ? 'Invoices' : 'Invoiced';
    $('dbChartSub').textContent = (g === 'day' ? 'daily' : g === 'week' ? 'weekly' : 'monthly') + ' · by the billed date (Los Angeles)';
    $('dbLegend').innerHTML = [['Total value', C.total], ['Partially paid', C.partial], ['Paid', C.paid], ['Unpaid', C.unpaid], ['Bad debt', C.bad], ['Estimates', C.est]].map(x => '<span><i style="background:' + x[1] + '"></i>' + x[0] + '</span>').join('') +
      (D.prev.kind === 'ly' ? '<span><i class="lyk"></i>Last year</span>' : '');
    const box = $('dbChart'); const W = Math.max(320, box.clientWidth), H = window.innerWidth < 900 ? 260 : 320;
    const L = 58, R = 8, T = 10, B = 28, pw = W - L - R, ph = H - T - B;
    const LY = D.prev.kind === 'ly' ? (D.prev_series || []) : [], lyv = (i) => LY[i] ? (q ? LY[i].n : LY[i].total) : null;
    const maxV = Math.max(0, ...ser.map((b, i) => { const x = v(b); return Math.max(x.total, x.partial + x.paid + x.unpaid, x.bad + x.est, lyv(i) || 0); }));
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
    if (LY.length) { const pts = ser.map((b, i) => lyv(i) == null ? null : [L + i * gw + gw / 2, y(lyv(i))]).filter(Boolean);
      s += '<polyline points="' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '" fill="none" stroke="#475569" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" pointer-events="none"/>' + pts.map(p => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.5" fill="#fff" stroke="#475569" stroke-width="2" pointer-events="none"/>').join(''); }
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="height:' + H + 'px" role="img" aria-label="Invoices by ' + g + '">' + s + '</svg><div class="db-tip" id="dbTip"></div>' + (maxV ? '' : '<div class="db-empty" style="position:absolute;inset:0;padding-top:120px">Nothing billed with these filters</div>');
    const tip = $('dbTip');
    box.querySelectorAll('.bk').forEach(el => {
      el.addEventListener('mousemove', (ev) => {
        const b = ser[+el.dataset.i], x = v(b), r = box.getBoundingClientRect(), f = (n) => q ? int(n) : usd2(n);
        tip.innerHTML = '<b>' + esc(bucketLabel(b, g, true)) + '</b>' + [['Total value', C.total, x.total], ['Partially paid', C.partial, x.partial], ['Paid', C.paid, x.paid], ['Unpaid', C.unpaid, x.unpaid], ['Bad debt', C.bad, x.bad], ['Estimates', C.est, x.est]].filter((z, k) => k < 4 || z[2]).map(z => '<div class="r"><span><i style="background:' + z[1] + '"></i>' + z[0] + '</span><span>' + f(z[2]) + '</span></div>').join('') +
          '<div class="r tot"><span>' + (q ? 'Invoiced' : 'Invoices') + '</span><span>' + (q ? usd2(b.total) : int(b.n)) + '</span></div>' +
          (LY[+el.dataset.i] ? (() => { const p = LY[+el.dataset.i], pv = q ? p.n : p.total, cv = q ? b.n : b.total, ch = pv ? Math.round((cv - pv) / pv * 100) : null; return '<div class="r ly"><span>Last year · ' + esc(bucketLabel(p, g, false)) + '</span><span>' + (q ? int(pv) : usd2(pv)) + (ch == null ? '' : ' (' + (ch > 0 ? '+' : '') + ch + '%)') + '</span></div>'; })() : '') +
          '<div class="hint">Click to see these invoices</div>';
        tip.style.display = 'block';
        const lx = ev.clientX - r.left + 14, tw = tip.offsetWidth;
        tip.style.left = (lx + tw > r.width ? ev.clientX - r.left - tw - 14 : lx) + 'px'; tip.style.top = Math.max(0, ev.clientY - r.top - 20) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      el.addEventListener('click', () => { const b = ser[+el.dataset.i]; location.href = '/invoices?d=' + b.from + '&e=' + b.to; });
    });
  }

  // ---- the list
  const STATUS = { paid: ['Paid', 'paid'], partial: ['Partial', 'partial'], unpaid: ['Unpaid', 'unpaid'], bad_debt: ['Bad debt', 'bad'], estimate: ['Estimate', 'est'] };
  const stOf = (r) => r.type === 'bad_debt' ? 'bad_debt' : r.type === 'estimate' ? 'estimate' : r.st;
  const timeLA = (utc) => new Date(String(utc).replace(' ', 'T') + 'Z').toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
  function paintList() {
    const g = D.range.group; let rows = D.rows;
    let selTxt = '';
    if (SUB && (SUB.to < D.range.from || SUB.from > D.range.to)) dropSub();
    if (SUB) { const b = SUB; rows = rows.filter(r => r.day >= b.from && r.day <= b.to); selTxt = '<span class="db-selchip">' + esc(b.from === b.to ? md(b.from, { weekday: 'short', year: 'numeric' }) : md(b.from) + ' – ' + md(b.to, { year: 'numeric' })) + '<button id="dbSelX" title="Show the whole period">×</button></span>'; }
    if (LF.status) rows = rows.filter(r => stOf(r) === LF.status);
    if (LF.client) { const w = LF.client.toLowerCase(); rows = rows.filter(r => (r.client + ' ' + r.person + ' INV' + r.id).toLowerCase().indexOf(w) > -1); }
    $('dbSel').innerHTML = selTxt;
    $('dbListN').textContent = int(rows.length) + ' shown · ' + usd2(rows.reduce((a, r) => a + (r.type === 'invoice' ? r.total : 0), 0)) + (D.row_count > D.rows.length ? ' · the newest ' + int(D.rows.length) + ' of ' + int(D.row_count) : '');
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
    const x = $('dbSelX'); if (x) x.onclick = () => { dropSub(); paintList(); };
  }
  function dropSub() { SUB = null; try { history.replaceState(null, '', '/invoices'); } catch (e) {} }
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; };

  function paint() { paintFilters(); if (INV) { paintList(); return; } paintTiles(); paintChart(); }

  // ---- clicks
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.id === 'dbAmMore') { amMore = !amMore; paintFilters(); return; }
    if (b.id === 'dbCustom') { const m = $('dbPMenu'), open = !m.hidden || !$('dbCal').hidden; closeCal(); m.hidden = open; b.setAttribute('aria-expanded', String(!open)); return; }
    if (b.dataset.pm) { if (b.dataset.pm === 'custom') { openCal(); return; } S.period = b.dataset.pm; S.group = 'auto'; closeMenu(); save(); paintFilters(); load(); return; }
    if (b.dataset.p) { S.period = b.dataset.p; S.group = 'auto'; save(); paintFilters(); load(); return; }
    if (b.dataset.g) { const [from, to] = range(); S.group = b.dataset.g === autoGroup(daysBetween(from, to)) ? 'auto' : b.dataset.g; save(); paintFilters(); load(); return; }
    if (b.dataset.o) { S.online = b.dataset.o; save(); paintFilters(); load(); return; }
    if (b.dataset.ord) { S.orders = S.orders === b.dataset.ord ? 'all' : b.dataset.ord; save(); paintFilters(); load(); return; }
    if (b.dataset.am) { S.am = S.am === b.dataset.am && b.dataset.am !== 'all' ? 'all' : b.dataset.am; save(); paintFilters(); load(); return; }
    if (b.dataset.by) { S.by = b.dataset.by; save(); if (D) paint(); else paintFilters(); return; }
  });
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-tgo]'); if (!t) return;
    const [k, v] = (t.dataset.tgo || '').split(':');
    if (k === 'ord') { S.orders = v; save(); } if (k === 'on') { S.online = v; save(); }
    location.href = '/invoices' + (k === 'st' ? '?st=' + v : '');
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'dbLy') { S.ly = ev.target.checked; save(); load(); }
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.id === 'dbAmAll') { ev.preventDefault(); S.am = 'all'; save(); paintFilters(); load(); return; }
    if (!(ev.target.closest && ev.target.closest('.db-pm'))) closeMenu();
  }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { closeMenu(); const c = $('dbSnap'); if (c) c.hidden = true; } });
  let rt = 0; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (D && !INV) paintChart(); }, 120); });

  paintFilters(); load();
})();
