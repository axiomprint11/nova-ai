// ReportsAI (1.20.96) — the owner's reports page, one report at a time. The first is Onboarding: every client welcome form the
// account managers filled in the CRM (customer_welcome_forms), who onboarded whom, when, and where the client came from —
// so the AMs can be rewarded for the onboarding work. Everything here is READ-ONLY on the production DB.
'use strict';

module.exports = function mountReportsAi(app, deps) {
  const { auth, adminOnly, serveVersionedHtml, runQuery, mysql } = deps;
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
};
