/**
 * Closed days — AxiomPrint's own calendar of days the shop is closed (production table `holidays`, edited on the
 * website's "Closed days" panel: "New jobs' due dates skip these days").
 *
 *   const closedDays = require('./closed-days')(runQuery);
 *   closedDays.isClosed('2026-11-26')   -> true
 *   closedDays.name('2026-11-26')       -> 'Thanksgiving'
 *   closedDays.yearSet(2026)            -> Set of 'YYYY-MM-DD' (null until the first load succeeded)
 *   closedDays.upcoming(365)            -> [{ date, name, weekday, repeats }] from today (Los Angeles)
 *   closedDays.text(365)                -> 'Thu Nov 26, 2026 (Thanksgiving); Fri Nov 27, 2026 (...)' for prompts
 *
 * Rows: name, date, repeat_on ('does_not_repeat' | 'annually_on_same_date' | …) and recurrence JSON
 * { freq: none|yearly|monthly|weekly, interval, mode: day|weekday, month, month_day, ordinal, weekday, weekdays,
 *   ends: never|on|after, until, count }. Every row is expanded into dates for last year .. three years ahead and kept
 * in memory; it reloads every hour (and on demand), so everything that counts business days can ask synchronously.
 */
const LA = 'America/Los_Angeles';
const WD = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const iso = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const wdOf = (v) => { if (v == null || v === '') return null; if (typeof v === 'number' || /^\d$/.test(String(v))) return Number(v) % 7; const k = String(v).toLowerCase(); return k in WD ? WD[k] : null; };
// The n-th (1..5, or -1 = last) weekday of a month, or null when that month has no such day.
function nthWeekday(y, m, wd, n) {
  if (n < 0) { const last = daysIn(y, m); return last - ((dow(y, m, last) - wd + 7) % 7); }
  const d = 1 + ((wd - dow(y, m, 1) + 7) % 7) + (n - 1) * 7;
  return d <= daysIn(y, m) ? d : null;
}
const todayLA = () => new Intl.DateTimeFormat('en-CA', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Every date a row stands for, between two years (inclusive).
function expand(row, y0, y1) {
  const out = [];
  const base = String(row.day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return out;
  const by = +base.slice(0, 4), bm = +base.slice(5, 7), bd = +base.slice(8, 10);
  let r = row.recurrence;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = null; } }
  r = r || {};
  let freq = String(r.freq || '').toLowerCase();
  if (!freq || freq === 'none') freq = /annual|year/i.test(row.repeat_on || '') ? 'yearly' : /month/i.test(row.repeat_on || '') ? 'monthly' : /week/i.test(row.repeat_on || '') ? 'weekly' : 'none';
  if (freq === 'none') return [base];
  const every = Math.max(1, parseInt(r.interval) || 1);
  const until = r.ends === 'on' && /^\d{4}-\d{2}-\d{2}/.test(String(r.until || '')) ? String(r.until).slice(0, 10) : null;
  const max = r.ends === 'after' ? Math.max(1, parseInt(r.count) || 1) : Infinity;
  let n = 0;
  const push = (d) => {
    if (d < base || n >= max || (until && d > until)) return false;
    n++;
    if (+d.slice(0, 4) >= y0 && +d.slice(0, 4) <= y1) out.push(d);
    return true;
  };
  // "Same day and week" (e.g. the 4th Thursday): from the recurrence, or worked out from the first date.
  const sameWeek = /same_day_and_week/i.test(row.repeat_on || '') || r.mode === 'weekday' || r.mode === 'ordinal';
  let ordinal = r.ordinal != null && r.ordinal !== '' ? parseInt(r.ordinal) : null;
  if (sameWeek && !ordinal) ordinal = Math.ceil(bd / 7);
  if (sameWeek && wdOf(r.weekday) == null) r = Object.assign({}, r, { weekday: dow(by, bm, bd) });
  const byWeekday = sameWeek && ordinal && wdOf(r.weekday) != null;
  if (freq === 'yearly') {
    const m = parseInt(r.month) || bm;
    for (let y = by; y <= y1 && n < max; y += every) {
      let d = null;
      if (byWeekday) d = nthWeekday(y, m, wdOf(r.weekday), ordinal);
      else { const md = parseInt(r.month_day) || bd; d = md <= daysIn(y, m) ? md : null; }
      if (d) push(iso(y, m, d));
    }
  } else if (freq === 'monthly') {
    for (let k = 0, y = by, m = bm; y <= y1 && n < max && k < 600; k++) {
      let d = null;
      if (byWeekday) d = nthWeekday(y, m, wdOf(r.weekday), ordinal);
      else { const md = parseInt(r.month_day) || bd; d = md <= daysIn(y, m) ? md : null; }
      if (d) push(iso(y, m, d));
      m += every; while (m > 12) { m -= 12; y++; }
    }
  } else if (freq === 'weekly') {
    const days = (Array.isArray(r.weekdays) && r.weekdays.length ? r.weekdays : [dow(by, bm, bd)]).map(wdOf).filter(x => x != null);
    // Week by week from the Sunday of the start date.
    let t = Date.UTC(by, bm - 1, bd) - dow(by, bm, bd) * 86400000;
    for (let k = 0; k < 600 && n < max; k++, t += every * 7 * 86400000) {
      const d0 = new Date(t);
      if (d0.getUTCFullYear() > y1) break;
      days.slice().sort().forEach(w => { const d = new Date(t + w * 86400000); push(iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())); });
    }
  } else return [base];
  return out;
}

module.exports = function closedDays(runQuery) {
  let map = null;           // 'YYYY-MM-DD' -> { name, repeats }
  let loadedAt = 0, loading = null, lastError = null;
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const rows = await runQuery("SELECT h.*, DATE_FORMAT(h.`date`, '%Y-%m-%d') AS day FROM holidays h");
        const y = +todayLA().slice(0, 4), next = new Map();
        rows.forEach(row => {
          let rec = row.recurrence;
          if (typeof rec === 'string') { try { rec = JSON.parse(rec); } catch (e) { rec = null; } }
          const repeats = rec && rec.freq ? !/^none$/i.test(String(rec.freq)) : !!row.repeat_on && String(row.repeat_on) !== 'does_not_repeat';
          expand(row, y - 1, y + 3).forEach(d => {
            const nm = String(row.name || 'Closed').replace(/\s+/g, ' ').trim();
            // Two rows on one day (a yearly Independence Day and a one-off one): keep one, prefer the one-off name.
            if (!next.has(d) || (next.get(d).repeats && !repeats)) next.set(d, { name: nm, repeats: repeats });
          });
        });
        map = next; loadedAt = Date.now(); lastError = null;
      } catch (e) { lastError = e.message; console.error('CLOSED_DAYS load failed:', e.message); }
      finally { loading = null; }
      return map;
    })();
    return loading;
  }
  load();
  setInterval(load, 60 * 60 * 1000).unref();

  const api = {
    load: load,
    ready: () => !!map,
    status: () => ({ ok: !!map, loaded_at: loadedAt ? new Date(loadedAt).toISOString() : null, count: map ? map.size : 0, error: lastError }),
    isClosed: (d) => !!(map && map.has(String(d).slice(0, 10))),
    name: (d) => (map && map.has(String(d).slice(0, 10))) ? map.get(String(d).slice(0, 10)).name : null,
    yearSet(year) {
      if (!map) return null;
      const set = new Set(), p = String(year) + '-';
      for (const d of map.keys()) if (d.indexOf(p) === 0) set.add(d);
      return set;
    },
    upcoming(days) {
      if (!map) return [];
      const from = todayLA(), to = new Date(Date.parse(from + 'T12:00:00Z') + (days || 365) * 86400000).toISOString().slice(0, 10);
      return Array.from(map.keys()).filter(d => d >= from && d <= to).sort().map(d => ({
        date: d, name: map.get(d).name, repeats: map.get(d).repeats,
        weekday: new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) }));
    },
    // One line for a prompt: "Thu Nov 26, 2026 (Thanksgiving); …".
    text(days) {
      return api.upcoming(days || 365).map(x => new Date(x.date + 'T12:00:00Z').toLocaleDateString('en-US',
        { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) + ' (' + x.name + ')').join('; ');
    }
  };
  return api;
};
module.exports.expand = expand;
