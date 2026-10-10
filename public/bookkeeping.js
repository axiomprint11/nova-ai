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

  let ov = null, categories = [];
  document.querySelectorAll('.bk-tabs button').forEach(b => b.onclick = () => show(b.dataset.v));
  function show(v) {
    document.querySelectorAll('.bk-tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    document.querySelectorAll('.bk-view').forEach(s => s.classList.toggle('on', s.dataset.v === v));
    ({ brief: loadBrief, txns: loadTxns, bills: loadBills, vendors: loadVendors, rules: loadRules, conn: loadConn, activity: loadActivity })[v]();
    try { history.replaceState(null, '', '/bookkeeping?tab=' + v); } catch (e) {}
  }
  async function overview() {
    ov = await api('/api/bookkeeping/overview');
    categories = String(ov.settings.categories || '').split('\n').map(x => x.trim()).filter(Boolean);
    $('nPending').textContent = ov.counts.pending || '';
    const rs = $('runState');
    if (ov.running) { rs.className = 'bk-pill off'; rs.textContent = 'Running…'; }
    else if (ov.last_run) { rs.className = 'bk-pill ' + (ov.last_run.ok ? 'on' : 'err'); rs.textContent = (ov.last_run.ok ? 'Last run ' : 'Last run failed ') + when(ov.last_run.started_at); }
    else { rs.className = 'bk-pill off'; rs.textContent = 'Not run yet'; }
    return ov;
  }
  const catSelect = (cur, cls, blank) => '<select class="' + (cls || '') + '">' + (blank ? '<option value=""' + (cur ? '' : ' selected') + '>' + esc(blank) + '</option>' : '') + categories.concat(cur && categories.indexOf(cur) < 0 ? [cur] : []).map(c => '<option' + (c === cur ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>';
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
      const row = b.closest('.bk-prop'); const sel = row.querySelector('select.pick'); const rem = row.querySelector('.remember'); const av = row.querySelector('.appvendor');
      b.disabled = true;
      const r = await post('/api/bookkeeping/proposals/' + b.dataset.approve + '/decide', { action: 'approve', category: sel ? sel.value : undefined, remember: rem ? rem.checked : undefined, approve_vendor: av ? av.checked : undefined });
      if (!r.ok) { alert(r.error || 'Could not approve'); b.disabled = false; } else refresh();
    });
    v.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => { const note = prompt('Why? (optional)') ; if (note === null) return; b.disabled = true; await post('/api/bookkeeping/proposals/' + b.dataset.reject + '/decide', { action: 'reject', note }); refresh(); });
    v.querySelectorAll('[data-answer]').forEach(b => b.onclick = async () => {
      const row = b.closest('.bk-prop'); const inp = row.querySelector('[data-ans]'); const cat = row.querySelector('select.ans-cat');
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
        '<td class="num ' + (t.amount > 0 ? 'neg' : 'pos') + '">' + usd(-t.amount) + '</td><td>' + (t.category ? esc(t.category) + ' <span class="bk-tag ' + esc(t.category_source || '') + '">' + esc(t.category_source || '') + '</span>' : '<span class="bk-tag ' + esc(t.status) + '">' + esc(t.status) + '</span>') + '</td>' +
        '<td>' + catSelect(t.category || '', 'tx-cat') + ' <button class="bk-btn sm" data-tx="' + t.id + '">Set</button></td></tr>').join('') + '</tbody></table>' +
      (!(j.transactions || []).length ? '<div class="bk-muted" style="padding:14px 0">No transactions yet — connect a bank under Connections, then Sync.</div>' : '') + '</div>';
    $('txnGo').onclick = loadTxns; v.querySelector('input[name=q]').onkeydown = (e) => { if (e.key === 'Enter') loadTxns(); };
    $('syncNow').onclick = async () => { $('syncNow').disabled = true; const r = await post('/api/bookkeeping/sync', {}); if (!r.ok) alert(r.error); loadTxns(); overview(); };
    v.querySelectorAll('[data-tx]').forEach(b => b.onclick = async () => { const sel = b.previousElementSibling; await post('/api/bookkeeping/transactions/' + b.dataset.tx + '/category', { category: sel.value }); loadTxns(); overview(); });
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
    const [j, e] = await Promise.all([api('/api/bookkeeping/bills'), api('/api/bookkeeping/emails')]);
    v.innerHTML = '<div class="bk-card"><h2>Bill drafts<span class="sp"></span><button class="bk-btn" id="scanNow">Scan the inbox now</button></h2>' +
      '<table class="bk"><thead><tr><th>#</th><th>Vendor</th><th>Invoice</th><th>Dates</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>' +
      (j.bills || []).map(b => '<tr><td>' + b.id + '</td><td>' + esc(b.vendor) + (b.duplicate_of ? '<div class="bk-tag">dup of #' + b.duplicate_of + '</div>' : '') + '</td><td>' + esc(b.invoice_no || '') + ' <span class="bk-tag">' + esc(b.kind) + '</span></td><td>' + esc(b.invoice_date || '') + (b.due_date ? '<div class="bk-muted">due ' + esc(b.due_date) + '</div>' : '') + '</td><td class="num">' + usd(b.total) + '</td><td><span class="bk-tag ' + esc(b.status) + '">' + esc(b.status) + '</span>' + (b.note ? '<div class="bk-muted">' + esc(b.note) + '</div>' : '') + '</td><td>' + (b.file ? '<a href="#" data-file="' + b.id + '">file</a>' : '') + '</td></tr>' +
        (b.lines.length ? '<tr><td></td><td colspan="6"><div class="bk-lines">' + b.lines.map(l => '<div><span>' + esc(l.description) + '</span><span>' + esc(l.category || '') + '</span><span>' + usd(l.amount) + '</span></div>').join('') + '</div></td></tr>' : '')).join('') + '</tbody></table>' +
      (!(j.bills || []).length ? '<div class="bk-muted" style="padding:14px 0">No bill drafts yet.</div>' : '') + '</div>' +
      '<div class="bk-card"><h2>Inbox — ' + esc(ov ? ov.connections.gmail.inbox : '') + '</h2><table class="bk"><thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Attachments</th><th>Status</th><th></th></tr></thead><tbody>' +
      (e.emails || []).map(m => '<tr><td>' + when(m.received_at) + '</td><td>' + esc(m.from_addr) + '</td><td>' + esc(m.subject) + '<div class="bk-muted">' + esc(m.snippet) + '</div></td><td>' + m.attachments.map(a => esc(a.name)).join('<br>') + '</td><td><span class="bk-tag ' + esc(m.status) + '">' + esc(m.status) + '</span>' + (m.note ? '<div class="bk-muted">' + esc(m.note) + '</div>' : '') + '</td><td>' + (m.status !== 'parsed' ? '<button class="bk-btn sm" data-parse="' + m.id + '">Read as a bill</button>' : '') + '</td></tr>').join('') + '</tbody></table>' +
      (!(e.emails || []).length ? '<div class="bk-muted" style="padding:14px 0">Nothing scanned yet.</div>' : '') + '</div>';
    $('scanNow').onclick = async () => { $('scanNow').disabled = true; const r = await post('/api/bookkeeping/scan', {}); if (!r.ok) alert(r.error); loadBills(); overview(); };
    v.querySelectorAll('[data-file]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); openFile(a.dataset.file); });
    v.querySelectorAll('[data-parse]').forEach(b => b.onclick = async () => { b.disabled = true; const r = await post('/api/bookkeeping/emails/' + b.dataset.parse + '/parse', {}); if (!r.ok) alert(r.error); loadBills(); overview(); });
  }

  // ---------------------------------------------------------------- Rules
  async function loadRules() {
    const v = $('vRules');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/rules');
    v.innerHTML = '<div class="bk-card"><h2>Categorization rules<span class="sp"></span><span class="bk-muted">applied before the AI looks — made from your approvals, or here</span></h2>' +
      '<div class="bk-row" style="margin-bottom:10px"><select class="bk" id="rKind"><option value="vendor">Vendor is</option><option value="keyword">Description contains</option></select><input class="bk" id="rPat" placeholder="e.g. Veritiv or AMAZON" style="min-width:220px">' + catSelect('', 'bk') + '<button class="bk-btn p" id="rAdd">Add rule</button></div>' +
      '<table class="bk"><thead><tr><th>Rule</th><th>Category</th><th>From</th><th>Hits</th><th></th></tr></thead><tbody>' +
      (j.rules || []).map(r => '<tr><td>' + (r.kind === 'vendor' ? 'Vendor is ' : 'Contains ') + '<b>' + esc(r.pattern) + '</b></td><td>' + esc(r.category) + '</td><td>' + esc(r.source) + ' · ' + esc(r.created_by || '') + '</td><td>' + r.hits + '</td><td><button class="bk-btn sm bad" data-del="' + r.id + '">Remove</button></td></tr>').join('') + '</tbody></table>' +
      (!(j.rules || []).length ? '<div class="bk-muted" style="padding:14px 0">No rules yet — each approval with "remember" ticked adds one.</div>' : '') + '</div>' +
      
      '<div class="bk-card"><h2>Chart of accounts and notes for the AI</h2><div class="bk-muted">One category per line. The notes tell BookkeeperAI how AxiomPrint books things.</div>' +
      '<textarea class="bk" id="sCats" style="min-height:160px;margin-top:8px">' + esc(ov.settings.categories) + '</textarea><textarea class="bk" id="sNotes" style="margin-top:8px">' + esc(ov.settings.notes) + '</textarea>' +
      '<div class="bk-row" style="margin-top:8px"><label class="bk-muted">Ask me when confidence is below <input class="bk" id="sThr" type="number" min="0.3" max="1" step="0.05" value="' + esc(ov.settings.threshold) + '" style="width:80px"></label><button class="bk-btn p" id="sSave">Save</button><span class="bk-muted" id="sMsg"></span></div></div>';
    $('rAdd').onclick = async () => { const r = await post('/api/bookkeeping/rules', { kind: $('rKind').value, pattern: $('rPat').value.trim(), category: v.querySelector('select.bk:not(#rKind)').value }); if (!r.ok) alert(r.error); loadRules(); };
    v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/api/bookkeeping/rules/' + b.dataset.del, { method: 'DELETE' }); loadRules(); });
    $('sSave').onclick = async () => { await post('/api/bookkeeping/settings', { categories: $('sCats').value, notes: $('sNotes').value, threshold: $('sThr').value }); $('sMsg').textContent = 'Saved.'; overview(); };
  }

  // ---------------------------------------------------------------- Suppliers & vendors (the CRM directory + vendors seen on bills)
  async function loadVendors() {
    const v = $('vVendors');
    if (!ov) await overview();
    const j = await api('/api/bookkeeping/directory');
    const src = (x) => x.source === 'suppliers' ? '<span class="bk-src">supplier</span>' : x.source === 'vendors' ? '<span class="bk-src vendors">vendor</span>' : '<span class="bk-src bill">from a bill</span>';
    const row = (x) => '<tr data-vid="' + x.id + '"><td>' + src(x) + ' <b>' + esc(x.name) + '</b>' + (x.contact ? '<div class="bk-muted">' + esc(x.contact) + '</div>' : '') + '</td><td class="bk-muted">' + esc(x.email || '') + (x.phone ? '<br>' + esc(x.phone) : '') + '</td><td class="bk-muted">' + esc(x.specialty || '') + '</td>' +
      '<td>' + catSelect(x.default_category || '', 'vcat', '— not set —') + '</td><td><input type="text" class="bk valias" placeholder="bank names, one per line" value="' + esc(String(x.aliases || '').split('\n').join(' | ')) + '" title="How this vendor appears on bank statements (separate with |)"></td>' +
      '<td><label><input type="checkbox" class="vappr"' + (x.approved ? ' checked' : '') + '> ' + (x.approved ? 'yes' : 'no') + '</label></td><td class="bk-muted">' + (x.txns || 0) + ' / ' + (x.bills || 0) + '</td><td><button class="bk-btn sm" data-vsave="' + x.id + '">Save</button></td></tr>';
    const crm = (j.vendors || []).filter(x => x.source === 'suppliers' || x.source === 'vendors'), seen = (j.vendors || []).filter(x => !(x.source === 'suppliers' || x.source === 'vendors'));
    const table = (rows) => '<table class="bk"><thead><tr><th>Name</th><th>Contact</th><th>Specialty</th><th>Usual category</th><th>On the bank statement as</th><th>Approved</th><th>Txns / bills</th><th></th></tr></thead><tbody>' + rows.map(row).join('') + '</tbody></table>';
    v.innerHTML = '<div class="bk-card"><h2>From the CRM — Suppliers and Vendors<span class="sp"></span><span class="bk-muted">' + (j.synced_at ? 'synced ' + when(j.synced_at) : 'not synced yet') + '</span><button class="bk-btn" id="dirSync"' + (j.crm ? '' : ' disabled') + '>Refresh from CRM</button></h2>' +
      '<div class="bk-muted" style="margin-bottom:8px">Read from the CRM\u2019s Suppliers and Vendors lists (read-only, refreshed with every daily run). They are trusted: a bank line or bill that matches one is linked to it, and BookkeeperAI uses the specialty and the usual category when it proposes. Edit names, emails and specialties in the CRM; set the usual category and the bank-statement names here.</div>' +
      (crm.length ? table(crm) : '<div class="bk-muted">Nothing synced yet — press Refresh from CRM.</div>') + '</div>' +
      '<div class="bk-card"><h2>Seen on bills, not in the CRM<span class="sp"></span><span class="bk-muted">approve them here, or add them in the CRM</span></h2>' + (seen.length ? table(seen) : '<div class="bk-muted">None.</div>') + '</div>';
    $('dirSync').onclick = async () => { $('dirSync').disabled = true; const r = await post('/api/bookkeeping/directory/sync', {}); if (!r.ok) alert(r.error); else if (r.errors && r.errors.length) alert(r.errors.join('\n')); loadVendors(); };
    v.querySelectorAll('[data-vsave]').forEach(b => b.onclick = async () => {
      const tr = b.closest('tr'); b.disabled = true;
      await post('/api/bookkeeping/vendors/' + b.dataset.vsave, { approved: tr.querySelector('.vappr').checked, default_category: tr.querySelector('select.vcat').value, aliases: tr.querySelector('.valias').value.split('|').map(x => x.trim()).filter(Boolean).join('\n') });
      loadVendors();
    });
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
      '<ol class="bk-steps"><li>Create a Plaid account at dashboard.plaid.com (the Transactions product; Sandbox to try, then request Production / Limited Production).</li><li>Put <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code> and <code>PLAID_ENV=sandbox|production</code> in <code>.env</code> and restart Nova.</li><li>In the Plaid dashboard → Team Settings → Webhooks add <code>' + esc(c.chat.plaid_webhook_url) + '</code> (also sent with every Link). Allowed redirect URIs are not needed.</li><li>Press <b>Connect a bank</b> and sign in to each bank (2 accounts). Transactions sync straight away; the webhook keeps them current, the daily run syncs again.</li></ol></div>' +
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

  const want = new URLSearchParams(location.search).get('tab');
  show(['brief', 'txns', 'bills', 'vendors', 'rules', 'conn', 'activity'].indexOf(want) > -1 ? want : 'brief');
})();
