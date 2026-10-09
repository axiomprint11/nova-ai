// TalkAi admin page: Calls · Try it · Training · Setup.
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const H = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
  const api = async (url, opts) => {
    const r = await fetch(url, Object.assign({ headers: H() }, opts || {}));
    if (r.status === 401 || r.status === 403) { location.href = '/'; throw new Error('signed out'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = 'Error ' + r.status;
    return j;
  };
  const toDate = (ts) => new Date(String(ts).replace(' ', 'T') + (/Z$|[+-]\d\d:?\d\d$/.test(String(ts)) ? '' : 'Z'));
  const rel = (ts) => {
    if (!ts) return '';
    const d = toDate(ts); if (isNaN(d)) return String(ts);
    const now = new Date(), mins = Math.round((now - d) / 60000);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day0(now) - day0(d)) / 86400000);
    if (days === 0) return mins < 1 ? 'Just now' : mins < 60 ? mins + ' min ago' : 'Today ' + time;
    if (days === 1) return 'Yesterday ' + time;
    if (days < 7) return d.toLocaleDateString([], { weekday: 'long' }) + ' ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  };
  const full = (ts) => { const d = toDate(ts); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }); };
  // +18185551234 -> (818) 555-1234
  const phone = (v) => {
    const d = String(v || '').replace(/\D/g, '');
    const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    return t.length === 10 ? '(' + t.slice(0, 3) + ') ' + t.slice(3, 6) + '-' + t.slice(6) : (v || '');
  };
  const dur = (s) => s == null ? '' : s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
  const LANG = { en: 'English', es: 'Spanish', hy: 'Armenian', ru: 'Russian', fa: 'Farsi', ar: 'Arabic', ko: 'Korean', zh: 'Chinese', fr: 'French' };
  const lang = (l) => l ? (LANG[String(l).slice(0, 2).toLowerCase()] || l) : '';
  // The call's language as a small flag (drawn, since Windows shows flag emoji as letters); the name is the tooltip.
  // Languages without a flag here show their name.
  const FLAGS = {
    en: '<rect width="21" height="15" fill="#fff"/><g fill="#b22234"><rect width="21" height="1.15"/><rect y="2.3" width="21" height="1.15"/><rect y="4.6" width="21" height="1.15"/><rect y="6.9" width="21" height="1.15"/><rect y="9.2" width="21" height="1.15"/><rect y="11.5" width="21" height="1.15"/><rect y="13.85" width="21" height="1.15"/></g><rect width="9" height="8.05" fill="#3c3b6e"/>',
    es: '<rect width="21" height="15" fill="#aa151b"/><rect y="3.75" width="21" height="7.5" fill="#f1bf00"/>',
    hy: '<rect width="21" height="5" fill="#d90012"/><rect y="5" width="21" height="5" fill="#0033a0"/><rect y="10" width="21" height="5" fill="#f2a800"/>',
    ru: '<rect width="21" height="5" fill="#fff"/><rect y="5" width="21" height="5" fill="#0039a6"/><rect y="10" width="21" height="5" fill="#d52b1e"/>'
  };
  const flagChip = (l) => {
    const k = String(l || '').slice(0, 2).toLowerCase(), name = lang(l);
    return FLAGS[k] ? '<span class="tk-chip tk-flag" title="' + esc(name) + '" aria-label="' + esc(name) + '"><svg viewBox="0 0 21 15" width="21" height="15" aria-hidden="true">' + FLAGS[k] + '</svg></span>'
      : '<span class="tk-chip">' + esc(name) + '</span>';
  };

  let ov = null;
  async function loadOverview() {
    const j = await api('/api/admin/talk/overview');
    if (!j.ok) return;
    ov = j;
    const k = j.keys, s = j.settings;
    const ready = k.TWILIO_AUTH_TOKEN && k.ELEVENLABS_API_KEY && k.ELEVENLABS_AGENT_ID && k.TALKAI_LLM_KEY;
    const pill = $('tkPill');
    if (s.mode === 'forward') { pill.className = 'tk-pill fw'; pill.textContent = 'Forwarding to the team'; }
    else if (s.mode === 'message') { pill.className = 'tk-pill off'; pill.textContent = 'Closed message'; }
    else if (ready) { pill.className = 'tk-pill on'; pill.textContent = 'NovaAI answers'; }
    else { pill.className = 'tk-pill off'; pill.textContent = 'Setup needed'; }
    $('tkNum').textContent = j.number ? phone(j.number) : '';
    return j;
  }

  // ---- tabs ----
  const views = { calls: 'vCalls', try: 'vTry', train: 'vTrain', ams: 'vAms', setup: 'vSetup' };
  function show(v) {
    document.querySelectorAll('.tk-tabs button').forEach(x => x.classList.toggle('on', x.dataset.v === v));
    Object.keys(views).forEach(k => $(views[k]).classList.toggle('on', k === v));
    if (v === 'calls') loadCalls();
    if (v === 'train') paintTraining();
    if (v === 'setup') loadOverview().then(paintSetup);
    if (v === 'ams') loadAms();
    if (v === 'try') { api('/api/admin/talk/lines').then(l => { lines = l.lines || []; fillTryLines(); }).catch(() => {}); if (!tryState.msgs.length && !tryState.busy) paintTryIdle(); }
  }
  document.querySelectorAll('.tk-tabs button').forEach(b => { b.onclick = () => show(b.dataset.v); });

  // ---- Calls ----
  let filter = '', current = null, qTimer = null;
  document.querySelectorAll('#callFilter button').forEach(b => {
    b.onclick = () => { filter = b.dataset.f; document.querySelectorAll('#callFilter button').forEach(x => x.classList.toggle('on', x === b)); loadCalls(); };
  });
  $('callQ').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadCalls, 300); };
  $('callRefresh').onclick = async () => { const b = $('callRefresh'); b.classList.add('spin'); await loadCalls(); setTimeout(() => b.classList.remove('spin'), 300); };
  $('callReadAll').onclick = async () => { await api('/api/admin/talk/read-all', { method: 'POST', body: '{}' }); loadCalls(); };
  function setUnread(n) {
    $('tkUnread').textContent = n ? (n > 99 ? '99+' : n) : '';
    $('tkUnreadTab').textContent = n ? (n > 99 ? '99+' : n) : '';
    if (window.NovaNav) NovaNav.set('talk', n);
  }
  async function loadCalls() {
    const j = await api('/api/admin/talk/calls?filter=' + encodeURIComponent(filter) + '&q=' + encodeURIComponent($('callQ').value.trim()));
    if (!j.ok) { $('callRows').innerHTML = '<div class="tk-empty">' + esc(j.error || 'Could not load calls.') + '</div>'; return; }
    setUnread(j.unread);
    $('callStamp').textContent = j.calls.length + ' call' + (j.calls.length === 1 ? '' : 's') + ' · updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (!j.calls.length) {
      $('callRows').innerHTML = '<div class="tk-empty">' + (filter || $('callQ').value ? 'No calls match.' : 'No calls yet. Once the number is connected (Setup), every call shows up here — or try it under Try it.') + '</div>';
      return;
    }
    $('callRows').innerHTML = j.calls.map(callRow).join('');
    $('callRows').querySelectorAll('.tk-row').forEach(b => { b.onclick = () => openCall(parseInt(b.dataset.id)); });
  }

  // One call in the list: an avatar that says at a glance who it is (initials = a customer we know; a plain grey
  // phone = a number that is not on any account), the name and company, the phone number, and only the tags that matter.
  const AV_TONES = 8;
  const initials = (n) => { const w = String(n || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean); return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : (w[0] || '')[1] || '')).toUpperCase(); };
  const tone = (n) => { let h = 0; String(n || '').split('').forEach(ch => { h = (h * 31 + ch.charCodeAt(0)) >>> 0; }); return h % AV_TONES; };
  const AV_ICON = {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>'
  };
  function callAvatar(c) {
    const match = c.caller_match && c.caller_match[0];
    const own = Number(c.owner) === 1 && c.line_name;
    const person = own ? c.line_name : c.customer_name || (match ? (match.person || match.name) : '');
    if (c.source !== 'phone') return '<span class="tk-av test" title="Test" aria-label="Test call">' + AV_ICON.test + '</span>';
    if (person) return '<span class="tk-av t' + tone(person) + (own ? ' own' : '') + '" title="' + esc(c.verified ? 'Recognised customer' : 'Number on a customer account \u2014 not verified') + '">' + esc(initials(person)) + '</span>';
    return '<span class="tk-av unk" title="Not verified \u2014 the number is not on a customer account" aria-label="Not verified">' + AV_ICON.phone + '</span>';
  }
  function callRow(c) {
    const match = c.caller_match && c.caller_match[0];
    const test = c.source !== 'phone';
    const own = Number(c.owner) === 1 && c.line_name;
    // Who: verified/recognised customer, else the account the number belongs to, else nobody.
    const person = own ? c.line_name : c.customer_name || (match ? (match.person || match.name) : '');
    const company = own ? 'Calling their assistant' : c.customer_name ? (c.company || '') : match ? (match.company || '') : '';
    const known = !!person;
    const num = phone(c.from_number);
    const av = callAvatar(c);
    let title, line2;
    if (test) {
      title = known ? person : c.source === 'try' ? 'Test in text' : 'ElevenLabs test call';
      line2 = [known && company ? company : '', c.source === 'try' && c.tried_by ? 'by ' + String(c.tried_by).replace(/^member:|^user:/, '') : '', num].filter(Boolean).join(' \u00b7 ');
    } else if (known) {
      title = person;
      line2 = [company, num].filter(Boolean).join(' \u00b7 ');
    } else {
      title = num || 'Unknown number';
      line2 = num ? 'Not a client yet' : 'No caller ID';
    }
    const tags = [];
    if (!own && c.line_name) tags.push('<span class="tk-tag tr">' + esc(String(c.line_name).split(' ')[0]) + '\u2019s line</span>');
    if (c.hours_mode === 'after') tags.push('<span class="tk-tag">After hours</span>');
    if (c.hours_mode === 'missed') tags.push('<span class="tk-tag msg">Missed call</span>');
    if (c.emails_n) tags.push('<span class="tk-tag ok">\u2709 Email sent</span>');
    if (test) tags.push('<span class="tk-tag test">Test</span>');
    if (c.outcome === 'message') tags.push('<span class="tk-tag msg">Message</span>');
    if (c.outcome === 'transferred' || c.answered_by === 'forward') tags.push('<span class="tk-tag tr">' + (c.outcome === 'transferred' ? 'Transferred' : 'Forwarded') + '</span>');
    if (Number(c.callback) === 1 && !test) tags.push('<span class="tk-tag msg">Call back</span>');
    const sub = c.ai_summary || c.summary || c.first_said || (c.answered_by === 'message' ? 'Closed message played' : c.status ? 'Status: ' + c.status : '');
    return '<button type="button" class="tk-row' + (c.unread ? ' unread' : '') + (current === c.id ? ' on' : '') + (known || test ? '' : ' unknown') + '" data-id="' + c.id + '">' + av +
      '<span class="tk-rb"><span class="tk-r1"><b class="t">' + esc(title) + '</b><span class="when">' + esc(rel(c.created_at)) + (c.duration_sec ? ' \u00b7 ' + esc(dur(c.duration_sec)) : '') + '</span></span>' +
      (line2 ? '<span class="tk-r2">' + esc(line2) + '</span>' : '') +
      (tags.length ? '<span class="tk-r3">' + tags.join('') + '</span>' : '') +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></button>';
  }

  let audioUrl = null;
  async function openCall(id) {
    current = id;
    $('vCalls').classList.add('detail');
    document.querySelectorAll('.tk-row').forEach(b => { const on = parseInt(b.dataset.id) === id; b.classList.toggle('on', on); if (on) b.classList.remove('unread'); });
    history.replaceState(null, '', '/talk-ai?call=' + id);
    const v = $('callView');
    v.innerHTML = '<div class="tk-empty">Loading…</div>';
    const j = await api('/api/admin/talk/calls/' + id);
    if (!j.ok) { v.innerHTML = '<div class="tk-empty">' + esc(j.error || 'Could not load the call.') + '</div>'; return; }
    const c = j.call, turns = j.turns || [];
    const match = (c.caller_match || []).map(m => esc(m.name) + (m.company ? ' (' + esc(m.company) + ')' : '') + ' <i>#' + m.id + '</i>').join(', ');
    const chips = [];
    chips.push('<span class="tk-chip">' + esc(full(c.created_at)) + '</span>');
    if (c.line_name) chips.push('<span class="tk-chip ok">' + esc(c.line_name) + (Number(c.owner) === 1 ? ' calling their assistant' : Number(c.owner) === 2 ? '\u2019s phone (not verified)' : '\u2019s line') + '</span>');
    if (c.screen_ok != null) chips.push('<span class="tk-chip">' + (Number(c.screen_ok) === 1 ? 'They pressed 1 and took it' : 'Rang them first \u2014 not taken') + '</span>');
    if (c.hours_mode) chips.push('<span class="tk-chip' + (c.hours_mode === 'missed' ? ' warn' : '') + '">' + (c.hours_mode === 'after' ? 'After hours' : c.hours_mode === 'missed' ? 'Missed call \u2014 the team didn\u2019t pick up' : 'Regular hours') + '</span>');
    if (c.duration_sec != null) chips.push('<span class="tk-chip">' + esc(dur(c.duration_sec)) + '</span>');
    if (c.source === 'phone') chips.push(/passed-(a|b)\b/i.test(c.stir || '') ? '<span class="tk-chip ok" title="' + esc(c.stir) + '">Caller ID carrier-verified</span>'
      : '<span class="tk-chip" title="' + esc(c.stir || 'No STIR/SHAKEN result from the carrier') + '">Caller ID not carrier-verified</span>');
    if (Number(c.returning) === 1) chips.push('<span class="tk-chip">Talked to NovaAI before \u2014 short greeting</span>');
    if (c.language) chips.push(flagChip(c.language));
    // The usual case (NovaAI answered, call completed) needs no chip; only the exceptions are shown.
    if (c.answered_by && c.answered_by !== 'ai') chips.push('<span class="tk-chip">' + esc({ ai: 'Answered by NovaAI', forward: 'Forwarded to the team', message: 'Closed message', person: 'Answered by the team', ring: 'Ringing the team', menu: 'At the language menu' }[c.answered_by] || c.answered_by) + '</span>');
    if (c.outcome === 'message') chips.push('<span class="tk-chip warn">Message taken</span>');
    if (c.outcome === 'transferred') chips.push('<span class="tk-chip ok">Transferred</span>');
    if (c.status && c.source === 'phone' && !/^(completed|in-progress)$/.test(c.status)) chips.push('<span class="tk-chip">' + esc(c.status) + '</span>');
    // Emails NovaAI sent on this call: click to see exactly what went out.
    (c.emails || []).forEach((m, i) => chips.push('<button type="button" class="tk-mailbtn' + (m.ok ? '' : ' bad') + '" data-mail="' + i + '" title="Show the email">' +
      '\u2709 ' + (m.kind === 'csr' ? 'CSR team notified' : m.ok ? 'Email sent \u00b7 ' + esc(m.to_addr) : 'Email failed \u00b7 ' + esc(m.to_addr)) + '</button>'));
    if (c.emailed_to && !(c.emails || []).length) chips.push('<span class="tk-chip ok">Quote emailed to ' + esc(c.emailed_to) + '</span>');
    if (c.ended_reason) chips.push('<span class="tk-chip" title="How the call ended">' + esc(c.ended_reason) + '</span>');
    // Same avatar as the list: initials = a customer, dashed phone = a number on no account (no words needed).
    const who = c.verified ? '<b>' + (c.verified_by === 'caller_id' ? 'Recognised by caller ID:' : c.verified_by === 'check+caller_id' ? 'Verified (number + email/ZIP):' : 'Verified:') + '</b> ' + esc(c.customer_name || '#' + c.customer_id) + (c.company ? ' (' + esc(c.company) + ')' : '') + ' <i>#' + esc(c.customer_id) + '</i>'
      : match ? '<b>Caller ID matches</b> ' + match + ' <i>— not verified on the call</i>' : '';
    let html = '<div class="tk-hd"><button type="button" class="tk-link" id="callBack" style="float:right">← All calls</button>' +
      '<div class="tk-hd-top">' + callAvatar(c) + '<div class="tk-hd-id"><b class="big">' + esc(c.source === 'try' ? 'Test in text' : phone(c.from_number) || 'Unknown number') + '</b>' +
      (c.source !== 'phone' ? ' <span class="tk-tag test">Test</span>' : '') +
      (who ? '<div class="who">' + who + '</div>' : '') + '</div></div>' +
      '<div class="meta">' + chips.join('') + '</div>' +
      (c.has_audio || c.can_fetch_audio ? '<div class="tk-audio" id="callAudio"><span class="tk-msg">Loading the recording…</span></div>' : '') +
      (c.error ? '<div class="tk-msg err" style="margin-top:8px">' + esc(c.error) + '</div>' : '') +
      '<div style="margin-top:8px"><button type="button" class="tk-link" id="callUnread">Mark as unread</button>' +
      (c.page_url ? ' \u00b7 <a class="tk-link" href="' + esc(c.page_url) + '" target="_blank" rel="noopener" style="text-decoration:none">Caller\u2019s page \u2197</a>' : '') + '</div></div>';
    if (c.quotes && c.quotes.length) html += '<div class="tk-sum" style="background:#fff;border-color:var(--line)"><span>Prices given on this call</span>' +
      c.quotes.map(q => '<div style="margin-top:4px"><b>' + esc(q.product) + '</b> \u2014 ' + q.rows.map(r => esc(Number(r.quantity).toLocaleString('en-US')) + ': $' +
        esc(Number(r.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) +
        (r.order_url ? ' <a class="tk-link" style="text-decoration:none;padding:0" href="' + esc(r.order_url) + '" target="_blank" rel="noopener">order link</a>' : '')).join(' \u00b7 ') + '</div>').join('') + '</div>';
    // The AI summary the CSR team gets (Dialpad shows these calls as missed), with the callback verdict.
    if (c.ai_summary) {
      const cb = Number(c.callback) === 1;
      html += '<div class="tk-sum ai"><span>AI summary <em class="' + (cb ? 'cb' : 'ok') + '">' + (cb ? 'Call back' + (c.callback_reason ? ': ' + esc(c.callback_reason) : '') : 'No callback needed') + '</em></span>' +
        esc(c.ai_summary) + '<div class="tk-sumbar">' +
        (c.csr_sent_at ? '<span>Emailed to the CSR team ' + esc(rel(c.csr_sent_at)) + '</span>' : '<span>Not emailed to the CSR team yet</span>') +
        (c.hook_status ? '<span>CRM webhook: ' + esc(c.hook_status) + '</span>' : '') +
        '<button type="button" class="tk-link" data-ho="summary">Write it again</button><button type="button" class="tk-link" data-ho="csr">' + (c.csr_sent_at ? 'Send to CSR again' : 'Send to CSR team') + '</button>' +
        '<button type="button" class="tk-link" data-ho="data">Webhook data</button></div></div>';
    } else if (c.source === 'phone' && (c.transcript || []).length) {
      html += '<div class="tk-sum"><span>Summary' + (c.summary ? ' (ElevenLabs)' : '') + '</span>' + esc(c.summary || 'No AI summary yet.') +
        '<div class="tk-sumbar"><button type="button" class="tk-link" data-ho="summary">Write the AI summary</button><button type="button" class="tk-link" data-ho="data">Webhook data</button></div></div>';
    } else if (c.summary) html += '<div class="tk-sum"><span>Summary</span>' + esc(c.summary) + '</div>';
    const events = turns.filter(t => t.role === 'event');
    // "Quote emailed to X" events → the saved email to X (in order); none saved → rebuilt on click.
    const used = {}, mailKey = new Map();
    events.forEach(t => {
      const m = /^Quote emailed to (\S+)/.exec(String(t.content || ''));
      if (!m) return;
      const to = m[1].toLowerCase();
      const list = (c.emails || []).map((e, i) => ({ e: e, i: i })).filter(x => String(x.e.to_addr).toLowerCase() === to);
      const n = used[to] = (used[to] || 0) + 1;
      const hit = list[Math.min(n, list.length) - 1];
      mailKey.set(t.id, hit ? 'saved:' + hit.i : 'rebuild:' + to);
    });
    const mailFor = (t) => mailKey.get(t.id) || null;
    const evClass = (t) => /verified as|Transferred to|saved/i.test(t) ? ' ok' : /failed/i.test(t) ? ' bad' : '';
    if (c.transcript && c.transcript.length) {
      html += '<div class="tk-sec"><span>Transcript</span><button type="button" class="tk-link" id="showLog">Show NovaAI’s lookups</button></div><div class="tk-tx">' +
        c.transcript.map(t => '<div class="tk-say ' + (t.role === 'caller' ? 'caller' : 'agent') + '"><div class="who">' + (t.role === 'caller' ? 'Caller' : 'NovaAI') +
          '<small>' + (t.at != null ? Math.floor(t.at / 60) + ':' + String(Math.round(t.at % 60)).padStart(2, '0') : '') + '</small></div><div class="b">' + esc(t.text || '') + '</div></div>' +
          (t.tools && t.tools.length ? '<div class="tk-used">' + t.tools.map(x => '<span>' + esc(x) + '</span>').join('') + '</div>' : '')).join('') +
        events.map(t => evtHtml(t, evClass, mailFor)).join('') + '</div>' +
        '<div id="turnLog" hidden>' + turnsHtml(turns, evClass, mailFor) + '</div>';
    } else if (turns.length) {
      html += '<div class="tk-sec"><span>' + (c.source === 'try' ? 'Conversation' : 'As it happened') + '</span></div><div class="tk-tx">' + turnsHtml(turns, evClass, mailFor) + '</div>';
      if (c.source === 'phone' && !/completed|failed|busy|no-answer|canceled/.test(c.status || '')) html += '<div class="tk-msg">The full transcript, summary and recording arrive from ElevenLabs a minute after the call ends.</div>';
    } else {
      html += '<div class="tk-empty">' + (c.answered_by === 'forward' ? 'This call was forwarded to the team.' : c.answered_by === 'message' ? 'The caller heard the closed message.' : 'Nothing was said on this call yet.') + '</div>';
    }
    v.innerHTML = html;
    $('callBack').onclick = () => { $('vCalls').classList.remove('detail'); current = null; history.replaceState(null, '', '/talk-ai'); showCallsOverview(); };
    $('callUnread').onclick = async () => { await api('/api/admin/talk/calls/' + id + '/unread', { method: 'POST', body: '{}' }); current = null; loadCalls(); $('vCalls').classList.remove('detail'); v.innerHTML = '<div class="tk-empty">Marked as unread.</div>'; };
    if ($('showLog')) $('showLog').onclick = () => { const l = $('turnLog'); l.hidden = !l.hidden; $('showLog').textContent = l.hidden ? 'Show NovaAI’s lookups' : 'Hide NovaAI’s lookups'; };
    if (c.has_audio || c.can_fetch_audio) loadAudio(id);
    v.querySelectorAll('[data-mail]').forEach(b => { b.onclick = () => showMail(c.emails[parseInt(b.dataset.mail)]); });
    v.querySelectorAll('[data-ho]').forEach(b => {
      b.onclick = async () => {
        const k = b.dataset.ho;
        if (k === 'data') {
          const j = await api('/api/admin/talk/calls/' + id + '/handoff');
          if (!j.ok) return alert(j.error || 'Could not build it.');
          return showJson('What the CRM webhook gets for this call', j.payload);
        }
        if (k === 'csr' && !confirm('Email this call\u2019s summary to the CSR team now?')) return;
        b.disabled = true; b.textContent = k === 'csr' ? 'Sending\u2026' : 'Writing\u2026';
        const j = await api('/api/admin/talk/calls/' + id + '/handoff', { method: 'POST', body: JSON.stringify(k === 'csr' ? { csr: true } : { summary: true }) });
        if (k === 'csr' && j.csr && !j.csr.sent) alert(j.csr.error || 'Not sent.');
        openCall(id);
      };
    });
    v.querySelectorAll('[data-evmail]').forEach(b => {
      b.onclick = async () => {
        const k = b.dataset.evmail;
        if (k.indexOf('saved:') === 0) return showMail(c.emails[parseInt(k.slice(6))]);
        const j = await api('/api/admin/talk/calls/' + id + '/email-rebuild?to=' + encodeURIComponent(k.slice(8)));
        if (!j.ok) return alert(j.error || 'The email could not be shown.');
        showMail(j.email);
      };
    });
    loadCalls();
  }
  // Data as the CRM receives it, with Copy.
  function showJson(title, obj) {
    const pop = document.createElement('div');
    pop.className = 'tk-pop';
    const txt = JSON.stringify(obj, null, 2);
    pop.innerHTML = '<div class="tk-pop-in" role="dialog" aria-label="' + esc(title) + '"><div class="tk-pop-hd"><b>' + esc(title) + '</b><span style="flex:1"></span>' +
      '<button type="button" class="tk-link" data-copy>Copy</button><button type="button" class="tk-link" data-x>Close</button></div>' +
      '<pre class="tk-json">' + esc(txt) + '</pre></div>';
    document.body.appendChild(pop);
    const close = () => pop.remove();
    pop.onclick = (e) => { if (e.target === pop) close(); };
    pop.querySelector('[data-x]').onclick = close;
    pop.querySelector('[data-copy]').onclick = (e) => { navigator.clipboard.writeText(txt).then(() => { e.target.textContent = 'Copied'; }).catch(() => {}); };
  }
  // An email exactly as it went out, in a sandboxed frame (no scripts; links open in a new tab).
  function showMail(m) {
    if (!m) return;
    const pop = document.createElement('div');
    pop.className = 'tk-mailpop';
    pop.innerHTML = '<div class="tk-mailbox" role="dialog" aria-label="Email"><div class="tk-mailhd"><button type="button" class="x" aria-label="Close">\u2715</button>' +
      '<b class="s">' + esc(m.subject || '(no subject)') + '</b>' +
      '<div><span>To</span> ' + esc(m.to_addr) + '</div>' + (m.bcc ? '<div><span>Bcc</span> ' + esc(m.bcc) + '</div>' : '') +
      '<div><span>Sent</span> ' + esc(full(m.created_at)) + ' from order@axiomprint.com' + (m.ok ? '' : ' \u2014 <b style="color:#b42318">failed: ' + esc(m.error || '') + '</b>') + '</div>' +
      (m.rebuilt ? '<div style="margin-top:6px;padding:6px 9px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px">Sent before emails were saved \u2014 rebuilt from the prices given on this call, so it may include prices quoted after it was sent.</div>' : '') + '</div>' +
      '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" title="Email"></iframe></div>';
    document.body.appendChild(pop);
    pop.querySelector('iframe').srcdoc = '<base target="_blank">' + (m.html || '<pre style="white-space:pre-wrap;font:14px/1.5 Arial;padding:16px">' + esc(m.text || '') + '</pre>');
    const close = () => { pop.remove(); document.removeEventListener('keydown', key); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    pop.onclick = (e) => { if (e.target === pop) close(); };
    pop.querySelector('.x').onclick = close;
    document.addEventListener('keydown', key);
  }
  // An event line; a quote email gets a small envelope that opens it.
  function evtHtml(t, evClass, mailFor) {
    const k = mailFor ? mailFor(t) : null;
    return '<div class="tk-evt' + evClass(t.content) + '">' + esc(t.content) +
      (k ? ' <button type="button" class="tk-evmail" data-evmail="' + esc(k) + '" title="Show the email" aria-label="Show the email">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></button>' : '') + '</div>';
  }
  function turnsHtml(turns, evClass, mailFor) {
    return turns.map(t => {
      if (t.role === 'event') return evtHtml(t, evClass, mailFor);
      const used = (t.tools || []).map(x => '<span title="' + esc(JSON.stringify(x.input || {})) + '">' + esc(x.tool) + (x.found && x.found !== 'ok' ? ': ' + esc(x.found) : '') + '</span>').join('');
      return '<div class="tk-say ' + (t.role === 'caller' ? 'caller' : 'agent') + '"><div class="who">' + (t.role === 'caller' ? 'Caller' : 'NovaAI') +
        '<small>' + esc(new Date(toDate(t.created_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })) + '</small></div><div class="b">' + esc(t.content || '…') + '</div></div>' +
        (used ? '<div class="tk-used">' + used + '</div>' : '');
    }).join('');
  }
  // Playback speed for call recordings: 1× to 2×, remembered per browser (also keys: [ slower, ] faster).
  const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
  const getRate = () => { let r = 1; try { r = parseFloat(localStorage.getItem('tk-rate')) || 1; } catch (e) {} return SPEEDS.indexOf(r) > -1 ? r : 1; };
  function wireSpeed(box) {
    const a = box.querySelector('audio'); if (!a) return;
    const set = (r) => {
      a.playbackRate = r; a.preservesPitch = true;
      box.querySelectorAll('.tk-speed button').forEach(b => { const on = parseFloat(b.dataset.rate) === r; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      try { localStorage.setItem('tk-rate', String(r)); } catch (e) {}
    };
    box.querySelectorAll('.tk-speed button').forEach(b => { b.onclick = () => set(parseFloat(b.dataset.rate)); });
    a.addEventListener('loadedmetadata', () => { a.playbackRate = getRate(); });
    a.addEventListener('keydown', (e) => {
      const i = SPEEDS.indexOf(getRate());
      if (e.key === ']' && i < SPEEDS.length - 1) set(SPEEDS[i + 1]);
      if (e.key === '[' && i > 0) set(SPEEDS[i - 1]);
    });
    set(getRate());
  }
  // The recording needs the sign-in header, so it is fetched and played from memory.
  async function loadAudio(id) {
    const box = $('callAudio'); if (!box) return;
    try {
      const r = await fetch('/api/admin/talk/audio/' + id, { headers: { 'Authorization': 'Bearer ' + token } });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(r.status === 404 && t ? t : ''); }
      const b = await r.blob();
      if (current !== id || !$('callAudio')) return;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(b);
      box.innerHTML = '<audio controls preload="metadata" src="' + audioUrl + '"></audio>' +
        '<span class="tk-speed" role="group" aria-label="Playback speed">' + SPEEDS.map(r => '<button type="button" data-rate="' + r + '">' + r + '\u00d7</button>').join('') + '</span>' +
        '<a class="tk-link" href="' + audioUrl + '" download="call-' + id + '.mp3">Download</a>';
      wireSpeed(box);
    } catch (e) { if ($('callAudio')) $('callAudio').innerHTML = '<span class="tk-msg">' + esc(e.message || 'The recording could not be loaded.') + '</span>'; }
  }

  // ---- Try it ----
  const tryState = { callId: null, msgs: [], busy: false };
  async function newTry() {
    tryState.callId = null; tryState.msgs = []; tryState.busy = true;
    paintTry('<div class="tk-empty">Starting a test call\u2026</div>');
    const j = await api('/api/admin/talk/try/start', { method: 'POST', body: JSON.stringify({ from: $('tryFrom').value.trim(), line_id: $('tryLine').value, hours: $('tryHours').value, lang: $('tryLang').value }) }).catch(() => ({}));
    tryState.busy = false;
    tryState.callId = j.call_id || null;
    tryState.msgs.push({ role: 'assistant', content: j.greeting || (ov && ov.settings ? ov.settings.greeting : 'Hi! How can I help?'),
      note: [j.line, j.language, j.hours === 'after' ? 'After hours' : j.hours === 'missed' ? 'Missed call' : 'Regular hours', j.returning ? 'Talked to NovaAI before' : null, j.recognised ? 'Recognised by the number as ' + j.recognised : ($('tryFrom').value.trim() ? 'That number is not on a customer account' : null)].filter(Boolean).join(' \u00b7 ') });
    paintTry();
    $('tryInput').focus();
  }
  function paintTry(extra) {
    $('tryLog').innerHTML = tryState.msgs.map(m => m.role === 'note' ? '<div class="tk-evt">' + esc(m.note) + '</div>' : '<div class="tk-say ' + (m.role === 'user' ? 'caller' : 'agent') + '"><div class="who">' + (m.role === 'user' ? 'Caller' : 'NovaAI') + '</div>' +
      '<div class="b">' + esc(m.content) + '</div></div>' + (m.tools && m.tools.length ? '<div class="tk-used">' + m.tools.map(x => '<span title="' + esc(JSON.stringify(x.input || {})) + '">' +
        esc(x.tool) + (x.found && x.found !== 'ok' ? ': ' + esc(x.found) : '') + '</span>').join('') + '</div>' : '') +
      (m.note ? '<div class="tk-evt">' + esc(m.note) + '</div>' : '')).join('') + (extra || '');
    $('tryLog').scrollTop = $('tryLog').scrollHeight;
  }
  // Nothing runs until "Start test call" (or the first message) — opening the tab or changing a setting never starts a call.
  function paintTryIdle() {
    $('tryLog').innerHTML = '<div class="tk-tryidle"><b>No test call running</b><span>Pick who is calling, the line, the language and the time of day, then start the call. ' +
      'Typing a first message starts it too.</span><button type="button" class="tk-btn" id="tryStartBig">Start test call</button></div>';
    $('tryStartBig').onclick = newTry;
  }
  $('tryNew').onclick = newTry;
  // A different caller, line, language or time of day applies to the NEXT test call.
  ['tryFrom', 'tryLine', 'tryHours', 'tryLang'].forEach(id => {
    $(id).onchange = () => {
      if (!tryState.callId && !tryState.msgs.length) return;
      if (tryState.msgs.length && !tryState.msgs[tryState.msgs.length - 1].changed) {
        tryState.msgs.push({ role: 'note', changed: true, note: 'Settings changed \u2014 click Start a new test call to use them.' });
        paintTry();
      }
    };
  });
  $('tryForm').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('tryInput').value.trim();
    if (!t || tryState.busy) return;
    if (!tryState.callId) await newTry();                     // the first message starts the call
    tryState.busy = true; $('trySend').disabled = true; $('tryInput').value = '';
    tryState.msgs.push({ role: 'user', content: t });
    paintTry('<div class="tk-say agent"><div class="who">NovaAI</div><div class="b">…</div></div>');
    try {
      const j = await api('/api/admin/talk/try', { method: 'POST', body: JSON.stringify({ call_id: tryState.callId, from: $('tryFrom').value.trim(),
        messages: tryState.msgs.filter(m => m.role !== 'note').map(m => ({ role: m.role, content: m.content })) }) });
      if (!j.ok) throw new Error(j.error || 'No answer.');
      tryState.callId = j.call_id;
      tryState.msgs.push({ role: 'assistant', content: j.reply || '(no words)', tools: j.tools,
        note: j.ended ? 'NovaAI ended the call.' : j.transfer || null });
    } catch (err) {
      tryState.msgs.push({ role: 'assistant', content: '⚠ ' + err.message });
    }
    tryState.busy = false; $('trySend').disabled = false;
    paintTry(); $('tryInput').focus();
  };

  // ---- Training ----
  // Opening hours + the Regular / After hours setups (who answers, greetings, rules for that time of day).
  const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  let callerId = 'carrier', modes = null, curMode = 'regular';
  document.querySelectorAll('#sMode button').forEach(b => { b.onclick = () => { if (modes) { modes[curMode].answer = b.dataset.m; paintChoices(); } }; });
  document.querySelectorAll('#sModeTabs button').forEach(b => { b.onclick = () => { keepMode(); curMode = b.dataset.k; paintMode(); }; });
  function paintChoices() {
    document.querySelectorAll('#sMode button').forEach(b => b.classList.toggle('on', !!modes && b.dataset.m === modes[curMode].answer));
  }
  function keepMode() {
    if (!modes) return;
    Object.assign(modes[curMode], { greeting: $('sGreeting').value, greeting_known: $('sGreetingKnown').value, greeting_returning: $('sGreetingReturning').value, rules: $('sModeRules').value });
  }
  function paintMode() {
    document.querySelectorAll('#sModeTabs button').forEach(b => b.classList.toggle('on', b.dataset.k === curMode));
    const md = modes[curMode];
    $('sGreeting').value = md.greeting || ''; $('sGreetingKnown').value = md.greeting_known || ''; $('sGreetingReturning').value = md.greeting_returning || ''; $('sModeRules').value = md.rules || '';
    document.querySelectorAll('.tk-mname').forEach(x => { x.textContent = curMode === 'after' ? 'after hours' : curMode === 'missed' ? 'missed calls' : 'regular hours'; });
    $('sMissedBox').hidden = curMode !== 'missed';
    paintLogic();
    paintChoices();
  }
  // What a call to this setup does, step by step, from the live settings (the tab you see is what callers get).
  let logicData = null;
  function paintLogic() {
    const box = $('sLogic'); if (!box || !logicData) return;
    const j = logicData, s = j.settings, h = j.hours_now || {}, cal = j.calendar || [];
    const main = j.number ? phone(j.number) : null, missed = $('sMissedNum').value.trim() || (s.missed_number ? phone(s.missed_number) : '');
    const transfer = s.transfer_number ? phone(s.transfer_number) : '', forward = s.forward_number ? phone(s.forward_number) : '';
    const notify = s.notify_to || 'the team', ring = j.ring_seconds || 20, nextClosed = cal[0];
    const scr = (t) => '<span class="scr">' + esc(t) + '</span>';
    const live = curMode === 'missed' ? false : curMode === (h.open ? 'regular' : 'after');
    document.querySelectorAll('#sModeTabs button').forEach(b => {
      const on = b.dataset.k !== 'missed' && b.dataset.k === (h.open ? 'regular' : 'after');
      const d = b.querySelector('.dot'); if (on && !d) b.insertAdjacentHTML('beforeend', '<i class="dot" title="Answering the main number now"></i>'); else if (!on && d) d.remove();
    });
    const greetings = scr('Greeting') + ' for a new caller, ' + scr('Greeting for callers we know') + ' when the number is on a customer account' +
      ($('sReturningShort').checked ? ', and the ' + scr('Short greeting') + ' when they talked to NovaAI before' : '');
    const helps = 'Helps on the spot: prices from the website calculator (a price first, then questions), products, turnaround, ' +
      'closed days and order status \u2014 order details once the caller is recognised or verified. Can email the quote with Order now links.';
    const down = 'If the voice service is down: ' + (forward ? 'the call is forwarded to ' + scr(forward) + '.' : 'callers hear the ' + scr('Closed message') + '.');
    const hd = (cells) => '<div class="tk-flow-hd">' + cells.map(c => '<div><span>' + c[0] + '</span>' + c[1] + (c[2] ? '<small>' + c[2] + '</small>' : '') + '</div>').join('') + '</div>';
    const mainLine = $('sMainLine').value.trim() || (s.main_line ? phone(s.main_line) : '(747) 888-7777');
    const csr = $('sCsrTo').value.trim() || s.csr_to || '';
    const usage = (k) => { const n = (j.mode_counts || {})[k] || 0; return n + ' call' + (n === 1 ? '' : 's') + ' in the last 30 days'; };
    const after = 'After the call NovaAI writes an AI summary and emails it to the CSR team' + (csr ? ' (' + scr(csr.split(/\s*,\s*/).length + ' people') + ')' : ' \u2014 <b>no CSR emails set</b>') +
      ': \u201cno callback needed\u201d or \u201ccall back\u201d and why. <small>Dialpad still shows the call as missed; this is how the team knows NovaAI handled it' +
      (s.webhook_url ? ', and our CRM gets it through the webhook' : '') + '.</small>';
    let head, steps, alt = [];
    if (curMode === 'regular') {
      head = hd([['Clients call', '<b>' + esc(mainLine) + '</b>', 'Axiom main line (Dialpad)'],
        ['NovaAI answers on', main ? '<b>' + esc(main) + '</b>' : '<b class="none">TALKAI_NUMBER not set</b>', 'The TalkAi number'],
        ['When', '<b>Opening hours, as one of the team' + (live ? '<span class="tk-live">Now</span>' : '') + '</b>', esc(h.week || '') + ' \u00b7 ' + usage('regular')]]);
      steps = [
        'A client calls the Axiom main line ' + scr(mainLine) + ' during opening hours. Dialpad rings the CSR team.',
        'NovaAI on ' + scr(main || 'the TalkAi number') + ' can pick up as one more member of that ring group \u2014 sharing the load with the team (for example every 5th call). <small>Turned on in Dialpad by adding this number to the ring group; not in use until you do. ' + usage('regular') + '.</small>',
        '<span>Clients of an account manager with their own NovaAI line (\u201ctheir clients on the main line\u201d, ring first) ring that manager for ' + ring + ' seconds first \u2014 they press 1 to take it; NovaAI picks up if they don\u2019t.</span><small>Set per manager under Account managers.</small>',
        'NovaAI answers: ' + greetings + '.',
        helps,
        'Wants a person: ' + (transfer ? 'NovaAI transfers the call to ' + scr(transfer) + ' (Transfer to).' : 'no Transfer to number is set, so NovaAI takes a message.') + ' Messages are emailed to ' + scr(notify) + '.',
        after,
        down
      ];
      alt = [1, 2];
    } else if (curMode === 'missed') {
      head = hd([['Clients call', '<b>' + esc(mainLine) + '</b>', 'Axiom main line (Dialpad)'],
        ['NovaAI answers on', missed ? '<b>' + esc(missed) + '</b>' : '<b class="none">Not set yet</b>', 'Missed-call number \u2014 used only for this'],
        ['When', '<b>The team didn\u2019t pick up</b>', 'Dialpad passes the call on after 20 seconds \u00b7 ' + usage('missed')]]);
      steps = [
        'A client calls the Axiom main line ' + scr(mainLine) + ' during opening hours and nobody on the team picks up within 20 seconds.',
        'Dialpad transfers the call to ' + scr(missed || 'the missed-call number') + '. This number exists only for that, so every call it gets is a call the team missed.',
        'NovaAI answers straight away and apologises for the wait: ' + greetings + '.',
        helps,
        'Wants a person (artwork, order changes, a complaint): NovaAI takes a message \u2014 name, callback number and what it is about \u2014 emailed to ' + scr(notify) + ', and says the team will call back today.<small>It never transfers back: the team just couldn\u2019t pick up.</small>',
        after,
        down
      ];
    } else {
      head = hd([['Clients call', '<b>' + esc(mainLine) + '</b>', 'Axiom main line (Dialpad)'],
        ['NovaAI answers on', main ? '<b>' + esc(main) + '</b>' : '<b class="none">TALKAI_NUMBER not set</b>', 'The TalkAi number'],
        ['When', '<b>Outside opening hours' + (live ? '<span class="tk-live">Now</span>' : '') + '</b>', 'Evenings, closed days' + (nextClosed ? ' (next: ' + esc(nextClosed.name) + ', ' + esc(new Date(nextClosed.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) + ')' : '') + ' \u00b7 ' + usage('after')]]);
      steps = [
        'A client calls the Axiom main line ' + scr(mainLine) + ' while we are closed.',
        'Dialpad routes the call to ' + scr(main || 'the TalkAi number') + '. NovaAI checks the time in Los Angeles and the closed-days calendar, sees we are closed, and uses this After Hours setup.',
        'NovaAI answers and says the team is out: ' + greetings + '.',
        helps,
        'Wants a person: NovaAI says when we open again' + (!h.open && h.next ? ' (right now: ' + esc(h.next) + ')' : '') + ' and takes a message for the team, emailed to ' + scr(notify) + '.<small>No transfers after hours.</small>',
        after,
        down
      ];
    }
    // The steps fold away (remembered per browser); the number / when header stays in view.
    let open = false;
    try { open = localStorage.getItem('tk-steps-open') === '1'; } catch (e) {}
    box.innerHTML = head + '<button type="button" class="tk-steps-tg" aria-expanded="' + open + '"><span>How a call goes \u00b7 ' + steps.length + ' steps</span>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' +
      '<ol class="tk-steps"' + (open ? '' : ' hidden') + '>' + steps.map((t, i) => '<li' + (alt.indexOf(i) > -1 ? ' class="alt"' : '') + '>' + t + '</li>').join('') + '</ol>';
    const tg = box.querySelector('.tk-steps-tg');
    tg.onclick = () => {
      const ol = box.querySelector('.tk-steps'), on = ol.hidden;
      ol.hidden = !on; tg.setAttribute('aria-expanded', on ? 'true' : 'false');
      try { localStorage.setItem('tk-steps-open', on ? '1' : '0'); } catch (e) {}
    };
  }
  $('sMissedNum').addEventListener('input', () => paintLogic());
  ['sMainLine', 'sCsrTo', 'sTransfer'].forEach(id => $(id).addEventListener('input', () => paintLogic()));
  $('sHookDoc').onclick = async (e) => {
    e.preventDefault();
    const id = logicData && logicData.latest_call;
    if (!id) return alert('No answered phone call yet to show as an example. The full description is in docs/TALKAI_CRM_WEBHOOK.md.');
    const j = await api('/api/admin/talk/calls/' + id + '/handoff');
    if (!j.ok) return alert(j.error || 'Could not build it.');
    showJson('What the CRM webhook sends (latest call, #' + id + ')', j.payload);
  };
  $('sReturningShort').addEventListener('change', () => paintLogic());
  function paintHours(h) {
    $('sHours').innerHTML = DAYS.map(([k, label]) => {
      const d = h.days[k];
      return '<label><input type="checkbox" data-day="' + k + '"' + (d.open ? ' checked' : '') + '> ' + label + '</label>' +
        '<span class="' + (d.open ? '' : 'closed') + '" data-st="' + k + '">' + (d.open ? 'Open' : 'Closed') + '</span>' +
        '<span class="t"><input type="time" data-from="' + k + '" value="' + esc(d.from) + '"' + (d.open ? '' : ' disabled') + '> to ' +
        '<input type="time" data-to="' + k + '" value="' + esc(d.to) + '"' + (d.open ? '' : ' disabled') + '></span>';
    }).join('');
    $('sHours').querySelectorAll('input[data-day]').forEach(cb => {
      cb.onchange = () => {
        const k = cb.dataset.day, on = cb.checked;
        $('sHours').querySelector('[data-from="' + k + '"]').disabled = !on; $('sHours').querySelector('[data-to="' + k + '"]').disabled = !on;
        const st = $('sHours').querySelector('[data-st="' + k + '"]'); st.textContent = on ? 'Open' : 'Closed'; st.className = on ? '' : 'closed';
      };
    });
    $('sClosedDays').value = (h.closed || []).join('\n');
  }
  function readHours() {
    const days = {};
    DAYS.forEach(([k]) => {
      days[k] = { open: $('sHours').querySelector('[data-day="' + k + '"]').checked,
        from: $('sHours').querySelector('[data-from="' + k + '"]').value, to: $('sHours').querySelector('[data-to="' + k + '"]').value };
    });
    return { days: days, closed: $('sClosedDays').value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean) };
  }
  // The shop calendar (production \`holidays\`): read here, edited on the website.
  function paintCalendar(j) {
    const box = $('sCalendar'); if (!box) return;
    const st = j.calendar_status || {}, list = j.calendar || [];
    if (!list.length) { box.innerHTML = '<div class="tk-empty" style="padding:8px 0;text-align:left">' + (st.ok ? 'No closed days in the next 12 months.' : 'The calendar could not be read' + (st.error ? ' (' + esc(st.error) + ')' : '') + ' \u2014 the built-in holiday list is used until it can.') + '</div>'; return; }
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })); today.setHours(12, 0, 0, 0);
    box.innerHTML = list.map(x => {
      const d = new Date(x.date + 'T12:00:00'), n = Math.round((d - today) / 86400000);
      return '<div class="tk-cal-row' + (n === 0 ? ' today' : '') + '"><span class="d">' + esc(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })) + '</span>' +
        '<span class="n">' + esc(x.name) + '</span>' + (x.repeats ? '<span class="y">Every year</span>' : '') +
        '<span class="in">' + (n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days') + '</span></div>';
    }).join('');
  }
  // Accordion cards (Opening hours, Languages): open / closed remembered per browser.
  function accordion(card, toggle, body, key) {
    const set = (on) => {
      $(card).classList.toggle('open', on); $(body).hidden = !on; $(toggle).setAttribute('aria-expanded', on ? 'true' : 'false');
      try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) {}
    };
    $(toggle).onclick = () => set($(body).hidden);
    try { if (localStorage.getItem(key) === '1') set(true); } catch (e) {}
  }
  accordion('hoursCard', 'hoursToggle', 'hoursBody', 'tk-hours-open');
  accordion('langCard', 'langToggle', 'langBody', 'tk-langs-open');
  document.querySelectorAll('#sHoursTabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#sHoursTabs button').forEach(x => x.classList.toggle('on', x === b));
      document.querySelectorAll('#hoursBody [data-hp]').forEach(p => { p.hidden = p.dataset.hp !== b.dataset.h; });
    };
  });
  function paintNow(j) {
    const h = j.hours_now || {};
    paintCalendar(j);
    $('sCalCount').textContent = (j.calendar || []).length || '';
    $('sNowShort').innerHTML = (h.open ? '<b class="reg">Open</b> until ' + esc(h.closes) : '<b class="aft">Closed</b>' + (h.closed_today ? ' today (' + esc(h.closed_today) + ')' : '') +
      (h.next ? ' \u00b7 opens ' + esc(h.next) : '')) + (h.week ? ' \u00b7 ' + esc(h.week) : '');
    $('sNow').innerHTML = 'Right now: ' + (h.open ? '<b class="reg">Regular hours</b> — open until ' + esc(h.closes) : '<b class="aft">After hours</b>' +
      (h.closed_today ? ' — closed today (' + esc(h.closed_today) + ')' : '') + (h.next ? ' — opens ' + esc(h.next) : '')) + '<br><small style="color:var(--muted)">' + esc(h.week || '') + '</small>';
    document.querySelectorAll('.tk-ring').forEach(x => { x.textContent = j.ring_seconds || 20; });
  }
  let langState = null;
  function paintLangs(j) {
    const s = j.settings, all = j.langs || [];
    langState = { on: s.languages.slice(), greet: Object.assign({}, s.lang_greetings) };
    const draw = () => {
      $('sLangShort').textContent = all.filter(l => langState.on.indexOf(l.code) > -1).map(l => l.name).join(', ') + ' \u00b7 follows the caller\u2019s language';
      $('sLangs').innerHTML = all.map(l => '<label class="' + (langState.on.indexOf(l.code) > -1 ? 'on' : '') + '"><input type="checkbox" data-lang="' + l.code + '"' +
        (langState.on.indexOf(l.code) > -1 ? ' checked' : '') + (l.code === 'en' ? ' disabled' : '') + '> ' + esc(l.name) + '</label>').join('');
      $('sLangGreets').innerHTML = all.filter(l => l.code !== 'en' && langState.on.indexOf(l.code) > -1).map(l =>
        '<label>Greeting in ' + esc(l.name) + ' <small style="font-weight:400">for callers who spoke it before ({name} = their first name)</small><textarea data-greet="' + l.code + '" rows="2">' + esc(langState.greet[l.code] || l.greeting) + '</textarea></label>').join('');
      $('sLangs').querySelectorAll('input[data-lang]').forEach(cb => { cb.onchange = () => { keepLangGreets(); const k = cb.dataset.lang;
        langState.on = cb.checked ? langState.on.concat([k]) : langState.on.filter(x => x !== k); draw(); }; });
    };
    draw();
  }
  function keepLangGreets() { if (langState) $('sLangGreets').querySelectorAll('textarea[data-greet]').forEach(t => { langState.greet[t.dataset.greet] = t.value; }); }
  async function paintTraining() {
    const j = ov || await loadOverview();
    if (!j) return;
    const s = j.settings;
    paintLangs(j);
    modes = JSON.parse(JSON.stringify(s.modes));
    logicData = j;
    paintHours(s.hours); paintNow(j); paintMode();
    $('sRules').value = s.rules || '';
    $('sTransfer').value = s.transfer_number ? phone(s.transfer_number) : '';
    $('sForward').value = s.forward_number ? phone(s.forward_number) : '';
    $('sNotify').value = s.notify_to || '';
    $('sBcc').value = s.email_bcc || '';
    $('sReturningShort').checked = !!s.returning_short;
    $('sMissedNum').value = s.missed_number ? phone(s.missed_number) : '';
    $('sMissedState').innerHTML = s.missed_number ? 'Calls to ' + esc(phone(s.missed_number)) + ' get this setup. Make sure it shows <b>Connected</b> under Account managers → Twilio numbers.'
      : 'No number yet: buy one in Twilio, connect it under Account managers → Twilio numbers, then enter it here.';
    $('sSummary').checked = !!s.summary_mail;
    $('sMainLine').value = s.main_line ? phone(s.main_line) : '';
    $('sCsrTo').value = s.csr_to || '';
    $('sHook').value = s.webhook_url || '';
    $('sHookState').innerHTML = s.webhook_secret ? '<b style="color:#166534">Secret set \u2713</b>' : '<b style="color:#b45309">Secret not in .env yet</b>';
    paintLogic();
    $('sClosed').value = s.closed_message || '';
    $('sMsg').textContent = ''; $('sMsg').className = 'tk-msg';
  }
  $('sSave').onclick = async () => {
    const m = $('sMsg'); m.className = 'tk-msg'; m.textContent = 'Saving…';
    keepMode(); keepLangGreets();
    Object.keys(modes || {}).forEach(k => { modes[k].answer = 'ai'; });     // every setup is NovaAI (no "Who answers" choice)
    const j = await api('/api/admin/talk/settings', { method: 'POST', body: JSON.stringify({ hours: readHours(), modes: modes, rules: $('sRules').value,
      languages: langState ? langState.on.filter(k => k !== 'en') : undefined, lang_greetings: langState ? langState.greet : undefined,
      transfer_number: $('sTransfer').value, forward_number: $('sForward').value, notify_to: $('sNotify').value, email_bcc: $('sBcc').value, returning_short: $('sReturningShort').checked, missed_number: $('sMissedNum').value, summary_mail: $('sSummary').checked,
      main_line: $('sMainLine').value, csr_to: $('sCsrTo').value, webhook_url: $('sHook').value,
      closed_message: $('sClosed').value }) });
    if (!j.ok) { m.className = 'tk-msg err'; m.textContent = j.error || 'Could not save.'; return; }
    const keep = curMode;
    await loadOverview(); await paintTraining(); curMode = keep; paintMode();
    m.textContent = 'Saved ✓ — the next call uses it.';
  };

  // ---- Account managers ----
  let managers = null, twNumbers = [], lines = [];
  async function loadAms() {
    const [l, mg, tn] = await Promise.all([api('/api/admin/talk/lines'), managers ? Promise.resolve({ ok: true, managers: managers }) : api('/api/admin/talk/managers'),
      api('/api/admin/talk/twilio/numbers').catch(() => ({}))]);
    lines = l.lines || []; managers = mg.managers || managers || []; twNumbers = tn.numbers || [];
    paintLines(); paintNumbers(tn.ok ? null : (tn.error || 'Could not reach Twilio.'));
    fillTryLines();
  }
  function paintLines() {
    $('amList').innerHTML = lines.length ? lines.map(l => {
      const tags = [];
      if (l.number) tags.push('<span class="tk-chip ok">Own number ' + esc(phone(l.number)) + '</span>');
      if (Number(l.main_line)) tags.push('<span class="tk-chip">Their clients on the main line</span>');
      if (l.own_numbers && l.own_numbers.length) tags.push('<span class="tk-chip ok">Their assistant from ' + l.own_numbers.map(phone).map(esc).join(', ') + (l.has_pin ? ' · PIN' : '') + '</span>');
      if (Number(l.ring_first)) tags.push('<span class="tk-chip">Rings ' + esc(phone(l.ring_number)) + ' first' + (Number(l.screen) !== 0 ? ' · press 1' : '') + '</span>');
      if (l.voice_id) tags.push('<span class="tk-chip">Own voice</span>');
      if (!l.number && !Number(l.main_line)) tags.push('<span class="tk-chip warn">Not answering yet — give it a number or tick "their clients"</span>');
      return '<div class="tk-am' + (Number(l.active) ? '' : ' off') + '">' + avatar(l.photo, l.am_name) + '<div class="bd">' +
        '<b>' + esc(l.am_name || 'Account manager') + '</b> <small>' + esc(l.am_title || '') + (l.calls ? ' · ' + l.calls + ' call' + (l.calls === 1 ? '' : 's') : '') + '</small>' +
        '<div class="tags">' + tags.join('') + '</div>' +
        (l.training ? '<div style="margin-top:6px;color:var(--ink-soft);font-size:12.5px;white-space:pre-wrap">' + esc(String(l.training).slice(0, 220)) + (l.training.length > 220 ? '…' : '') + '</div>' : '') +
        '</div><button type="button" class="tk-btn ghost" data-edit="' + l.id + '">Edit</button></div>';
    }).join('') : '<div class="tk-empty" style="padding:14px">No account managers set up yet.</div>';
    $('amList').querySelectorAll('[data-edit]').forEach(b => { b.onclick = () => editLine(lines.find(x => x.id === parseInt(b.dataset.edit))); });
  }
  function paintNumbers(err) {
    if (err) { $('twNums').innerHTML = '<div class="tk-msg err">' + esc(err) + '</div>'; return; }
    $('twNums').innerHTML = twNumbers.length ? twNumbers.map(n => '<div class="tk-num"><div class="n"><b>' + esc(phone(n.number)) + '</b>' +
      '<small>' + esc(n.main ? 'Main TalkAi number' : n.missed ? 'Business hours missed calls' : n.line ? n.line + '’s line' : (n.name && n.name !== n.number ? n.name : 'Not used by TalkAi')) + '</small></div>' +
      (n.connected ? '<span class="tk-chip ok">Connected</span>' : '<button type="button" class="tk-btn ghost" data-connect="' + esc(n.sid) + '">Connect to Nova</button>') + '</div>').join('')
      : '<div class="tk-empty" style="padding:10px">No numbers in the Twilio account.</div>';
    $('twNums').querySelectorAll('[data-connect]').forEach(b => {
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'Connecting…';
        const j = await api('/api/admin/talk/twilio/numbers/' + b.dataset.connect + '/connect', { method: 'POST', body: '{}' });
        if (!j.ok) { b.disabled = false; b.textContent = 'Connect to Nova'; alert(j.error || 'Could not connect it.'); return; }
        loadAms();
      };
    });
  }
  // A person's CRM photo, with their initial underneath (shown when there is no photo or it fails to load).
  function avatar(photo, name) {
    return '<span class="tk-av">' + esc(String(name || '?').trim().charAt(0).toUpperCase() || '?') +
      (photo ? '<img src="' + esc(photo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</span>';
  }
  // The account manager picker: photo, name and client count (a native select can't show pictures).
  function personRow(m) {
    return avatar(m.photo, m.name) + '<span class="who"><span class="nm">' + esc(m.name) + ' <span class="ct">' + Number(m.clients || 0).toLocaleString('en-US') + ' clients</span></span>' +
      (m.title ? '<span class="ti">' + esc(m.title) + '</span>' : '') + '</span>';
  }
  function amPicker(box, current, onPick) {
    const wrap = box.querySelector('#amPick'), btn = wrap.querySelector('.tk-pickbtn'), list = wrap.querySelector('.tk-picklist'),
      search = wrap.querySelector('.tk-picksearch'), opts = wrap.querySelector('.tk-pickopts');
    let shown = [], hl = 0;
    const paintBtn = () => {
      const m = (managers || []).find(x => x.id === parseInt($('amWho').value));
      btn.innerHTML = (m ? personRow(m) : '<span class="who"><span class="ti" style="font-size:13px">Pick one…</span></span>') + '<span class="chev">▾</span>';
    };
    const paintList = () => {
      const q = search.value.trim().toLowerCase();
      shown = (managers || []).filter(m => !q || (m.name + ' ' + (m.title || '') + ' ' + (m.email || '')).toLowerCase().indexOf(q) > -1);
      hl = Math.min(hl, Math.max(shown.length - 1, 0));
      opts.innerHTML = shown.length ? shown.map((m, i) => '<button type="button" class="tk-opt' + (m.id === parseInt($('amWho').value) ? ' on' : '') + (i === hl ? ' hl' : '') + '" data-i="' + i + '">' + personRow(m) + '</button>').join('')
        : '<div class="tk-empty" style="padding:10px">No one matches.</div>';
      opts.querySelectorAll('.tk-opt').forEach(b => { b.onclick = () => pick(shown[parseInt(b.dataset.i)]); });
    };
    const open = (on) => {
      list.hidden = !on; btn.classList.toggle('open', on);
      if (on) { search.value = ''; hl = Math.max(shown.findIndex(m => m.id === parseInt($('amWho').value)), 0); paintList(); search.focus();
        const cur = opts.querySelector('.tk-opt.on'); if (cur) cur.scrollIntoView({ block: 'nearest' }); }
    };
    const pick = (m) => { if (!m) return; $('amWho').value = m.id; paintBtn(); open(false); btn.focus(); onPick(m); };
    btn.onclick = () => open(list.hidden);
    search.oninput = () => { hl = 0; paintList(); };
    search.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(0, Math.min(shown.length - 1, hl + (e.key === 'ArrowDown' ? 1 : -1))); paintList();
        const h = opts.querySelector('.tk-opt.hl'); if (h) h.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(shown[hl]); }
      else if (e.key === 'Escape') { open(false); btn.focus(); }
    };
    document.addEventListener('mousedown', function away(e) {
      if (!document.body.contains(wrap)) { document.removeEventListener('mousedown', away); return; }
      if (!list.hidden && !wrap.contains(e.target)) open(false);
    });
    $('amWho').value = current || '';
    paintBtn();
  }
  function editLine(l) {
    l = l || { main_line: 1, active: 1, screen: 1, own_numbers: [] };
    const box = $('amEdit');
    const used = lines.filter(x => x.id !== l.id).map(x => x.number).filter(Boolean);
    const numOpts = '<option value="">None — their clients on the main line only</option>' + twNumbers.filter(n => !n.main && !n.missed && (used.indexOf(n.number) === -1 || n.number === l.number))
      .map(n => '<option value="' + esc(n.number) + '"' + (l.number === n.number ? ' selected' : '') + '>' + esc(phone(n.number)) + (n.connected ? '' : ' (not connected yet)') + '</option>').join('') +
      (l.number && !twNumbers.some(n => n.number === l.number) ? '<option value="' + esc(l.number) + '" selected>' + esc(phone(l.number)) + '</option>' : '');
    const own = (l.own_numbers || []).concat(['', '', '']).slice(0, 3);
    const sec = (n, title, sub) => '<div class="tk-amsec"><div class="tk-sech"><i>' + n + '</i><div><b>' + title + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div></div>';
    box.hidden = false;
    box.innerHTML = '<h3>' + (l.id ? 'Edit ' + esc(l.am_name) : 'Add an account manager') + '</h3><div class="tk-form">' +
      sec(1, 'The person', 'Who this NovaAI works for.') +
        '<div class="tk-flabel">Account manager<div class="tk-pick" id="amPick"><input type="hidden" id="amWho">' +
          '<button type="button" class="tk-pickbtn" aria-haspopup="listbox"></button>' +
          '<div class="tk-picklist" hidden><input type="text" class="tk-picksearch" placeholder="Search by name or title" autocomplete="off"><div class="tk-pickopts" role="listbox"></div></div></div></div>' +
        '<label>Their email <small>Messages, call summaries and anything they ask NovaAI to email them.</small><input type="text" id="amNotify" value="' + esc(l.notify_to || '') + '" placeholder="their email"></label></div>' +
      sec(2, 'Their NovaAI number', 'A Twilio number that always answers for them. Give it to clients, or forward their missed calls to it.') +
        '<label>Twilio number<select id="amNum" class="tk-select">' + numOpts + '</select></label>' +
        '<label class="chk"><input type="checkbox" id="amMain"' + (Number(l.main_line) ? ' checked' : '') + '> <span>Their clients on the main line too <small style="display:block;color:var(--muted)">A caller recognised by their number whose account manager this is gets this NovaAI.</small></span></label></div>' +
      sec(3, 'Their phones — NovaAI is their assistant', 'When they call their NovaAI number (or the main number) from one of these, NovaAI answers as their personal assistant: their missed calls and messages, client and job look-ups, prices, notes emailed to them.') +
        '<div class="row3">' + own.map((n, i) => '<input type="text" class="amOwn" value="' + esc(n ? phone(n) : '') + '" placeholder="' + (i === 0 ? 'Cell, e.g. 818 555 1234' : i === 1 ? 'Another phone' : 'Another phone') + '">').join('') + '</div>' +
        '<div class="row2"><label>PIN <small>' + (l.has_pin ? 'A PIN is set. Type a new one to change it.' : 'Optional, 4–8 digits, typed on the keypad.') + '</small>' +
          '<input type="password" id="amPin" inputmode="numeric" autocomplete="new-password" maxlength="8" placeholder="' + (l.has_pin ? '••••  (unchanged)' : 'e.g. 482915') + '"></label>' +
          '<label>Greeting for them <small>{am} = their first name, {new} = “You have 2 new calls.”</small><input type="text" id="amOwnerGreet" value="' + esc(l.owner_greeting || '') + '" placeholder="Hi {am}! {new}How can I help today?"></label></div>' +
        '<label class="chk"><input type="checkbox" id="amPinAlways"' + (Number(l.owner_pin_always) ? ' checked' : '') + '> <span>Ask for the PIN on every call <small style="display:block;color:var(--muted)">Otherwise only when their carrier can’t confirm the number is really theirs. Without a PIN, an unconfirmed call is treated as an ordinary caller.</small></span></label>' +
        (l.has_pin ? '<label class="chk"><input type="checkbox" id="amPinClear"> <span>Remove the PIN</span></label>' : '') + '</div>' +
      sec(4, 'When they miss a call', 'Instead of voicemail, NovaAI greets the caller, tries to help, and takes a message for them.') +
        '<label class="chk"><input type="checkbox" id="amRingFirst"' + (Number(l.ring_first) ? ' checked' : '') + '> <span>Ring their phone first during regular hours <small style="display:block;color:var(--muted)">NovaAI answers if they don’t take it within <span class="tk-ring">' + ((ov && ov.ring_seconds) || 20) + '</span> seconds. Leave it off if their own phone (e.g. Dialpad) already forwards missed calls to this NovaAI number.</small></span></label>' +
        '<div class="row2"><label>Phone to ring <small>Also where transfers go.</small><input type="text" id="amRing" value="' + esc(l.ring_number ? phone(l.ring_number) : '') + '" placeholder="e.g. 747 400 4060"></label>' +
          '<label class="chk" style="align-self:end"><input type="checkbox" id="amScreen"' + (Number(l.screen) !== 0 ? ' checked' : '') + '> <span>“Press 1 to take it” <small style="display:block;color:var(--muted)">So their voicemail can’t pick up instead of NovaAI.</small></span></label></div>' +
        '<label>Greeting for callers <small>Optional. {name} = the caller’s first name, {am} = theirs.</small>' +
          '<textarea id="amGreeting" rows="2" placeholder="Hi {name}, {am} can’t come to the phone right now. I’m NovaAI, an AI assistant, and this call is recorded. How can I help you?">' + esc(l.greeting || '') + '</textarea></label></div>' +
      sec(5, 'Their training', 'How they like things handled. NovaAI follows it with their clients and when it works for them.') +
        '<textarea id="amTraining" rows="6" placeholder="- Most of my clients are restaurants: menus, table tents, banners.\n- Rush jobs: always take a message, I call back within the hour.\n- Say I’m in the office Mon–Thu.">' + esc(l.training || '') + '</textarea>' +
        '<label>Voice ID <small>Optional: an ElevenLabs voice ID for this line.</small><input type="text" id="amVoice" value="' + esc(l.voice_id || '') + '"></label></div>' +
      '<label class="chk"><input type="checkbox" id="amActive"' + (Number(l.active) || !l.id ? ' checked' : '') + '> <span>On</span></label>' +
      '<div class="acts"><button type="button" class="tk-btn" id="amSave">Save</button><button type="button" class="tk-btn ghost" id="amCancel">Cancel</button>' +
        '<span class="tk-msg" id="amMsg"></span>' + (l.id ? '<button type="button" class="del" id="amDel">Remove</button>' : '') + '</div></div>';
    amPicker(box, l.am_user_id || '', (m) => {
      if (!$('amRing').value && m.phone) $('amRing').value = phone(m.phone);
      if (!$('amNotify').value) $('amNotify').value = m.email || '';
      const first = box.querySelector('.amOwn');
      if (first && !first.value && m.cell) first.value = phone(m.cell);
    });
    $('amCancel').onclick = () => { box.hidden = true; };
    if ($('amDel')) $('amDel').onclick = async () => {
      if (!confirm('Remove ' + l.am_name + '’s NovaAI line? Past calls stay.')) return;
      await api('/api/admin/talk/lines/' + l.id, { method: 'DELETE' }); box.hidden = true; loadAms();
    };
    $('amSave').onclick = async () => {
      const msg = $('amMsg'); msg.className = 'tk-msg'; msg.textContent = 'Saving…';
      const j = await api('/api/admin/talk/lines', { method: 'POST', body: JSON.stringify({ id: l.id, am_user_id: $('amWho').value, number: $('amNum').value,
        main_line: $('amMain').checked, ring_first: $('amRingFirst').checked, ring_number: $('amRing').value, notify_to: $('amNotify').value, screen: $('amScreen').checked,
        own_numbers: Array.from(box.querySelectorAll('.amOwn')).map(x => x.value.trim()).filter(Boolean), pin: $('amPin').value.trim(),
        pin_always: $('amPinAlways').checked, clear_pin: $('amPinClear') ? $('amPinClear').checked : false, owner_greeting: $('amOwnerGreet').value,
        greeting: $('amGreeting').value, training: $('amTraining').value, voice_id: $('amVoice').value, active: $('amActive').checked }) });
      if (!j.ok) { msg.className = 'tk-msg err'; msg.textContent = j.error || 'Could not save.'; return; }
      box.hidden = true; loadAms();
    };
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('amAdd').onclick = () => editLine(null);
  function fillTryLines() {
    const sel = $('tryLine'), keep = sel.value;
    const ownTip = lines.filter(l => Number(l.active) && l.own_numbers && l.own_numbers.length).map(l => phone(l.own_numbers[0]) + ' = ' + l.am_name);
    $('tryOwnTip').textContent = ownTip.length ? 'Type an account manager’s phone to try their assistant: ' + ownTip.join(', ') + '.' : '';
    sel.innerHTML = '<option value="">Main number</option><option value="auto">Main number — their account manager’s NovaAI if they have one</option>' +
      lines.filter(l => Number(l.active)).map(l => '<option value="' + l.id + '">' + esc(l.am_name) + '’s line' + (l.number ? ' (' + esc(phone(l.number)) + ')' : '') + '</option>').join('');
    sel.value = keep;
  }

  // ---- Setup ----
  const copyRow = (label, value, multi) => '<div class="tk-copy">' + (label ? '<span class="l">' + esc(label) + '</span>' : '') +
    (multi ? '<pre>' + esc(value) + '</pre>' : '<code>' + esc(value) + '</code>') + '<button type="button" data-copy="' + esc(value) + '">Copy</button></div>';
  function paintSetup() {
    const j = ov; if (!j) return;
    const k = j.keys, u = j.urls, s = j.settings;
    const ok = (b) => '<b class="' + (b ? 'y' : 'n') + '">' + (b ? '✓' : '✗') + '</b>';
    const done = (b) => '<i class="' + (b ? 'done' : '') + '">' + (b ? '✓' : '') + '</i>';
    const stub = 'You are NovaAI, AxiomPrint’s phone assistant. Nova sends the full instructions with every turn.\nnova_call={{nova_call}} conversation={{system__conversation_id}} caller={{system__caller_id}}';
    const envText = ['TWILIO_ACCOUNT_SID=AC…', 'TWILIO_AUTH_TOKEN=…', 'TALKAI_NUMBER=' + (j.number || '+17473500012'), 'ELEVENLABS_API_KEY=…',
      'ELEVENLABS_AGENT_ID=…', 'ELEVENLABS_WEBHOOK_SECRET=…', 'TALKAI_LLM_KEY=' + (k.TALKAI_LLM_KEY ? '(already set)' : '<a long random password — see below>')].join('\n');
    const twilioDone = k.TWILIO_AUTH_TOKEN && j.hits.some(h => h.kind === 'twilio-voice' && h.ok);
    const elDone = k.ELEVENLABS_API_KEY && k.ELEVENLABS_AGENT_ID && k.TALKAI_LLM_KEY && j.hits.some(h => h.kind === 'llm' && h.ok);
    const hookDone = k.ELEVENLABS_WEBHOOK_SECRET && j.hits.some(h => h.kind === 'elevenlabs-webhook' && h.ok);
    $('setupBox').innerHTML =
      '<h2>Connect the phone number</h2><p class="lead">Twilio carries the call, ElevenLabs listens and speaks, and Nova decides what to say — with the same tools, ' +
      'rules and knowledge as the website chat. Five steps; each one ticks itself once Nova sees it working.</p>' +

      '<div class="tk-step"><h3>' + done(k.TWILIO_AUTH_TOKEN && k.ELEVENLABS_API_KEY && k.ELEVENLABS_AGENT_ID && k.TALKAI_LLM_KEY && k.ELEVENLABS_WEBHOOK_SECRET) + '1. Keys in Nova’s .env</h3>' +
      '<div class="tk-keys">' +
      ok(k.TWILIO_ACCOUNT_SID) + '<span><code>TWILIO_ACCOUNT_SID</code> — Twilio Console home page, Account Info (starts with AC). Needed for transfers.</span>' +
      ok(k.TWILIO_AUTH_TOKEN) + '<span><code>TWILIO_AUTH_TOKEN</code> — same place. Nova uses it to check every call really comes from Twilio.</span>' +
      ok(!!j.number) + '<span><code>TALKAI_NUMBER</code> — the TalkAi number, e.g. +17473500012 (shown at the top of this page).</span>' +
      ok(k.ELEVENLABS_API_KEY) + '<span><code>ELEVENLABS_API_KEY</code> — ElevenLabs → Developers → API keys (allow Agents / Conversational AI).</span>' +
      ok(k.ELEVENLABS_AGENT_ID) + '<span><code>ELEVENLABS_AGENT_ID</code> — the agent you create in step 3 (its ID starts with agent_).</span>' +
      ok(k.ELEVENLABS_WEBHOOK_SECRET) + '<span><code>ELEVENLABS_WEBHOOK_SECRET</code> — shown when you add the webhook in step 4.</span>' +
      ok(k.TALKAI_LLM_KEY) + '<span><code>TALKAI_LLM_KEY</code> — a password you make up; ElevenLabs sends it so only it can ask Nova what to say.</span>' +
      ok(k.email) + '<span>Email sending (Gmail, the same as past-due escalations) — for messages and call summaries.</span></div>' +
      '<p style="margin:10px 0 4px">Add the missing lines to <code>/opt/axiom-ai/.env</code>, then run <code>pm2 restart axiom-ai</code>:</p>' +
      copyRow('', envText, true) +
      '<p style="margin:8px 0 4px">To make <code>TALKAI_LLM_KEY</code>, run this on the server and use what it prints:</p>' + copyRow('', 'openssl rand -hex 24') + '</div>' +

      '<div class="tk-step"><h3>' + done(twilioDone) + '2. Twilio: send calls to Nova</h3><ol>' +
      '<li>Twilio Console → Phone Numbers → Manage → Active numbers → <b>' + esc(phone(j.number) || '(747) 350-0012') + '</b> (or "Voice configuration → Set up" on the inventory page).</li>' +
      '<li>Under <b>Voice Configuration</b>: Configure with <b>Webhook</b>; <b>A call comes in</b> → Webhook, this URL, <b>HTTP POST</b>:' + copyRow('', u.voice) + '</li>' +
      '<li><b>Call status changes</b> → this URL, HTTP POST:' + copyRow('', u.status) + '</li>' +
      '<li>Primary handler fails: leave empty. Save configuration.</li></ol>' +
      '<p class="tk-msg" style="margin-top:6px">Texting stays off until the A2P 10DLC registration Twilio shows is done; calls do not need it.</p></div>' +

      '<div class="tk-step"><h3>' + done(elDone) + '3. ElevenLabs: create the voice agent</h3><ol>' +
      '<li>ElevenLabs → <b>Agents</b> (Conversational AI) → Create agent → Blank. Name it <b>NovaAI Phone</b>. Copy its Agent ID into <code>ELEVENLABS_AGENT_ID</code>.</li>' +
      '<li><b>System prompt</b> — only this (Nova sends the real instructions):' + copyRow('', stub, true) + '</li>' +
      '<li><b>First message</b>:' + copyRow('', '{{greeting}}') + '</li>' +
      '<li><b>Dynamic variables</b> (placeholders for test calls from the ElevenLabs page): <code>nova_call</code> = <code>0</code>, <code>greeting</code> =' + copyRow('', s.greeting) + '</li>' +
      '<li><b>LLM</b> → <b>Custom LLM</b>. Server URL:' + copyRow('', u.llm) + ' Model ID: <code>nova-talkai</code>. API key: add a secret with the same value as <code>TALKAI_LLM_KEY</code>.</li>' +
      '<li><b>Voice</b>: pick a warm voice. For English and Spanish the Flash / Turbo models are fastest; for Armenian use <b>Eleven v3 Conversational</b>. Turn on <b>interruptions</b>.</li>' +
      '<li><b>Languages</b> (Agent tab): default <b>English</b>; under <b>Additional languages</b> add <b>Spanish</b>, <b>Armenian</b> and <b>Russian</b>, and give each a voice that speaks it ' +
        '(for Armenian use an <b>Eleven v3</b> voice). Then <b>Security \u2192 Overrides</b>: turn on <b>Language</b> \u2014 Nova tells ElevenLabs which language the caller chose.</li>' +
      '<li><b>Tools → System tools</b>: turn on <b>End conversation</b> and <b>Detect language</b>. Leave "Transfer to number" off — Nova does transfers (Training → Transfer to).</li>' +
      '<li><b>Advanced → audio</b>: user input audio format <b>μ-law 8000 Hz</b> and TTS output format <b>μ-law 8000 Hz</b> (needed because Nova hands the call over from Twilio).</li>' +
      '<li>Leave the phone number out of ElevenLabs — Nova connects each call itself, so it can forward or play the closed message when needed.</li></ol></div>' +

      '<div class="tk-step"><h3>' + done(hookDone) + '4. ElevenLabs: transcript and recording back to Nova</h3><ol>' +
      '<li>ElevenLabs → Agents → <b>Settings</b> (workspace) → <b>Post-call webhook</b> → add this URL:' + copyRow('', u.webhook) + '</li>' +
      '<li>Turn on <b>transcription</b> and <b>audio</b> (the recording). Copy the webhook’s secret into <code>ELEVENLABS_WEBHOOK_SECRET</code>.</li></ol></div>' +

      '<div class="tk-step"><h3>' + done(j.hits.some(h => h.kind === 'llm' && h.ok) && twilioDone) + '5. Call it</h3>' +
      '<p style="margin:0">Call <b>' + esc(phone(j.number) || 'the number') + '</b>. You should hear the greeting, then NovaAI. The call shows up under Calls at once; the ' +
      'transcript, summary and recording a minute after you hang up. Try "How much are 500 business cards?", then an order status with an order number and the account’s email.</p>' +
      '<p class="tk-msg" style="margin:6px 0 0">Calls cost about $0.10 a minute (Twilio + ElevenLabs) plus Nova’s AI. Recordings are kept ' + esc(j.keep_days) + ' days.</p></div>' +

      '<div class="tk-step"><h3><i>↻</i>Recent activity <button type="button" class="tk-link" id="hitsRefresh" style="margin-left:auto">Refresh</button></h3>' +
      (j.hits.length ? '<table class="tk-hits">' + j.hits.map(h => '<tr><td>' + esc(new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })) + '</td><td>' + ok(h.ok) +
        ' <b>' + esc(h.kind) + '</b></td><td>' + esc(h.note) + '</td></tr>').join('') + '</table>'
        : '<p class="tk-msg" style="margin:0">Nothing yet since Nova last restarted. Each call, answer and webhook shows here, with what went wrong if it did.</p>') + '</div>';
    $('setupBox').querySelectorAll('[data-copy]').forEach(b => {
      b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); } catch (e) { b.textContent = 'Select it'; } };
    });
    $('hitsRefresh').onclick = () => loadOverview().then(paintSetup);
  }

  // The overview (calls by day / week / month and this month's outcomes) fills the right side until a call is picked.
  function showCallsOverview() {
    current = null;
    document.querySelectorAll('.tk-row.on').forEach(b => b.classList.remove('on'));
    $('callView').innerHTML = '<div id="talkStats"></div><div class="tk-empty" style="padding:4px 0">Pick a call on the left to see it.</div>';
    if (window.NovaStats) NovaStats.mount($('talkStats'), { url: '/api/admin/talk/stats', token: token, key: 'talk' });
  }
  $('callOverview').onclick = () => { $('vCalls').classList.remove('detail'); history.replaceState(null, '', '/talk-ai'); showCallsOverview(); };

  // ---- start ----
  loadOverview().then(() => {
    const id = parseInt(new URLSearchParams(location.search).get('call'));
    show('calls');
    if (id) openCall(id); else showCallsOverview();
  });
  setInterval(() => { if (!document.hidden && $('vCalls').classList.contains('on')) loadCalls(); }, 30000);
})();
