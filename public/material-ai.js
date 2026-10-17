// Material AI (1.20.159) — materials described, every supplier with a comparable cost, invoice price checks, stock and reorder cycle.
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const H = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
  const api = async (url, body) => {
    const r = await fetch(url, body ? { method: 'POST', headers: H(), body: JSON.stringify(body) } : { headers: H() });
    if (r.status === 401) { location.href = '/'; throw new Error('signed out'); }
    const j = await r.json().catch(() => ({ ok: false, error: 'Error ' + r.status })); if (!r.ok && !j.error) j.error = 'Error ' + r.status; return j;
  };
  const toast = (m) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); };
  const usd = (n, d) => n == null || n === '' || isNaN(n) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: d == null ? 2 : d });
  const usdU = (n) => n == null ? '—' : usd(n, Math.abs(n) < 1 ? 4 : 2);
  const nf = (n, d) => n == null || n === '' || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d });
  const usD = (d) => { if (!d) return ''; const s = String(d).slice(0, 10).split('-'); return s.length === 3 ? s[1] + '-' + s[2] + '-' + s[0] : String(d); };
  const pl = (u) => !u ? 'units' : /^(sq ft|linear ft|each)$/.test(u) ? u : u.replace(/^(press sheet|sheet|roll|unit)/, '$1s');
  const who = (w) => String(w || '').replace(/@.*/, '');
  const lbl = (list, v) => { const x = (list || []).find(p => p[0] === v); return x ? x[1] : v; };
  const photo = (url, cls) => url ? '<img class="ma-ph ' + (cls || '') + '" src="' + esc(url) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<span class=&quot;ma-ph none&quot;>no photo</span>\'">' : '<span class="ma-ph none">no photo</span>';
  const vAv = (s) => s && s.seller && s.seller.photo ? '<img class="av" src="' + esc(s.seller.photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;av&quot;>' + esc((s.vendor_name || '?').charAt(0)) + '</span>\'">' : '<span class="av">' + esc(((s && s.vendor_name) || '?').charAt(0)) + '</span>';

  let V = {}, LIST = [], SET = {}, COUNTS = {};
  const F = { q: '', form: '', geo: '', tile: '' };
  let openId = null, drawerTab = 'describe', DET = null;

  // ---- tabs
  const params = new URLSearchParams(location.search);
  function show(v) {
    document.querySelectorAll('.ma-tabs button').forEach(x => x.classList.toggle('on', x.dataset.v === v));
    document.querySelectorAll('.ma-view').forEach(x => x.classList.toggle('on', x.dataset.v === v));
    if (v === 'alerts') loadAlerts(); else if (v === 'stock') drawStock(); else if (v === 'reorder') drawReorder();
    const u = new URL(location.href); u.searchParams.set('tab', v); history.replaceState(null, '', u);
  }
  document.querySelectorAll('.ma-tabs button').forEach(b => b.onclick = () => show(b.dataset.v));

  // ---- load
  async function load(fresh) {
    const j = await api('/api/material-ai/materials' + (fresh ? '?fresh=1' : ''));
    if (!j.ok) { document.querySelector('#maTable tbody').innerHTML = '<tr><td colspan="8" class="ma-muted" style="padding:20px">' + esc(j.error || 'Could not load the materials') + '</td></tr>'; return; }
    V = j.vocab; LIST = j.materials; SET = j.settings; COUNTS = j.counts;
    $('nAlerts').textContent = (COUNTS.alerts + COUNTS.unmatched) || '';
    $('nStock').textContent = COUNTS.tracked || ''; $('nReorder').textContent = COUNTS.reorder || '';
    const geos = Array.from(new Set(LIST.map(m => m.geo_type).filter(Boolean))).sort();
    const g = $('maGeo'), cur = F.geo; g.innerHTML = '<option value="">All geo types</option>' + geos.map(x => '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
    drawTiles(); drawList();
    if (document.querySelector('.ma-view.on').dataset.v === 'stock') drawStock();
    if (document.querySelector('.ma-view.on').dataset.v === 'reorder') drawReorder();
  }
  function drawTiles() {
    const n = LIST.length, good = LIST.filter(m => m.completeness.pct >= 80).length, two = LIST.filter(m => m.sources.filter(s => s.active).length >= 2).length;
    const none = LIST.filter(m => !m.sources.filter(s => s.active).length).length;
    const T = [['', n, 'materials in the CRM', ''], ['good', good, 'described well (80%+)', 'green'], ['needs', n - good, 'need details', 'amber'],
      ['two', two, 'with 2+ suppliers', ''], ['nosup', none, 'with no supplier', none ? 'red' : ''], ['alerts', COUNTS.alerts || 0, 'price alerts open', COUNTS.alerts ? 'red' : '']];
    $('maTiles').innerHTML = T.map(t => '<button class="ma-tile ' + t[3] + (F.tile === t[0] ? ' on' : '') + '" data-t="' + t[0] + '"><b>' + nf(t[1]) + '</b><span>' + esc(t[2]) + '</span></button>').join('');
    $('maTiles').querySelectorAll('[data-t]').forEach(b => b.onclick = () => { if (b.dataset.t === 'alerts') return show('alerts'); F.tile = F.tile === b.dataset.t ? '' : b.dataset.t; drawTiles(); drawList(); });
    $('maForms').innerHTML = [['', 'All'], ['sheet', 'Sheet'], ['roll', 'Roll'], ['rigid', 'Rigid'], ['item', 'Item']].map(f => '<button class="chip' + (F.form === f[0] ? ' on' : '') + '" data-f="' + f[0] + '">' + f[1] + '</button>').join(' ');
    $('maForms').querySelectorAll('[data-f]').forEach(b => b.onclick = () => { F.form = b.dataset.f; drawTiles(); drawList(); });
  }
  const passes = (m) => {
    if (F.form && m.spec.form !== F.form) return false;
    if (F.geo && m.geo_type !== F.geo) return false;
    const act = m.sources.filter(s => s.active).length;
    if (F.tile === 'good' && m.completeness.pct < 80) return false; if (F.tile === 'needs' && m.completeness.pct >= 80) return false;
    if (F.tile === 'two' && act < 2) return false; if (F.tile === 'nosup' && act) return false;
    if (F.q) { const h = [m.name, m.code, m.manufacturer, m.crm_supplier, m.geo_type, m.geo_sub_type, m.spec.color, m.spec.brand].concat(m.sources.map(s => s.vendor_name + ' ' + (s.vendor_sku || ''))).join(' ').toLowerCase(); if (F.q.toLowerCase().split(/\s+/).some(w => h.indexOf(w) === -1)) return false; }
    return true;
  };
  function specChips(m) {
    const s = m.spec, out = [];
    if (s.thickness) out.push(nf(s.thickness, 4) + ' ' + (s.thickness_unit || ''));
    if (s.basis_weight) out.push(nf(s.basis_weight) + (s.basis_unit === 'gsm' ? ' gsm' : s.basis_unit === 'oz' ? ' oz' : '# ' + lbl(V.basis_unit, s.basis_unit).replace('# ', '')));
    if (s.color) out.push(s.color + (s.edge_color && s.edge_color !== s.color ? ' · ' + s.edge_color + ' edge' : ''));
    if (s.finish && String(lbl(V.finish, s.finish)).toLowerCase() !== String(s.color || '').toLowerCase()) out.push(lbl(V.finish, s.finish));
    let h = out.map(x => '<span>' + esc(x) + '</span>').join('');
    if (s.adhesive && s.adhesive !== 'none') h += '<span class="adh">' + esc(lbl(V.adhesive, s.adhesive)) + '</span>';
    return h || '<span class="ma-muted" style="background:none">—</span>';
  }
  function supChips(m) {
    const act = m.sources.filter(s => s.active); if (!act.length) return '<span class="ma-pill red">no supplier</span>';
    const best = act.filter(s => s.cost_per_base != null).sort((a, b) => a.cost_per_base - b.cost_per_base)[0];
    return '<div class="ma-sups">' + act.slice(0, 4).map(s => '<div class="ma-sup' + (best && s.id === best.id && act.length > 1 ? ' best' : '') + '">' + (s.preferred ? '<span class="star" title="Preferred">★</span>' : '') +
      '<span class="v" title="' + esc(s.vendor_name) + '">' + esc(s.vendor_name) + '</span><span class="c">' + (s.cost_per_base != null ? usdU(s.cost_per_base) + ' / ' + esc(m.base_label) : 'no cost') + '</span></div>').join('') + '</div>';
  }
  function qBar(c) { const cls = c.pct >= 80 ? '' : c.pct >= 50 ? ' mid' : ' low'; return '<div class="ma-q' + cls + '" title="' + esc(c.missing.length ? 'Missing: ' + c.missing.join(', ') : 'Well described') + '"><div class="ma-qbar"><i style="width:' + c.pct + '%"></i></div><b>' + c.pct + '%</b></div>'; }
  function onHand(m) { const st = m.stock; if (st.on_hand == null) return '<span class="ma-muted">not counted</span>'; return '<span class="ma-num">' + nf(st.on_hand) + '</span> <span class="ma-sub">' + esc(m.base_label) + '</span>' + (st.reorder ? '<div><span class="ma-pill amber">reorder?</span></div>' : ''); }
  function drawList() {
    const rows = LIST.filter(passes); $('maShown').textContent = rows.length + ' of ' + LIST.length;
    const tb = document.querySelector('#maTable tbody');
    tb.innerHTML = rows.length ? rows.map(m => '<tr data-id="' + m.id + '"' + (m.id === openId ? ' class="on"' : '') + '><td style="width:52px">' + photo(m.photo) + '</td>' +
      '<td class="ma-nm"><b>' + esc(m.name) + '</b><div class="s">' + esc([m.code, m.manufacturer && m.manufacturer !== 'N/A' ? m.manufacturer : null, [m.geo_type, m.geo_sub_type].filter(Boolean).join(' › ')].filter(Boolean).join(' · ')) + '</div></td>' +
      '<td>' + (m.spec.form ? '<span class="ma-form ' + esc(m.spec.form) + '">' + esc({ sheet: 'Sheet', roll: 'Roll', rigid: 'Rigid', item: 'Item', liquid: 'Ink' }[m.spec.form] || m.spec.form) + '</span>' : '<span class="ma-muted">—</span>') + '</td>' +
      '<td><div class="ma-specs">' + specChips(m) + '</div></td><td>' + supChips(m) + (m.alerts ? '<div style="margin-top:3px"><span class="ma-pill red">' + m.alerts + ' price alert' + (m.alerts === 1 ? '' : 's') + '</span></div>' : '') + '</td>' +
      '<td>' + onHand(m) + '</td><td>' + qBar(m.completeness) + '</td>' +
      '<td class="ma-sub">' + (m.usage.products ? m.usage.products + ' product' + (m.usage.products === 1 ? '' : 's') : '—') + '</td></tr>').join('')
      : '<tr><td colspan="8" class="ma-muted" style="padding:20px">Nothing matches.</td></tr>';
    tb.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openMat(Number(tr.dataset.id)));
  }
  let qT = null; $('maQ').oninput = (e) => { clearTimeout(qT); qT = setTimeout(() => { F.q = e.target.value.trim(); drawList(); }, 200); };
  $('maGeo').onchange = (e) => { F.geo = e.target.value; drawList(); };
  $('maRefresh').onclick = () => load(true);

  // ---- the drawer
  function closeDrawer() { openId = null; DET = null; $('maDrawer').classList.remove('on'); $('maDim').classList.remove('on'); document.querySelectorAll('#maTable tr.on').forEach(t => t.classList.remove('on')); }
  $('maDim').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) closeDrawer(); });
  async function openMat(id, tab) {
    openId = id; if (tab) drawerTab = tab;
    document.querySelectorAll('#maTable tbody tr').forEach(t => t.classList.toggle('on', Number(t.dataset.id) === id));
    $('maDrawer').innerHTML = '<div class="ma-dbody ma-muted">Loading…</div>'; $('maDrawer').classList.add('on'); $('maDim').classList.add('on');
    const j = await api('/api/material-ai/materials/' + id); if (!j.ok) { $('maDrawer').innerHTML = '<div class="ma-dbody">' + esc(j.error) + '</div>'; return; }
    DET = j.material; drawDrawer();
  }
  function drawDrawer() {
    const m = DET, nA = (m.alert_rows || []).filter(a => a.status === 'open').length + (m.unmatched_rows || []).length;
    $('maDrawer').innerHTML = '<div class="ma-dh">' + (m.photo ? '<img src="' + esc(m.photo) + '" alt="" onerror="this.remove()">' : '<span class="ma-ph none">no photo</span>') +
      '<div class="sp"><h3>' + esc(m.name) + '</h3><div class="s">' + esc(['CRM #' + m.id, m.code, [m.geo_type, m.geo_sub_type].filter(Boolean).join(' › '), (m.departments || []).join(', ')].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="s">' + (m.usage.products ? 'Used by ' + m.usage.products + ' product' + (m.usage.products === 1 ? '' : 's') + ' (' + m.usage.options + ' option' + (m.usage.options === 1 ? '' : 's') + ')' : 'Not linked to any product option yet') + ' · described ' + m.completeness.pct + '%' + (m.completeness.missing.length ? ' — missing ' + esc(m.completeness.missing.join(', ')) : '') + '</div></div>' +
      '<button class="ma-x" title="Close (Esc)">×</button></div>' +
      '<div class="ma-dtabs">' + [['describe', 'Describe'], ['suppliers', 'Suppliers (' + m.sources.filter(s => s.active).length + ')'], ['stock', 'Inventory'], ['prices', 'Prices' + (nA ? '<span class="n">' + nA + '</span>' : '')], ['used', 'Used in']].map(t => '<button data-dt="' + t[0] + '"' + (drawerTab === t[0] ? ' class="on"' : '') + '>' + t[1] + '</button>').join('') + '</div>' +
      '<div class="ma-dbody"><div class="ma-dsec" data-dt="describe">' + describeHtml(m) + '</div><div class="ma-dsec" data-dt="suppliers">' + suppliersHtml(m) + '</div>' +
      '<div class="ma-dsec" data-dt="stock">' + stockHtml(m) + '</div><div class="ma-dsec" data-dt="prices">' + pricesHtml(m) + '</div><div class="ma-dsec" data-dt="used">' + usedHtml(m) + '</div></div>';
    const d = $('maDrawer');
    d.querySelector('.ma-x').onclick = closeDrawer;
    d.querySelectorAll('[data-dt]').forEach(b => { if (b.tagName === 'BUTTON') b.onclick = () => { drawerTab = b.dataset.dt; d.querySelectorAll('.ma-dtabs button').forEach(x => x.classList.toggle('on', x === b)); d.querySelectorAll('.ma-dsec').forEach(x => x.classList.toggle('on', x.dataset.dt === drawerTab)); }; });
    d.querySelectorAll('.ma-dsec').forEach(x => x.classList.toggle('on', x.dataset.dt === drawerTab));
    bindDescribe(m); bindSuppliers(m); bindStock(m); bindPrices(m);
  }

  // ---- Describe
  const opt = (list, v, blank) => (blank ? '<option value="">' + esc(blank) + '</option>' : '') + (list || []).map(p => '<option value="' + esc(p[0]) + '"' + (String(v) === String(p[0]) ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join('');
  const crmTag = (m, f) => m.spec_from[f] === 'crm' ? '<span class="crm" title="Read from the CRM row — save to keep it">from CRM</span>' : '';
  const COLORS = ['White', 'Black', 'Clear', 'Silver', 'Gold', 'Natural', 'Kraft', 'Ivory', 'Gray', 'Red', 'Blue', 'Green', 'Yellow', 'Frosted', 'Mirror'];
  function describeHtml(m) {
    const s = m.spec, f = (k, label, inner, span) => '<div class="ma-f ' + (span || 'ma-span2') + '"><label>' + label + crmTag(m, k) + '</label>' + inner + '</div>';
    const seg = (k, list) => '<div class="ma-seg" data-seg="' + k + '">' + list.map(p => '<button type="button" data-v="' + esc(p[0]) + '"' + (s[k] === p[0] ? ' class="on"' : '') + '>' + esc(p[1]) + '</button>').join('') + '</div>';
    return '<div class="ma-grid" id="dsForm">' +
      f('form', 'What it is', seg('form', V.form), 'ma-span6') +
      f('thickness', 'Thickness', '<div class="pair"><input type="number" step="any" name="thickness" value="' + esc(s.thickness == null ? '' : s.thickness) + '"><select name="thickness_unit">' + opt(V.thickness_unit, s.thickness_unit || 'in') + '</select></div>') +
      f('color', 'Color', '<input name="color" list="maColors" value="' + esc(s.color || '') + '"><datalist id="maColors">' + COLORS.map(c => '<option>' + c + '</option>').join('') + '</datalist>') +
      f('edge_color', 'Edge color', '<input name="edge_color" list="maColors" value="' + esc(s.edge_color || '') + '" placeholder="rigid boards, acrylic">') +
      f('adhesive', 'Adhesive', seg('adhesive', V.adhesive), 'ma-span6') +
      f('finish', 'Finish', '<select name="finish">' + opt(V.finish, s.finish, '—') + '</select>') +
      f('coated', 'Coating', '<select name="coated">' + opt(V.coated, s.coated, '—') + '</select>') +
      f('basis_weight', 'Paper / banner weight', '<div class="pair"><input type="number" step="any" name="basis_weight" value="' + esc(s.basis_weight == null ? '' : s.basis_weight) + '" placeholder="70"><select name="basis_unit">' + opt(V.basis_unit, s.basis_unit, '—') + '</select></div>') +
      f('sides', 'Printable', '<select name="sides">' + opt(V.sides, s.sides, '—') + '</select>') +
      f('use_where', 'Use', '<select name="use_where">' + opt(V.use_where, s.use_where, '—') + '</select>') +
      f('brand', 'Brand / maker', '<input name="brand" value="' + esc(s.brand || '') + '">') +
      f('product_line', 'Product line', '<input name="product_line" value="' + esc(s.product_line || '') + '" placeholder="e.g. Acrylite FF, 3M IJ180">', 'ma-span3') +
      '<div class="ma-f ma-span6"><label>Features</label><div class="ma-feat" id="dsFeat">' + V.features.map(x => '<button type="button" data-f="' + esc(x) + '"' + (s.features.indexOf(x) > -1 ? ' class="on"' : '') + '>' + esc(x) + '</button>').join('') + '</div></div>' +
      '<div class="ma-sec">Counting &amp; shipping</div>' +
      f('base_unit', 'We count it in', '<select name="base_unit">' + opt(V.base_unit, s.base_unit, '—') + '</select>') +
      '<div class="ma-f ma-span2" id="dsPress"' + (s.base_unit === 'press' ? '' : ' style="display:none"') + '><label>Press sheet size (in)</label><div class="pair"><input type="number" step="any" name="press_w" value="' + esc(s.press_w || '') + '" placeholder="13"><input type="number" step="any" name="press_h" value="' + esc(s.press_h || '') + '" placeholder="19"></div></div>' +
      f('weight', 'Weight', '<div class="pair"><input type="number" step="any" name="weight" value="' + esc(s.weight == null ? '' : s.weight) + '"><select name="weight_unit">' + opt(V.weight_unit, s.weight_unit || 'oz') + '</select><select name="weight_per"><option value="base"' + (!s.weight_per || s.weight_per === 'base' ? ' selected' : '') + '>per unit</option><option value="sqft"' + (s.weight_per === 'sqft' ? ' selected' : '') + '>per sq ft</option><option value="crm100"' + (s.weight_per === 'crm100' ? ' selected' : '') + '>per 100 sh 8.5×11</option></select></div>', 'ma-span4') +
      '<div class="ma-ship" id="dsShip"></div>' +
      f('notes', 'Notes', '<textarea name="notes">' + esc(s.notes || '') + '</textarea>', 'ma-span6') +
      '</div><div class="ma-save"><button class="bk-btn pri" id="dsSave">Save description</button><span class="ma-muted">Fields marked “from CRM” were read from the CRM row; saving keeps them in Nova. Nothing is written to the CRM.</span></div>';
  }
  function shipHtml(m) {
    const p = m.physics, unit = m.base_label;
    let h = '<span>One <b>' + esc(unit) + '</b>: ' + (p.per_unit_oz != null ? '<b>' + nf(p.per_unit_oz, 3) + ' oz</b> <span class="ma-muted">(' + esc(p.weight_how || '') + ')</span>' : '<span class="ma-muted">weight unknown — give a weight or the paper weight</span>') +
      ' · ' + (p.cube_in3 != null ? '<b>' + nf(p.cube_in3, 2) + ' in³</b>' : '<span class="ma-muted">size or thickness missing</span>') + '</span>';
    h += '<span style="display:flex;gap:6px;align-items:center">Job: <input type="number" id="shQty" placeholder="qty" min="0"> ' + esc(pl(unit)) + ' <span id="shOut" class="ma-muted"></span></span>';
    return h;
  }
  function bindDescribe(m) {
    const box = $('dsForm'); if (!box) return;
    box.querySelectorAll('[data-seg] button').forEach(b => b.onclick = () => { const on = b.classList.contains('on'); b.parentNode.querySelectorAll('button').forEach(x => x.classList.remove('on')); if (!on) b.classList.add('on'); });
    box.querySelectorAll('#dsFeat button').forEach(b => b.onclick = () => b.classList.toggle('on'));
    box.querySelector('[name=base_unit]').onchange = (e) => { $('dsPress').style.display = e.target.value === 'press' ? '' : 'none'; };
    $('dsShip').innerHTML = shipHtml(m);
    const calc = () => { const q = Number($('shQty').value) || 0, p = m.physics; if (!q) { $('shOut').textContent = ''; return; }
      const lb = p.per_unit_oz != null ? p.per_unit_oz * q / 16 : null, cu = p.cube_in3 != null ? p.cube_in3 * q : null;
      $('shOut').innerHTML = '→ ' + (lb != null ? '<b>' + nf(lb, 2) + ' lb</b>' : 'weight unknown') + ' · ' + (cu != null ? '<b>' + nf(cu, 0) + ' in³</b> (' + nf(cu / 1728, 2) + ' ft³)' : 'volume unknown'); };
    $('shQty').oninput = calc;
    $('dsSave').onclick = async () => {
      const body = {}; box.querySelectorAll('[name]').forEach(i => { body[i.name] = i.value; });
      box.querySelectorAll('[data-seg]').forEach(sg => { const on = sg.querySelector('button.on'); body[sg.dataset.seg] = on ? on.dataset.v : ''; });
      body.features = Array.from(box.querySelectorAll('#dsFeat button.on')).map(b => b.dataset.f);
      const r = await api('/api/material-ai/materials/' + m.id + '/spec', body); if (!r.ok) return alert(r.error || 'Could not save');
      toast('Saved'); await reloadOne(m.id);
    };
  }
  async function reloadOne(id) {
    const keep = drawerTab; const j = await api('/api/material-ai/materials/' + id); if (j.ok) { DET = j.material; drawerTab = keep; drawDrawer(); }
    const all = await api('/api/material-ai/materials'); if (all.ok) { LIST = all.materials; COUNTS = all.counts; $('nAlerts').textContent = (COUNTS.alerts + COUNTS.unmatched) || ''; $('nStock').textContent = COUNTS.tracked || ''; $('nReorder').textContent = COUNTS.reorder || ''; drawTiles(); drawList(); }
  }

  // ---- Suppliers
  let SELLERS = null;
  async function sellers() { if (SELLERS) return SELLERS; const j = await api('/api/material-ai/sellers'); SELLERS = j.ok ? j.sellers : []; return SELLERS; }
  const buysAs = (s, m) => { const sz = s.unit_w && s.unit_h ? (m.spec.form === 'roll' ? nf(s.unit_w) + '" × ' + nf(s.unit_h / 12, 1) + "'" : nf(s.unit_w) + '×' + nf(s.unit_h)) : ''; return esc(lbl(V.buy_unit, s.buy_unit)) + (s.units_per_buy > 1 ? ' of ' + nf(s.units_per_buy) : '') + (sz ? ' · ' + esc(sz) : ''); };
  function suppliersHtml(m) {
    const act = m.sources.filter(s => s.active), best = act.filter(s => s.cost_per_base != null).sort((a, b) => a.cost_per_base - b.cost_per_base)[0];
    const rows = m.sources.map(s => {
      const last = s.last_price != null ? (s.last_price_per === 'unit' ? s.last_price : s.last_price) : null;
      const ref = s.last_price_per === 'unit' ? s.cost_per_unit : s.cost_per_buy;
      const d = last != null && ref ? (last - ref) / ref * 100 : null;
      return '<tr class="' + (!s.active ? 'off' : best && s.id === best.id && act.length > 1 ? 'best' : '') + '"><td><div class="ma-ven">' + vAv(s) + '<div><b>' + (s.preferred ? '<span style="color:#f59e0b">★</span> ' : '') + esc(s.vendor_name) + '</b><div class="how">' + esc(s.match_how || '') + (s.seller ? '' : ' · not linked to Sellers') + '</div>' + (s.confirmed ? '' : '<span class="ma-pill amber" title="Read from the CRM or an invoice — press Edit, check the pack (pieces per carton) and the size, and save. Until then invoices check its price but do not add to stock.">check pack &amp; size</span>') + '</div></div></td>' +
        '<td>' + esc(s.vendor_sku || '') + (s.vendor_desc ? '<div class="ma-sub">' + esc(s.vendor_desc) + '</div>' : '') + '</td>' +
        '<td>' + buysAs(s, m) + '<div class="ma-sub">' + (s.yield ? '= ' + nf(s.base_per_buy) + ' ' + esc(s.base_per_buy === 1 ? m.base_label : pl(m.base_label)) : 'yield unknown') + '</div></td>' +
        '<td><b>' + usd(s.cost_per_buy) + '</b><div class="ma-sub">' + (s.units_per_buy > 1 ? usdU(s.cost_per_unit) + ' each · ' : '') + (s.cost_per_base != null ? usdU(s.cost_per_base) + ' / ' + esc(m.base_label) : '') + '</div><div class="ma-sub">' + esc([String(s.cost_from || '').replace(/@\S+/, ''), usD(s.cost_date)].filter(Boolean).join(' · ')) + '</div></td>' +
        '<td>' + (last != null ? usdU(last) + ' <span class="ma-sub">' + (s.last_price_per === 'unit' ? 'each' : 'per ' + esc(lbl(V.buy_unit, s.buy_unit)).toLowerCase()) + '</span><div class="ma-sub">' + usD(s.last_price_at) + (d != null ? ' · <span class="ma-delta ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + nf(d, 1) + '%</span>' : '') + '</div>' : '<span class="ma-muted">no invoice yet</span>') + '</td>' +
        '<td style="white-space:nowrap">' + (s.active ? '<button class="bk-btn sm" data-sedit="' + s.id + '">Edit</button> ' + (!s.preferred ? '<button class="bk-btn sm" data-spref="' + s.id + '" title="Make preferred">★</button> ' : '') + '<button class="bk-btn sm x" data-sdel="' + s.id + '" title="Remove">×</button>' : '<span class="ma-muted">archived</span>') + '</td></tr>';
    }).join('');
    return '<p class="ma-p">Every vendor who sells this material — the website and the calculator only ever see the material. Costs compare per <b>' + esc(m.base_label) + '</b> (set under Describe → We count it in), so a 13×19 and a 20×28 sheet, or two board sizes, line up.' + (act.length > 1 && best ? ' Cheapest now: <b>' + esc(best.vendor_name) + '</b>.' : '') + '</p>' +
      (m.sources.length ? '<table class="ma-st"><thead><tr><th>Vendor</th><th>Their item</th><th>Buys as</th><th>Cost</th><th>Last invoice</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="ma-muted">No supplier yet.</div>') +
      '<div id="spForm"></div><div class="ma-save"><button class="bk-btn pri" id="spAdd">+ Add a supplier</button></div>';
  }
  function bindSuppliers(m) {
    const d = $('maDrawer'); if (!$('spAdd')) return;
    $('spAdd').onclick = () => supForm(m, null);
    d.querySelectorAll('[data-sedit]').forEach(b => b.onclick = () => supForm(m, m.sources.find(s => s.id === Number(b.dataset.sedit))));
    d.querySelectorAll('[data-spref]').forEach(b => b.onclick = async () => { await api('/api/material-ai/sources/' + b.dataset.spref + '/preferred', {}); toast('Preferred supplier set'); reloadOne(m.id); });
    d.querySelectorAll('[data-sdel]').forEach(b => b.onclick = async () => { if (!confirm('Remove this supplier item?')) return; const r = await api('/api/material-ai/sources/' + b.dataset.sdel + '/delete', {}); toast(r.archived ? 'Archived — it has invoice prices' : 'Removed'); reloadOne(m.id); });
  }
  function yieldPreview(s, spec) {
    if (Number(s.yield_override) > 0) return Number(s.yield_override);
    const w = Number(s.unit_w) || 0, h = Number(s.unit_h) || 0, b = spec.base_unit || 'sheet';
    if (b === 'sqft') return w > 0 && h > 0 ? w * h / 144 : null; if (b === 'lft') return h > 0 ? h / 12 : null;
    if (b === 'press') { const pw = Number(spec.press_w) || 0, ph = Number(spec.press_h) || 0; if (!(pw && ph && w && h)) return null; return Math.max(Math.floor(w / pw) * Math.floor(h / ph), Math.floor(w / ph) * Math.floor(h / pw)) || null; }
    return 1;
  }
  async function supForm(m, s) {
    const list = await sellers(); s = s || { buy_unit: m.spec.form === 'roll' ? 'roll' : 'sheet', units_per_buy: 1, active: 1 };
    const roll = m.spec.form === 'roll';
    const box = $('spForm');
    box.innerHTML = '<div class="ma-sform"><div class="ma-grid">' +
      '<div class="ma-f ma-span3"><label>Supplier (CRM Sellers)</label><select id="sfSel"><option value="">— not in Sellers: type the name →</option>' + list.map(x => '<option value="' + x.id + '"' + (Number(s.seller_id) === x.id ? ' selected' : '') + '>' + esc(x.name) + (x.type === 'vendor' ? ' (vendor)' : '') + '</option>').join('') + '</select></div>' +
      '<div class="ma-f ma-span3"><label>…or name</label><input id="sfName" value="' + esc(s.seller_id ? '' : (s.vendor_name || '')) + '"></div>' +
      '<div class="ma-f ma-span2"><label>Their SKU / item #</label><input id="sfSku" value="' + esc(s.vendor_sku || '') + '"></div>' +
      '<div class="ma-f ma-span4"><label>How it reads on their invoice</label><input id="sfDesc" value="' + esc(s.vendor_desc || '') + '" placeholder="e.g. ACRYLITE FF CLEAR 1/8 48X96"></div>' +
      '<div class="ma-f ma-span2"><label>We buy it by the</label><select id="sfBuy">' + opt(V.buy_unit, s.buy_unit) + '</select></div>' +
      '<div class="ma-f ma-span2"><label>Pieces in one</label><input type="number" step="any" id="sfPer" value="' + esc(s.units_per_buy || 1) + '"></div>' +
      '<div class="ma-f ma-span2"><label>' + (roll ? 'Roll width (in) × length (ft)' : 'Piece size (in) W × H') + '</label><div class="pair"><input type="number" step="any" id="sfW" value="' + esc(s.unit_w || '') + '"><input type="number" step="any" id="sfH" value="' + esc(s.unit_h ? (roll ? +(s.unit_h / 12).toFixed(2) : s.unit_h) : '') + '"></div></div>' +
      '<div class="ma-f ma-span2"><label>Cost per ' + esc(lbl(V.buy_unit, s.buy_unit)).toLowerCase() + ' ($)</label><input type="number" step="any" id="sfCost" value="' + esc(s.cost_per_buy == null ? '' : s.cost_per_buy) + '"></div>' +
      '<div class="ma-f ma-span2"><label>' + esc(pl(m.base_label)) + ' per piece (blank = work it out)</label><input type="number" step="any" id="sfYield" value="' + esc(s.yield_override || '') + '"></div>' +
      '<div class="ma-f ma-span2"><label>Lead time (days)</label><input type="number" id="sfLead" value="' + esc(s.lead_days == null ? '' : s.lead_days) + '"></div>' +
      '<div class="ma-f ma-span2"><label>Minimum order</label><input id="sfMin" value="' + esc(s.min_order || '') + '"></div>' +
      '<div class="ma-f ma-span4"><label>Notes</label><input id="sfNotes" value="' + esc(s.notes || '') + '"></div>' +
      '<div class="ma-f ma-span2"><label>&nbsp;</label><label style="font-size:12px;color:var(--ink-soft)"><input type="checkbox" id="sfPref"' + (s.preferred ? ' checked' : '') + ' style="width:auto;height:auto"> preferred supplier</label></div>' +
      '<div class="ma-prev" id="sfPrev"></div></div>' +
      '<div class="ma-save"><button class="bk-btn pri" id="sfSave">' + (s.id ? 'Save' : 'Add supplier') + '</button><button class="bk-btn" id="sfCancel">Cancel</button></div></div>';
    const g = (id) => $(id).value;
    const prev = () => {
      const x = { unit_w: Number(g('sfW')) || null, unit_h: Number(g('sfH')) ? (roll ? Number(g('sfH')) * 12 : Number(g('sfH'))) : null, yield_override: Number(g('sfYield')) || null };
      const y = yieldPreview(x, m.spec), per = Number(g('sfPer')) || 1, cost = Number(g('sfCost'));
      const unit = lbl(V.buy_unit, g('sfBuy')).toLowerCase();
      $('sfPrev').innerHTML = y ? 'One ' + esc(unit) + ' = <b>' + nf(y * per, 3) + ' ' + esc(pl(m.base_label)) + '</b>' + (per > 1 ? ' (' + nf(per) + ' × ' + nf(y, 3) + ')' : '') +
        (cost > 0 ? ' · <b>' + usdU(cost / per / y) + ' per ' + esc(m.base_label) + '</b>' + (per > 1 ? ' · ' + usdU(cost / per) + ' per piece' : '') : '') + (m.spec.base_unit === 'press' && !(m.spec.press_w && m.spec.press_h) ? ' — set the press sheet size under Describe' : '')
        : '<span class="ma-muted">Give the size' + (m.spec.base_unit ? '' : ' and pick "We count it in" under Describe') + ' to compare the cost per ' + esc(m.base_label) + '.</span>';
    };
    box.querySelectorAll('input,select').forEach(i => { i.oninput = prev; i.onchange = prev; }); prev();
    $('sfCancel').onclick = () => { box.innerHTML = ''; };
    $('sfSave').onclick = async () => {
      const body = { id: s.id || null, seller_id: g('sfSel') || null, vendor_name: g('sfName'), vendor_sku: g('sfSku'), vendor_desc: g('sfDesc'), buy_unit: g('sfBuy'), units_per_buy: g('sfPer'),
        unit_w: g('sfW'), unit_h: g('sfH') ? (roll ? Number(g('sfH')) * 12 : g('sfH')) : '', cost_per_buy: g('sfCost'), yield_override: g('sfYield'), lead_days: g('sfLead'), min_order: g('sfMin'), notes: g('sfNotes'), preferred: $('sfPref').checked };
      const r = await api('/api/material-ai/materials/' + m.id + '/sources', body); if (!r.ok) return alert(r.error || 'Could not save');
      toast((s.id ? 'Supplier saved' : 'Supplier added') + (r.received ? ' · ' + r.received + ' invoice receipt' + (r.received === 1 ? '' : 's') + ' added to stock' : '')); reloadOne(m.id);
    };
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- Inventory
  function stockHtml(m) {
    const st = m.stock, act = m.sources.filter(s => s.active);
    const srcOpt = act.map(s => '<option value="' + s.id + '">' + esc(s.vendor_name) + ' — ' + esc(lbl(V.buy_unit, s.buy_unit)).toLowerCase() + (s.units_per_buy > 1 ? ' of ' + nf(s.units_per_buy) : '') + '</option>').join('');
    const facts = [[st.on_hand != null ? nf(st.on_hand) : '—', 'on hand (' + m.base_label + ')'], [st.last_count ? usD(st.last_count) : '—', 'last counted'], [st.last_in ? usD(st.last_in) : '—', 'last received'],
      [st.used_per_week != null ? nf(st.used_per_week) : '—', 'used per week'], [st.days_left != null ? st.days_left : '—', 'days left at that pace'], [st.cycle_days ? st.cycle_days + ' days' : '—', 'usual reorder cycle'],
      [st.avg_in != null ? nf(st.avg_in) : '—', 'usual order (' + m.base_label + ')'], [st.next_expected ? usD(st.next_expected) : '—', 'next order expected']];
    const kindL = { receive: 'Received', count: 'Counted', adjust: 'Adjusted' };
    return (st.reorder ? '<div class="ma-reorder">Time to reorder? — ' + esc(st.reorder) + '</div>' : '') +
      '<div class="ma-facts">' + facts.map(f => '<div class="ma-fact"><b>' + esc(f[0]) + '</b><span>' + esc(f[1]) + '</span></div>').join('') + '</div>' +
      '<div class="ma-inl"><b>Count</b> — what is left on the shelf? <input type="number" step="any" min="0" id="stCount" placeholder="qty"> ' + esc(pl(m.base_label)) + ' <input id="stLoc" placeholder="location (optional)" style="width:150px"> <button class="bk-btn pri sm" id="stCountGo">Save count</button></div>' +
      '<div class="ma-inl"><b>Received</b> <input type="number" step="any" min="0" id="stIn" placeholder="qty"> <select id="stInUnit"><option value="base">' + esc(pl(m.base_label)) + '</option>' + (act.length ? '<option value="buy">' + 'buy units of →</option>' : '') + '</select>' +
      (act.length ? '<select id="stInSrc">' + srcOpt + '</select>' : '') + ' <input id="stInNote" placeholder="note" style="width:140px"> <button class="bk-btn sm" id="stInGo">Add to stock</button></div>' +
      '<div class="ma-muted" style="margin-bottom:6px">' + (SET.invoice_receives ? 'Invoice lines linked to this material are added here by themselves.' : 'Invoice lines do not add to stock (Price alerts → Settings).') + '</div>' +
      ((st.entries || []).length ? '<table class="ma-st"><thead><tr><th>When</th><th>What</th><th>Qty</th><th>On hand after</th><th>By</th><th></th></tr></thead><tbody>' + st.entries.map(e => '<tr><td>' + usD(e.at) + '</td><td>' + esc(kindL[e.kind] || e.kind) +
        (e.kind === 'count' && e._used != null && e._used > 0 ? ' <span class="ma-pill blue">used ' + nf(e._used) + ' since last count</span>' : '') + (e.note ? '<div class="ma-sub">' + esc(e.note) + '</div>' : '') + (e.location ? '<div class="ma-sub">' + esc(e.location) + '</div>' : '') + '</td>' +
        '<td>' + (e.kind === 'count' ? '' : '+') + nf(e.qty) + (e.buy_qty ? '<div class="ma-sub">' + nf(e.buy_qty) + ' bought</div>' : '') + '</td><td>' + nf(e._after) + '</td><td class="ma-sub">' + esc(who(e.by)) + '</td><td><button class="bk-btn sm x" data-stdel="' + e.id + '" title="Remove this entry">×</button></td></tr>').join('') + '</tbody></table>' : '<div class="ma-muted">No counts or receipts yet — start with a count of what is on the shelf.</div>');
  }
  function bindStock(m) {
    if (!$('stCountGo')) return;
    $('stCountGo').onclick = async () => { const q = $('stCount').value; if (q === '') return; const r = await api('/api/material-ai/materials/' + m.id + '/stock', { kind: 'count', qty: q, location: $('stLoc').value }); if (!r.ok) return alert(r.error); toast('Count saved'); reloadOne(m.id); };
    $('stInGo').onclick = async () => { const q = $('stIn').value; if (q === '') return; const unit = $('stInUnit').value; const r = await api('/api/material-ai/materials/' + m.id + '/stock', { kind: 'receive', qty: q, unit, source_id: $('stInSrc') ? $('stInSrc').value : null, note: $('stInNote').value }); if (!r.ok) return alert(r.error); toast('+' + nf(r.qty) + ' ' + pl(m.base_label)); reloadOne(m.id); };
    $('maDrawer').querySelectorAll('[data-stdel]').forEach(b => b.onclick = async () => { if (!confirm('Remove this entry?')) return; await api('/api/material-ai/stock/' + b.dataset.stdel + '/delete', {}); reloadOne(m.id); });
  }

  // ---- Prices
  function pricesHtml(m) {
    const al = (m.alert_rows || []), um = m.unmatched_rows || [];
    return (al.filter(a => a.status === 'open').length ? '<h4 style="margin:0 0 6px;font-size:13px">Open alerts</h4>' + al.filter(a => a.status === 'open').map(a => alertRow(a, true)).join('') : '') +
      (um.length ? '<h4 style="margin:12px 0 6px;font-size:13px">Billed by a vendor with no supplier item</h4>' + um.map(umRow).join('') : '') +
      '<h4 style="margin:14px 0 6px;font-size:13px">Invoice prices</h4>' +
      ((m.prices || []).length ? '<table class="ma-st"><thead><tr><th>Date</th><th>Vendor</th><th>Invoice line</th><th>Qty</th><th>Price</th></tr></thead><tbody>' + m.prices.map(p => '<tr><td>' + usD(p.at) + '</td><td>' + esc(p.vendor_name || '') + '</td><td class="ma-sub">' + esc(p.line_text || '') +
        '<div>' + (p.ref_kind === 'bill' ? 'bill #' + p.ref_id : 'purchase item') + '</div></td><td>' + nf(p.qty) + '</td><td><b>' + usdU(p.price) + '</b> <span class="ma-sub">' + (p.per === 'unit' ? 'each' : 'per buy unit') + '</span></td></tr>').join('') + '</tbody></table>'
        : '<div class="ma-muted">No invoice has been linked to this material yet. In BookkeeperAI, link a bill line or purchase item to it (Link… → material) and its price lands here.</div>');
  }
  function bindPrices(m) { bindAlertActs($('maDrawer'), () => reloadOne(m.id)); }
  function usedHtml(m) {
    const u = m.used_in || [];
    return u.length ? '<p class="ma-p">The website product options that use this material — whichever vendor it came from, the customer sees the same option.</p><table class="ma-st"><thead><tr><th>Product</th><th>Field</th><th>Option</th></tr></thead><tbody>' +
      u.map(x => '<tr><td>' + esc(x.title) + ' <span class="ma-sub">#' + x.id + '</span></td><td>' + esc(x.field) + '</td><td>' + esc(x.option_title) + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="ma-muted">No product option is linked to this material in the CRM yet.</div>';
  }

  // ---- alerts (tab and drawer)
  function alertRow(a, inDrawer) {
    const up = a.pct > 0, per = a.per === 'unit' ? 'each' : 'per ' + (a.buy_unit ? lbl(V.buy_unit, a.buy_unit).toLowerCase() : 'buy unit');
    const decided = a.status !== 'open';
    return '<div class="ma-alert" data-al="' + a.id + '">' + (inDrawer ? '<span></span>' : photo(a.material && a.material.photo)) +
      '<div class="t"><b>' + esc(inDrawer ? (a.vendor_name || '') : (a.material ? a.material.name : '')) + '</b>' + (inDrawer ? '' : ' <span class="ma-muted">· ' + esc(a.vendor_name || '') + '</span>') +
      '<div class="s">Invoice ' + usD(a.at) + ': <b>' + usdU(a.found) + '</b> ' + esc(per) + ' vs <b>' + usdU(a.expected) + '</b> on file · <span class="ma-delta ' + (up ? 'up' : 'down') + '">' + (up ? '+' : '') + nf(a.pct, 1) + '%</span>' +
      (a.ref_kind === 'bill' ? ' · bill #' + a.ref_id : '') + (a.line_text ? ' · ' + esc(a.line_text) : '') + '</div>' +
      (decided ? '<div class="s">' + esc(a.status) + ' by ' + esc(who(a.decided_by)) + ' · ' + usD(a.decided_at) + '</div>' : '') + '</div>' +
      '<div class="acts">' + (decided ? '<button class="bk-btn sm" data-alact="reopen">Reopen</button>' : '<button class="bk-btn go sm" data-alact="accept" title="Make the invoice price the price on file">Accept new price</button><button class="bk-btn warn sm" data-alact="renegotiate">Renegotiate</button><button class="bk-btn sm" data-alact="dismiss">Dismiss</button>') + '</div></div>';
  }
  function umRow(u) {
    return '<div class="ma-alert" data-um="' + u.id + '"><span>' + (u.material ? photo(u.material.photo) : '') + '</span><div class="t"><b>' + esc(u.material ? u.material.name : '') + '</b> <span class="ma-muted">· ' + esc(u.vendor_name || 'unknown vendor') + '</span>' +
      '<div class="s">' + usD(u.at) + ' · ' + esc(u.line_text || '') + ' · qty ' + nf(u.qty) + ' · ' + usdU(u.price) + (u.ref_kind === 'bill' ? ' · bill #' + u.ref_id : '') + '</div></div>' +
      '<div class="acts"><button class="bk-btn pri sm" data-umact="add">Add as supplier item</button><button class="bk-btn sm" data-umact="dismiss">Not this material</button></div></div>';
  }
  const ALERT_CACHE = {};
  function bindAlertActs(root, after) {
    root.querySelectorAll('[data-al] [data-alact]').forEach(b => b.onclick = async () => {
      const row = b.closest('[data-al]'), id = row.dataset.al, act = b.dataset.alact;
      if (act === 'renegotiate') {
        const a = ALERT_CACHE[id] || (DET && (DET.alert_rows || []).find(x => String(x.id) === id));
        if (a) showDraft(row, a);
      }
      const r = await api('/api/material-ai/alerts/' + id, { action: act }); if (!r.ok) return alert(r.error);
      toast(act === 'accept' ? 'Price on file updated' : act === 'renegotiate' ? 'Marked to renegotiate — draft below' : act === 'dismiss' ? 'Dismissed' : 'Reopened');
      if (act !== 'renegotiate') after();
    });
    root.querySelectorAll('[data-um] [data-umact]').forEach(b => b.onclick = async () => {
      const id = b.closest('[data-um]').dataset.um; const r = await api('/api/material-ai/unmatched/' + id + '/' + b.dataset.umact, {}); if (!r.ok) return alert(r.error);
      toast(b.dataset.umact === 'add' ? 'Supplier item added — open the material to set its size and pack' : 'Dismissed'); after();
    });
  }
  function showDraft(row, a) {
    const name = a.material ? a.material.name : (DET ? DET.name : 'this material');
    const per = a.per === 'unit' ? 'per piece' : 'per ' + (a.buy_unit ? lbl(V.buy_unit, a.buy_unit).toLowerCase() : 'unit');
    const text = 'Hi,\n\nOn your invoice of ' + usD(a.at) + ' the ' + name + ' came in at ' + usdU(a.found) + ' ' + per + ', while our price on file is ' + usdU(a.expected) + ' (' + (a.pct > 0 ? '+' : '') + nf(a.pct, 1) + '%).\n\n' +
      'Could you look into it and confirm the price going forward? We order this regularly and would like to keep it at ' + usdU(a.expected) + ' if possible.\n\nThank you,\nAxiomPrint';
    const d = document.createElement('div'); d.className = 'ma-draft';
    d.innerHTML = esc(text) + '<div style="margin-top:8px;display:flex;gap:6px"><button class="bk-btn sm" data-copy>Copy</button>' + (a.vendor_email ? '<a class="bk-btn sm" style="text-decoration:none" href="mailto:' + esc(a.vendor_email) + '?subject=' + encodeURIComponent('Price on ' + name) + '&body=' + encodeURIComponent(text) + '">Open in email</a>' : '') + '</div>';
    d.querySelector('[data-copy]').onclick = () => { navigator.clipboard.writeText(text).then(() => toast('Copied')); };
    row.appendChild(d);
  }
  async function loadAlerts(fresh) {
    const j = await api('/api/material-ai/alerts' + (fresh ? '?fresh=1' : '')); if (!j.ok) { $('alOpen').innerHTML = '<div class="ma-muted">' + esc(j.error) + '</div>'; return; }
    if (!V.buy_unit) { const v = await api('/api/material-ai/vocab'); V = v.vocab || {}; }
    j.open.concat(j.done).forEach(a => { ALERT_CACHE[a.id] = a; });
    $('alN').textContent = j.open.length ? j.open.length + ' open' : '';
    $('alOpen').innerHTML = j.open.length ? j.open.map(a => alertRow(a)).join('') : '<div class="ma-muted">No price off by ' + esc(j.settings.alert_pct) + '% or more. Prices are checked each time BookkeeperAI links an invoice line to a material.</div>';
    $('umN').textContent = j.unmatched.length || ''; $('alUmCard').style.display = j.unmatched.length ? '' : 'none';
    $('alUm').innerHTML = j.unmatched.map(umRow).join('');
    $('doneN').textContent = j.done.length || ''; $('alDone').innerHTML = j.done.length ? j.done.map(a => alertRow(a)).join('') : '<div class="ma-muted">Nothing decided yet.</div>';
    $('setPct').value = j.settings.alert_pct; $('setRecv').checked = !!j.settings.invoice_receives; $('setTo').value = j.settings.alert_to || '';
    bindAlertActs(document.querySelector('.ma-view[data-v="alerts"]'), () => { loadAlerts(); load(); });
    document.querySelectorAll('.ma-view[data-v="alerts"] [data-al] .t').forEach(t => { t.style.cursor = 'pointer'; t.onclick = () => { const a = ALERT_CACHE[t.closest('[data-al]').dataset.al]; if (a) openMat(a.material_id, 'prices'); }; });
  }
  $('alRun').onclick = async () => { const r = await api('/api/material-ai/sweep', {}); toast(r.ok ? 'Checked ' + (r.lines || 0) + ' new invoice line' + (r.lines === 1 ? '' : 's') + (r.alerts ? ' · ' + r.alerts + ' alert' + (r.alerts === 1 ? '' : 's') : '') : (r.error || 'Failed')); loadAlerts(); load(); };
  $('setSave').onclick = async () => { const r = await api('/api/material-ai/settings', { alert_pct: $('setPct').value, invoice_receives: $('setRecv').checked, alert_to: $('setTo').value }); if (r.ok) { SET = r.settings; toast('Saved'); } else alert(r.error); };

  // ---- Inventory tab
  let stMode = 'tracked';
  document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { stMode = b.dataset.st; document.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('on', x === b)); drawStock(); });
  $('stQ').oninput = () => drawStock();
  function drawStock() {
    const q = $('stQ').value.trim().toLowerCase();
    const rows = LIST.filter(m => (stMode === 'all' || m.stock.on_hand != null) && (!q || (m.name + ' ' + (m.code || '')).toLowerCase().indexOf(q) > -1));
    const tb = document.querySelector('#stTable tbody');
    tb.innerHTML = rows.length ? rows.map(m => { const st = m.stock; return '<tr data-id="' + m.id + '"><td style="width:52px">' + photo(m.photo) + '</td><td class="ma-nm"><b>' + esc(m.name) + '</b><div class="s">' + esc(m.code || '') + '</div></td>' +
      '<td>' + (st.on_hand != null ? '<span class="ma-num">' + nf(st.on_hand) + '</span> <span class="ma-sub">' + esc(m.base_label) + '</span>' : '<span class="ma-muted">—</span>') + (m.crm_stock ? '<div class="ma-sub">CRM says ' + nf(m.crm_stock) + '</div>' : '') + '</td>' +
      '<td>' + usD(st.last_count) + '</td><td>' + usD(st.last_in) + '</td><td>' + nf(st.used_per_week) + '</td><td>' + (st.days_left != null ? st.days_left : '—') + (st.reorder ? ' <span class="ma-pill amber">reorder?</span>' : '') + '</td>' +
      '<td style="white-space:nowrap" class="stc"><button class="bk-btn sm" data-cnt="' + m.id + '">Count</button></td></tr>'; }).join('')
      : '<tr><td colspan="8" class="ma-muted" style="padding:20px">' + (stMode === 'tracked' ? 'Nothing counted yet. Switch to "All materials" and press Count to start.' : 'Nothing matches.') + '</td></tr>';
    tb.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = (e) => { if (e.target.closest('.stc')) return; openMat(Number(tr.dataset.id), 'stock'); });
    tb.querySelectorAll('[data-cnt]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); const cell = b.parentNode, m = LIST.find(x => x.id === Number(b.dataset.cnt));
      cell.innerHTML = '<span style="display:inline-flex;gap:4px;align-items:center">left: <input type="number" min="0" step="any" style="width:80px;height:28px;border:1px solid var(--line);border-radius:6px;padding:0 6px"> <button class="bk-btn pri sm">Save</button></span>';
      const inp = cell.querySelector('input'); inp.focus();
      const go = async () => { if (inp.value === '') return; const r = await api('/api/material-ai/materials/' + m.id + '/stock', { kind: 'count', qty: inp.value }); if (!r.ok) return alert(r.error); toast('Count saved'); await load(); };
      cell.querySelector('button').onclick = go; inp.onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
    });
  }

  // ---- Reorder tab
  function drawReorder() {
    const rows = LIST.filter(m => m.stock.receipts > 0 || m.stock.reorder).sort((a, b) => (b.stock.reorder ? 1 : 0) - (a.stock.reorder ? 1 : 0) || String(a.stock.next_expected || '9').localeCompare(String(b.stock.next_expected || '9')));
    const tb = document.querySelector('#roTable tbody');
    tb.innerHTML = rows.length ? rows.map(m => { const st = m.stock; return '<tr data-id="' + m.id + '"><td style="width:52px">' + photo(m.photo) + '</td><td class="ma-nm"><b>' + esc(m.name) + '</b><div class="s">' + esc((m.sources.find(s => s.preferred) || {}).vendor_name || '') + '</div></td>' +
      '<td>' + (st.reorder ? '<span class="ma-pill amber">' + esc(st.reorder) + '</span>' : '<span class="ma-pill green">not yet</span>') + '</td><td>' + st.receipts + '×</td><td>' + (st.cycle_days ? st.cycle_days + ' days' : '<span class="ma-muted">needs 2 receipts</span>') + '</td>' +
      '<td>' + (st.avg_in != null ? nf(st.avg_in) + ' <span class="ma-sub">' + esc(m.base_label) + '</span>' : '—') + '</td><td>' + usD(st.last_in) + '</td><td>' + usD(st.next_expected) + '</td><td>' + (st.days_left != null ? st.days_left : '—') + '</td></tr>'; }).join('')
      : '<tr><td colspan="9" class="ma-muted" style="padding:20px">No receipts yet. They come from invoice lines linked to a material in BookkeeperAI, or from "Received" on a material. Two receipts give the first cycle.</td></tr>';
    tb.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openMat(Number(tr.dataset.id), 'stock'));
  }

  load().then(() => { const t = params.get('tab'); if (t && t !== 'materials') show(t); const m = Number(params.get('m')); if (m) openMat(m); });
})();
