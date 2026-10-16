// Bookkeeping AI — the Daily Brief (approve / reject / answer), transactions, bills, rules, connections, activity.
(function () {
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '-' + m[3] + '-' + m[1] : String(d || ''); };   // 2026-10-08 → 10-08-2026 (shared since 1.19.89)
  const usd = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$/.test(ts) ? '' : 'Z')); return isNaN(d) ? ts : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } }, opts || {}));
    if (r.status === 401) { location.href = '/'; throw new Error('signed out'); }
    if (r.status === 403) { document.querySelector('.bk-main').innerHTML = '<div class="bk-card">Bookkeeping AI is not open to this account.</div>'; throw new Error('forbidden'); }
    return r.json();
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  // 1.19.153: /nova-ar is this page in AR-only mode — the Nova AR tab alone, for people with the AR role but not Bookkeeping
  const AR_ONLY = location.pathname.replace(/\/+$/, '') === '/nova-ar';
  NovaNav.mount({ current: AR_ONLY ? 'ar' : 'books' });
  if (AR_ONLY) {
    document.title = 'Nova AR · NovaAI';
    document.body.classList.add('ar-only');
    const h1 = document.querySelector('.bk-top h1'); if (h1) { const svg = h1.querySelector('svg'); h1.textContent = ' Nova AR'; if (svg) h1.prepend(svg); }
    document.querySelectorAll('.bk-tabs.main button').forEach(b => { if (b.dataset.v !== 'ar' && b.dataset.v !== 'aging') b.remove(); });   // 1.20.83: Nova AR · Acct Aging
    const t2 = document.getElementById('tabs2'); if (t2) t2.remove();
    const rs = document.getElementById('runState'); if (rs) rs.remove();
    const bub = document.getElementById('bkBub'); if (bub) bub.remove(); const bp = document.getElementById('bkBubPanel'); if (bp) bp.remove();
  }
  else { document.querySelectorAll('.bk-tabs.main button[data-v="ar"], .bk-tabs.main button[data-v="aging"]').forEach(t => t.remove()); }   // Nova AR lives in the left menu, not among the Bookkeeping tabs

  let ov = null, categories = [], chart = [];
  document.querySelectorAll('.bk-tabs button').forEach(b => b.onclick = () => show(b.dataset.v));
  // Main tabs with sub-tabs: Accounts (vendors / chart / rules) and Bills (bills / inbox). show('chart') or
  // show('inbox') opens that sub-tab directly; the last sub-tab of each is remembered per browser.
  const BILL_SUBS = { all: ['draft', 'approved', 'scheduled', 'paid', 'rejected'], pending: ['draft'], approved: ['approved'], scheduled: ['scheduled'], paid: ['paid'], rejected: ['rejected'] };
  let billSub = 'pending';
  const TABS = { accounts: { bar: 'subAccounts', subs: { vendors: loadVendors, equipment: loadEquipment, loans: loadLoans, team: loadTeam, chart: loadChart, rules: loadRules, materials: loadMaterials, nova: loadNovaVendors }, first: 'vendors' },
    purchases: { bar: 'subPurchases', subs: { list: () => loadPurchases('list'), waiting: () => loadPurchases('waiting'), notreceived: () => loadPurchases('notreceived') }, first: 'list' },
    bank: { bar: 'subBank', subs: { all: () => loadTxns(''), new: () => loadTxns('new'), pending: () => loadTxns('pending'), old: () => loadTxns('old'), categorized: () => loadTxns('categorized'), auto: () => loadTxns('auto'), stats: () => loadTxns('stats') }, first: 'pending' },   // 1.19.54: Bank feed is a top tab
    ar: { bar: 'subAr', subs: { open: () => loadAr('open'), done: () => loadAr('done'), rules: () => loadArRules() }, first: 'open' },   // 1.19.152: Nova AR
    aging: { bar: 'subAging', subs: { all: () => loadAging('all'), b0: () => loadAging('0-30'), b1: () => loadAging('31-60'), b2: () => loadAging('61-90'), b3: () => loadAging('90+') }, first: 'all' },   // 1.20.83: Acct Aging
    bills: { bar: 'subBills', subs: { all: () => loadBills('all'), pending: () => loadBills('pending'), approved: () => loadBills('approved'), scheduled: () => loadBills('scheduled'), paid: () => loadBills('paid'), rejected: () => loadBills('rejected') }, first: 'pending' } };
  // sub tabs as chips with an icon each (same look as the Inbox baskets)
  const SUB_ICON = { rules: 'sparkles', b0: 'calendar', b1: 'calendar', b2: 'calendar', b3: 'calendar', open: 'clock', done: 'check', nova: 'sparkles', all: 'landmark', new: 'sparkles', categorized: 'check', auto: 'zap', stats: 'trendup', pending: 'clock', old: 'calendar', approved: 'check', scheduled: 'calendar', paid: 'dollar', rejected: 'x', list: 'cart', bank: 'landmark', waiting: 'clock', notreceived: 'package', vendors: 'users', equipment: 'printer', chart: 'layers', rules: 'target', materials: 'box' };
  document.querySelectorAll('.bk-sub button').forEach(b => { b.onclick = () => show(b.closest('.bk-view').dataset.v, b.dataset.s); });
  $('puQ').onkeydown = (e) => { if (e.key === 'Enter') loadPurchases(lastSub.purchases); };
  { let arT = null; const arRun = () => show('ar', lastSub.ar || 'open'); $('arQ').oninput = () => { clearTimeout(arT); arT = setTimeout(arRun, 350); }; $('arQ').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(arT); arRun(); } }; }
  { let agT = null; const agRun = () => { const b = lastSub.aging || 'all'; show('aging', b); }; $('agQ').oninput = () => { clearTimeout(agT); agT = setTimeout(agRun, 300); }; $('agQ').onkeydown = (e) => { if (e.key === 'Enter') agRun(); }; }   // 1.19.29: one search for every Purchases view
  $('txQ').onkeydown = (e) => { if (e.key === 'Enter') loadTxns(); if (e.key === 'Escape') { $('txQ').value = ''; loadTxns(); } };
  // 1.19.128: emptying the box (Backspace, the field's ×) goes back to the full list on its own; typing searches after a pause
  let txQT = null, txQLast = '';
  $('txQ').oninput = () => { const v = $('txQ').value.trim(); clearTimeout(txQT); if (!v && txQLast) { txQLast = ''; loadTxns(); return; } txQT = setTimeout(() => { if (v !== txQLast) { txQLast = v; loadTxns(); } }, 450); };
  $('txQ').onsearch = () => { if (!$('txQ').value) loadTxns(); };
  const lastSub = {}; Object.keys(TABS).forEach(k => { try { lastSub[k] = localStorage.getItem('bk_sub_' + k) || TABS[k].first; } catch (e) { lastSub[k] = TABS[k].first; } });
  lastSub.bills = 'pending'; lastSub.bank = 'pending';   // 1.19.53: Bills and the Bank feed always open on Pending (All and the other statuses are a click away)
  function show(v, sub) {
    Object.keys(TABS).forEach(k => { if (TABS[k].subs[v] && v !== k) { sub = v; v = k; } });
    document.querySelectorAll('.bk-tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    document.querySelectorAll('.bk-view').forEach(s => s.classList.toggle('on', s.dataset.v === v));
    const T = TABS[v];
    if (T) {
      sub = T.subs[sub] ? sub : lastSub[v]; lastSub[v] = sub; try { localStorage.setItem('bk_sub_' + v, sub); } catch (e) {}
      document.querySelectorAll('#' + T.bar + ' button').forEach(b => b.classList.toggle('on', b.dataset.s === sub));
      if (v !== 'bills' && v !== 'bank' && v !== 'ar' && v !== 'aging') document.querySelectorAll('.bk-view[data-v="' + v + '"] .bk-subview').forEach(s => s.classList.toggle('on', s.dataset.s === sub));
      T.subs[sub]();
      try { history.replaceState(null, '', (AR_ONLY ? '/nova-ar?tab=' : '/bookkeeping?tab=') + v + '&sub=' + sub); } catch (e) {}
      return;
    }
    ({ brief: loadBrief, inbox: loadInbox, conn: loadConn, activity: loadActivity })[v]();
    try { history.replaceState(null, '', '/bookkeeping?tab=' + v); } catch (e) {}
  }
  // A person as a small face (photo or initial) with the name on hover; the agent, executor and poll keep their word.
  function whoHtml(w) {
    const t = String(w || ''); if (!t) return '';
    const key = t.toLowerCase().replace(/^(user|member):/, '');
    const m = (ov && ov.people || []).find(p => (p.email || '').toLowerCase() === key || (p.username || '').toLowerCase() === key);
    if (!m && t.indexOf('@') < 0) return '<span class="bk-who-sys">' + esc(t) + '</span>';
    const name = m ? m.name : t, init = esc(String(name).trim().charAt(0).toUpperCase() || '?');
    return '<span class="bk-who" title="' + esc(name) + (m && m.email && m.email !== name ? ' · ' + esc(m.email) : '') + '">' + (m && m.photo ? '<img src="' + esc(m.photo) + '" alt="" onerror="this.replaceWith(document.createTextNode(\'' + init + '\'))">' : init) + '</span>';
  }
  const noteHtml = (n) => esc(n || '').replace(/((?:marked read|moved to \S+|set aside|do later|approved|rejected|answered) by )(\S+)/g, (_, pre, w) => pre + whoHtml(w));
  // 1.19.93: a modal closes on a backdrop click only when the press started on the backdrop too. Dragging to select text in a
  // field and letting go outside the box used to count as a backdrop click (the click lands on the common ancestor) and
  // threw the form away mid-edit.
  let downAt = null;
  document.addEventListener('mousedown', (e) => { downAt = e.target; }, true);
  document.addEventListener('click', (e) => { if (e.target.classList && e.target.classList.contains('bk-modal') && downAt !== e.target) { e.stopPropagation(); e.preventDefault(); } }, true);
  // A styled yes / no instead of the browser's confirm(). Resolves true on the main button, false on Cancel / Esc / backdrop.
  // 1.19.117: a vendor name short enough for a question or a button — long official names get cut with an ellipsis
  const shortName = (who, max) => { who = String(who || '').trim(); max = max || 26; return who.length > max ? who.slice(0, max - 1).trim() + '…' : who; };
  // 1.19.119: small flags for the overseas team (18×12, drawn inline — no image requests)
  const FLAG = {
    AM: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="18" height="4" fill="#d90012"/><rect y="4" width="18" height="4" fill="#0033a0"/><rect y="8" width="18" height="4" fill="#f2a800"/></svg>',
    MX: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="6" height="12" fill="#006847"/><rect x="6" width="6" height="12" fill="#fff"/><rect x="12" width="6" height="12" fill="#ce1126"/><circle cx="9" cy="6" r="1.6" fill="#8a6a2b"/></svg>',
    PH: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="18" height="6" fill="#0038a8"/><rect y="6" width="18" height="6" fill="#ce1126"/><path d="M0 0l8 6-8 6z" fill="#fff"/><circle cx="2.6" cy="6" r="1.1" fill="#fcd116"/></svg>',
    other: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="18" height="12" fill="#e5e7eb"/><circle cx="9" cy="6" r="4" fill="none" stroke="#94a3b8" stroke-width="1"/><path d="M5 6h8M9 2v8" stroke="#94a3b8" stroke-width="1"/></svg>'
  };
  const flag = (code, title) => '<span class="tm-flag" title="' + esc(title || { AM: 'Armenia', MX: 'Mexico', PH: 'Philippines' }[code] || '') + '">' + (FLAG[code] || FLAG.other) + '</span>';
  const TEAMI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>';
  // 1.19.130: a small notice bottom-centre that fades by itself ("Learned “emperor steel” · 3 more lines linked")
  function toast(html, ms) { const el = document.createElement('div'); el.className = 'bk-toast'; el.innerHTML = html; document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('on')); setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 400); }, ms || 4500); }
  const learnedNote = (r, who) => { if (!r || (!r.learned && !r.relinked)) return; toast((r.learned ? 'Read from the bank: <b>' + esc(String(r.learned).toUpperCase()) + '</b>' + (who ? ' → ' + esc(who) : '') : 'Bank names updated') + (r.relinked ? ' · <b>' + r.relinked + '</b> more line' + (r.relinked === 1 ? '' : 's') + ' linked' : '')); };
  function ask(text, opt) {
    opt = opt || {};
    return new Promise((resolve) => {
      const el = document.createElement('div'); el.className = 'bk-modal bk-ask';
      el.innerHTML = '<div class="bk-modal-box bk-ask-box">' + (opt.title ? '<div class="bk-modal-title">' + esc(opt.title) + '</div>' : '') + '<div class="bk-ask-text">' + esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</div>' +
        '<div class="bk-ask-acts">' + (opt.cancel === false ? '' : '<button class="bk-btn" data-no>' + esc(opt.cancel || 'Cancel') + '</button>') + (opt.alt ? '<button class="bk-btn" data-alt>' + esc(opt.alt) + '</button>' : '') + '<button class="bk-btn ' + (opt.danger ? 'bad' : 'p') + '" data-yes>' + esc(opt.ok || 'OK') + '</button></div></div>'   // 1.19.117: **bold** markup in the text (escaped first, so names are safe)
      document.body.appendChild(el);
      const done = (v) => { el.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
      document.addEventListener('keydown', onKey);
      el.onclick = (e) => { if (e.target === el) done(false); };
      const nb = el.querySelector('[data-no]'); if (nb) nb.onclick = () => done(false); el.querySelector('[data-yes]').onclick = () => done(true);
      const ab = el.querySelector('[data-alt]'); if (ab) ab.onclick = () => done('alt');   // a third choice resolves 'alt' (1.19.77)
      el.querySelector('[data-yes]').focus();
    });
  }
  async function overview() {
    if (AR_ONLY) {   // 1.19.153: the AR page only needs who-is-who and its own count
      const j = await api('/api/bookkeeping/ar/me'); ov = { me: j.me, ar: j.ar !== false, people: j.people || [], counts: { ar_open: j.open || 0 }, settings: {}, chart: [], connections: {} };
      if (!ov.ar && !document.body.classList.contains('aging-only')) {   /* 1.20.88: the Acct Aging role — the report only, no queue */
        document.body.classList.add('aging-only'); document.title = 'Acct Aging · NovaAI';
        document.querySelectorAll('.bk-tabs.main button[data-v="ar"]').forEach(b => b.remove());
        const h1 = document.querySelector('.bk-top h1'); if (h1) { const svg = h1.querySelector('svg'); h1.textContent = ' Acct Aging'; if (svg) h1.prepend(svg); }
      }
      if ($('nAr')) $('nAr').textContent = ov.counts.ar_open || '';
      return ov;
    }
    ov = await api('/api/bookkeeping/overview');
    chart = ov.chart || [];
    categories = chart.filter(c => c.parent || !c.children).map(c => c.name).filter((n, i, a) => a.indexOf(n) === i);
    $('nPending').textContent = ov.counts.pending || '';
    if ($('nAr')) $('nAr').textContent = ov.counts.ar_open || '';
    $('nTxns').textContent = ov.counts.txn_open || ''; $('nTxns').title = (ov.counts.txn_open || 0) + ' transactions without a decided category';
    $('nBills').textContent = ov.counts.bill_drafts || ''; $('nBills').title = (ov.counts.bill_drafts || 0) + ' bill drafts waiting';
    const bs = ov.counts.bills_by_status || {}; $('nBillsPending').textContent = bs.draft || 0; if ($('nBillsAll')) $('nBillsAll').textContent = Object.values(bs).reduce((a, n) => a + n, 0); $('nBillsApproved').textContent = bs.approved || 0; $('nBillsScheduled').textContent = bs.scheduled || 0; $('nBillsPaid').textContent = bs.paid || 0; if ($('nBillsRejected')) $('nBillsRejected').textContent = bs.rejected || 0;
    $('nInbox').textContent = (ov.counts.inbox_new || 0) + (ov.counts.inbox_messages || 0) || ''; $('nInbox').title = (ov.counts.inbox_new || 0) + ' not looked at yet, ' + (ov.counts.inbox_messages || 0) + ' messages for a person';
    const rs = $('runState');
    if (ov.running) { rs.className = 'bk-pill off'; rs.textContent = 'Running…'; }
    else if (ov.last_run) { rs.className = 'bk-pill ' + (ov.last_run.ok ? 'on' : 'err'); rs.textContent = ov.last_run.ok ? 'Last run ' + when(ov.last_run.started_at) : 'Run failed ' + when(ov.last_run.started_at) + ' — ' + String(ov.last_run.summary || 'no details').slice(0, 70) + (String(ov.last_run.summary || '').length > 70 ? '…' : ''); rs.title = ov.last_run.summary || ''; rs.style.cursor = 'pointer';
      rs.onclick = () => alert((ov.last_run.ok ? 'Last run ' : 'Last run FAILED ') + when(ov.last_run.started_at) + (ov.last_run.started_by ? ' (' + ov.last_run.started_by + ')' : '') + '\n\n' + (ov.last_run.summary || 'no details') + '\n\nEvery run is listed under Activity.'); }
    else { rs.className = 'bk-pill off'; rs.textContent = 'Not run yet'; }
    return ov;
  }
  // ---------------------------------------------------------------- "?" help: hover = tooltip, click = popup
  const HELP = {};
  const qHelp = (key, title, html) => { HELP[key] = { title, html }; return '<button type="button" class="bk-q" data-help="' + esc(key) + '">?</button>'; };
  // Hover tips stay while the pointer is on them (so long text can be read, links clicked). [data-help] = a registered
  // "?" help; [data-tip] = the element's own text (e.g. the rating's reason). Shared by both.
  let tipEl = null, tipFor = null, tipTimer = null;
  const tipHide = () => { clearTimeout(tipTimer); tipTimer = setTimeout(() => { if (tipEl) { tipEl.remove(); tipEl = null; tipFor = null; } }, 140); };
  const tipKeep = () => clearTimeout(tipTimer);
  document.addEventListener('mouseover', (e) => {
    const b = e.target.closest && e.target.closest('[data-help],[data-tip]'); if (!b) return;
    if (tipEl && tipFor === b) { tipKeep(); return; }
    const html = b.dataset.help ? (HELP[b.dataset.help] || {}).html : esc(b.dataset.tip); if (!html) return;
    if (tipEl) { tipEl.remove(); tipEl = null; } clearTimeout(tipTimer);
    tipEl = document.createElement('div'); tipEl.className = 'bk-tip'; tipEl.innerHTML = html; document.body.appendChild(tipEl); tipFor = b;
    const r = b.getBoundingClientRect(), W = Math.min(420, window.innerWidth - 16);
    tipEl.style.width = W + 'px'; tipEl.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - W - 8)) + 'px';
    const below = r.bottom + 8, h = tipEl.offsetHeight; tipEl.style.top = (below + h > window.innerHeight - 8 && r.top - h - 8 > 0 ? r.top - h - 8 : below) + 'px';
    tipEl.addEventListener('mouseenter', tipKeep); tipEl.addEventListener('mouseleave', tipHide);
    const off = () => { tipHide(); b.removeEventListener('mouseleave', off); }; b.addEventListener('mouseleave', off);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-help]'); if (!b) return;
    const h = HELP[b.dataset.help]; if (!h) return;
    if (tipEl) { tipEl.remove(); tipEl = null; }
    const el = document.createElement('div'); el.className = 'bk-help on';
    el.innerHTML = '<div class="bk-help-box"><b>' + esc(h.title) + '</b><span class="bk-x" title="Close">✕</span><p>' + h.html + '</p></div>';
    el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) el.remove(); };
    document.body.appendChild(el);
  });

  // ---------------------------------------------------------------- column filters (a header word that opens a small list)
  // thFilter(key, label, options [{v, l, n}], cur) → header markup; thFilterBind(root, onChange) wires the popovers.
  // Column filters, CRM style: a funnel on the header; click → a popover. spec = an array of options (a list, picked
  // in one click), or { type: 'text', value } (contains), or { type: 'range', kind: 'number' | 'date', from, to,
  // presets: [{v, l}], period } (From / To with Clear / Apply; date ranges can also offer period presets).
  const FUNNEL = '<svg class="thf-f" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>';
  const thActive = (spec, cur) => Array.isArray(spec) ? !!cur : spec.type === 'text' ? !!spec.value : !!(spec.from || spec.to || (spec.period && spec.period !== spec.defaultPeriod) || (spec.groups || []).some(g => g.value));   // 1.19.124: chip groups (Received / Paid, how paid) count as active
  const thFilter = (key, label, spec, cur) => {
    const on = thActive(spec, cur); let val = '';
    if (Array.isArray(spec)) { const o = spec.find(x => x.v === cur); val = o && (cur || o.h != null) ? (o.h != null ? o.h : o.t != null ? esc(o.t) : o.l) : ''; }   // o.h = html shown in the header (an icon slot, kept even when nothing is picked so the header keeps its width)
    else if (spec.type === 'text') val = spec.value ? esc(spec.value) : '';
    else if (spec.type === 'range') { const pr = (spec.presets || []).find(x => x.v === spec.period); val = spec.period && spec.period !== 'custom' && spec.period !== spec.defaultPeriod && pr ? esc(pr.l) : (spec.from || spec.to) ? esc(spec.from && spec.to ? spec.from + ' – ' + spec.to : spec.from ? (spec.kind === 'date' ? 'from ' : '≥ ') + spec.from : (spec.kind === 'date' ? 'to ' : '≤ ') + spec.to) : '';  const gl = (spec.groups || []).filter(g => g.value).map(g => { const o = g.opts.find(x => x[0] === g.value); return o ? o[1] : g.value; }); if (gl.length) val = (val ? val + ' · ' : '') + esc(gl.join(' · ')); }
    // 1.19.83: the header never shows the picked value (it wrapped the row) — an active filter is the label + a red × that clears it;
    // what is picked is in the tooltip and ticked in the popover
    const tip = val ? String(val).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    return '<button type="button" class="thf' + (on ? ' on' : '') + '" data-thf="' + esc(key) + '" data-v="' + esc(cur || '') + '"' + (tip ? ' title="' + esc(label + ': ' + tip) + '"' : '') + '><span class="thf-l">' + esc(label) + '</span>' + (on ? '<i class="thf-x" title="Clear this filter">×</i>' : FUNNEL) + '</button>';
  };
  function thFilterBind(root, specs, onChange) {
    const clearOf = (spec) => Array.isArray(spec) ? '' : spec.type === 'text' ? '' : Object.assign({ from: '', to: '', period: spec.defaultPeriod || '' }, Object.fromEntries((spec.groups || []).map(g => [g.key, ''])));
    root.querySelectorAll('.thf').forEach(btn => btn.onclick = (e) => {
      e.stopPropagation(); document.querySelectorAll('.thf-pop').forEach(p => p.remove());
      const key = btn.dataset.thf, spec = specs[key] || [], cur = btn.dataset.v, label = btn.querySelector('.thf-l').textContent;
      if (e.target.closest('.thf-x')) { onChange(key, clearOf(spec)); return; }
      const pop = document.createElement('div'); pop.className = 'thf-pop';
      const r = btn.getBoundingClientRect(), W = Array.isArray(spec) ? 260 : 300; pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; pop.style.width = W + 'px';
      const place = () => { const h = pop.offsetHeight; if (r.bottom + 6 + h > window.innerHeight - 8 && r.top - h - 6 > 8) pop.style.top = (r.top - h - 6) + 'px'; };   // flip above when short of room
      const close = () => { pop.remove(); document.removeEventListener('click', away); };
      const away = (ev) => { if (!pop.contains(ev.target) && !ev.target.closest('.nd-pop')) close(); }; setTimeout(() => document.addEventListener('click', away), 0);   // 1.19.136: a click in the date picker is inside
      if (Array.isArray(spec)) {
        pop.innerHTML = '<div class="thf-h">' + esc(label) + (cur ? '<button type="button" class="thf-clear thf-hclear">× Clear</button>' : '') + '</div>' + (spec.length > 8 ? '<div class="ckp-search"><input type="text" placeholder="Filter…"></div>' : '') + '<div class="thf-list">' + spec.map(o => '<div class="thf-i' + (o.v === cur ? ' on' : '') + '" data-v="' + esc(o.v) + '"><span class="ckp-ck"></span><span class="thf-t">' + o.l + '</span>' + (o.n != null ? '<small>' + o.n + '</small>' : '') + '</div>').join('') + '</div>';
        document.body.appendChild(pop); place();
        const q = pop.querySelector('input'); if (q) { q.focus(); q.oninput = () => { const f = q.value.toLowerCase(); pop.querySelectorAll('.thf-i').forEach(i => { i.style.display = !f || i.textContent.toLowerCase().indexOf(f) > -1 ? '' : 'none'; }); }; }
        pop.querySelectorAll('.thf-i').forEach(i => i.onclick = () => { close(); onChange(key, i.dataset.v); });
        const hc = pop.querySelector('.thf-hclear'); if (hc) hc.onclick = () => { close(); onChange(key, ''); };
        return;
      }
      if (spec.type === 'text') {
        pop.innerHTML = '<div class="thf-h">' + esc(label) + '</div><div class="thf-body"><label class="thf-lab">Contains</label><input type="text" class="bk thf-in" value="' + esc(spec.value || '') + '" placeholder="' + esc(label) + '…"></div><div class="thf-acts"><button type="button" class="thf-clear">Clear</button><span class="sp"></span><button type="button" class="thf-apply">Apply</button></div>';
        document.body.appendChild(pop); place();
        const inp = pop.querySelector('.thf-in'); inp.focus(); inp.select();
        const apply = () => { close(); onChange(key, inp.value.trim()); };
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') apply(); if (ev.key === 'Escape') close(); };
        pop.querySelector('.thf-apply').onclick = apply; pop.querySelector('.thf-clear').onclick = () => { close(); onChange(key, ''); };
        return;
      }
      // range
      const dt = spec.kind === 'date', it = dt ? 'date' : 'number';
      const gvals = {}; (spec.groups || []).forEach(g => { gvals[g.key] = g.value || ''; });
      pop.innerHTML = '<div class="thf-h">' + esc(label) + (thActive(spec, cur) ? '<button type="button" class="thf-clear thf-hclear">× Clear</button>' : '') + '</div><div class="thf-body">' +
        (spec.presets ? '<div class="thf-presets">' + spec.presets.map(p => '<button type="button" class="ib-chip sm' + (spec.period === p.v && !(spec.from || spec.to) ? ' on' : '') + '" data-p="' + esc(p.v) + '">' + esc(p.l) + '</button>').join('') + '</div>' : '') +
        (spec.groups || []).map(g => '<div class="thf-lab">' + esc(g.label) + '</div><div class="thf-presets thf-group" data-g="' + esc(g.key) + '">' + g.opts.map(o => '<button type="button" class="ib-chip sm' + ((g.value || '') === o[0] ? ' on' : '') + '" data-gv="' + esc(o[0]) + '">' + esc(o[1]) + '</button>').join('') + '</div>').join('') +
        '<div class="thf-range"><label><span class="thf-lab">From</span><input type="' + it + '" class="bk thf-from" ' + (dt ? '' : 'min="0" step="0.01" ') + 'value="' + esc(spec.from || '') + '"></label><label><span class="thf-lab">To</span><input type="' + it + '" class="bk thf-to" ' + (dt ? '' : 'min="0" step="0.01" ') + 'value="' + esc(spec.to || '') + '"></label></div></div>' +
        '<div class="thf-acts"><button type="button" class="thf-clear">Clear</button><span class="sp"></span><button type="button" class="thf-apply">Apply</button></div>';
      document.body.appendChild(pop); place();
      const from = pop.querySelector('.thf-from'), to = pop.querySelector('.thf-to'); from.focus();
      const apply = () => { close(); onChange(key, Object.assign({ from: from.value, to: to.value, period: (from.value || to.value) ? 'custom' : (spec.period || '') }, gvals)); };
      [from, to].forEach(x => x.onkeydown = (ev) => { if (ev.key === 'Enter') apply(); if (ev.key === 'Escape') close(); });
      pop.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { close(); onChange(key, Object.assign({ from: '', to: '', period: b.dataset.p }, gvals)); });
      // 1.19.124: a chip in a group applies on the spot (with whatever From / To say)
      pop.querySelectorAll('.thf-group [data-gv]').forEach(b => b.onclick = () => { gvals[b.closest('.thf-group').dataset.g] = b.dataset.gv; close(); onChange(key, Object.assign({ from: from.value, to: to.value, period: (from.value || to.value) ? 'custom' : (spec.period || '') }, gvals)); });
      const clearAll = () => { close(); onChange(key, clearOf(spec)); };
      pop.querySelector('.thf-apply').onclick = apply; pop.querySelector('.thf-clear').onclick = clearAll; const hc2 = pop.querySelector('.thf-hclear'); if (hc2) hc2.onclick = clearAll;
    });
  }

  // ---------------------------------------------------------------- category picker
  // catSelect(cur, cls, blank, { multi }) draws a picker: a button with the choice (chips when multi) + a hidden input
  // carrying the value (`cls` on both the wrapper and the input, so `root.querySelector('.cls').value` still works; several
  // choices are joined with "; "). Click → a popover: search, the types of expense as collapsible groups, "+ New category…".
  const parentOf = (name) => { const c = chart.find(x => x.name === name && x.parent); return c ? c.parent : ''; };
  // 1.19.114: a short category — the type's coloured icon › sub category, the full "Type › Sub › Sub-sub" on hover
  const catShort = (name) => { if (!name) return ''; const p = parentOf(name), gp = p ? parentOf(p) : '', top = gp || p, st = styleOf(top || name); return '<span class="cat-short" title="' + esc([gp, p, name].filter(Boolean).join(' › ')) + '">' + (top ? tile(st.color, st.icon, 'xs', top.charAt(0)) + '<small>›</small>' : '') + '<b>' + esc(name) + '</b></span>'; };
  const catLabel = (name) => { const p = parentOf(name); if (!p) return esc(name || ''); const gp = parentOf(p); return (gp ? esc(gp) + ' <span class="bk-dim">›</span> ' : '') + esc(p) + ' <span class="bk-dim">›</span> ' + esc(name); };
  const splitCats = (v) => String(v || '').split(/\s*[;|\n]\s*/).map(x => x.trim()).filter(Boolean);
  const catSelect = (cur, cls, blank, o) => {
    o = o || {}; const vals = splitCats(cur);
    return '<span class="ckp ' + esc(cls || '') + (o.multi ? ' multi' : '') + '" data-blank="' + esc(blank || '') + '"' + (o.only ? ' data-only="' + esc(o.only) + '"' : '') + (o.reset ? ' data-reset="1"' : '') + '"><button type="button" class="ckp-btn">' + ckpFace(vals, blank, !!o.multi) + '</button><input type="hidden" class="' + esc(cls || '') + ' ckp-val" value="' + esc(vals.join('; ')) + '"></span>';
  };
  const ckpFace = (vals, blank, multi) => {
    if (!vals.length) return '<span class="ckp-empty">' + esc(blank || 'Choose…') + '</span><span class="ckp-caret"></span>';
    if (!multi) { const p = parentOf(vals[0]), st = styleOf(p || vals[0]); return '<span class="ckp-one">' + (p ? '<small><span class="dot" style="background:' + esc(st.color) + '"></span>' + esc(p) + '</small>' : '') + esc(vals[0]) + '</span><span class="ckp-caret"></span>'; }
    // 1.19.103: a chip names the type of expense before the sub category ("Facilities › Equipment Repairs…"), so the pick is unambiguous
    return vals.map(v => { const par = parentOf(v), st = styleOf(par || v); return '<span class="ckp-chip"><span class="dot" style="background:' + esc(st.color) + '"></span>' + (par ? '<small class="ckp-par">' + esc(par) + ' ›</small> ' : '') + esc(v) + '<i data-rm="' + esc(v) + '" title="Remove">×</i></span>'; }).join('') + '<span class="ckp-caret"></span>';
  };
  const ckpSet = (wrap, vals) => { wrap.querySelector('.ckp-val').value = vals.join('; '); wrap.querySelector('.ckp-btn').innerHTML = ckpFace(vals, wrap.dataset.blank, wrap.classList.contains('multi')); wrap.dispatchEvent(new Event('change', { bubbles: true })); };
  let ckpOpen = null, ckpCollapsed = {}; try { ckpCollapsed = JSON.parse(localStorage.getItem('bk_ckp_collapsed') || '{}') || {}; } catch (e) {}
  function ckpClose() { if (ckpOpen) { ckpOpen.pop.remove(); ckpOpen.wrap.classList.remove('open'); ckpOpen = null; } }
  document.addEventListener('click', (e) => {
    const rm = e.target.closest && e.target.closest('.ckp-chip i[data-rm]');
    if (rm) { const wrap = rm.closest('.ckp'); ckpSet(wrap, splitCats(wrap.querySelector('.ckp-val').value).filter(v => v !== rm.dataset.rm)); e.preventDefault(); return; }
    const btn = e.target.closest && e.target.closest('.ckp-btn');
    if (btn) { const wrap = btn.closest('.ckp'); if (ckpOpen && ckpOpen.wrap === wrap) ckpClose(); else { ckpClose(); ckpShow(wrap); } return; }
    // 1.19.121: a click anywhere outside the popover closes it — inside a form too; a click on the modal backdrop closes the
    // picker but not the form (the backdrop's own close is stopped here)
    if (ckpOpen && !e.target.closest('.ckp-pop')) { const onBackdrop = e.target.classList && e.target.classList.contains('bk-modal'); ckpClose(); if (onBackdrop) { e.stopPropagation(); e.preventDefault(); } }
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ckpOpen) ckpClose(); });
  window.addEventListener('resize', ckpClose); document.querySelector('.bk-main').addEventListener('scroll', ckpClose);
  function ckpShow(wrap) {
    const multi = wrap.classList.contains('multi'), blank = wrap.dataset.blank;
    let vals = splitCats(wrap.querySelector('.ckp-val').value);
    const pop = document.createElement('div'); pop.className = 'ckp-pop' + (multi ? ' multi' : ' single');
    pop.innerHTML = '<div class="ckp-search"><input type="text" placeholder="Search categories…"></div><div class="ckp-list"></div>' +
      '<div class="ckp-foot"><a href="#" class="ckp-new">+ New category…</a>' + (wrap.dataset.reset ? '<a href="#" class="ckp-reset" title="Undo — clear the category and send the line back to Pending">↺ Undo (uncategorize)</a>' : '') + '<span class="sp"></span>' + (blank ? '<a href="#" class="ckp-clear">' + esc(multi ? 'Clear' : blank) + '</a>' : '') + (multi ? '<button type="button" class="bk-btn sm p ckp-done">Done</button>' : '') + '</div>';
    pop.addEventListener('click', (e) => e.stopPropagation());   // clicks inside (which re-draw the list) must not reach the close-on-outside-click handler
    document.body.appendChild(pop);
    const r = wrap.getBoundingClientRect(), W = Math.min(360, window.innerWidth - 16);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.width = W + 'px';
    const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
    if (below >= 300 || below >= above) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.maxHeight = Math.min(420, below) + 'px'; }
    else { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.maxHeight = Math.min(420, above) + 'px'; }
    wrap.classList.add('open'); ckpOpen = { wrap, pop };
    const list = pop.querySelector('.ckp-list'), q = pop.querySelector('input');
    const draw = () => {
      const f = q.value.trim().toLowerCase(); let html = '';
      const only = wrap.dataset.only;   // 1.19.59: 'income' = money in → only the income type(s); 'expense' = everything else
      const tops = chart.filter(c => !c.parent && (!only || (only === 'income' ? !!c.income : !c.income)));
      tops.forEach(t => {
        const subs = t.children ? chart.filter(c => c.parent === t.name) : [];
        const kidsAll = t.children ? subs.flatMap(c => [{ name: c.name, lvl: 2, kids: chart.filter(g => g.parent === c.name).map(g => g.name) }].concat(chart.filter(g => g.parent === c.name).map(g => ({ name: g.name, lvl: 3, up: c.name })))) : [{ name: t.name, lvl: 1 }];
        const kids = kidsAll.map(k => k.name), lvlOf = {}, info = {}; kidsAll.forEach(k => { lvlOf[k.name] = k.lvl; info[k.name] = k; });
        const hit = (n) => n.toLowerCase().indexOf(f) > -1;
        const show = f ? kids.filter(k => hit(k) || hit(t.name) || (info[k].kids || []).some(hit) || (info[k].up && hit(info[k].up))) : kids;   // a match shows its sub above it and its sub-subs below
        if (!show.length) return;
        const col = !f && ckpCollapsed[t.name] && !show.some(k => vals.indexOf(k) > -1);
        const nSel = kids.filter(k => vals.indexOf(k) > -1).length;
        html += '<div class="ckp-g' + (col ? ' col' : '') + '" data-g="' + esc(t.name) + '"><div class="ckp-gh"><span class="ckp-tri"></span>' + tile(t.color, t.icon, 'sm', '') + esc(t.name) + (nSel ? '<b>' + nSel + '</b>' : '') + '<small>' + kids.length + '</small></div>' +
          (t.children ? show.map(k => { const row = chart.find(c => c.name === k && c.parent); const ic = row && row.icon && iconKey(row.icon) ? tile(t.color, row.icon, 'xs', '') : ''; return '<div class="ckp-i' + (vals.indexOf(k) > -1 ? ' on' : '') + (lvlOf[k] === 3 ? ' l3' : '') + '" data-v="' + esc(k) + '"><span class="ckp-ck"></span>' + ic + esc(k) + '</div>'; }).join('') : '<div class="ckp-i top' + (vals.indexOf(t.name) > -1 ? ' on' : '') + '" data-v="' + esc(t.name) + '"><span class="ckp-ck"></span>use as is</div>') + '</div>';
      });
      vals.filter(v => categories.indexOf(v) < 0).forEach(v => { html += '<div class="ckp-g"><div class="ckp-i on" data-v="' + esc(v) + '"><span class="ckp-ck"></span>' + esc(v) + ' <small class="bk-dim">not in the chart</small></div></div>'; });
      list.innerHTML = html || '<div class="bk-muted" style="padding:10px 12px">No match — add it below.</div>';
    };
    draw(); setTimeout(() => q.focus(), 0);
    q.oninput = draw;
    q.onkeydown = (e) => { if (e.key === 'Enter') { const first = list.querySelector('.ckp-i'); if (first) first.click(); e.preventDefault(); } };
    list.onclick = (e) => {
      const gh = e.target.closest('.ckp-gh');
      if (gh) { const g = gh.parentNode; g.classList.toggle('col'); ckpCollapsed[g.dataset.g] = g.classList.contains('col') ? 1 : 0; try { localStorage.setItem('bk_ckp_collapsed', JSON.stringify(ckpCollapsed)); } catch (er) {} return; }
      const it = e.target.closest('.ckp-i'); if (!it) return;
      const v = it.dataset.v;
      if (multi) { vals = vals.indexOf(v) > -1 ? vals.filter(x => x !== v) : vals.concat([v]); ckpSet(wrap, vals); draw(); }
      else { ckpSet(wrap, [v]); ckpClose(); }
    };
    pop.querySelector('.ckp-new').onclick = (e) => { e.preventDefault(); ckpClose(); newCategory(wrap); };
    const rst = pop.querySelector('.ckp-reset'); if (rst) rst.onclick = (e) => { e.preventDefault(); ckpClose(); wrap.dispatchEvent(new CustomEvent('ckp-reset', { bubbles: true })); };   // 1.19.149
    const clr = pop.querySelector('.ckp-clear'); if (clr) clr.onclick = (e) => { e.preventDefault(); vals = []; ckpSet(wrap, vals); if (multi) draw(); else ckpClose(); };
    const done = pop.querySelector('.ckp-done'); if (done) done.onclick = ckpClose;
  }
  // "+ New category…": name + type of expense (an existing one or a new one); the new one is selected in the picker that asked.
  function newCategory(wrap) {
    // 1.19.120: a proper picker — the types of expense as coloured tiles (as in the chart), a "+ New type" tile, the sub
    // category name, and a live "Type › Name" preview; no native dropdown over the form behind
    const tops = chart.filter(c => !c.parent && c.children).map(c => c.name);
    const el = document.createElement('div'); el.className = 'bk-modal nc-modal';
    let parent = '', newType = false;
    const tileFor = (t) => { const st = styleOf(t); return '<button type="button" class="nc-tile" data-t="' + esc(t) + '" style="--c:' + esc(st.color) + '">' + tile(st.color, st.icon, 'xs', t.charAt(0)) + '<span>' + esc(t) + '</span></button>'; };
    el.innerHTML = '<div class="bk-modal-box nc-box"><div class="bk-modal-title">New category</div><div class="bk-muted nc-sub">Where does it live in the chart of accounts?</div>' +
      '<div class="nc-grid">' + tops.map(tileFor).join('') + '<button type="button" class="nc-tile nc-newt" data-t="" style="--c:#64748b"><span class="coa-ic xs" style="--c:#64748b"><b>+</b></span><span>New type…</span></button></div>' +
      '<div id="ncNewTypeWrap" class="nc-field" hidden><label class="bk-muted">New type of expense</label><input class="bk" id="ncNewType" placeholder="e.g. Delivery"></div>' +
      '<div class="nc-field"><label class="bk-muted">Sub category</label><input class="bk" id="ncName" placeholder="e.g. Local Delivery"></div>' +
      '<div class="nc-preview bk-muted" id="ncPrev">Pick a type of expense above, then name the sub category.</div>' +
      '<div class="bk-row nv-acts"><button class="bk-btn p" id="ncSave" disabled>Add category</button><button class="bk-btn bk-x">Cancel</button><span class="bk-muted" id="ncMsg"></span></div></div>';
    const close = () => el.remove();
    el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.body.appendChild(el);
    const nameI = el.querySelector('#ncName'), typeI = el.querySelector('#ncNewType'), wrapT = el.querySelector('#ncNewTypeWrap'), prev = el.querySelector('#ncPrev'), save = el.querySelector('#ncSave');
    const typeName = () => newType ? typeI.value.trim() : parent;
    const paint = () => {
      el.querySelectorAll('.nc-tile').forEach(b => b.classList.toggle('on', newType ? b.classList.contains('nc-newt') : (!!parent && b.dataset.t === parent)));
      wrapT.hidden = !newType;
      const t = typeName(), n = nameI.value.trim(); const st = t && !newType ? styleOf(t) : { color: '#64748b', icon: '' };
      prev.innerHTML = t && n ? 'Will be filed as ' + '<span class="bk-cat-chip" style="--c:' + esc(st.color) + '">' + tile(st.color, st.icon, 'xs', t.charAt(0)) + '<small>' + esc(t) + ' ›</small> ' + esc(n) + '</span>' : t ? 'Now name the sub category under <b>' + esc(t) + '</b>.' : 'Pick a type of expense above, then name the sub category.';
      save.disabled = !(t && n);
    };
    el.querySelectorAll('.nc-tile').forEach(b => b.onclick = () => { newType = b.classList.contains('nc-newt'); parent = newType ? '' : b.dataset.t; paint(); (newType ? typeI : nameI).focus(); });
    nameI.oninput = paint; typeI.oninput = paint; paint();
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !save.disabled) { ev.preventDefault(); save.click(); } if (ev.key === 'Escape') close(); });
    save.onclick = async () => {
      const name = nameI.value.trim(), par = typeName();
      if (!name || !par) return;
      const r = await post('/api/bookkeeping/categories', { name, parent: par });
      if (!r.ok) { el.querySelector('#ncMsg').textContent = r.error; return; }
      ov.chart = r.chart; ov.settings.categories = r.settings.categories; chart = r.chart;
      categories = chart.filter(c => c.parent || !c.children).map(c => c.name).filter((n, i, a) => a.indexOf(n) === i);
      if (wrap && wrap.classList) { const vals = splitCats(wrap.querySelector('.ckp-val').value); ckpSet(wrap, wrap.classList.contains('multi') ? vals.concat([name]) : [name]); }
      close();
    };
  }
  const conf = (c, reason) => '<span class="bk-conf' + (c < 0.75 ? ' lo' : '') + (reason ? ' why' : '') + '"' + (reason ? ' data-why="' + esc(reason) + '"' : '') + '>' + Math.round(c * 100) + '%</span>';
  // Hovering a confidence badge shows BookkeeperAI's reason for it.
  document.addEventListener('mouseover', (e) => {
    const b = e.target.closest && e.target.closest('.bk-conf.why'); if (!b || tipEl) return;
    tipEl = document.createElement('div'); tipEl.className = 'bk-tip'; tipEl.innerHTML = '<b>Why ' + esc(b.textContent) + '</b><br>' + esc(b.dataset.why); document.body.appendChild(tipEl);
    const r = b.getBoundingClientRect(), W = Math.min(460, window.innerWidth - 16);
    tipEl.style.width = W + 'px'; tipEl.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - W - 8)) + 'px'; tipEl.style.top = (r.bottom + 8) + 'px';
    const off = () => { if (tipEl) { tipEl.remove(); tipEl = null; } b.removeEventListener('mouseleave', off); };
    b.addEventListener('mouseleave', off);
  });

  // ---------------------------------------------------------------- Daily Brief
  async function loadBrief() {
    await overview();
    const v = $('vBrief');
    const j = await api('/api/bookkeeping/pending');
    const list = j.pending || [];
    const open = (p) => p.question && !p.question.answer;
    const qs = list.filter(open), cats = list.filter(p => p.type === 'category' && !open(p)), bills = list.filter(p => p.type === 'bill' && !open(p));
    const tiles = '<div class="bk-grid">' +
      '<div class="bk-tile"><b>' + qs.length + '</b><span>Questions for you</span></div>' +
      '<div class="bk-tile"><b>' + cats.length + '</b><span>Categories to approve</span></div>' +
      '<div class="bk-tile"><b>' + bills.length + '</b><span>Bill drafts to approve</span></div>' +
      '<div class="bk-tile"><b>' + (ov.counts.transactions || 0) + '</b><span>Transactions synced</span></div></div>';
    const propHtml = (p) => {
      const pl = p.payload || {};
      let body = '<div class="t">' + esc(p.title) + ' ' + conf(p.confidence, p.reason) + '</div>';
      if (p.type === 'bill' && pl.lines && pl.lines.length) body += '<div class="bk-lines">' + pl.lines.slice(0, 8).map(l => '<div><span>' + esc(l.description) + '</span><span>' + esc(l.category || '') + '</span><span>' + usd(l.amount) + '</span></div>').join('') + (pl.lines.length > 8 ? '<div><span>…' + (pl.lines.length - 8) + ' more</span></div>' : '') + '</div>';
      if (p.type === 'bill') body += '<div class="r"><a href="#" data-file="' + p.ref_id + '">Open the bill file</a>' + (pl.due_date ? ' · due ' + esc(pl.due_date) : '') + '</div>';
      if (open(p)) body += '<div class="q">' + esc(String(p.question.question).replace(/^I am only (\d+)% sure about this bill from (.+?) \(.*\)\. Can you check the draft\?$/s, 'Can you check this draft from $2? I am only $1% sure.')) + '</div>';
      let acts;
      if (open(p)) acts = '<input type="text" placeholder="Optional note — e.g. “Uber rides are personal”" data-ans="' + p.question.id + '" style="min-width:220px">' + (p.type === 'category' ? catSelect(pl.category, 'ans-cat') : '') + '<button class="bk-btn sm p" data-answer="' + p.question.id + '" data-pid="' + p.id + '">Answer</button>';
      else if (p.type === 'category') acts = catSelect(pl.category, 'pick') + '<label class="bk-muted"><input type="checkbox" class="remember" checked> remember ' + esc(pl.vendor || '') + '</label><button class="bk-btn sm ok" data-approve="' + p.id + '">Approve</button><button class="bk-btn sm bad" data-reject="' + p.id + '">Reject</button>';
      else acts = (pl.new_vendor ? '<label class="bk-muted"><input type="checkbox" class="appvendor" checked> approve vendor</label>' : '') + '<button class="bk-btn sm ok" data-approve="' + p.id + '">Approve</button><button class="bk-btn sm bad" data-reject="' + p.id + '">Reject</button>';
      return '<div class="bk-prop" data-id="' + p.id + '"><div class="body">' + body + '</div><div class="acts">' + acts + '</div></div>';
    };
    const sec = (title, items, extra) => '<div class="bk-card"><h2>' + title + ' (' + items.length + ')<span class="sp"></span>' + (extra || '') + '</h2>' + (items.length ? items.map(propHtml).join('') : '<div class="bk-muted">Nothing here.</div>') + '</div>';
    v.innerHTML = tiles +
      '<div class="bk-row" style="margin-bottom:14px"><button class="bk-btn p" id="runNow">Run now</button><button class="bk-btn" id="postBrief">Post today’s brief to Google Chat</button><span class="bk-muted" id="runMsg">' +
        (ov.brief ? 'Brief of ' + esc(ov.brief.day) + (ov.brief.posted_at ? ' · posted to Google Chat ' + when(ov.brief.posted_at) : ov.brief.post_error ? ' · not posted: ' + esc(ov.brief.post_error) : ' · not posted') : 'No brief yet — press Run now.') + '</span></div>' +
      sec('Questions', qs) +
      sec('Suggestions', cats.concat(bills), cats.length + bills.length ? '<button class="bk-btn sm ok" id="approveAll">Approve all</button>' : '') +
      '<div class="bk-card"><h2>Payments</h2><div class="bk-muted">Not connected yet — paying through BILL comes in a later phase.</div></div>' +
      '<div class="bk-card"><h2>Talk to BookkeeperAI<span class="sp"></span><span class="bk-muted">the same conversation as Google Chat</span></h2><div class="bk-chat"><div class="bk-msgs" id="msgs"></div><div class="bk-input"><textarea id="chatIn" rows="1" placeholder="e.g. approve #12, Q3: that was the new cutter, what did we spend on paper? (Enter sends, Shift+Enter = new line)"></textarea><button class="bk-btn p" id="chatSend">Send</button></div></div></div>' +
      (ov.brief ? '<div class="bk-card"><h2>Today’s brief as posted</h2><pre class="bk-brief">' + esc(ov.brief.text) + '</pre></div>' : '');
    const refresh = () => loadBrief();
    v.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
      const row = b.closest('.bk-prop'); const sel = row.querySelector('input.pick'); const rem = row.querySelector('.remember'); const av = row.querySelector('.appvendor');
      b.disabled = true;
      const r = await post('/api/bookkeeping/proposals/' + b.dataset.approve + '/decide', { action: 'approve', category: sel ? sel.value : undefined, remember: rem ? rem.checked : undefined, approve_vendor: av ? av.checked : undefined });
      if (!r.ok) { alert(r.error || 'Could not approve'); b.disabled = false; } else refresh();
    });
    v.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => { const note = prompt('Why? (optional)') ; if (note === null) return; b.disabled = true; await post('/api/bookkeeping/proposals/' + b.dataset.reject + '/decide', { action: 'reject', note }); refresh(); });
    v.querySelectorAll('[data-answer]').forEach(b => b.onclick = async () => {
      const row = b.closest('.bk-prop'); const inp = row.querySelector('[data-ans]'); const cat = row.querySelector('input.ans-cat');
      // A category alone is an answer; words are optional (they teach BookkeeperAI for next time, e.g. "Uber rides are personal").
      if (!inp.value.trim() && !(cat && cat.value)) { inp.focus(); return; }
      b.disabled = true;
      await post('/api/bookkeeping/questions/' + b.dataset.answer + '/answer', { answer: inp.value.trim(), category: cat ? cat.value : undefined });
      refresh();
    });
    v.querySelectorAll('[data-file]').forEach(a => a.onclick = (e) => { e.preventDefault(); openFile(a.dataset.file); });
    if ($('approveAll')) $('approveAll').onclick = async () => { if (!await ask('Every suggested category without an open question is approved and a rule is made for each vendor.', { title: 'Approve all?', ok: 'Approve all' })) return; await post('/api/bookkeeping/proposals/decide-all', {}); refresh(); };
    $('runNow').onclick = async () => { $('runNow').disabled = true; $('runMsg').textContent = 'Running — syncing banks, scanning the inbox, categorizing…'; const r = await post('/api/bookkeeping/run', { post: false }); $('runMsg').textContent = r.ok ? r.summary : (r.error || 'Failed'); $('runNow').disabled = false; loadBrief(); };
    $('postBrief').onclick = async () => { $('postBrief').disabled = true; const r = await post('/api/bookkeeping/brief', { post: true }); $('runMsg').textContent = r.posted && !r.posted.error ? 'Posted to Google Chat.' : 'Not posted: ' + ((r.posted && r.posted.error) || 'unknown'); $('postBrief').disabled = false; };
    loadChat();
    $('chatSend').onclick = sendChat; growBox($('chatIn'), sendChat);   // 1.19.150: Enter / Ctrl+Enter send, Shift+Enter = new line, the box grows
  }
  async function openFile(id) {
    const r = await fetch('/api/bookkeeping/bills/' + id + '/file', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) return alert('No file for this bill.');
    const url = URL.createObjectURL(await r.blob()); window.open(url, '_blank', 'noopener');
  }
  async function loadChat() {
    const j = await api('/api/bookkeeping/chat');
    const box = $('msgs'); if (!box) return;
    box.innerHTML = (j.messages || []).map(m => '<div class="bk-msg ' + (m.direction === 'in' ? 'in' : 'out') + '"><small>' + esc(m.sender) + (m.channel === 'google-chat' ? ' · Google Chat' : '') + ' · ' + when(m.at) + '</small>' + esc(m.text) + '</div>').join('') || '<div class="bk-muted">Say hello — or ask what is pending.</div>';
    box.scrollTop = box.scrollHeight;
  }
  async function sendChat() {
    const inp = $('chatIn'); const text = inp.value.trim(); if (!text) return;
    inp.value = ''; $('chatSend').disabled = true;
    const box = $('msgs'); box.insertAdjacentHTML('beforeend', '<div class="bk-msg in">' + esc(text) + '</div><div class="bk-msg out bk-muted">…</div>'); box.scrollTop = box.scrollHeight;
    const r = await post('/api/bookkeeping/chat', { text });
    $('chatSend').disabled = false;
    if (!r.ok) alert(r.error || 'No answer');
    loadBrief();
  }

  // ---------------------------------------------------------------- the BookkeeperAI bubble (1.19.73): bottom-right on every tab
  // 1.19.150: a chat composer that grows with the message. Enter or Ctrl/Cmd+Enter sends, Shift+Enter adds a line.
  function growBox(ta, send) {
    if (!ta) return;
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, parseInt(getComputedStyle(ta).maxHeight) || 200) + 'px'; };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => { if (e.key !== 'Enter' || e.isComposing) return; if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return; e.preventDefault(); send(); setTimeout(fit, 0); });
    fit();
  }
  (function bubble() {
    const btn = $('bkBub'), panel = $('bkBubPanel'); if (!btn || !panel) return;
    let open = false, loaded = false;
    // 1.19.75: category names in an answer are drawn as chart chips (type colour + icon, "Type › Sub"), the rest as plain text
    const chipFor = (name) => { const row = chart.find(c => c.name === name); if (!row) return null; const top = row.parent ? (chart.find(c => c.name === row.top) || chart.find(c => c.name === row.parent)) : row; const st = styleOf((top || row).name);
      return '<span class="bk-cat-chip" style="--c:' + esc(st.color) + '">' + tile(st.color, row.icon || st.icon, 'xs', '') + (row.parent ? '<small>' + esc(row.top || row.parent) + ' ›</small> ' : '') + esc(name) + '</span>'; };
    const richText = (text) => {
      let html = esc(text); const toks = [];   // chips go in as placeholders so one chip's text is never re-matched by a shorter name
      const names = chart.map(c => c.name).filter(Boolean).sort((a, b) => b.length - a.length);
      names.forEach(n => { const chip = chipFor(n); if (!chip) return; const e = esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        html = html.replace(new RegExp('\\*\\*' + e + '\\*\\*|(^|[^\\w&;])' + e + '(?=$|[^\\w;])', 'g'), (m, pre) => { toks.push({ chip, name: n }); return (pre || '') + '\u0000' + (toks.length - 1) + '\u0000'; }); });
      // "Operations → Software & Subscriptions": the sub chip already names its type, so drop the type in front of it
      html = html.replace(/\u0000(\d+)\u0000\s*(?:→|›|&gt;|-&gt;|\/)\s*\u0000(\d+)\u0000/g, (m, a, b) => { const A = chart.find(c => c.name === toks[a].name), B = chart.find(c => c.name === toks[b].name); return A && !A.parent && B && B.parent ? '\u0000' + b + '\u0000' : m; });
      html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\u0000(\d+)\u0000/g, (m, i) => toks[i].chip);
      return html;
    };
    const paint = (msgs) => { const box = $('bubMsgs'); box.innerHTML = (msgs || []).map(m => '<div class="bk-msg ' + (m.direction === 'in' ? 'in' : 'out') + '"><small>' + esc(m.direction === 'in' ? m.sender : 'BookkeeperAI') + (m.channel === 'google-chat' ? ' · Google Chat' : '') + ' · ' + when(m.at) + '</small>' + (m.direction === 'in' ? esc(m.text) : richText(m.text)) + '</div>').join('') || '<div class="bk-muted" style="font-size:12.5px">Ask me where a purchase belongs, what a vendor usually is, what is pending, or to set a company\'s usual category.</div>'; box.scrollTop = box.scrollHeight; };
    const load = async () => { if (!ov) await overview(); const j = await api('/api/bookkeeping/chat'); paint(j.messages || []); loaded = true; };
    const toggle = (on) => { open = on == null ? !open : on; panel.hidden = !open; btn.classList.toggle('on', open); if (open) { if (!loaded) load(); setTimeout(() => $('bubIn').focus(), 50); } };
    btn.onclick = () => toggle(); $('bkBubClose').onclick = () => toggle(false);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(false); });
    // 1.19.150: a click anywhere outside the panel closes it (pickers and modals that float above it do not count)
    document.addEventListener('mousedown', (e) => { if (!open) return; if (panel.contains(e.target) || btn.contains(e.target) || e.target.closest('.ckp-pop, .bk-modal, .nd-pop, .thf-pop, .bk-toast')) return; toggle(false); });
    const send = async (text) => {
      text = String(text || '').trim(); if (!text) return;
      const box = $('bubMsgs'); box.insertAdjacentHTML('beforeend', '<div class="bk-msg in">' + esc(text) + '</div><div class="bk-msg out bk-muted" id="bubWait">…</div>'); box.scrollTop = box.scrollHeight;
      $('bubIn').value = ''; $('bubIn').style.height = ''; $('bubSend').disabled = true;
      const r = await post('/api/bookkeeping/chat', { text });
      $('bubSend').disabled = false;
      if (!r.ok) { const w = $('bubWait'); if (w) w.textContent = r.error || 'No answer'; return; }
      await load(); if ($('msgs')) loadChat();   // the Daily Brief tab shows the same thread
    };
    $('bubForm').onsubmit = (e) => { e.preventDefault(); send($('bubIn').value); };
    growBox($('bubIn'), () => send($('bubIn').value));
    $('bubHint').querySelectorAll('[data-ask]').forEach(a => a.onclick = (e) => { e.preventDefault(); send(a.dataset.ask); });
  })();

  // ---------------------------------------------------------------- Transactions
  let txnSt = 'pending';   // Pending every time the tab opens (not remembered)
  let txnPoll = null;
  // Categorized view filters (period defaults to the last 30 days); kept per browser.
  let TF = { period: '30', from: '', to: '', type: '', category: '', vendor_id: '', vkind: '', source: '', min: '', max: '', account: '', side: '', how: '' };
  try { TF = Object.assign(TF, JSON.parse(localStorage.getItem('bk_txn_filters') || '{}')); } catch (e) {}
  const periodRange = (pr) => { const d = new Date(), iso = (x) => x.toISOString().slice(0, 10); if (pr === '30') return [iso(new Date(Date.now() - 30 * 864e5)), '']; if (pr === '90') return [iso(new Date(Date.now() - 90 * 864e5)), '']; if (pr === 'month') return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), '']; if (pr === 'last') return [iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), iso(new Date(d.getFullYear(), d.getMonth(), 0))]; if (pr === 'year') return [d.getFullYear() + '-01-01', '']; if (pr === 'custom') return [TF.from, TF.to]; return ['', '']; };
  const chart_types = () => chart.filter(c => !c.parent);
  // The categorized report: totals, spend per month (bars), by type of expense (colored bars), top vendors.
  function report(T) {
    if (!T || !T.count) return '<div class="bk-muted" style="padding:10px 0 14px">No categorized transactions in this period.</div>';
    const months = T.by_month || [], maxM = Math.max(1, ...months.map(m => m.spent));
    const monthName = (m) => { const d = new Date(m + '-15T00:00:00'); return isNaN(d) ? m : d.toLocaleDateString([], { month: 'short', year: months.length > 12 ? '2-digit' : undefined }); };
    const types = T.by_type || [], maxT = Math.max(1, ...types.map(t => t.spent));
    return '<div class="tx-report"><div class="tx-tiles"><div class="bk-tile"><b>' + usd(T.spent) + '</b><span>spent · ' + T.count + ' transaction' + (T.count === 1 ? '' : 's') + '</span></div><div class="bk-tile"><b>' + usd(T.received) + '</b><span>received</span></div><div class="bk-tile"><b>' + usd(T.spent - T.received) + '</b><span>net out</span></div></div>' +
      '<div class="tx-charts"><div class="tx-chart"><div class="tx-ct">Spend by month</div><div class="tx-bars">' + months.map(m => '<div class="tx-bar" title="' + esc(monthName(m.m)) + ': ' + usd(m.spent) + ' spent, ' + usd(m.received) + ' received"><div class="tx-barv"><div class="tx-fill" style="height:' + Math.round(m.spent / maxM * 100) + '%"></div></div><small>' + esc(monthName(m.m)) + '</small><b>' + (m.spent >= 1000 ? '$' + (m.spent / 1000).toFixed(1) + 'k' : usd(m.spent).replace(/\.00$/, '')) + '</b></div>').join('') + '</div></div>' +
      '<div class="tx-chart"><div class="tx-ct">By type of expense <span class="bk-dim">click to filter</span></div>' + types.slice(0, 10).map(t => { const st = styleOf(t.type); return '<div class="tx-type" data-rtype="' + esc(t.type) + '">' + tile(st.color, st.icon, 'sm', '') + '<span class="tx-tn">' + esc(t.type) + '</span><span class="tx-tbar"><span style="width:' + Math.round(t.spent / maxT * 100) + '%;background:' + esc(st.color) + '"></span></span><b>' + usd(t.spent) + '</b></div>'; }).join('') + '</div>' +
      '<div class="tx-chart"><div class="tx-ct">Top vendors <span class="bk-dim">click to filter</span></div>' + (T.by_vendor || []).slice(0, 8).map(x => '<div class="tx-type"' + (x.vendor_id ? ' data-rvendor="' + x.vendor_id + '"' : '') + '><span class="tx-tn">' + esc(x.vendor || '—') + '</span><span class="bk-dim">' + x.n + '</span><b>' + usd(x.spent) + '</b></div>').join('') + '</div></div></div>';
  }
  // ---------------------------------------------------------------- purchases: the hub list, waiting for the bank, not received
  const SLOT_ICON = { bill: 'file', bank: 'landmark', conf: 'receipt', arr: 'package' };
  const slots = (p) => '<span class="pu-slots">' +
    '<span class="pu-slot bill' + (p.bill ? ' on' : '') + '" title="' + esc(p.bill ? 'Bill #' + p.bill.id + ' · ' + p.bill.status : 'No bill') + '">' + iconSvg('file') + '</span>' +
    '<span class="pu-slot bank' + (p.txns.length ? ' on' : '') + '" title="' + esc(p.txns.length ? p.txns.map(t => t.date + ' ' + t.name + ' ' + usd(Math.abs(t.amount))).join(', ') : p.no_paperwork ? 'Bank line (no paperwork expected)' : 'No bank line yet') + '">' + iconSvg('landmark') + '</span>' +
    '<span class="pu-slot conf' + (p.confirm ? ' on' : '') + '" title="' + esc(p.confirm ? 'Confirmation: ' + p.confirm.subject : 'No confirmation email') + '">' + iconSvg('receipt') + '</span>' +
    '<span class="pu-slot arr' + (p.arrivals || p.files ? ' on' : '') + '" title="' + esc([p.arrivals ? p.arrivals + ' delivery email' + (p.arrivals === 1 ? '' : 's') : '', p.files ? p.files + ' delivery slip' + (p.files === 1 ? '' : 's') : ''].filter(Boolean).join(' · ') || (p.expects_delivery ? 'No delivery yet' : 'Nothing to receive')) + '">' + iconSvg('package') + '</span></span>' + (p.paired ? '<span class="pu-paired" title="' + esc(p.txns.map(t => t.date + ' ' + t.name + ' ' + usd(Math.abs(t.amount))).join(', ')) + '">Paired</span>' : '');
  // what is behind the row: emails · attachments · items, with the email subjects on hover
  const puInfo = (p) => { const bits = []; if (p.emails) bits.push(p.emails + ' ' + (p.emails === 1 ? 'email' : 'emails')); if (p.attachments) bits.push(p.attachments + ' ' + (p.attachments === 1 ? 'attachment' : 'attachments')); if (p.items) bits.push(p.items + ' ' + (p.items === 1 ? 'item' : 'items') + (p.items_linked ? ' · ' + p.items_linked + ' linked' : '')); if (!bits.length) return '';
    return '<a href="#" class="pu-info" data-open="' + p.id + '"' + (p.email_subjects && p.email_subjects.length ? ' data-tip="' + esc(p.email_subjects.join('\n')) + '"' : '') + '>' + bits.join(' · ') + '</a>'; };
  const puStatus = (p) => '<span class="pu-st ' + (p.late ? 'late' : p.status === 'closed' ? 'closed' : p.status === 'awaiting bank' ? 'bank' : /received/.test(p.status) ? 'recv' : '') + '">' + esc(p.status) + (p.late ? ' · ' + p.days + ' days' : '') + '</span>';
  // 1.19.141: the Purchases list has the Bank feed's column filters — Date (presets + From / To), Vendor (kind) + Company,
  // Amount (From / To), Category (type / sub category), Status (delivery) — kept in PF / localStorage bk_pu_filters.
  let PF = { period: 'all', from: '', to: '', vendor_id: '', vendor_name: '', vkind: '', min: '', max: '', type: '', category: '', dstatus: '', pstatus: '' };   // 1.20.66: pstatus = the Payment column, dstatus = Received
  try { PF = Object.assign(PF, JSON.parse(localStorage.getItem('bk_pu_filters') || '{}')); } catch (e) {}
  const savePF = () => { try { localStorage.setItem('bk_pu_filters', JSON.stringify(PF)); } catch (e) {} loadPurchases(lastSub.purchases || 'list'); };
  const P_SVG = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const P_PEN = P_SVG('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12.5 7.5l4 4"/>'), P_LINK = P_SVG('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>');
  const RECV_L = { na: 'N/A', no: 'Not received', partial: 'Partially received', yes: 'Received' };   // 1.20.67: the pill's words
  const DELIV = [['na', 'Not applicable', 'Nothing to receive — a service, a fee, a subscription'], ['no', 'Not received', 'Goods ordered, nothing has arrived yet'], ['partial', 'Partially received', 'Some of it arrived'], ['yes', 'Received', 'All of it arrived']];
  async function loadPurchases(view) {
    const v = $(view === 'waiting' ? 'vPurchWaiting' : view === 'notreceived' ? 'vPurchNotReceived' : 'vPurchList');
    if (!ov) await overview();
    const q = ($('puQ') || {}).value || '';
    const [pf, pt] = periodRange(PF.period);
    const qs = ['from=' + (pf || ''), 'to=' + (pt || '')].concat(['vendor_id', 'vkind', 'min', 'max', 'type', 'category', 'dstatus', 'pstatus'].map(k => PF[k] ? k + '=' + encodeURIComponent(PF[k]) : '').filter(Boolean)).join('&');
    const j = await api('/api/bookkeeping/purchases?view=' + view + '&q=' + encodeURIComponent(q) + '&' + qs); if (!j.ok) { v.innerHTML = '<div class="bk-card">' + esc(j.error) + '</div>'; return; }
    const rows = j.purchases || [];
    $('nWaiting').textContent = j.counts.waiting || 0; $('nNotReceived').textContent = j.counts.notreceived || 0;
    const S = ov.settings;
    const intro = view === 'waiting' ? 'Emails you marked Transaction: proof of a payment with no bank line yet. Nova proposes the bank line when it lands (same amount to the cent); you confirm. After ' + esc(S.waiting_days) + ' days they are emailed to ' + esc(S.alert_to) + '.'
      : view === 'notreceived' ? 'Goods bought (by category) with no arrival attached. Mark them received when they come, partly received with a note, or cancelled. After ' + esc(S.notreceived_days) + ' days they are emailed to ' + esc(S.alert_to) + '.'
      : 'Everything we bought, one row per purchase, with its four slots: bill · bank line · confirmation · delivery. Hover a slot for what is in it; click the vendor for the emails and items behind it. Every column header is a filter.';
    const tm = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(ts) ? '' : 'Z')); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }); };
    const vlogo = (name, photo) => photo ? '<img class="bk-logo bk-vl" src="' + esc(photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;bk-logo bk-vl ph&quot;>' + esc(String(name || '?').charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo bk-vl ph' + (name ? '' : ' none') + '">' + esc(name ? String(name).charAt(0).toUpperCase() : '?') + '</span>';
    const kindTag = (p) => p.vendor_source === 'suppliers' ? 'supplier' : p.vendor_source === 'vendors' ? 'vendor' : p.vendor_source === 'nova' ? 'Nova vendor' : (p.vendor_kind || 'from a bill');
    const kindPill = (p) => p.vendor_source === 'nova' ? '<span class="bk-src nova" title="Nova vendor — kept in Nova, not in the CRM">vendor' + AI_I + '</span>' : '<span class="bk-src ' + esc(p.vendor_source || '') + '">' + esc(kindTag(p)) + '</span>';
    // the Bank feed's vendor cell: photo + kind pill on the left, company name + change icon on the right; unlinked = Link icon + near matches
    const vendorCell = (p) => { const c = p.vendor_card, linked = c && c.kind !== 'bill', sg = p.suggestions || [];
      const extra = (p.order_no || p.note ? '<div class="bk-muted">' + (p.order_no ? '#' + esc(p.order_no) : '') + (p.order_no && p.note ? ' · ' : '') + (p.note ? '<span class="bk-dim">' + esc(p.note) + '</span>' : '') + '</div>' : '') + puInfo(p);
      if (linked) return '<div class="bl-vendor pu-vendor tx-vcell"><div class="tx-vleft"><a href="#" class="tx-vphoto" data-vcard="' + c.id + '" title="Vendor details">' + vlogo(c.name, c.photo) + '<span class="tx-vedit">' + P_PEN + '</span></a>' + kindPill(p) + '</div>' +
        '<div class="bl-vname"><b class="tx-vn"><a href="#" class="pu-vn" data-open="' + p.id + '">' + esc(c.name) + '</a></b> <a href="#" class="bl-vact tx-vico" data-pvlink="' + p.id + '" title="Change vendor">' + P_PEN + '</a>' +
        (p.vendor && p.vendor !== c.name ? '<div class="bk-dim">' + esc(p.vendor) + '</div>' : '') + extra + '</div></div>';
      const best = sg[0];
      const sug = best ? '<div class="tx-sug"><span class="tx-match">Matched ' + Math.round((best.score || 0) * 100) + '%</span><button type="button" class="bk-btn sm p" data-pvpair="' + p.id + '" data-vid="' + best.id + '">Use</button></div><div class="tx-sug-n"><b>' + esc(best.name) + '</b>' + (sg.length > 1 ? ' <span class="bk-dim">or ' + sg.slice(1).map(x => '<a href="#" class="bl-sug" data-pvpair="' + p.id + '" data-vid="' + x.id + '" title="' + Math.round(x.score * 100) + '% match">' + esc(x.name) + '</a>').join(', ') + '</span>' : '') + '</div>' : '';
      return '<div class="bl-vendor pu-vendor tx-vcell"><div class="tx-vleft">' + vlogo(null, null) + '<div class="tx-vacts"><a href="#" class="bl-vact tx-vico" data-pvlink="' + p.id + '" title="Link to a vendor">' + P_LINK + '</a></div></div>' +
        '<div class="bl-vname"><b class="tx-vn"><a href="#" class="pu-vn" data-open="' + p.id + '">' + esc(p.vendor || '?') + '</a></b><div class="bl-unlinked">Not linked</div>' + sug + extra + '</div></div>'; };
    const amountCell = (p) => '<td class="num neg"><div class="tx-amt">' + (p.amount != null ? usd(p.amount) : '<span class="bk-dim">—</span>') + '</div><div class="tx-when bk-dim" title="' + (p.paid_on ? 'Paid — the bank line\'s date' : p.status === 'awaiting payment' ? 'The bill is not paid yet' : 'No bank line yet') + '">' + (p.paid_on ? 'paid ' + esc(usD(p.paid_on)) : p.status === 'awaiting payment' ? 'awaiting payment' : p.no_paperwork ? '' : 'awaiting bank') + '</div></td>';
    // Status: the money side as a pill (awaiting bank / awaiting payment / closed / cancelled) + the receiving dropdown
    // closed = paid and nothing left to receive; paid = the bank line is matched but goods are still on the way
    const statusCell = (p) => { const money = p.cancelled ? '<span class="pu-st">cancelled</span>' : p.status === 'awaiting bank' || p.status === 'awaiting payment' ? puStatus(p) : p.status === 'closed' ? '<span class="pu-st closed">closed</span>' : '<span class="pu-st paid" title="Bank line matched — goods still to receive">paid</span>';
      // 1.20.67: Received is a nailed-down pill like Payment — it is set by the paperwork (a delivery email matched, the slip
      // uploaded) and only edited by hand through the pencil (`receivePop`); N/A when there is nothing to receive.
      const sel = p.cancelled ? '' : '<span class="pu-recv-w"><span class="pu-st rv-' + esc(p.delivery || 'na') + '" title="' + esc((DELIV.find(d => d[0] === p.delivery) || DELIV[0])[2]) + '">' + esc(RECV_L[p.delivery] || 'N/A') + '</span><a href="#" class="pu-redit" data-redit="' + p.id + '" title="Received — match a delivery email, upload the slip, or set it by hand">' + iconSvg('pencil') + '</a></span>' + (p.late && /received/.test(p.status) ? '<div class="bk-dim pu-late">' + p.days + ' days</div>' : '') + (p.received_note ? '<div class="bk-dim pu-rnote" title="' + esc(p.received_note) + '">' + esc(p.received_note) + '</div>' : '');
      return '<td class="pu-status">' + money + '</td><td class="pu-status pu-recv">' + sel + '</td>'; };   // 1.20.66: Payment and Received are two columns
    const row = (p) => '<tr data-pid="' + p.id + '"><td class="pu-date">' + esc(usD(p.date)) + (tm(p.when) ? '<div class="bk-dim">' + esc(tm(p.when)) + '</div>' : '') + '</td><td>' + vendorCell(p) + '</td>' + amountCell(p) +
      '<td data-pcat="' + p.id + '">' + catSelect(p.category || '', 'pu-cat', 'Choose…', { only: 'expense' }) + '</td><td>' + slots(p) + '</td>' + statusCell(p) +
      '<td class="pu-acts">' + (p.status === 'awaiting bank' && p.suggest ? '<button class="bk-btn sm p" data-sug="' + p.id + '">' + p.suggest + ' bank line' + (p.suggest === 1 ? '' : 's') + ' match</button>' : p.status === 'awaiting bank' ? '<button class="bk-btn sm" data-sug="' + p.id + '">Pick bank line…</button>' : '') +
        (!p.cancelled && p.status !== 'closed' ? '<button class="bk-btn sm" data-recv="' + p.id + '" data-s="cancel" title="Cancelled or refunded — stops the reminders">Cancel</button>' : p.cancelled ? '<button class="bk-btn sm" data-recv="' + p.id + '" data-s="reopen">Reopen</button>' : '') + '</td></tr>';
    const PERIODS = [['all', 'All time'], ['30', 'Last 30 days'], ['month', 'This month'], ['last', 'Last month'], ['90', 'Last 90 days'], ['year', 'This year']].map(([v, l]) => ({ v, l }));
    const inUse = {}; rows.forEach(p => { if (p.category) inUse[p.category] = (inUse[p.category] || 0) + 1; });
    const FO = {
      date: { type: 'range', kind: 'date', from: PF.period === 'custom' ? PF.from : '', to: PF.period === 'custom' ? PF.to : '', period: PF.period, defaultPeriod: 'all', presets: PERIODS },
      vkind: [{ v: '', l: 'All' }, { v: 'supplier', l: '<span class="bk-src supplier">supplier</span>', t: 'Supplier' }, { v: 'vendor', l: '<span class="bk-src vendor">vendor</span>', t: 'Vendor' }, { v: 'nova', l: '<span class="bk-src nova">vendor' + AI_I + '</span>', t: 'Vendor ✦' }, { v: 'bill', l: '<span class="bk-src bill">from a bill</span>', t: 'From a bill' }, { v: 'none', l: 'Not linked' }],
      vendor: [{ v: '', l: 'All companies' }, { v: 'none', l: 'Not linked' }].concat((j.vendors || []).map(x => ({ v: String(x.id), l: esc(x.name) })), PF.vendor_id && PF.vendor_id !== 'none' && !(j.vendors || []).some(x => String(x.id) === PF.vendor_id) ? [{ v: PF.vendor_id, l: esc(PF.vendor_name || 'Company') }] : []),
      amount: { type: 'range', kind: 'number', from: PF.min, to: PF.max },
      type: [{ v: '', l: 'All categories' }].concat(chart_types().filter(t => !t.income).map(t => ({ v: 'T:' + t.name, l: tile(t.color, t.icon, 'sm', '') + ' ' + esc(t.name) })), Object.keys(inUse).sort().map(c => ({ v: 'C:' + c, l: catLabel(c), n: inUse[c] }))),
      pstatus: [{ v: '', l: 'All' }, { v: 'bank', l: 'Awaiting bank / payment', t: 'Awaiting' }, { v: 'paid', l: 'Paid (bank line matched)', t: 'Paid' }, { v: 'cancelled', l: 'Cancelled' }],
      dstatus: [{ v: '', l: 'All' }].concat(DELIV.map(d => ({ v: d[0], l: d[1] })))
    };
    const anyF = PF.period !== 'all' || PF.from || PF.to || PF.vendor_id || PF.vkind || PF.min || PF.max || PF.type || PF.category || PF.dstatus || PF.pstatus;
    const title = view === 'waiting' ? 'Waiting for the bank' : view === 'notreceived' ? 'Not received' : 'Purchases';
    v.innerHTML = '<div class="bk-card"><h2>' + title + ' ' + qHelp('purch_' + view, title, intro) + '<span class="sp"></span>' + (anyF ? '<button class="bk-btn sm" id="pfClear" title="Remove every column filter">× Clear filters</button>' : '') + '<span class="bk-muted">' + rows.length + ' purchase' + (rows.length === 1 ? '' : 's') + '</span></h2>' +
      '<table class="bk pu-table"><thead><tr><th class="tx-date">' + thFilter('date', 'Date', FO.date) + '</th><th class="tx-vth">' + thFilter('vkind', 'Vendor', FO.vkind, PF.vkind) + thFilter('vendor', 'Company', FO.vendor, PF.vendor_id) + '</th><th class="num">' + thFilter('amount', 'Amount', FO.amount) + '</th><th>' + thFilter('type', 'Category', FO.type, PF.type ? 'T:' + PF.type : PF.category ? 'C:' + PF.category : '') + '</th><th>Paperwork</th><th>' + thFilter('pstatus', 'Payment', FO.pstatus, PF.pstatus) + '</th><th>' + thFilter('dstatus', 'Received', FO.dstatus, PF.dstatus) + '</th><th></th></tr></thead><tbody>' + rows.map(row).join('') + '</tbody></table>' +
      (!rows.length ? '<div class="bk-muted" style="padding:14px 0">' + (view === 'list' && !anyF && !q ? 'No purchases yet. They appear when you press Bill, Transaction or Arrival on an email, or when a bank line is categorized.' : 'Nothing matches.') + '</div>' : '') + '</div>';
    if ($('pfClear')) $('pfClear').onclick = () => { Object.assign(PF, { period: 'all', from: '', to: '', vendor_id: '', vendor_name: '', vkind: '', min: '', max: '', type: '', category: '', dstatus: '', pstatus: '' }); savePF(); };
    thFilterBind(v, FO, (key, val) => {
      if (key === 'type') { PF.type = val.startsWith('T:') ? val.slice(2) : ''; PF.category = val.startsWith('C:') ? val.slice(2) : ''; }
      else if (key === 'vendor') { PF.vendor_id = val; const o = FO.vendor.find(x => x.v === val); PF.vendor_name = o && val && val !== 'none' ? o.l : ''; }
      else if (key === 'date') { PF.period = val.period || 'all'; PF.from = val.from || ''; PF.to = val.to || ''; }
      else if (key === 'amount') { PF.min = val.from || ''; PF.max = val.to || ''; }
      else PF[key] = val; savePF(); });
    v.querySelectorAll('[data-open]').forEach(a => a.onclick = (e) => { e.preventDefault(); purchaseView(Number(a.dataset.open), () => loadPurchases(view)); });
    v.querySelectorAll('[data-vcard]').forEach(a => a.onclick = (e) => { e.preventDefault(); if (typeof vendorCard === 'function') vendorCard(Number(a.dataset.vcard), () => loadPurchases(view)); });
    const setPV = async (pid, vid) => { const r = await post('/api/bookkeeping/purchases/' + pid + '/vendor', { vendor_id: vid, remember: true }); if (!r.ok) return alert(r.error); loadPurchases(view); };
    v.querySelectorAll('[data-pvlink]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); const p = rows.find(x => String(x.id) === a.dataset.pvlink); vendorPicker(a, { vendor: p.vendor || '', suggestions: p.suggestions || [] }, (vid) => setPV(p.id, vid)); });
    v.querySelectorAll('[data-pvpair]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); setPV(a.dataset.pvpair, Number(a.dataset.vid)); });
    v.querySelectorAll('.pu-slots').forEach(sl => { sl.onclick = (ev) => { ev.preventDefault(); const tr = sl.closest('tr'); paperworkPop(sl, Number(tr.dataset.pid)); }; });
    // the receiving dropdown — Partially received asks what came
    v.querySelectorAll('[data-redit]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); const p = rows.find(x => String(x.id) === a.dataset.redit); receivePop(a, p, () => { loadPurchases(view); overview(); }); });   // 1.20.67
    // the category picker sets it on the spot — on the purchase and the bank lines behind it
    v.querySelectorAll('td[data-pcat]').forEach(td => { const wrap = td.querySelector('.ckp'), inp = td.querySelector('input.pu-cat'); if (!wrap || !inp) return; let last = inp.value;
      wrap.addEventListener('change', async () => { if (inp.value === last || !inp.value) return; last = inp.value; const r = await post('/api/bookkeeping/purchases/' + td.dataset.pcat + '/category', { category: inp.value }); const tr = td.closest('tr'); tr.classList.add(r.ok ? 'saved' : 'failed'); setTimeout(() => tr.classList.remove('saved', 'failed'), 1200); if (!r.ok) alert(r.error); else loadPurchases(view); }); });
    v.querySelectorAll('[data-recv]').forEach(b => b.onclick = async () => {
      const st = b.dataset.s; let note = '';
      if (st === 'cancel') { note = await askText('Why? (cancelled, refunded, returned…)', { title: 'Cancel this purchase' }); if (note == null) return; }
      const r = await post('/api/bookkeeping/purchases/' + b.dataset.recv + '/receive', { status: st, note }); if (!r.ok) return alert(r.error); loadPurchases(view); overview();
    });
    v.querySelectorAll('[data-sug]').forEach(b => b.onclick = async () => {
      const pid = b.dataset.sug, j2 = await api('/api/bookkeeping/purchases/' + pid + '/suggest'); const list = j2.transactions || [];
      const el = document.createElement('div'); el.className = 'bk-modal';
      el.innerHTML = '<div class="bk-modal-box" style="width:min(520px,100%)"><div class="bk-modal-title">' + (list.length ? 'Which bank line paid this?' : 'No bank line matches yet') + '</div><div class="bk-muted" style="margin-bottom:8px">' + (list.length ? 'Same amount to the cent, within a few days. Pick one to attach it.' : 'Nothing in the bank feed has this exact amount yet. Sync the bank, or wait — a different amount always asks, never links.') + '</div>' +
        (list.length ? '<div class="vp-list">' + list.map(t => '<div class="vp-i" data-t="' + t.id + '"><span class="mv-ic" style="--kc:#1e40af;--kbg:#dbeafe">' + iconSvg('landmark') + '</span><span class="vp-n">' + esc(t.date) + ' · ' + esc(t.merchant || t.name) + ' <small>' + usd(Math.abs(t.amount)) + ' · ' + esc(t.account_name || '') + (t.same_vendor ? ' · same vendor' : '') + '</small></span></div>').join('') + '</div>' : '') +
        '<div class="bk-ask-acts"><button class="bk-btn" data-no>' + (list.length ? 'Cancel' : 'Close') + '</button></div></div>';
      document.body.appendChild(el); el.querySelector('[data-no]').onclick = () => el.remove(); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
      el.querySelectorAll('[data-t]').forEach(i => i.onclick = async () => { el.remove(); const r = await post('/api/bookkeeping/purchases/' + pid + '/attach', { transaction_id: Number(i.dataset.t) }); if (!r.ok) return alert(r.error); loadPurchases(view); overview(); });
    });
  }
  // One purchase: the emails behind it (with attachments), the bank line it is paired with, and its line items —
  // each with a picture when the email had one, a material from the catalog (or Unknown) and a category.
  async function purchaseView(pid, done) {
    const j = await api('/api/bookkeeping/purchases/' + pid); if (!j.ok) return alert(j.error);
    let p = j.purchase; let items = p.items.map(i => Object.assign({}, i));
    const el = document.createElement('div'); el.className = 'bk-modal';
    const dateS = (d) => d ? String(d).slice(0, 10) : '';
    const ROLE = { confirmation: ['Confirmation', 'receipt', '#115e59', '#ccfbf1'], bill: ['Bill', 'file', '#065f46', '#d1fae5'], delivery: ['Delivery', 'package', '#92400e', '#fef3c7'] };
    const emailRow = (e) => { const r = ROLE[e.role] || ROLE.delivery; return '<div class="pv-em"><span class="mv-ic" style="--kc:' + r[2] + ';--kbg:' + r[3] + '">' + iconSvg(r[1]) + '</span><span class="vp-n"><a href="#" data-em="' + e.id + '">' + esc(e.subject || '(no subject)') + '</a><div class="bk-dim">' + r[0] + ' · ' + esc(dateS(e.received_at)) + (e.attachments ? ' · ' + e.attachments + ' attachment' + (e.attachments === 1 ? '' : 's') + (e.attachment_names.length ? ': ' + esc(e.attachment_names.join(', ')) : '') : '') + '</div></span></div>'; };
    const KIND = { item: 'Item', shipping: 'Shipping', tax: 'Tax', fee: 'Fee', discount: 'Discount' };
    const itemRow = (i, k) => '<tr data-k="' + k + '" class="pv-it ' + esc(i.kind) + '"><td>' + (i.kind === 'item' ? (i.photo || i.material_photo ? '<img class="pv-ph" src="' + esc(i.photo || i.material_photo) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<span class="pv-ph ph"></span>') : '<span class="pv-ph ph">' + iconSvg(i.kind === 'shipping' ? 'truck' : 'receipt') + '</span>') + '</td>' +
      '<td><input class="bk pv-name" value="' + esc(i.name || '') + '" placeholder="Item"><div class="bk-dim"><select class="pv-kind">' + Object.keys(KIND).map(x => '<option value="' + x + '"' + (i.kind === x ? ' selected' : '') + '>' + KIND[x] + '</option>').join('') + '</select></div></td>' +
      '<td class="num"><input class="bk pv-qty" type="number" step="any" value="' + esc(i.qty != null ? i.qty : 1) + '" style="width:60px"></td><td class="num"><input class="bk pv-amt" type="number" step="0.01" value="' + esc(i.amount != null ? i.amount : '') + '" placeholder="0.00" style="width:92px"></td>' +
      '<td>' + (i.kind === 'item' ? '<button class="bk-btn sm pv-mat' + (i.material_id ? ' on' : '') + '">' + (i.material_id ? esc(i.material_name || 'Material #' + i.material_id) : 'Unknown') + '</button>' : '<span class="bk-dim">—</span>') + '</td>' +
      '<td>' + catSelect(i.category || '', 'pv-cat', 'Category') + '</td><td><button class="bk-btn sm pv-rm" title="Remove">×</button></td></tr>';
    const paint = () => {
      const sum = items.reduce((a, i) => a + (Number(i.amount) || 0), 0);
      el.innerHTML = '<div class="bk-modal-box pv-box"><div class="bk-modal-title">' + esc(p.vendor || '?') + (p.amount != null ? ' · ' + usd(p.amount) : '') + (p.order_no ? ' · #' + esc(p.order_no) : '') + '</div>' +
        '<div class="bk-muted" style="margin-bottom:10px">' + esc(p.date || '') + ' · ' + esc(p.status) + (p.category ? ' · ' + esc(p.category) : '') + (p.equipment ? ' · machine: ' + esc(p.equipment.name) : '') + '</div>' +
        '<div class="pv-cols"><div><div class="vp-h">Emails (' + p.emails.length + ')</div>' + (p.emails.length ? p.emails.map(emailRow).join('') : '<div class="bk-dim">None — this purchase came from a bank line.</div>') + '</div>' +
        '<div><div class="vp-h">Payment</div>' + (p.txns.length ? p.txns.map(t => '<div class="pv-em"><span class="mv-ic" style="--kc:#1e40af;--kbg:#dbeafe">' + iconSvg('landmark') + '</span><span class="vp-n"><span class="pu-paired">Paired</span> ' + esc(t.date) + ' · ' + esc(t.merchant || t.name) + ' · <b>' + usd(Math.abs(t.amount)) + '</b><div class="bk-dim">' + esc(t.account_name || '') + (t.category ? ' · ' + esc(t.category) : '') + '</div></span></div>').join('') : '<div class="bk-dim">' + (p.bill ? 'Bill #' + p.bill.id + ' · ' + esc(p.bill.status) + ' — ' : '') + 'no bank line yet; it pairs when the payment lands.</div>') + '</div></div>' +
        '<div class="vp-h" style="display:flex;align-items:center;gap:8px">Items (' + items.filter(i => i.kind === 'item').length + ')<span class="sp"></span>' + (p.emails.length ? '<button class="bk-btn sm" data-reread title="Let Nova read the items again from the email (replaces this list)">Read from email</button>' : '') + '<button class="bk-btn sm" data-addrow>+ Line</button></div>' +
        '<table class="bk pv-items"><thead><tr><th></th><th>What</th><th class="num">Qty</th><th class="num">Amount</th><th>Material</th><th>Category</th><th></th></tr></thead><tbody>' + items.map(itemRow).join('') + '</tbody></table>' +
        (items.length ? '<div class="bk-dim" style="text-align:right;margin-top:4px">Lines ' + usd(sum) + (p.amount != null && Math.abs(sum - p.amount) > 0.005 ? ' · purchase ' + usd(p.amount) + ' · <b>' + (sum > p.amount ? '+' : '−') + usd(Math.abs(sum - p.amount)) + '</b>' : p.amount != null ? ' · matches the purchase' : '') + '</div>' : '<div class="bk-dim">No items yet' + (p.emails.length ? ' — press Read from email, or add lines by hand.' : ' — add lines by hand.') + '</div>') +
        '<div class="bk-ask-acts"><button class="bk-btn" data-no>Close</button><button class="bk-btn p" data-yes>Save items</button></div></div>';
      el.querySelector('[data-no]').onclick = () => el.remove();
      el.querySelector('[data-yes]').onclick = async () => { collect(); const r = await post('/api/bookkeeping/purchases/' + pid + '/items', { items }); if (!r.ok) return alert(r.error); p = r.purchase; items = p.items.map(i => Object.assign({}, i)); paint(); if (done) done(); };
      const rr = el.querySelector('[data-reread]'); if (rr) rr.onclick = async () => { if (items.length && !confirm('Replace the list with what Nova reads from the email?')) return; rr.disabled = true; const r = await post('/api/bookkeeping/purchases/' + pid + '/items/extract', { email_id: p.emails[0].id }); if (!r.ok) return alert(r.error); p = r.purchase; items = p.items.map(i => Object.assign({}, i)); paint(); if (done) done(); };
      el.querySelector('[data-addrow]').onclick = () => { collect(); items.push({ kind: 'item', name: '', qty: 1, amount: null, category: p.category || '' }); paint(); el.querySelector('tr[data-k="' + (items.length - 1) + '"] .pv-name').focus(); };
      el.querySelectorAll('[data-em]').forEach(a => a.onclick = (e) => { e.preventDefault(); el.remove(); ibOpen = Number(a.dataset.em); show('inbox'); });
      el.querySelectorAll('.pv-rm').forEach(b => b.onclick = () => { collect(); items.splice(Number(b.closest('tr').dataset.k), 1); paint(); });
      el.querySelectorAll('.pv-kind').forEach(sel => sel.onchange = () => { collect(); paint(); });
      el.querySelectorAll('.pv-mat').forEach(b => b.onclick = () => { collect(); const k = Number(b.closest('tr').dataset.k); materialPicker(items[k].name, (m) => { items[k].material_id = m ? m.id : null; items[k].material_name = m ? m.name : null; items[k].material_photo = m ? m.photo : null; paint(); }); });
    };
    const collect = () => { el.querySelectorAll('tr[data-k]').forEach(tr => { const i = items[Number(tr.dataset.k)]; if (!i) return; i.name = tr.querySelector('.pv-name').value; i.kind = tr.querySelector('.pv-kind').value; i.qty = tr.querySelector('.pv-qty').value; i.amount = tr.querySelector('.pv-amt').value; i.category = tr.querySelector('.pv-cat.ckp-val').value; }); };
    paint(); document.body.appendChild(el); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
  }
  // Pick a material from the catalog for a line item (or clear it back to Unknown).
  async function materialPicker(seed, pick) {
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(520px,100%)"><div class="bk-modal-title">Which material is this?</div><input class="bk" id="mpQ" placeholder="Search the materials catalog" value="' + esc(String(seed || '').split(/[,(–—-]/)[0].trim().slice(0, 40)) + '" style="width:100%"><div class="vp-list" id="mpList" style="margin-top:8px;max-height:50vh;overflow:auto"></div><div class="bk-ask-acts"><button class="bk-btn" data-clear>Unknown (no material)</button><button class="bk-btn" data-no>Cancel</button></div></div>';
    document.body.appendChild(el);
    let t = null;
    const load = async () => { const j = await api('/api/bookkeeping/materials/pick?q=' + encodeURIComponent($('mpQ').value.trim())); const list = j.materials || []; $('mpList').innerHTML = list.length ? list.map(m => '<div class="vp-i" data-m="' + m.id + '">' + (m.photo ? '<img class="pv-ph sm" src="' + esc(m.photo) + '" alt="">' : '<span class="pv-ph sm ph"></span>') + '<span class="vp-n">' + esc(m.name) + '<small>' + esc([m.geo_type, m.geo_sub_type, m.code].filter(Boolean).join(' · ')) + '</small></span></div>').join('') : '<div class="bk-dim" style="padding:8px">Nothing in the catalog matches — keep it Unknown until the material is added in the CRM.</div>';
      el.querySelectorAll('[data-m]').forEach(i => i.onclick = () => { const m = list.find(x => x.id === Number(i.dataset.m)); el.remove(); pick(m); }); };
    $('mpQ').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); }; $('mpQ').focus(); load();
    el.querySelector('[data-no]').onclick = () => el.remove(); el.querySelector('[data-clear]').onclick = () => { el.remove(); pick(null); }; el.onclick = (ev) => { if (ev.target === el) el.remove(); };
  }
  // A one-line text question (note), resolves the text or null.
  function askText(label, opt) {
    opt = opt || {};
    return new Promise((resolve) => {
      const el = document.createElement('div'); el.className = 'bk-modal bk-ask';
      el.innerHTML = '<div class="bk-modal-box bk-ask-box">' + (opt.title ? '<div class="bk-modal-title">' + esc(opt.title) + '</div>' : '') + '<div class="bk-ask-text">' + esc(label) + '</div>' + (opt.multiline ? '<textarea class="bk bkt" id="askTxt" rows="3" style="width:100%;margin-top:10px;height:auto" placeholder="' + (opt.required ? 'Required' : 'Optional note') + '"></textarea>' : '<input class="bk" id="askTxt" style="width:100%;margin-top:10px" placeholder="' + (opt.required ? 'Required' : 'Optional note') + '">') + '<div class="bk-ask-acts"><button class="bk-btn" data-no>Cancel</button><button class="bk-btn p" data-yes>' + esc(opt.ok || 'OK') + '</button></div></div>';
      document.body.appendChild(el); const inp = el.querySelector('#askTxt'); inp.focus();
      const done = (v) => { el.remove(); resolve(v); };
      const submit = () => { const v = inp.value.trim(); if (opt.required && !v) { inp.focus(); inp.style.borderColor = '#dc2626'; return; } done(v); };
      inp.onkeydown = (e) => { if (e.key === 'Enter' && !(opt.multiline && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); submit(); } if (e.key === 'Escape') done(null); };
      el.querySelector('[data-no]').onclick = () => done(null); el.querySelector('[data-yes]').onclick = submit; el.onclick = (e) => { if (e.target === el) done(null); };
    });
  }
  const AI_I = '<svg class="tx-aik" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/></svg>';
  let txStats = false;
  async function loadTxns(sub) {
    if (typeof sub === 'string') { txStats = sub === 'stats'; txnSt = txStats ? 'categorized' : sub; }   // '' = All; Stats = the charts over the categorized lines
    const v = $('vTxns');
    if (!ov) await overview();
    const st = txnSt, q = (($('txQ') || {}).value || '').trim(); txQLast = q;
    if (!$('nWaiting').textContent) api('/api/bookkeeping/purchases?view=list').then(j => { if (j.ok) { $('nWaiting').textContent = j.counts.waiting || 0; $('nNotReceived').textContent = j.counts.notreceived || 0; } });
    const cat = st === 'categorized' || st === 'auto';   // 1.20.12: Auto is the Categorized view narrowed to what the system filed by itself
    // 1.19.49: the header filters work in every view (date defaults to the last 30 days); the status is a filter on the Category column.
    let qs = '?status=' + encodeURIComponent(st) + '&q=' + encodeURIComponent(q) + '&lists=1';
    { const [f, t] = (st === 'old' || st === 'auto') && TF.period !== 'custom' ? ['', ''] : periodRange(TF.period); /* 1.20.66: Auto is a review queue — every unreviewed line whatever its bank date (the chip counts them all); a custom range still narrows it */ qs += '&from=' + f + '&to=' + t + ['type', 'category', 'vendor_id', 'vkind', 'source', 'min', 'max', 'account', 'side', 'how'].map(k => TF[k] ? '&' + k + '=' + encodeURIComponent(TF[k]) : '').join(''); }
    const j = await api('/api/bookkeeping/transactions' + qs);
    const bs = j.by_status || {};
    $('nTxAll').textContent = (bs.new_open != null ? bs.new_open : bs.new || 0) + (bs.pending || 0) + (bs.old || 0) + (bs.categorized || 0); /* 1.19.113: Today also holds filed lines, so All counts only its open ones */ $('nTxNew').textContent = bs.new || 0; $('nTxPending').textContent = bs.pending || 0; $('nTxOld').textContent = bs.old || 0; $('nTxCategorized').textContent = bs.categorized || 0; $('nTxAuto').textContent = bs.auto || 0;   // 1.19.84: the three buckets are disjoint, All is their sum
    document.querySelectorAll('#subBank button').forEach(b => b.classList.toggle('on', b.dataset.s === (txStats ? 'stats' : st || 'all')));
    const chip = (k, l, n) => '<button class="ib-chip' + (st === k ? ' on' : '') + '" data-st="' + k + '">' + l + (n == null ? '' : ' (' + n + ')') + '</button>';
    const syncIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/></svg>';
    const T = j.totals || {}, chart = cat && txStats ? report(T) : '';   // 1.19.55: the charts live under Stats
    const PERIODS = [['30', 'Last 30 days'], ['month', 'This month'], ['last', 'Last month'], ['90', 'Last 90 days'], ['year', 'This year'], ['all', 'All time']].map(([v, l]) => ({ v, l }));
    const anyF = TF.type || TF.category || TF.vendor_id || TF.vkind || TF.source || TF.min || TF.max || TF.account || TF.side || TF.how || TF.period !== '30' || TF.from || TF.to;
    const fbar = '';   // 1.19.88: "Clear filters" sits beside the Sync button on the top line instead of its own row
    // 1.19.58: short — logo + "WF ••0489"; the full bank and account name on hover
    const BANK_ABBR = { 'wells fargo': 'WF', 'american express': 'Amex', 'bank of america': 'BofA', 'jpmorgan chase': 'Chase', 'capital one': 'CapOne', 'us bank': 'USB', 'u.s. bank': 'USB', 'citibank': 'Citi' };
    const bankAbbr = (n) => { const k = String(n || '').toLowerCase().replace(/[®™]/g, '').trim(); if (BANK_ABBR[k]) return BANK_ABBR[k]; const w = k.split(/\s+/).filter(Boolean); return w.length === 1 ? n.slice(0, 6) : w.map(x => x.charAt(0).toUpperCase()).join('').slice(0, 4); };
    const FO = {
      status: [{ v: 'pending', l: 'Pending — no category yet', t: 'Pending', n: bs.pending || 0 }, { v: 'new', l: 'Today — synced today, not categorized yet', t: 'Today', n: bs.new || 0 }, { v: 'categorized', l: 'Categorized', n: bs.categorized || 0 }, { v: '', l: 'All statuses' }],
      type: [{ v: '', l: 'All categories' }].concat(chart_types().map(t => ({ v: 'T:' + t.name, l: tile(t.color, t.icon, 'sm', '') + ' ' + esc(t.name) })), cat ? (T.by_category || []).map(c => ({ v: 'C:' + c.category, l: catLabel(c.category), n: c.n })) : []),
      vkind: [{ v: '', l: 'All' }, { v: 'supplier', l: '<span class="bk-src supplier">supplier</span>', t: 'Supplier' }, { v: 'vendor', l: '<span class="bk-src vendor">vendor</span>', t: 'Vendor' }, { v: 'nova', l: '<span class="bk-src nova">vendor' + AI_I + '</span>', t: 'Vendor ✦' }, { v: 'bill', l: '<span class="bk-src bill">from a bill</span>', t: 'From a bill' }, { v: 'none', l: 'Not linked' }],
      vendor: [{ v: '', l: 'All companies' }, { v: 'none', l: 'Not linked' }].concat((j.vendors || []).map(x => ({ v: String(x.id), l: esc(x.name) })), TF.vendor_id && TF.vendor_id !== 'none' && !(j.vendors || []).some(x => String(x.id) === TF.vendor_id) ? [{ v: TF.vendor_id, l: esc(TF.vendor_name || 'Company') }] : []),
      source: [{ v: '', l: 'Any' }, { v: 'approved', l: 'Approved (AI proposed)' }, { v: 'manual', l: 'Manual' }, { v: 'rule', l: 'By rule' }],
      account: [{ v: '', l: 'All accounts', h: '<span class="tx-acc-h empty"></span>' }].concat((j.accounts || []).map(a => { const ico = a.logo ? '<img class="tx-acc-i" src="' + esc(a.logo) + '" alt="">' : '<span class="tx-acc-i ph" style="' + (a.color ? 'background:' + esc(a.color) : '') + '">' + esc(String(a.institution || a.account_name || '?').charAt(0)) + '</span>'; return { v: a.account_name, l: ico + ' ' + esc(bankAbbr(a.institution || 'Bank')) + (a.mask ? ' <span class="tx-mask">••' + esc(a.mask) + '</span>' : ''), h: '<span class="tx-acc-h" title="' + esc(a.label) + '">' + ico + '</span>' }; })),
      date: { type: 'range', kind: 'date', from: TF.period === 'custom' ? TF.from : '', to: TF.period === 'custom' ? TF.to : '', period: TF.period, defaultPeriod: '30', presets: PERIODS },
      amount: { type: 'range', kind: 'number', from: TF.min, to: TF.max, groups: [   // 1.19.124: money in / out and how it was paid
        { key: 'side', label: 'Money', value: TF.side, opts: [['', 'Any'], ['in', 'Received'], ['out', 'Paid']] },
        { key: 'how', label: 'How', value: TF.how, opts: [['', 'Any'], ['online', 'Online'], ['store', 'Store'], ['check', 'Check'], ['other', 'Other']] }] }
    };
    const STL = { pending: 'Pending', new: 'Today', old: '90+', categorized: 'Categorized', '': 'All' };
    // 1.19.83: what the Status column says — Today = synced today (LA day) and not categorized, Pending = older and not categorized, else Categorized
    const newSince = j.new_since ? new Date(String(j.new_since).replace(' ', 'T') + 'Z').getTime() : Date.now() - 86400000;   // 1.19.108: the server's 6 AM Los Angeles cut-off
    const shown = (t) => t.status === 'categorized' ? 'categorized' : (new Date(String(t.created_at || '').replace(' ', 'T') + 'Z').getTime() >= newSince ? 'new' : (Date.now() - new Date(String(t.date || '') + 'T00:00:00').getTime() > 90 * 86400000 ? 'old' : 'pending'));
    const SRC_L = { manual: 'manually matched', approved: 'AI, approved', rule: 'by rule', refund: 'refund', transfer: 'transfer', vendor: 'company\'s usual', history: 'from history', ai: 'AI suggestion' , team: 'team member', loan: 'loan payment' };
    const HISTI = '<svg class="tx-ai-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    const VENDI = '<svg class="tx-ai-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/></svg>';
    const aiIcon = '<svg class="tx-ai-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
    // 1.19.47: one row = date (+ when it was synced) · vendor (logo, name, Link / Change, the machine's near match with its
    // score) · description · account ("Wells Fargo - 6595" with the bank's logo) · amount · category.
    // 1.19.55: the Date column is two lines — "Oct 12, 2026" over "5:17pm"
    const laD2 = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(ts) ? '' : 'Z')); if (isNaN(d)) return ''; const o = { timeZone: 'America/Los_Angeles' }; return esc(d.toLocaleDateString([], Object.assign({ month: 'short', day: 'numeric', year: 'numeric' }, o))) + '<div class="bk-dim">' + esc(d.toLocaleTimeString([], Object.assign({ hour: 'numeric', minute: '2-digit' }, o)).replace(' ', '').toLowerCase()) + '</div>'; };
    const SVG = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
    const REFI = SVG('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-5"/>');
    const RULEI = SVG('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>');   // 1.19.77: the Rules tab's target
    const NORULEI = SVG('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>');   // 1.19.116: the target struck through = No rule
    const MAILI = SVG('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>');
    const LOANI = SVG('<path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M9 21v-6h6v6"/>');
    const XFERI = SVG('<path d="M4 8h14l-3-3"/><path d="M20 16H6l3 3"/>');
    const CHECKI = SVG('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h6M6 14h4M15 13h3"/>');
    const isIncome = (name) => { const CH = (ov && ov.chart) || []; const c = CH.find(x => x.name === name); const top = c && c.parent ? CH.find(x => x.name === (parentOf(c.parent) || c.parent)) : c; return !!(top && top.income); };   // `chart` is the stats html here
    const PLUSV = SVG('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>');
    const PEN = SVG('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12.5 7.5l4 4"/>'), LINKI = SVG('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>');
    // how it was paid (Plaid's payment_channel / check_number)
    const CHAN = { store: ['Store', SVG('<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v9h14v-9"/><path d="M10 21v-6h4v6"/>')], online: ['Online', SVG('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>')], check: ['Check', SVG('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h6M7 14h3"/><path d="M15 14l1.5 1.5L19 12"/>')], other: ['Other', SVG('<path d="M4 12h16"/><path d="M14 6l6 6-6 6"/>')] };
    // 1.19.156: Plaid names a Wells Fargo ACH after the words it finds — often OUR name ("Axiom Print" for a USPS or Pacific McGraw
    // debit that says AXIOMPRINT INC in the wording). Our own name on the top line says nothing: show the linked company, else
    // the statement wording's own first words.
    const OWN = /^\s*axiom\s*(print|design)/i;
    const descTop = (t) => { const m = t.merchant || t.name || ''; if (!OWN.test(m)) return m; if (t.vendor_name) return t.vendor_name; const o = String(t.orig_desc || t.name || '').replace(/\s+/g, ' ').trim(); const w = o.split(' ').filter(x => !/\d{3,}/.test(x) && !/axiom/i.test(x)); return w.slice(0, 6).join(' ') || m; };
    const chanLine = (t) => { const c = CHAN[t.channel]; if (!c || t.channel === 'other') return ''; return '<span class="tx-chan" title="' + esc(c[0] + (t.check_no ? ' #' + t.check_no : '')) + '">' + c[1] + '</span>'; };   // 1.19.89: the check number moved under the date
    const checkLine = (t) => t.check_no ? '<div><a href="#" class="tx-check' + (t.has_check_image ? ' has' : '') + '" data-check="' + t.id + '" title="' + (t.has_check_image ? 'See the check' : 'Check #' + esc(t.check_no) + ' — attach a photo of it') + '">' + CHECKI + ' #' + esc(t.check_no) + '</a></div>' : '';
    const txWhen = (t) => { if (t.tx_time) { const d = new Date(t.tx_time); if (!isNaN(d)) return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).replace(/, (\d)/, ', $1').replace(' AM', 'am').replace(' PM', 'pm'); } const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t.tx_date || t.date || '')); return m ? new Date(m[1], m[2] - 1, m[3]).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''; };
    const prettyCat = (t) => { const w = (x) => String(x || '').toLowerCase().split('_').filter(Boolean); const p = w(t.plaid_primary), d = w(t.plaid_category); if (!d.length) return ''; let rest = d; if (p.length && d.slice(0, p.length).join(' ') === p.join(' ')) rest = d.slice(p.length); const cap = (a) => a.length ? a.join(' ').replace(/^./, c => c.toUpperCase()) : ''; return cap(p) + (rest.length && rest.join(' ') !== p.join(' ') && cap(rest) !== 'Other' + (p.length ? ' ' + p.join(' ') : '') ? (p.length ? ' · ' : '') + cap(rest) : ''); };
    const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
    const laT = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(ts) ? '' : 'Z')); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }); };
    const vlogo = (name, photo) => photo ? '<img class="bk-logo bk-vl" src="' + esc(photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;bk-logo bk-vl ph&quot;>' + esc(String(name || '?').charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo bk-vl ph' + (name ? '' : ' none') + '">' + esc(name ? String(name).charAt(0).toUpperCase() : '?') + '</span>';
    const kindTag = (t) => t.vendor_source === 'suppliers' ? 'supplier' : t.vendor_source === 'vendors' ? 'vendor' : t.vendor_source === 'nova' ? 'Nova vendor' : (t.vendor_kind || 'from a bill');
    // 1.19.64: photo with the kind tag under it on the left; company name (+ Link / Change icon, match pill) on the right
    const kindPill = (t) => t.vendor_source === 'nova' ? '<span class="bk-src nova" title="Nova vendor — kept in Nova, not in the CRM">vendor' + AI_I + '</span>' : '<span class="bk-src ' + esc(t.vendor_source || '') + '">' + esc(kindTag(t)) + '</span>';
    const vendorCell = (t) => {
      // 1.19.119: a line matched to an overseas team member — flag, department, and the person instead of a company
      if (t.team) return '<div class="bl-vendor pu-vendor tx-vcell"><div class="tx-vleft"><a href="#" class="tx-vphoto" data-teamgo="' + t.team.id + '" title="Overseas Team">' + vlogo(t.team.name, t.vendor_photo) + '<span class="tx-vedit">' + PEN + '</span></a><span class="bk-src team" title="Overseas team · ' + esc(t.team.dept || '') + '">' + flag(t.team.country) + ' team</span></div><div class="bl-vname"><b class="tx-vn">' + esc(t.team.name) + '</b> <a href="#" class="bl-vact tx-vico" data-unteam="' + t.id + '" title="Not this person — unlink">×</a><div class="bk-dim">' + esc(t.team.dept || '') + '</div></div></div>';
      if (t.vendor_id) return '<div class="bl-vendor pu-vendor tx-vcell"><div class="tx-vleft"><a href="#" class="tx-vphoto" data-vedit="' + t.vendor_id + '" title="' + (t.vendor_source === 'nova' || t.vendor_source === 'bill' ? 'Edit this vendor' : 'Vendor details') + '">' + vlogo(t.vendor_name, t.vendor_photo || t.plaid_logo) + '<span class="tx-vedit">' + PEN + '</span></a>' + kindPill(t) + '</div><div class="bl-vname"><b class="tx-vn">' + esc(t.vendor_name) + '</b> <a href="#" class="bl-vact tx-vico" data-setv="' + t.id + '" title="Change vendor">' + PEN + '</a>' +
        (t.vendor_by === 'auto' ? '<div class="tx-match ok">Matched ' + (t.vendor_score != null ? Math.round(t.vendor_score * 100) + '%' : 'by name') + '</div>' : t.vendor_by === 'person' ? '<div class="bk-dim">linked by a person</div>' : '') + '</div></div>';
      const sug = t.suggest_vendor_id ? '<div class="tx-sug"><span class="tx-match">Matched ' + Math.round((t.suggest_score || 0) * 100) + '%</span><button type="button" class="bk-btn sm p" data-usev="' + t.id + '" data-vid="' + t.suggest_vendor_id + '">Use</button></div><div class="tx-sug-n"><b>' + esc(t.suggest_name) + '</b></div>' : '';
      // 1.19.67: no vendor yet — the Link / Create icons sit under the photo where the kind pill would be
      return '<div class="bl-vendor pu-vendor tx-vcell"><div class="tx-vleft">' + (t.plaid_logo ? vlogo(t.merchant || t.name, t.plaid_logo) : vlogo(null, null)) + '<div class="tx-vacts"><a href="#" class="bl-vact tx-vico" data-setv="' + t.id + '" title="Link to a vendor">' + LINKI + '</a><a href="#" class="bl-vact tx-vico" data-newv="' + t.id + '" title="Create a Nova vendor from this line">' + PLUSV + '</a></div></div><div class="bl-vname"><span class="bl-unlinked">Not linked</span>' + sug + '</div></div>';
    };
    const bankCell = (t) => '<div class="tx-bank" title="' + esc((t.institution || 'Bank') + (t.mask ? ' - ' + t.mask : '') + (t.account_name ? ' · ' + t.account_name : '')) + '">' + (t.bank_logo ? '<img src="' + esc(t.bank_logo) + '" alt="">' : '<span class="tx-bank-ph" style="' + (t.bank_color ? 'background:' + esc(t.bank_color) : '') + '">' + esc(String(t.institution || t.account_name || '?').charAt(0)) + '</span>') +
      '<b>' + esc(t.institution ? bankAbbr(t.institution) : 'Bank') + (t.mask ? ' <span class="tx-mask">••' + esc(t.mask) + '</span>' : '') + '</b></div>';
    const statsBar = txStats ? '<div class="bk-filters tx-stats-bar"><span class="bk-muted">Period</span>' + PERIODS.map(pp => '<button class="ib-chip sm' + (TF.period === pp.v && !TF.from ? ' on' : '') + '" data-period="' + pp.v + '">' + esc(pp.l) + '</button>').join('') + '<span class="sp"></span><button class="bk-btn sm" id="tfMore" title="Vendor, account, amount and category filters">' + (anyF && TF.period === '30' ? 'Filtered' : 'Filter…') + '</button></div>' : '';
    v.innerHTML = '<div class="bk-card"><div class="bk-filters tx-top"><span class="bk-muted">' + (j.matched != null ? j.matched : (j.transactions || []).length) + ' ' + (st && st !== 'new' ? (STL[st] || '').toLowerCase() + ' ' : '') + 'line' + (j.matched === 1 ? '' : 's') + (st === 'new' ? ' synced today' : st === 'auto' ? ' filed by Nova, not reviewed yet' : st === 'old' ? ' older than 90 days' : TF.period === '30' && !TF.from ? ' in the last 30 days' : '') + ((j.transactions || []).length < (j.matched || 0) ? ' · showing the first ' + j.transactions.length : '') + '</span><span class="sp"></span>' + (anyF ? '<button class="bk-btn sm" id="tfClear" title="Remove every column filter">× Clear filters</button>' : '') + (st === 'auto' && (j.matched || (j.transactions || []).length) ? '<button class="bk-btn sm" id="autoReviewed" title="Every line here has been looked at — clear the Auto tab">✓ Mark all reviewed</button>' : '') + '<button class="bk-btn ico" id="syncNow" title="Sync with Bank" aria-label="Sync with Bank">' + syncIcon + '</button></div>' + fbar + statsBar + chart +
      (txStats ? '' : '<table class="bk tx-table"><thead><tr><th class="tx-date">' + thFilter('date', 'Date', FO.date) + '</th><th class="tx-vth">' + thFilter('vkind', 'Vendor', FO.vkind, TF.vkind) + thFilter('vendor', 'Company', FO.vendor, TF.vendor_id) + '</th><th>Description</th><th>' + thFilter('account', 'Account', FO.account, TF.account) + '</th><th class="num">' + thFilter('amount', 'Amount', FO.amount) + '</th><th>' + thFilter('type', 'Category', FO.type, TF.type ? 'T:' + TF.type : TF.category ? 'C:' + TF.category : '') + '</th><th>Status</th></tr></thead><tbody>' +
      (j.transactions || []).map(t => '<tr><td class="tx-date" title="Synced from the bank · bank date ' + esc(usD(t.date)) + (t.pending ? ' (still pending at the bank)' : '') + '">' + laD2(t.created_at) + checkLine(t) + '</td>' +
        '<td>' + vendorCell(t) + '</td><td class="tx-desc-td" title="' + esc([prettyCat(t) ? 'Bank category: ' + prettyCat(t) : '', t.place].filter(Boolean).join(' · ')) + '">' + esc(descTop(t)) + ((t.orig_desc || t.name) !== descTop(t) ? '<div class="bk-muted tx-orig">' + esc(t.orig_desc || t.name) + '</div>' : '') + '</td><td>' + bankCell(t) + '</td>' +
        '<td class="num ' + (t.amount > 0 ? 'neg' : 'pos') + '"><div class="tx-amt">' + usd(-t.amount) + chanLine(t) + '</div><div class="tx-when bk-dim" title="When the transaction happened' + (t.pending ? ' (still pending at the bank)' : '') + '">' + esc(txWhen(t)) + '</div></td>' +
        '<td data-txid="' + t.id + '">' + catSelect(t.category || '', 'tx-cat', t.category ? '' : (t.amount < 0 ? 'Income…' : 'Choose…'), { only: t.amount < 0 ? 'income' : 'expense', reset: t.status === 'categorized' }) /* 1.20.67: Undo (↺ Uncategorize) on every categorized line, in every view — it sits in the picker so the list stays clean */ +
        // 1.19.119: a Wise payout — pick the team member (the server lists the candidates by pay, or everyone), and a web-dev
        // member's line can flip between the build (asset) category and maintenance
        (t.team_hint && t.team_hint.members.length ? '<div class="tx-ref tx-team-hint"><span class="tx-match" title="' + esc(t.team_hint.ambiguous ? 'Two or more team members are on this pay — which one?' : 'A Wise payout — who is it for?') + '">' + TEAMI + ' Who is this?</span><select class="bk sm tx-team-sel" data-teamsel="' + t.id + '"><option value="">— team member —</option>' + t.team_hint.members.map(m => '<option value="' + m.id + '">' + esc(m.name) + (m.dept ? ' · ' + esc(m.dept) : '') + (m.pay != null ? ' · ' + usd(m.pay) : '') + '</option>').join('') + '</select></div>' : '') +
        (t.team && t.team.category_alt && t.category ? '<div class="tx-ref tx-team-flip bk-dim">' + (t.category === t.team.category_alt ? 'maintenance · <a href="#" data-teamcat="' + t.id + '" data-cat="' + esc(t.team.category) + '">build (asset) instead</a>' : 'build (asset) · <a href="#" data-teamcat="' + t.id + '" data-cat="' + esc(t.team.category_alt) + '">maintenance instead</a>') + '</div>' : '') +
        // 1.19.99: loan payments — matched to a loan, or a one-click hint
        (t.loan_id ? '<div class="tx-ref tx-loan" title="A payment on this loan — see Accounts → Loans & Leases"><div>' + LOANI + ' loan: <b>' + esc(t.loan_name || '') + '</b> <a href="#" class="tx-unref" data-unloan="' + t.id + '" title="Unlink">×</a></div></div>'
          : t.loan_hint ? '<div class="tx-ref tx-loan-hint"><span class="tx-match" title="Same monthly amount / same lender as an active loan">' + LOANI + ' Loan payment?</span><button type="button" class="bk-btn sm p" data-loan="' + t.id + '" data-lid="' + t.loan_hint.id + '">Match</button></div><div class="tx-ref tx-ref2 bk-dim">' + esc(t.loan_hint.name) + '</div>' : '') +
        // 1.19.92: transfers between our own accounts — matched, a one-click hint, or the picker
        (t.transfer_of ? '<div class="tx-ref tx-xfer" title="The other half of this transfer; neither side counts as spend or income"><div>' + XFERI + ' transfer ' + (t.amount < 0 ? 'from' : 'to') + ' <b>' + esc(t.transfer_institution ? bankAbbr(t.transfer_institution) : (t.transfer_account || 'account')) + '</b></div><div class="tx-ref2">' + esc(usD(t.transfer_date)) + ' · ' + usd(-t.transfer_amount) + ' <a href="#" class="tx-unref" data-unxfer="' + t.id + '" title="Unmatch">×</a></div></div>'
          : t.transfer_hint ? '<div class="tx-ref tx-xfer-hint"><span class="tx-match" title="Same amount the other way on another account within a week">' + XFERI + ' Transfer?</span> <button type="button" class="bk-btn sm p" data-xfer="' + t.id + '" data-with="' + t.transfer_hint.id + '">Match</button></div><div class="tx-ref tx-ref2 bk-dim">' + esc((t.transfer_hint.institution ? bankAbbr(t.transfer_hint.institution) : t.transfer_hint.account_name || '') + ' · ' + usD(t.transfer_hint.date) + ' · ') + usd(-t.transfer_hint.amount) + '</div>'
          : '') +   // 1.19.95: no picker link on every line — the hint (same amount the other way on another account) is the way in
        (t.amount < 0 ? (t.refund_of ? '<div class="tx-ref" title="Matched to the charge it gives back; the category and the Stats follow that charge"><div>' + REFI + ' refund of <b>' + esc(usD(t.refund_of_date)) + ' · ' + usd(t.refund_of_amount) + '</b></div><div class="tx-ref2">' + esc(t.refund_of_merchant || t.refund_of_name || '') + ' <a href="#" class="tx-unref" data-unref="' + t.id + '" title="Unmatch">×</a></div></div>'
            : t.transfer_of ? '' : '<div class="tx-ref"><a href="#" class="tx-refl" data-ref="' + t.id + '">' + REFI + ' Refund of a charge…</a></div>') : t.refunded_by ? '<div class="tx-ref bk-dim" title="A refund was matched to this charge"><div>' + REFI + ' refunded</div><div class="tx-ref2">' + esc(usD(t.refunded_by_date)) + ' · ' + usd(-t.refunded_by_amount) + '</div></div>' : '') +
        (!t.category && (t.cat_suggest || []).length ? '<div class="tx-ai">' + t.cat_suggest.map(sg => '<span class="tx-sg" title="' + esc(sg.why === 'history' ? 'Every past line from this company went here' + (sg.n ? ' (' + sg.n + ')' : '') : sg.why === 'vendor' ? 'The company\'s usual category' : (t.ai_reason || 'AI suggestion')) + '">' + (() => { const par = parentOf(sg.category), st = styleOf(par || sg.category); return '<span class="tx-sg-n" title="' + esc(par ? par + ' › ' + sg.category : sg.category) + '">' + (par ? tile(st.color, st.icon, 'xs', par.charAt(0)) + '<small class="tx-sg-par">›</small>' : '') + '<b>' + esc(shortName(sg.category, 27)) + '</b></span>'; })() + '<span class="tx-pct">' + Math.round((sg.conf || 0) * 100) + '%</span> <button type="button" class="bk-btn sm p tx-use" data-aicat="' + esc(sg.category) + '" data-src="' + esc(sg.why) + '"' + ((sg.conf || 0) >= 0.9 && !t.rule_exists && !t.refund_of ? ' data-askrule="' + esc(t.vendor_name || t.merchant || t.name) + '"' : '') + '>Use</button></span>').join('') + '</div>' :
          !t.category && t.status === 'new' ? '<div class="tx-ai bk-dim">' + aiIcon + ' rating…</div>' : '') +
        (t.can_rule ? '<div class="tx-ref tx-rules"><a href="#" class="tx-refl tx-mkrule" data-mkrule="' + t.id + '" title="Always file ' + esc(t.vendor_name || t.merchant || t.name) + ' as ' + esc(t.category) + '">' + RULEI + ' Create a rule</a><span class="tx-sep">·</span><a href="#" class="tx-refl tx-norule" data-norule="' + t.id + '" title="Never make a rule for ' + esc(t.vendor_name || t.merchant || t.name) + ' and stop asking">' + NORULEI + ' No rule</a></div>' : '') +
        // 1.19.79: a deposit filed as income is a customer payment — tell Accounts Receivable (once; "again" resends)
        (t.amount < 0 && t.category && !t.refund_of && isIncome(t.category) ? (t.ar_notified_at ? '<div class="tx-ref bk-dim" title="Accounts Receivable was emailed"><div>' + MAILI + ' AR notified ' + esc(usD(t.ar_notified_at.slice(0, 10))) + ' · ' + whoHtml(t.ar_notified_by || '') + ' <a href="#" class="tx-arl" data-ar="' + t.id + '" data-again="1" title="Send the email again">again</a></div></div>' : '<div class="tx-ref"><a href="#" class="tx-refl tx-arl" data-ar="' + t.id + '" title="Email Accounts Receivable about this payment">' + MAILI + ' Notify Accounts Receivable</a></div>') : '') + '</td>' +
        '<td><span class="bk-tag ' + esc(shown(t)) + '" title="' + esc(t.category ? 'Categorized — set ' + (t.category_source === 'approved' ? 'from the AI\'s proposal' : t.category_source === 'rule' ? 'by a vendor rule' : 'by hand') : shown(t) === 'new' ? 'Today — came in from the bank today, not categorized yet (at midnight it moves to Pending)' : shown(t) === 'old' ? '90+ — the bank date is more than 90 days back and it is still not categorized' : 'Pending — came in before today, still not categorized') + '">' + esc(STL[shown(t)]) + '</span>' + (t.category && t.category_source ? '<div class="bk-dim">' + esc(SRC_L[t.category_source] || t.category_source) + '</div>' : '') + (t.category && t.updated_at ? '<div class="bk-dim tx-when" title="When it was categorized">' + laD2(t.updated_at).replace(/<div[^>]*>/g, ' ').replace(/<\/div>/g, '').trim() + '</div>' : '') + '</td></tr>').join('') + '</tbody></table>' +
      (!(j.transactions || []).length ? '<div class="bk-muted" style="padding:14px 0">' + (st === 'new' ? 'Nothing came in from the bank today yet.' : 'No transactions here — connect a bank under Settings, then Sync.') + '</div>' : '')) + '</div>';
    if ($('tfMore')) $('tfMore').onclick = () => { txStats = false; txnSt = 'categorized'; lastSub.bank = 'categorized'; document.querySelectorAll('#subBank button').forEach(b => b.classList.toggle('on', b.dataset.s === 'categorized')); loadTxns(); };
    v.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { txnSt = b.dataset.st; loadTxns(); });
    const saveTF = () => { try { localStorage.setItem('bk_txn_filters', JSON.stringify(TF)); } catch (e) {} loadTxns(); };
    v.querySelectorAll('[data-period]').forEach(b => b.onclick = () => { TF.period = b.dataset.period; saveTF(); });
    if ($('tfFrom')) { $('tfFrom').onchange = () => { TF.from = $('tfFrom').value; saveTF(); }; $('tfTo').onchange = () => { TF.to = $('tfTo').value; saveTF(); }; }
    if ($('tfMin')) { $('tfMin').onchange = () => { TF.min = $('tfMin').value; saveTF(); }; $('tfMax').onchange = () => { TF.max = $('tfMax').value; saveTF(); }; }
    if ($('tfClear')) $('tfClear').onclick = () => { Object.assign(TF, { type: '', category: '', vendor_id: '', vkind: '', source: '', min: '', max: '', account: '', side: '', how: '', period: '30', from: '', to: '' }); saveTF(); };
    thFilterBind(v, FO, (key, val) => {
      if (key === 'type') { TF.type = val.startsWith('T:') ? val.slice(2) : ''; TF.category = val.startsWith('C:') ? val.slice(2) : ''; if (!cat && (TF.type || TF.category)) { txnSt = 'categorized'; lastSub.bank = 'categorized'; } }
      else if (key === 'vendor') TF.vendor_id = val;
      else if (key === 'vkind') TF.vkind = val;
      else if (key === 'date') { TF.period = val.period || '30'; TF.from = val.from || ''; TF.to = val.to || ''; }
      else if (key === 'amount') { TF.min = val.from || ''; TF.max = val.to || ''; TF.side = val.side || ''; TF.how = val.how || ''; }
      else TF[key] = val; saveTF(); });
    v.querySelectorAll('[data-rtype]').forEach(el => el.onclick = () => { TF.type = el.dataset.rtype; TF.category = ''; saveTF(); });
    v.querySelectorAll('[data-rvendor]').forEach(el => el.onclick = () => { TF.vendor_id = el.dataset.rvendor; saveTF(); });
    $('syncNow').onclick = async () => { $('syncNow').disabled = true; const r = await post('/api/bookkeeping/sync', {}); if (!r.ok) alert(r.error); loadTxns(); overview(); };
    if ($('autoReviewed')) $('autoReviewed').onclick = async () => {
      const n = j.matched != null ? j.matched : (j.transactions || []).length;
      if (!(await ask('Mark all **' + n + '** auto-filed lines as reviewed? They leave the Auto tab (and stay under Categorized).', { ok: 'Mark reviewed' }))) return;
      const r = await post('/api/bookkeeping/transactions/auto-reviewed', {}); if (!r.ok) return alert(r.error);
      toast(r.reviewed + ' line' + (r.reviewed === 1 ? '' : 's') + ' marked reviewed'); loadTxns('auto'); overview();
    };
    // Picking a category sets it on the spot (no Set button); the row flashes green.
    v.querySelectorAll('td[data-txid]').forEach(td => { const wrap = td.querySelector('.ckp'), inp = td.querySelector('input.tx-cat'); let last = inp.value;
      // 1.19.149: "↺ Uncategorize" (Categorized view only) — back to Pending, the sweeps leave it alone until it is filed again
      wrap.addEventListener('ckp-reset', async () => { if (!(await ask('Clear **' + (inp.value || 'the category') + '** and send this line back to **Pending**? Rules and the AI will not file it again on their own — you pick the category when you are ready.', { title: 'Uncategorize this line?', ok: 'Uncategorize' }))) return;
        const r = await post('/api/bookkeeping/transactions/' + td.dataset.txid + '/uncategorize', {}); if (!r.ok) { alert(r.error || 'Could not reset.'); return; } toast('Back to Pending'); loadTxns(); overview(); });
      wrap.addEventListener('change', async () => { if (inp.value === last || !inp.value) return; last = inp.value; const r = await post('/api/bookkeeping/transactions/' + td.dataset.txid + '/category', { category: inp.value, source: td.dataset.src || 'manual' }); td.dataset.src = ''; const tr = td.closest('tr'); tr.classList.add(r.ok ? 'saved' : 'failed');
        // 1.19.85: a 90%+ suggestion taken → offer to make it a rule, so the next line from that company files itself
        const who = td.dataset.askrule; td.dataset.askrule = '';
        if (r.ok && who) { const sw = shortName(who); const ok = await ask('Always file **' + sw + '** as **' + inp.value + '**? A rule categorizes every future line from them on its own (and any pending ones now). Edit or remove it under Accounts → Rules. "Never" stops this question for good (eBay, where every purchase is different).', { title: 'Make it a rule?', ok: 'Create a Rule', cancel: 'Not now', alt: 'Never for ' + shortName(who, 18) }); if (ok) { const rr = await post('/api/bookkeeping/transactions/' + td.dataset.txid + '/rule', ok === 'alt' ? { none: true } : {}); if (!rr.ok) alert(rr.error || 'Could not create the rule.'); } }   // 1.19.112: 'alt' = No rule
        setTimeout(() => { tr.classList.remove('saved', 'failed'); loadTxns(); overview(); }, 700); }); });
    v.querySelectorAll('[data-ref]').forEach(a => a.onclick = (e) => { e.preventDefault(); refundPicker(a, Number(a.dataset.ref), (j.transactions || []).find(x => x.id === Number(a.dataset.ref))); });
    // 1.19.119: overseas team — pick the person for a Wise payout, unlink, flip build / maintenance, jump to the tab
    v.querySelectorAll('[data-teamsel]').forEach(sel => sel.onchange = async () => {
      const tid = Number(sel.value); if (!tid) return; const t = (j.transactions || []).find(x => x.id === Number(sel.dataset.teamsel)); const m = t && t.team_hint.members.find(x => x.id === tid); if (!m) return;
      let remember = false;
      if (m.pay != null && Math.abs(Number(m.pay) - Math.abs(Number(t.amount))) >= 0.005) { const a = await ask('**' + m.name + '** is on ' + usd(m.pay) + ' per period; this payout is ' + usd(Math.abs(t.amount)) + '. Link it to them — and is ' + usd(Math.abs(t.amount)) + ' their pay from now on?', { title: 'Different amount', ok: 'Link and remember the new pay', alt: 'Link only this one' }); if (a === false) { sel.value = ''; return; } remember = a === true; }
      else if (m.pay == null) remember = await ask('Remember ' + usd(Math.abs(t.amount)) + ' as **' + m.name + '**\'s pay per period? Future payouts of that amount link to them by themselves.', { title: 'Remember the pay?', ok: 'Yes, remember', cancel: 'Just this one' });
      sel.disabled = true; const r = await post('/api/bookkeeping/transactions/' + t.id + '/team', { team_id: tid, remember }); if (!r.ok) alert(r.error || 'Could not link'); loadTxns(); overview();
    });
    v.querySelectorAll('[data-unteam]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/transactions/' + a.dataset.unteam + '/team', { team_id: null }); if (!r.ok) alert(r.error); loadTxns(); });
    v.querySelectorAll('[data-teamcat]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/transactions/' + a.dataset.teamcat + '/category', { category: a.dataset.cat, source: 'manual' }); if (!r.ok) alert(r.error); loadTxns(); });
    v.querySelectorAll('[data-teamgo]').forEach(a => a.onclick = (e) => { e.preventDefault(); location.href = '/bookkeeping?tab=accounts&sub=team'; });
    // 1.19.99: loan payments — match from the hint, unlink
    v.querySelectorAll('[data-loan]').forEach(b => b.onclick = async () => { b.disabled = true; const r = await post('/api/bookkeeping/transactions/' + b.dataset.loan + '/loan', { loan_id: Number(b.dataset.lid) }); if (!r.ok) alert(r.error);
      else if (r.vendor_made || r.swept) toast((r.vendor_made ? '<b>' + esc(r.vendor_made) + '</b> is now the lender on this loan' : 'Linked to the loan') + (r.swept ? ' · ' + r.swept + ' more payment' + (r.swept === 1 ? '' : 's') + ' matched' : ''), 5000);   // 1.19.144
      loadTxns(); overview(); });
    v.querySelectorAll('[data-unloan]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/transactions/' + a.dataset.unloan + '/loan', { loan_id: null }); if (!r.ok) alert(r.error); loadTxns(); });
    // 1.19.92: transfers — one-click match from the hint, the picker, unmatch
    v.querySelectorAll('[data-xfer]').forEach(b => b.onclick = async () => { b.disabled = true; const r = await post('/api/bookkeeping/transactions/' + b.dataset.xfer + '/transfer', { with: Number(b.dataset.with) }); if (!r.ok) alert(r.error); loadTxns(); overview(); });
    v.querySelectorAll('[data-unxfer]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/transactions/' + a.dataset.unxfer + '/transfer', { with: null }); if (!r.ok) alert(r.error); loadTxns(); overview(); });
    v.querySelectorAll('[data-xferpick]').forEach(a => a.onclick = (e) => { e.preventDefault(); transferPicker(a, Number(a.dataset.xferpick), (j.transactions || []).find(x => x.id === Number(a.dataset.xferpick))); });
    // 1.19.89: the check number opens the check's photo, or a box to attach one (paste, drop or upload)
    v.querySelectorAll('[data-check]').forEach(a => a.onclick = (e) => { e.preventDefault(); const t = (j.transactions || []).find(x => x.id === Number(a.dataset.check)); if (t) checkPop(t); });
    // 1.19.79: Notify Accounts Receivable about a customer payment
    v.querySelectorAll('[data-ar]').forEach(a => a.onclick = async (e) => {
      e.preventDefault(); const t = (j.transactions || []).find(x => x.id === Number(a.dataset.ar)); if (!t) return;
      const ok = await ask('Email Accounts Receivable about this payment — ' + usd(-t.amount) + ' from ' + (t.vendor_name || t.merchant || t.name) + ' on ' + usD(t.date) + '? The email goes to ' + (ov.settings.ar_to || '') + (ov.settings.ar_cc ? ', Cc ' + ov.settings.ar_cc : '') + ' (Settings → Alerts).', { title: a.dataset.again ? 'Send again?' : 'Notify Accounts Receivable', ok: 'Send email' });
      if (!ok) return;
      const r = await post('/api/bookkeeping/transactions/' + t.id + '/notify-ar', { again: !!a.dataset.again });
      if (!r.ok) { alert(r.error || 'Could not send.'); return; }
      a.replaceWith(Object.assign(document.createElement('span'), { className: 'bk-dim', textContent: 'Sent to ' + r.to })); setTimeout(() => loadTxns(), 900);
    });
    // 1.19.112: "no rule" — remember never to file this vendor by rule and stop offering
    v.querySelectorAll('[data-norule]').forEach(a => a.onclick = async (e) => {
      e.preventDefault(); const t = (j.transactions || []).find(x => x.id === Number(a.dataset.norule)); if (!t) return;
      const who = t.vendor_name || t.merchant || t.name;
      const ok = await ask('Never make a rule for **' + shortName(who) + '**? Their lines will keep asking for a category by hand, and Nova stops offering "Make it a rule?" for them. Undo under Accounts → Rules.', { title: 'No rule for ' + shortName(who), ok: 'Yes, no rule' });
      if (!ok) return;
      const r = await post('/api/bookkeeping/transactions/' + t.id + '/rule', { none: true });
      if (!r.ok) { alert(r.error || 'Could not save.'); return; }
      a.closest('.tx-ref').replaceWith(Object.assign(document.createElement('span'), { className: 'bk-dim', textContent: 'No rule for ' + who }));
    });
    // 1.19.77: Create a rule from a categorized line — asks first, then the rule also files every pending line of that vendor
    v.querySelectorAll('[data-mkrule]').forEach(a => a.onclick = async (e) => {
      e.preventDefault(); const t = (j.transactions || []).find(x => x.id === Number(a.dataset.mkrule)); if (!t) return;
      const who = t.vendor_name || t.merchant || t.name;
      const ok = await ask('Always file **' + shortName(who) + '** as **' + t.category + '**? Every pending bank line from them gets this category now, and new ones as they come in. Edit or remove the rule under Accounts → Rules.', { title: 'Create a rule', ok: 'Create rule' });
      if (!ok) return;
      const r = await post('/api/bookkeeping/transactions/' + t.id + '/rule', {});
      if (!r.ok) { alert(r.error || 'Could not create the rule.'); return; }
      a.replaceWith(Object.assign(document.createElement('span'), { className: 'bk-dim', textContent: 'Rule created' + (r.applied ? ' · ' + r.applied + ' pending line' + (r.applied === 1 ? '' : 's') + ' filed' : '') }));
      setTimeout(() => { loadTxns(); overview(); }, 900);
    });
    v.querySelectorAll('[data-unref]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/transactions/' + a.dataset.unref + '/refund', { of: null }); if (!r.ok) alert(r.error); loadTxns(); });
    v.querySelectorAll('.tx-more').forEach(b => b.onclick = () => { const m = b.nextElementSibling; m.hidden = !m.hidden; b.classList.toggle('open', !m.hidden); });
    v.querySelectorAll('.tx-use').forEach(b => b.onclick = () => { const td = b.closest('td'); td.dataset.src = b.dataset.src || ''; td.dataset.askrule = b.dataset.askrule || ''; ckpSet(td.querySelector('.ckp'), [b.dataset.aicat]); });
    clearTimeout(txnPoll); if (j.categorizing) txnPoll = setTimeout(() => { const on = document.querySelector('.bk-view.on'); if (on && on.dataset.v === 'bank') loadTxns(); }, 8000);   // the AI is rating new lines — refresh to show its suggestions
    const setV = async (id, vid) => { const r = await post('/api/bookkeeping/transactions/' + id + '/vendor', { vendor_id: vid }); if (!r.ok) alert(r.error || 'Could not link'); else learnedNote(r); loadTxns(); };
    v.querySelectorAll('[data-setv]').forEach(a => a.onclick = (e) => { e.preventDefault(); const t = (j.transactions || []).find(x => String(x.id) === a.dataset.setv); vendorPicker(a, { vendor: t ? (t.merchant || t.name) : '', suggestions: t && t.suggest_vendor_id ? [{ id: t.suggest_vendor_id, name: t.suggest_name, photo: t.suggest_photo, score: t.suggest_score || 0 }] : [] }, (vid) => setV(a.dataset.setv, vid)); });
    v.querySelectorAll('[data-usev]').forEach(b => b.onclick = () => setV(b.dataset.usev, Number(b.dataset.vid)));
    v.querySelectorAll('[data-vedit]').forEach(a => a.onclick = (e) => { e.preventDefault(); vendorCard(Number(a.dataset.vedit), () => loadTxns()); });   // 1.19.69: finish the vendor's record from the feed
    const vth = v.querySelector('.thf[data-thf=vendor]'); if (vth) vth.onclick = (e) => { e.stopPropagation(); document.querySelectorAll('.thf-pop').forEach(p => p.remove()); if (e.target.closest('.thf-x')) { TF.vendor_id = ''; TF.vendor_name = ''; saveTF(); return; } vendorPicker(vth, { vendor: '', suggestions: [] }, (val, name) => { TF.vendor_id = val; TF.vendor_name = val && val !== 'none' ? name : ''; saveTF(); }, { filter: { current: TF.vendor_id } }); };
    v.querySelectorAll('[data-newv]').forEach(a => a.onclick = (e) => { e.preventDefault(); const t = (j.transactions || []).find(x => String(x.id) === a.dataset.newv); novaVendorForm({ name: t ? (t.merchant || t.name) : '', aliases: t ? [t.merchant, t.name].filter((x, i, arr) => x && arr.indexOf(x) === i).join('\n') : '', website: t && t.website ? t.website : '' }, (nv) => setV(a.dataset.newv, nv.id)); });
  }

  // ---------------------------------------------------------------- Bills
  // What a bill line is: a material from the catalog, or a job in the system by its estimate number (E1234567).
  function lineLinkPicker(line, done) {
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(480px,100%)"><div class="bk-modal-title">Link this line</div><div class="bk-muted" style="margin-bottom:10px">' + esc(line.description || '') + '</div>' +
      '<div class="vp-list"><div class="vp-i" data-mat><span class="mv-ic" style="--kc:#4338ca;--kbg:#eef2ff">' + iconSvg('layers') + '</span><span class="vp-n">Material from the catalog<small>' + (line.material_id ? 'now: ' + esc(line.material_name || '#' + line.material_id) : 'search the CRM materials list') + '</small></span></div></div>' +
      '<div class="vp-list" style="margin-top:6px"><div class="vp-i" data-mach><span class="mv-ic" style="--kc:#1e40af;--kbg:#dbeafe">' + iconSvg('printer') + '</span><span class="vp-n">Machine payment<small>' + (line.equipment_id ? 'now: ' + esc(line.equipment_name || '#' + line.equipment_id) : 'a lease or loan payment for one of our machines') + '</small></span></div></div>' +
      '<div class="vp-h">OR a job</div><div class="bk-row" style="gap:8px"><input class="bk" id="llEst" placeholder="Estimate number, e.g. E1180747" value="' + esc(line.estimate_no ? 'E' + line.estimate_no : '') + '" style="flex:1;margin:0"><button class="bk-btn sm p" data-est>Link job</button></div>' +
      '<div class="bk-ask-acts">' + (line.material_id || line.estimate_no || line.equipment_id ? '<button class="bk-btn" data-clear>Unlink</button>' : '') + '<button class="bk-btn" data-no>Cancel</button></div></div>';
    document.body.appendChild(el);
    const close = () => el.remove();
    el.querySelector('[data-no]').onclick = close; el.onclick = (ev) => { if (ev.target === el) close(); };
    el.querySelector('[data-mat]').onclick = () => { close(); materialPicker(line.description, (m) => { if (m) done({ material: m }); }); };
    el.querySelector('[data-mach]').onclick = () => { close(); machinePicker((m) => { if (m) done({ equipment: m }); }); };
    el.querySelector('[data-est]').onclick = () => { const n = $('llEst').value.replace(/[^0-9]/g, ''); if (!n) return alert('Type the estimate number (E followed by digits).'); close(); done({ estimate: n }); };
    const cl = el.querySelector('[data-clear]'); if (cl) cl.onclick = () => { close(); done({}); };
    $('llEst').onkeydown = (e) => { if (e.key === 'Enter') el.querySelector('[data-est]').click(); };
  }
  // Pick one of our machines (Accounts → Equipment); financed ones first, with their monthly payment.
  async function machinePicker(pick) {
    const j = await api('/api/bookkeeping/equipment?fresh=0'); const list = (j.equipment || []).filter(e => e.active).sort((a, b) => ((b.mode === 'loan' || b.mode === 'lease') ? 1 : 0) - ((a.mode === 'loan' || a.mode === 'lease') ? 1 : 0) || String(a.name).localeCompare(b.name));
    const MODE = { owned: 'Owned', loan: 'Loan', lease: 'Lease' };
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(520px,100%)"><div class="bk-modal-title">Which machine?</div><input class="bk" id="mcQ" placeholder="Search machines" style="width:100%"><div class="vp-list" id="mcList" style="margin-top:8px;max-height:50vh;overflow:auto"></div><div class="bk-ask-acts"><button class="bk-btn" data-no>Cancel</button></div></div>';
    document.body.appendChild(el);
    const paint = () => { const q = $('mcQ').value.trim().toLowerCase(); const hits = list.filter(e => !q || (e.name + ' ' + (e.team || '') + ' ' + (e.vendor_name || '')).toLowerCase().indexOf(q) > -1);
      $('mcList').innerHTML = hits.length ? hits.map(e => '<div class="vp-i" data-e="' + e.id + '">' + (e.photo ? '<img class="pv-ph sm" src="' + esc(e.photo) + '" alt="">' : '<span class="pv-ph sm ph">' + esc(e.name.charAt(0)) + '</span>') + '<span class="vp-n">' + esc(e.name) + (e.mode ? ' <span class="eq-mode ' + e.mode + '">' + MODE[e.mode] + '</span>' : '') + '<small>' + esc([e.team, e.vendor_name, e.schedule && e.schedule.monthly ? usd(e.schedule.monthly) + '/mo' : ''].filter(Boolean).join(' · ')) + '</small></span></div>').join('') : '<div class="bk-dim" style="padding:8px">No machine matches.</div>';
      el.querySelectorAll('[data-e]').forEach(i => i.onclick = () => { const m = list.find(x => x.id === Number(i.dataset.e)); el.remove(); pick(m); }); };
    $('mcQ').oninput = paint; paint(); $('mcQ').focus();
    el.querySelector('[data-no]').onclick = () => el.remove(); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
  }
  // An email in a popup (from a bill or a purchase): header, body, attachments, and "Take me to the Inbox".
  // 1.19.30: click the paperwork icons → what each slot holds (bill, bank lines, confirmation, deliveries); emails open, the bill goes to Bills
  // 1.20.67: the Received popover — the status by hand, a delivery email matched from the vendor's recent mail (search too),
  // or the slip the driver handed to Receiving dropped / pasted / uploaded. An email or a slip asks "Fully or partially?" and
  // sets the status itself; the pill on the row then reads Received / Partially received.
  const fullOrPart = async (what) => { const r = await ask('**' + what + '** — did everything arrive?', { title: 'Received', ok: 'Fully received', alt: 'Partially', cancel: 'Cancel' }); if (!r) return null; if (r === true) return { received: 'yes', note: '' }; const note = await askText('What arrived, what is missing?', { title: 'Partially received' }); if (note == null) return null; return { received: 'partial', note }; };
  const fIconOf = (f) => f.ext === 'pdf' ? '<span class="ln-fi pdf">PDF</span>' : f.ext === 'docx' ? '<span class="ln-fi doc">DOC</span>' : f.ext === 'xlsx' ? '<span class="ln-fi xls">XLS</span>' : '<span class="ln-fi img">IMG</span>';
  const openDoc = async (id) => { const rr = await fetch('/api/bookkeeping/files/' + id, { headers: { 'Authorization': 'Bearer ' + token } }); if (!rr.ok) return alert('File not available.'); window.open(URL.createObjectURL(await rr.blob()), '_blank', 'noopener'); };
  async function receivePop(anchor, p, done) {
    document.querySelectorAll('.ckp-pop').forEach(x => x.remove());
    const usD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '-' + m[3] + '-' + m[1] : String(d || ''); };
    const pop = document.createElement('div'); pop.className = 'ckp-pop single pw-pop rv-pop'; pop.addEventListener('click', (e) => e.stopPropagation());
    const cur = p.delivery || 'na';
    pop.innerHTML = '<div class="pw-t">Received — ' + esc(p.vendor || '?') + (p.order_no ? ' <small>#' + esc(p.order_no) + '</small>' : '') + (p.amount != null ? ' <small>' + usd(p.amount) + '</small>' : '') + '</div>' +
      '<div class="rv-row">' + DELIV.map(d => '<button type="button" class="bk-btn sm rv-b rv-' + d[0] + (cur === d[0] ? ' cur' : '') + '" data-rs="' + d[0] + '" title="' + esc(d[2]) + '">' + esc(RECV_L[d[0]]) + '</button>').join('') + '</div>' +
      '<div class="pw-g"><div class="pw-h"><span class="pu-slot arr on">' + iconSvg('mail') + '</span>Match a delivery email <span class="bk-dim">— the vendor\'s latest mail</span></div><input class="bk sm rv-q" placeholder="Search subject or sender…"><div class="rv-list"><div class="bk-dim" style="padding:4px 2px">Loading…</div></div></div>' +
      '<div class="pw-g"><div class="pw-h"><span class="pu-slot arr on">' + iconSvg('upload') + '</span>Upload the delivery slip <span class="bk-dim">— what the driver handed to Receiving</span></div><div class="ln-drop rv-drop" tabindex="0">' + iconSvg('upload') + '<div><b>Drop it here</b>, paste (Ctrl+V) or click · PDF or a photo</div><input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" hidden></div><div class="rv-msg bk-dim"></div><div class="rv-files ln-files"></div></div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = Math.min(440, window.innerWidth - 16);
    pop.style.left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8)) + 'px'; pop.style.width = W + 'px';
    const below = window.innerHeight - r.bottom - 8; if (below >= 360) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.maxHeight = Math.min(560, below) + 'px'; } else { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.maxHeight = Math.min(560, r.top - 8) + 'px'; }
    const close = () => { pop.remove(); document.removeEventListener('click', close); document.removeEventListener('paste', onPaste); }; setTimeout(() => document.addEventListener('click', close), 0);
    const finish = () => { close(); if (done) done(); };
    // by hand
    pop.querySelectorAll('[data-rs]').forEach(b => b.onclick = async () => { const st = b.dataset.rs; let note = ''; if (st === 'partial') { note = await askText('What arrived, what is missing?', { title: 'Partially received' }); if (note == null) return; } const rr = await post('/api/bookkeeping/purchases/' + p.id + '/delivery', { status: st, note }); if (!rr.ok) return alert(rr.error); finish(); });
    // the vendor's emails
    const list = pop.querySelector('.rv-list'), q = pop.querySelector('.rv-q'); let tmr = null;
    const paintEmails = async () => {
      const j = await api('/api/bookkeeping/purchases/' + p.id + '/emails?q=' + encodeURIComponent(q.value.trim()));
      if (!j.ok) { list.innerHTML = '<div class="bk-dim">' + esc(j.error) + '</div>'; return; }
      list.innerHTML = j.emails.length ? j.emails.map(e => '<div class="pw-i rv-e" data-e="' + e.id + '" title="Attach as the delivery of this purchase"><a href="#" data-e="' + e.id + '">' + esc(e.subject || '(no subject)') + '</a><small>' + esc(usD(e.received_at)) + ' · ' + esc(String(e.from || '').replace(/<.*$/, '').trim()) + (e.kind ? ' · ' + esc(e.kind) : '') + (e.attachments ? ' · ' + e.attachments + ' attachment' + (e.attachments === 1 ? '' : 's') : '') + (e.on_purchase ? ' · on purchase #' + e.on_purchase : '') + '</small></div>').join('') : '<div class="bk-dim" style="padding:4px 2px">' + esc(j.note || (q.value.trim() ? 'Nothing matches.' : 'No recent mail from this vendor — search by words.')) + '</div>';
      list.querySelectorAll('[data-e]').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); const e = j.emails.find(x => String(x.id) === a.dataset.e); const fp = await fullOrPart(e.subject || 'This email'); if (!fp) return; const rr = await post('/api/bookkeeping/purchases/' + p.id + '/attach-email', { email_id: e.id, role: 'delivery', received: fp.received, note: fp.note }); if (!rr.ok) return alert(rr.error); toast('Delivery email attached · ' + RECV_L[fp.received]); finish(); });
    };
    q.oninput = () => { clearTimeout(tmr); tmr = setTimeout(paintEmails, 400); }; q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(tmr); paintEmails(); } };
    paintEmails();
    // the slip
    const drop = pop.querySelector('.rv-drop'), pick = drop.querySelector('input'), msg = pop.querySelector('.rv-msg'), fl = pop.querySelector('.rv-files');
    const paintFiles = async () => { const j = await api('/api/bookkeeping/purchases/' + p.id + '/files'); const files = j.files || []; fl.innerHTML = files.map(f => '<div class="ln-file">' + fIconOf(f) + '<div class="ln-fn"><a href="#" data-open="' + f.id + '">' + esc(f.name) + '</a><div class="bk-dim">' + (f.uploaded_by ? esc(f.uploaded_by.split('@')[0]) + ' · ' : '') + esc(usD(f.created_at)) + '</div></div><a href="#" class="bk-dim" data-rm="' + f.id + '" title="Remove">×</a></div>').join('');
      fl.querySelectorAll('[data-open]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); openDoc(a.dataset.open); });
      fl.querySelectorAll('[data-rm]').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); if (!(await ask('Remove this slip?', { ok: 'Remove', danger: true }))) return; await post('/api/bookkeeping/files/' + a.dataset.rm + '/delete', {}); paintFiles(); }); };
    paintFiles();
    const upload = async (files) => {
      files = Array.from(files || []).filter(f => f && f.size); if (!files.length) return;
      const fp = await fullOrPart(files.length === 1 ? files[0].name : files.length + ' files'); if (!fp) return;
      let n = 0;
      for (const f of files) { msg.textContent = 'Uploading ' + f.name + '…';
        const rr = await fetch('/api/bookkeeping/purchases/' + p.id + '/files', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name || 'slip'), 'X-File-Label': 'delivery', 'X-Received': fp.received, 'X-Note': encodeURIComponent(fp.note || '') }, body: f }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
        if (!rr.ok) { msg.textContent = f.name + ': ' + (rr.error || 'could not upload'); continue; } n++; }
      if (n) { toast(n + ' slip' + (n === 1 ? '' : 's') + ' saved · ' + RECV_L[fp.received]); finish(); }
    };
    drop.onclick = () => pick.click(); pick.onchange = () => upload(pick.files);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over'); drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files); };
    const onPaste = (e) => { const fs = Array.from((e.clipboardData || {}).files || []); if (fs.length) { e.preventDefault(); upload(fs); } }; document.addEventListener('paste', onPaste);
  }
  async function paperworkPop(anchor, pid) {
    document.querySelectorAll('.ckp-pop').forEach(p => p.remove());
    const j = await api('/api/bookkeeping/purchases/' + pid); if (!j.ok) return alert(j.error);
    const p = j.purchase, usD = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '-' + m[3] + '-' + m[1] : String(d || ''); };
    const em = (e) => '<div class="pw-i"><a href="#" data-em="' + e.id + '">' + esc(e.subject || '(no subject)') + '</a><small>' + esc(usD(e.received_at)) + (e.attachments ? ' · ' + e.attachments + ' attachment' + (e.attachments === 1 ? '' : 's') : '') + '</small></div>';
    const grp = (k, title, body, empty) => '<div class="pw-g"><div class="pw-h"><span class="pu-slot ' + k + (body ? ' on' : '') + '">' + iconSvg(SLOT_ICON[k]) + '</span>' + title + '</div>' + (body || '<div class="pw-none">' + empty + '</div>') + '</div>';
    const conf = p.emails.filter(e => e.role === 'confirmation'), dels = p.emails.filter(e => e.role === 'delivery');
    const pop = document.createElement('div'); pop.className = 'ckp-pop single pw-pop'; pop.addEventListener('click', (e) => e.stopPropagation());
    pop.innerHTML = '<div class="pw-t">Paperwork for ' + esc(p.vendor || '?') + (p.order_no ? ' <small>#' + esc(p.order_no) + '</small>' : '') + '</div>' +
      grp('bill', 'Bill', p.bill ? '<div class="pw-i"><a href="#" data-gobill="' + p.bill.id + '">Bill #' + p.bill.id + (p.bill.invoice_no ? ' · ' + esc(p.bill.invoice_no) : '') + '</a><small>' + esc(usD(p.bill.invoice_date)) + ' · ' + usd(p.bill.total) + ' · ' + esc(p.bill.status) + '</small></div>' : '', 'No bill') +
      grp('bank', 'Bank line' + (p.txns.length === 1 ? '' : 's'), p.txns.length ? p.txns.map(t => '<div class="pw-i"><span>' + esc(t.merchant || t.name) + '</span><small>' + esc(usD(t.date)) + ' · ' + usd(Math.abs(t.amount)) + (t.account_name ? ' · ' + esc(t.account_name) : '') + '</small></div>').join('') : '', p.no_paperwork ? 'Bank line only — no paperwork expected' : 'No bank line yet') +
      grp('conf', 'Confirmation', conf.length ? conf.map(em).join('') : '', 'No confirmation email') +
      grp('arr', 'Delivery <a href="#" class="pw-add" data-recv-add title="Match a delivery email or upload the slip">+ Attach…</a>', (dels.length ? dels.map(em).join('') : '') + (p.files || []).map(f => '<div class="pw-i"><a href="#" data-file="' + f.id + '">' + esc(f.name) + '</a><small>slip · ' + esc(usD(f.created_at)) + (f.uploaded_by ? ' · ' + esc(f.uploaded_by.split('@')[0]) : '') + '</small></div>').join(''), p.expects_delivery ? 'No delivery email or slip yet' : 'Nothing to receive') +
      '<div class="ckp-foot"><a href="#" data-openp="' + p.id + '">Open the purchase</a> <span class="bk-dim">· emails, attachments, items</span></div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = Math.min(400, window.innerWidth - 16);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.width = W + 'px';
    const below = window.innerHeight - r.bottom - 8; if (below >= 300) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.maxHeight = Math.min(460, below) + 'px'; } else { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.maxHeight = Math.min(460, r.top - 8) + 'px'; }
    const close = () => { pop.remove(); document.removeEventListener('click', close); }; setTimeout(() => document.addEventListener('click', close), 0);
    pop.querySelectorAll('[data-em]').forEach(a => a.onclick = (e) => { e.preventDefault(); close(); emailModal(Number(a.dataset.em)); });
    pop.querySelectorAll('[data-gobill]').forEach(a => a.onclick = (e) => { e.preventDefault(); close(); show('bills', p.bill.status === 'draft' ? 'pending' : p.bill.status); setTimeout(() => { const c = document.querySelector('.bl-card[data-bill="' + a.dataset.gobill + '"]'); if (c) { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1800); } }, 700); });
    pop.querySelectorAll('[data-openp]').forEach(a => a.onclick = (e) => { e.preventDefault(); close(); purchaseView(p.id, () => loadPurchases(lastSub.purchases)); });
    pop.querySelectorAll('[data-file]').forEach(a => a.onclick = (e) => { e.preventDefault(); openDoc(a.dataset.file); });
    const add = pop.querySelector('[data-recv-add]'); if (add) add.onclick = (e) => { e.preventDefault(); close(); receivePop(anchor, Object.assign({}, p, { delivery: p.expects_delivery ? (p.received || 'no') : 'na' }), () => loadPurchases(lastSub.purchases)); };
  }
  async function emailModal(id) {
    const j = await api('/api/bookkeeping/emails/' + id); if (!j.ok) return alert(j.error);
    const e = j.email; const dec = (t) => { const d = document.createElement('textarea'); d.innerHTML = String(t || ''); return d.value; };
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box em-modal"><div class="bk-modal-title" style="display:flex;align-items:center;gap:10px">' + esc(dec(e.subject) || '(no subject)') + '<span class="sp"></span><button class="bk-btn sm p" data-inbox>' + iconSvg('mail') + 'Take me to the Inbox</button><button class="em-close" data-no aria-label="Close">×</button></div>' +
      '<div class="bk-muted" style="margin-bottom:8px">' + esc(e.from_addr || '') + ' · ' + esc(when(e.received_at)) + (e.read_by ? ' · closed' : ' · open') + '</div>' +
      (e.attachments.length ? '<div class="bl-emails" style="margin:0 0 8px">' + e.attachments.map(a => '<a href="#" class="bl-att" data-i="' + a.i + '" data-kind="' + a.kind + '" title="' + esc(a.name) + '">' + iconSvg('paperclip') + esc(a.name) + '</a>').join('') + '</div>' : '') +
      '<div class="em-modal-body">' + (e.body_html ? '<iframe class="em-html" sandbox="allow-same-origin allow-popups" referrerpolicy="no-referrer" style="width:100%;height:60vh;border:0"></iframe>' : '<div class="em-body">' + esc(e.body || e.snippet || '') + '</div>') + '</div></div>';
    document.body.appendChild(el);
    const fr = el.querySelector('iframe'); if (fr) fr.srcdoc = '<base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;color:#222;margin:12px}img{max-width:100%}</style>' + e.body_html;
    const close = () => el.remove(); el.querySelector('[data-no]').onclick = close; el.onclick = (ev) => { if (ev.target === el) close(); };
    el.querySelector('[data-inbox]').onclick = () => { close(); ibFilter = 'open'; ibOpen = e.id; show('inbox'); };
    el.querySelectorAll('.bl-att').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); const r = await fetch('/api/bookkeeping/emails/' + id + '/att/' + a.dataset.i, { headers: { 'Authorization': 'Bearer ' + token } }); if (!r.ok) return alert('File not available.'); viewFile(URL.createObjectURL(await r.blob()), a.dataset.kind, a.title); });
  }
  // ---------------------------------------------------------------- 1.19.152: Nova AR — the customer-payment queue
  let arSt = 'open';
  let AF = { period: 'all', from: '', to: '', min: '', max: '', mperiod: '30', mfrom: '', mto: '', inv: '', client: '' };   /* 1.20.109: inv / client = the Matched tab's Invoice and Client text filters */   // 1.20.5: mperiod = the Matched tab's "Matched" date filter, last 30 days by default
  try { AF = Object.assign(AF, JSON.parse(localStorage.getItem('bk_ar_filters') || '{}')); } catch (e) {}
  const arPeriod = (pr) => { if (pr === 'custom') return [AF.from, AF.to]; const [f, t] = periodRange(pr); return [f, t]; };
  async function loadAr(sub) {
    arSt = sub === 'done' ? 'done' : 'open';
    const v = $('vArList'); if (!v.innerHTML.trim()) v.innerHTML = '<div class="bk-card bk-muted">Loading the queue…</div>';
    try { if (!ov) await overview(); } catch (e) { ov = { me: '', people: [], counts: {}, settings: {}, chart: [] }; }
    const [from, to] = arPeriod(AF.period);
    const [mfrom, mto] = AF.mperiod === 'custom' ? [AF.mfrom, AF.mto] : periodRange(AF.mperiod);
    const qs = '?status=' + arSt + '&from=' + (from || '') + '&to=' + (to || '') + (arSt === 'done' ? '&mfrom=' + (mfrom || '') + '&mto=' + (mto || '') : '') + (AF.min ? '&min=' + encodeURIComponent(AF.min) : '') + (AF.max ? '&max=' + encodeURIComponent(AF.max) : '') + ($('arQ').value.trim() ? '&q=' + encodeURIComponent($('arQ').value.trim()) : '');
    let j; try { j = await api('/api/bookkeeping/ar' + qs); } catch (e) { j = { ok: false, error: 'The server did not answer (' + (e && e.message || 'network') + '). Try again in a moment.' }; }
    if (!j.ok) { v.innerHTML = '<div class="bk-card"><div style="color:#b91c1c;font-weight:600">Could not load the queue</div><div class="bk-muted" style="margin-top:4px">' + esc(j.error || 'Could not load') + '</div><button class="bk-btn sm" style="margin-top:10px" onclick="location.reload()">Reload</button></div>'; return; }
    $('nArOpen').textContent = j.counts.open || ''; $('nArDone').textContent = j.counts.done || ''; $('nAr').textContent = j.counts.open || '';
    const PER = [['all', 'All time'], ['30', 'Last 30 days'], ['month', 'This month'], ['last', 'Last month'], ['90', 'Last 90 days'], ['year', 'This year']].map(([a, l]) => ({ v: a, l }));
    const FO = { date: { type: 'range', kind: 'date', from: AF.period === 'custom' ? AF.from : '', to: AF.period === 'custom' ? AF.to : '', period: AF.period, defaultPeriod: 'all', presets: PER }, amount: { type: 'range', from: AF.min, to: AF.max }, mdate: { type: 'range', kind: 'date', from: AF.mperiod === 'custom' ? AF.mfrom : '', to: AF.mperiod === 'custom' ? AF.mto : '', period: AF.mperiod, defaultPeriod: '30', presets: PER } };
    FO.inv = { type: 'text', value: AF.inv || '' }; FO.client = { type: 'text', value: AF.client || '' };
    /* 1.20.109: the Matched tab's Invoice and Client columns filter on the page (the rows are the period's snapshot) */
    const clientText = (r) => ((r.invoices || []).map(i => [i.company, i.person, i.customer].filter(Boolean).join(' ')).join(' ') + ' ' + (r.customer_name || '')).toLowerCase();
    if (arSt === 'done') j.rows = j.rows.filter(r => (!AF.inv || (r.invoices || []).some(i => String(i.no || ('INV' + i.id)).toLowerCase().indexOf(AF.inv.toLowerCase()) > -1)) && (!AF.client || clientText(r).indexOf(AF.client.toLowerCase()) > -1));
    const anyF = AF.period !== 'all' || AF.min || AF.max || (arSt === 'done' && (AF.mperiod !== '30' || AF.inv || AF.client));
    const payer = (t) => '<div class="ar-pay"><b>' + esc(descTopAr(t)) + '</b>' + (t.orig_desc && t.orig_desc !== descTopAr(t) ? '<div class="bk-dim">' + esc(t.orig_desc) + '</div>' : '') + '<div class="bk-dim">' + esc(t.institution || 'Bank') + (t.mask ? ' ••' + esc(t.mask) : '') + '</div></div>';
    const descTopAr = (t) => { const m = t.merchant || t.name || ''; if (!/^\s*axiom\s*(print|design)/i.test(m)) return m; const o = String(t.orig_desc || t.name || '').replace(/\s+/g, ' ').trim(); const w = o.split(' ').filter(x => !/\d{3,}/.test(x) && !/axiom/i.test(x)); return w.slice(0, 6).join(' ') || m; };
    // 1.20.1: who / what filed the line as a customer payment
    const filedBy = (t) => { const f = t.filed; if (!f) return ''; return '<div class="ar-filed bk-dim">' + (f.kind === 'person' ? esc(f.label) + ' ' + (f.who ? whoHtml(f.who) + ' <span class="ar-who">' + esc(whoName(f.who)) + '</span>' : '<span class="ar-who">?</span>') : '<span class="ar-rule" title="' + esc(f.detail || '') + '">' + esc(f.label) + '</span>' + (f.detail ? ' <span class="ar-ruled">' + esc(f.detail) + '</span>' : '')) + '</div>'; };
    const whoName = (w) => { const t = String(w || ''); const key = t.toLowerCase().replace(/^(user|member):/, ''); const m = (ov && ov.people || []).find(p => (p.email || '').toLowerCase() === key || (p.username || '').toLowerCase() === key); return m ? (m.name || '').split(' ')[0] || m.name : key.split('@')[0]; };
    const laTime = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(ts) ? '' : 'Z')); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).toLowerCase().replace(' ', ''); };
    const laDay = (ts) => { if (!ts) return ''; const d = new Date(ts); if (isNaN(d)) return ''; const o = {}; new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).forEach(x => { o[x.type] = x.value; }); return o.year + '-' + o.month + '-' + o.day; };
    const doneClient = (r) => { const inv = r.invoices || []; const comp = inv.map(i => i.company || (i.person ? '' : i.customer) || '').filter(Boolean).filter((x, k, arr) => arr.indexOf(x) === k); const pers = inv.map(i => i.person || '').filter(Boolean).filter((x, k, arr) => arr.indexOf(x) === k);
      const l2 = comp.length ? comp.join(', ') : (r.customer_name || ''); const l3 = pers.filter(p => p !== l2).join(', ');
      return (l2 ? '<div class="ar-dco">' + esc(l2) + '</div>' : '') + (l3 ? '<div class="bk-dim ar-dpe">' + esc(l3) + '</div>' : ''); };
    const howTag = (t) => t.how ? '<span class="ar-how">' + esc(t.how) + '</span>' : '';
    const invLine = (i) => '<b>' + esc(i.no || ('INV' + i.id)) + '</b> ' + (i.customer ? esc(i.customer) : '') + (i.status === 'paid' ? ' <span class="bk-tag pair" title="The CRM already shows this invoice as paid">paid in CRM</span>' : '') + '<div class="bk-dim">' + (i.total != null ? usd(i.total) + (i.status === 'partial' ? ' · ' + usd(i.balance) + ' due' : '') : '') + (i.created ? ' · ' + esc(usD(String(i.created).slice(0, 10))) : '') + (i.po ? ' · PO ' + esc(i.po) : '') + '</div>';
    const sugg = (r) => r.suggestions === null ? '<div class="bk-dim ar-wait" style="padding:4px 0">Matching against the CRM…</div>' : (r.suggestions || []).length ? r.suggestions.map((s, i) => '<div class="ar-s' + (i === 0 && s.score >= 70 ? ' top' : '') + (i > 0 ? ' ar-more' : '') + '"><span class="ar-pct" title="How sure Nova is">' + s.score + '%</span><div class="ar-inv">' + s.invoices.map(invLine).join('<div style="height:3px"></div>') + '<div class="ar-why">' + esc(s.why.join(' · ')) + '</div></div><button class="bk-btn sm ' + (s.kind === 'pair' ? 'ar-pair' : 'ar-paybtn') + '" data-match="' + r.id + '" data-kind="' + (s.kind === 'pair' ? 'pair' : 'match') + '" data-inv="' + esc(s.invoices.map(x => x.id).join(',')) + '" data-cust="' + esc(s.customer || '') + '" data-cid="' + (s.customer_id || '') + '" title="' + (s.kind === 'pair' ? 'The CRM already shows this invoice as paid — pair the deposit with it, nothing is sent' : 'Match this deposit to the invoice — you review paid / balance open before anything is sent to the CRM') + '">' + (s.kind === 'pair' ? 'Pair' : 'Match') + '</button></div>').join('') + (r.suggestions.length > 1 ? '<a href="#" class="ar-seemore bk-dim" data-more="' + r.id + '">See ' + (r.suggestions.length - 1) + ' more</a>' : '') : '<div class="bk-dim" style="padding:4px 0">No invoice fits the amount — look one up below.</div>';
    const row = (r) => { const t = r.txn || {}; return '<tr data-ar="' + r.id + '"><td><div title="When the line reached Nova from the bank">' + esc(usD(String(t.synced_at || t.created_at || '').slice(0, 10))) + '</div><div class="bk-dim">' + esc(laTime(t.synced_at || t.created_at)) + '</div>' + filedBy(t) + '</td>' +
      '<td class="ar-amt">' + usd(r.amount) + '</td><td>' + payer(t) + '</td>' +
      '<td class="ar-paid"><div title="The bank\'s transaction date">' + esc(usD(t.tx_date || t.date || '')) + '</div>' + howTag(t) + '</td>' +
      (arSt === 'open'
        ? '<td class="ar-sgcell" data-arrow="' + r.id + '">' + sgCell(r) + '</td>'
        : '<td class="ar-done">' + (r.status === 'skipped' ? '<span class="bk-tag">skipped</span>' : (r.kind === 'pair' ? '<span class="bk-tag pair">paired</span> ' : r.kind === 'manual' ? '<span class="bk-tag" title="Typed in by hand — the CRM was not told">manual</span> ' : '<span class="bk-tag ok">matched</span> ') + (r.invoices || []).map(i => '<b>' + esc(i.no || ('INV' + i.id)) + '</b>').join(', ')) +
          (r.kind === 'match' && r.pay_status ? '<div class="bk-dim ar-paystat" title="' + esc(r.pay_status) + '">' + (r.pay_status === 'sent' ? '✓ CRM paid' + (r.pay_ref ? ' (payment ' + esc(r.pay_ref) + ')' : '') + (r.pay_method ? ' · ' + esc(r.pay_method) : '') + (r.send_receipt ? ' · receipt emailed' : '') : r.pay_status === 'not configured' ? 'CRM not told yet' : '<span class="ar-payerr">CRM: ' + esc(r.pay_status.replace(/^failed: /, '').slice(0, 90)) + '</span>') + (r.pay_status !== 'sent' ? ' <a href="#" data-resend="' + r.id + '">Send again</a>' : '') + '</div>' : '') + (r.note ? '<div class="bk-dim">' + esc(r.note) + '</div>' : '') + '</td>' +
          /* 1.20.109: the client in its own column — line 1 the company, line 2 the contact person (the snapshot kept at match time) */
          '<td class="ar-dcl">' + (r.status !== 'skipped' ? (doneClient(r) || '<span class="bk-dim">—</span>') : '<span class="bk-dim">—</span>') + '</td><td class="ar-when"><div title="When the match was made">' + esc(usD(laDay(r.matched_at))) + '</div><div class="bk-dim">' + esc(laTime(r.matched_at)) + '</div><div class="bk-dim">' + whoHtml(r.matched_by) + ' <span class="ar-who">' + esc(whoName(r.matched_by)) + '</span> · <a href="#" data-undo="' + r.id + '">Undo</a></div></td>') + '</tr>'; };
    // 1.20.83: the review card — a matched deposit before Match & Pay: what each invoice gets, paid / balance open, then confirm
    const reviewCell = (r) => { const invs = r.invoices || [], t = r.txn || {}; let left = Math.round(Number(r.amount) * 100) / 100;
      const lines = invs.slice().sort((a, b) => String(a.created || '').localeCompare(String(b.created || ''))).map(i => { const due = i.status === 'paid' ? 0 : Math.round((Number(i.balance != null ? i.balance : i.total) || 0) * 100) / 100; const pay = Math.min(left, due); left = Math.round((left - pay) * 100) / 100; const open = Math.round((due - pay) * 100) / 100;
        return '<div class="ar-rv-inv"><b>' + esc(i.no || 'INV' + i.id) + '</b> ' + esc(i.customer || '') + '<div class="bk-dim">' + (i.total != null ? 'invoice ' + usd(i.total) : '') + (i.status === 'partial' ? ' · ' + usd(i.balance) + ' was due' : '') + (i.created ? ' · ' + esc(usD(String(i.created).slice(0, 10))) : '') + '</div>' +
          '<div class="ar-rv-line">' + (i.total == null ? '<span class="bk-dim">invoice details could not be read from the CRM</span>' : i.status === 'paid' ? '<span class="bk-tag pair">already paid in the CRM</span>' : open <= 0.005 ? '<span class="ar-rv-ok">Pays in full — ' + usd(pay) + '</span>' : '<span class="ar-rv-part">Paid ' + usd(pay) + ' · <b>Balance open ' + usd(open) + '</b></span>') + '</div></div>'; }).join('');
      return '<div class="ar-review"><div class="ar-rv-h"><span class="bk-tag ok">matched</span> review before paying' + (r.matched_by ? ' <span class="bk-dim">· by ' + esc(whoName(r.matched_by)) + '</span>' : '') + '</div>' + lines +
        (left > 0.005 && invs.every(i => i.total != null) ? '<div class="ar-rv-over">' + usd(left) + ' of this deposit is not covered by the invoice' + (invs.length > 1 ? 's' : '') + '</div>' : '') +
        /* 1.20.93: what the CRM will record — the payment method (its own strings; a pick when the bank wording gave none it knows) and the receipt choice */
        '<div class="ar-rv-pay"><label>Pay as <select class="bk sm" data-paym="' + r.id + '">' + (t.crm_method ? '' : '<option value="">pick a method…</option>') + (j.methods || ['ACH', 'Check', 'Mobile deposit (check)', 'Credit card', 'Zelle', 'Venmo']).map(m => '<option value="' + esc(m) + '"' + (t.crm_method && (t.crm_method === m || (m === 'Check' && /^Check/.test(t.crm_method))) ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select></label>' + (t.how && !t.crm_method ? '<span class="bk-dim" title="The bank line read as this; the CRM only takes the methods in the list">bank line says ' + esc(t.how) + '</span>' : '') +
        '<label class="ar-rv-rc"><input type="checkbox" data-payrc="' + r.id + '"> Email the customer a receipt</label></div>' +
        (j.can_pay === false ? '<div class="ar-rv-over">Match &amp; Pay needs your Axiom CRM account — the CRM records the payment under the person who clicks. Sign in to Nova with your Axiom username and password.</div>' : '') +
        '<div class="ar-rv-acts"><button class="bk-btn sm ar-paybtn" data-payok="' + r.id + '" title="Final: record the payment in the CRM on these invoices"' + (j.can_pay === false ? ' disabled' : '') + '>Match &amp; Pay' + (invs.length > 1 ? ' (' + invs.length + ')' : '') + '</button><a href="#" class="bk-dim" data-undo="' + r.id + '">Undo</a></div></div>'; };
    const ruleTag = (r) => r.rule ? '<div class="ar-ruletag" title="A payer rule from a past match: this bank wording (' + esc(r.rule.pattern || '') + ') is ' + esc(r.rule.customer || '') + ' — Nova looked only at their invoices">Known payer: <b>' + esc(r.rule.customer || '') + '</b></div>' : '';
    const sgCell = (r) => r.status === 'review' ? reviewCell(r) : '<div class="ar-sg">' + ruleTag(r) + sugg(r) + '<div class="ar-acts"><span class="ar-other"><input class="bk sm" placeholder="Other INV number(s) or customer…" title="One invoice, or several numbers for a bulk payment: 125839, 125840" data-arq="' + r.id + '"></span><span class="sp"></span><a href="#" class="bk-dim" data-skip="' + r.id + '" title="Not a customer payment / handled elsewhere — keep it in the history">Skip</a></div><div class="ar-basket" data-basket="' + r.id + '"></div></div>';
    v.innerHTML = '<div class="bk-card">' +
      '<div class="ar-tiles"><div class="ar-tile"><b>' + usd(j.counts.open_total) + '</b><span class="bk-muted">' + j.counts.open + ' payment' + (j.counts.open === 1 ? '' : 's') + ' to match</span></div><div class="ar-tile"><b id="arInvN">' + (j.invoices_open || '…') + '</b><span class="bk-muted">open invoices in the CRM' + (j.invoices_at ? ' · read ' + esc(when(new Date(j.invoices_at).toISOString())) : '') + ' <a href="#" id="arFresh">refresh</a></span></div>' + (j.crm_error ? '<div class="ar-tile" style="border-color:#fca5a5"><b style="font-size:13px;color:#b91c1c">CRM not reachable</b><span class="bk-muted">' + esc(j.crm_error) + '</span></div>' : '') + '</div>' +
      '<h2>' + (arSt === 'open' ? 'Unmatched customer payments' : 'Matched — history') + (j.from ? ' <span class="bk-dim" style="font-weight:400;font-size:12px" title="Older deposits were handled by email before Nova AR">from ' + esc(usD(j.from)) + '</span>' : '') + ' ' + qHelp('ar', 'Nova AR', 'Every bank deposit filed as a customer payment waits here. Nova reads the open invoices from the CRM and suggests the one(s) the money pays — by amount to the cent, by the payer\'s name on the bank line, by an invoice number typed in the memo, or by a few invoices of one customer adding up. Click Matched on the right one, or look another up; Skip keeps a line that is not a customer payment in the history. Nothing is changed in the CRM from here.') + '<span class="sp"></span>' + (anyF ? '<button class="bk-btn sm" id="afClear">× Clear filters</button>' : '') + '<span class="bk-muted">' + j.rows.length + ' shown</span></h2>' +
      (j.rows.length ? '<table class="bk ar-table' + (arSt === 'done' ? ' done' : '') + '"><thead><tr><th>' + thFilter('date', 'Synced', FO.date) + '</th><th>' + thFilter('amount', 'Amount', FO.amount) + '</th><th>Payer (bank line)</th><th>Paid on</th>' + (arSt === 'open' ? '<th>Nova suggests</th>' : '<th>' + thFilter('inv', 'Invoice', FO.inv) + '</th><th>' + thFilter('client', 'Client', FO.client) + '</th>') + (arSt === 'done' ? '<th>' + thFilter('mdate', 'Matched', FO.mdate) + '</th>' : '') + '</tr></thead><tbody>' + j.rows.map(row).join('') + '</tbody></table>'
        : '<div class="bk-muted" style="padding:16px 0">' + (arSt === 'open' ? 'Nothing waiting — every customer payment is matched.' : AF.mperiod === '30' ? 'Nothing matched in the last 30 days — widen the Matched filter for older history.' : 'Nothing matched in that period.') + '</div>') + '</div>';
    const save = () => { try { localStorage.setItem('bk_ar_filters', JSON.stringify(AF)); } catch (e) {} loadAr(arSt); };
    thFilterBind(v, FO, (key, val) => { if (key === 'date') { AF.period = val.period || 'all'; AF.from = val.from || ''; AF.to = val.to || ''; if (!AF.from && !AF.to && AF.period === 'custom') AF.period = 'all'; } else if (key === 'amount') { AF.min = val.from || ''; AF.max = val.to || ''; } else if (key === 'mdate') { AF.mperiod = val.period || '30'; AF.mfrom = val.from || ''; AF.mto = val.to || ''; if (!AF.mfrom && !AF.mto && AF.mperiod === 'custom') AF.mperiod = '30'; } else if (key === 'inv' || key === 'client') { AF[key] = typeof val === 'string' ? val : ''; } save(); });
    const cl = $('afClear'); if (cl) cl.onclick = () => { AF = { period: 'all', from: '', to: '', min: '', max: '', mperiod: '30', mfrom: '', mto: '', inv: '', client: '' }; save(); };
    const fr = $('arFresh'); if (fr) fr.onclick = async (e) => { e.preventDefault(); await api('/api/bookkeeping/ar?status=open&fresh=1'); loadAr(arSt); };
    // 1.20.11: a matched row does not vanish — it turns green with a "✓ Matched to INV…" line, fades, and the rows below
    // slide up into its place (FLIP), so the eye follows what moved; the tiles and badge are updated in place, no reload
    const leaveRow = (tr, label) => new Promise(done => {
      tr.classList.add('ar-leaving'); const first = tr.querySelector('td'); if (first && label) first.insertAdjacentHTML('afterbegin', '<div class="ar-donemark">' + label + '</div>');
      setTimeout(() => { tr.classList.add('ar-fade'); }, 1100);
      setTimeout(() => {
        const after = []; let n = tr.nextElementSibling; while (n) { after.push([n, n.getBoundingClientRect().top]); n = n.nextElementSibling; }
        tr.remove();
        after.forEach(([el, top]) => { const d = top - el.getBoundingClientRect().top; if (!d) return; el.style.transition = 'none'; el.style.transform = 'translateY(' + d + 'px)'; });
        requestAnimationFrame(() => requestAnimationFrame(() => { after.forEach(([el]) => { el.style.transition = 'transform .45s ease'; el.style.transform = ''; }); setTimeout(() => after.forEach(([el]) => { el.style.transition = ''; }), 500); }));
        done();
      }, 1650);
    });
    const dropRow = async (id, label) => { const tr = v.querySelector('tr[data-ar="' + id + '"]'); const row = j.rows.find(x => String(x.id) === String(id));
      if (tr) await leaveRow(tr, label);
      if (row && arSt === 'open') { j.counts.open = Math.max(0, (j.counts.open || 1) - 1); j.counts.open_total = Math.round(((j.counts.open_total || 0) - Number(row.amount)) * 100) / 100; j.counts.done = (j.counts.done || 0) + 1;
        $('nArOpen').textContent = j.counts.open || ''; $('nArDone').textContent = j.counts.done || ''; $('nAr').textContent = j.counts.open || '';
        const tile = v.querySelector('.ar-tile b'); if (tile) tile.textContent = usd(j.counts.open_total); const tl = v.querySelector('.ar-tile .bk-muted'); if (tl) tl.textContent = j.counts.open + ' payment' + (j.counts.open === 1 ? '' : 's') + ' to match'; const sh = v.querySelector('h2 .bk-muted'); if (sh) sh.textContent = (v.querySelectorAll('.ar-table tbody tr').length) + ' shown';
        if (!v.querySelector('.ar-table tbody tr')) loadAr(arSt); }
      overview(); };
    const doMatch = async (id, ids, cust, cid, kind) => { const r = await post('/api/bookkeeping/ar/' + id + '/match', { invoice_ids: ids, customer: cust, customer_id: cid, kind: kind || 'match' }); if (!r.ok) { alert(r.error || 'Could not save.'); return; }
      if (r.status === 'review') {   // 1.20.83: the row stays — it now shows the review card (paid / balance open) with Match & Pay
        const row = j.rows.find(x => String(x.id) === String(id)); if (row) { row.status = 'review'; row.invoices = r.invoices || []; row.matched_by = ov && ov.me; }
        const td = v.querySelector('td[data-arrow="' + id + '"]'); if (td && row) { td.innerHTML = sgCell(row); bind(td); }
        toast('Matched to INV' + ids.join(', INV') + ' — review, then Match & Pay' + (r.learned ? ' · payer rule saved: "' + r.learned + '"' : '')); return; }
      const what = (kind === 'pair' ? 'Paired with INV' : kind === 'manual' ? 'Recorded by hand: INV' : 'Matched to INV') + ids.join(', INV');
      toast(what + (r.learned ? ' · payer rule saved' : '')); dropRow(id, '✓ ' + esc(what)); };
    const doPay = async (id) => {
      const ms = v.querySelector('[data-paym="' + id + '"]'), rc = v.querySelector('[data-payrc="' + id + '"]'); const method = ms ? ms.value : '';
      if (!method) { alert('Pick the payment method the CRM should record (ACH, Check, Credit card, Zelle or Venmo).'); if (ms) ms.focus(); return; }
      const r = await post('/api/bookkeeping/ar/' + id + '/pay-confirm', { method, send_receipt: !!(rc && rc.checked) }); if (!r.ok) { alert(r.error || 'Could not save.'); return; }
      const row = j.rows.find(x => String(x.id) === String(id)); const ids = row && row.invoices ? row.invoices.map(i => i.no || 'INV' + i.id) : [];
      const what = 'Matched & paid: ' + ids.join(', '); toast(what + (r.pay ? (r.pay.sent ? ' · CRM told' : ' · ' + (r.pay.error || 'CRM not told')) : '')); dropRow(id, '✓ ' + esc(what)); };
    // 1.20.10: the bulk-payment basket — several invoices paid with one deposit, typed in by hand. "Save match" records them
    // (kind manual) and tells the CRM nothing; the Matched tab shows "manual".
    const baskets = {};
    const basketAdd = (arId, i) => { if (!i) return; const b = baskets[arId] = baskets[arId] || []; if (!b.some(x => x.id === i.id)) b.push(i); basketDraw(arId); };
    const basketDraw = (arId) => { const el = v.querySelector('[data-basket="' + arId + '"]'); if (!el) return; const b = baskets[arId] || []; const row = j.rows.find(x => String(x.id) === String(arId)); const amt = row ? Number(row.amount) : 0;
      if (!b.length) { el.innerHTML = ''; return; }
      const tot = b.reduce((s, i) => s + (Number(i.status === 'partial' ? i.balance : i.total) || 0), 0), diff = Math.round((amt - tot) * 100) / 100;
      el.innerHTML = '<div class="ar-bk-l">Bulk payment — ' + b.length + ' invoice' + (b.length === 1 ? '' : 's') + '</div>' + b.map(i => '<span class="ar-chip"><b>' + esc(i.no || 'INV' + i.id) + '</b> ' + esc(i.customer || '') + ' · ' + usd(i.status === 'partial' ? i.balance : i.total) + (i.status === 'paid' ? ' <i>paid in CRM</i>' : '') + ' <a href="#" data-bdel="' + i.id + '" title="Remove">×</a></span>').join('') +
        '<div class="ar-bk-sum' + (Math.abs(diff) < 0.005 ? ' ok' : '') + '">' + usd(tot) + ' of ' + usd(amt) + (Math.abs(diff) < 0.005 ? ' · adds up' : diff > 0 ? ' · ' + usd(diff) + ' left over' : ' · ' + usd(-diff) + ' over the payment') + '</div>' +
        '<button class="bk-btn sm ar-manual" data-bsave="' + arId + '" title="Record these invoices against the payment. Nothing is sent to the CRM.">Save match (' + b.length + ') — no CRM payment</button> <a href="#" class="bk-dim" data-bclear="' + arId + '">clear</a>';
      el.querySelectorAll('[data-bdel]').forEach(a => a.onclick = (e) => { e.preventDefault(); baskets[arId] = b.filter(i => String(i.id) !== a.dataset.bdel); basketDraw(arId); });
      const cl = el.querySelector('[data-bclear]'); if (cl) cl.onclick = (e) => { e.preventDefault(); baskets[arId] = []; basketDraw(arId); };
      const sv = el.querySelector('[data-bsave]'); if (sv) sv.onclick = () => { const first = b[0]; doMatch(arId, b.map(i => i.id), first.customer || '', first.customer_id || '', 'manual'); }; };
    const bind = (scope) => {
    scope.querySelectorAll('[data-more]').forEach(a => a.onclick = (e) => { e.preventDefault(); const cell = a.closest('.ar-sg'); const open = cell.classList.toggle('open'); a.textContent = open ? 'See less' : 'See ' + cell.querySelectorAll('.ar-more').length + ' more'; });
    scope.querySelectorAll('[data-match]').forEach(b => b.onclick = () => doMatch(b.dataset.match, b.dataset.inv.split(',').map(Number), b.dataset.cust, b.dataset.cid, b.dataset.kind));
    scope.querySelectorAll('[data-payok]').forEach(b => b.onclick = () => doPay(b.dataset.payok));
    /* 1.20.93: Send again — after a CRM refusal; asks for the method when the CRM did not know ours */
    scope.querySelectorAll('[data-resend]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const id = a.dataset.resend; const row = j.rows.find(x => String(x.id) === String(id)) || {}; let method = row.pay_method || (row.txn && row.txn.crm_method) || '';
      if (!method || /pick a payment method|Unsupported payment method/i.test(row.pay_status || '')) { method = prompt('Payment method for the CRM — one of: ACH, Check, Mobile deposit (check), Credit card, Zelle, Venmo', method || 'ACH') || ''; if (!method) return; }
      const r = await post('/api/bookkeeping/ar/' + id + '/pay', { method }); toast(r.ok ? (r.pay && r.pay.sent ? 'CRM told' + (r.pay.ref ? ' (' + r.pay.ref + ')' : '') : (r.pay && r.pay.error) || 'CRM not told') : (r.error || 'Could not send')); loadAr(arSt); });
    scope.querySelectorAll('.ar-review [data-undo]').forEach(a => a.onclick = async (e) => { e.preventDefault(); await post('/api/bookkeeping/ar/' + a.dataset.undo + '/undo', {}); const row = j.rows.find(x => String(x.id) === String(a.dataset.undo)); if (row) { row.status = 'open'; row.suggestions = null; } loadAr(arSt); });
    scope.querySelectorAll('[data-skip]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const note = await askText('Why is this not a customer payment to match? (optional)', { title: 'Skip this payment', ok: 'Skip', optional: true }); if (note === null) return; const r = await post('/api/bookkeeping/ar/' + a.dataset.skip + '/skip', { note }); if (!r.ok) { alert(r.error); return; } dropRow(a.dataset.skip, 'Skipped'); });
    v.querySelectorAll('[data-undo]').forEach(a => a.onclick = async (e) => { e.preventDefault(); await post('/api/bookkeeping/ar/' + a.dataset.undo + '/undo', {}); loadAr(arSt); overview(); });
    // "Other invoice…": type a number, a customer or a PO → a list of open invoices → click = Matched
    v.querySelectorAll('[data-arq]').forEach(inp => { let t = null, pick = null;
      const closePick = () => { if (pick) { pick.remove(); pick = null; } };
      const run = async () => { const q = inp.value.trim(); closePick(); if (q.length < 2) return; const r = await api('/api/bookkeeping/ar/invoices?q=' + encodeURIComponent(q)); if (!r.ok || inp.value.trim() !== q) return;
        pick = document.createElement('div'); pick.className = 'ar-pick'; const b = inp.getBoundingClientRect(); pick.style.left = Math.min(b.left, window.innerWidth - 436) + 'px'; pick.style.top = (b.bottom + 4 + window.scrollY) + 'px';
        if (r.many) { (r.invoices || []).forEach(i => basketAdd(inp.dataset.arq, i)); inp.value = ''; if (r.note) toast(r.note); return; }   // 1.20.10: several numbers typed → straight into the basket
        pick.innerHTML = (r.note ? '<div class="bk-dim" style="padding:8px 10px;border-bottom:1px solid var(--line);font-size:11.5px">' + esc(r.note) + '</div>' : '') + ((r.invoices || []).length ? r.invoices.map(i => '<div class="ar-s" data-pid="' + i.id + '" data-pkind="' + (i.status === 'paid' ? 'pair' : 'match') + '" data-pc="' + esc(i.customer || '') + '" data-pcid="' + (i.customer_id || '') + '"><div class="ar-inv">' + invLine(i) + '</div><a href="#" class="ar-addb" data-padd="' + i.id + '" title="Add to a bulk match — several invoices paid with one payment">+ Add</a><span class="bk-btn sm ' + (i.status === 'paid' ? 'ar-pair' : 'ar-paybtn') + '">' + (i.status === 'paid' ? 'Pair' : 'Match') + '</span></div>').join('') : '<div class="bk-dim" style="padding:10px">No open invoice matches "' + esc(q) + '".</div>');
        document.body.appendChild(pick);
        const byId = {}; (r.invoices || []).forEach(i => { byId[i.id] = i; });
        pick.querySelectorAll('[data-padd]').forEach(a => a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); basketAdd(inp.dataset.arq, byId[a.dataset.padd]); closePick(); inp.value = ''; inp.focus(); });
        pick.querySelectorAll('[data-pid]').forEach(d => d.onclick = () => { closePick(); doMatch(inp.dataset.arq, [Number(d.dataset.pid)], d.dataset.pc, d.dataset.pcid, d.dataset.pkind); });
        setTimeout(() => document.addEventListener('mousedown', function away(ev) { if (pick && !pick.contains(ev.target) && ev.target !== inp) { closePick(); document.removeEventListener('mousedown', away); } }), 0); };
      inp.oninput = () => { clearTimeout(t); t = setTimeout(run, 350); }; inp.onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(t); run(); } if (e.key === 'Escape') closePick(); }; });
    };
    bind(v);
    // 1.19.159: the queue is on screen; now the suggestions, row by row (three at a time), so a slow CRM never blanks the page
    if (arSt === 'open') {
      const todo = j.rows.filter(r => r.suggestions === null && r.status !== 'review'); let crmShown = false;
      const one = async () => { const r = todo.shift(); if (!r) return; const td = v.querySelector('td[data-arrow="' + r.id + '"]'); if (!td) return one();
        const sj = await api('/api/bookkeeping/ar/' + r.id + '/suggest').catch(() => ({ ok: false, error: 'request failed' }));
        if (!td.isConnected) return;   // the list was re-drawn meanwhile
        if (sj.ok) { r.suggestions = sj.suggestions || []; r.rule = sj.rule || null; if (sj.invoices_open != null && !crmShown) { crmShown = true; const tile = v.querySelector('#arInvN'); if (tile) tile.textContent = sj.invoices_open; } }
        else { r.suggestions = []; const w = td.querySelector('.ar-wait'); if (w) { w.textContent = sj.error || 'Could not match'; w.style.color = '#b91c1c'; } if (sj.crm_error) todo.length = 0; }
        if (sj.ok) { td.innerHTML = sgCell(r); bind(td); basketDraw(r.id); }
        return one(); };
      one(); one(); one();
    }
  }
  // ---- 1.20.83: AR Rules — payer words on the bank line → the customer; learned from every match, editable here
  /* 1.20.119: the Customer cell — the accounts are "Company (Person)"; one company name in bold, the people as small chips
     (several accounts of one company read "Peace & Haight · Aiyana Ramirez · Eric Klein …"), the full list on hover. */
  function ruleCustomer(r) {
    const names = String(r.customer_name || '').split(' \u00b7 ').map(x => x.trim()).filter(Boolean);
    if (!names.length) return '<b>Customer #' + esc(r.customer_id) + '</b>';
    const split = (n) => { const m = n.match(/^(.*?)\s*\(([^()]*)\)\s*$/); return m ? { co: m[1].trim(), who: m[2].trim() } : { co: n, who: '' }; };
    const parts = names.map(split);
    const brand = (co) => co.replace(/\s*\([^()]*\)\s*/g, ' ').trim();     /* "PAX (Peace & Haight)" → "PAX" */
    const cos = [...new Set(parts.map(p => brand(p.co)).filter(Boolean))];
    const main = cos.length === 1 ? cos[0] : (cos.find(c => parts.filter(p => brand(p.co) === c).length > 1) || cos[0]);
    const people = parts.map(p => p.who || (brand(p.co) !== main ? brand(p.co) : '')).filter(Boolean);
    return '<div class="ar-rcust" title="' + esc(names.join('\n')) + '"><b>' + esc(main) + '</b>' +
      (names.length > 1 ? ' <span class="bk-tag">' + names.length + ' accounts</span>' : '') +
      (people.length ? '<div class="ar-rpeople">' + people.map(x => '<span>' + esc(x) + '</span>').join('') + '</div>' : '') + '</div>';
  }
  async function loadArRules() {
    arSt = 'rules';
    const v = $('vArList'); v.innerHTML = '<div class="bk-card bk-muted">Loading…</div>';
    try { if (!ov) await overview(); } catch (e) { ov = { me: '', people: [], counts: {}, settings: {}, chart: [] }; }
    const j = await api('/api/bookkeeping/ar/rules'); if (!j.ok) { v.innerHTML = '<div class="bk-card">' + esc(j.error || 'Could not load') + '</div>'; return; }
    $('nArRules').textContent = j.rules.length || '';
    const q = $('arQ').value.trim().toLowerCase();
    const rules = j.rules.filter(r => !q || (r.pattern + ' ' + (r.customer_name || '')).toLowerCase().indexOf(q) > -1);
    v.innerHTML = '<div class="bk-card"><h2>Payer rules ' + qHelp('arrules', 'AR rules', 'A rule says: when the bank line carries these words, the payer is this customer — Nova then looks only at that customer\'s invoices (plus any invoice number in the memo) and lifts them in the suggestions.<br><br>Rules are <b>learned from every Match, Pair and hand entry</b> the AR team makes (the payer words of that deposit → the customer chosen), and you can add or remove them here. A rule <b>never pairs by itself</b> — it only makes the suggestion better; a person still clicks Match, reviews, and Match &amp; Pay.') + ' <span class="bk-muted">' + rules.length + '</span></h2>' +
      '<div class="ar-rform"><input class="bk" id="arRPat" placeholder="Payer words on the bank line, e.g. peace haight"><input class="bk" id="arRCust" placeholder="Customer(s) in the CRM… (type to search, tick several)" autocomplete="off"><button class="bk-btn p" id="arRAdd">Add rule</button><span class="bk-dim" id="arRMsg"></span><div class="ar-rchips" id="arRChips"></div></div>' +
      (rules.length ? '<table class="bk ar-rules"><thead><tr><th>Bank line says</th><th>Customer</th><th>How</th><th>Used</th><th>Made by</th><th></th></tr></thead><tbody>' +
        rules.map(r => '<tr><td class="pat">' + esc(r.pattern) + '</td><td>' + ruleCustomer(r) + '</td><td class="how">' + (r.source === 'manual' ? '<span class="bk-tag">Typed in</span>' : '<span class="bk-tag ok">Learned</span>') + '</td><td>' + (r.hits ? r.hits + '× · last ' + esc(usD(String(r.last_hit_at || '').slice(0, 10))) : '<span class="bk-dim">not yet</span>') + '</td><td>' + (r.made_by ? whoHtml(r.made_by) + ' ' + esc(r.made_by.split('@')[0]) : '') + ' <span class="bk-dim">' + esc(usD(String(r.updated_at || r.created_at || '').slice(0, 10))) + '</span></td><td class="ar-racts"><button class="bk-btn sm" data-redit="' + r.id + '">Edit</button><button class="ar-rdel" data-rdel="' + r.id + '" title="Remove this rule" aria-label="Remove">×</button></td></tr>').join('') + '</tbody></table>'
        : '<div class="bk-muted" style="padding:14px 0">No rules yet — every Match or Pair you make adds one.</div>') + '</div>';
    v.querySelectorAll('[data-rdel]').forEach(a => a.onclick = async (e) => { e.preventDefault(); if (!await ask('Remove this payer rule?', { ok: 'Remove' })) return; await post('/api/bookkeeping/ar/rules/' + a.dataset.rdel + '/delete', {}); loadArRules(); });
    let editing = 0;
    // the customer picker — 1.20.84: several accounts can be ticked (one payer, many CRM contacts); picked ones show as chips
    const inp = $('arRCust'); let t = null, pick = null; const picked = []; const closePick = () => { if (pick) { pick.remove(); pick = null; } };
    const drawChips = () => { $('arRChips').innerHTML = picked.map(c => '<span class="ar-chip"><b>' + esc(c.name) + '</b>' + (c.person && c.person !== c.name ? ' ' + esc(c.person) : '') + ' <i>#' + c.id + '</i><a href="#" data-cdel="' + c.id + '" title="Remove">×</a></span>').join('');
      $('arRChips').querySelectorAll('[data-cdel]').forEach(a => a.onclick = (e) => { e.preventDefault(); const i = picked.findIndex(c => String(c.id) === a.dataset.cdel); if (i > -1) picked.splice(i, 1); drawChips(); }); };
    inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => { const qq = inp.value.trim(); closePick(); if (qq.length < 2) return; const r = await api('/api/bookkeeping/ar/customers?q=' + encodeURIComponent(qq)); if (!r.ok || inp.value.trim() !== qq) return;
      pick = document.createElement('div'); pick.className = 'ar-cpick'; const byId = {}; (r.customers || []).forEach(c => { byId[c.id] = c; });
      const draw = () => { pick.innerHTML = (r.customers || []).length ? r.customers.map(c => '<label data-cid="' + c.id + '"><input type="checkbox"' + (picked.some(p => p.id === c.id) ? ' checked' : '') + '><b>' + esc(c.name) + '</b>' + (c.person && c.person !== c.name ? '<small>' + esc(c.person) + '</small>' : '') + '<small>#' + c.id + '</small></label>').join('') + '<div class="ar-cpick-foot"><a href="#" data-call>Tick all ' + r.customers.length + '</a><button class="bk-btn sm" data-cdone>Done</button></div>' : '<div class="bk-dim" style="padding:8px 10px">No customer matches.</div>';
        pick.querySelectorAll('label[data-cid] input').forEach(cb => cb.onchange = () => { const c = byId[cb.closest('label').dataset.cid]; const i = picked.findIndex(p => p.id === c.id); if (cb.checked && i < 0) picked.push(c); if (!cb.checked && i > -1) picked.splice(i, 1); drawChips(); });
        const all = pick.querySelector('[data-call]'); if (all) all.onclick = (e) => { e.preventDefault(); (r.customers || []).forEach(c => { if (!picked.some(p => p.id === c.id)) picked.push(c); }); drawChips(); draw(); };
        const done = pick.querySelector('[data-cdone]'); if (done) done.onclick = () => { closePick(); inp.value = ''; inp.focus(); }; };
      draw(); inp.parentElement.appendChild(pick);
      setTimeout(() => document.addEventListener('mousedown', function away(ev) { if (pick && !pick.contains(ev.target) && ev.target !== inp) { closePick(); document.removeEventListener('mousedown', away); } }), 0); }, 300); };
    $('arRAdd').onclick = async () => { const r = await post('/api/bookkeeping/ar/rules', { id: editing || undefined, pattern: $('arRPat').value, customer_ids: picked.map(c => c.id), customer_names: picked.map(c => c.name + (c.person && c.person !== c.name ? ' (' + c.person + ')' : '')) }); $('arRMsg').textContent = r.ok ? 'Saved as "' + r.pattern + '"' : (r.error || 'Could not save'); if (r.ok) setTimeout(loadArRules, 600); };
    // 1.20.85: Edit loads the rule into the form — its words and its accounts as chips — and Save rewrites that rule
    v.querySelectorAll('[data-redit]').forEach(b => b.onclick = () => { const r = rules.find(x => String(x.id) === b.dataset.redit); if (!r) return; editing = r.id;
      $('arRPat').value = r.pattern; picked.length = 0; const names = String(r.customer_name || '').split(' · ');
      (r.ids || []).forEach((id, i) => { const nm = names[i] || ('Customer #' + id); const m = /^(.*)\s*\(([^()]*)\)$/.exec(nm);     /* the LAST (…) is the person: "PAX (Peace & Haight) (Aiyana Ramirez)" */ picked.push({ id, name: m ? m[1] : nm, person: m ? m[2] : '' }); });
      drawChips(); $('arRAdd').textContent = 'Save rule'; $('arRMsg').innerHTML = 'Editing · <a href="#" id="arRCancel">cancel</a>'; $('arRCancel').onclick = (e) => { e.preventDefault(); loadArRules(); };
      $('arRPat').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }
  // ---- 1.20.83: Acct Aging — the open invoices in the CRM by age (0–30 / 31–60 / 61–90 / 90+), per customer, expandable
  let agingData = null, agingOpen = {};
  /* 1.20.94: Acct Aging header filters (the Bank feed's thFilter) — Customer text, AM list with heads, Due range, Days list; the sub-bar search stays */
  const AGF = { customer: '', am: '', due: { from: '', to: '', period: '' }, days: '' };
  const agFace = (g) => { const ini = esc(String(g.am || '?').charAt(0)); return (g.am_photo ? '<img class="ag-face sm" src="' + esc(g.am_photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;ag-face ag-ini sm&quot;>' + ini + '</span>\'">' : '<span class="ag-face ag-ini sm">' + ini + '</span>') + ' ' + esc(g.am); };
  async function loadAging(bucket) {
    const v = $('vAgingList'); if (!agingData) v.innerHTML = '<div class="bk-card bk-muted">Reading the open invoices from the CRM…</div>';
    try { if (!ov) await overview(); } catch (e) { ov = { me: '', people: [], counts: {}, settings: {}, chart: [] }; }
    if (!agingData) { const j = await api('/api/bookkeeping/ar/aging'); if (!j.ok) { v.innerHTML = '<div class="bk-card"><div style="color:#b91c1c;font-weight:600">Could not read the invoices</div><div class="bk-muted">' + esc(j.error || '') + '</div><button class="bk-btn sm" style="margin-top:10px" onclick="location.reload()">Reload</button></div>'; return; } agingData = j; }
    const j = agingData; const B = ['0-30', '31-60', '61-90', '90+'], BL = { '0-30': '0–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': 'Over 90 days' }, BC = { '0-30': '#a7f3d0', '31-60': '#fde68a', '61-90': '#fdba74', '90+': '#fca5a5' }, BK = { '0-30': 'b0', '31-60': 'b1', '61-90': 'b2', '90+': 'b3' };
    const q = $('agQ').value.trim().toLowerCase();
    /* 1.20.88: the AM filter (the select keeps its pick across re-draws; options from the rows) */
    const amRows = {}; j.rows.forEach(g => { if (g.am && !amRows[g.am]) amRows[g.am] = g; });
    const AGS = {
      customer: { type: 'text', value: AGF.customer },
      am: [{ v: '', l: 'Any account manager' }].concat(Object.keys(amRows).sort().map(a => ({ v: a, l: agFace(amRows[a]), t: a }))),
      due: { type: 'range', kind: 'number', from: AGF.due.from, to: AGF.due.to, period: '' },
      days: [{ v: '', l: 'Any age' }, { v: '90', l: 'Oldest over 90 days' }, { v: '180', l: 'Oldest over 180 days' }, { v: '365', l: 'Oldest over a year' }]
    };
    const amNow = AGF.am;
    /* 1.20.88: a bucket view shows that bucket's invoices only — the customer's total, count and days are of those invoices */
    const inB = (g) => bucket === 'all' ? g.invoices : g.invoices.filter(i => i.bucket === bucket);
    const cq = AGF.customer.toLowerCase(), dmin = AGF.due.from === '' ? null : Number(AGF.due.from), dmax = AGF.due.to === '' ? null : Number(AGF.due.to), dmin2 = AGF.days ? Number(AGF.days) : 0;
    const rows = j.rows.filter(g => (bucket === 'all' || g.buckets[bucket] > 0.005) && (!amNow || g.am === amNow) && (!q || (g.customer + ' ' + g.person + ' ' + g.am + ' ' + g.invoices.map(i => i.no).join(' ')).toLowerCase().indexOf(q) > -1)
        && (!cq || (g.customer + ' ' + (g.person || '') + ' ' + (g.email || '')).toLowerCase().indexOf(cq) > -1))
      .map(g => { const inv = inB(g); return Object.assign({}, g, { total: Math.round(inv.reduce((s, i) => s + i.balance, 0) * 100) / 100, invoiced: Math.round(inv.reduce((s, i) => s + i.total, 0) * 100) / 100, paid: Math.round(inv.reduce((s, i) => s + (i.done || 0), 0) * 100) / 100, n: inv.length, oldest: inv.reduce((m, i) => Math.max(m, i.age || 0), 0) }); });
    /* 1.20.89: the balance is what is due; invoiced / paid so far shown under it whenever something was paid */
    const dueCell = (g) => '<b>' + usd(g.total) + '</b>' + (g.paid > 0.005 ? '<div class="ag-ofp">of ' + usd(g.invoiced) + ' · paid ' + usd(g.paid) + '</div>' : '');
    const rowsF = rows.filter(g => (dmin == null || g.total >= dmin) && (dmax == null || g.total <= dmax) && (!dmin2 || g.oldest > dmin2));
    rows.length = 0; rowsF.forEach(g => rows.push(g));
    const cols = bucket === 'all' ? B : [bucket];
    $('nAging').textContent = j.totals.n || '';
    /* 1.20.91: every tile the same four lines — due · label with the invoice count · Invoiced · Paid (over every customer, not the filtered rows) */
    /* 1.20.107: the tiles follow the AM / customer / search filters (not the bucket — each tile IS a bucket) */
    const base = j.rows.filter(g => (!amNow || g.am === amNow) && (!q || (g.customer + ' ' + g.person + ' ' + g.am + ' ' + g.invoices.map(i => i.no).join(' ')).toLowerCase().indexOf(q) > -1) && (!cq || (g.customer + ' ' + (g.person || '') + ' ' + (g.email || '')).toLowerCase().indexOf(cq) > -1));
    const bk = { all: { inv: 0, paid: 0, n: 0, due: 0 } }; B.forEach(k => { bk[k] = { inv: 0, paid: 0, n: 0, due: 0 }; }); base.forEach(g => g.invoices.forEach(i => { bk.all.inv += i.total; bk.all.paid += i.done || 0; bk.all.n++; bk.all.due += i.balance; bk[i.bucket].inv += i.total; bk[i.bucket].paid += i.done || 0; bk[i.bucket].n++; bk[i.bucket].due += i.balance; }));
    const tile = (k, val, label) => '<div class="ag-tile' + (bucket === k ? ' on' : '') + '" data-agb="' + k + '" style="--c:' + (BC[k] || '#c7d2fe') + '"><b>' + usd(bk[k].due) + ' <small>due</small></b><span class="bk-muted">' + esc(label) + ' · ' + bk[k].n + ' inv</span><span class="ag-ofp">Invoiced ' + usd(bk[k].inv) + '</span><span class="ag-ofp">Paid ' + usd(bk[k].paid) + '</span></div>';
    const amFace = (g) => !g.am ? '<span class="bk-dim">—</span>' : g.am_photo ? '<img class="ag-face" src="' + esc(g.am_photo) + '" alt="" title="' + esc(g.am) + '" onerror="this.outerHTML=\'<span class=&quot;ag-face ag-ini&quot; title=&quot;' + esc(g.am).replace(/'/g, '') + '&quot;>' + esc(g.am.charAt(0)) + '</span>\'">' : '<span class="ag-face ag-ini" title="' + esc(g.am) + '">' + esc(g.am.charAt(0)) + '</span>';
    const invRows = (g) => '<table class="ag-inv"><tbody>' + g.invoices.filter(i => bucket === 'all' || i.bucket === bucket).map(i => '<tr><td><b>' + esc(i.no) + '</b>' + (i.po ? ' <span class="bk-dim">PO ' + esc(i.po) + '</span>' : '') + '</td><td>' + esc(usD(String(i.created || '').slice(0, 10))) + (i.due ? ' <span class="bk-dim">due ' + esc(usD(String(i.due).slice(0, 10))) + '</span>' : '') + '</td><td class="ag-agec"><span class="ag-age">' + (i.age == null ? '?' : i.age + ' d') + '</span></td><td class="num">' + usd(i.total) + '</td><td class="num">' + (i.done ? '<span class="ag-part">paid ' + usd(i.done) + '</span>' : '<span class="bk-dim">unpaid</span>') + '</td><td class="num"><b>' + usd(i.balance) + '</b> <span class="bk-dim">due</span></td></tr>').join('') + '</tbody></table>';
    const num = (x, k) => '<td class="num ' + (k || '') + (x > 0.005 ? '' : ' z') + '">' + (x > 0.005 ? usd(x) : '—') + '</td>';
    const tot = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, total: 0, invoiced: 0, paid: 0 }; rows.forEach(g => { B.forEach(k => { tot[k] += g.buckets[k]; }); tot.total += g.total; tot.invoiced += g.invoiced || 0; tot.paid += g.paid || 0; });
    v.innerHTML = '<div class="bk-card">' +
      '<div class="ag-tiles">' + tile('all', null, 'All open' + (amNow ? ' · ' + amNow.split(' ')[0] : '')) + B.map(k => tile(k, null, BL[k])).join('') + '</div>' +
      '<h2>Accounts receivable aging ' + qHelp('aging', 'Acct Aging', 'Every invoice the CRM shows as <b>unpaid or partial</b> (type invoice, total above zero), grouped by customer and aged from the invoice date: 0–30, 31–60, 61–90 and over 90 days. Invoices dated before <b>' + esc(usD(j.from || '2025-01-01')) + '</b> are left out — those are not chased any more (' + (j.dropped || 0) + ' hidden). The balance is total − paid. Click a customer to see the invoices; the bucket chips and tiles narrow the list; search by customer, invoice number or account manager. Read from the CRM, refreshed every 5 minutes (<a href="#" id="agFresh">refresh now</a>). Nothing here writes to the CRM.') + ' <span class="bk-muted">' + rows.length + ' customer' + (rows.length === 1 ? '' : 's') + (bucket !== 'all' ? ' · ' + esc(BL[bucket]) : '') + (amNow ? ' · ' + esc(amNow) : '') + ' · from ' + esc(usD(j.from || '2025-01-01')) + ' · read ' + esc(new Date(j.at || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + ' <a href="#" id="agFresh2">refresh</a></span></h2>' +
      (rows.length ? '<table class="bk ag-table"><thead><tr><th>' + thFilter('customer', 'Customer', AGS.customer) + '</th><th class="ag-amh">' + thFilter('am', 'AM', AGS.am, AGF.am) + '</th>' + cols.map(k => '<th class="num">' + esc(k === '90+' ? '90+' : BL[k].replace(' days', '')) + '</th>').join('') + '<th class="num">' + thFilter('due', 'Due', AGS.due) + '</th><th class="num">Inv</th><th class="num">' + thFilter('days', 'Days', AGS.days, AGF.days) + '</th></tr></thead><tbody>' +
        rows.map(g => '<tr class="ag-c" data-agc="' + esc(String(g.customer_id || 'none')) + '"><td>' + esc(g.customer) + (g.person && g.person !== g.customer ? '<div class="bk-dim">' + esc(g.person) + (g.email ? ' · ' + esc(g.email) : '') + '</div>' : (g.email ? '<div class="bk-dim">' + esc(g.email) + '</div>' : '')) + '</td><td class="ag-am">' + amFace(g) + '</td>' + cols.map(k => num(g.buckets[k])).join('') + '<td class="num">' + dueCell(g) + '</td><td class="num">' + g.n + '</td><td class="num ag-days"><span class="ag-age" title="Oldest open invoice' + (bucket !== 'all' ? ' in ' + BL[bucket] : '') + '">' + (g.oldest || 0) + ' d</span></td></tr>' +
          '<tr class="ag-d" data-agd="' + esc(String(g.customer_id || 'none')) + '"' + (agingOpen[g.customer_id || 'none'] ? '' : ' hidden') + '><td colspan="' + (cols.length + 5) + '">' + invRows(g) + '</td></tr>').join('') +
        '<tr class="ag-tot"><td>Total</td><td></td>' + cols.map(k => num(tot[k])).join('') + '<td class="num">' + dueCell(tot) + '</td><td></td><td></td></tr></tbody></table>'
        : '<div class="bk-muted" style="padding:16px 0">Nothing open' + (bucket !== 'all' ? ' in ' + esc(BL[bucket]) : '') + (amNow ? ' for ' + esc(amNow) : '') + (q ? ' for "' + esc(q) + '"' : '') + '.</div>') + '</div>';
    v.querySelectorAll('[data-agb]').forEach(t => t.onclick = () => show('aging', t.dataset.agb === 'all' ? 'all' : BK[t.dataset.agb]));
    thFilterBind(v, AGS, (key, val) => { if (key === 'due') AGF.due = { from: (val && val.from) || '', to: (val && val.to) || '', period: '' }; else AGF[key] = typeof val === 'string' ? val : ''; loadAging(bucket); });
    v.querySelectorAll('tr.ag-c').forEach(tr => tr.onclick = () => { const d = v.querySelector('tr.ag-d[data-agd="' + tr.dataset.agc + '"]'); if (!d) return; d.hidden = !d.hidden; agingOpen[tr.dataset.agc] = !d.hidden; });
    const fresh = async (e) => { e.preventDefault(); agingData = null; const j2 = await api('/api/bookkeeping/ar/aging?fresh=1'); if (j2.ok) agingData = j2; loadAging(bucket); };
    ['agFresh', 'agFresh2'].forEach(id => { const a = $(id); if (a) a.onclick = fresh; });
  }
  async function loadBills(sub) {
    billSub = BILL_SUBS[sub] ? sub : billSub;
    const v = $('vBills');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/bills');
    const KIND = { invoice: 'Invoice', credit_memo: 'Credit memo', statement: 'Statement' };
    const vlogo = (c) => c && c.photo ? '<img class="bk-logo bk-vl" src="' + esc(c.photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;bk-logo bk-vl ph&quot;>' + esc(String(c.name || '?').charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo bk-vl ph' + (c ? '' : ' none') + '">' + esc(c ? String(c.name).charAt(0).toUpperCase() : '?') + '</span>';
    const kindTag = (k) => k ? '<span class="bk-src ' + esc(k) + '">' + esc(k === 'bill' ? 'from a bill' : k) + '</span>' : '';
    const vendorBlock = (b) => {
      const c = b.vendor_card, linked = c && c.kind !== 'bill';
      const act = '<a href="#" class="bl-vact" data-link="' + b.id + '">' + (linked ? 'change' : (b.suggestions.length ? 'pick another' : 'Link')) + '</a>';
      return '<div class="bl-vendor">' + vlogo(linked ? c : null) + '<div class="bl-vname"><b>' + esc(b.vendor) + '</b> ' + act +
        (linked ? '<div class="bk-dim">' + kindTag(c.kind) + (c.name !== b.vendor ? ' ' + esc(c.name) : '') + (c.specialty ? ' · ' + esc(c.specialty) : '') + '</div>'
          : '<div class="bl-unlinked">Not in the CRM directory' + (b.suggestions.length ? ' — is it ' + b.suggestions.map(sg => '<a href="#" class="bl-sug" data-pair="' + b.id + '" data-vid="' + sg.id + '" title="' + Math.round(sg.score * 100) + '% match">' + esc(sg.name) + '</a>').join(' or ') + '?' : '') + '</div>') + '</div></div>';
    };
    const usDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? m[2] + '-' + m[3] + '-' + m[1] : String(d || ''); };
    const ROLE = { bill: 'Bill', receipt: 'Receipt', confirmation: 'Confirmation', delivery: 'Delivery', duplicate: 'Duplicate' };
    const lineLink = (l) => l.material_id ? (l.material_photo ? '<span class="bl-ph"><img src="' + esc(l.material_photo) + '" alt=""><img class="bl-ph-big" src="' + esc(l.material_photo) + '" alt=""></span>' : '') + '<button class="bk-btn sm bl-link on" data-ll title="' + (l.linked_by === 'rule' ? 'Linked by itself — the same wording from this vendor was linked before' : 'Material from the catalog') + '">' + esc(l.material_name || 'Material #' + l.material_id) + (l.linked_by === 'rule' ? ' <i class="bl-auto" title="linked by itself">auto</i>' : '') + '</button>' : l.equipment_id ? '<button class="bk-btn sm bl-link on eq" data-ll title="Machine payment (lease or loan)">' + iconSvg('printer') + esc(l.equipment_name || 'Machine #' + l.equipment_id) + (l.linked_by === 'rule' ? ' <i class="bl-auto" title="linked by itself">auto</i>' : '') + '</button>' : l.estimate_no ? '<button class="bk-btn sm bl-link on" data-ll title="Job in the system">E' + esc(l.estimate_no) + '</button>' : '<button class="bk-btn sm bl-link" data-ll title="Link this line to a material from the catalog, or to a job by its estimate number">Link…</button>';
    const billCard = (b) => {
      const tot = b.lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
      const pend = b.proposal_status === 'pending';
      const emails = b.emails || [];
      const q = [b.vendor, b.vendor_card && b.vendor_card.name, b.invoice_no, '#' + b.id, 'bill #' + b.id, b.total, usd(b.total), b.note, b.proposal_reason, b.rejected_note, (b.lines || []).map(l => [l.name, l.description, l.category, l.material_name, l.equipment_name, l.estimate_no].filter(Boolean).join(' ')).join(' '), (b.emails || []).map(e => e.subject).join(' ')].filter(x => x != null && x !== '').join(' ').toLowerCase();
      return '<div class="bl-card' + (b.status === 'rejected' ? ' off' : '') + '" data-bill="' + b.id + '" data-q="' + esc(q) + '"><div class="bl-head">' + vendorBlock(b) +
        '<div class="bl-meta"><div><span class="bk-tag">' + esc(KIND[b.kind] || b.kind) + '</span> ' + (b.invoice_no ? '<b>#' + esc(b.invoice_no) + '</b>' : '<span class="bk-dim">no number</span>') + ' <span class="bl-no" title="Nova\'s bill number">Bill #' + b.id + '</span>' + (billSub === 'all' ? ' <span class="bk-tag ' + esc(b.status) + '">' + (STATUS_L[b.status] || b.status) + '</span>' : '') + (b.duplicate_of && b.status !== 'rejected' ? ' <a href="#" class="bk-tag rejected bl-dup" data-goto="' + b.duplicate_of + '" title="Show bill #' + b.duplicate_of + '">possible duplicate of Bill #' + b.duplicate_of + '</a> <button class="bk-btn sm bl-merge" data-merge="' + b.id + '" data-into="' + b.duplicate_of + '">Merge into #' + b.duplicate_of + '</button>' : '') + (b.merged_into ? ' <span class="bk-tag rejected">merged into Bill #' + b.merged_into + '</span>' : '') + (b.merged && b.merged.length ? ' <span class="bk-tag">+ ' + b.merged.length + ' duplicate' + (b.merged.length === 1 ? '' : 's') + ' merged</span>' : '') + '</div>' +
          '<div class="bk-muted">' + (b.invoice_date ? 'Dated ' + esc(usDate(b.invoice_date)) : '') + (b.due_date ? ' · due <b>' + esc(usDate(b.due_date)) + '</b>' : '') + (b.terms ? ' · ' + esc(b.terms) : '') + (b.received_at ? ' · received ' + when(b.received_at) : '') + '</div></div>' +
        '<div class="bl-total"><b>' + usd(b.total) + '</b></div></div>' +
        (b.status === 'rejected' ? '<div class="bl-rej"><b>Rejected</b><span>' + (b.rejected_by ? 'by ' + whoHtml(b.rejected_by) + ' · ' : '') + esc(when(b.rejected_at) || '') + (b.rejected_note ? ' — ' + esc(b.rejected_note) : ' — no reason given') + (b.merged_into ? ' · merged into Bill #' + b.merged_into : '') + '</span></div>' : '') +
        (b.note || b.proposal_reason || b.question ? '<div class="bl-note bl-sum"><span class="bl-sumtext"><b>AI Summary:</b> ' + esc(b.note || b.proposal_reason || '') + '</span><button class="bl-more" data-more title="Show the whole note" aria-label="Show more">' + iconSvg('chevron') + '</button>' + (b.question ? '<button class="bk-btn sm bl-qbtn" data-q="' + b.id + '">' + iconSvg('sparkles') + 'AI question</button>' : '') + '</div>' : '') +
        (b.lines.length ? '<table class="bk bl-lines"><tbody>' + b.lines.map((l, i) => '<tr data-li="' + i + '"><td>' + esc(l.description || '') + (l.qty && l.unit_price ? ' <span class="bk-dim">' + esc(l.qty) + ' × ' + usd(l.unit_price) + '</span>' : '') + '</td><td class="bl-cat">' + catSelect(l.category || '', 'bl-catv', 'Category') + '</td><td class="bl-lk">' + lineLink(l) + '</td><td class="num">' + usd(l.amount) + '</td></tr>').join('') +
          (b.subtotal != null || b.tax ? '<tr class="sum"><td></td><td colspan="2" class="bk-muted">' + (b.subtotal != null ? 'Subtotal ' + usd(b.subtotal) : '') + (b.tax ? ' · tax ' + usd(b.tax) : '') + '</td><td class="num">' + usd(b.total) + '</td></tr>' : (Math.abs(tot - b.total) > 0.01 && tot ? '<tr class="sum"><td></td><td colspan="2" class="bk-dim">lines add up to ' + usd(tot) + '</td><td></td></tr>' : '')) + '</tbody></table>' : '') +
        (emails.length ? '<div class="bl-emails">' + emails.map(e => '<span class="bl-em"><a href="#" class="bl-emlink" data-em="' + e.id + '" title="' + esc(e.from_addr || '') + '">' + iconSvg('mail') + '<span class="bl-role">' + esc(ROLE[e.role] || e.role) + '</span>' + esc(e.subject || '(no subject)') + '<small>' + esc(when(e.received_at)) + (e.open ? '' : ' · closed') + '</small></a>' +
          e.attachments.map(a => '<a href="#" class="bl-att" data-em="' + e.id + '" data-i="' + a.i + '" data-kind="' + a.kind + '" title="' + esc(a.name) + '">' + iconSvg('paperclip') + esc(a.name) + '</a>').join('') + '</span>').join('') + '</div>' : '') +
        '<div class="bl-acts"><span class="sp"></span>' +
          (pend ? '<button class="bk-btn ok bl-decide" data-bapprove="' + b.proposal_id + '">Approve</button><button class="bk-btn bad bl-decide" data-breject="' + b.proposal_id + '">Reject</button>' : '') +
          (b.status === 'approved' ? '<button class="bk-btn sm" data-bstatus="scheduled" data-bid="' + b.id + '">Schedule payment…</button><button class="bk-btn sm ok" data-bstatus="paid" data-bid="' + b.id + '">Mark paid…</button>' : '') +
          (b.status === 'scheduled' ? '<span class="bk-muted">to pay ' + esc(usDate(b.scheduled_for || '')) + '</span><button class="bk-btn sm ok" data-bstatus="paid" data-bid="' + b.id + '">Mark paid…</button><button class="bk-btn sm" data-bstatus="approved" data-bid="' + b.id + '">Unschedule</button>' : '') +
          (b.status === 'rejected' && !b.merged_into ? '<button class="bk-btn sm" data-restore="' + b.id + '">Restore to Pending</button>' : '') +
          (b.status === 'paid' ? '<span class="bk-muted">paid ' + esc(usDate(b.paid_at || '')) + (b.paid_note ? ' · ' + esc(b.paid_note) : '') + '</span><button class="bk-btn sm" data-bstatus="approved" data-bid="' + b.id + '">Not paid after all</button>' : '') + '</div></div>';
    };
    const bills = j.bills || [];
    const TITLES = { all: ['All', 'Every bill, whatever its status.', 'No bills yet.'], pending: ['Pending', 'Bill drafts waiting for your decision.', 'No bill drafts waiting.'], approved: ['Approved', 'Approved and waiting to be paid — schedule a pay date or mark them paid as you go. (Paying through BILL comes in a later phase; nothing moves money here.)', 'Nothing approved and unpaid.'], scheduled: ['Scheduled', 'Approved bills with a pay date.', 'Nothing scheduled.'], paid: ['Paid', 'Paid bills, newest first.', 'Nothing paid yet.'], rejected: ['Rejected', 'Bills that were turned down, with the reason. Restore one if it was a mistake — it goes back to Pending.', 'Nothing rejected.'] };
    const t = TITLES[billSub];
    const STATUS_L = { draft: 'Pending', approved: 'Approved', scheduled: 'Scheduled', paid: 'Paid', rejected: 'Rejected' };
    const main = bills.filter(b => billSub === 'all' ? true : b.status === (billSub === 'pending' ? 'draft' : billSub)), rejected = [];
    if (billSub === 'all') main.sort((a, b) => b.id - a.id);   // 1.19.53: every bill, newest first, each with its status
    if (billSub === 'rejected') main.sort((a, b) => String(b.rejected_at || b.updated_at || '').localeCompare(String(a.rejected_at || a.updated_at || '')));
    if (billSub === 'scheduled') main.sort((a, b) => String(a.scheduled_for || '').localeCompare(String(b.scheduled_for || '')));
    if (billSub === 'paid') main.sort((a, b) => String(b.paid_at || '').localeCompare(String(a.paid_at || '')));
    const total = main.reduce((a, b) => a + (Number(b.total) || 0), 0);
    const HELP_TAB = { all: 'Every bill Nova knows, newest first, with its status on the card. Pending bills wait for your decision; the other tabs show one status each.',
      pending: 'Bills BookkeeperAI read from the inbox, waiting for your decision: fix the lines, then Approve or Reject (a reason is asked). Each one is paired with a CRM supplier or vendor — when the name is not an exact match, pick the right one once and the next bill from them links by itself.',
      approved: 'Approved and waiting to be paid — schedule a pay date or mark them paid as you go. Paying through BILL comes in a later phase; nothing moves money here.',
      scheduled: 'Approved bills with a pay date, soonest first. Mark paid when the money goes out, or Unschedule.',
      paid: 'Paid bills, newest first. "Not paid after all" sends one back to Approved.',
      rejected: 'Bills that were turned down, with who rejected them, when and why. Restore one if it was a mistake — it goes back to Pending. Merged duplicates stay merged.' };
    v.innerHTML = '<div class="bk-card"><h2>' + t[0] + ' bills ' + qHelp('bills_' + billSub, t[0] + ' bills', HELP_TAB[billSub] || '') + '<span class="sp"></span><span class="bk-muted">' + main.length + ' bill' + (main.length === 1 ? '' : 's') + (main.length ? ' · ' + usd(total) : '') + '</span>' + '</h2>' +
      (main.length ? main.map(billCard).join('') : '<div class="bk-muted" style="padding:10px 0">' + t[2] + '</div>') +
      (rejected.length ? '<details class="bl-done"><summary>' + rejected.length + ' rejected</summary>' + rejected.map(billCard).join('') + '</details>' : '') + '</div>';
    v.querySelectorAll('[data-file]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); openFile(a.dataset.file); });
    const blFilter = () => { const q = ($('blQ').value || '').trim().toLowerCase(); let n = 0, sum = 0; v.querySelectorAll('.bl-card').forEach(c => { const on = !q || c.dataset.q.indexOf(q) > -1; c.style.display = on ? '' : 'none'; if (on) { n++; const b = bills.find(x => String(x.id) === c.dataset.bill); sum += b ? Number(b.total) || 0 : 0; } }); const cnt = v.querySelector('h2 .bk-muted'); if (cnt) cnt.textContent = (q ? n + ' of ' + main.length : main.length) + ' bill' + (main.length === 1 ? '' : 's') + (n ? ' · ' + usd(sum) : ''); let none = v.querySelector('.bl-noq'); if (!none) { none = document.createElement('div'); none.className = 'bk-muted bl-noq'; none.style.padding = '10px 0'; none.textContent = 'No bills match the search.'; v.querySelector('.bk-card h2').after(none); } none.style.display = q && !n && main.length ? '' : 'none'; };
    $('blQ').oninput = blFilter; if (($('blQ').value || '').trim()) blFilter();
    v.querySelectorAll('.bl-sum').forEach(n => { const t = n.querySelector('.bl-sumtext'), m = n.querySelector('[data-more]'); requestAnimationFrame(() => { if (t.scrollWidth <= t.clientWidth + 1) m.style.display = 'none'; }); m.onclick = () => { n.classList.toggle('open'); }; });
    v.querySelectorAll('[data-goto]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); const c = v.querySelector('.bl-card[data-bill="' + a.dataset.goto + '"]'); if (!c) return alert('Bill #' + a.dataset.goto + ' is not in this list — look under the other Bills tabs.'); c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1800); });
    v.querySelectorAll('[data-merge]').forEach(bt => bt.onclick = async () => { const into = bt.dataset.into; if (!await ask('Bill #' + bt.dataset.merge + ' is folded into Bill #' + into + ': it is rejected as a duplicate, its email stays on #' + into + ' (marked Duplicate) and is closed in the inbox. Nothing is deleted.', { title: 'Merge into Bill #' + into + '?', ok: 'Merge' })) return; bt.disabled = true; const r = await post('/api/bookkeeping/bills/' + bt.dataset.merge + '/merge', { into: Number(into) }); if (!r.ok) alert(r.error); loadBills(); overview(); });
    v.querySelectorAll('[data-q]').forEach(bt => bt.onclick = () => { const b = bills.find(x => String(x.id) === bt.dataset.q); if (b && b.question) ask(b.question.question, { title: 'AI question — answer it in the Daily Brief', ok: 'OK', cancel: false }); });
    v.querySelectorAll('.bl-emlink').forEach(a => a.onclick = (ev) => { ev.preventDefault(); emailModal(Number(a.dataset.em)); });
    v.querySelectorAll('.bl-att').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); const r = await fetch('/api/bookkeeping/emails/' + a.dataset.em + '/att/' + a.dataset.i, { headers: { 'Authorization': 'Bearer ' + token } }); if (!r.ok) return alert('File not available.'); viewFile(URL.createObjectURL(await r.blob()), a.dataset.kind, a.title); });
    // lines: category and link edits save the whole line list of that bill
    const saveLines = async (card) => { const b = bills.find(x => String(x.id) === card.dataset.bill); if (!b) return; const r = await post('/api/bookkeeping/bills/' + b.id + '/lines', { lines: b.lines }); if (!r.ok) alert(r.error); };
    v.querySelectorAll('.bl-lines tr[data-li] .ckp').forEach(w => w.addEventListener('change', () => { const card = w.closest('.bl-card'), b = bills.find(x => String(x.id) === card.dataset.bill); const l = b.lines[Number(w.closest('tr').dataset.li)]; l.category = w.querySelector('.ckp-val').value; saveLines(card); }));
    v.querySelectorAll('[data-ll]').forEach(bt => bt.onclick = () => { const card = bt.closest('.bl-card'), b = bills.find(x => String(x.id) === card.dataset.bill), tr = bt.closest('tr'), l = b.lines[Number(tr.dataset.li)];
      lineLinkPicker(l, async (res) => { l.material_id = res.material ? res.material.id : null; l.material_name = res.material ? res.material.name : null; l.material_photo = res.material ? res.material.photo : null; l.linked_by = (res.material || res.equipment) ? 'hand' : null; l.estimate_no = res.estimate || null; l.equipment_id = res.equipment ? res.equipment.id : null; l.equipment_name = res.equipment ? res.equipment.name : null; tr.querySelector('.bl-lk').innerHTML = lineLink(l); tr.querySelector('[data-ll]').onclick = bt.onclick; await saveLines(card); }); });
    v.querySelectorAll('[data-bstatus]').forEach(b => b.onclick = async () => {
      const to = b.dataset.bstatus; let date = '', note = '';
      const d7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), d0 = new Date().toISOString().slice(0, 10);
      if (to === 'scheduled') { date = prompt('Pay on (YYYY-MM-DD):', d7); if (date === null) return; date = date.trim() || d7; }
      if (to === 'paid') { date = prompt('Paid on (YYYY-MM-DD):', d0); if (date === null) return; date = date.trim() || d0; note = prompt('How? (check #, card, ACH… optional)', '') || ''; }
      b.disabled = true; const r = await post('/api/bookkeeping/bills/' + b.dataset.bid + '/status', { status: to, date, note }); if (!r.ok) alert(r.error); loadBills(); overview();
    });
    v.querySelectorAll('[data-bapprove]').forEach(b => b.onclick = async () => { b.disabled = true; const r = await post('/api/bookkeeping/proposals/' + b.dataset.bapprove + '/decide', { action: 'approve', approve_vendor: true }); if (!r.ok) alert(r.error); loadBills(); overview(); });
    v.querySelectorAll('[data-breject]').forEach(b => b.onclick = async () => { const note = await askText('Why is this bill rejected? (not a bill, wrong vendor, already paid, duplicate…)', { title: 'Reject this bill', required: true, ok: 'Reject', multiline: true }); if (note == null) return; b.disabled = true; const r = await post('/api/bookkeeping/proposals/' + b.dataset.breject + '/decide', { action: 'reject', note }); if (!r.ok) alert(r.error); loadBills(); overview(); });
    v.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => { if (!await ask('The bill goes back to Pending for a decision.', { title: 'Restore Bill #' + b.dataset.restore + '?', ok: 'Restore' })) return; b.disabled = true; const r = await post('/api/bookkeeping/bills/' + b.dataset.restore + '/restore', {}); if (!r.ok) alert(r.error); loadBills(); overview(); });
    const pair = async (billId, vid) => { const r = await post('/api/bookkeeping/bills/' + billId + '/vendor', { vendor_id: vid, remember: true }); if (!r.ok) alert(r.error); loadBills(); };
    v.querySelectorAll('[data-pair]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); pair(a.dataset.pair, a.dataset.vid); });
    v.querySelectorAll('[data-link]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); const b = bills.find(x => String(x.id) === a.dataset.link); vendorPicker(a, b, (vid) => pair(b.id, vid)); });
  }
  // ---------------------------------------------------------------- Inbox (accounting@, Gmail-like)
  let ibFilter = 'open', ibOpen = null, ibSel = new Set();   // chip = basket by kind; inside, open emails (unread in Gmail) on top, closed ones under a divider
  async function loadInbox() {
    const v = $('vInbox');
    if (!ov) await overview();
    const e = await api('/api/bookkeeping/emails');
    const all = e.emails || [];
    const st = (m) => m.status === 'parsed' ? 'parsed' : m.status === 'error' ? 'error' : m.status === 'new' ? 'new' : m.status === 'message' ? 'message' : 'skipped';
    const counts = { all: all.length, parsed: 0, skipped: 0, new: 0, message: 0, ai: 0 }; all.forEach(m => { counts[st(m)] = (counts[st(m)] || 0) + 1; if (m.read_by === 'ai') counts.ai++; });
    const KIND = { advertisement: 'Ad', arrival: 'Delivery', receipt: 'Transaction', bill: 'Bill', message: 'Message', other: 'Other', notification: 'Other' };
    // the tag is the basket: a bill draft is a Bill whatever it was rated; rated with nothing fitting = Other
    const kindOf = (m) => st(m) === 'parsed' ? 'bill' : m.kind || (m.triaged_at ? 'other' : null);
    const kindTag = (m) => { const k = kindOf(m); return k ? '<span class="ib-kind ' + esc(k) + '"' + (m.note ? ' data-tip="' + esc(m.note) + '"' : '') + '>' + esc(KIND[k] || k) + ' ' + (m.confidence != null && k === m.kind ? Math.round(m.confidence * 100) : 100) + '%' + '</span>' : ''; };
    const fromName = (f) => { const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(f || ''); return m ? (m[1].trim() || m[2]) : String(f || '').replace(/^"|"$/g, ''); };
    const fromAddr = (f) => { const m = /<([^>]+)>/.exec(f || ''); return m ? m[1] : String(f || ''); };
    // who it is from, at a glance: the vendor's logo when the sender is linked, else a lettered circle
    const avatar = (m) => m.vendor_photo ? '<span class="ib-av logo" title="' + esc(m.vendor_name || '') + '"><img src="' + esc(m.vendor_photo) + '" alt="" onerror="this.parentNode.className=\'ib-av\';this.replaceWith(document.createTextNode(\'' + esc(fromName(m.from_addr).charAt(0).toUpperCase()) + '\'))"></span>' : '<span class="ib-av' + (m.vendor_id ? ' linked' : '') + '" title="' + esc(m.vendor_name || '') + '">' + esc(fromName(m.from_addr).charAt(0).toUpperCase() || '?') + '</span>';
    const clip = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/></svg>';
    const day = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$/.test(ts) ? '' : 'Z')); if (isNaN(d)) return ts; const now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
    // Baskets: where an open email goes by its rating; set-aside and bill drafts have their own.
    // Baskets: where an open email goes by its rating. Read in Gmail → Everything else; marked read here / by the AI → Set aside.
    // Baskets are by kind (what BookkeeperAI rated it); inside a basket, Open = still unread in Gmail, Closed = read.
    // Set aside is only what a person parked there. Gmail is the truth for open / closed (the scan syncs both ways).
    const isOpen = (m) => !m.read_by && !m.aside && st(m) !== 'error';   // open = still unread in Gmail (bill drafts included until Gmail says read)
    const basket = (m) => { if (m.aside) return 'done'; const k = kindOf(m); if (!k) return 'unrated'; return { bill: 'bill', message: 'message', advertisement: 'ads', receipt: 'receipt', arrival: 'arrival' }[k] || 'other'; };
    // the main chips, then the rest behind "More baskets" (same colours as the AI's tags)
    const BASKETS = [['open', 'All', 'mail'], ['unrated', 'New', 'sparkles'], ['bill', 'Bills', 'file'], ['receipt', 'Transactions', 'receipt'], ['arrival', 'Delivery', 'package'], ['message', 'Messages', 'users'], ['ads', 'Ads', 'megaphone'], ['other', 'Other', 'folder'], ['done', 'Do Later', 'clock']];
    const MAIN = ['open', 'bill', 'receipt', 'arrival', 'message', 'ads', 'other', 'done'], MORE = [];   // every basket on the line (1.19.3)
    const bc = {}, cc = {};   // open / closed counts per basket
    all.forEach(m => { const b = basket(m); if (b === 'done') { bc.done = (bc.done || 0) + 1; return; } if (isOpen(m)) bc[b] = (bc[b] || 0) + 1; else cc[b] = (cc[b] || 0) + 1; });
    const OPEN = ['message', 'ads', 'receipt', 'arrival', 'bill', 'other', 'unrated'];
    const billsToRead = all.filter(m => isOpen(m) && basket(m) === 'bill' && st(m) !== 'parsed').length;
    const openN = OPEN.reduce((a, k) => a + (bc[k] || 0), 0), closedN = OPEN.reduce((a, k) => a + (cc[k] || 0), 0); bc.open = openN; cc.open = closedN;
    if (!BASKETS.some(([k]) => k === ibFilter)) ibFilter = 'open';
    // Gmail snippets come HTML-escaped (&quot; &amp;): decode once, esc() re-escapes for display.
    const dec = (t) => { const d = document.createElement('textarea'); d.innerHTML = String(t || ''); return d.value; };
    all.forEach(m => { m.snippet = dec(m.snippet); m.subject = dec(m.subject); });
    all.sort((a, b) => (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0) || String(b.received_at || '').localeCompare(String(a.received_at || '')));   // open first, then closed; newest first in each
    const row = (m) => { const k = st(m); return '<div class="ib-row ' + k + (ibOpen === m.id ? ' open' : '') + '" data-m="' + m.id + '" data-k="' + k + '" data-b="' + basket(m) + '" data-o="' + (isOpen(m) ? 1 : 0) + '" data-ai="' + (m.read_by === 'ai' ? 1 : 0) + '" data-q="' + esc((m.from_addr + ' ' + m.subject + ' ' + (m.snippet || '') + ' ' + (m.note || '')).toLowerCase()) + '">' +
      '<span class="ib-pick"><input type="checkbox" data-pick="' + m.id + '" aria-label="Select"' + (ibSel.has(m.id) ? ' checked' : '') + '><span class="ib-dot ' + k + '" title="' + esc(k) + '"></span></span>' + avatar(m) + '<span class="ib-main"><span class="ib-l1"><span class="ib-from" title="' + esc(fromAddr(m.from_addr)) + '">' + esc(fromName(m.from_addr)) + '</span><span class="ib-time">' + esc(day(m.received_at)) + '</span></span>' +
      '<span class="ib-l2"><b>' + esc(m.subject || '(no subject)') + '</b></span><span class="ib-l3"><span class="ib-snip">' + esc(m.snippet || '') + '</span><span class="ib-att"><span class="ib-clip">' + (m.attachments.length ? clip + ' ' + m.attachments.length : '') + '</span>' + kindTag(m) + '</span></span></span>' +
      '<span class="ib-line">' + avatar(m) + '<span class="ib-from" title="' + esc(fromAddr(m.from_addr)) + '">' + esc(fromName(m.from_addr)) + '</span><span class="ib-text"><b>' + esc(m.subject || '(no subject)') + '</b><span class="ib-snip"> — ' + esc(m.snippet || '') + '</span></span><span class="ib-att"><span class="ib-clip">' + (m.attachments.length ? clip + ' ' + m.attachments.length : '') + '</span>' + kindTag(m) + '</span><span class="ib-time">' + esc(day(m.received_at)) + '</span></span>' +
      '</div>'; };
    const ibQv = ($('ibQ') || {}).value || '';
    v.innerHTML = '<div class="bk-sub ib-sub"><span class="ib-chips">' + BASKETS.filter(([k]) => MAIN.indexOf(k) > -1).map(([k, l, ic]) => '<button class="ib-chip k-' + k + (ibFilter === k ? ' on' : '') + '" data-f="' + k + '">' + iconSvg(ic) + l + '<b>' + (bc[k] || 0) + '</b></button>').join('') +
        '</span><span class="sp"></span><input id="ibQ" class="bk sub-q" placeholder="Search" autocomplete="off" value="' + esc(ibQv) + '"></div>' +
      '<div class="bk-card">' +
      '<div class="ib-progress" id="ibProg" style="display:none"><span class="ib-spin"></span><span id="ibProgText"></span></div>' +
      // one action bar per basket: review, then one click for the whole basket
      '<div class="ib-bar ib-acts" id="ibActs">' +
        '<span class="ib-selbar" id="ibSelBar" style="display:none"><b id="ibSelN"></b> selected <button class="bk-btn sm p" data-selread>Mark as read</button><button class="bk-btn sm" data-selmove>Move to <span class="thf-c"></span></button><button class="bk-btn sm" data-selclear>Clear</button></span>' +
        (() => { const D = (ov && ov.baskets) || {}; const txt = (k) => String(D[k] || '').replace('{poll}', ov.settings.poll_min);
          const head = (k, title) => '<b class="ib-bname">' + esc(title) + '</b>' + qHelp('basket_' + k, title, '<p>' + esc(txt(k)) + '</p><p class="bk-dim">Change the words under Settings → Inbox; the AI sorts by them.</p>');
          const readBtn = (k, n) => n ? '<button class="bk-btn sm" data-aside="' + k + '">Mark all ' + n + ' as read</button>' : '';
          return '<span data-for="bill">' + head('bill', 'Bills') + (bc.bill ? '<button class="bk-btn sm p" data-parseall>Turn ' + bc.bill + ' into bills</button>' + readBtn('bill', bc.bill) : '') + '</span>' +
            '<span data-for="receipt">' + head('receipt', 'Transactions') + readBtn('receipt', bc.receipt) + '</span>' +
            '<span data-for="arrival">' + head('arrival', 'Delivery') + readBtn('arrival', bc.arrival) + '</span>' +
            '<span data-for="message">' + head('message', 'Messages') + readBtn('message', bc.message) + '</span>' +
            '<span data-for="ads">' + head('advertisement', 'Ads') + readBtn('advertisement', bc.ads) + '</span>' +
            '<span data-for="other">' + head('other', 'Other') + readBtn('other', bc.other) + '</span>' +
            '<span data-for="done">' + head('aside', 'Do Later') + '</span>' +
            '<span data-for="open">' + head('all', 'All') + '<span class="bk-muted">' + (bc.unrated ? bc.unrated + ' not sorted yet — Scan puts them in their baskets.' : esc(txt('all'))) + '</span></span>'; })() +
        '<span class="bk-muted ib-last" style="margin-left:auto">' + esc(ov && ov.connections.gmail.last_scan ? 'Last scanned ' + when(ov.connections.gmail.last_scan) : 'Not scanned yet') + '</span><button class="bk-btn sm ico" id="scanNow2" title="Scan the inbox now" aria-label="Scan now">' + iconSvg('refresh') + '</button>' +
        '</div>' +
      '<div class="ib-split' + (ibOpen ? '' : ' lines') + '" id="ibSplit"><div class="ib-list">' + all.filter(isOpen).map(row).join('') + '<div class="ib-divider" id="ibClosedHead">Closed <b></b></div>' + all.filter(m => !isOpen(m)).map(row).join('') + (!all.length ? '<div class="bk-muted" style="padding:14px 0">Nothing scanned yet — press Scan now.</div>' : '') + '<div class="bk-muted" id="ibNone" style="display:none;padding:14px 10px">Nothing matches.</div></div>' +
      '<div class="ib-pane" id="ibPane"><div class="ib-empty">Select an email to read it</div></div></div></div>';
    const paneOn = (on) => { $('ibSplit').classList.toggle('lines', !on); };
    if (ibOpen && all.some(m => m.id === ibOpen)) { const r0 = v.querySelector('.ib-row[data-m="' + ibOpen + '"]'); if (r0) { r0.classList.add('open'); setTimeout(() => r0.scrollIntoView({ block: 'center' }), 50); } openEmail(ibOpen); }
    const filter = () => { const q = $('ibQ').value.trim().toLowerCase(); let n = 0; v.querySelectorAll('.ib-row').forEach(r => { const inB = ibFilter === 'open' ? OPEN.indexOf(r.dataset.b) > -1 : r.dataset.b === ibFilter; const on = inB && (!q || r.dataset.q.indexOf(q) > -1); r.style.display = on ? '' : 'none'; if (on) n++; }); $('ibNone').style.display = n || !all.length ? 'none' : ''; v.querySelectorAll('#ibActs > [data-for]').forEach(x => { x.style.display = x.dataset.for === ibFilter ? '' : 'none'; }); 

      const nc = Array.from(v.querySelectorAll('.ib-row[data-o="0"]')).filter(r => r.style.display !== 'none').length; const hd = $('ibClosedHead'); hd.style.display = nc && ibFilter !== 'done' ? '' : 'none'; hd.querySelector('b').textContent = nc; };
    const pickBasket = (f) => { ibFilter = f; loadInbox(); };
    const mb2 = v.querySelector('[data-more]'); if (mb2) mb2.onclick = (ev) => {
      ev.stopPropagation(); document.querySelectorAll('.thf-pop').forEach(p => p.remove());
      const pop = document.createElement('div'); pop.className = 'thf-pop mv-pop';
      pop.innerHTML = '<div class="thf-list">' + BASKETS.filter(([k]) => MORE.indexOf(k) > -1).map(([k, l, ic]) => '<div class="thf-i mv-i k-' + k + (ibFilter === k ? ' on' : '') + '" data-v="' + k + '"><span class="mv-ic">' + iconSvg(ic) + '</span><span class="thf-t">' + l + '</span><small>' + (bc[k] || 0) + '</small></div>').join('') + '</div>';
      document.body.appendChild(pop);
      const r = mb2.getBoundingClientRect(), W = 220; pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; pop.style.width = W + 'px';
      const closeP = () => { pop.remove(); document.removeEventListener('click', away); }; const away = (e2) => { if (!pop.contains(e2.target)) closeP(); }; setTimeout(() => document.addEventListener('click', away), 0);
      pop.querySelectorAll('.mv-i').forEach(i => i.onclick = () => { closeP(); ibOpen = null; pickBasket(i.dataset.v); });
    };
    v.querySelectorAll('.ib-chip[data-f]').forEach(c => c.onclick = () => {
      ibFilter = c.dataset.f; v.querySelectorAll('.ib-chip').forEach(x => x.classList.toggle('on', x === c)); filter();
      // a basket change closes the open email and goes back to the full-width list
      ibOpen = null; v.querySelectorAll('.ib-row.open').forEach(r => r.classList.remove('open')); $('ibPane').innerHTML = '<div class="ib-empty">Select an email to read it</div>'; paneOn(false);
    });
    $('ibQ').oninput = filter; filter();
    // picking several: the checkbox never opens the email; the bar acts on the picked ones
    const selPaint = () => { const n = ibSel.size; $('ibSelBar').style.display = n ? '' : 'none'; $('ibSelN').textContent = n; v.querySelectorAll('.ib-row').forEach(r => r.classList.toggle('picked', ibSel.has(Number(r.dataset.m)))); };
    v.querySelectorAll('[data-pick]').forEach(cb => { cb.onclick = (ev) => ev.stopPropagation(); cb.onchange = () => { const id = Number(cb.dataset.pick); if (cb.checked) ibSel.add(id); else ibSel.delete(id); selPaint(); }; });
    v.querySelector('[data-selclear]').onclick = () => { ibSel.clear(); v.querySelectorAll('[data-pick]').forEach(cb => { cb.checked = false; }); selPaint(); };
    v.querySelector('[data-selread]').onclick = async () => {
      const ids = Array.from(ibSel); if (!ids.length) return;
      if (!await ask('They are marked read in Gmail and move to Closed.', { title: 'Mark ' + ids.length + ' email' + (ids.length === 1 ? '' : 's') + ' as read?', ok: 'Mark as read' })) return;
      const r = await post('/api/bookkeeping/inbox/read', { ids }); if (!r.ok) await ask(r.error, { title: 'Not marked read', ok: 'OK', cancel: false }); ibSel.clear(); await overview(); loadInbox();
    };
    v.querySelector('[data-selmove]').onclick = (ev) => moveMenu(ev.currentTarget, null, async (kind) => { const ids = Array.from(ibSel); for (const id of ids) { const r = await post('/api/bookkeeping/emails/' + id + '/kind', { kind }); if (!r.ok) { await ask(r.error, { title: 'Not moved', ok: 'OK', cancel: false }); break; } } ibSel.clear(); await overview(); loadInbox(); });
    selPaint();
    v.querySelectorAll('.ib-row').forEach(r => r.onclick = () => { ibOpen = Number(r.dataset.m); v.querySelectorAll('.ib-row').forEach(x => x.classList.toggle('open', x === r)); paneOn(true); openEmail(ibOpen); });
    // Scan now, visibly: fetch new mail → rate 25 at a time (each rated row gets its tag as it comes in) → read the rated bills one by one.
    $('scanNow2').onclick = async () => {
      const btn = $('scanNow2'), prog = $('ibProg'), txt = $('ibProgText'); btn.disabled = true; prog.style.display = '';
      const say = (t) => { txt.textContent = t; };
      try {
        say('Checking ' + (ov ? ov.connections.gmail.inbox : 'the inbox') + ' for new mail…');
        const f = await post('/api/bookkeeping/inbox/fetch', {}); if (!f.ok) throw new Error(f.error);
        say((f.scan.new ? f.scan.new + ' new, ' : '') + f.scan.unread + ' unread in Gmail' + (f.scan.read_in_gmail ? ', ' + f.scan.read_in_gmail + ' read there since' : '') + (f.scan.unread_again ? ', ' + f.scan.unread_again + ' unread again' : '') + '…');
        let left = f.to_rate, done = 0, bills = [];
        while (left > 0) {
          say('Rating emails… ' + done + ' of ' + (done + left));
          const r = await post('/api/bookkeeping/inbox/rate', { limit: 25 }); if (!r.ok) throw new Error(r.error);
          (r.items || []).forEach(it => { const row = v.querySelector('.ib-row[data-m="' + it.id + '"]'); if (!row) return; const m = all.find(x => x.id === it.id); if (m) { m.kind = it.kind; m.confidence = it.confidence; m.triaged_at = 'now'; m.status = it.status === 'new' ? m.status : it.status; } const att = row.querySelector('.ib-att'); if (att) { const old = att.querySelector('.ib-kind'); if (old) old.remove(); att.insertAdjacentHTML('beforeend', kindTag(m || { kind: it.kind, confidence: it.confidence })); } row.classList.add('rated'); setTimeout(() => row.classList.remove('rated'), 900); });
          done += (r.items || []).length; left = r.remaining; bills = r.bills_to_read || [];
          if (!(r.items || []).length) break;
        }
        say('Done.');
      } catch (e) { say('Stopped: ' + e.message); }
      await overview(); setTimeout(loadInbox, 600);
    };
    v.querySelectorAll('[data-aside]').forEach(b => b.onclick = async () => {
      const k = b.dataset.aside, kinds = [k];
      const n = { receipt: bc.receipt, arrival: bc.arrival, advertisement: bc.ads, message: bc.message, bill: bc.bill, other: bc.other }[k] || 0;
      if (!await ask('They are marked read in Gmail and move to Closed in this basket. Any of them can still be turned into a bill later.', { title: 'Mark ' + n + ' email' + (n === 1 ? '' : 's') + ' as read?', ok: 'Mark as read' })) return;
      b.disabled = true; const r = await post('/api/bookkeeping/inbox/set-aside', { kinds, min: 0 }); if (!r.ok) await ask(r.error, { title: 'Not marked read', ok: 'OK', cancel: false }); await overview(); loadInbox();
    });
    const pa = v.querySelector('[data-parseall]'); if (pa) pa.onclick = async () => {
      const ids = all.filter(m => isOpen(m) && basket(m) === 'bill').map(m => m.id);
      if (!await ask('You go through them one by one: for each email you choose the purchase it belongs to, or start a new one. Emails not read yet are read in full and filed as drafts under Bills.', { title: 'Turn ' + ids.length + ' email' + (ids.length === 1 ? '' : 's') + ' into bills?', ok: 'Start' })) return;
      for (let i = 0; i < ids.length; i++) { const go = await billFlow(ids[i], null, { step: (i + 1) + ' of ' + ids.length }); if (go === 'stop') break; }
      await overview(); loadInbox();
    };
    $('nInbox').textContent = openN || '';
  }
  // The email's history: a small popover listing every action (newest first) with who did it.
  async function emailHistory(id, anchor) {
    document.querySelectorAll('.thf-pop').forEach(p => p.remove());
    const j = await api('/api/bookkeeping/emails/' + id + '/history'); if (!j.ok) return alert(j.error);
    const KIND = { advertisement: 'Ad', arrival: 'Delivery', receipt: 'Transaction', bill: 'Bill', message: 'Message', other: 'Other', notification: 'Other' };
    const line = (h) => {
      const d = h.detail || {};
      switch (h.action) {
        case 'scanned': return 'Scanned from the inbox';
        case 'rated': return 'Rated <b>' + esc(KIND[d.kind] || d.kind || '?') + (d.confidence != null ? ' ' + Math.round(d.confidence * 100) + '%' : '') + '</b>';
        case 'read': return 'Marked as read' + (d.basket ? ' (with all ' + esc(d.basket) + ')' : d.picked ? ' (picked)' : '');
        case 'unread': return 'Marked as unread';
        case 'move': return 'Moved to <b>' + esc(d.kind === 'aside' ? 'Do Later' : KIND[d.kind] || d.kind) + '</b>';
        case 'bill': return 'Converted to <b>bill #' + esc(d.bill_id) + '</b>' + (d.total != null ? ' · ' + usd(d.total) : '');
        case 'vendor': return d.vendor_id ? 'Linked sender to a vendor' + (d.address ? ' (' + esc(d.address) + ')' : '') : 'Unlinked sender';
        case 'match': return d.bill_id ? 'Matched to <b>bill #' + esc(d.bill_id) + '</b>' + (d.was && d.was !== 'paid' ? ' → paid' : '') : 'Matched to bank line #' + esc(d.transaction_id);
        case 'unmatch': return 'Match removed';
        case 'transaction': return 'Marked as a transaction → <b>purchase #' + esc(d.purchase_id) + '</b>' + (d.bill_id ? ' (bill #' + esc(d.bill_id) + ' paid)' : d.transaction_id ? ' (bank line matched)' : ' (waiting for the bank)');
        case 'arrival': return 'Arrival → <b>purchase #' + esc(d.purchase_id) + '</b> · ' + (d.received === 'partial' ? 'partly received' : 'received');
        default: return esc(h.action);
      }
    };
    const pop = document.createElement('div'); pop.className = 'thf-pop hist-pop';
    pop.innerHTML = '<div class="thf-h">History</div><div class="hist-list">' + (j.history.length ? j.history.map(h => '<div class="hist-i"><span class="hist-who">' + (h.who === 'BookkeeperAI' ? '<span class="bk-who ai" title="BookkeeperAI">AI</span>' : h.who === 'scan' || h.who === 'poll' || h.who === 'system' ? '<span class="bk-who sys" title="' + esc(h.who) + '">' + iconSvg('sparkles') + '</span>' : (whoHtml(h.who).indexOf('bk-who-sys') > -1 ? '<span class="bk-who" title="' + esc(h.who) + '">' + esc(h.who.charAt(0).toUpperCase()) + '</span>' : whoHtml(h.who))) + '</span><span class="hist-t">' + line(h) + '<small>' + esc(when(h.at)) + '</small></span></div>').join('') : '<div class="bk-muted" style="padding:10px 14px">Nothing yet.</div>') + '</div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = 340; pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; pop.style.width = W + 'px';
    const closeP = () => { pop.remove(); document.removeEventListener('click', away); }; const away = (ev) => { if (!pop.contains(ev.target)) closeP(); }; setTimeout(() => document.addEventListener('click', away), 0);
  }
  // Pick a vendor from the directory (search by name / email); pick(id).
  async function emailVendorPicker(pick) {
    const j = await api('/api/bookkeeping/vendors/pick'); const list = j.vendors || [];
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(460px,100%)"><div class="bk-modal-title">Link to a vendor</div><div class="bk-muted" style="margin-bottom:8px">The sender\'s address is remembered on the vendor here in Nova (not in the CRM), so every future email from it links by itself.</div><input class="bk" id="vpQ" placeholder="Search name or email…" style="width:100%;margin-bottom:8px"><div class="vp-list" id="vpList"></div><div class="bk-ask-acts"><button class="bk-btn" data-no>Cancel</button></div></div>';
    document.body.appendChild(el);
    const paint = () => { const q = $('vpQ').value.trim().toLowerCase(); const hits = list.filter(v => !q || (v.name + ' ' + (v.email || '')).toLowerCase().indexOf(q) > -1).slice(0, 60); $('vpList').innerHTML = hits.map(v => '<div class="vp-i" data-v="' + v.id + '">' + (v.photo ? '<img src="' + esc(v.photo) + '" alt="">' : '<span class="em-vinit">' + esc(v.name.charAt(0)) + '</span>') + '<span class="vp-n">' + esc(v.name) + (v.email ? ' <small>' + esc(v.email) + '</small>' : '') + '</span>' + (v.kind ? '<span class="bk-src ' + esc(v.kind) + '">' + esc(v.kind) + '</span>' : '') + '</div>').join('') || '<div class="bk-muted" style="padding:10px">No vendor matches.</div>'; $('vpList').querySelectorAll('.vp-i').forEach(i => i.onclick = () => { el.remove(); pick(Number(i.dataset.v)); }); };
    $('vpQ').oninput = paint; paint(); $('vpQ').focus();
    el.querySelector('[data-no]').onclick = () => el.remove(); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
  }
  // Bill: before anything is filed, choose the purchase this bill belongs to — one Nova found by order number, amount or
  // vendor — or start a new one. Then the email is read in full (if it was not already) and the draft lands under Bills.
  // Resolves 'done' / 'skip' / 'stop' (used by Turn all to walk through the basket).
  async function billFlow(id, done, opt) {
    opt = opt || {};
    const j = await post('/api/bookkeeping/emails/' + id + '/bill', {}); if (!j.ok) { alert(j.error); return 'skip'; }
    const x = j.extract || {}, list = j.purchases || [];
    return new Promise((resolve) => {
      const el = document.createElement('div'); el.className = 'bk-modal';
      el.innerHTML = '<div class="bk-modal-box" style="width:min(560px,100%)"><div class="bk-modal-title">Bill' + (opt.step ? ' <span class="bk-muted" style="font-weight:500">· ' + esc(opt.step) + '</span>' : '') + '</div>' +
        '<div class="bk-muted" style="margin-bottom:10px">' + (j.already ? 'Already read: bill #' + j.bill.id + ' — ' : 'Read from the email: ') + '<b>' + esc(x.vendor || '?') + '</b>' + (x.amount != null ? ' · <b>' + usd(x.amount) + '</b>' : '') + (x.order_no ? ' · #' + esc(x.order_no) : '') + (x.date ? ' · ' + esc(x.date) : '') + '. Which purchase is it?</div>' +
        (list.length ? '<div class="vp-h">Open purchases that fit</div><div class="vp-list">' + list.map(p => '<div class="vp-i" data-p="' + p.id + '"><span class="mv-ic" style="--kc:#1e40af;--kbg:#dbeafe">' + iconSvg('cart') + '</span><span class="vp-n">' + esc(p.vendor || '?') + (p.amount != null ? ' · ' + usd(p.amount) : '') + (p.order_no ? ' · #' + esc(p.order_no) : '') + ' <small>' + esc(p.date || '') + ' · ' + esc(p.status) + (p.why ? ' · ' + esc(p.why) : '') + '</small></span></div>').join('') + '</div><div class="vp-h">OR</div>' : '') +
        '<div class="vp-list"><div class="vp-i" data-new><span class="mv-ic" style="--kc:#065f46;--kbg:#d1fae5">' + iconSvg('sparkles') + '</span><span class="vp-n">New purchase from this bill<small>' + (list.length ? 'when nothing above is it' : 'nothing open matches it') + '</small></span></div></div>' +
        '<div class="bk-ask-acts">' + (opt.step ? '<button class="bk-btn" data-stop>Stop</button><button class="bk-btn" data-skip>Skip this one</button>' : '<button class="bk-btn" data-skip>Cancel</button>') + '</div></div>';
      document.body.appendChild(el);
      const finish = (v) => { el.remove(); resolve(v); };
      const go = async (body) => { el.querySelectorAll('.vp-i').forEach(i => { i.style.pointerEvents = 'none'; i.style.opacity = '.6'; }); const r = await post('/api/bookkeeping/emails/' + id + '/bill', body); if (!r.ok) { alert(r.error); return finish('skip'); } if (done) done(r); finish('done'); };
      el.querySelectorAll('[data-p]').forEach(i => i.onclick = () => go({ purchase_id: Number(i.dataset.p) }));
      el.querySelector('[data-new]').onclick = () => go({ new: 1 });
      el.querySelector('[data-skip]').onclick = () => finish('skip'); const st = el.querySelector('[data-stop]'); if (st) st.onclick = () => finish('stop');
      el.onclick = (ev) => { if (ev.target === el) finish(opt.step ? 'stop' : 'skip'); };
    });
  }
  // Transaction: Nova reads the email for vendor / amount / order number, then offers the bank lines with that exact
  // amount, a bill with that invoice number, or "wait for the bank" (a purchase with the bank slot empty).
  async function transactionFlow(id, done) {
    const j = await post('/api/bookkeeping/emails/' + id + '/transaction', {}); if (!j.ok) return alert(j.error);
    const x = j.extract || {}, txns = j.transactions || [], bills = j.bills || [], open = j.purchases || [];
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(560px,100%)"><div class="bk-modal-title">Transaction</div>' +
      '<div class="bk-muted" style="margin-bottom:10px">Read from the email: <b>' + esc(x.vendor || (j.vendor && j.vendor.name) || '?') + '</b>' + (x.amount != null ? ' · <b>' + usd(x.amount) + '</b>' : ' · no amount found') + (x.order_no ? ' · #' + esc(x.order_no) : '') + (x.what ? ' · ' + esc(x.what) : '') + '</div>' +
      (txns.length ? '<div class="vp-h">Bank lines with this amount</div><div class="vp-list">' + txns.map(t => '<div class="vp-i" data-t="' + t.id + '"><span class="mv-ic" style="--kc:#1e40af;--kbg:#dbeafe">' + iconSvg('landmark') + '</span><span class="vp-n">' + esc(t.date) + ' · ' + esc(t.merchant || t.name) + ' <small>' + usd(Math.abs(t.amount)) + (t.same_vendor ? ' · same vendor' : '') + '</small></span></div>').join('') + '</div>' : '') +
      (bills.length ? '<div class="vp-h">Bills with this number</div><div class="vp-list">' + bills.map(b => '<div class="vp-i" data-b="' + b.id + '"><span class="mv-ic" style="--kc:#065f46;--kbg:#d1fae5">' + iconSvg('file') + '</span><span class="vp-n">Bill #' + b.id + ' · ' + esc(b.vendor || '') + ' · ' + esc(b.invoice_no || '') + ' <small>' + usd(b.total) + ' · ' + esc(b.status) + ' — becomes paid</small></span></div>').join('') + '</div>' : '') +
      (open.length ? '<div class="vp-h">Open purchases from this vendor</div><div class="vp-list">' + open.map(p => '<div class="vp-i" data-p="' + p.id + '"><span class="mv-ic">' + iconSvg('cart') + '</span><span class="vp-n">' + esc(p.vendor || '') + (p.order_no ? ' · #' + esc(p.order_no) : '') + ' <small>' + (p.amount != null ? usd(p.amount) : '') + ' · ' + esc(p.date || '') + '</small></span></div>').join('') + '</div>' : '') +
      '<div class="vp-h">Or</div><div class="vp-list"><div class="vp-i" data-wait><span class="mv-ic" style="--kc:#115e59;--kbg:#ccfbf1">' + iconSvg('clock') + '</span><span class="vp-n">Wait for the bank <small>starts a purchase under Purchases → Waiting for the bank; Nova proposes the bank line when it lands</small></span></div></div>' +
      '<div class="bk-ask-acts"><button class="bk-btn" data-no>Cancel</button></div></div>';
    document.body.appendChild(el); el.querySelector('[data-no]').onclick = () => el.remove(); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
    const go = async (body) => { el.remove(); const r = await post('/api/bookkeeping/emails/' + id + '/transaction', Object.assign({ extract: x }, body)); if (!r.ok) return ask(r.error, { title: 'Not done', ok: 'OK', cancel: false }); done(); };
    el.querySelectorAll('[data-t]').forEach(i => i.onclick = () => go({ transaction_id: Number(i.dataset.t) }));
    el.querySelectorAll('[data-b]').forEach(i => i.onclick = () => go({ bill_id: Number(i.dataset.b) }));
    el.querySelectorAll('[data-p]').forEach(i => i.onclick = () => go({ purchase_id: Number(i.dataset.p) }));
    el.querySelector('[data-wait]').onclick = () => go({ wait: true });
  }
  // Arrival: pick the purchase the goods belong to (order number first, then the same vendor), say all or part came.
  async function arrivalFlow(id, done) {
    const j = await post('/api/bookkeeping/emails/' + id + '/arrival', {}); if (!j.ok) return alert(j.error);
    const x = j.extract || {}, list = j.purchases || [];
    const el = document.createElement('div'); el.className = 'bk-modal';
    const rowP = (p) => '<div class="vp-i pu-pick" data-p="' + p.id + '"><span class="mv-ic" style="--kc:#9a3412;--kbg:#fde8d8">' + iconSvg('package') + '</span><span class="vp-n">' + esc(p.vendor || '?') + (p.order_no ? ' · #' + esc(p.order_no) : '') + ' <small>' + (p.amount != null ? usd(p.amount) + ' · ' : '') + esc(p.date || '') + (p.received === 'partial' ? ' · partly received' : '') + (p.why ? ' · ' + esc(p.why) : '') + '</small></span><span class="bk-row" style="gap:4px"><button class="bk-btn sm p" data-all>All here</button><button class="bk-btn sm" data-part>Part</button></span></div>';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(600px,100%)"><div class="bk-modal-title">Delivery</div>' +
      '<div class="bk-muted" style="margin-bottom:10px">Read from the email: <b>' + esc(x.vendor || '?') + '</b>' + (x.order_no ? ' · #' + esc(x.order_no) : '') + (x.what ? ' · ' + esc(x.what) : '') + '. Which purchase did this deliver?</div>' +
      (list.length ? '<div class="vp-list">' + list.map(rowP).join('') + '</div>' : '<div class="bk-muted">No open goods purchase matches. Start one from this arrival; the bill or bank line can attach later.</div>') +
      '<div class="vp-h">Or</div><div class="vp-list"><div class="vp-i" data-start><span class="mv-ic">' + iconSvg('sparkles') + '</span><span class="vp-n">New purchase from this delivery <small>when nothing above is it</small></span></div></div>' +
      '<div class="bk-ask-acts"><button class="bk-btn" data-no>Cancel</button></div></div>';
    document.body.appendChild(el); el.querySelector('[data-no]').onclick = () => el.remove(); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
    const go = async (body) => { el.remove(); const r = await post('/api/bookkeeping/emails/' + id + '/arrival', Object.assign({ extract: x }, body)); if (!r.ok) return ask(r.error, { title: 'Not done', ok: 'OK', cancel: false }); done(); };
    el.querySelectorAll('.pu-pick').forEach(row => { const pid = Number(row.dataset.p); row.querySelector('[data-all]').onclick = (ev) => { ev.stopPropagation(); go({ purchase_id: pid, received: 'yes' }); }; row.querySelector('[data-part]').onclick = async (ev) => { ev.stopPropagation(); const note = await askText('What came, what is still missing?', { title: 'Partly received' }); if (note == null) return; go({ purchase_id: pid, received: 'partial', note }); }; });
    el.querySelector('[data-start]').onclick = () => go({ start: true, received: 'yes' });
  }
  // Match a receipt / payment email to a bill or a bank line. One candidate → confirm; several → choose.
  async function matchPicker(id, done) {
    const j = await api('/api/bookkeeping/emails/' + id + '/matches'); if (!j.ok) return alert(j.error);
    const bills = j.bills || [], txns = j.transactions || [];
    const billRow = (b) => '<div class="vp-i" data-bill="' + b.id + '"><span class="mv-ic" style="--kc:#065f46;--kbg:#d1fae5">' + iconSvg('file') + '</span><span class="vp-n">Bill #' + b.id + ' · ' + esc(b.vendor || '') + (b.invoice_no ? ' · ' + esc(b.invoice_no) : '') + ' <small>' + usd(b.total) + ' · ' + esc(b.status) + (b.due_date ? ' · due ' + esc(b.due_date) : '') + ' — ' + esc(b.why.join(', ')) + '</small></span></div>';
    const txnRow = (t) => '<div class="vp-i" data-txn="' + t.id + '"><span class="mv-ic" style="--kc:#1e40af;--kbg:#dbeafe">' + iconSvg('landmark') + '</span><span class="vp-n">' + esc(t.date) + ' · ' + esc(t.name) + ' <small>' + usd(Math.abs(t.amount)) + (t.category ? ' · ' + esc(t.category) : '') + ' — ' + esc(t.why.join(', ')) + '</small></span></div>';
    const total = bills.length + txns.length;
    if (total === 1) {
      const b = bills[0], t = txns[0];
      const ok = await ask(b ? 'Bill #' + b.id + ' — ' + (b.vendor || '') + (b.invoice_no ? ' ' + b.invoice_no : '') + ', ' + usd(b.total) + ' (' + b.why.join(', ') + '). It is marked paid on the email\'s date.' : t.date + ' ' + t.name + ', ' + usd(Math.abs(t.amount)) + ' (' + t.why.join(', ') + '). The email is kept as its receipt.', { title: b ? 'Match this bill?' : 'Match this bank line?', ok: 'Match' });
      if (!ok) return; const r = await post('/api/bookkeeping/emails/' + id + '/match', b ? { bill_id: b.id } : { transaction_id: t.id }); if (!r.ok) return alert(r.error); return done();
    }
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(560px,100%)"><div class="bk-modal-title">' + (total ? 'Which one is this email about?' : 'Nothing matched') + '</div>' +
      (total ? '<div class="bk-muted" style="margin-bottom:8px">A bill becomes paid on the email\'s date; a bank line keeps the email as its receipt.' + (j.numbers.length ? ' Numbers seen: ' + esc(j.numbers.slice(0, 5).join(', ')) + '.' : '') + (j.amounts.length ? ' Amounts: ' + j.amounts.slice(0, 5).map(usd).join(', ') + '.' : '') + '</div>' : '<div class="bk-muted" style="margin-bottom:8px">No open bill or recent bank line shares this sender, invoice number or amount' + (j.amounts.length ? ' (' + j.amounts.slice(0, 3).map(usd).join(', ') + ')' : '') + '. Sync the bank or turn the email into a bill first.</div>') +
      (bills.length ? '<div class="vp-h">Bills</div><div class="vp-list">' + bills.map(billRow).join('') + '</div>' : '') + (txns.length ? '<div class="vp-h">Bank lines</div><div class="vp-list">' + txns.map(txnRow).join('') + '</div>' : '') +
      '<div class="bk-ask-acts"><button class="bk-btn" data-no>' + (total ? 'Cancel' : 'Close') + '</button></div></div>';
    document.body.appendChild(el);
    el.querySelectorAll('[data-bill],[data-txn]').forEach(i => i.onclick = async () => { el.remove(); const r = await post('/api/bookkeeping/emails/' + id + '/match', i.dataset.bill ? { bill_id: Number(i.dataset.bill) } : { transaction_id: Number(i.dataset.txn) }); if (!r.ok) return alert(r.error); done(); });
    el.querySelector('[data-no]').onclick = () => el.remove(); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
  }
  // The "Move to" menu: the baskets in their colours. cur = the kind to leave out; pick(kind) does the move.
  function moveMenu(anchor, cur, pick) {
    document.querySelectorAll('.thf-pop').forEach(p => p.remove());
    const items = [['bill', 'Bills', 'file', 'bill'], ['receipt', 'Transactions', 'receipt', 'receipt'], ['message', 'Messages', 'users', 'message'], ['arrival', 'Delivery', 'package', 'arrival'], ['advertisement', 'Ads', 'megaphone', 'ads'], ['other', 'Other', 'folder', 'other'], ['aside', 'Do Later', 'clock', 'done']].filter(([kk]) => kk !== cur);
    const pop = document.createElement('div'); pop.className = 'thf-pop mv-pop';
    pop.innerHTML = '<div class="thf-list">' + items.map(([kk, l, ic, cls]) => '<div class="thf-i mv-i k-' + cls + '" data-v="' + kk + '"><span class="mv-ic">' + iconSvg(ic) + '</span><span class="thf-t">' + l + '</span></div>').join('') + '</div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = 200; pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; pop.style.width = W + 'px';
    const closeP = () => { pop.remove(); document.removeEventListener('click', away); };
    const away = (ev2) => { if (!pop.contains(ev2.target)) closeP(); }; setTimeout(() => document.addEventListener('click', away), 0);
    pop.querySelectorAll('.mv-i').forEach(i => i.onclick = () => { closeP(); pick(i.dataset.v); });
  }
  // The reading pane — an email the way Gmail shows it: subject, sender, date, the text, attachment cards that open a viewer.
  async function openEmail(id) {
    const j = await api('/api/bookkeeping/emails/' + id); if (!j.ok) return alert(j.error);
    const e = j.email, k = e.status === 'parsed' ? 'parsed' : e.status === 'error' ? 'error' : e.status === 'new' ? 'new' : e.status === 'message' ? 'message' : 'skipped';
    const KIND = { advertisement: 'Ad', arrival: 'Delivery', receipt: 'Transaction', bill: 'Bill', message: 'Message', other: 'Other', notification: 'Other' };
    const dec = (t) => { const d = document.createElement('textarea'); d.innerHTML = String(t || ''); return d.value; };
    const fromName = (f) => { const mm = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(f || ''); return mm ? (mm[1].trim() || mm[2]) : String(f || '').replace(/^"|"$/g, ''); };
    const fromAddr = (f) => { const mm = /<([^>]+)>/.exec(f || ''); return mm ? mm[1] : String(f || ''); };
    const fmtDate = (ts) => { const d = new Date(String(ts).replace(' ', 'T') + (/Z$/.test(ts || '') ? '' : 'Z')); return isNaN(d) ? ts : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    const body = dec(e.body || e.snippet || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[-_=]{8,}/g, '');
    const authHdr = { 'Authorization': 'Bearer ' + token };
    const att = (a) => '<a href="#" class="em-att" data-i="' + a.i + '" data-kind="' + a.kind + '" title="' + esc(a.name) + '"><span class="em-thumb ' + a.kind + '">' + (a.kind === 'pdf' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>' : '') + '</span><span class="em-attn"><b>' + esc(a.name) + '</b><small>' + (a.kind === 'pdf' ? 'PDF' : 'Image') + (a.size ? ' · ' + (a.size > 1048576 ? (a.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(a.size / 1024)) + ' KB') : '') + '</small></span></a>';
    const el = $('ibPane'); if (!el) return;
    const mainK = k === 'parsed' ? 'bill' : (e.decided_kind || e.kind || '');
    const htmlBody = e.body_html ? '<iframe class="em-html" sandbox="allow-same-origin allow-popups" referrerpolicy="no-referrer"></iframe>' : '';
    el.innerHTML = '<div class="em-box"><div class="em-head"><div class="em-subject">' + esc(dec(e.subject) || '(no subject)') + '</div><button class="em-close" data-close title="Back to the list" aria-label="Close">×</button></div>' +
      '<div class="em-meta"><button class="em-av' + (j.vendor && j.vendor.photo ? ' logo' : '') + (j.vendor ? ' linked' : '') + '" data-vmenu title="' + esc(j.vendor ? 'Vendor · ' + j.vendor.name + (j.vendor.kind ? ' · ' + j.vendor.kind.charAt(0).toUpperCase() + j.vendor.kind.slice(1) : '') + ' — click to change or unlink' : 'Not linked to a vendor — click to link ' + fromAddr(e.from_addr)) + '">' + (j.vendor && j.vendor.photo ? '<img src="' + esc(j.vendor.photo) + '" alt="' + esc(j.vendor.name) + '">' : esc(fromName(e.from_addr).charAt(0).toUpperCase())) + '</button><div class="em-who"><b>' + esc(fromName(e.from_addr)) + '</b> <span class="bk-muted">&lt;' + esc(fromAddr(e.from_addr)) + '&gt;</span><div class="bk-muted">to ' + esc(j.inbox) + '</div></div><div class="em-date bk-muted">' + esc(fmtDate(e.received_at)) + '</div></div>' +
      // the basket's own button is the main one (outlined): Bills → Bill, Transactions → Transaction, Arrivals → Arrival
      '<div class="em-acts">' + (k !== 'parsed' ? '<button class="ib-chip k-bill' + (mainK === 'bill' ? ' main' : '') + '" data-parse title="Read this email in full and file it as a bill draft under Bills">' + iconSvg('file') + 'Bill</button>' : '<button class="ib-chip k-bill on" data-gobills title="This email is a bill draft already — open it under Bills">' + iconSvg('file') + 'Bill →</button>') +
      (j.matched && (j.matched.bill || j.matched.txn) ? '<span class="em-matched">' + (j.matched.bill ? '<a href="#" data-gobills class="em-match">Matched · bill #' + j.matched.bill.id + ' · ' + esc(j.matched.bill.vendor || '') + (j.matched.bill.invoice_no ? ' ' + esc(j.matched.bill.invoice_no) : '') + ' · ' + usd(j.matched.bill.total) + ' · ' + esc(j.matched.bill.status) + '</a>' : '<span class="em-match">Matched · ' + esc(j.matched.txn.date) + ' ' + esc(j.matched.txn.name) + ' · ' + usd(Math.abs(j.matched.txn.amount)) + '</span>') + '<button class="bk-btn sm" data-unmatch title="Remove the match">×</button></span>' : '<button class="ib-chip k-receipt' + (mainK === 'receipt' ? ' main' : '') + '" data-match title="This email is proof of a payment: match it to the bank line or bill, or let it wait for the bank under Purchases">' + iconSvg('receipt') + 'Transaction</button>') +
      (k !== 'parsed' ? '<button class="ib-chip k-arrival' + (mainK === 'arrival' ? ' main' : '') + '" data-arrival title="Shipped / delivered: attach this email to the purchase it belongs to and record what came">' + iconSvg('package') + 'Delivery</button>' : '') +
      (k !== 'parsed' ? '<button class="ib-chip k-move" data-movebtn>' + iconSvg('folder') + 'Move to <span class="thf-c"></span></button>' : '') +
      (!e.read_by && !e.aside && k !== 'error' ? '<button class="bk-btn sm ico big" data-read title="Mark as read — here and in Gmail" aria-label="Mark as read">' + iconSvg('mailopen') + '</button>' : '<button class="bk-btn sm ico big" data-unread title="Mark as unread — here and in Gmail" aria-label="Mark as unread">' + iconSvg('mail') + '</button>') + '<button class="bk-btn sm ico" data-hist title="History — what was done with this email, and by whom" aria-label="History">' + iconSvg('clock') + '</button>' + '<span class="sp"></span><span class="em-verdict">' + (e.aside ? '<span class="ib-tag skipped">do later</span>' : '') + (e.kind ? '<span class="ib-kind ' + esc(e.kind) + '"' + (e.note ? ' data-tip="' + esc(e.note) + '"' : '') + '>' + esc(KIND[e.kind] || e.kind) + (e.confidence != null ? ' ' + Math.round(e.confidence * 100) + '%' : '') + '</span>' : '') + (e.note ? '' : '<span class="bk-muted">' + esc(k === 'new' ? 'Not rated yet.' : '') + '</span>') + (j.bill ? ' <a href="#" data-gobills>bill #' + j.bill.id + ' (' + esc(j.bill.status) + ')</a>' : '') + '</span></div>' +
      (e.attachments.length ? '<div class="em-atts">' + e.attachments.map(att).join('') + '</div>' : '') +
      (htmlBody || '<div class="em-body">' + esc(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>') + '</div>') + '</div>';
    const close = () => { el.innerHTML = '<div class="ib-empty">Select an email to read it</div>'; };
    if (e.body_html) {
      const fr = el.querySelector('.em-html');
      // One scrollbar only: the frame never scrolls itself — it grows to its content and the reading pane scrolls.
      const base = '<base target="_blank"><style>html,body{height:auto!important;overflow:visible!important}body{margin:0;padding:16px 22px;font:14px/1.5 -apple-system,Segoe UI,Roboto,Inter,sans-serif;color:#1f1f33;word-break:break-word}img{max-width:100%;height:auto}a{color:#4338ca}</style>';
      fr.setAttribute('scrolling', 'no');
      fr.onload = () => { try {
        const d = fr.contentDocument;
        const fit = () => { let h = d.body.offsetHeight; Array.from(d.body.children).forEach(c => { const r = c.getBoundingClientRect(); h = Math.max(h, r.bottom + (d.documentElement.scrollTop || 0)); }); fr.style.height = Math.min(Math.max(h, 60) + 32, 20000) + 'px'; };   // measure the content, not the viewport, so the frame can shrink too
        fit(); setTimeout(fit, 300); setTimeout(fit, 1200); setTimeout(fit, 3000);
        if (window.ResizeObserver) new ResizeObserver(fit).observe(d.body);
        d.querySelectorAll('img').forEach(im => { im.addEventListener('load', fit); im.addEventListener('error', fit); });
      } catch (er) {} };
      fr.srcdoc = base + e.body_html;
      const pl = el.querySelector('[data-plain]'); if (pl) pl.onclick = () => { fr.outerHTML = '<div class="em-body">' + esc(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>') + '</div>'; pl.remove(); };
    }
    // image thumbnails
    e.attachments.filter(a => a.kind === 'image').forEach(async a => { try { const r = await fetch('/api/bookkeeping/emails/' + id + '/att/' + a.i, { headers: authHdr }); if (r.ok) { const u = URL.createObjectURL(await r.blob()); const t = el.querySelector('.em-att[data-i="' + a.i + '"] .em-thumb'); if (t) t.style.backgroundImage = 'url(' + u + ')'; } } catch (er) {} });
    el.querySelectorAll('.em-att').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); const r = await fetch('/api/bookkeeping/emails/' + id + '/att/' + a.dataset.i, { headers: authHdr }); if (!r.ok) return alert('File not available.'); const u = URL.createObjectURL(await r.blob()); viewFile(u, a.dataset.kind, a.title); });
    const p1 = el.querySelector('[data-parse]'); if (p1) p1.onclick = () => billFlow(id, () => { close(); overview(); loadInbox(); });
    const r1 = el.querySelector('[data-read]'); if (r1) r1.onclick = async () => { r1.disabled = true; const r = await post('/api/bookkeeping/emails/' + id + '/read', {}); if (!r.ok) { await ask(r.error, { title: 'Not marked read', ok: 'OK', cancel: false }); r1.disabled = false; return; } close(); await overview(); loadInbox(); };
    const u1 = el.querySelector('[data-unread]'); if (u1) u1.onclick = async () => { u1.disabled = true; const r = await post('/api/bookkeeping/emails/' + id + '/unread', {}); if (!r.ok) { await ask(r.error, { title: 'Not marked unread', ok: 'OK', cancel: false }); u1.disabled = false; return; } close(); await overview(); loadInbox(); };
    // the avatar is the vendor: hover tells who, a click offers Link / Change / Unlink
    const linkV = () => emailVendorPicker(async (vid) => { const r = await post('/api/bookkeeping/emails/' + id + '/vendor', { vendor_id: vid }); if (!r.ok) return alert(r.error); openEmail(id); });
    const unlinkV = async () => { if (!await ask('Future emails from ' + fromAddr(e.from_addr) + ' will no longer link to ' + (j.vendor ? j.vendor.name : 'this vendor') + '.', { title: 'Unlink this address?', ok: 'Unlink' })) return; const r = await post('/api/bookkeeping/emails/' + id + '/vendor', { vendor_id: 0 }); if (!r.ok) return alert(r.error); openEmail(id); };
    const va = el.querySelector('[data-vmenu]'); if (va) va.onclick = (ev) => {
      ev.stopPropagation(); document.querySelectorAll('.thf-pop').forEach(p => p.remove());
      const pop = document.createElement('div'); pop.className = 'thf-pop mv-pop';
      pop.innerHTML = '<div class="vm-head">' + (j.vendor ? '<b>' + esc(j.vendor.name) + '</b>' + (j.vendor.kind ? ' <span class="bk-src ' + esc(j.vendor.kind) + '">' + esc(j.vendor.kind) + '</span>' : '') + '<small>' + esc(fromAddr(e.from_addr)) + '</small>' : '<b>Not linked</b><small>' + esc(fromAddr(e.from_addr)) + '</small>') + '</div><div class="thf-list">' +
        (j.vendor ? '<div class="thf-i" data-a="change">Change vendor…</div><div class="thf-i" data-a="unlink">Unlink this address</div>' : '<div class="thf-i" data-a="change">Link to a vendor…</div>') + '</div>';
      document.body.appendChild(pop);
      const r = va.getBoundingClientRect(), W = 240; pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; pop.style.width = W + 'px';
      const closeP = () => { pop.remove(); document.removeEventListener('click', away); }; const away = (ev2) => { if (!pop.contains(ev2.target)) closeP(); }; setTimeout(() => document.addEventListener('click', away), 0);
      pop.querySelectorAll('.thf-i').forEach(i => i.onclick = () => { closeP(); if (i.dataset.a === 'change') linkV(); else unlinkV(); });
    };
    const mt = el.querySelector('[data-match]'); if (mt) mt.onclick = () => transactionFlow(id, () => { ibOpen = null; overview(); loadInbox(); });
    const ar = el.querySelector('[data-arrival]'); if (ar) ar.onclick = () => arrivalFlow(id, () => { ibOpen = null; overview(); loadInbox(); });
    const um = el.querySelector('[data-unmatch]'); if (um) um.onclick = async () => { const r = await post('/api/bookkeeping/emails/' + id + '/match', { clear: 1 }); if (!r.ok) return alert(r.error); openEmail(id); overview(); };
    const hb = el.querySelector('[data-hist]'); if (hb) hb.onclick = (ev) => { ev.stopPropagation(); emailHistory(id, hb); };
    const cl = el.querySelector('[data-close]'); if (cl) cl.onclick = () => { ibOpen = null; close(); const sp = $('ibSplit'); if (sp) sp.classList.add('lines'); document.querySelectorAll('.ib-row.open').forEach(r => r.classList.remove('open')); };
    el.querySelectorAll('[data-gobills]').forEach(g1 => g1.onclick = (ev) => { ev.preventDefault(); show('bills'); });
    // Move to: a menu of the baskets, in their colours
    const mb = el.querySelector('[data-movebtn]'); if (mb) mb.onclick = (ev) => { ev.stopPropagation(); moveMenu(mb, e.aside ? 'aside' : e.kind, async (kind) => { mb.disabled = true; const rr = await post('/api/bookkeeping/emails/' + id + '/kind', { kind }); if (!rr.ok) await ask(rr.error, { title: 'Not moved', ok: 'OK', cancel: false }); await overview(); loadInbox(); }); };
    el.scrollTop = 0;
  }
  // Attachment viewer: PDFs in a frame, images as is; opens above the reading pane.
  function viewFile(url, kind, name) {
    const el = document.createElement('div'); el.className = 'bk-modal em-viewer';
    el.innerHTML = '<div class="em-vbox"><div class="em-vhead"><b>' + esc(name || '') + '</b><span class="sp"></span><a class="bk-btn sm" href="' + url + '" download="' + esc(name || 'file') + '">Download</a><a class="bk-btn sm" href="' + url + '" target="_blank" rel="noopener">Open in a tab</a><button class="bk-btn sm bk-x">✕</button></div>' +
      (kind === 'pdf' ? '<iframe class="em-frame" src="' + url + '#toolbar=1"></iframe>' : '<div class="em-img"><img src="' + url + '" alt=""></div>') + '</div>';
    const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.addEventListener('keydown', onKey, true); document.body.appendChild(el);
  }
  // Pick a directory entry for a bill: near matches first, then search the whole directory.
  // 1.19.60: match a money-in line to the charge it refunds — same amount and/or same merchant, last 120 days
  // 1.19.92: pick the other half of a transfer between our own accounts (same amount, opposite sign, within 14 days)
  async function transferPicker(anchor, id, t) {
    document.querySelectorAll('.ckp-pop').forEach(p => p.remove());
    const j = await api('/api/bookkeeping/transactions/' + id + '/transfer-candidates');
    const cands = j.candidates || [];
    const pop = document.createElement('div'); pop.className = 'ckp-pop single';
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.innerHTML = '<div class="ckp-gh" style="padding:10px 12px 4px">Which line is the other side of this ' + usd(-t.amount) + '?</div><div class="ckp-list">' +
      (cands.length ? cands.map(c => '<div class="ckp-i vp" data-c="' + c.id + '"><span class="rf-amt same">' + usd(-c.amount) + '</span><span class="rf-txt"><b>' + esc((c.institution ? bankAbbr(c.institution) + ' · ' : '') + (c.account_name || '')) + '</b><small>' + esc(usD(c.date)) + ' · ' + esc(c.merchant || c.name) + (c.other_account ? '' : ' · same account') + '</small></span></div>').join('')
        : '<div class="bk-muted" style="padding:10px 12px">No line with this amount the other way within 14 days. Sync the bank, or wait for the other side to post.</div>') +
      '</div><div class="ckp-foot"><span class="bk-muted">Both sides are filed as a transfer (credit card payment / between accounts) and the Stats leave them out.</span></div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = Math.min(420, window.innerWidth - 16);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.width = W + 'px';
    const below = window.innerHeight - r.bottom - 8; if (below >= 260) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.maxHeight = Math.min(400, below) + 'px'; } else { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.maxHeight = Math.min(400, r.top - 8) + 'px'; }
    const close = () => { pop.remove(); document.removeEventListener('click', away); document.removeEventListener('keydown', esc1); };
    const away = (e) => { if (!pop.contains(e.target)) close(); }, esc1 = (e) => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('click', away); document.addEventListener('keydown', esc1); }, 0);
    pop.querySelectorAll('[data-c]').forEach(el => el.onclick = async () => { const rr = await post('/api/bookkeeping/transactions/' + id + '/transfer', { with: Number(el.dataset.c) }); close(); if (!rr.ok) alert(rr.error); loadTxns(); overview(); });
  }
  async function refundPicker(anchor, id, t) {
    document.querySelectorAll('.ckp-pop').forEach(p => p.remove());
    const j = await api('/api/bookkeeping/transactions/' + id + '/refund-candidates');
    const cands = j.candidates || [];
    const pop = document.createElement('div'); pop.className = 'ckp-pop single';
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.innerHTML = '<div class="ckp-gh" style="padding:10px 12px 4px">Which charge does this ' + usd(-t.amount) + ' give back?</div><div class="ckp-list">' +
      (cands.length ? cands.map(c => '<div class="ckp-i vp" data-c="' + c.id + '"><span class="rf-amt' + (Math.abs(Math.abs(c.amount) - Math.abs(t.amount)) < 0.005 ? ' same' : '') + '">' + usd(-c.amount) + '</span><span class="rf-txt"><b>' + esc(c.merchant || c.name) + '</b><small>' + esc(usD(c.date)) + (c.category ? ' · ' + esc(c.category) : '') + (c.vendor_name && c.vendor_name !== (c.merchant || c.name) ? ' · ' + esc(c.vendor_name) : '') + '</small></span>' + (c.score >= 3 ? '<span class="bk-tag approved">same amount + merchant</span>' : c.score === 2 ? '<span class="bk-tag">same amount</span>' : '') + '</div>').join('')
        : '<div class="bk-muted" style="padding:10px 12px">No charge with this amount or merchant in the last 120 days.</div>') +
      '</div><div class="ckp-foot"><span class="bk-muted">The refund takes the charge\'s category and the Stats net it against what was spent.</span></div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = Math.min(420, window.innerWidth - 16);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.width = W + 'px';
    const below = window.innerHeight - r.bottom - 8; if (below >= 260) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.maxHeight = Math.min(400, below) + 'px'; } else { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.maxHeight = Math.min(400, r.top - 8) + 'px'; }
    const close = () => { pop.remove(); document.removeEventListener('click', away); document.removeEventListener('keydown', esc1); };
    const away = (e) => { if (!pop.contains(e.target)) close(); }, esc1 = (e) => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('click', away); document.addEventListener('keydown', esc1); }, 0);
    pop.querySelectorAll('[data-c]').forEach(el => el.onclick = async () => { const rr = await post('/api/bookkeeping/transactions/' + id + '/refund', { of: Number(el.dataset.c) }); close(); if (!rr.ok) alert(rr.error); loadTxns(); overview(); });
  }
  // 1.19.89: a check's photo. The bank feed never carries check images (Plaid does not deliver them), so the picture is one a
  // person attaches — pasted (Ctrl+V), dropped or uploaded — shrunk to 1400px JPEG in the browser and kept on the line.
  function checkPop(t) {
    const el = document.createElement('div'); el.className = 'bk-modal';
    const url = '/api/bookkeeping/transactions/' + t.id + '/check-image';
    const draw = (has) => {
      el.innerHTML = '<div class="bk-modal-box" style="width:min(820px,100%)"><div class="bk-modal-title">Check #' + esc(t.check_no) + ' <span class="bk-muted" style="font-weight:400">· ' + usd(-t.amount) + ' · ' + esc(usD(t.date)) + (t.merchant || t.name ? ' · ' + esc(t.merchant || t.name) : '') + '</span></div>' +
        (has ? '<div class="ck-img"><img alt="Check #' + esc(t.check_no) + '"></div><div class="bk-row" style="margin-top:10px"><button class="bk-btn sm" id="ckReplace">Replace</button><button class="bk-btn sm bad" id="ckRemove">Remove</button><span class="sp"></span><button class="bk-btn bk-x">Close</button></div>'
          : '<div class="ck-drop" id="ckDrop" tabindex="0"><div><b>No picture of this check yet.</b></div><div class="bk-muted">Your bank\'s feed does not carry check images. Open the check in online banking, copy the image, then <b>paste it here (Ctrl+V)</b> — or drop / upload a photo.</div><div style="margin-top:10px"><button class="bk-btn sm" id="ckUpload">Upload a picture</button></div></div><input type="file" id="ckFile" accept="image/*" hidden><div class="bk-row" style="margin-top:10px"><span class="bk-muted" id="ckMsg"></span><span class="sp"></span><button class="bk-btn bk-x">Close</button></div>') + '</div>';
      // the picture needs the bearer, which an <img src> cannot send — fetch it and show a blob URL
      const im = el.querySelector('.ck-img img'); if (im) fetch(url, { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.ok ? r.blob() : null).then(bl => { if (bl) im.src = URL.createObjectURL(bl); });
      const take = (f) => {
        if (!f || !/^image\//.test(f.type)) return;
        const img = new Image(); img.onload = async () => {
          const W = Math.min(1400, img.width), H = Math.round(img.height * W / img.width), c = document.createElement('canvas'); c.width = W; c.height = H;
          c.getContext('2d').drawImage(img, 0, 0, W, H); URL.revokeObjectURL(img.src);
          const r = await post(url, { image: c.toDataURL('image/jpeg', 0.85) });
          if (!r.ok) { const m = el.querySelector('#ckMsg'); if (m) m.textContent = r.error || 'Could not save.'; return; }
          t.has_check_image = 1; draw(true); loadTxns();
        };
        img.src = URL.createObjectURL(f);
      };
      el.onpaste = (ev) => { const it = Array.from((ev.clipboardData || {}).items || []).find(x => /^image\//.test(x.type)); if (it) { ev.preventDefault(); take(it.getAsFile()); } };
      const drop = el.querySelector('#ckDrop');
      if (drop) { drop.focus(); drop.ondragover = (ev) => { ev.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over'); drop.ondrop = (ev) => { ev.preventDefault(); drop.classList.remove('over'); take(ev.dataTransfer.files && ev.dataTransfer.files[0]); };
        el.querySelector('#ckUpload').onclick = () => el.querySelector('#ckFile').click(); el.querySelector('#ckFile').onchange = () => take(el.querySelector('#ckFile').files[0]); }
      const rep = el.querySelector('#ckReplace'); if (rep) rep.onclick = () => { t.has_check_image = 0; draw(false); };
      const rm = el.querySelector('#ckRemove'); if (rm) rm.onclick = async () => { if (!(await ask('Remove the picture of check #' + t.check_no + '?', { ok: 'Remove', danger: true }))) return; await post(url, { image: null }); t.has_check_image = 0; draw(false); loadTxns(); };
    };
    draw(!!t.has_check_image);
    el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) el.remove(); };
    document.body.appendChild(el);
  }
  async function vendorPicker(anchor, bill, onPick, opts) {
    opts = opts || {}; const asFilter = !!opts.filter;   // 1.19.67: the same picker is the Bank feed's Company header filter
    document.querySelectorAll('.ckp-pop').forEach(p => p.remove());
    const j = await api('/api/bookkeeping/directory?fresh=0');
    const all = (j.vendors || []).filter(x => x.kind !== 'bill');
    const pop = document.createElement('div'); pop.className = 'ckp-pop single';
    pop.addEventListener('click', (e) => e.stopPropagation());
    let vtab = 'axiom';   // 1.19.65: Axiom (CRM) vendors | Nova vendors; the search box always looks through both
    const isNova = (x) => x.source === 'nova' || x.source === 'bill';
    pop.innerHTML = (asFilter ? '<div class="thf-h">Company' + (opts.filter.current ? '<button type="button" class="thf-clear thf-hclear">× Clear</button>' : '') + '</div>' : '') + '<div class="ckp-search"><input type="text" placeholder="Search all vendors…"></div><div class="vp-tabs"><button type="button" class="ib-chip sm on" data-vt="axiom">Axiom vendors <small>' + all.filter(x => !isNova(x)).length + '</small></button><button type="button" class="ib-chip sm" data-vt="nova">Nova vendors ' + AI_I + ' <small>' + all.filter(isNova).length + '</small></button></div><div class="ckp-list"></div><div class="ckp-foot">' + (asFilter ? '<span class="bk-muted">Show only this company\'s lines.</span>' : '<a href="#" class="ckp-new vp-new">+ New Nova vendor…</a>') + '</div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = Math.min(380, window.innerWidth - 16);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.width = W + 'px';
    const below = window.innerHeight - r.bottom - 8; if (below >= 320) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.maxHeight = Math.min(440, below) + 'px'; } else { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.maxHeight = Math.min(440, r.top - 8) + 'px'; }
    const list = pop.querySelector('.ckp-list'), q = pop.querySelector('input');
    const row = (x, extra) => '<div class="ckp-i vp" data-v="' + x.id + '">' + (x.photo ? '<img class="bk-logo vp-logo" src="' + esc(x.photo) + '" alt="">' : '<span class="bk-logo vp-logo ph">' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>') + '<span class="vp-n"><b>' + esc(x.name) + '</b><small>' + esc([x.kind, x.specialty].filter(Boolean).join(' · ')) + '</small></span>' + (extra || '') + '</div>';
    const draw = () => {
      const f = q.value.trim().toLowerCase(); let html = '';
      if (asFilter && !f) html += '<div class="ckp-g">' + [['', 'All companies'], ['none', 'Not linked']].map(([v, l]) => '<div class="ckp-i vp' + (String(opts.filter.current || '') === v ? ' on' : '') + '" data-v="' + v + '"><span class="ckp-ck"></span><span class="vp-n"><b>' + l + '</b></span></div>').join('') + '</div>';
      if (!f && !asFilter && bill.suggestions.length) html += '<div class="ckp-g"><div class="ckp-gh">Near matches</div>' + bill.suggestions.map(sg => row(sg, '<span class="bk-dim">' + Math.round(sg.score * 100) + '%</span>')).join('') + '</div>';
      const hit = (x) => (x.name + ' ' + (x.specialty || '') + ' ' + (x.aliases || '')).toLowerCase().indexOf(f) > -1;
      if (f) {   // a search looks through both lists
        const ax = all.filter(x => !isNova(x) && hit(x)).slice(0, 60), nv = all.filter(x => isNova(x) && hit(x)).slice(0, 60);
        if (ax.length) html += '<div class="ckp-g"><div class="ckp-gh">Axiom vendors<small>' + ax.length + '</small></div>' + ax.map(x => row(x)).join('') + '</div>';
        if (nv.length) html += '<div class="ckp-g"><div class="ckp-gh">Nova vendors<small>' + nv.length + '</small></div>' + nv.map(x => row(x)).join('') + '</div>';
        if (!ax.length && !nv.length) html += '<div class="bk-muted" style="padding:10px 12px">No match — add it as a Nova vendor below.</div>';
      } else {
        const rest = all.filter(x => vtab === 'nova' ? isNova(x) : !isNova(x)).slice(0, 80);
        html += '<div class="ckp-g"><div class="ckp-gh">' + (vtab === 'nova' ? 'Nova vendors' : 'All suppliers and vendors') + '<small>' + rest.length + '</small></div>' + (rest.length ? rest.map(x => row(x)).join('') : '<div class="bk-muted" style="padding:8px 12px">None yet.</div>') + '</div>';
      }
      list.innerHTML = html;
    };
    pop.querySelectorAll('[data-vt]').forEach(b => b.onclick = () => { vtab = b.dataset.vt; pop.querySelectorAll('[data-vt]').forEach(x => x.classList.toggle('on', x === b)); draw(); });
    draw(); setTimeout(() => q.focus(), 0); q.oninput = draw;
    list.onclick = (e) => { const it = e.target.closest('.ckp-i'); if (!it) return; onPick(asFilter ? it.dataset.v : Number(it.dataset.v), (it.querySelector('b') || {}).textContent || ''); close(); };
    const hc = pop.querySelector('.thf-hclear'); if (hc) hc.onclick = () => { close(); onPick('', ''); };   // 1.19.104: "× Clear" on top, like every other filter popover
    if (pop.querySelector('.vp-new')) pop.querySelector('.vp-new').onclick = (e) => { e.preventDefault(); close(); novaVendorForm({ name: bill.vendor || '', aliases: bill.vendor || '' }, (nv) => onPick(nv.id)); };   // 1.19.63
    const close = () => { pop.remove(); document.removeEventListener('click', away); document.removeEventListener('keydown', esc1); };
    const away = (e) => { if (!pop.contains(e.target)) close(); }, esc1 = (e) => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('click', away); document.addEventListener('keydown', esc1); }, 0);
  }

  // ---------------------------------------------------------------- Rules
  // 1.19.112: the optional amount condition of a rule — [any amount ▾ | over | under] [$ n]
  // 1.19.146: money side — Any / Received (money in) / Paid (money out); blank = any
  const sideHtml = (pre, side) => '<select class="bk ' + pre + '-side" id="' + pre + 'Side" title="Money in or out: Received = deposits, Paid = charges"><option value=""' + (!side ? ' selected' : '') + '>Any</option><option value="in"' + (side === 'in' ? ' selected' : '') + '>Received</option><option value="out"' + (side === 'out' ? ' selected' : '') + '>Paid</option></select>';
  const SIDE_L = { in: 'Received', out: 'Paid' };
  // 1.19.151: 'between' shows a second box (from .. to)
  const amountCondHtml = (pre, op, val, side, val2) => '<span class="ra-amt">' + sideHtml(pre, side) + '<select class="bk ' + pre + '-amt-op" id="' + pre + 'AmtOp" title="Only lines whose amount is over / under / between this"><option value=""' + (!op ? ' selected' : '') + '>any amount</option><option value="over"' + (op === 'over' ? ' selected' : '') + '>over</option><option value="under"' + (op === 'under' ? ' selected' : '') + '>under</option><option value="equal"' + (op === 'equal' ? ' selected' : '') + '>exactly</option><option value="between"' + (op === 'between' ? ' selected' : '') + '>between</option></select><input class="bk ' + pre + '-amt-val" id="' + pre + 'AmtVal" type="number" min="0" step="0.01" placeholder="' + (op === 'between' ? 'from $' : '$') + '" value="' + (val != null && val !== '' ? esc(String(val)) : '') + '" style="width:84px"><input class="bk ' + pre + '-amt-val2" id="' + pre + 'AmtVal2" type="number" min="0" step="0.01" placeholder="to $" value="' + (val2 != null && val2 !== '' ? esc(String(val2)) : '') + '" style="width:84px' + (op === 'between' ? '' : ';display:none') + '"></span>';
  const amtOpUi = (scope) => { const op = scope.querySelector('[class*="-amt-op"]'), v1 = scope.querySelector('[class*="-amt-val"]:not([class*="-amt-val2"])'), v2 = scope.querySelector('[class*="-amt-val2"]'); if (!op) return; const f = () => { const b = op.value === 'between'; if (v2) v2.style.display = b ? '' : 'none'; if (v1) v1.placeholder = b ? 'from $' : '$'; }; op.addEventListener('change', f); f(); };
  const amtText = (r) => r.amount_op === 'between' ? usd(r.amount_val) + ' – ' + usd(r.amount_val2 == null ? r.amount_val : r.amount_val2) : (r.amount_op === 'over' ? '&gt; ' : r.amount_op === 'under' ? '&lt; ' : '= ') + usd(r.amount_val);
  async function loadRules() {
    const v = $('vRules');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/rules');
    v.innerHTML = '<div class="bk-card">' +
      '<div class="bk-row rl-add" style="margin-bottom:10px;flex-wrap:nowrap"><select class="bk" id="rKind"><option value="vendor">Vendor is</option><option value="keyword">Description contains</option><option value="none">No rule for vendor</option></select><input class="bk" id="rPat" placeholder="e.g. Veritiv or AMAZON" style="flex:0 0 220px;min-width:0">' + amountCondHtml('r', '', '', '', '') + catSelect('', 'rcat', 'Category…') + '<button class="bk-btn p" id="rAdd" style="white-space:nowrap;flex:none">Add rule</button></div>' +
      '<div class="bk-muted" style="margin:-4px 0 10px;font-size:12px">Money side and amount are optional — <b>Received</b> / <b>Paid</b> limits the rule to deposits or charges, "over $500", "under $50" or "between $100 and $800" to those amounts; Any = every line. <b>No rule for vendor</b> means: never file this vendor by rule and stop offering "Make it a rule?" for it (eBay, where every purchase is different).</div>' +
      '<table class="bk rl-table"><thead><tr><th>Rule</th><th>Money</th><th>Amount</th><th>Category</th><th>From</th><th>Hits</th><th></th></tr></thead><tbody>' +
      (j.rules || []).map(r => '<tr data-rule="' + r.id + '"><td class="rl-rule" title="' + esc((r.kind === 'vendor' ? 'Vendor is ' : r.kind === 'none' ? 'No rule for ' : 'Description contains ') + r.pattern) + '"><small>' + (r.kind === 'vendor' ? 'Vendor is' : r.kind === 'none' ? 'No rule for' : 'Contains') + '</small> <b>' + esc(r.pattern.length > 28 ? r.pattern.slice(0, 27) + '…' : r.pattern) + '</b></td>' +
        '<td class="rl-side">' + (r.side ? '<span title="Only money ' + (r.side === 'in' ? 'in (deposits)' : 'out (charges)') + '">' + SIDE_L[r.side] + '</span>' : '<span class="bk-dim">any</span>') + '</td>' +
        '<td class="rl-amt">' + (r.amount_op && r.amount_val != null ? '<span title="Only lines whose amount is ' + esc(r.amount_op === 'equal' ? 'exactly' : r.amount_op) + ' ' + usd(r.amount_val) + (r.amount_op === 'between' ? ' and ' + usd(r.amount_val2 == null ? r.amount_val : r.amount_val2) : '') + '">' + amtText(r) + '</span>' : '<span class="bk-dim">any</span>') + '</td>' +
        '<td class="rl-cat">' + (r.kind === 'none' ? '<span class="bk-muted" title="Never filed by rule, never asked">never by rule</span>' : catShort(r.category)) + '</td><td><span class="bk-row" style="gap:6px;align-items:center">' + esc(r.source) + (r.created_by ? ' · ' + whoHtml(r.created_by) : '') + '</span></td><td>' + r.hits + '</td><td style="white-space:nowrap"><button class="bk-btn sm" data-edit="' + r.id + '">Edit</button> <button class="bk-btn sm bad" data-del="' + r.id + '">Remove</button></td></tr>').join('') + '</tbody></table>' +
      (!(j.rules || []).length ? '<div class="bk-muted" style="padding:14px 0">No rules yet — each approval with "remember" ticked adds one.</div>' : '') + '</div>' +
      
      '<div class="bk-card"><h2>Notes for the AI ' + qHelp('notes', 'Notes for the AI', 'How AxiomPrint books things — BookkeeperAI reads this with every proposal. The chart of accounts itself is edited under Accounts → Chart of Accounts.') + '</h2>' +
      '<textarea class="bk" id="sNotes" style="margin-top:8px">' + esc(ov.settings.notes) + '</textarea>' +
      '<div class="bk-row" style="margin-top:8px"><label class="bk-muted">Ask me when confidence is below <input class="bk" id="sThr" type="number" min="0.3" max="1" step="0.05" value="' + esc(ov.settings.threshold) + '" style="width:80px"></label><button class="bk-btn p" id="sSave">Save</button><span class="bk-muted" id="sMsg"></span></div></div>';
    const noneUi = (sel, scope) => { const none = sel.value === 'none'; scope.querySelectorAll('.ra-amt, .ckp').forEach(el => { el.style.display = none ? 'none' : ''; }); };   // 1.19.112: "No rule" needs no amount or category
    $('rKind').onchange = () => noneUi($('rKind'), v.querySelector('.bk-row')); amtOpUi(v.querySelector('.rl-add'));
    $('rAdd').onclick = async () => { const r = await post('/api/bookkeeping/rules', { kind: $('rKind').value, pattern: $('rPat').value.trim(), category: v.querySelector('input.rcat').value, amount_op: $('rAmtOp').value, amount_val: $('rAmtVal').value, amount_val2: $('rAmtVal2').value, side: $('rSide').value }); if (!r.ok) alert(r.error); loadRules(); };
    v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/api/bookkeeping/rules/' + b.dataset.del, { method: 'DELETE' }); loadRules(); });
    // 1.19.77: Edit turns the row into an editor; saving a new category asks whether the lines the rule already categorized follow it
    v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const r = (j.rules || []).find(x => String(x.id) === b.dataset.edit); if (!r) return;
      const tr = v.querySelector('tr[data-rule="' + r.id + '"]'), was = tr.innerHTML;
      tr.innerHTML = '<td colspan="7"><div class="bk-row rl-add" style="flex-wrap:nowrap"><select class="bk re-kind"><option value="vendor"' + (r.kind === 'vendor' ? ' selected' : '') + '>Vendor is</option><option value="keyword"' + (r.kind === 'keyword' ? ' selected' : '') + '>Description contains</option><option value="none"' + (r.kind === 'none' ? ' selected' : '') + '>No rule for vendor</option></select>' +
        '<input class="bk re-pat" value="' + esc(r.pattern) + '" style="flex:0 0 190px;min-width:0">' + amountCondHtml('re', r.amount_op, r.amount_val, r.side, r.amount_val2) + catSelect(r.category || '', 'recat', 'Category…') +
        '<button class="bk-btn p re-save" style="white-space:nowrap;flex:none">Save</button><button class="bk-btn re-cancel" style="flex:none">Cancel</button><span class="bk-muted re-msg"></span></div></td>';
      tr.querySelector('.re-cancel').onclick = () => { tr.innerHTML = was; loadRules(); };
      noneUi(tr.querySelector('.re-kind'), tr); tr.querySelector('.re-kind').onchange = () => noneUi(tr.querySelector('.re-kind'), tr); amtOpUi(tr);
      tr.querySelector('.re-save').onclick = async () => {
        const kind = tr.querySelector('.re-kind').value, pattern = tr.querySelector('.re-pat').value.trim(), category = tr.querySelector('input.recat').value;
        const amount_op = kind === 'none' ? '' : tr.querySelector('.re-amt-op').value, amount_val = kind === 'none' ? '' : tr.querySelector('.re-amt-val').value, amount_val2 = kind === 'none' ? '' : tr.querySelector('.re-amt-val2').value, side = kind === 'none' ? '' : tr.querySelector('.re-side').value;
        if (!pattern || (kind !== 'none' && !category)) { tr.querySelector('.re-msg').textContent = 'Pattern and category are needed.'; return; }
        let apply = false;
        if (kind !== 'none' && category !== r.category) {
          const sc = await api('/api/bookkeeping/rules/' + r.id + '/scope');
          if (sc.ok && sc.lines > 0) {
            const a = await ask('This rule has already categorized ' + sc.lines + ' bank line' + (sc.lines === 1 ? '' : 's') + ' (' + usd(Math.abs(sc.total || 0)) + ') as ' + r.category + '. Change them to ' + category + ' too, or leave them and only use the new category from now on?',
              { title: 'Re-categorize ' + sc.lines + ' line' + (sc.lines === 1 ? '' : 's') + '?', ok: 'Yes, change all ' + sc.lines, alt: 'No, only new lines' });
            if (a === false) return;
            apply = a === true;
          }
        }
        const res = await post('/api/bookkeeping/rules/' + r.id, { kind, pattern, category, apply, amount_op, amount_val, amount_val2, side });
        if (!res.ok) { tr.querySelector('.re-msg').textContent = res.error || 'Could not save.'; return; }
        await loadRules();
        if (res.applied) { const m = document.createElement('div'); m.className = 'bk-muted'; m.style.padding = '6px 0'; m.textContent = res.applied + ' bank line' + (res.applied === 1 ? '' : 's') + ' re-categorized as ' + category + '.'; v.querySelector('.bk-card table').after(m); }
      };
    });
    $('sSave').onclick = async () => { await post('/api/bookkeeping/settings', { notes: $('sNotes').value, threshold: $('sThr').value }); $('sMsg').textContent = 'Saved.'; await overview(); };
  }

  // ---------------------------------------------------------------- Chart of Accounts (types of expense → sub categories, with colors and icons)
  // One line-icon set (24px grid, stroke 2) so every type and sub category looks the same family; keys are stored in the chart.
  const ICON_PATH = {
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',   // 1.19.136: loan documents
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    printer: '<path d="M6 9V3h12v6"/><rect x="6" y="14" width="12" height="7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    droplet: '<path d="M12 3s-6 6.5-6 11a6 6 0 0 0 12 0c0-4.5-6-11-6-11z"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/>',
    factory: '<path d="M3 21V9l6 4V9l6 4V9l6 4v8z"/><path d="M8 17h2M14 17h2"/>',
    package: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    truck: '<path d="M14 17H3V6h11z"/><path d="M14 9h4l3 3v5h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    car: '<path d="M5 16l1.5-5h11L19 16"/><rect x="3" y="12" width="18" height="6" rx="1"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/>',
    fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M4 11h10"/><path d="M14 9h3l3 3v6a2 2 0 0 1-4 0v-3h-2"/><path d="M2 21h14"/>',
    parking: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 14a6 6 0 1 1 8 0c-1 1-1.5 2-1.5 4h-5c0-2-.5-3-1.5-4z"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0 5.1 5.1L13 18.2a2.1 2.1 0 0 1-3-3l6.8-6.8z"/><path d="M14.7 6.3L17 4l3 3-2.3 2.3"/>',
    sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 14a6 6 0 0 1 4 6"/>',
    hardhat: '<path d="M3 17h18"/><path d="M4 17a8 8 0 0 1 16 0"/><path d="M10 9V6h4v3"/><path d="M2 20h20"/>',
    banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    landmark: '<path d="M3 22h18"/><path d="M5 18V10M9 18V10M15 18V10M19 18V10"/><path d="M3 10l9-6 9 6z"/>',
    gift: '<rect x="3" y="10" width="18" height="11" rx="1"/><path d="M3 10h18"/><path d="M12 10v11"/><path d="M12 10c-2-4-6-4-6-1s4 1 6 1zM12 10c2-4 6-4 6-1s-4 1-6 1z"/>',
    shield: '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    paperclip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
    phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>',
    megaphone: '<path d="M3 10v4l11 4V6z"/><path d="M14 8a4 4 0 0 1 0 8"/><path d="M6 14l1 6h3l-1-6"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    plane: '<path d="M2 14l8-1 4-8 3 1-3 7 7 2v2l-7-1-3 5-2 1 1-6-4-1z"/>',
    utensils: '<path d="M6 3v7a3 3 0 0 0 3 3v8"/><path d="M6 3v7M12 3v7"/><path d="M18 3c-2 2-3 5-3 8h3v10"/>',
    coffee: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v2M12 3v2"/>',
    scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M2 15l3-8 3 8a3 3 0 0 1-6 0zM16 15l3-8 3 8a3 3 0 0 1-6 0z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
    receipt: '<path d="M5 3h14v18l-2-1.5L15 21l-2-1.5L11 21l-2-1.5L7 21l-2-1.5z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    hammer: '<path d="M14 4l6 6-2 2-6-6z"/><path d="M12 6l-9 9 3 3 9-9"/><path d="M16 2l2 2M20 8l2 2"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    arrows: '<path d="M8 7H3M3 7l3-3M3 7l3 3"/><path d="M16 17h5M21 17l-3-3M21 17l-3 3"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    dollar: '<path d="M12 2v20"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    trendup: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    trenddown: '<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
    calculator: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01"/>',
    tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="8" cy="8" r="1.5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    mailopen: '<path d="M3 9.5 12 3l9 6.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m3 9.5 9 6.5 9-6.5"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    book: '<path d="M4 4a2 2 0 0 1 2-2h14v18H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 1 2-2h14"/>',
    cap: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 3 9 3 12 0v-5"/><path d="M22 9v6"/>',
    cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M2 3h3l2.5 11h11l2.5-8H6"/>',
    plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M17 6l3 3M14 9l3 3"/>',
    star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7"/><path d="M12 17h.01"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.5 15.5M8.5 8.5L20 20"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
    box: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M3 11h18"/><path d="M8 7l2-4h4l2 4"/>',
    ruler: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    percent: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
    piggy: '<path d="M4 11a7 7 0 0 1 7-6h3a6 6 0 0 1 6 6v2a4 4 0 0 1-2 3.5V20h-3v-2h-5v2H7v-3.5A5 5 0 0 1 4 13z"/><path d="M2 11h2M16 11h.01"/>',
    bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 10h16M8 18v3M16 18v3"/><path d="M8 14h.01M16 14h.01"/>',
    heart: '<path d="M12 21s-8-5.3-8-11a4.5 4.5 0 0 1 8-2.7A4.5 4.5 0 0 1 20 10c0 5.7-8 11-8 11z"/>',
    leaf: '<path d="M4 20c0-9 6-15 16-16 0 10-6 16-16 16z"/><path d="M4 20c4-4 7-7 10-10"/>',
    // 1.19.50
    roll: '<circle cx="7" cy="12" r="4"/><circle cx="7" cy="12" r="1"/><path d="M7 8h9a4 4 0 0 1 0 8h-1"/><path d="M11 16h10v3H11z"/>',
    sheets: '<path d="M9 3h11v12H9z"/><path d="M6.5 6.5v12h11"/><path d="M4 10v11h11"/>',
    carton: '<path d="M3 8l9-4 9 4-9 4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/><path d="M7.5 6l9 4"/>',
    smallcar: '<path d="M5 14l1.5-4a2 2 0 0 1 1.9-1.3h7.2a2 2 0 0 1 1.9 1.3L19 14"/><rect x="3" y="14" width="18" height="4" rx="1.5"/><circle cx="7.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/>',
    tape: '<circle cx="10" cy="12" r="7"/><circle cx="10" cy="12" r="2.5"/><path d="M17 12v4h5"/>',
    broom: '<path d="M19 3l-8 8"/><path d="M11 11l-4 4 2 2 4-4z"/><path d="M7 15l-4 6h6l2-3"/><path d="M5 18l3 3"/>',
    spray: '<path d="M8 10h7l1 11H7z"/><path d="M9 10V7h5v3"/><path d="M11.5 7V4h4"/><path d="M18 4l3-1M18 6l3 1"/>',
    shieldcheck: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    usershield: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 9-5"/><path d="M17 12l4 1.5v3c0 2.5-1.8 4.3-4 5-2.2-.7-4-2.5-4-5v-3z"/>',
    carshield: '<path d="M3 14l1.5-4.5A2 2 0 0 1 6.4 8H13"/><path d="M2 14h10v4H4"/><circle cx="6" cy="18" r="1.5"/><path d="M17 10l4 1.5v3c0 2.5-1.8 4.3-4 5-2.2-.7-4-2.5-4-5v-3z"/>',
    carwrench: '<path d="M3 14l1.5-4.5A2 2 0 0 1 6.4 8H12"/><path d="M2 14h9v4H4"/><circle cx="6" cy="18" r="1.5"/><path d="M21 8a3.5 3.5 0 0 1-4.6 3.3L13 14.7l-1.7-1.7 3.4-3.4A3.5 3.5 0 0 1 18 5l-1.5 1.5 1 1z"/>',
    pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
    store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v9h14v-9"/><path d="M10 21v-6h4v6"/>',
    ticket: '<path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M13 7v10" stroke-dasharray="2 2"/>',
    tent: '<path d="M3 20L12 4l9 16"/><path d="M12 4v16"/><path d="M8 20l4-7 4 7"/>',
    bricks: '<rect x="3" y="5" width="18" height="14"/><path d="M3 10h18M3 15h18"/><path d="M9 5v5M15 5v5M6 10v5M12 10v5M18 10v5M9 15v4M15 15v4"/>',
    crane: '<path d="M4 21h16"/><path d="M8 21V7l12-4"/><path d="M8 7H4"/><path d="M15 5.5V11"/><path d="M13 11h4"/><path d="M8 11l5 10"/>',
    // 1.19.126: a credit card (chip + stripe) and a card terminal with a card swiping through it
    creditcard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 9h20"/><rect x="5" y="12" width="4" height="3" rx=".5"/><path d="M15 15h4" stroke-linecap="round"/>',
    terminal: '<rect x="5" y="9" width="14" height="13" rx="2"/><path d="M8 13h8" stroke-linecap="round"/><path d="M8 16.5h2M11.5 16.5h2M15 16.5h1" stroke-linecap="round"/><path d="M8 9V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V9"/><path d="M8 6h8"/>',
    // 1.19.125: apparel and promotional products
    tshirt: '<path d="M8 3l4 2 4-2 5 4-3 3-2-1v12H8V9l-2 1-3-3z"/>',
    promo: '<path d="M7 8h10l1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><path d="M4 4l1.5 1.5M20 4l-1.5 1.5M12 2v1.5" stroke-linecap="round"/><path d="M10 14h4" stroke-linecap="round"/>',
    // 1.19.122: country flags for the chart (the overseas team's categories) — drawn with their own fills, so the type's colour
    // tints only the tile around them
    flag_am: '<g stroke="none"><rect x="2" y="5" width="20" height="4.67" rx="1" fill="#d90012"/><rect x="2" y="9.67" width="20" height="4.66" fill="#0033a0"/><rect x="2" y="14.33" width="20" height="4.67" rx="1" fill="#f2a800"/></g><rect x="2" y="5" width="20" height="14" rx="1.5" stroke="rgba(0,0,0,.25)" stroke-width="1"/>',
    flag_mx: '<g stroke="none"><rect x="2" y="5" width="6.67" height="14" rx="1" fill="#006847"/><rect x="8.67" y="5" width="6.66" height="14" fill="#fff"/><rect x="15.33" y="5" width="6.67" height="14" rx="1" fill="#ce1126"/><circle cx="12" cy="12" r="2" fill="#8a6a2b"/></g><rect x="2" y="5" width="20" height="14" rx="1.5" stroke="rgba(0,0,0,.25)" stroke-width="1"/>',
    flag_ph: '<g stroke="none"><rect x="2" y="5" width="20" height="7" rx="1" fill="#0038a8"/><rect x="2" y="12" width="20" height="7" rx="1" fill="#ce1126"/><path d="M2 5l10 7-10 7z" fill="#fff"/><circle cx="5.4" cy="12" r="1.6" fill="#fcd116"/></g><rect x="2" y="5" width="20" height="14" rx="1.5" stroke="rgba(0,0,0,.25)" stroke-width="1"/>'
  };
  const ICONS = Object.keys(ICON_PATH);
  // words the picker's search box also matches (the key itself always matches)
  const ICON_WORDS = { creditcard: 'credit card visa mastercard amex merchant fees card payment', terminal: 'terminal pos swipe card reader square clover point of sale merchant', tshirt: 'tshirt t-shirt shirt apparel clothing garment embroidery screen printing merch', promo: 'promo promotional products swag merch giveaway mug tote bag branded items', flag_am: 'armenia armenian flag yerevan overseas team', flag_mx: 'mexico mexican flag overseas team', flag_ph: 'philippines filipino flag manila overseas team', heart: 'employee benefits health', roll: 'rolls paper roll vinyl media', sheets: 'materials paper sheets stock', carton: 'box boxes packaging shipping', package: 'box boxes parcel', box: 'storage chest', smallcar: 'uber lyft rideshare taxi ride', car: 'van vehicle', truck: 'delivery freight', tape: 'supplies tape', paperclip: 'supplies office', broom: 'janitorial cleaning clean', spray: 'janitorial cleaning clean', shield: 'insurance', shieldcheck: 'business insurance liability', usershield: 'workers comp insurance people employees', carshield: 'car auto vehicle insurance', wrench: 'repairs maintenance', carwrench: 'vehicle repairs auto car maintenance', pin: 'local marketing location map', store: 'local marketing shop storefront retail', megaphone: 'marketing ads advertising', ticket: 'events expo trade show', tent: 'events expo booth trade show', bricks: 'leasehold improvements construction building wall', crane: 'leasehold improvements construction building', hammer: 'construction repairs', hardhat: 'construction safety', banknote: 'cash money', dollar: 'money income', users: 'people team staff', cap: 'education training', utensils: 'meals food', coffee: 'meals food', plane: 'travel', fuel: 'gas', parking: 'parking', zap: 'electricity utilities power', droplet: 'water ink utilities', bulb: 'ideas utilities', phone: 'telephone', globe: 'web internet', laptop: 'computer software', monitor: 'computer software', calendar: 'date subscriptions', receipt: 'bills', card: 'card id badge fees', landmark: 'bank taxes government', scale: 'legal', gift: 'gifts donations', percent: 'discount interest', piggy: 'savings', bus: 'transit', leaf: 'green', cart: 'purchases shopping', key: 'rent keys', home: 'rent office', building: 'rent office' };
  const LEGACY_ICON = { '🖨️': 'printer', '📄': 'file', '🎨': 'droplet', '🧰': 'briefcase', '🏭': 'factory', '📦': 'package', '🚚': 'truck', '🚐': 'car', '⛽': 'fuel', '🅿️': 'parking', '🏠': 'home', '🏢': 'building', '⚡': 'zap', '💡': 'bulb', '🛠️': 'wrench', '🧹': 'sparkles', '👥': 'users', '👷': 'hardhat', '💰': 'banknote', '🏛️': 'landmark', '🎁': 'gift', '🛡️': 'shield', '💻': 'laptop', '📎': 'paperclip', '📞': 'phone', '🌐': 'globe', '📣': 'megaphone', '🎯': 'target', '✈️': 'plane', '🍽️': 'utensils', '☕': 'coffee', '⚖️': 'scale', '🏦': 'landmark', '💳': 'card', '🧾': 'receipt', '🏗️': 'hammer', '🖥️': 'monitor', '↔️': 'arrows', '↩️': 'undo', '💵': 'dollar', '📈': 'trendup', '📉': 'trenddown', '🧮': 'calculator', '🔧': 'wrench', '🏷️': 'tag', '📬': 'mail', '🗂️': 'folder', '📚': 'book', '🎓': 'cap', '🚗': 'car', '🛒': 'cart', '🔌': 'plug', '🔑': 'key', '⭐': 'star', '❓': 'help' };
  const iconKey = (ic) => ICON_PATH[ic] ? ic : (LEGACY_ICON[ic] || '');
  const iconSvg = (ic) => { const k = iconKey(ic); return k ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON_PATH[k] + '</svg>' : ''; };
  // The tile: a light tint of the color with the color as border and icon — the CRM's pill look.
  const tile = (color, ic, cls, fallback) => '<span class="coa-ic ' + (cls || '') + '" style="--c:' + esc(color || '#64748b') + '">' + (iconSvg(ic) || '<b>' + esc(fallback || '') + '</b>') + '</span>';
  // Lighter "tech" palette (text/border colors; the tint is derived).
  const PALETTE = ['#2563eb', '#0ea5e9', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#8b5cf6', '#64748b', '#0d9488', '#d946ef'];
  let coa = null, coaSel = 0, coaUsage = {}, coaTimer = null;
  const styleOf = (name) => { const t = chart.find(c => !c.parent && c.name === name) || chart.find(c => c.name === name); return t ? { color: t.color || '#64748b', icon: t.icon || '' } : { color: '#64748b', icon: '' }; };
  async function loadChart() {
    const v = $('vChart');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/chart');
    coa = j.tree || []; coaUsage = j.usage || {}; if (coaSel >= coa.length) coaSel = 0;
    v.innerHTML = '<div class="coa-status" id="coaStatus" style="min-height:0;margin:0 0 6px"></div>' +
      '<div class="coa"><div class="coa-list" id="coaList"></div><div class="coa-edit" id="coaEdit"></div></div>';
    drawChart();
  }
  const useText = (u) => u ? [u.txns && u.txns + ' txn' + (u.txns === 1 ? '' : 's'), u.rules && u.rules + ' rule' + (u.rules === 1 ? '' : 's'), u.vendors && u.vendors + ' vendor' + (u.vendors === 1 ? '' : 's')].filter(Boolean).join(' · ') : '';
  const inUse = (n) => { const u = coaUsage[n]; return !!(u && (u.txns || u.rules || u.vendors)); };
  // The per-sub-category delivery toggle: effective value (own, or inherited from the level above), click flips it to an explicit choice.
  const effDeliv = (node, up) => node.delivery == null ? (up.delivery == null ? 0 : (up.delivery ? 1 : 0)) : (node.delivery ? 1 : 0);
  const delivBtn = (node, up, key, ref) => { const on = effDeliv(node, up), own = node.delivery != null; return '<button type="button" class="coa-dl' + (on ? ' on' : '') + (own ? ' own' : '') + '" data-' + key + '="' + ref + '" title="' + (on ? 'Expects delivery' : 'No delivery (a service)') + (own ? '' : ' — same as ' + esc(up.name) + '; click to set it for this one') + '">' + iconSvg('package') + '</button>'; };
  function drawChart() {
    const list = $('coaList'), ed = $('coaEdit'); if (!list) return;
    list.innerHTML = coa.map((t, i) => '<div class="coa-t' + (i === coaSel ? ' on' : '') + '" data-i="' + i + '">' + tile(t.color, t.icon, '', t.name.charAt(0)) + '<span class="nm">' + esc(t.name) + '<small>' + (t.children.length ? t.children.length + ' sub categor' + (t.children.length === 1 ? 'y' : 'ies') : 'used as is') + '</small></span>' +
      '<span class="coa-mv"><button data-up="' + i + '" title="Move up"' + (i ? '' : ' disabled') + '>▲</button><button data-down="' + i + '" title="Move down"' + (i < coa.length - 1 ? '' : ' disabled') + '>▼</button></span></div>').join('') +
      '<div class="coa-add"><input class="bk" id="coaNewType" placeholder="New type of expense…"><button class="bk-btn sm p" id="coaAddType">Add</button></div>';
    list.querySelectorAll('.coa-t').forEach(el => el.onclick = (e) => { if (e.target.closest('button')) return; coaSel = Number(el.dataset.i); drawChart(); });
    list.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = Number(b.dataset.up); [coa[i - 1], coa[i]] = [coa[i], coa[i - 1]]; coaSel = i - 1; drawChart(); saveChart(); });
    list.querySelectorAll('[data-down]').forEach(b => b.onclick = () => { const i = Number(b.dataset.down); [coa[i + 1], coa[i]] = [coa[i], coa[i + 1]]; coaSel = i + 1; drawChart(); saveChart(); });
    const addType = () => { const n = $('coaNewType').value.trim(); if (!n) return; if (coa.some(t => t.name === n)) { status('That type already exists.', true); return; } coa.push({ name: n, color: PALETTE[coa.length % PALETTE.length], icon: '', children: [] }); coaSel = coa.length - 1; drawChart(); saveChart(); };
    $('coaAddType').onclick = addType; $('coaNewType').onkeydown = (e) => { if (e.key === 'Enter') addType(); };
    const t = coa[coaSel];
    if (!t) { ed.innerHTML = '<div class="bk-muted">Add a type of expense on the left.</div>'; return; }
    ed.innerHTML = '<div class="coa-head"><button class="coa-big" id="coaIcon" title="Change icon">' + tile(t.color, t.icon, 'big', t.name.charAt(0)) + '</button><input class="name" id="coaName" value="' + esc(t.name) + '" title="Rename the type"></div>' +
      '<div class="bk-muted" style="margin-bottom:4px">Color</div><div class="coa-colors">' + PALETTE.map(c => '<span class="coa-sw' + (c === t.color ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '"></span>').join('') + '<input type="color" id="coaCustom" value="' + esc(t.color) + '" title="Any color"></div>' +
      '<label class="bk-row" style="gap:8px;align-items:center;margin:10px 0 12px;font-size:13px"><input type="checkbox" id="coaDeliv"' + (t.delivery ? ' checked' : '') + '> Expects delivery <span class="bk-muted">— the default for every sub category below (each has its own 📦 toggle); money here buys goods that must arrive; purchases get a receiving status and show under Not received</span></label>' +
      '<label class="bk-row" style="gap:8px;align-items:center;margin:-6px 0 12px;font-size:13px"><input type="checkbox" id="coaIncome"' + (t.income ? ' checked' : '') + '> Money in (income) <span class="bk-muted">— deposits and payments received get only this type\'s categories in the Bank feed, and the AI never files money out here</span></label>' +
      '<div class="bk-muted" style="margin-bottom:4px">Sub categories' + (t.children.length ? '' : ' <span class="bk-dim">— none yet: the type itself is used on transactions until you add some</span>') + '</div>' +
      '<div id="coaKids">' + t.children.map((k, i) => '<div class="coa-k" data-k="' + i + '"><span data-kicon="' + i + '" title="Icon">' + tile(t.color, k.icon, iconKey(k.icon) ? '' : 'empty', '·') + '</span><input class="kn" value="' + esc(k.name) + '">' + delivBtn(k, t, 'kdel2', i) + '<span class="use">' + esc(useText(coaUsage[k.name])) + '</span>' +
        '<span class="coa-mv"><button data-kup="' + i + '"' + (i ? '' : ' disabled') + '>▲</button><button data-kdown="' + i + '"' + (i < t.children.length - 1 ? '' : ' disabled') + '>▼</button></span><button class="del" data-kdel="' + i + '" title="' + (inUse(k.name) ? 'In use — rename it instead' : 'Remove') + '"' + (inUse(k.name) ? ' disabled' : '') + '>×</button></div>' +
        ((k.children || []).map((g, gi) => '<div class="coa-k coa-g" data-k="' + i + '" data-g="' + gi + '"><span class="coa-gl"></span><span data-gicon="' + i + ':' + gi + '" title="Icon">' + tile(t.color, g.icon, iconKey(g.icon) ? '' : 'empty', '·') + '</span><input class="gn" value="' + esc(g.name) + '">' + delivBtn(g, k.delivery == null ? t : k, 'gdel2', i + ':' + gi) + '<span class="use">' + esc(useText(coaUsage[g.name])) + '</span>' +
          '<span class="coa-mv"><button data-gup="' + i + ':' + gi + '"' + (gi ? '' : ' disabled') + '>▲</button><button data-gdown="' + i + ':' + gi + '"' + (gi < k.children.length - 1 ? '' : ' disabled') + '>▼</button></span><button class="del" data-gdel="' + i + ':' + gi + '" title="' + (inUse(g.name) ? 'In use — rename it instead' : 'Remove') + '"' + (inUse(g.name) ? ' disabled' : '') + '>×</button></div>').join('')) +
        '<div class="coa-k coa-g coa-gadd" data-k="' + i + '"><span class="coa-gl"></span><input class="bk" data-gnew="' + i + '" placeholder="+ sub category under ' + esc(k.name) + '…"></div>').join('') + '</div>' +
      '<div class="coa-foot"><input class="bk" id="coaNewKid" placeholder="New sub category under ' + esc(t.name) + '…"><button class="bk-btn sm p" id="coaAddKid">Add</button></div>' +
      '<div class="coa-foot" style="border-top:0;margin-top:6px;justify-content:flex-end"><button class="bk-btn sm bad" id="coaDelType"' + (t.children.some(k => inUse(k.name)) || inUse(t.name) ? ' disabled title="Some of it is in use"' : '') + '>Delete this type</button></div>';
    $('coaIcon').onclick = (e) => iconPicker(e.currentTarget, t.icon, (ic) => { t.icon = ic; drawChart(); saveChart(); });
    $('coaDeliv').onchange = () => { t.delivery = $('coaDeliv').checked ? 1 : 0; saveChart(); };
    $('coaIncome').onchange = () => { t.income = $('coaIncome').checked ? 1 : 0; saveChart(); };
    ed.querySelectorAll('.coa-sw').forEach(sw => sw.onclick = () => { t.color = sw.dataset.c; drawChart(); saveChart(); });
    $('coaCustom').oninput = (e) => { t.color = e.target.value; ed.querySelectorAll('.coa-ic').forEach(el => el.style.setProperty('--c', t.color)); };
    $('coaCustom').onchange = () => { drawChart(); saveChart(); };
    $('coaName').onchange = () => rename(t.name, $('coaName').value.trim(), true);
    ed.querySelectorAll('input.kn').forEach(inp => inp.onchange = () => { const i = Number(inp.closest('.coa-k').dataset.k); rename(t.children[i].name, inp.value.trim(), false); });
    ed.querySelectorAll('[data-kicon]').forEach(el => el.onclick = (e) => { const i = Number(el.dataset.kicon); iconPicker(e.currentTarget, t.children[i].icon, (ic) => { t.children[i].icon = ic; drawChart(); saveChart(); }); });
    ed.querySelectorAll('[data-kup]').forEach(b => b.onclick = () => { const i = Number(b.dataset.kup); [t.children[i - 1], t.children[i]] = [t.children[i], t.children[i - 1]]; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-kdown]').forEach(b => b.onclick = () => { const i = Number(b.dataset.kdown); [t.children[i + 1], t.children[i]] = [t.children[i], t.children[i + 1]]; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-kdel2]').forEach(b => b.onclick = () => { const k = t.children[Number(b.dataset.kdel2)]; k.delivery = effDeliv(k, t) ? 0 : 1; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-gdel2]').forEach(b => b.onclick = () => { const [i, gi] = b.dataset.gdel2.split(':').map(Number); const k = t.children[i], g = k.children[gi]; g.delivery = effDeliv(g, k.delivery == null ? t : k) ? 0 : 1; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-kdel]').forEach(b => b.onclick = async () => { const i = Number(b.dataset.kdel); if ((t.children[i].children || []).some(g => inUse(g.name))) { status('A sub category under it is in use.', true); return; } if (!await ask('Remove "' + t.children[i].name + '"' + ((t.children[i].children || []).length ? ' and its ' + t.children[i].children.length + ' sub categories' : '') + '?')) return; t.children.splice(i, 1); drawChart(); saveChart(); });
    // third level
    const gref = (b, key) => { const [i, gi] = b.dataset[key].split(':').map(Number); return { k: t.children[i], i, gi }; };
    ed.querySelectorAll('input.gn').forEach(inp => inp.onchange = () => { const row = inp.closest('.coa-k'); const g = t.children[Number(row.dataset.k)].children[Number(row.dataset.g)]; rename(g.name, inp.value.trim(), false); });
    ed.querySelectorAll('[data-gicon]').forEach(el => el.onclick = (e) => { const { k, gi } = gref(el, 'gicon'); iconPicker(e.currentTarget, k.children[gi].icon, (ic) => { k.children[gi].icon = ic; drawChart(); saveChart(); }); });
    ed.querySelectorAll('[data-gup]').forEach(b => b.onclick = () => { const { k, gi } = gref(b, 'gup'); [k.children[gi - 1], k.children[gi]] = [k.children[gi], k.children[gi - 1]]; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-gdown]').forEach(b => b.onclick = () => { const { k, gi } = gref(b, 'gdown'); [k.children[gi + 1], k.children[gi]] = [k.children[gi], k.children[gi + 1]]; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-gdel]').forEach(b => b.onclick = async () => { const { k, gi } = gref(b, 'gdel'); if (!await ask('Remove "' + k.children[gi].name + '"?')) return; k.children.splice(gi, 1); drawChart(); saveChart(); });
    ed.querySelectorAll('[data-gnew]').forEach(inp => inp.onkeydown = (e) => { if (e.key !== 'Enter') return; const n = inp.value.trim(); if (!n) return; const k = t.children[Number(inp.dataset.gnew)]; if (categories.indexOf(n) > -1 || coa.some(x => x.name === n || x.children.some(c => c.name === n || (c.children || []).some(g => g.name === n)))) { status('"' + n + '" is already in the chart.', true); return; } k.children = k.children || []; k.children.push({ name: n, icon: '' }); drawChart(); saveChart(); setTimeout(() => { const nx = ed.querySelector('[data-gnew="' + t.children.indexOf(k) + '"]'); if (nx) nx.focus(); }, 0); });
    const addKid = () => { const n = $('coaNewKid').value.trim(); if (!n) return; if (categories.indexOf(n) > -1 || t.children.some(k => k.name === n)) { status('"' + n + '" is already in the chart.', true); return; } t.children.push({ name: n, icon: '' }); drawChart(); saveChart(); setTimeout(() => $('coaNewKid') && $('coaNewKid').focus(), 0); };
    $('coaAddKid').onclick = addKid; $('coaNewKid').onkeydown = (e) => { if (e.key === 'Enter') addKid(); };
    $('coaDelType').onclick = async () => { if (!await ask('Delete the type "' + t.name + '" and its sub categories?')) return; coa.splice(coaSel, 1); coaSel = Math.max(0, coaSel - 1); drawChart(); saveChart(); };
  }
  function status(msg, err) { const el = $('coaStatus'); if (!el) return; el.textContent = msg; el.className = 'coa-status' + (err ? ' err' : ''); if (!err) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500); }
  function saveChart() {
    clearTimeout(coaTimer); status('Saving…');
    coaTimer = setTimeout(async () => {
      const r = await post('/api/bookkeeping/chart', { tree: coa });
      if (!r.ok) { status(r.error, true); loadChart(); return; }
      // keep the local objects (the open editor's handlers point at them); the server echo only refreshes the pickers
      chart = r.chart; ov.chart = r.chart; categories = chart.filter(c => c.parent || !c.children).map(c => c.name).filter((n, i, a) => a.indexOf(n) === i);
      status('Saved ✓');
    }, 350);
  }
  async function rename(from, to, isType) {
    if (!to || to === from) { drawChart(); return; }
    if (categories.indexOf(to) > -1 || coa.some(t => t.name === to)) { status('"' + to + '" already exists.', true); drawChart(); return; }
    clearTimeout(coaTimer);
    const r = await post('/api/bookkeeping/chart/rename', { from, to });
    if (!r.ok) { status(r.error, true); return; }
    coa = r.tree; chart = r.chart; ov.chart = r.chart; categories = chart.filter(c => c.parent || !c.children).map(c => c.name).filter((n, i, a) => a.indexOf(n) === i);
    if (coaUsage[from]) { coaUsage[to] = coaUsage[from]; delete coaUsage[from]; }
    status('Renamed ✓' + (!isType && coaUsage[to] && (coaUsage[to].txns || coaUsage[to].rules) ? ' — updated on ' + useText(coaUsage[to]) : ''));
    drawChart();
  }
  function iconPicker(anchor, cur, onPick) {
    document.querySelectorAll('.ico-pop').forEach(p => p.remove());
    const pop = document.createElement('div'); pop.className = 'ico-pop';
    pop.innerHTML = '<input type="text" class="bk ico-q" placeholder="Search icons…"><div class="ico-grid">' + ICONS.map(i => '<button type="button" data-i="' + i + '" title="' + i + (ICON_WORDS[i] ? ' — ' + ICON_WORDS[i] : '') + '"' + (i === iconKey(cur) ? ' class="on"' : '') + '>' + iconSvg(i) + '</button>').join('') + '</div><div class="ico-none bk-muted" hidden>Nothing matches</div><button type="button" class="none">No icon</button>';
    document.body.appendChild(pop);
    const q = pop.querySelector('.ico-q'); q.focus();
    q.oninput = () => {
      const f = q.value.trim().toLowerCase(); let n = 0;
      pop.querySelectorAll('[data-i]').forEach(b => { const k = b.dataset.i, hit = !f || (k + ' ' + (ICON_WORDS[k] || '')).indexOf(f) > -1; b.style.display = hit ? '' : 'none'; if (hit) n++; });
      pop.querySelector('.ico-none').hidden = n > 0;
    };
    q.onkeydown = (e) => { if (e.key === 'Enter') { const b = Array.from(pop.querySelectorAll('[data-i]')).find(x => x.style.display !== 'none'); if (b) b.click(); } if (e.key === 'Escape') close(); };
    // 1.19.52: under the icon, left-aligned with it; the grid shrinks to the room there is (or opens above when that is roomier)
    const r = anchor.getBoundingClientRect(), grid = pop.querySelector('.ico-grid');
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    const below = window.innerHeight - r.bottom - 14, above = r.top - 14, other = pop.offsetHeight - grid.offsetHeight;
    if (below >= 240 || below >= above) { grid.style.maxHeight = Math.max(120, Math.min(300, below - other)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; }
    else { grid.style.maxHeight = Math.max(120, Math.min(300, above - other)) + 'px'; pop.style.top = Math.max(8, r.top - 6 - pop.offsetHeight) + 'px'; }
    const close = () => { pop.remove(); document.removeEventListener('click', away, true); };
    const away = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
    setTimeout(() => document.addEventListener('click', away, true), 0);
    pop.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { onPick(b.dataset.i); close(); });
    pop.querySelector('.none').onclick = () => { onPick(''); close(); };
  }

  // ---------------------------------------------------------------- Suppliers & vendors (the CRM directory + vendors seen on bills)
  // ---------------------------------------------------------------- Nova vendors (1.19.63): companies kept only in Nova
  function novaVendorForm(init, onSaved) {
    init = init || {}; const isEdit = !!init.id; let d = {}; try { d = init.details ? JSON.parse(init.details) : {}; } catch (e) {}
    const el = document.createElement('div'); el.className = 'bk-modal';
    const F = (id, label, val, ph, type) => '<label class="nv-f"><span class="bk-muted">' + label + '</span><input class="bk" id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"></label>';
    // 1.19.86: the explanation sits behind a small (?) beside the title instead of a paragraph above the form
    el.innerHTML = '<div class="bk-modal-box" style="width:min(620px,100%)"><div class="bk-modal-title" style="margin-bottom:12px">' + (isEdit ? 'Edit ' + esc(init.name) : 'New Nova vendor') + ' ' + qHelp('novavendor', 'Nova vendor', 'A company kept in Nova only — not in the CRM supplier / vendor lists. The chart of accounts is its map: say what you buy from them and the usual category, and the AI files their lines there.') + '</div>' +
      // 1.19.77: the logo — the bank's merchant logo when one was picked up, a URL, or a picture uploaded here (shrunk to 160px)
      '<div class="nv-photo"><div class="nv-photo-box" id="nvPhotoBox">' + (init.photo ? '<img src="' + esc(init.photo) + '" alt="">' : '<span class="bk-logo ph">' + esc(String(init.name || '?').charAt(0).toUpperCase()) + '</span>') + '</div><div class="nv-photo-f"><span class="bk-muted">Logo / photo</span><div class="bk-row" style="gap:6px;flex-wrap:nowrap"><input class="bk" id="nvPhoto" value="' + esc(/^data:/.test(init.photo || '') ? '' : (init.photo || '')) + '" placeholder="https://… — or paste (Ctrl+V), drop or upload a picture"><button type="button" class="bk-btn sm" id="nvUpload">Upload</button><button type="button" class="bk-btn sm" id="nvNoPhoto" title="Remove the picture">×</button></div><input type="file" id="nvFile" accept="image/*" hidden></div></div>' +
      '<div class="nv-grid">' + F('nvName', 'Company', init.name, 'HEVAC Inc') + F('nvWeb', 'Website', d.website || init.website, 'linkedin.com') + F('nvEmail', 'Email', init.email, 'billing@…', 'email') + F('nvPhone', 'Phone', init.phone, '') + F('nvContact', 'Contact person', init.contact, '') + F('nvAddr', 'Address', init.address, '') + '</div>' +
      '<label class="nv-f"><span class="bk-muted">What we buy from them</span><input class="bk" id="nvSpec" value="' + esc(init.specialty || '') + '" placeholder="Rent for the shop · Job ads · Cleaning twice a month"></label>' +
      '<div class="nv-f"><span class="bk-muted">Usual category (chart of accounts)</span><div id="nvCat">' + catSelect(init.default_category || '', 'nvcat', 'not set', { multi: true }) + '</div></div>' +
      F('nvAlias', 'On the bank statement as', String(init.aliases || '').split('\n').join(' | '), 'HEVAC INC | HEVAC*RENT — separate with |') +
      '<label class="nv-f"><span class="bk-muted">Notes</span><textarea class="bk" id="nvNotes" rows="2">' + esc(init.notes || '') + '</textarea></label>' +
      '<div class="bk-row nv-acts"><button class="bk-btn p" id="nvSave">' + (isEdit ? 'Save' : 'Add vendor') + '</button><button class="bk-btn bk-x">Cancel</button><span class="bk-muted" id="nvMsg"></span></div></div>';
    const close = () => el.remove();
    el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.body.appendChild(el); el.querySelector('#nvName').focus();
    let photo = init.photo || '';
    const showPhoto = () => { el.querySelector('#nvPhotoBox').innerHTML = photo ? '<img src="' + esc(photo) + '" alt="">' : '<span class="bk-logo ph">' + esc(String(el.querySelector('#nvName').value || '?').charAt(0).toUpperCase()) + '</span>'; };
    el.querySelector('#nvPhoto').onchange = () => { const u = el.querySelector('#nvPhoto').value.trim(); if (!u || /^https?:\/\//.test(u)) { photo = u; showPhoto(); } };
    el.querySelector('#nvNoPhoto').onclick = () => { photo = ''; el.querySelector('#nvPhoto').value = ''; showPhoto(); };
    el.querySelector('#nvUpload').onclick = () => el.querySelector('#nvFile').click();
    // a picked, pasted (Ctrl+V anywhere in the form) or dropped picture: cropped to a centred square, shrunk to 160px
    const takeImage = (f) => {
      if (!f || !/^image\//.test(f.type)) return;
      const img = new Image(); img.onload = () => {
        const S = 160, c = document.createElement('canvas'); c.width = S; c.height = S; const g = c.getContext('2d');
        const side = Math.min(img.width, img.height), sx = Math.round((img.width - side) / 2), sy = Math.round((img.height - side) / 2);
        g.fillStyle = '#fff'; g.fillRect(0, 0, S, S); g.drawImage(img, sx, sy, side, side, 0, 0, S, S);
        photo = c.toDataURL('image/png'); el.querySelector('#nvPhoto').value = ''; showPhoto(); URL.revokeObjectURL(img.src);
        el.querySelector('#nvMsg').textContent = '';
      };
      img.src = URL.createObjectURL(f);
    };
    el.querySelector('#nvFile').onchange = () => takeImage(el.querySelector('#nvFile').files[0]);
    el.addEventListener('paste', (ev) => {
      const it = Array.from((ev.clipboardData || {}).items || []).find(x => /^image\//.test(x.type));
      if (it) { ev.preventDefault(); takeImage(it.getAsFile()); }
    });
    const box = el.querySelector('#nvPhotoBox');
    box.ondragover = (ev) => { ev.preventDefault(); box.classList.add('over'); }; box.ondragleave = () => box.classList.remove('over');
    box.ondrop = (ev) => { ev.preventDefault(); box.classList.remove('over'); takeImage(ev.dataTransfer.files && ev.dataTransfer.files[0]); };
    el.querySelector('#nvSave').onclick = async (ev) => {
      let force = false;
      const body = { photo, name: el.querySelector('#nvName').value.trim(), website: el.querySelector('#nvWeb').value.trim(), email: el.querySelector('#nvEmail').value.trim(), phone: el.querySelector('#nvPhone').value.trim(), contact: el.querySelector('#nvContact').value.trim(), address: el.querySelector('#nvAddr').value.trim(),
        specialty: el.querySelector('#nvSpec').value.trim(), default_category: el.querySelector('#nvCat .ckp-val').value, aliases: el.querySelector('#nvAlias').value.split('|').map(x => x.trim()).filter(Boolean).join('\n'), notes: el.querySelector('#nvNotes').value.trim() };
      if (!body.name) { el.querySelector('#nvMsg').textContent = 'Give the company a name.'; return; }
      if (ev.target.dataset.force) { body.force = true; }
      const r = await post(isEdit ? '/api/bookkeeping/vendors/' + init.id : '/api/bookkeeping/vendors', body);
      if (!r.ok) { el.querySelector('#nvMsg').textContent = r.error + (r.duplicate ? ' — click again to add anyway.' : ''); if (r.duplicate) ev.target.dataset.force = '1'; return; }
      close(); if (onSaved) onSaved(r.vendor || Object.assign({}, init, body));
    };
  }
  // 1.19.69: open a vendor from anywhere — Nova / bill vendors get the edit form, CRM companies a details card
  async function vendorCard(id, onDone) {
    const j = await api('/api/bookkeeping/directory?fresh=0');
    const x = (j.vendors || []).find(v => v.id === id); if (!x) { alert('Vendor not found'); return; }
    if (x.source === 'nova' || x.source === 'bill') return novaVendorForm(x, onDone);
    let d = {}; try { d = JSON.parse(x.details || '{}') || {}; } catch (e) {}
    const line = (k, val) => val ? '<div class="bk-dl"><span>' + esc(k) + '</span><div>' + val + '</div></div>' : '';
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(520px,100%)"><div class="bk-modal-head">' + (x.photo ? '<img class="bk-logo" src="' + esc(x.photo) + '" alt="">' : '<span class="bk-logo ph">' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>') + '<div><div class="bk-modal-title">' + esc(x.name) + '</div><div><span class="bk-src ' + esc(x.kind || '') + '">' + esc(x.kind || '') + '</span></div></div></div>' +
      line('Contact', esc(x.contact || '')) + line('Email', esc(x.email || '')) + line('Phone', esc(x.phone || '')) + line('Specialty', esc(x.specialty || '')) + line('Address', esc([d.address, d.city, d.state, d.zip].filter(Boolean).join(', '))) +
      '<div class="nv-f" style="margin-top:10px"><span class="bk-muted">Usual category (Nova)</span><div id="vcCat">' + catSelect(x.default_category || '', 'vccat', 'not set', { multi: true }) + '</div></div>' +
      '<label class="nv-f"><span class="bk-muted">On the bank statement as (Nova)</span><input class="bk" id="vcAlias" value="' + esc(String(x.aliases || '').split('\n').join(' | ')) + '" placeholder="separate with |"></label>' +
      '<div class="bk-muted" style="margin-top:8px">From the CRM ' + esc(d.list || x.source || '') + ' list — name and contacts are edited in the CRM; the category and bank names live here.</div>' +
      '<div class="bk-row" style="margin-top:12px"><button class="bk-btn p" id="vcSave">Save</button><button class="bk-btn bk-x">Close</button></div></div>';
    const close = () => el.remove(); el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.body.appendChild(el);
    el.querySelector('#vcSave').onclick = async () => { const r = await post('/api/bookkeeping/vendors/' + x.id, { default_category: el.querySelector('#vcCat .ckp-val').value, aliases: el.querySelector('#vcAlias').value.split('|').map(t => t.trim()).filter(Boolean).join('\n') }); if (!r.ok) return alert(r.error); learnedNote(r, x.name); close(); if (onDone) onDone(); };
  }
  async function loadNovaVendors() {
    const v = $('vNova');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/vendors/nova');
    const rows = j.vendors || [];
    const web = (x) => (x.bank && x.bank.website) || (() => { let d = {}; try { d = JSON.parse(x.details || '{}') || {}; } catch (e) {} return d.website || ''; })();
    const prettyPC = (c) => { const w = String(c || '').toLowerCase().split('_').filter(Boolean); return w.length ? w.join(' ').replace(/^./, ch => ch.toUpperCase()) : ''; };
    const CHW = { 'in store': 'Store', online: 'Online', other: 'Other' };
    const bankCell = (x) => { const b = x.bank || {}; if (!b.txns) return '<span class="bk-dim">nothing linked yet</span>';
      return (b.place ? '<div>' + esc(b.place) + '</div>' : '') + (b.category ? '<div class="bk-muted">' + esc(prettyPC(b.category)) + '</div>' : '') +
        (b.channels.length ? '<div class="bk-dim">' + b.channels.map(c => esc(CHW[c.channel] || c.channel) + ' ' + c.n).join(' · ') + '</div>' : '') +
        (b.accounts.length ? '<div class="bk-dim">' + b.accounts.map(a => esc((a.bank || 'Bank') + (a.account ? ' · ' + a.account : ''))).join('<br>') + '</div>' : ''); };
    // 1.19.147: "n lines" opens the Bank feed (All, all time) filtered to this company; the first → last date line is gone
    const spendCell = (x) => { const b = x.bank || {}; if (!b.txns) return '<span class="bk-dim">—</span>';
      return '<b>' + usd(b.spent) + '</b><div class="bk-muted"><a href="#" class="nv-lines" data-nvlines="' + x.id + '" title="Show these bank lines">' + b.txns + ' line' + (b.txns === 1 ? '' : 's') + '</a>' + (b.monthly ? ' · ~' + usd(b.monthly) + '/mo' : '') + '</div>'; };
    const q = (v.dataset.q || '').toLowerCase();
    const shown = rows.filter(x => !q || (x.name + ' ' + (x.specialty || '') + ' ' + (x.default_category || '') + ' ' + (x.contact || '') + ' ' + (x.email || '')).toLowerCase().indexOf(q) > -1);
    v.innerHTML = '<div class="bk-card"><h2>Nova vendors ' + qHelp('nova_vendors', 'Nova vendors', 'Companies you pay that are not in the CRM supplier / vendor lists — the landlord, LinkedIn, a one-off contractor. They live only in Nova, carry what you buy from them and their usual category from the chart of accounts, and can be linked to bank lines and bills like any CRM company.') +
      '<span class="sp"></span><input class="bk" id="nvQ" placeholder="Search" value="' + esc(v.dataset.q || '') + '" style="width:220px"><button class="bk-btn p" id="nvAdd">+ New vendor</button></h2>' +
      (shown.length ? '<table class="bk nv-table"><colgroup><col style="width:56px"><col style="width:156px"><col style="width:14%"><col style="width:150px"><col style="width:12%"><col style="width:176px"><col><col style="width:84px"></colgroup><thead><tr><th></th><th class="nv-co">Company</th><th>What we buy</th><th class="nv-catc">Category</th><th>Contact</th><th>Spend</th><th class="nv-stmt">Statement As</th><th></th></tr></thead><tbody>' +
        shown.map(x => '<tr><td>' + (x.photo ? '<img class="bk-logo" src="' + esc(x.photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;bk-logo ph&quot;>' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo ph">' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>') + '</td><td class="nv-co"><b>' + esc(x.name) + '</b>' + (web(x) ? '<div class="bk-dim"><a href="' + esc(/^https?:/.test(web(x)) ? web(x) : 'https://' + web(x)) + '" target="_blank" rel="noopener">' + esc(web(x)) + '</a></div>' : '') + '</td>' +
          '<td>' + esc(x.specialty || '') + '</td><td class="nv-catc">' + (x.default_category ? splitCats(x.default_category).map(c => catShort(c)).join('<br>') : '<span class="bk-dim">not set</span>') + '</td>' +
          '<td class="bk-muted">' + esc(x.contact || '') + (x.email ? '<br>' + esc(x.email) : '') + (x.phone ? '<br>' + esc(x.phone) : '') + (x.address ? '<br>' + esc(x.address) : '') + '</td><td class="nv-spend" title="' + esc(bankCell(x).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) + '">' + spendCell(x) + (x.bills ? '<div class="bk-dim">' + x.bills + ' bill' + (x.bills == 1 ? '' : 's') + '</div>' : '') + '</td><td class="bk-muted nv-stmt">' + esc(String(x.aliases || '').split('\n').filter(Boolean).join(' · ')) + '</td>' +
          '<td class="pu-acts nv-rowacts"><button class="bk-btn sm" data-nvedit="' + x.id + '">Edit</button>' + (!x.txns && !x.bills ? '<button class="bk-btn sm bad" data-nvdel="' + x.id + '" title="Remove from Nova">×</button>' : '') + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="bk-muted" style="padding:14px 0">' + (rows.length ? 'No match.' : 'No Nova vendors yet — add the landlord, LinkedIn, anyone you pay who is not in the CRM.') + '</div>') + '</div>';
    $('nvAdd').onclick = () => novaVendorForm({}, () => loadNovaVendors());
    $('nvQ').oninput = () => { v.dataset.q = $('nvQ').value; clearTimeout(v._t); v._t = setTimeout(() => { const pos = $('nvQ').selectionStart; loadNovaVendors().then(() => { const i = $('nvQ'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); }, 250); };
    v.querySelectorAll('[data-nvedit]').forEach(b => b.onclick = () => novaVendorForm(rows.find(x => x.id === Number(b.dataset.nvedit)), () => loadNovaVendors()));
    v.querySelectorAll('[data-nvlines]').forEach(a => a.onclick = (e) => { e.preventDefault(); const x = rows.find(r => r.id === Number(a.dataset.nvlines)); if (!x) return;
      Object.assign(TF, { type: '', category: '', vkind: '', source: '', min: '', max: '', account: '', side: '', how: '', period: 'all', from: '', to: '', vendor_id: String(x.id), vendor_name: x.name });
      try { localStorage.setItem('bk_txn_filters', JSON.stringify(TF)); } catch (err) {} show('bank', 'all'); });
    v.querySelectorAll('[data-nvdel]').forEach(b => b.onclick = async () => { const x = rows.find(r => r.id === Number(b.dataset.nvdel)); if (!await ask('Remove ' + x.name + ' from Nova?', { title: 'Remove vendor', ok: 'Remove' })) return; const r = await post('/api/bookkeeping/vendors/' + x.id + '/delete', {}); if (!r.ok) alert(r.error); loadNovaVendors(); });
  }
  async function loadVendors() {
    const v = $('vVendors');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/directory');
    const all = (j.vendors || []).filter(x => x.source !== 'nova');   // 1.19.133: the CRM lists only — Nova vendors (and the overseas team) have their own tab
    const KIND_LABEL = { supplier: 'Supplier', vendor: 'Vendor', nova: 'Nova vendor', bill: 'From a bill', other: 'Other' };
    const label = (k) => KIND_LABEL[k] || (String(k || 'other').charAt(0).toUpperCase() + String(k || 'other').slice(1));
    // The types are the CRM lists (read-only here — a row's type is the list it is in), then "from a bill".
    const kinds = (j.lists || ['supplier', 'vendor']).slice(); all.forEach(x => { if (x.kind && kinds.indexOf(x.kind) < 0) kinds.push(x.kind); }); if (kinds.indexOf('bill') < 0) kinds.push('bill');
    const counts = {}; all.forEach(x => { counts[x.kind || 'other'] = (counts[x.kind || 'other'] || 0) + 1; });
    let F = { kind: '', cat: '', ap: '', name: '', contact: '', spec: '' }; try { F = Object.assign(F, JSON.parse(localStorage.getItem('bk_vendor_filters') || '{}')); } catch (e) {}
    if (F.kind && !counts[F.kind]) F.kind = '';
    const catCounts = { '': 0 }; all.forEach(x => { const cs = splitCats(x.default_category); if (!cs.length) catCounts['']++; cs.forEach(c => { catCounts[c] = (catCounts[c] || 0) + 1; }); });
    const kindTag = (x) => '<span class="bk-src ' + esc(x.kind || 'other') + '">' + esc(label(x.kind)) + '</span>';
    const FOPTS = {
      kind: [{ v: '', l: 'All types', n: all.length }].concat(kinds.filter(k => counts[k]).map(k => ({ v: k, l: kindTag({ kind: k }), t: label(k), n: counts[k] }))),
      cat: [{ v: '', l: 'All', n: all.length }, { v: '__none', l: 'Not set', n: catCounts[''] }].concat(Object.keys(catCounts).filter(c => c).sort().map(c => ({ v: c, l: catLabel(c), n: catCounts[c] }))),
      ap: [{ v: '', l: 'All', n: all.length }, { v: '1', l: 'Approved', n: all.length - unapproved0() }, { v: '0', l: 'Waiting for approval', n: unapproved0() }],
      name: { type: 'text', value: F.name }, contact: { type: 'text', value: F.contact }, spec: { type: 'text', value: F.spec }
    };
    function unapproved0() { return all.filter(x => !x.approved).length; }
    const logo = (x) => x.photo ? '<img class="bk-logo" src="' + esc(x.photo) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<span class=&quot;bk-logo ph&quot;>' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo ph">' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>';
    const row = (x) => '<tr data-vid="' + x.id + '" data-kind="' + esc(x.kind || 'other') + '" data-ap="' + (x.approved ? 1 : 0) + '" data-cats="' + esc('|' + splitCats(x.default_category).join('|') + '|') + '" data-q="' + esc((x.name + ' ' + (x.contact || '') + ' ' + (x.email || '') + ' ' + (x.specialty || '') + ' ' + (x.aliases || '')).toLowerCase()) + '" data-name="' + esc(String(x.name || '').toLowerCase()) + '" data-contact="' + esc(((x.contact || '') + ' ' + (x.email || '') + ' ' + (x.phone || '')).toLowerCase()) + '" data-spec="' + esc(String(x.specialty || '').toLowerCase()) + '"><td class="vcell"><a href="#" class="bk-open" data-vopen="' + x.id + '" title="Full details">' + logo(x) + '</a><div class="vkind">' + kindTag(x) + '</div></td>' +
      '<td><a href="#" class="bk-open bk-name" data-vopen="' + x.id + '" title="Full details">' + esc(x.name) + '</a>' + (x.contact ? '<div class="bk-muted">' + esc(x.contact) + '</div>' : '') + '</td><td class="bk-muted">' + esc(x.email || '') + (x.phone ? '<br>' + esc(x.phone) : '') + '</td><td class="bk-muted">' + esc(x.specialty || '') + (x.materials ? '<div class="bk-dim"><a href="#" data-mats="' + x.id + '" title="See the materials in the catalog">' + x.materials + ' material' + (x.materials == 1 ? '' : 's') + '</a>: ' + esc((x.geo_types || []).join(', ')) + '</div>' : '') + '</td>' +
      '<td>' + catSelect(x.default_category || '', 'vcat', 'not set', { multi: true }) + '</td><td><input type="text" class="bk valias" placeholder="bank names, one per line" value="' + esc(String(x.aliases || '').split('\n').join(' | ')) + '" title="How this vendor appears on bank statements (separate with |)"></td>' +
      '<td class="num bk-muted" title="How many bank transactions and bills are linked to this company">' + (x.txns || 0) + ' <span class="bk-dim">txn' + (x.txns == 1 ? '' : 's') + '</span><br>' + (x.bills || 0) + ' <span class="bk-dim">bill' + (x.bills == 1 ? '' : 's') + '</span></td></tr>';
    // Full CRM record in a popup (everything the CRM holds for the company; edit it in the CRM).
    const openVendor = (x) => {
      let d = {}; try { d = JSON.parse(x.details || '{}') || {}; } catch (e) {}
      const line = (k, val) => val ? '<div class="bk-dl"><span>' + esc(k) + '</span><div>' + val + '</div></div>' : '';
      const addr = [d.address, d.unit].filter(Boolean).join(', ') + ((d.city || d.state || d.zip) ? '<br>' + esc([d.city, d.state].filter(Boolean).join(', ') + (d.zip ? ' ' + d.zip : '')) : '') + (d.country && d.country !== 'US' ? '<br>' + esc(d.country) : '');
      const el = document.createElement('div'); el.className = 'bk-modal';
      el.innerHTML = '<div class="bk-modal-box"><div class="bk-modal-head">' + logo(x) + '<div><div class="bk-modal-title">' + esc(x.name) + '</div><div>' + kindTag(x) + (x.approved ? ' <span class="bk-pill on">approved</span>' : ' <span class="bk-pill off">waiting for approval</span>') + '</div></div><button class="bk-btn sm bk-x" title="Close">✕</button></div>' +
        line('Contact', esc(x.contact || '')) + line('Email', x.email ? '<a href="mailto:' + esc(x.email) + '">' + esc(x.email) + '</a>' : '') + line('Phone', esc(x.phone || '')) + line('Specialty', esc(x.specialty || '')) +
        line('Address', (d.address || d.city) ? addr : '') + line('Hours', esc(d.hours || '')) + line('Usual category', esc(x.default_category || '')) + line('On the bank statement as', esc(String(x.aliases || '').split('\n').filter(Boolean).join(' · '))) +
        line('Linked', (x.txns || 0) + ' transaction' + (x.txns == 1 ? '' : 's') + ', ' + (x.bills || 0) + ' bill' + (x.bills == 1 ? '' : 's')) +
        line('Supplies', x.materials ? x.materials + ' material' + (x.materials == 1 ? '' : 's') + ' in the catalog — GEO types: ' + esc((x.geo_types || []).join(', ')) + ' <a href="#" data-mats="' + x.id + '">see them</a>' : '') + line('Notes', esc(x.notes || '')) +
        '<div class="bk-muted" style="margin-top:12px">' + (x.source === 'bill' ? 'First seen on a bill — not in the CRM yet. Add it to the CRM to fill this in.' : 'From the CRM ' + esc(d.list || x.source || '') + ' list (#' + esc(String(x.crm_id || '')) + '), synced ' + when(x.synced_at) + '. Edit the details in the CRM; they refresh here by themselves.') + '</div></div>';
      const close = () => el.remove();
      el.onclick = (e) => { if (e.target === el || e.target.classList.contains('bk-x')) close(); };
      document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
      el.querySelectorAll('[data-mats]').forEach(a => a.onclick = (e) => { e.preventDefault(); close(); matFilter = { vendor: a.dataset.mats }; show('materials'); });
      document.body.appendChild(el);
    };
    const unapproved = all.filter(x => !x.approved).length;
    v.innerHTML = '<div class="bk-card">' + (j.sync_error ? '<div class="bk-muted" style="color:#b91c1c;margin-bottom:8px" title="' + esc(j.sync_error) + '">CRM sync failed — ' + esc(j.sync_error) + '</div>' : '') +
            (all.length ? '<table class="bk bk-dir"><thead><tr><th>' + thFilter('kind', 'Type', FOPTS.kind, F.kind) + '</th><th>' + thFilter('name', 'Name', FOPTS.name) + '</th><th>' + thFilter('contact', 'Contact', FOPTS.contact) + '</th><th>' + thFilter('spec', 'Specialty', FOPTS.spec) + '</th><th>' + thFilter('cat', 'Usual category', FOPTS.cat, F.cat) + '</th><th title="How this company appears on bank statements">Bank name</th>' +
        '<th class="num" title="Bank transactions and bills linked to this company">Linked</th></tr></thead><tbody>' + all.map(row).join('') + '</tbody></table><div class="bk-muted" id="vNone" style="display:none;padding:14px 0">Nothing matches.</div>'
        : '<div class="bk-muted">Nothing synced from the CRM yet — it syncs itself within the hour.</div>') + '</div>';
    const filter = () => {
      const q = ''; let n = 0;
      try { localStorage.setItem('bk_vendor_filters', JSON.stringify(F)); } catch (e) {}
      v.querySelectorAll('tr[data-vid]').forEach(tr => {
        const catOk = !F.cat || (F.cat === '__none' ? tr.dataset.cats === '||' : tr.dataset.cats.indexOf('|' + F.cat + '|') > -1);
        const has = (k, v) => !v || (tr.dataset[k] || '').indexOf(v.toLowerCase()) > -1;
        const on = (!F.kind || tr.dataset.kind === F.kind) && (!F.ap || tr.dataset.ap === F.ap) && catOk && has('name', F.name) && has('contact', F.contact) && has('spec', F.spec) && (!q || tr.dataset.q.indexOf(q) >= 0); tr.style.display = on ? '' : 'none'; if (on) n++; });
      if ($('vNone')) $('vNone').style.display = n ? 'none' : '';
    };
    const onF = (key, val) => { F[key] = val; if (FOPTS[key] && FOPTS[key].type === 'text') FOPTS[key].value = val; filter(); const th = v.querySelector('.thf[data-thf="' + key + '"]'); if (th) th.outerHTML = thFilter(key, { kind: 'Type', cat: 'Usual category', ap: 'Approved', name: 'Name', contact: 'Contact', spec: 'Specialty' }[key], FOPTS[key], val); thFilterBind(v, FOPTS, onF); };
    thFilterBind(v, FOPTS, onF);
    filter();
    v.querySelectorAll('[data-vopen]').forEach(a => a.onclick = (e) => { e.preventDefault(); const x = all.find(y => String(y.id) === a.dataset.vopen); if (x) openVendor(x); });
    v.querySelectorAll('[data-mats]').forEach(a => a.onclick = (e) => { e.preventDefault(); matFilter = { vendor: a.dataset.mats }; show('materials'); });
    const ds = $('dirSync'); if (ds) ds.onclick = async () => { $('dirSync').disabled = true; const r = await post('/api/bookkeeping/directory/sync', {}); if (!r.ok) alert(r.error); else if (r.errors && r.errors.length) alert(r.errors.join('\n')); loadVendors(); };
    // Autosave: the usual category when it changes (a removed chip asks first), bank-statement names on blur, Approve on click.
    const flash = (tr, ok) => { tr.classList.add(ok ? 'saved' : 'failed'); setTimeout(() => tr.classList.remove('saved', 'failed'), 1200); };
    v.querySelectorAll('tr[data-vid]').forEach(tr => {
      const id = tr.dataset.vid, wrap = tr.querySelector('.ckp.vcat'), inp = tr.querySelector('input.vcat');
      let last = inp.value;
      wrap.addEventListener('change', async () => {
        const now = inp.value, was = splitCats(last), is = splitCats(now), removed = was.filter(x => is.indexOf(x) < 0);
        if (removed.length && !await ask('Remove ' + removed.join(', ') + ' from the usual categories?')) { ckpSet(wrap, was); return; }
        last = now; const r = await post('/api/bookkeeping/vendors/' + id, { default_category: now }); flash(tr, r.ok); if (!r.ok) alert(r.error);
      });
      const al = tr.querySelector('.valias'); let lastAl = al.value;
      al.addEventListener('change', async () => { if (al.value === lastAl) return; lastAl = al.value; const r = await post('/api/bookkeeping/vendors/' + id, { aliases: al.value.split('|').map(x => x.trim()).filter(Boolean).join('\n') }); flash(tr, r.ok); });
    });
    v.querySelectorAll('[data-vappr]').forEach(a => a.onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/vendors/' + a.dataset.vappr, { approved: true }); if (!r.ok) alert(r.error); loadVendors(); });
  }

  // ---------------------------------------------------------------- Materials (CRM → Materials, with GEO types)
  let matFilter = null;
  async function loadMaterials() {
    const v = $('vMaterials');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/materials');
    const all = j.materials || [], geo = j.geo || {}, unlinked = j.unlinked || {};
    const pre = matFilter || {}; matFilter = null;
    const geoNames = Object.keys(geo).sort((a, b) => a.startsWith('—') - b.startsWith('—') || a.localeCompare(b));
    const count = (g) => Object.values(geo[g]).reduce((a, b) => a + b, 0);
    const suppliers = {}; all.forEach(m => { const k = m.vendor_id ? 'v' + m.vendor_id : (m.supplier_text ? 't' + m.supplier_text : ''); if (k) suppliers[k] = { label: m.supplier || m.supplier_text, n: (suppliers[k] ? suppliers[k].n : 0) + 1, linked: !!m.vendor_id }; });
    const supKeys = Object.keys(suppliers).sort((a, b) => suppliers[b].n - suppliers[a].n);
    const photo = (m) => m.photo ? '<img class="bk-logo bk-mat" src="' + esc(m.photo) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<span class=&quot;bk-logo bk-mat ph&quot;></span>\'">' : '<span class="bk-logo bk-mat ph" style="color:#c7c7d6">·</span>';
    const supCell = (m) => m.vendor_id ? '<a href="#" class="bk-name" data-vgo="' + m.vendor_id + '">' + esc(m.supplier) + '</a>' + (m.supplier_text && m.supplier_text !== m.supplier ? '<div class="bk-dim">in the CRM as “' + esc(m.supplier_text) + '”</div>' : '') : m.supplier_text ? esc(m.supplier_text) + '<div class="bk-dim" title="This supplier name is not in the Suppliers / Vendors lists yet">not in the directory</div>' : '<span class="bk-dim">—</span>';
    const row = (m) => '<tr data-g="' + esc(m.geo_type || '— no GEO type —') + '" data-s="' + esc(m.geo_sub_type || '—') + '" data-sup="' + (m.vendor_id ? 'v' + m.vendor_id : (m.supplier_text ? 't' + esc(m.supplier_text) : '')) + '" data-q="' + esc([m.name, m.material, m.type, m.manufacturer, m.supplier, m.supplier_text, m.code, m.axiom_id, m.teams].filter(Boolean).join(' ').toLowerCase()) + '">' +
      '<td>' + photo(m) + '</td><td><b>' + esc(m.name) + '</b>' + (m.code || m.axiom_id ? '<div class="bk-dim">' + esc([m.code, m.axiom_id].filter(Boolean).join(' · ')) + '</div>' : '') + '</td>' +
      '<td>' + esc(m.geo_type || '—') + (m.geo_sub_type ? '<div class="bk-muted">' + esc(m.geo_sub_type) + '</div>' : '') + '</td>' +
      '<td class="bk-muted">' + esc([m.material, m.type].filter(Boolean).map(x => x.replace(/_/g, ' ')).join(' · ')) + (m.size || m.thickness ? '<div class="bk-dim">' + esc([m.size, m.thickness ? m.thickness + ' thick' : ''].filter(Boolean).join(' · ')) + '</div>' : '') + '</td>' +
      '<td class="bk-muted">' + esc(m.teams || '') + (m.step ? '<div class="bk-dim">' + esc(String(m.step).replace(/_/g, ' ')) + '</div>' : '') + '</td>' +
      '<td>' + supCell(m) + '</td><td class="bk-muted">' + esc(m.manufacturer || '') + '</td><td class="num">' + (m.cost != null ? usd(m.cost) : '<span class="bk-dim">—</span>') + '</td></tr>';
    v.innerHTML = '<div class="bk-card">' +
      '<div class="bk-filters"><select id="mGeo"><option value="">All GEO types (' + all.length + ')</option>' + geoNames.map(g => '<option value="' + esc(g) + '"' + (pre.geo === g ? ' selected' : '') + '>' + esc(g) + ' (' + count(g) + ')</option>').join('') + '</select>' +
      '<select id="mSub"><option value="">All sub types</option></select>' +
      '<select id="mSup"><option value="">All suppliers</option>' + supKeys.map(k => '<option value="' + esc(k) + '"' + (pre.vendor && k === 'v' + pre.vendor ? ' selected' : '') + '>' + esc(suppliers[k].label) + ' (' + suppliers[k].n + ')' + (suppliers[k].linked ? '' : ' — not in the directory') + '</option>').join('') + '</select>' +
      '<input name="q" id="mQ" placeholder="Search name, material, manufacturer, code…"></div>' +
      (all.length ? '<table class="bk bk-dir bk-mats"><thead><tr><th></th><th>Material</th><th>GEO type</th><th>Kind · size</th><th>Team · step</th><th>Supplier</th><th>Manufacturer</th><th class="num">Cost</th></tr></thead><tbody>' + all.map(row).join('') + '</tbody></table><div class="bk-muted" id="mNone" style="display:none;padding:14px 0">Nothing matches.</div><div class="bk-muted" id="mCount" style="padding:10px 0 0"></div>'
        : '<div class="bk-muted">Nothing synced yet — press Refresh from CRM.</div>') + '</div>';
    const subs = () => { const g = $('mGeo').value, cur = $('mSub').value; const names = g ? Object.keys(geo[g] || {}).sort() : []; $('mSub').innerHTML = '<option value="">All sub types' + (g ? ' (' + count(g) + ')' : '') + '</option>' + names.map(n => '<option value="' + esc(n) + '"' + (cur === n ? ' selected' : '') + '>' + esc(n) + ' (' + geo[g][n] + ')</option>').join(''); $('mSub').disabled = !g; };
    const filter = () => {
      const g = $('mGeo').value, sb = $('mSub').value, sp = $('mSup').value, q = $('mQ').value.trim().toLowerCase(); let n = 0;
      v.querySelectorAll('tr[data-g]').forEach(tr => { const on = (!g || tr.dataset.g === g) && (!sb || tr.dataset.s === sb) && (!sp || tr.dataset.sup === sp) && (!q || tr.dataset.q.indexOf(q) >= 0); tr.style.display = on ? '' : 'none'; if (on) n++; });
      if ($('mNone')) { $('mNone').style.display = n ? 'none' : ''; $('mCount').textContent = n === all.length ? '' : n + ' of ' + all.length + ' materials'; }
    };
    $('mGeo').onchange = () => { subs(); filter(); }; $('mSub').onchange = filter; $('mSup').onchange = filter; $('mQ').oninput = filter; subs(); filter();
    const ms = $('matSync'); if (ms) ms.onclick = async () => { ms.disabled = true; const r = await post('/api/bookkeeping/directory/sync', {}); if (!r.ok) alert(r.error); else if (r.errors && r.errors.length) alert(r.errors.join('\n')); loadMaterials(); };
    v.querySelectorAll('[data-vgo]').forEach(a => a.onclick = (e) => { e.preventDefault(); show('vendors'); setTimeout(() => { const tr = document.querySelector('tr[data-vid="' + a.dataset.vgo + '"]'); if (tr) { tr.scrollIntoView({ block: 'center' }); tr.style.background = '#fffbeb'; } }, 900); });
  }

  // ---------------------------------------------------------------- Equipment
  // The CRM's machines (name, photo, team) with how each one is financed: owned (depreciation → balance sheet), on a
  // loan (price, down payment, loan, term, rate; the monthly payment lands on the machine) or leased (every payment is
  // an expense). Payments to the vendor with the monthly amount attach to the machine by themselves.
  async function loadEquipment() {
    const v = $('vEquipment');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/equipment'); if (!j.ok) { v.innerHTML = '<div class="bk-card bk-muted">' + esc(j.error || 'Could not load') + '</div>'; return; }
    const all = j.equipment || [], vendors = j.vendors || [];
    const photo = (e) => e.photo ? '<img class="bk-logo bk-eq" src="' + esc(e.photo) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<span class=&quot;bk-logo bk-eq ph&quot;>' + esc((e.name || '?').charAt(0)) + '</span>\'">' : '<span class="bk-logo bk-eq ph">' + esc((e.name || '?').charAt(0).toUpperCase()) + '</span>';
    const MODE = { owned: ['Owned', 'check'], loan: ['Loan', 'landmark'], lease: ['Lease', 'calendar'] };
    const modePill = (e) => e.mode ? '<span class="eq-mode ' + e.mode + '">' + iconSvg(MODE[e.mode][1]) + MODE[e.mode][0] + '</span>' : '<span class="eq-mode none">not set</span>';
    const dateS = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', year: 'numeric' }) : '';
    const finance = (e) => {
      if (e.loan) { const L = e.loan; return '<div><b>' + usd(L.principal) + '</b>' + (L.down ? ' · ' + usd(L.down) + ' down' : '') + (L.lender ? ' · ' + esc(L.lender) : '') + '</div><div class="bk-dim">' + (L.kind === 'lease' ? 'Lease' : 'Financed ' + usd(L.financed)) + (L.term ? ' · ' + L.term + ' mo' : '') + (L.deferred ? ' after ' + L.deferred + ' skipped' : '') + (L.apr != null && L.kind !== 'lease' ? ' · ' + L.apr + '%' + (L.apr_given ? '' : ' effective') : '') + (e.schedule && e.schedule.end ? ' · ends ' + esc(dateS(e.schedule.end)) : '') + (L.sales_tax ? ' · tax ' + usd(L.sales_tax) + (L.tax_in ? ' financed' : ' separate') : '') + '</div><div class="bk-dim">from Loans &amp; Leases: <a href="#" data-lngo="' + L.id + '">' + esc(L.name) + '</a></div>'; }
      if (e.mode === 'owned') return '<div>Bought ' + esc(dateS(e.purchase_date)) + (e.purchase_price != null ? ' for <b>' + usd(e.purchase_price) + '</b>' : '') + '</div><div class="bk-dim">' + (e.life_years || 7) + '-year straight line' + (e.salvage ? ', ' + usd(e.salvage) + ' salvage' : '') + '</div>';
      if (e.mode === 'loan') return '<div>' + (e.purchase_price != null ? '<b>' + usd(e.purchase_price) + '</b> ' : '') + esc(dateS(e.purchase_date)) + (e.down_payment ? ' · ' + usd(e.down_payment) + ' down' : '') + '</div><div class="bk-dim">Loan ' + (e.loan_amount != null ? usd(e.loan_amount) : '—') + (e.loan_term ? ' · ' + e.loan_term + ' mo' : '') + (e.loan_rate != null ? ' · ' + e.loan_rate + '%' : '') + (e.schedule && e.schedule.end ? ' · ends ' + esc(dateS(e.schedule.end)) : '') + '</div>';
      if (e.mode === 'lease') return '<div>Lease from ' + esc(dateS(e.lease_start)) + (e.lease_term ? ' · ' + e.lease_term + ' mo' : '') + '</div><div class="bk-dim">' + (e.schedule && e.schedule.end ? 'ends ' + esc(dateS(e.schedule.end)) + ' · ' : '') + 'all of it is an expense (P&amp;L)</div>';
      return '<span class="bk-dim">Owned, loan or lease? Press Edit.</span>';
    };
    const monthly = (e) => e.schedule && e.schedule.monthly ? '<b>' + usd(e.schedule.monthly) + '</b>' + (e.schedule.property_tax ? '<div class="bk-dim">+ ' + usd(e.schedule.property_tax) + ' property tax = ' + usd(e.schedule.payment) + '</div>' : '') + '<div class="bk-dim">' + e.schedule.months_done + ' of ' + (e.schedule.months_done + e.schedule.months_left) + ' paid</div>' + (e.schedule.months_done + e.schedule.months_left ? '<div class="eq-bar"><i style="width:' + Math.round(100 * e.schedule.months_done / (e.schedule.months_done + e.schedule.months_left)) + '%"></i></div>' : '') : '<span class="bk-dim">—</span>';
    const paid = (e) => e.payments.n || e.payments.bills ? '<b>' + usd(e.payments.total) + '</b><div class="bk-dim">' + (e.payments.n ? e.payments.n + ' bank line' + (e.payments.n === 1 ? '' : 's') : '') + (e.payments.bills ? (e.payments.n ? ' · ' : '') + e.payments.bills + ' bill' + (e.payments.bills === 1 ? '' : 's') : '') + (e.payments.last ? ' · last ' + esc(e.payments.last) : '') + '</div>' : '<span class="bk-dim">none linked</span>';
    const value = (e) => {
      if (e.book && e.book.now != null) return '<b>' + usd(e.book.now) + '</b><div class="bk-dim">' + usd(e.book.year_start) + ' on Jan 1' + (e.book.yearly ? ' · ' + usd(e.book.yearly) + '/yr' : '') + '</div>' + (e.schedule && e.schedule.remaining ? '<div class="bk-dim">' + usd(e.schedule.remaining) + ' still to pay</div>' : '');
      if (e.schedule) return '<b>' + usd(e.schedule.remaining) + '</b><div class="bk-dim">' + e.schedule.months_left + ' payments left</div>';
      return '<span class="bk-dim">—</span>';
    };
    const vendorCell = (e) => e.vendor_id ? (e.vendor_photo ? '<img class="ib-av logo" src="' + esc(e.vendor_photo) + '" alt="" style="width:22px;height:22px;vertical-align:middle;margin-right:6px">' : '') + '<a href="#" class="bk-name" data-vgo="' + e.vendor_id + '">' + esc(e.vendor_name) + '</a>' : '<span class="bk-dim">no vendor</span>';
    const row = (e) => '<tr' + (e.active ? '' : ' class="off"') + ' data-e="' + e.id + '" data-q="' + esc((e.name + ' ' + (e.team || '') + ' ' + (e.vendor_name || '') + ' ' + (e.mode || '')).toLowerCase()) + '" data-m="' + esc(e.mode || 'none') + '">' +
      '<td>' + photo(e) + '</td><td><b>' + esc(e.name) + '</b>' + (e.team ? '<div class="bk-muted">' + esc(e.team) + '</div>' : '') + (e.active ? '' : '<div class="bk-dim">no longer in the CRM list</div>') + '</td>' +
      '<td>' + vendorCell(e) + '</td><td>' + modePill(e) + '<div style="margin-top:4px">' + finance(e) + '</div></td><td class="num">' + monthly(e) + '</td><td class="num">' + paid(e) + '</td><td class="num">' + value(e) + '</td>' +
      '<td class="pu-acts"><button class="bk-btn sm" data-edit="' + e.id + '">Edit</button>' + (e.payments.n || e.payments.bills ? '<button class="bk-btn sm" data-pays="' + e.id + '">Payments</button>' : '') + '</td></tr>';
    const n = { owned: 0, loan: 0, lease: 0, none: 0 }; all.forEach(e => { n[e.mode || 'none']++; });
    v.innerHTML = '<div class="bk-card">' +
      '<div class="bk-filters"><span class="bk-muted" style="flex:1;min-width:0">' + all.length + ' machines from the CRM · ' + n.owned + ' owned · ' + n.loan + ' on a loan · ' + n.lease + ' leased · ' + n.none + ' not set. Monthly payments to a machine\'s vendor for its amount land on the machine by themselves — bank lines under Purchases, bills under Bills.</span>' +
      '<select id="eqMode"><option value="">All</option><option value="owned">Owned</option><option value="loan">Loan</option><option value="lease">Lease</option><option value="none">Not set</option></select><input name="q" id="eqQ" placeholder="Search" style="flex:0 0 180px"><button class="bk-btn sm" id="eqAdd" title="A machine that is not in the CRM list">+ Add</button></div>' +
      (all.length ? '<table class="bk bk-dir bk-eqs"><thead><tr><th></th><th>Machine</th><th>Vendor</th><th>Financing</th><th class="num">Monthly</th><th class="num">Paid so far</th><th class="num">Book value</th><th></th></tr></thead><tbody>' + all.map(row).join('') + '</tbody></table>'
        : '<div class="bk-muted">Nothing synced yet.</div>') + '</div>';
    const filter = () => { const m = $('eqMode').value, q = $('eqQ').value.trim().toLowerCase(); v.querySelectorAll('tr[data-e]').forEach(tr => { tr.style.display = (!m || tr.dataset.m === m) && (!q || tr.dataset.q.indexOf(q) >= 0) ? '' : 'none'; }); };
    $('eqMode').onchange = filter; $('eqQ').oninput = filter;
    $('eqAdd').onclick = async () => { const name = await askText('Name of the machine', { title: 'Add a machine' }); if (!name) return; const r = await post('/api/bookkeeping/equipment', { name }); if (!r.ok) return alert(r.error); loadEquipment(); };
    v.querySelectorAll('[data-vgo]').forEach(a => a.onclick = (e) => { e.preventDefault(); show('vendors'); setTimeout(() => { const tr = document.querySelector('tr[data-vid="' + a.dataset.vgo + '"]'); if (tr) { tr.scrollIntoView({ block: 'center' }); tr.style.background = '#eef2ff'; } }, 400); });
    v.querySelectorAll('[data-lngo]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); show('loans'); });
    v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => equipmentEditor(all.find(e => e.id === Number(b.dataset.edit)), vendors, loadEquipment));
    v.querySelectorAll('[data-pays]').forEach(b => b.onclick = () => equipmentPayments(all.find(e => e.id === Number(b.dataset.pays))));
  }
  // 1.19.99: Accounts → Loans & Leases — every liability with its amortized balance, plus a balance-sheet strip
  // ---------------------------------------------------------------- 1.19.119: Overseas Team (people paid through Wise)
  async function loadTeam() {
    const v = $('vTeam');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/team'); if (!j.ok) { v.innerHTML = '<div class="bk-card bk-muted">' + esc(j.error || 'Could not load') + '</div>'; return; }
    const members = j.members || [], depts = j.depts || {}, countries = j.countries || {};
    const dateS = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const row = (m) => '<tr' + (m.status === 'left' ? ' class="off"' : '') + '><td>' + teamAv(m) + '</td>' +
      '<td><b>' + esc(m.name) + '</b>' + (m.status === 'left' ? ' <span class="bk-tag">left</span>' : '') + (m.crm_user_id ? ' <span class="bk-tag" title="Pulled from the Axiom CRM — name, department, start date and status follow it">CRM</span>' : '') + '<div class="bk-dim">' + esc(m.country_name || '') + (m.start_date ? ' · since ' + esc(dateS(m.start_date)) : '') + (m.end_date ? ' · until ' + esc(dateS(m.end_date)) : '') + '</div></td>' +
      '<td>' + esc(m.dept || '') + (m.crm_team ? '<div class="bk-dim">' + esc(m.crm_team) + '</div>' : '') + '</td>' +
      '<td class="num">' + (m.pay != null ? '<b>' + usd(m.pay) + '</b><div class="bk-dim">' + (m.period === 'monthly' ? 'monthly' : 'twice a month') + '</div>' : '<span class="bk-dim">not set</span>') + '</td>' +
      '<td>' + (m.category ? catShort(m.category) : '<span class="bk-dim">—</span>') + (m.category_alt ? '<div class="bk-dim" style="margin-top:3px">maintenance: ' + catShort(m.category_alt) + '</div>' : '') + '</td>' +
      '<td>' + (m.wise_ref ? '<code>' + esc(m.wise_ref) + '</code>' : '<span class="bk-dim">by amount</span>') + '</td>' +
      '<td class="num">' + (m.paid && m.paid.n ? '<b>' + usd(m.paid.total) + '</b><div class="bk-dim">' + m.paid.n + ' payout' + (m.paid.n === 1 ? '' : 's') + ' · last ' + esc(dateS(m.paid.last)) + (m.last_amount != null && m.pay != null && Math.abs(m.last_amount - m.pay) >= 0.005 ? ' · <span class="tm-warn">last ' + usd(m.last_amount) + '</span>' : '') + '</div>' : '<span class="bk-dim">none yet</span>') + '</td>' +
      '<td class="pu-acts"><button class="bk-btn sm" data-tedit="' + m.id + '">Edit</button></td></tr>';
    v.innerHTML = '<div class="bk-card"><h2>Overseas team ' + qHelp('team', 'Overseas team', 'The people paid through Wise — graphic design, web development, customer service. Wise puts no name on the bank line, so each person is recognised by their exact pay per period (or the Wise reference code when it stays the same for them). A matched payout is linked to the person and filed under their category; two people on the same pay are left for you to pick in the Bank feed. Each person is also a Nova vendor, so the feed and the history work as for a company.') + '</h2>' +
      (j.open_wise && j.open_wise.n ? '<div class="tm-open">' + TEAMI + ' <b>' + j.open_wise.n + '</b> Wise payout' + (j.open_wise.n === 1 ? '' : 's') + ' (' + usd(j.open_wise.total) + ') still waiting for a person — <a href="/bookkeeping?tab=bank&sub=pending">open the Bank feed</a></div>' : '') +
      '<div class="bk-filters"><span class="bk-muted" style="flex:1">' + members.length + ' team member' + (members.length === 1 ? '' : 's') + '</span><button class="bk-btn p" id="tmAdd">+ Add from Axiom</button></div>' +
      (members.length ? '<table class="bk bk-dir tm-table"><thead><tr><th></th><th>Person</th><th>Department</th><th class="num">Pay / period</th><th>Files under</th><th>Wise ref</th><th class="num">Paid so far</th><th></th></tr></thead><tbody>' + members.map(row).join('') + '</tbody></table>' : '<div class="bk-muted" style="padding:14px 0">Nobody yet. Add each person from the Axiom staff list and pick the category their payouts file under.</div>') +
      '<div class="bk-muted" style="margin-top:10px;font-size:12px">Web development: set <b>Files under</b> to the capital category for building the site (Assets &amp; Capital › Website Development) and <b>Maintenance category</b> to the expense one; a payout can be flipped between the two from the Bank feed.</div></div>';
    $('tmAdd').onclick = () => teamPicker(j, loadTeam);
    v.querySelectorAll('[data-tedit]').forEach(b => b.onclick = () => teamForm(members.find(x => String(x.id) === b.dataset.tedit), j, loadTeam));
  }
  // 1.19.149: a team member's face — the CRM photo when there is one, else the initial; the country flag in the corner
  const teamAv = (m) => '<span class="tm-av">' + flag(m.country, m.country_name) + (m.photo ? '<img class="bk-logo tm-ph" src="' + esc(m.photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;bk-logo ph&quot;>' + esc(String(m.name || '?').charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo ph">' + esc(String(m.name || '?').charAt(0).toUpperCase()) + '</span>') + '</span>';
  // 1.19.148: pick a person from the Axiom CRM staff list (name, team, start date and status come from there)
  function teamPicker(j, done) {
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(640px,100%)"><div class="bk-modal-title" style="margin-bottom:10px">Add from Axiom</div>' +
      '<div class="bk-row" style="margin-bottom:8px"><input class="bk" id="tpQ" placeholder="Search the staff list" style="flex:1"><span class="bk-muted" id="tpN"></span></div>' +
      '<div class="tp-list" id="tpList"><div class="bk-dim" style="padding:10px 2px">Loading the staff list…</div></div>' +
      '<div class="bk-row nv-acts"><button class="bk-btn bk-x">Cancel</button><span class="sp"></span><a href="#" class="bk-dim" id="tpHand" style="font-size:12px">Not in the CRM — type in by hand</a></div></div>';
    const close = () => el.remove(); el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.body.appendChild(el); el.querySelector('#tpQ').focus();
    let staff = [];
    const paint = () => {
      const q = el.querySelector('#tpQ').value.trim().toLowerCase();
      const rows = staff.filter(u => !q || (u.name + ' ' + u.title + ' ' + u.crm_team).toLowerCase().indexOf(q) > -1);
      el.querySelector('#tpN').textContent = rows.length + ' of ' + staff.length;
      el.querySelector('#tpList').innerHTML = rows.length ? rows.map(u => '<div class="tp-row' + (u.linked ? ' on' : '') + (u.active ? '' : ' off') + '" data-uid="' + u.user_id + '">' +
        teamAv(u) +
        '<div class="tp-main"><b>' + esc(u.name) + '</b>' + (u.active ? '' : ' <span class="bk-tag">inactive</span>') + '<div class="bk-dim">' + esc([u.title, u.crm_team].filter(Boolean).join(' · ') || u.dept) + '</div></div>' +
        '<div class="bk-dim tp-side">' + (u.start_date ? 'since ' + esc(usD(u.start_date)) : '') + '</div>' +
        (u.linked ? '<span class="bk-tag ok">on the team</span>' : '<button class="bk-btn sm p" data-add="' + u.user_id + '">Add</button>') + '</div>').join('') : '<div class="bk-dim" style="padding:10px 2px">No match.</div>';
      el.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => {
        b.disabled = true; b.textContent = 'Adding…';
        const r = await post('/api/bookkeeping/team/from-crm', { user_id: Number(b.dataset.add) }); if (!r.ok) { alert(r.error || 'Could not add.'); b.disabled = false; b.textContent = 'Add'; return; }
        close(); const t = await api('/api/bookkeeping/team'); const m = (t.members || []).find(x => x.id === r.id); if (m) teamForm(m, t, done); else done();
      });
    };
    el.querySelector('#tpQ').oninput = paint;
    el.querySelector('#tpHand').onclick = (ev) => { ev.preventDefault(); close(); teamForm({}, j, done); };
    api('/api/bookkeeping/team/crm').then(r => { if (!r.ok) { el.querySelector('#tpList').innerHTML = '<div class="bk-dim" style="padding:10px 2px">' + esc(r.error || 'Could not read the CRM staff list.') + '</div>'; return; } staff = r.staff || []; paint(); });
  }
  function teamForm(m, j, done) {
    m = m || {}; const isEdit = !!m.id, depts = j.depts || {}, countries = j.countries || {};
    // 1.19.148: a CRM-linked member — name, country, department, start date and status follow the CRM; pay, period,
    // Wise ref, ended and notes wait for the CRM to carry them. Only the two categories are Nova's to fill in.
    const crm = !!m.crm_user_id, CRM_F = ['name', 'country', 'department', 'start_date', 'status'], SOON_F = ['pay', 'period', 'wise_ref', 'end_date', 'notes'];
    const dis = (k) => crm && (CRM_F.indexOf(k) > -1 || SOON_F.indexOf(k) > -1) ? ' disabled title="' + (CRM_F.indexOf(k) > -1 ? 'From the Axiom CRM' : 'Soon from the Axiom CRM') + '"' : '';
    const el = document.createElement('div'); el.className = 'bk-modal';
    const f = (k, label, type, extra, ph) => '<label class="nv-f' + (dis(k) ? ' ro' : '') + '"><span class="bk-muted">' + label + '</span><input class="bk" name="' + k + '" type="' + (type || 'text') + '" value="' + esc(m[k] != null ? m[k] : '') + '"' + (extra || '') + (ph && !dis(k) ? ' placeholder="' + esc(ph) + '"' : '') + dis(k) + '></label>';
    const sel = (k, label, opts) => '<label class="nv-f' + (dis(k) ? ' ro' : '') + '"><span class="bk-muted">' + label + '</span><select class="bk" name="' + k + '"' + dis(k) + '>' + opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(m[k] == null ? '' : m[k]) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></label>';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(640px,100%)"><div class="bk-modal-title" style="margin-bottom:12px">' + (isEdit ? 'Edit ' + esc(m.name) : 'Add a team member') + (crm ? ' <span class="bk-tag" title="Name, department, start date and status follow the Axiom CRM">CRM</span>' : '') + '</div>' +
      (crm ? '<div class="bk-muted" style="margin:-6px 0 10px;font-size:12px">From the Axiom CRM' + (m.crm_team ? ' — ' + esc(m.crm_team) : '') + (m.title ? ' · ' + esc(m.title) : '') + '. The greyed fields follow the CRM; fill in the categories here.</div>' : '') +
      '<div class="nv-grid">' + f('name', 'Name', 'text', '', 'First and last name') + sel('country', 'Country', Object.keys(countries).map(c => [c, countries[c]]).concat([['other', 'Other']])) +
      sel('department', 'Department', Object.keys(depts).map(d => [d, depts[d]])) + sel('period', 'Paid', [['semi', 'Twice a month'], ['monthly', 'Monthly']]) +
      f('pay', 'Pay per period ($)', 'number', ' step="0.01" min="0"', '706.59') + f('wise_ref', 'Wise reference code (if it stays the same)', 'text', '', 'XXXXX9740') +
      '<label class="nv-f"><span class="bk-muted">Files under (category)</span>' + catSelect(m.category || '', 'tmcat', 'Category…') + '</label>' +
      '<label class="nv-f"><span class="bk-muted">Maintenance category (web dev only, optional)</span>' + catSelect(m.category_alt || '', 'tmalt', 'Category…') + '</label>' +
      f('start_date', 'Started', 'date') + f('end_date', 'Ended (blank = still with us)', 'date') + sel('status', 'Status', [['active', 'Active'], ['left', 'Left']]) + '</div>' +
      '<label class="nv-f' + (dis('notes') ? ' ro' : '') + '"><span class="bk-muted">Notes</span><textarea class="bk" name="notes" rows="2"' + dis('notes') + '>' + esc(m.notes || '') + '</textarea></label>' +
      '<div class="bk-row nv-acts"><button class="bk-btn p" id="tmSave">' + (isEdit ? 'Save' : 'Add') + '</button><button class="bk-btn bk-x">Cancel</button>' + (isEdit ? '<span class="sp"></span><button class="bk-btn sm bad" id="tmDel">Remove</button>' : '') + '<span class="bk-muted" id="tmMsg"></span></div></div>';
    const close = () => el.remove(); el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.body.appendChild(el); if (!crm) el.querySelector('[name=name]').focus();
    el.querySelector('#tmSave').onclick = async () => {
      const body = {}; el.querySelectorAll('input[name], select[name], textarea[name]').forEach(i => { if (!i.disabled) body[i.name] = i.value; });
      if (crm) body.name = m.name;
      body.category = el.querySelector('input.tmcat').value; body.category_alt = el.querySelector('input.tmalt').value;
      if (!body.name.trim()) { el.querySelector('#tmMsg').textContent = 'Give the person a name.'; return; }
      if (!body.category) { el.querySelector('#tmMsg').textContent = 'Pick the category their payouts file under.'; return; }
      const r = await post(isEdit ? '/api/bookkeeping/team/' + m.id : '/api/bookkeeping/team', body);
      if (!r.ok) { el.querySelector('#tmMsg').textContent = r.error || 'Could not save.'; return; }
      close(); done(); if (r.linked) overview();
    };
    const del = el.querySelector('#tmDel'); if (del) del.onclick = async () => { if (!(await ask('Remove **' + m.name + '** from the team? Their bank lines are kept, just unlinked; the Nova vendor stays.', { ok: 'Remove', danger: true }))) return; await post('/api/bookkeeping/team/' + m.id + '/delete', {}); close(); done(); };
  }
  async function loadLoans() {
    const v = $('vLoans');
    const ord = (d) => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');   /* 1.20.131: the payment day on the row */
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/loans'); if (!j.ok) { v.innerHTML = '<div class="bk-card bk-muted">' + esc(j.error || 'Could not load') + '</div>'; return; }
    const loans = j.loans || [], sheet = j.sheet || {};
    const KIND = { loan: 'Loan', lease: 'Lease', credit_line: 'Credit line' };
    const dateS = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const pic = (l) => l.equipment_photo ? '<img class="bk-logo bk-eq" src="' + esc(l.equipment_photo) + '" alt="">' : l.vendor_photo ? '<img class="bk-logo" src="' + esc(l.vendor_photo) + '" alt="">' : '<span class="bk-logo ph">' + esc(String(l.name || '?').charAt(0).toUpperCase()) + '</span>';
    // 1.19.144: the payment calendar — one square per contract month (grey = no payment due, green = paid, red = missed,
    // amber = due now, white = upcoming); hover a square for the month, due date and the bank line
    const ST_T = { skip: 'no payment due', paid: 'paid', missed: 'MISSED — no payment seen at the bank', due: 'due now', upcoming: 'upcoming' };
    const calCell = (l, sch, total, pct) => {
      const c = l.calendar;
      if (!c) return (total ? '<div>' + sch.months_done + ' of ' + total + ' paid</div><div class="ln-bar"><i style="width:' + pct + '%"></i></div>' : '<span class="bk-dim">open-ended</span>') + (sch.end ? '<div class="bk-dim">ends ' + esc(dateS(sch.end)) + '</div>' : '');
      const sq = c.slots.map(x => '<i class="ln-sq ' + x.state + '" title="' + esc('#' + x.n + ' · ' + x.month + ' · ' + ST_T[x.state] + (x.date ? ' on ' + usD(x.date) + ' · ' + usd(x.amount) : x.state !== 'skip' ? ' · due ' + usD(x.due) : '')) + '"></i>').join('');
      return '<div><b>' + c.paid + '</b> of ' + c.term + ' paid' + (c.missed ? ' · <span class="ln-miss">' + c.missed + ' missed</span>' : '') + (c.extra && c.extra.length ? ' · <span class="bk-dim" title="' + esc(c.extra.map(e => usD(e.date) + ' ' + usd(e.amount)).join(', ')) + '">+' + c.extra.length + ' extra</span>' : '') + '</div>' +
        '<div class="ln-cal">' + sq + '</div>' + (sch.end ? '<div class="bk-dim">ends ' + esc(dateS(sch.end)) + '</div>' : '');
    };
    const row = (l) => { const sch = l.schedule || {}, total = (sch.months_done || 0) + (sch.months_left || 0), pct = total ? Math.round(100 * (sch.months_done || 0) / total) : 0;
      return '<tr' + (l.status === 'paid' ? ' class="off"' : '') + '><td>' + pic(l) + '</td>' +
        '<td><b>' + esc(l.name) + '</b> <span class="ln-kind ' + esc(l.kind) + '">' + esc(KIND[l.kind] || l.kind) + '</span>' + (l.source === 'equipment' ? '<div class="bk-dim">financing from the Equipment tab</div>' : '') + (l.source === 'loan' ? '<div class="bk-dim ln-docs-l"><a href="#" data-ldocs="' + l.id + '" title="' + (l.files ? 'Open the documents on this loan' : 'Add the signed contract, loan terms…') + '">' + (l.files ? l.files + ' doc' + (l.files === 1 ? '' : 's') : 'Add docs') + '</a></div>' : '') + (l.status === 'paid' ? '<div class="bk-dim">paid off</div>' : '') + '</td>' +
        '<td>' + esc(l.vendor_name || l.lender || '—') + '</td>' +
        (() => {   /* 1.20.132: how the loan is paid — Auto pay (bank logo + account, the day, the amount) or Bill (the due day) */
          if (!l.pay_method) return '<td class="ln-payc"><span class="bk-dim">—</span></td>';
          if (l.pay_method === 'bill') return '<td class="ln-payc"><span class="ln-pm bill">Bill</span>' + (l.due_day ? '<div class="bk-dim">due the ' + ord(l.due_day) + '</div>' : '') + '</td>';
          const b = (j.banks || []).find(x => x.id === l.pay_account) || null;
          return '<td class="ln-payc"><span class="ln-pm auto">Auto pay</span><div class="ln-pmb">' + (b && b.logo ? '<img src="' + esc(b.logo) + '" alt="">' : '') + '<span>' + esc(b ? b.label.split(' · ')[0] : l.pay_account === 'other' ? 'Other account' : '') + '</span></div>' +
            '<div class="bk-dim">' + [l.pay_day ? 'the ' + ord(l.pay_day) : '', l.pay_amount ? usd(l.pay_amount) : ''].filter(Boolean).join(' · ') + '</div></td>';
        })() +
        '<td>' + (l.principal != null ? '<b>' + usd(l.principal) + '</b>' : '<span class="bk-dim">—</span>') + '<div class="bk-dim">' + esc(dateS(l.start_date)) + (l.math && l.math.down ? ' · ' + usd(l.math.down) + ' down' : '') + (l.term_months ? ' · ' + l.term_months + ' mo' : '') + (l.math && l.math.deferred ? ' after ' + l.math.deferred + ' skipped' : '') + (l.math && l.math.apr != null && l.kind !== 'lease' ? ' · ' + l.math.apr + '% APR' + (l.math.apr_given ? '' : ' (effective)') : l.apr != null && l.apr !== '' ? ' · ' + l.apr + '% APR' : '') + '</div>' + (l.math && l.math.total_payback ? '<div class="bk-dim">' + usd(l.math.total_payback) + ' back in all</div>' : '') + (l.math && l.math.sales_tax ? '<div class="bk-dim">' + usd(l.math.sales_tax) + ' sales tax ' + (l.math.tax_in ? 'financed' : 'paid separately') + '</div>' : '') + '</td>' +
        '<td class="ln-l">' + (sch.monthly ? '<b>' + usd(sch.monthly) + '</b>' : '—') + (l.math && l.math.property_tax ? '<div class="bk-dim">+ ' + usd(l.math.property_tax) + ' property tax = ' + usd(l.math.payment) + '</div>' : '') + ((l.calendar && l.calendar.next_due) ? '<div class="bk-dim">next ' + esc(dateS(l.calendar.next_due)) + '</div>' : sch.next ? '<div class="bk-dim">next ' + esc(dateS(sch.next)) + '</div>' : '') + '</td>' +
        '<td>' + calCell(l, sch, total, pct) + '</td>' +
        '<td class="ln-l"><b>' + usd(l.balance || 0) + '</b>' + (l.interest_paid ? '<div class="bk-dim">' + usd(l.interest_paid) + ' interest so far</div>' : '') + (l.total_interest != null && l.total_interest > 0 ? '<div class="bk-dim">' + usd(l.total_interest) + ' over the term</div>' : '') + '</td>' +
        '<td class="ln-l">' + (l.payments && (l.payments.n || l.payments.bills) ? '<b>' + usd(l.payments.total) + '</b><div class="bk-dim">' + (l.payments.n || 0) + ' bank line' + (l.payments.n === 1 ? '' : 's') + '</div>' + (l.payments.last ? '<div class="bk-dim">last ' + esc(dateS(l.payments.last)) + '</div>' : '') : '<span class="bk-dim">none linked</span>') + '</td>' +
        '<td class="pu-acts">' + (l.source === 'equipment' ? '<button class="bk-btn sm" data-eqgo="' + l.equipment_id + '">Edit under Equipment</button>' : '<button class="bk-btn sm" data-ledit="' + l.id + '">Edit</button>') + '</td></tr>'; };
    v.innerHTML = '<div class="bk-card"><h2>Loans &amp; leases ' + qHelp('loans', 'Loans & leases', 'Every amount the company owes: standalone loans you add here (SBA, line of credit, vehicle, owner loan) and the machines financed under Equipment. The balance is amortized from the principal, APR, term and monthly payment — the interest part of each payment shrinks over time. Link bank lines to a loan from the Bank feed ("Loan payment? Match") to see what was actually paid. The strip on top is the balance-sheet view: what the equipment is worth today (straight-line book value) against what is still owed.') + '</h2>' +
      '<div class="ln-sheet"><div class="ln-tile"><div class="k">Equipment, book value today</div><div class="v">' + usd(sheet.equipment_value || 0) + '</div></div><div class="ln-tile owe"><div class="k">Still owed on ' + (sheet.loans || 0) + ' loan' + (sheet.loans === 1 ? '' : 's') + ' / lease' + (sheet.loans === 1 ? '' : 's') + '</div><div class="v">' + usd(sheet.owed || 0) + '</div></div><div class="ln-tile"><div class="k">Monthly payments</div><div class="v">' + usd(sheet.monthly || 0) + '</div></div><div class="ln-tile net"><div class="k">Equipment net of loans</div><div class="v">' + usd(sheet.net || 0) + '</div></div></div>' +
      '<div class="bk-filters"><span class="bk-muted" style="flex:1">' + loans.length + ' loan' + (loans.length === 1 ? '' : 's') + ' and lease' + (loans.length === 1 ? '' : 's') + '</span><button class="bk-btn p" id="lnAdd">+ New loan / lease</button></div>' +
      (loans.length ? '<table class="bk bk-dir ln-table"><thead><tr><th></th><th>Loan</th><th>Lender</th><th>Payment</th><th>Borrowed</th><th>Monthly</th><th>Payments</th><th>Balance</th><th>Paid (bank)</th><th></th></tr></thead><tbody>' + loans.map(row).join('') + '</tbody></table>' : '<div class="bk-muted" style="padding:14px 0">No loans yet. Add one, or set a machine to "On a loan" / "Lease" under Equipment and it shows up here.</div>') + '</div>';
    $('lnAdd').onclick = () => loanForm({}, j, loadLoans);
    v.querySelectorAll('[data-ledit]').forEach(b => b.onclick = () => loanForm(loans.find(x => String(x.id) === b.dataset.ledit), j, loadLoans));
    v.querySelectorAll('[data-ldocs]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); loanForm(loans.find(x => String(x.id) === a.dataset.ldocs), j, loadLoans); setTimeout(() => { const d = document.querySelector('#lnDrop'); if (d) d.scrollIntoView({ block: 'center' }); }, 50); });
    v.querySelectorAll('[data-eqgo]').forEach(b => b.onclick = () => show('equipment'));
  }
  function loanForm(l, j, done) {
    l = l || {}; const isEdit = !!l.id;
    const el = document.createElement('div'); el.className = 'bk-modal';
    const f = (k, label, type, extra, ph) => '<label class="nv-f"><span class="bk-muted">' + label + '</span><input class="bk" name="' + k + '" type="' + (type || 'text') + '" value="' + esc(l[k] != null ? l[k] : '') + '"' + (extra || '') + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
    const sel = (k, label, opts) => '<label class="nv-f"><span class="bk-muted">' + label + '</span><select class="bk" name="' + k + '">' + opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(l[k] == null ? (k === 'tax_in' ? '1' : '') : l[k]) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></label>';
    // 1.19.135: money fields are text with thousands separators ("395,000.00"); parsed on save
    const fmtMoney = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return v === '' || v == null || !isFinite(n) ? '' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    const money = (k, label, ph) => '<label class="nv-f"><span class="bk-muted">' + label + '</span><input class="bk ln-money" name="' + k + '" type="text" inputmode="decimal" value="' + esc(fmtMoney(l[k])) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
    // 1.19.137: a compact grid — `c` = how many of its 12 columns a field takes (1.20.131: twelve, was six)
    const w = (html, c) => html.replace('<label class="nv-f">', '<label class="nv-f" style="grid-column:span ' + c + '">');
    const ro = (k, label, title) => '<label class="nv-f ln-ro" style="grid-column:span 3" title="' + esc(title || '') + '"><span class="bk-muted">' + label + ' <i>auto</i></span><input class="bk ln-money" name="' + k + '" type="text" readonly tabindex="-1" value="' + esc(fmtMoney(l[k])) + '"></label>';
    // 1.20.131: purchase price → financed price is worked out, the loan term is a pick, the total pay back is computed,
    // property tax is a tick, and the loan says how it is paid (auto payment from a connected bank, or a bill)
    const purchase = l.purchase_price != null && l.purchase_price !== '' ? l.purchase_price : (l.principal != null && l.principal !== '' ? Number(l.principal) + (Number(l.direct_down) || 0) : '');
    const TERMS = [24, 36, 48, 60, 72, 84]; const termV = Number(l.term_months) || '';
    // 1.20.132: a stepped schedule ("3 @ $99 then 57 @ $7,572") — [{n, amount}] kept in steps_json; the term is the sum, the regular payment the last step
    let steps = []; try { steps = JSON.parse(l.steps_json || '[]'); } catch (e) { steps = []; } if (!Array.isArray(steps)) steps = [];
    const termMode = steps.length ? 'steps' : termV && TERMS.indexOf(termV) < 0 ? 'custom' : String(termV); const termCustom = termMode === 'custom';
    const days = (k, label, blank) => '<label class="nv-f"><span class="bk-muted">' + label + '</span><select class="bk" name="' + k + '"><option value="">' + blank + '</option>' + Array.from({ length: 31 }, (_, i) => i + 1).map(d => '<option value="' + d + '"' + (String(l[k] || '') === String(d) ? ' selected' : '') + '>' + d + (d === 1 || d === 21 || d === 31 ? 'st' : d === 2 || d === 22 ? 'nd' : d === 3 || d === 23 ? 'rd' : 'th') + ' of every month</option>').join('') + '</select></label>';
    const banks = (j.banks || []); const payAcc = l.pay_account || '';
    const section = (t) => '<div class="ln-sec" style="grid-column:span 12">' + t + '</div>';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(820px,100%)"><div class="bk-modal-title" style="margin-bottom:12px">' + (isEdit ? 'Edit ' + esc(l.name) : 'New loan / lease') + '</div>' +
      '<div class="nv-grid ln-grid">' +
      w(f('name', 'Name', 'text', '', 'SBA EIDL · Line of credit · Van loan'), 6) + w(sel('kind', 'Kind', [['loan', 'Loan (amortized)'], ['lease', 'Lease (fixed payments)'], ['credit_line', 'Line of credit (open-ended)']]), 4) + w(sel('status', 'Status', [['active', 'Active'], ['paid', 'Paid off']]), 2) +
      w(sel('vendor_id', 'Lender', [['', '— company —']].concat((j.vendors || []).map(x => [x.id, x.name]))), 4) + w(f('lender', 'Lender name (if not listed)', 'text', '', 'Screen GP Americas'), 4) + w(sel('equipment_id', 'Finances a machine', [['', '— none —']].concat((j.equipment || []).map(x => [x.id, x.name]))), 4) +
      section('Finance') +
      w('<label class="nv-f"><span class="bk-muted">Purchase price</span><input class="bk ln-money" name="purchase_price" type="text" inputmode="decimal" value="' + esc(fmtMoney(purchase)) + '" placeholder="434,500.00"></label>', 3) +
      w(money('direct_down', 'Direct down payment', '0.00').replace('<span class="bk-muted">', '<span class="bk-muted" title="Paid straight to the manufacturer / seller — not part of the loan">'), 3) +
      ro('principal', 'Financed price', 'Purchase price − direct down payment: what the lender finances') +
      w(money('down_payment', 'Loan down payment', '39,500.00').replace('<span class="bk-muted">', '<span class="bk-muted" title="The down payment paid to the lender at signing">'), 3) +
      w(f('purchase_date', 'Purchase date', 'date'), 4) + w(f('arrival_date', 'Arrival date', 'date'), 4) + w(f('start_date', 'Loan start date', 'date'), 4) +
      w(f('deferred_months', 'No payment months', 'number', ' step="1" min="0"', '0'), 3) +
      '<label class="nv-f" style="grid-column:span 3"><span class="bk-muted">Loan term</span><span class="ln-term"><select class="bk" id="lnTermSel">' + [['', '— months —']].concat(TERMS.map(t => [t, t + ' months'])).concat([['custom', 'Custom months…'], ['steps', 'Stepped payments…']]).map(o => '<option value="' + o[0] + '"' + (termMode === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
        '<input class="bk" name="term_months" type="number" step="1" min="0" value="' + esc(termV) + '" placeholder="mo"' + (termCustom ? '' : ' hidden') + '></span></label>' +
      '<div class="ln-steps" id="lnSteps" style="grid-column:span 12"' + (steps.length ? '' : ' hidden') + '><div class="bk-muted">Payment steps, in order — e.g. 3 payments @ $99.00, then 57 @ $7,572.00</div><div id="lnStepRows"></div><a href="#" id="lnStepAdd">+ Add a step</a><input type="hidden" name="steps_json" value="' + esc(steps.length ? JSON.stringify(steps) : '') + '"></div>' +
      w(money('monthly', 'Monthly payment', '5,808.00'), 3) + w(f('apr', 'Interest %', 'number', ' step="0.001" min="0"', 'computed'), 3) +
      ro('total_payback', 'Total pay back', 'Loan down payment + monthly × term + due at the end') + w(money('balloon', 'Due at the end', '0.00'), 3) +
      '<label class="nv-f ln-check" style="grid-column:span 6"><span class="bk-muted">Property tax</span><label class="ln-tick" title="Tick when Axiom pays the property tax on the machine"><input type="checkbox" name="property_tax_axiom" value="1"' + (Number(l.property_tax_axiom) ? ' checked' : '') + '> Axiom due</label></label>' +
      w(money('sales_tax', 'Sales tax', '34,000.00'), 3) + w(sel('tax_in', 'Sales tax is', [['0', 'Excluded — Axiom pays'], ['1', 'Included in the total sale']]), 5) +
      section('Payment') +
      '<label class="nv-f" style="grid-column:span 3"><span class="bk-muted">Payment method</span><span class="ln-seg" id="lnPay"><button type="button" data-m="auto"' + (l.pay_method === 'auto' ? ' class="on"' : '') + '>Auto pay</button><button type="button" data-m="bill"' + (l.pay_method === 'bill' ? ' class="on"' : '') + '>Bill</button></span><input type="hidden" name="pay_method" value="' + esc(l.pay_method || '') + '"></label>' +
      '<label class="nv-f ln-auto" style="grid-column:span 4"><span class="bk-muted">Auto payment from</span><span class="ln-bank" id="lnBank"><button type="button" class="bk ln-bank-b"></button><div class="ln-bank-l" hidden></div></span><input type="hidden" name="pay_account" value="' + esc(payAcc) + '"></label>' +
      days('pay_day', 'Scheduled payment date', '— day —').replace('<label class="nv-f">', '<label class="nv-f ln-auto" style="grid-column:span 3">') +
      w(money('pay_amount', 'Auto payment amount', '5,808.00'), 2).replace('class="nv-f"', 'class="nv-f ln-auto"') +
      days('due_day', 'Due', '— day —').replace('<label class="nv-f">', '<label class="nv-f ln-bill" style="grid-column:span 4">') +
      '</div>' +
      '<div class="bk-dim" id="lnCalc" style="margin:4px 0 10px"></div>' +
      '<label class="nv-f"><span class="bk-muted">Notes</span><textarea class="bk" name="notes" rows="2">' + esc(l.notes || '') + '</textarea></label>' +
      '<div class="ln-docs"><div class="bk-muted" style="margin-bottom:6px">Documents — the signed agreement, terms, payment schedule</div>' +
      (isEdit ? '<div class="ln-drop" id="lnDrop" tabindex="0">' + iconSvg('upload') + '<div><b>Drop files here</b> or click to choose · PDF, pictures, Word, Excel · up to 25 MB each</div><input type="file" id="lnFile" multiple accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,application/pdf,image/png,image/jpeg" hidden></div><div class="ln-uplabel bk-muted">Label the files I add as <span id="lnUpLabelBox"></span></div><div id="lnFiles" class="ln-files"></div>' : '<div class="bk-dim">Add the loan first, then its documents.</div>') + '</div>' +
      '<div class="bk-row nv-acts"><button class="bk-btn p" id="lnSave">' + (isEdit ? 'Save' : 'Add loan') + '</button><button class="bk-btn bk-x">Cancel</button>' + (isEdit ? '<span class="sp"></span><button class="bk-btn sm bad" id="lnDel">Delete</button>' : '') + '<span class="bk-muted" id="lnMsg"></span></div></div>';
    const close = () => el.remove(); el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.body.appendChild(el); el.querySelector('[name=name]').focus();
    const num = (k) => { const v = Number(String(el.querySelector('[name=' + k + ']').value || '').replace(/[$,\s]/g, '')); return isFinite(v) ? v : 0; };
    // the term pick ↔ the months box; the property-tax amount shows when Axiom pays it; the payment fields follow the method
    const termSel = el.querySelector('#lnTermSel'), termIn = el.querySelector('[name=term_months]');
    const stepsBox = el.querySelector('#lnSteps'), stepRows = el.querySelector('#lnStepRows'), stepsIn = el.querySelector('[name=steps_json]'), monthlyIn = el.querySelector('[name=monthly]');
    const readSteps = () => Array.from(stepRows.querySelectorAll('.ln-step')).map(r => ({ n: parseInt(r.querySelector('[data-n]').value) || 0, amount: Number(String(r.querySelector('[data-a]').value).replace(/[$,\s]/g, '')) || 0 })).filter(x => x.n > 0);
    const stepsSync = () => {   /* the hidden field, the term (sum of the counts) and the regular payment (the last step) follow the rows */
      const st = termSel.value === 'steps' ? readSteps() : []; stepsIn.value = st.length ? JSON.stringify(st) : '';
      if (st.length) { termIn.value = st.reduce((n, x) => n + x.n, 0); monthlyIn.value = fmtMoney(st[st.length - 1].amount); }
      termIn.readOnly = monthlyIn.readOnly = !!st.length; termIn.classList.toggle('ln-ro-in', !!st.length); monthlyIn.classList.toggle('ln-ro-in', !!st.length);
      recalc();
    };
    const stepRow = (x) => { const d = document.createElement('div'); d.className = 'ln-step'; d.innerHTML = '<input class="bk" data-n type="number" min="1" step="1" value="' + (x && x.n ? x.n : '') + '" placeholder="3"><span>payments @</span><input class="bk ln-money" data-a type="text" inputmode="decimal" value="' + (x && x.amount != null && x.amount !== '' ? fmtMoney(x.amount) : '') + '" placeholder="99.00"><a href="#" data-x title="Remove">×</a>';
      d.querySelector('[data-x]').onclick = (ev) => { ev.preventDefault(); d.remove(); stepsSync(); }; d.querySelectorAll('input').forEach(i => { i.addEventListener('input', stepsSync); i.addEventListener('blur', () => { if (i.classList.contains('ln-money')) i.value = fmtMoney(i.value); stepsSync(); }); }); return d; };
    steps.forEach(x => stepRows.appendChild(stepRow(x)));
    el.querySelector('#lnStepAdd').onclick = (ev) => { ev.preventDefault(); const r = stepRow(null); stepRows.appendChild(r); r.querySelector('[data-n]').focus(); };
    termSel.onchange = () => {
      const m = termSel.value; stepsBox.hidden = m !== 'steps';
      if (m === 'custom') { termIn.hidden = false; termIn.focus(); } else { termIn.hidden = m !== 'steps'; if (m !== 'steps') termIn.value = m; }
      if (m === 'steps' && !stepRows.children.length) { stepRows.appendChild(stepRow({ n: 3, amount: '' })); stepRows.appendChild(stepRow(null)); }
      stepsSync();
    };
    if (steps.length) termIn.hidden = false;
    const paySel = el.querySelector('[name=pay_method]'), seg = el.querySelector('#lnPay');
    const payShow = () => { const m = paySel.value; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); el.querySelectorAll('.ln-auto').forEach(x => x.style.display = m === 'auto' ? '' : 'none'); el.querySelectorAll('.ln-bill').forEach(x => x.style.display = m === 'bill' ? '' : 'none'); };
    seg.querySelectorAll('button').forEach(b => b.onclick = () => { paySel.value = paySel.value === b.dataset.m ? '' : b.dataset.m; payShow(); });   /* 1.20.132: a toggle — a second click on the lit one clears it */
    payShow();
    // the bank picker shows each connection's logo (a native select cannot)
    const bankIn = el.querySelector('[name=pay_account]'), bankBtn = el.querySelector('.ln-bank-b'), bankList = el.querySelector('.ln-bank-l');
    const bankOpts = [{ id: '', label: '— bank —' }].concat(banks).concat([{ id: 'other', label: 'Other' }]);
    const bankHtml = (b) => (b.logo ? '<img src="' + esc(b.logo) + '" alt="">' : '<span class="ln-bank-i">' + (b.id && b.id !== 'other' ? iconSvg('landmark') : '') + '</span>') + '<span class="ln-bank-t">' + esc(b.label) + '</span>';
    const bankPaint = () => { const b = bankOpts.find(x => x.id === bankIn.value) || bankOpts[0]; bankBtn.innerHTML = bankHtml(b) + '<i class="ln-bank-c">▾</i>'; };
    bankList.innerHTML = bankOpts.map(b => '<div class="ln-bank-o" data-id="' + esc(b.id) + '">' + bankHtml(b) + '</div>').join('');
    bankList.querySelectorAll('.ln-bank-o').forEach(o => o.onclick = () => { bankIn.value = o.dataset.id; bankList.hidden = true; bankPaint(); });
    bankBtn.onclick = () => { bankList.hidden = !bankList.hidden; };
    el.addEventListener('click', (ev) => { if (!ev.target.closest('.ln-bank')) bankList.hidden = true; });
    bankPaint();
    // live: financed price and total pay back fill their boxes; the line under the fields explains monthly / APR / interest
    const recalc = () => {
      const kind = el.querySelector('[name=kind]').value, price = num('purchase_price'), direct = num('direct_down'), down = num('down_payment'), term = num('term_months'), def = num('deferred_months'), balloon = num('balloon');
      const P = Math.max(0, price - direct); el.querySelector('[name=principal]').value = price || direct ? fmtMoney(P) : '';
      const aprV = el.querySelector('[name=apr]').value, apr = aprV === '' ? null : Number(aprV); let monthly = num('monthly');
      const fin = Math.max(0, P - down), out = el.querySelector('#lnCalc');
      if (!monthly && apr != null && term && kind !== 'lease') { const i = apr / 100 / 12, g = fin * Math.pow(1 + i, def); monthly = i ? g * i / (1 - Math.pow(1 + i, -term)) : g / term; }
      let eff = apr;
      if (eff == null && monthly && term && fin && kind !== 'lease') {
        const pv = (i) => Math.pow(1 + i, -def) * (monthly * (1 - Math.pow(1 + i, -term)) / i + balloon * Math.pow(1 + i, -term));
        if (monthly * term + balloon <= fin + 0.005) eff = 0; else { let lo = 1e-7, hi = 0.1; for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (pv(mid) > fin) lo = mid; else hi = mid; } eff = Math.round((lo + hi) / 2 * 12 * 100 * 1000) / 1000; }
      }
      const st = termSel.value === 'steps' ? readSteps() : [];
      if (st.length && fin && kind !== 'lease' && apr == null) {   /* 1.20.132: the APR behind a stepped schedule — PV of every payment in order */
        const pv = (i) => { let v = 0, k = def; for (const x of st) for (let q = 0; q < x.n; q++) { k++; v += x.amount * Math.pow(1 + i, -k); } return v + balloon * Math.pow(1 + i, -k); };
        if (st.reduce((n, x) => n + x.n * x.amount, 0) + balloon <= fin + 0.005) eff = 0; else { let lo = 1e-7, hi = 0.1; for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (pv(mid) > fin) lo = mid; else hi = mid; } eff = Math.round((lo + hi) / 2 * 12 * 100 * 1000) / 1000; }
      }
      const total = st.length ? down + st.reduce((n, x) => n + x.n * x.amount, 0) + balloon : monthly && term ? down + monthly * term + balloon : 0; el.querySelector('[name=total_payback]').value = total ? fmtMoney(total) : '';
      const tax = num('sales_tax'), taxIn = el.querySelector('[name=tax_in]').value !== '0', prop = 0, axiomTax = el.querySelector('[name=property_tax_axiom]').checked;
      if (!P && !monthly) { out.innerHTML = ''; return; }
      out.innerHTML = 'Financed <b>' + usd(fin) + '</b>' + (direct ? ' after ' + usd(direct) + ' paid direct' : '') + (down ? (direct ? ' and ' : ' after ') + usd(down) + ' down to the lender' : '') + (st.length ? ' · ' + st.map(x => x.n + ' × <b>' + usd(x.amount) + '</b>').join(' then ') + ' (' + term + ' months)' : monthly ? ' · <b>' + usd(monthly) + '</b> × ' + term : '') + (def && (st.length || monthly) ? ' after ' + def + ' month' + (def === 1 ? '' : 's') + ' with no payment' : '') +
        (eff != null && kind !== 'lease' ? ' · <b>' + eff + '%</b> APR' + (apr == null ? ' (computed from the payments)' : '') : '') + (total ? ' · total back <b>' + usd(total) + '</b>' + (total - P > 0 ? ' (' + usd(total - P) + ' interest)' : '') : '') +
        (tax ? '<br>Sales tax ' + usd(tax) + (taxIn ? ' is inside the total sale' : ' is excluded — Axiom pays it separately') : '') +
        (axiomTax ? '<br>Property tax on the machine is Axiom\u2019s to pay' : '') + (prop ? '' : '');
    };
    el.querySelectorAll('.ln-money').forEach(i => { i.addEventListener('blur', () => { i.value = fmtMoney(i.value); recalc(); }); i.addEventListener('input', recalc); });
    el.querySelectorAll('[name=apr],[name=term_months],[name=deferred_months],[name=kind],[name=tax_in],[name=purchase_price],[name=direct_down],[name=property_tax_axiom]').forEach(i => { i.addEventListener('input', recalc); i.addEventListener('change', recalc); });
    stepsSync();
    el.querySelector('#lnSave').onclick = async () => {
      const body = {}; el.querySelectorAll('[name]').forEach(i => { body[i.name] = i.type === 'checkbox' ? (i.checked ? 1 : 0) : i.classList.contains('ln-money') ? String(i.value).replace(/[$,\s]/g, '') : i.value; });
      if (!body.name.trim()) { el.querySelector('#lnMsg').textContent = 'Give the loan a name.'; return; }
      const r = await post(isEdit ? '/api/bookkeeping/loans/' + l.id : '/api/bookkeeping/loans', body);
      if (!r.ok) { el.querySelector('#lnMsg').textContent = r.error || 'Could not save.'; return; }
      close(); done();
      if (!isEdit && r.id) { const jj = await api('/api/bookkeeping/loans'); if (jj.ok) { const nl = (jj.loans || []).find(x => x.id === r.id); if (nl && await ask('**' + body.name.trim() + '** is saved. Add its documents now — the signed agreement, terms, schedule?', { ok: 'Add documents', cancel: 'Later' })) loanForm(nl, jj, done); } }
    };
    // 1.19.136: documents — drop / choose / paste; raw upload with the name in a header; opened through the bearer as blob URLs
    if (isEdit) {
      const list = el.querySelector('#lnFiles'), drop = el.querySelector('#lnDrop'), pick = el.querySelector('#lnFile');
      const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
      // 1.20.134: a coloured pill per label (a native select cannot be styled) — click opens a small list
      const LABELS = [['Signed Contract', 'sc'], ['Signed Loan', 'sl'], ['Proposal', 'pr'], ['Wire Instructions', 'wi'], ['Other', 'ot']];
      const lblCls = (name) => (LABELS.find(x => x[0] === name) || ['', 'ot'])[1];
      const labelPill = (f) => '<span class="ln-lbl"><button type="button" class="ln-lbl-b ' + (f.label ? lblCls(f.label) : 'none') + '" data-label="' + f.id + '">' + (f.label ? esc(f.label) : '+ label') + '</button><div class="ln-lbl-l" hidden>' + LABELS.map(x => '<div class="ln-lbl-o" data-v="' + x[0] + '"><i class="ln-lbl-d ' + x[1] + '"></i>' + x[0] + '</div>').join('') + '<div class="ln-lbl-o" data-v=""><i class="ln-lbl-d none"></i>No label</div></div></span>';
      const wireLabel = (sp, onPick) => { const b = sp.querySelector('.ln-lbl-b'), lst = sp.querySelector('.ln-lbl-l'); b.onclick = (ev) => { ev.stopPropagation(); el.querySelectorAll('.ln-lbl-l').forEach(x => { if (x !== lst) x.hidden = true; }); lst.hidden = !lst.hidden; };
        lst.querySelectorAll('.ln-lbl-o').forEach(o => o.onclick = (ev) => { ev.stopPropagation(); lst.hidden = true; const v = o.dataset.v; b.className = 'ln-lbl-b ' + (v ? lblCls(v) : 'none'); b.textContent = v || '+ label'; onPick(v); }); };
      el.addEventListener('click', () => el.querySelectorAll('.ln-lbl-l').forEach(x => { x.hidden = true; }));
      let upLabel = '';
      const up = el.querySelector('#lnUpLabelBox'); if (up) { up.innerHTML = labelPill({ id: 'new', label: '' }); wireLabel(up.querySelector('.ln-lbl'), (v) => { upLabel = v; }); }
      const fIcon = (f) => f.ext === 'pdf' ? '<span class="ln-fi pdf">PDF</span>' : f.ext === 'docx' ? '<span class="ln-fi doc">DOC</span>' : f.ext === 'xlsx' ? '<span class="ln-fi xls">XLS</span>' : '<span class="ln-fi img">IMG</span>';
      const paintFiles = async () => {
        const r = await api('/api/bookkeeping/loans/' + l.id + '/files'); const files = r.files || [];
        list.innerHTML = files.length ? files.map(f => '<div class="ln-file" data-f="' + f.id + '">' + fIcon(f) + '<div class="ln-fn"><a href="#" data-open="' + f.id + '" title="Open">' + esc(f.name) + '</a><div class="bk-dim">' + kb(f.size || 0) + (f.uploaded_by ? ' · ' + esc(f.uploaded_by.split('@')[0]) : '') + (f.created_at ? ' · ' + esc(new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : '') + '</div></div>' +
          labelPill(f) + '<a href="#" class="bk-dim" data-dl="' + f.id + '" title="Download">' + iconSvg('download') + '</a><a href="#" class="bk-dim" data-rm="' + f.id + '" title="Remove">×</a></div>').join('') : '<div class="bk-dim" style="padding:4px 2px">No documents yet.</div>';
        list.querySelectorAll('.ln-lbl').forEach(sp => wireLabel(sp, (v) => post('/api/bookkeeping/files/' + sp.querySelector('.ln-lbl-b').dataset.label, { label: v })));
        list.querySelectorAll('[data-open]').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); const rr = await fetch('/api/bookkeeping/files/' + a.dataset.open, { headers: { 'Authorization': 'Bearer ' + token } }); if (!rr.ok) return alert('File not available.'); window.open(URL.createObjectURL(await rr.blob()), '_blank', 'noopener'); });
        list.querySelectorAll('[data-dl]').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); const f = files.find(x => String(x.id) === a.dataset.dl); const rr = await fetch('/api/bookkeeping/files/' + a.dataset.dl + '?dl=1', { headers: { 'Authorization': 'Bearer ' + token } }); if (!rr.ok) return alert('File not available.'); const u = URL.createObjectURL(await rr.blob()); const x = document.createElement('a'); x.href = u; x.download = f ? f.name : 'document'; document.body.appendChild(x); x.click(); x.remove(); });
        list.querySelectorAll('[data-rm]').forEach(a => a.onclick = async (ev) => { ev.preventDefault(); const f = files.find(x => String(x.id) === a.dataset.rm); if (!(await ask('Remove **' + (f ? f.name : 'this file') + '**?', { ok: 'Remove', danger: true }))) return; await post('/api/bookkeeping/files/' + a.dataset.rm + '/delete', {}); paintFiles(); });
      };
      const upload = async (fl) => {
        const msg = el.querySelector('#lnMsg'); let n = 0;
        for (const f of Array.from(fl || [])) {
          msg.textContent = 'Uploading ' + f.name + '…';
          const r = await fetch('/api/bookkeeping/loans/' + l.id + '/files', { method: 'POST', headers: Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) }, upLabel ? { 'X-File-Label': upLabel } : {}), body: f }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
          if (!r.ok) { msg.textContent = f.name + ': ' + (r.error || 'could not upload'); continue; }
          n++;
        }
        if (n) msg.textContent = n + ' file' + (n === 1 ? '' : 's') + ' added.';
        paintFiles();
      };
      drop.onclick = () => pick.click(); drop.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick.click(); } };
      pick.onchange = () => { upload(pick.files); pick.value = ''; };
      ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (ev) => upload(ev.dataTransfer.files));
      el.addEventListener('paste', (ev) => { const fs = Array.from((ev.clipboardData || {}).files || []); if (fs.length) { ev.preventDefault(); upload(fs); } });
      paintFiles();
    }
    const del = el.querySelector('#lnDel'); if (del) del.onclick = async () => { if (!(await ask('Delete "' + l.name + '"? Linked bank lines are kept, just unlinked.', { ok: 'Delete', danger: true }))) return; await post('/api/bookkeeping/loans/' + l.id + '/delete', {}); close(); done(); };
  }
  function equipmentEditor(e, vendors, done) {
    let mode = e.mode || 'owned';
    const el = document.createElement('div'); el.className = 'bk-modal';
    const f = (k, label, type, extra) => '<label>' + label + '<input class="bk" name="' + k + '" type="' + (type || 'text') + '" value="' + esc(e[k] != null ? e[k] : '') + '"' + (extra || '') + '></label>';
    const money = (k, l) => f(k, l, 'number', ' step="0.01" min="0"'), date = (k, l) => f(k, l, 'date'), int = (k, l) => f(k, l, 'number', ' step="1" min="0"');
    const fields = () => mode === 'owned' ? money('purchase_price', 'Purchase price') + date('purchase_date', 'Purchase date') + f('life_years', 'Useful life (years)', 'number', ' step="0.5" min="0" placeholder="7"') + money('salvage', 'Salvage value') + '<div class="wide bk-dim">Straight-line depreciation from the purchase date; the book value on Jan 1 of each year is what goes on the balance sheet.</div>'
      : mode === 'loan' ? money('purchase_price', 'Purchase price') + date('purchase_date', 'Purchase date') + money('down_payment', 'Down payment') + money('loan_amount', 'Loan amount (price − down, if empty)') + int('loan_term', 'Loan term (months)') + f('loan_rate', 'Interest rate (% APR)', 'number', ' step="0.01" min="0"') + date('loan_start', 'First payment (purchase date if empty)') + money('monthly_payment', 'Monthly payment') + f('life_years', 'Useful life (years)', 'number', ' step="0.5" min="0" placeholder="7"') + '<div class="wide bk-dim">Each monthly payment lands on this machine; principal vs interest for the P&amp;L is split later from the rate.</div>'
      : date('lease_start', 'Lease start') + int('lease_term', 'Lease term (months)') + money('lease_monthly', 'Monthly payment') + '<div class="wide bk-dim">A lease is not an asset: every payment is an expense on the P&amp;L. The machine still shows here with its payment history.</div>';
    const paint = () => {
      el.innerHTML = '<div class="bk-modal-box" style="width:min(640px,100%)"><div class="bk-modal-title">' + esc(e.name) + '</div>' + (e.team ? '<div class="bk-muted">' + esc(e.team) + '</div>' : '') +
        '<div class="eq-modes">' + ['owned', 'loan', 'lease'].map(m => '<button class="bk-btn' + (mode === m ? ' p' : '') + '" data-mode="' + m + '">' + { owned: 'Owned outright', loan: 'On a loan', lease: 'Leased' }[m] + '</button>').join('') + '</div>' +
        '<div class="eq-form"><label class="wide">Vendor / lender<select class="bk" name="vendor_id"><option value="">— none —</option>' + vendors.map(x => '<option value="' + x.id + '"' + (e.vendor_id === x.id ? ' selected' : '') + '>' + esc(x.name) + (x.kind ? ' · ' + esc(x.kind) : '') + '</option>').join('') + '</select></label>' + fields() +
        '<label class="wide">Notes<input class="bk" name="notes" value="' + esc(e.notes || '') + '" placeholder="Serial number, who holds the loan, anything worth remembering"></label></div>' +
        '<div class="bk-ask-acts"><button class="bk-btn" data-no>Cancel</button><button class="bk-btn p" data-yes>Save</button></div></div>';
      el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { collect(); mode = b.dataset.mode; paint(); });
      el.querySelector('[data-no]').onclick = () => el.remove();
      el.querySelector('[data-yes]').onclick = async () => { collect(); const body = Object.assign({}, e, { mode }); delete body.payments; delete body.schedule; delete body.book; const r = await post('/api/bookkeeping/equipment/' + e.id, body); if (!r.ok) return alert(r.error); el.remove(); done(); if (r.linked) overview(); };
    };
    const collect = () => { el.querySelectorAll('input[name], select[name]').forEach(i => { e[i.name] = i.value === '' ? null : (i.type === 'number' ? Number(i.value) : i.value); }); };
    paint(); document.body.appendChild(el); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
  }
  async function equipmentPayments(e) {
    const j = await api('/api/bookkeeping/equipment/' + e.id + '/payments'); const t = j.transactions || [], b = j.bills || [];
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(640px,100%)"><div class="bk-modal-title">' + esc(e.name) + ' — payments</div>' +
      (t.length ? '<div class="vp-h">Bank lines</div><table class="bk eq-pay"><tbody>' + t.map(x => '<tr><td>' + esc(x.date) + '</td><td>' + esc(x.merchant || x.name) + '<div class="bk-dim">' + esc(x.category || '') + (x.account_name ? ' · ' + esc(x.account_name) : '') + '</div></td><td class="num"><b>' + usd(Math.abs(x.amount)) + '</b></td><td><button class="bk-btn sm" data-unt="' + x.id + '" title="Not this machine">×</button></td></tr>').join('') + '</tbody></table>' : '') +
      (b.length ? '<div class="vp-h">Bills</div><table class="bk eq-pay"><tbody>' + b.map(x => '<tr><td>' + esc(x.invoice_date || '') + '</td><td>Bill #' + x.id + (x.invoice_no ? ' · ' + esc(x.invoice_no) : '') + '<div class="bk-dim">' + esc(x.status) + '</div></td><td class="num"><b>' + usd(x.total) + '</b></td><td><button class="bk-btn sm" data-unb="' + x.id + '" title="Not this machine">×</button></td></tr>').join('') + '</tbody></table>' : '') +
      (!t.length && !b.length ? '<div class="bk-muted">Nothing linked yet.</div>' : '') +
      '<div class="bk-ask-acts"><button class="bk-btn" data-no>Close</button></div></div>';
    document.body.appendChild(el); el.querySelector('[data-no]').onclick = () => el.remove(); el.onclick = (ev) => { if (ev.target === el) el.remove(); };
    el.querySelectorAll('[data-unt]').forEach(x => x.onclick = async () => { await post('/api/bookkeeping/equipment/' + e.id + '/link', { transaction_id: Number(x.dataset.unt), off: 1 }); el.remove(); loadEquipment(); });
    el.querySelectorAll('[data-unb]').forEach(x => x.onclick = async () => { await post('/api/bookkeeping/equipment/' + e.id + '/link', { bill_id: Number(x.dataset.unb), off: 1 }); el.remove(); loadEquipment(); });
  }

  // ---------------------------------------------------------------- Connections
  async function loadConn() {
    await overview();
    const v = $('vConn'), c = ov.connections, s = ov.settings;
    const pill = (on, yes, no) => '<span class="bk-pill ' + (on ? 'on' : 'off') + '">' + (on ? yes : no) + '</span>';
    v.innerHTML = '<div class="bk-conn">' +
      // Alerts (purchases waiting / not received)
      '<div class="bk-card"><h2>Alerts ' + qHelp('alerts', 'Alerts', 'Two things can sit unfinished on a purchase: a payment with no bank line yet (an order confirmation you marked Transaction), and goods with no arrival. Each morning at the time below Nova emails one list of everything older than these limits to the address here, and keeps emailing daily until each one is handled (matched, received, or cancelled).') + '</h2>' +
      '<div class="bk-row" style="gap:14px;flex-wrap:wrap"><label class="bk-muted">Waiting for the bank after <input class="bk" id="aWait" type="number" min="1" max="365" value="' + esc(s.waiting_days) + '" style="width:64px"> days</label>' +
      '<label class="bk-muted">Not received after <input class="bk" id="aRecv" type="number" min="1" max="365" value="' + esc(s.notreceived_days) + '" style="width:64px"> days</label>' +
      '<label class="bk-muted">Email <input class="bk" id="aTo" type="email" value="' + esc(s.alert_to) + '" style="width:220px"></label>' +
      '<label class="bk-muted" style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">at <input class="bk" id="aAt" type="time" value="' + esc(s.alert_at || '08:00') + '" style="width:120px"> LA time</label>' +
      '<button class="bk-btn sm" id="alertNow" title="Send the list now, whatever the time">Send now</button></div>' +
      '<div class="bk-row" style="gap:14px;flex-wrap:wrap;margin-top:10px"><span class="bk-muted">Customer payments — "Notify Accounts Receivable" on a deposit emails</span><label class="bk-muted">To <input class="bk" id="arTo" type="email" value="' + esc(s.ar_to || '') + '" style="width:220px"></label><label class="bk-muted">Cc <input class="bk" id="arCc" value="' + esc(s.ar_cc || '') + '" style="width:260px" placeholder="paymentsupport@axiomprint.com"></label></div>' +
      '<div class="bk-muted" style="margin-top:8px">Goods or service is decided by the type of expense in the Chart of Accounts ("expects delivery"), and can be flipped on any purchase.</div></div>' +
      // Plaid
      '<div class="bk-card"><h2>Bank accounts ' + pill(c.plaid.configured, 'Plaid keys set (' + esc(c.plaid.env) + ')', 'Plaid keys not in .env') + '<span class="sp"></span>' + (c.plaid.leftovers ? '<button class="bk-btn bad" id="plaidPurge" title="Remove the sandbox connections and every test transaction, proposal and purchase that came from them. Bills and emails stay.">Remove test data</button>' : '') + '<button class="bk-btn p" id="plaidLink"' + (c.plaid.configured ? '' : ' disabled') + '>Connect a bank</button></h2>' +
      (c.plaid.items.length ? '<table class="bk"><thead><tr><th>Bank</th><th>Accounts</th><th>Last sync</th><th>Status</th><th></th></tr></thead><tbody>' + c.plaid.items.map(it => '<tr><td>' + esc(it.institution) + '</td><td>' + it.accounts.map(a => '<label class="bk-acct' + ((it.excluded || []).indexOf(a.account_id) > -1 ? ' off' : '') + '"><input type="checkbox" data-acct="' + esc(a.account_id) + '" data-item="' + it.id + '"' + ((it.excluded || []).indexOf(a.account_id) > -1 ? '' : ' checked') + '> ' + esc(a.name) + (a.mask ? ' ••' + esc(a.mask) : '') + ((it.excluded || []).indexOf(a.account_id) > -1 ? ' <span class="bk-dim">not in use</span>' : '') + '</label>').join('') + '</td><td>' + when(it.last_sync_at) + '</td><td>' + (it.env && it.env !== c.plaid.env ? '<span class="bk-pill err" title="Connected under Plaid ' + esc(it.env) + '; Nova now runs ' + esc(c.plaid.env) + ' — disconnect it and connect the real bank">' + esc(it.env) + ' — reconnect</span>' : it.status === 'ok' ? '<span class="bk-pill on">ok</span>' : '<span class="bk-pill err">' + esc(it.error || it.status) + '</span>') + '</td><td><button class="bk-btn sm" data-more="' + it.id + '" title="Re-open the bank sign-in in update mode and ask Plaid for up to 2 years of history on this same connection — the older months come in on the next sync, nothing is doubled">More history</button> <button class="bk-btn sm bad" data-unlink="' + it.id + '">Disconnect</button></td></tr>').join('') + '</tbody></table>'
        : '<div class="bk-muted">No bank connected yet.</div>') +
      '<ol class="bk-steps"><li>Create a Plaid account at dashboard.plaid.com (the Transactions product; Sandbox to try, then request Production / Limited Production).</li><li>Put <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code> and <code>PLAID_ENV=sandbox|production</code> in <code>.env</code> and restart Nova.</li><li>Nothing to set in the dashboard\u2019s Webhooks page (that page is only for Transfer / Wallet / Income events): the Transactions webhook <code>' + esc(c.chat.plaid_webhook_url) + '</code> is attached to every bank connection Nova creates. Under Team Settings \u2192 API \u2192 <b>Allowed redirect URIs</b> add <code>https://nova.axiomprint.com/bookkeeping/plaid-oauth</code> \u2014 banks that sign you in on their own page (Chase, Bank of America, Wells Fargo, Capital One\u2026) send you back there.</li><li>Press <b>Connect a bank</b> and sign in to each bank (2 accounts). Transactions sync straight away; the webhook keeps them current, the daily run syncs again.</li></ol></div>' +
      // Gmail
      '<div class="bk-card"><h2>Inbox ' + qHelp('inbox_baskets', 'Inbox baskets', 'What each basket means, in your words. The (?) next to a basket in the Inbox shows this text, and BookkeeperAI sorts incoming mail by these definitions — change them and the next scan sorts by the new words. Do Later is never filled by the AI.') + '</h2>' +
      '<div class="bk-muted" style="margin-bottom:8px">How BookkeeperAI decides which basket an email goes to. Edit freely; {poll} in the All line becomes the minutes between checks.</div>' +
      [['all', 'All'], ['bill', 'Bills'], ['receipt', 'Transactions'], ['arrival', 'Delivery'], ['message', 'Messages'], ['advertisement', 'Ads'], ['other', 'Other'], ['aside', 'Do Later']].map(([k, l]) => '<label class="bk-row" style="gap:10px;align-items:flex-start;margin:6px 0"><b style="flex:0 0 110px;padding-top:7px;font-size:13px">' + l + '</b><textarea class="bk bkt" data-basket="' + k + '" rows="2" style="flex:1;margin:0;font-size:13px;resize:vertical">' + esc((ov.baskets || {})[k] || '') + '</textarea></label>').join('') +
      '<div class="bk-row" style="margin-top:6px"><button class="bk-btn p" id="basketsSave">Save baskets</button><button class="bk-btn" id="basketsReset" title="Back to the built-in wording">Reset to defaults</button><span class="bk-muted" id="basketsMsg"></span></div></div>' +
      '<div class="bk-card"><h2>Accounting inbox — ' + esc(c.gmail.inbox) + ' ' + pill(c.gmail.key, 'service account key present', 'gmail-key.json missing') + '<span class="sp"></span><button class="bk-btn" id="scanNow2">Scan now</button></h2>' +
      '<div class="bk-muted">Read with the same Google service account Nova uses for order@ (domain-wide delegation). Polled every ' + esc(c.gmail.poll_min) + ' min' + (c.gmail.last_scan ? ' · last scan ' + when(c.gmail.last_scan) : ' · not scanned yet') + '. Gmail push: ' + (c.gmail.push && c.gmail.topic ? '<span class="bk-pill on">configured</span>' + (c.gmail.watch_expires ? ' watch until ' + when(c.gmail.watch_expires) : ' — press Start watch') : '<span class="bk-pill off">not set up (polling only)</span>') + '</div>' +
      '<ol class="bk-steps"><li>Nothing to do for reading: the delegation that covers order@ covers accounting@ too (scope gmail.readonly). If scanning fails with "unauthorized_client", add the scope in Google Admin → Security → API controls → Domain-wide delegation.</li>' +
      '<li>Optional, for instant pickup: in the Google Cloud project of the service account enable Pub/Sub, create a topic, give <code>gmail-api-push@system.gserviceaccount.com</code> the Publisher role on it, add a push subscription to <code>' + esc(c.chat.push_url) + '</code>, then set <code>BOOKKEEPER_PUBSUB_TOPIC</code> and <code>BOOKKEEPER_PUSH_TOKEN</code> in .env and press <button class="bk-btn sm" id="watchBtn">Start watch</button> (it renews daily).</li></ol>' +
      '<div class="bk-row" style="margin-top:8px"><label class="bk-muted">Check every <input class="bk" id="sPoll" type="number" min="2" max="120" value="' + esc(s.poll_min) + '" style="width:70px"> min</label><label class="bk-muted">First scan looks back <input class="bk" id="sBack" type="number" min="1" max="90" value="' + esc(s.backfill_days) + '" style="width:70px"> days</label></div>' +
      '<div class="bk-muted" style="margin-top:12px"><label><input type="checkbox" id="tAuto"' + (s.triage_auto ? ' checked' : '') + '> <b>Let BookkeeperAI set emails aside by itself</b> (off: it only rates them and you click "Set aside all ads" in the Inbox)</label></div>' +
      '<div class="bk-muted" style="margin-top:8px"><b>Confidence it needs</b> to…</div>' +
      '<div class="bk-row" style="margin-top:6px;gap:16px"><label class="bk-muted">set an <b>ad / receipt</b> aside <input class="bk" id="tAd" type="number" min="30" max="100" value="' + Math.round(s.triage_ad * 100) + '" style="width:64px">%</label>' +
      '<label class="bk-muted">set a <b>delivery</b> notice aside <input class="bk" id="tNotice" type="number" min="30" max="100" value="' + Math.round(s.triage_notice * 100) + '" style="width:64px">%</label>' +
      '<label class="bk-muted">treat as a <b>bill</b> to be paid <input class="bk" id="tBill" type="number" min="30" max="100" value="' + Math.round(s.triage_bill * 100) + '" style="width:64px">%</label>' +
      '<label class="bk-muted">keep a <b>message</b> for a person <input class="bk" id="tMsg" type="number" min="30" max="100" value="' + Math.round(s.triage_message * 100) + '" style="width:64px">%</label></div>' +
      '<div class="bk-dim" style="margin-top:4px">Below the bill threshold it still reads the email in full before deciding — a missed bill costs more than a model call.</div></div>' +
      // Google Chat
      '<div class="bk-card"><h2>Google Chat — Gary and Arsine ' + (c.chat.space ? '<span class="bk-pill on">Chat app connected</span>' : c.chat.webhook ? '<span class="bk-pill on">webhook set (post only)</span>' : '<span class="bk-pill off">not connected</span>') + '<span class="sp"></span><button class="bk-btn" id="chatTest">Send a test message</button></h2>' +
      '<div class="bk-muted">The Daily Brief is posted every morning at <input class="bk" id="sRunAt" type="time" style="width:auto;display:inline-block" value="' + esc(s.run_at) + '"> (Los Angeles). Who may approve in Chat: ' + esc(c.chat_users.join(', ')) + ' (BOOKKEEPER_CHAT_USERS).</div>' +
      '<p class="bk-muted" style="margin:10px 0 4px"><b>Quick start (one-way):</b> in Google Chat open the space with Gary and Arsine → space name → Apps &amp; integrations → Add webhooks → name it BookkeeperAI → paste the URL here:</p>' +
      '<div class="bk-row"><input class="bk" id="sHook" placeholder="https://chat.googleapis.com/v1/spaces/…/messages?key=…" style="flex:1;min-width:260px" value=""><span class="bk-muted">' + (s.chat_webhook ? 'a webhook is saved' : '') + '</span></div>' +
      '<p class="bk-muted" style="margin:10px 0 4px"><b>Two-way (reply in Chat):</b> a Google Chat app. In the Google Cloud project of the service account: enable the <b>Google Chat API</b> → Configuration: app name BookkeeperAI, avatar, description; Functionality: receive 1:1 messages and join spaces; Connection settings: HTTP endpoint URL <code>' + esc(c.chat.events_url) + '</code>; Visibility: make it available to specific people (Gary, Arsine). Put the project <b>number</b> in <code>BOOKKEEPER_CHAT_AUDIENCE</code> in .env, restart, then add the app to the space and say hi — Nova remembers the space and posts the brief there.' +
      (c.chat.app_audience ? ' <span class="bk-pill on">audience set</span>' : ' <span class="bk-pill off">BOOKKEEPER_CHAT_AUDIENCE not set</span>') + '</p>' +
      '<div class="bk-muted">A bookkeeperAI@axiomprint.com mailbox is not needed for this — the app posts as itself in the space. (If you still want that address, create it in Google Admin and it can be the sender of email copies later.)</div>' +
      '<div class="bk-row" style="margin-top:10px"><button class="bk-btn p" id="connSave">Save</button><span class="bk-muted" id="connMsg"></span></div></div>' +
      '<div class="bk-card"><h2>Who can open this tab</h2><div class="bk-muted">' + esc(c.users.join(', ')) + ' (BOOKKEEPER_USERS in .env; you are signed in as ' + esc(ov.me) + ').</div></div></div>';
    $('alertNow').onclick = async () => { $('alertNow').disabled = true; const r = await post('/api/bookkeeping/purchases/alert', {}); $('connMsg').textContent = r.ok ? (r.sent ? 'Sent: ' + r.n + ' overdue purchase(s) to ' + ov.settings.alert_to + '.' : 'Nothing overdue — no email sent.') : r.error; $('alertNow').disabled = false; };
    $('basketsSave').onclick = async () => { const o = {}; v.querySelectorAll('textarea[data-basket]').forEach(t => { o[t.dataset.basket] = t.value.trim(); }); const r = await post('/api/bookkeeping/settings', { baskets: JSON.stringify(o) }); $('basketsMsg').textContent = r.ok ? 'Saved — the next scan sorts by these.' : (r.error || 'Not saved'); ov = null; };
    $('basketsReset').onclick = async () => { if (!await ask('Put the built-in wording back in every basket?', { title: 'Reset basket definitions', ok: 'Reset' })) return; await post('/api/bookkeeping/settings', { baskets: '{}' }); ov = null; loadConn(); };
    $('connSave').onclick = async () => { const b = { run_at: $('sRunAt').value, poll_min: $('sPoll').value, backfill_days: $('sBack').value, waiting_days: $('aWait').value, notreceived_days: $('aRecv').value, alert_to: $('aTo').value.trim(), alert_at: $('aAt').value, ar_to: $('arTo').value.trim(), ar_cc: $('arCc').value.trim(), triage_ad: $('tAd').value / 100, triage_notice: $('tNotice').value / 100, triage_bill: $('tBill').value / 100, triage_message: $('tMsg').value / 100, triage_auto: $('tAuto').checked ? 1 : 0 }; if ($('sHook').value.trim()) b.chat_webhook = $('sHook').value.trim(); await post('/api/bookkeeping/settings', b); $('connMsg').textContent = 'Saved.'; loadConn(); };
    $('chatTest').onclick = async () => { $('chatTest').disabled = true; const r = await post('/api/bookkeeping/chat/test', {}); $('connMsg').textContent = r.ok ? 'Sent via ' + r.posted.via + '.' : r.error; $('chatTest').disabled = false; };
    $('scanNow2').onclick = async () => { $('scanNow2').disabled = true; const r = await post('/api/bookkeeping/scan', {}); $('connMsg').textContent = r.ok ? 'Scanned: ' + r.scan.new + ' new email(s), ' + r.parsed.bills + ' bill draft(s).' : r.error; loadConn(); };
    if ($('watchBtn')) $('watchBtn').onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/gmail/watch', {}); $('connMsg').textContent = r.ok ? 'Watching.' : r.error; loadConn(); };
    // 1.19.57: untick an account (a personal one on the same login) and its lines disappear from every view; tick it back and they return
    v.querySelectorAll('[data-acct]').forEach(cb => cb.onchange = async () => {
      const item = cb.dataset.item, excluded = Array.from(v.querySelectorAll('[data-acct][data-item="' + item + '"]')).filter(x => !x.checked).map(x => x.dataset.acct);
      const r = await post('/api/bookkeeping/plaid/items/' + item + '/accounts', { excluded });
      if (!r.ok) { alert(r.error || 'Could not save'); cb.checked = !cb.checked; return; }
      loadConn(); overview();
    });
    v.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => { if (!await ask('Its transactions stay; new ones stop coming in.', { title: 'Disconnect this bank?', ok: 'Disconnect', danger: true })) return; await api('/api/bookkeeping/plaid/' + b.dataset.unlink, { method: 'DELETE' }); loadConn(); });
    const openLink = async (token, receivedRedirectUri, update) => {
      await loadScript('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
      const h = window.Plaid.create(Object.assign({ token: token,
        onSuccess: async (public_token, metadata) => { try { localStorage.removeItem('bk_plaid_link_token'); localStorage.removeItem('bk_plaid_update'); } catch (e) {}
          if (update) {   // 1.20.61: update mode — the connection already exists; sync pulls the extra history (duplicates are set aside by the sync itself)
            $('connMsg').textContent = 'Pulling the extra history…'; const r = await post('/api/bookkeeping/sync', {});
            $('connMsg').textContent = r.ok ? 'Done — ' + (r.sync.added || 0) + ' new lines' + (r.sync.dups ? ', ' + r.sync.dups + ' already-known lines set aside' : '') + '.' : (r.error || 'Sync failed');
            ov = null; loadConn(); overview(); return; }
          const x = await post('/api/bookkeeping/plaid/exchange', { public_token, metadata }); $('connMsg').textContent = x.ok ? 'Connected ' + x.institution + (x.first_sync && x.first_sync.added != null ? ' — ' + x.first_sync.added + ' transactions pulled.' : '.') : x.error; $('plaidLink').disabled = false; loadConn(); },
        onExit: () => { $('plaidLink').disabled = false; try { localStorage.removeItem('bk_plaid_link_token'); } catch (e) {} } }, receivedRedirectUri ? { receivedRedirectUri: receivedRedirectUri } : {}));
      h.open();
    };
    if ($('plaidPurge')) $('plaidPurge').onclick = async () => {
      if (!await ask('This removes the sandbox bank connections and every transaction, proposal and purchase that came only from them. Bills and inbox emails stay. It cannot be undone.', { title: 'Remove the test data?', ok: 'Remove test data', danger: true })) return;
      $('plaidPurge').disabled = true; const r = await post('/api/bookkeeping/plaid/purge-sandbox', {});
      $('connMsg').textContent = r.ok ? 'Removed ' + r.connections + ' test connection(s), ' + r.transactions + ' transactions and ' + r.purchases + ' purchases.' : r.error; ov = null; loadConn();
    };
    v.querySelectorAll('[data-more]').forEach(b => b.onclick = async () => {
      if (!await ask('Plaid will re-open this bank\u2019s sign-in and extend the history to up to **2 years** on the same connection. The older months arrive on the next sync; lines Nova already has are recognised and never doubled.', { title: 'Pull more history?', ok: 'Continue' })) return;
      b.disabled = true;
      const r = await post('/api/bookkeeping/plaid/link-token', { item_id: b.dataset.more, days: 730 });
      if (!r.ok) { alert(r.error); b.disabled = false; return; }
      try { localStorage.setItem('bk_plaid_link_token', r.link_token); localStorage.setItem('bk_plaid_update', '1'); } catch (e) {}
      openLink(r.link_token, null, true);
    });
    $('plaidLink').onclick = async () => {
      $('plaidLink').disabled = true;
      const r = await post('/api/bookkeeping/plaid/link-token', {});
      if (!r.ok) { alert(r.error); $('plaidLink').disabled = false; return; }
      try { localStorage.setItem('bk_plaid_link_token', r.link_token); } catch (e) {}   // 1.19.46: an OAuth bank sends the person back to /bookkeeping/plaid-oauth; Link resumes with this token
      openLink(r.link_token, null);
    };
    // Back from the bank's own sign-in page (OAuth): finish the connection with the token Link started with.
    if (window.__plaidReturn) {
      const back = window.__plaidReturn; window.__plaidReturn = null;
      let tok = null; try { tok = localStorage.getItem('bk_plaid_link_token'); } catch (e) {}
      let upd = false; try { upd = localStorage.getItem('bk_plaid_update') === '1'; } catch (e) {}
      if (tok) { $('plaidLink').disabled = true; openLink(tok, back, upd); } else $('connMsg').textContent = 'The bank sent you back, but the connection could not be resumed — press Connect a bank again.';
    }
  }
  function loadScript(src) { return new Promise((ok, no) => { if (document.querySelector('script[src="' + src + '"]')) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }

  // ---------------------------------------------------------------- Activity
  async function loadActivity() {
    const v = $('vActivity');
    const j = await api('/api/bookkeeping/activity');
    v.innerHTML = '<div class="bk-card"><h2>Runs</h2><table class="bk"><thead><tr><th>Started</th><th>Kind</th><th>By</th><th>Result</th></tr></thead><tbody>' +
      (j.runs || []).map(r => '<tr><td>' + when(r.started_at) + '</td><td>' + esc(r.kind) + '</td><td>' + whoHtml(r.started_by || '') + '</td><td>' + (r.finished_at ? (r.ok ? '<span class="bk-pill on">ok</span> ' : '<span class="bk-pill err">failed</span> ') : '<span class="bk-pill off">running</span> ') + esc(r.summary || '') + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="bk-card"><h2>Briefs</h2><table class="bk"><thead><tr><th>Day</th><th>Questions / categories / bills</th><th>Google Chat</th></tr></thead><tbody>' +
      (j.briefs || []).map(b => { let st = {}; try { st = JSON.parse(b.stats || '{}'); } catch (e) {} return '<tr><td>' + esc(b.day) + '</td><td>' + (st.questions || 0) + ' / ' + (st.categories || 0) + ' / ' + (st.bills || 0) + '</td><td>' + (b.posted_at ? 'posted ' + when(b.posted_at) : b.post_error ? '<span class="bk-pill err">' + esc(b.post_error) + '</span>' : 'not posted') + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="bk-card"><h2>Audit log<span class="sp"></span><span class="bk-muted">every action by the agent, the executor and people</span></h2><table class="bk"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Ref</th><th>Detail</th></tr></thead><tbody>' +
      (j.audit || []).map(a => '<tr><td>' + when(a.at) + '</td><td>' + whoHtml(a.who) + '</td><td>' + esc(a.action) + '</td><td>' + esc(a.ref || '') + '</td><td class="bk-muted">' + esc(String(a.detail || '').slice(0, 200)) + '</td></tr>').join('') + '</tbody></table></div>';
  }

  // 1.19.46: Plaid OAuth return → remember the address, land on Settings (the bank list), and let it resume Link.
  if (/\/bookkeeping\/plaid-oauth/.test(location.pathname) && /oauth_state_id=/.test(location.search)) { window.__plaidReturn = location.href; history.replaceState(null, '', '/bookkeeping?tab=conn'); }
  const qs = new URLSearchParams(location.search), want = qs.get('tab');
  document.querySelectorAll('.bk-sub button').forEach(b => { const ic = SUB_ICON[b.dataset.s]; if (ic && iconKey(ic) && !b.querySelector('svg')) b.insertAdjacentHTML('afterbegin', iconSvg(ic)); });   // icons once the icon table exists
  if (AR_ONLY) {   /* 1.20.83: Acct Aging + Rules reachable by URL; 1.20.88: an aging-only person always lands on the report */
    (async () => { try { await overview(); } catch (e) {} if (ov && ov.ar === false) show('aging', qs.get('sub') || 'all'); else if (qs.get('tab') === 'aging') show('aging', qs.get('sub') || 'all'); else show('ar', ['done', 'rules'].indexOf(qs.get('sub')) > -1 ? qs.get('sub') : 'open'); })();
    return;
  }
  if (want === 'ar') { location.replace('/nova-ar' + (qs.get('sub') ? '?sub=' + qs.get('sub') : '')); return; }
  show(['brief', 'purchases', 'list', 'bank', 'waiting', 'notreceived', 'bills', 'ar', 'inbox', 'accounts', 'vendors', 'chart', 'rules', 'materials', 'conn', 'activity'].indexOf(want) > -1 ? (want === 'txns' ? 'purchases' : want === 'purchases' && qs.get('sub') === 'bank' ? 'bank' : want) : 'brief', qs.get('sub') === 'bank' ? 'pending' : qs.get('sub'));
})();
