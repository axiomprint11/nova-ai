/**
 * Graphic design services — company knowledge shared by every assistant (1.20.37).
 *
 * The hourly rates and the "hours per kind of job" guide used to live only in the website chat's Training
 * (client_bot_rules.design / design_min / design_max). They are general knowledge — the CRM Chat needs them to
 * answer "how much can I charge for the design on E1181735" — so they now live in SQLite `company_info`
 * (key `design_services`, {guide, min, max}), edited in Admin → Domain Knowledge → Company info, and read by the
 * website chat, TalkAi and the staff ChatBot. The first load migrates whatever was saved on the Client ChatBot page.
 *
 * estimate(pieces, rates) is the one piece of arithmetic every assistant uses: low hours × lowest rate to high hours
 * × highest rate, rounded to whole dollars. The models never do this sum themselves.
 */
module.exports = function designServices(db) {
  const DEFAULT_MIN = 65, DEFAULT_MAX = 86;
  /* 1.20.165 — the team quotes a design fee as THREE options by kind of client, not one wide range. Each option is a price for a
     job of `tier_hours` hours (the low end of Nova's estimate); Nova scales it to each job's hours and rounds to $5. Staff only —
     the website chat and TalkAi keep the plain estimate (a customer never sees "picky client"). */
  const DEFAULT_TIER_HOURS = 1.5;
  const DEFAULT_TIERS = [
    { key: 'easy', name: 'Easy', who: 'Simple product, the client sends the logo and text, one round of changes', low: 85, high: 95 },
    { key: 'standard', name: 'Standard / picky', who: 'A few rounds of changes, a client who is particular about the details', low: 120, high: 150 },
    { key: 'hard', name: 'Hard / many ideas', who: 'Lots of ideas or directions, starting from scratch, many rounds', low: 180, high: 220 }
  ];
  const DEFAULT_GUIDE = [
    'AxiomPrint has in-house graphic designers. The price depends on the project.',
    '',
    'Typical time per piece (hours, low–high):',
    '- Small change to an existing file (text, date, phone number): 0.25–0.5',
    '- Make a customer file print-ready (size, bleed, resolution, colors): 0.5–1',
    '- Business card from the customer’s logo and text: 1–2',
    '- Postcard, flyer or rack card, one side: 1.5–3 (both sides: 2.5–4)',
    '- Banner, sign or poster: 1.5–3',
    '- Sticker or label: 1–2',
    '- Brochure (tri-fold or bi-fold): 3–6',
    '- Menu: 2–4 per page',
    '- Booklet or catalog: 1–2 per page',
    '- Packaging / box dieline artwork: 4–8',
    '- Logo design: 6–12',
    '',
    'Rush (needed within 24 hours): add 50%. Customer-supplied logo and text keep the hours at the low end; starting from nothing or several rounds of changes pushes them to the high end.'
  ].join('\n');
  db.run('CREATE TABLE IF NOT EXISTS company_info (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)');
  let cache = null;
  const rate = (v, d) => { const n = Number(v); return n > 0 && n <= 1000 ? Math.round(n * 100) / 100 : d; };
  function norm(v) {
    v = v && typeof v === 'object' ? v : {};
    const out = { guide: String(v.guide || '').trim().slice(0, 8000) || DEFAULT_GUIDE, min: rate(v.min, DEFAULT_MIN), max: rate(v.max, DEFAULT_MAX) };
    if (out.max < out.min) out.max = out.min;
    const th = Number(v.tier_hours); out.tier_hours = th > 0 && th <= 100 ? Math.round(th * 100) / 100 : DEFAULT_TIER_HOURS;
    const src = Array.isArray(v.tiers) && v.tiers.length ? v.tiers : DEFAULT_TIERS;
    out.tiers = src.slice(0, 5).map((t, i) => {
      let lo = rate(t && t.low, 0), hi = rate(t && t.high, 0); if (hi && lo && hi < lo) { const x = lo; lo = hi; hi = x; } if (!hi) hi = lo;
      return { key: String((t && t.key) || 'tier' + (i + 1)).replace(/[^a-z0-9_]/gi, '').slice(0, 20) || 'tier' + (i + 1), name: String((t && t.name) || 'Option ' + (i + 1)).trim().slice(0, 40),
        who: String((t && t.who) || '').trim().slice(0, 200), low: lo, high: hi };
    }).filter(t => t.low > 0);
    if (!out.tiers.length) out.tiers = DEFAULT_TIERS.map(t => Object.assign({}, t));
    return out;
  }
  const dbGet = (sql, p) => new Promise(ok => db.get(sql, p || [], (e, r) => ok(e ? null : r)));
  async function get() {
    if (cache) return cache;
    const row = await dbGet('SELECT value, updated_at, updated_by FROM company_info WHERE key = ?', ['design_services']);
    let v = null; try { v = row && row.value ? JSON.parse(row.value) : null; } catch (e) {}
    if (!v) {
      // one-time migration from the Client ChatBot page's Training fields (if that table exists and was edited)
      const old = await dbGet('SELECT design, design_min, design_max FROM client_bot_rules WHERE id = 1');
      if (old && (old.design || old.design_min || old.design_max)) { v = { guide: old.design, min: old.design_min, max: old.design_max }; await set(v, 'migrated from Client ChatBot training'); }
    }
    cache = Object.assign(norm(v), { updated_at: row ? row.updated_at : null, updated_by: row ? row.updated_by : null });
    return cache;
  }
  /* a partial save (the Client ChatBot page sends only guide / min / max) keeps the saved options */
  async function set(v, who) {
    const cur = await get().catch(() => null);
    const n = norm(Object.assign({}, cur ? { tiers: cur.tiers, tier_hours: cur.tier_hours } : {}, v || {}, { tiers: v && v.tiers ? v.tiers : cur && cur.tiers, tier_hours: v && v.tier_hours != null ? v.tier_hours : cur && cur.tier_hours }));
    return new Promise((ok, no) => db.run('INSERT INTO company_info (key, value, updated_at, updated_by) VALUES (?,?,datetime(\'now\'),?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      ['design_services', JSON.stringify(n), who || ''], e => { if (e) return no(e); cache = null; ok(n); }));
  }
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\.00$/, '');
  // pieces: [{task, hours_low, hours_high}] → the estimate every assistant quotes verbatim
  // opts.tiers: also the three options for the team, each scaled to the job's low hours (rounded to $5)
  function estimate(pieces, rates, opts) {
    const lo = Number(rates.min), hi = Number(rates.max);
    const list = (Array.isArray(pieces) ? pieces : []).slice(0, 20).map(x => {
      let a = Math.max(0, Math.min(200, Number(x && x.hours_low) || 0)), b = Math.max(0, Math.min(200, Number(x && x.hours_high) || 0));
      if (b < a) { const t = a; a = b; b = t; }
      if (!b) b = a;
      return { task: String((x && x.task) || 'Design').slice(0, 120), hours_low: Math.round(a * 4) / 4, hours_high: Math.round(b * 4) / 4 };
    }).filter(x => x.hours_high > 0);
    if (!list.length) return { error: 'Give each piece of design work its hours (hours_low, hours_high).' };
    const hl = list.reduce((n, x) => n + x.hours_low, 0), hh = list.reduce((n, x) => n + x.hours_high, 0);
    const low = Math.round(hl * lo), high = Math.round(hh * hi);
    const hrs = (n) => (Math.round(n * 100) / 100).toString();
    const out = { pieces: list, hours: hrs(hl) + '–' + hrs(hh) + ' hours', hours_low: hl, hours_high: hh, hourly_rate: money(lo) + '–' + money(hi) + ' per hour', low, high,
      estimate: money(low) + '–' + money(high), say: 'Give the estimate exactly as written here (estimate, hours, hourly rate); it is an estimate — the final price depends on the project.' };
    if (opts && opts.tiers && Array.isArray(rates.tiers) && rates.tiers.length) {
      const f = hl / (Number(rates.tier_hours) || DEFAULT_TIER_HOURS), r5 = (n) => Math.max(5, Math.round(n / 5) * 5);
      out.options = rates.tiers.map(t => { const a = r5(t.low * f), b = Math.max(a, r5(t.high * f)); return { name: t.name, who: t.who, low: a, high: b, price: a === b ? money(a) : money(a) + '–' + money(b) }; });
      out.scaled_from = hrs(rates.tier_hours) + ' hours' + (Math.abs(f - 1) > 0.001 ? ' (this job ≈ ' + hrs(hl) + ' hours, ×' + (Math.round(f * 100) / 100) + ')' : '');
      delete out.estimate; delete out.hourly_rate; delete out.low; delete out.high;
      out.say = 'Give the team these options exactly as written — each name, its price and who it fits, one per line. No hourly rate, no single wide range, no arithmetic of your own. ' +
        'Say which one fits best only when the job, its notes or the client clearly point to it.';
    }
    return out;
  }
  return { get, set, estimate, DEFAULT_GUIDE, DEFAULT_MIN, DEFAULT_MAX, DEFAULT_TIERS, DEFAULT_TIER_HOURS, money };
};
