'use strict';
// Email notifications (1.20.73): every email Nova sends to the TEAM, in one list — what it is, who gets it, on or off.
// Admin → Emails shows the list; `notify_prefs` keeps the choice per kind (enabled + recipients override). The sending
// code asks `Notify.on(kind)` before composing and `Notify.to(kind, fallback)` for the address, so a switched-off kind is
// never sent (and never recorded as sent) and a recipients override replaces the configured address.
// Customer-facing mail (quotes to callers, website quote emails) is not here — those are the product, not notifications.
module.exports = function (deps) {
  const { db, auth, adminOnly } = deps;
  const KINDS = [
    { kind: 'talk.summary', group: 'TalkAi', name: 'Call Summary', desc: 'After each real call NovaAI answered: the summary and the transcript. Setup → "email a summary of every call".', where: 'TalkAi Setup → Notification email' },
    { kind: 'talk.message', group: 'TalkAi', name: 'Message Taken', desc: 'NovaAI took a message for the team on a call (caller, call-back number, topic, message).', where: 'TalkAi Setup → Notification email' },
    { kind: 'talk.csr', group: 'TalkAi', name: 'CSR Hand-off', desc: 'The AI summary with call back yes / no, sent to the CSR team (Dialpad shows the call as missed, so the team hears what happened).', where: 'TalkAi Setup → CSR team' },
    { kind: 'talk.quote_bcc', group: 'TalkAi', name: 'Client Quotes BCC', desc: 'A blind copy of every quote email NovaAI sends a caller after a phone call (the "Your AxiomPrint quote" email with the prices and Order now links) — for quality checks. The caller\u2019s own email is not affected by this switch.', where: 'TalkAi Setup → Copy of every quote' },
    { kind: 'talk.alert', group: 'TalkAi', name: 'TalkAi Failure Alert', desc: 'The moment a call turn fails (NovaAI could not answer and the caller heard “Sorry, I’m having trouble on my side”, a webhook or transfer step broke) — the error line, at once; then at most one email per 30 minutes per kind with the count.', where: 'TALKAI_ALERT_TO in .env (default gary@)' },
    { kind: 'talk.relay', group: 'TalkAi', name: 'Asked-for Person Relay', desc: 'When a caller asked for someone by name, that team member gets the call summary.', where: 'the team directory (the person asked for)', fixed_to: true },
    { kind: 'client.escalate', group: 'Website chat', name: 'Past-due Job Escalation', desc: 'A customer asked about a job that is past its deadline and not finished — once per job per day.', where: 'CLIENT_BOT_ESCALATE_TO' },
    { kind: 'client.quote_bcc', group: 'Website chat', name: 'Client Quotes BCC', desc: 'A blind copy of every quote email NovaAI sends a website-chat customer (Send to me / Email Chat) — for quality checks. The customer\u2019s own email is not affected.', where: 'CLIENT_BOT_MAIL_BCC' },
    { kind: 'bk.alerts', group: 'Bookkeeping', name: 'Daily Purchases Alert', desc: 'Once a day — purchases waiting for the bank / not received, and what Nova filed on its own in the last 24 h.', where: 'Bookkeeping Settings → Alerts' },
    { kind: 'bk.loans', group: 'Bookkeeping', name: 'Missed Loan Payment', desc: 'A loan slot with no bank line after its due date (once per loan-month).', where: 'Bookkeeping Settings → Alerts' },
    { kind: 'bk.ar', group: 'Bookkeeping', name: 'Notify Accounts Receivable', desc: 'A customer deposit filed under an income category — sent when someone presses "Notify Accounts Receivable".', where: 'Bookkeeping Settings → Alerts (AR to / cc)' },
    { kind: 'ra.onboarding', group: 'ReportsAI', name: 'Onboarding Report', desc: 'The client-onboarding report — the leaderboard per account manager, where the clients came from and every onboarding — sent on the configured day (the 1st of the month by default) for the previous period; each account manager who onboarded gets their own list when that is switched on.', where: 'ReportsAI → Onboarding → Email report' },
    { kind: 'ra.clients', group: 'ReportsAI', name: 'New Clients Report', desc: 'The new-clients report — every account created in the period, who made it (website sign-up or a team member), where the clients came from, the referrals and who has ordered — sent on the configured day (the 1st of the month by default) to the owner with a copy to the CC list and to every account manager.', where: 'ReportsAI → New Clients → Email report' },
    { kind: 'ra.referrals', group: 'ReportsAI', name: 'Referral Report', desc: 'The referral report — every referral of the period, the top referring clients and the Axiom team members who referred, and who has ordered — sent on the configured day (the 1st of the month by default) to the owner with a copy to the CC list; each account manager gets their own list (the referred clients on their account and the referrals they made) when that is switched on.', where: 'ReportsAI → Referral Report → Email report' },
    { kind: 'ma.price', group: 'Material AI', name: 'Material Price Alert', desc: 'An invoice line linked to a material came in at a price more than the set percent (10 % by default) away from that supplier\u2019s price on file — the material, the vendor, both prices and the invoice; accept the new price or mark it to renegotiate on the Material AI page.', where: 'Material AI → Price alerts → settings' },
    { kind: 'hr.leave', group: 'NovaHR', name: 'Time Off Requests', desc: 'A time off request goes to the person\u2019s manager; the approval or decline (with the reason) goes back to the person.', where: 'the manager / the employee', fixed_to: true },
    { kind: 'hr.late', group: 'NovaHR', name: 'Late Clock-in Alert', desc: 'Someone clocked in later than the "alert manager when late by" minutes in HR settings — to their manager, once a day.', where: 'the person\u2019s manager', fixed_to: true },
    { kind: 'hr.missed', group: 'NovaHR', name: 'Missed Clock-out', desc: 'Every morning at 9 (Glendale): a shift from yesterday with a clock-in and no clock-out — to the person and their manager.', where: 'the person and their manager', fixed_to: true },
    { kind: 'hr.checkin', group: 'NovaHR', name: 'Points Earned', desc: 'The weekly check-in (attendance points + what the manager saw) and every shout-out — to the employee.', where: 'the employee', fixed_to: true },
    { kind: 'hr.review', group: 'NovaHR', name: 'Self-review Reminder', desc: 'Sent when a manager presses "Remind people with a self-review due" on Reviews.', where: 'the people with a self-review due', fixed_to: true },
    { kind: 'hr.redeem', group: 'NovaHR', name: 'Points Redemption', desc: 'Someone redeemed reward points (a gift card, a paid day off, a bonus) — to HR to fulfil it.', where: 'HR_ALERT_TO in .env (default gary@)' },
    { kind: 'backup', group: 'System', name: 'Backup Problems', desc: 'The nightly users.db backup failed, or its Google Drive upload did.', where: 'BACKUP_ALERT_TO' }
  ];
  db.run('CREATE TABLE IF NOT EXISTS notify_prefs (kind TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, recipients TEXT, updated_at TEXT, updated_by TEXT)');
  const prefs = {};                                   // kind → { enabled, recipients }
  const defaults = {};                                // kind → () => current configured address (registered by each module)
  function load() { return new Promise((res) => db.all('SELECT * FROM notify_prefs', [], (e, rows) => { if (!e) { Object.keys(prefs).forEach(k => delete prefs[k]); (rows || []).forEach(r => { prefs[r.kind] = r; }); } res(); })); }
  load();
  const on = (kind) => !prefs[kind] || Number(prefs[kind].enabled) !== 0;
  const to = (kind, fallback) => { const p = prefs[kind]; const r = p && String(p.recipients || '').trim(); return r || fallback; };
  const register = (kind, fn) => { defaults[kind] = fn; };
  const who = (req) => String((req.user && (req.user.email || req.user.username || req.user.key)) || 'admin').replace(/^(member|user):/, '');
  app_routes();
  function app_routes() {
    const app = deps.app;
    app.get('/api/admin/notifications', auth, adminOnly, async (req, res) => {
      const out = [];
      for (const k of KINDS) {
        let def = ''; try { def = defaults[k.kind] ? String(await defaults[k.kind]() || '') : ''; } catch (e) { def = ''; }
        const p = prefs[k.kind] || null;
        out.push(Object.assign({}, k, { enabled: on(k.kind), recipients: p ? (p.recipients || '') : '', default_to: def, effective_to: on(k.kind) ? to(k.kind, def) : '', updated_at: p ? p.updated_at : null, updated_by: p ? p.updated_by : null }));
      }
      res.json({ ok: true, kinds: out });
    });
    app.post('/api/admin/notifications/:kind', auth, adminOnly, (req, res) => {
      const kind = String(req.params.kind || ''); if (!KINDS.some(k => k.kind === kind)) return res.status(404).json({ ok: false, error: 'No such email kind' });
      const b = req.body || {};
      const cur = prefs[kind] || { enabled: 1, recipients: '' };
      const enabled = b.enabled == null ? Number(cur.enabled) !== 0 : !!b.enabled;
      const recipients = b.recipients == null ? (cur.recipients || '') : String(b.recipients).replace(/\s+/g, ' ').trim().slice(0, 400);
      if (recipients && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+(\s*[,;]\s*[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+)*$/.test(recipients)) return res.status(400).json({ ok: false, error: 'Recipients: one or more email addresses, separated by commas.' });
      db.run("INSERT INTO notify_prefs (kind, enabled, recipients, updated_at, updated_by) VALUES (?,?,?,datetime('now'),?) ON CONFLICT(kind) DO UPDATE SET enabled = excluded.enabled, recipients = excluded.recipients, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
        [kind, enabled ? 1 : 0, recipients || null, who(req)], async (e) => { if (e) return res.status(500).json({ ok: false, error: e.message }); await load(); console.log('NOTIFY ' + kind + ' ' + (enabled ? 'on' : 'OFF') + (recipients ? ' → ' + recipients : '') + ' by ' + who(req)); res.json({ ok: true, enabled, recipients }); });
    });
  }
  return { KINDS, on, to, register, reload: load };
};
