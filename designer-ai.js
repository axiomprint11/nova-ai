// Designer AI — the tools around the design team. 1.20.13: the AutoAssign Jobs tab: the jobs sitting with the
// "PrePress 1 Tier 1" / "PrePress Tier 2" placeholder users in the CRM, the designers with their faces, load and
// strong sides, and a matcher that says who should take a job. Nothing is written to the CRM — an assignment made here
// is kept in SQLite (da_assign) until the CRM gets an endpoint for it. "Template Designer" and "Online Designer" are
// placeholders for later.
'use strict';

module.exports = function mountDesignerAi(app, deps) {
  const { db, auth, adminOnly, serveVersionedHtml, runQuery } = deps;
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
  async function designers() {
    if (Date.now() - teamAt > 10 * 60000) { try { await syncTeam(); teamAt = Date.now(); } catch (e) { errlog('team sync', e.message); } }
    const rows = await dbAll('SELECT * FROM da_designers ORDER BY name');
    // the live load: jobs in the prepress stage assigned to each designer (not canceled), and what they finished in 30 days
    let load = {}, done = {};
    try {
      (await runQuery("SELECT m.user_id, COUNT(DISTINCT e.id) n FROM estimate_team_members m JOIN estimate e ON e.id = m.estimate_id JOIN estimate_stage s ON s.estimate_id = e.id WHERE m.user_id IN (" + TEAM.join(',') + ") AND s.estimate_stage = 'prepress' AND s.estimate_substage <> 'canceled' AND e.estimate_invoiceid > 0 GROUP BY m.user_id")).forEach(r => { load[r.user_id] = Number(r.n); });
      (await runQuery("SELECT m.user_id, COUNT(DISTINCT e.id) n FROM estimate_team_members m JOIN estimate e ON e.id = m.estimate_id WHERE m.user_id IN (" + TEAM.join(',') + ") AND e.prepress_status = 'approved' AND e.created >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY m.user_id")).forEach(r => { done[r.user_id] = Number(r.n); });
    } catch (e) { errlog('load', e.message); }
    const nova = {}; (await dbAll("SELECT user_id, COUNT(*) n FROM da_assign WHERE status = 'assigned' AND at >= datetime('now', '-14 days') GROUP BY user_id")).forEach(r => { nova[r.user_id] = r.n; });
    return rows.map(r => Object.assign({}, r, { skills: r.skills || '', skill_list: skillList(r.skills), active_jobs: load[r.user_id] || 0, done_30: done[r.user_id] || 0, nova_assigned: nova[r.user_id] || 0 }));
  }
  const skillList = (s) => String(s || '').split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean);

  // ---- the queue: jobs parked on a tier placeholder, in the prepress stage
  const PROOF_LABEL = { proof_checking: 'Proof Checking', insta_proofed: 'Insta Proofed', proof_sent: 'Proof Sent', upload_files: 'Upload Files', waiting_files: 'Waiting for Files', rejected_edits: 'Rejected — edits', rejected_reupload: 'Rejected — re-upload', approved: 'Approved', hard_copy_approved: 'Hard copy approved', insta_proof_manual: 'Insta Proof Manual' };
  async function queue(tier, all) {
    const tu = TIER_USERS[tier] || TIER_USERS[1];
    const rows = await runQuery(
      "SELECT e.id, e.estimate_name, e.created, e.complete_by, e.prepress_status, e.estimate_invoiceid inv, e.estimate_productid product_id, p.title product, p.image product_image, pc.title category, " +
      "s.estimate_stage stage, s.estimate_substage substage, s.stage_in_date, c.company_name, c.name cname, c.last_name clname, " +
      "(SELECT GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') FROM estimate_team_members m2 JOIN user u ON u.id = m2.user_id WHERE m2.estimate_id = e.id AND m2.user_id NOT IN (239, 331)) others, " +
      "(SELECT GROUP_CONCAT(DISTINCT m3.user_id) FROM estimate_team_members m3 WHERE m3.estimate_id = e.id AND m3.user_id IN (" + TEAM.join(',') + ")) designer_ids, " +
      "(SELECT dd.design_type FROM estimate_design_details dd WHERE dd.estimate_id = e.id AND dd.design_type LIKE '%Proof%' ORDER BY dd.id DESC LIMIT 1) proof_type, " +
      "(SELECT dd.design_type FROM estimate_design_details dd WHERE dd.estimate_id = e.id AND dd.design_type NOT LIKE '%Proof%' ORDER BY dd.id DESC LIMIT 1) files_type, " +
      "(SELECT dd.service_type FROM estimate_design_details dd WHERE dd.estimate_id = e.id AND dd.service_type IS NOT NULL ORDER BY dd.id DESC LIMIT 1) service " +
      "FROM estimate e JOIN estimate_team_members m ON m.estimate_id = e.id AND m.user_id = " + tu + " JOIN estimate_stage s ON s.estimate_id = e.id " +
      "LEFT JOIN product p ON p.id = e.estimate_productid LEFT JOIN productcategory pc ON pc.id = p.product_category_id LEFT JOIN customer c ON c.id = e.estimate_clientid " +
      "WHERE s.estimate_stage = 'prepress' AND s.estimate_substage <> 'canceled'" + (all ? '' : ' AND e.estimate_invoiceid > 0') + " ORDER BY e.created DESC LIMIT 300");
    const ids = rows.map(r => r.id);
    const mine = {}; if (ids.length) (await dbAll('SELECT estimate_id, user_id, score, reason, at, picked_by FROM da_assign WHERE status = \'assigned\' AND estimate_id IN (' + ids.map(() => '?').join(',') + ')', ids)).forEach(r => { mine[r.estimate_id] = r; });
    return rows.map(r => ({
      id: r.id, e: 'E' + r.id, name: r.estimate_name || '', created: r.created, complete_by: r.complete_by, invoiced: Number(r.inv) > 0, inv: r.inv,
      product_id: r.product_id, product: r.product || '', product_image: r.product_image || null, category: r.category || '', stage: r.stage, substage: r.substage, stage_in: r.stage_in_date,
      status: r.prepress_status, status_label: PROOF_LABEL[r.prepress_status] || r.prepress_status || '', proof_type: r.proof_type || (r.substage === 'tier_2' ? 'Tier 2' : r.substage === 'tier_1' ? 'Tier 1' : ''), files_type: r.files_type || '', service: r.service || '',
      tier, customer: r.company_name || [r.cname, r.clname].filter(Boolean).join(' ') || '', others: r.others || '', designer_ids: r.designer_ids ? String(r.designer_ids).split(',').map(Number) : [],
      nova: mine[r.id] || null
    }));
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
      const h = await runQuery("SELECT m.user_id, SUM(e.estimate_productid = " + (parseInt(job.product_id) || 0) + ") same_product, SUM(p.product_category_id = (SELECT product_category_id FROM product WHERE id = " + (parseInt(job.product_id) || 0) + ")) same_cat FROM estimate_team_members m JOIN estimate e ON e.id = m.estimate_id LEFT JOIN product p ON p.id = e.estimate_productid WHERE m.user_id IN (" + TEAM.join(',') + ") AND e.created >= DATE_SUB(NOW(), INTERVAL 180 DAY) GROUP BY m.user_id");
      h.forEach(r => { hist[r.user_id] = { product: Number(r.same_product) || 0, cat: Number(r.same_cat) || 0 }; });
    } catch (e) { errlog('history', e.message); }
    const recent = {}; (await dbAll("SELECT user_id, COUNT(*) n FROM da_assign WHERE status = 'assigned' AND at >= datetime('now', '-2 hours') GROUP BY user_id")).forEach(r => { recent[r.user_id] = r.n; });
    const minLoad = team.length ? Math.min(...team.map(d => d.active_jobs)) : 0;
    const jobText = [job.product, job.category, job.proof_type, job.name, job.files_type].join(' ').toLowerCase();
    const isT2 = /tier ?2|tier_2/i.test(job.proof_type + ' ' + job.substage);
    const out = team.map(d => {
      let score = 50; const why = [];
      const h = hist[d.user_id] || { product: 0, cat: 0 };
      if (h.product) { const p = Math.min(30, h.product * 5); score += p; why.push('did ' + h.product + ' × ' + (job.product || 'this product') + ' in 180 days'); }
      else if (h.cat) { const p = Math.min(15, h.cat * 2); score += p; why.push(h.cat + ' ' + (job.category || 'same category') + ' jobs in 180 days'); }
      const hits = d.skill_list.filter(sk => sk && jobText.indexOf(sk) > -1);
      if (hits.length) { score += Math.min(36, hits.length * 12); why.push('strong side: ' + hits.join(', ')); }
      if (isT2) { if (d.tier2) { score += 15; why.push('Tier 2 designer'); } else { score -= 20; why.push('not marked Tier 2'); } }
      const over = d.active_jobs - minLoad; if (over > 0) { score -= Math.min(30, over * 3); }
      why.push(d.active_jobs + ' active job' + (d.active_jobs === 1 ? '' : 's') + (over === 0 ? ' — lightest load' : ''));
      if (d.max_active && d.active_jobs >= d.max_active) { score -= 40; why.push('at max (' + d.max_active + ')'); }
      if (recent[d.user_id]) { score -= recent[d.user_id] * 4; why.push('picked ' + recent[d.user_id] + '× in the last 2 h'); }
      return { user_id: d.user_id, name: d.name, last_name: d.last_name, photo: d.photo, score: Math.max(0, Math.min(100, Math.round(score))), why, active_jobs: d.active_jobs };
    }).sort((a, b) => b.score - a.score || a.active_jobs - b.active_jobs);
    return out;
  }

  const guard = [auth, adminOnly];
  app.get('/designer-ai', serveVersionedHtml('designer-ai.html'));
  app.get('/api/designer/designers', ...guard, async (req, res) => { try { res.json({ ok: true, designers: await designers() }); } catch (e) { res.json({ ok: false, error: e.message }); } });
  app.post('/api/designer/designers/:id', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id), b = req.body || {};
      const cur = await dbGet('SELECT * FROM da_designers WHERE user_id = ?', [id]); if (!cur) return res.json({ ok: false, error: 'No such designer' });
      await dbRun('UPDATE da_designers SET skills = ?, notes = ?, max_active = ?, tier2 = ?, active = ?, updated_at = ? WHERE user_id = ?',
        [String(b.skills != null ? b.skills : cur.skills || '').slice(0, 600), String(b.notes != null ? b.notes : cur.notes || '').slice(0, 1000), Math.max(1, parseInt(b.max_active) || cur.max_active || 25), b.tier2 != null ? (b.tier2 ? 1 : 0) : cur.tier2, b.active != null ? (b.active ? 1 : 0) : cur.active, nowIso(), id]);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/designer/queue', ...guard, async (req, res) => {
    try { const tier = req.query.tier === '2' ? 2 : 1; res.json({ ok: true, tier, jobs: await queue(tier, req.query.all === '1') }); }
    catch (e) { res.json({ ok: false, error: 'CRM not reachable: ' + e.message }); }
  });
  app.post('/api/designer/match', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.body.estimate_id); if (!id) return res.json({ ok: false, error: 'Which job?' });
      const tier = req.body.tier === 2 || req.body.tier === '2' ? 2 : 1;
      const job = (await queue(tier, true)).find(j => j.id === id) || (await queue(tier === 1 ? 2 : 1, true)).find(j => j.id === id);
      if (!job) return res.json({ ok: false, error: 'E' + id + ' is not in the queue any more' });
      const picks = await match(job);
      res.json({ ok: true, job, picks: picks.slice(0, 4) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  // a pick made in Nova — kept here only (the CRM is not changed) until the web team gives us an assignment endpoint
  app.post('/api/designer/assign', ...guard, async (req, res) => {
    try {
      const eid = parseInt(req.body.estimate_id), uid = parseInt(req.body.user_id); if (!eid || !uid) return res.json({ ok: false, error: 'Job and designer, please' });
      const d = await dbGet('SELECT * FROM da_designers WHERE user_id = ?', [uid]); if (!d) return res.json({ ok: false, error: 'No such designer' });
      await dbRun("UPDATE da_assign SET status = 'replaced' WHERE estimate_id = ? AND status = 'assigned'", [eid]);
      await dbRun('INSERT INTO da_assign (estimate_id, user_id, score, reason, picked_by, at) VALUES (?,?,?,?,?,?)', [eid, uid, parseInt(req.body.score) || null, String(req.body.reason || '').slice(0, 500), userId(req), nowIso()]);
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
