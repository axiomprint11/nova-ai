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
  let period = '30', grain = 'day';
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

  // ---- the email report settings (1.20.97)
  const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: H(), body: JSON.stringify(body || {}) }); return r.json(); };
  let em = null;
  async function loadEmail() {
    const j = await api('/api/reports-ai/onboarding/email'); if (!j.ok) { $('obEmMsg').textContent = j.error || ''; return; }
    em = j.settings;
    $('obEmSpan').value = em.span; $('obEmDay').innerHTML = Array.from({ length: 28 }, (_, i) => '<option value="' + (i + 1) + '">' + (i + 1) + (i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th') + ' of the month</option>').join(''); $('obEmDay').value = String(em.day || 1);
    $('obEmAt').value = em.at || '07:00'; $('obEmTo').value = em.to || ''; $('obEmCc').value = em.cc || ''; $('obEmPer').checked = !!em.per_am;
    $('obEmOn').classList.toggle('on', !!em.enabled);
    $('obEmailWhen').textContent = (em.enabled ? 'if sent today it would cover ' : 'off — would cover ') + j.preview + (j.notify_on === false ? ' · switched off under Admin → Emails' : '');
    $('obEmDay').parentElement.style.display = em.span === 'week' ? 'none' : '';
    $('obEmSent').innerHTML = (j.sent || []).length ? '<div><b>Sent</b></div>' + j.sent.map(x => '<div>' + esc(usD(String(x.at).slice(0, 10))) + ' · ' + (x.kind === 'owner' ? 'report' : 'AM list') + ' → ' + esc(x.to_addr) + (x.cc ? ' cc ' + esc(x.cc) : '') + ' · ' + x.n + ' · ' + esc(String(x.period_key).replace(/^\w+:/, '')) + '</div>').join('') : '';
  }
  const emBody = () => ({ enabled: $('obEmOn').classList.contains('on'), span: $('obEmSpan').value, day: $('obEmDay').value, at: $('obEmAt').value.trim(), to: $('obEmTo').value.trim(), cc: $('obEmCc').value.trim(), per_am: $('obEmPer').checked });
  $('obEmOn').onclick = async () => { $('obEmOn').classList.toggle('on'); const j = await post('/api/reports-ai/onboarding/email', emBody()); $('obEmMsg').textContent = j.ok ? 'Saved.' : (j.error || 'Could not save'); loadEmail(); };
  $('obEmSpan').onchange = () => { $('obEmDay').parentElement.style.display = $('obEmSpan').value === 'week' ? 'none' : ''; };
  $('obEmSave').onclick = async () => { $('obEmMsg').textContent = 'Saving…'; const j = await post('/api/reports-ai/onboarding/email', emBody()); $('obEmMsg').textContent = j.ok ? 'Saved.' : (j.error || 'Could not save'); if (j.ok) loadEmail(); };
  $('obEmSend').onclick = async () => { if (!confirm('Send the onboarding report now, for the timespan above, to the addresses above' + ($('obEmPer').checked ? ' — and to each account manager who onboarded' : '') + '?')) return; $('obEmMsg').textContent = 'Sending…'; const j = await post('/api/reports-ai/onboarding/email/send', { span: $('obEmSpan').value }); $('obEmMsg').textContent = j.ok && j.sent ? 'Sent: ' + j.period + ' — ' + j.n + ' onboardings to ' + (j.owner && j.owner.to) + (j.ams && j.ams.length ? ' + ' + j.ams.length + ' AM' + (j.ams.length === 1 ? '' : 's') : '') : (j.error || 'Not sent'); loadEmail(); };
  loadEmail();

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
    try { history.replaceState(null, '', '?tab=' + b.dataset.v); } catch (e) { /* ignore */ }
  });

  let period = '30', by = 'rev', data = null;
  const PF = { product: '', cat: '', orders: { from: '', to: '' }, rev: { from: '', to: '' }, trend: '', prod: { from: '', to: '' } };
  function range(p) {
    const now = new Date(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (p === 'month') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(d0)];
    if (p === 'last') return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
    if (p === 'year') return [ymd(new Date(now.getFullYear(), 0, 1)), ymd(d0)];
    const n = parseInt(p) || 30; return [ymd(new Date(d0 - (n - 1) * 864e5)), ymd(d0)];
  }
  document.querySelectorAll('#prPeriod button[data-p]').forEach(b => b.onclick = () => { period = b.dataset.p; document.querySelectorAll('#prPeriod button[data-p]').forEach(x => x.classList.toggle('on', x === b)); load(); });
  document.querySelectorAll('#prBy button[data-b]').forEach(b => b.onclick = () => { by = b.dataset.b; document.querySelectorAll('#prBy button[data-b]').forEach(x => x.classList.toggle('on', x === b)); drawChart(); });
  { let t = null; $('prQ').oninput = () => { clearTimeout(t); t = setTimeout(render, 250); }; }

  async function load() {
    const [from, to] = range(period);
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
  function kpi(label, cls, p, value, sub) {
    return '<div class="ra-kpi"><div class="l ' + (cls || '') + '">' + label + '</div>' + (p ? '<div class="p">' + pimg(p) + '<span>' + esc(p.title) + '</span></div><div class="v">' + value + (sub ? ' <span class="ra-muted">· ' + sub + '</span>' : '') + '</div>' : '<div class="ra-muted">Not enough data</div>') + '</div>';
  }
  function drawKpis(all) {
    const sold = all.filter(p => p.cur.orders > 0);
    const byRev = sold.slice().sort((a, b) => b.cur.rev - a.cur.rev)[0];
    const byQty = sold.slice().sort((a, b) => b.cur.qty - a.cur.qty)[0];
    const byOrders = sold.slice().sort((a, b) => b.cur.orders - a.cur.orders)[0];
    const up = sold.filter(p => p.trend_kind === 'up' && p.prev.orders >= 2).sort((a, b) => (b.cur.rev - b.prev.rev) - (a.cur.rev - a.prev.rev))[0];
    const down = all.filter(p => (p.trend_kind === 'down' || p.trend_kind === 'gone') && p.prev.orders >= 3).sort((a, b) => (a.cur.rev - a.prev.rev) - (b.cur.rev - b.prev.rev))[0];
    const magnet = sold.filter(p => p.cur.new_clients > 0).sort((a, b) => b.cur.new_clients - a.cur.new_clients || b.cur.new_rev - a.cur.new_rev)[0];
    const timed = sold.filter(p => p.cur.prod_n >= 3);
    const slow = timed.slice().sort((a, b) => b.cur.prod_med - a.cur.prod_med)[0];
    const fast = timed.slice().sort((a, b) => a.cur.prod_med - b.cur.prod_med)[0];
    const d = (p) => p ? p.cur.prod_med + ' days typical' : '';
    $('prKpis').innerHTML =
      kpi('Top seller · revenue', '', byRev, byRev && '<b>' + usd0(byRev.cur.rev) + '</b>', byRev && byRev.cur.orders + ' orders ' + arrow(byRev.trend.rev)) +
      kpi('Most units sold', '', byQty, byQty && '<b>' + num(byQty.cur.qty) + '</b> pcs', byQty && unit(byQty.cur.unit_price) + ' each') +
      kpi('Most orders', '', byOrders, byOrders && '<b>' + byOrders.cur.orders + '</b> orders', byOrders && byOrders.cur.clients + ' clients ' + arrow(byOrders.trend.orders)) +
      kpi('Heating up', 'up', up, up && '<b>' + usd0(up.cur.rev) + '</b> ' + arrow(up.trend.rev), up && 'was ' + usd0(up.prev.rev)) +
      kpi('Cooling down', 'down', down, down && '<b>' + usd0(down.cur.rev) + '</b> ' + arrow(down.trend.rev), down && 'was ' + usd0(down.prev.rev) + ' · ' + down.prev.orders + ' orders') +
      kpi('Brings new clients', '', magnet, magnet && '<b>' + magnet.cur.new_clients + '</b> first-time clients', magnet && usd0(magnet.cur.new_rev) + ' from them') +
      kpi('Longest in production', 'down', slow, slow && '<b>' + d(slow) + '</b>', slow && 'avg ' + slow.cur.prod_avg + ' · ' + slow.cur.prod_n + ' jobs') +
      kpi('Shortest in production', 'up', fast, fast && '<b>' + d(fast) + '</b>', fast && 'avg ' + fast.cur.prod_avg + ' · ' + fast.cur.prod_n + ' jobs');
  }
  const BY_L = { rev: 'Revenue', qty: 'Units', orders: 'Orders', new_clients: 'New clients' };
  function drawChart() {
    if (!data) return; const rows = (data._rows || []).filter(p => p.cur[by] > 0).sort((a, b) => b.cur[by] - a.cur[by]).slice(0, 15);
    const max = rows.length ? Math.max(rows[0].cur[by], rows.reduce((m, p) => Math.max(m, p.prev[by]), 0)) : 0;
    const f = by === 'rev' ? usd0 : num;
    $('prChartN').textContent = BY_L[by] + ' · top ' + rows.length + ' of ' + (data._rows || []).length + ' · thin bar = the period before';
    $('prChart').innerHTML = rows.map(p => '<div class="nm" title="' + esc(p.title) + '">' + pimg(p) + '<span>' + esc(p.title) + '</span></div><div class="bar"><i style="width:' + (p.cur[by] / max * 100) + '%"></i><i class="prev" style="width:' + (p.prev[by] / max * 100) + '%"></i></div><div class="val"><b>' + f(p.cur[by]) + '</b> ' + arrow(p.trend[by === 'new_clients' ? 'orders' : by]) + '</div>').join('') || '<div class="ra-muted">Nothing in this period.</div>';
  }
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
  if (/[?&]tab=products/.test(location.search)) document.querySelector('.ra-tabs button[data-v="products"]').click();
})();
