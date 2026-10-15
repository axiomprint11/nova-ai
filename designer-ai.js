// Designer AI — the tools around the design team. 1.20.13: the AutoAssign Jobs tab: the jobs sitting with the
// "PrePress 1 Tier 1" / "PrePress Tier 2" placeholder users in the CRM, the designers with their faces, load and
// strong sides, and a matcher that says who should take a job. Nothing is written to the CRM — an assignment made here
// is kept in SQLite (da_assign) until the CRM gets an endpoint for it. "Template Designer" and "Online Designer" are
// placeholders for later.
'use strict';

module.exports = function mountDesignerAi(app, deps) {
  const { db, auth, adminOnly, serveVersionedHtml, runQuery, anthropic, model, sendMail } = deps;
  const dbAll = (sql, p) => new Promise((res, rej) => db.all(sql, p || [], (e, r) => e ? rej(e) : res(r || [])));
  const dbGet = (sql, p) => new Promise((res, rej) => db.get(sql, p || [], (e, r) => e ? rej(e) : res(r)));
  const dbRun = (sql, p) => new Promise((res, rej) => db.run(sql, p || [], function (e) { e ? rej(e) : res(this); }));
  const nowIso = () => new Date().toISOString();
  const userId = (req) => (req.user && (req.user.key || req.user.username || req.user.email)) || 'unknown';
  const errlog = (w, m) => console.error('[designer-ai] ' + w + ': ' + m);

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS da_designers (user_id INTEGER PRIMARY KEY, name TEXT, last_name TEXT, photo TEXT, title TEXT, active INTEGER DEFAULT 1,
      skills TEXT, notes TEXT, max_active INTEGER DEFAULT 25, tier2 INTEGER DEFAULT 0, updated_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS da_assign (id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER, user_id INTEGER, score INTEGER, reason TEXT, picked_by TEXT, at TEXT, status TEXT DEFAULT 'assigned')`);
    db.run('CREATE INDEX IF NOT EXISTS da_assign_est ON da_assign(estimate_id)');
    db.run('CREATE TABLE IF NOT EXISTS da_settings (key TEXT PRIMARY KEY, value TEXT, updated_by TEXT, updated_at TEXT)');   // 1.20.18: match_logic — the owner's rules in words
    // 1.20.17: how hard / how creative a job a designer can take (0–10), and their hours (until the hours table exists)
    ['hard_level INTEGER DEFAULT 5', 'creative_level INTEGER DEFAULT 5', 'shift_start TEXT', 'shift_end TEXT', 'work_days TEXT', 'comm_level INTEGER DEFAULT 5', 'languages TEXT'].forEach(c => db.run('ALTER TABLE da_designers ADD COLUMN ' + c, () => {}));
  });

  // the placeholder users the CRM parks a job on until a designer takes it
  const TIER_USERS = { 1: 239, 2: 331 };
  // the design team (CRM user ids) — seeded once; faces, titles and names are re-read from the CRM on every list
  const TEAM = [437, 277, 365, 326, 329, 416, 417, 219, 232];   // Ani Muradyan, Alex Vradiy, George Abrahamyan, Max Mazmanyan, Edgar Papoyan, Fernando Lira, Rodrigo Garcia, Jelly Ace Pamatin, Greg Belarmino
  const staffPhoto = (ph) => !ph ? null : /^https?:\/\//.test(ph) ? ph : 'https://axiomprint.s3.us-west-1.amazonaws.com/MemberImages/' + String(ph).replace(/^\/+/, '');

  async function syncTeam() {
    if (!runQuery) return;
    const rows = await runQuery('SELECT id, name, last_name, title, memberimage, status FROM user WHERE id IN (' + TEAM.join(',') + ')');
    for (const r of rows) {
      await dbRun('INSERT INTO da_designers (user_id, name, last_name, photo, title, active, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, last_name = excluded.last_name, photo = excluded.photo, title = excluded.title',
        [r.id, r.name, r.last_name, staffPhoto(r.memberimage), r.title || '', r.status === 10 ? 1 : 0, nowIso()]);
    }
  }
  let teamAt = 0;
  // 1.20.33: `estimate.created` has no index, so "created >= 180 days ago" scans the whole table (EXPLAIN: type ALL,
  // 167k rows). Estimate ids are monotonic: an id floor per window turns it into a PRIMARY range scan. One MIN() per
  // window per hour.
  const floors = {};
  async function idFloor(days) {
    const f = floors[days]; if (f && Date.now() - f.at < 3600e3) return f.id;
    const r = await runQuery('SELECT MIN(id) id FROM estimate WHERE created >= DATE_SUB(NOW(), INTERVAL ' + parseInt(days) + ' DAY)');
    const id = (r[0] && Number(r[0].id)) || 0; floors[days] = { id, at: Date.now() }; return id;
  }
  // 1.20.31: the four CRM load queries are cached for 45 s — a Match read them twice (scoring + the model's profiles)
  let teamCache = null, teamCacheAt = 0;
  const dropTeamCache = () => { teamCache = null; };
  async function designers() {
    if (teamCache && Date.now() - teamCacheAt < 45000) return teamCache;
    const out = await designersFresh(); teamCache = out; teamCacheAt = Date.now(); return out;
  }
  async function designersFresh() {
    if (Date.now() - teamAt > 10 * 60000) { try { await syncTeam(); teamAt = Date.now(); } catch (e) { errlog('team sync', e.message); } }
    const rows = await dbAll('SELECT * FROM da_designers ORDER BY name');
    // the live load: jobs in the prepress stage assigned to each designer (not canceled), and what they finished in 30 days
    let load = {}, waiting = {}, done = {}, done90 = {};
    try {
      // 1.20.16: "active" is what the CRM board counts — proof_checking (and a rejected-edits round) on the designer's desk;
      // proof_sent / rejected_reupload sit with the customer and are shown apart as "waiting on client"
      (await runQuery("SELECT m.user_id, COUNT(DISTINCT CASE WHEN e.prepress_status IN ('proof_checking', 'rejected_edits', 'insta_proof_manual') THEN e.id END) n, COUNT(DISTINCT CASE WHEN e.prepress_status IN ('proof_sent', 'rejected_reupload', 'waiting_files', 'upload_files') THEN e.id END) w FROM estimate_stage s JOIN estimate e ON e.id = s.estimate_id JOIN estimate_team_members m ON m.estimate_id = e.id AND m.user_id IN (" + TEAM.join(',') + ") WHERE s.estimate_stage = 'prepress' AND s.estimate_substage <> 'canceled' AND e.estimate_invoiceid > 0 GROUP BY m.user_id")).forEach(r => { load[r.user_id] = Number(r.n) || 0; waiting[r.user_id] = Number(r.w) || 0; });
      (await runQuery("SELECT m.user_id, COUNT(DISTINCT CASE WHEN e.created >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN e.id END) n, COUNT(DISTINCT e.id) n90 FROM estimate_team_members m JOIN estimate e ON e.id = m.estimate_id WHERE m.user_id IN (" + TEAM.join(',') + ") AND e.id >= " + (await idFloor(90)) + " AND e.prepress_status = 'approved' AND e.created >= DATE_SUB(NOW(), INTERVAL 90 DAY) GROUP BY m.user_id")).forEach(r => { done[r.user_id] = Number(r.n); done90[r.user_id] = Number(r.n90); });
    } catch (e) { errlog('load', e.message); }
    const nova = {}; (await dbAll("SELECT user_id, COUNT(*) n FROM da_assign WHERE status = 'assigned' AND at >= datetime('now', '-14 days') GROUP BY user_id")).forEach(r => { nova[r.user_id] = r.n; });
    let total = {}; try { (await runQuery("SELECT m.user_id, COUNT(DISTINCT m.estimate_id) n FROM estimate_team_members m JOIN estimate e ON e.id = m.estimate_id WHERE m.user_id IN (" + TEAM.join(',') + ") AND e.id >= " + (await idFloor(180)) + " AND e.created >= DATE_SUB(NOW(), INTERVAL 180 DAY) GROUP BY m.user_id")).forEach(r => { total[r.user_id] = Number(r.n); }); } catch (e) {}
    return rows.map(r => Object.assign({}, r, { skills: r.skills || '', skill_list: skillList(r.skills), hard_level: r.hard_level == null ? 5 : r.hard_level, creative_level: r.creative_level == null ? 5 : r.creative_level, comm_level: r.comm_level == null ? 5 : r.comm_level, languages: r.languages || '', language_list: String(r.languages || '').split(',').map(x => x.trim()).map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).filter(Boolean), active_jobs: load[r.user_id] || 0, waiting_client: waiting[r.user_id] || 0, done_30: done[r.user_id] || 0, done_90: done90[r.user_id] || 0, nova_assigned: nova[r.user_id] || 0, jobs_180: total[r.user_id] || 0, is_new: (total[r.user_id] || 0) < 60, on_shift: onShift(r) }));
  }
  const skillList = (s) => String(s || '').split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean);

  // ---- the queue: jobs parked on a tier placeholder, in the prepress stage
  const PROOF_LABEL = { proof_checking: 'Proof Checking', insta_proofed: 'Insta Proofed', proof_sent: 'Proof Sent', upload_files: 'Upload Files', waiting_files: 'Waiting for Files', rejected_edits: 'Rejected — edits', rejected_reupload: 'Rejected — re-upload', approved: 'Approved', hard_copy_approved: 'Hard copy approved', insta_proof_manual: 'Insta Proof Manual' };
  // "id|name|last|photo;;…" → [{user_id, name, last_name, photo}] (1.20.20: the Team on it cell shows faces)
  const teamOf = (s) => !s ? [] : String(s).split(';;').map(x => { const [id, name, last, ph] = x.split('|'); return { user_id: Number(id), name: name || '', last_name: last || '', photo: staffPhoto(ph) }; }).filter(t => t.user_id);
  async function queue(tier, all, onlyId) {
    const tu = TIER_USERS[tier] || TIER_USERS[1]; const f180 = await idFloor(180);
    const rows = await runQuery(
      "SELECT e.id, e.estimate_name, e.created, e.complete_by, e.prepress_status, e.estimate_invoiceid inv, e.estimate_productid product_id, e.design_price, e.prepress_notes, e.prepress_internal_notes, p.title product, p.image product_image, pc.title category, pc.id category_id, " +
      "s.estimate_stage stage, s.estimate_substage substage, s.stage_in_date, c.company_name, c.name cname, c.last_name clname, " +
      "(SELECT GROUP_CONCAT(DISTINCT CONCAT_WS('|', u.id, u.name, IFNULL(u.last_name, ''), IFNULL(u.memberimage, '')) ORDER BY u.name SEPARATOR ';;') FROM estimate_team_members m2 JOIN user u ON u.id = m2.user_id WHERE m2.estimate_id = e.id AND m2.user_id NOT IN (239, 331)) others, " +
      "(SELECT GROUP_CONCAT(DISTINCT m3.user_id) FROM estimate_team_members m3 WHERE m3.estimate_id = e.id AND m3.user_id IN (" + TEAM.join(',') + ")) designer_ids, " +
      "(SELECT dd.design_type FROM estimate_design_details dd WHERE dd.estimate_id = e.id AND dd.design_type LIKE '%Proof%' ORDER BY dd.id DESC LIMIT 1) proof_type, " +
      "(SELECT dd.design_type FROM estimate_design_details dd WHERE dd.estimate_id = e.id AND dd.design_type NOT LIKE '%Proof%' ORDER BY dd.id DESC LIMIT 1) files_type, " +
      "(SELECT dd.service_type FROM estimate_design_details dd WHERE dd.estimate_id = e.id AND dd.service_type IS NOT NULL ORDER BY dd.id DESC LIMIT 1) service, " +
      "(SELECT dd.notes FROM estimate_design_details dd WHERE dd.estimate_id = e.id AND dd.notes IS NOT NULL AND dd.notes <> '' ORDER BY dd.id DESC LIMIT 1) design_notes, " +
      "(SELECT COUNT(*) FROM estimate e2 WHERE e2.estimate_productid = e.estimate_productid AND e2.id >= " + f180 + " AND e2.created >= DATE_SUB(NOW(), INTERVAL 180 DAY)) product_180 " +
      "FROM estimate e JOIN estimate_team_members m ON m.estimate_id = e.id AND m.user_id = " + tu + " JOIN estimate_stage s ON s.estimate_id = e.id " +
      "LEFT JOIN product p ON p.id = e.estimate_productid LEFT JOIN productcategory pc ON pc.id = p.product_category_id LEFT JOIN customer c ON c.id = e.estimate_clientid " +
      "WHERE s.estimate_stage = 'prepress' AND s.estimate_substage <> 'canceled'" + (all ? '' : ' AND e.estimate_invoiceid > 0') + (onlyId ? ' AND e.id = ' + parseInt(onlyId) : '') + " ORDER BY e.created DESC LIMIT 300");
    const ids = rows.map(r => r.id);
    const mine = {}, busy = {}; if (ids.length) (await dbAll('SELECT estimate_id, user_id, score, reason, at, picked_by, status FROM da_assign WHERE status IN (\'assigned\', \'busy\') AND estimate_id IN (' + ids.map(() => '?').join(',') + ')', ids)).forEach(r => { if (r.status === 'busy') busy[r.estimate_id] = r; else mine[r.estimate_id] = r; });
    return rows.map(r => ({
      id: r.id, e: 'E' + r.id, name: r.estimate_name || '', created: r.created, complete_by: r.complete_by, invoiced: Number(r.inv) > 0, inv: r.inv,
      product_id: r.product_id, product: r.product || '', product_image: r.product_image || null, category: r.category || '', stage: r.stage, substage: r.substage, stage_in: r.stage_in_date,
      status: r.prepress_status, status_label: PROOF_LABEL[r.prepress_status] || r.prepress_status || '', proof_type: r.proof_type || (r.substage === 'tier_2' ? 'Tier 2' : r.substage === 'tier_1' ? 'Tier 1' : ''), files_type: r.files_type || '', service: r.service || '',
      tier, customer: r.company_name || [r.cname, r.clname].filter(Boolean).join(' ') || '', others: teamOf(r.others).map(t => t.name).join(', '), team: teamOf(r.others), designer_ids: r.designer_ids ? String(r.designer_ids).split(',').map(Number) : [],
      design_fee: Number(r.design_price) || 0, notes: [r.design_notes, r.prepress_notes, r.prepress_internal_notes].filter(Boolean).join('\n').slice(0, 1200), product_180: Number(r.product_180) || 0, category_id: r.category_id,
      nova: mine[r.id] || null, busy: busy[r.id] ? { at: busy[r.id].at, reason: busy[r.id].reason } : null
    })).map(j => Object.assign(j, { hard: jobHard(j), creative: jobCreative(j), common: j.product_180 >= 40 }));
  }
  // 1.20.17: how hard and how creative a job is, 0–10 — from the category, the proof tier, the design fee and the notes
  const HARD_BY_CAT = { 'Folding Cartons': 8, 'Rigid Boxes': 9, 'Corrugated Boxes': 8, 'Sleeves and Inserts': 7, 'Catalogs & Books': 7, 'Trade Show Displays': 6, 'Standing Displays': 6, 'Custom': 8, 'Services': 7, 'Roll Labels': 5, 'Adhesive Products': 5, 'Stickers on Sheet': 4, 'Individual Stickers': 4, 'Rigid Boards': 4, 'Signs': 4, 'Real Estate Signs': 3, 'Banners / Posters': 3, 'Banner Stands': 3, 'Flags': 4, 'Standard Business Cards': 2, 'Luxury Business Cards': 4, 'Plastic Business Cards': 3, 'Special Shape Business Cards': 6, 'Marketing Materials': 3, 'Brochures / Flyers': 3, 'Menus': 4, 'Invitations': 5, 'Event & Invitations': 5, 'Calendars': 5, 'Promo Products': 4, 'Wall Art': 5, 'Mailing & EDDM': 4, 'Holders / Folders': 5 };
  function jobHard(j) {
    let h = HARD_BY_CAT[j.category] != null ? HARD_BY_CAT[j.category] : 5;
    const t = (j.product + ' ' + j.name).toLowerCase();
    if (/die ?cut|custom shape|cutout|contour/.test(t)) h += 2;
    if (/wrap|vehicle|van|fleet/.test(t)) h += 3;
    if (/variable|vdp|numbering/.test(t)) h += 1;
    if (j.tier === 2 || /tier ?2/i.test(j.proof_type || '')) h += 2;
    if (j.service === 'expedite') h += 1;
    return Math.max(0, Math.min(10, h));
  }
  function jobCreative(j) {
    let c = 1;
    if (j.design_fee > 0) c = 5 + Math.min(4, Math.round(j.design_fee / 50));
    if (/Work with Our Designers/i.test(j.files_type || '')) c = Math.max(c, 7);
    if (/design|create|layout|mock ?up|logo|artwork from scratch|make it look/i.test(j.notes || '')) c += 1;
    if (/Print Ready|Use Existing Files/i.test(j.files_type || '') && j.design_fee === 0) c = Math.min(c, 2);
    return Math.max(0, Math.min(10, c));
  }
  // 1.20.21: client communication (0–10) and the languages a designer speaks — a job that needs talking to the client
  // ("Work with Our Designers", a design fee, notes) favours the communicators; a language named in the job's notes /
  // customer name favours a speaker of it
  const LANGS = ['English', 'Armenian', 'Russian', 'Spanish', 'Filipino', 'Mandarin'];
  const LANG_HINT = { Armenian: /\barmenian\b|\bhayeren\b|[\u0530-\u058F]/i, Russian: /\brussian\b|[\u0400-\u04FF]/i, Spanish: /\bspanish\b|\bespa[nñ]ol\b|\bhabla\b/i, Filipino: /\bfilipino\b|\btagalog\b/i, Mandarin: /\bmandarin\b|\bchinese\b|[\u4E00-\u9FFF]/i };
  const jobLangs = (job) => { const txt = [job.notes, job.name, job.customer].filter(Boolean).join(' '); return LANGS.filter(l => LANG_HINT[l] && LANG_HINT[l].test(txt)); };
  // 1.20.17: the designer's hours — "09:00".."14:00" on work_days (1–7, Mon=1), Los Angeles time; until the hours table exists
  const laNow = () => { const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }); const o = {}; f.formatToParts(new Date()).forEach(x => { o[x.type] = x.value; }); return { min: Number(o.hour) * 60 + Number(o.minute), day: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[o.weekday] || 1 }; };
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const fmtT = (t) => { const m = toMin(t); if (m == null) return ''; const h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM'); };
  function onShift(d) {
    const st = toMin(d.shift_start), en = toMin(d.shift_end); if (st == null || en == null) return { known: false };
    const now = laNow(); const days = String(d.work_days || '1,2,3,4,5').split(',').map(Number);
    if (days.indexOf(now.day) < 0) return { known: true, on: false, why: 'day off' };
    if (now.min < st) return { known: true, on: false, why: 'starts at ' + fmtT(d.shift_start) };
    if (now.min >= en) return { known: true, on: false, why: 'left at ' + fmtT(d.shift_end) };
    return { known: true, on: true, left: en - now.min, ends: fmtT(d.shift_end) };
  }

  // ---- the matcher: who should take this job
  //   history  — the designer did this product (5 a job, up to 30) or this category (2 a job, up to 15) in the last 180 days
  //   skills   — the strong sides typed on the designer card found in the product / category / proof type (12 each, up to 36)
  //   tier 2   — a Tier 2 job wants a designer marked Tier 2 (+15), one not marked loses 20
  //   load     — every job above the lightest designer's load costs 3 (up to 30); at or over "max active" costs 40
  //   fairness — a Nova pick in the last 2 hours costs 4 a pick, so the queue spreads
  const WORDS = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').split(' ').filter(w => w.length >= 3);
  async function match(job) {
    const team = (await designers()).filter(d => d.active);
    let hist = {};
    try {
      const h = await runQuery("SELECT m.user_id, SUM(e.estimate_productid = " + (parseInt(job.product_id) || 0) + ") same_product, SUM(p.product_category_id = (SELECT product_category_id FROM product WHERE id = " + (parseInt(job.product_id) || 0) + ")) same_cat FROM estimate_team_members m JOIN estimate e ON e.id = m.estimate_id LEFT JOIN product p ON p.id = e.estimate_productid WHERE m.user_id IN (" + TEAM.join(',') + ") AND e.id >= " + (await idFloor(180)) + " AND e.created >= DATE_SUB(NOW(), INTERVAL 180 DAY) GROUP BY m.user_id");
      h.forEach(r => { hist[r.user_id] = { product: Number(r.same_product) || 0, cat: Number(r.same_cat) || 0 }; });
    } catch (e) { errlog('history', e.message); }
    const recent = {}; (await dbAll("SELECT user_id, COUNT(*) n FROM da_assign WHERE status = 'assigned' AND at >= datetime('now', '-2 hours') GROUP BY user_id")).forEach(r => { recent[r.user_id] = r.n; });
    const minLoad = team.length ? Math.min(...team.map(d => d.active_jobs)) : 0;
    const langs = jobLangs(job);
    const jobText = [job.product, job.category, job.proof_type, job.name, job.files_type].join(' ').toLowerCase();
    const isT2 = /tier ?2|tier_2/i.test(job.proof_type + ' ' + job.substage);
    // 1.20.17: every reason carries its points, so the pick can be read: "did 39 × Classic Business Cards (+30) · 2 active jobs (−3)"
    const pts = (n) => ' (' + (n > 0 ? '+' : '') + n + ')';
    const out = team.map(d => {
      let score = 50; const why = [];
      const add = (n, text) => { score += n; why.push(text + (n ? pts(n) : '')); };
      const h = hist[d.user_id] || { product: 0, cat: 0 };
      if (h.product) add(Math.min(30, h.product * 5), 'did ' + h.product + ' × ' + (job.product || 'this product') + ' in 180 days');
      else if (h.cat) add(Math.min(15, h.cat * 2), h.cat + ' ' + (job.category || 'same category') + ' jobs in 180 days');
      const hits = d.skill_list.filter(sk => sk && jobText.indexOf(sk) > -1);
      if (hits.length) add(Math.min(36, hits.length * 12), 'strong side: ' + hits.join(', '));
      if (isT2) { if (d.tier2) add(15, 'Tier 2 designer'); else add(-20, 'not marked Tier 2'); }
      // how hard the job is against what they can take (0–10): each point over their level costs 6
      const hardOver = job.hard - d.hard_level;
      if (hardOver > 0) add(-Math.min(40, hardOver * 6), 'job hardness ' + job.hard + '/10 is over their ' + d.hard_level);
      else if (job.hard >= 7) add(6, 'hard job (' + job.hard + '/10) within their ' + d.hard_level);
      // a creative job (design fee, "Work with Our Designers", design notes) goes to the creative ones
      if (job.creative >= 6 || job.design_fee > 0) { const c = (d.comm_level == null ? 5 : d.comm_level) - 5; if (c) add(c * 2, 'client communication ' + (c + 5) + '/10 on a job with client back-and-forth'); }
      langs.forEach(l => { if ((d.language_list || []).indexOf(l) > -1) add(12, 'speaks ' + l + ' — the job mentions it'); });
      if (job.creative >= 6) { const diff = d.creative_level - 5; add(diff * 3, 'creative job ' + job.creative + '/10 · their creative level ' + d.creative_level); if (d.creative_level < job.creative - 2) add(-15, 'below the creativity this job asks'); }
      // newer designers: common, easy products are theirs to learn on; the hard / creative ones are not
      if (d.is_new) { if (job.common && job.hard <= 4 && job.creative < 6) add(15, 'newer designer (' + d.jobs_180 + ' jobs in 180 d) — a common, easy product'); else if (job.hard >= 7 || job.creative >= 7) add(-10, 'newer designer — not a hard / creative one'); }
      // hours: off shift is out; leaving within the hour should not start something new
      const sh = d.on_shift;
      if (!sh.known) add(0, 'hours not set — add them on the Designers tab');
      else if (!sh.on) add(-45, 'OFF SHIFT — ' + sh.why);
      else if (sh.left <= 60) add(-25, 'leaves at ' + sh.ends);
      else if (sh.left <= 90 && job.hard >= 6) add(-15, 'only ' + sh.left + ' min left today for a hard job');
      const over = d.active_jobs - minLoad;
      add(over > 0 ? -Math.min(30, over * 3) : 0, d.active_jobs + ' active job' + (d.active_jobs === 1 ? '' : 's') + (over === 0 ? ' — lightest load' : ''));
      if (d.max_active && d.active_jobs >= d.max_active) add(-40, 'at max (' + d.max_active + ')');
      if (recent[d.user_id]) add(-recent[d.user_id] * 4, 'picked ' + recent[d.user_id] + '× in the last 2 h');
      // 1.20.32: hours and the cap are hard limits, not just points — an off-shift designer can never top the list
      const off = !!(sh.known && !sh.on), atMax = !!(d.max_active && d.active_jobs >= d.max_active);
      if (off) score = Math.min(score, 15); else if (atMax) score = Math.min(score, 25);
      return { user_id: d.user_id, name: d.name, last_name: d.last_name, photo: d.photo, score: Math.max(0, Math.min(100, Math.round(score))), why, active_jobs: d.active_jobs, at_max: atMax, off_shift: off, hours_known: !!sh.known };
    }).sort((a, b) => (a.off_shift - b.off_shift) || (a.at_max - b.at_max) || b.score - a.score || a.active_jobs - b.active_jobs);
    return out;
  }

  const guard = [auth, adminOnly];
  app.get('/designer-ai', serveVersionedHtml('designer-ai.html'));
  app.get('/api/designer/designers', ...guard, async (req, res) => { try { res.json({ ok: true, designers: await designers() }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/designer/designers/:id', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), b = req.body || {};
      const cur = await dbGet('SELECT * FROM da_designers WHERE user_id = ?', [id]); if (!cur) return res.json({ ok: false, error: 'No such designer' });
      const lvl = (v, cur) => v == null || v === '' ? (cur == null ? 5 : cur) : Math.max(0, Math.min(10, parseInt(v) || 0));
      const tm = (v, cur) => v == null ? cur : (/^\d{1,2}:\d{2}$/.test(String(v).trim()) ? String(v).trim() : null);
      await dbRun('UPDATE da_designers SET skills = ?, notes = ?, max_active = ?, tier2 = ?, active = ?, hard_level = ?, creative_level = ?, shift_start = ?, shift_end = ?, work_days = ?, comm_level = ?, languages = ?, updated_at = ? WHERE user_id = ?',
        [String(b.skills != null ? b.skills : cur.skills || '').slice(0, 600), String(b.notes != null ? b.notes : cur.notes || '').slice(0, 1000), Math.max(1, parseInt(b.max_active) || cur.max_active || 25), b.tier2 != null ? (b.tier2 ? 1 : 0) : cur.tier2, b.active != null ? (b.active ? 1 : 0) : cur.active,
          lvl(b.hard_level, cur.hard_level), lvl(b.creative_level, cur.creative_level), tm(b.shift_start, cur.shift_start), tm(b.shift_end, cur.shift_end), b.work_days != null ? String(b.work_days).split(',').map(x => parseInt(x)).filter(x => x >= 1 && x <= 7).join(',') || null : cur.work_days, lvl(b.comm_level, cur.comm_level), b.languages != null ? String(b.languages).split(',').map(x => x.trim()).map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).filter(x => LANGS.indexOf(x) > -1).join(',') : cur.languages, nowIso(), id]);
      dropTeamCache(); res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // both tiers in one list (1.20.15); ?tier=1|2 narrows. A job parked on both placeholders shows once, as Tier 2.
  async function queueAll(all, tier, onlyId) {
    const want = tier === 1 || tier === 2 ? [tier] : [2, 1];
    const seen = new Map();
    for (const t of want) for (const j of await queue(t, all, onlyId)) if (!seen.has(j.id)) seen.set(j.id, j);
    return Array.from(seen.values()).sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }
  app.get('/api/designer/queue', ...guard, async (req, res) => {
    try { const tier = req.query.tier === '2' ? 2 : req.query.tier === '1' ? 1 : 0; const jobs = await queueAll(req.query.all === '1', tier); res.json({ ok: true, tier, jobs, counts: { t1: jobs.filter(j => j.tier === 1).length, t2: jobs.filter(j => j.tier === 2).length } }); }
    catch (e) { res.json({ ok: false, error: 'CRM not reachable: ' + e.message }); }
  });
  // 1.20.18: Match Logic — the owner's rules in plain words (Designer AI → Match Logic). When set, the model reads the job, the
  // scored candidates and the rules, and may move the scores; every change it makes is shown as "your rule: …" on the pick.
  const getSetting = async (k) => { const r = await dbGet('SELECT value FROM da_settings WHERE key = ?', [k]); return r ? r.value : ''; };
  // 1.20.28 — Overload: when nobody can take the job it stays in the queue, is marked "Everyone is busy" and the people in
  // `overload_to` get an email (once per job per day). Built-in test: every designer who takes jobs is at their Max active
  // or off shift. The owner's Overload Logic text (editable on the Match Logic tab) goes to the model too, which may say
  // busy for its own reasons ({"busy":true,"busy_reason":…}).
  const OVERLOAD_DEFAULT = 'Everyone is busy when every designer who takes jobs is at their Max active, or the only ones with room are off shift for the day.\nWhen that happens: do not force the job on anyone. Leave it in the queue, mark it "Everyone is busy" and email the team — the designers will pick it up themselves.\nA rush / expedite job may still go to the lightest designer who is on shift, even at their max, if the due date is today or tomorrow.';
  const OVERLOAD_TO_DEFAULT = 'gary@axiomprint.com, tasha@axiomprint.com';
  const builtinBusy = (picks) => picks.length > 0 && picks.every(p => p.at_max || p.off_shift);
  async function markBusy(job, reason, who) {
    const open = await dbGet("SELECT id, at FROM da_assign WHERE estimate_id = ? AND status = 'busy' ORDER BY id DESC LIMIT 1", [job.id]);
    if (!open) await dbRun("INSERT INTO da_assign (estimate_id, user_id, score, reason, picked_by, at, status) VALUES (?,?,?,?,?,?,'busy')", [job.id, 0, null, String(reason || '').slice(0, 500), who, nowIso()]);
    // the email, once per job per 24 h
    const last = await dbGet("SELECT value FROM da_settings WHERE key = ?", ['busy_mailed_' + job.id]);
    if (last && Date.now() - new Date(last.value).getTime() < 24 * 3600e3) return { emailed: false, emailed_at: last.value };
    const to = ((await getSetting('overload_to')) || OVERLOAD_TO_DEFAULT).split(/[,;\s]+/).map(x => x.trim()).filter(x => /@/.test(x));
    if (!sendMail || !to.length) return { emailed: false };
    try {
      const line = (k, v) => v ? k + ': ' + v + '\n' : '';
      await sendMail({ to: to.join(', '), subject: 'Designer AI — everyone is busy, ' + job.e + ' not assigned',
        text: 'Everyone is busy and AI wasn\'t able to assign this job to anyone. It stays in the queue for now — the designers will pick it up themselves.\n\n' +
          line('Job', job.e + (job.name ? ' — ' + job.name : '')) + line('Customer', job.customer) + line('Product', job.product + (job.category ? ' (' + job.category + ')' : '')) + line('Tier', 'Tier ' + job.tier + (job.proof_type ? ' · ' + job.proof_type : '')) + line('Due', job.complete_by ? String(job.complete_by).slice(0, 10) : '') + line('Why', reason) +
          '\nDesigner AI: https://nova.axiomprint.com/designer-ai\n' });
      await dbRun('INSERT INTO da_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', ['busy_mailed_' + job.id, nowIso(), who, nowIso()]);
      return { emailed: true, to };
    } catch (e) { errlog('busy mail', e.message); return { emailed: false, error: e.message }; }
  }
  async function aiAdjust(job, picks, logic, overload) {
    overload = (overload || '').trim(); logic = (logic || '').trim();
    if (overload === OVERLOAD_DEFAULT.trim()) overload = '';   // Nova's own default is already builtinBusy() — no model call for it
    if (!anthropic || (!logic && !overload)) return { picks, ai: false };
    const cand = picks.map(p => ({ user_id: p.user_id, name: p.name + ' ' + (p.last_name || ''), score: p.score, reasons: p.why, active_jobs: p.active_jobs }));
    const team = await designers();
    const prof = team.filter(d => d.active).map(d => ({ user_id: d.user_id, name: d.name + ' ' + (d.last_name || ''), title: d.title, strong_sides: d.skill_list, tier2: !!d.tier2, hard_level: d.hard_level, creative_level: d.creative_level, client_communication: d.comm_level, languages: d.language_list, notes: d.notes || '', active_jobs: d.active_jobs, waiting_on_client: d.waiting_client, approved_30d: d.done_30, jobs_180d: d.jobs_180, hours: d.shift_start ? d.shift_start + '-' + d.shift_end + ' days ' + (d.work_days || '1-5') : 'unknown', on_shift: d.on_shift }));
    const sys = 'You assign print jobs to designers at AxiomPrint. Nova has already scored every designer with its built-in rules (history, strong sides, hardness, creativity, load, hours). The OWNER\'S RULES below take priority over those scores wherever they apply. Return ONLY JSON: {"picks":[{"user_id":n,"score":0-100,"note":"short reason citing the owner rule, or empty"}],"busy":false,"busy_reason":""} — every candidate once, scores changed only where a rule applies, note only when you changed something. Set busy to true ONLY when the OVERLOAD RULES say nobody should take this job right now (then the job stays in the queue and the team is emailed); give the reason in one sentence.';
    const user = 'OWNER\'S RULES:\n' + (logic.slice(0, 4000) || '(none)') + '\n\nOVERLOAD RULES (when is everyone busy):\n' + (overload.slice(0, 2000) || '(none)') + '\n\nJOB:\n' + JSON.stringify({ e: job.e, name: job.name, customer: job.customer, product: job.product, category: job.category, tier: job.tier, proof_type: job.proof_type, status: job.status_label, hard: job.hard, creative: job.creative, design_fee: job.design_fee, expedite: job.service === 'expedite', due: job.complete_by, created: job.created, notes: (job.notes || '').slice(0, 600), team_on_it: job.others }) +
      '\n\nDESIGNERS:\n' + JSON.stringify(prof) + '\n\nNOVA\'S SCORES:\n' + JSON.stringify(cand) + '\n\nTime now (Los Angeles): ' + new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    try {
      const r = await anthropic.messages.create({ model: model || 'claude-haiku-4-5', max_tokens: 900, system: sys, messages: [{ role: 'user', content: user }] });
      const txt = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); const m = /\{[\s\S]*\}/.exec(txt); if (!m) return { picks, ai: false };
      const out = JSON.parse(m[0]); const by = {}; (out.picks || []).forEach(p => { by[p.user_id] = p; });
      const adj = picks.map(p => { const a = by[p.user_id]; if (!a) return p; const sc = Math.max(0, Math.min(100, Math.round(Number(a.score)))); const changed = !isNaN(sc) && sc !== p.score; return Object.assign({}, p, { score: isNaN(sc) ? p.score : sc, why: changed || a.note ? p.why.concat(['your rule: ' + (a.note || ('score ' + p.score + ' → ' + sc))]) : p.why, ai_changed: changed }); });
      adj.sort((a, b) => (a.off_shift - b.off_shift) || (a.at_max - b.at_max) || b.score - a.score || a.active_jobs - b.active_jobs);
      return { picks: adj, ai: true, busy: out.busy === true, busy_reason: out.busy === true ? String(out.busy_reason || '').slice(0, 300) : '' };
    } catch (e) { errlog('ai adjust', e.message); return { picks, ai: false, ai_error: e.message }; }
  }
  app.get('/api/designer/settings', ...guard, async (req, res) => { try { const r = await dbGet('SELECT * FROM da_settings WHERE key = ?', ['match_logic']); const o = await dbGet('SELECT * FROM da_settings WHERE key = ?', ['overload_logic']); const t = await dbGet('SELECT * FROM da_settings WHERE key = ?', ['overload_to']);
    res.json({ ok: true, match_logic: r ? r.value : '', updated_by: r ? r.updated_by : null, updated_at: r ? r.updated_at : null, overload_logic: o ? o.value : OVERLOAD_DEFAULT, overload_default: !o, overload_to: t ? t.value : OVERLOAD_TO_DEFAULT, overload_updated_at: o ? o.updated_at : null, overload_updated_by: o ? o.updated_by : null }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/designer/settings', ...guard, async (req, res) => {
    try {
      const put = (k, v) => dbRun('INSERT INTO da_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at', [k, v, userId(req), nowIso()]);
      const b = req.body || {};
      if (b.match_logic != null) await put('match_logic', String(b.match_logic).slice(0, 8000));
      if (b.overload_logic != null) await put('overload_logic', String(b.overload_logic).slice(0, 4000));
      if (b.overload_to != null) await put('overload_to', String(b.overload_to).split(/[,;\s]+/).map(x => x.trim()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).join(', '));
      res.json({ ok: true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/designer/match', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.body.estimate_id); if (!id) return res.json({ ok: false, error: 'Which job?' });
      const t0 = Date.now();
      const job = (await queueAll(true, 0, id)).find(j => j.id === id);   // 1.20.31: one job, not the whole queue
      if (!job) return res.json({ ok: false, error: 'E' + id + ' is not in the queue any more' });
      const base = await match(job);
      const overload = (await getSetting('overload_logic')) || OVERLOAD_DEFAULT;
      const r = await aiAdjust(job, base, await getSetting('match_logic'), overload);
      let busy = null;
      if (r.busy) busy = { reason: r.busy_reason || 'your Overload Logic says nobody should take this now' };
      else if (!r.ai && builtinBusy(base)) busy = { reason: 'every designer who takes jobs is at their max or off shift' };
      if (busy) { const m = await markBusy(job, busy.reason, userId(req)); Object.assign(busy, m); }
      res.json({ ok: true, job, picks: r.picks.slice(0, 4), ai: r.ai, ai_error: r.ai_error || null, busy, ms: Date.now() - t0 });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // a pick made in Nova — kept here only (the CRM is not changed) until the web team gives us an assignment endpoint
  app.post('/api/designer/assign', ...guard, async (req, res) => {
    try {
      const eid = parseInt(req.body.estimate_id), uid = parseInt(req.body.user_id); if (!eid || !uid) return res.json({ ok: false, error: 'Job and designer, please' });
      const d = await dbGet('SELECT * FROM da_designers WHERE user_id = ?', [uid]); if (!d) return res.json({ ok: false, error: 'No such designer' });
      await dbRun("UPDATE da_assign SET status = 'replaced' WHERE estimate_id = ? AND status IN ('assigned', 'busy')", [eid]);
      await dbRun('INSERT INTO da_assign (estimate_id, user_id, score, reason, picked_by, at) VALUES (?,?,?,?,?,?)', [eid, uid, parseInt(req.body.score) || null, String(req.body.reason || '').slice(0, 500), userId(req), nowIso()]);
      dropTeamCache();
      res.json({ ok: true, designer: { user_id: d.user_id, name: d.name, photo: d.photo } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/designer/unassign', ...guard, async (req, res) => {
    try { await dbRun("UPDATE da_assign SET status = 'cleared' WHERE estimate_id = ? AND status = 'assigned'", [parseInt(req.body.estimate_id)]); res.json({ ok: true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/designer/history', ...guard, async (req, res) => {
    try { res.json({ ok: true, rows: await dbAll("SELECT a.*, d.name, d.photo FROM da_assign a LEFT JOIN da_designers d ON d.user_id = a.user_id ORDER BY a.id DESC LIMIT 200") }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  return { designers, queue, match };
};
