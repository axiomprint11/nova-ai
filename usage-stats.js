/**
 * Usage overviews (CRM Chat, TalkAi, Client ChatBot): counts by Los Angeles day, week (Monday start) and
 * month, plus the "today / this week / this month" figures with the period before for comparison.
 *
 *   const { series } = require('./usage-stats');
 *   series(['2026-10-08 17:02:11', ...])   // SQLite UTC timestamps
 *   -> { day: [{ key, label, n }] (30), week: [...] (12), month: [...] (12),
 *        now: { today, yesterday, week, last_week, month, last_month } }
 */
const LA = 'America/Los_Angeles';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' (Los Angeles) of a SQLite UTC timestamp or a Date.
function laDay(t) {
  const d = t instanceof Date ? t : new Date(String(t).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? '' : 'Z'));
  return isNaN(d) ? null : dayFmt.format(d);
}
// Calendar arithmetic on day keys (noon UTC, so no time zone or DST edge can move the date).
const keyToDate = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10), 12));
const dateToKey = (d) => d.toISOString().slice(0, 10);
const addDays = (k, n) => dateToKey(new Date(keyToDate(k).getTime() + n * 86400000));
const weekOf = (k) => addDays(k, -((keyToDate(k).getUTCDay() + 6) % 7));        // Monday of that week
const monthOf = (k) => k.slice(0, 7);
const addMonths = (m, n) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + n; const d = new Date(Date.UTC(y, mo, 1)); return d.toISOString().slice(0, 7); };
const dayLabel = (k) => MONTHS[+k.slice(5, 7) - 1] + ' ' + (+k.slice(8, 10));

function series(timestamps, at) {
  const today = laDay(at || new Date());
  const byDay = new Map();
  (timestamps || []).forEach(t => { const k = laDay(t); if (k) byDay.set(k, (byDay.get(k) || 0) + 1); });
  const sumRange = (from, to) => { let n = 0; for (const [k, v] of byDay) if (k >= from && k <= to) n += v; return n; };
  const day = [];
  for (let i = 29; i >= 0; i--) { const k = addDays(today, -i); day.push({ key: k, label: dayLabel(k), n: byDay.get(k) || 0 }); }
  const thisWeek = weekOf(today), week = [];
  for (let i = 11; i >= 0; i--) { const k = addDays(thisWeek, -7 * i); week.push({ key: k, label: dayLabel(k), n: sumRange(k, addDays(k, 6)) }); }
  const thisMonth = monthOf(today), month = [];
  for (let i = 11; i >= 0; i--) {
    const m = addMonths(thisMonth, -i);
    month.push({ key: m, label: MONTHS[+m.slice(5, 7) - 1] + (m.slice(5, 7) === '01' || i === 11 ? ' ' + m.slice(0, 4) : ''), n: sumRange(m + '-01', m + '-31') });
  }
  const lastWeek = addDays(thisWeek, -7), lastMonth = addMonths(thisMonth, -1);
  return { day: day, week: week, month: month, now: {
    today: byDay.get(today) || 0, yesterday: byDay.get(addDays(today, -1)) || 0,
    week: sumRange(thisWeek, today), last_week: sumRange(lastWeek, addDays(lastWeek, 6)),
    month: sumRange(thisMonth + '-01', today), last_month: sumRange(lastMonth + '-01', lastMonth + '-31') } };
}
// Rows created since this many days ago are enough for 12 months of buckets.
const SINCE = "datetime('now', '-400 days')";
// The start of this Los Angeles month / week as a SQLite UTC timestamp (for "this month" counts in SQL).
function startOf(unit) {
  const today = laDay(new Date());
  const k = unit === 'week' ? weekOf(today) : monthOf(today) + '-01';
  // Midnight in LA of that day, in UTC: try both offsets and keep the one that lands on that LA day.
  for (const off of [7, 8]) {
    const d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10), off));
    if (laDay(d) === k && laDay(new Date(d.getTime() - 1000)) !== k) return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  return k + ' 07:00:00';
}

module.exports = { series, laDay, SINCE, startOf };
