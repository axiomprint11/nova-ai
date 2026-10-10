/**
 * Office hours — what AxiomPrint tells customers ("we're open Mon–Fri 9 to 6, Saturday 10 to 2"). Company data,
 * edited in Admin → Domain Knowledge → Company info, stored in SQLite `company_info` (key `office_hours`), and put
 * into every assistant's prompt (CRM Chat, the website chat, TalkAi) by `line()`.
 *
 * NOT the TalkAi call-routing hours (talk_settings.hours, 8:00–6:55): the phone is answered 24/7 and those decide
 * which setup answers. The assistants never quote the routing hours to a customer.
 */
module.exports = function officeHours(db) {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const DEFAULT = { days: { mon: { open: 1, from: '09:00', to: '18:00' }, tue: { open: 1, from: '09:00', to: '18:00' }, wed: { open: 1, from: '09:00', to: '18:00' },
    thu: { open: 1, from: '09:00', to: '18:00' }, fri: { open: 1, from: '09:00', to: '18:00' }, sat: { open: 1, from: '10:00', to: '14:00' }, sun: { open: 0, from: '10:00', to: '14:00' } },
    note: '', address: '', phone: '' };
  db.run('CREATE TABLE IF NOT EXISTS company_info (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)');
  let cache = null;
  const hhmm = (v, d) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : d;
  function norm(h) {
    h = h && typeof h === 'object' ? h : {};
    const out = { days: {}, note: String(h.note || '').slice(0, 600), address: String(h.address || '').slice(0, 200), phone: String(h.phone || '').slice(0, 60) };
    DAYS.forEach(k => { const d = (h.days && h.days[k]) || {}; const def = DEFAULT.days[k]; out.days[k] = { open: d.open ? 1 : 0, from: hhmm(d.from, def.from), to: hhmm(d.to, def.to) }; });
    return out;
  }
  function get() {
    return new Promise(ok => {
      if (cache) return ok(cache);
      db.get('SELECT value FROM company_info WHERE key = ?', ['office_hours'], (e, row) => {
        let v = null; try { v = row && row.value ? JSON.parse(row.value) : null; } catch (er) {}
        cache = norm(v || DEFAULT); ok(cache);
      });
    });
  }
  function set(h, who) {
    const v = norm(h);
    return new Promise((ok, no) => db.run('INSERT INTO company_info (key, value, updated_at, updated_by) VALUES (?,?,datetime(\'now\'),?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      ['office_hours', JSON.stringify(v), who || ''], e => { if (e) return no(e); cache = v; ok(v); }));
  }
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const ampm = (t) => { const v = toMin(t); if (v == null) return t; const h = Math.floor(v / 60), mi = v % 60; return ((h % 12) || 12) + (mi ? ':' + String(mi).padStart(2, '0') : '') + ' ' + (h < 12 ? 'AM' : 'PM'); };
  // "Mon–Fri 9 AM–6 PM, Sat 10 AM–2 PM, Sun closed" — or, spoken (TalkAi), "Monday to Friday 9 AM to 6 PM, Saturday
  // 10 AM to 2 PM, closed Sunday": full day names and "to", never abbreviations or dashes the voice would read oddly.
  function weekText(h, spoken) {
    const groups = [];
    DAYS.forEach(k => {
      const d = h.days[k], txt = d.open ? ampm(d.from) + (spoken ? ' to ' : '–') + ampm(d.to) : 'closed', last = groups[groups.length - 1];
      if (last && last.txt === txt) last.to = k; else groups.push({ from: k, to: k, txt });
    });
    const nm = (k) => spoken ? NAMES[k] : NAMES[k].slice(0, 3);
    return groups.map(g => { const days = g.from === g.to ? nm(g.from) : nm(g.from) + (spoken ? ' to ' : '–') + nm(g.to); return spoken && g.txt === 'closed' ? 'closed ' + days : days + ' ' + g.txt; }).join(', ');
  }
  // Open right now (Los Angeles)? closedDays (closed-days.js) adds the calendar.
  function status(h, closedDays) {
    const la = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
    const wd = la.slice(0, 3).toLowerCase(), m = /(\d{2}):(\d{2})/.exec(la.split(', ')[2] || la), nowMin = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
    const dateM = /(\d{2})\/(\d{2})\/(\d{4})/.exec(la), today = dateM ? dateM[3] + '-' + dateM[1] + '-' + dateM[2] : '';
    const holiday = closedDays && closedDays.isClosed && closedDays.isClosed(today) ? (closedDays.name(today) || 'closed day') : null;
    const d = h.days[wd] || { open: 0 };
    const open = !holiday && d.open && nowMin >= toMin(d.from) && nowMin < toMin(d.to);
    return { open: !!open, closes: open ? ampm(d.to) : null, holiday: holiday || null, today: wd };
  }
  // line(closedDays, { spoken: true }) for the phone: full day names, "to" instead of dashes, and a rule to keep it that way.
  async function line(closedDays, opts) {
    const h = await get();
    const st = status(h, closedDays);
    const spoken = !!(opts && opts.spoken);
    return 'OFFICE HOURS (what to tell customers when they ask when we are open, pick-up times or when to call — the ONLY hours you ever state' + (spoken ? '; say day names in full, "Monday to Friday", "Saturday", never "Mon–Fri" or "Sat"' : '') + '): ' + weekText(h, spoken) + ' (Los Angeles)' +
      (h.note ? '. ' + h.note.replace(/[.\s]+$/, '') : '') + '. Right now the office is ' + (st.open ? 'open until ' + st.closes + ' today' : 'closed' + (st.holiday ? ' (' + st.holiday + ')' : '')) + '.' +
      (h.address ? ' Address: ' + h.address + '.' : '') + (h.phone ? ' Phone: ' + h.phone + '.' : '');
  }
  return { get, set, weekText, status, line, DAYS, NAMES };
};
