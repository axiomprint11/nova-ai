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
  let period = 'month', grain = 'month';
  function range(p) {
    const now = new Date(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (p === 'week') return [ymd(new Date(d0 - ((d0.getDay() + 6) % 7) * 864e5)), ymd(d0)];
    if (p === 'month') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(d0)];
    if (p === 'last') return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
    if (p === '30') return [ymd(new Date(d0 - 29 * 864e5)), ymd(d0)];
    if (p === '90') return [ymd(new Date(d0 - 89 * 864e5)), ymd(d0)];
    if (p === 'year') return [ymd(new Date(now.getFullYear(), 0, 1)), ymd(d0)];
    return ['', ''];
  }
  document.querySelectorAll('#obPeriod button[data-p]').forEach(b => b.onclick = () => { period = b.dataset.p; document.querySelectorAll('#obPeriod button[data-p]').forEach(x => x.classList.toggle('on', x === b)); if (period === 'week' && grain === 'month') setGrain('day'); load(); });
  document.querySelectorAll('#obGrain button').forEach(b => b.onclick = () => setGrain(b.dataset.g));
  function setGrain(g) { grain = g; document.querySelectorAll('#obGrain button').forEach(x => x.classList.toggle('on', x.dataset.g === g)); drawChart(); }
  $('obAll').onchange = load;
  { let t = null; $('obQ').oninput = () => { clearTimeout(t); t = setTimeout(render, 250); }; }

  // ---- data
  let data = null, amPick = '';
  const OF = { date: { from: '', to: '', period: '' }, client: '', am: '', src: '', via: '', rating: '' };
  async function load() {
    const [from, to] = range(period);
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
    const keys = [], label = {}; const [from0, to0] = range(period);
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

  load();
})();
