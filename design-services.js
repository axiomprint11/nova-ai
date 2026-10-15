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
  function set(v, who) {
    const n = norm(v);
    return new Promise((ok, no) => db.run('INSERT INTO company_info (key, value, updated_at, updated_by) VALUES (?,?,datetime(\'now\'),?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      ['design_services', JSON.stringify(n), who || ''], e => { if (e) return no(e); cache = null; ok(n); }));
  }
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\.00$/, '');
  // pieces: [{task, hours_low, hours_high}] → the estimate every assistant quotes verbatim
  function estimate(pieces, rates) {
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
    return { pieces: list, hours: hrs(hl) + '–' + hrs(hh) + ' hours', hours_low: hl, hours_high: hh, hourly_rate: money(lo) + '–' + money(hi) + ' per hour', low, high,
      estimate: money(low) + '–' + money(high), say: 'Give the estimate exactly as written here (estimate, hours, hourly rate); it is an estimate — the final price depends on the project.' };
  }
  return { get, set, estimate, DEFAULT_GUIDE, DEFAULT_MIN, DEFAULT_MAX, money };
};
