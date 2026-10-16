// ReportsAI (1.20.96) — the owner's reports page, one report at a time. The first is Onboarding: every client welcome form the
// account managers filled in the CRM (customer_welcome_forms), who onboarded whom, when, and where the client came from —
// so the AMs can be rewarded for the onboarding work. Everything here is READ-ONLY on the production DB.
'use strict';

module.exports = function mountReportsAi(app, deps) {
  const { db, auth, adminOnly, serveVersionedHtml, runQuery, mysql, sendMail, Notify } = deps;
  const dbGet = (sql, p) => new Promise((res, rej) => db.get(sql, p || [], (e, r) => e ? rej(e) : res(r)));
  const dbRun = (sql, p) => new Promise((res, rej) => db.run(sql, p || [], function (e) { e ? rej(e) : res(this); }));
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  db.run('CREATE TABLE IF NOT EXISTS ra_settings (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS ra_sent (id INTEGER PRIMARY KEY AUTOINCREMENT, report TEXT, period_key TEXT, kind TEXT, to_addr TEXT, cc TEXT, n INTEGER, at TEXT, by TEXT)');
  if (Notify) Notify.register('ra.onboarding', () => (emailSettingsSync().to || 'gary@axiomprint.com'));
  const staffPhoto = (ph) => !ph ? null : /^https?:\/\//.test(ph) ? ph : 'https://axiomprint.s3.us-west-1.amazonaws.com/MemberImages/' + String(ph).replace(/^\/+/, '');
  const ymd = (v) => v instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(v) : String(v || '').slice(0, 10);

  app.get('/reports-ai', serveVersionedHtml('reports-ai.html'));

  // Where the client came from. The form has had two lives: codes since Aug 2026 (google, google_ads, chatgpt, existing_client with the
  // client in hear_about_us_who, employee_referral with referred_by_manager_id, other with free text, instagram, our_website) and free
  // text before that ("Google ", "Chat GPT", "Personal Referral", "word of mouth", "Repeat customer"…). sourceOf() folds both into one
  // short kind + who it came from, for the table's second line and the Source filter.
  function sourceOf(f, refName) {
    const raw = String(f.how_did_they_hear_about_us || '').trim(), who = String(f.hear_about_us_who || '').trim(), low = raw.toLowerCase();
    const other = String(f.onboarding_type_other || '').trim();
    if (!raw) return { kind: 'Unknown', who: '', raw: '' };
    if (low === 'existing_client' || /existing|current client|another client|client referr?al/.test(low)) return { kind: 'Client referral', who, raw };
    if (low === 'employee_referral' || /employee|team referr?al|staff/.test(low)) return { kind: 'Team referral', who: refName || who, raw };
    if (low === 'google_ads' || /google ads|adwords|\bppc\b/.test(low)) return { kind: 'Google Ads', who: '', raw };
    if (/google|\bgmb\b|maps/.test(low)) return { kind: 'Google', who: '', raw };
    if (/chat ?gpt|openai|\bai\b|claude|gemini|perplexity|copilot/.test(low) || /chat ?gpt|claude|gemini|perplexity/.test(who.toLowerCase())) return { kind: 'ChatGPT / AI', who: /chat ?gpt|claude|gemini|perplexity/.test(who.toLowerCase()) ? who : '', raw };
    if (/instagram|facebook|linkedin|tiktok|social/.test(low)) return { kind: 'Social', who: raw.replace(/_/g, ' '), raw };
    if (/yelp/.test(low)) return { kind: 'Yelp', who: '', raw };
    if (/reddit/.test(low)) return { kind: 'Reddit', who: '', raw };
    if (/our_website|website|online|internet|web/.test(low)) return { kind: 'Website', who: '', raw };
    if (/previous|repeat|returning|old client|used us|worked with us|past customer/.test(low) || /past customer|previous/.test(other.toLowerCase())) return { kind: 'Returning client', who: who || other, raw };
    if (/referr?al|friend|word of mouth|recommend|mouth/.test(low) || /referr?al|word.of.mouth|recommend/.test(who.toLowerCase())) return { kind: 'Referral', who: /^(personal referral|referral|friend|word of mouth|recommendation)$/i.test(raw) ? who : (who || raw), raw };
    if (low === 'other') { if (/team referr?al/.test(other.toLowerCase())) return { kind: 'Team referral', who, raw }; if (/cold call|walk.?in|trade ?show|event/.test(who.toLowerCase())) return { kind: 'Outreach', who, raw }; return { kind: 'Other', who, raw }; }
    return { kind: 'Other', who: who || raw, raw };
  }
  const VIA = { call: 'Call', in_person: 'In person', loom_video: 'Loom video', other: 'Other', did_not_onboard: 'Did not onboard' };

  // GET /api/reports-ai/onboarding?from&to&all=1 — every welcome form in the range (date_onboarded, LA days), the AM with their face,
  // the client, the source folded by sourceOf(), the onboarding method, lead rating, budget. `all=1` keeps the "did not onboard" forms.
  app.get('/api/reports-ai/onboarding', auth, adminOnly, async (req, res) => {
    try {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null, to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
      const where = ['f.date_onboarded IS NOT NULL'];
      if (from) where.push('f.date_onboarded >= ' + mysql.escape(from)); if (to) where.push('f.date_onboarded <= ' + mysql.escape(to));
      if (req.query.all !== '1') where.push("(f.onboarding_type IS NULL OR f.onboarding_type <> 'did_not_onboard')");
      const rows = await runQuery('SELECT f.id, f.customer_id, f.date_onboarded, f.onboarding_type, f.onboarding_type_other, f.lead_rating, f.how_did_they_hear_about_us, f.hear_about_us_who, f.referred_by_manager_id, ' +
        'f.annual_print_budget, f.estimated_order_value, f.onboarding_outcome, f.created_at, f.created_by_manager_id, ' +
        'c.company_name, c.name AS c_name, c.last_name AS c_last, c.email AS c_email, c.manager_id AS c_manager_id, ' +
        'u.name AS am_name, u.last_name AS am_last, u.memberimage AS am_photo, r.name AS ref_name, r.last_name AS ref_last ' +
        'FROM customer_welcome_forms f LEFT JOIN customer c ON c.id = f.customer_id LEFT JOIN user u ON u.id = f.created_by_manager_id LEFT JOIN user r ON r.id = f.referred_by_manager_id ' +
        'WHERE ' + where.join(' AND ') + ' ORDER BY f.date_onboarded DESC, f.id DESC LIMIT 5000');
      const ams = {};
      const out = rows.map(r => {
        const amName = [r.am_name, r.am_last].filter(Boolean).join(' ').trim() || (r.created_by_manager_id ? 'User #' + r.created_by_manager_id : 'Nobody');
        const am = { id: r.created_by_manager_id || 0, name: amName, photo: staffPhoto(r.am_photo) };
        if (!ams[am.id]) ams[am.id] = Object.assign({ n: 0 }, am); ams[am.id].n++;
        const refName = [r.ref_name, r.ref_last].filter(Boolean).join(' ').trim();
        return { id: r.id, date: ymd(r.date_onboarded), created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
          customer: { id: r.customer_id, company: r.company_name || '', person: [r.c_name, r.c_last].filter(Boolean).join(' ').trim(), email: r.c_email || '', manager_id: r.c_manager_id || null },
          am, via: VIA[r.onboarding_type] || (r.onboarding_type ? String(r.onboarding_type).replace(/_/g, ' ') : ''), via_code: r.onboarding_type || '', via_other: r.onboarding_type_other || '',
          source: sourceOf(r, refName), rating: r.lead_rating || '', budget: r.annual_print_budget || '', value: r.estimated_order_value || null, outcome: r.onboarding_outcome || '', not_onboarded: r.onboarding_type === 'did_not_onboard' };
      });
      res.json({ ok: true, rows: out, ams: Object.values(ams).sort((a, b) => b.n - a.n), from, to });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---------------------------------------------------------------- the monthly email (1.20.97)
  // Settings (SQLite ra_settings key 'onboarding_email'): enabled, span ('month' = the previous calendar month, '30' = the last 30
  // days, 'week' = the previous Mon–Sun week), day (day of month to send, 1), at ('07:00' LA), to (the owner), cc (comma list),
  // per_am (each AM who onboarded gets their own list). The owner's mail: the leaderboard, the sources, every onboarding; an AM's mail:
  // their count, rank and their own list. Every send is logged in ra_sent; the clock sends once per period key.
  const EMAIL_DEFAULTS = { enabled: true, span: 'month', day: 1, at: '07:00', to: 'gary@axiomprint.com', cc: 'luciana@axiomprint.com', per_am: true };
  let emailCache = null;
  async function emailSettings() { const r = await dbGet("SELECT value FROM ra_settings WHERE key = 'onboarding_email'").catch(() => null); let v = {}; try { v = r && r.value ? JSON.parse(r.value) : {}; } catch (e) {} emailCache = Object.assign({}, EMAIL_DEFAULTS, v); return emailCache; }
  function emailSettingsSync() { return emailCache || EMAIL_DEFAULTS; }
  emailSettings().catch(() => {});
  const LA = 'America/Los_Angeles';
  const laParts = (d) => { const o = {}; new Intl.DateTimeFormat('en-US', { timeZone: LA, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d || new Date()).forEach(x => { o[x.type] = x.value; }); return o; };
  const laDay = (d) => { const o = laParts(d); return o.year + '-' + o.month + '-' + o.day; };
  const addDays = (k, n) => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // the period a mail sent on `today` (LA day) covers
  function spanRange(span, today) {
    const y = +today.slice(0, 4), m = +today.slice(5, 7);
    if (span === 'week') { const d = new Date(today + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; const mon = addDays(today, -dow - 7); return { from: mon, to: addDays(mon, 6), key: 'week:' + mon, label: 'the week of ' + usD(mon) + ' – ' + usD(addDays(mon, 6)) }; }
    if (span === '30') return { from: addDays(today, -30), to: addDays(today, -1), key: '30:' + today, label: 'the last 30 days (' + usD(addDays(today, -30)) + ' – ' + usD(addDays(today, -1)) + ')' };
    const first = new Date(Date.UTC(y, m - 2, 1)), last = new Date(Date.UTC(y, m - 1, 0));
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), key: 'month:' + first.toISOString().slice(0, 7), label: MON[first.getUTCMonth()] + ' ' + first.getUTCFullYear() };
  }
  const usD = (k) => k ? k.slice(5, 7) + '-' + k.slice(8, 10) + '-' + k.slice(0, 4) : '';
  async function onboardingRows(from, to) {
    const rows = await runQuery('SELECT f.id, f.customer_id, f.date_onboarded, f.onboarding_type, f.onboarding_type_other, f.lead_rating, f.how_did_they_hear_about_us, f.hear_about_us_who, f.referred_by_manager_id, f.created_by_manager_id, ' +
      'c.company_name, c.name AS c_name, c.last_name AS c_last, u.name AS am_name, u.last_name AS am_last, u.email AS am_email, u.memberimage AS am_photo, r.name AS ref_name, r.last_name AS ref_last ' +
      'FROM customer_welcome_forms f LEFT JOIN customer c ON c.id = f.customer_id LEFT JOIN user u ON u.id = f.created_by_manager_id LEFT JOIN user r ON r.id = f.referred_by_manager_id ' +
      "WHERE f.date_onboarded >= " + mysql.escape(from) + ' AND f.date_onboarded <= ' + mysql.escape(to) + " AND (f.onboarding_type IS NULL OR f.onboarding_type <> 'did_not_onboard') ORDER BY f.date_onboarded, f.id");
    return rows.map(r => ({ date: ymd(r.date_onboarded), customer: r.company_name || [r.c_name, r.c_last].filter(Boolean).join(' ') || ('Customer #' + r.customer_id), person: r.company_name ? [r.c_name, r.c_last].filter(Boolean).join(' ') : '',
      am: { id: r.created_by_manager_id || 0, name: [r.am_name, r.am_last].filter(Boolean).join(' ').trim() || 'Nobody', email: r.am_email || '', photo: staffPhoto(r.am_photo) },
      via: VIA[r.onboarding_type] || (r.onboarding_type ? String(r.onboarding_type).replace(/_/g, ' ') : ''), via_other: r.onboarding_type_other || '', source: sourceOf(r, [r.ref_name, r.ref_last].filter(Boolean).join(' ').trim()), rating: r.lead_rating || '' }));
  }
  const RATING = { high_potential: 'High potential', developing_opportunity: 'Developing', limited_opportunity: 'Limited' };
  function tableHtml(rows, withAm) {
    return '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px"><tr style="background:#f3f4f8;color:#555"><th align="left" style="padding:6px 8px">Date</th><th align="left" style="padding:6px 8px">Client</th>' + (withAm ? '<th align="left" style="padding:6px 8px">AM</th>' : '') + '<th align="left" style="padding:6px 8px">Source</th><th align="left" style="padding:6px 8px">Via</th><th align="left" style="padding:6px 8px">Rating</th></tr>' +
      rows.map(r => '<tr><td style="padding:6px 8px;border-top:1px solid #eee;white-space:nowrap">' + usD(r.date) + '</td><td style="padding:6px 8px;border-top:1px solid #eee"><b>' + esc(r.customer) + '</b>' + (r.person ? '<br><span style="color:#777">' + esc(r.person) + '</span>' : '') + '</td>' + (withAm ? '<td style="padding:6px 8px;border-top:1px solid #eee">' + esc(r.am.name) + '</td>' : '') +
        '<td style="padding:6px 8px;border-top:1px solid #eee">' + esc(r.source.kind) + (r.source.who ? '<br><span style="color:#777">from ' + esc(r.source.who) + '</span>' : '') + '</td><td style="padding:6px 8px;border-top:1px solid #eee">' + esc(r.via) + (r.via_other ? '<br><span style="color:#777">' + esc(r.via_other) + '</span>' : '') + '</td><td style="padding:6px 8px;border-top:1px solid #eee">' + esc(RATING[r.rating] || r.rating.replace(/_/g, ' ')) + '</td></tr>').join('') + '</table>';
  }
  function ownerHtml(rows, range, ams) {
    const src = {}; rows.forEach(r => { src[r.source.kind] = (src[r.source.kind] || 0) + 1; });
    const srcRows = Object.keys(src).sort((a, b) => src[b] - src[a]).map(k => '<tr><td style="padding:4px 8px">' + esc(k) + '</td><td align="right" style="padding:4px 8px"><b>' + src[k] + '</b></td></tr>').join('');
    return '<div style="font-family:Inter,Arial,sans-serif;color:#1c1c28;max-width:860px">' +
      '<h2 style="margin:0 0 4px">Client onboardings — ' + esc(range.label) + '</h2><div style="color:#777;margin-bottom:16px">' + rows.length + ' onboarding' + (rows.length === 1 ? '' : 's') + ' by ' + ams.length + ' account manager' + (ams.length === 1 ? '' : 's') + ' · from the CRM welcome forms · <a href="https://nova.axiomprint.com/reports-ai">open in NovaAI</a></div>' +
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px"><tr style="background:#f3f4f8;color:#555"><th align="left" style="padding:6px 8px">#</th><th align="left" style="padding:6px 8px">Account manager</th><th align="right" style="padding:6px 8px">Onboardings</th></tr>' +
      ams.map((a, i) => '<tr><td style="padding:6px 8px;border-top:1px solid #eee">' + (i + 1) + '</td><td style="padding:6px 8px;border-top:1px solid #eee">' + (a.photo ? '<img src="' + esc(a.photo) + '" width="24" height="24" style="border-radius:12px;vertical-align:middle;margin-right:6px">' : '') + esc(a.name) + '</td><td align="right" style="padding:6px 8px;border-top:1px solid #eee"><b>' + a.n + '</b></td></tr>').join('') + '</table>' +
      '<h3 style="margin:0 0 6px;font-size:14px">Where the clients came from</h3><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px">' + srcRows + '</table>' +
      '<h3 style="margin:0 0 6px;font-size:14px">Every onboarding</h3>' + tableHtml(rows, true) + '</div>';
  }
  function amHtml(a, mine, rank, total, range) {
    return '<div style="font-family:Inter,Arial,sans-serif;color:#1c1c28;max-width:860px"><h2 style="margin:0 0 4px">Your client onboardings — ' + esc(range.label) + '</h2>' +
      '<div style="color:#777;margin-bottom:16px">Hi ' + esc(a.name.split(' ')[0]) + ' — you onboarded <b style="color:#1c1c28">' + mine.length + '</b> client' + (mine.length === 1 ? '' : 's') + ' (#' + rank + ' of ' + total + ' on the team). Thank you!</div>' + tableHtml(mine, false) + '</div>';
  }
  // Send the report for `today` (LA day). who = 'clock' | the admin's id. Returns what went out.
  async function sendOnboardingReport(who, opts) {
    const st = await emailSettings(); const today = (opts && opts.today) || laDay(); const range = spanRange((opts && opts.span) || st.span, today);
    if (Notify && !Notify.on('ra.onboarding')) return { sent: false, error: 'The "Onboarding Report" email is switched off under Admin → Emails.' };
    const rows = await onboardingRows(range.from, range.to);
    const by = {}; rows.forEach(r => { const k = String(r.am.id); if (!by[k]) by[k] = Object.assign({ n: 0 }, r.am); by[k].n++; });
    const ams = Object.values(by).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const to = (Notify ? Notify.to('ra.onboarding', st.to) : st.to) || st.to, cc = String(st.cc || '').split(/[,;]\s*/).map(x => x.trim()).filter(Boolean);
    const out = { sent: true, period: range.label, from: range.from, to: range.to, n: rows.length, owner: null, ams: [] };
    const subj = 'Client onboardings — ' + range.label + ' (' + rows.length + ')';
    await sendMail({ to, cc: cc.join(', ') || undefined, subject: subj, html: ownerHtml(rows, range, ams), text: rows.length + ' onboardings in ' + range.label + '. ' + ams.map(a => a.name + ': ' + a.n).join(', ') });
    await dbRun('INSERT INTO ra_sent (report, period_key, kind, to_addr, cc, n, at, by) VALUES (?,?,?,?,?,?,?,?)', ['onboarding', range.key, 'owner', to, cc.join(', '), rows.length, new Date().toISOString(), who]);
    out.owner = { to, cc };
    if (st.per_am && !(opts && opts.owner_only)) {
      for (let i = 0; i < ams.length; i++) {
        const a = ams[i]; if (!a.email || !a.id) continue;
        const mine = rows.filter(r => String(r.am.id) === String(a.id));
        try { await sendMail({ to: a.email, subject: 'Your client onboardings — ' + range.label + ' (' + mine.length + ')', html: amHtml(a, mine, i + 1, ams.length, range), text: 'You onboarded ' + mine.length + ' clients in ' + range.label + '.' }); out.ams.push({ name: a.name, to: a.email, n: mine.length }); await dbRun('INSERT INTO ra_sent (report, period_key, kind, to_addr, cc, n, at, by) VALUES (?,?,?,?,?,?,?,?)', ['onboarding', range.key, 'am', a.email, '', mine.length, new Date().toISOString(), who]); }
        catch (e) { out.ams.push({ name: a.name, to: a.email, error: e.message }); }
      }
    }
    return out;
  }
  // the clock: once a minute — on the configured day of the month at the configured LA time, once per period
  if (String(process.env.REPORTS_CLOCK || '1') !== '0') {
    setInterval(async () => {
      try {
        const st = emailSettingsSync(); if (!st.enabled) return;
        const o = laParts(), today = o.year + '-' + o.month + '-' + o.day, hm = o.hour + ':' + o.minute;
        const dueDay = st.span === 'week' ? (new Date(today + 'T12:00:00Z').getUTCDay() === 1) : (+o.day === (+st.day || 1));
        if (!dueDay || hm !== (st.at || '07:00')) return;
        const range = spanRange(st.span, today);
        if (await dbGet("SELECT id FROM ra_sent WHERE report = 'onboarding' AND kind = 'owner' AND period_key = ?", [range.key])) return;
        const r = await sendOnboardingReport('clock'); console.log('REPORTS onboarding email ' + (r.sent ? 'sent for ' + r.period + ' (' + r.n + ')' : 'not sent: ' + r.error));
      } catch (e) { console.error('REPORTS clock: ' + e.message); }
    }, 60000).unref();
  }
  app.get('/api/reports-ai/onboarding/email', auth, adminOnly, async (req, res) => {
    try { const st = await emailSettings(); const sent = await new Promise((r2) => db.all("SELECT * FROM ra_sent WHERE report = 'onboarding' ORDER BY id DESC LIMIT 12", [], (e, rows) => r2(rows || []))); const next = spanRange(st.span, laDay()); res.json({ ok: true, settings: st, sent, preview: next.label, notify_on: Notify ? Notify.on('ra.onboarding') : true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/reports-ai/onboarding/email', auth, adminOnly, async (req, res) => {
    try {
      const b = req.body || {}, cur = await emailSettings();
      const mail = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
      const to = String(b.to == null ? cur.to : b.to).trim(); if (!mail.test(to)) return res.json({ ok: false, error: 'Send to: one email address.' });
      const cc = String(b.cc == null ? cur.cc : b.cc).split(/[,;]\s*/).map(x => x.trim()).filter(Boolean); if (cc.some(x => !mail.test(x))) return res.json({ ok: false, error: 'CC: email addresses separated by commas.' });
      const next = { enabled: b.enabled == null ? !!cur.enabled : !!b.enabled, span: ['month', '30', 'week'].indexOf(b.span) > -1 ? b.span : cur.span, day: Math.min(28, Math.max(1, parseInt(b.day) || cur.day || 1)), at: /^\d{2}:\d{2}$/.test(b.at || '') ? b.at : cur.at, to, cc: cc.join(', '), per_am: b.per_am == null ? !!cur.per_am : !!b.per_am };
      await dbRun("INSERT INTO ra_settings (key, value, updated_by, updated_at) VALUES ('onboarding_email', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", [JSON.stringify(next), (req.user && (req.user.key || req.user.username)) || 'admin', new Date().toISOString()]);
      emailCache = Object.assign({}, EMAIL_DEFAULTS, next);
      res.json({ ok: true, settings: emailCache });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // Send now — the owner's report for the configured span as of today (a test, or a missed month); owner_only=1 skips the AMs' mails
  app.post('/api/reports-ai/onboarding/email/send', auth, adminOnly, async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await sendOnboardingReport((req.user && (req.user.key || req.user.username)) || 'admin', { owner_only: !!(req.body && req.body.owner_only), span: req.body && req.body.span }))); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
};
