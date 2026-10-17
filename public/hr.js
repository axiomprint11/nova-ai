/* NovaHR page (1.20.167). Draws every section from GET /api/hr/state and the per-view endpoints in hr.js (server).
   Event handling is one delegated click / input / change listener on [data-act] / [data-in]. No `//` comment ends a code line. */
(function () {
  'use strict';
  const token = () => { try { return localStorage.getItem('axiom_token') || ''; } catch (e) { return ''; } };
  async function api(path, opts) {
    opts = opts || {};
    const h = Object.assign({ Authorization: 'Bearer ' + token() }, opts.headers || {});
    let body = opts.body;
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body === 'object') { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers: h, body });
    if (r.status === 401) { location.href = '/'; throw new Error('Signed out'); }
    if (opts.raw) return r;
    let j = null; try { j = await r.json(); } catch (e) { j = { ok: false, error: 'HTTP ' + r.status }; }
    if (!r.ok && j && j.ok !== false) j.ok = false;
    return j;
  }
  const post = (p, b) => api(p, { method: 'POST', body: b || {} });

  let S = null, LOADED = 0;
  const UI = { view: 'today', q: '', loc: 'all', dept: 'all', incomplete: false, inactive: false, drawer: null, detail: null, tab: 'overview', editing: false,
    tsWeek: null, ts: null, timeTab: 'sheet', adhWeeks: 4, adhSort: 'worst', adh: null, calMonth: null, calLoc: 'all', orgq: '', orgOpen: {}, orgZoom: (() => { try { const z = +localStorage.getItem('hr_org_zoom'); return z >= 0.3 && z <= 1.5 ? z : 1; } catch (e) { return 1; } })(), bandOpen: {},
    rwTab: 'checkin', rwWeek: null, ck: null, setTab: 'types', holLoc: 'all', cover: '', skDept: 'all', skQ: '', draft: {}, myWeek: null, flags: null, kiosks: null, audit: null };
  const params = new URLSearchParams(location.search);
  if (params.get('tab')) UI.view = params.get('tab');
  if (params.get('sub') === 'adh') UI.timeTab = 'adh';
  if (params.get('sub') === 'redeem') UI.rwTab = 'redeem';

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const fmtD = (s, o) => s ? parse(s).toLocaleDateString('en-US', o || { month: 'short', day: 'numeric' }) : '';
  const fmtLong = (s) => fmtD(s, { month: 'short', day: 'numeric', year: 'numeric' });
  const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd0 = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
  const today = () => S ? S.today : iso(new Date());
  const weekday = (s) => { const w = parse(s).getDay(); return w === 0 ? 7 : w; };
  const mondayOf = (s) => addDays(s, 1 - weekday(s));
  const hrsLabel = (h) => { h = Math.max(0, Number(h) || 0); const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return hh + 'h ' + pad(mm === 60 ? 0 : mm) + 'm'; };
  const fmtH = (h) => { const x = ((h % 24) + 24) % 24, hh = Math.floor(x), mm = Math.round((x - hh) * 60); return ((hh % 12) || 12) + (mm ? ':' + pad(mm) : '') + (hh < 12 ? 'a' : 'p'); };
  const LOCN = (k) => (S.locations[k] || S.locations.gl);
  /* 1.20.169: a small flag per location (18x12, inline SVG, no image requests); gl = Glendale = US */
  const FLAGS = {
    gl: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="18" height="12" fill="#fff"/><path d="M0 0h18v1.33H0zM0 2.67h18V4H0zM0 5.33h18v1.34H0zM0 8h18v1.33H0zM0 10.67h18V12H0z" fill="#b22234"/><rect width="8" height="6.67" fill="#3c3b6e"/><g fill="#fff"><circle cx="1.6" cy="1.4" r=".45"/><circle cx="4" cy="1.4" r=".45"/><circle cx="6.4" cy="1.4" r=".45"/><circle cx="2.8" cy="3.3" r=".45"/><circle cx="5.2" cy="3.3" r=".45"/><circle cx="1.6" cy="5.2" r=".45"/><circle cx="4" cy="5.2" r=".45"/><circle cx="6.4" cy="5.2" r=".45"/></g></svg>',
    am: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="18" height="4" fill="#d90012"/><rect y="4" width="18" height="4" fill="#0033a0"/><rect y="8" width="18" height="4" fill="#f2a800"/></svg>',
    mx: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="6" height="12" fill="#006847"/><rect x="6" width="6" height="12" fill="#fff"/><rect x="12" width="6" height="12" fill="#ce1126"/><circle cx="9" cy="6" r="1.6" fill="#8a6a2b"/></svg>',
    ph: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="18" height="6" fill="#0038a8"/><rect y="6" width="18" height="6" fill="#ce1126"/><path d="M0 0l8 6-8 6z" fill="#fff"/><circle cx="2.6" cy="6" r="1.1" fill="#fcd116"/></svg>',
    other: '<svg viewBox="0 0 18 12" aria-hidden="true"><rect width="18" height="12" fill="#e5e7eb"/><circle cx="9" cy="6" r="4" fill="none" stroke="#94a3b8" stroke-width="1"/><path d="M5 6h8M9 2v8" stroke="#94a3b8" stroke-width="1"/></svg>'
  };
  const flag = (k) => '<span class="flag" title="' + esc(LOCN(k).name) + '">' + (FLAGS[S.locations[k] ? k : 'gl'] || FLAGS.other) + '</span>';
  const locName = (k) => '<span class="locn">' + flag(k) + esc(LOCN(k).name) + '</span>';
  const tzNow = (tz) => { const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; }); return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: p.weekday }; };
  const offsetFromLA = (tz) => { const a = tzNow(tz), b = tzNow('America/Los_Angeles'); return (Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi) - Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi)) / 3600000; };
  const clockStr = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date());
  const timeIn = (at, tz) => new Date(at).toLocaleTimeString('en-US', { timeZone: tz || undefined, hour: 'numeric', minute: '2-digit' });
  const isMgr = () => !!(S && (S.viewer.admin || S.viewer.manager));
  const isAdmin = () => !!(S && S.viewer.admin);
  const ME = () => S && S.me;
  let EMAP = {};
  const emp = (id) => EMAP[id] || null;
  const first = (e) => (e && (e.first_name || String(e.name || '').split(' ')[0])) || '';
  const initials = (e) => String(e.name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
  const statusOf = (e) => (e && e.live && e.live.status) || 'off';
  const STATUS_TXT = { working: 'Working', break: 'On break', off: 'Off shift', pto: 'Out today' };
  const STATUS_TAG = { working: 'ok', break: 'warn', off: '', pto: 'pto' };
  const statusTag = (st) => '<span class="tag ' + STATUS_TAG[st] + '"><i class="dot-' + st + '"></i>' + STATUS_TXT[st] + '</span>';
  const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#2563eb', '#0d9488', '#ea580c', '#9333ea', '#16a34a', '#e11d48', '#0284c7', '#65a30d'];
  const nameColor = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  function avatar(e, cls, status) {
    if (!e) return '<span class="av ' + (cls || '') + '" style="background:#cbd5e1">?</span>';
    const dot = status ? '<span class="dot dot-' + status + '"></span>' : '';
    const ph = e.photo_url;
    const bg = ph ? 'background-color:#e5e7eb;background-image:url(\'' + esc(ph) + '\')' : 'background:' + (e.color || nameColor(e.name));
    return '<span class="av ' + (cls || '') + '" style="' + bg + '" aria-hidden="true">' + (ph ? '' : esc(initials(e))) + dot + '</span>';
  }
  const pav = (p, cls) => { const e = p.employee_id && emp(p.employee_id); return e ? avatar(e, cls) : '<span class="av ' + (cls || '') + '" style="background:' + nameColor(p.name) + '" aria-hidden="true">' + esc(initials(p)) + '</span>'; };
  const deptName = (id) => { const d = S && S.org.depts.find(x => x.id === id); return d ? d.name : ''; };
  const shiftArr = (e) => { const s = e.shift_start == null ? 9 : Number(e.shift_start); let en = e.shift_end == null ? s + 9 : Number(e.shift_end); if (en <= s) en += 24; return [s, en]; };
  const shiftLabel = (e) => { const [s, en] = shiftArr(e); return fmtH(s) + '–' + fmtH(en); };
  const DAYN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const daysLabel = (e) => { const d = String(e.shift_days || '1,2,3,4,5'); return d === '1,2,3,4,5' ? 'Mon–Fri' : d === '1,2,3,4,5,6' ? 'Mon–Sat' : d.split(',').map(x => DAYN[+x]).join(', '); };
  const tzOf = (e) => LOCN(e.location).tz;
  const leaveType = (k) => (S.settings.leave_types || []).find(t => t.k === k) || { n: k, k };
  const typeName = (k) => leaveType(k).n;
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }
  const I = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.8 3.1 2.6 3.5 5.2"/></svg>',
    time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2.5v3M16 2.5v3M7 13h3M7 17h3M14 13h3M14 17h3"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3.5a8.5 8.5 0 1 0 3.5 10.8A7 7 0 0 1 17 3.5z"/></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13l2 2 4-4"/></svg>',
    skills: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/></svg>',
    rewards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.4 6.8 19.2l1-5.9L3.5 9.2l5.9-.8z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    org: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="5" rx="1"/><rect x="2.5" y="16" width="6" height="5" rx="1"/><rect x="15.5" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M5.5 16v-4h13v4"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
    badge: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M8.5 17c.6-1.6 2-2.5 3.5-2.5s2.9.9 3.5 2.5M10 2.5v2h4v-2"/></svg>'
  };
  const NAV = [['today', 'Today', 'today'], ['people', 'People', 'people'], ['org', 'Company tree', 'org'], ['time', 'Time & attendance', 'time'], ['timeoff', 'Time off', 'off'],
    ['reviews', 'Reviews', 'review'], ['skills', 'Skills', 'skills'], ['rewards', 'Rewards', 'rewards'], ['settings', 'HR settings', 'settings', 1]];
  const TITLES = { today: 'Today', people: 'People', org: 'Company tree', time: 'Time & attendance', timeoff: 'Time off', reviews: 'Reviews', skills: 'Skills', rewards: 'Rewards', settings: 'HR settings' };

  // ---------- load ----------
  async function load(silent) {
    const j = await api('/api/hr/state' + (UI.inactive ? '?all=1' : ''));
    if (!j || !j.ok) { $('view').innerHTML = '<div class="lock red">' + esc((j && j.error) || 'NovaHR could not load') + '</div>'; return; }
    S = j; LOADED = Date.now(); EMAP = {}; S.employees.forEach(e => { EMAP[e.id] = e; });
    if (S.me && !EMAP[S.me.id]) EMAP[S.me.id] = S.me;
    if (S.me) S.me = EMAP[S.me.id];
    if (!silent) render(); else { render(); if (UI.drawer) drawRender(); }
  }
  function people() { return S.employees.filter(e => e.status !== 'Inactive' || UI.inactive); }

  // ---------- shell ----------
  function renderShell() {
    const pend = S.counts.pending_leave || 0;
    $('nav').innerHTML = NAV.filter(n => !n[3] || isAdmin()).map(n => '<button type="button" data-act="nav" data-k="' + n[0] + '" class="' + (UI.view === n[0] ? 'on' : '') + '">' + I[n[2]] + n[1] + (n[0] === 'timeoff' && pend && isMgr() ? '<span class="count">' + pend + '</span>' : '') + '</button>').join('');
  }
  function render() {
    if (!S) return;
    if (!TITLES[UI.view] || (UI.view === 'settings' && !isAdmin())) UI.view = 'today';
    renderShell();
    $('title').textContent = TITLES[UI.view];
    const n = people().length;
    const sub = { today: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' }) + ' in Glendale',
      people: n + ' people across ' + new Set(people().map(e => e.location)).size + ' locations', time: 'Hours, punches, and how well the team sticks to schedule',
      timeoff: isMgr() ? 'Requests, approvals, and the team calendar' : 'Request days off and see your balance', reviews: S.settings.review.year + ' annual reviews, due ' + fmtD(S.settings.review.due, { month: 'short', day: 'numeric' }),
      skills: 'Who can run what, and where coverage is thin', rewards: 'Points for showing up on schedule and doing great work', org: 'Departments, teams, and who leads them', settings: 'Company-wide time off, holidays, attendance, the time clock and rewards' };
    $('subtitle').textContent = sub[UI.view];
    try { const u = new URL(location.href); u.searchParams.set('tab', UI.view); history.replaceState(null, '', u.pathname + '?' + u.searchParams.toString()); } catch (e) {}
    const v = $('view');
    const keep = v.querySelector('.org-wrap'), sl = keep ? keep.scrollLeft : null, st = keep ? keep.scrollTop : 0;
    v.innerHTML = '<div class="wrap">' + ({ today: vToday, people: vPeople, org: vOrg, time: vTime, timeoff: vTimeoff, reviews: vReviews, skills: vSkills, rewards: vRewards, settings: vSettings })[UI.view]() + '</div>';
    const w = v.querySelector('.org-wrap'); if (w) { orgSize(); w.scrollLeft = sl != null ? sl : (w.scrollWidth - w.clientWidth) / 2; w.scrollTop = st; orgEdges(); }
    after();
  }
  function after() {
    if (UI.view === 'timeoff') rqSummary();
    if (UI.view === 'today' && UI.myWeek == null && ME()) { UI.myWeek = 'loading'; api('/api/hr/timesheets?mine=1').then(j => { UI.myWeek = j && j.ok ? j.rows[0] || null : null; if (UI.view === 'today') render(); }); }
    if (UI.view === 'today' && isMgr() && UI.flags == null) { UI.flags = 'loading'; api('/api/hr/timesheets').then(j => { UI.flags = j && j.ok ? j.rows.filter(r => r.flagged && r.can_manage) : []; if (UI.view === 'today') render(); }); }
    if (UI.view === 'time' && UI.timeTab === 'sheet' && !UI.ts) loadTs();
    if (UI.view === 'time' && UI.timeTab === 'adh' && !UI.adh) loadAdh();
    if (UI.view === 'rewards' && UI.rwTab === 'checkin' && isMgr() && !UI.ck) loadCk();
    if (UI.view === 'settings' && UI.setTab === 'clock' && !UI.kiosks) api('/api/hr/kiosks').then(j => { UI.kiosks = j && j.ok ? j.kiosks : []; if (UI.view === 'settings') render(); });
    if (UI.view === 'settings' && UI.setTab === 'audit' && !UI.audit) api('/api/hr/audit').then(j => { UI.audit = j && j.ok ? j.rows : []; if (UI.view === 'settings') render(); });
  }

  // =========================================================== Today
  function vToday() {
    const me = ME();
    return '<div class="card" style="margin-bottom:16px"><div class="card-h"><h2>Who\'s working now</h2><span class="hint">Shifts on Glendale time · click a location for everyone</span>' +
      '<div class="r legend"><span><i style="background:var(--work)"></i>Working</span><span><i style="background:var(--break)"></i>Break</span><span><i style="background:color-mix(in srgb,var(--accent) 28%,transparent)"></i>Scheduled</span><span><i style="background:var(--pto)"></i>Out</span></div></div>' +
      '<div class="band">' + bandHTML() + '</div></div>' +
      '<div class="grid g-today"><div class="grid" style="align-content:start">' + clockCard(me) + (isMgr() ? (me ? myBalancesCard(me) : '') : (me ? myBalancesCard(me) : '')) + '</div>' +
      '<div class="grid" style="align-content:start">' + (isMgr() ? approvalsCard() : '') + (me ? myRequestsCard(me) : '') + upcomingCard() + '</div></div>';
  }
  function bandHTML() {
    const la = tzNow('America/Los_Angeles'), now = (la.h + la.mi / 60) / 24 * 100;
    const segOf = (e, off) => { const [s0, s1] = shiftArr(e); const a = ((s0 - off) % 24 + 24) % 24, len = s1 - s0; return a + len <= 24 ? [[a, len]] : [[a, 24 - a], [0, a + len - 24]]; };
    const rows = Object.keys(S.locations).map(k => {
      const L = S.locations[k], off = offsetFromLA(L.tz), ppl = people().filter(e => e.location === k && e.status === 'Active');
      if (!ppl.length) return '';
      const wd = tzNow(L.tz).wd, wdn = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd];
      const sched = ppl.filter(e => String(e.shift_days || '1,2,3,4,5').split(',').map(Number).indexOf(wdn) > -1 || ['working', 'break'].indexOf(statusOf(e)) > -1);
      const onNow = ppl.filter(e => ['working', 'break'].indexOf(statusOf(e)) > -1);
      const open = !!UI.bandOpen[k];
      let lanes = '';
      if (open) lanes = sched.map(e => { const st = statusOf(e); return '<div class="lane ' + (st === 'off' ? '' : st) + '" title="' + esc(e.name) + ': ' + shiftLabel(e) + ' local, ' + STATUS_TXT[st].toLowerCase() + '">' + segOf(e, off).map(s => '<i class="seg-s" style="left:' + (s[0] / 24 * 100) + '%;width:' + (s[1] / 24 * 100) + '%"></i>').join('') + '</div>'; }).join('');
      else {
        const groups = {}; sched.forEach(e => { const key = shiftArr(e).join('-'); (groups[key] = groups[key] || []).push(e); });
        lanes = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length).slice(0, 4).map(key => {
          const g = groups[key], on = g.filter(e => ['working', 'break'].indexOf(statusOf(e)) > -1).length, out = g.filter(e => statusOf(e) === 'pto').length;
          const cls = on ? 'working' : out === g.length ? 'pto' : '';
          return '<div class="lane grp ' + cls + '" title="' + esc(shiftLabel(g[0])) + ' local · ' + g.length + ' scheduled, ' + on + ' on now' + (out ? ', ' + out + ' out' : '') + '">' + segOf(g[0], off).map(s => '<i class="seg-s" style="left:' + (s[0] / 24 * 100) + '%;width:' + (s[1] / 24 * 100) + '%"></i>').join('') + '</div>';
        }).join('') || '<div class="muted" style="font-size:12px">No one scheduled today</div>';
      }
      const shown = (onNow.length ? onNow : []).slice(0, 14);
      return '<div class="band-row"><button class="band-loc" type="button" data-act="band" data-k="' + k + '" aria-expanded="' + open + '"><b>' + flag(k) + esc(L.name) + I.chev + '</b><div class="t num">' + clockStr(L.tz) + '</div><small>' + onNow.length + ' of ' + ppl.length + ' on now</small></button>' +
        '<div class="lanes"><span class="nowline" style="left:' + now + '%"></span>' + lanes + '</div>' +
        '<div class="band-people">' + shown.map(e => '<button class="pbtn" data-act="open" data-id="' + e.id + '" title="' + esc(e.name) + ', ' + STATUS_TXT[statusOf(e)].toLowerCase() + '">' + avatar(e, 'sm', statusOf(e)) + '</button>').join('') + (onNow.length > shown.length ? '<span class="more">+' + (onNow.length - shown.length) + '</span>' : '') + (!onNow.length ? '<span class="more">No one on right now</span>' : '') + '</div></div>';
    }).join('');
    const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => '<span style="left:' + (h / 24 * 100) + '%">' + (h === 0 || h === 24 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p') + '</span>').join('');
    return rows + '<div class="axis"><div></div><div class="axis-ticks">' + ticks + '</div><div></div></div>';
  }
  function myWorked() { const me = ME(); if (!me || !me.live) return 0; const w = Number(me.live.worked) || 0; return statusOf(me) === 'working' ? w + (Date.now() - LOADED) / 3600000 : w; }
  function clockCard(me) {
    if (!me) return '<div class="card"><div class="card-h"><h2>My time clock</h2></div><div class="card-b"><div class="lock">' + I.lock + 'You are signed in with an account that has no NovaHR profile, so there is no clock here. ' + (isAdmin() ? 'Everyone in the team has one under People.' : 'Ask HR to add you.') + '</div></div></div>';
    const st = statusOf(me), p = (me.live && me.live.punches) || [];
    const label = { working: 'Clocked in', break: 'On break', off: p.length ? 'Clocked out' : 'Not clocked in', pto: 'Out today (time off)' }[st];
    let acts = '';
    if (st === 'off' || st === 'pto') acts = '<button class="btn primary" data-act="punch" data-t="in">Clock in</button>';
    if (st === 'working') acts = '<button class="btn" data-act="punch" data-t="break">Start break</button><button class="btn bad" data-act="punch" data-t="out">Clock out</button>';
    if (st === 'break') acts = '<button class="btn primary" data-act="punch" data-t="back">End break</button><button class="btn bad" data-act="punch" data-t="out">Clock out</button>';
    const names = { in: 'In', break: 'Break', back: 'Back', out: 'Out' };
    const W = UI.myWeek && UI.myWeek !== 'loading' ? UI.myWeek : null;
    const bars = (W ? W.days : [0, 1, 2, 3, 4, 5, 6].map(i => ({ day: addDays(mondayOf(today()), i), h: 0 }))).map(d => { const h = d.kind === 'live' ? myWorked() : Number(d.h) || 0; return '<div class="' + (d.day === today() ? 'today' : '') + '"><div class="b" title="' + (h ? hrsLabel(h) : 'No hours') + '"><i style="height:' + Math.min(100, h / 10 * 100) + '%"></i></div>' + parse(d.day).toLocaleDateString('en-US', { weekday: 'narrow' }) + '</div>'; }).join('');
    const wk = W ? W.days.reduce((s, d) => s + (d.kind === 'live' ? myWorked() : d.kind === 'missed' ? 0 : Number(d.h) || 0), 0) : 0;
    const L = LOCN(me.location);
    return '<div class="card"><div class="card-h"><h2>My time clock</h2><span class="hint">' + esc(L.note) + ', shift ' + shiftLabel(me) + ' ' + daysLabel(me) + '</span></div><div class="card-b">' +
      '<div class="clock"><div><div class="clock-time num" id="liveClock">' + hrsLabel(myWorked()) + '</div><div class="clock-state">' + label + ' today</div></div><div class="clock-actions">' + acts + '</div></div>' +
      (p.length ? '<div class="punches">' + p.map(x => '<span class="tag">' + names[x.type] + ' ' + timeIn(x.at, tzOf(me)) + (x.source === 'kiosk' ? ' · clock' : '') + '</span>').join('') + '</div>' : '') +
      '<div class="week-bar">' + bars + '</div><div class="muted" style="font-size:12px;margin-top:8px">This week: <b class="num" style="color:var(--ink)">' + hrsLabel(wk) + '</b> of ' + (S.settings.attendance.otWeekly || 40) + 'h</div>' +
      '<div class="clock-foot">' + I.badge + '<span>Time clock PIN: ' + (me.has_pin ? '<b style="color:var(--ink)">set</b>' : '<span class="missing">not set</span>') + '</span><button class="linkbtn" data-act="pin" data-id="' + me.id + '">' + (me.has_pin ? 'Change my PIN' : 'Set my PIN') + '</button><button class="linkbtn" data-act="badge-one" data-id="' + me.id + '">My badge</button></div>' +
      '</div></div>';
  }
  function approvalsCard() {
    const pend = S.leave.filter(r => r.can_decide);
    const flags = Array.isArray(UI.flags) ? UI.flags : [];
    return '<div class="card"><div class="card-h"><h2>Needs your approval</h2><span class="hint">' + pend.length + ' time off, ' + flags.length + ' timesheet</span></div><div class="card-b"><div class="list">' +
      pend.map(r => reqLi(r, true)).join('') +
      flags.map(f => { const e = emp(f.employee_id); if (!e) return ''; const n = f.days.filter(d => d.kind === 'missed' || d.kind === 'absent').length; return '<div class="li">' + avatar(e) + '<div class="meta"><b>' + esc(e.name) + '</b><div class="muted" style="font-size:12px">' + n + ' day' + (n === 1 ? '' : 's') + ' with a missing punch this week</div></div><div class="acts"><button class="btn sm" data-act="nav" data-k="time">Fix timesheet</button></div></div>'; }).join('') +
      (!pend.length && !flags.length ? '<div class="empty">You\'re all caught up.</div>' : '') + '</div></div></div>';
  }
  function reqRange(r) { const n = r.days != null ? r.days : 0; return (r.start_date === r.end_date ? fmtD(r.start_date, { weekday: 'short', month: 'short', day: 'numeric' }) : fmtD(r.start_date) + ' – ' + fmtD(r.end_date)) + ', ' + n + ' day' + (n === 1 ? '' : 's'); }
  function reqLi(r, actions) {
    const e = emp(r.employee_id); if (!e) return '';
    const stTag = { pending: '<span class="tag warn">Pending</span>', approved: '<span class="tag ok">Approved</span>', declined: '<span class="tag bad">Declined</span>', cancelled: '<span class="tag">Cancelled</span>' }[r.status] || '';
    let acts = stTag;
    if (actions && r.can_decide) acts = '<button class="btn sm ok" data-act="approve" data-id="' + r.id + '">Approve</button><button class="btn sm bad" data-act="decline" data-id="' + r.id + '">Decline</button>';
    else if (actions && ME() && r.employee_id === ME().id && (r.status === 'pending' || (r.status === 'approved' && r.start_date > today()))) acts = stTag + ' <button class="btn sm ghost" data-act="cancel-req" data-id="' + r.id + '">Cancel</button>';
    return '<div class="li">' + avatar(e) + '<div class="meta"><b>' + esc(e.name) + '</b> <span class="tag pto">' + esc(typeName(r.type)) + (r.half_day ? ', half day' : '') + '</span><div class="muted" style="font-size:12px">' + reqRange(r) + (r.note ? ' — ' + esc(r.note) : '') + '</div>' + (r.decision_note ? '<div style="font-size:12px;margin-top:3px;color:var(--ink-2)">Manager: ' + esc(r.decision_note) + '</div>' : '') + '</div><div class="acts">' + acts + '</div></div>';
  }
  function myRequestsCard(me) {
    const mine = S.leave.filter(r => r.employee_id === me.id && r.end_date >= addDays(today(), -30)).sort((a, b) => b.start_date.localeCompare(a.start_date));
    return '<div class="card"><div class="card-h"><h2>My time off requests</h2><div class="r"><button class="btn sm primary" data-act="nav" data-k="timeoff">Request time off</button></div></div><div class="card-b"><div class="list">' + (mine.length ? mine.map(r => reqLi(r, true)).join('') : '<div class="empty">No requests yet.</div>') + '</div></div></div>';
  }
  function myBalancesCard() { return '<div class="card"><div class="card-h"><h2>My balances</h2><span class="hint">Resets Jan 1</span></div><div class="card-b">' + balancesHTML(S.balances) + '</div></div>'; }
  function balancesHTML(b) {
    const list = (b || []).filter(x => x.track);
    if (!list.length) return '<div class="muted">No tracked balances.</div>';
    return '<div class="bal">' + list.map(x => '<div><small>' + esc(x.n) + '</small><b class="num">' + x.left + '</b><small>of ' + x.allowance + ' days left' + (x.pending ? ', ' + x.pending + ' pending' : '') + (x.accrual === 'Monthly' ? ' · earned monthly' : '') + '</small><div class="meter"><i style="width:' + (x.allowance ? Math.max(0, Math.min(100, x.left / x.allowance * 100)) : 0) + '%"></i></div></div>').join('') + '</div>';
  }
  function upcomingCard() {
    const t = today(), horizon = addDays(t, 30);
    const out = S.leave.filter(r => r.status !== 'declined' && r.end_date >= t && r.start_date <= horizon).sort((a, b) => a.start_date.localeCompare(b.start_date));
    const hol = S.holidays.filter(h => h.date >= t && h.date <= addDays(t, 45));
    const md = (s) => s.slice(5, 10), within = (mmdd) => { for (let i = 0; i <= 30; i++) if (md(addDays(t, i)) === mmdd) return addDays(t, i); return null; };
    const cel = [];
    people().filter(e => e.status === 'Active').forEach(e => { if (e.bday) { const d = within(e.bday); if (d) cel.push({ e, txt: 'Birthday', d }); } if (e.hire_date && +e.hire_date.slice(0, 4) < +t.slice(0, 4)) { const d = within(md(e.hire_date)); if (d) { const y = +d.slice(0, 4) - +e.hire_date.slice(0, 4); if (y > 0) cel.push({ e, txt: y + ' year' + (y === 1 ? '' : 's') + ' at Axiom', d }); } } });
    cel.sort((a, b) => a.d.localeCompare(b.d));
    const rows = out.slice(0, 14).map(r => { const e = emp(r.employee_id); if (!e) return ''; return '<div class="li">' + avatar(e, 'sm') + '<div class="meta">' + esc(e.name) + ' <span class="muted">' + (r.status === 'pending' ? 'may be out' : 'out') + '</span></div><span class="muted num" style="font-size:12px">' + (r.start_date === r.end_date ? fmtD(r.start_date) : fmtD(r.start_date) + ' – ' + fmtD(r.end_date)) + '</span></div>'; }).join('') +
      hol.map(h => '<div class="li"><span class="av sm" style="background:var(--warn-soft);color:var(--warn)">H</span><div class="meta">' + esc(h.name) + ' <span class="muted">' + locName(h.location) + ' team off</span></div><span class="muted num" style="font-size:12px">' + fmtD(h.date) + '</span></div>').join('') +
      cel.slice(0, 14).map(c => '<div class="li">' + avatar(c.e, 'sm') + '<div class="meta">' + esc(c.e.name) + ' <span class="muted">' + esc(c.txt) + '</span></div><span class="muted num" style="font-size:12px">' + fmtD(c.d) + '</span></div>').join('');
    return '<div class="card"><div class="card-h"><h2>Coming up</h2><span class="hint">Next 30 days</span></div><div class="card-b"><div class="list">' + (rows || '<div class="empty">Nothing coming up.</div>') + '</div></div></div>';
  }

  // =========================================================== People
  function missingCount(e) { return (e.missing || []).length; }
  function completePct(e) { return e.req_total ? Math.round((e.req_total - missingCount(e)) / e.req_total * 100) : null; }
  function vPeople() {
    const q = UI.q.toLowerCase().trim();
    const langName = (k) => { const l = (S.settings.languages.list || []).find(x => x.k === k); return l ? l.n : ''; };
    const list = people().filter(e => (!UI.incomplete || missingCount(e)) && (UI.loc === 'all' || e.location === UI.loc) && (UI.dept === 'all' || String(e.department_id) === String(UI.dept)) &&
      (!q || q.split(/\s+/).every(w => [e.name, e.title, deptName(e.department_id), e.work_email, e.username, e.legal_first, e.legal_last, Object.keys(e.langs || {}).map(langName).join(' ')].join(' ').toLowerCase().indexOf(w) > -1)));
    const showPay = isMgr();
    const incN = people().filter(e => missingCount(e)).length;
    return '<div class="toolbar"><div class="search">' + I.search + '<input class="input" placeholder="Search name, role, email or language" value="' + esc(UI.q) + '" data-in="q" aria-label="Search people"></div>' +
      '<div class="chips">' + [['all', 'All locations']].concat(Object.keys(S.locations).map(k => [k, S.locations[k].name])).map(([k, n]) => '<button class="chip" data-act="loc" data-k="' + k + '" aria-pressed="' + (UI.loc === k) + '">' + (k === 'all' ? '' : flag(k)) + esc(n) + '</button>').join('') + '</div>' +
      '<select class="select" data-in="dept" aria-label="Department"><option value="all">All departments</option>' + S.org.depts.map(d => '<option value="' + d.id + '" ' + (String(UI.dept) === String(d.id) ? 'selected' : '') + '>' + esc(d.name) + '</option>').join('') + '</select>' +
      (isMgr() ? '<button class="chip" data-act="incomplete" aria-pressed="' + UI.incomplete + '">Missing info ' + incN + '</button><button class="chip" data-act="inactive" aria-pressed="' + UI.inactive + '">Show inactive</button>' +
        '<span style="margin-left:auto;display:flex;gap:8px"><button class="btn" data-act="badges">' + I.badge + 'Print badges</button><button class="btn primary" data-act="add">Add employee</button></span>' : '') + '</div>' +
      '<div class="card tbl-wrap"><table><thead><tr><th>Name</th><th>Department</th><th>Location</th><th>Local time</th><th>Status</th><th>Reports to</th>' + (showPay ? '<th class="r">Pay</th><th>Profile</th><th>PIN</th>' : '') + '<th>Started</th></tr></thead><tbody>' +
      (list.map(e => {
        const st = statusOf(e), m = emp(e.reports_to), p = completePct(e);
        return '<tr class="click" data-act="open" data-id="' + e.id + '"><td><div class="who">' + avatar(e, '', st) + '<div><b>' + esc(e.name) + (e.status !== 'Active' ? ' <span class="tag">' + esc(e.status) + '</span>' : '') + '</b><small>' + esc(e.title || '') + '</small></div></div></td>' +
          '<td>' + esc(deptName(e.department_id)) + '</td><td>' + locName(e.location) + '</td><td class="num">' + clockStr(tzOf(e)) + '</td><td>' + statusTag(st) + '</td>' +
          '<td>' + (m ? esc(m.name) : '<span class="muted">—</span>') + '</td>' +
          (showPay ? '<td class="r num">' + (e.priv ? payText(e) : '<span class="muted">—</span>') + '</td><td>' + (p == null ? '<span class="muted">—</span>' : '<span class="pc" title="' + esc((e.missing || []).map(x => x[1]).join(', ') || 'Complete') + '"><span class="meter"><i style="width:' + p + '%;background:' + (p === 100 ? 'var(--work)' : p >= 85 ? 'var(--accent)' : 'var(--break)') + '"></i></span><span class="num">' + p + '%</span></span>') + '</td><td>' + (e.priv ? (e.has_pin ? '<span class="tag ok">Set</span>' : '<span class="tag">—</span>') : '') + '</td>' : '') +
          '<td class="num">' + (e.hire_date ? fmtD(e.hire_date, { month: 'short', year: 'numeric' }) : '<span class="muted">—</span>') + '</td></tr>';
      }).join('') || '<tr><td colspan="10"><div class="empty">No one matches those filters.</div></td></tr>') + '</tbody></table></div>';
  }
  function payText(e) { if (e.pay_rate == null || e.pay_rate === '') return '<span class="muted">Not set</span>'; return e.pay_type === 'Salary' ? usd0(e.pay_rate) + '/yr' : usd(e.pay_rate) + '/hr'; }

  // =========================================================== Profile drawer
  async function openDrawer(id, tab) {
    UI.drawer = +id; UI.tab = tab || 'overview'; UI.editing = false; UI.detail = null;
    $('drawer').classList.add('on'); $('scrim').classList.add('on');
    drawRender();
    const j = await api('/api/hr/employees/' + id);
    if (UI.drawer !== +id) return;
    UI.detail = j && j.ok ? j : { employee: emp(id) };
    if (j && j.ok && j.employee) { Object.assign(EMAP[id] || {}, j.employee); }
    drawRender();
  }
  function closeAll() { UI.drawer = null; $('drawer').classList.remove('on'); $('scrim').classList.remove('on'); closeModal(); }
  function closeModal() { $('modal').classList.remove('on', 'wide'); setTimeout(() => { if (!$('modal').classList.contains('on')) $('modalBox').innerHTML = ''; }, 200); }
  function openModal(html, wide) { $('modalBox').innerHTML = html; $('modal').classList.add('on'); $('modal').classList.toggle('wide', !!wide); }
  function drawRender() {
    const e = emp(UI.drawer); if (!e) { $('drawer').innerHTML = '<div class="empty">Loading…</div>'; return; }
    const priv = e.priv, st = statusOf(e);
    const tabs = [['overview', 'Overview'], ['job', 'Job & pay', 1], ['timeoff', 'Time off', 1], ['skills', 'Skills & languages'], ['review', 'Performance', 1], ['docs', 'Documents', 1]].filter(t => !t[2] || priv);
    if (!tabs.find(t => t[0] === UI.tab)) UI.tab = 'overview';
    const L = LOCN(e.location);
    $('drawer').innerHTML = '<div class="dr-h">' + avatar(e, 'lg', st) + '<div style="min-width:0"><h2>' + esc(e.name) + '</h2><div class="muted">' + esc(e.title || '') + (deptName(e.department_id) ? ', ' + esc(deptName(e.department_id)) : '') + '</div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' + statusTag(st) + '<span class="tag">' + flag(e.location) + esc(L.name) + ', ' + clockStr(L.tz) + ' local</span>' + (e.employment_type ? '<span class="tag">' + esc(e.employment_type) + '</span>' : '') + (e.status !== 'Active' ? '<span class="tag warn">' + esc(e.status) + '</span>' : '') + '</div></div>' +
      '<button class="btn ghost x" data-act="close" aria-label="Close">' + I.x + '</button></div>' + completeHTML(e) +
      '<div class="tabs" role="tablist">' + tabs.map(t => '<button role="tab" data-act="tab" data-k="' + t[0] + '" aria-selected="' + (UI.tab === t[0]) + '">' + t[1] + '</button>').join('') + '</div>' +
      '<div class="dr-b">' + (UI.detail ? ({ overview: tOverview, job: tJob, timeoff: tTimeoff, skills: tSkills, review: tReview, docs: tDocs })[UI.tab](e) : '<div class="empty">Loading…</div>') + '</div>';
  }
  function completeHTML(e) {
    if (!e.priv || !e.req_total) return '';
    const miss = e.missing || [], have = e.req_total - miss.length, pct = Math.round(have / e.req_total * 100);
    return '<div class="complete ' + (pct === 100 ? 'done' : '') + '"><div class="complete-top"><b>Profile ' + (pct === 100 ? 'complete' : have + ' of ' + e.req_total + ' filled in') + '</b><div class="meter"><i style="width:' + pct + '%"></i></div></div>' +
      (miss.length ? '<div class="miss-list">' + miss.map(([k, l]) => '<button class="tag warn" data-act="fill" data-k="' + k + '">' + esc(l) + '</button>').join('') + '</div>' : '') + '</div>';
  }
  const canEditSelf = (e) => !!(ME() && ME().id === e.id);
  const edited = (e, k) => String(e.nova_edited || '').split(',').indexOf(k) > -1;
  const CRM_KEYS = ['first_name', 'last_name', 'work_email', 'work_phone', 'username', 'hire_date', 'title', 'legal_first', 'legal_last', 'personal_email', 'personal_phone', 'birth_date', 'photo_url', 'commission_pct'];
  function FF(e, k, label, opt) {
    opt = opt || {};
    const v = e[k], id = 'f_' + k;
    const canEd = UI.editing && (e.can_manage || (opt.self && canEditSelf(e))) && !opt.ro;
    const crm = e.crm_user_id && CRM_KEYS.indexOf(k) > -1 ? '<span class="tag crm" title="' + (edited(e, k) ? 'Edited in NovaHR — the CRM sync leaves it alone' : 'From the Axiom CRM — kept in step every 15 min until edited here') + '">' + (edited(e, k) ? 'NOVA' : 'CRM') + '</span>' : '';
    const miss = (v === '' || v == null) && !opt.optional;
    if (canEd) {
      let ctl;
      if (opt.opts) ctl = '<select class="select" id="' + id + '" data-f="' + k + '">' + (opt.blank ? '<option value="">Not set</option>' : '') + opt.opts.map(o => Array.isArray(o) ? '<option value="' + esc(o[0]) + '" ' + (String(o[0]) === String(v) ? 'selected' : '') + '>' + esc(o[1]) + '</option>' : '<option ' + (o === v ? 'selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
      else ctl = '<input class="input" id="' + id + '" data-f="' + k + '" type="' + (opt.type || 'text') + '" ' + (opt.step ? 'step="' + opt.step + '"' : '') + ' value="' + esc(v == null ? '' : v) + '" ' + (opt.ph ? 'placeholder="' + esc(opt.ph) + '"' : '') + '>';
      return '<div class="field ' + (opt.full ? 'full' : '') + '"><label for="' + id + '">' + esc(label) + crm + '</label>' + ctl + '</div>';
    }
    let shown = v;
    if (opt.type === 'date' && v) shown = fmtLong(v);
    if (opt.opts && Array.isArray(opt.opts[0])) { const f = opt.opts.find(o => String(o[0]) === String(v)); shown = f ? f[1] : v; }
    if (opt.fmt) shown = opt.fmt(v);
    return '<div class="field ' + (opt.full ? 'full' : '') + '"><label>' + esc(label) + crm + '</label><div class="v">' + (v !== '' && v != null ? esc(shown) : '<span class="' + (miss ? 'missing' : 'muted') + '">' + (miss ? 'Missing' : '—') + '</span>') + '</div></div>';
  }
  function editBar(e) {
    if (!(e.can_manage || canEditSelf(e))) return '';
    return '<span class="r">' + (UI.editing ? '<button class="btn sm" data-act="edit-cancel">Cancel</button><button class="btn sm primary" data-act="edit-save">Save changes</button>' : '<button class="btn sm" data-act="edit">Edit details</button>') + '</span>';
  }
  const PERMS = [['perm_submitter', 'Is submitter', 'Can submit jobs to production'], ['perm_all_projects', 'View all projects', 'Sees every job, not just their own'], ['perm_mail', 'Enable mail', 'Sends and reads email inside the CRM'], ['perm_products', 'View products', 'Sees product setup and pricing']];
  function tOverview(e) {
    const priv = e.priv, m = emp(e.reports_to), reports = people().filter(x => x.reports_to === e.id);
    const selfNote = UI.editing && !e.can_manage ? '<div class="lock">' + I.lock + 'You can update your personal details and emergency contact. Ask your manager to change work details.</div>' : '';
    const permsHTML = PERMS.map(([k, n, d]) => { const on = !!Number(e[k]); return '<div class="perm"><span class="pi ' + (on ? 'on' : '') + '">' + (on ? '✓' : '') + '</span><span><b>' + n + '</b><small>' + d + '</small></span></div>'; }).join('');
    const opts = (S.roles || []);
    let h = selfNote + '<div class="sec"><h3>Work information' + editBar(e) + '</h3><div class="fields">' +
      FF(e, 'first_name', 'First name') + FF(e, 'last_name', 'Last name') + FF(e, 'work_email', 'Work email', { type: 'email' }) + FF(e, 'work_phone', 'Work phone', { type: 'tel', ph: '(747) 888-7777 ext. 101' }) +
      (priv ? FF(e, 'username', 'Username') : '') + FF(e, 'hire_date', 'Start date', { type: 'date' }) +
      (priv ? FF(e, 'role', 'Role', { opts: opts, blank: 1 }) : '') + FF(e, 'title', 'Title') +
      (priv ? FF(e, 'status', 'Status', { opts: ['Active', 'On leave', 'Inactive'] }) + FF(e, 'account_type', 'Type', { opts: ['Member', 'Manager', 'Admin'], ro: !isAdmin() }) : '') + '</div>' +
      (priv ? '<div class="sub-h">System access <span class="muted" style="font-weight:500">· set in the Axiom CRM (user form) — NovaHR shows them, never changes them</span></div><div class="perms">' + permsHTML + '</div>' : '') + '</div>';
    if (priv) {
      h += '<div class="sec"><h3>Personal information</h3><div class="photo-row">' + avatar(e, 'xl') + '<div><b>Profile photo</b><div class="muted" style="font-size:12px">' + (e.photo_url ? 'Shows on the time clock, badges, the company tree and reports.' : '<span class="missing">Missing.</span> A face makes the team list easier to scan.') + '</div>' +
        (UI.editing ? '<label class="btn sm" style="margin-top:8px">' + (e.photo_url ? 'Replace photo' : 'Upload photo') + '<input type="file" accept="image/*" data-photo="' + e.id + '" hidden></label>' + (edited(e, 'photo_url') ? ' <button class="btn sm ghost" data-act="photo-del">Back to the CRM photo</button>' : '') : '') + '</div></div>' +
        '<div class="sub-h">Legal name and contact</div><div class="fields">' +
        FF(e, 'legal_first', 'Legal first name', { self: 1 }) + FF(e, 'legal_last', 'Legal last name', { self: 1 }) + FF(e, 'personal_email', 'Personal email', { type: 'email', self: 1 }) + FF(e, 'personal_phone', 'Personal phone', { type: 'tel', self: 1 }) +
        FF(e, 'birth_date', 'Birthday', { type: 'date', self: 1 }) + '<div class="field"><label>Shift (local)</label><div class="v">' + shiftLabel(e) + ', ' + daysLabel(e) + '</div></div>' +
        FF(e, 'address', 'Home address', { self: 1, full: 1 }) + FF(e, 'city_state_zip', 'City, state, zip', { self: 1, full: 1 }) + '</div></div>' +
        '<div class="sec"><h3>Emergency contact</h3><div class="fields">' + FF(e, 'emergency_name', 'Name', { self: 1 }) + FF(e, 'emergency_rel', 'Relationship', { self: 1, optional: 1 }) + FF(e, 'emergency_phone', 'Phone', { type: 'tel', self: 1 }) + '</div></div>';
      if (e.can_manage || canEditSelf(e)) h += clockSection(e);
    }
    const langName = (k) => { const l = (S.settings.languages.list || []).find(x => x.k === k); return l ? l.n : null; };
    const lt = Object.entries(e.langs || {}).filter(([k]) => langName(k)).sort((a, b) => b[1] - a[1]).map(([k, v]) => '<span class="tag">' + esc(langName(k)) + ' <span class="muted">' + esc(S.settings.languages.levels[v] || '') + '</span></span>').join('');
    h += '<div class="sec"><h3>Languages<span class="r"><button class="btn sm ghost" data-act="tab" data-k="skills">' + (e.can_manage || canEditSelf(e) ? 'Edit' : 'View') + '</button></span></h3><div class="chips">' + (lt || '<span class="missing">None added</span>') + '</div></div>' +
      '<div class="sec"><h3>Team</h3><div class="list">' +
      (m ? '<div class="li">' + avatar(m) + '<div class="meta"><b>' + esc(m.name) + '</b><small class="muted">Reports to</small></div><button class="btn sm" data-act="open" data-id="' + m.id + '">View</button></div>' : '') +
      reports.map(r => '<div class="li">' + avatar(r, '', statusOf(r)) + '<div class="meta"><b>' + esc(r.name) + '</b><small class="muted">' + esc(r.title || '') + '</small></div><button class="btn sm" data-act="open" data-id="' + r.id + '">View</button></div>').join('') +
      (!m && !reports.length ? '<div class="empty">No team links yet.</div>' : '') + '</div></div>';
    return h;
  }
  function clockSection(e) {
    const self = canEditSelf(e);
    return '<div class="sec"><h3>Time clock</h3><div class="clockbox">' +
      '<div><b>PIN</b><small>' + (e.has_pin ? 'Set ' + (e.pin_set_at ? fmtLong(e.pin_set_at.slice(0, 10)) : '') + '. Used at the time clock by the door.' : 'No PIN yet — needed for the time clock by the door.') + '</small>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm primary" data-act="pin" data-id="' + e.id + '">' + (self ? (e.has_pin ? 'Change my PIN' : 'Set my PIN') : (e.has_pin ? 'New PIN' : 'Make a PIN')) + '</button>' + (e.has_pin && e.can_manage && !self ? '<button class="btn sm ghost" data-act="pin-clear" data-id="' + e.id + '">Clear</button>' : '') + '</div></div>' +
      '<div><b>Badge</b><small>QR badge, version ' + (e.badge_ver || 1) + '. Scan it at the time clock instead of typing the PIN.</small><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" data-act="badge-one" data-id="' + e.id + '">Show / print</button>' + (e.can_manage ? '<button class="btn sm ghost" data-act="badge-reissue" data-id="' + e.id + '" title="The old badge stops working">Lost — new badge</button>' : '') + '</div></div>' +
      '</div></div>';
  }
  function tJob(e) {
    const d = UI.detail || {}, ed = e.can_manage;
    const yrs = e.hire_date ? (Date.now() - parse(e.hire_date)) / 31557600000 : 0;
    const lock = ed ? '' : '<div class="lock">' + I.lock + 'Only you and your manager can see this. Ask your manager to change anything here.</div>';
    const sel = (k, opts, v) => '<select class="select" data-jf="' + k + '"' + (k === 'reports_to' ? ' data-people' : k === 'location' ? ' data-loc' : '') + (ed ? '' : ' disabled') + '>' + opts.map(o => Array.isArray(o) ? '<option value="' + esc(o[0]) + '" ' + (String(o[0]) === String(v) ? 'selected' : '') + '>' + esc(o[1]) + '</option>' : '<option ' + (o === v ? 'selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    const val = (x) => '<div class="v">' + (x == null || x === '' ? '<span class="muted">—</span>' : esc(x)) + '</div>';
    const [s0, s1] = shiftArr(e), hm = (h) => pad(Math.floor(((h % 24) + 24) % 24)) + ':' + pad(Math.round((h % 1) * 60));
    const days = String(e.shift_days || '1,2,3,4,5').split(',').map(Number);
    const others = people().filter(x => x.id !== e.id).sort((a, b) => a.name.localeCompare(b.name));
    const monthly = e.pay_rate ? (e.pay_type === 'Salary' ? e.pay_rate / 12 : e.pay_rate * 173) : 0;
    return lock + '<div class="sec"><h3>Position</h3><div class="fields">' +
      '<div class="field"><label>Job title</label>' + (ed ? '<input class="input" data-jf="title" value="' + esc(e.title || '') + '">' : val(e.title)) + '</div>' +
      '<div class="field"><label>Department</label>' + (ed ? sel('department_id', [['', 'None']].concat(S.org.depts.map(x => [x.id, x.name])), e.department_id) : val(deptName(e.department_id))) + '</div>' +
      '<div class="field"><label>Employment type</label>' + (ed ? sel('employment_type', ['Full-time', 'Part-time', 'Contractor'], e.employment_type) : val(e.employment_type)) + '</div>' +
      '<div class="field"><label>Reports to</label>' + (ed ? sel('reports_to', [['', 'No manager']].concat(others.map(x => [x.id, x.name])), e.reports_to) : val(emp(e.reports_to) ? emp(e.reports_to).name : '')) + '</div>' +
      '<div class="field"><label>Location</label>' + (ed ? sel('location', Object.keys(S.locations).map(k => [k, S.locations[k].name]), e.location) : '<div class="val">' + locName(e.location) + '</div>') + '</div>' +
      '<div class="field"><label>Time with Axiom</label>' + val(e.hire_date ? Math.floor(yrs) + ' yr ' + Math.floor((yrs % 1) * 12) + ' mo (since ' + fmtLong(e.hire_date) + ')' : '') + '</div>' +
      '<div class="field"><label>Shift start (' + esc(LOCN(e.location).name) + ' time)</label>' + (ed ? '<input class="input" type="time" data-jf="shift_start" value="' + hm(s0) + '">' : val(fmtH(s0))) + '</div>' +
      '<div class="field"><label>Shift end</label>' + (ed ? '<input class="input" type="time" data-jf="shift_end" value="' + hm(s1) + '">' : val(fmtH(s1) + (s1 > 24 ? ' (next day)' : ''))) + '</div>' +
      '<div class="field full"><label>Work days</label>' + (ed ? '<div class="chips">' + [1, 2, 3, 4, 5, 6, 7].map(n => '<button type="button" class="chip" data-act="wd" data-n="' + n + '" aria-pressed="' + (days.indexOf(n) > -1) + '">' + DAYN[n] + '</button>').join('') + '</div><input type="hidden" data-jf="shift_days" value="' + esc(days.join(',')) + '">' : val(daysLabel(e))) + '</div>' +
      '</div></div>' +
      '<div class="sec"><h3>Compensation</h3><div class="fields">' +
      '<div class="field"><label>Pay type</label>' + (ed ? sel('pay_type', ['Hourly', 'Salary'], e.pay_type || 'Hourly') : val(e.pay_type)) + '</div>' +
      '<div class="field"><label>' + (e.pay_type === 'Salary' ? 'Annual salary (USD)' : 'Hourly rate (USD)') + '</label>' + (ed ? '<input class="input num" type="number" step="0.25" min="0" data-jf="pay_rate" value="' + esc(e.pay_rate == null ? '' : e.pay_rate) + '">' : '<div class="v num">' + payText(e) + '</div>') + '</div>' +
      '<div class="field"><label>Paid through</label>' + (ed ? sel('pay_method', [['', 'Not set'], 'Direct deposit', 'Wise (USD)', 'Check'], e.pay_method || '') : val(e.pay_method)) + '</div>' +
      '<div class="field"><label>Commission percent' + (e.crm_user_id ? ' <span class="tag crm">' + (edited(e, 'commission_pct') ? 'NOVA' : 'CRM') + '</span>' : '') + '</label>' + (ed ? '<input class="input num" type="number" step="0.25" min="0" data-jf="commission_pct" value="' + esc(e.commission_pct == null ? '' : e.commission_pct) + '">' : val(e.commission_pct ? Number(e.commission_pct).toFixed(2) + '%' : '')) + '</div>' +
      (ed ? '<div class="field"><label>Pay change effective</label><input class="input" type="date" data-jf="pay_effective" value="' + today() + '"></div><div class="field"><label>Reason for a pay change</label><input class="input" data-jf="pay_reason" placeholder="e.g. Annual review raise"></div>' : '') +
      '<div class="field"><label>Est. monthly cost</label><div class="v num">' + (monthly ? usd0(monthly) : '<span class="muted">—</span>') + '</div></div>' +
      '</div>' + (ed ? '<div class="save-bar"><button class="btn primary" data-act="job-save">Save job & pay</button></div>' : '') + '</div>' +
      '<div class="sec"><h3>Pay history</h3><table><thead><tr><th>Effective</th><th>Change</th><th class="r">Rate</th><th>By</th></tr></thead><tbody>' +
      ((d.pay_history || []).map(p => '<tr><td class="num">' + fmtLong(p.effective_date) + '</td><td>' + esc(p.reason || '') + '</td><td class="r num">' + (p.pay_rate == null ? '—' : p.pay_type === 'Salary' ? usd0(p.pay_rate) + '/yr' : usd(p.pay_rate) + '/hr') + '</td><td class="muted">' + esc(p.changed_by || '') + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">No pay changes recorded in NovaHR yet.</td></tr>') + '</tbody></table></div>';
  }
  function tTimeoff(e) {
    const d = UI.detail || {};
    const rs = (d.leave || []).map(r => Object.assign({}, r, { can_decide: r.status === 'pending' && e.can_manage && !(ME() && ME().id === e.id && !isAdmin()) }));
    return '<div class="sec"><h3>Balances <span class="muted" style="font-weight:500">' + today().slice(0, 4) + '</span>' + (isAdmin() ? '<span class="r"><button class="btn sm" data-act="adjust" data-id="' + e.id + '">Adjust balances</button></span>' : '') + '</h3>' + balancesHTML(d.balances) + '</div>' +
      '<div class="sec"><h3>Requests' + (e.can_manage && !(ME() && ME().id === e.id) ? '<span class="r"><button class="btn sm" data-act="req-for" data-id="' + e.id + '">Add time off</button></span>' : '') + '</h3><div class="list">' + (rs.length ? rs.map(r => reqLi(r, true)).join('') : '<div class="empty">No requests yet.</div>') + '</div></div>';
  }
  function tSkills(e) {
    const ed = e.can_manage, L = S.settings.languages, LV = S.settings.skill_levels;
    const langEd = e.can_manage || canEditSelf(e);
    const langName = (k) => { const l = (L.list || []).find(x => x.k === k); return l ? l.n : null; };
    const have = Object.entries(e.langs || {}).filter(([k]) => langName(k)).sort((a, b) => b[1] - a[1]);
    const left = (L.list || []).filter(l => !(e.langs || {}).hasOwnProperty(l.k));
    let h = '<div class="sec"><h3>Languages spoken</h3>' +
      (have.length ? have.map(([k, v]) => '<div class="score-row"><div><b>' + esc(langName(k)) + '</b></div><div style="display:flex;gap:6px;align-items:center">' +
        (langEd ? '<div class="seg">' + L.levels.map((n, i) => '<button data-act="lang-lv" data-id="' + e.id + '" data-k="' + k + '" data-n="' + i + '" aria-pressed="' + (i === v) + '">' + esc(n) + '</button>').join('') + '</div><button class="btn sm ghost" data-act="lang-del" data-id="' + e.id + '" data-k="' + k + '" aria-label="Remove">' + I.x + '</button>' : '<span class="tag acc">' + esc(L.levels[v]) + '</span>') + '</div></div>').join('') : '<div class="muted" style="font-size:13px">No languages added yet.</div>') +
      (langEd && left.length ? '<div class="lang-add"><select class="select" id="lg_k">' + left.map(l => '<option value="' + l.k + '">' + esc(l.n) + '</option>').join('') + '</select><select class="select" id="lg_v">' + L.levels.map((n, i) => '<option value="' + i + '" ' + (i === 2 ? 'selected' : '') + '>' + esc(n) + '</option>').join('') + '</select><button class="btn sm primary" data-act="lang-add" data-id="' + e.id + '">Add language</button></div>' : '') + '</div>';
    const groups = []; (S.settings.skills || []).forEach(s => { if (groups.indexOf(s.g) < 0) groups.push(s.g); });
    h += '<div class="sec"><h3>Skills & equipment</h3><p class="muted" style="margin:-6px 0 10px;font-size:12px">' + (ed ? 'Tap a level to change it.' : 'Ask your manager to update a level after training.') + '</p>' +
      groups.map(g => '<div style="margin-bottom:10px"><div class="muted" style="font-size:11.5px;margin:8px 0 2px;font-weight:700">' + esc(g) + '</div>' + S.settings.skills.filter(s => s.g === g).map(s => { const lv = (e.skills || {})[s.k] || 0; return '<div class="score-row"><div><b>' + esc(s.n) + '</b><small>' + esc(LV[lv]) + '</small></div><div class="score">' + [0, 1, 2, 3, 4].map(n => '<button aria-label="' + esc(LV[n]) + '" title="' + esc(LV[n]) + '" aria-pressed="' + (n === lv) + '" ' + (ed ? 'data-act="skill" data-id="' + e.id + '" data-k="' + s.k + '" data-n="' + n + '"' : 'disabled') + '>' + n + '</button>').join('') + '</div></div>'; }).join('') + '</div>').join('') + '</div>';
    return h;
  }
  function tReview(e) {
    const d = UI.detail || {}, ev = S.reviews[e.id] || { stage: 'none' }, yr = S.settings.review.year;
    const self = canEditSelf(e);
    return '<div class="sec"><h3>' + yr + ' annual review<span class="r">' + reviewTag(ev) + '</span></h3>' +
      (ev.avg ? '<div class="overall"><b class="num">' + ev.avg.toFixed(1) + '</b><div><div style="font-weight:700">' + SCALE[Math.round(ev.avg)] + '</div><div class="muted" style="font-size:12px">Overall, average of ' + S.settings.review.areas.length + ' areas</div></div></div>' : '') +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
      (e.can_manage && !self ? '<button class="btn primary" data-act="eval" data-id="' + e.id + '">' + (ev.stage === 'done' ? 'View review' : 'Open review') + '</button>' : '') +
      (self ? '<button class="btn primary" data-act="eval" data-id="' + e.id + '">' + (ev.stage === 'none' || ev.stage === 'self' ? 'Write self-review' : 'View review') + '</button>' : '') +
      (ev.stage === 'done' ? '<button class="btn" data-act="report" data-id="' + e.id + '">Open report</button>' : '') + '</div></div>' +
      '<div class="sec"><h3>Past reviews</h3><table><thead><tr><th>Year</th><th>Reviewer</th><th>Stage</th><th class="r">Overall</th></tr></thead><tbody>' +
      ((d.reviews || []).filter(r => r.year !== yr).map(r => '<tr><td>' + r.year + '</td><td>' + esc(emp(r.reviewer_id) ? emp(r.reviewer_id).name : '—') + '</td><td>' + reviewTag(r) + '</td><td class="r num">' + (r.avg ? r.avg.toFixed(1) : '—') + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">First review cycle in NovaHR</td></tr>') + '</tbody></table></div>' +
      '<div class="sec"><h3>Reward points<span class="r">' + (isAdmin() ? '<button class="btn sm ghost" data-act="pts-adjust" data-id="' + e.id + '">Adjust</button>' : '') + '</span></h3><div class="v" style="font-size:20px;font-weight:700">' + (e.points || 0) + ' pts</div>' +
      '<div class="list" style="margin-top:8px">' + ((d.points || []).slice(0, 12).map(p => '<div class="li"><span class="tag ' + (p.points < 0 ? '' : 'acc') + '">' + (p.points > 0 ? '+' : '') + p.points + '</span><div class="meta" style="font-size:12.5px">' + esc(p.reason || '') + '<div class="muted" style="font-size:11px">' + esc(p.kind) + (p.given_by ? ' · ' + esc(p.given_by) : '') + ' · ' + fmtLong((p.created_at || '').slice(0, 10)) + '</div></div></div>').join('') || '<div class="muted" style="font-size:12px">No points yet.</div>') + '</div></div>';
  }
  const DOC_LIST = (e) => ['New hire form', 'Training checklist', e.location === 'gl' ? 'W-4 and I-9' : 'Contractor agreement', 'Employee handbook acknowledgment', 'Banking details'];
  function tDocs(e) {
    const d = UI.detail || {}, docs = d.docs || [], up = e.can_manage || canEditSelf(e);
    const rows = DOC_LIST(e).map(n => { const f = docs.find(x => x.kind === n); return '<div class="li"><span class="av sm" style="background:var(--surface-3);color:var(--ink-2);font-size:8.5px">' + (f ? esc(String(f.mime || '').indexOf('pdf') > -1 ? 'PDF' : 'DOC') : '—') + '</span><div class="meta"><b>' + esc(n) + '</b><small class="muted" style="display:block">' + (f ? esc(f.name) + ' · ' + fmtLong(f.created_at.slice(0, 10)) : 'Not on file') + '</small></div>' + (f ? '<span class="tag ok">On file</span><button class="btn sm" data-act="doc-open" data-id="' + f.id + '">Open</button>' : '<span class="tag warn">Missing</span>' + (up ? '<label class="btn sm">Upload<input type="file" hidden data-doc="' + e.id + '" data-kind="' + esc(n) + '"></label>' : '')) + '</div>'; }).join('');
    const extra = docs.filter(x => DOC_LIST(e).indexOf(x.kind) < 0);
    return '<div class="sec"><h3>Documents' + (up ? '<span class="r"><label class="btn sm">Upload a file<input type="file" hidden data-doc="' + e.id + '" data-kind=""></label></span>' : '') + '</h3><div class="list">' + rows +
      extra.map(f => '<div class="li"><span class="av sm" style="background:var(--surface-3);color:var(--ink-2);font-size:8.5px">' + (String(f.mime || '').indexOf('pdf') > -1 ? 'PDF' : 'FILE') + '</span><div class="meta"><b>' + esc(f.name) + '</b><small class="muted" style="display:block">' + esc(f.kind || 'Other') + ' · ' + Math.round(f.size / 1024) + ' KB · ' + esc(f.uploaded_by || '') + ' · ' + fmtLong(f.created_at.slice(0, 10)) + '</small></div><button class="btn sm" data-act="doc-open" data-id="' + f.id + '">Open</button>' + (e.can_manage ? '<button class="btn sm ghost" data-act="doc-del" data-id="' + f.id + '" aria-label="Remove">' + I.x + '</button>' : '') + '</div>').join('') +
      '</div><p class="muted" style="font-size:12px;margin-top:10px">PDF, picture, Word or Excel, up to 25 MB. Files stay on the Nova server and open only for the person, their manager and HR.</p></div>';
  }

  // =========================================================== Company tree
  function orgMatch(txt) { const q = UI.orgq.trim().toLowerCase(); if (!q) return true; return q.split(/\s+/).every(w => String(txt).toLowerCase().indexOf(w) > -1); }
  function hl(s) { const q = UI.orgq.trim(); let out = esc(s); if (!q) return out; q.split(/\s+/).filter(Boolean).forEach(w => { out = out.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); }); return out; }
  const pkey = (p) => p.employee_id ? 'e' + p.employee_id : 'n' + String(p.name).toLowerCase();
  function deptPeople(d) { const s = new Set(); d.heads.forEach(p => s.add(pkey(p))); d.teams.forEach(t => { t.leads.forEach(p => s.add(pkey(p))); t.members.forEach(m => s.add(pkey(m))); }); return s; }
  const pBtn = (p, inner) => p.employee_id ? '<button class="btn ghost" style="padding:0;border:0;text-align:left;font-weight:inherit;display:flex;align-items:center;gap:9px;min-width:0" data-act="open" data-id="' + p.employee_id + '">' + inner + '</button>' : inner;
  function vOrg() {
    const O = S.org, q = UI.orgq.trim();
    const all = new Set(); if (O.ceo.name) all.add(O.ceo.employee_id ? 'e' + O.ceo.employee_id : 'n' + O.ceo.name.toLowerCase()); O.depts.forEach(d => deptPeople(d).forEach(n => all.add(n)));
    const teamsN = O.depts.reduce((s, d) => s + d.teams.length, 0);
    const cols = O.depts.map(d => {
      const dHit = orgMatch(d.name + ' ' + d.heads.map(p => p.name + ' ' + (p.title || '')).join(' '));
      const teams = d.teams.map(t => {
        const memHits = t.members.map(m => orgMatch(m.name + ' ' + (m.title || '') + ' ' + t.name));
        const tHit = orgMatch(t.name + ' ' + t.leads.map(p => p.name + ' ' + (p.title || '')).join(' ')) || memHits.some(Boolean);
        const open = UI.orgOpen[t.id] || (q && memHits.some(Boolean));
        const stack = t.members.slice(0, 5).map(m => pav(m, 'xs')).join('');
        return '<div class="team ' + (q && !tHit && !dHit ? 'dim' : '') + '"><button class="team-h" data-act="org-toggle" data-id="' + t.id + '" aria-expanded="' + !!open + '"><span class="team-n">' + hl(t.name) + (t.edited && isAdmin() ? ' <span class="tag crm">NOVA</span>' : '') + '</span>' +
          '<span class="team-lead">' + (t.leads.length ? t.leads.map(p => pav(p, 'xs') + '<span>' + hl(p.name) + '</span>').join(' ') : '<span class="muted">No lead yet</span>') + '</span>' +
          '<span class="team-meta">' + (t.members.length ? '<span class="stack">' + stack + '</span><span class="cnt">' + t.members.length + '</span>' : '<span class="muted">No members yet</span>') + I.chev + '</span></button>' +
          (open ? '<ul class="mem">' + t.members.map((m, i) => '<li class="' + (q && !memHits[i] && !tHit ? 'dim' : '') + '">' + pBtn(m, pav(m, 'sm') + '<div><b>' + hl(m.name) + '</b>' + (m.title ? '<small>' + hl(m.title) + '</small>' : '') + '</div>') + (isAdmin() ? '<button class="btn sm ghost x" data-act="org-rmp" data-t="' + t.id + '" data-e="' + (m.employee_id || '') + '" data-n="' + esc(m.name) + '" aria-label="Remove from team">' + I.x + '</button>' : '') + '</li>').join('') +
            (isAdmin() ? '<li><button class="btn sm ghost" data-act="org-addp" data-id="' + t.id + '">+ Add person</button><button class="btn sm ghost" data-act="org-editteam" data-id="' + t.id + '">Edit team</button></li>' : '') + '</ul>' : '') + '</div>';
      }).join('');
      const anyHit = dHit || d.teams.some(t => orgMatch(t.name + ' ' + t.leads.map(p => p.name).join(' ')) || t.members.some(m => orgMatch(m.name + ' ' + (m.title || '') + ' ' + t.name)));
      return '<section class="dept ' + (q && !anyHit ? 'dim' : '') + '" style="--dc:' + esc(d.color) + '"><header class="dept-h"><div class="dept-t"><h3>' + hl(d.name) + '</h3><span class="cnt">' + deptPeople(d).size + ' people</span></div>' +
        '<div class="leads">' + d.heads.map(p => '<div class="who">' + pBtn(p, pav(p, 'sm') + '<div style="min-width:0"><b>' + hl(p.name) + '</b>' + (p.title ? '<small>' + hl(p.title) + '</small>' : '') + '</div>') + '</div>').join('') + '</div>' +
        (isAdmin() ? '<div style="margin-top:8px"><button class="btn sm ghost" data-act="org-editdept" data-id="' + d.id + '">Edit</button></div>' : '') + '</header>' +
        '<div class="teams">' + (teams || '<div class="empty" style="padding:10px">No teams yet</div>') + (isAdmin() ? '<button class="btn sm ghost" style="align-self:flex-start" data-act="org-addteam" data-d="' + d.id + '">+ Add team</button>' : '') + '</div></section>';
    }).join('');
    const ceoP = O.ceo.employee_id ? emp(O.ceo.employee_id) : null;
    return '<div class="toolbar"><div class="search">' + I.search + '<input class="input" placeholder="Search people, roles, or teams" value="' + esc(UI.orgq) + '" data-in="orgq" aria-label="Search the company tree"></div>' +
      '<button class="btn" data-act="org-all" data-n="1">Expand all</button><button class="btn" data-act="org-all" data-n="0">Collapse all</button>' +
      (isAdmin() ? '<span style="margin-left:auto;display:flex;gap:8px"><button class="btn" data-act="org-reset" title="Re-read the CRM departments and teams; Nova edits are dropped">Sync from CRM</button><button class="btn" data-act="org-addteam">Add team</button><button class="btn primary" data-act="org-adddept">Add department</button></span>' : '') + '</div>' +
      '<div class="card org-box"><div class="org-wrap" tabindex="0" aria-label="Company tree — drag to move, arrow keys scroll"><div class="org" style="zoom:' + UI.orgZoom + '"><div class="ceo">' + (ceoP ? avatar(ceoP, 'lg') : pav({ name: O.ceo.name }, 'lg')) + '<div><b>' + esc(O.ceo.name) + '</b><small>' + esc(O.ceo.title) + '</small></div>' +
      '<div class="ceo-stats"><span><b>' + O.depts.length + '</b> departments</span><span><b>' + teamsN + '</b> teams</span><span><b>' + all.size + '</b> people</span></div></div>' +
      '<div class="cols">' + cols + '</div></div></div>' +
      '<button class="org-arrow l" data-act="org-pan" data-d="-1" aria-label="Scroll left"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>' +
      '<button class="org-arrow r" data-act="org-pan" data-d="1" aria-label="Scroll right"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>' +
      '<div class="org-ctl"><span class="org-hint"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>Drag to move · wheel to zoom</span>' +
      '<button data-act="org-zoom" data-d="-1" aria-label="Zoom out" title="Zoom out">−</button><button data-act="org-zoom" data-d="0" class="pct" title="Back to 100%">' + Math.round(UI.orgZoom * 100) + '%</button><button data-act="org-zoom" data-d="1" aria-label="Zoom in" title="Zoom in">+</button><button data-act="org-zoom" data-d="fit" title="Fit the whole tree in view">Fit</button></div></div>' +
      '<p class="muted" style="font-size:12px;margin-top:10px">The tree comes from the Axiom CRM\'s departments and teams; a department or team edited here keeps its Nova version (marked NOVA). Some people lead more than one team. Click a name to open their profile.</p>';
  }
  /* 1.20.169: the tree is a canvas — it fills the window height so both scrollbars are always on screen, drags with the hand,
     has left / right arrows that show while there is more that way, and zooms (− % + Fit, kept per browser). */
  function orgSize() {
    const w = document.querySelector('.org-wrap'); if (!w) return;
    w.style.height = Math.max(380, innerHeight - w.getBoundingClientRect().top - 46) + 'px';
  }
  function orgEdges() {
    const w = document.querySelector('.org-wrap'); if (!w) return;
    const box = w.parentNode, max = w.scrollWidth - w.clientWidth;
    box.classList.toggle('more-l', w.scrollLeft > 4); box.classList.toggle('more-r', w.scrollLeft < max - 4);
  }
  /* d: -1 / 1 = a step, '0' = 100 %, 'fit', or {z} = an exact zoom; at = {x, y} in the window — that spot of the tree stays
     under it (the mouse wheel), else the middle of the view does. 1.20.170 */
  function orgZoom(d, at) {
    const w = document.querySelector('.org-wrap'), o = w && w.querySelector('.org'), c = o && o.querySelector('.cols'); if (!c) return;
    const old = UI.orgZoom, wr = w.getBoundingClientRect();
    const px = at ? at.x : wr.left + w.clientWidth / 2, py = at ? at.y : wr.top + w.clientHeight / 2;
    const cr = c.getBoundingClientRect(), or = o.getBoundingClientRect();
    const fx = (px - cr.left) / (cr.width || 1), fy = (py - or.top) / (or.height || 1);
    let z = d === 'fit' || d === '0' ? 1 : d && typeof d === 'object' ? d.z : Math.round((old + (+d) * 0.1) * 10) / 10;
    if (d === 'fit') { o.style.zoom = 1; z = Math.min(1, (w.clientWidth - 44) / o.scrollWidth, (w.clientHeight - 56) / o.scrollHeight); z = Math.floor(z * 20) / 20; }
    z = Math.max(0.3, Math.min(1.5, Math.round(z * 100) / 100)); if (z === old && d !== 'fit') return;
    UI.orgZoom = z; try { localStorage.setItem('hr_org_zoom', String(z)); } catch (e) {}
    o.style.zoom = z; const pct = w.parentNode.querySelector('.org-ctl .pct'); if (pct) pct.textContent = Math.round(z * 100) + '%';
    if (d === 'fit') { w.scrollLeft = (w.scrollWidth - w.clientWidth) / 2; w.scrollTop = 0; }
    else { const cr2 = c.getBoundingClientRect(), or2 = o.getBoundingClientRect(); w.scrollLeft += cr2.left + fx * cr2.width - px; w.scrollTop += or2.top + fy * or2.height - py; }
    orgEdges();
  }
  /* The mouse wheel zooms in / out where the pointer is (a map's feel); a trackpad's two-finger scroll still moves the tree,
     a pinch (ctrl + wheel) zooms; Shift + wheel scrolls sideways. 1.20.170 */
  document.addEventListener('wheel', (ev) => {
    const w = ev.target.closest && ev.target.closest('.org-wrap'); if (!w || ev.shiftKey) return;
    const mouse = ev.deltaMode === 1 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50 && Number.isInteger(ev.deltaY));
    if (!ev.ctrlKey && !mouse) return;
    ev.preventDefault();
    const step = ev.ctrlKey && !mouse ? Math.exp(-ev.deltaY * 0.01) : (ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    orgZoom({ z: UI.orgZoom * step }, { x: ev.clientX, y: ev.clientY });
  }, { passive: false });
  let orgDrag = null;
  document.addEventListener('pointerdown', (ev) => {
    const w = ev.target.closest && ev.target.closest('.org-wrap'); if (!w || ev.button !== 0 || ev.pointerType === 'touch') return;
    if (ev.target.closest('input, select, textarea, .org-ctl, .org-arrow')) return;
    orgDrag = { w, x: ev.clientX, y: ev.clientY, sl: w.scrollLeft, st: w.scrollTop, moved: false, id: ev.pointerId };
  });
  document.addEventListener('pointermove', (ev) => {
    if (!orgDrag) return;
    const dx = ev.clientX - orgDrag.x, dy = ev.clientY - orgDrag.y;
    if (!orgDrag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!orgDrag.moved) { orgDrag.moved = true; orgDrag.w.classList.add('dragging'); try { getSelection().removeAllRanges(); } catch (e) {} try { orgDrag.w.setPointerCapture(orgDrag.id); } catch (e) {} }
    orgDrag.w.scrollLeft = orgDrag.sl - dx; orgDrag.w.scrollTop = orgDrag.st - dy; ev.preventDefault();
  });
  const orgUp = () => { if (!orgDrag) return; const d = orgDrag; orgDrag = null; d.w.classList.remove('dragging'); if (d.moved) { const stop = (e) => { e.stopPropagation(); e.preventDefault(); }; document.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => document.removeEventListener('click', stop, true), 0); } };
  document.addEventListener('pointerup', orgUp); document.addEventListener('pointercancel', orgUp);
  document.addEventListener('selectstart', (ev) => { if (orgDrag) ev.preventDefault(); });
  document.addEventListener('scroll', (ev) => { if (ev.target && ev.target.classList && ev.target.classList.contains('org-wrap')) orgEdges(); }, true);
  document.addEventListener('keydown', (ev) => {
    const w = document.activeElement; if (!w || !w.classList || !w.classList.contains('org-wrap')) return;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { w.scrollBy({ left: (ev.key === 'ArrowLeft' ? -1 : 1) * 120, behavior: 'smooth' }); ev.preventDefault(); }
  });
  window.addEventListener('resize', () => { orgSize(); orgEdges(); });
  function personPicker(id, list, placeholderName) {
    return '<select class="select" id="' + id + '" data-people style="width:100%"><option value="">' + esc(placeholderName || 'Pick a person') + '</option>' + people().filter(e => e.status === 'Active').sort((a, b) => a.name.localeCompare(b.name)).map(e => '<option value="' + e.id + '" ' + ((list || []).some(p => p.employee_id === e.id) ? 'selected' : '') + '>' + esc(e.name) + '</option>').join('') + '</select>';
  }
  function multiPick(id, list) {
    const sel = new Set((list || []).filter(p => p.employee_id).map(p => p.employee_id));
    return '<div id="' + id + '" style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 8px">' + people().filter(e => e.status === 'Active').sort((a, b) => a.name.localeCompare(b.name)).map(e => '<label style="display:flex;gap:8px;align-items:center;padding:3px 0;font-size:12.5px"><input type="checkbox" value="' + e.id + '" ' + (sel.has(e.id) ? 'checked' : '') + '>' + avatar(e, 'xs') + esc(e.name) + '<span class="muted" style="font-size:11px">' + esc(e.title || '') + '</span></label>').join('') + '</div>';
  }
  function orgModal(kind, id, deptId) {
    const sw = ['#0e00a8', '#0eabe2', '#bb0173', '#2b99c4', '#c924b6', '#078c66', '#d97706', '#475569'];
    let body = '', title = '', act = '';
    if (kind === 'dept') {
      const d = id ? S.org.depts.find(x => x.id === id) : null; title = d ? 'Edit department' : 'Add department'; act = 'org-save-dept';
      const cur = d ? d.color : sw[6];
      body = '<div class="field full"><label for="o_name">Department name</label><input class="input" id="o_name" value="' + esc(d ? d.name : '') + '"></div>' +
        '<div class="field full"><label>Color</label><div class="swatches">' + sw.concat(d && sw.indexOf(cur) < 0 ? [cur] : []).map(c => '<label><input type="radio" name="o_c" value="' + c + '" ' + (c === cur ? 'checked' : '') + '><i style="background:' + c + '"></i></label>').join('') + '</div></div>' +
        '<div class="field full"><label>Department head(s)</label>' + multiPick('o_heads', d ? d.heads : []) + '</div>' + (d ? '<div class="field full"><button class="btn sm bad" data-act="org-del" data-kind="dept" data-id="' + d.id + '">Remove this department</button></div>' : '');
    }
    if (kind === 'team') {
      const t = id ? S.org.depts.flatMap(d => d.teams.map(x => Object.assign({ dept: d.id }, x))).find(x => x.id === id) : null; title = t ? 'Edit team' : 'Add team'; act = 'org-save-team';
      body = '<div class="field full"><label for="o_dept">Department</label><select class="select" id="o_dept" style="width:100%">' + S.org.depts.map(d => '<option value="' + d.id + '" ' + (d.id === (t ? t.dept : deptId) ? 'selected' : '') + '>' + esc(d.name) + '</option>').join('') + '</select></div>' +
        '<div class="field full"><label for="o_name">Team name</label><input class="input" id="o_name" value="' + esc(t ? t.name : '') + '"></div><div class="field full"><label>Team lead(s)</label>' + multiPick('o_heads', t ? t.leads : []) + '</div>' + (t ? '<div class="field full"><button class="btn sm bad" data-act="org-del" data-kind="team" data-id="' + t.id + '">Remove this team</button></div>' : '');
    }
    if (kind === 'person') {
      const t = S.org.depts.flatMap(d => d.teams).find(x => x.id === id); title = 'Add person to ' + t.name; act = 'org-save-person';
      body = '<div class="field full"><label>Person</label>' + personPicker('o_emp') + '</div><div class="field full"><label for="o_role">Role on this team (optional)</label><input class="input" id="o_role"></div>';
    }
    openModal('<div class="box-h"><h2>' + esc(title) + '</h2><button class="btn ghost x" data-act="close-modal" aria-label="Close">' + I.x + '</button></div><div class="box-b"><div class="fields">' + body + '</div></div>' +
      '<div class="box-f"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="' + act + '" data-id="' + (id || '') + '">Save</button></div>');
  }

  // =========================================================== Time & attendance
  async function loadTs() {
    UI.tsWeek = UI.tsWeek || mondayOf(today());
    const j = await api('/api/hr/timesheets?week=' + UI.tsWeek);
    UI.ts = j && j.ok ? j : { rows: [], error: (j && j.error) || 'Could not load' };
    if (UI.view === 'time') render();
  }
  async function loadAdh() { const j = await api('/api/hr/adherence?weeks=' + UI.adhWeeks); UI.adh = j && j.ok ? j : { rows: [], error: (j && j.error) || 'Could not load' }; if (UI.view === 'time') render(); }
  function vTime() {
    const tabs = '<div class="seg" style="margin-bottom:12px"><button data-act="time-tab" data-k="sheet" aria-pressed="' + (UI.timeTab === 'sheet') + '">Timesheets</button><button data-act="time-tab" data-k="adh" aria-pressed="' + (UI.timeTab === 'adh') + '">Schedule adherence</button></div>';
    if (UI.timeTab === 'adh') return tabs + vAdherence();
    const ws = UI.tsWeek || mondayOf(today()), days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i));
    const T = UI.ts;
    const isThis = ws === mondayOf(today());
    const head = '<div class="toolbar"><div class="seg"><button data-act="week" data-n="-7" aria-label="Previous week">‹</button><button data-act="week" data-n="0" aria-pressed="' + isThis + '">This week</button><button data-act="week" data-n="7" aria-label="Next week" ' + (isThis ? 'disabled' : '') + '>›</button></div>' +
      '<span class="muted">' + fmtD(days[0]) + ' – ' + fmtD(days[6]) + '</span>' +
      (isMgr() ? '<span style="margin-left:auto;display:flex;gap:8px"><button class="btn" data-act="ts-all">Approve all clean timesheets</button><button class="btn" data-act="ts-export">Export for payroll (CSV)</button></span>' : '') + '</div>';
    if (!T) return tabs + head + '<div class="card"><div class="empty">Loading timesheets…</div></div>';
    const rows = (T.rows || []).map(r => {
      const e = emp(r.employee_id); if (!e) return '';
      const cells = r.days.map(d => {
        const mgr = r.can_manage, at = 'data-id="' + e.id + '" data-d="' + d.day + '"';
        if (d.kind === 'missed') return '<td class="h flag" ' + (mgr ? 'data-act="fix" ' + at : '') + ' title="Clocked in, no clock-out. ' + (mgr ? 'Click to fix.' : 'Your manager will fix this.') + '">Missing</td>';
        if (d.kind === 'absent') return '<td class="h flag" ' + (mgr ? 'data-act="fix" ' + at : '') + ' title="A scheduled work day with no punches. ' + (mgr ? 'Click to enter hours or mark it.' : '') + '">No punch</td>';
        if (d.kind === 'future') return '<td class="h zero"></td>';
        if (d.kind === 'today') return '<td class="h zero">—</td>';
        if (d.kind === 'pto') return '<td class="h ptoh" title="' + esc(typeName(d.leave ? d.leave.type : '')) + '">' + (d.leave && d.leave.half ? '½ PTO' : 'PTO') + '</td>';
        if (d.kind === 'holiday') return '<td class="h zero" title="Holiday">Hol</td>';
        if (d.kind === 'live') return '<td class="h live ' + (mgr ? 'click' : '') + '" ' + (mgr ? 'data-act="fix" ' + at : '') + '>' + Number(d.h).toFixed(2) + '</td>';
        if (d.kind === 'fixed') return '<td class="h fixed ' + (mgr ? 'click' : '') + '" ' + (mgr ? 'data-act="fix" ' + at : '') + ' title="Fixed by ' + esc((d.fix && d.fix.by) || '') + (d.fix && d.fix.reason ? ': ' + esc(d.fix.reason) : '') + '">' + Number(d.h).toFixed(2) + '*</td>';
        if (d.kind === 'ok') return '<td class="h ' + (mgr ? 'click' : '') + '" ' + (mgr ? 'data-act="fix" ' + at : '') + '>' + (d.h ? Number(d.h).toFixed(2) : '0.00') + '</td>';
        return '<td class="h zero">—</td>';
      }).join('');
      const empty = !r.total && !r.flagged;
      const stat = r.flagged ? '<span class="tag bad">Fix needed</span>' : r.approved ? '<span class="tag ok" title="' + esc(r.approved.by) + '">Approved</span>' : empty ? '<span class="muted" style="font-size:11.5px">No hours</span>' : '<span class="tag">Open</span>';
      const act = r.can_manage ? (r.approved ? '<button class="btn sm ghost" data-act="ts-unapprove" data-id="' + e.id + '">Reopen</button>' : !r.flagged && !empty ? '<button class="btn sm" data-act="ts-approve" data-id="' + e.id + '">Approve</button>' : '') : '';
      return '<tr><td><div class="who">' + avatar(e, 'sm') + '<div><b>' + esc(e.name) + '</b><small>' + locName(e.location) + ' · ' + shiftLabel(e) + '</small></div></div></td>' + cells + '<td class="r tot num">' + r.total.toFixed(2) + '</td><td class="r num" style="color:' + (r.ot ? 'var(--warn)' : 'var(--ink-3)') + '">' + (r.ot ? r.ot.toFixed(2) : '—') + '</td><td>' + stat + '</td><td class="r">' + act + '</td></tr>';
    }).join('');
    return tabs + head + (T.error ? '<div class="lock red">' + esc(T.error) + '</div>' : '') +
      '<div class="card tbl-wrap"><table class="ts"><thead><tr><th>Employee</th>' + days.map(d => '<th class="c">' + parse(d).toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + parse(d).getDate() + '</th>').join('') + '<th class="r">Total</th><th class="r">Overtime</th><th>Status</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="12"><div class="empty">No timesheets.</div></td></tr>') + '</tbody></table></div>' +
      '<p class="muted" style="font-size:12px;margin-top:10px">Hours are worked time after breaks (no break punched on a day over 6 h takes off ' + S.settings.attendance.breakMin + ' min), punches rounded to ' + (S.settings.attendance.round ? S.settings.attendance.round + ' min' : 'the minute') + '. Overtime: over ' + S.settings.attendance.otWeekly + ' h a week' + (S.settings.attendance.otDailyCA ? '; Glendale also over 8 h a day (California)' : '') + '. * = hours set by a manager. Days before someone\'s first punch in NovaHR are not counted.</p>';
  }
  async function openFix(id, day) {
    const e = emp(id);
    openModal('<div class="box-h"><h2>' + esc(e.name) + ' · ' + fmtD(day, { weekday: 'long', month: 'short', day: 'numeric' }) + '</h2><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div><div class="box-b"><div class="empty">Loading punches…</div></div>');
    const j = await api('/api/hr/punches?employee=' + id + '&date=' + day);
    const r = UI.ts && UI.ts.rows.find(x => x.employee_id === +id), d = r && r.days.find(x => x.day === day);
    const ps = (j && j.punches) || [], tz = (j && j.tz) || tzOf(e);
    const N = { in: 'Clocked in', break: 'Break', back: 'Back from break', out: 'Clocked out' };
    $('modalBox').innerHTML = '<div class="box-h"><h2>' + esc(e.name) + ' · ' + fmtD(day, { weekday: 'long', month: 'short', day: 'numeric' }) + '</h2><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div><div class="box-b">' +
      '<div class="muted" style="font-size:12px;margin-bottom:8px">Shift ' + shiftLabel(e) + ' ' + esc(LOCN(e.location).name) + ' time' + (d && d.fix ? ' · hours set by ' + esc(d.fix.by) + ' to ' + d.fix.hours + (d.fix.reason ? ' — ' + esc(d.fix.reason) : '') : '') + '</div>' +
      '<div class="list">' + (ps.map(p => '<div class="li"><span class="tag">' + N[p.type] + '</span><div class="meta num">' + timeIn(p.at, tz) + ' <span class="muted" style="font-size:11.5px">· ' + esc(p.source) + (p.note ? ' · ' + esc(p.note) : '') + '</span></div><button class="btn sm ghost" data-act="void" data-id="' + id + '" data-d="' + day + '" data-p="' + p.id + '">Remove</button></div>').join('') || '<div class="muted">No punches this day.</div>') + '</div>' +
      '<div class="sec"><h3>Add the missing punch</h3><div class="fields"><div class="field"><label>Type</label><select class="select" id="fx_t" style="width:100%"><option value="out">Clocked out</option><option value="in">Clocked in</option><option value="break">Break</option><option value="back">Back from break</option></select></div><div class="field"><label>Time (' + esc(LOCN(e.location).name) + ')</label><input class="input" type="time" id="fx_time" style="width:100%"></div></div></div>' +
      '<div class="sec"><h3>Or set the hours for the day</h3><div class="fields"><div class="field"><label>Hours (0–16)</label><input class="input num" type="number" step="0.25" min="0" max="16" id="fx_h" style="width:100%" value="' + (d && d.fix ? d.fix.hours : '') + '"></div><div class="field"><label>Reason</label><input class="input" id="fx_r" style="width:100%" placeholder="e.g. Forgot to clock out, left at 5:30"></div></div></div></div>' +
      '<div class="box-f">' + (d && d.fix ? '<button class="btn ghost" data-act="fix-clear" data-id="' + id + '" data-d="' + day + '">Undo the hours fix</button>' : '') + '<button class="btn" data-act="close-modal">Cancel</button><button class="btn" data-act="fix-hours" data-id="' + id + '" data-d="' + day + '">Set hours</button><button class="btn primary" data-act="fix-punch" data-id="' + id + '" data-d="' + day + '">Add punch</button></div>';
  }
  function vAdherence() {
    const A = S.settings.attendance, D = UI.adh;
    const head = '<div class="toolbar"><div class="seg">' + [2, 4, 8].map(w => '<button data-act="adh-w" data-n="' + w + '" aria-pressed="' + (UI.adhWeeks === w) + '">' + w + ' weeks</button>').join('') + '</div>' +
      (isMgr() ? '<div class="seg"><button data-act="adh-sort" data-k="worst" aria-pressed="' + (UI.adhSort === 'worst') + '">Needs attention first</button><button data-act="adh-sort" data-k="name" aria-pressed="' + (UI.adhSort === 'name') + '">A–Z</button></div>' : '') +
      '<span class="muted" style="margin-left:auto;font-size:12px">Late means clocking in more than ' + A.grace + ' min after shift start. ' + (isAdmin() ? '<button class="linkbtn" data-act="nav" data-k="settings" data-tab="att">Change rules</button>' : '') + '</span></div>';
    if (!D) return head + '<div class="card"><div class="empty">Loading…</div></div>';
    let list = (D.rows || []).filter(r => r.n && emp(r.employee_id));
    if (UI.adhSort === 'worst') list.sort((x, y) => x.score - y.score); else list.sort((x, y) => emp(x.employee_id).name.localeCompare(emp(y.employee_id).name));
    const tot = list.reduce((s, x) => ({ n: s.n + x.n, ok: s.ok + x.ok, l: s.l + x.lates, m: s.m + x.missed, e: s.e + x.early, lm: s.lm + x.avgLate * x.lates }), { n: 0, ok: 0, l: 0, m: 0, e: 0, lm: 0 });
    const sc = (s) => s >= 95 ? 'ok' : s >= 85 ? 'warn' : 'bad';
    const noData = (D.rows || []).filter(r => !r.n).length;
    const strip = (e, r) => '<div class="strip">' + r.recent.map(x => { const dl = fmtD(x.day, { weekday: 'short', month: 'short', day: 'numeric' }); const t = x.k === 'missed' ? dl + ': missed punch' : dl + ': in ' + (x.in ? timeIn(x.in, tzOf(e)) : '?') + (x.inD > 0 ? ' (' + x.inD + ' min late)' : '') + ', out ' + (x.out ? timeIn(x.out, tzOf(e)) : '?') + (x.outD < 0 ? ' (' + (-x.outD) + ' min early)' : ''); return '<i class="sq ' + x.k + '" title="' + esc(t) + '"></i>'; }).join('') + '</div>';
    const trend = (r) => '<div class="spark">' + r.trend.map(v => v == null ? '<i class="na"></i>' : '<i class="' + sc(v) + '" style="height:' + Math.max(12, v) + '%" title="' + v + '% on schedule"></i>').join('') + '</div>';
    return head + '<div class="kpis"><div><small>On schedule</small><b class="num">' + (tot.n ? Math.round(tot.ok / tot.n * 100) : 100) + '%</b><span>of ' + tot.n + ' shifts started and ended on time</span></div>' +
      '<div><small>Late arrivals</small><b class="num">' + tot.l + '</b><span>' + (tot.l ? 'avg ' + Math.round(tot.lm / tot.l) + ' min late' : 'none') + '</span></div>' +
      '<div><small>Left early</small><b class="num">' + tot.e + '</b><span>more than ' + A.earlyGrace + ' min before shift end</span></div>' +
      '<div><small>Missed punches</small><b class="num">' + tot.m + '</b><span>need a manager fix</span></div></div>' +
      '<div class="card tbl-wrap"><table><thead><tr><th>Employee</th><th>Shift</th><th>On schedule</th><th class="r">Late</th><th class="r">Avg late</th><th class="r">Left early</th><th class="r">Missed</th><th>Weekly trend</th><th>Recent shifts</th></tr></thead><tbody>' +
      (list.map(r => { const e = emp(r.employee_id); return '<tr><td><div class="who">' + avatar(e, 'sm') + '<div><b>' + esc(e.name) + '</b><small>' + locName(e.location) + '</small></div></div></td><td class="num" style="white-space:nowrap">' + shiftLabel(e) + '</td>' +
        '<td><div class="score-cell"><span class="tag ' + sc(r.score) + '">' + r.score + '%</span><div class="meter" style="width:70px;margin:0"><i style="width:' + r.score + '%;background:var(--' + (sc(r.score) === 'ok' ? 'work' : sc(r.score) === 'warn' ? 'break' : 'bad') + ')"></i></div></div></td>' +
        '<td class="r num">' + (r.lates || '<span class="muted">0</span>') + '</td><td class="r num">' + (r.avgLate ? r.avgLate + ' min' : '<span class="muted">—</span>') + '</td><td class="r num">' + (r.early || '<span class="muted">0</span>') + '</td><td class="r num" ' + (r.missed ? 'style="color:var(--bad)"' : '') + '>' + (r.missed || '<span class="muted">0</span>') + '</td><td>' + trend(r) + '</td><td>' + strip(e, r) + '</td></tr>'; }).join('') ||
        '<tr><td colspan="9"><div class="empty">No scheduled shifts with punches in this period yet. Adherence starts from each person\'s first clock-in in NovaHR.</div></td></tr>') + '</tbody></table></div>' +
      '<div class="legend" style="margin-top:10px"><span><i style="background:var(--work)"></i>On time</span><span><i style="background:var(--break)"></i>Late</span><span><i style="background:#ef4444"></i>Late over ' + A.lateAlert + ' min</span><span><i style="background:var(--accent)"></i>Left early</span><span><i style="border:1.5px solid #ef4444"></i>Missed punch</span><span class="muted">Hover a square for times' + (noData ? ' · ' + noData + ' people have not clocked in yet' : '') + '</span></div>';
  }

  // =========================================================== Time off
  function vTimeoff() {
    const me = ME();
    const pending = S.leave.filter(r => r.can_decide), decided = S.leave.filter(r => r.status !== 'pending' && emp(r.employee_id) && emp(r.employee_id).can_manage && !(me && r.employee_id === me.id)).sort((a, b) => (b.decided_at || b.start_date).localeCompare(a.decided_at || a.start_date)).slice(0, 20);
    const mine = me ? S.leave.filter(r => r.employee_id === me.id).sort((a, b) => b.start_date.localeCompare(a.start_date)) : [];
    const types = (S.settings.leave_types || []).filter(t => t.on);
    const reports = people().filter(e => e.can_manage && !(me && e.id === me.id) && e.status === 'Active').sort((a, b) => a.name.localeCompare(b.name));
    const mgr = me && emp(me.reports_to);
    const def = (() => { let d = today(), c = 0; while (c < 5) { d = addDays(d, 1); if (weekday(d) < 6) c++; } return d; })();
    return '<div class="grid g-today"><div class="card"><div class="card-h"><h2>Request time off</h2><span class="hint">' + (me ? 'Goes to ' + (mgr ? esc(mgr.name) : 'HR') + ' for approval' : '') + '</span></div><div class="card-b">' + (me ? balancesHTML(S.balances) : '') +
      '<div class="fields" style="margin-top:14px">' +
      (reports.length ? '<div class="field full"><label for="rq_for">For</label><select class="select" id="rq_for" data-in="rq" data-people style="width:100%">' + (me ? '<option value="">Me</option>' : '') + reports.map(e => '<option value="' + e.id + '">' + esc(e.name) + '</option>').join('') + '</select></div>' : '') +
      '<div class="field"><label for="rq_type">Type</label><select class="select" id="rq_type" data-in="rq" style="width:100%">' + types.map(t => '<option value="' + t.k + '">' + esc(t.n) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;color:var(--ink);font-size:13px;font-weight:500"><input type="checkbox" id="rq_half" data-in="rq"> Half day</label></div>' +
      '<div class="field"><label for="rq_from">First day off</label><input class="input" type="date" id="rq_from" data-in="rq" value="' + def + '" style="width:100%"></div>' +
      '<div class="field"><label for="rq_to">Last day off</label><input class="input" type="date" id="rq_to" data-in="rq" value="' + def + '" style="width:100%"></div>' +
      '<div class="field full"><label for="rq_note">Note for the manager</label><input class="input" id="rq_note" placeholder="Optional" style="width:100%"></div>' +
      (reports.length ? '<div class="field full" id="rqApproveRow" style="display:none"><label style="display:flex;gap:8px;align-items:center;color:var(--ink);font-size:13px;font-weight:500"><input type="checkbox" id="rq_approve" checked> Already approved (I\'m their manager)</label></div>' : '') +
      '</div><div id="rqSummary" style="margin-top:12px;font-size:13px"></div><div style="margin-top:12px"><button class="btn primary" data-act="submit-req">Send request</button></div></div></div>' +
      '<div class="card"><div class="card-h"><h2>' + (isMgr() ? 'Waiting on you' : 'Your requests') + '</h2><span class="hint">' + (isMgr() ? pending.length + ' pending' : '') + '</span></div><div class="card-b"><div class="list">' +
      ((isMgr() ? pending : mine).map(r => reqLi(r, true)).join('') || '<div class="empty">Nothing waiting.</div>') + '</div>' +
      (isMgr() && mine.length ? '<div class="muted" style="font-size:11.5px;margin:16px 0 4px;font-weight:700">Your own requests</div><div class="list">' + mine.slice(0, 8).map(r => reqLi(r, true)).join('') + '</div>' : '') +
      (isMgr() && decided.length ? '<div class="muted" style="font-size:11.5px;margin:16px 0 4px;font-weight:700">Decided</div><div class="list">' + decided.map(r => reqLi(r, false)).join('') + '</div>' : '') + '</div></div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-h"><h2>Team calendar</h2><div class="chips">' + [['all', 'Everyone']].concat(Object.keys(S.locations).map(k => [k, S.locations[k].name])).map(([k, n]) => '<button class="chip" data-act="cal-loc" data-k="' + k + '" aria-pressed="' + (UI.calLoc === k) + '">' + (k === 'all' ? '' : flag(k)) + esc(n) + '</button>').join('') + '</div>' +
      '<div class="r"><button class="btn sm" data-act="cal" data-n="-1" aria-label="Previous month">‹</button><b style="min-width:130px;text-align:center">' + calLabel() + '</b><button class="btn sm" data-act="cal" data-n="1" aria-label="Next month">›</button></div></div>' +
      '<div class="card-b"><div class="legend" style="margin-bottom:10px"><span><i style="background:var(--pto)"></i>Approved</span><span><i style="border:1px dashed var(--pto)"></i>Pending</span><span><i style="background:var(--warn)"></i>Holiday</span></div>' + calHTML() + '</div></div>';
  }
  function calBase() { if (!UI.calMonth) { const t = parse(today()); UI.calMonth = [t.getFullYear(), t.getMonth()]; } return UI.calMonth; }
  function calLabel() { const [y, m] = calBase(); return new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  function calHTML() {
    const [y, m] = calBase(), f = new Date(y, m, 1, 12), start = iso(new Date(y, m, 1 - ((f.getDay() + 6) % 7), 12));
    let h = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => '<div class="dh">' + d + '</div>').join('');
    const locOk = (e) => UI.calLoc === 'all' || (e && e.location === UI.calLoc);
    for (let i = 0; i < 42; i++) {
      const s = addDays(start, i), d = parse(s);
      if (i >= 35 && d.getMonth() !== m) break;
      const wk = d.getDay() === 0 || d.getDay() === 6;
      const evs = S.leave.filter(r => r.status !== 'declined' && r.start_date <= s && r.end_date >= s && !wk && locOk(emp(r.employee_id)));
      const ev = evs.slice(0, 4).map(r => { const e = emp(r.employee_id); return '<div class="ev ' + (r.status === 'pending' ? 'pending' : '') + '" title="' + esc(e ? e.name : '') + ', ' + esc(typeName(r.type)) + (r.status === 'pending' ? ' (pending)' : '') + '">' + esc(first(e)) + (r.half_day ? ' ½' : '') + '</div>'; }).join('') + (evs.length > 4 ? '<div class="ev more">+' + (evs.length - 4) + ' more</div>' : '');
      const hol = S.holidays.filter(x => x.date === s && (UI.calLoc === 'all' || x.location === UI.calLoc)).map(x => '<div class="ev hol" title="' + esc(x.name) + ', ' + esc(LOCN(x.location).name) + (x.src === 'website' ? ' (website closed days)' : '') + '">' + flag(x.location) + esc(x.name) + '</div>').join('');
      h += '<div class="day ' + (d.getMonth() !== m ? 'out' : '') + ' ' + (wk ? 'wk' : '') + ' ' + (s === today() ? 'today' : '') + '"><span class="dn">' + d.getDate() + '</span>' + hol + ev + '</div>';
    }
    return '<div class="cal">' + h + '</div>';
  }
  let rqT = null;
  function rqSummary() {
    const el = $('rqSummary'); if (!el) return;
    const forSel = $('rq_for'), half = $('rq_half').checked;
    if ($('rqApproveRow')) $('rqApproveRow').style.display = forSel && forSel.value ? '' : 'none';
    if (half) $('rq_to').value = $('rq_from').value;
    clearTimeout(rqT); rqT = setTimeout(async () => {
      const b = { type: $('rq_type').value, from: $('rq_from').value, to: $('rq_to').value, half, employee_id: forSel && forSel.value ? +forSel.value : undefined };
      const j = await post('/api/hr/leave/preview', b);
      if (!j || !j.ok) { el.innerHTML = '<span class="tag bad">' + esc((j && j.error) || 'Check the dates') + '</span>'; return; }
      let msg = '<b>' + j.days + ' workday' + (j.days === 1 ? '' : 's') + '</b>';
      if (!j.days) msg = '<span class="tag warn">Those days are not work days</span>';
      if (j.left_after != null) msg += j.left_after < 0 ? ' <span class="tag bad">' + (-j.left_after) + ' more than the ' + esc(String(j.type).toLowerCase()) + ' balance</span>' : ' <span class="muted">' + j.left_after + ' ' + esc(String(j.type).toLowerCase()) + ' days left after this</span>';
      if (j.holidays && j.holidays.length) msg += ' <span class="muted">· holidays not counted: ' + esc(j.holidays.join(', ')) + '</span>';
      if (j.overlap && j.overlap.length) msg += '<div class="tag warn" style="margin-top:8px">' + esc(j.overlap.join(', ')) + ' from ' + esc(j.dept || 'the department') + ' ' + (j.overlap.length > 1 ? 'are' : 'is') + ' also out then</div>';
      if (j.short_notice) msg += '<div class="tag warn" style="margin-top:8px">Less than ' + j.short_notice + ' days\' notice — the manager can still approve</div>';
      el.innerHTML = msg;
    }, 200);
  }

  // =========================================================== Reviews
  const SCALE = ['', 'Needs improvement', 'Below expectations', 'Meets expectations', 'Exceeds expectations', 'Exceptional'];
  const RV = { none: ['Not started', ''], self: ['Self-review', 'warn'], manager: ['Manager review', 'acc'], done: ['Complete', 'ok'] };
  const reviewTag = (ev) => { const r = RV[(ev && ev.stage) || 'none']; return '<span class="tag ' + r[1] + '">' + r[0] + '</span>'; };
  function vReviews() {
    const me = ME(), ceoId = S.org.ceo.employee_id;
    const list = isMgr() ? people().filter(e => e.status === 'Active' && e.priv && !(me && e.id === me.id) && e.id !== ceoId) : (me ? [me] : []);
    if (isMgr() && me && list.indexOf(me) < 0 && me.id !== ceoId) list.unshift(me);
    const st = (e) => (S.reviews[e.id] || { stage: 'none' }).stage;
    const c = (k) => list.filter(e => st(e) === k).length;
    const col = { none: 'var(--off)', self: 'var(--break)', manager: 'var(--accent)', done: 'var(--work)' };
    const due = Math.ceil((parse(S.settings.review.due) - parse(today())) / 86400000);
    return (isMgr() ? '<div class="card" style="margin-bottom:16px"><div class="card-b"><div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><b style="font-size:15px">' + c('done') + ' of ' + list.length + ' reviews complete</b><span class="muted">' + (due >= 0 ? due + ' days left in the cycle' : 'the cycle ended ' + (-due) + ' days ago') + '</span><button class="btn sm" data-act="nudge" style="margin-left:auto">Remind people with a self-review due</button></div>' +
      '<div class="pipe">' + ['done', 'manager', 'self', 'none'].map(k => '<i style="width:' + (list.length ? c(k) / list.length * 100 : 0) + '%;background:' + col[k] + '"></i>').join('') + '</div><div class="legend">' + ['done', 'manager', 'self', 'none'].map(k => '<span><i style="background:' + col[k] + '"></i>' + RV[k][0] + ' ' + c(k) + '</span>').join('') + '</div></div></div>' : '') +
      '<div class="card tbl-wrap"><table><thead><tr><th>Employee</th><th>Reviewer</th><th>Stage</th><th>Self-review</th><th class="r">Overall</th><th class="r"></th></tr></thead><tbody>' +
      (list.map(e => { const ev = S.reviews[e.id] || { stage: 'none' }, m = emp(ev.reviewer_id || e.reports_to), self = me && e.id === me.id;
        const btn = !self ? '<button class="btn sm ' + (ev.stage === 'manager' ? 'primary' : '') + '" data-act="eval" data-id="' + e.id + '">' + (ev.stage === 'done' ? 'View' : ev.stage === 'manager' ? 'Write review' : 'Open') + '</button>' : '<button class="btn sm primary" data-act="eval" data-id="' + e.id + '">' + (ev.self_text ? 'View' : 'Write self-review') + '</button>';
        return '<tr><td><div class="who">' + avatar(e, 'sm') + '<div><b>' + esc(e.name) + '</b><small>' + esc(e.title || '') + '</small></div></div></td><td>' + (m ? esc(m.name) : '—') + '</td><td>' + reviewTag(ev) + '</td><td>' + (ev.self_text ? '<span class="tag ok">Submitted</span>' : '<span class="tag">Not yet</span>') + '</td><td class="r num">' + (ev.avg ? '<b>' + ev.avg.toFixed(1) + '</b>' : '<span class="muted">—</span>') + '</td><td class="r" style="white-space:nowrap">' + btn + (ev.stage === 'done' ? ' <button class="btn sm" data-act="report" data-id="' + e.id + '">Report</button>' : '') + '</td></tr>'; }).join('') || '<tr><td colspan="6"><div class="empty">No reviews to show.</div></td></tr>') + '</tbody></table></div>';
  }
  function openEval(id) {
    const e = emp(id), ev = Object.assign({ stage: 'none', scores: {} }, S.reviews[id] || {}), me = ME();
    const self = me && me.id === e.id, mgrMode = e.can_manage && !self, locked = ev.stage === 'done';
    UI.evalScores = Object.assign({}, ev.scores || {});
    const areas = S.settings.review.areas;
    const scoreRows = () => areas.map(c => { const v = UI.evalScores[c.k] || 0; return '<div class="score-row"><div><b>' + esc(c.n) + '</b><small>' + esc(c.d || '') + (v ? ', ' + SCALE[v].toLowerCase() : '') + '</small></div><div class="score">' + [1, 2, 3, 4, 5].map(n => '<button aria-label="' + n + ', ' + SCALE[n] + '" aria-pressed="' + (n === v) + '" ' + (mgrMode && !locked ? 'data-act="score" data-k="' + c.k + '" data-n="' + n + '"' : 'disabled') + '>' + n + '</button>').join('') + '</div></div>'; }).join('');
    const vals = areas.map(a => UI.evalScores[a.k]).filter(Boolean), a = vals.length === areas.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
    const ta = (k, label, ph, editable) => '<div class="field full" style="margin-top:12px"><label for="ev_' + k + '">' + esc(label) + '</label>' + (editable ? '<textarea class="input" id="ev_' + k + '" rows="3" style="width:100%;resize:vertical" placeholder="' + esc(ph) + '">' + esc(ev[k] || '') + '</textarea>' : '<div class="v" style="font-weight:400;white-space:pre-wrap">' + (ev[k] ? esc(ev[k]) : '<span class="muted">Not written yet</span>') + '</div>') + '</div>';
    const selfEditable = self && (ev.stage === 'none' || ev.stage === 'self');
    const showMgr = mgrMode || ev.stage === 'done';
    const m = emp(ev.reviewer_id || e.reports_to);
    openModal('<div class="box-h"><div class="who">' + avatar(e) + '<div><h2>' + esc(e.name) + ', ' + S.settings.review.year + ' review</h2><small class="muted">' + esc(e.title || '') + ', reviewed by ' + (m ? esc(m.name) : '—') + '</small></div></div><span style="margin-left:12px">' + reviewTag(ev) + '</span><button class="btn ghost x" data-act="close-modal" aria-label="Close">' + I.x + '</button></div>' +
      '<div class="box-b"><div class="sec"><h3>Self-review</h3>' + ta('self_text', 'In your own words, how did this year go?', 'Wins, things you learned, where you want to grow', selfEditable) + '</div>' +
      (showMgr ? '<div class="sec"><h3>Scores<span class="r muted" style="font-weight:500;font-size:11.5px">1 needs improvement, 3 meets, 5 exceptional</span></h3><div id="evScores">' + scoreRows() + '</div><div id="evOverall">' + (a ? '<div class="overall"><b class="num">' + a.toFixed(1) + '</b><div><div style="font-weight:700">' + SCALE[Math.round(a)] + '</div><div class="muted" style="font-size:12px">Overall, updates as you score</div></div></div>' : '') + '</div></div>' +
        '<div class="sec"><h3>Manager notes</h3>' + ta('strengths', 'Strengths', 'What they do best', mgrMode && !locked) + ta('growth', 'Areas to grow', 'Be specific and kind', mgrMode && !locked) + ta('goals', 'Goals for next year', 'Two or three measurable goals', mgrMode && !locked) + '</div>' : '') + '</div>' +
      '<div class="box-f">' + (selfEditable ? '<button class="btn" data-act="self-save" data-id="' + id + '">Save draft</button><button class="btn primary" data-act="self-submit" data-id="' + id + '">Submit self-review</button>' : '') +
      (mgrMode && !locked ? '<button class="btn" data-act="eval-save" data-id="' + id + '">Save draft</button><button class="btn primary" id="evDone" data-act="eval-done" data-id="' + id + '" ' + (vals.length < areas.length ? 'disabled title="Score every area first"' : '') + '>Complete review</button>' : '') +
      (locked && isAdmin() && !self ? '<button class="btn ghost" data-act="eval-reopen" data-id="' + id + '">Reopen</button>' : '') + (locked ? '<button class="btn primary" data-act="report" data-id="' + id + '">Open report</button>' : '') + '</div>', true);
    UI.evalRedraw = () => { const box = $('evScores'); if (box) box.innerHTML = scoreRows(); const v2 = areas.map(x => UI.evalScores[x.k]).filter(Boolean), a2 = v2.length === areas.length ? v2.reduce((x, y) => x + y, 0) / v2.length : 0; const o = $('evOverall'); if (o) o.innerHTML = a2 ? '<div class="overall"><b class="num">' + a2.toFixed(1) + '</b><div><div style="font-weight:700">' + SCALE[Math.round(a2)] + '</div><div class="muted" style="font-size:12px">Overall, updates as you score</div></div></div>' : ''; const d = $('evDone'); if (d) d.disabled = v2.length < areas.length; };
  }
  async function saveEval(id, action) {
    const b = { action };
    if (action.indexOf('self') === 0) b.self_text = ($('ev_self_text') || {}).value || '';
    else { b.scores = UI.evalScores; ['strengths', 'growth', 'goals'].forEach(k => { const el = $('ev_' + k); if (el) b[k] = el.value; }); }
    const j = await post('/api/hr/reviews/' + id, b);
    if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return false; }
    S.reviews[id] = j.review; return j.review;
  }
  async function openReport(id) {
    const e = emp(id), ev = S.reviews[id] || {}, m = emp(ev.reviewer_id || e.reports_to), yr = S.settings.review.year;
    const d = await api('/api/hr/employees/' + id);
    const bal = (d && d.balances) || [];
    const a = ev.avg || 0;
    openModal('<div class="box-h no-print"><h2>Annual evaluation report</h2><button class="btn ghost x" data-act="close-modal" aria-label="Close">' + I.x + '</button></div>' +
      '<div class="box-b" id="printArea"><div class="report" style="padding:18px;border-radius:8px"><div class="rep-head"><div class="rep-mark">A</div><div><b style="font-size:16px;color:#190070">AxiomPrint</b><div style="font-size:11px;color:#6b6787">Annual employee evaluation</div></div><div class="addr">4544 San Fernando Rd.<br>Glendale, CA 91204</div></div>' +
      '<h2>' + esc(e.name) + '</h2><div class="rep-grid"><div><span>Position</span>' + esc(e.title || '—') + '</div><div><span>Department</span>' + esc(deptName(e.department_id) || '—') + '</div><div><span>Location</span>' + esc(LOCN(e.location).name) + '</div>' +
      '<div><span>Review period</span>Jan 1 – Dec 31, ' + yr + '</div><div><span>Reviewer</span>' + (m ? esc(m.name) : '—') + '</div><div><span>Hire date</span>' + (e.hire_date ? fmtLong(e.hire_date) : '—') + '</div></div>' +
      '<h4>Scores</h4><table><thead><tr><th>Area</th><th style="width:40%"></th><th class="r">Score</th></tr></thead><tbody>' + S.settings.review.areas.map(c => '<tr><td>' + esc(c.n) + '</td><td><div class="rep-bar"><i style="width:' + ((ev.scores || {})[c.k] || 0) / 5 * 100 + '%"></i></div></td><td class="r"><b>' + ((ev.scores || {})[c.k] || '—') + '</b> / 5</td></tr>').join('') +
      '<tr><td><b>Overall</b></td><td>' + (a ? SCALE[Math.round(a)] : '') + '</td><td class="r"><b>' + (a ? a.toFixed(1) : '—') + '</b> / 5</td></tr></tbody></table>' +
      '<h4>Attendance</h4><div class="rep-grid">' + bal.filter(x => x.track).map(x => '<div><span>' + esc(x.n) + ' used</span>' + x.used + ' of ' + x.allowance + ' days</div>').join('') + '</div>' +
      '<h4>Employee self-review</h4><p style="margin:0;white-space:pre-wrap">' + (esc(ev.self_text) || '—') + '</p><h4>Strengths</h4><p style="margin:0;white-space:pre-wrap">' + (esc(ev.strengths) || '—') + '</p>' +
      '<h4>Areas to grow</h4><p style="margin:0;white-space:pre-wrap">' + (esc(ev.growth) || '—') + '</p><h4>Goals for ' + (yr + 1) + '</h4><p style="margin:0;white-space:pre-wrap">' + (esc(ev.goals) || '—') + '</p>' +
      '<div class="sig"><div>Employee signature and date</div><div>Manager signature and date</div></div></div></div>' +
      '<div class="box-f no-print"><button class="btn" data-act="close-modal">Close</button><button class="btn primary" data-act="print">Print or save as PDF</button></div>', true);
  }

  // =========================================================== Skills
  function vSkills() {
    const LV = S.settings.skill_levels, groups = []; (S.settings.skills || []).forEach(s => { if (groups.indexOf(s.g) < 0) groups.push(s.g); });
    const SKL = groups.flatMap(g => S.settings.skills.filter(x => x.g === g));
    const cover = UI.cover, q = UI.skQ.toLowerCase().trim();
    const ppl = people().filter(e => e.status === 'Active' && (UI.skDept === 'all' || String(e.department_id) === String(UI.skDept)) && (!q || e.name.toLowerCase().indexOf(q) > -1));
    const lvl = (l) => '<i></i><i></i><i></i><i></i>';
    const rows = ppl.map(e => {
      const st = statusOf(e), lv = cover ? ((e.skills || {})[cover] || 0) : 0, cls = cover ? (lv >= 3 ? 'hl' : 'dim') : '';
      return '<tr class="' + cls + '"><td><div class="who">' + avatar(e, 'sm', st) + '<div><b>' + esc(e.name) + '</b><small>' + locName(e.location) + (cover && lv >= 3 ? ', ' + STATUS_TXT[st].toLowerCase() : '') + '</small></div></div></td>' +
        SKL.map(s => { const l = (e.skills || {})[s.k] || 0; return '<td class="lv">' + (e.can_manage ? '<button class="lvl l' + l + '" data-act="cycle" data-id="' + e.id + '" data-k="' + s.k + '" title="' + esc(first(e)) + ': ' + esc(s.n) + ', ' + esc(LV[l]).toLowerCase() + '. Click to change.">' + lvl(l) + '</button>' : '<span class="lvl l' + l + '" title="' + esc(LV[l]) + '">' + lvl(l) + '</span>') + '</td>'; }).join('') + '</tr>';
    }).join('');
    const allA = people().filter(e => e.status === 'Active');
    const foot = SKL.map(s => { const n = allA.filter(e => ((e.skills || {})[s.k] || 0) >= 3).length; return '<td class="' + (n <= 1 ? 'risk' : '') + '" title="' + n + ' independent">' + n + '</td>'; }).join('');
    const risky = SKL.filter(s => allA.filter(e => ((e.skills || {})[s.k] || 0) >= 3).length <= 1);
    return '<div class="toolbar"><label class="muted" for="coverSel">Find coverage for</label><select class="select" id="coverSel" data-in="cover"><option value="">Any skill</option>' + SKL.map(s => '<option value="' + s.k + '" ' + (cover === s.k ? 'selected' : '') + '>' + esc(s.n) + '</option>').join('') + '</select>' +
      (cover ? '<span class="muted">' + allA.filter(e => ((e.skills || {})[cover] || 0) >= 3 && ['working', 'break'].indexOf(statusOf(e)) > -1).length + ' working now can do this on their own</span>' : '') +
      '<select class="select" data-in="skdept"><option value="all">All departments</option>' + S.org.depts.map(d => '<option value="' + d.id + '" ' + (String(UI.skDept) === String(d.id) ? 'selected' : '') + '>' + esc(d.name) + '</option>').join('') + '</select>' +
      '<div class="search">' + I.search + '<input class="input" placeholder="Find a person" value="' + esc(UI.skQ) + '" data-in="skq" style="width:180px"></div>' +
      '<div class="legend" style="margin-left:auto">' + LV.map((l, i) => '<span><span class="lvl l' + i + '" style="padding:0"><i></i><i></i><i></i><i></i></span>' + esc(l) + '</span>').join('') + '</div></div>' +
      (allA.filter(e => Object.keys(e.skills || {}).length).length < 3 ? '<div class="lock blue">Skill levels are not filled in yet. Managers click a cell (or open a profile → Skills & languages) to set what each person can run — then this page shows where coverage is thin.</div>' : risky.length ? '<div class="lock red">Only one person or fewer can run ' + esc(risky.map(s => s.n.toLowerCase()).join(', ')) + ' on their own. Cross-train someone before the next vacation.</div>' : '') +
      '<div class="card tbl-wrap"><table class="mx" data-nolazy><thead><tr><th></th>' + groups.map(g => '<th class="grp" colspan="' + SKL.filter(s => s.g === g).length + '">' + esc(g) + '</th>').join('') + '</tr><tr><th style="vertical-align:bottom">Person</th>' + SKL.map(s => '<th class="sk">' + esc(s.n) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="40"><div class="empty">No one matches.</div></td></tr>') + '</tbody><tfoot><tr><td style="text-align:left">Independent or better (everyone)</td>' + foot + '</tr></tfoot></table></div>' + langCoverage();
  }
  function langCoverage() {
    const L = S.settings.languages, allA = people().filter(e => e.status === 'Active');
    return '<div class="card" style="margin-top:16px"><div class="card-h"><h2>Languages spoken</h2><span class="hint">Conversational or better, with who\'s working now</span>' + (isAdmin() ? '<div class="r"><button class="btn sm" data-act="nav" data-k="settings" data-tab="skills">Edit list</button></div>' : '') + '</div>' +
      '<div class="card-b lang-grid">' + L.list.map(l => { const ppl = allA.filter(e => ((e.langs || {})[l.k] || 0) >= 1).sort((a, b) => b.langs[l.k] - a.langs[l.k]); const on = ppl.filter(e => ['working', 'break'].indexOf(statusOf(e)) > -1).length;
        return '<div class="lang-card"><div class="lang-h"><b>' + esc(l.n) + '</b><span class="muted">' + ppl.length + ' ' + (ppl.length === 1 ? 'person' : 'people') + (ppl.length ? ', ' + on + ' on now' : '') + '</span></div><div class="lang-ppl">' +
          (ppl.slice(0, 30).map(e => '<button class="lang-p" data-act="open" data-id="' + e.id + '" title="' + esc(e.name) + ', ' + esc(L.levels[e.langs[l.k]]) + '">' + avatar(e, 'sm', statusOf(e)) + '<span>' + esc(first(e)) + '</span><small>' + esc(L.levels[e.langs[l.k]]) + '</small></button>').join('') || '<span class="muted" style="font-size:12px">No one yet — people add their languages on their profile</span>') + '</div></div>'; }).join('') + '</div></div>';
  }

  // =========================================================== Rewards
  async function loadCk() { UI.rwWeek = UI.rwWeek || addDays(mondayOf(today()), -7); const j = await api('/api/hr/checkins?week=' + UI.rwWeek); UI.ck = j && j.ok ? j : { rows: [], error: (j && j.error) || 'Could not load' }; if (UI.view === 'rewards') render(); }
  function vRewards() {
    const tabs = isMgr() ? [['checkin', 'Weekly check-in'], ['board', 'Leaderboard'], ['redeem', 'Redemptions'], ['how', 'How rewards work']] : [['board', 'My points'], ['redeem', 'My redemptions'], ['how', 'How rewards work']];
    if (!tabs.find(t => t[0] === UI.rwTab)) UI.rwTab = tabs[0][0];
    return '<div class="seg" style="margin-bottom:12px">' + tabs.map(t => '<button data-act="rw-tab" data-k="' + t[0] + '" aria-pressed="' + (UI.rwTab === t[0]) + '">' + t[1] + '</button>').join('') + '</div>' + ({ checkin: rwCheckin, board: rwBoard, redeem: rwRedeem, how: rwHow })[UI.rwTab]();
  }
  function rwCheckin() {
    const R = S.settings.rewards, C = UI.ck, ws = UI.rwWeek || addDays(mondayOf(today()), -7);
    const last = addDays(mondayOf(today()), -7), isLast = ws === last, isThis = ws === mondayOf(today());
    const head = '<div class="toolbar"><div class="seg"><button data-act="rw-week" data-n="-7" aria-label="Earlier week">‹</button><button data-act="rw-week" data-k="last" aria-pressed="' + isLast + '">Last week</button><button data-act="rw-week" data-k="this" aria-pressed="' + isThis + '">This week so far</button></div>' +
      '<span class="muted">' + fmtD(ws) + ' – ' + fmtD(addDays(ws, 6)) + (C && C.rows ? ', ' + C.rows.filter(r => r.sent_at).length + ' of ' + C.rows.length + ' sent' : '') + '</span><button class="btn primary" data-act="rw-sendall" style="margin-left:auto">Send all remaining</button></div>' +
      '<div class="lock blue">' + I.today + 'Attendance points fill in on their own from clock-ins. Add what you saw this week, then send. Each person gets an email with the breakdown.</div>';
    if (!C) return head + '<div class="card"><div class="empty">Loading…</div></div>';
    const rows = (C.rows || []).map(r => {
      const e = emp(r.employee_id); if (!e) return ''; const ap = r.att, sent = !!r.sent_at;
      return '<div class="ck ' + (sent ? 'sent' : '') + '"><div class="who">' + avatar(e) + '<div><b>' + esc(e.name) + '</b><small>' + esc(e.title || '') + '</small></div></div>' +
        '<div class="ck-att"><span class="tag ' + (ap.pts >= R.perfectWeek ? 'ok' : ap.pts ? 'warn' : ap.neutral ? '' : 'bad') + '">+' + ap.pts + ' attendance</span><small>' + esc(ap.why) + (ap.streak ? ', plus ' + R.streakWeeks + '-week streak bonus' : '') + '</small></div>' +
        '<div class="ck-cats">' + R.cats.map(c => '<button class="chip" ' + (sent ? 'disabled' : '') + ' data-act="rw-cat" data-id="' + e.id + '" data-k="' + c.k + '" aria-pressed="' + (r.cats.indexOf(c.k) > -1) + '">' + esc(c.n) + ' +' + c.p + '</button>').join('') + '</div>' +
        '<input class="input ck-note" placeholder="Note they\'ll see (optional)" value="' + esc(r.note || '') + '" data-rwnote="' + e.id + '" ' + (sent ? 'disabled' : '') + '>' +
        '<div class="ck-tot"><b class="num">' + r.total + '</b><small>' + (r.capped ? 'capped' : 'points') + '</small>' + (sent ? '<span class="tag ok">Sent</span>' : '<button class="btn sm primary" data-act="rw-send" data-id="' + e.id + '">Send</button>') + '</div></div>';
    }).join('');
    return head + '<div class="card"><div class="card-b ck-list">' + (rows || '<div class="empty">No one reports to you yet. Set "Reports to" on their profile.</div>') + '</div></div>';
  }
  function ckTotal(r) { const R = S.settings.rewards; const cp = r.cats.reduce((s, k) => s + ((R.cats.find(c => c.k === k) || {}).p || 0), 0); r.capped = r.att.pts + cp > R.weeklyCap; r.total = Math.min(R.weeklyCap, r.att.pts + cp); }
  function rwBoard() {
    const R = S.settings.rewards, me = ME();
    const ranked = people().filter(e => e.status === 'Active' && e.id !== S.org.ceo.employee_id).sort((a, b) => (b.points || 0) - (a.points || 0) || a.name.localeCompare(b.name));
    const myPts = me ? me.points || 0 : 0;
    const cat = R.catalog.slice().sort((a, b) => a.p - b.p), next = cat.find(c => c.p > myPts);
    const team = ranked.filter(e => e.can_manage && !(me && e.id === me.id));
    return '<div class="grid g-today"><div class="card board"><div class="card-h"><h2>Leaderboard</h2><span class="hint">All-time points</span></div><div class="card-b"><div class="list">' +
      ranked.slice(0, 40).map((e, i) => '<div class="li" ' + (me && e.id === me.id ? 'style="background:var(--accent-soft);margin:0 -10px;padding:10px;border-radius:8px"' : '') + '><span class="rank">' + (i + 1) + '</span>' + avatar(e) + '<div class="meta"><b>' + esc(e.name) + '</b><small class="muted">' + esc(deptName(e.department_id)) + '</small></div><b class="pts">' + (e.points || 0) + '</b></div>').join('') + '</div></div></div>' +
      '<div class="grid" style="align-content:start">' +
      (me ? '<div class="card"><div class="card-b"><div class="muted">Your points</div><div style="font-size:34px;font-weight:700;letter-spacing:-.02em">' + myPts + '</div><div class="muted" style="font-size:12px">' + (next ? (next.p - myPts) + ' more for ' + esc(next.n.toLowerCase()) : 'You can redeem anything in the catalog') + '</div>' + (next ? '<div class="meter"><i style="width:' + (myPts / next.p * 100) + '%"></i></div>' : '') + '</div></div>' : '') +
      (isMgr() && team.length ? '<div class="card"><div class="card-h"><h2>Quick shout-out</h2><span class="hint">Anytime, outside the weekly check-in</span></div><div class="card-b"><div class="fields">' +
        '<div class="field"><label for="aw_emp">Who</label><select class="select" id="aw_emp" data-people style="width:100%">' + team.sort((a, b) => a.name.localeCompare(b.name)).map(e => '<option value="' + e.id + '">' + esc(e.name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="aw_pts">Points</label><select class="select" id="aw_pts" style="width:100%"><option>10</option><option selected>25</option><option>50</option></select></div>' +
        '<div class="field full"><label for="aw_why">What did they do?</label><input class="input" id="aw_why" style="width:100%" placeholder="e.g. Caught a proof error before a 5k run"></div></div><div style="margin-top:12px"><button class="btn primary" data-act="award">Give points</button></div></div></div>' : '') +
      '<div class="card"><div class="card-h"><h2>Redeem points</h2></div><div class="card-b"><div class="list">' + cat.map(c => '<div class="li"><div class="meta"><b>' + esc(c.n) + '</b>' + (c.leave ? '<small class="muted" style="display:block">Adds ' + (c.days || 1) + ' day' + ((c.days || 1) === 1 ? '' : 's') + ' to your ' + esc(typeName(c.leave).toLowerCase()) + ' balance</small>' : '') + '</div><span class="tag acc num">' + c.p + ' pts</span>' + (me ? '<button class="btn sm" ' + (myPts < c.p ? 'disabled' : '') + ' data-act="redeem" data-k="' + esc(c.k) + '">Redeem</button>' : '') + '</div>').join('') + '</div></div></div>' +
      '<div class="card"><div class="card-h"><h2>Recent points</h2><span class="hint">Shout-outs are shared with the team</span></div><div class="card-b"><div class="list">' +
      (S.ledger.slice(0, 12).map(a => { const e = emp(a.employee_id); if (!e) return ''; return '<div class="li">' + avatar(e, 'sm') + '<div class="meta"><b>' + esc(first(e)) + '</b> <span class="tag ' + (a.points < 0 ? '' : 'acc') + '">' + (a.points > 0 ? '+' : '') + a.points + '</span><div style="font-size:12.5px">' + esc(a.reason || '') + '</div><small class="muted">' + (a.given_by ? 'From ' + esc(a.given_by) + ', ' : '') + fmtD((a.created_at || '').slice(0, 10)) + '</small></div></div>'; }).join('') || '<div class="empty">No points yet.</div>') + '</div></div></div></div></div>';
  }
  function rwRedeem() {
    const list = S.redemptions || [];
    const st = { requested: '<span class="tag warn">Requested</span>', fulfilled: '<span class="tag ok">Fulfilled</span>', rejected: '<span class="tag bad">Rejected — points returned</span>' };
    return '<div class="card"><div class="card-h"><h2>' + (isAdmin() ? 'Redemption requests' : 'My redemptions') + '</h2><span class="hint">' + (isAdmin() ? 'Fulfil a request once the reward is given. A paid day off adds to their balance when fulfilled.' : '') + '</span></div><div class="card-b"><div class="list">' +
      (list.map(r => { const e = emp(r.employee_id); return '<div class="li">' + avatar(e, 'sm') + '<div class="meta"><b>' + esc(e ? e.name : '') + '</b> · ' + esc(r.item_name) + ' <span class="tag acc">' + r.points + ' pts</span><div class="muted" style="font-size:11.5px">' + fmtLong((r.created_at || '').slice(0, 10)) + (r.decided_by ? ' · ' + esc(r.status) + ' by ' + esc(r.decided_by) : '') + '</div></div>' + (isAdmin() && r.status === 'requested' ? '<button class="btn sm ok" data-act="red-ok" data-id="' + r.id + '">Fulfilled</button><button class="btn sm bad" data-act="red-no" data-id="' + r.id + '">Reject</button>' : st[r.status] || '') + '</div>'; }).join('') || '<div class="empty">No redemptions yet.</div>') + '</div></div></div>';
  }
  function rwHow() {
    const R = S.settings.rewards, A = S.settings.attendance;
    return '<div class="how"><div class="card"><div class="card-b"><span class="tag ok">Automatic, every week</span><h3>Showing up on schedule</h3><p>Clock-ins are checked against each person\'s shift. A full week with no late arrivals, early exits, or missed punches earns <b>' + R.perfectWeek + ' points</b>.</p><p>Each late arrival or early exit takes off ' + R.latePenalty + ', and each missed punch takes off ' + R.missedPenalty + ', down to zero. Points never go negative.</p><p>' + R.streakWeeks + ' perfect weeks in a row adds a <b>' + R.streakBonus + '-point streak bonus</b>. A week with no scheduled shifts neither counts nor breaks the streak.</p><p class="muted">Late means more than ' + A.grace + ' minutes after shift start. Approved time off and holidays don\'t count against anyone.</p></div></div>' +
      '<div class="card"><div class="card-b"><span class="tag acc">Manager, every Monday</span><h3>Weekly check-in</h3><p>Each manager opens the check-in for last week. Attendance points are already filled in. The manager taps what they saw:</p><div class="chips" style="margin:10px 0">' + R.cats.map(c => '<span class="chip">' + esc(c.n) + ' +' + c.p + '</span>').join('') + '</div><p>Adds a note and sends. A week is capped at ' + R.weeklyCap + ' points so scores stay fair across teams.</p></div></div>' +
      '<div class="card"><div class="card-b"><span class="tag warn">Anytime</span><h3>Shout-outs</h3><p>For a moment that shouldn\'t wait until Monday, like catching a file error before a big run. These show on the team feed.</p><h3 style="margin-top:18px">Redeeming</h3><div class="list">' + R.catalog.slice().sort((a, b) => a.p - b.p).map(c => '<div class="li"><div class="meta">' + esc(c.n) + '</div><span class="tag acc num">' + c.p + ' pts</span></div>').join('') + '</div></div></div></div>' +
      (isAdmin() ? '<p class="muted" style="font-size:12px;margin-top:12px">Change point values, categories, and the catalog in <button class="linkbtn" data-act="nav" data-k="settings" data-tab="rew">HR settings</button>.</p>' : '');
  }

  // =========================================================== Settings
  function draft(k) { if (!UI.draft[k]) UI.draft[k] = JSON.parse(JSON.stringify(S.settings[k])); return UI.draft[k]; }
  function dirty(k) { UI.dirty = UI.dirty || {}; UI.dirty[k] = 1; return draft(k); }
  function setPath(obj, p, val) { const ks = p.split('.'); let o = obj; ks.slice(0, -1).forEach(k => { o = o[k] = o[k] == null ? {} : o[k]; }); o[ks[ks.length - 1]] = val; }
  const numIn = (key, p, v, w, step) => '<input class="input num" type="number" min="0" step="' + (step || 1) + '" style="width:' + (w || 66) + 'px" data-sp="' + key + '" data-p="' + p + '" value="' + esc(v) + '">';
  const chk = (key, p, v) => '<input type="checkbox" data-sp="' + key + '" data-p="' + p + '" ' + (v ? 'checked' : '') + '>';
  const txt = (key, p, v, w, ph) => '<input class="input" style="width:' + (w || 200) + 'px" data-sp="' + key + '" data-p="' + p + '" value="' + esc(v) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
  const saveBtn = (key) => '<div class="save-bar">' + (UI.dirty && UI.dirty[key] ? '<span class="muted" style="font-size:12px;align-self:center">Unsaved changes</span><button class="btn" data-act="set-reset" data-k="' + key + '">Discard</button>' : '') + '<button class="btn primary" data-act="set-save" data-k="' + key + '">Save</button></div>';
  function vSettings() {
    if (!isAdmin()) return '<div class="lock">' + I.lock + 'HR settings are for HR admins.</div>';
    const tabs = [['types', 'Time off types'], ['hol', 'Paid holidays'], ['att', 'Attendance rules'], ['clock', 'Time clock & PINs'], ['skills', 'Skills & languages'], ['rew', 'Rewards'], ['rev', 'Reviews'], ['co', 'Company'], ['audit', 'Audit log']];
    return '<div class="set"><nav class="set-nav">' + tabs.map(t => '<button data-act="set-tab" data-k="' + t[0] + '" aria-current="' + (UI.setTab === t[0] ? 'page' : 'false') + '">' + t[1] + '</button>').join('') + '</nav><div class="set-body">' + ({ types: sTypes, hol: sHol, att: sAtt, clock: sClock, skills: sSkills, rew: sRew, rev: sRev, co: sCo, audit: sAudit })[UI.setTab]() + '</div></div>';
  }
  function sTypes() {
    const T = draft('leave_types'), L = Object.keys(S.locations);
    return '<div class="card"><div class="card-h"><h2>Time off types</h2><span class="hint">Days per year, by location</span><div class="r"><button class="btn sm" data-act="pol-addtype">Add type</button></div></div><div class="card-b tbl-wrap" style="padding-top:8px"><table class="pol"><thead><tr><th>On</th><th>Name</th><th class="c">Paid</th><th class="c">Track balance</th>' + L.map(l => '<th class="c">' + esc(S.locations[l].name) + '</th>').join('') + '<th>How it\'s earned</th><th class="c">Carry over</th><th class="c">Notice (days)</th></tr></thead><tbody>' +
      T.map((t, i) => '<tr class="' + (t.on ? '' : 'off') + '"><td>' + chk('leave_types', i + '.on', t.on) + '</td><td>' + txt('leave_types', i + '.n', t.n, 130) + '</td><td class="c">' + chk('leave_types', i + '.paid', t.paid) + '</td><td class="c">' + chk('leave_types', i + '.track', t.track) + '</td>' +
        L.map(l => '<td class="c">' + numIn('leave_types', i + '.allow.' + l, (t.allow || {})[l] || 0, 58, 0.5) + '</td>').join('') +
        '<td><select class="select" data-sp="leave_types" data-p="' + i + '.accrual">' + ['Up front', 'Monthly', 'Per hour worked', 'As needed'].map(o => '<option ' + (o === t.accrual ? 'selected' : '') + '>' + o + '</option>').join('') + '</select></td><td class="c">' + numIn('leave_types', i + '.carry', t.carry || 0, 58) + '</td><td class="c">' + numIn('leave_types', i + '.notice', t.notice || 0, 58) + '</td></tr>').join('') + '</tbody></table>' +
      ((T.find(t => t.k === 'sick') || { allow: { gl: 5 } }).allow.gl < 5 ? '<div class="lock amber" style="margin-top:12px">California requires at least 40 hours (5 days) of paid sick leave a year for Glendale staff.</div>' : '') +
      '<p class="muted" style="font-size:12px;margin:12px 0 0">Monthly = the yearly days are earned a twelfth a month (from the hire month in the first year). Carry-over and a person\'s own allowance are set per person under their Time off tab → Adjust balances. Check local leave laws for each country with your accountant.</p>' + saveBtn('leave_types') + '</div></div>';
  }
  function sHol() {
    const H = S.holidays.filter(h => UI.holLoc === 'all' || h.location === UI.holLoc);
    const L = Object.keys(S.locations);
    return '<div class="card"><div class="card-h"><h2>Paid holidays</h2><span class="hint">Each location gets its own calendar</span></div><div class="card-b">' +
      '<div class="chips" style="margin-bottom:12px">' + [['all', 'All locations']].concat(L.map(l => [l, S.locations[l].name])).map(([k, n]) => '<button class="chip" data-act="hol-loc" data-k="' + k + '" aria-pressed="' + (UI.holLoc === k) + '">' + (k === 'all' ? '' : flag(k)) + esc(n) + ' ' + (k === 'all' ? S.holidays.length : S.holidays.filter(h => h.location === k).length) + '</button>').join('') + '</div>' +
      '<div class="hol-add"><input class="input" type="date" id="h_d"><input class="input" id="h_n" placeholder="Holiday name" style="flex:1;min-width:160px"><select class="select" id="h_l" data-loc>' + L.map(l => '<option value="' + l + '" ' + (UI.holLoc === l ? 'selected' : '') + '>' + esc(S.locations[l].name) + '</option>').join('') + '</select><button class="btn primary" data-act="hol-add">Add holiday</button></div>' +
      '<div class="list" style="margin-top:6px">' + (H.map(h => '<div class="li"><span class="num" style="width:120px;color:var(--ink-2)">' + fmtD(h.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + '</span><div class="meta"><b>' + esc(h.name) + '</b>' + (h.src === 'website' ? ' <span class="tag crm" title="From the website\'s Closed days (CRM holidays) — change it there">WEBSITE</span>' : '') + '</div><span class="tag">' + locName(h.location) + '</span>' + (h.id ? '<button class="btn sm ghost" data-act="hol-del" data-id="' + h.id + '" aria-label="Remove">' + I.x + '</button>' : '<span style="width:30px"></span>') + '</div>').join('') || '<div class="empty">No holidays for this location yet.</div>') + '</div>' +
      '<p class="muted" style="font-size:12px;margin-top:10px">Glendale also follows the website\'s Closed days (the CRM holidays list), shown as WEBSITE. Time off never counts a holiday, and nobody is expected to clock in on one.</p></div></div>';
  }
  function sAtt() {
    const A = draft('attendance'), row = (l, d, ctl) => '<div class="set-row"><div><b>' + l + '</b><small>' + d + '</small></div><div>' + ctl + '</div></div>';
    return '<div class="card"><div class="card-h"><h2>Attendance rules</h2><span class="hint">Used for timesheets, schedule tracking, and reward points</span></div><div class="card-b">' +
      row('Late after', 'Minutes past shift start before a clock-in counts as late', numIn('attendance', 'grace', A.grace) + ' min') +
      row('Left early after', 'Minutes before shift end before a clock-out counts as early', numIn('attendance', 'earlyGrace', A.earlyGrace) + ' min') +
      row('Alert manager when late by', 'Emails the manager so they can check in', numIn('attendance', 'lateAlert', A.lateAlert) + ' min') +
      row('Round punches to', 'Nearest increment on the timesheet', '<select class="select" data-sp="attendance" data-p="round">' + [0, 5, 15].map(v => '<option value="' + v + '" ' + (+A.round === v ? 'selected' : '') + '>' + (v ? v + ' min' : 'Exact') + '</option>').join('') + '</select>') +
      row('Unpaid break', 'Deducted when someone works over 6 hours and forgets to punch a break', numIn('attendance', 'breakMin', A.breakMin) + ' min') +
      row('Weekly overtime after', 'Hours in a week', numIn('attendance', 'otWeekly', A.otWeekly) + ' hrs') +
      row('California daily overtime', 'Over 8 hours in a day for Glendale staff', chk('attendance', 'otDailyCA', A.otDailyCA)) +
      row('Auto clock-out', 'Clock people out at shift end if they are still clocked in 2 hours later, and flag it for review', chk('attendance', 'autoOut', A.autoOut)) + saveBtn('attendance') + '</div></div>';
  }
  function sClock() {
    const C = draft('clock'), row = (l, d, ctl) => '<div class="set-row"><div><b>' + l + '</b><small>' + d + '</small></div><div>' + ctl + '</div></div>';
    const K = UI.kiosks;
    let here = null; try { here = localStorage.getItem('hr_kiosk_name'); } catch (e) {}
    const withPin = people().filter(e => e.status === 'Active' && e.has_pin).length, act = people().filter(e => e.status === 'Active').length;
    return '<div class="card"><div class="card-h"><h2>Time clock</h2><span class="hint">PINs, badges and who may clock in from the web</span></div><div class="card-b">' +
      row('PIN length', 'Digits in each person\'s time clock PIN (every PIN is different)', '<select class="select" data-sp="clock" data-p="pin_len">' + [4, 5, 6].map(v => '<option value="' + v + '" ' + (+C.pin_len === v ? 'selected' : '') + '>' + v + ' digits</option>').join('') + '</select>') +
      row('Glendale staff clock in', 'From their own phone / computer, or only at the time clock by the door', '<select class="select" data-sp="clock" data-p="gl_web"><option value="allow" ' + (C.gl_web === 'allow' ? 'selected' : '') + '>Web or time clock</option><option value="kiosk" ' + (C.gl_web === 'kiosk' ? 'selected' : '') + '>Time clock only</option></select>') +
      row('Office network', 'Glendale web clock-ins only from these IP addresses (blank = anywhere). The office\'s public IP.', txt('clock', 'office_ips', C.office_ips || '', 220, 'e.g. 203.0.113.7')) +
      row('Remote staff clock in from the web', 'Armenia, Mexico and the Philippines', '<select class="select" data-sp="clock" data-p="remote_web"><option value="allow" ' + (C.remote_web !== 'off' ? 'selected' : '') + '>Allowed</option><option value="off" ' + (C.remote_web === 'off' ? 'selected' : '') + '>Off</option></select>') +
      row('Badge needs the PIN too', 'Scanning a badge also asks for the PIN — stops someone clocking in with a borrowed badge', chk('clock', 'badge_pin', C.badge_pin)) + saveBtn('clock') + '</div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-h"><h2>Time clocks (kiosks)</h2><span class="hint">A tablet or computer by the door that the team clocks in on with their PIN or badge</span><div class="r"><button class="btn sm primary" data-act="kiosk-new">Make this device a time clock</button></div></div><div class="card-b">' +
      (here ? '<div class="lock blue">This browser is the time clock "' + esc(here) + '". <a href="/hr/kiosk" class="linkbtn" target="_blank">Open it</a></div>' : '') +
      '<div class="list">' + (K == null ? '<div class="muted">Loading…</div>' : K.length ? K.map(k => '<div class="li"><span class="av sm" style="background:' + (k.revoked_at ? '#cbd5e1' : '#10b981') + '">⏱</span><div class="meta"><b>' + esc(k.name) + '</b> <span class="tag">' + locName(k.location) + '</span><div class="muted" style="font-size:11.5px">Made by ' + esc(k.created_by || '') + ' · ' + (k.revoked_at ? 'switched off ' + esc(k.revoked_at) : k.last_seen ? 'last seen ' + esc(k.last_seen) + ' UTC' + (k.last_ip ? ' from ' + esc(k.last_ip) : '') : 'not used yet') + '</div></div>' + (k.revoked_at ? '' : '<button class="btn sm bad" data-act="kiosk-off" data-id="' + k.id + '">Switch off</button>') + '</div>').join('') : '<div class="muted">No time clocks yet.</div>') + '</div>' +
      '<p class="muted" style="font-size:12px;margin-top:10px">' + withPin + ' of ' + act + ' active people have a PIN. Set a PIN on each person\'s profile (Overview → Time clock), or let them set their own from Today. Badges: People → Print badges. A USB or Bluetooth barcode scanner by the time clock reads badges instantly; the tablet camera works too.</p></div></div>';
  }
  function sSkills() {
    const SK = draft('skills'), LV = draft('skill_levels'), LG = draft('languages');
    const groups = []; SK.forEach(s => { if (groups.indexOf(s.g) < 0) groups.push(s.g); });
    const cnt = (k) => S.employees.filter(e => ((e.skills || {})[k] || 0) > 0).length, ind = (k) => S.employees.filter(e => ((e.skills || {})[k] || 0) >= 3).length;
    const lc = (k) => S.employees.filter(e => (e.langs || {}).hasOwnProperty(k)).length;
    return '<div class="card"><div class="card-h"><h2>Skills & equipment</h2><span class="hint">Shows on every profile and the Skills grid</span></div><div class="card-b">' +
      '<div class="hol-add"><input class="input" id="sk_n" placeholder="New skill, e.g. Spot UV coater" style="flex:1"><input class="input" id="sk_g" list="sk_groups" placeholder="Group" style="width:170px"><datalist id="sk_groups">' + groups.map(g => '<option value="' + esc(g) + '">').join('') + '</datalist><button class="btn primary" data-act="sk-add">Add skill</button></div>' +
      groups.map(g => '<div style="margin-top:16px"><div style="font-weight:700;margin-bottom:4px">' + esc(g) + ' <span class="muted" style="font-weight:500;font-size:12px">' + SK.filter(s => s.g === g).length + ' skills</span></div>' + SK.map((s, i) => ({ s, i })).filter(x => x.s.g === g).map(({ s, i }) => '<div class="set-row">' + txt('skills', i + '.n', s.n, 260) + '<div><select class="select" data-sp="skills" data-p="' + i + '.g">' + groups.map(x => '<option ' + (x === s.g ? 'selected' : '') + '>' + esc(x) + '</option>').join('') + '</select><span class="muted" style="font-size:11.5px;width:150px;text-align:right">' + cnt(s.k) + ' trained, ' + ind(s.k) + ' independent</span><button class="btn sm ghost" data-act="sk-del" data-i="' + i + '" aria-label="Remove">' + I.x + '</button></div></div>').join('') + '</div>').join('') + saveBtn('skills') + '</div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-h"><h2>Skill levels</h2><span class="hint">Independent and above counts as coverage</span></div><div class="card-b">' + LV.map((l, i) => '<div class="set-row"><div style="display:flex;align-items:center;gap:12px"><span class="lvl l' + i + '" style="padding:0"><i></i><i></i><i></i><i></i></span><b>Level ' + i + '</b></div><div>' + txt('skill_levels', String(i), l, 220) + '</div></div>').join('') + saveBtn('skill_levels') + '</div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-h"><h2>Languages</h2><span class="hint">People pick from this list on their profile</span></div><div class="card-b"><div class="hol-add"><input class="input" id="lg_new" placeholder="Add a language, e.g. Farsi" style="flex:1"><button class="btn primary" data-act="lang-new">Add language</button></div>' +
      LG.list.map((l, i) => '<div class="set-row">' + txt('languages', 'list.' + i + '.n', l.n, 260) + '<div><span class="muted" style="font-size:11.5px">' + lc(l.k) + ' people</span><button class="btn sm ghost" data-act="lang-rm" data-i="' + i + '" aria-label="Remove">' + I.x + '</button></div></div>').join('') +
      '<div class="sub-h">Language levels</div>' + LG.levels.map((n, i) => '<div class="set-row"><b>Level ' + i + '</b><div>' + txt('languages', 'levels.' + i, n, 220) + '</div></div>').join('') + saveBtn('languages') + '</div></div>';
  }
  function sRew() {
    const R = draft('rewards'), row = (l, d, ctl) => '<div class="set-row"><div><b>' + l + '</b><small>' + d + '</small></div><div>' + ctl + '</div></div>';
    const types = (S.settings.leave_types || []).filter(t => t.on);
    return '<div class="card"><div class="card-h"><h2>Attendance points</h2></div><div class="card-b">' +
      row('Perfect week', 'No late arrivals, early exits, or missed punches', numIn('rewards', 'perfectWeek', R.perfectWeek) + ' pts') +
      row('Late or left early', 'Taken off the weekly attendance points', numIn('rewards', 'latePenalty', R.latePenalty) + ' pts each') +
      row('Missed punch', 'Taken off the weekly attendance points', numIn('rewards', 'missedPenalty', R.missedPenalty) + ' pts each') +
      row('Streak bonus', 'Extra points for this many perfect weeks in a row', numIn('rewards', 'streakWeeks', R.streakWeeks, 52) + ' weeks ' + numIn('rewards', 'streakBonus', R.streakBonus) + ' pts') +
      row('Weekly cap', 'Most points one person can earn in a check-in', numIn('rewards', 'weeklyCap', R.weeklyCap) + ' pts') + '</div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-h"><h2>Check-in categories</h2><div class="r"><button class="btn sm" data-act="pol-addcat">Add category</button></div></div><div class="card-b">' + R.cats.map((c, i) => '<div class="set-row">' + txt('rewards', 'cats.' + i + '.n', c.n, 300) + '<div>' + numIn('rewards', 'cats.' + i + '.p', c.p) + ' pts <button class="btn sm ghost" data-act="pol-delcat" data-i="' + i + '" aria-label="Remove">' + I.x + '</button></div></div>').join('') + '</div></div>' +
      '<div class="card" style="margin-top:16px"><div class="card-h"><h2>Reward catalog</h2><div class="r"><button class="btn sm" data-act="pol-addcatalog">Add reward</button></div></div><div class="card-b">' + R.catalog.map((c, i) => '<div class="set-row">' + txt('rewards', 'catalog.' + i + '.n', c.n, 240) + '<div>' + numIn('rewards', 'catalog.' + i + '.p', c.p, 80) + ' pts · adds <select class="select" data-sp="rewards" data-p="catalog.' + i + '.leave"><option value="">no time off</option>' + types.map(t => '<option value="' + t.k + '" ' + (c.leave === t.k ? 'selected' : '') + '>' + esc(t.n.toLowerCase()) + '</option>').join('') + '</select>' + (c.leave ? numIn('rewards', 'catalog.' + i + '.days', c.days || 1, 56, 0.5) + ' days' : '') + ' <button class="btn sm ghost" data-act="pol-delcatalog" data-i="' + i + '" aria-label="Remove">' + I.x + '</button></div></div>').join('') + saveBtn('rewards') + '</div></div>';
  }
  function sRev() {
    const R = draft('review');
    return '<div class="card"><div class="card-h"><h2>Annual review cycle</h2></div><div class="card-b"><div class="set-row"><div><b>Review year</b><small>The cycle everyone sees on Reviews</small></div><div>' + numIn('review', 'year', R.year, 80) + '</div></div>' +
      '<div class="set-row"><div><b>Due date</b><small>Shown as "days left"</small></div><div><input class="input" type="date" data-sp="review" data-p="due" value="' + esc(R.due) + '"></div></div>' +
      '<div class="sub-h">Areas scored 1–5 <button class="btn sm" data-act="rev-addarea" style="margin-left:8px">Add area</button></div>' +
      R.areas.map((a, i) => '<div class="set-row">' + txt('review', 'areas.' + i + '.n', a.n, 220) + '<div>' + txt('review', 'areas.' + i + '.d', a.d || '', 320, 'What it means') + '<button class="btn sm ghost" data-act="rev-delarea" data-i="' + i + '" aria-label="Remove">' + I.x + '</button></div></div>').join('') +
      '<p class="muted" style="font-size:12px">Changing the areas mid-cycle keeps the scores already given for areas that stay.</p>' + saveBtn('review') + '</div></div>';
  }
  function sCo() {
    const O = draft('org');
    return '<div class="card"><div class="card-h"><h2>Company</h2></div><div class="card-b"><div class="set-row"><div><b>Top of the tree</b><small>The name on the CEO card (matched to the person in People)</small></div><div>' + txt('org', 'ceo_name', O.ceo_name, 220) + txt('org', 'ceo_title', O.ceo_title, 120) + '</div></div>' + saveBtn('org') +
      '<div class="sub-h">The Axiom CRM</div><div class="set-row"><div><b>Staff and tree</b><small>NovaHR reads the CRM users, departments and teams (never writes). Last sync: ' + esc(S.sync && S.sync.at ? new Date(S.sync.at).toLocaleString() : '—') + (S.sync && S.sync.error ? ' — ' + esc(S.sync.error) : '') + '</small></div><div><button class="btn" data-act="sync">Sync now</button></div></div>' +
      '<div class="set-row"><div><b>Live since</b><small>Adherence and timesheet flags count from each person\'s first punch</small></div><div>' + esc(S.go_live ? fmtLong(S.go_live) : '—') + '</div></div></div></div>';
  }
  function sAudit() {
    const rows = UI.audit;
    return '<div class="card"><div class="card-h"><h2>Audit log</h2><span class="hint">Every change in NovaHR, newest first (last 300)</span><div class="r"><button class="btn sm" data-act="audit-reload">Refresh</button></div></div><div class="card-b tbl-wrap"><table class="audit"><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>' +
      (rows == null ? '<tr><td colspan="4" class="muted">Loading…</td></tr>' : rows.map(r => '<tr><td class="num" style="white-space:nowrap">' + esc(r.at) + '</td><td>' + esc(r.actor) + '</td><td>' + esc(r.entity) + (r.entity_id ? ' #' + r.entity_id : '') + ' · <b>' + esc(r.action) + '</b>' + (r.entity === 'employee' && emp(r.entity_id) ? '<div class="muted">' + esc(emp(r.entity_id).name) + '</div>' : '') + '</td><td><code>' + esc(String(r.after_json || '').slice(0, 220)) + '</code></td></tr>').join('')) + '</tbody></table></div></div>';
  }

  // =========================================================== PIN, badges
  function pinModal(id) {
    const e = emp(id), self = ME() && ME().id === e.id, len = S.settings.clock.pin_len || 4;
    openModal('<div class="box-h"><h2>' + (self ? 'Your time clock PIN' : 'PIN for ' + esc(e.name)) + '</h2><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div><div class="box-b" id="pinBody">' +
      '<p class="muted" style="margin-top:0">' + len + (len < 6 ? '–6' : '') + ' digits, different from everyone else\'s. ' + (self ? 'Pick one you will remember — it is never shown again.' : 'Make one and tell ' + esc(first(e)) + ' in person — it is shown once.') + '</p>' +
      '<div class="fields"><div class="field"><label for="pin_in">' + (self ? 'Choose your PIN' : 'Type a PIN (optional)') + '</label><input class="input num" id="pin_in" inputmode="numeric" autocomplete="off" maxlength="6" style="width:100%;font-size:18px;letter-spacing:.2em" placeholder="' + '•'.repeat(len) + '"></div></div></div>' +
      '<div class="box-f"><button class="btn" data-act="close-modal">Cancel</button>' + (!self || e.can_manage ? '<button class="btn" data-act="pin-gen" data-id="' + id + '">Make a random PIN</button>' : '') + '<button class="btn primary" data-act="pin-save" data-id="' + id + '">Save PIN</button></div>');
    setTimeout(() => { const i = $('pin_in'); if (i) i.focus(); }, 60);
  }
  async function savePin(id, gen) {
    const pin = gen ? undefined : ($('pin_in').value || '').trim();
    if (!gen && !pin) { toast('Type a PIN or make a random one'); return; }
    const j = await post('/api/hr/employees/' + id + '/pin', gen ? {} : { pin });
    if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
    const e = emp(id); e.has_pin = true;
    $('pinBody').innerHTML = '<p style="margin-top:0">' + (ME() && ME().id === +id ? 'Your PIN is saved:' : 'Tell ' + esc(first(e)) + ' this PIN in person:') + '</p><div class="pin-show">' + esc(j.pin) + '</div><p class="muted" style="font-size:12px">It will not be shown again. A new one can be made any time.</p>';
    $('modalBox').querySelector('.box-f').innerHTML = '<button class="btn primary" data-act="close-modal">Done</button>';
    if (UI.view === 'today' || UI.view === 'people') render(); if (UI.drawer) drawRender();
  }
  function qrSvg(code, cell) {
    if (typeof qrcode !== 'function') return '<div class="muted" style="font-size:10px;word-break:break-all;text-align:center">' + esc(code) + '</div>';
    const q = qrcode(0, 'M'); q.addData(code); q.make();
    return q.createSvgTag({ cellSize: cell || 4, margin: 0, scalable: true });
  }
  function badgeHTML(b) {
    const ph = b.photo ? 'background-image:url(\'' + esc(b.photo) + '\');background-color:#e5e7eb' : 'background:' + (b.color || nameColor(b.name));
    return '<div class="badge"><div class="badge-top"><i>A</i>AXIOMPRINT</div><div class="badge-ph" style="' + ph + '">' + (b.photo ? '' : esc(initials(b))) + '</div><div class="badge-n">' + esc(b.name) + '</div><div class="badge-t">' + esc(b.title || '') + (b.dept ? '<br>' + esc(b.dept) : '') + '</div><div class="badge-qr qr">' + qrSvg(b.code, 3) + '</div><div class="badge-f">SCAN TO CLOCK IN · NOVAHR</div></div>';
  }
  async function printBadges(ids) {
    openModal('<div class="box-h no-print"><h2>Badges</h2><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div><div class="box-b"><div class="empty">Making badges…</div></div>', true);
    const j = await post('/api/hr/badges', { ids: ids || [] });
    if (!j || !j.ok) { $('modalBox').querySelector('.box-b').innerHTML = '<div class="lock red">' + esc((j && j.error) || 'Could not make badges') + '</div>'; return; }
    $('modalBox').innerHTML = '<div class="box-h no-print"><h2>' + j.badges.length + ' badge' + (j.badges.length === 1 ? '' : 's') + '</h2><span class="muted" style="font-size:12px">CR80 card size (2.125 × 3.375 in). Print on card stock or badge sheets.</span><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div>' +
      '<div class="box-b"><div id="printArea"><div class="badges">' + j.badges.map(badgeHTML).join('') + '</div></div></div><div class="box-f no-print"><button class="btn" data-act="close-modal">Close</button><button class="btn primary" data-act="print">Print badges</button></div>';
  }
  function badgePicker() {
    const list = people().filter(e => e.status === 'Active' && e.can_manage).sort((a, b) => a.name.localeCompare(b.name));
    openModal('<div class="box-h"><h2>Print badges</h2><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div><div class="box-b"><p class="muted" style="margin-top:0">Each badge has the person\'s photo and a QR code they scan at the time clock. A lost badge is replaced from their profile (the old one stops working).</p>' +
      '<div class="toolbar"><button class="btn sm" data-act="bp-all" data-n="1">Tick all</button><button class="btn sm" data-act="bp-all" data-n="0">Clear</button><select class="select" id="bp_dept"><option value="">Any department</option>' + S.org.depts.map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('') + '</select><button class="btn sm" data-act="bp-dept">Tick that department</button></div>' +
      '<div id="bpList" style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 10px">' + list.map(e => '<label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:12.5px"><input type="checkbox" value="' + e.id + '" data-dept="' + (e.department_id || '') + '">' + avatar(e, 'xs') + esc(e.name) + '<span class="muted" style="font-size:11px">' + esc(e.title || '') + (e.photo_url ? '' : ' · no photo') + '</span></label>').join('') + '</div></div>' +
      '<div class="box-f"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="bp-go">Make badges</button></div>');
  }

  // =========================================================== People picker (1.20.168)
  // Every <select data-people> (options = employee ids) is drawn as a button with the person's head + name, and opens a list
  // with heads, names and titles (search past 8 people). The <select> stays in the page, hidden, and keeps the value: a pick
  // sets it and fires change, so every reader of .value works as before. A MutationObserver upgrades selects drawn later.
  let ppOpen = null;
  function ppFace(v, label, cls) {
    const e = v ? emp(v) : (/^me$/i.test(String(label || '').trim()) ? ME() : null);
    if (e) return avatar(e, cls || 'sm');
    return '<span class="av ' + (cls || 'sm') + ' pp-none" aria-hidden="true">—</span>';
  }
  /* 1.20.169: a <select data-loc> (options = location keys) gets the same picker with the flag and the local time */
  const isLoc = (sel) => sel.hasAttribute('data-loc');
  const locRow = (o) => '<span class="pp-flag">' + flag(o.value) + '</span><span class="pp-txt"><b>' + esc(o.text) + '</b><small>' + clockStr(LOCN(o.value).tz) + ' local</small></span>';
  function ppLabel(sel) {
    const o = sel.options[sel.selectedIndex]; if (!o) return '<span class="muted">Pick a person</span>';
    if (isLoc(sel)) return locRow(o);
    const e = o.value ? emp(o.value) : null, isMe = !o.value && /^me$/i.test(o.text.trim());
    const sub = e ? [e.title, deptName(e.department_id)].filter(Boolean)[0] : isMe && ME() ? ME().name : '';
    return ppFace(o.value, o.text) + '<span class="pp-txt"><b>' + esc(o.text) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>';
  }
  function ppSync(sel) { const b = sel && sel._ppBtn; if (b) { b.innerHTML = ppLabel(sel) + '<svg class="pp-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>'; b.disabled = sel.disabled; } }
  function ppEnhance(sel) {
    if (sel._ppBtn) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pp-btn';
    if (sel.style.width) b.style.width = sel.style.width;
    sel.style.display = 'none'; sel.parentNode.insertBefore(b, sel.nextSibling); sel._ppBtn = b; ppSync(sel);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); if (ppOpen && ppOpen.sel === sel) ppClose(); else ppShow(sel); });
  }
  function ppClose() { if (ppOpen) { ppOpen.el.remove(); ppOpen = null; } }
  function ppShow(sel) {
    ppClose();
    const opts = Array.from(sel.options), many = opts.length > 8;
    const el = document.createElement('div'); el.className = 'pp-pop' + (isLoc(sel) ? ' pp-locs' : '');
    el.innerHTML = (many ? '<div class="pp-q">' + I.search + '<input type="text" placeholder="Search people" autocomplete="off"></div>' : '') + '<div class="pp-list" role="listbox"></div>';
    document.body.appendChild(el);
    const r = sel._ppBtn.getBoundingClientRect(), w = Math.max(r.width, isLoc(sel) ? 220 : 280);
    el.style.width = w + 'px'; el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    const below = innerHeight - r.bottom - 12, above = r.top - 12, up = below < 260 && above > below;
    el.style.maxHeight = Math.min(380, Math.max(160, up ? above : below)) + 'px';
    if (up) el.style.bottom = (innerHeight - r.top + 4) + 'px'; else el.style.top = (r.bottom + 4) + 'px';
    const list = el.querySelector('.pp-list'), q = el.querySelector('input');
    let act = 0, shown = [];
    const draw = () => {
      const t = q ? q.value.trim().toLowerCase() : '';
      shown = opts.filter(o => { if (!t) return true; if (isLoc(sel)) return o.text.toLowerCase().indexOf(t) > -1; const e = o.value ? emp(o.value) : null; return [o.text, e && e.title, e && deptName(e.department_id), e && LOCN(e.location).name].join(' ').toLowerCase().indexOf(t) > -1; });
      act = Math.max(0, Math.min(act, shown.length - 1));
      list.innerHTML = shown.map((o, i) => { if (isLoc(sel)) return '<div class="pp-row' + (o.value === sel.value ? ' sel' : '') + (i === act ? ' act' : '') + '" role="option" data-i="' + i + '">' + locRow(o) + (o.value === sel.value ? '<span class="pp-tick">✓</span>' : '') + '</div>';
        const e = o.value ? emp(o.value) : null; const isMe = !o.value && /^me$/i.test(o.text.trim()) && ME();
        const sub = e ? [e.title, deptName(e.department_id), LOCN(e.location).name].filter(Boolean).join(' · ') : isMe ? ME().name : '';
        return '<div class="pp-row' + (o.value === sel.value ? ' sel' : '') + (i === act ? ' act' : '') + '" role="option" data-i="' + i + '">' + ppFace(o.value, o.text) + '<span class="pp-txt"><b>' + esc(o.text) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' + (o.value === sel.value ? '<span class="pp-tick">✓</span>' : '') + '</div>'; }).join('') || '<div class="pp-empty">No one matches</div>';
      const a = list.querySelector('.act'); if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const pick = (o) => { if (!o) return; sel.value = o.value; ppSync(sel); ppClose(); sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); sel._ppBtn.focus(); };
    list.addEventListener('mousedown', (ev) => ev.preventDefault());
    list.addEventListener('click', (ev) => { const row = ev.target.closest('.pp-row'); if (row) pick(shown[+row.dataset.i]); });
    el.addEventListener('click', (ev) => ev.stopPropagation());
    const keys = (ev) => {
      if (ev.key === 'ArrowDown') { act = Math.min(shown.length - 1, act + 1); draw(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { act = Math.max(0, act - 1); draw(); ev.preventDefault(); }
      else if (ev.key === 'Enter') { pick(shown[act]); ev.preventDefault(); }
      else if (ev.key === 'Escape') { ppClose(); sel._ppBtn.focus(); ev.preventDefault(); ev.stopPropagation(); }
    };
    act = Math.max(0, opts.findIndex(o => o.value === sel.value));
    if (q) { q.addEventListener('input', () => { act = 0; draw(); }); q.addEventListener('keydown', keys); }
    else { el.tabIndex = -1; el.addEventListener('keydown', keys); }
    ppOpen = { sel, el }; draw();
    setTimeout(() => (q || el).focus(), 0);
  }
  document.addEventListener('click', () => ppClose());
  window.addEventListener('resize', () => ppClose());
  document.addEventListener('scroll', (ev) => { if (ppOpen && !ppOpen.el.contains(ev.target)) ppClose(); }, true);
  new MutationObserver(() => { document.querySelectorAll('select[data-people], select[data-loc]').forEach(ppEnhance); }).observe(document.body, { childList: true, subtree: true });

  // =========================================================== Add employee
  async function openAdd() {
    openModal('<div class="box-h"><h2>Add employee</h2><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div><div class="box-b">' +
      '<div class="seg" style="margin-bottom:12px"><button data-act="add-mode" data-k="crm" aria-pressed="true">From the Axiom CRM</button><button data-act="add-mode" data-k="hand" aria-pressed="false">Type in by hand</button></div><div id="addBody"><div class="empty">Loading the CRM staff list…</div></div></div>' +
      '<div class="box-f" id="addFoot"><button class="btn" data-act="close-modal">Cancel</button></div>', true);
    const j = await api('/api/hr/crm-staff');
    UI.crmStaff = j && j.ok ? j.staff : [];
    addMode('crm');
  }
  function addMode(k) {
    document.querySelectorAll('[data-act="add-mode"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.k === k));
    if (k === 'crm') {
      const list = (UI.crmStaff || []).sort((a, b) => (a.test - b.test) || a.name.localeCompare(b.name));
      $('addBody').innerHTML = '<p class="muted" style="margin-top:0">Active CRM staff who are not in NovaHR yet. Their name, email, phones, birthday, start date, photo and title come from the CRM.</p><input class="input" id="crmQ" placeholder="Search" style="width:100%;margin-bottom:8px" data-in="crmq">' +
        '<div id="crmList" style="max-height:360px;overflow:auto">' + (list.length ? list.map(u => '<div class="li" data-name="' + esc(u.name.toLowerCase() + ' ' + (u.email || '').toLowerCase()) + '">' + avatar({ name: u.name, photo_url: u.photo }, 'sm') + '<div class="meta"><b>' + esc(u.name) + '</b>' + (u.test ? ' <span class="tag">looks like a test account</span>' : '') + '<small class="muted" style="display:block">' + esc(u.title || '') + ' · ' + esc(u.email || '') + ' · ' + locName(u.location) + '</small></div><button class="btn sm primary" data-act="add-crm" data-id="' + u.id + '">Add</button></div>').join('') : '<div class="empty">Everyone active in the CRM is already in NovaHR.</div>') + '</div>';
      $('addFoot').innerHTML = '<button class="btn" data-act="close-modal">Close</button>';
    } else {
      $('addBody').innerHTML = '<div class="fields"><div class="field full"><label for="n_name">Full name</label><input class="input" id="n_name"></div><div class="field"><label for="n_title">Job title</label><input class="input" id="n_title"></div>' +
        '<div class="field"><label for="n_dept">Department</label><select class="select" id="n_dept" style="width:100%"><option value="">—</option>' + S.org.depts.map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="n_loc">Location</label><select class="select" id="n_loc" data-loc style="width:100%">' + Object.keys(S.locations).map(k => '<option value="' + k + '">' + esc(S.locations[k].name) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="n_email">Work email</label><input class="input" id="n_email" type="email"></div><div class="field"><label for="n_hire">Start date</label><input class="input" id="n_hire" type="date" value="' + today() + '"></div>' +
        '<div class="field"><label for="n_rate">Hourly rate (USD)</label><input class="input" id="n_rate" type="number" step="0.25"></div></div><p class="muted" style="font-size:12px;margin:12px 0 0">For someone not in the CRM yet (a contractor, a new hire before their account). Fill in the rest on their profile.</p>';
      $('addFoot').innerHTML = '<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="add-save">Add employee</button>';
    }
  }

  // =========================================================== events
  async function act(a, b, ev) {
    const id = b.dataset.id;
    switch (a) {
      case 'nav': if (b.dataset.tab) UI.setTab = b.dataset.tab; closeAll(); UI.view = b.dataset.k; render(); $('view').scrollTop = 0; return;
      case 'band': UI.bandOpen[b.dataset.k] = !UI.bandOpen[b.dataset.k]; render(); return;
      case 'open': ev.stopPropagation(); closeModal(); openDrawer(id); return;
      case 'close': closeAll(); return;
      case 'close-modal': closeModal(); return;
      case 'tab': UI.tab = b.dataset.k; UI.editing = false; drawRender(); return;
      case 'edit': UI.editing = true; drawRender(); return;
      case 'edit-cancel': UI.editing = false; drawRender(); return;
      case 'edit-save': {
        const e = emp(UI.drawer), body = {};
        document.querySelectorAll('#drawer [data-f]').forEach(i => { const k = i.dataset.f, v = i.value.trim(); if (String(e[k] == null ? '' : e[k]) !== v) body[k] = v; });
        if (!Object.keys(body).length) { UI.editing = false; drawRender(); return; }
        const j = await post('/api/hr/employees/' + e.id, body);
        if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        UI.editing = false; toast('Details saved'); await load(true); openDrawer(e.id, UI.tab); return;
      }
      case 'job-save': {
        const e = emp(UI.drawer), body = {};
        const tm = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(v); return m ? +m[1] + (+m[2]) / 60 : null; };
        document.querySelectorAll('#drawer [data-jf]').forEach(i => { const k = i.dataset.jf; let v = i.value; if (k === 'shift_start' || k === 'shift_end') v = tm(v); body[k] = v; });
        if (body.shift_start != null && body.shift_end != null && body.shift_end <= body.shift_start) body.shift_end += 24;
        const send = {}; Object.keys(body).forEach(k => { if (k === 'pay_effective' || k === 'pay_reason') return; if (String(e[k] == null ? '' : e[k]) !== String(body[k] == null ? '' : body[k])) send[k] = body[k]; });
        if (!Object.keys(send).length) { toast('Nothing changed'); return; }
        if ('pay_rate' in send || 'pay_type' in send) { send.pay_effective = body.pay_effective; send.pay_reason = body.pay_reason; }
        const j = await post('/api/hr/employees/' + e.id, send);
        if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        toast('Job & pay saved'); await load(true); openDrawer(e.id, 'job'); return;
      }
      case 'wd': { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); const h = document.querySelector('#drawer [data-jf="shift_days"]'); h.value = Array.from(document.querySelectorAll('#drawer [data-act="wd"][aria-pressed="true"]')).map(x => x.dataset.n).join(','); return; }
      case 'fill': {
        const k = b.dataset.k, jobKeys = ['pay_rate', 'pay_method', 'commission_pct'];
        if (k === 'langs') { UI.tab = 'skills'; UI.editing = false; drawRender(); return; }
        UI.tab = jobKeys.indexOf(k) > -1 ? 'job' : 'overview'; UI.editing = jobKeys.indexOf(k) < 0; drawRender();
        setTimeout(() => { const el = document.querySelector('#drawer [data-f="' + k + '"],#drawer [data-jf="' + k + '"]'); if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); } else if (k === 'photo_url') { const ph = document.querySelector('#drawer .photo-row'); if (ph) ph.scrollIntoView({ block: 'center' }); } }, 40);
        return;
      }
      case 'photo-del': { const j = await post('/api/hr/employees/' + UI.drawer + '/photo', { photo: null }); if (j && j.ok) { toast('Back to the CRM photo'); setTimeout(async () => { await load(true); openDrawer(UI.drawer, 'overview'); }, 600); } return; }
      case 'loc': UI.loc = b.dataset.k; render(); return;
      case 'incomplete': UI.incomplete = !UI.incomplete; render(); return;
      case 'inactive': UI.inactive = !UI.inactive; await load(); return;
      case 'punch': {
        b.disabled = true;
        const j = await post('/api/hr/punch', { type: b.dataset.t });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not clock in'); b.disabled = false; return; }
        toast({ in: 'Clocked in', break: 'Break started', back: 'Back from break', out: 'Clocked out' }[b.dataset.t] + ' at ' + timeIn(j.at, tzOf(ME())));
        UI.myWeek = null; await load(true); return;
      }
      case 'approve': case 'decline': {
        let note = null;
        if (a === 'decline') { const r = S.leave.find(x => x.id === +id); note = prompt('Reason for declining (shared with ' + first(emp(r.employee_id)) + ')', ''); if (note === null) return; if (!note.trim()) { toast('Add a reason'); return; } }
        const j = await post('/api/hr/leave/' + id + '/' + (a === 'approve' ? 'approve' : 'decline'), { note });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        toast(a === 'approve' ? 'Approved' : 'Declined'); await load(true); if (UI.drawer) openDrawer(UI.drawer, UI.tab); return;
      }
      case 'cancel-req': { if (!confirm('Cancel this request?')) return; const j = await post('/api/hr/leave/' + id + '/cancel', {}); if (!j || !j.ok) { toast((j && j.error) || 'Could not cancel'); return; } toast('Cancelled'); await load(true); if (UI.drawer) openDrawer(UI.drawer, UI.tab); return; }
      case 'submit-req': {
        const forSel = $('rq_for'), half = $('rq_half').checked;
        const body = { type: $('rq_type').value, from: $('rq_from').value, to: half ? $('rq_from').value : $('rq_to').value, half, note: $('rq_note').value.trim() };
        if (forSel && forSel.value) { body.employee_id = +forSel.value; body.approve = $('rq_approve') && $('rq_approve').checked; }
        const j = await post('/api/hr/leave', body);
        if (!j || !j.ok) { toast((j && j.error) || 'Could not send'); return; }
        toast(body.employee_id ? (body.approve ? 'Added and approved' : 'Request added') : 'Request sent'); await load(); return;
      }
      case 'req-for': closeAll(); UI.view = 'timeoff'; render(); setTimeout(() => { const s = $('rq_for'); if (s) { s.value = id; ppSync(s); rqSummary(); } }, 30); return;
      case 'cal': { const [y, m] = calBase(); const d = new Date(y, m + (+b.dataset.n), 1); UI.calMonth = [d.getFullYear(), d.getMonth()]; render(); return; }
      case 'cal-loc': UI.calLoc = b.dataset.k; render(); return;
      case 'org-pan': { const w = document.querySelector('.org-wrap'); if (w) w.scrollBy({ left: +b.dataset.d * Math.max(240, w.clientWidth * 0.7), behavior: 'smooth' }); return; }
      case 'org-zoom': orgZoom(b.dataset.d); return;
      case 'time-tab': UI.timeTab = b.dataset.k; render(); return;
      case 'week': { const n = +b.dataset.n; UI.tsWeek = n === 0 ? mondayOf(today()) : addDays(UI.tsWeek || mondayOf(today()), n); UI.ts = null; render(); return; }
      case 'fix': openFix(id, b.dataset.d); return;
      case 'fix-punch': case 'fix-hours': case 'fix-clear': case 'void': {
        const body = { employee_id: +id, date: b.dataset.d, reason: ($('fx_r') || {}).value || '' };
        if (a === 'fix-punch') { const t = $('fx_time').value; if (!t) { toast('Pick a time'); return; } body.punch = { type: $('fx_t').value, time: t }; }
        if (a === 'fix-hours') { body.hours = $('fx_h').value; }
        if (a === 'fix-clear') body.clear = true;
        if (a === 'void') { if (!confirm('Remove this punch? It stays in the audit log.')) return; body.void_id = +b.dataset.p; }
        const j = await post('/api/hr/timesheets/fix', body);
        if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        toast('Timesheet updated'); UI.ts = null; UI.flags = null; UI.adh = null; await loadTs(); if (a === 'void') openFix(id, b.dataset.d); else closeModal(); load(true); return;
      }
      case 'ts-approve': case 'ts-all': {
        const j = await post('/api/hr/timesheets/approve', a === 'ts-all' ? { all: true, week: UI.tsWeek } : { employee_id: +id, week: UI.tsWeek });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not approve'); return; }
        toast(j.approved ? 'Approved ' + j.approved + ' timesheet' + (j.approved === 1 ? '' : 's') + (j.skipped_flagged ? ' · ' + j.skipped_flagged + ' need a fix first' : '') : 'Nothing left to approve'); UI.ts = null; loadTs(); return;
      }
      case 'ts-unapprove': { await post('/api/hr/timesheets/unapprove', { employee_id: +id, week: UI.tsWeek }); UI.ts = null; loadTs(); return; }
      case 'ts-export': {
        const r = await api('/api/hr/timesheets/export?week=' + (UI.tsWeek || mondayOf(today())), { raw: true });
        if (!r.ok) { toast('Could not export'); return; }
        const blob = await r.blob(), url = URL.createObjectURL(blob), aa = document.createElement('a');
        aa.href = url; aa.download = 'novahr-payroll-' + (UI.tsWeek || mondayOf(today())) + '.csv'; document.body.appendChild(aa); aa.click(); aa.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); return;
      }
      case 'adh-w': UI.adhWeeks = +b.dataset.n; UI.adh = null; render(); return;
      case 'adh-sort': UI.adhSort = b.dataset.k; render(); return;
      case 'skill': case 'cycle': {
        const e = emp(id), k = b.dataset.k, n = a === 'cycle' ? (((e.skills || {})[k] || 0) + 1) % 5 : +b.dataset.n;
        const j = await post('/api/hr/employees/' + id + '/skill', { k, level: n });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        e.skills = e.skills || {}; if (n) e.skills[k] = n; else delete e.skills[k];
        if (UI.drawer) drawRender(); if (UI.view === 'skills') render(); return;
      }
      case 'lang-lv': case 'lang-del': case 'lang-add': {
        const e = emp(id); let k = b.dataset.k, lv = a === 'lang-del' ? null : +b.dataset.n;
        if (a === 'lang-add') { k = $('lg_k').value; lv = +$('lg_v').value; }
        const j = await post('/api/hr/employees/' + id + '/lang', { k, level: lv });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        e.langs = e.langs || {}; if (lv == null) delete e.langs[k]; else e.langs[k] = lv;
        if (e.missing) e.missing = e.missing.filter(m => m[0] !== 'langs' || !Object.keys(e.langs).length);
        drawRender(); if (UI.view === 'skills' || UI.view === 'people') render(); return;
      }
      case 'eval': openEval(+id); return;
      case 'score': UI.evalScores[b.dataset.k] = +b.dataset.n; UI.evalRedraw(); return;
      case 'eval-save': case 'self-save': { const r = await saveEval(+id, a === 'eval-save' ? 'save' : 'self_save'); if (r) { toast('Draft saved'); closeModal(); render(); } return; }
      case 'self-submit': { const r = await saveEval(+id, 'self_submit'); if (r) { toast('Self-review sent to your manager'); closeModal(); render(); } return; }
      case 'eval-done': { const r = await saveEval(+id, 'complete'); if (r) { toast('Review complete'); render(); openReport(+id); } return; }
      case 'eval-reopen': { const j = await post('/api/hr/reviews/' + id, { action: 'reopen' }); if (j && j.ok) { S.reviews[id] = j.review; toast('Reopened'); closeModal(); render(); } else toast((j && j.error) || 'Could not reopen'); return; }
      case 'report': openReport(+id); return;
      case 'print': window.print(); return;
      case 'nudge': { const j = await post('/api/hr/reviews-remind', {}); toast(j && j.ok ? 'Reminder sent to ' + j.sent + ' of ' + j.people + ' people' : 'Could not send'); return; }
      case 'rw-tab': UI.rwTab = b.dataset.k; render(); return;
      case 'rw-week': { if (b.dataset.k === 'last') UI.rwWeek = addDays(mondayOf(today()), -7); else if (b.dataset.k === 'this') UI.rwWeek = mondayOf(today()); else UI.rwWeek = addDays(UI.rwWeek || addDays(mondayOf(today()), -7), +b.dataset.n); UI.ck = null; render(); return; }
      case 'rw-cat': {
        const r = UI.ck.rows.find(x => x.employee_id === +id); const k = b.dataset.k;
        r.cats = r.cats.indexOf(k) > -1 ? r.cats.filter(x => x !== k) : r.cats.concat([k]); ckTotal(r); render();
        post('/api/hr/checkins', { employee_id: +id, week: UI.rwWeek, cats: r.cats, note: r.note }); return;
      }
      case 'rw-send': {
        const r = UI.ck.rows.find(x => x.employee_id === +id); const el = document.querySelector('[data-rwnote="' + id + '"]'); if (el) r.note = el.value.trim();
        const j = await post('/api/hr/checkins', { employee_id: +id, week: UI.rwWeek, cats: r.cats, note: r.note, send: true });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not send'); return; }
        toast('Sent to ' + first(emp(id)) + ' · +' + j.total); UI.ck = null; load(true); return;
      }
      case 'rw-sendall': { if (!confirm('Send every remaining check-in for this week?')) return; const j = await post('/api/hr/checkins/send-all', { week: UI.rwWeek }); toast(j && j.ok ? (j.sent ? 'Sent check-ins to ' + j.sent + ' people (' + j.points + ' points)' : 'Everyone already has theirs') : 'Could not send'); UI.ck = null; load(true); return; }
      case 'award': {
        const why = $('aw_why').value.trim(); if (!why) { toast('Add a reason so the team knows why'); return; }
        const j = await post('/api/hr/shoutout', { employee_id: +$('aw_emp').value, points: +$('aw_pts').value, reason: why });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not give points'); return; }
        toast('+' + $('aw_pts').value + ' points to ' + first(emp($('aw_emp').value))); load(true); return;
      }
      case 'redeem': {
        const c = S.settings.rewards.catalog.find(x => x.k === b.dataset.k); if (!c || !confirm('Redeem ' + c.p + ' points for ' + c.n + '?')) return;
        const j = await post('/api/hr/redeem', { k: c.k }); if (!j || !j.ok) { toast((j && j.error) || 'Could not redeem'); return; }
        toast('Request sent to HR'); load(true); return;
      }
      case 'red-ok': case 'red-no': { const j = await post('/api/hr/redemptions/' + id, { status: a === 'red-ok' ? 'fulfilled' : 'rejected' }); if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; } toast(a === 'red-ok' ? 'Marked fulfilled' : 'Rejected — points returned'); load(true); return; }
      case 'pts-adjust': { const p = prompt('Points to add (negative to take away)', ''); if (p === null || !parseInt(p)) return; const why = prompt('Reason', 'Adjustment'); const j = await post('/api/hr/points-adjust', { employee_id: +id, points: parseInt(p), reason: why }); if (j && j.ok) { toast('Points adjusted'); await load(true); openDrawer(id, 'review'); } return; }
      case 'adjust': {
        const e = emp(id), bal = (UI.detail && UI.detail.balances) || [];
        openModal('<div class="box-h"><h2>Adjust ' + esc(first(e)) + '\'s balances · ' + today().slice(0, 4) + '</h2><button class="btn ghost x" data-act="close-modal">' + I.x + '</button></div><div class="box-b"><p class="muted" style="margin-top:0">Blank = the company rule. "Used before NovaHR" counts days taken this year before NovaHR started.</p><table><thead><tr><th>Type</th><th>Own allowance</th><th>Carried over</th><th>Used before NovaHR</th></tr></thead><tbody>' +
          bal.filter(x => x.track).map(x => '<tr data-type="' + x.k + '"><td><b>' + esc(x.n) + '</b><div class="muted" style="font-size:11px">rule: ' + ((leaveType(x.k).allow || {})[e.location] || 0) + ' days</div></td><td><input class="input num" type="number" step="0.5" style="width:90px" data-adj="allowance" value="' + (x.override == null ? '' : x.override) + '"></td><td><input class="input num" type="number" step="0.5" style="width:90px" data-adj="carried" value="' + (x.carried || '') + '"></td><td><input class="input num" type="number" step="0.5" style="width:90px" data-adj="used_before" value="' + (x.used_before || '') + '"></td></tr>').join('') +
          '</tbody></table></div><div class="box-f"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="adjust-save" data-id="' + id + '">Save</button></div>');
        return;
      }
      case 'adjust-save': {
        for (const tr of document.querySelectorAll('#modalBox tr[data-type]')) { const v = (k) => tr.querySelector('[data-adj="' + k + '"]').value; await post('/api/hr/leave-adjust', { employee_id: +id, type: tr.dataset.type, allowance: v('allowance'), carried: v('carried'), used_before: v('used_before') }); }
        toast('Balances saved'); closeModal(); await load(true); openDrawer(id, 'timeoff'); return;
      }
      case 'pin': pinModal(+id); return;
      case 'pin-save': savePin(+id, false); return;
      case 'pin-gen': savePin(+id, true); return;
      case 'pin-clear': { if (!confirm('Clear this PIN? They can\'t use the time clock until a new one is set.')) return; const j = await post('/api/hr/employees/' + id + '/pin', { clear: true }); if (j && j.ok) { emp(id).has_pin = false; toast('PIN cleared'); drawRender(); } return; }
      case 'badge-one': printBadges([+id]); return;
      case 'badge-reissue': { if (!confirm('Make a new badge? The old one stops working right away.')) return; const j = await post('/api/hr/employees/' + id + '/badge-reissue', {}); if (j && j.ok) { emp(id).badge_ver = j.ver; toast('New badge made — print it'); drawRender(); printBadges([+id]); } return; }
      case 'badges': badgePicker(); return;
      case 'bp-all': document.querySelectorAll('#bpList input').forEach(i => { i.checked = b.dataset.n === '1'; }); return;
      case 'bp-dept': { const d = $('bp_dept').value; document.querySelectorAll('#bpList input').forEach(i => { if (i.dataset.dept === d) i.checked = true; }); return; }
      case 'bp-go': { const ids = Array.from(document.querySelectorAll('#bpList input:checked')).map(i => +i.value); if (!ids.length) { toast('Tick at least one person'); return; } printBadges(ids); return; }
      case 'add': openAdd(); return;
      case 'add-mode': addMode(b.dataset.k); return;
      case 'add-crm': { b.disabled = true; const j = await post('/api/hr/employees', { crm_user_id: +id }); if (!j || !j.ok) { toast((j && j.error) || 'Could not add'); b.disabled = false; return; } b.textContent = 'Added'; toast('Added to NovaHR'); load(true); return; }
      case 'add-save': {
        const name = $('n_name').value.trim(); if (!name) { toast('Enter a name'); return; }
        const j = await post('/api/hr/employees', { name, title: $('n_title').value, department_id: $('n_dept').value, location: $('n_loc').value, work_email: $('n_email').value, hire_date: $('n_hire').value, pay_rate: $('n_rate').value });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not add'); return; }
        closeModal(); toast(name + ' added'); await load(); openDrawer(j.id); return;
      }
      case 'doc-open': {
        const r = await api('/api/hr/docs/' + id, { raw: true }); if (!r.ok) { toast('Could not open'); return; }
        const url = URL.createObjectURL(await r.blob()); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000); return;
      }
      case 'doc-del': { if (!confirm('Remove this file?')) return; await post('/api/hr/docs/' + id + '/delete', {}); toast('Removed'); openDrawer(UI.drawer, 'docs'); return; }
      case 'org-toggle': UI.orgOpen[id] = !UI.orgOpen[id]; render(); return;
      case 'org-all': S.org.depts.forEach(d => d.teams.forEach(t => { UI.orgOpen[t.id] = b.dataset.n === '1'; })); render(); return;
      case 'org-adddept': orgModal('dept'); return;
      case 'org-editdept': orgModal('dept', +id); return;
      case 'org-addteam': orgModal('team', null, +(b.dataset.d || 0) || (S.org.depts[0] || {}).id); return;
      case 'org-editteam': orgModal('team', +id); return;
      case 'org-addp': orgModal('person', +id); return;
      case 'org-save-dept': case 'org-save-team': {
        const name = $('o_name').value.trim(); if (!name) { toast('Enter a name'); return; }
        const heads = Array.from(document.querySelectorAll('#o_heads input:checked')).map(i => ({ employee_id: +i.value }));
        const j = a === 'org-save-dept' ? await post('/api/hr/org/dept', { id: id || undefined, name, color: (document.querySelector('input[name="o_c"]:checked') || {}).value, heads }) : await post('/api/hr/org/team', { id: id || undefined, name, department_id: +$('o_dept').value, leads: heads });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        if (a === 'org-save-team') UI.orgOpen[j.id] = true; closeModal(); toast('Saved'); load(); return;
      }
      case 'org-save-person': { const e = +$('o_emp').value; if (!e) { toast('Pick a person'); return; } const j = await post('/api/hr/org/team/' + id + '/person', { employee_id: e, title: $('o_role').value }); if (j && j.ok) { closeModal(); toast('Added'); load(); } return; }
      case 'org-rmp': { if (!confirm('Remove ' + b.dataset.n + ' from this team?')) return; await post('/api/hr/org/team/' + b.dataset.t + '/person', { remove: true, employee_id: b.dataset.e ? +b.dataset.e : null, name: b.dataset.n }); load(); return; }
      case 'org-del': { if (!confirm('Remove this ' + (b.dataset.kind === 'dept' ? 'department' : 'team') + ' from the tree?')) return; const j = await post('/api/hr/org/' + b.dataset.kind + '/' + id + '/delete', {}); if (!j || !j.ok) { toast((j && j.error) || 'Could not remove'); return; } closeModal(); load(); return; }
      case 'org-reset': { if (!confirm('Re-read the departments and teams from the CRM? Edits made in NovaHR are dropped (departments / teams added here stay).')) return; const j = await post('/api/hr/org/reset', {}); toast(j && j.ok ? 'Tree synced from the CRM' : 'Could not sync'); load(); return; }
      case 'sync': { b.disabled = true; const j = await post('/api/hr/sync', {}); toast(j && j.ok ? 'Synced: ' + (j.updated || 0) + ' updated, ' + (j.inactive || 0) + ' made inactive' : 'Sync failed: ' + ((j && j.error) || '')); load(); return; }
      case 'set-tab': UI.setTab = b.dataset.k; if (b.dataset.k === 'audit') UI.audit = null; render(); return;
      case 'audit-reload': UI.audit = null; render(); return;
      case 'set-save': {
        const k = b.dataset.k; const val = UI.draft[k] || S.settings[k];
        const j = await post('/api/hr/settings/' + k, { value: val }); if (!j || !j.ok) { toast((j && j.error) || 'Could not save'); return; }
        S.settings[k] = j.value; delete UI.draft[k]; if (UI.dirty) delete UI.dirty[k]; toast('Saved'); render(); return;
      }
      case 'set-reset': delete UI.draft[b.dataset.k]; if (UI.dirty) delete UI.dirty[b.dataset.k]; render(); return;
      case 'hol-loc': UI.holLoc = b.dataset.k; render(); return;
      case 'hol-add': { const j = await post('/api/hr/holidays', { date: $('h_d').value, name: $('h_n').value, location: $('h_l').value }); if (!j || !j.ok) { toast((j && j.error) || 'Could not add'); return; } toast('Holiday added'); load(); return; }
      case 'hol-del': { const j = await post('/api/hr/holidays', { delete: +id }); if (j && j.ok) { toast('Removed'); load(); } return; }
      case 'pol-addtype': dirty('leave_types').push({ k: 't' + Date.now().toString(36), n: 'New type', paid: true, track: false, on: true, allow: { gl: 0, am: 0, mx: 0, ph: 0 }, accrual: 'As needed', carry: 0, notice: 0 }); render(); return;
      case 'pol-addcat': dirty('rewards').cats.push({ k: 'c' + Date.now().toString(36), n: 'New category', p: 10 }); render(); return;
      case 'pol-delcat': dirty('rewards').cats.splice(+b.dataset.i, 1); render(); return;
      case 'pol-addcatalog': dirty('rewards').catalog.push({ k: 'r' + Date.now().toString(36), n: 'New reward', p: 200 }); render(); return;
      case 'pol-delcatalog': dirty('rewards').catalog.splice(+b.dataset.i, 1); render(); return;
      case 'rev-addarea': dirty('review').areas.push({ k: 'a' + Date.now().toString(36), n: 'New area', d: '' }); render(); return;
      case 'rev-delarea': dirty('review').areas.splice(+b.dataset.i, 1); render(); return;
      case 'sk-add': { const n = $('sk_n').value.trim(), g = $('sk_g').value.trim() || 'Other'; if (!n) { toast('Name the skill'); return; } dirty('skills').push({ k: 's' + Date.now().toString(36), n, g }); render(); toast('Added — press Save'); return; }
      case 'sk-del': { const sk = draft('skills')[+b.dataset.i]; const c = S.employees.filter(e => (e.skills || {})[sk.k]).length; if (c && !confirm(c + ' people have a level for ' + sk.n + '. Remove it anyway (after Save)?')) return; dirty('skills').splice(+b.dataset.i, 1); render(); return; }
      case 'lang-new': { const n = $('lg_new').value.trim(); if (!n) { toast('Type a language'); return; } const L = dirty('languages'); if (L.list.some(l => l.n.toLowerCase() === n.toLowerCase())) { toast(n + ' is already on the list'); return; } L.list.push({ k: 'l' + Date.now().toString(36), n }); render(); return; }
      case 'lang-rm': { const L = dirty('languages'), l = L.list[+b.dataset.i]; const c = S.employees.filter(e => (e.langs || {}).hasOwnProperty(l.k)).length; if (c && !confirm(c + ' people list ' + l.n + '. Remove it anyway (after Save)?')) return; L.list.splice(+b.dataset.i, 1); render(); return; }
      case 'kiosk-new': {
        const name = prompt('Name this time clock (e.g. Front door tablet)', 'Front door'); if (!name) return;
        const loc = prompt('Which location? gl = Glendale, am, mx, ph', 'gl') || 'gl';
        const j = await post('/api/hr/kiosks', { name, location: loc.trim().toLowerCase() });
        if (!j || !j.ok) { toast((j && j.error) || 'Could not make it'); return; }
        try { localStorage.setItem('hr_kiosk_token', j.token); localStorage.setItem('hr_kiosk_name', name); } catch (e) {}
        UI.kiosks = null; render(); if (confirm('This browser is now the time clock "' + name + '". Open it now?')) location.href = '/hr/kiosk'; return;
      }
      case 'kiosk-off': { if (!confirm('Switch off this time clock? It stops working at once.')) return; await post('/api/hr/kiosks/' + id + '/revoke', {}); UI.kiosks = null; render(); return; }
    }
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    if (b.id === 'scrim') { closeAll(); return; }
    if (b.tagName === 'LABEL' || b.disabled) return;
    act(b.dataset.act, b, ev).catch(e => toast(e.message || 'Something went wrong'));
  });
  $('modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(); });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    const keepFocus = (sel) => { const pos = t.selectionStart; render(); const n = document.querySelector(sel); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } };
    if (t.dataset.in === 'q') { UI.q = t.value; keepFocus('[data-in="q"]'); }
    if (t.dataset.in === 'orgq') { UI.orgq = t.value; keepFocus('[data-in="orgq"]'); }
    if (t.dataset.in === 'skq') { UI.skQ = t.value; keepFocus('[data-in="skq"]'); }
    if (t.dataset.in === 'crmq') { const q = t.value.toLowerCase(); document.querySelectorAll('#crmList .li').forEach(li => { li.style.display = li.dataset.name.indexOf(q) > -1 ? '' : 'none'; }); }
    if (t.dataset.sp && t.type !== 'checkbox' && t.tagName !== 'SELECT') { const d = dirty(t.dataset.sp); setPath(d, t.dataset.p, t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value); }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.in === 'dept') { UI.dept = t.value; render(); }
    if (t.dataset.in === 'cover') { UI.cover = t.value; render(); }
    if (t.dataset.in === 'skdept') { UI.skDept = t.value; render(); }
    if (t.dataset.in === 'rq') rqSummary();
    if (t.dataset.sp) {
      const d = dirty(t.dataset.sp);
      const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : (t.tagName === 'SELECT' && /^\d+$/.test(t.value) ? +t.value : t.value);
      setPath(d, t.dataset.p, v);
      if (t.type === 'checkbox' || t.tagName === 'SELECT') render();
    }
    if (t.dataset.rwnote && UI.ck) { const r = UI.ck.rows.find(x => x.employee_id === +t.dataset.rwnote); if (r && !r.sent_at) { r.note = t.value; post('/api/hr/checkins', { employee_id: r.employee_id, week: UI.rwWeek, cats: r.cats, note: r.note }); } }
    if (t.dataset.photo && t.files && t.files[0]) readPhoto(t.files[0]).then(async url => { const j = await post('/api/hr/employees/' + t.dataset.photo + '/photo', { photo: url }); if (!j || !j.ok) { toast((j && j.error) || 'Could not save the photo'); return; } toast('Photo updated'); await load(true); openDrawer(+t.dataset.photo, 'overview'); }).catch(() => toast('That file could not be read as an image'));
    if (t.dataset.doc && t.files && t.files[0]) {
      const f = t.files[0]; if (f.size > 25 * 1024 * 1024) { toast('Up to 25 MB'); return; }
      api('/api/hr/employees/' + t.dataset.doc + '/docs', { method: 'POST', body: f, headers: { 'X-File-Name': encodeURIComponent(f.name), 'X-Doc-Kind': encodeURIComponent(t.dataset.kind || ''), 'Content-Type': 'application/octet-stream' } }).then(j => { if (!j || !j.ok) { toast((j && j.error) || 'Could not upload'); return; } toast('Uploaded'); openDrawer(+t.dataset.doc, 'docs'); });
    }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { if ($('modal').classList.contains('on')) closeModal(); else closeAll(); } if (ev.key === 'Enter' && ev.target.id === 'pin_in') { const btn = document.querySelector('[data-act="pin-save"]'); if (btn) btn.click(); } });
  function readPhoto(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const img = new Image(); img.onload = () => { const s = 240, c = document.createElement('canvas'); c.width = c.height = s; const k = Math.max(s / img.width, s / img.height), w = img.width * k, h = img.height * k; c.getContext('2d').drawImage(img, (s - w) / 2, (s - h) / 2, w, h); res(c.toDataURL('image/jpeg', 0.84)); }; img.onerror = rej; img.src = r.result; }; r.onerror = rej; r.readAsDataURL(file); });
  }
  setInterval(() => { const lc = $('liveClock'); if (lc) lc.textContent = hrsLabel(myWorked()); }, 1000);
  setInterval(() => { if (document.hidden || $('modal').classList.contains('on') || UI.editing) return; if (UI.view === 'today') { UI.myWeek = null; UI.flags = null; load(true); } }, 90000);
  load();
})();
