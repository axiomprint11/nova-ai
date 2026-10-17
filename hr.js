// NovaHR (1.20.167) — one place for the AxiomPrint team: clock in / out (web, kiosk PIN or QR badge), timesheets, schedule
// adherence, time off, the company tree, annual reviews, skills and languages, reward points and the HR settings.
//
// Everything lives in Nova's SQLite (hr_* tables). The CRM is READ-ONLY here, as everywhere in Nova:
//   - staff come from CRM `user` (type member): names, emails, phones, legal name, birthday, start date, photo, title and the four
//     access flags (isSubmitter / view_all_projects / mail_enabled / view_products — shown, never changed: they are CRM permissions).
//     A field edited in NovaHR is kept in `nova_edited` and the CRM sync no longer overwrites it.
//   - the company tree is seeded from CRM `department` + `team` (lead_ids / members JSON); a department or team edited in Nova is
//     marked `edited` and the next sync leaves it alone.
// Never read: password_hash, auth_key, token, password_reset_token.
//
// Business rules follow docs (the owner's spec "Axiom HR: Developer Handoff"): punches in UTC; shifts in the person's local hours
// (end > 24 = overnight); a punch belongs to the shift-day of (punch − (shift start − 6 h)); worked = in→break/out + back→break/out,
// minus the unpaid break when none was punched and the day is over 6 h; adherence = first in / last out against the shift with
// grace / earlyGrace / lateAlert; attendance points per week with a streak bonus; leave days = the person's work days minus their
// location's holidays.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function mountHr(app, deps) {
  const { db, auth, serveVersionedHtml, runQuery, sendMail, Notify, closedDays, version } = deps;
  const SECRET = process.env.JWT_SECRET || 'nova-hr-dev';
  const FILES = process.env.HR_FILES_DIR || path.join(__dirname, 'hr-files');
  const dbAll = (sql, p) => new Promise((res, rej) => db.all(sql, p || [], (e, r) => e ? rej(e) : res(r || [])));
  const dbGet = (sql, p) => new Promise((res, rej) => db.get(sql, p || [], (e, r) => e ? rej(e) : res(r)));
  const dbRun = (sql, p) => new Promise((res, rej) => db.run(sql, p || [], function (e) { e ? rej(e) : res(this); }));
  const nowIso = () => new Date().toISOString();
  const str = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n || 200) : null; };
  const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
  const errlog = (w, m) => console.error('[hr] ' + w + ': ' + m);
  const who = (req) => String((req.user && (req.user.key || req.user.username)) || 'unknown').replace(/^(member|user):/, '');
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(String(s)).digest('hex');
  const PIN_KEY = hmac(SECRET, 'novahr-pin-v1'), BADGE_KEY = hmac(SECRET, 'novahr-badge-v1'), TICKET_KEY = hmac(SECRET, 'novahr-ticket-v1'), KIOSK_KEY = hmac(SECRET, 'novahr-kiosk-v1');
  const staffPhoto = (ph) => !ph ? null : /^https?:\/\//.test(ph) || /^data:image\//.test(ph) ? ph : 'https://axiomprint.s3.us-west-1.amazonaws.com/MemberImages/' + String(ph).replace(/^\/+/, '');

  const LOC = {
    gl: { name: 'Glendale', tz: 'America/Los_Angeles', note: 'Glendale, CA office' },
    am: { name: 'Armenia', tz: 'Asia/Yerevan', note: 'Remote, Yerevan time' },
    mx: { name: 'Mexico', tz: 'America/Mexico_City', note: 'Remote, Mexico City time' },
    ph: { name: 'Philippines', tz: 'Asia/Manila', note: 'Remote, Manila time' }
  };
  const LOCS = Object.keys(LOC);
  const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#2563eb', '#0d9488', '#ea580c', '#9333ea', '#16a34a', '#e11d48', '#0284c7', '#65a30d'];
  const ROLES = ['Admin', 'Production', 'Prepress', 'Sales', 'Customer Service', 'Accounting', 'Marketing', 'Office'];

  // ---------------- tables ----------------
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS hr_employees (id INTEGER PRIMARY KEY AUTOINCREMENT, crm_user_id INTEGER UNIQUE,
      first_name TEXT, last_name TEXT, work_email TEXT, work_phone TEXT, username TEXT, hire_date TEXT, role TEXT, title TEXT,
      status TEXT DEFAULT 'Active', account_type TEXT DEFAULT 'Member', department_id INTEGER, employment_type TEXT, reports_to INTEGER,
      location TEXT DEFAULT 'gl', shift_start REAL, shift_end REAL, shift_days TEXT DEFAULT '1,2,3,4,5',
      perm_submitter INTEGER DEFAULT 0, perm_all_projects INTEGER DEFAULT 0, perm_mail INTEGER DEFAULT 0, perm_products INTEGER DEFAULT 0,
      legal_first TEXT, legal_last TEXT, personal_email TEXT, personal_phone TEXT, birth_date TEXT, address TEXT, city_state_zip TEXT,
      photo_url TEXT, emergency_name TEXT, emergency_rel TEXT, emergency_phone TEXT,
      pay_type TEXT, pay_rate REAL, pay_method TEXT, commission_pct REAL DEFAULT 0,
      color TEXT, pin_hash TEXT, pin_set_at TEXT, badge_ver INTEGER DEFAULT 1, nova_edited TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT, updated_by TEXT)`);
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS hr_emp_pin ON hr_employees(pin_hash)');
    db.run(`CREATE TABLE IF NOT EXISTS hr_departments (id INTEGER PRIMARY KEY AUTOINCREMENT, crm_id INTEGER, name TEXT, color TEXT, sort INTEGER DEFAULT 0, edited INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0)`);
    db.run('CREATE TABLE IF NOT EXISTS hr_dept_heads (department_id INTEGER, employee_id INTEGER, name TEXT, title TEXT, sort INTEGER DEFAULT 0)');
    db.run(`CREATE TABLE IF NOT EXISTS hr_teams (id INTEGER PRIMARY KEY AUTOINCREMENT, crm_id INTEGER, department_id INTEGER, name TEXT, sort INTEGER DEFAULT 0, edited INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0)`);
    db.run('CREATE TABLE IF NOT EXISTS hr_team_people (team_id INTEGER, employee_id INTEGER, name TEXT, title TEXT, is_lead INTEGER DEFAULT 0, sort INTEGER DEFAULT 0)');
    db.run(`CREATE TABLE IF NOT EXISTS hr_punches (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, type TEXT, at TEXT, source TEXT DEFAULT 'web',
      ip TEXT, note TEXT, kiosk_id INTEGER, by TEXT, lat REAL, lng REAL, voided INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    db.run('CREATE INDEX IF NOT EXISTS hr_punch_e ON hr_punches(employee_id, at)');
    db.run('CREATE TABLE IF NOT EXISTS hr_ts_weeks (employee_id INTEGER, week_start TEXT, approved_by TEXT, approved_at TEXT, PRIMARY KEY (employee_id, week_start))');
    db.run(`CREATE TABLE IF NOT EXISTS hr_ts_fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, work_date TEXT, hours REAL, reason TEXT, fixed_by TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS hr_holidays (id INTEGER PRIMARY KEY AUTOINCREMENT, location TEXT, date TEXT, name TEXT, created_by TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS hr_leave (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, type TEXT, start_date TEXT, end_date TEXT, half_day INTEGER DEFAULT 0,
      days REAL, note TEXT, status TEXT DEFAULT 'pending', decided_by TEXT, decided_at TEXT, decision_note TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run('CREATE TABLE IF NOT EXISTS hr_leave_adjust (employee_id INTEGER, type TEXT, year INTEGER, allowance REAL, used_before REAL, carried REAL, note TEXT, updated_by TEXT, PRIMARY KEY (employee_id, type, year))');
    db.run(`CREATE TABLE IF NOT EXISTS hr_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER, employee_id INTEGER, reviewer_id INTEGER, stage TEXT DEFAULT 'none',
      self_text TEXT, strengths TEXT, growth TEXT, goals TEXT, scores TEXT, self_at TEXT, completed_at TEXT, completed_by TEXT, updated_at TEXT, UNIQUE (year, employee_id))`);
    db.run('CREATE TABLE IF NOT EXISTS hr_emp_skills (employee_id INTEGER, skill TEXT, level INTEGER, updated_by TEXT, updated_at TEXT, PRIMARY KEY (employee_id, skill))');
    db.run('CREATE TABLE IF NOT EXISTS hr_emp_langs (employee_id INTEGER, lang TEXT, level INTEGER, PRIMARY KEY (employee_id, lang))');
    db.run(`CREATE TABLE IF NOT EXISTS hr_checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, week_start TEXT, manager TEXT, attendance_points INTEGER,
      cats TEXT, category_points INTEGER, total_points INTEGER, note TEXT, why TEXT, sent_at TEXT, UNIQUE (employee_id, week_start))`);
    db.run(`CREATE TABLE IF NOT EXISTS hr_points (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, points INTEGER, kind TEXT, reason TEXT, ref_id INTEGER,
      given_by TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS hr_redemptions (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, item TEXT, item_name TEXT, points INTEGER,
      status TEXT DEFAULT 'requested', decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS hr_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, name TEXT, kind TEXT, status TEXT, file TEXT, mime TEXT, size INTEGER,
      uploaded_by TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS hr_pay_history (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, effective_date TEXT, pay_type TEXT, pay_rate REAL,
      reason TEXT, changed_by TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS hr_kiosks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, location TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')),
      revoked_at TEXT, last_seen TEXT, last_ip TEXT)`);
    db.run('CREATE TABLE IF NOT EXISTS hr_settings (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TEXT)');
    db.run(`CREATE TABLE IF NOT EXISTS hr_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, entity TEXT, entity_id INTEGER, action TEXT, before_json TEXT, after_json TEXT,
      at TEXT DEFAULT (datetime('now')))`);
    db.run('CREATE TABLE IF NOT EXISTS hr_meta (key TEXT PRIMARY KEY, value TEXT)');
  });
  try { fs.mkdirSync(FILES, { recursive: true }); } catch (e) {}
  async function audit(actor, entity, id, action, before, after) {
    try { await dbRun('INSERT INTO hr_audit (actor, entity, entity_id, action, before_json, after_json) VALUES (?,?,?,?,?,?)', [actor, entity, id || null, action, before == null ? null : JSON.stringify(before).slice(0, 8000), after == null ? null : JSON.stringify(after).slice(0, 8000)]); } catch (e) { errlog('audit', e.message); }
  }
  const meta = async (k) => { const r = await dbGet('SELECT value FROM hr_meta WHERE key = ?', [k]); return r ? r.value : null; };
  const setMeta = (k, v) => dbRun('INSERT INTO hr_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(v)]);

  // ---------------- settings ----------------
  const all = (n) => ({ gl: n, am: n, mx: n, ph: n });
  const DEFAULTS = {
    attendance: { grace: 5, earlyGrace: 5, lateAlert: 15, round: 5, breakMin: 30, otWeekly: 40, otDailyCA: true, autoOut: false },
    rewards: {
      perfectWeek: 20, latePenalty: 5, missedPenalty: 10, streakWeeks: 4, streakBonus: 50, weeklyCap: 100,
      cats: [{ k: 'quality', n: 'Quality work', p: 10 }, { k: 'extra', n: 'Went the extra mile', p: 15 }, { k: 'team', n: 'Helped a teammate', p: 10 }, { k: 'catch', n: 'Caught an error before print', p: 25 }, { k: 'client', n: 'Customer praise', p: 15 }],
      catalog: [{ k: 'gift25', n: '$25 gift card', p: 300 }, { k: 'pto1', n: 'Paid day off', p: 500, leave: 'vac', days: 1 }, { k: 'bonus150', n: '$150 bonus', p: 1000 }]
    },
    leave_types: [
      { k: 'vac', n: 'Vacation', paid: true, track: true, on: true, allow: { gl: 10, am: 12, mx: 12, ph: 12 }, accrual: 'Up front', carry: 5, notice: 14 },
      { k: 'sick', n: 'Sick', paid: true, track: true, on: true, allow: all(5), accrual: 'Up front', carry: 0, notice: 0 },
      { k: 'pers', n: 'Personal', paid: true, track: true, on: true, allow: all(2), accrual: 'Up front', carry: 0, notice: 3 },
      { k: 'bereave', n: 'Bereavement', paid: true, track: false, on: true, allow: all(3), accrual: 'As needed', carry: 0, notice: 0 },
      { k: 'unpaid', n: 'Unpaid', paid: false, track: false, on: true, allow: all(0), accrual: 'As needed', carry: 0, notice: 7 }
    ],
    skills: [
      { k: 'prep', n: 'File prep & preflight', g: 'Prepress' }, { k: 'impose', n: 'Imposition', g: 'Prepress' }, { k: 'design', n: 'Design', g: 'Prepress' }, { k: 'cad', n: 'CAD / die lines', g: 'Prepress' },
      { k: 'digital', n: 'Digital press', g: 'Production' }, { k: 'roll', n: 'Roll label press', g: 'Production' }, { k: 'lf', n: 'Large format print', g: 'Production' },
      { k: 'lam', n: 'Lamination', g: 'Production' }, { k: 'die', n: 'Die cutting / foiling', g: 'Production' }, { k: 'bind', n: 'Bindery & cutting', g: 'Production' },
      { k: 'install', n: 'Sign installation', g: 'Production' }, { k: 'ful', n: 'Packing & shipping', g: 'Production' },
      { k: 'cs', n: 'Customer support', g: 'Office' }, { k: 'crm', n: 'CRM & order entry', g: 'Office' }, { k: 'books', n: 'Bookkeeping', g: 'Office' }
    ],
    skill_levels: ['Not trained', 'Learning', 'Needs help', 'Independent', 'Can train others'],
    languages: { list: [{ k: 'en', n: 'English' }, { k: 'hy', n: 'Armenian' }, { k: 'es', n: 'Spanish' }, { k: 'ru', n: 'Russian' }, { k: 'tl', n: 'Tagalog' }, { k: 'ko', n: 'Korean' }], levels: ['Basic', 'Conversational', 'Fluent', 'Native'] },
    review: {
      year: new Date().getFullYear(), due: new Date().getFullYear() + '-12-15',
      areas: [
        { k: 'quality', n: 'Quality of work', d: 'Accuracy, attention to detail, fewer reprints' },
        { k: 'speed', n: 'Productivity & turnaround', d: 'Hits due dates, keeps jobs moving' },
        { k: 'comm', n: 'Communication', d: 'Clear notes, timely updates to team and clients' },
        { k: 'rel', n: 'Reliability & attendance', d: 'On time, follows through, owns mistakes' },
        { k: 'team', n: 'Teamwork', d: 'Helps others, shares knowledge, covers gaps' },
        { k: 'tech', n: 'Technical skills', d: 'Equipment, software, and process knowledge' }
      ]
    },
    clock: { pin_len: 4, gl_web: 'allow', office_ips: '', badge_pin: false, remote_web: 'allow' },
    org: { ceo_name: 'Gary Bayatyan', ceo_title: 'CEO' }
  };
  const settings = JSON.parse(JSON.stringify(DEFAULTS));
  async function loadSettings() {
    const rows = await dbAll('SELECT key, value FROM hr_settings');
    rows.forEach(r => { try { const v = JSON.parse(r.value); if (DEFAULTS[r.key] && !Array.isArray(DEFAULTS[r.key]) && typeof v === 'object' && !Array.isArray(v)) settings[r.key] = Object.assign({}, DEFAULTS[r.key], v); else settings[r.key] = v; } catch (e) {} });
  }
  async function saveSetting(key, value, by) {
    settings[key] = value;
    await dbRun("INSERT INTO hr_settings (key, value, updated_by, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", [key, JSON.stringify(value), by]);
  }
  const leaveType = (k) => (settings.leave_types || []).find(t => t.k === k);

  // ---------------- time helpers ----------------
  const fmtCache = {};
  function parts(ms, tz) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' }));
    const o = {}; f.formatToParts(new Date(ms)).forEach(x => { o[x.type] = x.value; });
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (p) => p.y + '-' + pad(p.mo) + '-' + pad(p.d);
  const localDate = (ms, tz) => ymd(parts(ms, tz));
  const tzOffset = (ms, tz) => { const p = parts(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
  function zoned(day, hours, tz) {
    const [y, m, d] = day.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d) + Math.round(hours * 3600000);
    const off = tzOffset(guess, tz); let t = guess - off;
    const off2 = tzOffset(t, tz); if (off2 !== off) t = guess - off2;
    return t;
  }
  const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const weekday = (day) => { const w = new Date(day + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
  const mondayOf = (day) => addDays(day, 1 - weekday(day));
  const todayLA = () => localDate(Date.now(), LOC.gl.tz);
  const tzOf = (e) => (LOC[e.location] || LOC.gl).tz;
  const shiftOf = (e) => { const s = e.shift_start == null ? 9 : Number(e.shift_start), en = e.shift_end == null ? s + 9 : Number(e.shift_end); return [s, en > s ? en : en + 24]; };
  const shiftDays = (e) => String(e.shift_days || '1,2,3,4,5').split(',').map(Number).filter(x => x >= 1 && x <= 7);
  const shiftDayOf = (ms, e) => localDate(ms - (shiftOf(e)[0] - 6) * 3600000, tzOf(e));
  const todayFor = (e) => shiftDayOf(Date.now(), e);

  // ---------------- holidays ----------------
  const DEFAULT_HOLIDAYS = [
    ['2026-11-01', 'ph', 'All Saints Day'], ['2026-11-16', 'mx', 'Revolution Day'], ['2026-11-26', 'gl', 'Thanksgiving'], ['2026-11-27', 'gl', 'Day after Thanksgiving'],
    ['2026-11-30', 'ph', 'Bonifacio Day'], ['2026-12-24', 'gl', 'Christmas Eve'], ['2026-12-25', 'gl', 'Christmas'], ['2026-12-25', 'mx', 'Christmas'], ['2026-12-25', 'ph', 'Christmas'],
    ['2026-12-30', 'ph', 'Rizal Day'], ['2026-12-31', 'am', 'New Year holiday'], ['2027-01-01', 'gl', 'New Year'], ['2027-01-01', 'am', 'New Year'], ['2027-01-01', 'mx', 'New Year'], ['2027-01-01', 'ph', 'New Year'],
    ['2027-01-02', 'am', 'New Year holiday'], ['2027-01-06', 'am', 'Armenian Christmas']
  ];
  let holidays = [];
  async function loadHolidays() { holidays = await dbAll('SELECT id, location, date, name FROM hr_holidays ORDER BY date'); }
  // Glendale also follows the website's closed days (CRM `holidays`, closed-days.js) — shown as "from the website"
  function holidayList(from, to) {
    const out = holidays.filter(h => (!from || h.date >= from) && (!to || h.date <= to)).map(h => ({ id: h.id, location: h.location, date: h.date, name: h.name, src: 'nova' }));
    if (closedDays && closedDays.ready && closedDays.ready()) {
      const have = new Set(out.filter(h => h.location === 'gl').map(h => h.date));
      (closedDays.upcoming(450) || []).concat(pastClosed(from)).forEach(c => {
        if ((from && c.date < from) || (to && c.date > to) || have.has(c.date)) return;
        const w = weekday(c.date); if (w >= 6) return;
        have.add(c.date); out.push({ id: null, location: 'gl', date: c.date, name: c.name, src: 'website' });
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  function pastClosed(from) {
    if (!closedDays || !closedDays.yearSet || !from) return [];
    const out = []; const y0 = +from.slice(0, 4), y1 = +todayLA().slice(0, 4);
    for (let y = y0; y <= y1; y++) { const s = closedDays.yearSet(y); if (s) s.forEach(d => { if (d >= from && d < todayLA()) out.push({ date: d, name: closedDays.name(d) || 'Closed' }); }); }
    return out;
  }
  let holCache = { at: 0, map: null };
  function holidaySet() {
    if (holCache.map && Date.now() - holCache.at < 60000) return holCache.map;
    const m = {}; LOCS.forEach(l => { m[l] = new Set(); });
    holidayList(addDays(todayLA(), -400), addDays(todayLA(), 500)).forEach(h => { if (m[h.location]) m[h.location].add(h.date); });
    holCache = { at: Date.now(), map: m }; return m;
  }
  const isHoliday = (loc, day) => !!(holidaySet()[loc] || new Set()).has(day);
  const isWorkday = (e, day) => shiftDays(e).indexOf(weekday(day)) > -1 && !isHoliday(e.location || 'gl', day);
  function leaveDays(e, from, to, half) {
    let n = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkday(e, d)) n++;
    return half ? Math.min(n, 0.5) : n;
  }

  // ---------------- employees in memory ----------------
  let EMP = [], byId = {}, byCrm = {}, kids = {};
  async function loadEmployees() {
    EMP = await dbAll('SELECT * FROM hr_employees ORDER BY first_name, last_name');
    byId = {}; byCrm = {}; kids = {};
    EMP.forEach(e => { byId[e.id] = e; if (e.crm_user_id) byCrm[e.crm_user_id] = e; });
    EMP.forEach(e => { if (e.reports_to && byId[e.reports_to]) (kids[e.reports_to] = kids[e.reports_to] || []).push(e.id); });
    liveCache.at = 0;
  }
  const fullName = (e) => [e.first_name, e.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || e.work_email || 'Employee ' + e.id;
  const active = () => EMP.filter(e => e.status !== 'Inactive');
  function chainOf(id) {
    const out = new Set(), stack = (kids[id] || []).slice();
    while (stack.length) { const k = stack.pop(); if (out.has(k)) continue; out.add(k); (kids[k] || []).forEach(x => stack.push(x)); }
    return out;
  }

  // who is looking: employee row, admin / manager scope
  async function viewer(req) {
    const key = String((req.user && req.user.key) || '');
    const email = key.indexOf('member:') === 0 ? key.slice(7).toLowerCase() : null;
    let me = null, isAdm = !!(req.user && req.user.is_admin);
    if (email) {
      me = EMP.find(e => String(e.work_email || '').toLowerCase() === email) || null;
      const m = await dbGet('SELECT axiom_user_id, is_admin FROM members WHERE LOWER(email) = ?', [email]).catch(() => null);
      if (m && m.is_admin) isAdm = true;
      if (!me && m && m.axiom_user_id && byCrm[m.axiom_user_id]) me = byCrm[m.axiom_user_id];
    }
    if (me && me.account_type === 'Admin') isAdm = true;
    const scope = me ? chainOf(me.id) : new Set();
    const isMgr = !isAdm && !!me && (me.account_type === 'Manager' || scope.size > 0);
    return { me, admin: isAdm, manager: isMgr, scope, email, key, name: me ? fullName(me) : (req.user && req.user.username) || 'admin' };
  }
  const canPrivate = (v, e) => v.admin || (v.me && v.me.id === e.id) || v.scope.has(e.id);
  const canManage = (v, e) => v.admin || v.scope.has(e.id);
  const isLead = (v) => v.admin || v.manager;

  // ---------------- punches & status ----------------
  const liveCache = { at: 0, map: {} };
  async function lastPunches() {
    if (liveCache.at && Date.now() - liveCache.at < 30000) return liveCache.map;
    const since = new Date(Date.now() - 40 * 3600000).toISOString();
    const rows = await dbAll('SELECT id, employee_id, type, at, source FROM hr_punches WHERE voided = 0 AND at >= ? ORDER BY at', [since]);
    const map = {}; rows.forEach(r => { (map[r.employee_id] = map[r.employee_id] || []).push(r); });
    liveCache.at = Date.now(); liveCache.map = map; return map;
  }
  let leaveToday = { at: 0, map: {} };
  async function approvedLeaveMap() {
    if (leaveToday.at && Date.now() - leaveToday.at < 60000) return leaveToday.map;
    const rows = await dbAll("SELECT * FROM hr_leave WHERE status = 'approved' AND end_date >= ?", [addDays(todayLA(), -2)]);
    const map = {}; rows.forEach(r => { (map[r.employee_id] = map[r.employee_id] || []).push(r); });
    leaveToday = { at: Date.now(), map }; return map;
  }
  function stateFrom(list, e) {
    const day = todayFor(e);
    const mine = (list || []).filter(p => shiftDayOf(Date.parse(p.at), e) === day);
    const last = (list || [])[(list || []).length - 1];
    let state = 'off';
    if (last && Date.now() - Date.parse(last.at) < 16 * 3600000) state = (last.type === 'in' || last.type === 'back') ? 'working' : last.type === 'break' ? 'break' : 'off';
    return { state, today: mine, last };
  }
  async function liveStatus() {
    const pm = await lastPunches(), lm = await approvedLeaveMap();
    const out = {};
    EMP.forEach(e => {
      const s = stateFrom(pm[e.id], e); const day = todayFor(e);
      const out1 = (lm[e.id] || []).find(r => r.start_date <= day && r.end_date >= day && !r.half_day);
      out[e.id] = { status: s.state === 'off' && out1 ? 'pto' : s.state, punches: s.today.map(p => ({ type: p.type, at: p.at, source: p.source })), worked: workedMs(s.today, true) / 3600000 };
    });
    return out;
  }
  function roundMs(ms) { const r = Number(settings.attendance.round) || 0; if (!r) return ms; const step = r * 60000; return Math.round(ms / step) * step; }
  // worked time of one shift-day's punches (breaks out); open = count up to now when `live`
  function workedMs(list, live) {
    let ms = 0, start = null, broke = false;
    (list || []).forEach(p => {
      const t = roundMs(Date.parse(p.at));
      if (p.type === 'in' || p.type === 'back') { if (start == null) start = t; }
      else { if (p.type === 'break') broke = true; if (start != null) { ms += Math.max(0, t - start); start = null; } }
    });
    if (start != null && live) ms += Math.max(0, Date.now() - start);
    if (!broke && ms > 6 * 3600000) ms -= (Number(settings.attendance.breakMin) || 0) * 60000;
    return Math.max(0, ms);
  }
  async function punchesBetween(ids, fromDay, toDay) {
    const from = new Date(Date.parse(fromDay + 'T00:00:00Z') - 36 * 3600000).toISOString(), to = new Date(Date.parse(toDay + 'T00:00:00Z') + 60 * 3600000).toISOString();
    const rows = await dbAll('SELECT * FROM hr_punches WHERE voided = 0 AND at >= ? AND at < ?' + (ids ? ' AND employee_id IN (' + ids.map(Number).join(',') + ')' : '') + ' ORDER BY at', [from, to]);
    const map = {}; rows.forEach(r => { const e = byId[r.employee_id]; if (!e) return; const d = shiftDayOf(Date.parse(r.at), e); const k = r.employee_id + '|' + d; (map[k] = map[k] || []).push(r); });
    return map;
  }
  let firstPunch = { at: 0, map: {} };
  async function firstPunchDays() {
    if (firstPunch.at && Date.now() - firstPunch.at < 120000) return firstPunch.map;
    const rows = await dbAll('SELECT employee_id, MIN(at) AS at FROM hr_punches WHERE voided = 0 GROUP BY employee_id');
    const map = {}; rows.forEach(r => { const e = byId[r.employee_id]; if (e) map[r.employee_id] = shiftDayOf(Date.parse(r.at), e); });
    firstPunch = { at: Date.now(), map }; return map;
  }

  // one person's day: what the timesheet and adherence read
  function dayRecord(e, day, ctx) {
    const today = todayFor(e), [s0, s1] = shiftOf(e);
    const fix = ctx.fixes[e.id + '|' + day];
    const lv = (ctx.leave[e.id] || []).find(r => r.start_date <= day && r.end_date >= day && r.status === 'approved');
    const list = ctx.punches[e.id + '|' + day] || [];
    const work = isWorkday(e, day), hol = isHoliday(e.location || 'gl', day);
    const tracked = ctx.first[e.id] && day >= ctx.first[e.id] && (!e.hire_date || day >= e.hire_date);
    const r = { day, kind: 'none', h: null, scheduled: work && !!tracked && !(lv && !lv.half_day), punches: list.map(p => ({ id: p.id, type: p.type, at: p.at, source: p.source, note: p.note })) };
    if (lv) { r.leave = { type: lv.type, half: !!lv.half_day, id: lv.id }; }
    if (fix) { r.kind = 'fixed'; r.h = fix.hours; r.fix = { hours: fix.hours, reason: fix.reason, by: fix.fixed_by }; return r; }
    if (day > today) { r.kind = lv ? 'pto' : hol ? 'holiday' : 'future'; if (lv && !lv.half_day) r.h = leaveType(lv.type) && leaveType(lv.type).paid ? 8 : 0; return r; }
    if (list.length) {
      const last = list[list.length - 1], open = last.type !== 'out';
      if (open && day < today) { r.kind = 'missed'; r.h = null; r.open_since = last.at; }
      else { r.kind = open ? 'live' : 'ok'; r.h = Math.round(workedMs(list, open) / 36000) / 100; }
      const ins = list.filter(p => p.type === 'in'), outs = list.filter(p => p.type === 'out');
      if (ins.length) r.inD = Math.round((Date.parse(ins[0].at) - zoned(day, s0, tzOf(e))) / 60000);
      if (outs.length && !open) r.outD = Math.round((Date.parse(outs[outs.length - 1].at) - zoned(day, s1, tzOf(e))) / 60000);
      if (lv && lv.half_day && r.h != null) r.h += 4;
      return r;
    }
    if (lv) { r.kind = 'pto'; r.h = lv.half_day ? 4 : (leaveType(lv.type) && leaveType(lv.type).paid ? 8 : 0); return r; }
    if (hol) { r.kind = 'holiday'; r.h = 0; return r; }
    if (day === today) { r.kind = 'today'; return r; }
    if (r.scheduled) { r.kind = 'absent'; return r; }
    r.kind = work ? 'none' : 'off'; r.h = work ? null : 0; return r;
  }
  async function ctxFor(ids, from, to) {
    const punches = await punchesBetween(ids, from, to);
    const fx = await dbAll('SELECT * FROM hr_ts_fixes WHERE work_date >= ? AND work_date <= ? ORDER BY id', [from, to]);
    const fixes = {}; fx.forEach(f => { fixes[f.employee_id + '|' + f.work_date] = f; });
    const lv = await dbAll("SELECT * FROM hr_leave WHERE status = 'approved' AND end_date >= ? AND start_date <= ?", [from, to]);
    const leave = {}; lv.forEach(r => { (leave[r.employee_id] = leave[r.employee_id] || []).push(r); });
    return { punches, fixes, leave, first: await firstPunchDays() };
  }
  // adherence class of a scheduled past day
  function classify(r) {
    const A = settings.attendance;
    if (r.kind === 'missed' || r.kind === 'absent') return 'missed';
    if (r.inD == null) return null;
    if (r.inD > A.grace) return r.inD > A.lateAlert ? 'vlate' : 'late';
    if (r.outD != null && r.outD < -A.earlyGrace) return 'early';
    return 'ok';
  }
  function adhOf(e, days, ctx) {
    const recs = [];
    days.forEach(d => { if (d >= todayFor(e)) return; const r = dayRecord(e, d, ctx); if (!r.scheduled || r.kind === 'fixed' || r.kind === 'pto') return; const k = classify(r); if (k) recs.push({ day: d, k, inD: r.inD, outD: r.outD, punches: r.punches }); });
    const c = { ok: 0, late: 0, vlate: 0, early: 0, missed: 0 }; let lateMin = 0;
    recs.forEach(r => { c[r.k]++; if (r.k === 'late' || r.k === 'vlate') lateMin += r.inD; });
    const n = recs.length, lates = c.late + c.vlate;
    return Object.assign({ recs, n, lates, avgLate: lates ? Math.round(lateMin / lates) : 0, score: n ? Math.round(c.ok / n * 100) : 100 }, c);
  }
  const weekDays = (ws) => [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i));
  function attPoints(e, ws, ctx) {
    const R = settings.rewards, a = adhOf(e, weekDays(ws), ctx);
    if (!a.n) return { pts: 0, a, why: 'No scheduled shifts', streak: false, neutral: true };
    const perfect = !a.lates && !a.missed && !a.early;
    let pts = perfect ? R.perfectWeek : Math.max(0, R.perfectWeek - (a.lates + a.early) * R.latePenalty - a.missed * R.missedPenalty);
    let streak = false;
    if (perfect && R.streakWeeks > 0) {
      let c = 1;
      for (let i = 1; i < 26; i++) { const w = adhOf(e, weekDays(addDays(ws, -7 * i)), ctx); if (!w.n) continue; if (w.lates || w.missed || w.early) break; c++; }
      if (c % R.streakWeeks === 0) { streak = true; pts += R.streakBonus; }
    }
    const parts = []; if (a.lates) parts.push(a.lates + ' late'); if (a.early) parts.push(a.early + ' left early'); if (a.missed) parts.push(a.missed + ' missed punch');
    return { pts, a: { n: a.n, lates: a.lates, early: a.early, missed: a.missed }, streak, why: perfect ? a.n + ' of ' + a.n + ' on time' : parts.join(', ') };
  }

  // ---------------- balances ----------------
  async function balancesFor(e, year) {
    year = year || +todayLA().slice(0, 4);
    const rows = await dbAll("SELECT type, status, days, start_date FROM hr_leave WHERE employee_id = ? AND status IN ('approved','pending') AND substr(start_date, 1, 4) = ?", [e.id, String(year)]);
    const adj = await dbAll('SELECT * FROM hr_leave_adjust WHERE employee_id = ? AND year = ?', [e.id, year]);
    const out = [];
    (settings.leave_types || []).filter(t => t.on).forEach(t => {
      const a = adj.find(x => x.type === t.k) || {};
      let allowance = a.allowance != null ? Number(a.allowance) : Number((t.allow || {})[e.location || 'gl']) || 0;
      if (t.accrual === 'Monthly' && a.allowance == null) {
        const start = e.hire_date && e.hire_date.slice(0, 4) === String(year) ? +e.hire_date.slice(5, 7) : 1;
        const m = +todayLA().slice(0, 4) > year ? 12 : +todayLA().slice(5, 7);
        allowance = Math.round(allowance * Math.max(0, m - start + 1) / 12 * 2) / 2;
      }
      allowance += Number(a.carried) || 0;
      const used = rows.filter(r => r.type === t.k && r.status === 'approved').reduce((s, r) => s + (Number(r.days) || 0), 0) + (Number(a.used_before) || 0);
      const pending = rows.filter(r => r.type === t.k && r.status === 'pending').reduce((s, r) => s + (Number(r.days) || 0), 0);
      out.push({ k: t.k, n: t.n, track: !!t.track, paid: !!t.paid, allowance, used, pending, left: Math.round((allowance - used) * 2) / 2, carried: Number(a.carried) || 0, used_before: Number(a.used_before) || 0, override: a.allowance != null ? Number(a.allowance) : null, accrual: t.accrual });
    });
    return out;
  }

  // ---------------- profile completeness ----------------
  const REQ = [['first_name', 'Work first name'], ['last_name', 'Work last name'], ['work_email', 'Work email'], ['work_phone', 'Work phone'], ['username', 'Username'], ['hire_date', 'Start date'],
    ['role', 'Role'], ['title', 'Title'], ['status', 'Status'], ['account_type', 'Type'], ['legal_first', 'Legal first name'], ['legal_last', 'Legal last name'], ['personal_email', 'Personal email'],
    ['personal_phone', 'Personal phone'], ['birth_date', 'Birthday'], ['address', 'Home address'], ['city_state_zip', 'City, state, zip'], ['emergency_name', 'Emergency contact'],
    ['emergency_phone', 'Emergency phone'], ['photo_url', 'Profile photo'], ['pay_rate', 'Pay rate'], ['pay_method', 'Paid through']];
  function missing(e, langs) {
    const req = (e.role === 'Customer Service' || e.role === 'Sales') ? REQ.concat([['commission_pct', 'Commission percent']]) : REQ;
    const miss = req.filter(([k]) => { const v = e[k]; return v == null || v === '' || (k === 'pay_rate' && !Number(v)) || (k === 'commission_pct' && !Number(v)); });
    if (!langs || !langs.length) miss.unshift(['langs', 'Languages spoken']);
    return { miss, total: req.length + 1 };
  }

  // ---------------- what a viewer may see of a person ----------------
  const PUBLIC = ['id', 'crm_user_id', 'first_name', 'last_name', 'title', 'department_id', 'location', 'status', 'photo_url', 'reports_to', 'hire_date', 'work_email', 'work_phone', 'shift_start', 'shift_end', 'shift_days', 'color', 'employment_type'];
  const PRIVATE = ['username', 'role', 'account_type', 'perm_submitter', 'perm_all_projects', 'perm_mail', 'perm_products', 'legal_first', 'legal_last', 'personal_email', 'personal_phone',
    'birth_date', 'address', 'city_state_zip', 'emergency_name', 'emergency_rel', 'emergency_phone', 'pay_type', 'pay_rate', 'pay_method', 'commission_pct', 'nova_edited', 'pin_set_at', 'badge_ver'];
  function shape(v, e, extra) {
    const o = {}; PUBLIC.forEach(k => { o[k] = e[k]; });
    o.name = fullName(e); o.color = e.color || COLORS[e.id % COLORS.length];
    o.bday = e.birth_date ? e.birth_date.slice(5, 10) : null;
    o.priv = canPrivate(v, e); o.can_manage = canManage(v, e);
    if (o.priv) { PRIVATE.forEach(k => { o[k] = e[k]; }); o.has_pin = !!e.pin_hash; }
    return Object.assign(o, extra || {});
  }

  // ---------------- CRM sync ----------------
  const TEST_RE = /\btest\b|webdev|\binfo\b|\binc\b|simple user|designer_l|destigner|machine/i;
  const locFrom = (u) => { const a = String(u.personal_phone_iso || '').toUpperCase(), b = String(u.phone_country_iso || '').toUpperCase(); for (const c of [a, b]) { if (c === 'AM') return 'am'; if (c === 'MX') return 'mx'; if (c === 'PH') return 'ph'; } return 'gl'; };
  const goodDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); if (!m) return null; const y = +m[1]; if (y < 1930 || y > new Date().getFullYear() - 14) return null; return m[0]; };
  const goodStart = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m && +m[1] >= 2000 ? m[0] : null; };
  // CRM-owned columns and the CRM value for each
  const CRM_F = {
    first_name: u => str(u.name, 64), last_name: u => str(u.last_name, 64), work_email: u => str(u.email, 191), work_phone: u => str([u.phone, u.extension ? 'ext. ' + u.extension : ''].filter(Boolean).join(' '), 40),
    username: u => str(u.username, 64), hire_date: u => goodStart(u.ws), title: u => str(u.title, 128), legal_first: u => str(u.legal_name, 64), legal_last: u => str(u.legal_last_name, 64),
    personal_email: u => str(u.personal_email, 191), personal_phone: u => str(u.personal_phone, 40), birth_date: u => goodDate(u.birthday), photo_url: u => staffPhoto(u.memberimage),
    commission_pct: u => u.commission == null ? null : Number(u.commission)
  };
  const PERM_F = { perm_submitter: 'isSubmitter', perm_all_projects: 'view_all_projects', perm_mail: 'mail_enabled', perm_products: 'view_products' };
  async function crmUsers() {
    return runQuery("SELECT id, username, email, personal_email, name, last_name, legal_name, legal_last_name, phone, extension, personal_phone, phone_country_iso, personal_phone_iso, memberimage, commission, isSubmitter, view_all_projects, view_products, mail_enabled, DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday, DATE_FORMAT(working_start_date, '%Y-%m-%d') AS ws, title, status, blocked_at FROM user WHERE type = 'member'");
  }
  const jsonIds = (v) => { if (Array.isArray(v)) return v.map(Number).filter(Boolean); try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(Number).filter(Boolean) : []; } catch (e) { return []; } };
  let syncing = null, syncedAt = 0, lastSync = null;
  async function syncCrm(force, by) {
    if (!runQuery) return { ok: false, error: 'no CRM' };
    if (syncing) return syncing;
    if (!force && Date.now() - syncedAt < 10 * 60000) return lastSync || { ok: true, cached: true };
    syncing = (async () => {
      const stats = { added: 0, updated: 0, inactive: 0 };
      try {
        const users = await crmUsers(); const um = {}; users.forEach(u => { um[u.id] = u; });
        const seeded = await meta('seeded_employees');
        const nova = await dbAll('SELECT email, is_admin FROM members');
        const novaAdmin = new Set(nova.filter(m => m.is_admin).map(m => String(m.email).toLowerCase()));
        // 1. update people already in NovaHR
        for (const e of EMP) {
          const u = e.crm_user_id && um[e.crm_user_id]; if (!u) continue;
          const edited = new Set(String(e.nova_edited || '').split(',').filter(Boolean));
          const set = {};
          Object.keys(CRM_F).forEach(k => { if (edited.has(k)) return; const v = CRM_F[k](u); if (v != null && v !== e[k]) set[k] = v; });
          Object.keys(PERM_F).forEach(k => { const v = Number(u[PERM_F[k]]) ? 1 : 0; if (v !== Number(e[k] || 0)) set[k] = v; });
          const crmActive = Number(u.status) === 10 && !u.blocked_at;
          if (!crmActive && e.status !== 'Inactive' && !edited.has('status')) { set.status = 'Inactive'; stats.inactive++; }
          if (Object.keys(set).length) { await updateEmp(e.id, set); stats.updated++; }
        }
        // 2. first run: everyone active in the CRM (test / system accounts left out)
        if (!seeded) {
          for (const u of users) {
            if (Number(u.status) !== 10 || u.blocked_at || byCrm[u.id]) continue;
            if (TEST_RE.test([u.name, u.last_name, u.username].join(' '))) continue;
            await insertFromCrm(u, novaAdmin); stats.added++;
          }
          await loadEmployees();
          await syncOrg(true, users);
          await placeFromOrg();
          await setMeta('seeded_employees', nowIso());
          await setMeta('go_live', todayLA());
        } else await syncOrg(false, users);
        await loadEmployees(); await loadDeptNames();
        syncedAt = Date.now(); lastSync = Object.assign({ ok: true, at: nowIso() }, stats);
        if (stats.added || stats.updated || stats.inactive) console.log('[hr] CRM sync: ' + JSON.stringify(stats));
        return lastSync;
      } catch (e) { errlog('crm sync', e.message); lastSync = { ok: false, error: e.message, at: nowIso() }; return lastSync; }
      finally { syncing = null; }
    })();
    return syncing;
  }
  async function insertFromCrm(u, novaAdmin) {
    const loc = locFrom(u);
    const row = { crm_user_id: u.id, location: loc, status: 'Active', account_type: novaAdmin && novaAdmin.has(String(u.email || '').toLowerCase()) ? 'Admin' : 'Member',
      employment_type: loc === 'gl' ? 'Full-time' : 'Contractor', pay_type: 'Hourly', pay_method: loc === 'gl' ? 'Direct deposit' : 'Wise (USD)', shift_days: '1,2,3,4,5' };
    Object.keys(CRM_F).forEach(k => { row[k] = CRM_F[k](u); });
    Object.keys(PERM_F).forEach(k => { row[k] = Number(u[PERM_F[k]]) ? 1 : 0; });
    // a remote person's default hours = Glendale 9–6 in their own time; Designer AI's hours win when set there
    const sh = await designerHours(u.id);
    const la = sh || [9, 18];
    const off = (tzOffset(Date.now(), LOC[loc].tz) - tzOffset(Date.now(), LOC.gl.tz)) / 3600000;
    let s = la[0] + off; while (s < 0) s += 24; while (s >= 24) s -= 24;
    row.shift_start = Math.round(s * 4) / 4; row.shift_end = row.shift_start + (la[1] - la[0]);
    const cols = Object.keys(row);
    const r = await dbRun('INSERT INTO hr_employees (' + cols.join(',') + ', color, updated_at) VALUES (' + cols.map(() => '?').join(',') + ',?,?)', cols.map(c => row[c]).concat([COLORS[u.id % COLORS.length], nowIso()]));
    return r.lastID;
  }
  async function designerHours(crmId) {
    try {
      const d = await dbGet('SELECT shift_start, shift_end FROM da_designers WHERE user_id = ?', [crmId]);
      const t = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] + (+m[2]) / 60 : null; };
      if (d && t(d.shift_start) != null && t(d.shift_end) != null) return [t(d.shift_start), t(d.shift_end)];
    } catch (e) {}
    return null;
  }
  async function updateEmp(id, set) {
    const cols = Object.keys(set); if (!cols.length) return;
    await dbRun('UPDATE hr_employees SET ' + cols.map(c => c + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?', cols.map(c => set[c]).concat([nowIso(), id]));
  }
  // the CRM tree → hr_departments / hr_teams (rows edited in Nova are left alone)
  async function syncOrg(first, users) {
    let depts = [], teams = [];
    try { depts = await runQuery('SELECT id, name, lead_ids, color FROM department ORDER BY id'); teams = await runQuery('SELECT id, name, lead_ids, members, department_id FROM team ORDER BY id'); }
    catch (e) { errlog('org read', e.message); return; }
    const um = {}; (users || []).forEach(u => { um[u.id] = u; });
    const person = (crmId) => { const e = byCrm[crmId]; if (e) return { employee_id: e.id, name: fullName(e), title: e.title || null }; const u = um[crmId]; return u ? { employee_id: null, name: [u.name, u.last_name].filter(Boolean).join(' ').trim(), title: str(u.title, 128) } : null; };
    let si = 0;
    for (const d of depts) {
      let row = await dbGet('SELECT * FROM hr_departments WHERE crm_id = ?', [d.id]);
      if (!row) { const r = await dbRun('INSERT INTO hr_departments (crm_id, name, color, sort) VALUES (?,?,?,?)', [d.id, str(d.name, 128), str(d.color, 9) || '#475569', si]); row = { id: r.lastID, edited: 0 }; }
      else if (!row.edited) await dbRun('UPDATE hr_departments SET name = ?, color = ? WHERE id = ?', [str(d.name, 128), str(d.color, 9) || row.color, row.id]);
      si++;
      if (row.edited) continue;
      await dbRun('DELETE FROM hr_dept_heads WHERE department_id = ?', [row.id]);
      let k = 0; for (const id of jsonIds(d.lead_ids)) { const p = person(id); if (p) await dbRun('INSERT INTO hr_dept_heads (department_id, employee_id, name, title, sort) VALUES (?,?,?,?,?)', [row.id, p.employee_id, p.name, p.title, k++]); }
    }
    let ti = 0;
    for (const t of teams) {
      const dep = await dbGet('SELECT id FROM hr_departments WHERE crm_id = ?', [t.department_id]);
      let row = await dbGet('SELECT * FROM hr_teams WHERE crm_id = ?', [t.id]);
      if (!row) { const r = await dbRun('INSERT INTO hr_teams (crm_id, department_id, name, sort) VALUES (?,?,?,?)', [t.id, dep ? dep.id : null, str(t.name, 128), ti]); row = { id: r.lastID, edited: 0 }; }
      else if (!row.edited) await dbRun('UPDATE hr_teams SET name = ?, department_id = ? WHERE id = ?', [str(t.name, 128), dep ? dep.id : row.department_id, row.id]);
      ti++;
      if (row.edited) continue;
      await dbRun('DELETE FROM hr_team_people WHERE team_id = ?', [row.id]);
      let k = 0;
      for (const id of jsonIds(t.lead_ids)) { const p = person(id); if (p) await dbRun('INSERT INTO hr_team_people (team_id, employee_id, name, title, is_lead, sort) VALUES (?,?,?,?,1,?)', [row.id, p.employee_id, p.name, p.title, k++]); }
      for (const id of jsonIds(t.members)) { const p = person(id); if (p) await dbRun('INSERT INTO hr_team_people (team_id, employee_id, name, title, is_lead, sort) VALUES (?,?,?,?,0,?)', [row.id, p.employee_id, p.name, p.title, k++]); }
    }
    // link names to people added later
    await dbRun('UPDATE hr_team_people SET employee_id = (SELECT e.id FROM hr_employees e WHERE LOWER(TRIM(e.first_name || \' \' || COALESCE(e.last_name, \'\'))) = LOWER(TRIM(hr_team_people.name))) WHERE employee_id IS NULL');
    await dbRun('UPDATE hr_dept_heads SET employee_id = (SELECT e.id FROM hr_employees e WHERE LOWER(TRIM(e.first_name || \' \' || COALESCE(e.last_name, \'\'))) = LOWER(TRIM(hr_dept_heads.name))) WHERE employee_id IS NULL');
  }
  // first run: department, role and manager from the tree (the first team a person is on; its lead is the manager)
  async function placeFromOrg() {
    const tp = await dbAll('SELECT p.*, t.department_id, d.name AS dept_name FROM hr_team_people p JOIN hr_teams t ON t.id = p.team_id LEFT JOIN hr_departments d ON d.id = t.department_id ORDER BY t.sort, p.sort');
    const heads = await dbAll('SELECT * FROM hr_dept_heads ORDER BY sort');
    const leadsOf = {}; tp.filter(p => p.is_lead && p.employee_id).forEach(p => { (leadsOf[p.team_id] = leadsOf[p.team_id] || []).push(p.employee_id); });
    const managers = new Set(tp.filter(p => p.is_lead && p.employee_id).map(p => p.employee_id).concat(heads.filter(h => h.employee_id).map(h => h.employee_id)));
    const roleFor = (dn, title) => /prepress|pre-press|design|cad/i.test(dn) ? 'Prepress' : /sales|customer/i.test(dn) ? (/account manager|sales/i.test(title || '') ? 'Sales' : 'Customer Service') : /finance|account/i.test(dn) ? 'Accounting' : /marketing/i.test(dn) ? 'Marketing' : /admin|human/i.test(dn) ? 'Office' : 'Production';
    for (const e of EMP) {
      const mine = tp.filter(p => p.employee_id === e.id);
      const pick = mine.find(p => !p.is_lead) || mine[0];
      const head = heads.find(h => h.employee_id === e.id);
      const set = {};
      if (head) { set.department_id = head.department_id; const d = await dbGet('SELECT name FROM hr_departments WHERE id = ?', [head.department_id]); set.role = roleFor((d && d.name) || '', e.title); }
      else if (pick) { set.department_id = pick.department_id; set.role = roleFor(pick.dept_name || '', e.title); const lead = (leadsOf[pick.team_id] || []).find(id => id !== e.id); if (lead) set.reports_to = lead; else { const h = heads.find(x => x.department_id === pick.department_id && x.employee_id && x.employee_id !== e.id); if (h) set.reports_to = h.employee_id; } }
      if (managers.has(e.id) && e.account_type === 'Member') set.account_type = 'Manager';
      if (Object.keys(set).length) await updateEmp(e.id, set);
    }
    // the CEO reports to no one; department heads report to the CEO
    const ceo = EMP.find(e => fullName(e).toLowerCase() === String(settings.org.ceo_name || '').toLowerCase());
    if (ceo) { await updateEmp(ceo.id, { reports_to: null }); for (const h of heads) if (h.employee_id && h.employee_id !== ceo.id) { const e = byId[h.employee_id]; if (e && (!e.reports_to || e.reports_to === h.employee_id)) await updateEmp(h.employee_id, { reports_to: ceo.id }); } }
    await loadEmployees();
  }

  // ---------------- boot ----------------
  const ready = (async () => {
    await new Promise(r => db.get('SELECT 1', [], () => r()));
    await loadSettings();
    if (!(await meta('seeded_holidays'))) { for (const h of DEFAULT_HOLIDAYS) await dbRun('INSERT INTO hr_holidays (location, date, name, created_by) VALUES (?,?,?,?)', [h[1], h[0], h[2], 'seed']); await setMeta('seeded_holidays', nowIso()); }
    await loadHolidays(); await loadEmployees();
    syncCrm(false, 'boot').catch(e => errlog('boot sync', e.message));
  })().catch(e => errlog('boot', e.message));
  setInterval(() => { syncCrm(false, 'timer').catch(() => {}); }, 15 * 60000).unref();

  // ---------------- notifications ----------------
  if (Notify) {
    Notify.register('hr.leave', () => 'the manager (requests) / the employee (decisions)');
    Notify.register('hr.late', () => 'the person’s manager');
    Notify.register('hr.missed', () => 'the person and their manager');
    Notify.register('hr.checkin', () => 'the employee');
    Notify.register('hr.review', () => 'the people with a self-review due');
    Notify.register('hr.redeem', () => process.env.HR_ALERT_TO || 'gary@axiomprint.com');
  }
  const BASE = process.env.PUBLIC_BASE_URL || 'https://nova.axiomprint.com';
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function mail(kind, to, subject, lines, link) {
    if (!sendMail || !to) return { skipped: true };
    if (Notify && !Notify.on(kind)) return { off: true };
    if (kind === 'hr.redeem' && Notify) to = Notify.to(kind, to);
    const html = '<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#1e1b2e;line-height:1.5">' + lines.map(l => '<p style="margin:0 0 10px">' + l + '</p>').join('') +
      (link ? '<p style="margin:16px 0 0"><a href="' + BASE + link + '" style="background:#4f46e5;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none;font-weight:600">Open NovaHR</a></p>' : '') +
      '<p style="margin:18px 0 0;color:#8b88a3;font-size:12px">NovaHR · AxiomPrint</p></div>';
    try { await sendMail({ to, subject, html, text: lines.map(l => l.replace(/<[^>]+>/g, '')).join('\n\n') }); return { ok: true }; }
    catch (e) { errlog('mail ' + kind, e.message); return { ok: false, error: e.message }; }
  }
  const emailOf = (e) => e && (e.work_email || e.personal_email);
  const managerOf = (e) => e && e.reports_to ? byId[e.reports_to] : null;

  // ---------------- guards ----------------
  const guard = [auth, async (req, res, next) => { await ready; req.hr = await viewer(req); next(); }];
  const adminGuard = [...guard, (req, res, next) => req.hr.admin ? next() : res.status(403).json({ ok: false, error: 'HR admins only' })];
  const leadGuard = [...guard, (req, res, next) => isLead(req.hr) ? next() : res.status(403).json({ ok: false, error: 'Managers and HR only' })];
  const empOr404 = (req, res) => { const e = byId[parseInt(req.params.id)]; if (!e) { res.status(404).json({ ok: false, error: 'No such person' }); return null; } return e; };

  // ---------------- pages ----------------
  app.get('/hr', serveVersionedHtml('hr.html'));
  app.get('/hr/kiosk', serveVersionedHtml('hr-kiosk.html'));

  // ---------------- state: everything the page draws ----------------
  app.get('/api/hr/state', ...guard, async (req, res) => {
    try {
      syncCrm(false).catch(() => {});
      const v = req.hr, live = await liveStatus();
      const skills = await dbAll('SELECT employee_id, skill, level FROM hr_emp_skills');
      const langs = await dbAll('SELECT employee_id, lang, level FROM hr_emp_langs');
      const pts = await dbAll('SELECT employee_id, SUM(points) AS p FROM hr_points GROUP BY employee_id');
      const sk = {}, lg = {}, pp = {};
      skills.forEach(r => { (sk[r.employee_id] = sk[r.employee_id] || {})[r.skill] = r.level; });
      langs.forEach(r => { (lg[r.employee_id] = lg[r.employee_id] || {})[r.lang] = r.level; });
      pts.forEach(r => { pp[r.employee_id] = Number(r.p) || 0; });
      const list = (req.query.all === '1' && isLead(v) ? EMP : active()).map(e => {
        const o = shape(v, e, { live: live[e.id], skills: sk[e.id] || {}, langs: lg[e.id] || {}, points: pp[e.id] || 0 });
        if (o.priv) { const m = missing(e, Object.keys(lg[e.id] || {})); o.missing = m.miss; o.req_total = m.total; }
        return o;
      });
      const from = addDays(todayLA(), -62), to = addDays(todayLA(), 400);
      const lv = await dbAll("SELECT * FROM hr_leave WHERE end_date >= ? AND start_date <= ? AND status IN ('pending','approved','declined') ORDER BY start_date", [addDays(todayLA(), -370), to]);
      const leave = lv.filter(r => byId[r.employee_id]).filter(r => r.status !== 'declined' || canPrivate(v, byId[r.employee_id])).filter(r => r.end_date >= from || canPrivate(v, byId[r.employee_id])).map(r => {
        const p = canPrivate(v, byId[r.employee_id]);
        return { id: r.id, employee_id: r.employee_id, type: r.type, start_date: r.start_date, end_date: r.end_date, half_day: !!r.half_day, days: r.days, status: r.status,
          note: p ? r.note : null, decision_note: p ? r.decision_note : null, decided_by: p ? r.decided_by : null, created_at: r.created_at, can_decide: r.status === 'pending' && canManage(v, byId[r.employee_id]) && !(v.me && v.me.id === r.employee_id && !v.admin) };
      });
      const yr = settings.review.year;
      const rv = await dbAll('SELECT * FROM hr_reviews WHERE year = ?', [yr]);
      const reviews = {}; rv.forEach(r => { const e = byId[r.employee_id]; if (e && canPrivate(v, e)) reviews[r.employee_id] = reviewOut(r, v); });
      const feed = await dbAll("SELECT * FROM hr_points ORDER BY id DESC LIMIT 200");
      const ledger = feed.filter(p => byId[p.employee_id]).filter(p => p.kind === 'shoutout' || canPrivate(v, byId[p.employee_id])).slice(0, 80);
      const red = await dbAll('SELECT * FROM hr_redemptions ORDER BY id DESC LIMIT 100');
      const redemptions = red.filter(r => byId[r.employee_id] && (v.admin || (v.me && v.me.id === r.employee_id)));
      const pendingFor = leave.filter(r => r.can_decide).length;
      res.json({
        ok: true, version, today: todayLA(), now: nowIso(),
        me: v.me ? shape(v, v.me, { live: live[v.me.id], skills: sk[v.me.id] || {}, langs: lg[v.me.id] || {}, points: pp[v.me.id] || 0 }) : null,
        viewer: { admin: v.admin, manager: v.manager, name: v.name, scope: Array.from(v.scope), email: v.email },
        employees: list, org: await orgOut(), settings: publicSettings(v), locations: LOC, roles: ROLES,
        holidays: holidayList(addDays(todayLA(), -200), addDays(todayLA(), 420)),
        leave, reviews, ledger, redemptions, counts: { pending_leave: pendingFor },
        balances: v.me ? await balancesFor(v.me) : null,
        sync: lastSync, go_live: await meta('go_live')
      });
    } catch (e) { errlog('state', e.stack || e.message); res.status(500).json({ ok: false, error: e.message }); }
  });
  function publicSettings(v) {
    const s = JSON.parse(JSON.stringify(settings));
    if (!v.admin) { delete s.clock.office_ips; }
    return s;
  }
  async function orgOut() {
    const d = await dbAll('SELECT * FROM hr_departments WHERE hidden = 0 ORDER BY sort, id');
    const h = await dbAll('SELECT * FROM hr_dept_heads ORDER BY sort');
    const t = await dbAll('SELECT * FROM hr_teams WHERE hidden = 0 ORDER BY sort, id');
    const p = await dbAll('SELECT * FROM hr_team_people ORDER BY is_lead DESC, sort');
    const ceo = EMP.find(e => fullName(e).toLowerCase() === String(settings.org.ceo_name || '').toLowerCase());
    const per = (x) => ({ employee_id: x.employee_id || null, name: x.employee_id && byId[x.employee_id] ? fullName(byId[x.employee_id]) : x.name, title: x.title || (x.employee_id && byId[x.employee_id] ? byId[x.employee_id].title : null) });
    return {
      ceo: { employee_id: ceo ? ceo.id : null, name: settings.org.ceo_name, title: settings.org.ceo_title },
      depts: d.map(x => ({ id: x.id, crm_id: x.crm_id, name: x.name, color: x.color || '#475569', edited: !!x.edited,
        heads: h.filter(y => y.department_id === x.id).map(per),
        teams: t.filter(y => y.department_id === x.id).map(y => ({ id: y.id, crm_id: y.crm_id, name: y.name, edited: !!y.edited,
          leads: p.filter(z => z.team_id === y.id && z.is_lead).map(per), members: p.filter(z => z.team_id === y.id && !z.is_lead).map(per) })) }))
    };
  }
  function reviewOut(r, v) {
    const e = byId[r.employee_id];
    let scores = {}; try { scores = JSON.parse(r.scores || '{}'); } catch (x) {}
    const mgrView = v.admin || v.scope.has(r.employee_id);
    const vals = (settings.review.areas || []).map(a => scores[a.k]).filter(x => x);
    const avg = vals.length === (settings.review.areas || []).length && vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const showMgr = mgrView || r.stage === 'done';
    return { id: r.id, year: r.year, employee_id: r.employee_id, reviewer_id: r.reviewer_id || (e && e.reports_to) || null, stage: r.stage, self_text: r.self_text, self_at: r.self_at,
      strengths: showMgr ? r.strengths : null, growth: showMgr ? r.growth : null, goals: showMgr ? r.goals : null, scores: showMgr ? scores : {}, avg: showMgr ? avg : 0, completed_at: r.completed_at, completed_by: r.completed_by };
  }

  // one person in full (the drawer)
  app.get('/api/hr/employees/:id', ...guard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const v = req.hr;
    const out = { ok: true, employee: shape(v, e) };
    if (canPrivate(v, e)) {
      out.balances = await balancesFor(e);
      out.leave = (await dbAll('SELECT * FROM hr_leave WHERE employee_id = ? ORDER BY start_date DESC LIMIT 60', [e.id]));
      out.pay_history = await dbAll('SELECT * FROM hr_pay_history WHERE employee_id = ? ORDER BY effective_date DESC, id DESC', [e.id]);
      out.docs = (await dbAll('SELECT id, name, kind, status, mime, size, uploaded_by, created_at FROM hr_docs WHERE employee_id = ? ORDER BY id DESC', [e.id]));
      out.reviews = (await dbAll('SELECT * FROM hr_reviews WHERE employee_id = ? ORDER BY year DESC', [e.id])).map(r => reviewOut(r, v));
      out.points = await dbAll('SELECT * FROM hr_points WHERE employee_id = ? ORDER BY id DESC LIMIT 50', [e.id]);
      out.adjust = await dbAll('SELECT * FROM hr_leave_adjust WHERE employee_id = ? AND year = ?', [e.id, +todayLA().slice(0, 4)]);
    }
    res.json(out);
  });

  // ---------------- people: add / edit ----------------
  const WORK_F = ['first_name', 'last_name', 'work_email', 'work_phone', 'username', 'hire_date', 'role', 'title', 'status'];
  const JOB_F = ['department_id', 'employment_type', 'reports_to', 'location', 'shift_start', 'shift_end', 'shift_days'];
  const SELF_F = ['legal_first', 'legal_last', 'personal_email', 'personal_phone', 'birth_date', 'address', 'city_state_zip', 'emergency_name', 'emergency_rel', 'emergency_phone'];
  const PAY_F = ['pay_type', 'pay_rate', 'pay_method', 'commission_pct'];
  const OPTS = { status: ['Active', 'On leave', 'Inactive'], account_type: ['Member', 'Manager', 'Admin'], employment_type: ['Full-time', 'Part-time', 'Contractor'], pay_type: ['Hourly', 'Salary'], pay_method: ['Direct deposit', 'Wise (USD)', 'Check'], role: ROLES };
  function cleanField(k, v) {
    if (v === '' || v == null) return null;
    if (OPTS[k]) return OPTS[k].indexOf(String(v)) > -1 ? String(v) : undefined;
    if (k === 'location') return LOC[v] ? v : undefined;
    if (['department_id', 'reports_to'].indexOf(k) > -1) { const n = parseInt(v); return isFinite(n) && n > 0 ? n : null; }
    if (['shift_start', 'shift_end', 'pay_rate', 'commission_pct'].indexOf(k) > -1) { const n = num(v); return n == null ? null : n; }
    if (k === 'shift_days') { const d = String(v).split(',').map(Number).filter(x => x >= 1 && x <= 7); return d.length ? Array.from(new Set(d)).sort().join(',') : undefined; }
    if (['hire_date', 'birth_date'].indexOf(k) > -1) return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined;
    if (/email/.test(k)) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? String(v).trim().toLowerCase() : undefined;
    return str(v, k === 'address' ? 255 : 128);
  }
  app.post('/api/hr/employees/:id', ...guard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const v = req.hr, b = req.body || {};
    const self = v.me && v.me.id === e.id, mgr = canManage(v, e);
    if (!self && !mgr) return res.status(403).json({ ok: false, error: 'Not yours to change' });
    const allowed = new Set(SELF_F.concat(mgr ? WORK_F.concat(JOB_F, PAY_F) : []));
    if (v.admin) allowed.add('account_type');
    const set = {}, bad = [];
    Object.keys(b).forEach(k => { if (!allowed.has(k)) return; const c = cleanField(k, b[k]); if (c === undefined) bad.push(k); else if (c !== e[k]) set[k] = c; });
    if (bad.length) return res.status(400).json({ ok: false, error: 'Check: ' + bad.join(', ') });
    if (set.reports_to) { if (set.reports_to === e.id || chainOf(e.id).has(set.reports_to)) return res.status(400).json({ ok: false, error: 'That would make a loop in who reports to whom' }); }
    if (set.shift_start != null || set.shift_end != null) { const s = set.shift_start != null ? set.shift_start : e.shift_start, en = set.shift_end != null ? set.shift_end : e.shift_end; if (s != null && (s < 0 || s >= 24)) return res.status(400).json({ ok: false, error: 'Shift start is an hour of the day' }); if (en != null && s != null && en <= s) set.shift_end = en + 24; }
    if (!Object.keys(set).length) return res.json({ ok: true, unchanged: true });
    const edited = new Set(String(e.nova_edited || '').split(',').filter(Boolean)); Object.keys(set).forEach(k => { if (CRM_F[k] || k === 'status') edited.add(k); });
    set.nova_edited = Array.from(edited).join(',') || null; set.updated_by = who(req);
    if ((set.pay_rate != null && set.pay_rate !== e.pay_rate) || (set.pay_type && set.pay_type !== e.pay_type)) {
      await dbRun('INSERT INTO hr_pay_history (employee_id, effective_date, pay_type, pay_rate, reason, changed_by) VALUES (?,?,?,?,?,?)', [e.id, str(b.pay_effective, 10) || todayLA(), set.pay_type || e.pay_type, set.pay_rate != null ? set.pay_rate : e.pay_rate, str(b.pay_reason, 200) || (e.pay_rate ? 'Change' : 'Starting pay'), who(req)]);
    }
    const before = {}; Object.keys(set).forEach(k => { before[k] = e[k]; });
    await updateEmp(e.id, set); await audit(who(req), 'employee', e.id, 'update', PAY_F.some(k => k in set) ? Object.assign(before, { pay_rate: before.pay_rate != null ? '[pay]' : null }) : before, set);
    await loadEmployees();
    res.json({ ok: true, employee: shape(v, byId[e.id]) });
  });
  app.post('/api/hr/employees/:id/reset-field', ...adminGuard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const k = String((req.body || {}).field || '');
    const edited = new Set(String(e.nova_edited || '').split(',').filter(Boolean)); edited.delete(k);
    await updateEmp(e.id, { nova_edited: Array.from(edited).join(',') || null }); await loadEmployees(); syncedAt = 0; await syncCrm(true);
    res.json({ ok: true });
  });
  app.post('/api/hr/employees', ...leadGuard, async (req, res) => {
    const b = req.body || {}, v = req.hr;
    if (b.crm_user_id) {
      const id = parseInt(b.crm_user_id); if (byCrm[id]) return res.json({ ok: false, error: 'Already in NovaHR' });
      const u = (await crmUsers()).find(x => x.id === id); if (!u) return res.json({ ok: false, error: 'No such CRM user' });
      const nid = await insertFromCrm(u, null); await loadEmployees();
      const set = { reports_to: v.me ? v.me.id : null }; if (b.department_id) set.department_id = parseInt(b.department_id); await updateEmp(nid, set); await loadEmployees();
      await audit(who(req), 'employee', nid, 'add_from_crm', null, { crm_user_id: id });
      return res.json({ ok: true, id: nid });
    }
    const name = str(b.name, 120); if (!name) return res.json({ ok: false, error: 'Enter a name' });
    const parts2 = name.split(' '), loc = LOC[b.location] ? b.location : 'gl';
    const row = { first_name: parts2[0], last_name: parts2.slice(1).join(' ') || null, title: str(b.title, 128) || 'New hire', department_id: parseInt(b.department_id) || null, location: loc,
      work_email: cleanField('work_email', b.work_email) || null, hire_date: cleanField('hire_date', b.hire_date) || todayLA(), pay_type: 'Hourly', pay_rate: num(b.pay_rate),
      pay_method: loc === 'gl' ? 'Direct deposit' : 'Wise (USD)', employment_type: loc === 'gl' ? 'Full-time' : 'Contractor', status: 'Active', account_type: 'Member',
      reports_to: parseInt(b.reports_to) || (v.me ? v.me.id : null), shift_start: 9, shift_end: 18, shift_days: '1,2,3,4,5', username: parts2[0].toLowerCase(), updated_by: who(req) };
    const cols = Object.keys(row);
    const r = await dbRun('INSERT INTO hr_employees (' + cols.join(',') + ', color, updated_at) VALUES (' + cols.map(() => '?').join(',') + ',?,?)', cols.map(c => row[c]).concat([COLORS[Math.floor(Math.random() * COLORS.length)], nowIso()]));
    if (row.pay_rate) await dbRun('INSERT INTO hr_pay_history (employee_id, effective_date, pay_type, pay_rate, reason, changed_by) VALUES (?,?,?,?,?,?)', [r.lastID, row.hire_date, 'Hourly', row.pay_rate, 'Starting pay', who(req)]);
    await audit(who(req), 'employee', r.lastID, 'add', null, Object.assign({}, row, { pay_rate: row.pay_rate ? '[pay]' : null }));
    await loadEmployees();
    res.json({ ok: true, id: r.lastID });
  });
  app.get('/api/hr/crm-staff', ...leadGuard, async (req, res) => {
    try {
      const users = await crmUsers();
      res.json({ ok: true, staff: users.filter(u => Number(u.status) === 10 && !u.blocked_at && !byCrm[u.id]).map(u => ({ id: u.id, name: [u.name, u.last_name].filter(Boolean).join(' ').trim(), title: u.title || '', email: u.email, photo: staffPhoto(u.memberimage), location: locFrom(u), test: TEST_RE.test([u.name, u.last_name, u.username].join(' ')) })) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/hr/sync', ...adminGuard, async (req, res) => { syncedAt = 0; res.json(await syncCrm(true, who(req))); });

  // photo: a small square picture made in the browser (data URL, ≤ 250 KB) — the CRM photo stays the default
  app.post('/api/hr/employees/:id/photo', ...guard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const v = req.hr;
    if (!(v.me && v.me.id === e.id) && !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Not yours to change' });
    const url = (req.body || {}).photo;
    if (url && !(/^data:image\/(jpeg|png|webp);base64,/.test(url) && url.length < 250000)) return res.json({ ok: false, error: 'A JPEG or PNG under 250 KB' });
    const edited = new Set(String(e.nova_edited || '').split(',').filter(Boolean)); if (url) edited.add('photo_url'); else edited.delete('photo_url');
    await updateEmp(e.id, { photo_url: url || null, nova_edited: Array.from(edited).join(',') || null }); await loadEmployees();
    if (!url) { syncedAt = 0; syncCrm(true).catch(() => {}); }
    await audit(who(req), 'employee', e.id, url ? 'photo' : 'photo_removed', null, null);
    res.json({ ok: true });
  });

  // ---------------- PIN and badge ----------------
  const pinHash = (pin) => hmac(PIN_KEY, String(pin));
  const WEAK = /^(\d)\1+$|^0123|^1234|^2345|^3456|^4567|^5678|^6789|^9876|^4321|^1212|^1004|^2000|^1111/;
  async function pinFree(pin, exceptId) { const r = await dbGet('SELECT id FROM hr_employees WHERE pin_hash = ?', [pinHash(pin)]); return !r || r.id === exceptId; }
  app.post('/api/hr/employees/:id/pin', ...guard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const v = req.hr, b = req.body || {};
    const self = v.me && v.me.id === e.id;
    if (!self && !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Not yours to change' });
    const len = Math.min(6, Math.max(4, parseInt(settings.clock.pin_len) || 4));
    if (b.clear) { if (!canManage(v, e)) return res.status(403).json({ ok: false, error: 'Only a manager can clear a PIN' }); await updateEmp(e.id, { pin_hash: null, pin_set_at: null }); await loadEmployees(); await audit(who(req), 'employee', e.id, 'pin_cleared'); return res.json({ ok: true }); }
    let pin = b.pin != null ? String(b.pin).trim() : null;
    if (pin != null) {
      if (!new RegExp('^\\d{' + len + ',6}$').test(pin)) return res.json({ ok: false, error: 'The PIN is ' + len + (len < 6 ? ' to 6' : '') + ' digits' });
      if (WEAK.test(pin)) return res.json({ ok: false, error: 'Too easy to guess — avoid repeats and runs like 1234' });
      if (!(await pinFree(pin, e.id))) return res.json({ ok: false, error: 'Someone already has that PIN — pick another' });
    } else {
      for (let i = 0; i < 200 && pin == null; i++) { const c = String(crypto.randomInt(0, 10 ** len)).padStart(len, '0'); if (!WEAK.test(c) && await pinFree(c, e.id)) pin = c; }
      if (pin == null) return res.json({ ok: false, error: 'Could not find a free PIN — make PINs longer in HR settings' });
    }
    await updateEmp(e.id, { pin_hash: pinHash(pin), pin_set_at: nowIso() }); await loadEmployees();
    await audit(who(req), 'employee', e.id, b.pin != null ? 'pin_set' : 'pin_generated');
    res.json({ ok: true, pin, shown_once: true });
  });
  const badgeSig = (id, ver) => hmac(BADGE_KEY, id + '.' + ver).slice(0, 12).toUpperCase();
  const badgeCode = (e) => 'NHR-' + e.id + '-' + (e.badge_ver || 1) + '-' + badgeSig(e.id, e.badge_ver || 1);
  function fromBadge(code) {
    const m = /NHR-(\d+)-(\d+)-([0-9A-F]{12})/i.exec(String(code || '')); if (!m) return null;
    const e = byId[+m[1]]; if (!e || Number(e.badge_ver || 1) !== +m[2]) return null;
    const want = badgeSig(+m[1], +m[2]); if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3].toUpperCase()))) return null;
    return e;
  }
  app.post('/api/hr/badges', ...leadGuard, async (req, res) => {
    const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(Number);
    const v = req.hr;
    const list = (ids.length ? ids.map(i => byId[i]).filter(Boolean) : active()).filter(e => canManage(v, e) || (v.me && v.me.id === e.id));
    await audit(who(req), 'badge', null, 'print', null, { n: list.length });
    res.json({ ok: true, badges: list.map(e => ({ id: e.id, name: fullName(e), first_name: e.first_name, title: e.title, photo: e.photo_url, color: e.color, location: (LOC[e.location] || LOC.gl).name, dept: deptName(e.department_id), code: badgeCode(e), ver: e.badge_ver || 1 })) });
  });
  app.post('/api/hr/employees/:id/badge-reissue', ...leadGuard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; if (!canManage(req.hr, e)) return res.status(403).json({ ok: false, error: 'Not your report' });
    await updateEmp(e.id, { badge_ver: (e.badge_ver || 1) + 1 }); await loadEmployees(); await audit(who(req), 'employee', e.id, 'badge_reissued');
    res.json({ ok: true, ver: byId[e.id].badge_ver });
  });
  let deptCache = {};
  const deptName = (id) => deptCache[id] || null;
  async function loadDeptNames() { const d = await dbAll('SELECT id, name FROM hr_departments'); deptCache = {}; d.forEach(x => { deptCache[x.id] = x.name; }); }
  ready.then(loadDeptNames).catch(() => {});

  // ---------------- clocking in ----------------
  const NEXT = { off: ['in'], working: ['break', 'out'], break: ['back', 'out'] };
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 45);
  async function doPunch(e, type, opt) {
    const pm = await lastPunches(); const s = stateFrom(pm[e.id], e);
    if ((NEXT[s.state] || ['in']).indexOf(type) < 0) return { ok: false, error: s.state === 'working' ? 'Already clocked in' : s.state === 'break' ? 'On a break — end the break or clock out' : 'Not clocked in yet', state: s.state };
    const at = nowIso();
    const r = await dbRun('INSERT INTO hr_punches (employee_id, type, at, source, ip, note, kiosk_id, by, lat, lng) VALUES (?,?,?,?,?,?,?,?,?,?)', [e.id, type, at, opt.source || 'web', opt.ip || null, opt.note || null, opt.kiosk_id || null, opt.by || null, num(opt.lat), num(opt.lng)]);
    liveCache.at = 0; firstPunch.at = 0; setTimeout(() => api.warm(), 50);
    if (type === 'in') lateCheck(e, at).catch(x => errlog('late', x.message));
    const state = type === 'in' || type === 'back' ? 'working' : type === 'break' ? 'break' : 'off';
    const pm2 = await lastPunches(); const today = stateFrom(pm2[e.id], e).today;
    return { ok: true, id: r.lastID, type, at, state, worked: workedMs(today, true) / 3600000, punches: today.map(p => ({ type: p.type, at: p.at })) };
  }
  async function lateCheck(e, at) {
    const day = shiftDayOf(Date.parse(at), e); if (!isWorkday(e, day)) return;
    const first = (await punchesBetween([e.id], day, day))[e.id + '|' + day] || [];
    if (first.filter(p => p.type === 'in').length !== 1) return;
    const late = Math.round((Date.parse(at) - zoned(day, shiftOf(e)[0], tzOf(e))) / 60000);
    if (late <= (Number(settings.attendance.lateAlert) || 15)) return;
    const m = managerOf(e); if (!m || !emailOf(m)) return;
    await mail('hr.late', emailOf(m), fullName(e) + ' clocked in ' + late + ' min late', ['<b>' + escH(fullName(e)) + '</b> clocked in at ' + new Date(at).toLocaleTimeString('en-US', { timeZone: tzOf(e), hour: 'numeric', minute: '2-digit' }) + ' ' + (LOC[e.location] || LOC.gl).name + ' time — ' + late + ' minutes after the shift start.', 'You may want to check in with them.'], '/hr?tab=time&sub=adh');
  }
  function webAllowed(e, req) {
    const C = settings.clock || {};
    if (e.location === 'gl') {
      if (C.gl_web === 'kiosk') return 'Glendale staff clock in at the time clock by the door';
      const ips = String(C.office_ips || '').split(/[\s,]+/).filter(Boolean);
      if (ips.length && ips.indexOf(ipOf(req)) < 0) return 'Clock in from the office network or the time clock';
    } else if (C.remote_web === 'off') return 'Clocking in from the web is switched off';
    return null;
  }
  app.post('/api/hr/punch', ...guard, async (req, res) => {
    const v = req.hr, b = req.body || {};
    if (!v.me) return res.json({ ok: false, error: 'You are not in NovaHR yet — ask HR to add you' });
    const type = String(b.type || ''); if (['in', 'break', 'back', 'out'].indexOf(type) < 0) return res.json({ ok: false, error: 'Unknown punch' });
    const blocked = webAllowed(v.me, req); if (blocked) return res.json({ ok: false, error: blocked });
    res.json(await doPunch(v.me, type, { source: b.source === 'mobile' ? 'mobile' : 'web', ip: ipOf(req), by: who(req), lat: b.lat, lng: b.lng }));
  });

  // ---------------- kiosk (a shared tablet at the door) ----------------
  const kioskToken = (id) => { const p = 'k' + id + '.' + crypto.randomBytes(9).toString('hex'); return p + '.' + hmac(KIOSK_KEY, p).slice(0, 32); };
  async function kioskOf(req) {
    const t = String(req.headers['x-hr-kiosk'] || '');
    const m = /^k(\d+)\.([0-9a-f]+)\.([0-9a-f]{32})$/.exec(t); if (!m) return null;
    const want = hmac(KIOSK_KEY, 'k' + m[1] + '.' + m[2]).slice(0, 32);
    if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3]))) return null;
    const k = await dbGet('SELECT * FROM hr_kiosks WHERE id = ? AND revoked_at IS NULL', [+m[1]]); if (!k) return null;
    if (!k.last_seen || Date.now() - Date.parse(k.last_seen + 'Z') > 60000) dbRun("UPDATE hr_kiosks SET last_seen = datetime('now'), last_ip = ? WHERE id = ?", [ipOf(req), k.id]).catch(() => {});
    return k;
  }
  const kioskGuard = async (req, res, next) => { await ready; const k = await kioskOf(req); if (!k) return res.status(401).json({ ok: false, error: 'This device is not a NovaHR time clock (or it was switched off)' }); req.kiosk = k; next(); };
  app.post('/api/hr/kiosks', ...adminGuard, async (req, res) => {
    const b = req.body || {};
    const r = await dbRun('INSERT INTO hr_kiosks (name, location, created_by) VALUES (?,?,?)', [str(b.name, 60) || 'Time clock', LOC[b.location] ? b.location : 'gl', who(req)]);
    await audit(who(req), 'kiosk', r.lastID, 'create', null, { name: b.name });
    res.json({ ok: true, id: r.lastID, token: kioskToken(r.lastID) });
  });
  app.get('/api/hr/kiosks', ...adminGuard, async (req, res) => res.json({ ok: true, kiosks: await dbAll('SELECT * FROM hr_kiosks ORDER BY id DESC') }));
  app.post('/api/hr/kiosks/:id/revoke', ...adminGuard, async (req, res) => { await dbRun("UPDATE hr_kiosks SET revoked_at = datetime('now') WHERE id = ?", [parseInt(req.params.id)]); await audit(who(req), 'kiosk', parseInt(req.params.id), 'revoke'); res.json({ ok: true }); });
  const tries = {};
  function locked(kid) { const t = tries[kid]; return t && t.until && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0; }
  function failed(kid) { const t = tries[kid] = tries[kid] || { n: 0, first: Date.now() }; if (Date.now() - t.first > 60000) { t.n = 0; t.first = Date.now(); } t.n++; if (t.n >= 5) { t.until = Date.now() + 60000; t.n = 0; t.first = Date.now(); } }
  const ticket = (eid, kid) => { const exp = Date.now() + 90000; const p = eid + '.' + kid + '.' + exp; return p + '.' + hmac(TICKET_KEY, p).slice(0, 24); };
  function fromTicket(t, kid) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.([0-9a-f]{24})$/.exec(String(t || '')); if (!m) return null;
    if (+m[2] !== kid || +m[3] < Date.now()) return null;
    if (hmac(TICKET_KEY, m[1] + '.' + m[2] + '.' + m[3]).slice(0, 24) !== m[4]) return null;
    return byId[+m[1]] || null;
  }
  async function kioskPerson(e) {
    const pm = await lastPunches(); const s = stateFrom(pm[e.id], e);
    const lm = await approvedLeaveMap(); const day = todayFor(e);
    return { id: e.id, name: fullName(e), first_name: e.first_name, title: e.title, photo: e.photo_url, color: e.color, state: s.state, next: NEXT[s.state] || ['in'],
      worked: workedMs(s.today, true) / 3600000, punches: s.today.map(p => ({ type: p.type, at: p.at })), on_leave: !!(lm[e.id] || []).find(r => r.start_date <= day && r.end_date >= day), shift: shiftOf(e), tz: tzOf(e) };
  }
  app.get('/api/hr/kiosk/hello', kioskGuard, (req, res) => res.json({ ok: true, kiosk: { id: req.kiosk.id, name: req.kiosk.name, location: req.kiosk.location, tz: (LOC[req.kiosk.location] || LOC.gl).tz }, pin_len: Math.min(6, Math.max(4, parseInt(settings.clock.pin_len) || 4)), badge_pin: !!settings.clock.badge_pin, version }));
  app.post('/api/hr/kiosk/identify', kioskGuard, async (req, res) => {
    const k = req.kiosk, b = req.body || {}, wait = locked(k.id);
    if (wait) return res.json({ ok: false, error: 'Too many wrong tries — wait ' + wait + ' s', locked: wait });
    let e = null, need = false;
    if (b.badge) { e = fromBadge(b.badge); if (e && settings.clock.badge_pin && !b.pin) need = true; if (e && b.pin && e.pin_hash !== pinHash(b.pin)) e = null; }
    else if (b.pin && /^\d{4,6}$/.test(String(b.pin))) { const r = await dbGet('SELECT id FROM hr_employees WHERE pin_hash = ?', [pinHash(b.pin)]); e = r ? byId[r.id] : null; }
    if (!e || e.status === 'Inactive') { failed(k.id); await audit('kiosk:' + k.id, 'kiosk', k.id, b.badge ? 'badge_unknown' : 'pin_wrong'); return res.json({ ok: false, error: b.badge ? 'That badge is not active — ask HR for a new one' : 'PIN not found — try again' }); }
    if (need) return res.json({ ok: true, need_pin: true, name: e.first_name });
    res.json({ ok: true, person: await kioskPerson(e), ticket: ticket(e.id, k.id) });
  });
  app.post('/api/hr/kiosk/punch', kioskGuard, async (req, res) => {
    const k = req.kiosk, b = req.body || {}, e = fromTicket(b.ticket, k.id);
    if (!e) return res.json({ ok: false, error: 'Took too long — enter your PIN again' });
    const r = await doPunch(e, String(b.type || ''), { source: 'kiosk', ip: ipOf(req), kiosk_id: k.id, by: 'kiosk:' + k.name });
    if (r.ok) r.person = await kioskPerson(e);
    res.json(r);
  });

  // ---------------- timesheets ----------------
  async function timesheet(v, ws, mine) {
    const days = weekDays(ws);
    const people = mine ? (v.me ? [v.me] : []) : (isLead(v) ? active().filter(e => v.admin || v.scope.has(e.id) || (v.me && v.me.id === e.id)) : (v.me ? [v.me] : []));
    const ctx = await ctxFor(people.map(e => e.id), ws, days[6]);
    const appr = await dbAll('SELECT * FROM hr_ts_weeks WHERE week_start = ?', [ws]); const am = {}; appr.forEach(a => { am[a.employee_id] = a; });
    const A = settings.attendance;
    return people.map(e => {
      const recs = days.map(d => dayRecord(e, d, ctx));
      const tot = recs.reduce((s, r) => s + (r.kind === 'missed' ? 0 : Number(r.h) || 0), 0);
      const ptoH = recs.filter(r => r.leave).reduce((s, r) => s + (r.leave.half ? 4 : (leaveType(r.leave.type) && leaveType(r.leave.type).paid ? 8 : 0)), 0);
      const workH = Math.max(0, tot - ptoH);
      let ot = 0;
      if (e.location === 'gl' && A.otDailyCA) { const daily = recs.reduce((s, r) => s + Math.max(0, (r.leave ? 0 : Number(r.h) || 0) - 8), 0); const reg = recs.reduce((s, r) => s + Math.min(8, r.leave ? 0 : Number(r.h) || 0), 0); ot = daily + Math.max(0, reg - A.otWeekly); }
      else ot = Math.max(0, workH - A.otWeekly);
      const flagged = recs.some(r => r.kind === 'missed' || r.kind === 'absent');
      return { employee_id: e.id, days: recs, total: Math.round(tot * 100) / 100, work: Math.round(workH * 100) / 100, pto: ptoH, ot: Math.round(ot * 100) / 100, flagged, approved: am[e.id] ? { by: am[e.id].approved_by, at: am[e.id].approved_at } : null, can_manage: canManage(v, e) };
    });
  }
  const weekParam = (q) => /^\d{4}-\d{2}-\d{2}$/.test(String(q || '')) ? mondayOf(String(q)) : mondayOf(todayLA());
  app.get('/api/hr/timesheets', ...guard, async (req, res) => { try { const ws = weekParam(req.query.week); res.json({ ok: true, week: ws, rows: await timesheet(req.hr, ws, req.query.mine === '1') }); } catch (e) { errlog('timesheets', e.stack); res.status(500).json({ ok: false, error: e.message }); } });
  app.post('/api/hr/timesheets/approve', ...leadGuard, async (req, res) => {
    const b = req.body || {}, ws = weekParam(b.week), v = req.hr;
    const rows = await timesheet(v, ws);
    const pick = rows.filter(r => r.can_manage && !r.approved && !r.flagged && r.total > 0 && (b.all || +b.employee_id === r.employee_id));
    for (const r of pick) await dbRun('INSERT OR REPLACE INTO hr_ts_weeks (employee_id, week_start, approved_by, approved_at) VALUES (?,?,?,?)', [r.employee_id, ws, who(req), nowIso()]);
    await audit(who(req), 'timesheet', null, 'approve', null, { week: ws, ids: pick.map(r => r.employee_id) });
    res.json({ ok: true, approved: pick.length, skipped_flagged: rows.filter(r => r.flagged && (b.all || +b.employee_id === r.employee_id)).length });
  });
  app.post('/api/hr/timesheets/unapprove', ...leadGuard, async (req, res) => {
    const b = req.body || {}, e = byId[+b.employee_id]; if (!e || !canManage(req.hr, e)) return res.status(403).json({ ok: false, error: 'Not your report' });
    await dbRun('DELETE FROM hr_ts_weeks WHERE employee_id = ? AND week_start = ?', [e.id, weekParam(b.week)]); res.json({ ok: true });
  });
  // a manager fixes a day: add the missing punch at a time, or set the hours outright
  app.post('/api/hr/timesheets/fix', ...leadGuard, async (req, res) => {
    const b = req.body || {}, e = byId[+b.employee_id], v = req.hr;
    if (!e || !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Not your report' });
    const day = String(b.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.json({ ok: false, error: 'Pick a day' });
    const reason = str(b.reason, 255);
    if (b.punch) {
      const t = String(b.punch.time || ''), type = String(b.punch.type || 'out'); const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m || ['in', 'break', 'back', 'out'].indexOf(type) < 0) return res.json({ ok: false, error: 'Pick a type and a time' });
      let h = +m[1] + (+m[2]) / 60; const s0 = shiftOf(e)[0]; if (h < s0 - 6) h += 24;
      const at = new Date(zoned(day, h, tzOf(e))).toISOString();
      await dbRun('INSERT INTO hr_punches (employee_id, type, at, source, note, by) VALUES (?,?,?,?,?,?)', [e.id, type, at, 'manager_fix', reason, who(req)]);
      liveCache.at = 0; firstPunch.at = 0;
      await audit(who(req), 'punch', e.id, 'fix_add', null, { day, type, at, reason });
      return res.json({ ok: true });
    }
    if (b.void_id) { await dbRun('UPDATE hr_punches SET voided = 1, note = COALESCE(note, \'\') || ? WHERE id = ? AND employee_id = ?', [' [voided by ' + who(req) + (reason ? ': ' + reason : '') + ']', +b.void_id, e.id]); liveCache.at = 0; firstPunch.at = 0; await audit(who(req), 'punch', +b.void_id, 'void', null, { reason }); return res.json({ ok: true }); }
    if (b.clear) { await dbRun('DELETE FROM hr_ts_fixes WHERE employee_id = ? AND work_date = ?', [e.id, day]); await audit(who(req), 'timesheet', e.id, 'fix_clear', null, { day }); return res.json({ ok: true }); }
    const hrs = num(b.hours); if (hrs == null || hrs < 0 || hrs > 16) return res.json({ ok: false, error: 'Hours between 0 and 16' });
    await dbRun('DELETE FROM hr_ts_fixes WHERE employee_id = ? AND work_date = ?', [e.id, day]);
    await dbRun('INSERT INTO hr_ts_fixes (employee_id, work_date, hours, reason, fixed_by) VALUES (?,?,?,?,?)', [e.id, day, hrs, reason, who(req)]);
    await audit(who(req), 'timesheet', e.id, 'fix_hours', null, { day, hours: hrs, reason });
    res.json({ ok: true });
  });
  app.get('/api/hr/timesheets/export', ...leadGuard, async (req, res) => {
    const ws = weekParam(req.query.week), rows = await timesheet(req.hr, ws);
    const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const lines = [['Employee', 'Email', 'Location', 'Department', 'Week of', 'Regular hours', 'Overtime', 'PTO hours', 'Total', 'Pay type', 'Paid through', 'Approved', 'Needs a fix'].map(q).join(',')];
    rows.forEach(r => { const e = byId[r.employee_id]; lines.push([fullName(e), e.work_email, (LOC[e.location] || LOC.gl).name, deptName(e.department_id), ws, Math.max(0, r.work - r.ot).toFixed(2), r.ot.toFixed(2), r.pto.toFixed(2), r.total.toFixed(2), e.pay_type, e.pay_method, r.approved ? 'yes' : 'no', r.flagged ? 'yes' : ''].map(q).join(',')); });
    await audit(who(req), 'timesheet', null, 'export', null, { week: ws, n: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="novahr-payroll-' + ws + '.csv"');
    res.send(lines.join('\r\n'));
  });
  app.get('/api/hr/punches', ...guard, async (req, res) => {
    const e = byId[+req.query.employee]; if (!e || !canPrivate(req.hr, e)) return res.status(403).json({ ok: false, error: 'Not visible' });
    const day = String(req.query.date || todayFor(e));
    const map = await punchesBetween([e.id], day, day);
    const all2 = await dbAll('SELECT * FROM hr_punches WHERE employee_id = ? AND at >= ? AND at < ? ORDER BY at', [e.id, new Date(Date.parse(day + 'T00:00:00Z') - 36 * 3600000).toISOString(), new Date(Date.parse(day + 'T00:00:00Z') + 60 * 3600000).toISOString()]);
    res.json({ ok: true, day, tz: tzOf(e), punches: (map[e.id + '|' + day] || []), voided: all2.filter(p => p.voided && shiftDayOf(Date.parse(p.at), e) === day) });
  });

  // ---------------- adherence ----------------
  app.get('/api/hr/adherence', ...guard, async (req, res) => {
    try {
      const v = req.hr, weeks = [2, 4, 8].indexOf(+req.query.weeks) > -1 ? +req.query.weeks : 4;
      const ws0 = mondayOf(todayLA()), from = addDays(ws0, -7 * (weeks - 1)), to = addDays(ws0, 6);
      const people = isLead(v) ? active().filter(e => v.admin || v.scope.has(e.id) || (v.me && v.me.id === e.id)) : (v.me ? [v.me] : []);
      const ctx = await ctxFor(people.map(e => e.id), addDays(from, -7 * 8), to);
      const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
      const rows = people.map(e => {
        const a = adhOf(e, days, ctx);
        const trend = []; for (let i = Math.min(weeks, 8) - 1; i >= 0; i--) { const w = adhOf(e, weekDays(addDays(ws0, -7 * i)), ctx); trend.push(w.n ? w.score : null); }
        return { employee_id: e.id, n: a.n, ok: a.ok, lates: a.lates, avgLate: a.avgLate, early: a.early, missed: a.missed, vlate: a.vlate, score: a.score, trend,
          recent: a.recs.slice(-15).map(r => ({ day: r.day, k: r.k, inD: r.inD, outD: r.outD, in: (r.punches.find(p => p.type === 'in') || {}).at || null, out: (r.punches.filter(p => p.type === 'out').pop() || {}).at || null })) };
      });
      res.json({ ok: true, weeks, from, to, rows });
    } catch (e) { errlog('adherence', e.stack); res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------------- time off ----------------
  app.post('/api/hr/leave', ...guard, async (req, res) => {
    const v = req.hr, b = req.body || {};
    const e = b.employee_id && +b.employee_id !== (v.me && v.me.id) ? byId[+b.employee_id] : v.me;
    if (!e) return res.json({ ok: false, error: 'You are not in NovaHR yet — ask HR to add you' });
    const forOther = !(v.me && v.me.id === e.id); if (forOther && !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Not your report' });
    const t = leaveType(b.type); if (!t || !t.on) return res.json({ ok: false, error: 'Pick a type' });
    const from = String(b.from || ''), half = !!b.half, to = half ? from : String(b.to || from);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return res.json({ ok: false, error: 'Check the dates' });
    if (from.slice(0, 4) !== to.slice(0, 4)) return res.json({ ok: false, error: 'Split a request that crosses New Year into two' });
    const days = leaveDays(e, from, to, half); if (!days) return res.json({ ok: false, error: 'Those days are not work days for ' + e.first_name });
    const clash = await dbGet("SELECT id FROM hr_leave WHERE employee_id = ? AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?", [e.id, to, from]);
    if (clash) return res.json({ ok: false, error: 'There is already a request on those days' });
    const auto = forOther && b.approve;
    const r = await dbRun('INSERT INTO hr_leave (employee_id, type, start_date, end_date, half_day, days, note, status, created_by, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [e.id, t.k, from, to, half ? 1 : 0, days, str(b.note, 500), auto ? 'approved' : 'pending', who(req), auto ? who(req) : null, auto ? nowIso() : null]);
    leaveToday.at = 0;
    await audit(who(req), 'leave', r.lastID, auto ? 'add_approved' : 'request', null, { employee_id: e.id, type: t.k, from, to, days });
    if (!auto) { const m = managerOf(e); if (m) mail('hr.leave', emailOf(m), fullName(e) + ' asked for ' + t.n.toLowerCase() + ' · ' + rangeText(from, to, half), ['<b>' + escH(fullName(e)) + '</b> asked for <b>' + escH(t.n) + '</b>: ' + escH(rangeText(from, to, half)) + ' (' + days + ' day' + (days === 1 ? '' : 's') + ').', b.note ? 'Note: ' + escH(b.note) : ''].filter(Boolean), '/hr?tab=timeoff'); }
    res.json({ ok: true, id: r.lastID, days });
  });
  const rangeText = (a, b, half) => { const f = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); return (a === b ? f(a) : f(a) + ' – ' + f(b)) + (half ? ', half day' : ''); };
  async function decide(req, res, status) {
    const v = req.hr, r = await dbGet('SELECT * FROM hr_leave WHERE id = ?', [parseInt(req.params.id)]);
    if (!r) return res.status(404).json({ ok: false, error: 'No such request' });
    const e = byId[r.employee_id]; if (!e) return res.status(404).json({ ok: false, error: 'No such person' });
    const note = str((req.body || {}).note, 500);
    if (status === 'cancelled') {
      const own = v.me && v.me.id === e.id;
      if (!own && !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Not yours' });
      if (own && !canManage(v, e) && r.status !== 'pending' && r.start_date <= todayLA()) return res.json({ ok: false, error: 'Ask your manager to cancel time off that has started' });
    } else {
      if (!canManage(v, e) || (v.me && v.me.id === e.id && !v.admin)) return res.status(403).json({ ok: false, error: 'Only their manager or HR decides' });
      if (r.status !== 'pending') return res.json({ ok: false, error: 'Already ' + r.status });
      if (status === 'declined' && !note) return res.json({ ok: false, error: 'Add a reason — they will see it' });
    }
    await dbRun('UPDATE hr_leave SET status = ?, decided_by = ?, decided_at = ?, decision_note = COALESCE(?, decision_note) WHERE id = ?', [status, who(req), nowIso(), note, r.id]);
    leaveToday.at = 0;
    await audit(who(req), 'leave', r.id, status, { status: r.status }, { status, note });
    if (status !== 'cancelled') { const t = leaveType(r.type) || { n: r.type }; mail('hr.leave', emailOf(e), 'Your ' + t.n.toLowerCase() + ' request was ' + status + ' · ' + rangeText(r.start_date, r.end_date, r.half_day), ['Hi ' + escH(e.first_name || '') + ',', 'Your <b>' + escH(t.n) + '</b> request for ' + escH(rangeText(r.start_date, r.end_date, r.half_day)) + ' was <b>' + status + '</b> by ' + escH(v.name) + '.', note ? 'Note: ' + escH(note) : ''].filter(Boolean), '/hr?tab=timeoff'); }
    res.json({ ok: true });
  }
  app.post('/api/hr/leave/:id/approve', ...guard, (req, res) => decide(req, res, 'approved'));
  app.post('/api/hr/leave/:id/decline', ...guard, (req, res) => decide(req, res, 'declined'));
  app.post('/api/hr/leave/:id/cancel', ...guard, (req, res) => decide(req, res, 'cancelled'));
  app.post('/api/hr/leave/preview', ...guard, async (req, res) => {
    const v = req.hr, b = req.body || {}; const e = b.employee_id ? byId[+b.employee_id] : v.me; if (!e) return res.json({ ok: false });
    const from = String(b.from || ''), half = !!b.half, to = half ? from : String(b.to || from);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return res.json({ ok: false, error: 'Last day must be on or after the first day' });
    const days = leaveDays(e, from, to, half), t = leaveType(b.type);
    const bal = (await balancesFor(e, +from.slice(0, 4))).find(x => x.k === (t && t.k));
    const ov = (await dbAll("SELECT employee_id FROM hr_leave WHERE status IN ('pending','approved') AND start_date <= ? AND end_date >= ? AND employee_id <> ?", [to, from, e.id])).map(r => byId[r.employee_id]).filter(x => x && x.department_id && x.department_id === e.department_id);
    const lead = Math.round((Date.parse(from + 'T12:00:00Z') - Date.parse(todayLA() + 'T12:00:00Z')) / 86400000);
    const hol = holidayList(from, to).filter(h => h.location === (e.location || 'gl'));
    res.json({ ok: true, days, left_after: bal && bal.track ? Math.round((bal.left - bal.pending - days) * 2) / 2 : null, type: t ? t.n : null, overlap: Array.from(new Set(ov.map(x => x.first_name))), dept: deptName(e.department_id), short_notice: t && t.notice && lead < t.notice ? t.notice : 0, holidays: hol.map(h => h.name) });
  });
  app.post('/api/hr/leave-adjust', ...adminGuard, async (req, res) => {
    const b = req.body || {}, e = byId[+b.employee_id]; if (!e) return res.json({ ok: false, error: 'No such person' });
    const t = leaveType(b.type); if (!t) return res.json({ ok: false, error: 'Pick a type' });
    const y = parseInt(b.year) || +todayLA().slice(0, 4);
    await dbRun('INSERT OR REPLACE INTO hr_leave_adjust (employee_id, type, year, allowance, used_before, carried, note, updated_by) VALUES (?,?,?,?,?,?,?,?)', [e.id, t.k, y, num(b.allowance), num(b.used_before), num(b.carried), str(b.note, 200), who(req)]);
    await audit(who(req), 'leave_adjust', e.id, 'set', null, b);
    res.json({ ok: true, balances: await balancesFor(e, y) });
  });

  // ---------------- reviews ----------------
  async function reviewRow(empId, year) {
    let r = await dbGet('SELECT * FROM hr_reviews WHERE year = ? AND employee_id = ?', [year, empId]);
    if (!r) { await dbRun('INSERT OR IGNORE INTO hr_reviews (year, employee_id, reviewer_id, stage) VALUES (?,?,?,?)', [year, empId, (byId[empId] || {}).reports_to || null, 'none']); r = await dbGet('SELECT * FROM hr_reviews WHERE year = ? AND employee_id = ?', [year, empId]); }
    return r;
  }
  app.post('/api/hr/reviews/:id', ...guard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const v = req.hr, b = req.body || {}, year = settings.review.year;
    const r = await reviewRow(e.id, year); const self = v.me && v.me.id === e.id, mgr = canManage(v, e) && !self;
    const act = String(b.action || 'save');
    if (r.stage === 'done' && act !== 'reopen') return res.json({ ok: false, error: 'This review is complete' });
    const set = {};
    if (self && (act === 'self_save' || act === 'self_submit')) {
      if (['none', 'self'].indexOf(r.stage) < 0 && !(v.admin)) return res.json({ ok: false, error: 'Your manager is writing the review now' });
      set.self_text = String(b.self_text || '').slice(0, 6000);
      if (act === 'self_submit') { if (!set.self_text.trim()) return res.json({ ok: false, error: 'Write a few lines first' }); set.stage = 'manager'; set.self_at = nowIso(); }
      else set.stage = 'self';
    } else if (mgr || (v.admin && !self)) {
      if (act === 'reopen') { if (!v.admin) return res.status(403).json({ ok: false, error: 'HR reopens a review' }); set.stage = 'manager'; set.completed_at = null; }
      else {
        let sc = {}; try { sc = JSON.parse(r.scores || '{}'); } catch (x) {}
        if (b.scores && typeof b.scores === 'object') (settings.review.areas || []).forEach(a => { const n = parseInt(b.scores[a.k]); if (n >= 1 && n <= 5) sc[a.k] = n; });
        set.scores = JSON.stringify(sc);
        ['strengths', 'growth', 'goals'].forEach(k => { if (b[k] != null) set[k] = String(b[k]).slice(0, 6000); });
        if (r.stage === 'none' || r.stage === 'self') set.stage = 'manager';
        set.reviewer_id = v.me ? v.me.id : r.reviewer_id;
        if (act === 'complete') {
          if ((settings.review.areas || []).some(a => !sc[a.k])) return res.json({ ok: false, error: 'Score every area first' });
          set.stage = 'done'; set.completed_at = nowIso(); set.completed_by = who(req);
        }
      }
    } else return res.status(403).json({ ok: false, error: 'Not yours to review' });
    set.updated_at = nowIso();
    const cols = Object.keys(set);
    await dbRun('UPDATE hr_reviews SET ' + cols.map(c => c + ' = ?').join(', ') + ' WHERE id = ?', cols.map(c => set[c]).concat([r.id]));
    await audit(who(req), 'review', r.id, act, { stage: r.stage }, { stage: set.stage || r.stage });
    res.json({ ok: true, review: reviewOut(await dbGet('SELECT * FROM hr_reviews WHERE id = ?', [r.id]), v) });
  });
  app.post('/api/hr/reviews-remind', ...leadGuard, async (req, res) => {
    const v = req.hr, year = settings.review.year;
    const rv = await dbAll('SELECT * FROM hr_reviews WHERE year = ?', [year]); const rm = {}; rv.forEach(r => { rm[r.employee_id] = r; });
    const due = active().filter(e => (v.admin || v.scope.has(e.id)) && (!rm[e.id] || (['none', 'self'].indexOf(rm[e.id].stage) > -1 && !rm[e.id].self_text)));
    let sent = 0;
    for (const e of due) { const r = await mail('hr.review', emailOf(e), 'Your ' + year + ' self-review is due', ['Hi ' + escH(e.first_name || '') + ',', 'Your ' + year + ' annual review is open. Please write a few lines about how the year went — wins, what you learned and where you want to grow — before ' + escH(new Date(settings.review.due + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })) + '.'], '/hr?tab=reviews'); if (r && r.ok) sent++; }
    await audit(who(req), 'review', null, 'remind', null, { n: due.length, sent });
    res.json({ ok: true, people: due.length, sent });
  });

  // ---------------- skills & languages ----------------
  app.post('/api/hr/employees/:id/skill', ...guard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; if (!canManage(req.hr, e)) return res.status(403).json({ ok: false, error: 'Managers set skill levels' });
    const k = String((req.body || {}).k || ''), lv = parseInt((req.body || {}).level);
    if (!(settings.skills || []).some(s => s.k === k) || !(lv >= 0 && lv <= 4)) return res.json({ ok: false, error: 'Unknown skill or level' });
    if (lv === 0) await dbRun('DELETE FROM hr_emp_skills WHERE employee_id = ? AND skill = ?', [e.id, k]);
    else await dbRun('INSERT OR REPLACE INTO hr_emp_skills (employee_id, skill, level, updated_by, updated_at) VALUES (?,?,?,?,?)', [e.id, k, lv, who(req), nowIso()]);
    res.json({ ok: true });
  });
  app.post('/api/hr/employees/:id/lang', ...guard, async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const v = req.hr;
    if (!(v.me && v.me.id === e.id) && !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Not yours to change' });
    const k = String((req.body || {}).k || ''), lv = (req.body || {}).level;
    if (!(settings.languages.list || []).some(l => l.k === k)) return res.json({ ok: false, error: 'Unknown language' });
    if (lv == null || lv === '') await dbRun('DELETE FROM hr_emp_langs WHERE employee_id = ? AND lang = ?', [e.id, k]);
    else { const n = parseInt(lv); if (!(n >= 0 && n <= 3)) return res.json({ ok: false, error: 'Unknown level' }); await dbRun('INSERT OR REPLACE INTO hr_emp_langs (employee_id, lang, level) VALUES (?,?,?)', [e.id, k, n]); }
    res.json({ ok: true });
  });

  // ---------------- rewards ----------------
  async function checkinRows(v, ws) {
    const people = active().filter(e => (v.admin || v.scope.has(e.id)) && !(v.me && v.me.id === e.id));
    const ctx = await ctxFor(people.map(e => e.id), addDays(ws, -7 * 27), addDays(ws, 6));
    const saved = await dbAll('SELECT * FROM hr_checkins WHERE week_start = ?', [ws]); const sm = {}; saved.forEach(s => { sm[s.employee_id] = s; });
    const R = settings.rewards;
    return people.map(e => {
      const ap = attPoints(e, ws, ctx), s = sm[e.id];
      let cats = []; try { cats = JSON.parse((s && s.cats) || '[]'); } catch (x) {}
      const cp = cats.reduce((t, k) => t + (((R.cats || []).find(c => c.k === k) || {}).p || 0), 0);
      return { employee_id: e.id, att: ap, cats, note: s ? s.note || '' : '', sent_at: s ? s.sent_at : null, total: s && s.sent_at ? s.total_points : Math.min(R.weeklyCap, ap.pts + cp), capped: ap.pts + cp > R.weeklyCap };
    });
  }
  app.get('/api/hr/checkins', ...leadGuard, async (req, res) => {
    try { const ws = weekParam(req.query.week || addDays(mondayOf(todayLA()), -7)); res.json({ ok: true, week: ws, rows: await checkinRows(req.hr, ws) }); }
    catch (e) { errlog('checkins', e.stack); res.status(500).json({ ok: false, error: e.message }); }
  });
  async function sendCheckin(v, e, ws, cats, note, by) {
    const R = settings.rewards; const rows = await checkinRows(v, ws); const row = rows.find(r => r.employee_id === e.id);
    if (!row) return { ok: false, error: 'Not your report' };
    if (row.sent_at) return { ok: false, error: 'Already sent' };
    cats = (cats || []).filter(k => (R.cats || []).some(c => c.k === k));
    const cp = cats.reduce((t, k) => t + (((R.cats || []).find(c => c.k === k) || {}).p || 0), 0);
    const total = Math.min(R.weeklyCap, row.att.pts + cp);
    const names = cats.map(k => ((R.cats || []).find(c => c.k === k) || {}).n).filter(Boolean);
    const why = 'Week of ' + new Date(ws + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ': ' + row.att.why.toLowerCase() + (row.att.streak ? ', ' + R.streakWeeks + '-week streak bonus' : '') + (names.length ? ', ' + names.join(', ').toLowerCase() : '') + (note ? '. ' + note : '');
    await dbRun('INSERT INTO hr_checkins (employee_id, week_start, manager, attendance_points, cats, category_points, total_points, note, why, sent_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(employee_id, week_start) DO UPDATE SET manager = excluded.manager, attendance_points = excluded.attendance_points, cats = excluded.cats, category_points = excluded.category_points, total_points = excluded.total_points, note = excluded.note, why = excluded.why, sent_at = excluded.sent_at',
      [e.id, ws, by, row.att.pts, JSON.stringify(cats), cp, total, note || null, why, nowIso()]);
    const ci = await dbGet('SELECT id FROM hr_checkins WHERE employee_id = ? AND week_start = ?', [e.id, ws]);
    if (total) await dbRun('INSERT INTO hr_points (employee_id, points, kind, reason, ref_id, given_by) VALUES (?,?,?,?,?,?)', [e.id, total, 'checkin', why, ci ? ci.id : null, by]);
    mail('hr.checkin', emailOf(e), '+' + total + ' NovaHR points for the week of ' + new Date(ws + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), ['Hi ' + escH(e.first_name || '') + ',', 'You earned <b>' + total + ' points</b> this week.', 'Attendance: +' + row.att.pts + ' (' + escH(row.att.why) + (row.att.streak ? ', streak bonus' : '') + ')' + (names.length ? '<br>From your manager: ' + escH(names.join(', ')) + ' (+' + cp + ')' : ''), note ? '“' + escH(note) + '”' : ''].filter(Boolean), '/hr?tab=rewards');
    return { ok: true, total };
  }
  app.post('/api/hr/checkins', ...leadGuard, async (req, res) => {
    const b = req.body || {}, v = req.hr, e = byId[+b.employee_id]; if (!e || !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Not your report' });
    const ws = weekParam(b.week);
    if (b.send) { const r = await sendCheckin(v, e, ws, b.cats, str(b.note, 500), who(req)); await audit(who(req), 'checkin', e.id, 'send', null, { week: ws, total: r.total }); return res.json(r); }
    const s = await dbGet('SELECT sent_at FROM hr_checkins WHERE employee_id = ? AND week_start = ?', [e.id, ws]); if (s && s.sent_at) return res.json({ ok: false, error: 'Already sent' });
    const R = settings.rewards; const cats = (Array.isArray(b.cats) ? b.cats : []).filter(k => (R.cats || []).some(c => c.k === k));
    await dbRun('INSERT INTO hr_checkins (employee_id, week_start, manager, cats, note) VALUES (?,?,?,?,?) ON CONFLICT(employee_id, week_start) DO UPDATE SET cats = excluded.cats, note = excluded.note, manager = excluded.manager', [e.id, ws, who(req), JSON.stringify(cats), str(b.note, 500)]);
    res.json({ ok: true });
  });
  app.post('/api/hr/checkins/send-all', ...leadGuard, async (req, res) => {
    const v = req.hr, ws = weekParam((req.body || {}).week), rows = await checkinRows(v, ws);
    let n = 0, pts = 0;
    for (const r of rows.filter(x => !x.sent_at)) { const x = await sendCheckin(v, byId[r.employee_id], ws, r.cats, r.note, who(req)); if (x.ok) { n++; pts += x.total; } }
    await audit(who(req), 'checkin', null, 'send_all', null, { week: ws, n, pts });
    res.json({ ok: true, sent: n, points: pts });
  });
  app.post('/api/hr/shoutout', ...leadGuard, async (req, res) => {
    const b = req.body || {}, v = req.hr, e = byId[+b.employee_id];
    if (!e || !canManage(v, e)) return res.status(403).json({ ok: false, error: 'Shout-outs go to your own team' });
    const p = parseInt(b.points); if ([10, 25, 50].indexOf(p) < 0 && !(v.admin && p > 0 && p <= 500)) return res.json({ ok: false, error: '10, 25 or 50 points' });
    const why = str(b.reason, 300); if (!why) return res.json({ ok: false, error: 'Add a reason so the team knows why' });
    await dbRun('INSERT INTO hr_points (employee_id, points, kind, reason, given_by) VALUES (?,?,?,?,?)', [e.id, p, 'shoutout', why, v.name]);
    await audit(who(req), 'points', e.id, 'shoutout', null, { p, why });
    mail('hr.checkin', emailOf(e), 'Shout-out from ' + v.name + ': +' + p + ' points', ['Hi ' + escH(e.first_name || '') + ',', escH(v.name) + ' gave you <b>+' + p + ' points</b>: “' + escH(why) + '”'], '/hr?tab=rewards');
    res.json({ ok: true });
  });
  app.post('/api/hr/points-adjust', ...adminGuard, async (req, res) => {
    const b = req.body || {}, e = byId[+b.employee_id]; if (!e) return res.json({ ok: false, error: 'No such person' });
    const p = parseInt(b.points); if (!p) return res.json({ ok: false, error: 'Points?' });
    await dbRun('INSERT INTO hr_points (employee_id, points, kind, reason, given_by) VALUES (?,?,?,?,?)', [e.id, p, 'adjustment', str(b.reason, 300) || 'Adjustment', req.hr.name]);
    await audit(who(req), 'points', e.id, 'adjust', null, { p }); res.json({ ok: true });
  });
  const pointsOf = async (id) => Number(((await dbGet('SELECT SUM(points) AS p FROM hr_points WHERE employee_id = ?', [id])) || {}).p) || 0;
  app.post('/api/hr/redeem', ...guard, async (req, res) => {
    const v = req.hr; if (!v.me) return res.json({ ok: false, error: 'You are not in NovaHR yet' });
    const item = (settings.rewards.catalog || []).find(c => c.k === String((req.body || {}).k || '')); if (!item) return res.json({ ok: false, error: 'Pick a reward' });
    const have = await pointsOf(v.me.id); if (have < item.p) return res.json({ ok: false, error: 'You need ' + (item.p - have) + ' more points' });
    const r = await dbRun('INSERT INTO hr_redemptions (employee_id, item, item_name, points) VALUES (?,?,?,?)', [v.me.id, item.k, item.n, item.p]);
    await dbRun('INSERT INTO hr_points (employee_id, points, kind, reason, ref_id, given_by) VALUES (?,?,?,?,?,?)', [v.me.id, -item.p, 'redemption', 'Redeemed: ' + item.n, r.lastID, v.name]);
    await audit(who(req), 'redemption', r.lastID, 'request', null, { item: item.k, p: item.p });
    mail('hr.redeem', process.env.HR_ALERT_TO || 'gary@axiomprint.com', fullName(v.me) + ' redeemed ' + item.p + ' points for ' + item.n, ['<b>' + escH(fullName(v.me)) + '</b> redeemed <b>' + item.p + ' points</b> for <b>' + escH(item.n) + '</b>.', 'Mark it fulfilled (or reject it — the points go back) under NovaHR → Rewards.'], '/hr?tab=rewards&sub=redeem');
    res.json({ ok: true, id: r.lastID });
  });
  app.post('/api/hr/redemptions/:id', ...adminGuard, async (req, res) => {
    const r = await dbGet('SELECT * FROM hr_redemptions WHERE id = ?', [parseInt(req.params.id)]); if (!r) return res.status(404).json({ ok: false });
    const st = String((req.body || {}).status || ''); if (['fulfilled', 'rejected'].indexOf(st) < 0 || r.status !== 'requested') return res.json({ ok: false, error: 'Already ' + r.status });
    await dbRun('UPDATE hr_redemptions SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?', [st, who(req), nowIso(), str((req.body || {}).note, 300), r.id]);
    if (st === 'rejected') await dbRun('INSERT INTO hr_points (employee_id, points, kind, reason, ref_id, given_by) VALUES (?,?,?,?,?,?)', [r.employee_id, r.points, 'adjustment', 'Returned: ' + r.item_name + ' not redeemed', r.id, req.hr.name]);
    // a "Paid day off" reward adds to that leave balance (the catalog item says which type and how many days)
    const item = (settings.rewards.catalog || []).find(c => c.k === r.item);
    if (st === 'fulfilled' && item && item.leave && leaveType(item.leave)) {
      const y = +todayLA().slice(0, 4); const a = await dbGet('SELECT * FROM hr_leave_adjust WHERE employee_id = ? AND type = ? AND year = ?', [r.employee_id, item.leave, y]);
      await dbRun('INSERT OR REPLACE INTO hr_leave_adjust (employee_id, type, year, allowance, used_before, carried, note, updated_by) VALUES (?,?,?,?,?,?,?,?)', [r.employee_id, item.leave, y, a ? a.allowance : null, a ? a.used_before : null, (a && Number(a.carried) || 0) + (Number(item.days) || 1), 'Reward: ' + item.n, who(req)]);
    }
    await audit(who(req), 'redemption', r.id, st);
    res.json({ ok: true });
  });

  // ---------------- documents ----------------
  const FILE_KINDS = [[/^%PDF/, 'application/pdf', 'pdf'], [/^\x89PNG/, 'image/png', 'png'], [/^\xFF\xD8\xFF/, 'image/jpeg', 'jpg'], [/^PK\x03\x04/, null, 'zip']];
  function sniff(buf) {
    const head = buf.slice(0, 8).toString('latin1');
    for (const [re, mime, ext] of FILE_KINDS) if (re.test(head)) {
      if (ext !== 'zip') return { mime, ext };
      const has = (s) => buf.indexOf(s) > -1 && buf.indexOf(s) < 4000;
      if (has('word/')) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
      if (has('xl/')) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
      return null;
    }
    return null;
  }
  app.post('/api/hr/employees/:id/docs', ...guard, require('express').raw({ type: () => true, limit: 25 * 1024 * 1024 + 1024 }), async (req, res) => {
    const e = empOr404(req, res); if (!e) return; const v = req.hr;
    if (!canManage(v, e) && !(v.me && v.me.id === e.id)) return res.status(403).json({ ok: false, error: 'Not yours' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); if (!buf.length) return res.json({ ok: false, error: 'Empty file' });
    const kind = sniff(buf); if (!kind) return res.json({ ok: false, error: 'PDF, picture (PNG / JPG), Word or Excel files only' });
    const name = str(decodeURIComponent(String(req.headers['x-file-name'] || 'document')), 150) || 'document';
    const file = 'emp' + e.id + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + kind.ext;
    fs.writeFileSync(path.join(FILES, file), buf);
    const label = str(decodeURIComponent(String(req.headers['x-doc-kind'] || '')), 60);
    const r = await dbRun('INSERT INTO hr_docs (employee_id, name, kind, status, file, mime, size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)', [e.id, name, label, 'On file', file, kind.mime, buf.length, who(req)]);
    await audit(who(req), 'doc', r.lastID, 'upload', null, { employee_id: e.id, name });
    res.json({ ok: true, id: r.lastID });
  });
  app.get('/api/hr/docs/:id', ...guard, async (req, res) => {
    const d = await dbGet('SELECT * FROM hr_docs WHERE id = ?', [parseInt(req.params.id)]); if (!d) return res.status(404).end();
    const e = byId[d.employee_id]; if (!e || !canPrivate(req.hr, e)) return res.status(403).end();
    const full = path.resolve(FILES, d.file); if (full.indexOf(path.resolve(FILES)) !== 0 || !fs.existsSync(full)) return res.status(404).end();
    res.setHeader('Content-Type', d.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + '; filename="' + String(d.name).replace(/[^\w.\- ]+/g, '_') + '"');
    fs.createReadStream(full).pipe(res);
  });
  app.post('/api/hr/docs/:id/delete', ...leadGuard, async (req, res) => {
    const d = await dbGet('SELECT * FROM hr_docs WHERE id = ?', [parseInt(req.params.id)]); if (!d) return res.status(404).json({ ok: false });
    const e = byId[d.employee_id]; if (!e || !canManage(req.hr, e)) return res.status(403).json({ ok: false, error: 'Not your report' });
    const full = path.resolve(FILES, d.file); if (full.indexOf(path.resolve(FILES)) === 0) { try { fs.unlinkSync(full); } catch (x) {} }
    await dbRun('DELETE FROM hr_docs WHERE id = ?', [d.id]); await audit(who(req), 'doc', d.id, 'delete', { name: d.name }); res.json({ ok: true });
  });

  // ---------------- company tree ----------------
  const personFrom = (p) => { const eid = parseInt(p && p.employee_id); if (eid && byId[eid]) return { employee_id: eid, name: fullName(byId[eid]), title: str(p.title, 128) || byId[eid].title || null }; const n = str(p && p.name, 120); return n ? { employee_id: null, name: n, title: str(p.title, 128) } : null; };
  app.post('/api/hr/org/dept', ...adminGuard, async (req, res) => {
    const b = req.body || {}; const name = str(b.name, 128); if (!name) return res.json({ ok: false, error: 'Name the department' });
    let id = parseInt(b.id);
    if (id) await dbRun('UPDATE hr_departments SET name = ?, color = COALESCE(?, color), edited = 1 WHERE id = ?', [name, str(b.color, 9), id]);
    else { const mx = await dbGet('SELECT MAX(sort) AS s FROM hr_departments'); id = (await dbRun('INSERT INTO hr_departments (name, color, sort, edited) VALUES (?,?,?,1)', [name, str(b.color, 9) || '#475569', ((mx && mx.s) || 0) + 1])).lastID; }
    if (Array.isArray(b.heads)) { await dbRun('DELETE FROM hr_dept_heads WHERE department_id = ?', [id]); let k = 0; for (const h of b.heads) { const p = personFrom(h); if (p) await dbRun('INSERT INTO hr_dept_heads (department_id, employee_id, name, title, sort) VALUES (?,?,?,?,?)', [id, p.employee_id, p.name, p.title, k++]); } }
    await audit(who(req), 'department', id, b.id ? 'edit' : 'add', null, { name }); await loadDeptNames();
    res.json({ ok: true, id });
  });
  app.post('/api/hr/org/team', ...adminGuard, async (req, res) => {
    const b = req.body || {}; const name = str(b.name, 128); if (!name) return res.json({ ok: false, error: 'Name the team' });
    const dep = parseInt(b.department_id); if (!dep) return res.json({ ok: false, error: 'Pick a department' });
    let id = parseInt(b.id);
    if (id) await dbRun('UPDATE hr_teams SET name = ?, department_id = ?, edited = 1 WHERE id = ?', [name, dep, id]);
    else { const mx = await dbGet('SELECT MAX(sort) AS s FROM hr_teams'); id = (await dbRun('INSERT INTO hr_teams (department_id, name, sort, edited) VALUES (?,?,?,1)', [dep, name, ((mx && mx.s) || 0) + 1])).lastID; }
    if (Array.isArray(b.leads)) { await dbRun('DELETE FROM hr_team_people WHERE team_id = ? AND is_lead = 1', [id]); let k = 0; for (const h of b.leads) { const p = personFrom(h); if (p) await dbRun('INSERT INTO hr_team_people (team_id, employee_id, name, title, is_lead, sort) VALUES (?,?,?,?,1,?)', [id, p.employee_id, p.name, p.title, k++]); } }
    await audit(who(req), 'team', id, b.id ? 'edit' : 'add', null, { name }); await loadDeptNames();
    res.json({ ok: true, id });
  });
  app.post('/api/hr/org/team/:id/person', ...adminGuard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {};
    const t = await dbGet('SELECT * FROM hr_teams WHERE id = ?', [id]); if (!t) return res.status(404).json({ ok: false });
    if (b.remove) { const p = personFrom(b); if (p && p.employee_id) await dbRun('DELETE FROM hr_team_people WHERE team_id = ? AND employee_id = ? AND is_lead = ?', [id, p.employee_id, b.lead ? 1 : 0]); else if (p) await dbRun('DELETE FROM hr_team_people WHERE team_id = ? AND name = ? AND is_lead = ?', [id, p.name, b.lead ? 1 : 0]); }
    else { const p = personFrom(b); if (!p) return res.json({ ok: false, error: 'Pick a person' }); await dbRun('INSERT INTO hr_team_people (team_id, employee_id, name, title, is_lead, sort) VALUES (?,?,?,?,?,999)', [id, p.employee_id, p.name, p.title, b.lead ? 1 : 0]); }
    await dbRun('UPDATE hr_teams SET edited = 1 WHERE id = ?', [id]);
    await audit(who(req), 'team', id, b.remove ? 'person_remove' : 'person_add', null, b);
    res.json({ ok: true });
  });
  app.post('/api/hr/org/:kind/:id/delete', ...adminGuard, async (req, res) => {
    const id = parseInt(req.params.id), kind = req.params.kind;
    if (kind === 'team') { await dbRun('UPDATE hr_teams SET hidden = 1, edited = 1 WHERE id = ?', [id]); }
    else if (kind === 'dept') { const n = await dbGet('SELECT COUNT(*) AS n FROM hr_teams WHERE department_id = ? AND hidden = 0', [id]); if (n && n.n) return res.json({ ok: false, error: 'Move or remove its teams first' }); await dbRun('UPDATE hr_departments SET hidden = 1, edited = 1 WHERE id = ?', [id]); }
    else return res.status(404).json({ ok: false });
    await audit(who(req), kind, id, 'remove'); res.json({ ok: true });
  });
  app.post('/api/hr/org/reset', ...adminGuard, async (req, res) => {
    await dbRun('UPDATE hr_departments SET edited = 0, hidden = 0 WHERE crm_id IS NOT NULL'); await dbRun('UPDATE hr_teams SET edited = 0, hidden = 0 WHERE crm_id IS NOT NULL');
    await syncOrg(false, await crmUsers()); await loadDeptNames(); await audit(who(req), 'org', null, 'reset_from_crm');
    res.json({ ok: true });
  });

  // ---------------- settings ----------------
  const SET_KEYS = ['attendance', 'rewards', 'leave_types', 'skills', 'skill_levels', 'languages', 'review', 'clock', 'org'];
  app.post('/api/hr/settings/:key', ...adminGuard, async (req, res) => {
    const k = req.params.key; if (SET_KEYS.indexOf(k) < 0) return res.status(404).json({ ok: false });
    const val = (req.body || {}).value; if (val == null || typeof val !== 'object') return res.json({ ok: false, error: 'Nothing to save' });
    const clean = sanitizeSetting(k, val); if (clean.error) return res.json({ ok: false, error: clean.error });
    const before = settings[k];
    if (k === 'skills') { const gone = (before || []).filter(s => !clean.value.some(x => x.k === s.k)).map(s => s.k); if (gone.length) await dbRun('DELETE FROM hr_emp_skills WHERE skill IN (' + gone.map(() => '?').join(',') + ')', gone); }
    if (k === 'languages') { const gone = ((before || {}).list || []).filter(s => !clean.value.list.some(x => x.k === s.k)).map(s => s.k); if (gone.length) await dbRun('DELETE FROM hr_emp_langs WHERE lang IN (' + gone.map(() => '?').join(',') + ')', gone); }
    await saveSetting(k, clean.value, who(req)); await audit(who(req), 'settings', null, k, before, clean.value);
    res.json({ ok: true, value: clean.value });
  });
  const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'k' + Date.now().toString(36);
  function sanitizeSetting(k, v) {
    const n = (x, d, lo, hi) => { const y = num(x); return y == null ? d : Math.min(hi == null ? 1e6 : hi, Math.max(lo == null ? 0 : lo, y)); };
    if (k === 'attendance') { const d = DEFAULTS.attendance; return { value: { grace: n(v.grace, d.grace, 0, 120), earlyGrace: n(v.earlyGrace, d.earlyGrace, 0, 120), lateAlert: n(v.lateAlert, d.lateAlert, 0, 240), round: [0, 5, 15].indexOf(+v.round) > -1 ? +v.round : d.round, breakMin: n(v.breakMin, d.breakMin, 0, 120), otWeekly: n(v.otWeekly, d.otWeekly, 0, 80), otDailyCA: !!v.otDailyCA, autoOut: !!v.autoOut } }; }
    if (k === 'rewards') {
      const d = DEFAULTS.rewards, seen = new Set();
      const cats = (Array.isArray(v.cats) ? v.cats : []).map(c => ({ k: str(c.k, 16) || keyOf(c.n), n: str(c.n, 60), p: n(c.p, 10, 0, 500) })).filter(c => c.n && !seen.has(c.k) && seen.add(c.k));
      const seen2 = new Set();
      const catalog = (Array.isArray(v.catalog) ? v.catalog : []).map(c => { const o = { k: str(c.k, 16) || keyOf(c.n), n: str(c.n, 60), p: n(c.p, 100, 1, 100000) }; if (c.leave && leaveType(c.leave)) { o.leave = c.leave; o.days = n(c.days, 1, 0.5, 10); } return o; }).filter(c => c.n && !seen2.has(c.k) && seen2.add(c.k));
      return { value: { perfectWeek: n(v.perfectWeek, d.perfectWeek), latePenalty: n(v.latePenalty, d.latePenalty), missedPenalty: n(v.missedPenalty, d.missedPenalty), streakWeeks: n(v.streakWeeks, d.streakWeeks, 0, 52), streakBonus: n(v.streakBonus, d.streakBonus), weeklyCap: n(v.weeklyCap, d.weeklyCap, 1, 10000), cats, catalog } };
    }
    if (k === 'leave_types') {
      if (!Array.isArray(v)) return { error: 'A list' }; const seen = new Set();
      return { value: v.map(t => ({ k: str(t.k, 16) || keyOf(t.n), n: str(t.n, 40), paid: !!t.paid, track: !!t.track, on: !!t.on, allow: LOCS.reduce((o, l) => { o[l] = n((t.allow || {})[l], 0, 0, 365); return o; }, {}), accrual: ['Up front', 'Monthly', 'Per hour worked', 'As needed'].indexOf(t.accrual) > -1 ? t.accrual : 'Up front', carry: n(t.carry, 0, 0, 365), notice: n(t.notice, 0, 0, 365) })).filter(t => t.n && !seen.has(t.k) && seen.add(t.k)) };
    }
    if (k === 'skills') { if (!Array.isArray(v)) return { error: 'A list' }; const seen = new Set(); return { value: v.map(s => ({ k: str(s.k, 16) || keyOf(s.n), n: str(s.n, 60), g: str(s.g, 40) || 'Other' })).filter(s => s.n && !seen.has(s.k) && seen.add(s.k)) }; }
    if (k === 'skill_levels') { if (!Array.isArray(v) || v.length !== 5) return { error: 'Five levels' }; return { value: v.map((x, i) => str(x, 40) || DEFAULTS.skill_levels[i]) }; }
    if (k === 'languages') { const seen = new Set(); const list = (Array.isArray(v.list) ? v.list : []).map(l => ({ k: str(l.k, 12) || keyOf(l.n), n: str(l.n, 40) })).filter(l => l.n && !seen.has(l.k) && seen.add(l.k)); const levels = Array.isArray(v.levels) && v.levels.length === 4 ? v.levels.map((x, i) => str(x, 40) || DEFAULTS.languages.levels[i]) : DEFAULTS.languages.levels; return { value: { list, levels } }; }
    if (k === 'review') { const y = parseInt(v.year) || settings.review.year; const seen = new Set(); const areas = (Array.isArray(v.areas) ? v.areas : settings.review.areas).map(a => ({ k: str(a.k, 12) || keyOf(a.n), n: str(a.n, 60), d: str(a.d, 120) || '' })).filter(a => a.n && !seen.has(a.k) && seen.add(a.k)); if (areas.length < 3) return { error: 'At least three review areas' }; return { value: { year: y, due: /^\d{4}-\d{2}-\d{2}$/.test(String(v.due)) ? v.due : y + '-12-15', areas } }; }
    if (k === 'clock') return { value: { pin_len: Math.min(6, Math.max(4, parseInt(v.pin_len) || 4)), gl_web: ['allow', 'kiosk'].indexOf(v.gl_web) > -1 ? v.gl_web : 'allow', remote_web: ['allow', 'off'].indexOf(v.remote_web) > -1 ? v.remote_web : 'allow', office_ips: String(v.office_ips || '').replace(/[^\d.:,\s a-f]/gi, '').slice(0, 400), badge_pin: !!v.badge_pin } };
    if (k === 'org') return { value: { ceo_name: str(v.ceo_name, 80) || DEFAULTS.org.ceo_name, ceo_title: str(v.ceo_title, 60) || 'CEO' } };
    return { error: 'Unknown setting' };
  }
  app.post('/api/hr/holidays', ...adminGuard, async (req, res) => {
    const b = req.body || {};
    if (b.delete) { await dbRun('DELETE FROM hr_holidays WHERE id = ?', [parseInt(b.delete)]); await loadHolidays(); holCache.at = 0; await audit(who(req), 'holiday', parseInt(b.delete), 'delete'); return res.json({ ok: true }); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) || !str(b.name) || !LOC[b.location]) return res.json({ ok: false, error: 'Add a date, a name and a location' });
    const r = await dbRun('INSERT INTO hr_holidays (location, date, name, created_by) VALUES (?,?,?,?)', [b.location, b.date, str(b.name, 80), who(req)]);
    await loadHolidays(); holCache.at = 0; await audit(who(req), 'holiday', r.lastID, 'add', null, b);
    res.json({ ok: true, id: r.lastID });
  });
  app.get('/api/hr/audit', ...adminGuard, async (req, res) => res.json({ ok: true, rows: await dbAll('SELECT * FROM hr_audit ORDER BY id DESC LIMIT 300') }));
  app.get('/api/hr/badge-count', ...guard, async (req, res) => {
    const v = req.hr; if (!isLead(v)) return res.json({ ok: true, count: 0, unread: 0 });
    const rows = await dbAll("SELECT employee_id FROM hr_leave WHERE status = 'pending'");
    const n = rows.filter(r => byId[r.employee_id] && canManage(v, byId[r.employee_id]) && !(v.me && v.me.id === r.employee_id && !v.admin)).length;
    res.json({ ok: true, count: n, unread: n });
  });

  // ---------------- the clock: auto clock-out and missed-punch emails ----------------
  async function tick() {
    await ready;
    const A = settings.attendance;
    if (A.autoOut) {
      const pm = await lastPunches();
      for (const e of active()) {
        const s = stateFrom(pm[e.id], e); if (s.state === 'off' || !s.last) continue;
        const day = shiftDayOf(Date.parse(s.last.at), e), end = zoned(day, shiftOf(e)[1], tzOf(e));
        if (Date.now() > end + 2 * 3600000 && Date.parse(s.last.at) < end) {
          await dbRun('INSERT INTO hr_punches (employee_id, type, at, source, note, by) VALUES (?,?,?,?,?,?)', [e.id, 'out', new Date(end).toISOString(), 'auto', 'Auto clock-out at shift end — check with them', 'auto']);
          liveCache.at = 0; await audit('auto', 'punch', e.id, 'auto_out', null, { at: new Date(end).toISOString() });
        }
      }
    }
    const la = parts(Date.now(), LOC.gl.tz), key = todayLA();
    if (la.h >= 9 && (await meta('missed_mailed')) !== key) {
      await setMeta('missed_mailed', key);
      const y = addDays(key, -1); const ids = active().map(e => e.id); if (!ids.length) return;
      const ctx = await ctxFor(ids, addDays(y, -1), key);
      for (const e of active()) {
        const d = shiftDayOf(Date.now() - 24 * 3600000, e); const r = dayRecord(e, d, ctx);
        if (r.kind !== 'missed') continue;
        const m = managerOf(e); const to = [emailOf(e), m && emailOf(m)].filter(Boolean).join(', ');
        await mail('hr.missed', to, 'Missed clock-out · ' + fullName(e) + ' · ' + rangeText(d, d), ['<b>' + escH(fullName(e)) + '</b> clocked in on ' + escH(rangeText(d, d)) + ' but there is no clock-out.', 'A manager can add the missing punch in NovaHR → Time & attendance.'], '/hr?tab=time');
      }
    }
  }
  setInterval(() => { tick().catch(e => errlog('tick', e.message)); }, 5 * 60000).unref();

  // ---------------- for other modules: Designer AI reads who is clocked in ----------------
  const api = {
    ready: () => ready,
    liveFor(crmUserId) {
      const e = byCrm[crmUserId]; if (!e) return null;
      const s = stateFrom(liveCache.map[e.id], e); const day = todayFor(e);
      const lv = (leaveToday.map[e.id] || []).find(r => r.start_date <= day && r.end_date >= day && !r.half_day);
      const [s0, s1] = shiftOf(e), end = zoned(day, s1, tzOf(e)), start = zoned(day, s0, tzOf(e));
      return { state: lv && s.state === 'off' ? 'pto' : s.state, clocked: s.state !== 'off', shift_start_ms: start, shift_end_ms: end, workday: isWorkday(e, day), tracked: !!firstPunch.map[e.id] };
    },
    warm: () => Promise.all([lastPunches(), approvedLeaveMap(), firstPunchDays()]).catch(() => {})
  };
  setInterval(() => { api.warm(); }, 60000).unref();
  ready.then(() => api.warm());
  app.locals.novaHR = api;
  return api;
};
