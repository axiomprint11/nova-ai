// Bookkeeping AI — the Daily Brief (approve / reject / answer), transactions, bills, rules, connections, activity.
(function () {
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$/.test(ts) ? '' : 'Z')); return isNaN(d) ? ts : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } }, opts || {}));
    if (r.status === 401) { location.href = '/'; throw new Error('signed out'); }
    if (r.status === 403) { document.querySelector('.bk-main').innerHTML = '<div class="bk-card">Bookkeeping AI is not open to this account.</div>'; throw new Error('forbidden'); }
    return r.json();
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  NovaNav.mount({ current: 'books' });

  let ov = null, categories = [], chart = [];
  document.querySelectorAll('.bk-tabs button').forEach(b => b.onclick = () => show(b.dataset.v));
  // Main tabs with sub-tabs: Accounts (vendors / chart / rules) and Bills (bills / inbox). show('chart') or
  // show('inbox') opens that sub-tab directly; the last sub-tab of each is remembered per browser.
  const TABS = { accounts: { bar: 'subAccounts', subs: { vendors: loadVendors, chart: loadChart, rules: loadRules }, first: 'vendors' }, bills: { bar: 'subBills', subs: { bills: loadBills, inbox: loadInbox }, first: 'bills' } };
  document.querySelectorAll('.bk-sub button').forEach(b => b.onclick = () => show(b.closest('.bk-view').dataset.v, b.dataset.s));
  const lastSub = {}; Object.keys(TABS).forEach(k => { try { lastSub[k] = localStorage.getItem('bk_sub_' + k) || TABS[k].first; } catch (e) { lastSub[k] = TABS[k].first; } });
  function show(v, sub) {
    Object.keys(TABS).forEach(k => { if (TABS[k].subs[v] && v !== k) { sub = v; v = k; } });
    document.querySelectorAll('.bk-tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    document.querySelectorAll('.bk-view').forEach(s => s.classList.toggle('on', s.dataset.v === v));
    const T = TABS[v];
    if (T) {
      sub = T.subs[sub] ? sub : lastSub[v]; lastSub[v] = sub; try { localStorage.setItem('bk_sub_' + v, sub); } catch (e) {}
      document.querySelectorAll('#' + T.bar + ' button').forEach(b => b.classList.toggle('on', b.dataset.s === sub));
      document.querySelectorAll('.bk-view[data-v="' + v + '"] .bk-subview').forEach(s => s.classList.toggle('on', s.dataset.s === sub));
      T.subs[sub]();
      try { history.replaceState(null, '', '/bookkeeping?tab=' + v + '&sub=' + sub); } catch (e) {}
      return;
    }
    ({ brief: loadBrief, txns: loadTxns, materials: loadMaterials, conn: loadConn, activity: loadActivity })[v]();
    try { history.replaceState(null, '', '/bookkeeping?tab=' + v); } catch (e) {}
  }
  async function overview() {
    ov = await api('/api/bookkeeping/overview');
    chart = ov.chart || [];
    categories = chart.filter(c => c.parent || !c.children).map(c => c.name).filter((n, i, a) => a.indexOf(n) === i);
    $('nPending').textContent = ov.counts.pending || '';
    const rs = $('runState');
    if (ov.running) { rs.className = 'bk-pill off'; rs.textContent = 'Running…'; }
    else if (ov.last_run) { rs.className = 'bk-pill ' + (ov.last_run.ok ? 'on' : 'err'); rs.textContent = (ov.last_run.ok ? 'Last run ' : 'Last run failed ') + when(ov.last_run.started_at); rs.title = ov.last_run.summary || ''; rs.style.cursor = 'pointer';
      rs.onclick = () => alert((ov.last_run.ok ? 'Last run ' : 'Last run FAILED ') + when(ov.last_run.started_at) + (ov.last_run.started_by ? ' (' + ov.last_run.started_by + ')' : '') + '\n\n' + (ov.last_run.summary || 'no details') + '\n\nEvery run is listed under Activity.'); }
    else { rs.className = 'bk-pill off'; rs.textContent = 'Not run yet'; }
    return ov;
  }
  // ---------------------------------------------------------------- "?" help: hover = tooltip, click = popup
  const HELP = {};
  const qHelp = (key, title, html) => { HELP[key] = { title, html }; return '<button type="button" class="bk-q" data-help="' + esc(key) + '">?</button>'; };
  let tipEl = null;
  document.addEventListener('mouseover', (e) => {
    const b = e.target.closest && e.target.closest('[data-help]'); if (!b || tipEl) return;
    const h = HELP[b.dataset.help]; if (!h) return;
    tipEl = document.createElement('div'); tipEl.className = 'bk-tip'; tipEl.innerHTML = h.html; document.body.appendChild(tipEl);
    const r = b.getBoundingClientRect(), W = Math.min(420, window.innerWidth - 16);
    tipEl.style.width = W + 'px'; tipEl.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - W - 8)) + 'px'; tipEl.style.top = (r.bottom + 8) + 'px';
    const off = () => { if (tipEl) { tipEl.remove(); tipEl = null; } b.removeEventListener('mouseleave', off); };
    b.addEventListener('mouseleave', off);
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

  // ---------------------------------------------------------------- category picker
  // catSelect(cur, cls, blank, { multi }) draws a picker: a button with the choice (chips when multi) + a hidden input
  // carrying the value (`cls` on both the wrapper and the input, so `root.querySelector('.cls').value` still works; several
  // choices are joined with "; "). Click → a popover: search, the types of expense as collapsible groups, "+ New category…".
  const parentOf = (name) => { const c = chart.find(x => x.name === name && x.parent); return c ? c.parent : ''; };
  const catLabel = (name) => { const p = parentOf(name); return p ? esc(p) + ' <span class="bk-dim">›</span> ' + esc(name) : esc(name || ''); };
  const splitCats = (v) => String(v || '').split(/\s*[;|\n]\s*/).map(x => x.trim()).filter(Boolean);
  const catSelect = (cur, cls, blank, o) => {
    o = o || {}; const vals = splitCats(cur);
    return '<span class="ckp ' + esc(cls || '') + (o.multi ? ' multi' : '') + '" data-blank="' + esc(blank || '') + '"><button type="button" class="ckp-btn">' + ckpFace(vals, blank, !!o.multi) + '</button><input type="hidden" class="' + esc(cls || '') + ' ckp-val" value="' + esc(vals.join('; ')) + '"></span>';
  };
  const ckpFace = (vals, blank, multi) => {
    if (!vals.length) return '<span class="ckp-empty">' + esc(blank || 'Choose…') + '</span><span class="ckp-caret"></span>';
    if (!multi) { const p = parentOf(vals[0]), st = styleOf(p || vals[0]); return '<span class="ckp-one">' + (p ? '<small><span class="dot" style="background:' + esc(st.color) + '"></span>' + esc(p) + '</small>' : '') + esc(vals[0]) + '</span><span class="ckp-caret"></span>'; }
    return vals.map(v => { const st = styleOf(parentOf(v) || v); return '<span class="ckp-chip"><span class="dot" style="background:' + esc(st.color) + '"></span>' + esc(v) + '<i data-rm="' + esc(v) + '" title="Remove">×</i></span>'; }).join('') + '<span class="ckp-caret"></span>';
  };
  const ckpSet = (wrap, vals) => { wrap.querySelector('.ckp-val').value = vals.join('; '); wrap.querySelector('.ckp-btn').innerHTML = ckpFace(vals, wrap.dataset.blank, wrap.classList.contains('multi')); wrap.dispatchEvent(new Event('change', { bubbles: true })); };
  let ckpOpen = null, ckpCollapsed = {}; try { ckpCollapsed = JSON.parse(localStorage.getItem('bk_ckp_collapsed') || '{}') || {}; } catch (e) {}
  function ckpClose() { if (ckpOpen) { ckpOpen.pop.remove(); ckpOpen.wrap.classList.remove('open'); ckpOpen = null; } }
  document.addEventListener('click', (e) => {
    const rm = e.target.closest && e.target.closest('.ckp-chip i[data-rm]');
    if (rm) { const wrap = rm.closest('.ckp'); ckpSet(wrap, splitCats(wrap.querySelector('.ckp-val').value).filter(v => v !== rm.dataset.rm)); e.preventDefault(); return; }
    const btn = e.target.closest && e.target.closest('.ckp-btn');
    if (btn) { const wrap = btn.closest('.ckp'); if (ckpOpen && ckpOpen.wrap === wrap) ckpClose(); else { ckpClose(); ckpShow(wrap); } return; }
    if (ckpOpen && !e.target.closest('.ckp-pop') && !e.target.closest('.bk-modal')) ckpClose();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ckpOpen) ckpClose(); });
  window.addEventListener('resize', ckpClose); document.querySelector('.bk-main').addEventListener('scroll', ckpClose);
  function ckpShow(wrap) {
    const multi = wrap.classList.contains('multi'), blank = wrap.dataset.blank;
    let vals = splitCats(wrap.querySelector('.ckp-val').value);
    const pop = document.createElement('div'); pop.className = 'ckp-pop' + (multi ? ' multi' : ' single');
    pop.innerHTML = '<div class="ckp-search"><input type="text" placeholder="Search categories…"></div><div class="ckp-list"></div>' +
      '<div class="ckp-foot"><a href="#" class="ckp-new">+ New category…</a><span class="sp"></span>' + (blank ? '<a href="#" class="ckp-clear">' + esc(multi ? 'Clear' : blank) + '</a>' : '') + (multi ? '<button type="button" class="bk-btn sm p ckp-done">Done</button>' : '') + '</div>';
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
      const tops = chart.filter(c => !c.parent);
      tops.forEach(t => {
        const kids = t.children ? chart.filter(c => c.parent === t.name).map(c => c.name) : [t.name];
        const show = f ? kids.filter(k => k.toLowerCase().indexOf(f) > -1 || t.name.toLowerCase().indexOf(f) > -1) : kids;
        if (!show.length) return;
        const col = !f && ckpCollapsed[t.name] && !show.some(k => vals.indexOf(k) > -1);
        const nSel = kids.filter(k => vals.indexOf(k) > -1).length;
        html += '<div class="ckp-g' + (col ? ' col' : '') + '" data-g="' + esc(t.name) + '"><div class="ckp-gh"><span class="ckp-tri"></span>' + tile(t.color, t.icon, 'sm', '') + esc(t.name) + (nSel ? '<b>' + nSel + '</b>' : '') + '<small>' + kids.length + '</small></div>' +
          (t.children ? show.map(k => '<div class="ckp-i' + (vals.indexOf(k) > -1 ? ' on' : '') + '" data-v="' + esc(k) + '"><span class="ckp-ck"></span>' + esc(k) + '</div>').join('') : '<div class="ckp-i top' + (vals.indexOf(t.name) > -1 ? ' on' : '') + '" data-v="' + esc(t.name) + '"><span class="ckp-ck"></span>use as is</div>') + '</div>';
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
    const clr = pop.querySelector('.ckp-clear'); if (clr) clr.onclick = (e) => { e.preventDefault(); vals = []; ckpSet(wrap, vals); if (multi) draw(); else ckpClose(); };
    const done = pop.querySelector('.ckp-done'); if (done) done.onclick = ckpClose;
  }
  // "+ New category…": name + type of expense (an existing one or a new one); the new one is selected in the picker that asked.
  function newCategory(wrap) {
    const tops = chart.filter(c => !c.parent && c.children).map(c => c.name);
    const el = document.createElement('div'); el.className = 'bk-modal';
    el.innerHTML = '<div class="bk-modal-box" style="width:min(440px,100%)"><div class="bk-modal-title">New category</div><div class="bk-muted" style="margin-bottom:10px">A sub category under a type of expense. Pick the type, or type a new one to start a new branch of the tree.</div>' +
      '<label class="bk-muted">Type of expense</label><div class="bk-row" style="margin:4px 0 10px"><select class="bk" id="ncParent" style="flex:1"><option value="">— new type —</option>' + tops.map(t => '<option>' + esc(t) + '</option>').join('') + '</select></div>' +
      '<div id="ncNewTypeWrap" style="margin-bottom:10px"><label class="bk-muted">New type of expense</label><input class="bk" id="ncNewType" placeholder="e.g. Delivery" style="width:100%;box-sizing:border-box;margin-top:4px"></div>' +
      '<label class="bk-muted">Sub category</label><input class="bk" id="ncName" placeholder="e.g. Local Delivery" style="width:100%;box-sizing:border-box;margin:4px 0 12px">' +
      '<div class="bk-row"><button class="bk-btn p" id="ncSave">Add</button><button class="bk-btn bk-x">Cancel</button><span class="bk-muted" id="ncMsg"></span></div></div>';
    const close = () => el.remove();
    el.onclick = (ev) => { if (ev.target === el || ev.target.classList.contains('bk-x')) close(); };
    document.body.appendChild(el);
    const par = el.querySelector('#ncParent'), wrapT = el.querySelector('#ncNewTypeWrap');
    par.onchange = () => { wrapT.style.display = par.value ? 'none' : ''; };
    el.querySelector('#ncName').focus();
    el.querySelector('#ncSave').onclick = async () => {
      const name = el.querySelector('#ncName').value.trim(), parent = par.value || el.querySelector('#ncNewType').value.trim();
      if (!name) { el.querySelector('#ncMsg').textContent = 'Give it a name.'; return; }
      const r = await post('/api/bookkeeping/categories', { name, parent });
      if (!r.ok) { el.querySelector('#ncMsg').textContent = r.error; return; }
      ov.chart = r.chart; ov.settings.categories = r.settings.categories; chart = r.chart;
      categories = chart.filter(c => c.parent || !c.children).map(c => c.name).filter((n, i, a) => a.indexOf(n) === i);
      if (wrap && wrap.classList) { const vals = splitCats(wrap.querySelector('.ckp-val').value); ckpSet(wrap, wrap.classList.contains('multi') ? vals.concat([name]) : [name]); }
      close();
    };
  }
  const conf = (c) => '<span class="bk-conf' + (c < 0.75 ? ' lo' : '') + '">' + Math.round(c * 100) + '%</span>';

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
      let body = '<div class="t">' + esc(p.title) + ' ' + conf(p.confidence) + '</div><div class="r">' + esc(p.reason || '') + '</div>';
      if (p.type === 'bill' && pl.lines && pl.lines.length) body += '<div class="bk-lines">' + pl.lines.slice(0, 8).map(l => '<div><span>' + esc(l.description) + '</span><span>' + esc(l.category || '') + '</span><span>' + usd(l.amount) + '</span></div>').join('') + (pl.lines.length > 8 ? '<div><span>…' + (pl.lines.length - 8) + ' more</span></div>' : '') + '</div>';
      if (p.type === 'bill') body += '<div class="r"><a href="#" data-file="' + p.ref_id + '">Open the bill file</a>' + (pl.due_date ? ' · due ' + esc(pl.due_date) : '') + '</div>';
      if (open(p)) body += '<div class="q">' + esc(p.question.question) + '</div>';
      let acts;
      if (open(p)) acts = '<input type="text" placeholder="Your answer" data-ans="' + p.question.id + '" style="min-width:220px">' + (p.type === 'category' ? catSelect(pl.category, 'ans-cat') : '') + '<button class="bk-btn sm p" data-answer="' + p.question.id + '" data-pid="' + p.id + '">Answer</button>';
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
      '<div class="bk-card"><h2>Talk to BookkeeperAI<span class="sp"></span><span class="bk-muted">the same conversation as Google Chat</span></h2><div class="bk-chat"><div class="bk-msgs" id="msgs"></div><div class="bk-input"><input id="chatIn" placeholder="e.g. approve #12, Q3: that was the new cutter, what did we spend on paper?"><button class="bk-btn p" id="chatSend">Send</button></div></div></div>' +
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
      if (!inp.value.trim()) { inp.focus(); return; }
      b.disabled = true;
      await post('/api/bookkeeping/questions/' + b.dataset.answer + '/answer', { answer: inp.value.trim(), category: cat ? cat.value : undefined });
      refresh();
    });
    v.querySelectorAll('[data-file]').forEach(a => a.onclick = (e) => { e.preventDefault(); openFile(a.dataset.file); });
    if ($('approveAll')) $('approveAll').onclick = async () => { if (!confirm('Approve every suggestion that has no open question?')) return; await post('/api/bookkeeping/proposals/decide-all', {}); refresh(); };
    $('runNow').onclick = async () => { $('runNow').disabled = true; $('runMsg').textContent = 'Running — syncing banks, scanning the inbox, categorizing…'; const r = await post('/api/bookkeeping/run', { post: false }); $('runMsg').textContent = r.ok ? r.summary : (r.error || 'Failed'); $('runNow').disabled = false; loadBrief(); };
    $('postBrief').onclick = async () => { $('postBrief').disabled = true; const r = await post('/api/bookkeeping/brief', { post: true }); $('runMsg').textContent = r.posted && !r.posted.error ? 'Posted to Google Chat.' : 'Not posted: ' + ((r.posted && r.posted.error) || 'unknown'); $('postBrief').disabled = false; };
    loadChat();
    $('chatSend').onclick = sendChat; $('chatIn').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
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

  // ---------------------------------------------------------------- Transactions
  async function loadTxns() {
    const v = $('vTxns');
    if (!ov) await overview();
    const st = (v.querySelector('select[name=st]') || {}).value || '', q = (v.querySelector('input[name=q]') || {}).value || '';
    const j = await api('/api/bookkeeping/transactions?status=' + encodeURIComponent(st) + '&q=' + encodeURIComponent(q));
    v.innerHTML = '<div class="bk-card"><div class="bk-filters"><input name="q" placeholder="Search name, vendor or category" value="' + esc(q) + '"><select name="st"><option value="">All</option>' +
      ['new', 'pending', 'categorized'].map(s => '<option' + (s === st ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><button class="bk-btn" id="txnGo">Filter</button><span class="sp"></span><button class="bk-btn" id="syncNow">Sync banks now</button></div>' +
      '<table class="bk"><thead><tr><th>Date</th><th>Description</th><th>Account</th><th class="num">Amount</th><th>Category</th><th></th></tr></thead><tbody>' +
      (j.transactions || []).map(t => '<tr><td>' + esc(t.date) + (t.pending ? ' <span class="bk-tag">pending</span>' : '') + '</td><td>' + esc(t.merchant || t.name) + (t.merchant && t.merchant !== t.name ? '<div class="bk-muted">' + esc(t.name) + '</div>' : '') +
        (t.vendor_name ? '<div><span class="bk-src ' + esc(t.vendor_source || '') + '">' + (t.vendor_source === 'suppliers' ? 'supplier' : t.vendor_source === 'vendors' ? 'vendor' : 'from a bill') + '</span> ' + esc(t.vendor_name) + ' <a href="#" class="bk-muted" data-setv="' + t.id + '" title="Link to another supplier / vendor">change</a></div>' : '<div><a href="#" class="bk-muted" data-setv="' + t.id + '">link to a supplier / vendor</a></div>') +
        (t.plaid_category ? '<div class="bk-muted">bank: ' + esc(t.plaid_category) + '</div>' : '') + '</td><td>' + esc(t.account_name || '') + '</td>' +
        '<td class="num ' + (t.amount > 0 ? 'neg' : 'pos') + '">' + usd(-t.amount) + '</td><td>' + (t.category ? catLabel(t.category) + ' <span class="bk-tag ' + esc(t.category_source || '') + '">' + esc(t.category_source || '') + '</span>' : '<span class="bk-tag ' + esc(t.status) + '">' + esc(t.status) + '</span>') + '</td>' +
        '<td>' + catSelect(t.category || '', 'tx-cat') + ' <button class="bk-btn sm" data-tx="' + t.id + '">Set</button></td></tr>').join('') + '</tbody></table>' +
      (!(j.transactions || []).length ? '<div class="bk-muted" style="padding:14px 0">No transactions yet — connect a bank under Connections, then Sync.</div>' : '') + '</div>';
    $('txnGo').onclick = loadTxns; v.querySelector('input[name=q]').onkeydown = (e) => { if (e.key === 'Enter') loadTxns(); };
    $('syncNow').onclick = async () => { $('syncNow').disabled = true; const r = await post('/api/bookkeeping/sync', {}); if (!r.ok) alert(r.error); loadTxns(); overview(); };
    v.querySelectorAll('[data-tx]').forEach(b => b.onclick = async () => { const sel = b.parentNode.querySelector('input.tx-cat'); await post('/api/bookkeeping/transactions/' + b.dataset.tx + '/category', { category: sel.value }); loadTxns(); overview(); });
    v.querySelectorAll('[data-setv]').forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      const d = await api('/api/bookkeeping/directory');
      const t = (j.transactions || []).find(x => String(x.id) === a.dataset.setv);
      const names = d.vendors.map((x, i) => (i + 1) + '. ' + x.name).join('\n');
      const pick = prompt('Which supplier / vendor is "' + (t.merchant || t.name) + '"? Type the number (0 = none):\n' + names);
      if (pick === null) return;
      const vx = d.vendors[parseInt(pick) - 1];
      await post('/api/bookkeeping/transactions/' + t.id + '/vendor', { vendor_id: vx ? vx.id : null, alias: vx ? (t.merchant || t.name) : undefined });
      loadTxns();
    });
  }

  // ---------------------------------------------------------------- Bills
  async function loadBills() {
    const v = $('vBills');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/bills');
    const KIND = { invoice: 'Invoice', credit_memo: 'Credit memo', statement: 'Statement' };
    const vlogo = (c) => c && c.photo ? '<img class="bk-logo bk-vl" src="' + esc(c.photo) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;bk-logo bk-vl ph&quot;>' + esc(String(c.name || '?').charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo bk-vl ph' + (c ? '' : ' none') + '">' + esc(c ? String(c.name).charAt(0).toUpperCase() : '?') + '</span>';
    const kindTag = (k) => k ? '<span class="bk-src ' + esc(k) + '">' + esc(k === 'bill' ? 'from a bill' : k) + '</span>' : '';
    const vendorBlock = (b) => {
      const c = b.vendor_card, linked = c && c.kind !== 'bill';
      return '<div class="bl-vendor">' + vlogo(linked ? c : null) + '<div class="bl-vname"><b>' + esc(b.vendor) + '</b>' +
        (linked ? '<div class="bk-dim">' + kindTag(c.kind) + (c.name !== b.vendor ? ' ' + esc(c.name) : '') + (c.specialty ? ' · ' + esc(c.specialty) : '') + ' · <a href="#" data-link="' + b.id + '">change</a></div>'
          : '<div class="bl-unlinked">Not in the CRM directory' + (b.suggestions.length ? ' — is it ' + b.suggestions.map(sg => '<a href="#" class="bl-sug" data-pair="' + b.id + '" data-vid="' + sg.id + '" title="' + Math.round(sg.score * 100) + '% match">' + esc(sg.name) + '</a>').join(' or ') + '?' : '') + ' <a href="#" data-link="' + b.id + '">' + (b.suggestions.length ? 'pick another' : 'link to a vendor') + '</a></div>') + '</div></div>';
    };
    const billCard = (b) => {
      const tot = b.lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
      const pend = b.proposal_status === 'pending';
      return '<div class="bl-card' + (b.status === 'rejected' ? ' off' : '') + '" data-bill="' + b.id + '"><div class="bl-head">' + vendorBlock(b) +
        '<div class="bl-meta"><div><span class="bk-tag">' + esc(KIND[b.kind] || b.kind) + '</span> ' + (b.invoice_no ? '<b>#' + esc(b.invoice_no) + '</b>' : '<span class="bk-dim">no number</span>') + (b.duplicate_of ? ' <span class="bk-tag rejected">possible duplicate of #' + b.duplicate_of + '</span>' : '') + '</div>' +
          '<div class="bk-muted">' + (b.invoice_date ? 'Dated ' + esc(b.invoice_date) : '') + (b.due_date ? ' · due <b>' + esc(b.due_date) + '</b>' : '') + (b.terms ? ' · ' + esc(b.terms) : '') + (b.received_at ? ' · received ' + when(b.received_at) : '') + '</div></div>' +
        '<div class="bl-total"><b>' + usd(b.total) + '</b><span class="bk-tag ' + esc(b.status) + '">' + esc(b.status) + '</span></div></div>' +
        (b.note || b.proposal_reason ? '<div class="bl-note">' + esc(b.note || b.proposal_reason) + '</div>' : '') +
        (b.question ? '<div class="bl-q">' + esc(b.question.question) + ' <span class="bk-dim">— answer it in the Daily Brief</span></div>' : '') +
        (b.lines.length ? '<table class="bk bl-lines"><tbody>' + b.lines.map(l => '<tr><td>' + esc(l.description || '') + (l.qty && l.unit_price ? ' <span class="bk-dim">' + esc(l.qty) + ' × ' + usd(l.unit_price) + '</span>' : '') + '</td><td class="bk-muted">' + catLabel(l.category || '') + '</td><td class="num">' + usd(l.amount) + '</td></tr>').join('') +
          (b.subtotal != null || b.tax ? '<tr class="sum"><td></td><td class="bk-muted">' + (b.subtotal != null ? 'Subtotal ' + usd(b.subtotal) : '') + (b.tax ? ' · tax ' + usd(b.tax) : '') + '</td><td class="num">' + usd(b.total) + '</td></tr>' : (Math.abs(tot - b.total) > 0.01 && tot ? '<tr class="sum"><td></td><td class="bk-dim">lines add up to ' + usd(tot) + '</td><td></td></tr>' : '')) + '</tbody></table>' : '') +
        '<div class="bl-acts">' + (b.file ? '<a href="#" class="bk-btn sm" data-file="' + b.id + '">Open the file</a>' : '') + (b.subject ? '<span class="bk-dim bl-subj" title="' + esc(b.from_addr || '') + '">✉ ' + esc(b.subject) + '</span>' : '') + '<span class="sp"></span>' +
          (pend ? '<button class="bk-btn sm ok" data-bapprove="' + b.proposal_id + '">Approve</button><button class="bk-btn sm bad" data-breject="' + b.proposal_id + '">Reject</button>' : '') + '</div></div>';
    };
    const bills = j.bills || [], open = bills.filter(b => b.status === 'draft'), done = bills.filter(b => b.status !== 'draft');
    v.innerHTML = '<div class="bk-card"><h2>Bills ' + qHelp('bills', 'Bills', 'Bills BookkeeperAI read from ' + esc(ov ? ov.connections.gmail.inbox : 'the inbox') + '. Each one is paired with a CRM supplier or vendor — when the name is not an exact match, pick the right one once and the next bill from them links by itself.') + '<span class="sp"></span><span class="bk-muted">' + open.length + ' draft' + (open.length === 1 ? '' : 's') + (done.length ? ' · ' + done.length + ' decided' : '') + '</span><button class="bk-btn" id="scanNow">Scan the inbox now</button></h2>' +
      (open.length ? open.map(billCard).join('') : '<div class="bk-muted" style="padding:10px 0">No bill drafts waiting.</div>') +
      (done.length ? '<details class="bl-done"><summary>' + done.length + ' decided bill' + (done.length === 1 ? '' : 's') + '</summary>' + done.map(billCard).join('') + '</details>' : '') + '</div>';
    $('scanNow').onclick = async () => { $('scanNow').disabled = true; const r = await post('/api/bookkeeping/scan', {}); if (!r.ok) alert(r.error); loadBills(); overview(); };
    v.querySelectorAll('[data-file]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); openFile(a.dataset.file); });
    v.querySelectorAll('[data-bapprove]').forEach(b => b.onclick = async () => { b.disabled = true; const r = await post('/api/bookkeeping/proposals/' + b.dataset.bapprove + '/decide', { action: 'approve', approve_vendor: true }); if (!r.ok) alert(r.error); loadBills(); overview(); });
    v.querySelectorAll('[data-breject]').forEach(b => b.onclick = async () => { const note = prompt('Why? (optional)'); if (note === null) return; b.disabled = true; await post('/api/bookkeeping/proposals/' + b.dataset.breject + '/decide', { action: 'reject', note }); loadBills(); overview(); });
    const pair = async (billId, vid) => { const r = await post('/api/bookkeeping/bills/' + billId + '/vendor', { vendor_id: vid, remember: true }); if (!r.ok) alert(r.error); loadBills(); };
    v.querySelectorAll('[data-pair]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); pair(a.dataset.pair, a.dataset.vid); });
    v.querySelectorAll('[data-link]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); const b = bills.find(x => String(x.id) === a.dataset.link); vendorPicker(a, b, (vid) => pair(b.id, vid)); });
  }
  // ---------------------------------------------------------------- Inbox (accounting@, Gmail-like)
  let ibFilter = 'all', ibOpen = null;
  async function loadInbox() {
    const v = $('vInbox');
    if (!ov) await overview();
    const e = await api('/api/bookkeeping/emails');
    const all = e.emails || [];
    const st = (m) => m.status === 'parsed' ? 'parsed' : m.status === 'error' ? 'error' : m.status === 'new' ? 'new' : 'skipped';
    const counts = { all: all.length, parsed: 0, skipped: 0, new: 0 }; all.forEach(m => { counts[st(m)] = (counts[st(m)] || 0) + 1; });
    const fromName = (f) => { const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(f || ''); return m ? (m[1].trim() || m[2]) : String(f || '').replace(/^"|"$/g, ''); };
    const fromAddr = (f) => { const m = /<([^>]+)>/.exec(f || ''); return m ? m[1] : String(f || ''); };
    const clip = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/></svg>';
    const day = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/Z$/.test(ts) ? '' : 'Z')); if (isNaN(d)) return ts; const now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
    const row = (m) => { const k = st(m); return '<div class="ib-row ' + k + (ibOpen === m.id ? ' open' : '') + '" data-m="' + m.id + '" data-k="' + k + '" data-q="' + esc((m.from_addr + ' ' + m.subject + ' ' + (m.snippet || '') + ' ' + (m.note || '')).toLowerCase()) + '">' +
      '<span class="ib-dot ' + k + '" title="' + esc(k) + '"></span><span class="ib-from" title="' + esc(fromAddr(m.from_addr)) + '">' + esc(fromName(m.from_addr)) + '</span>' +
      '<span class="ib-subj"><b>' + esc(m.subject || '(no subject)') + '</b> <span>— ' + esc(m.snippet || '') + '</span></span>' +
      '<span class="ib-att">' + (m.attachments.length ? clip + ' ' + m.attachments.length : '') + '</span><span class="ib-time">' + esc(day(m.received_at)) + '</span>' +
      (ibOpen === m.id ? '<div class="ib-detail"><div class="bk-muted">' + esc(m.from_addr) + ' · ' + when(m.received_at) + '</div><div class="snip">' + esc(m.snippet || '') + '</div>' +
        (m.attachments.length ? '<div class="files">' + m.attachments.map(a => '<a>' + clip + ' ' + esc(a.name) + '</a>').join('') + '</div>' : '') +
        '<div class="verdict"><span class="ib-tag ' + k + '">' + esc(k) + '</span>' + esc(m.note || (k === 'new' ? 'Not read yet.' : '')) + (k === 'parsed' ? ' <a href="#" data-gobills>open Bills</a>' : '') + '</div>' +
        (k !== 'parsed' ? '<button class="bk-btn sm" data-parse="' + m.id + '">Read it as a bill</button>' : '') + '</div>' : '') + '</div>'; };
    v.innerHTML = '<div class="bk-card"><h2>Inbox — ' + esc(ov ? ov.connections.gmail.inbox : '') + ' ' + qHelp('inbox', 'Inbox', 'Every email that reached the accounting inbox, newest first, with what BookkeeperAI made of it: <b>green</b> = read as a bill (it is under Bills), <b>grey</b> = skipped (newsletter, receipt for something already paid, shipping notice…), <b>blue</b> = not read yet. Open one to see why; "Read it as a bill" makes BookkeeperAI read it anyway.') + '<span class="sp"></span><span class="bk-muted">' + all.length + ' emails · ' + (ov && ov.connections.gmail.last_scan ? 'scanned ' + when(ov.connections.gmail.last_scan) : 'not scanned yet') + '</span><button class="bk-btn" id="scanNow2">Scan now</button></h2>' +
      '<div class="ib-bar">' + [['all', 'All'], ['parsed', 'Bills'], ['skipped', 'Skipped'], ['new', 'Not read']].map(([k, l]) => '<button class="ib-chip' + (ibFilter === k ? ' on' : '') + '" data-f="' + k + '">' + l + ' (' + (counts[k] || 0) + ')</button>').join('') + '<input id="ibQ" placeholder="Search sender, subject, text…"></div>' +
      '<div class="ib-list">' + all.map(row).join('') + '</div>' + (!all.length ? '<div class="bk-muted" style="padding:14px 0">Nothing scanned yet — press Scan now.</div>' : '') + '<div class="bk-muted" id="ibNone" style="display:none;padding:14px 0">Nothing matches.</div></div>';
    const filter = () => { const q = $('ibQ').value.trim().toLowerCase(); let n = 0; v.querySelectorAll('.ib-row').forEach(r => { const on = (ibFilter === 'all' || r.dataset.k === ibFilter) && (!q || r.dataset.q.indexOf(q) > -1); r.style.display = on ? '' : 'none'; if (on) n++; }); $('ibNone').style.display = n || !all.length ? 'none' : ''; };
    v.querySelectorAll('.ib-chip').forEach(c => c.onclick = () => { ibFilter = c.dataset.f; v.querySelectorAll('.ib-chip').forEach(x => x.classList.toggle('on', x === c)); filter(); });
    $('ibQ').oninput = filter; filter();
    v.querySelectorAll('.ib-row').forEach(r => r.onclick = (ev) => { if (ev.target.closest('.ib-detail')) return; ibOpen = ibOpen === Number(r.dataset.m) ? null : Number(r.dataset.m); loadInbox(); });
    v.querySelectorAll('[data-parse]').forEach(b => b.onclick = async () => { b.disabled = true; const r = await post('/api/bookkeeping/emails/' + b.dataset.parse + '/parse', {}); if (!r.ok) alert(r.error); loadInbox(); overview(); });
    v.querySelectorAll('[data-gobills]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); show('bills', 'bills'); });
    $('scanNow2').onclick = async () => { $('scanNow2').disabled = true; const r = await post('/api/bookkeeping/scan', {}); if (!r.ok) alert(r.error); await overview(); loadInbox(); };
    const nb = $('nInbox'); if (nb) nb.textContent = counts.new || '';
  }
  // Pick a directory entry for a bill: near matches first, then search the whole directory.
  async function vendorPicker(anchor, bill, onPick) {
    document.querySelectorAll('.ckp-pop').forEach(p => p.remove());
    const j = await api('/api/bookkeeping/directory?fresh=0');
    const all = (j.vendors || []).filter(x => x.kind !== 'bill');
    const pop = document.createElement('div'); pop.className = 'ckp-pop single';
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.innerHTML = '<div class="ckp-search"><input type="text" placeholder="Search suppliers and vendors…"></div><div class="ckp-list"></div><div class="ckp-foot"><span class="bk-muted">Linking “' + esc(bill.vendor) + '” remembers the name for next time.</span></div>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), W = Math.min(380, window.innerWidth - 16);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.width = W + 'px';
    const below = window.innerHeight - r.bottom - 8; if (below >= 320) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.maxHeight = Math.min(440, below) + 'px'; } else { pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; pop.style.maxHeight = Math.min(440, r.top - 8) + 'px'; }
    const list = pop.querySelector('.ckp-list'), q = pop.querySelector('input');
    const row = (x, extra) => '<div class="ckp-i vp" data-v="' + x.id + '">' + (x.photo ? '<img class="bk-logo vp-logo" src="' + esc(x.photo) + '" alt="">' : '<span class="bk-logo vp-logo ph">' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>') + '<span class="vp-n"><b>' + esc(x.name) + '</b><small>' + esc([x.kind, x.specialty].filter(Boolean).join(' · ')) + '</small></span>' + (extra || '') + '</div>';
    const draw = () => {
      const f = q.value.trim().toLowerCase(); let html = '';
      if (!f && bill.suggestions.length) html += '<div class="ckp-g"><div class="ckp-gh">Near matches</div>' + bill.suggestions.map(sg => row(sg, '<span class="bk-dim">' + Math.round(sg.score * 100) + '%</span>')).join('') + '</div>';
      const rest = all.filter(x => !f || (x.name + ' ' + (x.specialty || '') + ' ' + (x.aliases || '')).toLowerCase().indexOf(f) > -1).slice(0, 60);
      html += '<div class="ckp-g"><div class="ckp-gh">' + (f ? 'Matches' : 'All suppliers and vendors') + '<small>' + rest.length + '</small></div>' + rest.map(x => row(x)).join('') + '</div>';
      list.innerHTML = html;
    };
    draw(); setTimeout(() => q.focus(), 0); q.oninput = draw;
    list.onclick = (e) => { const it = e.target.closest('.ckp-i'); if (!it) return; onPick(Number(it.dataset.v)); close(); };
    const close = () => { pop.remove(); document.removeEventListener('click', away); document.removeEventListener('keydown', esc1); };
    const away = (e) => { if (!pop.contains(e.target)) close(); }, esc1 = (e) => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('click', away); document.addEventListener('keydown', esc1); }, 0);
  }

  // ---------------------------------------------------------------- Rules
  async function loadRules() {
    const v = $('vRules');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/rules');
    v.innerHTML = '<div class="bk-card"><h2>Categorization rules<span class="sp"></span><span class="bk-muted">applied before the AI looks — made from your approvals, or here</span></h2>' +
      '<div class="bk-row" style="margin-bottom:10px"><select class="bk" id="rKind"><option value="vendor">Vendor is</option><option value="keyword">Description contains</option></select><input class="bk" id="rPat" placeholder="e.g. Veritiv or AMAZON" style="min-width:220px">' + catSelect('', 'rcat', 'Category…') + '<button class="bk-btn p" id="rAdd">Add rule</button></div>' +
      '<table class="bk"><thead><tr><th>Rule</th><th>Category</th><th>From</th><th>Hits</th><th></th></tr></thead><tbody>' +
      (j.rules || []).map(r => '<tr><td>' + (r.kind === 'vendor' ? 'Vendor is ' : 'Contains ') + '<b>' + esc(r.pattern) + '</b></td><td>' + esc(r.category) + '</td><td>' + esc(r.source) + ' · ' + esc(r.created_by || '') + '</td><td>' + r.hits + '</td><td><button class="bk-btn sm bad" data-del="' + r.id + '">Remove</button></td></tr>').join('') + '</tbody></table>' +
      (!(j.rules || []).length ? '<div class="bk-muted" style="padding:14px 0">No rules yet — each approval with "remember" ticked adds one.</div>' : '') + '</div>' +
      
      '<div class="bk-card"><h2>Notes for the AI ' + qHelp('notes', 'Notes for the AI', 'How AxiomPrint books things — BookkeeperAI reads this with every proposal. The chart of accounts itself is edited under Accounts → Chart of Accounts.') + '</h2>' +
      '<textarea class="bk" id="sNotes" style="margin-top:8px">' + esc(ov.settings.notes) + '</textarea>' +
      '<div class="bk-row" style="margin-top:8px"><label class="bk-muted">Ask me when confidence is below <input class="bk" id="sThr" type="number" min="0.3" max="1" step="0.05" value="' + esc(ov.settings.threshold) + '" style="width:80px"></label><button class="bk-btn p" id="sSave">Save</button><span class="bk-muted" id="sMsg"></span></div></div>';
    $('rAdd').onclick = async () => { const r = await post('/api/bookkeeping/rules', { kind: $('rKind').value, pattern: $('rPat').value.trim(), category: v.querySelector('input.rcat').value }); if (!r.ok) alert(r.error); loadRules(); };
    v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/api/bookkeeping/rules/' + b.dataset.del, { method: 'DELETE' }); loadRules(); });
    $('sSave').onclick = async () => { await post('/api/bookkeeping/settings', { notes: $('sNotes').value, threshold: $('sThr').value }); $('sMsg').textContent = 'Saved.'; await overview(); };
  }

  // ---------------------------------------------------------------- Chart of Accounts (types of expense → sub categories, with colors and icons)
  // One line-icon set (24px grid, stroke 2) so every type and sub category looks the same family; keys are stored in the chart.
  const ICON_PATH = {
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
    leaf: '<path d="M4 20c0-9 6-15 16-16 0 10-6 16-16 16z"/><path d="M4 20c4-4 7-7 10-10"/>'
  };
  const ICONS = Object.keys(ICON_PATH);
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
    v.innerHTML = '<div class="bk-card" style="margin-bottom:14px"><h2>Chart of Accounts ' + qHelp('chart', 'Chart of Accounts', 'Every transaction and bill line gets a <b>sub category</b>; sub categories are grouped under a <b>type of expense</b> with its color and icon, so reports can roll up by type. Changes save as you make them. Renaming follows the name everywhere it is used; a sub category in use cannot be deleted — rename it instead.') + '<span class="sp"></span><span class="coa-status" id="coaStatus"></span></h2></div>' +
      '<div class="coa"><div class="coa-list" id="coaList"></div><div class="coa-edit" id="coaEdit"></div></div>';
    drawChart();
  }
  const useText = (u) => u ? [u.txns && u.txns + ' txn' + (u.txns === 1 ? '' : 's'), u.rules && u.rules + ' rule' + (u.rules === 1 ? '' : 's'), u.vendors && u.vendors + ' vendor' + (u.vendors === 1 ? '' : 's')].filter(Boolean).join(' · ') : '';
  const inUse = (n) => { const u = coaUsage[n]; return !!(u && (u.txns || u.rules || u.vendors)); };
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
      '<div class="bk-muted" style="margin-bottom:4px">Sub categories' + (t.children.length ? '' : ' <span class="bk-dim">— none yet: the type itself is used on transactions until you add some</span>') + '</div>' +
      '<div id="coaKids">' + t.children.map((k, i) => '<div class="coa-k" data-k="' + i + '"><span data-kicon="' + i + '" title="Icon">' + tile(t.color, k.icon, iconKey(k.icon) ? '' : 'empty', '·') + '</span><input class="kn" value="' + esc(k.name) + '"><span class="use">' + esc(useText(coaUsage[k.name])) + '</span>' +
        '<span class="coa-mv"><button data-kup="' + i + '"' + (i ? '' : ' disabled') + '>▲</button><button data-kdown="' + i + '"' + (i < t.children.length - 1 ? '' : ' disabled') + '>▼</button></span><button class="del" data-kdel="' + i + '" title="' + (inUse(k.name) ? 'In use — rename it instead' : 'Remove') + '"' + (inUse(k.name) ? ' disabled' : '') + '>×</button></div>').join('') + '</div>' +
      '<div class="coa-foot"><input class="bk" id="coaNewKid" placeholder="New sub category under ' + esc(t.name) + '…"><button class="bk-btn sm p" id="coaAddKid">Add</button></div>' +
      '<div class="coa-foot" style="border-top:0;margin-top:6px;justify-content:flex-end"><button class="bk-btn sm bad" id="coaDelType"' + (t.children.some(k => inUse(k.name)) || inUse(t.name) ? ' disabled title="Some of it is in use"' : '') + '>Delete this type</button></div>';
    $('coaIcon').onclick = (e) => iconPicker(e.currentTarget, t.icon, (ic) => { t.icon = ic; drawChart(); saveChart(); });
    ed.querySelectorAll('.coa-sw').forEach(sw => sw.onclick = () => { t.color = sw.dataset.c; drawChart(); saveChart(); });
    $('coaCustom').oninput = (e) => { t.color = e.target.value; ed.querySelectorAll('.coa-ic').forEach(el => el.style.setProperty('--c', t.color)); };
    $('coaCustom').onchange = () => { drawChart(); saveChart(); };
    $('coaName').onchange = () => rename(t.name, $('coaName').value.trim(), true);
    ed.querySelectorAll('input.kn').forEach(inp => inp.onchange = () => { const i = Number(inp.closest('.coa-k').dataset.k); rename(t.children[i].name, inp.value.trim(), false); });
    ed.querySelectorAll('[data-kicon]').forEach(el => el.onclick = (e) => { const i = Number(el.dataset.kicon); iconPicker(e.currentTarget, t.children[i].icon, (ic) => { t.children[i].icon = ic; drawChart(); saveChart(); }); });
    ed.querySelectorAll('[data-kup]').forEach(b => b.onclick = () => { const i = Number(b.dataset.kup); [t.children[i - 1], t.children[i]] = [t.children[i], t.children[i - 1]]; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-kdown]').forEach(b => b.onclick = () => { const i = Number(b.dataset.kdown); [t.children[i + 1], t.children[i]] = [t.children[i], t.children[i + 1]]; drawChart(); saveChart(); });
    ed.querySelectorAll('[data-kdel]').forEach(b => b.onclick = () => { const i = Number(b.dataset.kdel); if (!confirm('Remove "' + t.children[i].name + '"?')) return; t.children.splice(i, 1); drawChart(); saveChart(); });
    const addKid = () => { const n = $('coaNewKid').value.trim(); if (!n) return; if (categories.indexOf(n) > -1 || t.children.some(k => k.name === n)) { status('"' + n + '" is already in the chart.', true); return; } t.children.push({ name: n, icon: '' }); drawChart(); saveChart(); setTimeout(() => $('coaNewKid') && $('coaNewKid').focus(), 0); };
    $('coaAddKid').onclick = addKid; $('coaNewKid').onkeydown = (e) => { if (e.key === 'Enter') addKid(); };
    $('coaDelType').onclick = () => { if (!confirm('Delete the type "' + t.name + '" and its sub categories?')) return; coa.splice(coaSel, 1); coaSel = Math.max(0, coaSel - 1); drawChart(); saveChart(); };
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
    pop.innerHTML = '<div class="ico-grid">' + ICONS.map(i => '<button type="button" data-i="' + i + '" title="' + i + '"' + (i === iconKey(cur) ? ' class="on"' : '') + '>' + iconSvg(i) + '</button>').join('') + '</div><button type="button" class="none">No icon</button>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(); pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 376)) + 'px'; pop.style.top = (r.bottom + 6 + 330 > window.innerHeight ? r.top - 6 - pop.offsetHeight : r.bottom + 6) + 'px';
    const close = () => { pop.remove(); document.removeEventListener('click', away, true); };
    const away = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
    setTimeout(() => document.addEventListener('click', away, true), 0);
    pop.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { onPick(b.dataset.i); close(); });
    pop.querySelector('.none').onclick = () => { onPick(''); close(); };
  }

  // ---------------------------------------------------------------- Suppliers & vendors (the CRM directory + vendors seen on bills)
  async function loadVendors() {
    const v = $('vVendors');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/directory');
    const all = j.vendors || [];
    const KIND_LABEL = { supplier: 'Supplier', vendor: 'Vendor', bill: 'From a bill', other: 'Other' };
    const label = (k) => KIND_LABEL[k] || (String(k || 'other').charAt(0).toUpperCase() + String(k || 'other').slice(1));
    // The types are the CRM lists (read-only here — a row's type is the list it is in), then "from a bill".
    const kinds = (j.lists || ['supplier', 'vendor']).slice(); all.forEach(x => { if (x.kind && kinds.indexOf(x.kind) < 0) kinds.push(x.kind); }); if (kinds.indexOf('bill') < 0) kinds.push('bill');
    const counts = {}; all.forEach(x => { counts[x.kind || 'other'] = (counts[x.kind || 'other'] || 0) + 1; });
    let kindF = ''; try { kindF = localStorage.getItem('bk_vendor_kind') || ''; } catch (e) {}
    if (kindF && !counts[kindF]) kindF = '';
    const logo = (x) => x.photo ? '<img class="bk-logo" src="' + esc(x.photo) + '" alt="" loading="lazy" onerror="this.outerHTML=\'<span class=&quot;bk-logo ph&quot;>' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>\'">' : '<span class="bk-logo ph">' + esc(String(x.name).charAt(0).toUpperCase()) + '</span>';
    const kindTag = (x) => '<span class="bk-src ' + esc(x.kind || 'other') + '">' + esc(label(x.kind)) + '</span>';
    const row = (x) => '<tr data-vid="' + x.id + '" data-kind="' + esc(x.kind || 'other') + '" data-q="' + esc((x.name + ' ' + (x.contact || '') + ' ' + (x.email || '') + ' ' + (x.specialty || '') + ' ' + (x.aliases || '')).toLowerCase()) + '"><td><a href="#" class="bk-open" data-vopen="' + x.id + '" title="Full details">' + logo(x) + '</a></td><td>' + kindTag(x) + '</td>' +
      '<td><a href="#" class="bk-open bk-name" data-vopen="' + x.id + '" title="Full details">' + esc(x.name) + '</a>' + (x.contact ? '<div class="bk-muted">' + esc(x.contact) + '</div>' : '') + '</td><td class="bk-muted">' + esc(x.email || '') + (x.phone ? '<br>' + esc(x.phone) : '') + '</td><td class="bk-muted">' + esc(x.specialty || '') + (x.materials ? '<div class="bk-dim"><a href="#" data-mats="' + x.id + '" title="See the materials in the catalog">' + x.materials + ' material' + (x.materials == 1 ? '' : 's') + '</a>: ' + esc((x.geo_types || []).join(', ')) + '</div>' : '') + '</td>' +
      '<td>' + catSelect(x.default_category || '', 'vcat', 'not set', { multi: true }) + '</td><td><input type="text" class="bk valias" placeholder="bank names, one per line" value="' + esc(String(x.aliases || '').split('\n').join(' | ')) + '" title="How this vendor appears on bank statements (separate with |)"></td>' +
      '<td class="c"><label class="bk-check" title="Approved = BookkeeperAI may link bank lines and bills to this company without asking. CRM entries are approved by themselves; a company first seen on a bill waits here."><input type="checkbox" class="vappr"' + (x.approved ? ' checked' : '') + '></label></td>' +
      '<td class="num bk-muted" title="How many bank transactions and bills are linked to this company">' + (x.txns || 0) + ' <span class="bk-dim">txn' + (x.txns == 1 ? '' : 's') + '</span><br>' + (x.bills || 0) + ' <span class="bk-dim">bill' + (x.bills == 1 ? '' : 's') + '</span></td><td><button class="bk-btn sm" data-vsave="' + x.id + '">Save</button></td></tr>';
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
    v.innerHTML = '<div class="bk-card"><h2>Vendors &amp; suppliers ' + qHelp('vendors', 'Vendors & suppliers', 'Read from the CRM’s Suppliers and Vendors lists (read-only, refreshed with every daily run); the photo is the CRM’s. They are trusted: a bank line or bill that matches one is linked to it, and BookkeeperAI uses the specialty and the usual category when it proposes. The type is the CRM list the company is in (Supplier, Vendor — new lists appear as new types). Edit names, emails and specialties in the CRM; set the usual category and the bank-statement names here; click a name or logo for the full record. The list refreshes by itself: when you open this tab, hourly, and with every daily run. <b>Approved</b> means BookkeeperAI may link bank lines and bills to the company without asking (CRM entries are approved by themselves); <b>Linked</b> counts the transactions and bills matched to it so far. Vendors first seen on a bill are <span class="bk-src bill">from a bill</span> and wait for your approval.') + '<span class="sp"></span><span class="bk-muted">' + (j.synced_at ? 'synced ' + when(j.synced_at) : 'not synced yet') + (j.sync_error ? ' · <span style="color:#b91c1c">' + esc(j.sync_error) + '</span>' : '') + '</span><button class="bk-btn" id="dirSync"' + (j.crm ? '' : ' disabled') + '>Refresh from CRM</button></h2>' +
      (unapproved ? '<div class="bk-muted" style="margin-bottom:8px">' + unapproved + ' vendor' + (unapproved === 1 ? '' : 's') + ' first seen on a bill ' + (unapproved === 1 ? 'is' : 'are') + ' waiting for your approval.</div>' : '') +
      '<div class="bk-filters"><select id="vKind"><option value="">All types (' + all.length + ')</option>' + kinds.filter(k => counts[k]).map(k => '<option value="' + esc(k) + '"' + (kindF === k ? ' selected' : '') + '>' + esc(label(k)) + ' (' + counts[k] + ')</option>').join('') + '</select>' +
      '<select id="vAppr"><option value="">Approved and waiting</option><option value="0">Waiting for approval' + (unapproved ? ' (' + unapproved + ')' : '') + '</option><option value="1">Approved</option></select><input name="q" id="vQ" placeholder="Search name, contact, email, specialty…"></div>' +
      (all.length ? '<table class="bk bk-dir"><thead><tr><th></th><th>Type</th><th>Name</th><th>Contact</th><th>Specialty</th><th>Usual category</th><th>On the bank statement as</th><th class="c" title="BookkeeperAI may link bank lines and bills to an approved company without asking">Approved</th><th class="num" title="Bank transactions and bills linked to this company">Linked</th><th></th></tr></thead><tbody>' + all.map(row).join('') + '</tbody></table><div class="bk-muted" id="vNone" style="display:none;padding:14px 0">Nothing matches.</div>'
        : '<div class="bk-muted">Nothing synced yet — press Refresh from CRM.</div>') + '</div>';
    const filter = () => {
      const k = $('vKind').value, ap = $('vAppr').value, q = $('vQ').value.trim().toLowerCase(); let n = 0;
      try { localStorage.setItem('bk_vendor_kind', k); } catch (e) {}
      v.querySelectorAll('tr[data-vid]').forEach(tr => { const on = (!k || tr.dataset.kind === k) && (!ap || (tr.querySelector('.vappr').checked ? '1' : '0') === ap) && (!q || tr.dataset.q.indexOf(q) >= 0); tr.style.display = on ? '' : 'none'; if (on) n++; });
      if ($('vNone')) $('vNone').style.display = n ? 'none' : '';
    };
    ['vKind', 'vAppr'].forEach(id => $(id).onchange = filter); $('vQ').oninput = filter; filter();
    v.querySelectorAll('[data-vopen]').forEach(a => a.onclick = (e) => { e.preventDefault(); const x = all.find(y => String(y.id) === a.dataset.vopen); if (x) openVendor(x); });
    v.querySelectorAll('[data-mats]').forEach(a => a.onclick = (e) => { e.preventDefault(); matFilter = { vendor: a.dataset.mats }; show('materials'); });
    $('dirSync').onclick = async () => { $('dirSync').disabled = true; const r = await post('/api/bookkeeping/directory/sync', {}); if (!r.ok) alert(r.error); else if (r.errors && r.errors.length) alert(r.errors.join('\n')); loadVendors(); };
    v.querySelectorAll('[data-vsave]').forEach(b => b.onclick = async () => {
      const tr = b.closest('tr'); b.disabled = true;
      await post('/api/bookkeeping/vendors/' + b.dataset.vsave, { approved: tr.querySelector('.vappr').checked, default_category: tr.querySelector('input.vcat').value, aliases: tr.querySelector('.valias').value.split('|').map(x => x.trim()).filter(Boolean).join('\n') });
      loadVendors();
    });
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
    v.innerHTML = '<div class="bk-card"><h2>Materials &amp; GEO types<span class="sp"></span><span class="bk-muted">' + all.length + ' materials · ' + (j.synced_at ? 'synced ' + when(j.synced_at) : 'not synced yet') + (j.sync_error ? ' · <span style="color:#b91c1c">' + esc(j.sync_error) + '</span>' : '') + '</span><button class="bk-btn" id="matSync"' + (j.crm ? '' : ' disabled') + '>Refresh from CRM</button></h2>' +
      '<div class="bk-muted" style="margin-bottom:8px">The CRM\u2019s materials catalog (Products → Materials), read-only, refreshed with the directory. Every material carries its <b>GEO type</b> and sub type, the production team and step, and the supplier it is bought from. BookkeeperAI knows what each supplier supplies and treats purchases of catalog materials as production cost, not office supplies. The supplier on a material is still a typed name in the CRM; it is linked to the directory by name here' + (Object.keys(unlinked).length ? ' — <b>' + Object.keys(unlinked).length + ' name' + (Object.keys(unlinked).length === 1 ? '' : 's') + ' not in the directory</b>: ' + esc(Object.keys(unlinked).sort((a, b) => unlinked[b] - unlinked[a]).map(k => k + ' (' + unlinked[k] + ')').join(', ')) : '') + '.</div>' +
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
    $('matSync').onclick = async () => { $('matSync').disabled = true; const r = await post('/api/bookkeeping/directory/sync', {}); if (!r.ok) alert(r.error); else if (r.errors && r.errors.length) alert(r.errors.join('\n')); loadMaterials(); };
    v.querySelectorAll('[data-vgo]').forEach(a => a.onclick = (e) => { e.preventDefault(); show('vendors'); setTimeout(() => { const tr = document.querySelector('tr[data-vid="' + a.dataset.vgo + '"]'); if (tr) { tr.scrollIntoView({ block: 'center' }); tr.style.background = '#fffbeb'; } }, 900); });
  }

  // ---------------------------------------------------------------- Connections
  async function loadConn() {
    await overview();
    const v = $('vConn'), c = ov.connections, s = ov.settings;
    const pill = (on, yes, no) => '<span class="bk-pill ' + (on ? 'on' : 'off') + '">' + (on ? yes : no) + '</span>';
    v.innerHTML = '<div class="bk-conn">' +
      // Plaid
      '<div class="bk-card"><h2>Bank accounts ' + pill(c.plaid.configured, 'Plaid keys set (' + esc(c.plaid.env) + ')', 'Plaid keys not in .env') + '<span class="sp"></span><button class="bk-btn p" id="plaidLink"' + (c.plaid.configured ? '' : ' disabled') + '>Connect a bank</button></h2>' +
      (c.plaid.items.length ? '<table class="bk"><thead><tr><th>Bank</th><th>Accounts</th><th>Last sync</th><th>Status</th><th></th></tr></thead><tbody>' + c.plaid.items.map(it => '<tr><td>' + esc(it.institution) + '</td><td>' + it.accounts.map(a => esc(a.name) + (a.mask ? ' ••' + esc(a.mask) : '')).join('<br>') + '</td><td>' + when(it.last_sync_at) + '</td><td>' + (it.status === 'ok' ? '<span class="bk-pill on">ok</span>' : '<span class="bk-pill err">' + esc(it.error || it.status) + '</span>') + '</td><td><button class="bk-btn sm bad" data-unlink="' + it.id + '">Disconnect</button></td></tr>').join('') + '</tbody></table>'
        : '<div class="bk-muted">No bank connected yet.</div>') +
      '<ol class="bk-steps"><li>Create a Plaid account at dashboard.plaid.com (the Transactions product; Sandbox to try, then request Production / Limited Production).</li><li>Put <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code> and <code>PLAID_ENV=sandbox|production</code> in <code>.env</code> and restart Nova.</li><li>Nothing to set in the dashboard\u2019s Webhooks page (that page is only for Transfer / Wallet / Income events): the Transactions webhook <code>' + esc(c.chat.plaid_webhook_url) + '</code> is attached to every bank connection Nova creates. Allowed redirect URIs are not needed.</li><li>Press <b>Connect a bank</b> and sign in to each bank (2 accounts). Transactions sync straight away; the webhook keeps them current, the daily run syncs again.</li></ol></div>' +
      // Gmail
      '<div class="bk-card"><h2>Accounting inbox — ' + esc(c.gmail.inbox) + ' ' + pill(c.gmail.key, 'service account key present', 'gmail-key.json missing') + '<span class="sp"></span><button class="bk-btn" id="scanNow2">Scan now</button></h2>' +
      '<div class="bk-muted">Read with the same Google service account Nova uses for order@ (domain-wide delegation). Polled every ' + esc(c.gmail.poll_min) + ' min' + (c.gmail.last_scan ? ' · last scan ' + when(c.gmail.last_scan) : ' · not scanned yet') + '. Gmail push: ' + (c.gmail.push && c.gmail.topic ? '<span class="bk-pill on">configured</span>' + (c.gmail.watch_expires ? ' watch until ' + when(c.gmail.watch_expires) : ' — press Start watch') : '<span class="bk-pill off">not set up (polling only)</span>') + '</div>' +
      '<ol class="bk-steps"><li>Nothing to do for reading: the delegation that covers order@ covers accounting@ too (scope gmail.readonly). If scanning fails with "unauthorized_client", add the scope in Google Admin → Security → API controls → Domain-wide delegation.</li>' +
      '<li>Optional, for instant pickup: in the Google Cloud project of the service account enable Pub/Sub, create a topic, give <code>gmail-api-push@system.gserviceaccount.com</code> the Publisher role on it, add a push subscription to <code>' + esc(c.chat.push_url) + '</code>, then set <code>BOOKKEEPER_PUBSUB_TOPIC</code> and <code>BOOKKEEPER_PUSH_TOKEN</code> in .env and press <button class="bk-btn sm" id="watchBtn">Start watch</button> (it renews daily).</li></ol>' +
      '<div class="bk-row" style="margin-top:8px"><label class="bk-muted">Poll every <input class="bk" id="sPoll" type="number" min="2" max="120" value="' + esc(s.poll_min) + '" style="width:70px"> min</label><label class="bk-muted">First scan looks back <input class="bk" id="sBack" type="number" min="1" max="90" value="' + esc(s.backfill_days) + '" style="width:70px"> days</label></div></div>' +
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
    $('connSave').onclick = async () => { const b = { run_at: $('sRunAt').value, poll_min: $('sPoll').value, backfill_days: $('sBack').value }; if ($('sHook').value.trim()) b.chat_webhook = $('sHook').value.trim(); await post('/api/bookkeeping/settings', b); $('connMsg').textContent = 'Saved.'; loadConn(); };
    $('chatTest').onclick = async () => { $('chatTest').disabled = true; const r = await post('/api/bookkeeping/chat/test', {}); $('connMsg').textContent = r.ok ? 'Sent via ' + r.posted.via + '.' : r.error; $('chatTest').disabled = false; };
    $('scanNow2').onclick = async () => { $('scanNow2').disabled = true; const r = await post('/api/bookkeeping/scan', {}); $('connMsg').textContent = r.ok ? 'Scanned: ' + r.scan.new + ' new email(s), ' + r.parsed.bills + ' bill draft(s).' : r.error; loadConn(); };
    if ($('watchBtn')) $('watchBtn').onclick = async (e) => { e.preventDefault(); const r = await post('/api/bookkeeping/gmail/watch', {}); $('connMsg').textContent = r.ok ? 'Watching.' : r.error; loadConn(); };
    v.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => { if (!confirm('Disconnect this bank? Its transactions stay.')) return; await api('/api/bookkeeping/plaid/' + b.dataset.unlink, { method: 'DELETE' }); loadConn(); });
    $('plaidLink').onclick = async () => {
      $('plaidLink').disabled = true;
      const r = await post('/api/bookkeeping/plaid/link-token', {});
      if (!r.ok) { alert(r.error); $('plaidLink').disabled = false; return; }
      await loadScript('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
      const h = window.Plaid.create({ token: r.link_token,
        onSuccess: async (public_token, metadata) => { const x = await post('/api/bookkeeping/plaid/exchange', { public_token, metadata }); $('connMsg').textContent = x.ok ? 'Connected ' + x.institution + (x.first_sync && x.first_sync.added != null ? ' — ' + x.first_sync.added + ' transactions pulled.' : '.') : x.error; loadConn(); },
        onExit: () => { $('plaidLink').disabled = false; } });
      h.open();
    };
  }
  function loadScript(src) { return new Promise((ok, no) => { if (document.querySelector('script[src="' + src + '"]')) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }

  // ---------------------------------------------------------------- Activity
  async function loadActivity() {
    const v = $('vActivity');
    const j = await api('/api/bookkeeping/activity');
    v.innerHTML = '<div class="bk-card"><h2>Runs</h2><table class="bk"><thead><tr><th>Started</th><th>Kind</th><th>By</th><th>Result</th></tr></thead><tbody>' +
      (j.runs || []).map(r => '<tr><td>' + when(r.started_at) + '</td><td>' + esc(r.kind) + '</td><td>' + esc(r.started_by || '') + '</td><td>' + (r.finished_at ? (r.ok ? '<span class="bk-pill on">ok</span> ' : '<span class="bk-pill err">failed</span> ') : '<span class="bk-pill off">running</span> ') + esc(r.summary || '') + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="bk-card"><h2>Briefs</h2><table class="bk"><thead><tr><th>Day</th><th>Questions / categories / bills</th><th>Google Chat</th></tr></thead><tbody>' +
      (j.briefs || []).map(b => { let st = {}; try { st = JSON.parse(b.stats || '{}'); } catch (e) {} return '<tr><td>' + esc(b.day) + '</td><td>' + (st.questions || 0) + ' / ' + (st.categories || 0) + ' / ' + (st.bills || 0) + '</td><td>' + (b.posted_at ? 'posted ' + when(b.posted_at) : b.post_error ? '<span class="bk-pill err">' + esc(b.post_error) + '</span>' : 'not posted') + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="bk-card"><h2>Audit log<span class="sp"></span><span class="bk-muted">every action by the agent, the executor and people</span></h2><table class="bk"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Ref</th><th>Detail</th></tr></thead><tbody>' +
      (j.audit || []).map(a => '<tr><td>' + when(a.at) + '</td><td>' + esc(a.who) + '</td><td>' + esc(a.action) + '</td><td>' + esc(a.ref || '') + '</td><td class="bk-muted">' + esc(String(a.detail || '').slice(0, 200)) + '</td></tr>').join('') + '</tbody></table></div>';
  }

  const qs = new URLSearchParams(location.search), want = qs.get('tab');
  show(['brief', 'txns', 'bills', 'inbox', 'accounts', 'vendors', 'chart', 'rules', 'materials', 'conn', 'activity'].indexOf(want) > -1 ? want : 'brief', qs.get('sub'));
})();
