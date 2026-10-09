/**
 * The AxiomPrint team, from the production `user` table — so NovaAI can tell who a caller means by
 * "Can I speak to Lulu?" and relay the message to that person.
 *
 *   const team = require('./team-directory')({ runQuery });
 *   await team.find('Lulu', { managerId })  -> { match: {id, first, last, name, email, title} }
 *                                             | { ambiguous: [{…}, {…}] } | { none: true }
 *
 * Staff = type 'member', status 10, not blocked, an @axiomprint.com email; shared mailboxes (order@, info@,
 * webdev@) and company rows are left out. Names match the first name, the legal name, the nickname in brackets
 * ("JC (Juan Carlos)"), the email name (lulu.alba@ → lulu) and the last name; "Lulu Alba" must match both.
 * When several people share a first name: the caller's account manager wins, then the only one who has signed in
 * to the CRM in the last 45 days (office staff do; production floor staff mostly never do). Otherwise ambiguous.
 * Read-only. Cached 10 minutes.
 */
module.exports = function teamDirectory(o) {
  const runQuery = o.runQuery;
  const SKIP_LOCAL = /^(order|info|webdev|noreply|no-reply|admin|support|hello)$/i;
  const TITLES = /\b(mr|mrs|ms|miss|mister|dr|sir|madam|ma'?am)\b\.?/g;
  const norm = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let cache = { at: 0, list: [] };

  async function staff() {
    if (Date.now() - cache.at < 10 * 60 * 1000 && cache.list.length) return cache.list;
    const rows = await runQuery("SELECT id, name, last_name, legal_name, call_rail_name, title, email, last_login_at FROM user " +
      "WHERE type = 'member' AND status = 10 AND blocked_at IS NULL AND email LIKE '%@axiomprint.com' LIMIT 500");
    const list = [];
    (rows || []).forEach(r => {
      const email = String(r.email || '').trim();
      const local = email.split('@')[0] || '';
      const rawFirst = String(r.name || '').trim(), last = String(r.last_name || '').trim();
      if (!rawFirst || SKIP_LOCAL.test(local) || /axiomprint/i.test(rawFirst) || norm(rawFirst) === norm(last)) return;
      const nick = (rawFirst.match(/\(([^)]+)\)/) || [])[1] || '';
      const first = rawFirst.replace(/\([^)]*\)/g, '').trim();
      const firsts = new Set([first, nick, r.legal_name, r.call_rail_name, local.split(/[._-]/)[0]].map(norm).filter(x => x && x.length > 1));
      // "Vance Leonard" → also "vance"; "Juan Carlos" → also "juan".
      [...firsts].forEach(f => { const w = f.split(' ')[0]; if (w.length > 1) firsts.add(w); });
      const lasts = new Set([last, norm(last).split(' ')[0]].map(norm).filter(x => x && x.length > 1));
      const seen = r.last_login_at ? Date.parse(r.last_login_at) : 0;
      list.push({ id: r.id, first: first, last: last, name: (first + ' ' + last).trim(), email: email, title: r.title || '',
        firsts: [...firsts], lasts: [...lasts], active: seen && Date.now() - seen < 45 * 86400000, seen: seen || 0 });
    });
    cache = { at: Date.now(), list: list };
    return list;
  }
  // One letter apart (speech-to-text slips: "Lulu" / "Lulú" / "Loulou" is too far; "Talin" / "Tallin" is not).
  function near(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1 || a.length < 4 || b.length < 4) return false;
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
  }
  const pub = (p) => ({ id: p.id, first: p.first, last: p.last, name: p.name, email: p.email, title: p.title });

  async function find(said, ctx) {
    ctx = ctx || {};
    const list = await staff();
    const words = norm(String(said || '').replace(TITLES, ' ')).replace(TITLES, ' ').split(' ').filter(w => w.length > 1);
    if (!words.length) return { none: true };
    const phrase = words.join(' ');
    const score = (p) => {
      const firstHit = p.firsts.some(f => f === phrase || words.indexOf(f) > -1 || (f.indexOf(' ') > 0 && phrase.indexOf(f) > -1));
      const lastHit = p.lasts.some(l => words.indexOf(l) > -1 || (l.indexOf(' ') > 0 && phrase.indexOf(l) > -1));
      if (firstHit && lastHit) return 4;
      if (p.firsts.indexOf(phrase) > -1) return 3;                 // "Lulu", "Juan Carlos", "JC"
      if (words.length > 1 && (firstHit || lastHit)) return 1;     // "Juan Smith": first name only — weak
      if (firstHit) return 3;
      if (lastHit) return 2;
      if (p.firsts.some(f => words.some(w => near(w, f)))) return 1;
      return 0;
    };
    const scored = list.map(p => ({ p: p, s: score(p) })).filter(x => x.s > 0);
    if (!scored.length) return { none: true };
    const top = Math.max(...scored.map(x => x.s));
    let best = scored.filter(x => x.s === top).map(x => x.p);
    if (best.length > 1 && ctx.managerId) {
      const am = best.find(p => Number(p.id) === Number(ctx.managerId));
      if (am) return { match: pub(am), why: 'account manager' };
    }
    if (best.length > 1) {
      const active = best.filter(p => p.active);
      if (active.length === 1) return { match: pub(active[0]), why: 'only active' };
      if (active.length > 1) best = active;
    }
    if (best.length === 1) return { match: pub(best[0]) };
    return { ambiguous: best.sort((a, b) => b.seen - a.seen).slice(0, 4).map(pub) };
  }
  async function byId(id) {
    const list = await staff();
    const p = list.find(x => Number(x.id) === Number(id));
    return p ? pub(p) : null;
  }
  return { find, byId, staff };
};
