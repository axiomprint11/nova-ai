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
    if (v === 'try') { api('/api/admin/talk/lines').then(l => { lines = l.lines || []; fillTryLines(); }).catch(() => {}); if (!tryState.msgs.length) newTry(); }
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
    $('callRows').innerHTML = j.calls.map(c => {
      const match = c.caller_match && c.caller_match[0];
      const name = c.customer_name ? c.customer_name + (c.company ? ' · ' + c.company : '')
        : c.source === 'try' ? 'Test in text' + (c.tried_by ? ' · ' + String(c.tried_by).replace(/^member:|^user:/, '') : '')
        : c.source === 'elevenlabs' ? 'ElevenLabs test call'
        : phone(c.from_number) || 'Unknown number';
      const tags = [];
      if (c.verified) tags.push('<span class="tk-tag ok">' + (c.verified_by === 'caller_id' ? 'Recognised' : 'Verified') + '</span>');
      if (c.line_name) tags.push('<span class="tk-tag tr">' + esc(String(c.line_name).split(' ')[0]) + '\u2019s line</span>');
      if (c.hours_mode === 'after') tags.push('<span class="tk-tag">After hours</span>');
      if (c.source !== 'phone') tags.push('<span class="tk-tag test">Test</span>');
      if (c.outcome === 'message') tags.push('<span class="tk-tag msg">Message</span>');
      if (c.outcome === 'transferred' || c.answered_by === 'forward') tags.push('<span class="tk-tag tr">' + (c.outcome === 'transferred' ? 'Transferred' : 'Forwarded') + '</span>');
      const sub = c.summary || c.first_said || (c.answered_by === 'message' ? 'Closed message played' : c.status ? 'Status: ' + c.status : '');
      return '<button type="button" class="tk-row' + (c.unread ? ' unread' : '') + (current === c.id ? ' on' : '') + '" data-id="' + c.id + '">' +
        '<div class="w">' + esc(c.customer_name || c.source !== 'phone' ? phone(c.from_number) || ('#' + c.id) : (match ? 'Caller ID: ' + match.name : '#' + c.id)) +
        '<span>' + esc(rel(c.created_at)) + (c.duration_sec ? ' · ' + esc(dur(c.duration_sec)) : '') + '</span></div>' +
        '<div class="t">' + esc(name) + tags.join('') + '</div>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</button>';
    }).join('');
    $('callRows').querySelectorAll('.tk-row').forEach(b => { b.onclick = () => openCall(parseInt(b.dataset.id)); });
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
    if (c.line_name) chips.push('<span class="tk-chip ok">' + esc(c.line_name) + '\u2019s line</span>');
    if (c.hours_mode) chips.push('<span class="tk-chip">' + (c.hours_mode === 'after' ? 'After hours' : 'Regular hours') + '</span>');
    if (c.duration_sec != null) chips.push('<span class="tk-chip">' + esc(dur(c.duration_sec)) + '</span>');
    if (c.source === 'phone') chips.push(/passed-(a|b)\b/i.test(c.stir || '') ? '<span class="tk-chip ok" title="' + esc(c.stir) + '">Caller ID carrier-verified</span>'
      : '<span class="tk-chip" title="' + esc(c.stir || 'No STIR/SHAKEN result from the carrier') + '">Caller ID not carrier-verified</span>');
    if (c.caller_first) chips.push('<span class="tk-chip">Greeted as ' + esc(c.caller_first) + '</span>');
    if (c.language) chips.push('<span class="tk-chip">' + esc(lang(c.language)) + '</span>');
    if (c.answered_by) chips.push('<span class="tk-chip">' + esc({ ai: 'Answered by NovaAI', forward: 'Forwarded to the team', message: 'Closed message', person: 'Answered by the team', ring: 'Ringing the team' }[c.answered_by] || c.answered_by) + '</span>');
    if (c.outcome === 'message') chips.push('<span class="tk-chip warn">Message taken</span>');
    if (c.outcome === 'transferred') chips.push('<span class="tk-chip ok">Transferred</span>');
    if (c.status && c.source === 'phone') chips.push('<span class="tk-chip">' + esc(c.status) + '</span>');
    if (c.cost != null) chips.push('<span class="tk-chip" title="ElevenLabs credits for this call">' + esc(c.cost) + ' credits</span>');
    if (c.emailed_to) chips.push('<span class="tk-chip ok">Quote emailed to ' + esc(c.emailed_to) + '</span>');
    if (c.ended_reason) chips.push('<span class="tk-chip" title="How the call ended">' + esc(c.ended_reason) + '</span>');
    let html = '<div class="tk-hd"><button type="button" class="tk-link" id="callBack" style="float:right">← All calls</button>' +
      '<b class="big">' + esc(c.source === 'try' ? 'Test in text' : phone(c.from_number) || 'Unknown number') + '</b>' +
      (c.source !== 'phone' ? ' <span class="tk-tag test">Test</span>' : '') +
      '<div class="who">' + (c.verified ? '<b>' + (c.verified_by === 'caller_id' ? 'Recognised by caller ID:' : c.verified_by === 'check+caller_id' ? 'Verified (number + email/ZIP):' : 'Verified:') + '</b> ' + esc(c.customer_name || '#' + c.customer_id) + (c.company ? ' (' + esc(c.company) + ')' : '') + ' <i>#' + esc(c.customer_id) + '</i>'
        : match ? '<b>Caller ID matches</b> ' + match + ' <i>— not verified on the call</i>' : '<i>Not verified' + (c.source === 'phone' ? '; the number is not on a customer account' : '') + '</i>') + '</div>' +
      '<div class="meta">' + chips.join('') + '</div>' +
      (c.has_audio ? '<div class="tk-audio" id="callAudio"><span class="tk-msg">Loading the recording…</span></div>' : '') +
      (c.error ? '<div class="tk-msg err" style="margin-top:8px">' + esc(c.error) + '</div>' : '') +
      '<div style="margin-top:8px"><button type="button" class="tk-link" id="callUnread">Mark as unread</button>' +
      (c.page_url ? ' \u00b7 <a class="tk-link" href="' + esc(c.page_url) + '" target="_blank" rel="noopener" style="text-decoration:none">Caller\u2019s page \u2197</a>' : '') + '</div></div>';
    if (c.quotes && c.quotes.length) html += '<div class="tk-sum" style="background:#fff;border-color:var(--line)"><span>Prices given on this call</span>' +
      c.quotes.map(q => '<div style="margin-top:4px"><b>' + esc(q.product) + '</b> \u2014 ' + q.rows.map(r => esc(Number(r.quantity).toLocaleString('en-US')) + ': $' +
        esc(Number(r.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) +
        (r.order_url ? ' <a class="tk-link" style="text-decoration:none;padding:0" href="' + esc(r.order_url) + '" target="_blank" rel="noopener">order link</a>' : '')).join(' \u00b7 ') + '</div>').join('') + '</div>';
    if (c.summary) html += '<div class="tk-sum"><span>Summary</span>' + esc(c.summary) + '</div>';
    const events = turns.filter(t => t.role === 'event');
    const evClass = (t) => /verified as|Transferred to|saved/i.test(t) ? ' ok' : /failed/i.test(t) ? ' bad' : '';
    if (c.transcript && c.transcript.length) {
      html += '<div class="tk-sec"><span>Transcript</span><button type="button" class="tk-link" id="showLog">Show NovaAI’s lookups</button></div><div class="tk-tx">' +
        c.transcript.map(t => '<div class="tk-say ' + (t.role === 'caller' ? 'caller' : 'agent') + '"><div class="who">' + (t.role === 'caller' ? 'Caller' : 'NovaAI') +
          '<small>' + (t.at != null ? Math.floor(t.at / 60) + ':' + String(Math.round(t.at % 60)).padStart(2, '0') : '') + '</small></div><div class="b">' + esc(t.text || '') + '</div></div>' +
          (t.tools && t.tools.length ? '<div class="tk-used">' + t.tools.map(x => '<span>' + esc(x) + '</span>').join('') + '</div>' : '')).join('') +
        events.map(t => '<div class="tk-evt' + evClass(t.content) + '">' + esc(t.content) + '</div>').join('') + '</div>' +
        '<div id="turnLog" hidden>' + turnsHtml(turns, evClass) + '</div>';
    } else if (turns.length) {
      html += '<div class="tk-sec"><span>' + (c.source === 'try' ? 'Conversation' : 'As it happened') + '</span></div><div class="tk-tx">' + turnsHtml(turns, evClass) + '</div>';
      if (c.source === 'phone' && !/completed|failed|busy|no-answer|canceled/.test(c.status || '')) html += '<div class="tk-msg">The full transcript, summary and recording arrive from ElevenLabs a minute after the call ends.</div>';
    } else {
      html += '<div class="tk-empty">' + (c.answered_by === 'forward' ? 'This call was forwarded to the team.' : c.answered_by === 'message' ? 'The caller heard the closed message.' : 'Nothing was said on this call yet.') + '</div>';
    }
    v.innerHTML = html;
    $('callBack').onclick = () => { $('vCalls').classList.remove('detail'); current = null; history.replaceState(null, '', '/talk-ai'); };
    $('callUnread').onclick = async () => { await api('/api/admin/talk/calls/' + id + '/unread', { method: 'POST', body: '{}' }); current = null; loadCalls(); $('vCalls').classList.remove('detail'); v.innerHTML = '<div class="tk-empty">Marked as unread.</div>'; };
    if ($('showLog')) $('showLog').onclick = () => { const l = $('turnLog'); l.hidden = !l.hidden; $('showLog').textContent = l.hidden ? 'Show NovaAI’s lookups' : 'Hide NovaAI’s lookups'; };
    if (c.has_audio) loadAudio(id);
    loadCalls();
  }
  function turnsHtml(turns, evClass) {
    return turns.map(t => {
      if (t.role === 'event') return '<div class="tk-evt' + evClass(t.content) + '">' + esc(t.content) + '</div>';
      const used = (t.tools || []).map(x => '<span title="' + esc(JSON.stringify(x.input || {})) + '">' + esc(x.tool) + (x.found && x.found !== 'ok' ? ': ' + esc(x.found) : '') + '</span>').join('');
      return '<div class="tk-say ' + (t.role === 'caller' ? 'caller' : 'agent') + '"><div class="who">' + (t.role === 'caller' ? 'Caller' : 'NovaAI') +
        '<small>' + esc(new Date(toDate(t.created_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })) + '</small></div><div class="b">' + esc(t.content || '…') + '</div></div>' +
        (used ? '<div class="tk-used">' + used + '</div>' : '');
    }).join('');
  }
  // The recording needs the sign-in header, so it is fetched and played from memory.
  async function loadAudio(id) {
    const box = $('callAudio'); if (!box) return;
    try {
      const r = await fetch('/api/admin/talk/audio/' + id, { headers: { 'Authorization': 'Bearer ' + token } });
      if (!r.ok) throw new Error();
      const b = await r.blob();
      if (current !== id || !$('callAudio')) return;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(b);
      box.innerHTML = '<audio controls preload="metadata" src="' + audioUrl + '"></audio><a class="tk-link" href="' + audioUrl + '" download="call-' + id + '.mp3">Download</a>';
    } catch (e) { box.innerHTML = '<span class="tk-msg">The recording could not be loaded.</span>'; }
  }

  // ---- Try it ----
  const tryState = { callId: null, msgs: [], busy: false };
  async function newTry() {
    tryState.callId = null; tryState.msgs = []; tryState.busy = true;
    paintTry('<div class="tk-empty">Starting a test call\u2026</div>');
    const j = await api('/api/admin/talk/try/start', { method: 'POST', body: JSON.stringify({ from: $('tryFrom').value.trim(), line_id: $('tryLine').value, hours: $('tryHours').value }) }).catch(() => ({}));
    tryState.busy = false;
    tryState.callId = j.call_id || null;
    tryState.msgs.push({ role: 'assistant', content: j.greeting || (ov && ov.settings ? ov.settings.greeting : 'Hi! How can I help?'),
      note: [j.line, j.hours === 'after' ? 'After hours' : 'Regular hours', j.recognised ? 'Recognised by the number as ' + j.recognised : ($('tryFrom').value.trim() ? 'That number is not on a customer account' : null)].filter(Boolean).join(' \u00b7 ') });
    paintTry();
    $('tryInput').focus();
  }
  function paintTry(extra) {
    $('tryLog').innerHTML = tryState.msgs.map(m => '<div class="tk-say ' + (m.role === 'user' ? 'caller' : 'agent') + '"><div class="who">' + (m.role === 'user' ? 'Caller' : 'NovaAI') + '</div>' +
      '<div class="b">' + esc(m.content) + '</div></div>' + (m.tools && m.tools.length ? '<div class="tk-used">' + m.tools.map(x => '<span title="' + esc(JSON.stringify(x.input || {})) + '">' +
        esc(x.tool) + (x.found && x.found !== 'ok' ? ': ' + esc(x.found) : '') + '</span>').join('') + '</div>' : '') +
      (m.note ? '<div class="tk-evt">' + esc(m.note) + '</div>' : '')).join('') + (extra || '');
    $('tryLog').scrollTop = $('tryLog').scrollHeight;
  }
  $('tryNew').onclick = newTry;
  $('tryFrom').onchange = newTry;
  $('tryLine').onchange = newTry; $('tryHours').onchange = newTry;            // a different number = a new test call as that caller
  $('tryForm').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('tryInput').value.trim();
    if (!t || tryState.busy) return;
    tryState.busy = true; $('trySend').disabled = true; $('tryInput').value = '';
    tryState.msgs.push({ role: 'user', content: t });
    paintTry('<div class="tk-say agent"><div class="who">NovaAI</div><div class="b">…</div></div>');
    try {
      const j = await api('/api/admin/talk/try', { method: 'POST', body: JSON.stringify({ call_id: tryState.callId, from: $('tryFrom').value.trim(),
        messages: tryState.msgs.map(m => ({ role: m.role, content: m.content })) }) });
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
  document.querySelectorAll('#sCallerId button').forEach(b => { b.onclick = () => { callerId = b.dataset.c; paintChoices(); }; });
  document.querySelectorAll('#sMode button').forEach(b => { b.onclick = () => { if (modes) { modes[curMode].answer = b.dataset.m; paintChoices(); } }; });
  document.querySelectorAll('#sModeTabs button').forEach(b => { b.onclick = () => { keepMode(); curMode = b.dataset.k; paintMode(); }; });
  function paintChoices() {
    document.querySelectorAll('#sCallerId button').forEach(b => b.classList.toggle('on', b.dataset.c === callerId));
    document.querySelectorAll('#sMode button').forEach(b => b.classList.toggle('on', !!modes && b.dataset.m === modes[curMode].answer));
  }
  function keepMode() {
    if (!modes) return;
    Object.assign(modes[curMode], { greeting: $('sGreeting').value, greeting_known: $('sGreetingKnown').value, rules: $('sModeRules').value });
  }
  function paintMode() {
    document.querySelectorAll('#sModeTabs button').forEach(b => b.classList.toggle('on', b.dataset.k === curMode));
    const md = modes[curMode];
    $('sGreeting').value = md.greeting || ''; $('sGreetingKnown').value = md.greeting_known || ''; $('sModeRules').value = md.rules || '';
    document.querySelectorAll('.tk-mname').forEach(x => { x.textContent = curMode === 'after' ? 'after hours' : 'regular hours'; });
    paintChoices();
  }
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
  function paintNow(j) {
    const h = j.hours_now || {};
    $('sNow').innerHTML = 'Right now: ' + (h.open ? '<b class="reg">Regular hours</b> — open until ' + esc(h.closes) : '<b class="aft">After hours</b>' +
      (h.next ? ' — opens ' + esc(h.next) : '')) + '<br><small style="color:var(--muted)">' + esc(h.week || '') + '</small>';
    document.querySelectorAll('.tk-ring').forEach(x => { x.textContent = j.ring_seconds || 20; });
  }
  async function paintTraining() {
    const j = ov || await loadOverview();
    if (!j) return;
    const s = j.settings;
    callerId = s.caller_id || 'carrier';
    modes = JSON.parse(JSON.stringify(s.modes));
    paintHours(s.hours); paintNow(j); paintMode();
    $('sRules').value = s.rules || '';
    $('sTransfer').value = s.transfer_number ? phone(s.transfer_number) : '';
    $('sForward').value = s.forward_number ? phone(s.forward_number) : '';
    $('sNotify').value = s.notify_to || '';
    $('sSummary').checked = !!s.summary_mail;
    $('sClosed').value = s.closed_message || '';
    $('sMsg').textContent = ''; $('sMsg').className = 'tk-msg';
  }
  $('sSave').onclick = async () => {
    const m = $('sMsg'); m.className = 'tk-msg'; m.textContent = 'Saving…';
    keepMode();
    const j = await api('/api/admin/talk/settings', { method: 'POST', body: JSON.stringify({ caller_id: callerId, hours: readHours(), modes: modes, rules: $('sRules').value,
      transfer_number: $('sTransfer').value, forward_number: $('sForward').value, notify_to: $('sNotify').value, summary_mail: $('sSummary').checked,
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
      if (Number(l.ring_first)) tags.push('<span class="tk-chip">Rings ' + esc(phone(l.ring_number)) + ' first</span>');
      if (l.voice_id) tags.push('<span class="tk-chip">Own voice</span>');
      if (!l.number && !Number(l.main_line)) tags.push('<span class="tk-chip warn">Not answering yet — give it a number or tick "their clients"</span>');
      return '<div class="tk-am' + (Number(l.active) ? '' : ' off') + '"><div class="av">' + esc(String(l.am_name || '?').charAt(0)) + '</div><div class="bd">' +
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
      '<small>' + esc(n.main ? 'Main TalkAi number' : n.line ? n.line + '’s line' : (n.name && n.name !== n.number ? n.name : 'Not used by TalkAi')) + '</small></div>' +
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
  function editLine(l) {
    l = l || { main_line: 1, active: 1 };
    const box = $('amEdit');
    const used = lines.filter(x => x.id !== l.id).map(x => x.number).filter(Boolean);
    const numOpts = '<option value="">None — main line only</option>' + twNumbers.filter(n => !n.main && (used.indexOf(n.number) === -1 || n.number === l.number))
      .map(n => '<option value="' + esc(n.number) + '"' + (l.number === n.number ? ' selected' : '') + '>' + esc(phone(n.number)) + (n.connected ? '' : ' (not connected yet)') + '</option>').join('') +
      (l.number && !twNumbers.some(n => n.number === l.number) ? '<option value="' + esc(l.number) + '" selected>' + esc(phone(l.number)) + '</option>' : '');
    box.hidden = false;
    box.innerHTML = '<h3>' + (l.id ? 'Edit ' + esc(l.am_name) : 'Add an account manager') + '</h3><div class="tk-form">' +
      '<label>Account manager<select id="amWho" class="tk-select">' + (l.id ? '' : '<option value="">Pick one…</option>') +
        (managers || []).map(m => '<option value="' + m.id + '"' + (Number(l.am_user_id) === m.id ? ' selected' : '') + ' data-phone="' + esc(m.phone) + '" data-email="' + esc(m.email) + '">' +
          esc(m.name) + (m.title ? ' — ' + esc(m.title) : '') + ' (' + m.clients + ' clients)</option>').join('') + '</select></label>' +
      '<label>Their own number <small>Calls to it always get this account manager’s NovaAI.</small><select id="amNum" class="tk-select">' + numOpts + '</select></label>' +
      '<label class="chk"><input type="checkbox" id="amMain"' + (Number(l.main_line) ? ' checked' : '') + '> <span>Their clients on the main line too <small style="display:block;color:var(--muted)">A caller recognised by their number whose account manager this is.</small></span></label>' +
      '<div class="row2"><label>Their phone <small>Rings first, and where transfers go.</small><input type="text" id="amRing" value="' + esc(l.ring_number ? phone(l.ring_number) : '') + '" placeholder="e.g. 747 400 4060"></label>' +
      '<label>Messages go to<input type="text" id="amNotify" value="' + esc(l.notify_to || '') + '" placeholder="their email"></label></div>' +
      '<label class="chk"><input type="checkbox" id="amRingFirst"' + (Number(l.ring_first) ? ' checked' : '') + '> <span>Ring their phone first during regular hours <small style="display:block;color:var(--muted)">NovaAI answers if they do not pick up within <span class="tk-ring">' + ((ov && ov.ring_seconds) || 20) + '</span> seconds.</small></span></label>' +
      '<label>Greeting <small>Optional — otherwise the hours greeting is used. {name} = the caller’s first name, {am} = this account manager’s.</small>' +
        '<textarea id="amGreeting" rows="2" placeholder="Hi {name}, you’ve reached {am}’s line at AxiomPrint. I’m NovaAI, {am}’s AI assistant, and this call is recorded. How can I help?">' + esc(l.greeting || '') + '</textarea></label>' +
      '<label>Their notes for NovaAI <small>How they like things handled: their clients, products they focus on, what to promise, when to take a message.</small>' +
        '<textarea id="amTraining" rows="6" placeholder="- Most of my clients are restaurants: menus, table tents, banners.\n- Rush jobs: always take a message, I call back within the hour.\n- Say I’m in the office Mon–Thu.">' + esc(l.training || '') + '</textarea></label>' +
      '<label>Voice ID <small>Optional: an ElevenLabs voice ID for this line.</small><input type="text" id="amVoice" value="' + esc(l.voice_id || '') + '"></label>' +
      '<label class="chk"><input type="checkbox" id="amActive"' + (Number(l.active) || !l.id ? ' checked' : '') + '> <span>On</span></label>' +
      '<div class="acts"><button type="button" class="tk-btn" id="amSave">Save</button><button type="button" class="tk-btn ghost" id="amCancel">Cancel</button>' +
        '<span class="tk-msg" id="amMsg"></span>' + (l.id ? '<button type="button" class="del" id="amDel">Remove</button>' : '') + '</div></div>';
    $('amWho').onchange = () => {
      const o = $('amWho').selectedOptions[0];
      if (o && !$('amRing').value) $('amRing').value = o.dataset.phone ? phone(o.dataset.phone) : '';
      if (o && !$('amNotify').value) $('amNotify').value = o.dataset.email || '';
    };
    $('amCancel').onclick = () => { box.hidden = true; };
    if ($('amDel')) $('amDel').onclick = async () => {
      if (!confirm('Remove ' + l.am_name + '’s NovaAI line? Past calls stay.')) return;
      await api('/api/admin/talk/lines/' + l.id, { method: 'DELETE' }); box.hidden = true; loadAms();
    };
    $('amSave').onclick = async () => {
      const msg = $('amMsg'); msg.className = 'tk-msg'; msg.textContent = 'Saving…';
      const j = await api('/api/admin/talk/lines', { method: 'POST', body: JSON.stringify({ id: l.id, am_user_id: $('amWho').value, number: $('amNum').value,
        main_line: $('amMain').checked, ring_first: $('amRingFirst').checked, ring_number: $('amRing').value, notify_to: $('amNotify').value,
        greeting: $('amGreeting').value, training: $('amTraining').value, voice_id: $('amVoice').value, active: $('amActive').checked }) });
      if (!j.ok) { msg.className = 'tk-msg err'; msg.textContent = j.error || 'Could not save.'; return; }
      box.hidden = true; loadAms();
    };
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('amAdd').onclick = () => editLine(null);
  function fillTryLines() {
    const sel = $('tryLine'), keep = sel.value;
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
      '<li><b>Language</b>: English as default; add Spanish and Armenian as additional languages so NovaAI can switch with the caller.</li>' +
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

  // ---- start ----
  loadOverview().then(() => {
    const id = parseInt(new URLSearchParams(location.search).get('call'));
    show('calls');
    if (id) openCall(id);
  });
  setInterval(() => { if (!document.hidden && $('vCalls').classList.contains('on')) loadCalls(); }, 30000);
})();
