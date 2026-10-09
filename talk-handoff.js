/**
 * TalkAi hand-off — after NovaAI answers a call, the CSR team and the CRM find out.
 *
 * Dialpad still logs a call NovaAI answered as "missed" (it was passed on to a Twilio number), so without this the
 * team would call the client back about something NovaAI already handled. For every phone call NovaAI answered:
 *
 *   1. aiSummary(call)  — a short Dialpad-style summary written by Claude from the transcript and what happened on
 *                         the call (prices given, quote emailed, message taken, transfer), plus callback yes/no + why.
 *                         Kept in talk_calls.ai_summary / callback / callback_reason.
 *   2. CSR email        — to talk_settings.csr_to (Training → Numbers and messages → "CSR team"), straight after the
 *                         call: "no callback needed" or "CALL BACK: <why>", the summary, caller, quotes, message.
 *   3. CRM webhook      — POST to talk_settings.webhook_url, signed with TALKAI_WEBHOOK_SECRET (.env), ~90 s after the
 *                         call so the recording is usually in. Retried 1 / 5 / 30 / 120 min. One stable delivery per call
 *                         (X-Nova-Delivery: talkai-call-<id>), so the CRM can upsert. Spec: docs/TALKAI_CRM_WEBHOOK.md.
 *
 * Recording links in the webhook are signed and expire (TALKAI_REC_LINK_DAYS, default 30): /api/talk/rec/<id>/<exp>/<sig>.mp3
 */
const fs = require('fs');
const path = require('path');

module.exports = function talkHandoff(o) {
  const { app, deps, dbGet, dbAll, dbRun, settings, env, hit, NOVA_URL, AUDIO_DIR, callLink, htmlEsc, usd2, fetchAudio, auth, adminOnly } = o;
  const crypto = deps.crypto || require('crypto');
  const REC_DAYS = parseInt(env('TALKAI_REC_LINK_DAYS')) || 30;
  const recKey = crypto.createHash('sha256').update('talkai-rec:' + String(process.env.JWT_SECRET || 'nova')).digest();
  const digits = (v) => String(v || '').replace(/\D/g, '');
  const e164 = (v) => { const d = digits(v); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : (String(v || '').trim() || null); };
  const pretty = (v) => { const d = digits(v).replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(v || ''); };
  const iso = (t) => { if (!t) return null; const d = new Date(String(t).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? '' : 'Z')); return isNaN(d) ? null : d.toISOString(); };
  const laTime = (t) => { const d = iso(t); return d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  const dur = (s) => s == null ? '' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
  const VIA = { regular: { key: 'regular_hours', label: 'Regular hours (NovaAI on the main number)' },
    missed: { key: 'team_missed', label: 'Team missed call (Dialpad passed it on)' },
    after: { key: 'after_hours', label: 'After hours' } };

  // ---------------------------------------------------------------- recording links
  const recSig = (id, exp) => crypto.createHmac('sha256', recKey).update(id + ':' + exp).digest('hex').slice(0, 40);
  function recordingUrl(id) {
    const exp = Math.floor(Date.now() / 1000) + REC_DAYS * 86400;
    return { url: NOVA_URL + '/api/talk/rec/' + id + '/' + exp + '/' + recSig(id, exp) + '.mp3', expires_at: new Date(exp * 1000).toISOString() };
  }
  app.get('/api/talk/rec/:id/:exp/:sig', async (req, res) => {
    const id = parseInt(req.params.id), exp = parseInt(req.params.exp), sig = String(req.params.sig || '').replace(/\.mp3$/i, '');
    const want = id && exp ? recSig(id, exp) : '';
    if (!want || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.status(403).type('text/plain').send('Bad link');
    if (exp * 1000 < Date.now()) return res.status(410).type('text/plain').send('This recording link has expired');
    let c = await dbGet('SELECT audio_path FROM talk_calls WHERE id = ?', [id]).catch(() => null);
    if (c && !c.audio_path && fetchAudio) { await fetchAudio(id, 'recording link').catch(() => {}); c = await dbGet('SELECT audio_path FROM talk_calls WHERE id = ?', [id]).catch(() => null); }
    if (!c || !c.audio_path) return res.status(404).type('text/plain').send('The recording is not ready yet');
    const full = path.resolve(AUDIO_DIR, c.audio_path);
    if (full.indexOf(path.resolve(AUDIO_DIR)) !== 0 || !fs.existsSync(full)) return res.status(404).type('text/plain').send('No recording');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('audio/mpeg').sendFile(full);
  });

  // ---------------------------------------------------------------- what happened on the call
  async function facts(callId) {
    const c = await dbGet('SELECT * FROM talk_calls WHERE id = ?', [callId]);
    if (!c) return null;
    const turns = await dbAll('SELECT role, content, tools, created_at FROM talk_turns WHERE call_id = ? ORDER BY id', [callId]).catch(() => []);
    let transcript = [];
    try { transcript = JSON.parse(c.transcript || '[]') || []; } catch (e) {}
    if (!transcript.length) transcript = turns.filter(t => t.role !== 'event' && t.content).map(t => ({ role: t.role === 'caller' ? 'caller' : 'agent', text: t.content, at: null }));
    let quotes = [];
    try { quotes = JSON.parse(c.quotes || '[]') || []; } catch (e) {}
    let match = [];
    try { match = JSON.parse(c.caller_match || '[]') || []; } catch (e) {}
    const events = turns.filter(t => t.role === 'event').map(t => String(t.content || ''));
    // The message NovaAI took (take_message), if any.
    let message = null;
    turns.filter(t => t.role === 'event').forEach(t => {
      let tl = []; try { tl = JSON.parse(t.tools || '[]') || []; } catch (e) {}
      const m = tl.find(x => x && x.tool === 'take_message');
      if (m) {
        const body = String(t.content || '').replace(/^Message taken for the team:\s*/, '');
        message = { topic: (m.input && m.input.topic) || null, caller_name: (m.input && m.input.caller_name) || null,
          callback_number: e164(m.input && m.input.callback_number) || null, email: (m.input && m.input.email) || null,
          text: body.split(' — ').slice(1).join(' — ') || body };
      }
    });
    const emails = await dbAll('SELECT kind, to_addr, subject, ok, created_at FROM talk_emails WHERE call_id = ? ORDER BY id', [callId]).catch(() => []);
    const jobs = [...new Set((JSON.stringify(transcript) + ' ' + JSON.stringify(turns.map(t => t.tools || ''))).match(/\bE\d{6,8}\b/g) || [])].slice(0, 10);
    // Who: verified customer, else the account the number is on.
    const top = match[0] || null;
    const custId = c.customer_id || (top && top.id) || null;
    let account = null;
    if (custId && deps.runQuery) {
      try {
        const r = await deps.runQuery('SELECT c.id, c.name, c.last_name, c.company_name, c.email, c.manager_id, u.name AS mn, u.last_name AS ml, u.email AS me ' +
          'FROM customer c LEFT JOIN user u ON u.id = c.manager_id WHERE c.id = ' + parseInt(custId) + ' LIMIT 1');
        if (r[0]) account = { id: r[0].id, name: [r[0].name, r[0].last_name].filter(Boolean).join(' ').trim(), company: r[0].company_name || '', email: r[0].email || '',
          manager: r[0].manager_id ? { id: r[0].manager_id, name: [r[0].mn, r[0].ml].filter(Boolean).join(' ').trim() || null, email: r[0].me || null } : null };
      } catch (e) {}
    }
    const person = c.customer_name || (top && (top.person || top.name)) || (account && account.name) || null;
    return { c, transcript, quotes, events, message, emails, jobs, account, person,
      company: c.company || (top && top.company) || (account && account.company) || null,
      recognised: c.verified ? (String(c.verified_by || '').indexOf('check') > -1 ? 'verified' : 'caller_id') : top ? 'number_on_account' : 'unknown' };
  }

  // ---------------------------------------------------------------- the AI summary
  const SUM_SYSTEM = [
    'You write the call summary AxiomPrint’s customer-service team reads after NovaAI (AxiomPrint’s AI phone assistant) answered a client call.',
    'Dialpad shows these calls as missed, so the team uses your summary to decide whether to call the client back.',
    'Return ONLY JSON: {"summary": "...", "callback": true|false, "callback_reason": "..." }.',
    'summary: 2 to 4 plain sentences, third person, like "Elena from Biohackers World called about 2 custom 3x5 ft flags. NovaAI quoted $86.40 for 2 and emailed the quote to elena@... She plans to order online."',
    'Name the caller (and company) when known, what they wanted, product/quantity/size, prices NovaAI gave (exactly as in the facts), order numbers, what was sent, and what was agreed.',
    'callback: true when the caller asked for a person or a call back, left a message, was upset, NovaAI could not help or did not finish, the call dropped mid-way, or there is anything the team must do.',
    'false when NovaAI fully handled it (price given, question answered, quote emailed) and the caller needs nothing more.',
    'callback_reason: when callback is true, one short line on what the team should do ("Wants artwork reviewed before ordering — call back today"); else "".',
    'Never invent details that are not in the transcript or facts. No markdown.'
  ].join('\n');
  async function aiSummary(f) {
    const c = f.c;
    const lines = f.transcript.map(t => (t.role === 'caller' ? 'Caller: ' : 'NovaAI: ') + String(t.text || '').replace(/\s+/g, ' ')).join('\n').slice(-14000);
    const callerSaid = f.transcript.filter(t => t.role === 'caller' && String(t.text || '').trim()).length;
    if (!callerSaid) {
      return { summary: (f.person ? f.person + (f.company ? ' from ' + f.company : '') : 'The caller') + ' hung up before saying anything to NovaAI' +
        (c.duration_sec ? ' (' + dur(c.duration_sec) + ' call)' : '') + '.', callback: true, callback_reason: 'Hung up before NovaAI could help — please call back.', by: 'rule' };
    }
    const factsText = [
      'Caller: ' + (f.person || 'unknown') + (f.company ? ' (' + f.company + ')' : '') + ' · ' + pretty(c.from_number) + ' · ' +
        ({ caller_id: 'recognised by caller ID', verified: 'verified (gave email/ZIP/order number)', number_on_account: 'number is on their account', unknown: 'not a client yet' }[f.recognised]),
      'Came in: ' + (VIA[c.hours_mode] || VIA.regular).label + ' · ' + laTime(c.created_at) + (c.duration_sec ? ' · ' + dur(c.duration_sec) : ''),
      f.quotes.length ? 'Prices NovaAI gave: ' + f.quotes.map(q => q.product + ' — ' + (q.rows || []).map(r => r.quantity + ' for $' + usd2(r.price)).join(', ') +
        (q.specs && q.specs.length ? ' (' + q.specs.slice(0, 6).map(sp => sp.field + ': ' + sp.value).join('; ') + ')' : '')).join(' | ') : '',
      f.emails.filter(e => e.ok).length ? 'Emails sent: ' + f.emails.filter(e => e.ok).map(e => (e.kind || 'email') + ' to ' + e.to_addr).join('; ') : '',
      f.message ? 'Message taken for the team: ' + [f.message.topic, f.message.text, f.message.callback_number ? 'call back on ' + pretty(f.message.callback_number) : ''].filter(Boolean).join(' — ') : '',
      c.outcome === 'transferred' ? 'The call was transferred to the team.' : '',
      f.events.length ? 'Events: ' + f.events.slice(-8).join(' | ').slice(0, 1500) : '',
      c.ended_reason ? 'Ended: ' + c.ended_reason : ''
    ].filter(Boolean).join('\n');
    try {
      const r = await deps.anthropic.messages.create({ model: deps.model, max_tokens: 500, system: SUM_SYSTEM,
        messages: [{ role: 'user', content: 'FACTS\n' + factsText + '\n\nTRANSCRIPT\n' + lines }] });
      const txt = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      if (!j.summary) throw new Error('no summary');
      return { summary: String(j.summary).slice(0, 1200), callback: !!j.callback, callback_reason: j.callback ? String(j.callback_reason || 'Call the client back.').slice(0, 300) : '', by: 'nova' };
    } catch (e) {
      console.error('TALKAI ai summary', e.message);
      const fallback = c.summary && !/couldn.t be generated/i.test(c.summary) ? c.summary : null;
      return { summary: fallback || (f.person || 'A caller') + ' talked to NovaAI for ' + (dur(c.duration_sec) || 'a short while') + '. Open the call for the transcript.',
        callback: !!(f.message || c.outcome === 'transferred'), callback_reason: f.message ? 'Left a message — see below.' : '', by: fallback ? 'elevenlabs' : 'fallback' };
    }
  }
  async function ensureSummary(callId, force) {
    const f = await facts(callId);
    if (!f) return null;
    if (f.c.ai_summary && !force) return f;
    const s = await aiSummary(f);
    await dbRun('UPDATE talk_calls SET ai_summary = ?, callback = ?, callback_reason = ? WHERE id = ?', [s.summary, s.callback ? 1 : 0, s.callback_reason || null, callId]);
    return facts(callId);
  }

  // ---------------------------------------------------------------- the CSR email
  function csrEmail(f) {
    const c = f.c, cb = Number(c.callback) === 1;
    const who = f.person ? f.person + (f.company ? ' (' + f.company + ')' : '') : pretty(c.from_number) || 'Unknown caller';
    const subject = 'NovaAI answered: ' + who + (f.person ? ' · ' + pretty(c.from_number) : '') + ' — ' + (cb ? 'CALL BACK' : 'no callback needed');
    const row = (k, v) => v ? '<tr><td style="padding:4px 14px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top">' + htmlEsc(k) + '</td><td style="padding:4px 0">' + v + '</td></tr>' : '';
    const quotes = f.quotes.map(q => '<div style="margin:2px 0"><b>' + htmlEsc(q.product) + '</b> — ' + (q.rows || []).map(r => htmlEsc(r.quantity) + ' for $' + htmlEsc(usd2(r.price))).join(', ') + '</div>').join('');
    const sentTo = f.emails.filter(e => e.ok && e.kind !== 'notes').map(e => htmlEsc(e.to_addr)).join(', ');
    const banner = cb
      ? '<div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:10px;padding:10px 14px;font-weight:700">Call back: ' + htmlEsc(c.callback_reason || 'see below') + '</div>'
      : '<div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:10px 14px;font-weight:700">Handled by NovaAI — no callback needed</div>';
    const html = '<div style="font:14px/1.55 Arial,sans-serif;color:#1f2937;max-width:640px">' + banner +
      '<p style="margin:14px 0 6px;font-size:12px;font-weight:700;letter-spacing:.04em;color:#6b7280">AI SUMMARY</p>' +
      '<p style="margin:0 0 14px">' + htmlEsc(c.ai_summary || '') + '</p>' +
      '<table style="border-collapse:collapse;font-size:13.5px">' +
        row('Caller', htmlEsc(who) + (f.recognised === 'unknown' ? ' <span style="color:#9ca3af">(not a client yet)</span>' : '')) +
        row('Phone', htmlEsc(pretty(c.from_number))) +
        row('Account', f.account ? '#' + htmlEsc(f.account.id) + (f.account.manager && f.account.manager.name ? ' · AM ' + htmlEsc(f.account.manager.name) : '') : '') +
        row('Came in', htmlEsc((VIA[c.hours_mode] || VIA.regular).label + ' · ' + laTime(c.created_at))) +
        row('Duration', htmlEsc(dur(c.duration_sec))) +
        row('Prices given', quotes) +
        row('Quote emailed to', sentTo) +
        row('Jobs mentioned', htmlEsc(f.jobs.join(', '))) +
        row('Message', f.message ? htmlEsc([f.message.topic, f.message.text].filter(Boolean).join(' — ')) + (f.message.callback_number ? '<br>Call back on ' + htmlEsc(pretty(f.message.callback_number)) : '') : '') +
      '</table>' +
      '<p style="margin:16px 0 0"><a href="' + callLink(c.id) + '" style="color:#4f46e5;font-weight:700">Open the call in Nova</a> <span style="color:#6b7280">(recording and transcript)</span></p>' +
      '<p style="margin:14px 0 0;color:#9ca3af;font-size:12px">Dialpad shows this call as missed: NovaAI answered it. Sent to the CSR team so nobody calls the client twice.</p></div>';
    const text = (cb ? 'CALL BACK: ' + (c.callback_reason || '') : 'Handled by NovaAI — no callback needed') + '\n\n' + (c.ai_summary || '') + '\n\n' +
      ['Caller: ' + who, 'Phone: ' + pretty(c.from_number), 'Came in: ' + (VIA[c.hours_mode] || VIA.regular).label + ' · ' + laTime(c.created_at), 'Duration: ' + dur(c.duration_sec),
        f.message ? 'Message: ' + [f.message.topic, f.message.text].filter(Boolean).join(' — ') : ''].filter(Boolean).join('\n') + '\n\nOpen the call: ' + callLink(c.id);
    return { subject, html, text };
  }
  async function sendCsr(callId, force) {
    const s = await settings();
    if (!s.csr_to || !deps.sendMail) return { sent: false, error: s.csr_to ? 'Email is not available.' : 'No CSR team addresses are set.' };
    const f = await ensureSummary(callId);
    if (!f) return { sent: false, error: 'No such call.' };
    if (f.c.csr_sent_at && !force) return { sent: false, already: f.c.csr_sent_at };
    const m = csrEmail(f);
    try {
      await deps.sendMail({ to: s.csr_to, subject: m.subject, html: m.html, text: m.text });
      await dbRun("UPDATE talk_calls SET csr_sent_at = datetime('now'), csr_to = ? WHERE id = ?", [s.csr_to, callId]);
      await dbRun('INSERT INTO talk_emails (call_id, kind, to_addr, bcc, subject, html, text, ok) VALUES (?,?,?,?,?,?,?,1)', [callId, 'csr', s.csr_to, null, m.subject, m.html, m.text]).catch(() => {});
      hit('csr-summary', true, 'Call ' + callId + ' → ' + s.csr_to);
      return { sent: true, to: s.csr_to };
    } catch (e) {
      hit('csr-summary', false, 'Call ' + callId + ': ' + e.message);
      return { sent: false, error: e.message };
    }
  }

  // ---------------------------------------------------------------- the CRM webhook
  function payload(f, s) {
    const c = f.c, rec = recordingUrl(c.id), via = VIA[c.hours_mode] || VIA.regular;
    const startedAt = iso(c.created_at);
    const endedAt = startedAt && c.duration_sec != null ? new Date(Date.parse(startedAt) + c.duration_sec * 1000).toISOString() : null;
    return {
      event: 'call.answered_by_ai', version: 1, sent_at: new Date().toISOString(),
      call: {
        id: c.id, status: 'answered_by_ai', answered_by: 'NovaAI', direction: 'inbound',
        started_at: startedAt, ended_at: endedAt, duration_sec: c.duration_sec != null ? Number(c.duration_sec) : null,
        via: via.key, via_label: via.label,
        main_line: e164(s && s.main_line) || null,
        answered_on: e164(c.to_number) || null,
        language: c.language || 'en',
        twilio_call_sid: c.call_sid && /^CA/.test(c.call_sid) ? c.call_sid : null,
        elevenlabs_conversation_id: c.conversation_id || null,
        nova_url: callLink(c.id)
      },
      caller: {
        phone: e164(c.from_number), recognised: f.recognised !== 'unknown', recognised_by: f.recognised,
        customer_id: f.account ? f.account.id : (c.customer_id || null),
        name: f.person || null, company: f.company || null, email: f.account ? f.account.email || null : null,
        account_manager: f.account && f.account.manager ? f.account.manager : null
      },
      summary: { text: c.ai_summary || null, callback_needed: Number(c.callback) === 1, callback_reason: c.callback_reason || null, generated_by: 'NovaAI' },
      outcome: {
        result: c.outcome === 'transferred' ? 'transferred' : f.message ? 'message_taken' : Number(c.callback) === 1 ? 'needs_callback' : 'handled',
        message: f.message,
        quotes: f.quotes.map(q => ({ product_id: q.product_id || null, product: q.product, options: (q.specs || []).map(sp => ({ name: sp.field, value: sp.value })),
          prices: (q.rows || []).map(r => ({ quantity: Number(r.quantity), price: Number(r.price), list_price: r.list_price != null ? Number(r.list_price) : null,
            discount_percent: r.discount != null ? Number(r.discount) : null, ready: r.ready || null, order_url: r.order_url || null })) })),
        emails_sent: f.emails.filter(e => e.ok && e.kind !== 'csr').map(e => ({ kind: e.kind, to: e.to_addr, subject: e.subject, at: iso(e.created_at) })),
        jobs_mentioned: f.jobs
      },
      recording: { ready: !!c.audio_path, url: rec.url, expires_at: rec.expires_at, content_type: 'audio/mpeg' },
      transcript: f.transcript.map(t => ({ speaker: t.role === 'caller' ? 'caller' : 'novaai', text: String(t.text || ''), at_sec: t.at != null ? Number(t.at) : null }))
    };
  }
  const RETRY_MIN = [1, 5, 30, 120];
  async function sendHook(callId, attempt) {
    attempt = attempt || 1;
    const s = await settings();
    const url = String(s.webhook_url || '').trim(), secret = env('TALKAI_WEBHOOK_SECRET');
    if (!url) return { sent: false, error: 'No webhook URL is set.' };
    if (!secret) return { sent: false, error: 'TALKAI_WEBHOOK_SECRET is not in .env.' };
    const f = await ensureSummary(callId);
    if (!f) return { sent: false, error: 'No such call.' };
    const body = JSON.stringify(payload(f, s));
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex');
    let status = 0, err = null;
    try {
      const r = await fetch(url, { method: 'POST', body: body, signal: AbortSignal.timeout(15000), headers: {
        'Content-Type': 'application/json', 'User-Agent': 'NovaAI-TalkAi/1', 'X-Nova-Event': 'call.answered_by_ai',
        'X-Nova-Delivery': 'talkai-call-' + callId, 'X-Nova-Attempt': String(attempt), 'X-Nova-Signature': 't=' + t + ',v1=' + sig } });
      status = r.status;
      if (!r.ok) err = 'HTTP ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120);
    } catch (e) { err = e.message; }
    await dbRun("UPDATE talk_calls SET hook_status = ?, hook_tries = ?, hook_sent_at = datetime('now') WHERE id = ?", [err ? 'failed: ' + err.slice(0, 160) : 'delivered', attempt, callId]).catch(() => {});
    hit('crm-webhook', !err, 'Call ' + callId + ' attempt ' + attempt + (err ? ': ' + err : ' → ' + status));
    if (err && attempt < RETRY_MIN.length + 1 && status !== 400 && status !== 401 && status !== 403 && status !== 410) {
      setTimeout(() => sendHook(callId, attempt + 1).catch(() => {}), RETRY_MIN[attempt - 1] * 60000).unref();
    }
    return { sent: !err, status: status, error: err };
  }

  // ---------------------------------------------------------------- after every call NovaAI answered
  async function afterCall(callId) {
    const c = await dbGet('SELECT id, source, owner, answered_by FROM talk_calls WHERE id = ?', [callId]).catch(() => null);
    // Real client calls only: not tests, not an account manager calling their own assistant.
    if (!c || c.source !== 'phone' || Number(c.owner) === 1) return;
    await ensureSummary(callId).catch(e => console.error('TALKAI summary', e.message));
    await sendCsr(callId).catch(e => console.error('TALKAI csr', e.message));
    const s = await settings();
    if (s.webhook_url && env('TALKAI_WEBHOOK_SECRET')) setTimeout(() => sendHook(callId).catch(() => {}), 90 * 1000).unref();
  }

  // ---------------------------------------------------------------- admin
  app.get('/api/admin/talk/calls/:id/handoff', auth, adminOnly, async (req, res) => {
    const f = await facts(parseInt(req.params.id));
    if (!f) return res.status(404).json({ ok: false, error: 'No such call.' });
    res.json({ ok: true, payload: payload(f, await settings()), csr: f.c.csr_sent_at ? { sent_at: f.c.csr_sent_at, to: f.c.csr_to } : null,
      webhook: f.c.hook_status ? { status: f.c.hook_status, tries: f.c.hook_tries, at: f.c.hook_sent_at } : null });
  });
  // Write the summary again, and/or send the CSR email / webhook again.
  app.post('/api/admin/talk/calls/:id/handoff', auth, adminOnly, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {};
    const out = { ok: true };
    if (b.summary) { const f = await ensureSummary(id, true); out.summary = f && f.c.ai_summary; out.callback = f && Number(f.c.callback) === 1; }
    if (b.csr) out.csr = await sendCsr(id, true);
    if (b.webhook) out.webhook = await sendHook(id, 1);
    res.json(out);
  });

  return { afterCall, sendCsr, sendHook, ensureSummary, payload, facts };
};
