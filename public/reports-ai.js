// ReportsAI — the period chips every report shares (1.20.110): This week · This month · Last month · 30 · 90 · 6 months · 12 months ·
// YTD · Custom (two dates); RaPeriod.range(state) gives [from, to] as LA calendar days ('' = open), RaPeriod.wire() runs the chips.
window.RaPeriod = (function () {
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function range(st) {
    const p = st.period, now = new Date(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (p === 'custom') return [st.from || '', st.to || ymd(d0)];
    if (p === 'week') return [ymd(new Date(d0 - ((d0.getDay() + 6) % 7) * 864e5)), ymd(d0)];
    if (p === 'month') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(d0)];
    if (p === 'last') return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
    if (p === 'year') return [ymd(new Date(now.getFullYear(), 0, 1)), ymd(d0)];
    if (p === '180') return [ymd(new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())), ymd(d0)];
    if (p === '365') return [ymd(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)), ymd(d0)];
    if (p === 'all') return ['', ''];
    const n = parseInt(p) || 30; return [ymd(new Date(d0 - (n - 1) * 864e5)), ymd(d0)];
  }
  function wire(barId, st, onChange) {
    const bar = document.getElementById(barId); if (!bar) return;
    const cu = bar.querySelector('.ra-custom'), ins = cu ? cu.querySelectorAll('input') : [];
    const paint = () => { bar.querySelectorAll('button[data-p]').forEach(x => x.classList.toggle('on', x.dataset.p === st.period)); if (cu) cu.hidden = st.period !== 'custom'; };
    bar.querySelectorAll('button[data-p]').forEach(b => b.onclick = () => { st.period = b.dataset.p; paint(); if (st.period === 'custom') { if (ins[0] && !ins[0].value) { ins[0].focus(); return; } if (!(st.from && st.to)) return; } onChange(); });
    ins.forEach(i => i.onchange = () => { st.from = ins[0].value; st.to = ins[1].value; if (st.from && st.to && st.from <= st.to) onChange(); });
    paint();
  }
  return { range, wire };
})();
// ReportsAI — Onboarding (1.20.96): who onboarded whom, when, where the client came from; a chart per account manager.
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const H = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
  const api = async (url) => { const r = await fetch(url, { headers: H() }); if (r.status === 401 || r.status === 403) { location.href = '/'; throw new Error('signed out'); } return r.json(); };
  const usD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '-' + m[3] + '-' + m[1] : String(d || ''); };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const face = (p, cls) => { const ini = esc(String(p.name || '?').trim().charAt(0).toUpperCase()); return p.photo ? '<img class="ra-av ' + (cls || '') + '" src="' + esc(p.photo) + '" alt="" title="' + esc(p.name) + '" onerror="this.outerHTML=\'<span class=&quot;ra-av ' + (cls || '') + '&quot;>' + ini + '</span>\'">' : '<span class="ra-av ' + (cls || '') + '" title="' + esc(p.name) + '">' + ini + '</span>'; };
  const COLORS = ['#4f46e5', '#059669', '#d97706', '#db2777', '#0891b2', '#7c3aed', '#dc2626', '#65a30d', '#0d9488', '#9333ea', '#ea580c', '#2563eb'];

  // ---- period
  const PS = { period: '30', from: '', to: '' }; let grain = 'day';
  const range = () => RaPeriod.range(PS);
  RaPeriod.wire('obPeriod', PS, () => { if (PS.period === 'week' && grain === 'month') setGrain('day'); load(); });
  document.querySelectorAll('#obGrain button').forEach(b => b.onclick = () => setGrain(b.dataset.g));
  function setGrain(g) { grain = g; document.querySelectorAll('#obGrain button').forEach(x => x.classList.toggle('on', x.dataset.g === g)); drawChart(); }
  $('obAll').onchange = load;
  { let t = null; $('obQ').oninput = () => { clearTimeout(t); t = setTimeout(render, 250); }; }

  // ---- data
  let data = null, amPick = '';
  const OF = { date: { from: '', to: '', period: '' }, client: '', am: '', src: '', via: '', rating: '' };
  async function load() {
    const [from, to] = range();
    $('obList').innerHTML = '<div class="ra-muted">Reading the welcome forms from the CRM…</div>';
    const j = await api('/api/reports-ai/onboarding?from=' + from + '&to=' + to + ($('obAll').checked ? '&all=1' : ''));
    if (!j.ok) { $('obList').innerHTML = '<div class="ra-muted" style="color:#b91c1c">' + esc(j.error || 'Could not load') + '</div>'; return; }
    data = j; render();
  }

  // ---- the rows that pass the filters (the AM tiles and the chart follow them too, except the AM pick itself)
  function passes(r, ignoreAm) {
    const q = $('obQ').value.trim().toLowerCase();
    if (q && (r.customer.company + ' ' + r.customer.person + ' ' + r.customer.email + ' ' + r.am.name + ' ' + r.source.kind + ' ' + r.source.who + ' ' + r.via).toLowerCase().indexOf(q) < 0) return false;
    if (!ignoreAm && amPick && String(r.am.id) !== amPick) return false;
    if (OF.client && (r.customer.company + ' ' + r.customer.person + ' ' + r.customer.email).toLowerCase().indexOf(OF.client.toLowerCase()) < 0) return false;
    if (OF.src && r.source.kind !== OF.src) return false;
    if (OF.via && r.via_code !== OF.via) return false;
    if (OF.rating && r.rating !== OF.rating) return false;
    if (OF.date.from && r.date < OF.date.from) return false; if (OF.date.to && r.date > OF.date.to) return false;
    return true;
  }
  function render() {
    if (!data) return;
    const base = data.rows.filter(r => passes(r, true));   /* for the tiles + chart: every AM */
    const rows = base.filter(r => !amPick || String(r.am.id) === amPick);
    // AM tiles — the leaderboard for the period
    const by = {}; base.forEach(r => { const k = String(r.am.id); if (!by[k]) by[k] = Object.assign({ n: 0 }, r.am); by[k].n++; });
    const ams = Object.values(by).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    ams.forEach((a, i) => { a.color = COLORS[i % COLORS.length]; });
    $('obAms').innerHTML = ams.map((a, i) => '<div class="ra-am' + (amPick === String(a.id) ? ' on' : '') + '" data-am="' + esc(a.id) + '" title="Only ' + esc(a.name) + '"><span class="rank">#' + (i + 1) + '</span>' + face(a) + '<div><b>' + a.n + '</b><small>' + esc(a.name) + '</small></div></div>').join('') || '<div class="ra-muted">No onboardings in this period.</div>';
    $('obAms').querySelectorAll('[data-am]').forEach(el => el.onclick = () => { amPick = amPick === el.dataset.am ? '' : el.dataset.am; render(); });
    data._ams = ams; data._base = base; data._rows = rows;
    drawChart(); drawTable(rows);
  }

  // ---- the chart: stacked bars per AM, by day / week / month over the period
  function buckets(g) {
    const keys = [], label = {}; const [from0, to0] = range();
    const rows = data._base; if (!rows.length && !from0) return { keys, label };
    const from = from0 || rows.reduce((m, r) => r.date < m ? r.date : m, rows[0].date), to = to0 || ymd(new Date());
    const d = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
    if (g === 'day') { for (let x = new Date(d); x <= end; x.setDate(x.getDate() + 1)) { const k = ymd(x); keys.push(k); label[k] = MONTHS[x.getMonth()] + ' ' + x.getDate(); } }
    else if (g === 'week') { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); for (let x = new Date(d); x <= end; x.setDate(x.getDate() + 7)) { const k = ymd(x); keys.push(k); label[k] = 'Wk of ' + MONTHS[x.getMonth()] + ' ' + x.getDate(); } }
    else { d.setDate(1); for (let x = new Date(d); x <= end; x.setMonth(x.getMonth() + 1)) { const k = ymd(x).slice(0, 7); keys.push(k); label[k] = MONTHS[x.getMonth()] + ' ' + String(x.getFullYear()).slice(2); } }
    if (keys.length > 120) { const cut = keys.splice(0, keys.length - 120); cut.forEach(k => delete label[k]); }
    return { keys, label };
  }
  const bucketOf = (date, g) => { if (g === 'day') return date; if (g === 'month') return date.slice(0, 7); const x = new Date(date + 'T12:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
  function drawChart() {
    if (!data) return; const box = $('obChart'), svg = box.querySelector('svg'), tip = box.querySelector('.ra-tip'); const ams = data._ams || [], base = data._base || [];
    const { keys, label } = buckets(grain); const idx = {}; keys.forEach((k, i) => { idx[k] = i; });
    const cells = keys.map(() => ({})); let max = 0;
    base.forEach(r => { const i = idx[bucketOf(r.date, grain)]; if (i == null) return; const k = String(r.am.id); cells[i][k] = (cells[i][k] || 0) + 1; });
    cells.forEach(c => { const t = Object.values(c).reduce((s, n) => s + n, 0); if (t > max) max = t; });
    $('obChartN').textContent = base.length + ' onboarding' + (base.length === 1 ? '' : 's');
    $('obLegend').innerHTML = ams.map(a => '<span><i class="ra-dot" style="background:' + a.color + '"></i>' + esc(a.name) + ' · ' + a.n + '</span>').join('');
    const W = Math.max(320, box.clientWidth || 800), Hh = 210, padL = 28, padB = 22, padT = 8, innerH = Hh - padT - padB, n = keys.length;
    if (!n || !max) { svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (Hh / 2) + '" class="tick" text-anchor="middle">Nothing in this period</text>'; return; }
    const top = Math.max(1, Math.ceil(max / 4) * 4), step = (W - padL) / n, bw = Math.max(3, Math.min(34, step * 0.66));
    let out = '';
    for (let g = 0; g <= 4; g++) { const v = top * g / 4, y = padT + innerH - innerH * g / 4; out += '<line class="grid" x1="' + padL + '" y1="' + y + '" x2="' + W + '" y2="' + y + '"/><text class="tick" x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + v + '</text>'; }
    const every = n > 40 ? Math.ceil(n / 20) : n > 16 ? 2 : 1;
    keys.forEach((k, i) => {
      const x = padL + step * i + (step - bw) / 2; let y = padT + innerH;
      ams.forEach(a => { const v = cells[i][String(a.id)] || 0; if (!v) return; const h = innerH * v / top; y -= h; out += '<rect class="seg" data-i="' + i + '" x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="2" fill="' + a.color + '"/>'; });
      out += '<rect class="hit" data-i="' + i + '" x="' + (padL + step * i) + '" y="' + padT + '" width="' + step + '" height="' + innerH + '" fill="transparent"/>';
      if (i % every === 0) out += '<text class="tick" x="' + (x + bw / 2) + '" y="' + (Hh - 6) + '" text-anchor="middle">' + esc(label[k]) + '</text>';
    });
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Hh); svg.innerHTML = out;
    svg.querySelectorAll('.hit').forEach(h => {
      h.onmouseenter = () => { const i = +h.dataset.i; box.classList.add('hovering'); svg.querySelectorAll('rect.seg').forEach(s => s.classList.toggle('on', +s.dataset.i === i));
        const tot = Object.values(cells[i]).reduce((s, v) => s + v, 0);
        tip.innerHTML = '<div><b style="margin:0">' + esc(label[keys[i]]) + '</b> · ' + tot + '</div>' + ams.filter(a => cells[i][String(a.id)]).map(a => '<div class="row"><i class="ra-dot" style="background:' + a.color + '"></i>' + esc(a.name) + '<b>' + cells[i][String(a.id)] + '</b></div>').join('');
        tip.hidden = false; const r = h.getBoundingClientRect(), b = box.getBoundingClientRect(); tip.style.left = (r.left - b.left + r.width / 2) + 'px'; tip.style.top = (padT + innerH - innerH * tot / top) * (b.height / Hh) + 'px'; };
      h.onmouseleave = () => { box.classList.remove('hovering'); tip.hidden = true; };
    });
  }
  window.addEventListener('resize', () => drawChart());

  // ---- the table (NovaTable header filters, pinned header)
  function specs() {
    const rows = data._base || [], uniq = (f) => rows.map(f).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).sort();
    return {
      date: { type: 'range', kind: 'date', presets: [{ v: '', l: 'Whole period' }], period: OF.date.period, from: OF.date.from, to: OF.date.to },
      client: { type: 'text', value: OF.client },
      am: [{ v: '', l: 'Any account manager' }].concat((data._ams || []).map(a => ({ v: String(a.id), l: a.name, h: NovaTable.face(a.photo || '', a.name) }))),
      src: [{ v: '', l: 'Any source' }].concat(uniq(r => r.source.kind).map(k => ({ v: k, l: k }))),
      via: [{ v: '', l: 'Any method' }].concat(uniq(r => r.via_code).map(k => ({ v: k, l: (rows.find(r => r.via_code === k) || {}).via || k }))),
      rating: [{ v: '', l: 'Any rating' }].concat(uniq(r => r.rating).map(k => ({ v: k, l: ratingLabel(k) })))
    };
  }
  const ratingLabel = (k) => ({ high_potential: 'High potential', developing: 'Developing opportunity', developing_opportunity: 'Developing opportunity', limited: 'Limited opportunity', limited_opportunity: 'Limited opportunity' }[k] || String(k || '').replace(/_/g, ' '));
  const ratingTag = (k) => !k ? '' : '<span class="ra-tag ' + (/high/.test(k) ? 'hi' : /develop/.test(k) ? 'dev' : 'lo') + '">' + esc(ratingLabel(k)) + '</span>';
  const srcCls = (k) => String(k || '').toLowerCase().replace(/[^a-z]/g, '');
  function drawTable(rows) {
    const S = specs(), T = (k, l) => NovaTable.th(k, l, S[k], k === 'date' ? '' : k === 'am' ? amPick : OF[k]);
    $('obList').innerHTML = '<h2>Onboardings <span class="n">' + rows.length + ' of ' + (data._base || []).length + '</span></h2>' +
      (rows.length ? '<table class="ra"><thead><tr id="obHead"><th>' + T('date', 'Onboarded') + '</th><th>' + T('client', 'Client') + '</th><th>' + T('am', 'AM') + '</th><th>' + T('src', 'Source') + '</th><th>' + T('via', 'Onboarded via') + '</th><th>' + T('rating', 'Lead rating') + '</th><th>Budget</th></tr></thead><tbody>' +
        rows.map(r => '<tr' + (r.not_onboarded ? ' style="opacity:.6"' : '') + '><td><b>' + esc(usD(r.date)) + '</b></td>' +
          '<td><b>' + esc(r.customer.company || r.customer.person || ('Customer #' + r.customer.id)) + '</b><div class="sub">' + esc([r.customer.company ? r.customer.person : '', r.customer.email].filter(Boolean).join(' · ')) + '</div></td>' +
          '<td><div class="ra-who">' + face(r.am, 'sm') + '<span>' + esc(r.am.name) + '</span></div></td>' +
          '<td><span class="ra-src ' + srcCls(r.source.kind) + '">' + esc(r.source.kind) + '</span>' + (r.source.who ? '<div class="sub">from ' + esc(r.source.who) + '</div>' : (r.source.raw && r.source.raw.toLowerCase() !== r.source.kind.toLowerCase() && !/^(google|google_ads|chatgpt|existing_client|employee_referral|other)$/i.test(r.source.raw) ? '<div class="sub" title="as written on the form">' + esc(r.source.raw) + '</div>' : '')) + '</td>' +
          '<td>' + (r.not_onboarded ? '<span class="ra-tag no">Did not onboard</span>' : esc(r.via || '—')) + (r.via_other ? '<div class="sub">' + esc(r.via_other) + '</div>' : '') + '</td>' +
          '<td>' + ratingTag(r.rating) + '</td><td class="sub">' + esc(r.budget || '') + (r.value ? '<div>est. $' + Number(r.value).toLocaleString('en-US') + '</div>' : '') + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="ra-muted">Nothing matches.</div>');
    const tr = $('obHead'); if (!tr) return;
    NovaTable.bind(tr, S, (k, v) => { if (k === 'date') OF.date = { from: (v && v.from) || '', to: (v && v.to) || '', period: '' }; else if (k === 'am') amPick = typeof v === 'string' ? v : ''; else OF[k] = typeof v === 'string' ? v : ''; render(); });
    NovaTable.pin(tr.closest('table'));
  }

  /* the Email report card is mounted by RaEmailCard below (1.20.100) */

  load();
})();

// ---- Product Report (1.20.98): what sells, what is cooling down, what brings new clients, what takes longest in production.
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token'); if (!token) return;
  const H = () => ({ 'Authorization': 'Bearer ' + token });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const usD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '/' + m[3] + '/' + m[1] : String(d || ''); };
  const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd0 = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const r1 = (n) => n == null ? '—' : Math.round(n * 10) / 10;
  const unit = (n) => n == null ? '—' : n >= 10 ? usd(n) : '$' + Number(n).toFixed(n >= 1 ? 2 : 3);

  // tabs
  document.querySelectorAll('.ra-tabs button[data-v]').forEach(b => b.onclick = () => {
    document.querySelectorAll('.ra-tabs button[data-v]').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.ra-view').forEach(v => v.classList.toggle('on', v.dataset.v === b.dataset.v));
    if (b.dataset.v === 'products' && !data) load();
    if (window.RaTabs && RaTabs[b.dataset.v]) RaTabs[b.dataset.v]();
    try { history.replaceState(null, '', '?tab=' + b.dataset.v); } catch (e) { /* ignore */ }
  });
  window.RaTabs = window.RaTabs || {};

  const PS = { period: '30', from: '', to: '' }; let by = 'rev', data = null;
  const PF = { product: '', cat: '', orders: { from: '', to: '' }, rev: { from: '', to: '' }, trend: '', prod: { from: '', to: '' } };
  const range = () => RaPeriod.range(PS);
  RaPeriod.wire('prPeriod', PS, load);
  document.querySelectorAll('#prBy button[data-b]').forEach(b => b.onclick = () => setBy(b.dataset.b));
  { let t = null; $('prQ').oninput = () => { clearTimeout(t); t = setTimeout(render, 250); }; }

  async function load() {
    const [from, to] = range(); if (!from) { $('prList').innerHTML = '<div class="ra-muted">Pick a start date.</div>'; return; }
    $('prList').innerHTML = '<div class="ra-muted">Reading the orders from the CRM…</div>'; $('prKpis').innerHTML = ''; $('prChart').innerHTML = '';
    let j; try { const r = await fetch('/api/reports-ai/products?from=' + from + '&to=' + to, { headers: H() }); if (r.status === 401 || r.status === 403) { location.href = '/'; return; } j = await r.json(); } catch (e) { j = { ok: false, error: 'The CRM did not answer' }; }
    if (!j.ok) { $('prList').innerHTML = '<div class="ra-muted" style="color:#b91c1c">' + esc(j.error || 'Could not load') + '</div>'; return; }
    j.products.forEach(p => { p.trend_kind = trendKind(p); p.conv = p.cur.orders + p.cur.quotes ? Math.round(p.cur.orders / (p.cur.orders + p.cur.quotes) * 100) : null; });
    data = j; $('prVs').textContent = usD(j.from) + ' – ' + usD(j.to) + ' · compared with ' + usD(j.prev_from) + ' – ' + usD(j.prev_to) + (j.ms ? ' · ' + (j.ms / 1000).toFixed(1) + ' s' : '');
    render();
  }
  // rising = revenue up 25%+ on 3+ orders, cooling = down 25%+ from 3+ orders before, new = nothing in the period before, gone = nothing now
  function trendKind(p) {
    const c = p.cur, v = p.prev;
    if (!v.orders && c.orders) return 'new'; if (v.orders && !c.orders) return 'gone'; if (!c.orders && !v.orders) return 'quotes';
    if (c.orders >= 3 && p.trend.rev >= 25) return 'up'; if (v.orders >= 3 && p.trend.rev <= -25) return 'down'; return 'flat';
  }
  const TREND_L = { up: 'Heating up', down: 'Cooling down', flat: 'Steady', new: 'New this period', gone: 'No orders now', quotes: 'Quotes only' };
  const arrow = (pct, suffix) => pct == null ? '<span class="ra-tr flat">new</span>' : pct === 0 ? '<span class="ra-tr flat">=</span>' : '<span class="ra-tr ' + (pct > 0 ? 'up' : 'down') + '" title="vs the period before">' + (pct > 0 ? '▲' : '▼') + Math.abs(pct) + '%' + (suffix || '') + '</span>';

  function passes(p) {
    const q = $('prQ').value.trim().toLowerCase();
    if (q && (p.title + ' ' + p.category).toLowerCase().indexOf(q) < 0) return false;
    if (PF.product && p.title.toLowerCase().indexOf(PF.product.toLowerCase()) < 0) return false;
    if (PF.cat && p.category !== PF.cat) return false;
    if (PF.trend && p.trend_kind !== PF.trend) return false;
    if (PF.orders.from !== '' && p.cur.orders < +PF.orders.from) return false; if (PF.orders.to !== '' && p.cur.orders > +PF.orders.to) return false;
    if (PF.rev.from !== '' && p.cur.rev < +PF.rev.from) return false; if (PF.rev.to !== '' && p.cur.rev > +PF.rev.to) return false;
    if (PF.prod.from !== '' && (p.cur.prod_med == null || p.cur.prod_med < +PF.prod.from)) return false; if (PF.prod.to !== '' && (p.cur.prod_med == null || p.cur.prod_med > +PF.prod.to)) return false;
    return true;
  }
  function render() {
    if (!data) return;
    const rows = data.products.filter(passes); data._rows = rows;
    drawKpis(data.products); drawChart(); drawTable(rows);
  }
  const pimg = (p, cls) => p.image ? '<img class="' + (cls || '') + '" src="' + esc(p.image) + '" alt="" onerror="this.remove()">' : '';
  function kpi(label, cls, p, value, sub, mode) {
    return '<div class="ra-kpi"' + (mode ? ' data-b="' + mode + '" title="Show this list on the chart"' : '') + '><div class="l ' + (cls || '') + '">' + label + '</div>' + (p ? '<div class="p">' + pimg(p) + '<span>' + esc(p.title) + '</span></div><div class="v">' + value + (sub ? ' <span class="ra-muted">· ' + sub + '</span>' : '') + '</div>' : '<div class="ra-muted">Not enough data</div>') + '</div>';
  }
  function drawKpis(all) {
    const sold = all.filter(p => p.cur.orders > 0);
    const byRev = sold.slice().sort((a, b) => b.cur.rev - a.cur.rev)[0];
    const byQty = sold.slice().sort((a, b) => b.cur.qty - a.cur.qty)[0];
    const byOrders = sold.slice().sort((a, b) => b.cur.orders - a.cur.orders)[0];
    const byReo = sold.filter(p => p.cur.reorders > 0).sort((a, b) => b.cur.reorders - a.cur.reorders)[0];
    const up = sold.filter(p => p.trend_kind === 'up' && p.prev.orders >= 2).sort((a, b) => (b.cur.rev - b.prev.rev) - (a.cur.rev - a.prev.rev))[0];
    const down = all.filter(p => (p.trend_kind === 'down' || p.trend_kind === 'gone') && p.prev.orders >= 3).sort((a, b) => (a.cur.rev - a.prev.rev) - (b.cur.rev - b.prev.rev))[0];
    const magnet = sold.filter(p => p.cur.new_clients > 0).sort((a, b) => b.cur.new_clients - a.cur.new_clients || b.cur.new_rev - a.cur.new_rev)[0];
    const timed = sold.filter(p => p.cur.prod_n >= 3);
    const slow = timed.slice().sort((a, b) => b.cur.prod_med - a.cur.prod_med)[0];
    const fast = timed.slice().sort((a, b) => a.cur.prod_med - b.cur.prod_med)[0];
    const d = (p) => p ? r1(p.cur.prod_med) + ' days typical' : '';
    $('prKpis').innerHTML =
      kpi('Top seller · revenue', '', byRev, byRev && '<b>' + usd0(byRev.cur.rev) + '</b>', byRev && byRev.cur.orders + ' orders ' + arrow(byRev.trend.rev), 'rev') +
      kpi('Most units sold', '', byQty, byQty && '<b>' + num(byQty.cur.qty) + '</b> pcs', byQty && unit(byQty.cur.unit_price) + ' each', 'qty') +
      kpi('Most orders', '', byOrders, byOrders && '<b>' + byOrders.cur.orders + '</b> orders', byOrders && byOrders.cur.clients + ' clients ' + arrow(byOrders.trend.orders), 'orders') +
      kpi('Most reorders', '', byReo, byReo && '<b>' + byReo.cur.reorders + '</b> reorders', byReo && Math.round(byReo.cur.reorders / byReo.cur.orders * 100) + '% of its orders', 'reorders') +
      kpi('Heating up', 'up', up, up && '<b>' + usd0(up.cur.rev) + '</b> ' + arrow(up.trend.rev), up && 'was ' + usd0(up.prev.rev), 'up') +
      kpi('Cooling down', 'down', down, down && '<b>' + usd0(down.cur.rev) + '</b> ' + arrow(down.trend.rev), down && 'was ' + usd0(down.prev.rev) + ' · ' + down.prev.orders + ' orders', 'down') +
      kpi('Brings new clients', '', magnet, magnet && '<b>' + magnet.cur.new_clients + '</b> first-time clients', magnet && usd0(magnet.cur.new_rev) + ' from them', 'new_clients') +
      kpi('Longest in production', 'down', slow, slow && '<b>' + d(slow) + '</b>', slow && 'avg ' + r1(slow.cur.prod_avg) + ' · ' + slow.cur.prod_n + ' jobs', 'slow') +
      kpi('Shortest in production', 'up', fast, fast && '<b>' + d(fast) + '</b>', fast && 'avg ' + r1(fast.cur.prod_avg) + ' · ' + fast.cur.prod_n + ' jobs', 'fast');
    $('prKpis').querySelectorAll('.ra-kpi[data-b]').forEach(k => k.onclick = () => setBy(k.dataset.b));
  }
  // the chart's views: plain measures, and the ranked lists behind the tiles (so more than one product shows for each).
  // cols = the three figure columns at the right (1.20.104); a click on a product name lists its jobs (E-numbers) under the row.
  const pct = (p) => arrow(p);
  const MODES = {
    rev: { t: 'Revenue by product', v: p => p.cur.rev, pv: p => p.prev.rev, cols: [['Revenue', p => '<b>' + usd0(p.cur.rev) + '</b>'], ['vs before', p => pct(p.trend.rev)], ['Before', p => usd0(p.prev.rev)]] },
    qty: { t: 'Units by product', v: p => p.cur.qty, pv: p => p.prev.qty, cols: [['Units', p => '<b>' + num(p.cur.qty) + '</b>'], ['vs before', p => pct(p.trend.qty)], ['Per unit', p => unit(p.cur.unit_price)]] },
    orders: { t: 'Orders by product', v: p => p.cur.orders, pv: p => p.prev.orders, cols: [['Orders', p => '<b>' + num(p.cur.orders) + '</b>'], ['vs before', p => pct(p.trend.orders)], ['Clients', p => num(p.cur.clients)]] },
    new_clients: { t: 'New clients by product', v: p => p.cur.new_clients, pv: p => p.prev.new_clients, cols: [['New clients', p => '<b>' + num(p.cur.new_clients) + '</b>'], ['Before', p => num(p.prev.new_clients)], ['Their revenue', p => usd0(p.cur.new_rev)]] },
    reorders: { t: 'Most reorders', v: p => p.cur.reorders, pv: p => p.prev.reorders, cols: [['Reorders', p => '<b>' + num(p.cur.reorders) + '</b>'], ['Of orders', p => p.cur.orders ? Math.round(p.cur.reorders / p.cur.orders * 100) + '%' : '—'], ['Orders', p => num(p.cur.orders)]] },
    up: { t: 'Heating up — revenue gained vs the period before', keep: p => p.trend_kind === 'up' && p.prev.orders >= 2, sort: (a, b) => (b.cur.rev - b.prev.rev) - (a.cur.rev - a.prev.rev), v: p => p.cur.rev, pv: p => p.prev.rev, cols: [['Revenue', p => '<b>' + usd0(p.cur.rev) + '</b>'], ['Change', p => pct(p.trend.rev)], ['Was', p => usd0(p.prev.rev)]] },
    down: { t: 'Cooling down — revenue lost vs the period before', keep: p => (p.trend_kind === 'down' || p.trend_kind === 'gone') && p.prev.orders >= 3, sort: (a, b) => (a.cur.rev - a.prev.rev) - (b.cur.rev - b.prev.rev), v: p => p.cur.rev, pv: p => p.prev.rev, cols: [['Revenue', p => '<b>' + usd0(p.cur.rev) + '</b>'], ['Change', p => pct(p.trend.rev)], ['Was', p => usd0(p.prev.rev) + ' <span class="sub">· ' + p.prev.orders + ' ord</span>']] },
    slow: { t: 'Longest in production — typical days (3+ timed jobs)', keep: p => p.cur.prod_n >= 3, sort: (a, b) => b.cur.prod_med - a.cur.prod_med, v: p => p.cur.prod_med, pv: p => p.prev.prod_med || 0, cols: [['Typical', p => '<b>' + r1(p.cur.prod_med) + ' d</b>'], ['Average', p => r1(p.cur.prod_avg) + ' d'], ['Jobs', p => p.cur.prod_n + ' <span class="sub">· max ' + r1(p.cur.prod_max) + '</span>']] },
    fast: { t: 'Shortest in production — typical days (3+ timed jobs)', keep: p => p.cur.prod_n >= 3, sort: (a, b) => a.cur.prod_med - b.cur.prod_med, v: p => p.cur.prod_med, pv: p => p.prev.prod_med || 0, cols: [['Typical', p => '<b>' + r1(p.cur.prod_med) + ' d</b>'], ['Average', p => r1(p.cur.prod_avg) + ' d'], ['Jobs', p => p.cur.prod_n + ' <span class="sub">· max ' + r1(p.cur.prod_max) + '</span>']] }
  };
  let openJobs = null;   /* the product whose jobs are listed under its chart row */
  function drawChart() {
    if (!data) return; const M = MODES[by] || MODES.rev, all = data._rows || [];
    const rows = all.filter(M.keep || (p => M.v(p) > 0)).sort(M.sort || ((a, b) => M.v(b) - M.v(a))).slice(0, 20);
    const max = rows.reduce((m, p) => Math.max(m, M.v(p), M.pv(p)), 0) || 1;
    $('prChartT').textContent = M.t; $('prChartN').textContent = 'top ' + rows.length + ' of ' + all.length + ' · thin bar = the period before · click a product for its jobs';
    document.querySelectorAll('#prKpis .ra-kpi[data-b]').forEach(k => k.classList.toggle('on', k.dataset.b === by));
    $('prChart').innerHTML = rows.length ? '<div class="h">Product</div><div class="h"></div>' + M.cols.map(c => '<div class="h r">' + c[0] + '</div>').join('') +
      rows.map(p => '<div class="nm" data-pid="' + p.pid + '" title="' + esc(p.title) + ' — show the jobs">' + pimg(p) + '<span>' + esc(p.title) + '</span><i class="car">' + (openJobs === p.pid ? '▲' : '▼') + '</i></div><div class="bar" data-pid="' + p.pid + '"><i style="width:' + (M.v(p) / max * 100) + '%"></i><i class="prev" style="width:' + (M.pv(p) / max * 100) + '%"></i></div>' + M.cols.map(c => '<div class="c" data-pid="' + p.pid + '" data-hover="1">' + c[1](p) + '</div>').join('') + (openJobs === p.pid ? '<div class="ra-jobs" data-jobs="' + p.pid + '"><span class="ra-muted">Reading the jobs…</span></div>' : '')).join('') : '<div class="ra-muted" style="grid-column:1/-1">Nothing in this view for the period.</div>';
    /* the whole row opens the jobs; hovering a figure shows the E-numbers behind it (1.20.106) */
    $('prChart').querySelectorAll('[data-pid]').forEach(el => { el.onclick = () => { const pid = +el.dataset.pid; openJobs = openJobs === pid ? null : pid; drawChart(); }; if (el.dataset.hover) el.onmouseenter = () => hoverJobs(+el.dataset.pid, el); });
    const box = $('prChart').querySelector('[data-jobs]'); if (box) loadJobs(+box.dataset.jobs, box);
  }
  const jobsCache = {};
  async function fetchJobs(pid) {
    const k = pid + ':' + data.from + ':' + data.to; if (jobsCache[k]) return jobsCache[k];
    let j; try { const r = await fetch('/api/reports-ai/products/' + pid + '/jobs?from=' + data.from + '&to=' + data.to, { headers: H() }); j = await r.json(); } catch (e) { j = { ok: false, error: 'The CRM did not answer' }; }
    if (j.ok) jobsCache[k] = j; return j;
  }
  async function hoverJobs(pid, el) {
    if (el.title) return; el.title = 'Reading the jobs…';
    const j = await fetchJobs(pid); if (!j.ok) { el.title = j.error || ''; return; }
    const jobs = j.jobs.filter(x => !x.canceled && x.invoiced), prod = by === 'slow' || by === 'fast';
    const list = (prod ? jobs.filter(x => x.prod_days != null).sort((a, b) => b.prod_days - a.prod_days) : jobs).slice(0, 25);
    el.title = (prod ? list.length + ' timed jobs' : jobs.length + ' jobs') + ' — click for the full list\n' + list.map(x => x.e + (prod ? '  ' + x.prod_days + ' d' : '  ' + usd0(x.price)) + (x.client ? '  ' + x.client : '')).join('\n') + (jobs.length > list.length ? '\n…' : '');
  }
  const dt = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : '—';
  async function loadJobs(pid, box) {
    const j = await fetchJobs(pid);
    if (!box.isConnected) return;
    if (!j.ok) { box.innerHTML = '<span style="color:#b91c1c">' + esc(j.error || 'Could not load') + '</span>'; return; }
    const jobs = j.jobs.filter(x => !x.canceled), timed = jobs.filter(x => x.prod_days != null).length;
    const prodMode = by === 'slow' || by === 'fast';
    const sorted = prodMode ? jobs.slice().sort((a, b) => (b.prod_days || -1) - (a.prod_days || -1)) : jobs;
    box.innerHTML = '<div style="margin-bottom:6px"><b>' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') + '</b> <span class="ra-muted">· ' + jobs.filter(x => x.invoiced).length + ' invoiced · ' + timed + ' timed in production · ' + (j.jobs.length - jobs.length) + ' canceled left out</span></div>' +
      '<table><thead><tr><th>Job</th><th>Name</th><th>Client</th><th class="n">Qty</th><th class="n">Price</th><th>Created</th><th>Prod. started</th><th>Done</th><th class="n">Prod. days</th><th class="n">Order → ready</th><th>On time</th></tr></thead><tbody>' +
      sorted.map(x => '<tr' + (!x.invoiced ? ' class="off" title="quote — not invoiced"' : '') + '><td class="e">' + x.e + (x.type === 'reorder' ? ' <span class="ra-muted">re</span>' : '') + (x.express ? ' <span style="color:#b91c1c">exp</span>' : '') + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.client) + '</td><td class="n">' + (x.qty != null ? num(x.qty) : '—') + '</td><td class="n">' + usd0(x.price) + '</td><td>' + dt(x.created) + '</td><td>' + dt(x.started) + '</td><td>' + dt(x.done) + '</td><td class="n">' + (x.prod_days != null ? '<b>' + x.prod_days + '</b>' : '—') + '</td><td class="n">' + (x.o2r_days != null ? x.o2r_days : '—') + '</td><td>' + (x.on_time == null ? '—' : x.on_time ? '<span class="ok">yes</span>' : '<span class="late">late</span>') + '</td></tr>').join('') + '</tbody></table>';
  }
  const setBy = (b) => { by = b; document.querySelectorAll('#prBy button[data-b]').forEach(x => x.classList.toggle('on', x.dataset.b === b)); drawChart(); };
  function specs() {
    const all = data.products, uniq = (f) => all.map(f).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).sort();
    return {
      product: { type: 'text', value: PF.product },
      cat: [{ v: '', l: 'Any category' }].concat(uniq(p => p.category).map(c => ({ v: c, l: c }))),
      orders: { type: 'range', kind: 'number', presets: [{ v: '', l: 'Any' }], from: PF.orders.from, to: PF.orders.to },
      rev: { type: 'range', kind: 'number', presets: [{ v: '', l: 'Any' }], from: PF.rev.from, to: PF.rev.to },
      trend: [{ v: '', l: 'Any' }].concat(['up', 'down', 'flat', 'new', 'gone', 'quotes'].map(k => ({ v: k, l: TREND_L[k], sub: String(all.filter(p => p.trend_kind === k).length) }))),
      prod: { type: 'range', kind: 'number', presets: [{ v: '', l: 'Any' }], from: PF.prod.from, to: PF.prod.to }
    };
  }
  const cur = (k) => k === 'product' ? PF.product : k === 'cat' ? PF.cat : k === 'trend' ? PF.trend : '';
  function drawTable(rows) {
    const S = specs(), T = (k, l) => NovaTable.th(k, l, S[k], cur(k));
    const tot = rows.reduce((a, p) => { a.orders += p.cur.orders; a.qty += p.cur.qty; a.rev += p.cur.rev; a.nc += p.cur.new_clients; a.po += p.prev.orders; a.prev += p.prev.rev; return a; }, { orders: 0, qty: 0, rev: 0, nc: 0, po: 0, prev: 0 });
    const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
    $('prList').innerHTML = '<h2>Products <span class="n">' + rows.length + ' of ' + data.products.length + ' · ' + num(tot.orders) + ' orders · ' + usd0(tot.rev) + ' ' + arrow(pct(tot.rev, tot.prev)) + '</span></h2>' +
      (rows.length ? '<table class="ra pr"><thead><tr id="prHead"><th>' + T('product', 'Product') + '</th><th>' + T('cat', 'Category') + '</th><th class="num">' + T('orders', 'Orders') + '</th><th class="num">Units</th><th class="num">' + T('rev', 'Revenue') + '</th><th class="num">Avg order</th><th class="num">Per unit</th><th class="num">Clients · new</th><th class="num">Reorders</th><th class="num">Quotes → orders</th><th>' + T('trend', 'Trend') + '</th><th class="num">' + T('prod', 'Production days') + '</th><th class="num">On time</th></tr></thead><tbody>' +
        rows.map(p => { const c = p.cur, v = p.prev; return '<tr>' +
          '<td>' + pimg(p, 'ra-pimg') + '<b>' + esc(p.title) + '</b><div class="sub">#' + p.pid + (p.active === false ? ' · inactive' : '') + (c.express ? ' · ' + c.express + ' express' : '') + (c.design ? ' · ' + c.design + ' with design fee' : '') + '</div></td>' +
          '<td class="sub">' + esc(p.category) + '</td>' +
          '<td class="num"><b>' + num(c.orders) + '</b><div class="sub">' + arrow(p.trend.orders) + ' <span title="the period before">' + num(v.orders) + '</span></div></td>' +
          '<td class="num">' + num(c.qty) + '<div class="sub">' + arrow(p.trend.qty) + '</div></td>' +
          '<td class="num"><b>' + usd0(c.rev) + '</b><div class="sub">' + arrow(p.trend.rev) + ' <span title="the period before">' + usd0(v.rev) + '</span></div></td>' +
          '<td class="num">' + (c.avg_order != null ? usd0(c.avg_order) : '—') + '</td>' +
          '<td class="num">' + unit(c.unit_price) + (p.trend.unit != null && p.trend.unit !== 0 ? '<div class="sub">' + arrow(p.trend.unit) + '</div>' : '') + '</td>' +
          '<td class="num">' + c.clients + (c.new_clients ? ' · <b style="color:#047857" title="customers whose first ever order was this product">' + c.new_clients + ' new</b>' : '') + (c.new_rev ? '<div class="sub">' + usd0(c.new_rev) + ' from new</div>' : '') + '</td>' +
          '<td class="num">' + (c.orders ? Math.round(c.reorders / c.orders * 100) + '%' : '—') + '<div class="sub">' + c.reorders + '</div></td>' +
          '<td class="num">' + (p.conv != null ? p.conv + '%' : '—') + '<div class="sub">' + c.quotes + ' quote' + (c.quotes === 1 ? '' : 's') + '</div></td>' +
          '<td><span class="ra-tr ' + (p.trend_kind === 'up' ? 'up' : p.trend_kind === 'down' || p.trend_kind === 'gone' ? 'down' : 'flat') + '">' + TREND_L[p.trend_kind] + '</span></td>' +
          '<td class="num">' + (c.prod_med != null ? '<b>' + r1(c.prod_med) + '</b> <span class="sub">typical · avg ' + r1(c.prod_avg) + ' · max ' + r1(c.prod_max) + '</span><div class="sub">' + c.prod_n + ' timed job' + (c.prod_n === 1 ? '' : 's') + (c.o2r_med != null ? ' · order → ready ' + r1(c.o2r_med) + ' d' : '') + '</div>' : '<span class="sub">—</span>') + '</td>' +
          '<td class="num">' + (c.ontime != null ? '<b style="color:' + (c.ontime >= 90 ? '#047857' : c.ontime >= 70 ? '#b45309' : '#b91c1c') + '">' + c.ontime + '%</b><div class="sub">of ' + c.timed + '</div>' : '—') + '</td></tr>'; }).join('') +
        '<tr><td><b>Total</b></td><td></td><td class="num"><b>' + num(tot.orders) + '</b><div class="sub">' + arrow(pct(tot.orders, tot.po)) + '</div></td><td class="num">' + num(tot.qty) + '</td><td class="num"><b>' + usd0(tot.rev) + '</b><div class="sub">' + arrow(pct(tot.rev, tot.prev)) + '</div></td><td class="num">' + (tot.orders ? usd0(tot.rev / tot.orders) : '') + '</td><td></td><td class="num">' + tot.nc + ' new</td><td colspan="5"></td></tr></tbody></table>'
        : '<div class="ra-muted">Nothing matches.</div>');
    const tr = $('prHead'); if (!tr) return;
    NovaTable.bind(tr, S, (k, v) => { if (k === 'orders' || k === 'rev' || k === 'prod') PF[k] = { from: v && v.from != null ? String(v.from) : '', to: v && v.to != null ? String(v.to) : '' }; else PF[k] = typeof v === 'string' ? v : ''; render(); });
    NovaTable.pin(tr.closest('table'));
  }
  const m0 = /[?&]tab=(\w+)/.exec(location.search); const t0 = m0 && document.querySelector('.ra-tabs button[data-v="' + m0[1] + '"]'); if (t0) setTimeout(() => t0.click(), 0);
})();

// ---- the shared Email report card (1.20.100): one per report — settings, Send now, what was sent. RaEmailCard.mount(box, labels)
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token'); if (!token) return;
  const H = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const usD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '-' + m[3] + '-' + m[1] : String(d || ''); };
  const api = async (url, body) => { const r = await fetch(url, body ? { method: 'POST', headers: H(), body: JSON.stringify(body) } : { headers: H() }); return r.json(); };
  function mount(box, L) {
    if (!box) return; const report = box.dataset.report, q = (sel) => box.querySelector(sel);
    const flag = report === 'clients' ? 'all_ams' : 'per_am';
    box.innerHTML = '<h2>Email report <span class="n" data-when></span><span class="sp"></span><span class="ra-switch" data-on title="Send the report"></span></h2>' +
      '<div class="ra-email"><label>Timespan<select data-span><option value="month">Previous month</option><option value="30">Last 30 days</option><option value="week">Previous week (Mon–Sun)</option></select></label>' +
      '<label>Send on<select data-day>' + Array.from({ length: 28 }, (_, i) => '<option value="' + (i + 1) + '">' + (i + 1) + (i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th') + ' of the month</option>').join('') + '</select></label>' +
      '<label>At (Los Angeles)<input data-at placeholder="07:00"></label><label>Send to<input data-to placeholder="gary@axiomprint.com"></label><label>CC<input data-cc placeholder="one or more, separated by commas"></label>' +
      '<label class="chk"><input type="checkbox" data-flag> <span data-flaglabel>' + esc(L[flag] || '') + '</span></label>' +
      '<div class="acts"><button class="bk-btn pri" data-save>Save</button><button class="bk-btn" data-send>Send now</button><span class="msg" data-msg></span></div></div><div class="ra-sent" data-sent></div>';
    const body = () => ({ enabled: q('[data-on]').classList.contains('on'), span: q('[data-span]').value, day: q('[data-day]').value, at: q('[data-at]').value.trim(), to: q('[data-to]').value.trim(), cc: q('[data-cc]').value.trim(), [flag]: q('[data-flag]').checked });
    async function load() {
      const j = await api('/api/reports-ai/' + report + '/email'); if (!j.ok) { q('[data-msg]').textContent = j.error || ''; return; }
      const em = j.settings; q('[data-span]').value = em.span; q('[data-day]').value = String(em.day || 1); q('[data-at]').value = em.at || '07:00'; q('[data-to]').value = em.to || ''; q('[data-cc]').value = em.cc || ''; q('[data-flag]').checked = !!em[flag];
      if (flag === 'all_ams' && j.ams) q('[data-flaglabel]').textContent = (L.all_ams || 'Also send to every account manager') + ' (' + j.ams.length + ': ' + j.ams.map(a => a.name.split(' ')[0]).join(', ') + ')';
      q('[data-on]').classList.toggle('on', !!em.enabled);
      q('[data-when]').textContent = (em.enabled ? 'if sent today it would cover ' : 'off — would cover ') + j.preview + (j.notify_on === false ? ' · switched off under Admin → Emails' : '');
      q('[data-day]').parentElement.style.display = em.span === 'week' ? 'none' : '';
      q('[data-sent]').innerHTML = (j.sent || []).length ? '<div><b>Sent</b></div>' + j.sent.map(x => '<div>' + esc(usD(String(x.at).slice(0, 10))) + ' · ' + (x.kind === 'owner' ? 'report' : 'AM copy') + ' → ' + esc(x.to_addr) + (x.cc ? ' cc ' + esc(x.cc) : '') + ' · ' + x.n + ' · ' + esc(String(x.period_key).replace(/^\w+:/, '')) + '</div>').join('') : '';
    }
    q('[data-on]').onclick = async () => { q('[data-on]').classList.toggle('on'); const j = await api('/api/reports-ai/' + report + '/email', body()); q('[data-msg]').textContent = j.ok ? 'Saved.' : (j.error || 'Could not save'); load(); };
    q('[data-span]').onchange = () => { q('[data-day]').parentElement.style.display = q('[data-span]').value === 'week' ? 'none' : ''; };
    q('[data-save]').onclick = async () => { q('[data-msg]').textContent = 'Saving…'; const j = await api('/api/reports-ai/' + report + '/email', body()); q('[data-msg]').textContent = j.ok ? 'Saved.' : (j.error || 'Could not save'); if (j.ok) load(); };
    q('[data-send]').onclick = async () => { if (!confirm((L.confirm || 'Send this report now, for the timespan above, to the addresses above') + (q('[data-flag]').checked ? ' — and ' + (L.am_part || (flag === 'all_ams' ? 'to every account manager' : 'to each account manager who onboarded')) : '') + '?')) return; q('[data-msg]').textContent = 'Sending…'; const j = await api('/api/reports-ai/' + report + '/email/send', { span: q('[data-span]').value }); q('[data-msg]').textContent = j.ok && j.sent ? 'Sent: ' + j.period + ' — ' + j.n + ' ' + (L.noun || 'rows') + ' to ' + (j.owner && j.owner.to) + (j.ams && j.ams.length ? ' + ' + j.ams.length + ' AM' + (j.ams.length === 1 ? '' : 's') : '') : (j.error || 'Not sent'); load(); };
    load();
  }
  window.RaEmailCard = { mount };
  mount(document.getElementById('obEmail'), { per_am: 'Also email each account manager their own onboardings', confirm: 'Send the onboarding report now, for the timespan above, to the addresses above', noun: 'onboardings' });
  mount(document.getElementById('clEmail'), { all_ams: 'Also send the same report to every account manager', confirm: 'Send the new-clients report now, for the timespan above, to the addresses above', noun: 'new clients' });
  mount(document.getElementById('rfEmail'), { per_am: 'Also email each account manager their own referral list (the referred clients on their account + the referrals they made)', confirm: 'Send the referral report now, for the timespan above, to the addresses above', am_part: 'each account manager their own referral list', noun: 'referrals' });
})();

// ---- New Clients + Referral Report (1.20.100)
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token'); if (!token) return;
  const H = () => ({ 'Authorization': 'Bearer ' + token });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const usD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '/' + m[3] + '/' + m[1] : String(d || ''); };
  const usd0 = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const COLORS = ['#4f46e5', '#059669', '#d97706', '#db2777', '#0891b2', '#7c3aed', '#dc2626', '#65a30d', '#0d9488', '#9333ea', '#ea580c', '#2563eb', '#6b7280'];
  const face = (p, cls) => { const ini = esc(String(p.name || '?').trim().charAt(0).toUpperCase()); return p.photo ? '<img class="ra-av ' + (cls || '') + '" src="' + esc(p.photo) + '" alt="" title="' + esc(p.name) + '" onerror="this.outerHTML=\'<span class=&quot;ra-av ' + (cls || '') + '&quot;>' + ini + '</span>\'">' : '<span class="ra-av ' + (cls || '') + '" title="' + esc(p.name) + '">' + ini + '</span>'; };
  const WEB = '<span class="web" title="Signed up on the website"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg></span>';
  const made = (r) => r.made.kind === 'web' ? '<span class="ra-made">' + WEB + '<span>Website</span></span>' : r.made.kind === 'team' ? '<span class="ra-made">' + face(r.made, 'sm') + '<span>' + esc(r.made.name) + '</span></span>' : '<span class="ra-muted">not logged</span>';
  const arrow = (a, b) => { if (!b) return a ? '<span class="ra-tr flat">new</span>' : ''; const pct = Math.round((a - b) / b * 100); return pct === 0 ? '<span class="ra-tr flat">=</span>' : '<span class="ra-tr ' + (pct > 0 ? 'up' : 'down') + '" title="vs the period before (' + b + ')">' + (pct > 0 ? '▲' : '▼') + Math.abs(pct) + '%</span>'; };
  const refTag = (ref) => !ref ? '' : '<span class="ra-ref ' + ref.kind + '">' + (ref.kind === 'client' ? 'Client referral' : ref.kind === 'team' ? 'Axiom team' : 'Referral') + '</span>';
  const client = (r) => '<b>' + esc(r.company || r.person || ('Customer #' + r.id)) + '</b><div class="sub">' + esc([r.company ? r.person : '', r.email].filter(Boolean).join(' · ')) + '</div>';
  const orders = (r) => r.orders ? '<b>' + r.orders.n + '</b> · ' + usd0(r.orders.rev) + '<div class="sub">first ' + usD(r.orders.first) + '</div>' : '<span class="ra-muted">not yet</span>';
  const cache = {};
  async function fetchClients(st) {
    const [from, to] = RaPeriod.range(st), k = from + ':' + to; if (!from) return { ok: false, error: 'Pick a start date.' }; if (cache[k]) return cache[k];
    let j; try { const r = await fetch('/api/reports-ai/clients?from=' + from + '&to=' + to, { headers: H() }); if (r.status === 401 || r.status === 403) { location.href = '/'; return null; } j = await r.json(); } catch (e) { j = { ok: false, error: 'The CRM did not answer' }; }
    if (j.ok) cache[k] = j; return j;
  }
  // a stacked bar chart by day / week / month — series picked by keyOf(row) → { k, l, color }
  function stacked(box, legendEl, rows, keyOf, grain, from, to) {
    const svg = box.querySelector('svg'), tip = box.querySelector('.ra-tip');
    const keys = [], label = {}; const d = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
    if (grain === 'day') { for (let x = new Date(d); x <= end; x.setDate(x.getDate() + 1)) { const k = ymd(x); keys.push(k); label[k] = MONTHS[x.getMonth()] + ' ' + x.getDate(); } }
    else if (grain === 'week') { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); for (let x = new Date(d); x <= end; x.setDate(x.getDate() + 7)) { const k = ymd(x); keys.push(k); label[k] = 'Wk of ' + MONTHS[x.getMonth()] + ' ' + x.getDate(); } }
    else { d.setDate(1); for (let x = new Date(d); x <= end; x.setMonth(x.getMonth() + 1)) { const k = ymd(x).slice(0, 7); keys.push(k); label[k] = MONTHS[x.getMonth()] + ' ' + String(x.getFullYear()).slice(2); } }
    if (keys.length > 120) { const cut = keys.splice(0, keys.length - 120); cut.forEach(k => delete label[k]); }
    const bucketOf = (date) => { if (grain === 'day') return date; if (grain === 'month') return date.slice(0, 7); const x = new Date(date + 'T12:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
    const idx = {}; keys.forEach((k, i) => { idx[k] = i; }); const cells = keys.map(() => ({})); const series = {}; let max = 0;
    rows.forEach(r => { const i = idx[bucketOf(r.date)]; const sk = keyOf(r); if (!series[sk.k]) series[sk.k] = { k: sk.k, l: sk.l, n: 0 }; series[sk.k].n++; if (i == null) return; cells[i][sk.k] = (cells[i][sk.k] || 0) + 1; });
    const S = Object.values(series).sort((a, b) => b.n - a.n); S.forEach((x, i) => { x.color = COLORS[i % COLORS.length]; });
    cells.forEach(c => { const t = Object.values(c).reduce((s, n) => s + n, 0); if (t > max) max = t; });
    legendEl.innerHTML = S.map(a => '<span><i class="ra-dot" style="background:' + a.color + '"></i>' + esc(a.l) + ' · ' + a.n + '</span>').join('');
    const W = Math.max(320, box.clientWidth || 800), Hh = 210, padL = 28, padB = 22, padT = 8, innerH = Hh - padT - padB, n = keys.length;
    if (!n || !max) { svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (Hh / 2) + '" class="tick" text-anchor="middle">Nothing in this period</text>'; return; }
    const top = Math.max(1, Math.ceil(max / 4) * 4), step = (W - padL) / n, bw = Math.max(3, Math.min(34, step * 0.66));
    let out = '';
    for (let g = 0; g <= 4; g++) { const v = top * g / 4, y = padT + innerH - innerH * g / 4; out += '<line class="grid" x1="' + padL + '" y1="' + y + '" x2="' + W + '" y2="' + y + '"/><text class="tick" x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + v + '</text>'; }
    const every = n > 40 ? Math.ceil(n / 20) : n > 16 ? 2 : 1;
    keys.forEach((k, i) => {
      const x = padL + step * i + (step - bw) / 2; let y = padT + innerH;
      S.forEach(a => { const v = cells[i][a.k] || 0; if (!v) return; const h = innerH * v / top; y -= h; out += '<rect class="seg" data-i="' + i + '" x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="2" fill="' + a.color + '"/>'; });
      out += '<rect class="hit" data-i="' + i + '" x="' + (padL + step * i) + '" y="' + padT + '" width="' + step + '" height="' + innerH + '" fill="transparent"/>';
      if (i % every === 0) out += '<text class="tick" x="' + (x + bw / 2) + '" y="' + (Hh - 6) + '" text-anchor="middle">' + esc(label[k]) + '</text>';
    });
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Hh); svg.innerHTML = out;
    svg.querySelectorAll('.hit').forEach(h => {
      h.onmouseenter = () => { const i = +h.dataset.i; box.classList.add('hovering'); svg.querySelectorAll('rect.seg').forEach(sg => sg.classList.toggle('on', +sg.dataset.i === i));
        const tot = Object.values(cells[i]).reduce((s, v) => s + v, 0);
        tip.innerHTML = '<div><b style="margin:0">' + esc(label[keys[i]]) + '</b> · ' + tot + '</div>' + S.filter(a => cells[i][a.k]).map(a => '<div class="row"><i class="ra-dot" style="background:' + a.color + '"></i>' + esc(a.l) + '<b>' + cells[i][a.k] + '</b></div>').join('');
        tip.hidden = false; const r = h.getBoundingClientRect(), b = box.getBoundingClientRect(); tip.style.left = (r.left - b.left + r.width / 2) + 'px'; tip.style.top = (padT + innerH - innerH * tot / top) * (b.height / Hh) + 'px'; };
      h.onmouseleave = () => { box.classList.remove('hovering'); tip.hidden = true; };
    });
  }
  const leaderboard = (el, items, pick, onPick, sub) => {
    el.innerHTML = items.map((a, i) => '<div class="ra-am' + (pick === a.key ? ' on' : '') + '" data-k="' + esc(a.key) + '" title="Only ' + esc(a.name) + '"><span class="rank">#' + (i + 1) + '</span>' + face(a) + '<div><b>' + a.n + '</b><small>' + esc(a.name) + (sub && sub(a) ? ' · ' + sub(a) : '') + '</small></div></div>').join('') || '<div class="ra-muted">Nothing in this period.</div>';
    el.querySelectorAll('[data-k]').forEach(x => x.onclick = () => onPick(pick === x.dataset.k ? '' : x.dataset.k));
  };

  // ======== New Clients
  const C = { period: 'month', from: '', to: '', grain: 'day', series: 'source', revBy: 'source', data: null, maker: '', F: { date: { from: '', to: '' }, client: '', made: '', src: '', am: '', ordered: '', ref: '' } };
  RaPeriod.wire('clPeriod', C, loadClients);
  document.querySelectorAll('#clRevBy button').forEach(b => b.onclick = () => { C.revBy = b.dataset.r; document.querySelectorAll('#clRevBy button').forEach(x => x.classList.toggle('on', x === b)); renderClients(); });
  document.querySelectorAll('#clGrain button').forEach(b => b.onclick = () => { C.grain = b.dataset.g; document.querySelectorAll('#clGrain button').forEach(x => x.classList.toggle('on', x === b)); renderClients(); });
  document.querySelectorAll('#clSeries button').forEach(b => b.onclick = () => { C.series = b.dataset.s; document.querySelectorAll('#clSeries button').forEach(x => x.classList.toggle('on', x === b)); renderClients(); });
  { let t = null; $('clQ').oninput = () => { clearTimeout(t); t = setTimeout(renderClients, 250); }; }
  async function loadClients() {
    $('clList').innerHTML = '<div class="ra-muted">Reading the accounts from the CRM…</div>';
    const j = await fetchClients(C); if (!j) return;
    if (!j.ok) { $('clList').innerHTML = '<div class="ra-muted" style="color:#b91c1c">' + esc(j.error || 'Could not load') + '</div>'; return; }
    C.data = j; $('clVs').textContent = usD(j.from) + ' – ' + usD(j.to) + ' · compared with ' + usD(j.prev.from) + ' – ' + usD(j.prev.to); renderClients();
  }
  const madeKey = (r) => r.made.kind === 'web' ? 'web' : r.made.kind === 'team' ? 'u' + r.made.id : 'none';
  function passesC(r, ignoreMaker) {
    const q = $('clQ').value.trim().toLowerCase(), F = C.F;
    if (q && (r.company + ' ' + r.person + ' ' + r.email + ' ' + r.source.kind + ' ' + (r.source.who || '') + ' ' + r.made.name + ' ' + (r.am ? r.am.name : '') + ' ' + (r.referral ? r.referral.who : '')).toLowerCase().indexOf(q) < 0) return false;
    if (!ignoreMaker && C.maker && madeKey(r) !== C.maker) return false;
    if (F.client && (r.company + ' ' + r.person + ' ' + r.email).toLowerCase().indexOf(F.client.toLowerCase()) < 0) return false;
    if (F.made && madeKey(r) !== F.made) return false;
    if (F.src && r.source.kind !== F.src) return false;
    if (F.am && String(r.am ? r.am.id : 0) !== F.am) return false;
    if (F.ordered === 'yes' && !r.orders) return false; if (F.ordered === 'no' && r.orders) return false;
    if (F.ref && (r.referral ? r.referral.kind : 'none') !== F.ref) return false;
    if (F.date.from && r.date < F.date.from) return false; if (F.date.to && r.date > F.date.to) return false;
    return true;
  }
  function renderClients() {
    const d = C.data; if (!d) return;
    const base = d.rows.filter(r => passesC(r, true)), rows = base.filter(r => !C.maker || madeKey(r) === C.maker);
    const web = base.filter(r => r.web).length, team = base.filter(r => r.made.kind === 'team').length, ordered = base.filter(r => r.orders).length, rev = base.reduce((a, r) => a + (r.orders ? r.orders.rev : 0), 0), refs = base.filter(r => r.referral).length;
    const K = (l, v, s) => '<div class="ra-kpi"><div class="l">' + l + '</div><div class="p" style="font-size:20px">' + v + '</div><div class="v">' + (s || '') + '</div></div>';
    const nOrders = base.reduce((a, r) => a + (r.orders ? r.orders.n : 0), 0);
    $('clKpis').innerHTML = K('New clients', base.length + ' ' + arrow(base.length, d.prev.n), 'the period before: ' + d.prev.n) + K('Signed up on the website', web + ' ' + arrow(web, d.prev.web), base.length ? Math.round(web / base.length * 100) + '% of new clients' : '') + K('Created by the team', team, base.length ? Math.round(team / base.length * 100) + '%' : '') + K('Already ordered', ordered, base.length ? Math.round(ordered / base.length * 100) + '% · ' + nOrders + ' order' + (nOrders === 1 ? '' : 's') : '') +
      K('Revenue from them so far', usd0(rev), (ordered ? usd0(rev / ordered) + ' per ordering client' : '') + (base.length ? ' · ' + usd0(rev / base.length) + ' per new client' : '')) + K('Referrals', refs + ' ' + arrow(refs, d.prev.refs), base.filter(r => r.referral && r.referral.kind === 'client').length + ' from clients · ' + base.filter(r => r.referral && r.referral.kind === 'team').length + ' from the team');
    drawRevenue(base);
    // who created the accounts — team members, then the website as one tile
    const by = {}; base.forEach(r => { const k = madeKey(r); if (!by[k]) by[k] = { key: k, id: r.made.id, name: r.made.kind === 'web' ? 'Website sign-ups' : r.made.name, photo: r.made.photo, n: 0, ordered: 0, rev: 0 }; by[k].n++; if (r.orders) { by[k].ordered++; by[k].rev += r.orders.rev; } });
    const makers = Object.values(by).sort((a, b) => b.n - a.n);
    $('clMakersN').textContent = makers.filter(m => m.key !== 'web' && m.key !== 'none').length + ' team members · ' + web + ' website';
    leaderboard($('clMakers'), makers, C.maker, (k) => { C.maker = k; renderClients(); }, (a) => a.ordered + ' ordered · ' + usd0(a.rev));
    const keyOf = C.series === 'source' ? (r) => ({ k: r.source.kind, l: r.source.kind }) : C.series === 'maker' ? (r) => ({ k: madeKey(r), l: r.made.kind === 'web' ? 'Website' : r.made.name }) : C.series === 'how' ? (r) => r.web ? { k: 'web', l: 'Website sign-up' } : { k: 'team', l: 'Created by the team' } : (r) => ({ k: 'a' + (r.am ? r.am.id : 0), l: r.am ? r.am.name : 'No AM' });
    const [from, to] = RaPeriod.range(C); $('clChartN').textContent = rows.length + ' new client' + (rows.length === 1 ? '' : 's');
    stacked($('clChart'), $('clLegend'), rows, keyOf, C.grain, from, to);
    drawClientsTable(rows, base);
  }
  // 1.20.110: what the new clients have spent so far, by source / by who created the account / by AM — clients, ordered, revenue, per client
  function drawRevenue(base) {
    const keyOf = C.revBy === 'source' ? (r) => [r.source.kind, r.source.kind] : C.revBy === 'maker' ? (r) => [madeKey(r), r.made.kind === 'web' ? 'Website sign-ups' : r.made.name] : (r) => ['a' + (r.am ? r.am.id : 0), r.am ? r.am.name : 'No AM'];
    const by = {}; base.forEach(r => { const [k, l] = keyOf(r); if (!by[k]) by[k] = { l, n: 0, ordered: 0, rev: 0 }; by[k].n++; if (r.orders) { by[k].ordered++; by[k].rev += r.orders.rev; } });
    const rows = Object.values(by).sort((a, b) => b.rev - a.rev || b.n - a.n), max = rows.length ? Math.max(rows[0].rev, 1) : 1, total = rows.reduce((a, x) => a + x.rev, 0);
    $('clRevN').textContent = usd0(total) + ' from ' + base.filter(r => r.orders).length + ' of ' + base.length + ' new clients';
    $('clRev').innerHTML = rows.length ? '<div class="h">' + (C.revBy === 'source' ? 'Source' : C.revBy === 'maker' ? 'Created by' : 'Account manager') + '</div><div class="h"></div><div class="h r">Revenue</div><div class="h r">Clients</div><div class="h r">Ordered</div><div class="h r">Per client</div>' +
      rows.map(x => '<div class="nm" title="' + esc(x.l) + '"><span>' + esc(x.l) + '</span></div><div class="bar"><i style="width:' + (x.rev / max * 100) + '%"></i></div><div class="c"><b>' + usd0(x.rev) + '</b>' + (total ? ' <span class="sub">' + Math.round(x.rev / total * 100) + '%</span>' : '') + '</div><div class="c">' + x.n + '</div><div class="c">' + x.ordered + (x.n ? ' <span class="sub">' + Math.round(x.ordered / x.n * 100) + '%</span>' : '') + '</div><div class="c">' + (x.n ? usd0(x.rev / x.n) : '—') + '</div>').join('') : '<div class="ra-muted" style="grid-column:1/-1">Nothing in this period.</div>';
  }
  function drawClientsTable(rows, base) {
    const F = C.F, uniq = (f) => base.map(f).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).sort();
    const makers = {}; base.forEach(r => { const k = madeKey(r); if (!makers[k]) makers[k] = { v: k, l: r.made.kind === 'web' ? 'Website sign-up' : r.made.name, h: r.made.kind === 'team' ? NovaTable.face(r.made.photo || '', r.made.name) : undefined }; });
    const ams = {}; base.forEach(r => { const k = String(r.am ? r.am.id : 0); if (!ams[k]) ams[k] = { v: k, l: r.am ? r.am.name : 'No AM', h: r.am ? NovaTable.face(r.am.photo || '', r.am.name) : undefined }; });
    const S = { date: { type: 'range', kind: 'date', presets: [{ v: '', l: 'Whole period' }], from: F.date.from, to: F.date.to }, client: { type: 'text', value: F.client },
      made: [{ v: '', l: 'Anyone' }].concat(Object.values(makers)), src: [{ v: '', l: 'Any source' }].concat(uniq(r => r.source.kind).map(k => ({ v: k, l: k }))), am: [{ v: '', l: 'Any AM' }].concat(Object.values(ams)),
      ordered: [{ v: '', l: 'Any' }, { v: 'yes', l: 'Has ordered' }, { v: 'no', l: 'Not yet' }], ref: [{ v: '', l: 'Any' }, { v: 'client', l: 'Client referral' }, { v: 'team', l: 'Axiom team referral' }, { v: 'other', l: 'Other referral' }, { v: 'none', l: 'No referral' }] };
    const T = (k, l) => NovaTable.th(k, l, S[k], k === 'date' ? '' : F[k]);
    $('clList').innerHTML = '<h2>New clients <span class="n">' + rows.length + ' of ' + C.data.rows.length + '</span></h2>' +
      (rows.length ? '<table class="ra"><thead><tr id="clHead"><th>' + T('date', 'Created') + '</th><th>' + T('client', 'Client') + '</th><th>' + T('made', 'Created by') + '</th><th>' + T('src', 'Source') + '</th><th>' + T('ref', 'Referral') + '</th><th>' + T('am', 'AM') + '</th><th>Onboarded</th><th>' + T('ordered', 'Orders') + '</th></tr></thead><tbody>' +
        rows.map(r => '<tr><td><b>' + usD(r.date) + '</b><div class="sub">' + esc(new Date(r.created).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })) + '</div></td><td>' + client(r) + '</td><td>' + made(r) + (r.bizdev ? '<div class="sub">biz dev · ' + esc(r.bizdev) + '</div>' : '') + '</td>' +
          '<td><span class="ra-src ' + String(r.source.kind).toLowerCase().replace(/[^a-z]/g, '') + '">' + esc(r.source.kind) + '</span>' + (r.source.who && !r.referral ? '<div class="sub">' + esc(r.source.who) + '</div>' : '') + '<div class="sub">' + (r.source.from === 'form' ? 'welcome form' : 'sign-up form') + '</div></td>' +
          '<td>' + (r.referral ? refTag(r.referral) + '<div class="sub">' + (r.referral.kind === 'team' ? 'by ' : 'from ') + esc(r.referral.who) + (r.referral.title ? ' · ' + esc(r.referral.title) : '') + '</div>' : '') + '</td>' +
          '<td>' + (r.am ? '<div class="ra-who">' + face(r.am, 'sm') + '<span>' + esc(r.am.name) + '</span></div>' : '<span class="ra-muted">—</span>') + '</td>' +
          '<td>' + (r.onboarded ? (r.onboarded.not ? '<span class="ra-tag no">Did not onboard</span>' : usD(r.onboarded.date)) + '<div class="sub">' + esc(r.onboarded.by) + '</div>' : '<span class="ra-muted">—</span>') + '</td><td>' + orders(r) + '</td></tr>').join('') + '</tbody></table>' : '<div class="ra-muted">Nothing matches.</div>');
    const tr = $('clHead'); if (!tr) return;
    NovaTable.bind(tr, S, (k, v) => { if (k === 'date') F.date = { from: (v && v.from) || '', to: (v && v.to) || '' }; else F[k] = typeof v === 'string' ? v : ''; renderClients(); });
    NovaTable.pin(tr.closest('table'));
  }

  // ======== Referral Report
  const R = { period: 'month', from: '', to: '', data: null, pick: '', F: { date: { from: '', to: '' }, client: '', kind: '', who: '', am: '', ordered: '' } };
  RaPeriod.wire('rfPeriod', R, loadRefs);
  { let t = null; $('rfQ').oninput = () => { clearTimeout(t); t = setTimeout(renderRefs, 250); }; }
  async function loadRefs() {
    $('rfList').innerHTML = '<div class="ra-muted">Reading the referrals from the CRM…</div>';
    const j = await fetchClients(R); if (!j) return;
    if (!j.ok) { $('rfList').innerHTML = '<div class="ra-muted" style="color:#b91c1c">' + esc(j.error || 'Could not load') + '</div>'; return; }
    R.data = j; $('rfVs').textContent = usD(j.from) + ' – ' + usD(j.to) + ' · the period before had ' + j.prev.refs + ' referral' + (j.prev.refs === 1 ? '' : 's'); renderRefs();
  }
  const whoKey = (r) => r.referral.kind + ':' + String(r.referral.who || '').toLowerCase().trim();   /* by name — two CRM accounts of one company count as one referrer */
  function passesR(r, ignorePick) {
    const q = $('rfQ').value.trim().toLowerCase(), F = R.F;
    if (q && (r.company + ' ' + r.person + ' ' + r.email + ' ' + r.referral.who + ' ' + (r.am ? r.am.name : '')).toLowerCase().indexOf(q) < 0) return false;
    if (!ignorePick && R.pick && whoKey(r) !== R.pick) return false;
    if (F.client && (r.company + ' ' + r.person + ' ' + r.email).toLowerCase().indexOf(F.client.toLowerCase()) < 0) return false;
    if (F.kind && r.referral.kind !== F.kind) return false; if (F.who && whoKey(r) !== F.who) return false;
    if (F.am && String(r.am ? r.am.id : 0) !== F.am) return false;
    if (F.ordered === 'yes' && !r.orders) return false; if (F.ordered === 'no' && r.orders) return false;
    if (F.date.from && r.date < F.date.from) return false; if (F.date.to && r.date > F.date.to) return false;
    return true;
  }
  function renderRefs() {
    const d = R.data; if (!d) return;
    const all = d.rows.filter(r => r.referral).concat(d.older_referrals || []).sort((a, b) => b.created < a.created ? -1 : 1);
    const base = all.filter(r => passesR(r, true)), rows = base.filter(r => !R.pick || whoKey(r) === R.pick);
    const cl = base.filter(r => r.referral.kind === 'client'), tm = base.filter(r => r.referral.kind === 'team'), ordered = base.filter(r => r.orders), rev = ordered.reduce((a, r) => a + r.orders.rev, 0);
    const K = (l, v, s) => '<div class="ra-kpi"><div class="l">' + l + '</div><div class="p" style="font-size:20px">' + v + '</div><div class="v">' + (s || '') + '</div></div>';
    $('rfKpis').innerHTML = K('Referrals', base.length + ' ' + arrow(base.length, d.prev.refs), 'of ' + d.rows.length + ' new clients' + (d.rows.length ? ' · ' + Math.round(base.filter(r => !r.older_account).length / d.rows.length * 100) + '%' : '')) + K('From clients', cl.length, cl.map(whoKey).filter((x, i, a) => a.indexOf(x) === i).length + ' referring clients') + K('From the Axiom team', tm.length, tm.map(whoKey).filter((x, i, a) => a.indexOf(x) === i).length + ' team members') + K('Already ordered', ordered.length, base.length ? Math.round(ordered.length / base.length * 100) + '% · ' + usd0(rev) + ' so far' : '');
    const board = (list) => { const by = {}; list.forEach(r => { const k = whoKey(r); if (!by[k]) by[k] = { key: k, name: r.referral.who, photo: r.referral.photo || null, title: r.referral.title || '', n: 0, ordered: 0, rev: 0 }; by[k].n++; if (r.orders) { by[k].ordered++; by[k].rev += r.orders.rev; } }); return Object.values(by).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)); };
    const cb = board(cl), tb = board(tm);
    $('rfClientsN').textContent = cb.length + ' clients sent ' + cl.length; $('rfTeamN').textContent = tb.length + ' team members sent ' + tm.length;
    leaderboard($('rfClients'), cb, R.pick, (k) => { R.pick = k; renderRefs(); }, (a) => a.ordered ? a.ordered + ' ordered · ' + usd0(a.rev) : '');
    leaderboard($('rfTeam'), tb, R.pick, (k) => { R.pick = k; renderRefs(); }, (a) => (a.title ? a.title : '') + (a.ordered ? (a.title ? ' · ' : '') + a.ordered + ' ordered' : ''));
    drawRefsTable(rows, base, all.length);
  }
  function drawRefsTable(rows, base, total) {
    const F = R.F;
    const whos = {}; base.forEach(r => { const k = whoKey(r); if (!whos[k]) whos[k] = { v: k, l: r.referral.who, sub: r.referral.kind === 'team' ? 'Axiom team' : 'client', h: r.referral.photo ? NovaTable.face(r.referral.photo, r.referral.who) : undefined }; });
    const ams = {}; base.forEach(r => { const k = String(r.am ? r.am.id : 0); if (!ams[k]) ams[k] = { v: k, l: r.am ? r.am.name : 'No AM', h: r.am ? NovaTable.face(r.am.photo || '', r.am.name) : undefined }; });
    const S = { date: { type: 'range', kind: 'date', presets: [{ v: '', l: 'Whole period' }], from: F.date.from, to: F.date.to }, client: { type: 'text', value: F.client },
      kind: [{ v: '', l: 'Any' }, { v: 'client', l: 'Client referral' }, { v: 'team', l: 'Axiom team' }, { v: 'other', l: 'Other' }], who: [{ v: '', l: 'Anyone' }].concat(Object.values(whos).sort((a, b) => a.l.localeCompare(b.l))), am: [{ v: '', l: 'Any AM' }].concat(Object.values(ams)), ordered: [{ v: '', l: 'Any' }, { v: 'yes', l: 'Has ordered' }, { v: 'no', l: 'Not yet' }] };
    const T = (k, l) => NovaTable.th(k, l, S[k], k === 'date' ? '' : F[k]);
    $('rfList').innerHTML = '<h2>Referrals <span class="n">' + rows.length + ' of ' + total + '</span></h2>' +
      (rows.length ? '<table class="ra"><thead><tr id="rfHead"><th>' + T('date', 'Created') + '</th><th>' + T('client', 'New client') + '</th><th>' + T('kind', 'Kind') + '</th><th>' + T('who', 'Referred by') + '</th><th>' + T('am', 'AM') + '</th><th>Created by</th><th>' + T('ordered', 'Orders') + '</th></tr></thead><tbody>' +
        rows.map(r => '<tr' + (r.older_account ? ' style="opacity:.75"' : '') + '><td><b>' + usD(r.date) + '</b>' + (r.older_account ? '<div class="sub">older account · onboarded ' + usD(r.onboarded && r.onboarded.date) + '</div>' : '') + '</td><td>' + client(r) + '</td><td>' + refTag(r.referral) + '</td>' +
          '<td><div class="ra-who">' + (r.referral.photo ? face({ name: r.referral.who, photo: r.referral.photo }, 'sm') : '') + '<span><b>' + esc(r.referral.who) + '</b>' + (r.referral.title ? '<div class="sub">' + esc(r.referral.title) + '</div>' : '') + '</span></div><div class="sub">' + (r.referral.from === 'account' ? 'on the account' : r.referral.from === 'form' ? 'welcome form' : 'sign-up form') + '</div></td>' +
          '<td>' + (r.am ? '<div class="ra-who">' + face(r.am, 'sm') + '<span>' + esc(r.am.name) + '</span></div>' : '<span class="ra-muted">—</span>') + '</td><td>' + made(r) + '</td><td>' + orders(r) + '</td></tr>').join('') + '</tbody></table>' : '<div class="ra-muted">No referrals match.</div>');
    const tr = $('rfHead'); if (!tr) return;
    NovaTable.bind(tr, S, (k, v) => { if (k === 'date') F.date = { from: (v && v.from) || '', to: (v && v.to) || '' }; else F[k] = typeof v === 'string' ? v : ''; renderRefs(); });
    NovaTable.pin(tr.closest('table'));
  }
  window.RaTabs = window.RaTabs || {};
  RaTabs.clients = () => { if (!C.data) loadClients(); };
  RaTabs.referrals = () => { if (!R.data) loadRefs(); };
  window.addEventListener('resize', () => { if (C.data && document.querySelector('.ra-view[data-v="clients"].on')) renderClients(); });
})();
