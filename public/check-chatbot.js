#!/usr/bin/env node
/**
 * check-chatbot.js — why can't I see ChatBot?
 *
 * Reports the real state of the agents table, the novaai account, member access,
 * and whether the frontend files are actually on disk. Repairs anything it can.
 *
 * Run from /opt/axiom-ai:
 *   node check-chatbot.js
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const ROOT = __dirname;
const DBF = path.join(ROOT, 'users.db');
const PUB = path.join(ROOT, 'public');

if (!fs.existsSync(DBF)) {
  console.error('Cannot find users.db at ' + DBF + ' — run this from /opt/axiom-ai');
  process.exit(1);
}
const db = new sqlite3.Database(DBF);
const all = (sql, p = []) => new Promise(r => db.all(sql, p, (e, rows) => r(e ? [] : (rows || []))));
const run = (sql, p = []) => new Promise(r => db.run(sql, p, function (e) { r(e ? 0 : this.changes); }));

(async () => {
  console.log('\n=== 1. Frontend files ===');
  [['public/chatbot.html', path.join(PUB, 'chatbot.html')],
   ['public/chatbot.js', path.join(PUB, 'chatbot.js')],
   ['public/index.html', path.join(PUB, 'index.html')],
   ['public/order-assist.js', path.join(PUB, 'order-assist.js')]].forEach(([label, f]) => {
    if (!fs.existsSync(f)) { console.log('  MISSING  ' + label + '   <-- upload this'); return; }
    const txt = fs.readFileSync(f, 'utf8');
    const needsRoute = /index\.html|order-assist\.js/.test(label);
    const ok = needsRoute ? txt.includes("'chatbot': '/chatbot'") : true;
    console.log('  ' + (ok ? 'ok      ' : 'STALE   ') + label +
      (needsRoute && !ok ? '   <-- missing the chatbot route, re-upload' : ''));
  });

  console.log('\n=== 2. agents table ===');
  const ag = await all("SELECT slug, name, status, access, sort_order FROM agents ORDER BY sort_order");
  ag.forEach(a => console.log('  ' + a.slug.padEnd(18) + a.status.padEnd(13) + 'access=' + a.access));
  const cb = ag.find(a => a.slug === 'chatbot');
  if (!cb) {
    console.log('  ChatBot row MISSING — creating it');
    await run("INSERT OR IGNORE INTO agents (slug, name, description, status, access, sort_order) VALUES (?,?,?,?,?,?)",
      ['chatbot', 'ChatBot', 'Ask anything about AxiomPrint.', 'active', 'all', 2]);
    console.log('  created');
  } else if (cb.status !== 'active' || cb.access !== 'all') {
    console.log('  ChatBot is ' + cb.status + '/' + cb.access + ' — fixing to active/all');
    await run("UPDATE agents SET status='active', access='all' WHERE slug='chatbot'");
    console.log('  fixed');
  } else {
    console.log('  ChatBot is active/all — correct');
  }

  console.log('\n=== 3. Local accounts (users table) ===');
  const users = await all("SELECT id, username, is_admin FROM users");
  if (!users.length) console.log('  (none)');
  users.forEach(u => console.log('  ' + String(u.username).padEnd(16) + (u.is_admin ? 'ADMIN — sees every agent' : 'not admin — sees all non-restricted agents')));
  console.log('  Note: local accounts have no member_agents rows, so they are never');
  console.log('  filtered. If novaai still cannot see ChatBot, it is a frontend file issue (section 1).');

  console.log('\n=== 4. Members with an explicit allow-list ===');
  const rows = await all("SELECT m.id, m.email, m.enabled, GROUP_CONCAT(ma.agent_slug) AS slugs " +
    "FROM members m LEFT JOIN member_agents ma ON ma.member_id = m.id GROUP BY m.id ORDER BY m.email");
  if (!rows.length) console.log('  (no members)');
  let fixed = 0;
  for (const r of rows) {
    const list = (r.slugs || '').split(',').filter(Boolean);
    if (!list.length) { console.log('  ' + String(r.email).padEnd(34) + 'no list = ALL agents (ok)'); continue; }
    if (list.indexOf('chatbot') === -1) {
      await run("INSERT OR IGNORE INTO member_agents (member_id, agent_slug) VALUES (?, 'chatbot')", [r.id]);
      fixed++;
      console.log('  ' + String(r.email).padEnd(34) + list.join(',') + '   <-- ChatBot ADDED');
    } else {
      console.log('  ' + String(r.email).padEnd(34) + list.join(','));
    }
  }
  console.log('\n  members repaired: ' + fixed);

  console.log('\nDone. If anything changed above: pm2 restart axiom-ai, then hard-refresh (Ctrl+Shift+R).\n');
  db.close();
})();
