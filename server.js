require('dotenv').config();
const express = require('express');
// Money is always shown as 1,678.54 (comma thousands, two decimals); callers add the $.
function usd2(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');   // HMAC for the signed CRM handoff

// Model choice, by job rather than one setting for everything.
//   MAIN  — the agent loop: many tools, long context, has to follow detailed rules.
//           This is where model quality actually shows.
//   LIGHT — short background jobs (chat titles, welcome lines). Speed and cost win;
//           a stronger model here buys nothing.
// Override either in .env without touching code.
const MODEL_MAIN = process.env.ANTHROPIC_MODEL_MAIN || 'claude-sonnet-5';
const MODEL_LIGHT = process.env.ANTHROPIC_MODEL_LIGHT || 'claude-haiku-4-5';
const mysql = require('mysql2/promise');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { google } = require('googleapis');
const fs = require('fs');

const app = express();

// Bump with every deploy. Shown in the UI so "is the new code live?" is a glance
// rather than an investigation — we have lost hours to that question.
const NOVA_VERSION = '1.10.2';
const NOVA_BUILT = '10-09-2026 9:05am';
const jsonBody = express.json({ limit: '25mb' });
// TalkAi's webhooks (talk-ai.js) read their own raw body: signature checks and call recordings.
app.use((req, res, next) => req.path.indexOf('/api/talk/hook/') === 0 ? next() : jsonBody(req, res, next));

// --- Auto cache-busting HTML server ---
// Serves an HTML page but rewrites every local .js/.css reference to include
// ?v=<file-modified-time>. When you upload a new JS/CSS file, its timestamp
// changes, the version changes, and browsers are forced to fetch the fresh copy.
// This means you NEVER have to manually bump version numbers or rename files.
// One build id for the whole frontend: the newest mtime across public/. Used to
// version the embedded iframe URL and reported by /api/version, so "am I running
// the latest?" has a definite answer instead of a guess.
let BUILD_ID = 0;
function computeBuildId() {
  const pubDir = path.join(__dirname, 'public');
  let newest = 0;
  try {
    fs.readdirSync(pubDir).forEach(f => {
      if (!/\.(js|css|html)$/.test(f)) return;
      try {
        const m = Math.floor(fs.statSync(path.join(pubDir, f)).mtimeMs);
        if (m > newest) newest = m;
      } catch (e) {}
    });
  } catch (e) {}
  BUILD_ID = newest || Date.now();
  return BUILD_ID;
}
computeBuildId();
// Files are uploaded while the server is running, so re-check periodically
// rather than trusting the value captured at boot.
setInterval(computeBuildId, 15000);

// What hash would this asset be served as right now? Lets a loaded page tell
// whether it is running the current file.
app.get('/api/asset-hash', (req, res) => {
  const file = String(req.query.file || '').split('?')[0];
  if (!/^\/[\w\-./]+\.(js|css)$/.test(file) || file.indexOf('..') > -1) {
    return res.status(400).json({ error: 'bad file' });
  }
  const real = path.join(__dirname, 'public', file);
  res.set('Cache-Control', 'no-store');
  res.json({ file: file, hash: assetHash(real) });
});

app.get('/api/version', (req, res) => {
  res.json({ version: NOVA_VERSION, built: NOVA_BUILT, build: BUILD_ID });
});

app.get('/api/version-old', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    build: computeBuildId(),
    build_iso: new Date(BUILD_ID).toISOString(),
    started: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    uptime_s: Math.floor(process.uptime())
  });
});

// Content hash per asset, so every edit produces a genuinely NEW filename:
//   /chatbot.js  ->  /chatbot.a91f3c7e.js
// A query string (?v=) is only a hint — CDNs and some proxies are free to ignore
// it and serve the cached body, which is exactly what kept happening. A different
// path cannot be confused with the old one by anything, anywhere.
const hashCache = new Map();   // realPath -> { mtime, hash }
function assetHash(realPath) {
  try {
    const st = fs.statSync(realPath);
    const key = realPath;
    const hit = hashCache.get(key);
    if (hit && hit.mtime === st.mtimeMs) return hit.hash;
    const buf = fs.readFileSync(realPath);
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 10);
    hashCache.set(key, { mtime: st.mtimeMs, hash });
    return hash;
  } catch (e) { return null; }
}

// Serve /name.<hash>.js from public/name.js. The hash is in the path, so the body
// for a given URL can never change — safe to cache hard and forever.
app.get(/^\/([\w\-./]+)\.([0-9a-f]{10})\.(js|css)$/, (req, res, next) => {
  const base = req.params[0], ext = req.params[2];
  const pubRoot = path.join(__dirname, 'public') + path.sep;
  const real = path.join(__dirname, 'public', base + '.' + ext);
  // Contain to public/ — the separator matters, or "publicevil.js" would pass.
  if (!real.startsWith(pubRoot)) return res.status(400).end();
  fs.access(real, fs.constants.R_OK, (err) => {
    if (err) return next();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(ext === 'css' ? 'text/css' : 'application/javascript');
    res.sendFile(real);
  });
});

function serveVersionedHtml(htmlFile) {
  return (req, res) => {
    const pubDir = path.join(__dirname, 'public');
    const htmlPath = path.join(pubDir, htmlFile);
    fs.readFile(htmlPath, 'utf8', (err, html) => {
      if (err) return res.status(404).send('Not found');
      // Rewrite src="/foo.js" -> src="/foo.<contenthash>.js"
      html = html.replace(/(src|href)="(\/[^"]+\.(?:js|css))"/g, (m, attr, file) => {
        const clean = file.split('?')[0];
        const real = path.join(pubDir, clean);
        const h = assetHash(real);
        if (!h) return m;
        const dot = clean.lastIndexOf('.');
        return attr + '="' + clean.slice(0, dot) + '.' + h + clean.slice(dot) + '"';
      });
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('CDN-Cache-Control', 'no-store');      // Cloudflare and friends
      res.set('Cloudflare-CDN-Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.set('X-Nova-Build', String(BUILD_ID));
      res.type('html').send(html);
    });
  };
}

// Serve the agent pages with auto-versioning (the HTML itself is never cached,
// and its script/style links always carry the latest file timestamp).
// ===== Embeddable ChatBot widget =====
// embed.js goes in the <head> of axiomprint.com / crm.axiomprint.com and injects
// an iframe pointing at /widget here. Because the iframe is served by Nova it
// shares Nova's origin and session, so access is still enforced by the normal
// auth middleware on /api/chatbot/chat — the embed grants nothing by itself.
const EMBED_PARENTS = [
  'https://axiomprint.com',
  'https://www.axiomprint.com',
  'https://crm.axiomprint.com'
];

// Allow these sites (and only these) to frame the widget.
function allowFraming(req, res, next) {
  // X-Frame-Options can't express a list, so use CSP and make sure no
  // conflicting XFO header is set.
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy',
    "frame-ancestors 'self' " + EMBED_PARENTS.join(' ') + ';');
  next();
}

app.get('/embed.js', (req, res) => {
  res.type('application/javascript');
  // MUST revalidate every load. This is the outermost file in the chain: a stale
  // embed.js pins a stale iframe URL, and no amount of refreshing downstream
  // helps. It is ~8KB, so revalidating costs nothing.
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*'); // the loader itself is public and harmless
  res.setHeader('X-Nova-Build', String(BUILD_ID));
  // Hand the current build to the loader so it can version the iframe URL.
  fs.readFile(path.join(__dirname, 'public', 'embed.js'), 'utf8', (err, js) => {
    if (err) return res.status(404).send('// embed.js not found');
    res.send('window.__NOVA_BUILD=' + JSON.stringify(String(BUILD_ID)) + ';\n' + js);
  });
});

app.get('/widget', allowFraming, serveVersionedHtml('widget.html'));
app.get('/widget.html', allowFraming, serveVersionedHtml('widget.html'));

// Client bot pages are served by client-bot.js. Their .html paths would otherwise
// come straight from express.static — without the framing rules — so send them
// to the real routes.
app.get('/client-chat.html', (req, res) => res.redirect(301, '/client-chat'));
app.get('/client-bot.html', (req, res) => res.redirect(301, '/client-bot'));
app.get('/chatbot', serveVersionedHtml('chatbot.html'));
// Retired agent pages: everything is ChatBot now.
['/order-assist', '/order-assist.html', '/prepress', '/prepress.html'].forEach(p => app.get(p, (req, res) => res.redirect(302, '/chatbot')));
app.get('/chatbot.html', serveVersionedHtml('chatbot.html'));
app.get('/admin', serveVersionedHtml('admin.html'));
app.get('/admin.html', serveVersionedHtml('admin.html'));
app.get('/', serveVersionedHtml('index.html'));
app.get('/index.html', serveVersionedHtml('index.html'));

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  // Assets are requested with ?v=<mtime> from the pages, so they are already
  // cache-busted by URL. Revalidating means a direct hit (no ?v=) is never stale.
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('X-Nova-Build', String(BUILD_ID));
  }
}));

const db = new sqlite3.Database('/opt/axiom-ai/users.db');
db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)');
// is_admin flag on local users (admin accounts like novaai)
db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0', () => {});
db.run('ALTER TABLE users ADD COLUMN last_login TEXT', () => {});
// Members authorized to log in with their Axiom credentials
db.run(`CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  axiom_user_id INTEGER,
  display_name TEXT,
  enabled INTEGER DEFAULT 1,
  added_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
)`);
db.run('ALTER TABLE members ADD COLUMN photo TEXT', () => {});
db.run('ALTER TABLE members ADD COLUMN username TEXT', () => {});
db.run('ALTER TABLE members ADD COLUMN last_login TEXT', () => {});
db.run('ALTER TABLE members ADD COLUMN axiom_user_id INTEGER', () => {});
db.run('ALTER TABLE members ADD COLUMN display_name TEXT', () => {});
db.run('ALTER TABLE members ADD COLUMN added_by TEXT', () => {});
// Chat sessions
db.run(`CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  title TEXT,
  agent_slug TEXT DEFAULT 'order-assist',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);
db.run("ALTER TABLE chats ADD COLUMN agent_slug TEXT DEFAULT 'order-assist'", () => {});
// Where the chat came from: 'app' (Nova pages) or 'crm-widget' (embedded bubble).
// Lets you review CRM usage separately when judging quality.
db.run("ALTER TABLE chats ADD COLUMN source TEXT DEFAULT 'app'", () => {});
// The client a conversation belongs to. Pinned once and remembered, so nobody is
// asked "who is this for" twice, and so chats can be listed per client later.
// A cart per conversation. Multi-product requests ("2 boxes windowed, 2 boxes
// no window") are common, and holding each priced item somewhere visible beats
// scrolling back through the chat to find what was quoted.
db.run(`CREATE TABLE IF NOT EXISTS chat_cart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  product_id INTEGER,
  product TEXT,
  image TEXT,
  quantity INTEGER,
  price REAL,
  list_price REAL,
  summary TEXT,
  payload TEXT,
  added_at TEXT DEFAULT (datetime('now'))
)`, () => {
  db.run('CREATE INDEX IF NOT EXISTS ix_cart_chat ON chat_cart(chat_id)', () => {});
  // Each item keeps the turnaround it was quoted on, and the ready date that
  // follows from it — one shared date across a mixed cart would be wrong for
  // every item but one.
  db.run('ALTER TABLE chat_cart ADD COLUMN turnaround TEXT', () => {});
  db.run('ALTER TABLE chat_cart ADD COLUMN ready_date TEXT', () => {});
});

db.run('ALTER TABLE chats ADD COLUMN client_id INTEGER', () => {});
db.run('ALTER TABLE chats ADD COLUMN client_name TEXT', () => {});
// Messages within a chat (role: user|assistant), rating: 0 none, 1 up, -1 down
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_key TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  rating INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`, () => {
  // The cards drawn alongside an answer — product matches, price quotes, client
  // picks, timelines. Without these a reopened chat shows "Which one?" with
  // nothing under it, which is most of what an answer actually was.
  db.run('ALTER TABLE messages ADD COLUMN cards TEXT', () => {});
});

// Agents: configurable AI agents. Order Assist is active; others are placeholders.
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS agents (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'coming_soon',
    access TEXT DEFAULT 'all',
    role TEXT,
    rules TEXT,
    workflow TEXT,
    knowledge TEXT,
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS training_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    question TEXT,
    answer TEXT,
    source_message_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`, () => {
    // One example per rated message, so re-rating replaces rather than duplicates.
    // One example per rated message, so re-approving updates rather than
    // duplicating. SQLite treats NULLs as distinct, so manually added examples
    // (which have no source message) are unaffected.
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_training_msg ON training_examples(source_message_id)', () => {});
    db.run('ALTER TABLE training_examples ADD COLUMN created_by TEXT', () => {});
  });
  const SEED_AGENTS = [
    // Retired — ChatBot now prices and orders. Kept as a row so historic chats
    // still resolve a name instead of showing a bare slug.
    ['order-assist', 'Order Assist (retired)', 'Replaced by ChatBot.', 'inactive', 'none', 0],
    ['chatbot', 'ChatBot', 'Ask anything about AxiomPrint — products, pricing, policies, and what the team agreed in training.', 'active', 'all', 2],
    ['resolve-issues', 'Resolve Issues', 'Handles client problems, reprints, and complaint resolution.', 'coming_soon', 'all', 3],
    ['prepress-ai', 'PrepressAI', 'Reviews artwork and prepress requirements before production.', 'coming_soon', 'all', 4],
    ['business-analyst', 'Business Analyst', 'Revenue, sales, and operational analytics. Admin and selected users only.', 'coming_soon', 'restricted', 5],
    ['agent-five', 'Agent (Unassigned)', 'Reserved for a future agent.', 'coming_soon', 'all', 6],
    // NovaAI on the phone. A training target only (role / rules / knowledge, Domain Knowledge docs shared with
    // it): access 'system' keeps it out of every staff chat's agent menu.
    ['talk-ai', 'TalkAi', 'NovaAI on the phone. Training and documents for calls; call settings are on the TalkAi page.', 'active', 'system', 7]
  ];
  SEED_AGENTS.forEach(a => {
    db.run('INSERT OR IGNORE INTO agents (slug, name, description, status, access, sort_order) VALUES (?,?,?,?,?,?)', a);
  });
  // ChatBot must be available to everyone. If an older row exists (or someone flipped
  // it), force it back to active/all so it never silently disappears for members.
  db.run("UPDATE agents SET status = 'active', access = 'all' WHERE slug = 'chatbot'");
  db.run("UPDATE agents SET status = 'active', access = 'system' WHERE slug = 'talk-ai'");
  // One chat agent (ChatBot) and TalkAi. The others are retired: their rows stay so old chats keep their
  // agent's name, but they are never listed, chosen or routed to.
  db.run("UPDATE agents SET status = 'retired' WHERE slug NOT IN ('chatbot', 'talk-ai')");
  // Per-member agent access. If a member has NO rows here, they get ALL active agents
  // (default-allow). If they have rows, they get ONLY those agents (allow-list).
  db.run(`CREATE TABLE IF NOT EXISTS member_agents (
    member_id INTEGER NOT NULL,
    agent_slug TEXT NOT NULL,
    PRIMARY KEY (member_id, agent_slug)
  )`);
  // ChatBot is available to everyone. Members with NO rows already get every agent
  // (default-allow), but members who were given an explicit allow-list before ChatBot
  // existed would be missing it — backfill those so nobody has to be granted it by hand.
  db.run(
    "INSERT OR IGNORE INTO member_agents (member_id, agent_slug) " +
    "SELECT DISTINCT member_id, 'chatbot' FROM member_agents",
    function (err) {
      if (!err && this && this.changes) console.log('CHATBOT_ACCESS backfilled for ' + this.changes + ' member(s)');
    });
  // Domain Knowledge: admin-authored docs shared with all or selected agents.
  // agents = JSON array of slugs, or the string 'all' meaning every agent.
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    agents TEXT DEFAULT 'all',
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`, () => {
    // Product guides are big and specific. Tagging them lets the prompt pull in
    // ONLY the family being discussed, instead of every guide on every request.
    db.run("ALTER TABLE knowledge_docs ADD COLUMN kind TEXT DEFAULT 'doc'", () => {});
    db.run('ALTER TABLE knowledge_docs ADD COLUMN family TEXT', () => {});
  });
  // Files (Word/PDF) attached to a knowledge doc. Stored on disk; extracted text kept for agents.
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    filename TEXT,
    mimetype TEXT,
    path TEXT,
    extracted_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Order requests raised from ChatBot. These are DRAFTS, not CRM orders — Nova
  // has no write access to the AxiomPrint order system, so this captures a
  // complete, checked request that an AM (or a future order API) can act on.
  db.run(`CREATE TABLE IF NOT EXISTS order_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT,
    created_by TEXT,
    client_id INTEGER,
    client_name TEXT,
    product_id INTEGER,
    product TEXT,
    quantity INTEGER,
    list_price REAL,
    price REAL,
    discount_name TEXT,
    discount_percent REAL,
    specs TEXT,
    job_name TEXT,
    needed_by TEXT,
    artwork TEXT,
    po_number TEXT,
    notes TEXT,
    source_estimate TEXT,
    status TEXT DEFAULT 'draft',
    remote_ref TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Printing jargon: what clients say -> the words the product data uses.
  // A table rather than code, so the team can add terms as they hear them
  // without waiting on a deploy.
  db.run(`CREATE TABLE IF NOT EXISTS print_jargon (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT UNIQUE,
    expands_to TEXT,
    category TEXT DEFAULT 'general',
    note TEXT,
    active INTEGER DEFAULT 1,
    hits INTEGER DEFAULT 0,
    created_by TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`, () => { seedJargon(); loadJargon(); });

  // Words people searched for that matched nothing — the queue of terms worth
  // teaching the system. Answers "how do we find out what's missing".
  db.run(`CREATE TABLE IF NOT EXISTS jargon_misses (
    term TEXT PRIMARY KEY,
    misses INTEGER DEFAULT 1,
    last_query TEXT,
    last_seen TEXT DEFAULT (datetime('now'))
  )`);

  // Per-user ChatBot widget preferences (size, side, colour, font, width).
  // Keyed on the same user_key the rest of the app uses ('user:name' / 'member:email')
  // so a person's settings follow them to any browser they sign in from.
  db.run(`CREATE TABLE IF NOT EXISTS widget_prefs (
    user_key TEXT PRIMARY KEY,
    prefs TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // Team meeting notes — global business knowledge (not tied to one agent).
  // Pasted straight from Meet AI summaries so training discussions aren't lost.
  db.run(`CREATE TABLE IF NOT EXISTS meeting_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    meeting_date TEXT,
    body TEXT,
    attendees TEXT,
    tags TEXT,
    active INTEGER DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // Per-member Domain Knowledge access level: 'none' | 'own' | 'all'. Default 'none'.
  db.run("ALTER TABLE members ADD COLUMN knowledge_access TEXT DEFAULT 'none'", () => {});
  // Promote a member to full admin (sees Users, all history, agent training).
  db.run('ALTER TABLE members ADD COLUMN is_admin INTEGER DEFAULT 0', () => {});
  // Candidates the admin chose to ignore (so they stop appearing)
  db.run(`CREATE TABLE IF NOT EXISTS dismissed_candidates (
    message_id INTEGER PRIMARY KEY,
    agent_slug TEXT,
    dismissed_at TEXT DEFAULT (datetime('now'))
  )`);
  // Installation & delivery rates, edited in Admin → Installation Pricing.
  // One live row (id=1) holding the whole config as JSON; every save also
  // writes a history row so a bad edit can be traced and undone.
  db.run(`CREATE TABLE IF NOT EXISTS install_pricing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS install_pricing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config TEXT NOT NULL,
    changed_by TEXT,
    note TEXT,
    changed_at TEXT DEFAULT (datetime('now'))
  )`, () => loadInstallPricing());
});

// ---- Installation & delivery pricing (config lives in SQLite, engine is shared) ----
// The engine file is the same one the browser loads, so chat and calculator
// can never disagree about a number.
const InstallPricing = require('./public/install-pricing.js');
let installPricing = InstallPricing.withDefaults(null);
let installPricingMeta = { updated_by: null, updated_at: null, is_default: true };
function loadInstallPricing() {
  db.get('SELECT config, updated_by, updated_at FROM install_pricing WHERE id = 1', [], (e, row) => {
    if (e || !row) { installPricing = InstallPricing.withDefaults(null); installPricingMeta = { is_default: true }; return; }
    try {
      installPricing = InstallPricing.withDefaults(JSON.parse(row.config));
      installPricingMeta = { updated_by: row.updated_by, updated_at: row.updated_at, is_default: false };
    } catch (err) {
      console.error('install_pricing config unreadable, using defaults:', err.message);
      installPricing = InstallPricing.withDefaults(null);
    }
  });
}

// ---- Driving distance and time from the shop ----
// Every install and delivery is measured from the Glendale shop (config
// `origin`). With GOOGLE_ROUTES_API_KEY in .env, Google's Routes API gives
// road miles and, for a future date and time, a real traffic prediction.
// Without a key, OpenStreetMap does it for free: Nominatim finds the address,
// OSRM gives road miles and free-flow minutes, and the admin traffic factors
// turn that into a traffic estimate.
const ROUTE_CACHE = new Map();          // address|provider -> { at, value }
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;
const ROUTE_UA = 'AxiomPrint-Nova/1.2 (order@axiomprint.com)';

// Wall-clock time in Los Angeles -> epoch ms. The shop's schedule is local, and
// the server clock may not be.
function laEpoch(dateISO, hhmm) {
  const m = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m || !t) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const g = k => +parts.find(p => p.type === k).value;
  const asLA = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return guess + (guess - asLA);
}

// "11:00 AM" / "5 PM" / "17:30" -> "HH:MM", or '' when it is not a time.
function toTime24(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
  if (!m) return '';
  let h = parseInt(m[1], 10); const mi = m[2] || '00'; const ap = (m[3] || '').toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return (h < 10 ? '0' : '') + h + ':' + mi;
}

async function osmGeocode(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us' +
    '&viewbox=-119.2,34.9,-117.3,33.3&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': ROUTE_UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('Address lookup failed (HTTP ' + r.status + ')');
  const j = await r.json();
  return Array.isArray(j) && j[0] ? { lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name } : null;
}

async function routeViaOsm(address) {
  const origin = await osmGeocode(installPricing.origin.replace(/^AxiomPrint,\s*/i, ''));
  if (!origin) throw new Error('Could not locate the shop address');
  let dest = await osmGeocode(address), approximate = false;
  // "Vons, Sun Valley, CA" — a business name the map does not know. Fall back to
  // the rest of the address and say the distance is approximate.
  if (!dest && address.indexOf(',') > -1) {
    dest = await osmGeocode(address.split(',').slice(1).join(',').trim());
    approximate = !!dest;
  }
  if (!dest) return { ok: false, error: 'Could not find "' + address + '" on the map — enter the miles by hand.' };
  const r = await fetch('https://router.project-osrm.org/route/v1/driving/' +
    origin.lon + ',' + origin.lat + ';' + dest.lon + ',' + dest.lat + '?overview=false',
    { headers: { 'User-Agent': ROUTE_UA }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('Routing failed (HTTP ' + r.status + ')');
  const j = await r.json();
  const route = j && j.routes && j.routes[0];
  if (!route) return { ok: false, error: 'No driving route found to that address.' };
  return { ok: true, meters: route.distance, seconds: route.duration, live_seconds: null,
           matched: dest.label, approximate: approximate, source: 'openstreetmap' };
}

// Google Routes API (computeRoutes). The key lives in .env as GOOGLE_ROUTES_API_KEY
// (GOOGLE_MAPS_API_KEY is accepted too). With a future date and time it asks for
// Google's traffic prediction (TRAFFIC_AWARE); otherwise the cheapest
// TRAFFIC_UNAWARE route, and the admin traffic factors estimate the traffic.
const routesKey = () => process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
async function routeViaGoogle(address, departEpoch) {
  const dep = departEpoch && departEpoch > Date.now() + 60 * 1000 ? new Date(departEpoch).toISOString() : null;
  const body = {
    origin: { address: installPricing.origin.replace(/^AxiomPrint,\s*/i, '') },
    destination: { address: address },
    travelMode: 'DRIVE',
    routingPreference: dep ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
    units: 'IMPERIAL',
    regionCode: 'us'
  };
  if (dep) body.departureTime = dep;
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': routesKey(),
               'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.staticDuration' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // A key / billing / permission problem, not an address problem.
    const err = new Error('Google Routes ' + r.status + ': ' + ((j.error && (j.error.status + ' ' + j.error.message)) || 'error'));
    err.keyProblem = true;
    throw err;
  }
  const route = j.routes && j.routes[0];
  if (!route || route.distanceMeters == null) {
    return { ok: false, error: 'Google could not route to "' + address + '" — check the address or enter the miles by hand.' };
  }
  const secs = (v) => v ? parseInt(String(v).replace(/s$/, ''), 10) : null;
  const withTraffic = secs(route.duration), free = secs(route.staticDuration) || withTraffic;
  return { ok: true, meters: route.distanceMeters, seconds: free,
           live_seconds: dep ? withTraffic : null,
           matched: address, approximate: false, source: 'google' };
}

// { ok, miles, minutes (no traffic), traffic_minutes, traffic, traffic_label,
//   live (true = Google's prediction for that time), source, matched, approximate }
async function routeLookup(address, opts) {
  opts = opts || {};
  address = String(address || '').trim();
  if (!address) return { ok: false, error: 'No address' };
  if (/^at\s+axiom|axiomprint\s*(shop)?$|in[- ]shop/i.test(address)) {
    return { ok: true, miles: 0, minutes: 0, traffic_minutes: 0, source: 'shop', matched: 'At AxiomPrint' };
  }
  const useGoogle = !!routesKey();
  const departEpoch = laEpoch(opts.date, opts.time);
  const cacheKey = address.toLowerCase() + '|' + (useGoogle ? 'g|' + (departEpoch || '') : 'osm');
  const hit = ROUTE_CACHE.get(cacheKey);
  let base;
  if (hit && Date.now() - hit.at < ROUTE_TTL_MS) base = hit.value;
  else {
    try {
      if (useGoogle) {
        try { base = await routeViaGoogle(address, departEpoch); }
        catch (ge) {
          // Google refused (key, billing, IP restriction) or is down: keep quoting
          // with OpenStreetMap rather than failing the estimate.
          console.error('ROUTE google failed, using OpenStreetMap:', ge.message);
          base = await routeViaOsm(address);
        }
      } else base = await routeViaOsm(address);
    } catch (e) {
      console.error('ROUTE lookup failed:', e.message);
      return { ok: false, error: 'Distance lookup is unavailable right now (' + e.message + ') — enter the miles by hand.' };
    }
    if (base.ok) ROUTE_CACHE.set(cacheKey, { at: Date.now(), value: base });
  }
  if (!base.ok) return base;

  // Traffic: Google's own prediction when it gave one for a future time;
  // otherwise road time × the admin traffic factor for that time of day.
  const D = installPricing.delivery;
  const trafficId = InstallPricing.trafficFor(opts.time, installPricing) || D.default_traffic;
  const tr = D.traffic.find(t => t.id === trafficId) || D.traffic[0];
  const minutes = Math.round(base.seconds / 60);
  const live = base.live_seconds != null;
  return {
    ok: true,
    miles: Math.round(base.meters / 1609.344 * 10) / 10,
    minutes: minutes,
    traffic_minutes: live ? Math.round(base.live_seconds / 60) : Math.round(minutes * Number(tr.factor || 1)),
    traffic: tr.id,
    traffic_label: tr.label.split(' (')[0],
    live: live,
    source: base.source,
    matched: base.matched,
    approximate: !!base.approximate
  };
}

const dbConfig = {
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB,
  ssl: { rejectUnauthorized: false }
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const mountMcp = require('./mcp');
// Reports (client follow-up, top clients, unpaid invoices, product sales) —
// read-only queries drawn by public/nova-report.js. One connection per run.
const Reports = require('./reports')({ openConn: () => mysql.createConnection(dbConfig) });

// ---- Gmail (read-only, impersonating the shared order@ inbox) ----
const GMAIL_USER = 'order@axiomprint.com';
let gmailClient = null;
function getGmail() {
  if (gmailClient) return gmailClient;
  const key = JSON.parse(fs.readFileSync('/opt/axiom-ai/gmail-key.json', 'utf8'));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: GMAIL_USER
  });
  gmailClient = google.gmail({ version: 'v1', auth });
  return gmailClient;
}

// ---- Sending email (Gmail API, as order@axiomprint.com) ----
// Needs the gmail.send scope added to the service account's domain-wide delegation in Google Admin
// (Security → API controls → Domain-wide delegation → the client id of gmail-key.json). Used for
// NovaAI's escalations (past-due jobs). MAIL_FROM in .env changes the sending address.
let gmailSendClient = null;
function getGmailSend() {
  if (gmailSendClient) return gmailSendClient;
  const key = JSON.parse(fs.readFileSync('/opt/axiom-ai/gmail-key.json', 'utf8'));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: process.env.MAIL_FROM || GMAIL_USER
  });
  gmailSendClient = google.gmail({ version: 'v1', auth });
  return gmailSendClient;
}
async function sendMail({ to, subject, text, html, replyTo, bcc }) {
  const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const from = clean(process.env.MAIL_FROM || GMAIL_USER);
  const b64 = (t) => Buffer.from(String(t || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const boundary = 'nova-' + require('crypto').randomBytes(8).toString('hex');
  const lines = ['From: NovaAI <' + from + '>', 'To: ' + clean(to),
    'Subject: =?UTF-8?B?' + Buffer.from(clean(subject), 'utf8').toString('base64') + '?=',
    bcc ? 'Bcc: ' + clean(bcc) : null,                     // Gmail delivers to it and strips the header
    replyTo ? 'Reply-To: ' + clean(replyTo) : null, 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"', '',
    '--' + boundary, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    '--' + boundary, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html || ''),
    '--' + boundary + '--', ''].filter(x => x !== null);
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await getGmailSend().users.messages.send({ userId: 'me', requestBody: { raw: raw } });
  return r && r.data ? r.data.id : null;
}

// ---- Google Drive (read-only, shared Team Drive job folders) ----
let driveClient = null;
function getDrive() {
  if (driveClient) return driveClient;
  const key = JSON.parse(fs.readFileSync('/opt/axiom-ai/gmail-key.json', 'utf8'));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: GMAIL_USER
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

// List image/PDF files within a folder ID, including one level of subfolders (Proof, PrintReadyFiles, etc.)
async function driveFolderFiles(folderId) {
  const drive = getDrive();
  const sharedOpts = { includeItemsFromAllDrives: true, supportsAllDrives: true, corpora: 'allDrives' };
  async function listChildren(fid) {
    const r = await drive.files.list({
      q: "'" + fid + "' in parents and trashed=false",
      fields: 'files(id,name,mimeType,thumbnailLink,webViewLink)',
      pageSize: 100,
      ...sharedOpts
    });
    return r.data.files || [];
  }
  const top = await listChildren(folderId);
  let files = [];
  const subfolders = [];
  top.forEach(f => {
    if (f.mimeType === 'application/vnd.google-apps.folder') subfolders.push(f);
    else if (/^image\//.test(f.mimeType) || f.mimeType === 'application/pdf') files.push(f);
  });
  // one level deep into subfolders (cap to avoid huge folders)
  for (const sf of subfolders.slice(0, 6)) {
    const kids = await listChildren(sf.id);
    kids.forEach(f => {
      if (/^image\//.test(f.mimeType) || f.mimeType === 'application/pdf') {
        files.push({ ...f, _folder: sf.name });
      }
    });
  }
  return files.slice(0, 40);
}

// Resolve a folder ID from a stored value that may be a URL, a bare ID, or a folder NAME
async function resolveFolderId(value) {
  const direct = extractFolderId(value);
  if (direct) return direct;
  // Otherwise treat it as a folder name and search the shared drives for an exact match
  const drive = getDrive();
  const name = String(value).trim().replace(/'/g, "\\'");
  const r = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and name='" + name + "' and trashed=false",
    fields: 'files(id,name)',
    pageSize: 5,
    includeItemsFromAllDrives: true, supportsAllDrives: true, corpora: 'allDrives'
  });
  const folders = r.data.files || [];
  return folders.length ? folders[0].id : null;
}

// Extract a Drive folder ID from a stored link or raw id
function extractFolderId(link) {
  if (!link) return null;
  const s = String(link).trim();
  const m = s.match(/folders\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // bare id only if it has no spaces/slashes and looks like a drive id
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

async function driveFileBytes(fileId) {
  const drive = getDrive();
  const meta = await drive.files.get({ fileId, fields: 'mimeType,name', supportsAllDrives: true });
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data), mime: meta.data.mimeType, name: meta.data.name };
}

function decodeBody(payload) {
  // Walk the MIME tree for text/plain, fall back to text/html stripped
  function find(part, mime) {
    if (!part) return null;
    if (part.mimeType === mime && part.body && part.body.data) return part.body.data;
    if (part.parts) { for (const p of part.parts) { const r = find(p, mime); if (r) return r; } }
    return null;
  }
  let data = find(payload, 'text/plain') || find(payload, 'text/html');
  if (!data) return '';
  let txt = Buffer.from(data, 'base64').toString('utf8');
  txt = txt.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ');
  return txt.slice(0, 1500);
}

async function gmailSearch(query, maxResults) {
  const gmail = getGmail();
  const list = await gmail.users.messages.list({ userId: 'me', q: query || '', maxResults: Math.min(maxResults || 10, 25) });
  const msgs = list.data.messages || [];
  const out = [];
  for (const m of msgs) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = {};
    (full.data.payload.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });
    out.push({
      id: m.id,
      threadId: full.data.threadId,
      from: headers['from'] || '',
      to: headers['to'] || '',
      subject: headers['subject'] || '(no subject)',
      date: headers['date'] || '',
      snippet: full.data.snippet || '',
      body: decodeBody(full.data.payload),
      attachments: listAttachments(full.data.payload)
    });
  }
  return out;
}

function listAttachments(payload) {
  const found = [];
  let idx = 0;
  function walk(part) {
    if (!part) return;
    const fn = part.filename;
    const mime = part.mimeType || '';
    const att = part.body && part.body.attachmentId;
    if (fn && fn.length && att) {
      const size = part.body.size || 0;
      const isImg = /^image\//.test(mime);
      if (!(isImg && size < 15000)) {
        found.push({ index: idx, filename: fn, mimeType: mime, size });
        idx++;
      }
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return found;
}

// Resolve the real attachmentId by message + index (so the model only passes a small index)
async function resolveAttachmentId(messageId, index) {
  const gmail = getGmail();
  const full = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const list = [];
  function walk(part) {
    if (!part) return;
    const att = part.body && part.body.attachmentId;
    if (part.filename && part.filename.length && att) {
      const size = part.body.size || 0;
      const isImg = /^image\//.test(part.mimeType || '');
      if (!(isImg && size < 15000)) list.push({ id: att, mime: part.mimeType });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(full.data.payload);
  return list[index] || null;
}

async function fetchAttachment(messageId, attachmentId) {
  const gmail = getGmail();
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const b64 = (res.data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

async function extractPdfText(buffer) {
  let pdfParse = require('pdf-parse');
  if (typeof pdfParse !== 'function' && pdfParse.default) pdfParse = pdfParse.default;
  // pdf-parse 2.x exports a PDFParse class instead of a function.
  const run = typeof pdfParse === 'function' ? pdfParse(buffer)
    : (async () => {
        const p = new pdfParse.PDFParse({ data: new Uint8Array(buffer) });
        try { return await p.getText({ first: 40 }); } finally { try { await p.destroy(); } catch (e) {} }
      })();
  const data = await Promise.race([
    run,
    new Promise((_, rej) => setTimeout(() => rej(new Error('PDF parse timed out')), 15000))
  ]);
  return (data.text || '').slice(0, 6000);
}

// Extract text from an attached knowledge file (PDF or Word). Returns '' if not extractable.
async function extractFileText(buffer, mimetype, filename) {
  const name = (filename || '').toLowerCase();
  const mt = (mimetype || '').toLowerCase();
  try {
    if (mt.includes('pdf') || name.endsWith('.pdf')) {
      return await extractPdfText(buffer);
    }
    if (mt.includes('word') || mt.includes('officedocument.wordprocessing') || name.endsWith('.docx') || name.endsWith('.doc')) {
      let mammoth;
      try { mammoth = require('mammoth'); } catch (e) { return '(Word file attached — install "mammoth" to extract its text for agents.)'; }
      const result = await mammoth.extractRawText({ buffer });
      return (result.value || '').slice(0, 6000);
    }
    // Plain text, Markdown, CSV: read as is.
    if (mt.startsWith('text/') || /\.(txt|md|csv)$/.test(name)) return buffer.toString('utf8').replace(/\u0000/g, '').slice(0, 20000);
  } catch (e) { return ''; }
  return '';
}

// Ad-hoc read-only SQL from an agent. Uses query() rather than execute() because
// execute() prepares the statement, and MySQL rejects prepared statements that end
// in a semicolon or use syntax the model may reasonably produce.
async function runQueryRaw(sql) {
  const clean = String(sql || '').trim().replace(/;+\s*$/, '');
  const conn = await mysql.createConnection(dbConfig);
  try {
    const [rows] = await conn.query(clean);
    return rows;
  } finally {
    await conn.end();
  }
}

async function runQuery(sql) {
  const conn = await mysql.createConnection(dbConfig);
  const [rows] = await conn.execute(sql);
  await conn.end();
  return rows;
}

// ---- Server-side price calculation (mirrors the in-browser evaluator) ----
function num(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : null; }
// Add N business days to a start date (skips Sat/Sun). Returns a Date.
// AxiomPrint's closed days come from its own calendar: the production `holidays` table (the website's "Closed days"
// panel — "New jobs' due dates skip these days"), loaded into memory by closed-days.js and reloaded hourly.
const closedDays = require('./closed-days')(runQuery);
// The closed days of a year as a Set of 'YYYY-MM-DD' — every business-day count (timelines, due dates, quotes) uses
// this. Until the calendar has loaded once (or if the database is unreachable at boot), the built-in list below.
function usHolidays(year) {
  const fromDb = closedDays.yearSet(year);
  if (fromDb) return fromDb;
  const set = new Set();
  const iso = (y, m, d) => y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0');
  const nthWeekday = (y, month, weekday, n) => {
    if (n > 0) {
      const first = new Date(y, month - 1, 1).getDay();
      const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
      return new Date(y, month - 1, day);
    } else {
      const lastDay = new Date(y, month, 0).getDate();
      const lastDow = new Date(y, month - 1, lastDay).getDay();
      const day = lastDay - ((lastDow - weekday + 7) % 7);
      return new Date(y, month - 1, day);
    }
  };
  const observed = (y, month, d) => {
    const dt = new Date(y, month - 1, d); const dow = dt.getDay();
    if (dow === 6) dt.setDate(dt.getDate() - 1);
    else if (dow === 0) dt.setDate(dt.getDate() + 1);
    return dt;
  };
  const add = (dt) => set.add(iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()));
  // AxiomPrint closes for these major holidays only:
  add(observed(year, 1, 1));                 // New Year's Day
  add(nthWeekday(year, 5, 1, -1));           // Memorial Day (last Mon May)
  add(observed(year, 7, 4));                 // Independence Day
  add(nthWeekday(year, 9, 1, 1));            // Labor Day (1st Mon Sep)
  add(nthWeekday(year, 11, 4, 4));           // Thanksgiving (4th Thu Nov)
  add(observed(year, 12, 25));               // Christmas
  return set;
}
function addBusinessDays(start, n) {
  const d = new Date(start);
  let added = 0;
  let curYear = d.getFullYear();
  let holidays = usHolidays(curYear);
  const isoOf = (dt) => dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (d.getFullYear() !== curYear) { curYear = d.getFullYear(); holidays = usHolidays(curYear); }
    const day = d.getDay();
    if (day !== 0 && day !== 6 && !holidays.has(isoOf(d))) added++;
  }
  return d;
}
// Parse a leading integer (business days) from a turnaround title like "6 Business Days"
function turnaroundDays(title) {
  const m = String(title || '').match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}
function parseWH(title) {
  // Tolerate every way a size gets written: 24x36, 24 x 36, 24" x 36", 24in x 36in,
  // 5x9ft, 4ft x 8ft, 10' x 3'. The unit can sit on either number or neither.
  const m = String(title).match(
    /([0-9]*\.?[0-9]+)\s*(?:"|''|\u201d|\u2032|'|in\b|inch(?:es)?\b|ft\b|foot\b|feet\b)?\s*[xX\u00d7]\s*([0-9]*\.?[0-9]+)\s*(?:"|''|\u201d|\u2032|'|in\b|inch(?:es)?\b|ft\b|foot\b|feet\b)?/);
  return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : null;
}

// Was the size written in feet? Banners and signage usually are, and the
// catalogue stores inches, so this decides whether to multiply by 12.
function sizeInFeet(text) {
  // \b fails against a digit — "5x9ft" has no word boundary before "ft" — so
  // match the unit however it is attached.
  return /[0-9\s](?:ft|foot|feet)\b|[\u2032']/i.test(String(text || ''));
}

function evalFormula(formula, env) {
  if (!formula) return null;
  const tokens = Object.keys(env).sort((a, b) => b.length - a.length);
  let expr = formula;
  tokens.forEach(t => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expr = expr.replace(new RegExp('(?<![A-Za-z0-9_$])' + esc + '(?![A-Za-z0-9_$])', 'g'), '(' + Number(env[t]) + ')');
  });
  expr = expr.replace(/\bfloor\b/gi, 'Math.floor').replace(/\bround\b/gi, 'Math.round');
  expr = expr.replace(/\.\.\./g, '0');
  expr = expr.replace(/(?<!\.)\b(?!Math\b|floor\b|round\b)[A-Za-z_][A-Za-z0-9_]*(\$[A-Za-z0-9_]+)?/g, '0');
  try {
    const fn = new Function('return (' + expr + ');');
    const r = fn();
    return (typeof r === 'number' && isFinite(r)) ? r : null;
  } catch (e) { return null; }
}

async function loadCalc(pid) {
  const prod = await runQuery(
    'SELECT id, title, type, formula, url, image, ' +
    "COALESCE(NULLIF(public_title,''), title) AS display_title FROM product WHERE id = " + pid);
  if (!prod.length || !prod[0].formula) return null;
  // clarify_for_ai is the team's own switch: fields ticked here must never be
  // quietly defaulted — the card flags them so the value gets confirmed rather
  // than guessed. Set per product in the CRM.
  const variables = await runQuery('SELECT id, title, type, `order`, configs, hidden, internal, hasVersions, clarify_for_ai FROM product_variables WHERE product_id = ' + pid + ' ORDER BY `order`');
  // Parse configs JSON (holds wxh flag, min/max dimensions, etc. for size variables)
  variables.forEach(v => {
    v.cfg = {};
    if (v.configs) { try { v.cfg = JSON.parse(v.configs); } catch (e) { v.cfg = {}; } }
  });
  const varIds = variables.map(v => v.id);
  let items = [];
  // redirect_url: some options aren't options at all — they mean "that's a
  // different product". Picking "Smaller Posters" on Bulk Large Posters is really
  // a request for Bulk Small Posters, and the id is the tail of that URL.
  // Hidden options are hidden from the WEBSITE, not from us. An AM can select
  // them, so the chat must be able to as well — Saddle Stitch Booklets keeps its
  // "Custom Size" option hidden, which is why a valid 5x7 looked unorderable.
  // They are flagged so pickers can leave them out of the default list.
  // dayCount is the programmed turnaround length. Never read it from the title —
  // "Express" is 0 days on 483 products and 1 day on 10 others, and
  // "4-5 Business Days" is 5. Only this column knows.
  if (varIds.length) items = await runQuery('SELECT id, variable_id, title, value, base, isHidden, `default`, `order`, custom, image, material_id, highlighted, redirect_url, dayCount FROM product_variable_item WHERE variable_id IN (' + varIds.join(',') + ') ORDER BY variable_id, `order`');
  variables.forEach(v => { v.items = items.filter(it => it.variable_id === v.id); });
  return { product: prod[0], variables };
}

// Load a product's rich content (SEO keywords, info, FAQ, and the AI-training field)
// for use in reasoning and reply drafting. Returns a compact text block (or '').
async function loadProductKnowledge(pid) {
  if (!pid) return '';
  try {
    const rows = await runQuery('SELECT title, public_title, meta_keywords, added_keywords, meta_description, information, faq, ai_training FROM product WHERE id = ' + parseInt(pid));
    if (!rows.length) return '';
    const p = rows[0];
    const parts = [];
    parts.push('PRODUCT: ' + (p.public_title || p.title || ''));
    // Keywords (merge meta + added)
    let kw = [];
    if (p.meta_keywords) kw = kw.concat(String(p.meta_keywords).split(/[,;]/).map(s => s.trim()).filter(Boolean));
    if (p.added_keywords) { try { const arr = JSON.parse(p.added_keywords); if (Array.isArray(arr)) kw = kw.concat(arr.map(String)); } catch (e) {} }
    kw = Array.from(new Set(kw)).slice(0, 40);
    if (kw.length) parts.push('KEYWORDS: ' + kw.join(', '));
    if (p.meta_description) parts.push('DESCRIPTION: ' + stripHtml(p.meta_description).slice(0, 400));
    if (p.information) parts.push('INFO: ' + stripHtml(p.information).slice(0, 1200));
    // FAQ
    if (p.faq) {
      try {
        const faq = JSON.parse(p.faq);
        if (Array.isArray(faq) && faq.length) {
          const q = faq.slice(0, 6).map(f => 'Q: ' + (f.question || f.q || '') + '\nA: ' + stripHtml(f.answer || f.a || '')).join('\n');
          if (q.trim()) parts.push('FAQ:\n' + q.slice(0, 1500));
        }
      } catch (e) {}
    }
    // AI training field — the most important: explicit guidance for this product.
    if (p.ai_training) {
      let at = p.ai_training;
      if (typeof at === 'string') { const t = at.trim(); if (t.startsWith('{') || t.startsWith('[')) { try { at = JSON.parse(t); } catch (e) {} } }
      let atText = (typeof at === 'string') ? at : JSON.stringify(at, null, 1);
      atText = stripHtml(atText).slice(0, 2000);
      if (atText.trim()) parts.push('AI TRAINING (authoritative guidance for this product):\n' + atText);
    }
    return parts.join('\n\n');
  } catch (e) { return ''; }
}

// Strip HTML tags to plain text for prompt use.
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

// Build the public website URL for a product. The `url` field already includes the id.
function productUrl(id, urlSlug) {
  if (!urlSlug) return null;
  const s = String(urlSlug).replace(/^\/+|\/+$/g, '');
  return 'https://axiomprint.com/product/' + s;
}

function tokensFor(v) {
  const t = (v.title || '').trim();
  return Array.from(new Set([t.replace(/\s+/g, '_'), t, t.replace(/\s+/g, '')])).filter(Boolean);
}

// Build env from chosen items, compute price for a given quantity item
function priceWith(calc, chosen, qtyItem, customWH, versions) {
  const env = {};
  const vCount = (versions && Number(versions) > 0) ? Number(versions) : 1;
  calc.variables.forEach(v => {
    const it = chosen[v.id];
    if (!it) return;
    const val = (it.value == null || it.value === '') ? 0 : Number(it.value);
    const baseVal = (it.base == null) ? 0 : Number(it.base);
    let wh = parseWH(it.title);
    // If this is the Size variable and a custom W/H was supplied, use it
    if (customWH && /size/i.test(v.title)) wh = { w: customWH.w, h: customWH.h };
    tokensFor(v).forEach(k => {
      env[k] = val; env[k + '$base'] = baseVal; env[k + '$versionsCount'] = vCount;
      if (wh) { env[k + '$w'] = wh.w; env[k + '$h'] = wh.h; }
    });
  });
  if (qtyItem) {
    const qv = Number(qtyItem.value) || 0;
    env['Qty'] = qv; env['Quantity'] = qv;
    env['Qty$base'] = Number(qtyItem.base) || 0; env['Quantity$base'] = Number(qtyItem.base) || 0;
    env['Qty$versionsCount'] = vCount; env['Quantity$versionsCount'] = vCount;
  }
  return evalFormula(calc.product.formula, env);
}

// Work out a client's discount for one product.
// Precedence is most-specific-first: an explicit product rule beats a category
// rule, which beats the site-wide rate. Returns null when there is no discount.
async function discountFor(clientId, productId) {
  const cid = parseInt(clientId), pid = parseInt(productId);
  if (!cid || !pid) return null;
  try {
    // SELECT * on purpose: the live customer table has discount_option_id but NOT
    // discount_options. Naming a missing column made this query fail, and the
    // catch below turned that into "no discount" for every account.
    const cust = await runQueryRaw('SELECT * FROM customer WHERE id = ' + cid + ' LIMIT 1');
    if (!cust.length) return null;

    // Usually a single model id; some accounts carry a JSON list.
    const ids = [];
    if (cust[0].discount_option_id) ids.push(Number(cust[0].discount_option_id));
    if (cust[0].discount_options) {
      try {
        const extra = JSON.parse(cust[0].discount_options);
        if (Array.isArray(extra)) extra.forEach(x => {
          const n = Number(x && x.id != null ? x.id : x);
          if (n && ids.indexOf(n) === -1) ids.push(n);
        });
      } catch (e) {}
    }
    if (!ids.length) return null;

    const prod = await runQueryRaw('SELECT product_category_id FROM product WHERE id = ' + pid + ' LIMIT 1');
    const catId = prod.length ? Number(prod[0].product_category_id) : null;

    const models = await runQueryRaw(
      'SELECT id, title, value FROM discount_models WHERE id IN (' + ids.join(',') + ')');

    let best = null;
    models.forEach(m => {
      let v = {};
      try { v = typeof m.value === 'string' ? JSON.parse(m.value) : (m.value || {}); } catch (e) { return; }
      let pct = null, basis = null;
      const byProd = (v.for_products || []).find(x => Number(x.product_id) === pid);
      if (byProd && byProd.value != null) { pct = Number(byProd.value); basis = 'product'; }
      if (pct == null && catId != null) {
        const byCat = (v.for_categories || []).find(x => Number(x.product_category_id) === catId);
        // A category set to 0 is a deliberate exclusion, not a missing rule.
        if (byCat && byCat.value != null) { pct = Number(byCat.value); basis = 'category'; }
      }
      if (pct == null && v.site_wide && v.site_wide.value != null) {
        pct = Number(v.site_wide.value); basis = 'site-wide';
      }
      if (pct != null && isFinite(pct) && pct > 0 && (!best || pct > best.percent)) {
        best = { percent: pct, name: m.title, basis: basis, model_id: m.id };
      }
    });
    return best;
  } catch (e) { console.error('DISCOUNT lookup failed', cid, pid, e.message); return null; }
}

// Resolve a product's options (respecting related-to rules) and price it.
// Shared by the ChatBot pricing tool and the editable calculator, so both give
// exactly the same answer and the dependency rules only exist in one place.
//   opts.options  { "Field Name": "Option Title" }  - loose match, used by the AI
//   opts.itemIds  { variableId: itemId }            - exact, used by the editor
// "Related to" rules (product_variable_filters) for one or more products, as
// plain sentences the models can repeat. Two kinds:
//   field-level (product_variable_id)      -> the WHOLE field only shows when …
//   item-level  (product_variable_item_id) -> this ONE option only shows when …
// e.g. Book Dust Jackets: Scoring only appears when Paper Stock is 100# Gloss
// Cover — never with 100# Gloss Text. Answering "do we charge for scoring?"
// without that condition is a wrong answer.
// Returns { field: {varId: [text]}, item: {itemId: [text]}, unlocks: {itemId: [name]},
//           list: {pid: [text]} }.
async function relatedRules(pids) {
  const out = { field: {}, item: {}, unlocks: {}, list: {}, raw: [] };
  pids = (Array.isArray(pids) ? pids : [pids]).map(n => parseInt(n)).filter(Boolean);
  if (!pids.length) return out;
  const inP = pids.join(',');
  const [fieldRows, itemRows, vars] = await Promise.all([
    runQueryRaw('SELECT pvf.product_variable_id AS var_id, pvf.relatedTo, pvf.relatedItems FROM product_variable_filters pvf ' +
      'JOIN product_variables pv ON pv.id = pvf.product_variable_id WHERE pv.product_id IN (' + inP + ') AND pvf.product_variable_item_id IS NULL'),
    runQueryRaw('SELECT pvf.product_variable_item_id AS item_id, pvf.relatedTo, pvf.relatedItems FROM product_variable_filters pvf ' +
      'JOIN product_variable_item pvi ON pvi.id = pvf.product_variable_item_id ' +
      'JOIN product_variables pv ON pv.id = pvi.variable_id WHERE pv.product_id IN (' + inP + ')'),
    runQueryRaw('SELECT id, product_id, title FROM product_variables WHERE product_id IN (' + inP + ')')
  ]);
  if (!fieldRows.length && !itemRows.length) return out;
  const items = vars.length ? await runQueryRaw('SELECT id, variable_id, title, isHidden FROM product_variable_item WHERE variable_id IN (' +
    vars.map(v => parseInt(v.id)).join(',') + ')') : [];
  const varById = {}, itemById = {};
  vars.forEach(v => { varById[Number(v.id)] = v; });
  items.forEach(i => { itemById[Number(i.id)] = i; });
  const nice = (t) => String(t || '').replace(/_/g, ' ');
  const ids = (rel) => {
    try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch (e) { rel = []; }
    return Array.isArray(rel) ? rel.map(Number).filter(Boolean) : [];
  };
  // "Paper Stock is 100# Gloss Cover (not 100# Gloss Text)"
  const cond = (relatedTo, list) => {
    const rv = varById[Number(relatedTo)];
    const ok = list.map(i => itemById[i]).filter(Boolean);
    if (!rv || !ok.length) return null;
    const others = items.filter(i => Number(i.variable_id) === Number(rv.id) && list.indexOf(Number(i.id)) === -1 && Number(i.isHidden) !== 1);
    return nice(rv.title) + ' is ' + ok.map(i => i.title).join(' or ') +
      (others.length && others.length <= 6 ? ' (not ' + others.map(i => i.title).join(', ') + ')' : '');
  };
  const add = (map, k, v) => { (map[k] = map[k] || []).push(v); };
  fieldRows.forEach(r => {
    const v = varById[Number(r.var_id)];
    const list = ids(r.relatedItems), c = cond(r.relatedTo, list);
    if (!v || !c) return;
    const text = nice(v.title) + ' is only offered when ' + c + '.';
    add(out.field, Number(v.id), text);
    add(out.list, Number(v.product_id), text);
    out.raw.push({ pid: Number(v.product_id), var_id: Number(v.id), item_id: null, related_var_id: Number(r.relatedTo), text: text });
    list.forEach(i => add(out.unlocks, i, nice(v.title)));
  });
  itemRows.forEach(r => {
    const it = itemById[Number(r.item_id)];
    const list = ids(r.relatedItems), c = cond(r.relatedTo, list);
    if (!it || !c || Number(it.isHidden) === 1) return;
    const v = varById[Number(it.variable_id)];
    const text = nice(v && v.title) + ' "' + it.title + '" is only available when ' + c + '.';
    add(out.item, Number(it.id), text);
    if (v) add(out.list, Number(v.product_id), text);
    if (v) out.raw.push({ pid: Number(v.product_id), var_id: Number(v.id), item_id: Number(it.id), related_var_id: Number(r.relatedTo), text: text });
    list.forEach(i => add(out.unlocks, i, nice(v && v.title) + ': ' + it.title));
  });
  return out;
}

async function quoteProduct(pid, opts) {
  opts = opts || {};
  const calc = await loadCalc(pid);
  if (!calc || !calc.product) return { ok: false, error: 'Product not found' };

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const qtyVar = calc.variables.find(v => /quantity|qty/i.test(v.title));
  const optionVars = calc.variables.filter(v => !(qtyVar && v.id === qtyVar.id) && (v.items || []).length);

  // What was asked for, by name (AI) or by item id (editor)
  const requestedFor = {};
  const unmatched = [];
  const byId = opts.itemIds || null;
  optionVars.forEach(v => {
    if (byId) {
      const want = byId[v.id] != null ? Number(byId[v.id]) : null;
      if (want) {
        const hit = v.items.find(i => Number(i.id) === want);
        if (hit) requestedFor[v.id] = hit;
      }
      return;
    }
    const want = opts.options || {};
    const key = Object.keys(want).find(k => norm(k) === norm(v.title));
    if (!key) return;
    const asked = norm(want[key]);
    const hit = v.items.find(i => norm(i.title) === asked) ||
                v.items.find(i => norm(i.title).indexOf(asked) > -1) ||
                v.items.find(i => asked.indexOf(norm(i.title)) > -1);
    if (hit) requestedFor[v.id] = hit;
    else unmatched.push({ field: String(v.title).replace(/_/g, ' '), asked: want[key],
                          available: v.items.map(i => i.title), _fromKey: key });
  });

  // FEATURE REQUESTS. "add foil", "with spot UV" — capabilities the person asked
  // for by name. This ONLY reads opts.features, i.e. words the model was told to
  // pass because the person actually said them.
  //
  // It used to also sweep up values the model had filed under an unknown field,
  // and word-match those across every field. That is how a Die Cut Postcards
  // quote picked up Foil and Raised Spot UV nobody asked for: a stray word like
  // "custom" matched "Custom Foil", and the paid option was selected and then
  // labelled "specified". Defaults are almost always right; overriding one is a
  // decision that needs a clear instruction, not a loose word match.
  const featureWords = Array.isArray(opts.features) ? opts.features : [];

  featureWords.forEach(raw => {
    const words = String(raw || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/).filter(w => w.length > 2 &&
        !['and', 'the', 'with', 'for', 'add', 'plus', 'custom', 'option', 'please'].includes(w));
    if (!words.length) return;

    optionVars.forEach(v => {
      if (requestedFor[v.id]) return;
      const fieldWords = norm(v.title);
      // Does the request name THIS field? ("foil" -> Foil Option)
      const namesField = words.some(w => fieldWords.indexOf(norm(w)) > -1 && norm(w).length > 2);
      // Or name one of its options outright? ("40 micron" -> Raised Spot UV)
      const cands = v.items.filter(i => {
        const t = norm(i.title);
        return words.some(w => t.indexOf(norm(w)) > -1 && norm(w).length > 2);
      });

      if (namesField) {
        // They named the field, so they want it ON — pick the first real option.
        const yes = v.items.find(i => !/^(no|none)$/i.test(String(i.title).trim()));
        if (yes) requestedFor[v.id] = yes;
      } else if (cands.length) {
        // They named a specific option. Only honour it when the match is the
        // whole option or a clear phrase, not one incidental word.
        const strong = cands.find(i => {
          const t = norm(i.title);
          return words.filter(w => t.indexOf(norm(w)) > -1).length >= Math.min(2, words.length);
        }) || (words.length === 1 ? cands[0] : null);
        if (strong && !/^(no|none)$/i.test(String(strong.title).trim())) requestedFor[v.id] = strong;
      }
    });
  });

  // Anything resolved as a feature is no longer "unmatched".
  for (let i = unmatched.length - 1; i >= 0; i--) {
    const v = optionVars.find(x => String(x.title).replace(/_/g, ' ') === unmatched[i].field);
    if (v && requestedFor[v.id]) unmatched.splice(i, 1);
  }

  // Related-to rules: an option is selectable only when every rule attached to it
  // is satisfied by the current pick in the related field.
  // Two kinds of rule, both in product_variable_filters:
  //   item-level  (product_variable_item_id set)  -> is THIS option selectable
  //   field-level (product_variable_item_id NULL) -> is the WHOLE field even shown
  // Foil Color is the classic field-level case: it only exists once Foil Option
  // is Digital or Raised. An inactive field must contribute $0, exactly like the site.
  const [fRows, fieldRows] = await Promise.all([
    runQueryRaw(
      'SELECT pvf.product_variable_item_id AS item_id, pvf.relatedTo, pvf.relatedItems ' +
      'FROM product_variable_filters pvf ' +
      'JOIN product_variable_item pvi ON pvi.id = pvf.product_variable_item_id ' +
      'JOIN product_variables pv ON pv.id = pvi.variable_id WHERE pv.product_id = ' + parseInt(pid)),
    runQueryRaw(
      'SELECT pvf.product_variable_id, pvf.relatedTo, pvf.relatedItems ' +
      'FROM product_variable_filters pvf JOIN product_variables pv ON pvf.product_variable_id = pv.id ' +
      'WHERE pv.product_id = ' + parseInt(pid) + ' AND pvf.product_variable_item_id IS NULL')
  ]);
  const depByVar = {};
  (fieldRows || []).forEach(f => {
    let rel = f.relatedItems;
    try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch (e) { rel = []; }
    if (!Array.isArray(rel)) rel = [];
    (depByVar[Number(f.product_variable_id)] = depByVar[Number(f.product_variable_id)] || [])
      .push({ relatedTo: Number(f.relatedTo), items: rel.map(Number) });
  });
  const rulesByItem = {};
  (fRows || []).forEach(f => {
    let rel = f.relatedItems;
    try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch (e) { rel = []; }
    if (!Array.isArray(rel)) rel = [];
    (rulesByItem[Number(f.item_id)] = rulesByItem[Number(f.item_id)] || [])
      .push({ relatedTo: Number(f.relatedTo), items: rel.map(Number) });
  });

  const chosen = {};

  // Resolve the QUANTITY tier first. Turnaround (and sometimes other fields) are
  // gated on quantity via product_variable_filters — e.g. "6 Business Days" only
  // exists at 5000+. Those rules can't be evaluated unless the quantity is already
  // in `chosen`, so without this every quantity-gated option looks selectable.
  let qty = parseInt(opts.quantity) || 0;
  const qtyTiers = qtyVar
    ? (qtyVar.items || []).map(i => ({ v: Number(i.value), it: i }))
        .filter(x => isFinite(x.v) && x.v > 0).sort((a, b) => a.v - b.v)
    : [];
  // An explicit per-version breakdown wins over everything else: when someone
  // lists "Version 1: 20 Media, Version 2: 800 General Admission", the total is
  // the SUM of those, not a number to be divided evenly.
  let versionList = null;
  if (Array.isArray(opts.version_list) && opts.version_list.length) {
    versionList = opts.version_list.map((v, i) => ({
      name: String((v && v.name) || ('V' + (i + 1))),
      quantity: Math.max(0, parseInt(v && v.quantity) || 0)
    }));
    const sum = versionList.reduce((a, b) => a + b.quantity, 0);
    if (sum > 0) qty = sum;
  }
  // "25 of each across 4 versions" is a per-version quantity: the total is 100.
  // Taking it as the total is a 4x underprice, so accept it explicitly.
  const perVersionIn = parseInt(opts.quantity_per_version) || 0;
  const versionsIn = parseInt(opts.versions) || 1;
  if (!versionList && perVersionIn > 0) qty = perVersionIn * Math.max(1, versionsIn);
  // No quantity asked for (opening a product straight into the calculator):
  // fall back to the product's own default tier rather than failing to price.
  if (!qty && qtyTiers.length) {
    // Some products carry more than one tier flagged default — Wheat Paste
    // Poster has both 1 and 10. Take the one the site would show first (lowest
    // `order`), so the same request always produces the same number.
    const defaults = qtyTiers.filter(x => x.it.default == 1);
    if (defaults.length > 1) {
      defaults.sort((a, b) => (Number(a.it.order) || 0) - (Number(b.it.order) || 0));
      console.log('QTY_DEFAULTS product ' + pid + ' has ' + defaults.length +
                  ' defaults (' + defaults.map(d => d.v).join(', ') + ') — using ' + defaults[0].v);
    }
    qty = (defaults[0] || qtyTiers[0]).v;
  }
  let qtyTierItem = null;
  if (qtyVar && qty > 0 && qtyTiers.length) {
    const exact = qtyTiers.find(x => x.v === qty);
    const atOrBelow = qtyTiers.filter(x => x.v <= qty).pop();
    qtyTierItem = (exact || atOrBelow || qtyTiers[0]).it;
    chosen[qtyVar.id] = qtyTierItem;
  }

  const allowed = (item) => {
    const rules = rulesByItem[Number(item.id)];
    if (!rules || !rules.length) return true;
    return rules.every(r => {
      const parent = chosen[r.relatedTo];
      if (!parent) return true;
      return r.items.indexOf(Number(parent.id)) > -1;
    });
  };
  const pickFor = (v) => {
    const req = requestedFor[v.id];
    if (req && allowed(req)) return req;
    const ok = v.items.filter(allowed);
    const pool = ok.length ? ok : v.items;
    return pool.find(i => i.default == 1) || pool[0];
  };

  optionVars.forEach(v => { if (requestedFor[v.id]) chosen[v.id] = requestedFor[v.id]; });
  optionVars.forEach(v => { if (!chosen[v.id]) chosen[v.id] = pickFor(v); });
  const srcOf = {};
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    optionVars.forEach(v => {
      const cur = chosen[v.id];
      if (cur && allowed(cur)) return;
      const p = pickFor(v);
      if (p && (!cur || p.id !== cur.id)) { chosen[v.id] = p; srcOf[v.id] = 'auto'; changed = true; }
    });
    if (!changed) break;
  }

  // Which fields are actually live given what's selected?
  const fieldActive = (varId) => {
    const deps = depByVar[Number(varId)];
    if (!deps || !deps.length) return true;
    return deps.every(dep => {
      const parent = chosen[dep.relatedTo];
      return parent && dep.items.indexOf(Number(parent.id)) > -1;
    });
  };

  // A chosen option that carries a redirect means the job belongs to a DIFFERENT
  // product — "Smaller Posters" on Bulk Large Posters is really Bulk Small
  // Posters. Pricing it here would quote the 24x36 product for an 18x24 job.
  {
    // Also catch the case where the size they asked for isn't on this product but
    // a redirect option covers it — asking for 18x24 on a 24x36-only product
    // should land on the small-poster product, not silently keep 24x36.
    const wantW = Number(opts.width), wantH = Number(opts.height);
    if (isFinite(wantW) && wantW > 0 && isFinite(wantH) && wantH > 0) {
      const sizeVar2 = calc.variables.find(v => /size/i.test(v.title));
      if (sizeVar2) {
        const fits = (sizeVar2.items || []).some(i => {
          const p2 = parseWH(i.title);
          return p2 && ((p2.w === wantW && p2.h === wantH) || (p2.w === wantH && p2.h === wantW));
        });
        const freeSize2 = sizeVar2.type === 'size_new' || sizeVar2.type === 'size_3D';
        if (!fits && !freeSize2) {
          const alt = (sizeVar2.items || []).find(i => i.redirect_url && productIdFromUrl(i.redirect_url));
          if (alt) chosen[sizeVar2.id] = alt;
        }
      }
    }

    const hop = Object.keys(chosen).map(k => chosen[k])
      .find(it => it && it.redirect_url && productIdFromUrl(it.redirect_url));
    if (hop && !opts._redirected) {
      const target = productIdFromUrl(hop.redirect_url);
      if (target && target !== parseInt(pid)) {
        const q2 = await quoteProduct(target, Object.assign({}, opts, {
          _redirected: true,
          _redirectedFrom: parseInt(pid),
          _redirectReason: hop.title
        }));
        if (q2 && !q2.error) {
          q2.redirected = {
            from_id: parseInt(pid),
            from: calc.product.title,
            reason: hop.title,
            to_id: target
          };
          return q2;
        }
      }
    }
  }

  // A size written as text ("5\" x 7\"") is the same request as width 5, height 7.
  // Accepting only the split form meant a stated custom size was silently dropped
  // and the product's default quoted instead.
  if ((!opts.width || !opts.height) && opts.size) {
    const wh = parseWH(String(opts.size));
    if (wh) { opts.width = wh.w; opts.height = wh.h; }
  }
  // A size can also arrive buried in the spec list ("3.5 x 2 on metallic board").
  // Without this it looked unstated, so a value the person actually asked for was
  // labelled a guess and flagged for clarification.
  if ((!opts.width || !opts.height) && Array.isArray(opts.specs)) {
    for (const sp of opts.specs) {
      const wh = parseWH(String(sp));
      if (wh) {
        if (sizeInFeet(String(sp))) { opts.width = wh.w * 12; opts.height = wh.h * 12; }
        else { opts.width = wh.w; opts.height = wh.h; }
        break;
      }
    }
  }

  // Custom width/height.
  // A size_new / size_3D field is a FREE W x H input on the site: the listed
  // options are common presets, and any size within the configs min/max is
  // orderable even when no option is flagged custom. Hang Tags is the case that
  // exposed this — 5x5 is valid (min 1.5, max 6) but isn't in the list.
  let cWH = null;
  let sizeOutOfRange = null;
  const w = Number(opts.width), h = Number(opts.height);
  if (isFinite(w) && w > 0 && isFinite(h) && h > 0) cWH = { w: w, h: h };
  const sizeVar = calc.variables.find(v => v.type === 'size_new' || v.type === 'size_3D' || /size/i.test(v.title));
  if (sizeVar) {
    const cfg = sizeVar.cfg || {};
    const freeSize = (sizeVar.type === 'size_new' || sizeVar.type === 'size_3D');
    const customOpt = (sizeVar.items || []).find(i => i.custom == 1 || /custom/i.test(i.title || ''));
    const sel = chosen[sizeVar.id];
    const isCustomSel = sel && (sel.custom == 1 || /custom/i.test(sel.title || ''));

    // Sitting on an explicit "Custom Size" option with no dimensions: fall back
    // to the product's defaults so the area is never zero.
    if (!cWH && isCustomSel) {
      const dW = Number(cfg.defaultWidth), dH = Number(cfg.defaultHeight);
      if (dW > 0 && dH > 0) cWH = { w: dW, h: dH };
    }

    if (cWH && !isCustomSel) {
      const curWH = sel ? parseWH(sel.title) : null;
      const matchesCurrent = curWH && curWH.w === cWH.w && curWH.h === cWH.h;
      if (!matchesCurrent) {
        // Prefer an exact preset (cheaper, no custom base fee), otherwise keep
        // the free size — flipping to the custom option when there is one.
        const flip = !(cfg.wxh === false || cfg.wxh === 0 || cfg.wxh === '0' || cfg.wxh === 'false');
        const preset = (sizeVar.items || []).find(i => {
          const p2 = parseWH(i.title);
          if (!p2) return false;
          return (p2.w === cWH.w && p2.h === cWH.h) || (flip && p2.w === cWH.h && p2.h === cWH.w);
        });
        // They asked for this size, so it is SPECIFIED — not something the system
        // chose. Marking a stated size as "auto" makes a quote look like it
        // guessed when it did exactly what was asked.
        if (preset) { chosen[sizeVar.id] = preset; requestedFor[sizeVar.id] = preset; cWH = null; }
        else if (customOpt) { chosen[sizeVar.id] = customOpt; requestedFor[sizeVar.id] = customOpt; }
        else if (freeSize) {
          // Kept as a typed custom size. Mark it requested so it reads as
          // "specified" rather than looking like the system chose it.
          if (sel) requestedFor[sizeVar.id] = sel;
        } else { cWH = null; }   // not a free-size field, can't honour it
      }
    }

    // Flag anything outside the product's own limits rather than pricing it silently.
    if (cWH) {
      const minW = Number(cfg.minWidth) || 0, maxW = Number(cfg.maxWidth) || 0;
      const minH = Number(cfg.minHeight) || 0, maxH = Number(cfg.maxHeight) || 0;
      const lo = (minW && cWH.w < minW) || (minH && cWH.h < minH);
      const hi = (maxW && cWH.w > maxW) || (maxH && cWH.h > maxH);
      if (lo || hi) {
        sizeOutOfRange = (hi ? cfg.oversizeErrorMessage : cfg.minSizeErrorMessage) ||
          ('Outside this product\'s size range (' + (minW || '?') + '-' + (maxW || '?') + '" W, ' +
           (minH || '?') + '-' + (maxH || '?') + '" H).');
      }
    }
  }

  const used = optionVars.map(v => {
    const it = chosen[v.id];
    if (!it) return null;
    // Foil Color when Foil Option = No: not shown on the site, so not shown here.
    if (!fieldActive(v.id)) return null;
    let source;
    if (requestedFor[v.id] && requestedFor[v.id].id === it.id) source = 'requested';
    else if (srcOf[v.id] === 'auto') source = 'auto';
    else if (rulesByItem[Number(it.id)] && rulesByItem[Number(it.id)].some(r => chosen[r.relatedTo])) source = 'linked';
    else source = 'default';
    const isSizeCustom = sizeVar && v.id === sizeVar.id && cWH &&
      (it.custom == 1 || /custom/i.test(it.title || ''));
    return {
      variable_id: v.id, item_id: it.id,
      field: String(v.title).replace(/_/g, ' '),
      value: isSizeCustom ? (cWH.w + '" × ' + cWH.h + '" (custom)') : it.title,
      source: source
    };
  }).filter(Boolean);

  // Asked for, but a "Related to" rule kept it out: the field only shows with
  // another selection (Scoring needs a Cover paper), or the option needs a
  // different choice elsewhere. Reported so nobody quotes a job believing it
  // includes something the calculator dropped.
  const notApplied = [];
  {
    const nice = t => String(t || '').replace(/_/g, ' ');
    const varTitle = id => nice((calc.variables.find(x => Number(x.id) === Number(id)) || {}).title);
    const itemTitle = id => {
      for (const x of calc.variables) { const i = (x.items || []).find(y => Number(y.id) === Number(id)); if (i) return i.title; }
      return null;
    };
    optionVars.forEach(v => {
      const req = requestedFor[v.id];
      if (!req) return;
      let rules = null;
      if (!fieldActive(v.id)) rules = depByVar[Number(v.id)];
      else if (chosen[v.id] && Number(chosen[v.id].id) !== Number(req.id)) rules = rulesByItem[Number(req.id)];
      else return;
      notApplied.push({ field: nice(v.title), asked: req.title,
        needs: (rules || []).map(r => varTitle(r.relatedTo) + ' = ' + r.items.map(itemTitle).filter(Boolean).join(' or ')).join('; ') || 'a different selection' });
    });
  }

  // Only ACTIVE fields go into pricing. Dropping an inactive field from `chosen`
  // makes its formula tokens evaluate to 0 — matching the website, where a hidden
  // field costs nothing.
  const chosenActive = {};
  Object.keys(chosen).forEach(vid => { if (fieldActive(Number(vid))) chosenActive[vid] = chosen[vid]; });

  // Price, using the tier resolved above.
  const versions = versionList ? versionList.length : (parseInt(opts.versions) || 1);
  let price = null;
  if (qtyVar) {
    // Use the SAME helper Order Assist uses, so the two agents can never quote
    // different numbers for the same job. It mirrors the site's
    // customCountCalculation: exact tier -> direct calc; between tiers -> linear
    // interpolation between the surrounding tier prices; above the top tier ->
    // the top unit rate; below the smallest -> not orderable.
    // Verified on Postcards 4x6, qty 1300, 2 versions = $132.35, matching the
    // live calculator exactly.
    price = priceForQuantity(calc, chosenActive, qtyVar, qty, cWH, versions);
  } else {
    price = priceWith(calc, chosenActive, null, cWH, versions);
  }

  // Quantity belongs in the spec list too — it is the single spec people check
  // most, and its absence made the table look incomplete. Insert it at its real
  // position in the product's field order (usually just above Turnaround).
  // Quantity, then Versions, then Turnaround — the same order the website uses.
  const productHasVersions = !!(qtyVar && (qtyVar.hasVersions == 1 || qtyVar.hasVersions === '1' || qtyVar.hasVersions === true));
  if (qtyVar && qty > 0) {
    const tierItem = (qtyVar.items || []).find(i => Number(i.value) === qty) || null;
    const qtyOrder = Number(qtyVar.order) || 0;
    let at = used.length;
    for (let i = 0; i < optionVars.length; i++) {
      if ((Number(optionVars[i].order) || 0) > qtyOrder) {
        const vid = optionVars[i].id;
        const idx = used.findIndex(u => u.variable_id === vid);
        if (idx > -1) { at = idx; }
        break;
      }
    }
    used.splice(at, 0, {
      variable_id: qtyVar.id,
      item_id: tierItem ? tierItem.id : null,
      field: 'Quantity',
      // Quantity is per version. On a multi-version run the piece count is
      // qty x versions, and showing only one of those numbers misleads.
      // Quantity is the TOTAL across versions, same as the website's field.
      // Only claim "N per version" when the split is genuinely even — with a real
      // breakdown (20 / 800 / 360 ...) an average is misleading.
      value: (function () {
        if (!productHasVersions || versions < 2) return qty.toLocaleString();
        const even = versionList
          ? versionList.every(v => v.quantity === versionList[0].quantity)
          : true;
        return even
          ? (qty.toLocaleString() + ' total · ' + Math.round(qty / versions).toLocaleString() + ' per version')
          : (qty.toLocaleString() + ' total across ' + versions + ' versions');
      })(),
      source: 'requested',
      isQuantity: true
    });
    // Versions sits directly under Quantity whenever the product supports it,
    // even at 1 — seeing "Versions 1" is how the team knows it was considered.
    if (productHasVersions) {
      // Carry the per-version breakdown so the card can show it on hover, the way
      // the CRM does — "Versions 12" on its own tells nobody what was ordered.
      const detail = versionList
        ? versionList.map((v, i) => ({ n: i + 1, name: v.name, quantity: v.quantity }))
        : (versions > 1
            ? Array.from({ length: versions }, (_, i) => ({
                n: i + 1,
                name: (opts.version_names && opts.version_names[i]) || '',
                quantity: (opts.version_quantities && opts.version_quantities[i] != null)
                  ? opts.version_quantities[i]
                  : Math.floor(qty / versions) + (i < (qty - Math.floor(qty / versions) * versions) ? 1 : 0)
              }))
            : null);
      used.splice(at + 1, 0, {
        field: 'Versions',
        value: String(versions),
        source: versions > 1 ? 'requested' : 'default',
        isVersions: true,
        detail: detail
      });
      // List each version as its own row, the way the CRM does:
      //   Version 1   20 - Media
      // "Versions 12" on its own tells nobody what was ordered, and this shows
      // in the spec table with no dependency on the panel rendering.
      if (detail && detail.length > 1) {
        detail.forEach((v, i) => {
          used.splice(at + 2 + i, 0, {
            field: 'Version ' + v.n,
            value: Number(v.quantity || 0).toLocaleString() + (v.name ? ' - ' + v.name : ' - (unnamed)'),
            source: v.name ? 'requested' : 'default',
            isVersionRow: true,
            versionIndex: i
          });
        });
      }
    }
  }

  // Everything the editor needs to render the form
  const fields = optionVars.filter(v => fieldActive(v.id)).map(v => ({
    id: v.id, title: String(v.title).replace(/_/g, ' '), type: v.type,
    order: Number(v.order) || 0,
    cfg: v.cfg || {},
    // Lets the editor put the W x H inputs directly under the Size dropdown,
    // and only when a custom option is actually selected.
    isSize: !!(sizeVar && v.id === sizeVar.id),
    selected: chosen[v.id] ? chosen[v.id].id : null,
    items: v.items.map(i => ({
      id: i.id, title: i.title,
      custom: (i.custom == 1 || /custom/i.test(i.title || '')) ? true : undefined,
      allowed: (function () { const s = chosen[v.id]; delete chosen[v.id]; const a = allowed(i); chosen[v.id] = s; return a; })()
    }))
  }));

  // Client discount, if this quote is for a known account.
  const disc = await discountFor(opts.client_id, pid);
  let clientName = null;
  if (opts.client_id) {
    try {
      const cr = await runQueryRaw("SELECT CONCAT(name,' ',last_name) AS n, company_name FROM customer WHERE id = " +
        parseInt(opts.client_id) + ' LIMIT 1');
      if (cr.length) clientName = cr[0].company_name ? (cr[0].n + ' (' + cr[0].company_name + ')') : cr[0].n;
    } catch (e) {}
  }
  const listPrice = price == null ? null : Number(Number(price).toFixed(2));
  const finalPrice = (listPrice != null && disc)
    ? Number((listPrice * (1 - disc.percent / 100)).toFixed(2))
    : listPrice;

  return {
    ok: price != null,
    product: calc.product.title, product_id: parseInt(pid),
    // Fields the team flagged as price-critical for this product that are still
    // on a default. The card marks these rows "Clarify" with a dropdown, so they
    // get settled in place instead of through a round of chat.
    clarify: await (async () => {
      try {
        const norm2 = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
        const open = [];

        // Driven by clarify_for_ai on the field itself. Whatever the team ticks
        // in the CRM is what gets flagged — Size and Quantity everywhere, plus
        // Pages on booklets, Material on labels, and so on. A flagged field that
        // was left on its default is shown with a dropdown, not assumed.
        const flagged = {};
        calc.variables.forEach(v => {
          if (Number(v.clarify_for_ai) === 1) flagged[norm2(v.title)] = v.title;
        });

        used.forEach(u => {
          // Specified beats clarify, always. A value the person asked for is
          // settled — flagging it says "you didn't tell me" about something they
          // did tell us, which reads as the chat not listening.
          if (u.source === 'requested' || u.source === 'specified') return;
          if (u.source !== 'default' && u.source !== undefined) return;
          const f = norm2(u.field);
          if (!flagged[f]) return;
          open.push({
            field: u.field,
            note: 'No ' + String(u.field).replace(/_/g, ' ').toLowerCase() +
                  ' was given — this is the product default.'
          });
        });

        return open.length ? open : undefined;
      } catch (e) { return undefined; }
    })(),
    // When the job is actually ready, from the turnaround that was selected.
    // Shown on the card so a quote never leaves the date to guesswork.
    schedule: (function () {
      try {
        const tv = calc.variables.find(v => /turnaround/i.test(v.title));
        // Fall back to whatever the spec list shows. Reading only from
        // chosenActive meant a turnaround that was resolved another way left the
        // card with no completion date at all.
        const sel = tv ? (chosenActive[tv.id] || chosen[tv.id]) : null;
        let title = sel ? sel.title : null;
        if (!title) {
          const row = used.find(u => /turnaround/i.test(u.field));
          if (row) title = row.value;
        }
        if (!title) return null;

        // The programmed day count. Parsing the title is only a fallback for
        // rows that predate it being filled in.
        let d = (sel && sel.dayCount != null && sel.dayCount !== '')
          ? parseInt(sel.dayCount) : null;
        if (d == null || !isFinite(d)) d = turnaroundDaysOf(title);
        if (d == null) return null;
        // Same-day / zero-day turnarounds can't be promised from a calculator —
        // whether it makes it depends on the floor, not the arithmetic.
        if (d === 0) return { label: title, days: 0, sameDay: true, timeline: [] };

        const t = buildTimeline(d);
        return t ? { label: title, days: d, readyLabel: t.readyLabel, readyDate: t.readyDate,
                     beforeCutoff: t.beforeCutoff, skipped: t.skipped, timeline: t.timeline } : null;
      } catch (e) { return null; }
    })(),
    // Carried so a copied quote can include the product photo.
    product_image: calc.product.image || null,
    product_url: calc.product.url ? ('https://axiomprint.com/product/' + calc.product.url) : null,
    quantity: qty,
    price: finalPrice,
    list_price: listPrice,
    discount: disc ? { percent: disc.percent, name: disc.name, basis: disc.basis,
                       saved: Number((listPrice - finalPrice).toFixed(2)) } : null,
    client_id: opts.client_id ? parseInt(opts.client_id) : null,
    client_name: clientName,
    each: finalPrice == null ? null : Number((finalPrice / Math.max(1, qty)).toFixed(2)),
    size: cWH ? (cWH.w + '" × ' + cWH.h + '"') : null,
    width: cWH ? cWH.w : null, height: cWH ? cWH.h : null,
    specs: used, unmatched: unmatched,
    not_applied: notApplied.length ? notApplied : undefined,
    fields: fields,
    quantities: qtyVar ? qtyVar.items.map(i => ({ id: i.id, title: i.title, value: Number(i.value) })) : [],
    // A size_new / size_3D field always accepts a typed W x H, so the editor
    // should offer the inputs even when no option is flagged "Custom".
    hasCustomSize: !!(sizeVar && (
      sizeVar.type === 'size_new' || sizeVar.type === 'size_3D' ||
      (sizeVar.items || []).some(i => i.custom == 1 || /custom/i.test(i.title || '')))),
    sizeLimits: sizeVar ? {
      minW: Number((sizeVar.cfg || {}).minWidth) || null, maxW: Number((sizeVar.cfg || {}).maxWidth) || null,
      minH: Number((sizeVar.cfg || {}).minHeight) || null, maxH: Number((sizeVar.cfg || {}).maxHeight) || null,
      unit: (sizeVar.cfg || {}).metric || 'inch'
    } : null,
    size_warning: sizeOutOfRange,
    hasVersions: productHasVersions,
    // Whether this product offers Variable Data. Above ~25 designs, versions stop
    // being practical and VDP is the right route. Counts HIDDEN fields too —
    // 24 of the 57 VDP fields in the catalogue are hidden from the website but
    // still orderable by an AM, Postcards #299 among them.
    hasVariableData: !!calc.variables.find(v => /variable/i.test(v.title)),
    maxVersions: 25,
    versions: versions,
    // Base quantity for a new version row. With an explicit breakdown the rows
    // already carry their own numbers, so this is only the starting value.
    per_version: versionList
      ? (versionList[0] ? versionList[0].quantity : qty)
      : ((productHasVersions && versions > 1) ? Math.round(qty / versions) : qty),
    // ALWAYS return a full per-version breakdown when the job has versions, even
    // when the split was even. The card was showing computed defaults while the
    // state behind it stayed empty, so ordering failed with "give every version a
    // quantity" on a form that visibly had them.
    version_names: (function () {
      if (versionList) return versionList.map(v => v.name);
      if (Array.isArray(opts.version_names) && opts.version_names.length === versions) return opts.version_names;
      if (productHasVersions && versions > 1) return Array.from({ length: versions }, (_, i) => 'V' + (i + 1));
      return null;
    })(),
    version_quantities: (function () {
      if (versionList) return versionList.map(v => v.quantity);
      if (Array.isArray(opts.version_quantities) && opts.version_quantities.length === versions) {
        return opts.version_quantities.map(Number);
      }
      if (productHasVersions && versions > 1) {
        const even = Math.floor(qty / versions);
        const rem = qty - even * versions;
        return Array.from({ length: versions }, (_, i) => even + (i < rem ? 1 : 0));
      }
      return null;
    })(),
    qtyOrder: qtyVar ? (Number(qtyVar.order) || 0) : 999,
    error: price == null ? 'Could not price that quantity' : null
  };
}

// Price a single quantity that may NOT be a predefined tier.
// Mirrors the live site's customCountCalculation: exact match -> normal calc;
// below smallest -> null (invalid); above largest -> linear at top unit rate;
// between tiers -> linear interpolation between surrounding tier prices.
function priceForQuantity(calc, chosen, qtyVar, qty, customWH, versions) {
  const q = Number(qty);
  const items = (qtyVar.items || []).map(it => ({ value: Number(it.value), item: it }))
    .filter(x => isFinite(x.value)).sort((a, b) => a.value - b.value);
  if (!items.length) return null;

  // exact tier match -> direct calc
  const exact = items.find(x => x.value === q);
  if (exact) return priceWith(calc, chosen, exact.item, customWH, versions);

  // Build the combined sorted list including the custom value (like dropOptions)
  const combined = items.concat([{ value: q, item: null }]).sort((a, b) => a.value - b.value);
  const index = combined.findIndex(x => x.value === q && x.item === null);

  if (index === 0) return null; // below the smallest tier -> invalid

  const prev = combined[index - 1];
  const prevPrice = priceWith(calc, chosen, prev.item, customWH, versions);
  if (prevPrice == null) return null;

  let total;
  if (index === combined.length - 1) {
    // above the largest tier: scale linearly at the top tier's unit rate
    total = (prevPrice / prev.value) * q;
  } else {
    // between two tiers: linear interpolation between surrounding tier prices
    const next = combined[index + 1];
    const nextPrice = priceWith(calc, chosen, next.item, customWH, versions);
    if (nextPrice == null) return null;
    total = (nextPrice * q - prev.value * nextPrice + next.value * prevPrice - q * prevPrice) / (next.value - prev.value);
  }
  return Math.floor(total * 100) / 100;
}

// ---- Product match scoring --------------------------------------------------
// Turns "how well does this product fit the request" into a 0-100 number the team
// can eyeball. Deliberately simple and explainable: exact/near title matches score
// highest, keyword-only matches score lowest, and the client's own order history
// is a strong boost because a product they've bought before is usually the answer.
function scoreProductMatch(p, hint, extraText) {
  const h = String(hint || '').toLowerCase().trim();
  if (!h) return { score: 0, why: [] };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sing = s => s.split(' ').map(w => w.replace(/s$/, '')).join(' ');
  const title = norm(p.title), pub = norm(p.public_title);
  const nameText = sing(title + ' ' + pub);
  const hN = sing(norm(h));
  const why = [];
  let score = 0;

  if (sing(title) === hN || sing(pub) === hN) { score = 88; why.push('exact product name'); }
  else if (nameText.includes(hN)) {
    // Contains the hint - but a name padded with extra words is a looser match
    // ("Posters" beats "Backlit Poster Film" for the hint "poster").
    const extraWords = Math.max(0, sing(title).split(' ').filter(Boolean).length - hN.split(' ').filter(Boolean).length);
    score = 74 - Math.min(12, extraWords * 3);
    why.push('name match');
  } else {
    const words = hN.split(' ').filter(w => w.length > 2);
    const hay = sing(norm(p._kw || ''));
    const hit = words.filter(w => hay.includes(w));
    if (words.length && hit.length) {
      score = 34 + Math.round((hit.length / words.length) * 22);
      why.push(hit.length + ' of ' + words.length + ' words match');
    } else { score = 28; why.push('keyword match'); }
  }

  // How much of the client's actual wording shows up in this product's name?
  // This is what separates "Wheat Paste Poster" from "Backlit Poster Film" when
  // the client wrote "wheat paste posters".
  const STOP = ['the','and','for','with','need','printing','print','custom','order','please','size','sizes','each','copy','copies','from','they','that','this','have','would','like','some','all','our','your'];
  const reqWords = Array.from(new Set(sing(norm(extraText || '')).split(' ')
    .filter(w => w.length > 3 && STOP.indexOf(w) === -1 && !hN.includes(w))));
  const shared = reqWords.filter(w => nameText.includes(w));
  if (shared.length) {
    score += Math.min(14, shared.length * 7);
    why.push('matches "' + shared.slice(0, 2).join('", "') + '"');
  }

  if (p.ordered > 0) {
    score += 12;
  }

  return { score: Math.max(5, Math.min(99, Math.round(score))), why: why };
}


// Clients routinely list the SAME product at the SAME size once per artwork file
// ("Poster 1: 1 copy 24x36 / Poster 2 set: 1 of ea 24x36 / ..."). On a product whose
// Quantity variable has hasVersions = 1, that is ONE job with N versions, not N
// separate jobs. The extractor splits them line by line, so we merge here in code
// rather than relying on the model to spot it.
function normHint(h) {
  return String(h || '').toLowerCase().trim()
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')
    .split(' ').map(w => w.replace(/s$/, '')).join(' ').trim();
}
function normSize(s) {
  const nums = String(s || '').match(/(\d+(?:\.\d+)?)/g);
  if (!nums || nums.length < 2) return String(s || '').toLowerCase().replace(/\s+/g, '');
  return nums.slice(0, 2).map(Number).sort((a, b) => a - b).join('x');
}
function parseQtyNum(q) {
  const n = parseInt(String(q == null ? '' : q).replace(/,/g, '').replace(/[^0-9]/g, ''), 10);
  return isFinite(n) && n > 0 ? n : null;
}
// "set", "1 of ea", "1 of each" = an unknown number of designs behind one line.
function lineIsAmbiguous(p) {
  const blob = [p.line, p.product_hint, (p.options || []).join(' ')].filter(Boolean).join(' ');
  return /\b(set|each|ea\b|of ea)\b/i.test(blob);
}

function consolidateVersionLines(products) {
  const list = Array.isArray(products) ? products : [];
  if (list.length < 2) return list;

  const groups = new Map();
  list.forEach((p, i) => {
    const key = normHint(p.product_hint) + '|' + normSize(p.size);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Object.assign({ _i: i }, p));
  });

  const out = [];
  groups.forEach(group => {
    if (group.length < 2) { out.push(group[0]); return; }

    let totalQty = 0;
    let anyUnknownQty = false;
    let anyAmbiguous = false;
    const lines = [];
    const opts = [];

    group.forEach((p, idx) => {
      const stated = parseQtyNum(p.quantity);
      const vs = parseQtyNum(p.versions) || 1;
      const ambiguous = lineIsAmbiguous(p);
      if (ambiguous) anyAmbiguous = true;
      if (stated == null) anyUnknownQty = true;
      else totalQty += stated * vs;
      lines.push({
        label: p.line || ('Item ' + (idx + 1)),
        quantity: stated,
        designs: vs,
        ambiguous: ambiguous
      });
      (p.options || []).forEach(o => { if (o && opts.indexOf(o) === -1) opts.push(o); });
    });

    // Each line is at least one distinct design; "set" lines may hide more.
    const designCount = group.reduce((n, p) => n + (parseQtyNum(p.versions) || 1), 0);

    out.push({
      product_hint: group[0].product_hint,
      size: group.find(p => p.size) ? group.find(p => p.size).size : '',
      quantity: (!anyUnknownQty && totalQty > 0) ? String(totalQty) : '',
      versions: String(designCount),
      options: opts,
      consolidated: true,
      version_lines: lines,
      versions_unresolved: anyAmbiguous || anyUnknownQty,
      consolidation_note: 'Merged ' + group.length + ' line items of the same product and size into one job with ' +
        designCount + ' version(s)' +
        (anyAmbiguous ? '. Some lines say "set" or "of each" without a file count, so the version count is a MINIMUM - confirm with the client.' : '.')
    });
  });

  // Preserve the client's original ordering
  return out.sort((a, b) => {
    const ai = a._i == null ? 0 : a._i, bi = b._i == null ? 0 : b._i;
    return ai - bi;
  }).map(p => { delete p._i; return p; });
}

// Build a formatted quote: pick defaults (+overrides), price across quantities
async function buildQuote(pid, opts) {
  const calc = await loadCalc(pid);
  if (!calc) return { error: 'No calculator/formula for this product.' };
  opts = opts || {};
  const overrides = opts.options || {};
  const qtyVar = calc.variables.find(v => /quantity|qty/i.test(v.title));
  const sizeVar = calc.variables.find(v => /size/i.test(v.title));
  // custom_size = { w, h } in inches. Be tolerant: the model sometimes sends it
  // as a JSON string, or as an array of sizes. Normalize to a single {w,h}.
  let cs = opts.custom_size;
  if (typeof cs === 'string') { try { cs = JSON.parse(cs); } catch (e) { cs = null; } }
  if (Array.isArray(cs)) cs = cs[0];  // a quote is ONE size; ignore extras (each size = separate quote)
  const reqWH = (cs && cs.w && cs.h) ? { w: Number(cs.w), h: Number(cs.h) } : null;
  let customWH = null;        // set only when we actually use the Custom option
  let presetSizeItem = null;  // set when a preset size matches the requested dimensions
  let sizeError = null;       // set when the size can't be honored at all
  let sizeWarning = null;     // set when we price but the size is out of limits
  if (reqWH && sizeVar) {
    const cfg = sizeVar.cfg || {};
    // wxh flag (from configs): true/absent = orientation interchangeable; false = orientation fixed
    const flippable = !(cfg.wxh === false || cfg.wxh === 0 || cfg.wxh === '0' || cfg.wxh === 'false');
    // Validate against min/max bounds if present in configs
    const minW = num(cfg.minWidth), maxW = num(cfg.maxWidth), minH = num(cfg.minHeight), maxH = num(cfg.maxHeight);
    const oversize = (maxW && reqWH.w > maxW) || (maxH && reqWH.h > maxH);
    const undersize = (minW && reqWH.w < minW) || (minH && reqWH.h < minH);
    presetSizeItem = sizeVar.items.find(it => {
      const wh = parseWH(it.title);
      if (!wh) return false;
      if (wh.w === reqWH.w && wh.h === reqWH.h) return true;
      if (flippable && wh.w === reqWH.h && wh.h === reqWH.w) return true;
      return false;
    });
    if (!presetSizeItem) {
      const hasCustom = sizeVar.items.some(it => it.custom == 1 || /custom/i.test(it.title));
      if (hasCustom) {
        customWH = reqWH;
        // Soft warnings - still price, but flag the size issue
        if (oversize) sizeWarning = 'Size exceeds the product limits (max ' + (maxW||'?') + '" W × ' + (maxH||'?') + '" H).';
        else if (undersize) sizeWarning = 'Size is below the product minimum (min ' + (minW||'?') + '" W × ' + (minH||'?') + '" H).';
      } else {
        // Truly cannot honor: no custom option and no preset match
        sizeError = 'This product has no custom-size option and no preset matches ' + reqWH.w + '" × ' + reqWH.h + '". It cannot be auto-quoted at that size — needs the team to quote manually.';
      }
    }
  }
  if (sizeError) return { error: sizeError.trim() };
  const chosen = {};
  const chosenLabels = [];
  calc.variables.forEach(v => {
    if (qtyVar && v.id === qtyVar.id) return; // handle qty separately
    let pick = null;
    if (sizeVar && v.id === sizeVar.id && reqWH) {
      if (presetSizeItem) {
        // Case 2: matched a preset size - use it (cheaper, standard automation)
        pick = presetSizeItem;
        chosen[v.id] = pick;
        chosenLabels.push({ label: v.title, value: pick.title });
        return;
      } else {
        // Case 1: no preset - use the Custom option with entered dimensions
        pick = v.items.find(it => it.custom == 1) || v.items.find(it => /custom/i.test(it.title));
        if (pick) { chosen[v.id] = pick; chosenLabels.push({ label: v.title, value: reqWH.w + '" W × ' + reqWH.h + '" H (Custom)' }); return; }
      }
    }
    const want = overrides[v.title];
    if (want != null) {
      pick = v.items.find(it => String(it.title).toLowerCase() === String(want).toLowerCase())
        || v.items.find(it => String(it.title).replace(/\s/g,'').toLowerCase().includes(String(want).replace(/\s/g,'').toLowerCase()));
    }
    // No explicit value: use the default item, or leave unselected if the variable has no
    // default (optional/dependent field like Foil Color) so it contributes 0 like the site.
    if (!pick) pick = v.items.find(it => it.default == 1) || (v.items.length === 1 ? v.items[0] : null);
    if (pick) { chosen[v.id] = pick; chosenLabels.push({ label: v.title, value: pick.title }); }
  });

  // Quantities: requested list (any number, tier or custom), else a default ladder
  let lines = [];
  if (qtyVar) {
    if (opts.quantities && opts.quantities.length) {
      lines = opts.quantities.map(q => ({ qty: Number(q), price: priceForQuantity(calc, chosen, qtyVar, Number(q), customWH) }));
    } else {
      lines = qtyVar.items.slice(0, 5).map(qi => ({ qty: Number(qi.value), price: priceWith(calc, chosen, qi, customWH) }));
    }
  }
  return { product: calc.product.title, productId: calc.product.id, url: productUrl(calc.product.id, calc.product.url), specs: chosenLabels, lines, customSize: customWH, warning: sizeWarning };
}

function formatQuote(q) {
  if (q.error) return q.error;
  let out = q.product;
  if (q.customSize) out += ' — Custom Size ' + q.customSize.w + '" W × ' + q.customSize.h + '" H';
  out += '\n\n';
  q.specs.forEach(s => { out += s.label + ': ' + s.value + '\n'; });
  out += '\n';
  q.lines.forEach(l => {
    out += 'Qty ' + Number(l.qty).toLocaleString() + ': ' + (l.price == null ? 'n/a' : '$' + usd2(l.price)) + '\n';
  });
  if (q.warning) out += '\n⚠️ ' + q.warning;
  return out.trim();
}

const DATA_DICTIONARY = `
AXIOMPRINT DATABASE GUIDE (Laravel/Yii MySQL app for a print business)

CLOSED DAYS: the \`holidays\` table is AxiomPrint's own calendar of days the shop is closed (no production, no pick-up;
  they never count as business days — the website skips them for due dates). Columns: name, \`date\`, repeat_on
  ('does_not_repeat' | 'annually_on_same_date'), recurrence JSON (freq none/yearly, month, month_day, interval, ends).
  A yearly row repeats every year from its date. Not the US federal list: e.g. Christmas Eve, New Year's Eve and the
  day after Thanksgiving are closed; observed days are their own rows (Independence Day 2026 = Fri 2026-07-03).

CORE CONCEPT - how a sale works:
- The \`estimate\` table is the central object. Each row = ONE product line item for a customer (NOT a quote). ~1.17M rows.
- A "job number" shown as E1169106 maps directly to estimate.id = 1169106. Strip the "E" prefix.
- An estimate becomes a real SALE when its estimate.estimate_invoiceid points at an invoice with payment_status='paid'.
- *** There is NO invoiceestimate table in this database. Estimates link to invoices ONLY through
  estimate.estimate_invoiceid -> invoice.id (and both belong to a project: estimate.estimate_projectid,
  invoice.invoice_projectid -> project.id). estimate.estimate_invoice_order is the line's position on the invoice
  (0 = first line).

KEY TABLES & COLUMNS:

estimate (the line item / job):
- id (= job number without E prefix)
- estimate_clientid -> customer.id
- estimate_productid -> product.id
- estimate_managerid -> user.id (sales rep)
- estimate_price (line price), estimate_name (item name)
- created, updated (datetime; use 'created' NOT created_at)
- production_status: not_started,in_production,reprint,complete,hard_copy
- DEADLINE: complete_by = the ready-by deadline the system set (Los Angeles time, usually 5:00 PM). production_started_at = the moment the job was approved AND paid and the deadline was set — stored in UTC, so show it with CONVERT_TZ(production_started_at, '+00:00', 'America/Los_Angeles'). The turnaround the customer chose is the estimateoption 'Turnaround' (e.g. '5 Business Days', 'Next Day', 'Express'); the shipping method is estimate_handle.shipping_method (pick_up, shipping, blind_drop_ship, delivery, installation, usps_mail_drop_off, tbd) with shipping_service_code (UPS: 01 Next Day Air, 02 2nd Day Air, 03 Ground, 12 3 Day Select, 13 Next Day Air Saver, 14 Next Day Air Early, 59 2nd Day Air A.M.; FedEx codes are names like FEDEX_GROUND). Explain a deadline as: approved and paid on <date>, <turnaround> turnaround, ready on <complete_by>, then pick-up on that date or the shipping service.
- *** PRODUCTION STATUS WARNING: The estimate.production_status column is OFTEN STALE and unreliable - it frequently still says 'not_started' even when the job is actively in production. NEVER report production status from this column alone. The TRUE current production status comes from qr_scan_history (see below). Always check qr_scan_history before telling anyone a job's production state. ***
- estimate_type: estimate,sample,reprint,color_match,reorder
- estimate_drive_link: the Google Drive folder URL/ID for this job's design files (proofs, print-ready files, customer files). To SHOW a job's files/images, use the view_job_files tool with the job number - it reads this link and lists the images/PDFs. (Note: the older drive_files table is legacy/stale and stops around estimate 1071470 - do NOT use it; estimate_drive_link is the current source.)
- category_id -> productcategory.id

qr_scan_history (THE SOURCE OF TRUTH for production progress):
- estimate_id -> estimate.id
- production_step (e.g. 'printing','cutting','not_started', etc - the step the job was scanned into)
- created_at (when the scan happened)
- To get a job's CURRENT production step: SELECT production_step, created_at FROM qr_scan_history WHERE estimate_id=<n> ORDER BY created_at DESC LIMIT 1. The most recent scan = where the job actually is right now.
- To get the full production timeline: same query without LIMIT, ordered by created_at. This shows when it moved through each step.
- When asked about a job's status or "where is the order", ALWAYS query qr_scan_history (not production_status) and report the latest step + when it was last scanned (e.g. "in Cutting as of 3 hours ago").

logs (detailed event history for an estimate/job):
- estimate_id -> estimate.id, event_type, event (text), created_at
- estimate_stage: ONE row per estimate (estimate_id) = the job's current board column: estimate_stage / estimate_substage. Live jobs: prepress (cad_template = CAD, design, tier_1, tier_2), processing (payment, imposition, production, packing = Dispatch), handling (pickup, shipping, delivery_install, job_merge). Not live: order (new_client, reorder, ongoing, follow_up) and complete (done, canceled, final_payment, ticket). A project (estimate.estimate_projectid -> project.projectname) whose live jobs sit in different columns shows as "Mixed".
- CANCELED jobs: estimate_stage = 'complete' AND estimate_substage = 'canceled'. A canceled job keeps its old prepress_status / production_status (e.g. still 'proof_checking'), its estimate_invoiceid is cleared, and its invoice stays only on the project (invoice.invoice_projectid = estimate.estimate_projectid, total 0, payment_status can still read 'paid') — the website shows that invoice as CANCELED. So the substage is the only reliable sign: never describe a canceled job as in progress, and never count it as a client's last / current order. 'complete' + 'done' = finished. A client's LAST order = their newest estimate that is not canceled and has an invoice (not a quote); a newer canceled one is mentioned only as canceled.
- Promo codes: promo_code (promo_code text, name, type percent/amount, value, min/max_order_price, valid_from/valid_to). A USE is recorded on the invoice: invoice.invoice_promo_code_id = promo_code.id and invoice.invoice_promo_code_discount_value = the dollars taken off. multiple_use = 0 means ONE use per customer (not one use overall — such codes are used by hundreds of clients); promo_code.used only says it was used at least once. "Has client X used code Y" = SELECT 1 FROM invoice WHERE invoice_clientid IN (X and the client's other accounts with the same email) AND invoice_promo_code_id = Y. SavewithNova10 ("Nova Chat Coupon", id 254) is NovaAI's 10% code.
- Useful event_types for production: 'production_step_updated','qr_scanned','estimate_stage_updated'. Also tracks shipping: 'shipping_label_created','tracking_number_updated','product_shipped_email_sent','ready_for_pickup_email_sent'.
- Use logs to answer "was this shipped?", "what happened with this order", or to build a full history.

estimateoption (product configuration - sizes, quantities, options) - KEY-VALUE table:
- estimate_id -> estimate.id
- estimate_option_name (e.g. 'Size','Quantity','Material')
- estimate_option_value (the chosen value)
- *** IMPORTANT: The actual ORDER QUANTITY lives HERE as estimate_option_name='Quantity', estimate_option_value=<number>. Always get quantity from estimateoption. ***
- *** SIZE WARNING: sizes are often stored as internal codes (e.g. '864'), NOT human strings like '24x36'. To match a size you may need to look at distinct estimate_option_value where name='Size' for that product first. Do not assume a literal '24x36' text match will work. ***

product (catalog, ~1300 rows):
- id, title (e.g. 'A-Frame Sidewalk Sign','Retractable Roll Up Banner'), public_title
- product_category_id -> productcategory.id
- NEWEST PRODUCTS: sort by product.id DESC (as the CRM product list does). Do NOT use product.created: a product made by copying another keeps the original's created date (e.g. id 1344, added in 2026, shows 2018). Require a photo (image not empty). Live, public products: active = 1, available_for_websites contains 'axiom_print', available_for_customers NULL or empty (a non-empty JSON list = made for those customers), and not in the productcategory titled 'ClientProduct' (id 115, client-specific products). Several active products are internal tests (titles like 'Test 2', 'Web Dev Test', 'Trading Cards DEMO2', 'Foil Business Cards TEST') and 'Copy of …' duplicates — leave them out of new-product lists.
- Product names may differ from how staff refer to them. Search broadly: WHERE title LIKE '%A-Frame%' OR title LIKE '%Roll Up%'. Show the user the actual product titles you matched.
- *** WEBSITE FILTER: The product table contains products for MULTIPLE websites (AxiomPrint and PrintHorse). This is the AxiomPrint CRM — ALWAYS restrict product searches to AxiomPrint products by adding: AND available_for_websites LIKE '%axiom_print%'. Never show or quote PrintHorse products (available_for_websites contains 'print_horse'). ***
- RICH MATCHING FIELDS: products also have meta_keywords (comma-separated), added_keywords (JSON array), meta_title, public_title, meta_description, information (HTML product info), faq (JSON), and ai_training (authoritative per-product guidance). When matching a client's wording to a product, search these too: WHERE (title LIKE '%x%' OR public_title LIKE '%x%' OR meta_keywords LIKE '%x%' OR added_keywords LIKE '%x%'). When answering questions about a product or drafting a reply, prefer facts from ai_training, then information/faq.

invoice (~127k rows):
- id, invoice_clientid -> customer.id, invoice_managerid -> user.id
- payment_status: paid,unpaid,partial,void  <-- filter paid for real sales
- invoice_total_payment (total), invoice_total_payment_done (paid so far)
- invoice_creation_date (datetime)
- invoice_type: invoice,estimate,bad_debt (use ='invoice' for real invoices; 'estimate' = a quote sent, not yet invoiced)
- invoice_projectid -> project.id
- Line items: SELECT * FROM estimate WHERE estimate_invoiceid = <invoice.id> ORDER BY estimate_invoice_order.
  A line's billed amount is COALESCE(estimate.new_total, estimate.estimate_price) — new_total is after discounts and
  the lines add up to invoice_subtotal_payment; estimate_price is the pre-discount list price.

project (an order / job folder, ~97k): id, projectclientid -> customer.id, projectname, created_at, active.
- A client's "last order" (as in the weekly Client Follow-up report) is MAX(project.created_at) for that client.

dialpad_calls (THE phone log, since 2026-08-10): customer_id -> customer.id, direction ('inbound'|'outbound'),
  call_type ('internal' = staff-to-staff), date_started, conversation_key, is_primary_leg, duration_ms, ai_summary,
  transcript_text. One call that rings several phones creates several rows ("legs") — count calls with
  COUNT(DISTINCT conversation_key). The old \`calls\` table stopped in May 2024; do not use it.

email_from_system (emails the CRM sent): customer_id -> customer.id, to_email, subject, type, estimate_id, invoiceid.
- The send time is sent_at. Rows since spring 2026 leave created_at NULL, so use COALESCE(sent_at, created_at).

customer (~35k): id, name, last_name, email, company_name, phone, manager_id->user.id
user (staff, ~420): id, name, last_name, email, title
invoicepayment: invoice_id->invoice.id, invoice_paymentdone, invoice_paymentdate

CANONICAL QUERY PATTERNS:

1) Look up job E<n>: SELECT * FROM estimate WHERE id=<n>; then customer by estimate_clientid; then SELECT estimate_option_name,estimate_option_value FROM estimateoption WHERE estimate_id=<n>;

1b) READABLE JOB CONFIG (decode the option codes to names - ALWAYS do this when showing a job's specs for a reprint/reorder/quote):
   estimateoption stores numeric COEFFICIENT values (e.g. Paper Stock=0.95), NOT readable names. To get the real option names, join to product_variable_item by matching value:
   SELECT eo.estimate_option_name AS opt, eo.estimate_option_value AS val, pvi.title AS label
   FROM estimateoption eo
   JOIN estimate e ON e.id = eo.estimate_id
   JOIN product_variables pv ON pv.product_id = e.estimate_productid AND pv.title = eo.estimate_option_name
   JOIN product_variable_item pvi ON pvi.variable_id = pv.id AND pvi.value = eo.estimate_option_value
   WHERE eo.estimate_id = <n>;
   *** ACCURACY RULES when reporting decoded specs (critical for reprints): ***
   - If exactly ONE label matches a value, show the name (e.g. "Paper Stock: 14PT Coated Both Sides").
   - If the join returns NO row for an option (value didn't match any item), show the raw value and mark it "(unconfirmed - verify with team)". NEVER substitute the "closest" value - a wrong paper stock on a reprint is a costly error.
   - If MULTIPLE labels share the same value (e.g. Shape where Rectangle/Square/Circle may all =1), list the candidates or note it's ambiguous rather than picking one.
   - Quantity and Turnaround: show the stored value directly (Quantity is the real count; Turnaround maps via the join).

2) Units of a product sold in last year (the right way):
   Join product -> estimate (estimate_productid) -> invoice ON invoice.id = estimate.estimate_invoiceid (paid) and SUM the quantity from estimateoption where name='Quantity'. Filter invoice.payment_status='paid' AND invoice.invoice_creation_date >= DATE_SUB(CURDATE(),INTERVAL 1 YEAR). When the user names a size, first inspect distinct Size option values for that product, then report what you find rather than forcing a 24x36 text match.

3) Revenue: SUM(invoice_total_payment) FROM invoice WHERE payment_status='paid' AND invoice_type='invoice' AND <date>.

4) Top customers: GROUP BY invoice_clientid, SUM(invoice_total_payment), JOIN customer for names.

5) "Where is my order" / status for a client reply (e.g. from an invoice number like INV125472):
   a. Find the invoice: the number after "INV" is invoice.id (INV125472 -> invoice.id=125472). Get invoice_clientid, payment_status, dates.
   b. Find the linked estimate(s)/job: SELECT id FROM estimate WHERE estimate_invoiceid=<invoice_id> ORDER BY estimate_invoice_order. The estimate.id IS the job number (shown as E<id>).
   c. *** Get REAL production status from qr_scan_history (latest scan), NOT production_status. ***
   d. Check logs for shipping events (shipping_label_created, tracking_number_updated, product_shipped_email_sent) to answer whether it shipped.
   e. Summarize for the rep: product, qty, current production step + when last scanned, whether shipped/tracking, and a suggested honest reply. Do NOT claim "not started" unless the latest qr_scan_history scan actually says not_started.

NOTES:
- Ignore tables prefixed old_ or suffixed _old (legacy).
- Date columns: estimate.created, invoice.invoice_creation_date.
- Always filter to paid invoices for "how many did we sell".
- When product names or sizes don't match exactly, surface the closest matches and tell the user what you matched - don't silently return null.

=====================================================================
PRODUCT PRICING CALCULATOR (how to compute a quote for any product)
=====================================================================

Each product has a math formula plus configurable variables (size, quantity, material, finishing, turnaround, etc). To price it you load four things and combine them.

THE FORMULA:
- product.formula is a math expression producing the final price.
- Every token maps to a variable's \`name\` in product_variables. Token Paper_Stock => the variable named Paper_Stock.
- For a selected option: value = per-unit multiplier (scales with quantity); base = flat one-time fee.
- Bare token = selected item's \`value\`. Token with $base suffix = selected item's \`base\`. Applies to all: Shape$base, Finishing$base, Turnaround$base.

TWO PRICE LAYERS:
1. Run cost - scales with quantity, uses value fields.
2. Base fees - flat one-time, uses $base fields (e.g. 16PT +$8, round corners +$8).

SHEET MATH (e.g. business cards):
  ups_per_sheet = floor( (12*18) / ((width+0.25)*(height+0.25)) )  (+0.25 = bleed/gap)
  Run cost = Quantity / ups_per_sheet * (sum of per-unit values).

TURNAROUND IS SPECIAL: its value is a MULTIPLIER on the whole subtotal (1.0 standard, 1.2 rush = +20%); base is an extra flat fee on top.

default FLAG: product_variable_item.default=1 = pre-selected option. One default per variable. Always respect it.

DEPENDENCY FILTERS (product_variable_filters): each rule says an item_id is only available if the selected item in another variable is one of relatedItems (list of item_ids). relatedTo/relatedItems reference product_variable_item.id, not names. If active child becomes invalid after a parent change, switch to first available.

4-STEP QUERY RECIPE:
  1: SELECT id,title,formula FROM product WHERE id=<pid>;
  2: SELECT id,title,name,type,\`order\` FROM product_variables WHERE product_id=<pid> ORDER BY \`order\`;
  3: SELECT id,variable_id,title,value,base,isHidden,\`default\`,\`order\` FROM product_variable_item WHERE variable_id IN (<ids>) AND isHidden=0 ORDER BY variable_id,\`order\`;
  4: SELECT pvf.product_variable_item_id,pvf.relatedTo,pvf.relatedItems FROM product_variable_filters pvf JOIN product_variable_item pvi ON pvf.product_variable_item_id=pvi.id JOIN product_variables pv ON pvi.variable_id=pv.id WHERE pv.product_id=<pid>;

FOR A QUOTE: find product by title, run the recipe, use the user's options (fall back to default=1 for unspecified), substitute each token's value and $base into the formula, evaluate, and show price with a breakdown of run cost vs base fees and which options you assumed.
`;

let tableList = '';
async function loadSchema() {
  try {
    const tables = await runQuery('SHOW TABLES');
    tableList = tables.map(t => Object.values(t)[0]).join(', ');
    console.log('Schema loaded: ' + tables.length + ' tables');
  } catch(e) { console.log('Schema load error:', e.message); }
}
loadSchema();

function auth(req, res, next) {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); }
  catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  // A website visitor's token (client-facing bot) never opens a staff endpoint.
  if (req.user && req.user.kind === 'client') return res.status(401).json({ error: 'Invalid token' });
  next();
}

function adminOnly(req, res, next) {
  if (!req.user) return res.status(403).json({ error: 'Admin only' });
  // Token says admin -> allow.
  if (req.user.is_admin) return next();
  // Otherwise check the live DB: a member promoted to admin AFTER their last login
  // won't have it in their token yet. Honor the current database value.
  const email = String(req.user.key || '').replace(/^member:/, '');
  if (!email) return res.status(403).json({ error: 'Admin only' });
  db.get('SELECT is_admin FROM members WHERE email = ?', [email], (e, m) => {
    if (!e && m && m.is_admin) { req.user.is_admin = true; return next(); }
    return res.status(403).json({ error: 'Admin only' });
  });
}

// Who am I + what can I access. Works for any logged-in user (admin or member).
// Who am I? The single place a frontend confirms its stored token is still good
// and finds out who it belongs to. Returns 401 via the auth middleware when the
// token is missing, expired or from a deleted account.
app.get('/api/me', auth, (req, res) => {
  const key = String(req.user.key || '');
  const email = key.replace(/^member:/, '');
  const base = {
    success: true,
    key: key,
    username: req.user.username,
    is_admin: !!req.user.is_admin,
    display_name: req.user.username,
    email: key.indexOf('member:') === 0 ? email : null,
    photo: null
  };
  if (req.user.is_admin) return res.json(Object.assign(base, { knowledge_access: 'all' }));
  db.get('SELECT display_name, photo, knowledge_access, is_admin, enabled FROM members WHERE email = ?',
    [email], (e, m) => {
      // A member row that has been disabled should not keep a working session.
      if (m && m.enabled === 0) return res.status(401).json({ error: 'Account disabled' });
      res.json(Object.assign(base, {
        is_admin: !!(m && m.is_admin),
        display_name: (m && m.display_name) || req.user.username || email,
        photo: (m && m.photo) || null,
        knowledge_access: (m && m.knowledge_access) || 'none',
        email: email
      }));
    });
});

// Resolve a user's Domain Knowledge access level: 'all' | 'own' | 'none'.
// Admins always get 'all'. Members get their stored knowledge_access (default 'none').
function knowledgeAccessLevel(req) {
  return new Promise((resolve) => {
    if (req.user && req.user.is_admin) return resolve({ level: 'all', author: req.user.username || 'admin', email: null });
    const email = String((req.user && req.user.key) || '').replace(/^member:/, '');
    if (!email) return resolve({ level: 'none', author: null, email: null });
    db.get('SELECT knowledge_access, display_name FROM members WHERE email = ?', [email], (e, m) => {
      const level = (m && m.knowledge_access) ? m.knowledge_access : 'none';
      resolve({ level, author: (m && m.display_name) || email, email });
    });
  });
}

// Middleware: require at least 'own' access to Domain Knowledge.
function knowledgeGuard(req, res, next) {
  knowledgeAccessLevel(req).then(acc => {
    if (acc.level === 'none') return res.status(403).json({ error: 'No access to Domain Knowledge' });
    req.knowledgeAccess = acc;
    next();
  });
}

// --- Admin: member management ---
// Look up an Axiom user by email (to add as a member)
app.post('/api/admin/lookup-user', auth, adminOnly, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    if (!email) return res.json({ success: false, error: 'Email required' });
    const rows = await runQuery('SELECT id, email, name, last_name, title FROM user WHERE email = ' + mysql.escape(email) + ' LIMIT 1');
    if (!rows.length) return res.json({ success: false, error: 'No Axiom user with that email' });
    res.json({ success: true, user: rows[0] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// List all members
app.get('/api/admin/members', auth, adminOnly, (req, res) => {
  db.all('SELECT * FROM members ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, members: rows || [] });
  });
});

// Add a member (by Axiom email)
app.post('/api/admin/members/add', auth, adminOnly, async (req, res) => {
  try {
    const input = String(req.body.email || req.body.identifier || '').trim().toLowerCase();
    if (!input) return res.json({ success: false, error: 'Enter a username or email' });
    // Find the Axiom user by username OR email
    const rows = await runQuery('SELECT id, name, last_name, email, username, memberimage FROM user WHERE LOWER(username) = ' + mysql.escape(input) + ' OR LOWER(email) = ' + mysql.escape(input) + ' LIMIT 1');
    if (!rows.length) return res.json({ success: false, error: 'No Axiom user found for "' + input + '"' });
    const u = rows[0];
    const email = (u.email || '').toLowerCase();
    const uname = (u.username || '').toLowerCase();
    const dn = ((u.name || '') + ' ' + (u.last_name || '')).trim() || uname || email;
    const photo = u.memberimage || null;
    db.run('INSERT OR IGNORE INTO members (email, username, axiom_user_id, display_name, photo, enabled, added_by) VALUES (?,?,?,?,?,1,?)',
      [email, uname, u.id, dn, photo, req.user.username], function (err) {
        if (err) return res.json({ success: false, error: err.message });
        const newId = this.lastID;
        // A new member has no member_agents rows, which already means "all agents"
        // (default-allow), so ChatBot is included. We only need to act if rows exist.
        const ensureChatbot = (mid) => {
          if (!mid) return;
          db.get('SELECT COUNT(*) AS n FROM member_agents WHERE member_id = ?', [mid], (e, r) => {
            if (!e && r && r.n > 0) {
              db.run('INSERT OR IGNORE INTO member_agents (member_id, agent_slug) VALUES (?, ?)', [mid, 'chatbot']);
            }
          });
        };
        if (this.changes === 0) {
          db.run('UPDATE members SET enabled=1, username=?, display_name=?, photo=?, axiom_user_id=? WHERE email=?', [uname, dn, photo, u.id, email], function () {
            // Re-enabled member may have an old allow-list without ChatBot
            db.get('SELECT id FROM members WHERE email = ?', [email], (e2, m) => { if (m) ensureChatbot(m.id); });
            return res.json({ success: true, note: 'Member already existed - re-enabled and updated.' });
          });
        } else {
          ensureChatbot(newId);
          res.json({ success: true });
        }
      });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Enable/disable a member
app.post('/api/admin/members/toggle', auth, adminOnly, (req, res) => {
  const { id, enabled } = req.body;
  db.run('UPDATE members SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Get a member's agent access. Returns { allowed: [slug,...], allAgents: [...], default_all: bool }
// default_all = true means the member has no explicit rows, so they get all active agents.
app.get('/api/admin/members/:id/agents', auth, adminOnly, (req, res) => {
  const memberId = parseInt(req.params.id);
  db.all("SELECT slug, name, status FROM agents WHERE access != 'restricted' ORDER BY sort_order", [], (e, agents) => {
    if (e) return res.json({ success: false, error: e.message });
    db.all('SELECT agent_slug FROM member_agents WHERE member_id = ?', [memberId], (e2, rows) => {
      if (e2) return res.json({ success: false, error: e2.message });
      const allowed = (rows || []).map(r => r.agent_slug);
      if (allowed.length && allowed.indexOf('chatbot') === -1) allowed.push('chatbot');
      res.json({ success: true, allAgents: agents || [], allowed, default_all: allowed.length === 0, alwaysOn: ['chatbot'] });
    });
  });
});

// Set a member's agent access. Body: { id, slugs: [slug,...] }.
// An empty array means "default-allow all" (we clear all rows).
app.post('/api/admin/members/agents', auth, adminOnly, (req, res) => {
  const memberId = parseInt(req.body.id);
  let slugs = Array.isArray(req.body.slugs) ? req.body.slugs.slice() : [];
  if (!memberId) return res.json({ success: false, error: 'No member id' });
  // ChatBot is available to every member by design. If an allow-list is being saved,
  // force it in — unchecking it in the UI must not be able to take it away.
  if (slugs.length && slugs.indexOf('chatbot') === -1) slugs.push('chatbot');
  db.run('DELETE FROM member_agents WHERE member_id = ?', [memberId], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    if (!slugs.length) return res.json({ success: true, default_all: true });
    const stmt = db.prepare('INSERT OR IGNORE INTO member_agents (member_id, agent_slug) VALUES (?, ?)');
    slugs.forEach(s => stmt.run([memberId, s]));
    stmt.finalize(e => {
      if (e) return res.json({ success: false, error: e.message });
      res.json({ success: true, default_all: false });
    });
  });
});

// ===== Domain Knowledge =====
// Access levels: 'all' (see everyone's), 'own' (only own docs), 'none' (no access).
// Admins always have 'all'. Members use members.knowledge_access.

// Report the caller's access level (used by the UI to show/hide the tab).
app.get('/api/knowledge/access', auth, (req, res) => {
  knowledgeAccessLevel(req).then(acc => res.json({ success: true, level: acc.level }));
});

// List knowledge docs visible to the caller (with attachment counts).
// ===== Order requests from ChatBot =====
// Posts to the AxiomPrint order API. The payload mirrors what the website sends:
// every selected option is expanded into an `estimateoption` entry carrying the
// variable id, item id, type, order and value straight from the product tables.

const ORDER_API_URL = process.env.AXIOM_ORDER_API_URL || 'https://laravelapi.axiomprint.com/api/v1/customers/orders';

// "Tue, Aug 18" — the format the order API uses for dates.
function orderDateLabel(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Turn a resolved quote into the API's estimateoption array.
function buildEstimateOptions(calc, chosen, qtyItem, cWH, versionList) {
  const out = [];
  calc.variables.forEach(v => {
    const it = (qtyItem && /quantity|qty/i.test(v.title)) ? qtyItem : chosen[v.id];
    if (!it) return;
    const entry = {
      selected: it.title,
      variabletype: v.type,
      optionname: v.title,
      optionVariableId: v.id,
      optionVariableItemId: it.id,
      optionid: it.id,
      optionvalue: it.value == null ? 0 : Number(it.value),
      order: Number(v.order) || 0,
      highlighted: Number(it.highlighted) || 0
    };
    if (it.image) entry.selected_image = it.image;
    if (it.material_id != null) entry.material_id = it.material_id;
    // Versions belong to the Quantity field on the website's calculator
    // (product_variables.hasVersions), so carry them on that entry too — the
    // estimate-level array alone was silently dropped on E1175597.
    if (versionList && versionList.length > 1 && /quantity|qty/i.test(v.title)) {
      entry.versions = versionList;
      entry.versionsCount = versionList.length;
      entry.hasVersions = 1;
    }
    if (v.type === 'size_new' || v.type === 'size_3D') {
      const cfg = v.cfg || {};
      const oc = { metric: cfg.metric || 'inch' };
      const isCustom = it.custom == 1 || /custom/i.test(it.title || '');
      if (isCustom && cWH) { oc.width = cWH.w; oc.height = cWH.h; }
      else if (cfg.orientation) { oc.orientation = cfg.orientation; }
      entry.optionconfig = JSON.stringify(oc);
    }
    out.push(entry);
  });
  return out.sort((a, b) => a.order - b.order);
}

// What an order needs beyond the priced estimate.
const ORDER_REQUIRED = [
  { key: 'job_name', label: 'Job name', type: 'text', hint: 'What this job is called on the order' },
  { key: 'needed_by', label: 'Needed by', type: 'date', hint: 'Date the client needs it' }
];
// Values below are the ACTUAL enums the CRM stores, taken from
// estimate_design_details.design_type / .proofing and estimate_handle.shipping_method.
// Anything else is rejected by the database, so these strings are not negotiable.
const ORDER_CHOICES = [
  { key: 'shipping_method', label: 'Delivery', type: 'select', options: [
      { value: 'pick_up', label: 'Pick up' },
      { value: 'shipping', label: 'Ship' },
      { value: 'blind_drop_ship', label: 'Blind drop ship' },
      { value: 'tbd', label: 'Decide later (TBD)' } ], default: 'pick_up' },
  { key: 'design_type', label: 'Artwork', type: 'select', options: [
      { value: 'Manual Proof Tier1', label: 'Manual Proof — Tier 1' },
      { value: 'Manual Proof Tier2', label: 'Manual Proof — Tier 2' },
      { value: 'Send the Files Later', label: 'Upload later' },
      { value: 'Work with Our Designers', label: 'Hire a designer' } ], default: 'Manual Proof Tier1' },
  { key: 'proofing', label: 'Proof', type: 'select', options: [
      { value: 'yes_online_pdf', label: 'Online PDF proof' },
      { value: 'yes_hard_copy', label: 'Hard copy proof' },
      { value: 'no', label: 'No proof' } ], default: 'yes_online_pdf' },
  { key: 'payment_term', label: 'Payment', type: 'select', options: [
      { value: 'pay_upon_approval', label: 'Pay on approval' },
      { value: 'net_30', label: 'Net 30' } ], default: 'pay_upon_approval' }
];

// design_type -> the service_level the CRM records alongside it.
const SHIP_METHODS = ['tbd', 'pick_up', 'shipping', 'blind_drop_ship'];
const NEEDS_ADDRESS = ['shipping', 'blind_drop_ship'];
const DESIGN_SERVICE_LEVEL = {
  'Manual Proof Tier1': 'level_1',
  'Manual Proof Tier2': 'level_2'
};
const ORDER_OPTIONAL = [
  { key: 'notes', label: 'Notes', type: 'textarea', hint: 'Anything production or prepress should know' }
];

app.get('/api/chatbot/order-fields', auth, (req, res) => {
  // No client, no form. Returning the fields anyway lets a stale frontend render
  // an order form that cannot possibly be submitted — the person fills it in and
  // only then discovers the problem.
  const clientId = parseInt(req.query.client_id) || 0;
  if (!clientId) {
    return res.json({
      ok: true, needs_client: true, required: [], choices: [], optional: [], live: true,
      message: 'Choose the client first — an order cannot be placed without one.'
    });
  }
  res.json({ ok: true, needs_client: false, required: ORDER_REQUIRED, choices: ORDER_CHOICES,
             optional: ORDER_OPTIONAL, live: true });
});

app.post('/api/chatbot/order-request', auth, async (req, res) => {
  const b = req.body || {};
  const missing = ORDER_REQUIRED.filter(f => !String(b[f.key] || '').trim()).map(f => f.label);
  if (!b.product_id || !b.quantity) missing.push('Product and quantity');
  if (!b.client_id) missing.push('Client');
  if (!b.shipping_method) missing.push('Delivery method');
  // Only the methods that actually go somewhere need an address. TBD does not.
  if (['shipping', 'blind_drop_ship'].indexOf(b.shipping_method) > -1 && !b.address_id) {
    missing.push('Shipping address');
  }
  // If the QUOTE has versions, the ORDER must carry them. Without this a
  // multi-version job can be created as a plain run — which is what happened on
  // E1175597: correct quantity, but estimate_handle.versions came back NULL and
  // production had no idea it was two designs.
  const quotedVersions = parseInt(b.versions) || 0;
  if (quotedVersions > 1 && !(Array.isArray(b.version_names) && b.version_names.length === quotedVersions)) {
    missing.push('Version names and quantities (this quote has ' + quotedVersions + ' versions)');
  }
  // Versions must be complete: every one named, every one with a quantity, and
  // the total must equal their sum — that is how the CRM stores it.
  if (Array.isArray(b.version_names) && b.version_names.length > 1) {
    const blanks = b.version_names.map((n, i) => (String(n || '').trim() ? null : i + 1)).filter(Boolean);
    if (blanks.length) missing.push('Version name for ' + blanks.join(', '));
    const qs = Array.isArray(b.version_quantities) ? b.version_quantities.map(Number) : [];
    if (qs.length !== b.version_names.length || qs.some(x => !isFinite(x) || x <= 0)) {
      missing.push('A quantity for every version');
    }
  }
  if (missing.length) return res.json({ ok: false, missing: missing });

  const who = (req.user && (req.user.username || req.user.email)) || 'unknown';
  let payload = null;

  try {
    // Rebuild the quote server-side. The browser is never trusted for price or
    // option ids on something that creates a real order.
    const q = await quoteProduct(parseInt(b.product_id), {
      itemIds: b.item_ids || {},
      options: b.options || {},
      quantity: parseInt(b.quantity),
      width: b.width, height: b.height,
      client_id: b.client_id,
      versions: b.versions,
      // Keep the exact per-version split through to the order.
      version_list: (Array.isArray(b.version_names) && Array.isArray(b.version_quantities))
        ? b.version_names.map((n, i) => ({ name: n, quantity: b.version_quantities[i] }))
        : undefined
    });
    if (!q.ok) return res.json({ ok: false, error: q.error || 'Could not price this order' });

    const calc = await loadCalc(parseInt(b.product_id));
    // q.specs already excludes fields whose parent dependency isn't met (e.g. Foil
    // Color with Foil Option = No), so the order carries only live fields.
    const chosen = {};
    (q.specs || []).forEach(sp => {
      if (sp.isQuantity || sp.isVersions || sp.isVersionRow) return;
      const v = calc.variables.find(x => x.id === sp.variable_id);
      if (v) chosen[v.id] = (v.items || []).find(i => i.id === sp.item_id);
    });
    const qtyVar = calc.variables.find(v => /quantity|qty/i.test(v.title));
    let qtyItem = null;
    if (qtyVar) {
      qtyItem = (qtyVar.items || []).find(i => Number(i.value) === Number(q.quantity)) || null;
      if (!qtyItem) {
        // Not a listed tier — send the real number so the CRM records what was ordered.
        qtyItem = { id: null, title: String(q.quantity), value: Number(q.quantity), highlighted: 0 };
      }
    }
    const cWH = (q.width && q.height) ? { w: q.width, h: q.height } : null;
    // needed_by may be a date (2026-08-17) or a same-day datetime (…T14:30)
    const neededDatePart = String(b.needed_by || '').slice(0, 10);
    const dateLabel = orderDateLabel(neededDatePart);
    const timePart = String(b.needed_by || '').indexOf('T') > -1
      ? String(b.needed_by).slice(11, 16) : null;
    const PROOFS = ['no', 'yes_online_pdf', 'yes_hard_copy', 'insta_proof'];
    const proofing = PROOFS.indexOf(b.proofing) > -1 ? b.proofing : 'yes_online_pdf';
    const DESIGNS = ['Manual Proof Tier1', 'Manual Proof Tier2', 'Send the Files Later',
                     'Work with Our Designers', 'Upload Design', 'Print Ready', 'Use Existing Files'];
    const designType = DESIGNS.indexOf(b.design_type) > -1 ? b.design_type : 'Manual Proof Tier1';

    // One canonical versions array, sent in every place the CRM might read it.
    const versionPayload = (Array.isArray(b.version_names) && b.version_names.length > 1)
      ? b.version_names.map((n, i) => ({
          name: String(n || ('Version ' + (i + 1))),
          index: i,
          quantity: (Array.isArray(b.version_quantities) && b.version_quantities[i] != null)
            ? Number(b.version_quantities[i]) : 0
        }))
      : null;

    payload = {
      invoice: { payment_term: b.payment_term || 'pay_upon_approval' },
      estimates: [{
        estimateoption: buildEstimateOptions(calc, chosen, qtyItem, cWH, versionPayload),
        // Real enum values: tbd | pick_up | shipping | blind_drop_ship
        shipping_method: SHIP_METHODS.indexOf(b.shipping_method) > -1 ? b.shipping_method : 'pick_up',
        shipping_address_id: NEEDS_ADDRESS.indexOf(b.shipping_method) > -1 && b.address_id
          ? parseInt(b.address_id) : undefined,
        system_estimate_boxes: [],
        shipping_weight: 0,
        shipping_volume: 0,
        shipping_notes: String(b.shipping_notes || ''),
        // estimate_price = LIST, new_total = what the client pays. Confirmed on
        // E1175598 (132.35 / 99.26 at 25%) and on CRM-created jobs E1175114
        // (16685.44 / 8531.84) and E1156659 (145.30 / 116.24). Sending the
        // discounted figure in both — as E1175597 did — leaves no record that a
        // discount was applied.
        estimate_price: (q.list_price != null ? q.list_price : q.price),
        estimate_productid: parseInt(b.product_id),
        estimate_name: String(b.job_name || '').slice(0, 200),
        prepress_notes: [String(b.notes || ''),
          (Array.isArray(b.version_names) && b.version_names.length > 1)
            ? ('Versions: ' + b.version_names.map((n, i) => (i + 1) + ') ' + n +
                ((Array.isArray(b.version_quantities) && b.version_quantities[i] != null)
                  ? ' x' + b.version_quantities[i] : '')).join('  '))
            : ''].filter(Boolean).join('\n'),
        // Files coming later means prepress is waiting; anything else is ready to move.
        prepress_status: designType === 'Send the Files Later' ? 'waiting_files' : 'upload_files',
        count: 1,
        new_total: q.price,
        needed_by_note: dateLabel + (timePart ? ' ' + timePart : ''),
        complete_by: dateLabel + (timePart ? ' ' + timePart : ''),
        // Exact shape the CRM stores in estimate_handle.versions:
        //   [{ "name": "Media", "index": 0, "quantity": 20 }, ...]
        // The Quantity option above is the SUM of these, which is how the CRM
        // records it (verified: 3 versions x 1 -> Quantity 3; 2 x 100 -> 200).
        versions: versionPayload || undefined,
        // Some Laravel resources expect the JSON column as a string rather than
        // an array. Sending both costs nothing and covers either shape.
        versions_json: versionPayload ? JSON.stringify(versionPayload) : undefined,
        design_details: {
          design_type: designType,
          notes: String(b.notes || ''),
          need_help_with_file: designType === 'Work with Our Designers' ? 'yes' : 'no',
          // Tier 1 / Tier 2 map to the service_level the CRM records.
          service_level: DESIGN_SERVICE_LEVEL[designType] || undefined,
          answers: '<b>Do you need help with file?</b>\n' +
            (designType === 'Work with Our Designers'
              ? 'YES, please have a designer work on it.'
              : 'NO, our design team is working on it.') +
            '\n<b>Proofing Options?</b>\n' + proofing,
          proofing: proofing
        }
      }],
      customer: { id: parseInt(b.client_id) }
    };

    const row = [
      req.user.key, who, parseInt(b.client_id), String(b.client_name || ''),
      parseInt(b.product_id), String(q.product || ''), parseInt(b.quantity),
      q.list_price, q.price,
      q.discount ? q.discount.name : null, q.discount ? q.discount.percent : null,
      JSON.stringify(q.specs || []),
      String(b.job_name || '').slice(0, 200), String(b.needed_by || ''), designType,
      String(b.po_number || ''), String(b.notes || ''), String(b.source_estimate || '')
    ];

    const insertId = await new Promise((resolve) => {
      db.run('INSERT INTO order_requests (user_key, created_by, client_id, client_name, product_id, product, ' +
        'quantity, list_price, price, discount_name, discount_percent, specs, job_name, needed_by, artwork, ' +
        'po_number, notes, source_estimate) VALUES (' + row.map(() => '?').join(',') + ')',
        row, function () { resolve(this ? this.lastID : null); });
    });

    if (!process.env.AXIOM_ORDER_API_TOKEN) {
      db.run("UPDATE order_requests SET status = 'draft' WHERE id = ?", [insertId]);
      return res.json({ ok: true, id: insertId, submitted: false, draft: true,
        error: 'AXIOM_ORDER_API_TOKEN is not set in .env, so the order was saved but not sent.' });
    }

    const r = await fetch(ORDER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + process.env.AXIOM_ORDER_API_TOKEN
      },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    let out = {};
    try { out = JSON.parse(text); } catch (e) { out = { raw: text.slice(0, 400) }; }

    // Always log the raw response: the exact shape of a successful order reply is
    // the one thing we can't verify from here, and without it a created order has
    // no visible reference back to the CRM.
    console.log('ORDER_API_RESP status=' + r.status + ' body=' + text.slice(0, 900));
    console.log('ORDER_PRICES list=' + payload.estimates[0].estimate_price +
      ' total=' + payload.estimates[0].new_total);
    if (!payload.estimates[0].versions) {
      console.log('ORDER_VERSIONS none sent (single-version job)');
    }
    if (payload.estimates && payload.estimates[0] && payload.estimates[0].versions) {
      console.log('ORDER_VERSIONS sent=' + JSON.stringify(payload.estimates[0].versions) +
        ' qty_option=' + (function () {
          const q = (payload.estimates[0].estimateoption || []).find(o => /quantity/i.test(o.optionname || ''));
          return q ? q.selected : '?';
        })());
    }

    // Walk the response for anything that looks like the new estimate id. Laravel
    // APIs nest differently depending on the resource, so don't assume a shape.
    const findRef = (node, depth) => {
      if (node == null || depth > 5) return null;
      if (Array.isArray(node)) {
        for (const x of node) { const v = findRef(x, depth + 1); if (v) return v; }
        return null;
      }
      if (typeof node !== 'object') return null;
      const KEYS = ['estimate_id', 'estimateId', 'estimate_printordernumber', 'print_order_number',
                    'e_number', 'eNumber', 'order_id', 'orderId', 'number', 'id'];
      for (const k of KEYS) {
        if (node[k] != null && (typeof node[k] === 'number' || /^[Ee]?\d{4,}$/.test(String(node[k])))) {
          return String(node[k]).replace(/^[Ee]/, '');
        }
      }
      for (const k of Object.keys(node)) {
        const v = findRef(node[k], depth + 1);
        if (v) return v;
      }
      return null;
    };
    const ref = findRef(out, 0);

    db.run('UPDATE order_requests SET status = ?, remote_ref = ? WHERE id = ?',
      [r.ok ? 'submitted' : 'failed', ref ? String(ref) : null, insertId]);

    if (!r.ok) console.error('ORDER_API_FAIL', r.status, text.slice(0, 500));
    return res.json({
      ok: true, id: insertId, submitted: r.ok,
      remote_ref: ref, e_number: ref ? ('E' + ref) : null,
      // If we couldn't find a reference, hand the raw reply back so it's visible
      // rather than leaving a placed order with no traceable number.
      raw_response: ref ? undefined : text.slice(0, 400),
      error: r.ok ? null : ('Order API returned ' + r.status + ': ' + text.slice(0, 200))
    });
  } catch (e) {
    console.error('ORDER_REQUEST_ERROR', e.message);
    return res.json({ ok: false, error: e.message });
  }
});

// Recent order requests, for the team to work through
app.get('/api/chatbot/order-requests', auth, (req, res) => {
  const mine = !req.user.is_admin;
  const sql = 'SELECT * FROM order_requests ' + (mine ? 'WHERE user_key = ? ' : '') + 'ORDER BY id DESC LIMIT 50';
  db.all(sql, mine ? [req.user.key] : [], (err, rows) => {
    if (err) return res.json({ ok: false, error: err.message });
    res.json({ ok: true, requests: rows || [] });
  });
});

// The job's board column (estimate_stage, one row per job) says more than estimate.production_status, which
// lags: 'complete' + 'done' = finished, 'complete' + 'canceled' = canceled (the job keeps its old prepress /
// production status), the rest are live columns. Returns { stage, headline } or null to fall back.
const SUBSTAGE_LABEL = { cad_template: 'CAD template', design: 'In design', tier_1: 'File check (Tier 1)', tier_2: 'File check (Tier 2)',
  payment: 'Waiting on payment', imposition: 'Imposition', production: 'In production', packing: 'Packing / dispatch', pickup: 'Pick-up stage',
  shipping: 'Shipping stage', delivery_install: 'Delivery / install stage', job_merge: 'Job merge', final_payment: 'Final payment',
  new_client: 'New order', reorder: 'Reorder', ongoing: 'Ongoing', follow_up: 'Follow-up', ticket: 'Ticket' };
function boardStatus(substage) {
  const s = String(substage || '');
  if (!s) return null;
  if (s === 'canceled') return { stage: 'canceled', headline: 'Canceled' };
  if (s === 'done') return { stage: 'done', headline: 'Complete' };
  if (['production', 'imposition', 'packing', 'job_merge'].indexOf(s) > -1) return { stage: 'production', headline: SUBSTAGE_LABEL[s] };
  if (['pickup', 'shipping', 'delivery_install'].indexOf(s) > -1) return { stage: 'done', headline: SUBSTAGE_LABEL[s] };
  return null;                                     // order / prepress columns: the prepress status says more
}

// Lightweight job peek for the E-number hover preview. Deliberately minimal —
// this fires on hover, so it must stay cheap.
app.get('/api/chatbot/job-peek', auth, async (req, res) => {
  try {
    const eid = parseInt(String(req.query.e || '').replace(/[^0-9]/g, ''));
    if (!eid) return res.json({ ok: false });
    const rows = await runQueryRaw(
      'SELECT e.id, e.estimate_name, DATE(e.created) AS created, e.production_status, e.prepress_status, ' +
      "(SELECT s.estimate_substage FROM estimate_stage s WHERE s.estimate_id = e.id ORDER BY s.id DESC LIMIT 1) AS substage, " +
      'COALESCE(e.new_total, e.estimate_price) AS total, ' +
      'COALESCE(NULLIF(p.public_title, \'\'), p.title) AS product, p.image, ' +
      "CONCAT(c.name,' ',c.last_name) AS client " +
      'FROM estimate e LEFT JOIN product p ON p.id = e.estimate_productid ' +
      'LEFT JOIN customer c ON c.id = e.estimate_clientid WHERE e.id = ' + eid + ' LIMIT 1');
    if (!rows.length) return res.json({ ok: false });
    const j = rows[0];
    const PREP = { approved: 'Files approved', upload_files: 'Waiting for files', proof_checking: 'Proof checking',
      rejected_reupload: 'Rejected — reupload', rejected_edits: 'Rejected — edits', waiting_files: 'Waiting for files',
      waiting_files_followup: 'Waiting for files', proof_sent: 'Proof sent', hard_copy_approved: 'Hard copy approved',
      insta_proofed: 'Auto-proofed', insta_proof_manual: 'Proof under review' };
    let status = PREP[j.prepress_status] || j.prepress_status || '';
    let stage = 'prepress';
    if (j.production_status === 'complete') { status = 'Complete'; stage = 'done'; }
    else if (j.production_status === 'in_production') { status = 'In production'; stage = 'production'; }
    else if (j.production_status === 'reprint') { status = 'Reprint in progress'; stage = 'production'; }
    else if (j.prepress_status === 'approved' && j.production_status === 'not_started') {
      status = 'Approved — queued'; stage = 'ready';
    }
    const bs = boardStatus(j.substage);
    if (bs) { status = bs.headline; stage = bs.stage; }
    res.json({
      ok: true, e_number: 'E' + j.id,
      product: j.product || null, image: j.image || null,
      name: j.estimate_name || null, client: j.client || null,
      created: j.created ? String(j.created).slice(0, 10) : null,
      total: j.total != null ? Number(j.total) : null,
      status: status, stage: stage
    });
  } catch (e) { res.json({ ok: false }); }
});

// Turnaround titles are free text. Read the promised days out of them, erring on
// the LONGER end of a range so a due date is never optimistic.
//   "3 Business Days" -> 3      "4-5 Business Days" -> 5
//   "Next Day" -> 1             "Same Day" / "Express (Same Day)" -> 0
//   bare "Express" -> 1, flagged ambiguous (no number in the name)
// Returns { days, ambiguous } — NOT a number. Several callers treated the object
// as a number, which made every comparison against it meaningless.
function parseTurnaroundDays(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return { days: null, ambiguous: true };
  if (/same\s*day/.test(t)) return { days: 0, ambiguous: false };
  // Weeks are business weeks: "2 weeks" is 10 working days, not 2.
  const wk = t.match(/(\d+)\s*week/);
  if (wk) return { days: parseInt(wk[1]) * 5, ambiguous: false };
  const nums = (t.match(/\d+/g) || []).map(Number).filter(n => n >= 0 && n < 200);
  if (nums.length) return { days: Math.max.apply(null, nums), ambiguous: false };
  if (/next\s*(business\s*)?day/.test(t)) return { days: 1, ambiguous: false };
  if (/express|rush/.test(t)) return { days: 1, ambiguous: true };
  return { days: null, ambiguous: true };
}

// When a plain number is all that's wanted.
function turnaroundDaysOf(text) {
  const r = parseTurnaroundDays(text);
  return (r && r.days != null && isFinite(r.days)) ? r.days : null;
}

// Build ONE estimate object for the order payload. Extracted so a cart of
// several items can be submitted as a single order with several estimates —
// which is what the API's `estimates` array is for.
async function buildEstimateForOrder(spec) {
  const q = await quoteProduct(spec.product_id, spec.priceOpts || {});
  if (!q || q.error) throw new Error(q && q.error ? q.error : 'Could not price item');

  const calc = await loadCalc(spec.product_id);
  const chosen = {};
  (q.specs || []).forEach(sp => {
    if (sp.isQuantity || sp.isVersions || sp.isVersionRow) return;
    const v = calc.variables.find(x => x.id === sp.variable_id);
    if (v) chosen[v.id] = (v.items || []).find(i => i.id === sp.item_id);
  });
  const qtyVar = calc.variables.find(v => /quantity/i.test(v.title));
  const qtyItem = qtyVar ? (qtyVar.items || []).find(i => Number(i.value) === Number(q.quantity)) ||
    (qtyVar.items || []).filter(i => Number(i.value) <= Number(q.quantity)).pop() : null;
  const cWH = (q.width && q.height) ? { w: Number(q.width), h: Number(q.height) } : null;

  const versionPayload = (Array.isArray(spec.version_names) && spec.version_names.length > 1)
    ? spec.version_names.map((n, i) => ({
        name: String(n || ('Version ' + (i + 1))),
        index: i,
        quantity: (Array.isArray(spec.version_quantities) && spec.version_quantities[i] != null)
          ? Number(spec.version_quantities[i]) : 0
      }))
    : null;

  const PROOFS = ['no', 'yes_online_pdf', 'yes_hard_copy', 'insta_proof'];
  const proofing = PROOFS.indexOf(spec.proofing) > -1 ? spec.proofing : 'yes_online_pdf';
  const DESIGNS = ['Manual Proof Tier1', 'Manual Proof Tier2', 'Send the Files Later',
                   'Work with Our Designers', 'Upload Design', 'Print Ready', 'Use Existing Files'];
  const designType = DESIGNS.indexOf(spec.design_type) > -1 ? spec.design_type : 'Manual Proof Tier1';

  return {
    estimate: {
      estimateoption: buildEstimateOptions(calc, chosen, qtyItem, cWH, versionPayload),
      shipping_method: SHIP_METHODS.indexOf(spec.shipping_method) > -1 ? spec.shipping_method : 'pick_up',
      shipping_address_id: NEEDS_ADDRESS.indexOf(spec.shipping_method) > -1 && spec.address_id
        ? parseInt(spec.address_id) : undefined,
      system_estimate_boxes: [],
      estimate_name: String(spec.job_name || q.product),
      estimate_productid: parseInt(spec.product_id),
      estimate_price: q.price,
      new_total: q.price,
      needed_by: spec.needed_by || undefined,
      prepress_notes: versionPayload
        ? 'Versions: ' + versionPayload.map((v, i) => (i + 1) + ') ' + v.name + ' x' + v.quantity).join('  ')
        : (spec.notes || ''),
      prepress_status: designType === 'Send the Files Later' ? 'waiting_files' : 'upload_files',
      versions: versionPayload || undefined,
      versions_json: versionPayload ? JSON.stringify(versionPayload) : undefined,
      design_details: {
        design_type: designType,
        notes: String(spec.notes || ''),
        need_help_with_file: designType === 'Work with Our Designers' ? 'yes' : 'no',
        service_level: DESIGN_SERVICE_LEVEL[designType] || undefined,
        answers: '<b>Do you need help with file?</b>\n' +
          (designType === 'Work with Our Designers'
            ? 'YES, please have a designer work on it.' : 'NO, our design team is working on it.') +
          '\n<b>Proofing Options?</b>\n' + proofing,
        proofing: proofing
      }
    },
    quote: q
  };
}

// Place every cart item as ONE order with several estimates.
app.post('/api/chatbot/order-cart', auth, async (req, res) => {
  const b = req.body || {};
  const chatId = parseInt(b.chat_id);
  const clientId = parseInt(b.client_id);
  if (!chatId) return res.json({ ok: false, error: 'No conversation' });
  if (!clientId) return res.json({ ok: false, error: 'Choose the client first' });

  const rows = await new Promise(r =>
    db.all('SELECT * FROM chat_cart WHERE chat_id = ? ORDER BY id', [chatId], (e, x) => r(e ? [] : x)));
  if (!rows.length) return res.json({ ok: false, error: 'The cart is empty' });

  const perItem = {};
  (b.items || []).forEach(i => { perItem[String(i.cart_id)] = i; });

  const estimates = [];
  const missing = [];
  for (const row of rows) {
    const it = perItem[String(row.id)] || {};
    if (!String(it.job_name || '').trim()) missing.push('Job name for ' + row.product);
    if (['shipping', 'blind_drop_ship'].indexOf(it.shipping_method) > -1 && !it.address_id) {
      missing.push('Shipping address for ' + row.product);
    }
    let saved = {};
    try { saved = JSON.parse(row.payload || '{}'); } catch (e) {}
    try {
      const built = await buildEstimateForOrder({
        product_id: row.product_id,
        priceOpts: {
          quantity: saved.quantity || row.quantity,
          item_ids: saved.item_ids,
          versions: saved.versions,
          version_names: saved.version_names,
          version_quantities: saved.version_quantities,
          width: saved.width, height: saved.height,
          client_id: clientId
        },
        version_names: saved.version_names,
        version_quantities: saved.version_quantities,
        job_name: it.job_name, needed_by: it.needed_by,
        shipping_method: it.shipping_method, address_id: it.address_id,
        design_type: it.design_type, proofing: it.proofing, notes: it.notes
      });
      estimates.push(built.estimate);
    } catch (e) {
      return res.json({ ok: false, error: 'Could not price ' + row.product + ': ' + e.message });
    }
  }
  if (missing.length) return res.json({ ok: false, missing: missing });

  const payload = {
    invoice: { payment_term: b.payment_term || 'pay_upon_approval' },
    estimates: estimates,
    customer_id: clientId
  };

  try {
    const r = await fetch(ORDER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Authorization': 'Bearer ' + process.env.AXIOM_ORDER_API_TOKEN
      },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    console.log('ORDER_CART status=' + r.status + ' items=' + estimates.length +
                ' body=' + text.slice(0, 600));
    let out = {};
    try { out = JSON.parse(text); } catch (e) {}
    if (!r.ok) return res.json({ ok: false, error: 'The order API rejected it (' + r.status + ')' });

    // Collect every estimate number the response mentions — one per item.
    const nums = [];
    (function walk(node, depth) {
      if (node == null || depth > 6) return;
      if (Array.isArray(node)) return node.forEach(x => walk(x, depth + 1));
      if (typeof node !== 'object') return;
      ['estimate_id', 'estimateId', 'estimate_printordernumber', 'print_order_number',
       'e_number', 'id'].forEach(k => {
        if (node[k] != null && /^[Ee]?\d{4,}$/.test(String(node[k]))) {
          const v = 'E' + String(node[k]).replace(/^[Ee]/, '');
          if (nums.indexOf(v) === -1) nums.push(v);
        }
      });
      Object.keys(node).forEach(k => walk(node[k], depth + 1));
    })(out, 0);

    // Cart is placed — clear it so the conversation can't submit twice.
    db.run('DELETE FROM chat_cart WHERE chat_id = ?', [chatId], () => {});
    res.json({ ok: true, submitted: true, count: estimates.length, e_numbers: nums });
  } catch (e) {
    res.json({ ok: false, error: 'Could not reach the order API: ' + e.message });
  }
});

// Work out the ready date from the turnaround text if the browser didn't send
// one. Computing it here means an item can never land in the cart without a
// date — the checkout then has something to prefill.
function readyFromTurnaround(turnaround, given) {
  if (given) return given;
  if (!turnaround) return null;
  try {
    const days = turnaroundDaysOf(turnaround);
    if (days == null) return null;
    const t = buildTimeline(days);
    return t ? t.readyDate : null;
  } catch (e) { return null; }
}

// Push a priced item to the CRM as a QUOTE. No customer needed — it lands on
// Estimates -> Quotes, where a manager assigns it later, and that assignment is
// what creates the project, applies the discount and sorts taxation. So this is
// the right endpoint for the common case: a price asked for before we know who
// is asking.
const QUOTE_API_URL = process.env.AXIOM_QUOTE_API_URL ||
  'https://laravelapi.axiomprint.com/api/v1/nova-ai-bot/quotes';

app.post('/api/chatbot/quote-to-crm', auth, async (req, res) => {
  const b = req.body || {};
  const productId = parseInt(b.product_id);
  const price = Number(b.price);
  if (!productId) return res.json({ ok: false, error: 'Which product?' });
  if (!isFinite(price) || price < 0) return res.json({ ok: false, error: 'No price to send' });

  const options = (b.specs || [])
    .filter(sp => sp && sp.field && sp.value != null)
    .map((sp, i) => ({
      optionname: String(sp.field).replace(/_/g, ' '),
      selected: String(sp.value),
      variabletype: sp.variable_type || undefined,
      optionVariableId: sp.variable_id || undefined,
      optionVariableItemId: sp.item_id || undefined,
      order: i + 1
    }));

  // A price ladder is ONE quote, not three — the alternatives go in the
  // description so a manager sees them without three estimates to reconcile.
  const ladder = Array.isArray(b.ladder) && b.ladder.length > 1
    ? b.ladder.map(r => Number(r.quantity).toLocaleString() + ': $' + usd2(Number(r.price))).join('  |  ')
    : '';

  const payload = {
    estimate: {
      estimate_productid: productId,
      estimate_price: Number(price.toFixed(2)),
      estimate_name: String(b.name || b.product || 'Quote').slice(0, 255),
      estimate_description: [b.summary, ladder].filter(Boolean).join(' - ').slice(0, 2000) || undefined,
      estimateoption: options.length ? options : undefined,
      design_details: b.design_type
        ? { design_type: b.design_type, notes: String(b.notes || '') }
        : undefined
    },
    ai_bot_note: ('Quoted in Nova by ' + ((req.user && (req.user.username || req.user.email)) || 'an AM') +
      ' on ' + shopToday() + '.' + (b.client_hint ? ' Client mentioned: ' + b.client_hint : '') +
      ' No customer assigned yet.').slice(0, 5000)
  };

  try {
    const r = await fetch(QUOTE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    console.log('QUOTE_CRM status=' + r.status + ' product=' + productId + ' body=' + text.slice(0, 400));
    let out = {};
    try { out = JSON.parse(text); } catch (e) {}

    if (!r.ok || out.success === false) {
      // 422 carries Laravel's per-field errors; surface those rather than a code.
      const detail = out.errors
        ? Object.keys(out.errors).map(k => k + ': ' + [].concat(out.errors[k]).join(', ')).join('; ')
        : (out.error || out.message || ('HTTP ' + r.status));
      return res.json({ ok: false, error: detail });
    }

    const id = (out.data && (out.data.quote_id || (out.data.estimate && out.data.estimate.id))) || null;
    res.json({ ok: true, quote_id: id, e_number: id ? ('E' + id) : null });
  } catch (e) {
    res.json({ ok: false, error: 'Could not reach the quote API: ' + e.message });
  }
});

// ===== Chat cart =====
app.get('/api/chats/:id/cart', auth, (req, res) => {
  db.all('SELECT * FROM chat_cart WHERE chat_id = ? ORDER BY id', [req.params.id], (e, rows) => {
    if (e) return res.json({ ok: false, error: e.message });
    const items = (rows || []).map(r => ({
      id: r.id, product_id: r.product_id, product: r.product, image: r.image,
      quantity: r.quantity, price: r.price, list_price: r.list_price, summary: r.summary,
      turnaround: r.turnaround || null,
      // Items added before this was stored still get a date rather than a blank field.
      ready_date: readyFromTurnaround(r.turnaround, r.ready_date)
    }));
    res.json({
      ok: true, items: items,
      total: items.reduce((a, b) => a + (Number(b.price) || 0), 0),
      list_total: items.reduce((a, b) => a + (Number(b.list_price) || Number(b.price) || 0), 0)
    });
  });
});

// Re-price every cart item for a client. Items added before the client was
// connected hold list prices, and a cart total that disagrees with the cards
// beside it is worse than no total at all.
app.post('/api/chats/:id/cart/reprice', auth, async (req, res) => {
  const chatId = parseInt(req.params.id);
  const clientId = parseInt(req.body.client_id) || null;
  if (!chatId) return res.json({ ok: false, error: 'No conversation' });

  const rows = await new Promise(r =>
    db.all('SELECT * FROM chat_cart WHERE chat_id = ? ORDER BY id', [chatId], (e, x) => r(e ? [] : x)));
  if (!rows.length) return res.json({ ok: true, items: [], total: 0 });

  let changed = 0;
  for (const row of rows) {
    let saved = {};
    try { saved = JSON.parse(row.payload || '{}'); } catch (e) {}
    try {
      const q = await quoteProduct(row.product_id, {
        quantity: saved.quantity || row.quantity,
        item_ids: saved.item_ids,
        versions: saved.versions,
        version_names: saved.version_names,
        version_quantities: saved.version_quantities,
        width: saved.width, height: saved.height,
        client_id: clientId
      });
      if (!q || q.error) continue;
      if (Number(q.price) === Number(row.price)) continue;
      changed++;
      saved.client_id = clientId;
      await new Promise(r2 => db.run(
        'UPDATE chat_cart SET price = ?, list_price = ?, payload = ? WHERE id = ?',
        [q.price, q.list_price != null ? q.list_price : q.price, JSON.stringify(saved), row.id],
        () => r2()));
    } catch (e) { /* leave that item as it was */ }
  }

  db.all('SELECT * FROM chat_cart WHERE chat_id = ? ORDER BY id', [chatId], (e, out) => {
    const items = (out || []).map(r => ({
      id: r.id, product_id: r.product_id, product: r.product, image: r.image,
      quantity: r.quantity, price: r.price, list_price: r.list_price, summary: r.summary,
      turnaround: r.turnaround || null, ready_date: readyFromTurnaround(r.turnaround, r.ready_date)
    }));
    res.json({
      ok: true, changed: changed, items: items,
      total: items.reduce((a, b) => a + (Number(b.price) || 0), 0),
      list_total: items.reduce((a, b) => a + (Number(b.list_price) || Number(b.price) || 0), 0)
    });
  });
});

app.post('/api/chats/cart', auth, (req, res) => {
  const b = req.body || {};
  const chatId = parseInt(b.chat_id);
  if (!chatId || !b.product_id) return res.json({ ok: false, error: 'Need a chat and a product' });
  db.run(
    'INSERT INTO chat_cart (chat_id, product_id, product, image, quantity, price, list_price, summary, ' +
    'payload, turnaround, ready_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [chatId, parseInt(b.product_id), String(b.product || ''), b.image || null,
     parseInt(b.quantity) || 0, Number(b.price) || 0,
     b.list_price != null ? Number(b.list_price) : null,
     String(b.summary || ''), JSON.stringify(b.payload || {}),
     b.turnaround || null, readyFromTurnaround(b.turnaround, b.ready_date)],
    function (err) {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID });
    });
});

app.delete('/api/chats/cart/:id', auth, (req, res) => {
  db.run('DELETE FROM chat_cart WHERE id = ?', [req.params.id], (e) => {
    res.json({ ok: !e, error: e ? e.message : undefined });
  });
});

app.delete('/api/chats/:id/cart', auth, (req, res) => {
  db.run('DELETE FROM chat_cart WHERE chat_id = ?', [req.params.id], (e) => {
    res.json({ ok: !e, error: e ? e.message : undefined });
  });
});

// Pin a client to a conversation. Once set it travels with the chat: the agent
// sees it in every turn, quotes get the right discount, and the Order form is
// pre-filled — so "who is this for" is asked once, not on every card.
app.post('/api/chats/set-client', auth, async (req, res) => {
  const chatId = parseInt(req.body.chat_id);
  const clientId = req.body.client_id ? parseInt(req.body.client_id) : null;
  if (!chatId) return res.json({ ok: false, error: 'No chat id' });
  try {
    let name = null, info = null;
    if (clientId) {
      const r = await runQueryRaw(
        "SELECT CONCAT(name,' ',last_name) AS n, company_name, email, phone FROM customer " +
        'WHERE id = ' + clientId + ' LIMIT 1');
      if (!r.length) return res.json({ ok: false, error: 'No such client' });
      name = r[0].company_name ? (r[0].n + ' (' + r[0].company_name + ')') : r[0].n;
      // The same summary the client card shows, so the pinned bar is as useful
      // as the card it replaces.
      let stats = [];
      try {
        stats = await runQueryRaw(
          'SELECT COUNT(*) AS orders, ' +
          'SUM(COALESCE(new_total, estimate_price)) AS lifetime, ' +
          'DATE(MAX(created)) AS last_order ' +
          'FROM estimate WHERE estimate_clientid = ' + clientId);
      } catch (e) {}
      info = {
        name: r[0].n, company: r[0].company_name || null,
        email: r[0].email || null, phone: r[0].phone || null,
        orders: stats.length ? Number(stats[0].orders) || 0 : 0,
        lifetime: stats.length ? Number(stats[0].lifetime) || 0 : 0,
        last_order: stats.length ? stats[0].last_order : null
      };
    }
    db.run('UPDATE chats SET client_id = ?, client_name = ? WHERE id = ? AND (user_key = ? OR ? = 1)',
      [clientId, name, chatId, req.user.key, req.user.is_admin ? 1 : 0], (e) => {
        if (e) return res.json({ ok: false, error: e.message });
        res.json({ ok: true, client_id: clientId, client_name: name, info: info });
      });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// What client is this conversation pinned to?
app.get('/api/chats/:id/client', auth, (req, res) => {
  db.get('SELECT client_id, client_name FROM chats WHERE id = ?', [req.params.id], async (e, row) => {
    if (e || !row || !row.client_id) {
      return res.json({ ok: true, client_id: null, client_name: null });
    }
    let info = null;
    try {
      const r = await runQueryRaw(
        "SELECT CONCAT(name,' ',last_name) AS n, company_name, email, phone FROM customer " +
        'WHERE id = ' + parseInt(row.client_id) + ' LIMIT 1');
      const stats = await runQueryRaw(
        'SELECT COUNT(*) AS orders, SUM(COALESCE(new_total, estimate_price)) AS lifetime, ' +
        'DATE(MAX(created)) AS last_order FROM estimate WHERE estimate_clientid = ' +
        parseInt(row.client_id));
      if (r.length) {
        info = {
          name: r[0].n, company: r[0].company_name || null,
          email: r[0].email || null, phone: r[0].phone || null,
          orders: stats.length ? Number(stats[0].orders) || 0 : 0,
          lifetime: stats.length ? Number(stats[0].lifetime) || 0 : 0,
          last_order: stats.length ? stats[0].last_order : null
        };
      }
    } catch (e2) {}
    res.json({ ok: true, client_id: row.client_id, client_name: row.client_name || null, info: info });
  });
});

// Client lookup for the order form, when a quote was produced before anyone said
// who it is for. Same starts-with rules as the chat tool, ranked by activity.
app.get('/api/chatbot/find-client', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, clients: [] });
    const SEL = "SELECT c.id, CONCAT(c.name,' ',c.last_name) AS full_name, c.email, c.company_name, " +
      '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_clientid = c.id) AS orders ' +
      'FROM customer c WHERE ';
    let where;
    if (q.indexOf('@') > -1) {
      where = 'c.email = ' + mysql.escape(q) + ' OR c.email LIKE ' + mysql.escape(q + '%');
    } else {
      const bits = q.split(/\s+/).filter(Boolean);
      const first = bits[0], last = bits.slice(1).join(' ');
      const parts = [
        'c.company_name LIKE ' + mysql.escape(first + '%'),
        'c.name LIKE ' + mysql.escape(first + '%'),
        'c.last_name LIKE ' + mysql.escape(first + '%')
      ];
      if (last) parts.push('(c.name LIKE ' + mysql.escape(first + '%') +
        ' AND c.last_name LIKE ' + mysql.escape(last + '%') + ')');
      where = parts.join(' OR ');
    }
    const rows = await runQueryRaw(SEL + '(' + where + ') ORDER BY orders DESC LIMIT 6');
    res.json({
      ok: true,
      clients: rows.map(r => ({
        id: r.id, name: r.full_name, company: r.company_name, email: r.email, orders: r.orders
      }))
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// AxiomPrint is in Los Angeles. Every "today" and every cutoff decision has to be
// made in that timezone, not the server's.
const SHOP_TZ = process.env.SHOP_TIMEZONE || 'America/Los_Angeles';

function shopNowParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  return f.formatToParts(new Date()).reduce((m, p) => (m[p.type] = p.value, m), {});
}
// Today's date in the shop's timezone, as YYYY-MM-DD.
function shopToday() {
  const p = shopNowParts();
  return p.year + '-' + p.month + '-' + p.day;
}
// Is it still before the 5PM cutoff where the presses are?
function shopBeforeCutoff() {
  const p = shopNowParts();
  const h = parseInt(p.hour, 10);
  return (h === 24 ? 0 : h) < 17;
}

// Day-by-day production timeline for a turnaround. Shared by the turnaround tool
// and every price card, so a quote always shows when the job is actually ready.
function buildTimeline(days, opts) {
  opts = opts || {};
  if (days == null || !isFinite(days)) return null;
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  const isBiz = d => {
    const w = d.getDay();
    return w !== 0 && w !== 6 && !usHolidays(d.getFullYear()).has(iso(d));
  };

  // The shop is in Los Angeles; the server runs in UTC. Reading the clock
  // directly meant 1PM in LA looked like 20:00 and failed the 5PM cutoff, so
  // half of every working day was pushed to the next day. Both "what day is it"
  // and "is it before 5PM" have to be asked in shop time.
  const now = opts.from
    ? new Date(opts.from + 'T12:00:00')
    : (function () {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date()).reduce((m, p) => (m[p.type] = p.value, m), {});
        return new Date(parts.year + '-' + parts.month + '-' + parts.day + 'T12:00:00');
      })();
  const beforeCutoff = opts.beforeCutoff != null ? opts.beforeCutoff : shopBeforeCutoff();
  const approval = new Date(now); approval.setHours(12, 0, 0, 0);

  // The clock starts today if we're before 5PM on a working day, else the next
  // working day. That start day is day ZERO — counting begins the day after.
  let start = new Date(approval);
  if (!beforeCutoff || !isBiz(approval)) {
    do { start.setDate(start.getDate() + 1); } while (!isBiz(start));
  }

  // The START DAY is always shown. Counting begins the day AFTER it, which is
  // the part people get wrong — seeing "Mon Start Day, Tue Day 1" makes the rule
  // obvious in a way a sentence doesn't.
  const sameDayStart = iso(start) === iso(approval);
  const timeline = sameDayStart
    ? [{ date: iso(approval), type: 'start', label: 'Start Day', approvedToo: true }]
    : [{ date: iso(approval), type: 'approved', label: 'Approved' },
       { date: iso(start), type: 'start', label: 'Start Day' }];

  let cur = new Date(start), counted = 0, guard = 0;
  if (days === 0) {
    timeline.push({ date: iso(start), type: 'ready', label: 'Ready' });
    cur = new Date(start);
  } else {
    while (counted < days && guard++ < 300) {
      cur.setDate(cur.getDate() + 1);
      if (isBiz(cur)) {
        counted++;
        timeline.push({ date: iso(cur), type: counted === days ? 'ready' : 'production',
                        label: counted === days ? 'Ready' : ('Day ' + counted) });
      } else {
        const w = cur.getDay();
        timeline.push({ date: iso(cur), type: 'skipped',
                        label: (w === 0 || w === 6) ? 'Weekend' : 'Holiday', name: closedDays.name(iso(cur)) || undefined });
      }
    }
  }
  const fmt = d => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return {
    days: days,
    beforeCutoff: beforeCutoff,
    approvalLabel: fmt(approval),
    firstDayLabel: days > 0 ? fmt(new Date(timeline.find(t => t.type === 'production' || t.type === 'ready').date + 'T12:00:00')) : null,
    readyDate: iso(cur),
    readyLabel: fmt(cur),
    skipped: timeline.filter(t => t.type === 'skipped').length,
    timeline: timeline
  };
}

// Everything the order form should pre-fill: the due date implied by the chosen
// turnaround, the client's delivery preference, and their address book.
app.get('/api/chatbot/order-defaults', auth, async (req, res) => {
  try {
    const clientId = parseInt(req.query.client_id) || null;
    // Accept either an explicit day count or the turnaround title to read it from.
    const parsed = parseTurnaroundDays(req.query.turnaround);
    const days = (req.query.days != null && req.query.days !== '')
      ? parseInt(req.query.days) : parsed.days;
    const daysAmbiguous = (req.query.days != null && req.query.days !== '') ? false : parsed.ambiguous;
    const fromEstimate = parseInt(String(req.query.from_estimate || '').replace(/[^0-9]/g, '')) || null;

    // ---- due date from the turnaround ----
    const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const isBiz = d => {
      const w = d.getDay();
      return w !== 0 && w !== 6 && !usHolidays(d.getFullYear()).has(iso(d));
    };
    // Shop time, not server time — see SHOP_TZ.
    const now = new Date(shopToday() + 'T12:00:00');
    const beforeCutoff = shopBeforeCutoff();

    let due = null, sameDay = false;
    if (days === 0) {
      // Same-day work: the team picks an exact time, and it can't be in the past.
      sameDay = true;
    } else if (days != null && days > 0) {
      // The clock starts today if we're before the 5PM cutoff on a working day,
      // otherwise the next working day. The start day is day zero.
      let cur = new Date(now);
      cur.setHours(12, 0, 0, 0);
      if (!beforeCutoff || !isBiz(cur)) {
        do { cur.setDate(cur.getDate() + 1); } while (!isBiz(cur));
      }
      let counted = 0, guard = 0;
      while (counted < days && guard++ < 200) {
        cur.setDate(cur.getDate() + 1);
        if (isBiz(cur)) counted++;
      }
      due = iso(cur);
    }

    // ---- delivery preference ----
    let shipping_method = null, method_source = null, addressId = null;
    if (fromEstimate) {
      // A reorder should behave like the job it came from.
      try {
        const h = await runQueryRaw(
          'SELECT shipping_method, shipping_address_id FROM estimate_handle WHERE estimate_id = ' + fromEstimate + ' LIMIT 1');
        if (h.length && h[0].shipping_method) {
          const prev = String(h[0].shipping_method);
          shipping_method = SHIP_METHODS.indexOf(prev) > -1 ? prev : 'pick_up';
          addressId = h[0].shipping_address_id || null;
          method_source = 'previous order';
        }
      } catch (e) {}
    }
    if (!shipping_method && clientId) {
      try {
        const c = await runQueryRaw('SELECT default_handling_method FROM customer WHERE id = ' + clientId + ' LIMIT 1');
        // customer.default_handling_method: pickup | shipping | tbd | blind_drop_ship
        const m = c.length ? String(c[0].default_handling_method || '') : '';
        const MAP = { pickup: 'pick_up', shipping: 'shipping', blind_drop_ship: 'blind_drop_ship', tbd: 'tbd' };
        if (MAP[m]) {
          shipping_method = MAP[m];
          method_source = m === 'tbd'
            ? 'client default is TBD — confirm with them'
            : 'client default';
        }
      } catch (e) {}
    }

    // ---- address book ----
    let addresses = [];
    if (clientId) {
      try {
        addresses = await runQueryRaw(
          'SELECT id, title, company_name, address, unit, city, state, zip, for_handling, auto_apply_to_projects ' +
          'FROM customerusers WHERE customer_id = ' + clientId +
          " AND address IS NOT NULL AND address <> '' " +
          'ORDER BY for_handling DESC, auto_apply_to_projects DESC, id DESC LIMIT 25');
        addresses = addresses.map(a => ({
          id: a.id,
          label: [a.company_name || a.title, a.address, a.unit, a.city, a.state, a.zip]
            .filter(x => x && String(x).trim()).join(', '),
          preferred: a.for_handling == 1 || a.auto_apply_to_projects == 1
        }));
      } catch (e) { addresses = []; }
    }
    if (!addressId && addresses.length) {
      const pref = addresses.find(a => a.preferred);
      addressId = pref ? pref.id : addresses[0].id;
    }

    res.json({
      ok: true,
      needed_by: due, same_day: sameDay,
      cutoff_passed: !beforeCutoff,
      turnaround_days: days,
      turnaround_ambiguous: daysAmbiguous,
      turnaround: req.query.turnaround || null,
      shipping_method: shipping_method, method_source: method_source,
      address_id: addressId, addresses: addresses
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Reprice from the editable calculator. Same engine and same related-to rules as
// the AI pricing tool, so an edited quote can never disagree with the original.
app.post('/api/chatbot/reprice', auth, async (req, res) => {
  try {
    const pid = parseInt(req.body.product_id);
    if (!pid) return res.json({ ok: false, error: 'No product id' });
    // If the conversation is pinned to a client, that client's pricing applies
    // even when the card was created before they were connected.
    if (!req.body.client_id && req.body.chat_id) {
      const pinned = await new Promise(r =>
        db.get('SELECT client_id FROM chats WHERE id = ?', [parseInt(req.body.chat_id)],
          (e, row) => r(e ? null : row)));
      if (pinned && pinned.client_id) req.body.client_id = pinned.client_id;
    }
    const q = await quoteProduct(pid, {
      itemIds: req.body.item_ids || {},
      quantity: req.body.quantity,
      version_names: req.body.version_names,
      version_quantities: req.body.version_quantities,
      version_list: (Array.isArray(req.body.version_names) && Array.isArray(req.body.version_quantities))
        ? req.body.version_names.map((n, i) => ({ name: n, quantity: req.body.version_quantities[i] }))
        : undefined,
      width: req.body.width,
      height: req.body.height,
      versions: req.body.versions,
      client_id: req.body.client_id
    });
    res.json(q);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== "Order now" links =====
// A priced quote -> a link to the product page on axiomprint.com with every
// option already selected, so the client only has to upload and check out.
// See docs/NOVA_AI_URL_GENERATOR.md. The selections are keyed by the variable's
// exact title (underscores and all) and hold the chosen item ids.
//   Short link (default): POST the config to the product-shares API and link
//     ?shareId=… — short, and orders placed from it are tracked.
//   Inline (fallback when that API is down): ?config=<url-encoded JSON>.
const SITE_URL = 'https://axiomprint.com';
const PRODUCT_SHARE_API = process.env.PRODUCT_SHARE_API || 'https://website.workroomapp.com/api/v1/product-shares';
const orderLinkCache = new Map();        // product + config -> url
const productLinkCache = new Map();      // product id -> { slug, vars, at }

async function productLinkInfo(pid) {
  const hit = productLinkCache.get(pid);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const rows = await runQuery('SELECT id, title, url FROM product WHERE id = ' + parseInt(pid));
  if (!rows.length) return null;
  const vars = await runQuery('SELECT id, title, type, internal FROM product_variables WHERE product_id = ' + parseInt(pid));
  const p = rows[0];
  // product.url is the page slug, normally already ending in -<id>
  // ("raised-spot-uv-cards-184"). The id after the last "-" is what the site reads.
  let slug = String(p.url || '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '').replace(/^product\//, '');
  if (!slug) slug = String(p.title || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!new RegExp('-' + parseInt(pid) + '$').test(slug)) slug += '-' + parseInt(pid);
  const info = { slug: slug, vars: {}, at: Date.now() };
  vars.forEach(v => { info.vars[v.id] = { title: v.title, type: v.type, internal: Number(v.internal) === 1 }; });
  productLinkCache.set(pid, info);
  return info;
}

async function buildOrderLink(item) {
  const pid = parseInt(item && item.product_id);
  if (!pid) return { ok: false, error: 'No product' };
  const info = await productLinkInfo(pid);
  if (!info) return { ok: false, error: 'Unknown product' };
  const selections = {};
  const config = { selections: selections, selectedMetric: 'inch' };
  let qtyTitle = null, qtyItem = null, custom = false;
  (Array.isArray(item.specs) ? item.specs : []).forEach(sp => {
    if (!sp || sp.isVersionRow || sp.isVersions) return;
    const v = info.vars[parseInt(sp.variable_id)];
    if (!v || v.internal) return;
    if (sp.isQuantity) { qtyTitle = v.title; qtyItem = parseInt(sp.item_id) || null; return; }
    if (v.type === 'text' || v.type === 'number') return;      // no raw values on a quote
    if (!parseInt(sp.item_id)) return;
    selections[v.title] = parseInt(sp.item_id);
    if (/\(custom\)/i.test(String(sp.value || ''))) custom = true;
  });
  const qty = parseInt(item.quantity) || 0;
  if (qtyTitle && qtyItem) selections[qtyTitle] = qtyItem;           // a listed quantity
  else if (qty > 0) { config.isCustomQuantity = true; config.customQuantity = qty; }
  const w = Number(item.width), h = Number(item.height);
  if (custom && w > 0 && h > 0) config.customSize = { width: w, height: h };
  if (!Object.keys(selections).length) return { ok: false, error: 'Nothing to select' };

  const base = SITE_URL + '/product/' + info.slug;
  const key = pid + '|' + JSON.stringify(config);
  const cached = orderLinkCache.get(key);
  if (cached) return cached;
  let out;
  try {
    const r = await fetch(PRODUCT_SHARE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ productId: String(pid), config: config }),
      signal: AbortSignal.timeout(6000)
    });
    const j = await r.json().catch(() => ({}));
    const id = j && j.data && j.data.id;
    if (!r.ok || !/^[0-9a-f]{24}$/i.test(String(id || ''))) throw new Error('share API ' + r.status);
    out = { ok: true, url: base + '?shareId=' + id, share_id: id, method: 'share', product_id: pid, config: config };
  } catch (e) {
    // Still a working link — just long, and not tracked. Not cached, so the
    // next request tries for a short one again.
    console.error('ORDER_LINK share failed for product ' + pid + ': ' + e.message);
    return { ok: true, url: base + '?config=' + encodeURIComponent(JSON.stringify(config)), method: 'inline', product_id: pid, config: config };
  }
  orderLinkCache.set(key, out);
  if (orderLinkCache.size > 2000) orderLinkCache.delete(orderLinkCache.keys().next().value);
  return out;
}

// { items: [{ product_id, quantity, width, height, specs:[{variable_id,item_id,isQuantity,value}] }] }
app.post('/api/chatbot/order-links', auth, async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 40) : [];
  if (!items.length) return res.json({ ok: false, error: 'No items' });
  try {
    const links = await Promise.all(items.map(it =>
      buildOrderLink(it).catch(e => ({ ok: false, error: e.message }))));
    res.json({ ok: true, links: links });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== Draft a reply email (ChatBot "Help to draft email") =====
// Writes the words around a quote — greeting, a short intro tied to what the
// client asked for, a close, a sign-off. The quote tables and "Order now" links
// are added by the page from the saved items, so no price is ever retyped by
// the model. When the client's email is known, the last 30 days of mail with
// them in the shared inbox set the tone.
function stripQuoted(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^On .+wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) ||
        /^From:\s.+/i.test(l.trim()) && out.length > 3) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

app.post('/api/chatbot/draft-reply', auth, async (req, res) => {
  try {
    const b = req.body || {};
    let clientName = String(b.client_name || '').trim();
    let clientEmail = String(b.client_email || '').trim().toLowerCase();
    let company = String(b.company || '').trim();
    // Fill in from the CRM when only the client id is known.
    if (parseInt(b.client_id) && (!clientName || !clientEmail)) {
      try {
        const r = await runQuery("SELECT name, last_name, company_name, email FROM customer WHERE id = " + parseInt(b.client_id));
        if (r.length) {
          if (!clientName) clientName = [r[0].name, r[0].last_name].filter(Boolean).join(' ').trim();
          if (!clientEmail) clientEmail = String(r[0].email || '').trim().toLowerCase();
          if (!company) company = String(r[0].company_name || '').trim();
        }
      } catch (e) {}
    }
    if (/@axiomprint\.com$/i.test(clientEmail)) clientEmail = '';     // staff, never the client
    const firstName = (clientName.split(/\s+/)[0] || '').replace(/[^A-Za-z'\-]/g, '');

    // Last 30 days of mail with this client, oldest first, quotes trimmed.
    let samples = [], toneNote = '';
    if (clientEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      try {
        const q = '(from:' + clientEmail + ' OR to:' + clientEmail + ') newer_than:30d';
        const mails = await gmailSearch(q, 8);
        samples = mails.reverse().map(m => {
          const fromClient = String(m.from || '').toLowerCase().indexOf(clientEmail) > -1;
          return (fromClient ? 'CLIENT' : 'AXIOMPRINT') + ' · ' + (m.date || '') + ' · ' + (m.subject || '') + '\n' +
            stripQuoted(m.body || m.snippet || '').slice(0, 700);
        });
      } catch (e) { toneNote = 'Could not read the inbox: ' + e.message; }
    }
    let toneText = samples.join('\n---\n');
    if (toneText.length > 5000) toneText = toneText.slice(-5000);

    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 12).map(it =>
      '- ' + String(it.product || '') + ': ' + (Array.isArray(it.rows) ? it.rows : []).map(r =>
        Number(r.quantity || 0).toLocaleString() + ' for $' + usd2(Number(r.price || 0))).join(', ') +
      (it.summary ? ' (' + String(it.summary).slice(0, 200) + ')' : ''));
    const request = String(b.request || '').slice(0, 2500);

    const sys = 'You write the words of a quote reply email for AxiomPrint, a print shop. ' +
      'Write any price as $1,678.54 (comma for thousands, two decimals). ' +
      'Return STRICT JSON only: {"subject":"...","greeting":"...","intro":"...","outro":"...","signoff":"..."}.\n' +
      '- greeting: "Hi <first name>," when the first name is known, otherwise "Hi there,".\n' +
      '- intro: one or two sentences in the spirit of "here is the pricing based on your request", naming what ' +
      'they asked for in plain words (product, quantities). No prices — the quote table follows the intro.\n' +
      '- outro: one or two sentences. Say each quantity has an "Order now" link that opens the product with ' +
      'everything already selected, and invite questions. If the request left something open, ask it here.\n' +
      '- signoff: e.g. "Best," or "Thanks,".\n' +
      '- subject: short, e.g. "Your quote: Raised Spot UV Business Cards".\n' +
      'Match the tone AxiomPrint has used with this client in the recent emails (warmth, formality, length); ' +
      'if there are none, warm and professional. Never invent prices, dates or promises. No markdown.';
    const userMsg = 'CLIENT: ' + (clientName || 'unknown') + (company ? ' (' + company + ')' : '') +
      '\nFIRST NAME: ' + (firstName || 'unknown') +
      '\n\nWHAT THEY ASKED FOR:\n' + (request || '(not available — describe the items below)') +
      '\n\nWHAT WE ARE QUOTING:\n' + (items.join('\n') || '(none)') +
      (toneText ? '\n\nRECENT EMAILS WITH THIS CLIENT (last 30 days, oldest first — match this tone):\n' + toneText : '');

    let parsed = {};
    try {
      const r = await anthropic.messages.create({ model: MODEL_LIGHT, max_tokens: 700, system: sys,
        messages: [{ role: 'user', content: userMsg }] });
      let txt = (r.content.find(x => x.type === 'text') || {}).text || '{}';
      txt = txt.replace(/```json|```/g, '').trim();
      const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
      if (i >= 0 && j > i) txt = txt.slice(i, j + 1);
      parsed = JSON.parse(txt);
    } catch (e) { parsed = {}; }
    const firstProduct = ((b.items || [])[0] || {}).product || 'your print job';
    res.json({
      ok: true,
      to: clientEmail || null, client_name: clientName || null, first_name: firstName || null,
      subject: parsed.subject || ('Your quote: ' + firstProduct),
      greeting: parsed.greeting || (firstName ? 'Hi ' + firstName + ',' : 'Hi there,'),
      intro: parsed.intro || 'Here is the pricing based on your request:',
      outro: parsed.outro || 'Each quantity has an Order now link that opens the product with everything already ' +
        'selected. Let me know if you have any questions.',
      signoff: parsed.signoff || 'Best,',
      tone_emails: samples.length, tone_note: toneNote || undefined
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== Single sign-on from the CRM =====
// The CRM already knows who the person is. Rather than making them log in again
// inside the widget, it hands us its own API token — which we verify AGAINST THE
// AXIOMPRINT API before trusting it. The browser never gets to assert an identity.
function shortUrl(u) { try { return new URL(u).pathname; } catch (e) { return u; } }

// The company domain from an email, or null for consumer mailboxes. A shared
// gmail.com tells you nothing about who someone works with; a company domain
// tells you almost everything.
const FREE_MAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'me.com', 'mac.com', 'live.com', 'msn.com', 'comcast.net', 'sbcglobal.net',
  'att.net', 'verizon.net', 'protonmail.com', 'proton.me', 'ymail.com',
  'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'inbox.com', 'fastmail.com'
]);
function domainOf(text) {
  const m = String(text || '').toLowerCase().match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
  if (!m) return null;
  const d = m[1];
  return FREE_MAIL.has(d) ? null : d;
}

// Excel-exported CSVs are often UTF-16 or carry a BOM. Read as UTF-8 and you get
// nulls between every character, which then fails the binary check.
function decodeText(buf) {
  if (buf.length > 1 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  if (buf.length > 1 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
    }
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

// Turn a workbook into CSV the model can read, sheet by sheet, with the row count
// stated so a truncated file is obvious rather than silently short.
function sheetsToText(XLSX, wb) {
  return (wb.SheetNames || []).map(n => {
    const sh = wb.Sheets[n];
    const csv = XLSX.utils.sheet_to_csv(sh, { blankrows: false, dateNF: 'yyyy-mm-dd' });
    const rows = csv.split(/\n/).filter(l => l.replace(/,/g, '').trim()).length;
    if (!rows) return '### ' + n + '\n(empty)';
    return '### ' + n + ' (' + rows + ' rows)\n' + csv.trim();
  }).join('\n\n');
}

// "https://axiomprint.com/product/small-poster-printing-1052" -> 1052
function productIdFromUrl(u) {
  const m = String(u || '').match(/-(\d+)\s*$/);
  return m ? parseInt(m[1]) : null;
}

// Words that carry no product meaning. "which products offer hemp paper cards"
// should search for hemp/paper/card, not for "which" and "offer" — a term that
// appears in no product makes an AND search return nothing at all.
const SEARCH_STOPWORDS = new Set([
  'which','what','who','whom','whose','where','when','how','why',
  'product','products','item','items','option','options','offer','offers','offering',
  'have','has','having','does','doe','did','can','could','would','should','will',
  'need','needs','want','wants','looking','look','find','show','give','get','make',
  'the','and','for','with','from','that','this','these','those','any','all','some',
  'please','thanks','order','orders','price','prices','pricing','quote','cost',
  'available','availability','print','printing','printed','custom','new'
]);

// Trade shorthand people actually type, expanded to the words the database uses.
// "14pt c1s" has to become "14pt coated 1 side" — c1s appears nowhere in the data,
// so without this the most specific part of a request matches nothing at all.
const SEARCH_SYNONYMS = {
  // "coated outside" is how some products word C1S (Scored Header Cards calls it
  // "14PT Coated Outside, Uncoated Inside"), so both spellings have to be reachable.
  c1s: ['coated', '1', 'side', 'outside'],
  c2s: ['coated', '2', 'side'],
  coated1side: ['coated', '1', 'side', 'outside'],
  coatedoneside: ['coated', '1', 'side', 'outside'],
  scoring: ['score'],
  scored: ['score'],
  crease: ['score'],
  creased: ['score'],
  perf: ['perforation'],
  perfed: ['perforation'],
  diecut: ['die', 'cut'],
  numbering: ['variable', 'data'],
  vdp: ['variable', 'data'],
  bleed: ['bleed'],
  ncr: ['carbonless'],
  saddlestitch: ['saddle', 'stitch'],
  perfectbound: ['perfect', 'bound'],
  wiro: ['wire'],
  spiral: ['coil'],
  gloss: ['gloss'],
  matt: ['matte'],
  velvet: ['soft', 'touch'],
  linen: ['linen'],
  hemp: ['hemp'],
  '1s': ['1', 'side'],
  '2s': ['2', 'side'],
  uncoated: ['uncoated'],
  gloss: ['gloss'],
  matte: ['matte'],
  dull: ['matte'],
  softtouch: ['soft', 'touch'],
  spotuv: ['spot', 'uv'],
  suede: ['soft', 'touch'],
  aq: ['aqueous'],
  '4/4': ['both', 'side'],
  '4/0': ['front', 'only'],
  '5/0': ['white', 'front'],
  cmyk: ['full', 'color'],
  fullcolor: ['full', 'color'],
  doublesided: ['front', 'back'],
  twosided: ['front', 'back'],
  onesided: ['front', 'only'],
  eddm: ['eddm'],
  lam: ['lamination'],
  laminated: ['lamination'],
  pt: [],
  lb: []
};

// Materials people ask for by what they DO rather than what the option is called.
// "Synthetic paper" is never an option title — the stock is "15Mil White PVC" or
// "Yupo". A spec word listed here matches ANY of its alternatives, in the options
// or in the product name, so "synthetic menus" finds Plastic Menus.
const MATERIAL_ALTS = (function () {
  const synthetic = ['synthetic', 'pvc', 'plastic', 'polypropylene', 'yupo', 'polyester', 'styrene', 'tyvek'];
  return {
    synthetic: synthetic, plastic: synthetic, pvc: synthetic, polypropylene: synthetic, yupo: synthetic, tyvek: synthetic,
    waterproof: synthetic.concat(['vinyl']), 'water-proof': synthetic.concat(['vinyl']),
    tearproof: synthetic, 'tear-proof': synthetic, untearable: synthetic,
    acrylic: ['acrylic', 'plexi'], plexiglass: ['acrylic', 'plexi'], plexi: ['acrylic', 'plexi'],
    aluminum: ['aluminum', 'aluminium', 'dibond', 'acm'], metal: ['aluminum', 'aluminium', 'dibond', 'acm', 'metal'],
    magnetic: ['magnet'], magnet: ['magnet'],
    wood: ['wood', 'birch', 'bamboo'], wooden: ['wood', 'birch', 'bamboo']
  };
})();

// Spec words in the person's own question that the model left out of `specs`.
// Only material / jargon words count — "what", "use" and "menus" never do.
function specWordsFrom(text, already) {
  const have = new Set((already || []).map(x => String(x).toLowerCase()));
  const out = [];
  String(text || '').toLowerCase().replace(/[^a-z0-9\- ]+/g, ' ').split(/\s+/).forEach(w => {
    if (!w || have.has(w) || out.indexOf(w) > -1) return;
    if (MATERIAL_ALTS[w] || (JARGON[w] && JARGON[w].length) || SEARCH_SYNONYMS[w] && SEARCH_SYNONYMS[w].length) out.push(w);
  });
  return out.slice(0, 4);
}

// Live jargon map, loaded from the table and refreshed on save. Falls back to
// SEARCH_SYNONYMS if the table is empty for any reason.
let JARGON = {};
function loadJargon() {
  db.all("SELECT term, expands_to FROM print_jargon WHERE active = 1", [], (e, rows) => {
    if (e) return;
    const map = {};
    (rows || []).forEach(r => {
      const words = String(r.expands_to || '').split(/[,\s]+/).filter(Boolean);
      if (r.term) map[String(r.term).toLowerCase()] = words;
    });
    JARGON = Object.keys(map).length ? map : SEARCH_SYNONYMS;
  });
}

// First run: move the built-in list into the table so it is editable from then on.
function seedJargon() {
  db.get('SELECT COUNT(*) AS n FROM print_jargon', [], (e, row) => {
    if (e || (row && row.n > 0)) return;
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO print_jargon (term, expands_to, category, created_by) VALUES (?,?,?,?)');
    Object.keys(SEARCH_SYNONYMS).forEach(k => {
      const cat = /lam|mil/.test(k) ? 'lamination'
        : /vinyl|bopp|styrene|coroplast|foam|acrylic|fabric|mesh/.test(k) ? 'material'
        : /c1s|c2s|1s|2s|uncoated|gloss|matte|dull|aq|pt|lb|linen|hemp/.test(k) ? 'paper'
        : /uv|touch|suede|foil|emboss/.test(k) ? 'finish'
        : /4\/|cmyk|color|sided/.test(k) ? 'printing' : 'general';
      stmt.run(k, SEARCH_SYNONYMS[k].join(' '), cat, 'seed');
    });
    stmt.finalize(() => { console.log('JARGON seeded from built-in list'); loadJargon(); });
  });
}

// Record a term that matched nothing, so the team can see what to teach it.
function noteJargonMiss(term, query) {
  if (!term || term.length < 2) return;
  db.run('INSERT INTO jargon_misses (term, misses, last_query, last_seen) VALUES (?,1,?,datetime(\'now\')) ' +
    'ON CONFLICT(term) DO UPDATE SET misses = misses + 1, last_query = excluded.last_query, ' +
    'last_seen = datetime(\'now\')', [String(term).toLowerCase(), String(query || '').slice(0, 200)], () => {});
}

// Stem for LIKE matching. "scoring" must find "Scored", "Score" and "Scores" —
// without this the most descriptive word in a request matches nothing, which is
// how "which product has scoring" concluded we don't offer it.
function likeStem(w) {
  const t = String(w || '').toLowerCase();
  if (t.length > 5 && /ing$/.test(t)) return t.slice(0, -3);
  if (t.length > 4 && /ed$/.test(t)) return t.slice(0, -2);
  if (t.length > 4 && /es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && /s$/.test(t)) return t.slice(0, -1);
  return t;
}

// SQL condition for one search word against a column. Guards against matching a
// word inside its own negation: "coated" must NOT match "60# White Uncoated Paper",
// which is how Roll Labels turned up in a search for coated stock and scoring.
function termCond(col, w) {
  const t = String(w || '').toLowerCase();

  // Measurements are exact. "5mil" must match "5 Mil Gloss Lamination" and
  // "Gloss Lamination - 5 Mil", but NOT "15 Mil" or "3.5Mil" — a substring match
  // silently returns the wrong thickness, which reads as a correct answer.
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(pt|mil|lb|oz|gsm)$/);
  if (m) {
    const num = m[1].replace('.', '\\.');
    // Trailing boundary matters too: "5 mil" must not match "Within 5 Miles".
    return col + ' REGEXP ' + mysql.escape('(^|[^0-9.])' + num + '[[:space:]]*' + m[2] + '([^a-z]|$)');
  }

  const stem = likeStem(t);
  const base = col + ' LIKE ' + mysql.escape('%' + stem + '%');
  // Don't let a word match inside its own negation: "coated" vs "Uncoated".
  if (stem.length > 3 && !/^un/.test(stem)) {
    return '(' + base + ' AND ' + col + ' NOT LIKE ' + mysql.escape('%un' + stem + '%') + ')';
  }
  return base;
}

function isMeasurement(w) {
  return /^\d+(?:\.\d+)?\s*(pt|mil|lb|oz|gsm)$/.test(String(w || '').toLowerCase());
}

// A spec the person stated ("14pt c1s") becomes a GROUP of words. A product has
// to satisfy every group, not a percentage of the words — "14pt c1s AND scoring"
// means both, and a brochure with scoring on 100# text is not an answer.
function specGroupCond(cols, words) {
  if (!words.length) return '1';
  // Within one spec, a MEASUREMENT must match ("5mil" is not optional), while
  // descriptive words are alternatives — "14pt c1s" should still find
  // "14PT Coated Outside, Uncoated Inside" even though it says neither "1" nor "side".
  const measures = words.filter(isMeasurement);
  const descriptive = words.filter(w => !isMeasurement(w));
  const chunks = [];
  measures.forEach(w => {
    chunks.push('(' + cols.map(c => termCond(c, w)).join(' OR ') + ')');
  });
  if (descriptive.length) {
    const any = [];
    descriptive.forEach(w => cols.forEach(c => any.push(termCond(c, w))));
    chunks.push('(' + any.join(' OR ') + ')');
  }
  return '(' + chunks.join(' AND ') + ')';
}

// Split a query into meaningful, de-pluralised search terms.
function searchTerms(q) {
  let raw = String(q || '').toLowerCase().replace(/[^a-z0-9. ]+/g, ' ')
    .split(/\s+/).filter(Boolean).map(w => w.replace(/\.$/, ''));
  // Rejoin a number that was typed apart from its unit: "5 mil" -> "5mil".
  // Otherwise the "5" is dropped as too short and the thickness is lost.
  const joined = [];
  for (let i = 0; i < raw.length; i++) {
    const nxt = raw[i + 1];
    if (/^\d+(?:\.\d+)?$/.test(raw[i]) && nxt && /^(pt|mil|lb|oz|gsm)$/.test(nxt)) {
      joined.push(raw[i] + nxt);
      i++;
    } else {
      joined.push(raw[i]);
    }
  }
  raw = joined;

  const kept = [];
  raw.forEach(w => {
    if (SEARCH_STOPWORDS.has(w)) return;
    // Expand shorthand first — c1s is 3 chars but carries the most meaning.
    const syn = JARGON[w] || SEARCH_SYNONYMS[w];
    if (syn) {
      syn.forEach(x => { if (kept.indexOf(x) === -1) kept.push(x); });
      return;
    }
    // Split things like "14pt" into "14pt" AND "14" so both forms match.
    const m = w.match(/^(\d+(?:\.\d+)?)(pt|lb|mil|oz|gsm)$/);
    if (m) { if (kept.indexOf(w) === -1) kept.push(w); return; }
    if (w.length > 2) {
      const t = w.replace(/s$/, '');
      if (kept.indexOf(t) === -1) kept.push(t);
    }
  });
  // If stripping left nothing, fall back to the longer raw words rather than
  // searching for an empty string.
  return kept.length ? kept : raw.filter(w => w.length > 2).map(w => w.replace(/s$/, ''));
}

app.post('/api/auth/crm', async (req, res) => {
  const crmToken = String((req.body && req.body.crm_token) || '').trim();
  if (!crmToken) return res.status(400).json({ error: 'No CRM token supplied' });

  // Try each candidate route and auth style, and report exactly what each said.
  // Relying on the server log made this a guessing game; the widget now shows the
  // upstream status itself.
  // Confirmed by the CRM team: GET /api/v1/me with the bearer token.
  const DEFAULT_VERIFY = 'https://laravelapi.axiomprint.com/api/v1/me';
  const candidates = [];
  (process.env.AXIOM_AUTH_VERIFY_URL || '')
    .split(',').map(x => x.trim()).filter(Boolean)
    .forEach(u => {
      // Reject anything that isn't a clean http(s) URL. A placeholder pasted
      // from documentation — "…" or "<url>" — became a real request to
      // /api/v1/%E2%80%A6 and 404'd, which read like an auth failure.
      if (!/^https?:\/\/[\x21-\x7e]+$/.test(u) || /[<>\u2026]/.test(u)) {
        console.log('CRM_SSO ignoring malformed AXIOM_AUTH_VERIFY_URL: ' + u);
        return;
      }
      candidates.push(u);
    });
  if (!candidates.length) candidates.push(DEFAULT_VERIFY);

  let who = null;
  const tried = [];
  try {
    let text = '', ok = false;
    for (const url of candidates) {
      for (const style of ['bearer', 'raw']) {
        const headers = { 'Accept': 'application/json' };
        headers['Authorization'] = (style === 'bearer' ? 'Bearer ' : '') + crmToken;
        let r;
        try { r = await fetch(url, { method: 'GET', headers: headers }); }
        catch (fe) { tried.push(shortUrl(url) + ' [' + style + '] network error'); continue; }
        const body = await r.text();
        tried.push(shortUrl(url) + ' [' + style + '] ' + r.status);
        if (r.ok) { text = body; ok = true; break; }
      }
      if (ok) break;
    }
    console.log('CRM_SSO verify=' + candidates.join(',') + ' | tried: ' + tried.join(' | '));
    if (!ok) {
      // A 404 means the ROUTE is wrong, not the credential. Reporting it as a
      // rejected token sent us hunting for auth problems that did not exist.
      const all404 = tried.length && tried.every(t => / 404$/.test(t));
      return res.status(401).json({
        error: all404
          ? 'The verification URL is wrong — every attempt returned 404. Check AXIOM_AUTH_VERIFY_URL.'
          : 'The CRM API did not accept that token.',
        tried: tried
      });
    }
    let out = {};
    try { out = JSON.parse(text); } catch (e) { out = {}; }
    // Laravel wraps the user differently depending on the resource, so dig for it.
    const u = out.data || out.user || out;
    who = {
      email: String(u.email || (u.user && u.user.email) || '').toLowerCase().trim(),
      name: u.name || u.display_name ||
        [u.first_name, u.last_name].filter(Boolean).join(' ') || null
    };
    console.log('CRM_SSO verified email=' + (who.email || '(none)') + ' name=' + (who.name || '(none)'));
    if (!who.email) {
      console.log('CRM_SSO no email in response: ' + text.slice(0, 300));
      return res.status(401).json({
        error: 'The CRM answered, but returned no email for this user.',
        tried: tried, sample: text.slice(0, 200)
      });
    }
  } catch (e) {
    console.error('CRM_SSO error', e.message);
    return res.status(502).json({ error: 'Could not reach the CRM: ' + e.message, tried: tried });
  }

  const email = who.email;
  const local = await new Promise(r2 =>
    db.get('SELECT username, is_admin FROM users WHERE LOWER(username) = ? OR LOWER(username) = ?',
      [email, email.split('@')[0]], (e, row) => r2(e ? null : row)));
  if (local) {
    const token = jwt.sign(
      { key: 'user:' + local.username, username: local.username, is_admin: !!local.is_admin },
      process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, username: local.username, is_admin: !!local.is_admin, via: 'crm' });
  }

  let member = await new Promise(r2 =>
    db.get('SELECT email, display_name, is_admin, enabled FROM members WHERE LOWER(email) = ?',
      [email], (e, row) => r2(e ? null : row)));

  // A verified CRM user who isn't on the member list: add them only when that has
  // been switched on deliberately, so SSO can't quietly widen who has access.
  if (!member && String(process.env.NOVA_SSO_AUTOCREATE || '') === '1') {
    await new Promise(r2 => db.run(
      'INSERT OR IGNORE INTO members (email, username, display_name, enabled, added_by) VALUES (?,?,?,1,?)',
      [email, email.split('@')[0], who.name || email, 'crm-sso'], () => r2()));
    member = { email: email, display_name: who.name || email, is_admin: 0, enabled: 1 };
    console.log('CRM_SSO auto-added member ' + email);
  }

  if (!member) return res.status(403).json({ error: 'You are signed into the CRM, but not set up in Nova yet. Ask an admin to add you.' });
  if (member.enabled === 0) return res.status(403).json({ error: 'This Nova account is disabled.' });

  const token = jwt.sign(
    { key: 'member:' + member.email, username: member.display_name || member.email, is_admin: !!member.is_admin },
    process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: member.display_name || member.email, is_admin: !!member.is_admin, via: 'crm' });
});

// ----- Signed handoff -----
// When the CRM authenticates with a session cookie there is no bearer token to
// exchange. Instead the CRM renders a short signed payload naming the logged-in
// user; we verify the signature with a shared secret, so the browser still can't
// claim to be someone it isn't. Needs no API call and no new CRM endpoint.
//
// CRM side (Blade, in the layout that loads embed.js):
//   @php
//     $p = base64_encode(json_encode([
//       'email' => auth()->user()->email,
//       'name'  => auth()->user()->name,
//       'ts'    => time(),
//     ]));
//     $sig = hash_hmac('sha256', $p, env('NOVA_SSO_SECRET'));
//   @endphp
//   <script>window.NovaChat = { hideWhenLoggedOut:false, sso:{ payload:"{{ $p }}", sig:"{{ $sig }}" } };</script>
app.post('/api/auth/handoff', async (req, res) => {
  const secret = process.env.NOVA_SSO_SECRET;
  if (!secret) return res.status(501).json({ error: 'Signed sign-in is not configured on this server.' });

  const payload = String((req.body && req.body.payload) || '');
  const sig = String((req.body && req.body.sig) || '');
  if (!payload || !sig) return res.status(400).json({ error: 'Missing sign-in payload' });

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.log('HANDOFF_SSO bad signature');
    return res.status(401).json({ error: 'That sign-in could not be verified.' });
  }

  let data = {};
  try { data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); } catch (e) {
    return res.status(400).json({ error: 'Sign-in payload could not be read' });
  }

  // A signature alone would be replayable forever; require it to be recent.
  const age = Math.abs(Math.floor(Date.now() / 1000) - (Number(data.ts) || 0));
  if (!data.ts || age > 900) {
    console.log('HANDOFF_SSO stale payload age=' + age + 's');
    return res.status(401).json({ error: 'That sign-in has expired — reload the page.' });
  }

  const email = String(data.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'No email in the sign-in payload' });
  console.log('HANDOFF_SSO verified email=' + email);
  return issueNovaSession(email, data.name, res);
});

// Shared by both SSO routes: turn a VERIFIED email into a Nova session.
function issueNovaSession(email, name, res) {
  return new Promise((resolve) => {
    db.get('SELECT username, is_admin FROM users WHERE LOWER(username) = ? OR LOWER(username) = ?',
      [email, email.split('@')[0]], (e, local) => {
        if (local) {
          const token = jwt.sign(
            { key: 'user:' + local.username, username: local.username, is_admin: !!local.is_admin },
            process.env.JWT_SECRET, { expiresIn: '30d' });
          res.json({ token, username: local.username, is_admin: !!local.is_admin, via: 'sso' });
          return resolve();
        }
        db.get('SELECT email, display_name, is_admin, enabled FROM members WHERE LOWER(email) = ?',
          [email], async (e2, member) => {
            if (!member && String(process.env.NOVA_SSO_AUTOCREATE || '') === '1') {
              await new Promise(r3 => db.run(
                'INSERT OR IGNORE INTO members (email, username, display_name, enabled, added_by) VALUES (?,?,?,1,?)',
                [email, email.split('@')[0], name || email, 'sso'], () => r3()));
              member = { email: email, display_name: name || email, is_admin: 0, enabled: 1 };
              console.log('SSO auto-added member ' + email);
            }
            if (!member) {
              res.status(403).json({ error: 'You are signed into the CRM, but not set up in Nova yet. Ask an admin to add you.' });
              return resolve();
            }
            if (member.enabled === 0) {
              res.status(403).json({ error: 'This Nova account is disabled.' });
              return resolve();
            }
            const token = jwt.sign(
              { key: 'member:' + member.email, username: member.display_name || member.email, is_admin: !!member.is_admin },
              process.env.JWT_SECRET, { expiresIn: '30d' });
            res.json({ token, username: member.display_name || member.email, is_admin: !!member.is_admin, via: 'sso' });
            resolve();
          });
      });
  });
}

// ===== ChatBot widget preferences (per signed-in user) =====
const WIDGET_DEFAULTS = {
  scale: 1,          // 0.85 - 1.3  overall size
  side: 'right',     // 'right' | 'left'
  accent: 'indigo',  // colour theme
  fontSize: 14,      // 12 - 17 px
  panelWidth: 1080,  // 760 - 1600 px — wide enough for chat + calculator side by side
  panelHeight: 700   // 480 - 1000 px
};
// Bumped when the widget layout changes size. 2 = the two-panel ChatBot layout;
// sizes saved for the old one-column widget (480 x 560) are replaced, or the
// panel would open too narrow for its second column.
const WIDGET_LAYOUT = 2;
const ACCENTS = {
  indigo:  { main: '#7C6FE0', dark: '#5F51C7', light: '#efedfd', grad: '#5B6EF5' },
  violet:  { main: '#8B5CF6', dark: '#6D28D9', light: '#f3ecfe', grad: '#A78BFA' },
  blue:    { main: '#3B82F6', dark: '#1D4ED8', light: '#e8f0fe', grad: '#60A5FA' },
  teal:    { main: '#0D9488', dark: '#0F766E', light: '#e3f6f4', grad: '#2DD4BF' },
  rose:    { main: '#E11D48', dark: '#9F1239', light: '#fdeaef', grad: '#FB7185' },
  slate:   { main: '#475569', dark: '#334155', light: '#eef1f5', grad: '#64748B' }
};

function cleanPrefs(raw) {
  const p = Object.assign({}, WIDGET_DEFAULTS, raw || {});
  if (!raw || Number(raw.layout) !== WIDGET_LAYOUT) {
    p.panelWidth = WIDGET_DEFAULTS.panelWidth;
    p.panelHeight = WIDGET_DEFAULTS.panelHeight;
  }
  const num = (v, min, max, dflt) => {
    const n = Number(v);
    return isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  return {
    scale: num(p.scale, 0.85, 1.3, 1),
    side: p.side === 'left' ? 'left' : 'right',
    accent: ACCENTS[p.accent] ? p.accent : 'indigo',
    fontSize: Math.round(num(p.fontSize, 12, 17, 14)),
    panelWidth: Math.round(num(p.panelWidth, 760, 1600, WIDGET_DEFAULTS.panelWidth)),
    panelHeight: Math.round(num(p.panelHeight, 480, 1000, WIDGET_DEFAULTS.panelHeight)),
    layout: WIDGET_LAYOUT
  };
}

// ===== Installation & delivery pricing =====
// Everyone signed in reads the rates (the calculator card needs them); only
// admins change them.
function installPricingWho(req) {
  return (req.user && (req.user.username || req.user.email || String(req.user.key || '').replace(/^(member|user):/, ''))) || 'unknown';
}

// A saved config must still be a working price list: every rate a number,
// nothing negative, and the lists the calculator draws from not empty.
function validateInstallPricing(cfg) {
  const errs = [];
  const walk = (v, path) => {
    if (typeof v === 'number') {
      if (!isFinite(v)) errs.push(path + ' is not a number');
      else if (v < 0) errs.push(path + ' cannot be negative');
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '[' + i + ']'));
    else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], path ? path + '.' + k : k));
  };
  walk(cfg, '');
  const I = cfg.install || {}, D = cfg.delivery || {};
  const need = [['install.levels', I.levels], ['install.materials', I.materials], ['install.insurance', I.insurance],
                ['install.crew.steps', I.crew && I.crew.steps], ['delivery.traffic', D.traffic], ['zones', cfg.zones]];
  need.forEach(([n, a]) => { if (!Array.isArray(a) || !a.length) errs.push(n + ' needs at least one row'); });
  const ids = (a) => (a || []).map(x => x && x.id);
  [['materials', I.materials], ['equipment', I.equipment], ['insurance', I.insurance], ['traffic', D.traffic]].forEach(([n, a]) => {
    const list = ids(a);
    if (list.some(x => !x)) errs.push(n + ': every row needs an id');
    if (new Set(list).size !== list.length) errs.push(n + ': ids must be unique');
  });
  if (I.hours && !(Number(I.hours.sqft_per_installer_hour) > 0)) errs.push('Sq ft per installer-hour must be above 0');
  if (I.hours && !(Number(I.hours.round_to) > 0)) errs.push('Hour rounding must be above 0');
  if (D && !(Number(D.avg_mph) > 0)) errs.push('Average speed must be above 0');
  return errs;
}

app.get('/api/install-pricing', auth, (req, res) => {
  res.json({ success: true, config: installPricing, meta: installPricingMeta, defaults: InstallPricing.DEFAULTS });
});

// ===== Reports =====
app.get('/api/reports', auth, (req, res) => res.json({ success: true, reports: Reports.list() }));
app.post('/api/reports/:id', auth, async (req, res) => {
  try {
    const out = await Reports.run(req.params.id, (req.body && req.body.params) || {});
    res.json({ success: true, report: out });
  } catch (e) {
    console.error('REPORT ' + req.params.id + ' failed:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Road miles and drive time from the shop to an address, for the calculator.
app.get('/api/route', auth, async (req, res) => {
  const r = await routeLookup(req.query.address, { date: req.query.date, time: req.query.time });
  res.json(r);
});

app.get('/api/admin/install-pricing/history', auth, adminOnly, (req, res) => {
  db.all('SELECT id, changed_by, note, changed_at FROM install_pricing_history ORDER BY id DESC LIMIT 25', [], (e, rows) => {
    if (e) return res.json({ success: false, error: e.message });
    res.json({ success: true, history: rows || [] });
  });
});

app.post('/api/admin/install-pricing', auth, adminOnly, (req, res) => {
  let cfg;
  try { cfg = InstallPricing.withDefaults(req.body && req.body.config); }
  catch (e) { return res.json({ success: false, error: 'Config could not be read' }); }
  const errs = validateInstallPricing(cfg);
  if (errs.length) return res.json({ success: false, error: errs.slice(0, 6).join('; ') });
  const who = installPricingWho(req);
  const json = JSON.stringify(cfg);
  db.run('INSERT INTO install_pricing (id, config, updated_by, updated_at) VALUES (1, ?, ?, datetime(\'now\')) ' +
         'ON CONFLICT(id) DO UPDATE SET config=excluded.config, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
    [json, who], (err) => {
      if (err) return res.json({ success: false, error: err.message });
      db.run('INSERT INTO install_pricing_history (config, changed_by, note) VALUES (?,?,?)',
        [json, who, String((req.body && req.body.note) || '').slice(0, 200)], () => {});
      installPricing = cfg;
      installPricingMeta = { updated_by: who, updated_at: new Date().toISOString(), is_default: false };
      res.json({ success: true, config: installPricing, meta: installPricingMeta });
    });
});

// Put back an earlier saved version (or the training-document defaults).
app.post('/api/admin/install-pricing/restore', auth, adminOnly, (req, res) => {
  const who = installPricingWho(req);
  const apply = (cfg, note) => {
    const json = JSON.stringify(cfg);
    db.run('INSERT INTO install_pricing (id, config, updated_by, updated_at) VALUES (1, ?, ?, datetime(\'now\')) ' +
           'ON CONFLICT(id) DO UPDATE SET config=excluded.config, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
      [json, who], (err) => {
        if (err) return res.json({ success: false, error: err.message });
        db.run('INSERT INTO install_pricing_history (config, changed_by, note) VALUES (?,?,?)', [json, who, note], () => {});
        installPricing = cfg;
        installPricingMeta = { updated_by: who, updated_at: new Date().toISOString(), is_default: false };
        res.json({ success: true, config: installPricing, meta: installPricingMeta });
      });
  };
  const hid = parseInt(req.body && req.body.history_id);
  if (!hid) return apply(InstallPricing.withDefaults(null), 'Reset to defaults');
  db.get('SELECT config, changed_at FROM install_pricing_history WHERE id = ?', [hid], (e, row) => {
    if (e || !row) return res.json({ success: false, error: 'That version was not found' });
    try { apply(InstallPricing.withDefaults(JSON.parse(row.config)), 'Restored version from ' + row.changed_at); }
    catch (err) { res.json({ success: false, error: 'That version could not be read' }); }
  });
});

app.get('/api/widget-prefs', auth, (req, res) => {
  const key = String((req.user && req.user.key) || '');
  db.get('SELECT prefs FROM widget_prefs WHERE user_key = ?', [key], (err, row) => {
    let stored = {};
    if (!err && row && row.prefs) { try { stored = JSON.parse(row.prefs); } catch (e) {} }
    res.json({ success: true, prefs: cleanPrefs(stored), accents: ACCENTS, defaults: WIDGET_DEFAULTS });
  });
});

app.post('/api/widget-prefs', auth, (req, res) => {
  const key = String((req.user && req.user.key) || '');
  if (!key) return res.status(401).json({ error: 'Unauthorized' });
  const prefs = cleanPrefs(req.body && req.body.prefs);
  db.run(
    'INSERT INTO widget_prefs (user_key, prefs, updated_at) VALUES (?, ?, datetime(\'now\')) ' +
    'ON CONFLICT(user_key) DO UPDATE SET prefs = excluded.prefs, updated_at = datetime(\'now\')',
    [key, JSON.stringify(prefs)],
    function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, prefs: prefs });
    });
});

// What is actually in the ChatBot's head right now? Confirms the training fields
// are loaded and shows their size, rather than leaving it to guesswork.
app.get('/api/admin/prompt-check', auth, knowledgeGuard, async (req, res) => {
  try {
    const brain = await loadCompanyBrain('business cards');
    const ag = await new Promise(r =>
      db.get('SELECT role, rules, workflow, knowledge FROM agents WHERE slug = ?', ['chatbot'],
        (e, row) => r(e ? null : row)));
    res.json({
      success: true,
      training: {
        role: (ag && ag.role || '').length,
        rules: (ag && ag.rules || '').length,
        workflow: (ag && ag.workflow || '').length,
        knowledge: (ag && ag.knowledge || '').length,
        total: (brain.training || '').length,
        loaded: !!(brain.training || '').trim(),
        position: 'first — before the data dictionary and reference material'
      },
      // Which documents are actually reaching the prompt, by title. A doc that
      // is saved but not shared with ChatBot silently never loads, and there was
      // no way to tell that apart from the model ignoring it.
      documents: await new Promise(r =>
        db.all("SELECT title, agents, kind, LENGTH(COALESCE(body,'')) AS size FROM knowledge_docs ORDER BY id DESC",
          [], (e, rows) => r((rows || []).map(d => {
            let shared = true;
            if (d.agents && d.agents !== 'all') {
              try { shared = (JSON.parse(d.agents) || []).indexOf('chatbot') > -1; }
              catch (e2) { shared = false; }
            }
            const isGuide = (d.kind || 'doc') === 'product_guide';
            return {
              title: d.title,
              size: d.size,
              in_prompt: isGuide ? 'only when its family is mentioned' : (shared ? 'yes' : 'NO — not shared with ChatBot'),
              kind: d.kind || 'doc'
            };
          })))),
      also_loaded: {
        domain_knowledge: (brain.docs || '').length,
        meeting_notes: (brain.meetings || '').length,
        product_guides: (brain.guides || '').length,
        approved_answers: (brain.approved || '').length
      },
      applies_to: ['nova.axiomprint.com/chatbot', 'CRM embedded widget'],
      note: 'Both surfaces call POST /api/chatbot/chat, so they share one prompt.'
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== Product family profiles =====
// Reads the live catalogue and writes a knowledge document describing one family
// of products: which fields repeat, what the common options are, and where the
// naming is inconsistent. The agent then knows "Paper Stock" is a real field on
// 33 business card products before it searches, instead of learning it per query.
app.post('/api/admin/product-profile', auth, knowledgeGuard, async (req, res) => {
  const term = String(req.body.term || '').trim();
  if (!term) return res.json({ success: false, error: 'Give a product family, e.g. "business card"' });
  const like = mysql.escape('%' + term + '%');
  const filter =
    '(p.title LIKE ' + like + ' OR p.public_title LIKE ' + like + ' OR p.meta_keywords LIKE ' + like + ') ' +
    "AND p.title NOT LIKE '%test%' AND p.title NOT LIKE '%Dont USE%' AND p.title NOT LIKE '%NOT USED%'";

  try {
    const products = await runQueryRaw(
      'SELECT p.id, p.title, p.product_category_id AS cat_id, ' +
      "COALESCE(pc.title, '(uncategorised)') AS category, " +
      '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_productid = p.id) AS orders ' +
      'FROM product p LEFT JOIN productcategory pc ON pc.id = p.product_category_id ' +
      'WHERE ' + filter + ' ORDER BY orders DESC LIMIT 80');
    if (!products.length) return res.json({ success: false, error: 'No products matched "' + term + '"' });

    const fields = await runQueryRaw(
      'SELECT pv.title AS field, COUNT(DISTINCT pv.product_id) AS products, ' +
      'COUNT(DISTINCT pvi.id) AS options ' +
      'FROM product p JOIN product_variables pv ON pv.product_id = p.id ' +
      'JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
      'WHERE pvi.isHidden = 0 AND ' + filter + ' ' +
      'GROUP BY pv.title ORDER BY products DESC, field');

    const opts = await runQueryRaw(
      'SELECT pv.title AS field, pvi.title AS opt, COUNT(DISTINCT pv.product_id) AS n ' +
      'FROM product p JOIN product_variables pv ON pv.product_id = p.id ' +
      'JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
      'WHERE pvi.isHidden = 0 AND ' + filter + ' ' +
      'GROUP BY pv.title, pvi.title HAVING n >= 2 ORDER BY pv.title, n DESC');

    const total = products.length;

    // Categories are how the catalogue is actually organised, and how the team
    // thinks about these products. Group by them rather than listing 41 products flat.
    const cats = {};
    products.forEach(p2 => {
      const k = p2.category || '(uncategorised)';
      (cats[k] = cats[k] || { name: k, id: p2.cat_id, items: [], orders: 0 });
      cats[k].items.push(p2);
      cats[k].orders += Number(p2.orders) || 0;
    });
    const catList = Object.values(cats).sort((a, b) => b.orders - a.orders);
    // A category holding one lone product of this family is usually a filing
    // mistake worth surfacing.
    const oddCats = catList.filter(c => c.items.length === 1 && catList.length > 2);
    const core = fields.filter(f => f.products >= Math.max(2, Math.round(total * 0.5)));
    const sometimes = fields.filter(f => f.products < Math.max(2, Math.round(total * 0.5)) && f.products > 1);
    const rare = fields.filter(f => f.products === 1);

    // Fields whose names are near-duplicates of a core field — the reason a
    // search for "printed sides" misses a product that calls it "Print Sides".
    // Compare on STEMMED TOKENS, so "Print_Sides" and "Printed_Sides" are seen as
    // the same field. Plain string comparison misses exactly the pairs that cause
    // trouble, because the difference is a suffix rather than extra words.
    const tokensOf = t => String(t).toLowerCase().split(/[^a-z0-9]+/)
      .filter(Boolean).map(likeStem).sort();
    const norm = t => String(t).toLowerCase().replace(/[^a-z]/g, '');
    const variants = [];
    fields.forEach(f => {
      const ft = tokensOf(f.field), fn = norm(f.field);
      core.forEach(c => {
        if (f.field === c.field) return;
        const ct = tokensOf(c.field), cn = norm(c.field);
        const sameTokens = ft.length === ct.length && ft.every((x, i) => x === ct[i]);
        const contained = fn.indexOf(cn) > -1 || cn.indexOf(fn) > -1;
        if (sameTokens || contained) {
          variants.push({ variant: f.field, on: f.products, main: c.field, mainOn: c.products });
        }
      });
    });

    const optsFor = f => opts.filter(o => o.field === f).slice(0, 12);
    let md = '# ' + term.replace(/\b\w/g, ch => ch.toUpperCase()) + ' — product family guide\n\n';
    md += 'Generated from the live catalogue. ' + total + ' products in this family.\n\n';
    md += '## Categories\n\nThis family spans ' + catList.length + ' categor' +
      (catList.length === 1 ? 'y' : 'ies') + '. Use the category to tell a standard ' +
      'product from a specialty one.\n\n';
    catList.forEach(c => {
      md += '| ' + c.name + ' | ' + c.items.length + ' products | ' +
        c.orders.toLocaleString() + ' orders |\n';
    });

    md += '\n## The products, by category\n\n';
    catList.forEach(c => {
      md += '### ' + c.name + (c.id ? '  _(category ' + c.id + ')_' : '') + '\n\n';
      c.items.slice(0, 30).forEach(p2 => {
        md += '- **' + p2.title + '** (#' + p2.id + ')' +
          (p2.orders ? ' — ' + Number(p2.orders).toLocaleString() + ' orders' : ' — not yet ordered') + '\n';
      });
      md += '\n';
    });
    if (oddCats.length) {
      md += '**Possibly miscategorised:** ' +
        oddCats.map(c => c.items[0].title + ' (#' + c.items[0].id + ') sits in "' + c.name + '"').join('; ') +
        '.\n\n';
    }

    md += '\n## Fields on most of them\n\nThese are the questions worth asking about any product in this family.\n\n';
    core.forEach(f => {
      md += '### ' + f.field.replace(/_/g, ' ') + '  \n';
      md += '_On ' + f.products + ' of ' + total + ' products._\n\n';
      const o = optsFor(f.field);
      if (o.length) {
        o.forEach(x => { md += '- ' + x.opt + '  _(' + x.n + ' products)_\n'; });
      } else {
        md += '- Options vary by product.\n';
      }
      md += '\n';
    });

    if (sometimes.length) {
      md += '## Fields on some of them\n\nOnly ask about these when the product actually has them.\n\n';
      sometimes.forEach(f => {
        const o = optsFor(f.field).slice(0, 6).map(x => x.opt).join(', ');
        md += '- **' + f.field.replace(/_/g, ' ') + '** — ' + f.products + ' products' +
          (o ? '. e.g. ' + o : '') + '\n';
      });
      md += '\n';
    }

    if (variants.length) {
      md += '## Watch out: the same thing under different names\n\n';
      md += 'These products name the same field differently. Treat them as equivalent.\n\n';
      const seen = {};
      variants.forEach(v => {
        const k = v.variant + '|' + v.main;
        if (seen[k]) return;
        seen[k] = 1;
        md += '- **' + v.variant.replace(/_/g, ' ') + '** (' + v.on + ') is the same as **' +
          v.main.replace(/_/g, ' ') + '** (' + v.mainOn + ')\n';
      });
      md += '\n';
    }

    if (rare.length) {
      md += '## One-off fields\n\nOn a single product each: ' +
        rare.map(f => f.field.replace(/_/g, ' ')).join(', ') + '.\n\n';
    }

    // Generated, NOT saved. Read it, fix the title, then Save — a guide shapes
    // every future answer about this family, so it should be looked at first.
    const title = term.replace(/\b\w/g, ch => ch.toUpperCase()) + ' — product guide';
    res.json({
      success: true,
      title: title,
      family: term.toLowerCase(),
      products: total,
      categories: catList.map(c => ({ name: c.name, products: c.items.length, orders: c.orders })),
      core_fields: core.length,
      variants: variants.length,
      odd_categories: oddCats.length,
      body: md,
      chars: md.length
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Save a generated guide. Re-saving the same family replaces it rather than
// stacking near-identical copies.
app.post('/api/admin/product-guides', auth, knowledgeGuard, (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  const family = String(req.body.family || '').toLowerCase().trim();
  if (!title || !body) return res.json({ success: false, error: 'Title and body are both needed' });
  const who = (req.user && (req.user.username || req.user.email)) || 'guide';
  db.get("SELECT id FROM knowledge_docs WHERE kind = 'product_guide' AND family = ?", [family], (e, row) => {
    if (row && row.id) {
      db.run("UPDATE knowledge_docs SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?",
        [title, body, row.id], (e2) => {
          if (e2) return res.json({ success: false, error: e2.message });
          res.json({ success: true, id: row.id, replaced: true });
        });
    } else {
      db.run('INSERT INTO knowledge_docs (title, body, agents, created_by, kind, family) VALUES (?,?,?,?,?,?)',
        [title, body, 'all', who, 'product_guide', family], function (e2) {
          if (e2) return res.json({ success: false, error: e2.message });
          res.json({ success: true, id: this.lastID, replaced: false });
        });
    }
  });
});

app.get('/api/admin/product-guides', auth, knowledgeGuard, (req, res) => {
  db.all("SELECT id, title, family, LENGTH(body) AS chars, updated_at, created_by " +
         "FROM knowledge_docs WHERE kind = 'product_guide' ORDER BY family", [], (e, rows) => {
    if (e) return res.json({ success: false, error: e.message });
    res.json({ success: true, guides: rows || [] });
  });
});

app.get('/api/admin/product-guides/:id', auth, knowledgeGuard, (req, res) => {
  db.get("SELECT id, title, family, body FROM knowledge_docs WHERE id = ? AND kind = 'product_guide'",
    [req.params.id], (e, row) => {
      if (e || !row) return res.json({ success: false, error: 'Not found' });
      res.json({ success: true, guide: row });
    });
});

app.delete('/api/admin/product-guides/:id', auth, knowledgeGuard, (req, res) => {
  db.run("DELETE FROM knowledge_docs WHERE id = ? AND kind = 'product_guide'", [req.params.id], (e) => {
    if (e) return res.json({ success: false, error: e.message });
    res.json({ success: true });
  });
});

// Approve an answer as a training example straight from Chat History. The team
// rarely remembers to thumbs-up mid-conversation, but a good exchange is just as
// useful found later — this is the same store the ratings feed.
app.post('/api/admin/train-from-chat', auth, adminOnly, (req, res) => {
  const messageId = parseInt(req.body.message_id);
  const kind = req.body.kind === 'bad' ? 'bad' : 'good';
  if (!messageId) return res.json({ success: false, error: 'Which message?' });

  db.get(
    'SELECT m.id, m.chat_id, m.content AS answer, ' +
    "  (SELECT m2.content FROM messages m2 WHERE m2.chat_id = m.chat_id AND m2.id < m.id " +
    "     AND m2.role = 'user' ORDER BY m2.id DESC LIMIT 1) AS question, " +
    "  COALESCE(c.agent_slug, 'chatbot') AS agent_slug " +
    'FROM messages m LEFT JOIN chats c ON c.id = m.chat_id WHERE m.id = ?',
    [messageId], (e, msg) => {
      if (e || !msg) return res.json({ success: false, error: 'Message not found' });
      const q = String(msg.question || '').trim();
      const a = String(msg.answer || '').trim();
      if (!q) return res.json({ success: false, error: 'No question found above that answer' });
      if (a.length < 25) return res.json({ success: false, error: 'That answer is too short to teach from' });

      db.run(
        'INSERT INTO training_examples (agent_slug, kind, question, answer, source_message_id) ' +
        'VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(source_message_id) DO UPDATE SET kind = excluded.kind, ' +
        'question = excluded.question, answer = excluded.answer',
        [msg.agent_slug, kind, q.slice(0, 1200), a.slice(0, 4000), messageId],
        function (err) {
          if (err) return res.json({ success: false, error: err.message });
          // Reflect it on the message too, so the thumbs match the training.
          db.run('UPDATE messages SET rating = ? WHERE id = ?',
            [kind === 'good' ? 1 : -1, messageId], () => {});
          res.json({ success: true, kind: kind });
        });
    });
});

// ===== Printing jargon =====
// The translation layer between what clients say and what the product data calls
// things. Editable by the team; no deploy needed to teach it a new word.
app.get('/api/admin/jargon', auth, knowledgeGuard, (req, res) => {
  db.all('SELECT * FROM print_jargon ORDER BY category, term', [], (e, rows) => {
    if (e) return res.json({ success: false, error: e.message });
    db.all('SELECT * FROM jargon_misses ORDER BY misses DESC, last_seen DESC LIMIT 40', [], (e2, misses) => {
      res.json({ success: true, terms: rows || [], misses: misses || [] });
    });
  });
});

app.post('/api/admin/jargon', auth, knowledgeGuard, (req, res) => {
  const term = String(req.body.term || '').toLowerCase().trim();
  const expands = String(req.body.expands_to || '').trim();
  if (!term || !expands) return res.json({ success: false, error: 'Term and expansion are both needed' });
  const who = (req.user && (req.user.username || req.user.email)) || 'unknown';
  const run = req.body.id
    ? ['UPDATE print_jargon SET term=?, expands_to=?, category=?, note=?, active=?, updated_at=datetime(\'now\') WHERE id=?',
       [term, expands, req.body.category || 'general', req.body.note || '',
        req.body.active === false ? 0 : 1, parseInt(req.body.id)]]
    : ['INSERT INTO print_jargon (term, expands_to, category, note, created_by) VALUES (?,?,?,?,?) ' +
       'ON CONFLICT(term) DO UPDATE SET expands_to=excluded.expands_to, category=excluded.category, ' +
       'note=excluded.note, active=1, updated_at=datetime(\'now\')',
       [term, expands, req.body.category || 'general', req.body.note || '', who]];
  db.run(run[0], run[1], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    // Once a word is taught, it is no longer a miss.
    db.run('DELETE FROM jargon_misses WHERE term = ?', [term], () => {});
    loadJargon();
    res.json({ success: true, id: this.lastID || req.body.id });
  });
});

app.delete('/api/admin/jargon/:id', auth, knowledgeGuard, (req, res) => {
  db.run('DELETE FROM print_jargon WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.json({ success: false, error: err.message });
    loadJargon();
    res.json({ success: true });
  });
});

app.post('/api/admin/jargon/dismiss', auth, knowledgeGuard, (req, res) => {
  db.run('DELETE FROM jargon_misses WHERE term = ?', [String(req.body.term || '').toLowerCase()], () => {
    res.json({ success: true });
  });
});

// ===== Meeting notes =====
// Global business knowledge captured from team trainings. Unlike knowledge_docs
// these are NOT assigned per-agent — every agent sees the active ones.

// List (newest meeting first). Body is trimmed for the list view.
app.get('/api/admin/meetings', auth, knowledgeGuard, (req, res) => {
  db.all('SELECT id, title, meeting_date, body, attendees, tags, active, created_by, created_at, updated_at ' +
    'FROM meeting_notes ORDER BY COALESCE(meeting_date, created_at) DESC, id DESC', [], (err, rows) => {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, meetings: rows || [] });
  });
});

// Single meeting with full body
app.get('/api/admin/meetings/:id', auth, knowledgeGuard, (req, res) => {
  db.get('SELECT * FROM meeting_notes WHERE id = ?', [parseInt(req.params.id)], (err, row) => {
    if (err || !row) return res.json({ success: false, error: 'Not found' });
    res.json({ success: true, meeting: row });
  });
});

// Create or update
app.post('/api/admin/meetings', auth, knowledgeGuard, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const body = String(b.body || '').trim();
  if (!title) return res.json({ success: false, error: 'Title is required' });
  if (!body) return res.json({ success: false, error: 'Paste the meeting notes before saving' });
  // Store the date as YYYY-MM-DD; fall back to today if not supplied.
  let mdate = String(b.meeting_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mdate)) mdate = new Date().toISOString().slice(0, 10);
  const attendees = String(b.attendees || '').trim();
  const tags = String(b.tags || '').trim();
  const active = (b.active === false || b.active === 0 || b.active === '0') ? 0 : 1;
  const who = (req.user && (req.user.username || req.user.email)) || 'admin';

  if (b.id) {
    db.run('UPDATE meeting_notes SET title = ?, meeting_date = ?, body = ?, attendees = ?, tags = ?, active = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [title, mdate, body, attendees, tags, active, parseInt(b.id)], function (err) {
        if (err) return res.json({ success: false, error: err.message });
        res.json({ success: true, id: parseInt(b.id) });
      });
  } else {
    db.run('INSERT INTO meeting_notes (title, meeting_date, body, attendees, tags, active, created_by) VALUES (?,?,?,?,?,?,?)',
      [title, mdate, body, attendees, tags, active, who], function (err) {
        if (err) return res.json({ success: false, error: err.message });
        res.json({ success: true, id: this.lastID });
      });
  }
});

// Toggle whether a meeting feeds the agents (without deleting the record)
app.post('/api/admin/meetings/toggle', auth, knowledgeGuard, (req, res) => {
  const id = parseInt(req.body.id);
  const active = req.body.active ? 1 : 0;
  if (!id) return res.json({ success: false, error: 'No meeting id' });
  db.run('UPDATE meeting_notes SET active = ?, updated_at = datetime(\'now\') WHERE id = ?', [active, id], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/admin/meetings/:id', auth, knowledgeGuard, (req, res) => {
  db.run('DELETE FROM meeting_notes WHERE id = ?', [parseInt(req.params.id)], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/admin/knowledge', auth, knowledgeGuard, (req, res) => {
  const acc = req.knowledgeAccess;
  const where = acc.level === 'own' ? ' WHERE created_by = ?' : '';
  const params = acc.level === 'own' ? [acc.author] : [];
  db.all('SELECT id, title, body, agents, created_by, created_at, updated_at FROM knowledge_docs' + where + ' ORDER BY updated_at DESC', params, (err, rows) => {
    if (err) return res.json({ success: false, error: err.message });
    rows = rows || [];
    if (!rows.length) return res.json({ success: true, docs: [], level: acc.level });
    // Attach file lists
    const ids = rows.map(r => r.id);
    db.all('SELECT id, doc_id, filename, mimetype FROM knowledge_files WHERE doc_id IN (' + ids.map(() => '?').join(',') + ')', ids, (e, files) => {
      const byDoc = {};
      (files || []).forEach(f => { (byDoc[f.doc_id] = byDoc[f.doc_id] || []).push({ id: f.id, filename: f.filename, mimetype: f.mimetype }); });
      rows.forEach(r => { r.files = byDoc[r.id] || []; });
      res.json({ success: true, docs: rows, level: acc.level });
    });
  });
});

// Create a knowledge doc. Optional files[] = [{filename, mimetype, data(base64)}].
app.post('/api/admin/knowledge/create', auth, knowledgeGuard, async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = req.body.body || '';
  let agents = req.body.agents;
  if (Array.isArray(agents)) agents = JSON.stringify(agents); else agents = 'all';
  if (!title) return res.json({ success: false, error: 'Title required' });
  const author = req.knowledgeAccess.author || req.user.username || 'admin';
  db.run('INSERT INTO knowledge_docs (title, body, agents, created_by) VALUES (?,?,?,?)',
    [title, body, agents, author], async function (err) {
      if (err) return res.json({ success: false, error: err.message });
      const docId = this.lastID;
      try { await saveKnowledgeFiles(docId, req.body.files || []); } catch (e) {}
      res.json({ success: true, id: docId });
    });
});

// Update a knowledge doc. 'own' users can only edit their own.
app.post('/api/admin/knowledge/update', auth, knowledgeGuard, (req, res) => {
  const id = parseInt(req.body.id);
  const title = (req.body.title || '').trim();
  const body = req.body.body || '';
  let agents = req.body.agents;
  if (Array.isArray(agents)) agents = JSON.stringify(agents); else agents = 'all';
  if (!id || !title) return res.json({ success: false, error: 'Missing id or title' });
  db.get('SELECT created_by FROM knowledge_docs WHERE id = ?', [id], async (e, doc) => {
    if (e || !doc) return res.json({ success: false, error: 'Not found' });
    if (req.knowledgeAccess.level === 'own' && doc.created_by !== req.knowledgeAccess.author) {
      return res.status(403).json({ success: false, error: 'You can only edit your own documents' });
    }
    db.run("UPDATE knowledge_docs SET title=?, body=?, agents=?, updated_at=datetime('now') WHERE id=?",
      [title, body, agents, id], async function (err) {
        if (err) return res.json({ success: false, error: err.message });
        try { await saveKnowledgeFiles(id, req.body.files || []); } catch (e2) {}
        res.json({ success: true });
      });
  });
});

// Delete a knowledge doc (and its files). 'own' users can only delete their own.
app.post('/api/admin/knowledge/delete', auth, knowledgeGuard, (req, res) => {
  const id = parseInt(req.body.id);
  db.get('SELECT created_by FROM knowledge_docs WHERE id = ?', [id], (e, doc) => {
    if (e || !doc) return res.json({ success: false, error: 'Not found' });
    if (req.knowledgeAccess.level === 'own' && doc.created_by !== req.knowledgeAccess.author) {
      return res.status(403).json({ success: false, error: 'You can only delete your own documents' });
    }
    // Remove files from disk
    db.all('SELECT path FROM knowledge_files WHERE doc_id = ?', [id], (e2, files) => {
      (files || []).forEach(f => { try { if (f.path) fs.unlinkSync(f.path); } catch (x) {} });
      db.run('DELETE FROM knowledge_files WHERE doc_id = ?', [id]);
      db.run('DELETE FROM knowledge_docs WHERE id = ?', [id], function (err) {
        if (err) return res.json({ success: false, error: err.message });
        res.json({ success: true });
      });
    });
  });
});

// Delete a single attachment.
app.post('/api/admin/knowledge/file-delete', auth, knowledgeGuard, (req, res) => {
  const fileId = parseInt(req.body.file_id);
  db.get('SELECT kf.path, kf.doc_id, kd.created_by FROM knowledge_files kf JOIN knowledge_docs kd ON kf.doc_id = kd.id WHERE kf.id = ?', [fileId], (e, row) => {
    if (e || !row) return res.json({ success: false, error: 'Not found' });
    if (req.knowledgeAccess.level === 'own' && row.created_by !== req.knowledgeAccess.author) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try { if (row.path) fs.unlinkSync(row.path); } catch (x) {}
    db.run('DELETE FROM knowledge_files WHERE id = ?', [fileId], function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true });
    });
  });
});

// Download an attachment.
app.get('/api/admin/knowledge/file/:id', auth, knowledgeGuard, (req, res) => {
  db.get('SELECT kf.filename, kf.mimetype, kf.path, kd.created_by FROM knowledge_files kf JOIN knowledge_docs kd ON kf.doc_id = kd.id WHERE kf.id = ?', [parseInt(req.params.id)], (e, row) => {
    if (e || !row) return res.status(404).send('Not found');
    if (req.knowledgeAccess.level === 'own' && row.created_by !== req.knowledgeAccess.author) return res.status(403).send('Forbidden');
    if (!row.path || !fs.existsSync(row.path)) return res.status(404).send('File missing');
    res.setHeader('Content-Type', row.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + (row.filename || 'file') + '"');
    fs.createReadStream(row.path).pipe(res);
  });
});

// Save base64 file attachments for a doc, extracting text for agents where possible.
const KNOWLEDGE_DIR = '/opt/axiom-ai/knowledge_files';
async function saveKnowledgeFiles(docId, files) {
  if (!Array.isArray(files) || !files.length) return;
  try { if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true }); } catch (e) {}
  for (const f of files) {
    if (!f || !f.data || !f.filename) continue;
    const safe = String(f.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const diskName = docId + '_' + Date.now() + '_' + safe;
    const full = path.join(KNOWLEDGE_DIR, diskName);
    try {
      const buf = Buffer.from(f.data, 'base64');
      fs.writeFileSync(full, buf);
      let extracted = '';
      try { extracted = await extractFileText(buf, f.mimetype, f.filename); } catch (e) {}
      db.run('INSERT INTO knowledge_files (doc_id, filename, mimetype, path, extracted_text) VALUES (?,?,?,?,?)',
        [docId, f.filename, f.mimetype || '', full, extracted || '']);
    } catch (e) { /* skip bad file */ }
  }
}

// Helper: fetch the knowledge text that applies to a given agent slug, concatenated.
// Includes both doc bodies and any extracted text from attached files.
// Team meeting notes that feed EVERY agent. These are global business knowledge,
// so unlike knowledge_docs there's no per-agent assignment - if it's active, it's in.
// Newest first, and capped so a long backlog can't crowd out the rest of the prompt.
function loadMeetingKnowledge(limitChars) {
  const cap = limitChars || 12000;
  return new Promise((resolve) => {
    db.all('SELECT title, meeting_date, attendees, tags, body FROM meeting_notes WHERE active = 1 ' +
      'ORDER BY COALESCE(meeting_date, created_at) DESC, id DESC LIMIT 40', [], (err, rows) => {
      if (err || !rows || !rows.length) return resolve('');
      let out = '', used = 0;
      for (const r of rows) {
        const head = '## ' + (r.title || 'Team meeting') + (r.meeting_date ? ' (' + r.meeting_date + ')' : '') +
          (r.attendees ? '\nAttendees: ' + r.attendees : '') +
          (r.tags ? '\nTopics: ' + r.tags : '');
        const block = head + '\n' + (r.body || '') + '\n\n';
        if (used + block.length > cap) {
          // Keep the newest meetings whole rather than truncating every one.
          if (used === 0) { out += block.slice(0, cap); used = cap; }
          break;
        }
        out += block; used += block.length;
      }
      resolve(out.trim());
    });
  });
}

// Everything ChatBot knows, assembled from the four sources the team maintains:
// domain knowledge docs, meeting notes, the agent's own admin-authored training,
// and answers people gave a thumbs-up to. Each source is capped so no single one
// can crowd out the others.
// recentText: what the person has actually said in this conversation, used to
// decide which product guide (if any) is worth including.
async function loadCompanyBrain(recentText) {
  const out = { docs: '', meetings: '', training: '', approved: '', guides: '' };

  // 1. Domain Knowledge docs shared with ChatBot (or with all agents)
  try { out.docs = await loadAgentKnowledge('chatbot'); } catch (e) {}
  // Only the guide matching what is being discussed.
  try { out.guides = await loadProductGuides(recentText); } catch (e) {}

  // 2. Team meeting notes (global)
  try { out.meetings = await loadMeetingKnowledge(9000); } catch (e) {}

  // 3. Admin-authored role/rules/workflow/knowledge for this agent
  try {
    out.training = await new Promise((resolve) => {
      db.get('SELECT role, rules, workflow, knowledge FROM agents WHERE slug = ?', ['chatbot'], (e, ag) => {
        if (e || !ag) return resolve('');
        let s = '';
        if (ag.role && ag.role.trim()) s += '\nROLE:\n' + ag.role.trim();
        if (ag.rules && ag.rules.trim()) s += '\nRULES:\n' + ag.rules.trim();
        if (ag.workflow && ag.workflow.trim()) s += '\nHOW TO ANSWER:\n' + ag.workflow.trim();
        if (ag.knowledge && ag.knowledge.trim()) s += '\nEXTRA KNOWLEDGE:\n' + ag.knowledge.trim();
        resolve(s);
      });
    });
  } catch (e) {}

  // 4. Approved answers. ChatBot learns from EVERY agent's thumbs-up, not just its
  // own — a good Order Assist answer is still a good answer about the business.
  try {
    out.approved = await new Promise((resolve) => {
      db.all(
        "SELECT agent_slug, kind, question, answer FROM training_examples " +
        "WHERE kind IN ('good','bad') " +
        // This agent's own approved answers first, then everyone else's.
        "ORDER BY (CASE WHEN agent_slug = 'chatbot' THEN 0 ELSE 1 END), created_at DESC " +
        'LIMIT 60', [], (e, rows) => {
        if (e || !rows || !rows.length) return resolve('');
        const good = rows.filter(r => r.kind === 'good').slice(0, 14);
        const bad = rows.filter(r => r.kind === 'bad').slice(0, 5);
        let s = '';
        if (good.length) {
          s += '\nANSWERS THE TEAM APPROVED. These were marked correct by the team on real questions. ' +
               'Treat the FACTS in them as verified, and match their level of detail and tone. When a new ' +
               'question is close to one of these, answer it the same way:';
          good.forEach(g => {
            s += '\n\nQ: ' + String(g.question || '').slice(0, 400) +
                 '\nGOOD ANSWER: ' + String(g.answer || '').slice(0, 900);
          });
        }
        if (bad.length) {
          s += '\n\nANSWERS THE TEAM REJECTED (do NOT answer like this):';
          bad.forEach(b => {
            s += '\n\nQ: ' + String(b.question || '').slice(0, 300) +
                 '\nBAD ANSWER (avoid): ' + String(b.answer || '').slice(0, 500);
          });
        }
        resolve(s);
      });
    });
  } catch (e) {}

  return out;
}

// Pull in the product guide(s) relevant to THIS conversation only. A guide for
// business cards is gold when someone asks about business cards and pure noise
// when they ask about banners, so it is matched against what was actually said.
function loadProductGuides(text, limitChars) {
  const cap = limitChars || 14000;
  const hay = String(text || '').toLowerCase();
  return new Promise((resolve) => {
    db.all("SELECT title, body, family FROM knowledge_docs WHERE kind = 'product_guide'", [], (e, rows) => {
      if (e || !rows || !rows.length || !hay) return resolve('');
      const hits = rows.filter(r => {
        const fam = String(r.family || '').toLowerCase().trim();
        if (!fam) return false;
        // Match the family and its singular form. Strip only the TRAILING plural —
        // stripping every "s" turned "business cards" into "busines card".
        const singular = fam.replace(/s$/, '');
        return hay.indexOf(fam) > -1 || (singular.length > 3 && hay.indexOf(singular) > -1);
      });
      if (!hits.length) return resolve('');
      let out = '', used = 0;
      for (const h of hits) {
        const block = '\n\n' + String(h.body || '');
        if (used + block.length > cap) break;
        out += block;
        used += block.length;
      }
      resolve(out ? '\nPRODUCT FAMILY GUIDE (from the live catalogue — use these field names and options):' + out : '');
    });
  });
}

// TalkAi's training for the phone: its own agent row (role / rules / how to answer / knowledge), the Domain
// Knowledge docs shared with TalkAi BY NAME (not "All agents" ones — those are written for staff and can hold
// internal details callers must not hear), and its approved / rejected example answers. Capped.
async function loadTalkTraining() {
  const docs = await loadAgentKnowledge('talk-ai', { explicitOnly: true }).catch(() => '');
  const ag = await new Promise(ok => db.get('SELECT role, rules, workflow, knowledge FROM agents WHERE slug = ?', ['talk-ai'], (e, r) => ok(e ? null : r)));
  const ex = await new Promise(ok => db.all("SELECT kind, question, answer FROM training_examples WHERE agent_slug = 'talk-ai' AND kind IN ('good','bad') ORDER BY created_at DESC LIMIT 20", [], (e, r) => ok(e ? [] : (r || []))));
  let s = '';
  if (ag) {
    if (String(ag.role || '').trim()) s += '\nROLE:\n' + ag.role.trim();
    if (String(ag.rules || '').trim()) s += '\nRULES:\n' + ag.rules.trim();
    if (String(ag.workflow || '').trim()) s += '\nHOW TO ANSWER:\n' + ag.workflow.trim();
    if (String(ag.knowledge || '').trim()) s += '\nKNOWLEDGE:\n' + ag.knowledge.trim();
  }
  if (docs) s += '\nDOCUMENTS:\n' + String(docs).slice(0, 16000);
  const good = ex.filter(e => e.kind === 'good').slice(0, 8), bad = ex.filter(e => e.kind === 'bad').slice(0, 4);
  if (good.length) s += '\nANSWERS THE TEAM APPROVED (answer close questions the same way):' + good.map(g => '\nQ: ' + String(g.question || '').slice(0, 300) + '\nA: ' + String(g.answer || '').slice(0, 600)).join('');
  if (bad.length) s += '\nANSWERS THE TEAM REJECTED (never answer like this):' + bad.map(b => '\nQ: ' + String(b.question || '').slice(0, 300) + '\nBAD: ' + String(b.answer || '').slice(0, 400)).join('');
  return s.trim().slice(0, 24000);
}

function loadAgentKnowledge(slug, opts) {
  const explicitOnly = !!(opts && opts.explicitOnly);
  return new Promise((resolve) => {
    // Product guides are excluded here and injected per-conversation instead —
    // loading all of them every time would be tens of KB of irrelevant catalogue.
    db.all("SELECT id, title, body, agents FROM knowledge_docs " +
           "WHERE COALESCE(kind,'doc') <> 'product_guide'", [], (err, rows) => {
      if (err || !rows) return resolve('');
      const applicable = rows.filter(r => {
        if (!r.agents || r.agents === 'all') return !explicitOnly;
        try { const arr = JSON.parse(r.agents); return Array.isArray(arr) && arr.includes(slug); }
        catch (e) { return false; }
      });
      if (!applicable.length) return resolve('');
      const ids = applicable.map(r => r.id);
      db.all('SELECT doc_id, filename, extracted_text FROM knowledge_files WHERE doc_id IN (' + ids.map(() => '?').join(',') + ')', ids, (e, files) => {
        const byDoc = {};
        (files || []).forEach(f => { if (f.extracted_text) (byDoc[f.doc_id] = byDoc[f.doc_id] || []).push('[Attached: ' + f.filename + ']\n' + f.extracted_text); });
        const text = applicable.map(r => {
          let block = '## ' + r.title + '\n' + (r.body || '');
          if (byDoc[r.id]) block += '\n' + byDoc[r.id].join('\n');
          return block;
        }).join('\n\n');
        resolve(text);
      });
    });
  });
}

// Promote/demote a member to admin.
app.post('/api/admin/members/set-admin', auth, adminOnly, (req, res) => {
  const id = parseInt(req.body.id);
  const makeAdmin = req.body.is_admin ? 1 : 0;
  if (!id) return res.json({ success: false, error: 'No member id' });
  db.run('UPDATE members SET is_admin = ? WHERE id = ?', [makeAdmin, id], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, is_admin: makeAdmin });
  });
});

// Set a member's Domain Knowledge access level: 'none' | 'own' | 'all'.
app.post('/api/admin/members/knowledge-access', auth, adminOnly, (req, res) => {
  const id = parseInt(req.body.id);
  const level = ['none', 'own', 'all'].includes(req.body.level) ? req.body.level : 'none';
  if (!id) return res.json({ success: false, error: 'No member id' });
  db.run('UPDATE members SET knowledge_access = ? WHERE id = ?', [level, id], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, level });
  });
});

// Remove a member
app.post('/api/admin/members/remove', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM members WHERE id = ?', [req.body.id], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/register', (req, res) => res.status(403).json({ error: 'Disabled' }));

// ===== Chat history & ratings =====
// Create a new chat, returns chat_id
app.post('/api/chats/create', auth, (req, res) => {
  const title = String(req.body.title || 'New chat').slice(0, 120);
  const agent = String(req.body.agent_slug || 'chatbot').slice(0, 60);
  const source = String(req.body.source || 'app').slice(0, 30);
  db.run('INSERT INTO chats (user_key, title, agent_slug, source) VALUES (?,?,?,?)',
    [req.user.key, title, agent, source], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, chat_id: this.lastID });
  });
});

// Save a message to a chat. Returns message_id (used for rating assistant msgs)
app.post('/api/chats/message', auth, (req, res) => {
  const { chat_id, role, content, cards } = req.body;
  if (!chat_id || !role) return res.json({ success: false, error: 'Missing fields' });
  // Cards are stored with the message so reopening a chat shows what was
  // actually on screen, not just the sentence above it.
  let cardJson = null;
  try {
    if (Array.isArray(cards) && cards.length) cardJson = JSON.stringify(cards).slice(0, 400000);
  } catch (e) {}
  db.run('INSERT INTO messages (chat_id, user_key, role, content, cards) VALUES (?,?,?,?,?)',
    [chat_id, req.user.key, role, String(content || ''), cardJson], function (err) {
      if (err) return res.json({ success: false, error: err.message });
      db.run('UPDATE chats SET updated_at = datetime("now") WHERE id = ?', [chat_id]);
      res.json({ success: true, message_id: this.lastID });
    });
});

// Compose a client-ready email from a quote, matching the client's tone
app.post('/api/draft-email', auth, async (req, res) => {
  try {
    const { quote, client_name, client_emails, product, url, specs, lines, has_versions, version_count, rush_offer } = req.body;
    const toneSamples = (client_emails || []).slice(0, 3).map(e => (e.body || e.snippet || '')).filter(Boolean).join('\n---\n').slice(0, 1500);
    let versionNote = '';
    if (has_versions && version_count > 1) {
      versionNote = '\nNOTE: This quote includes ' + version_count + ' versions (designs). You may briefly mention it is priced for ' + version_count + ' designs.';
    }
    let rushNote = '';
    if (rush_offer && rush_offer.price != null) {
      rushNote = '\nNOTE: This quote is priced at standard turnaround. Last time the client ordered with "' + rush_offer.label + '". In the OUTRO, briefly offer it: if they want "' + rush_offer.label + '" turnaround like last time, the price would be $' + usd2(Number(rush_offer.price)) + '.';
    }
    const sys = "You write client-ready quote emails for AxiomPrint, a print shop. Warm, professional, concise. " +
      "Write any price as $1,678.54 (comma for thousands, two decimals). " +
      "Return STRICT JSON only: {\"greeting\":\"<e.g. Hi Daniel,>\",\"intro\":\"<1-2 sentence friendly intro that references what they asked for>\",\"outro\":\"<1-2 sentence close inviting next steps; include any clarifying question or turnaround offer here>\",\"signoff\":\"<e.g. Best,>\"}. " +
      "Do NOT include the price table or specs in any field - those are added separately. Do NOT use markdown or asterisks. Match the client's formality from their sample emails." + versionNote + rushNote;
    const userMsg = 'CLIENT NAME: ' + (client_name || 'there') +
      '\nPRODUCT: ' + (product || '') +
      '\nWHAT THEY ASKED FOR (for the intro): ' + (quote || '').split('\n').slice(0,8).join(' ') +
      (toneSamples ? ('\n\nCLIENT\'S OWN EMAILS (match their tone):\n' + toneSamples) : '');
    let parsed = {};
    try {
      const r = await anthropic.messages.create({ model: MODEL_LIGHT, max_tokens: 500, system: sys, messages: [{ role: 'user', content: userMsg }] });
      let txt = (r.content.find(b => b.type === 'text') || {}).text || '{}';
      txt = txt.replace(/```json|```/g, '').trim();
      const b = txt.indexOf('{'), lb = txt.lastIndexOf('}'); if (b >= 0 && lb > b) txt = txt.slice(b, lb + 1);
      parsed = JSON.parse(txt);
    } catch (e) { parsed = {}; }
    res.json({ success: true,
      greeting: parsed.greeting || ('Hi ' + (client_name || 'there') + ','),
      intro: parsed.intro || 'Thanks for reaching out! Here is your quote:',
      outro: parsed.outro || 'Let me know which option works best and I\'d be happy to get this started.',
      signoff: parsed.signoff || 'Best,'
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});


app.post('/api/summarize-title', auth, async (req, res) => {
  try {
    const text = String(req.body.text || '').slice(0, 1500);
    if (!text) return res.json({ success: false });
    const r = await anthropic.messages.create({
      model: MODEL_LIGHT,
      max_tokens: 30,
      messages: [{ role: 'user', content: 'Write a 4-8 word title summarizing what this is about, like "Nayoung Seo at Freehold Group about rush flyers". No quotes, no punctuation at the end. Content:\n\n' + text }]
    });
    const title = (r.content.find(b => b.type === 'text') || {}).text || '';
    res.json({ success: true, title: title.trim().replace(/^["']|["']$/g, '').slice(0, 80) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Update a chat's title (used to summarize image-only first messages)
app.post('/api/chats/title', auth, (req, res) => {
  const { chat_id, title } = req.body;
  db.run('UPDATE chats SET title = ? WHERE id = ? AND user_key = ?', [String(title||'').slice(0,120), chat_id, req.user.key], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// List my chats (for the sidebar)
app.get('/api/chats', auth, (req, res) => {
  const agent = req.query.agent || 'chatbot';
  db.all("SELECT id, title, created_at, updated_at FROM chats WHERE user_key = ? AND COALESCE(agent_slug,'chatbot') = ? ORDER BY updated_at DESC LIMIT 100",
    [req.user.key, agent], (err, rows) => {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, chats: rows || [] });
    });
});

// Public list of agents the user can chat with (active ones selectable)
app.get('/api/agents', auth, (req, res) => {
  db.all('SELECT slug, name, description, status, access FROM agents ORDER BY sort_order', [], (err, rows) => {
    if (err) return res.json({ success: false, error: err.message });
    // 'system' agents (TalkAi) are training targets, never something to chat with.
    let list = (rows || []).filter(a => a.access !== 'system' && a.status !== 'retired');
    // Admins see everything.
    if (req.user.is_admin) return res.json({ success: true, agents: list });
    // Non-admins never see 'restricted' agents.
    list = list.filter(a => a.access !== 'restricted');
    // Per-member allow-list: if the member has explicit agent rows, restrict to those.
    const email = String(req.user.key || '').replace(/^member:/, '');
    db.get('SELECT id FROM members WHERE email = ?', [email], (e, member) => {
      if (e || !member) return res.json({ success: true, agents: list });
      db.all('SELECT agent_slug FROM member_agents WHERE member_id = ?', [member.id], (e2, allowed) => {
        if (e2) return res.json({ success: true, agents: list });
        if (allowed && allowed.length) {
          const allowSet = new Set(allowed.map(a => a.agent_slug));
          // ChatBot is available to everyone by design, so an allow-list built
          // before it existed must not hide it.
          allowSet.add('chatbot');
          list = list.filter(a => allowSet.has(a.slug));
        }
        // No rows = default-allow (all non-restricted agents).
        res.json({ success: true, agents: list });
      });
    });
  });
});

// Get full messages of one chat (owner or admin)
app.get('/api/chats/:id', auth, (req, res) => {
  db.get('SELECT * FROM chats WHERE id = ?', [req.params.id], (err, chat) => {
    if (err || !chat) return res.json({ success: false, error: 'Not found' });
    if (chat.user_key !== req.user.key && !req.user.is_admin) return res.status(403).json({ success: false, error: 'Forbidden' });
    db.all('SELECT id, role, content, rating, cards, created_at FROM messages WHERE chat_id = ? ORDER BY id', [req.params.id], (e, msgs) => {
      (msgs || []).forEach(m => {
        try { m.cards = m.cards ? JSON.parse(m.cards) : null; } catch (e2) { m.cards = null; }
      });
      res.json({ success: true, chat, messages: msgs || [] });
    });
  });
});

// Rate an assistant message (1 up, -1 down, 0 clear)
app.post('/api/messages/rate', auth, (req, res) => {
  const { message_id, rating } = req.body;
  const r = rating === 1 ? 1 : rating === -1 ? -1 : 0;
  // only owner or admin can rate
  db.get('SELECT user_key FROM messages WHERE id = ?', [message_id], (err, row) => {
    if (err || !row) return res.json({ success: false, error: 'Not found' });
    if (row.user_key !== req.user.key && !req.user.is_admin) return res.status(403).json({ success: false, error: 'Forbidden' });
    db.run('UPDATE messages SET rating = ? WHERE id = ?', [r, message_id], function (e) {
      if (e) return res.json({ success: false, error: e.message });

      // A rating makes this message a CANDIDATE for training — nothing more.
      // Only an admin approving it in Admin > Agents writes a training example.
      // A user liking an answer is feedback; it is not a decision that the answer
      // is correct enough to teach every future reply.
      res.json({ success: true });
    });
  });
});

// Admin: list users (members + admins) with last login
app.get('/api/admin/users-activity', auth, adminOnly, (req, res) => {
  // Select only columns guaranteed to exist; photo is backfilled live below.
  db.all('SELECT id, email, username, display_name, enabled, last_login, created_at, axiom_user_id, knowledge_access, is_admin FROM members ORDER BY (last_login IS NULL), last_login DESC', [], async (err, members) => {
    if (err) return res.json({ success: false, error: 'members query: ' + err.message });
    members = members || [];
    try {
      const ids = members.map(m => m.axiom_user_id).filter(Boolean);
      if (ids.length) {
        const rows = await runQuery('SELECT id, memberimage, username FROM user WHERE id IN (' + ids.join(',') + ')');
        const byId = {};
        rows.forEach(r => { byId[r.id] = r; });
        members.forEach(m => {
          const u = byId[m.axiom_user_id];
          if (u) {
            m.photo = u.memberimage || null;
            if (!m.username && u.username) {
              m.username = u.username;
              db.run('UPDATE members SET username = ? WHERE id = ?', [String(u.username).toLowerCase(), m.id]);
            }
          }
        });
      }
    } catch (e) { /* optional */ }
    db.all('SELECT username, last_login FROM users', [], (e, admins) => {
      // Combined counts query for all user_keys at once
      db.all(`SELECT user_key,
          SUM(CASE WHEN updated_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS d7,
          SUM(CASE WHEN updated_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS d30,
          COUNT(*) AS total
        FROM chats GROUP BY user_key`, [], (e3, counts) => {
        const byKey = {};
        (counts || []).forEach(c => { byKey[c.user_key] = c; });
        members.forEach(m => {
          const c = byKey['member:' + m.email] || { d7: 0, d30: 0, total: 0 };
          m.chats7 = c.d7; m.chats30 = c.d30; m.chatsTotal = c.total;
          m.user_key = 'member:' + m.email;
        });
        // Attach each member's agent allow-list (empty = all agents)
        db.all('SELECT member_id, agent_slug FROM member_agents', [], (e4, maRows) => {
          const byMember = {};
          (maRows || []).forEach(r => { (byMember[r.member_id] = byMember[r.member_id] || []).push(r.agent_slug); });
          members.forEach(m => { m.allowed_agents = byMember[m.id] || []; });
          res.json({ success: true, members, admins: admins || [] });
        });
      });
    });
  });
});

// Admin: history list - one row per conversation, with rating summary, filterable
app.get('/api/admin/history', auth, async (req, res) => {
  const filter = req.query.rating || 'all'; // all|up|down|unread
  // Admins: which conversations someone else had since this admin last opened them (the CRM Chat unread dot).
  const reader = crmReader(req);
  let reads = null;
  if (req.user.is_admin) { await initCrmReads(reader); reads = {}; (await crmAll('SELECT chat_id, read_at FROM crm_chat_reads WHERE reader = ?', [reader])).forEach(r => { reads[r.chat_id] = r.read_at; }); }
  let userKey = req.query.user || '';     // optional exact user_key
  let where = [];
  let params = [];
  // Non-admins can only see their OWN chats.
  if (!req.user.is_admin) {
    userKey = req.user.key; // 'member:email'
  }
  if (userKey) { where.push('c.user_key = ?'); params.push(userKey); }
  // Filter to one client — "show me every conversation about Copymat Westwood"
  // is the reason the client is stored on the chat in the first place.
  if (req.query.client_id) { where.push('c.client_id = ?'); params.push(parseInt(req.query.client_id)); }
  if (req.query.has_client === '1') { where.push('c.client_id IS NOT NULL'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // aggregate ratings per chat
  const sql = `
    SELECT c.id, c.user_key, c.title, c.created_at, c.updated_at, c.agent_slug, c.source,
      c.client_id, c.client_name,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id) AS msgs,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id AND m.rating=1) AS ups,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id AND m.rating=-1) AS downs
    FROM chats c ${whereSql}
    ORDER BY c.updated_at DESC LIMIT 500`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.json({ success: false, error: err.message });
    let list = rows || [];
    if (filter === 'up') list = list.filter(r => r.ups > 0);
    else if (filter === 'down') list = list.filter(r => r.downs > 0);
    if (reads) list.forEach(r => { r.unread = crmUnread(r, reader, reads) ? 1 : 0; });
    if (filter === 'unread') list = list.filter(r => r.unread);
    // Map user_key -> display name + photo (from members; admins get their username)
    db.all('SELECT email, display_name, username, photo, axiom_user_id FROM members', [], async (e, members) => {
      const byKey = {};
      (members || []).forEach(m => { byKey['member:' + m.email] = { name: m.display_name || m.username || m.email, photo: m.photo, axid: m.axiom_user_id }; });
      // backfill photos live from Axiom for any missing
      try {
        const missing = (members || []).filter(m => !m.photo && m.axiom_user_id).map(m => m.axiom_user_id);
        if (missing.length) {
          const pr = await runQuery('SELECT id, memberimage FROM user WHERE id IN (' + missing.join(',') + ')');
          const pm = {}; pr.forEach(r => { pm[r.id] = r.memberimage; });
          Object.values(byKey).forEach(v => { if (!v.photo && v.axid && pm[v.axid]) v.photo = pm[v.axid]; });
        }
      } catch (ee) {}
      // Real agent name per chat. Without this the UI fell back to a hardcoded
      // "Order Assist" for every row, so ChatBot conversations looked like
      // Order Assist ones and the history was impossible to judge by agent.
      const agentNames = {};
      try {
        const ags = await new Promise(r => db.all('SELECT slug, name FROM agents', [], (e, x) => r(e ? [] : (x || []))));
        ags.forEach(a => { agentNames[a.slug] = a.name; });
      } catch (ae) {}

      list.forEach(row => {
        const info = byKey[row.user_key];
        if (info) { row.display_name = info.name; row.photo = info.photo; }
        else { row.display_name = labelForKey(row.user_key); row.photo = null; }
        const slug = row.agent_slug || 'chatbot';
        row.agent_name = agentNames[slug] || slug;
      });
      res.json({ success: true, history: list });
    });
  });
});

// AxiomPrint's closed days (the shop calendar in the production `holidays` table), next 12 months.
app.get('/api/closed-days', auth, async (req, res) => {
  if (req.query.reload === '1') await closedDays.load();
  res.json(Object.assign({ ok: true, days: closedDays.upcoming(Math.min(Math.max(parseInt(req.query.days) || 365, 1), 1100)) }, { status: closedDays.status() }));
});

// ---- CRM Chat read / unread (admins). A conversation someone else had is unread for an admin until they open it in
// CRM Chat, and again when something new is said in it (updated_at after their read_at). Your own chats are never unread,
// and neither is a chat nobody wrote in. Members only ever see their own chats, so they have nothing unread.
db.run(`CREATE TABLE IF NOT EXISTS crm_chat_reads (
  chat_id INTEGER NOT NULL,
  reader TEXT NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, reader)
)`);
const crmAll = (sql, p) => new Promise(ok => db.all(sql, p || [], (e, r) => ok(e ? [] : (r || []))));
const crmRun = (sql, p) => new Promise((ok, no) => db.run(sql, p || [], (e) => e ? no(e) : ok()));
const crmReader = (req) => String((req.user && (req.user.key || req.user.username)) || '').slice(0, 120);
const crmUnread = (row, reader, reads) => row.user_key !== reader && row.msgs > 0 && (!reads[row.id] || reads[row.id] < row.updated_at);
const CRM_UNREAD_SQL = "SELECT COUNT(*) AS n FROM chats c LEFT JOIN crm_chat_reads r ON r.chat_id = c.id AND r.reader = ? " +
  "WHERE c.user_key <> ? AND (r.read_at IS NULL OR r.read_at < c.updated_at) AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)";
// First visit for this admin: everything older than 12 hours counts as read, so the list starts with what is new.
async function initCrmReads(reader) {
  if (!reader) return;
  try {
    const seen = await crmAll('SELECT 1 AS x FROM crm_chat_reads WHERE reader = ? LIMIT 1', [reader]);
    if (!seen.length) await crmRun("INSERT OR IGNORE INTO crm_chat_reads (chat_id, reader, read_at) SELECT id, ?, updated_at FROM chats " +
      "WHERE updated_at < datetime('now', '-12 hours')", [reader]);
  } catch (e) { console.error('CRM reads init', e.message); }
}
app.get('/api/crm/unread-count', auth, async (req, res) => {
  if (!req.user.is_admin) return res.json({ ok: true, unread: 0 });
  const reader = crmReader(req);
  await initCrmReads(reader);
  const r = await crmAll(CRM_UNREAD_SQL, [reader, reader]);
  res.json({ ok: true, unread: (r[0] && r[0].n) || 0 });
});
app.post('/api/admin/crm/chats/:id/read', auth, adminOnly, async (req, res) => {
  try { await crmRun("INSERT OR REPLACE INTO crm_chat_reads (chat_id, reader, read_at) VALUES (?, ?, datetime('now'))", [parseInt(req.params.id) || 0, crmReader(req)]); }
  catch (e) { return res.status(500).json({ ok: false }); }
  res.json({ ok: true });
});
app.post('/api/admin/crm/chats/:id/unread', auth, adminOnly, async (req, res) => {
  try { await crmRun('DELETE FROM crm_chat_reads WHERE chat_id = ? AND reader = ?', [parseInt(req.params.id) || 0, crmReader(req)]); }
  catch (e) { return res.status(500).json({ ok: false }); }
  res.json({ ok: true });
});
app.post('/api/admin/crm/chats/read-all', auth, adminOnly, async (req, res) => {
  try { await crmRun("INSERT OR REPLACE INTO crm_chat_reads (chat_id, reader, read_at) SELECT id, ?, datetime('now') FROM chats", [crmReader(req)]); }
  catch (e) { return res.status(500).json({ ok: false }); }
  res.json({ ok: true });
});

// ===== Admin: Agents =====
// ---- Overview for the CRM Chat (History) tab: chats started by day / week / month. Members see their own.
const usageStats = require('./usage-stats');
// Overview tiles: today / this week / this month, each with the period before.
function statTiles(now, unit) {
  return [
    { label: 'Today', value: now.today, sub: 'yesterday ' + now.yesterday },
    { label: 'This week', value: now.week, sub: 'last week ' + now.last_week },
    { label: 'This month', value: now.month, sub: 'last month ' + now.last_month }];
}
app.get('/api/stats/crm', auth, async (req, res) => {
  const all = (sql, p) => new Promise(ok => db.all(sql, p || [], (e, r) => ok(e ? [] : (r || []))));
  const mine = !req.user.is_admin || req.query.user === 'me';
  const who = mine ? ' AND user_key = ?' : (req.query.user ? ' AND user_key = ?' : '');
  const wp = mine ? [req.user.key] : (req.query.user ? [String(req.query.user)] : []);
  const rows = await all('SELECT created_at FROM chats WHERE created_at > ' + usageStats.SINCE + who, wp);
  const s = usageStats.series(rows.map(r => r.created_at));
  const m0 = usageStats.startOf('month');
  const q = await all("SELECT COUNT(*) AS n, COUNT(DISTINCT c.user_key) AS people FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.role = 'user' AND m.created_at >= ?" +
    (who ? who.replace('user_key', 'c.user_key') : ''), [m0].concat(wp));
  const tiles = statTiles(s.now).map(t => Object.assign(t, { label: 'Chats ' + t.label.toLowerCase() }));
  tiles.push({ label: 'Questions this month', value: (q[0] && q[0].n) || 0, sub: 'messages people sent' });
  if (!mine && !req.query.user) tiles.push({ label: 'People this month', value: (q[0] && q[0].people) || 0, sub: 'staff who chatted' });
  res.json({ ok: true, title: mine ? 'Your chats' : 'Chats started', unit: 'chats', unit1: 'chat', series: s, tiles: tiles });
});

// Usage per agent: questions people asked (user messages), chats and people in the last 30 days, last 7 days,
// and when it was last used. TalkAi counts phone calls instead.
function agentUsage() {
  const all = (sql, p) => new Promise(ok => db.all(sql, p || [], (e, r) => ok(e ? [] : (r || []))));
  return Promise.all([
    all("SELECT c.agent_slug AS slug, SUM(m.created_at > datetime('now','-30 days')) AS q30, SUM(m.created_at > datetime('now','-7 days')) AS q7, " +
      "COUNT(DISTINCT CASE WHEN m.created_at > datetime('now','-30 days') THEN c.id END) AS chats30, " +
      "COUNT(DISTINCT CASE WHEN m.created_at > datetime('now','-30 days') THEN c.user_key END) AS people30, MAX(m.created_at) AS last " +
      "FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.role = 'user' GROUP BY c.agent_slug"),
    all("SELECT 'talk-ai' AS slug, SUM(created_at > datetime('now','-30 days')) AS q30, SUM(created_at > datetime('now','-7 days')) AS q7, " +
      "SUM(created_at > datetime('now','-30 days')) AS chats30, COUNT(DISTINCT CASE WHEN created_at > datetime('now','-30 days') THEN from_number END) AS people30, " +
      "MAX(created_at) AS last FROM talk_calls WHERE source = 'phone'")
  ]).then(([chat, talk]) => {
    const out = {};
    chat.concat(talk).forEach(r => { if (r && r.slug) out[r.slug] = { q30: r.q30 || 0, q7: r.q7 || 0, chats30: r.chats30 || 0, people30: r.people30 || 0, last: r.last || null }; });
    return out;
  });
}
app.get('/api/admin/agents', auth, adminOnly, (req, res) => {
  db.all("SELECT slug, name, description, status, access, sort_order, updated_at FROM agents WHERE status <> 'retired' ORDER BY sort_order", [], async (err, rows) => {
    if (err) return res.json({ success: false, error: err.message });
    const usage = await agentUsage().catch(() => ({}));
    (rows || []).forEach(a => { a.usage = usage[a.slug] || { q30: 0, q7: 0, chats30: 0, people30: 0, last: null }; a.unit = a.slug === 'talk-ai' ? 'calls' : 'questions'; });
    res.json({ success: true, agents: rows || [] });
  });
});

app.get('/api/admin/agents/:slug', auth, adminOnly, (req, res) => {
  db.get('SELECT * FROM agents WHERE slug = ?', [req.params.slug], (err, agent) => {
    if (err || !agent) return res.json({ success: false, error: 'Not found' });
    db.all("SELECT id, kind, question, answer, created_at FROM training_examples WHERE agent_slug = ? AND kind IN ('good','bad') ORDER BY created_at DESC", [req.params.slug], (e, examples) => {
      res.json({ success: true, agent, examples: examples || [] });
    });
  });
});

app.post('/api/admin/agents/:slug', auth, adminOnly, (req, res) => {
  const { role, rules, workflow, knowledge, access, status } = req.body;
  db.run('UPDATE agents SET role=?, rules=?, workflow=?, knowledge=?, access=COALESCE(?,access), status=COALESCE(?,status), updated_at=datetime("now") WHERE slug=?',
    [role||'', rules||'', workflow||'', knowledge||'', access, status, req.params.slug], function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true });
    });
});

// Promote a rated message into a training example (good/bad) or mark it ignored
app.post('/api/admin/agents/:slug/examples', auth, adminOnly, (req, res) => {
  const { kind, question, answer, source_message_id } = req.body;
  const k = (kind === 'bad') ? 'bad' : (kind === 'ignored') ? 'ignored' : 'good';
  // Upsert: approving the same message twice should update it, not fail on the
  // unique index or create a duplicate example.
  db.run('INSERT INTO training_examples (agent_slug, kind, question, answer, source_message_id) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(source_message_id) DO UPDATE SET kind = excluded.kind, agent_slug = excluded.agent_slug, ' +
    'question = excluded.question, answer = excluded.answer, created_at = datetime(\'now\')',
    [req.params.slug, k, question||'', answer||'', source_message_id||null], function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

app.post('/api/admin/agents/:slug/examples/delete', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM training_examples WHERE id=? AND agent_slug=?', [req.body.id, req.params.slug], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Candidate rated answers not yet promoted (for the "approve as example" flow)
app.get('/api/admin/agents/:slug/candidates', auth, adminOnly, (req, res) => {
  // pull recent rated assistant messages FOR THIS AGENT only (via the chat's agent_slug),
  // with their preceding user question, excluding ones already promoted or dismissed.
  const slug = req.params.slug;
  const sql = `
    SELECT m.id, m.content AS answer, m.rating,
      (SELECT content FROM messages m2 WHERE m2.chat_id=m.chat_id AND m2.id < m.id AND m2.role='user' ORDER BY m2.id DESC LIMIT 1) AS question
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    WHERE m.role='assistant' AND m.rating != 0
      AND c.agent_slug = ?
      AND m.id NOT IN (SELECT source_message_id FROM training_examples WHERE source_message_id IS NOT NULL)
      AND m.id NOT IN (SELECT message_id FROM dismissed_candidates)
    ORDER BY m.id DESC LIMIT 50`;
  db.all(sql, [slug], (err, rows) => {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, candidates: rows || [] });
  });
});

// Dismiss (ignore) a candidate so it stops appearing
app.post('/api/admin/agents/:slug/candidates/dismiss', auth, adminOnly, (req, res) => {
  db.run('INSERT OR IGNORE INTO dismissed_candidates (message_id, agent_slug) VALUES (?,?)',
    [req.body.message_id, req.params.slug], function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true });
    });
});

// Admin: connection status for the Connections tab
app.get('/api/admin/connections', auth, adminOnly, async (req, res) => {
  const conns = [];
  // Axiom DB - try a trivial query
  let dbOk = false;
  try { await runQuery('SELECT 1'); dbOk = true; } catch (e) {}
  conns.push({ key: 'axiom_db', name: 'Axiom Database', status: dbOk ? 'connected' : 'error', detail: dbOk ? 'Live read-only connection to axiomprint_new' : 'Cannot reach database' });
  // Gmail - connected if the service account key is present
  let gmailOk = false;
  try { gmailOk = require('fs').existsSync(path.join(__dirname, 'gmail-key.json')); } catch (e) {}
  conns.push({ key: 'gmail', name: 'Gmail (order@axiomprint.com)', status: gmailOk ? 'connected' : 'disconnected', detail: gmailOk ? 'Reading shared inbox via service account' : 'No credentials found' });
  // Google Drive - same service account
  conns.push({ key: 'drive', name: 'Google Drive', status: gmailOk ? 'connected' : 'disconnected', detail: gmailOk ? 'Job files access via service account' : 'No credentials found' });
  // Driving distance for installation and delivery quotes.
  conns.push(routesKey()
    ? { key: 'maps', name: 'Driving distance — Google Routes API', status: 'connected',
        detail: 'Road miles from the Glendale shop, with Google traffic predictions when a date and time are given (falls back to OpenStreetMap if Google refuses — see pm2 logs "ROUTE google failed")' }
    : { key: 'maps', name: 'Driving distance — OpenStreetMap', status: 'connected',
        detail: 'Road miles from the Glendale shop; traffic estimated from the admin traffic factors. Add GOOGLE_ROUTES_API_KEY to .env for Google.' });
  res.json({ success: true, connections: conns });
});

// Admin: all users for the filter dropdown (every member + admin, even without chats yet)
// Clients that appear in any conversation, for the history filter.
app.get('/api/admin/chat-clients', auth, adminOnly, (req, res) => {
  db.all('SELECT client_id, client_name, COUNT(*) AS chats FROM chats ' +
         'WHERE client_id IS NOT NULL GROUP BY client_id, client_name ORDER BY chats DESC',
    [], (e, rows) => {
      res.json({ success: !e, clients: rows || [] });
    });
});

app.get('/api/admin/chat-users', auth, adminOnly, (req, res) => {
  const users = {};
  // everyone who already has chats
  db.all('SELECT DISTINCT user_key FROM chats', [], (err, chatRows) => {
    (chatRows || []).forEach(r => { users[r.user_key] = labelForKey(r.user_key); });
    // all enabled+disabled members
    db.all('SELECT email, display_name, username FROM members', [], (e1, members) => {
      (members || []).forEach(m => { users['member:' + m.email] = m.display_name || m.username || m.email; });
      // all admins
      db.all('SELECT username FROM users', [], (e2, admins) => {
        (admins || []).forEach(a => { users['user:' + a.username] = a.username; });
        const list = Object.keys(users).map(k => ({ key: k, label: users[k] }))
          .sort((a, b) => a.label.localeCompare(b.label));
        res.json({ success: true, users: list });
      });
    });
  });
});

function labelForKey(k) {
  return String(k || '').replace(/^member:/, '').replace(/^user:/, '');
}

// Pull readable text out of a chat attachment. Images and PDFs go to the model
// directly as native blocks; everything else is converted to text here so the
// content is usable in the conversation.
app.post('/api/chatbot/extract', auth, async (req, res) => {
  try {
    const { data, mime, filename } = req.body || {};
    if (!data) return res.json({ ok: false, error: 'No file data' });
    res.json(await extractAttachmentText(Buffer.from(data, 'base64'), mime, filename));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Text out of an attached file: PDF text, spreadsheets (every Excel format),
// CSV / TSV, Word, plain text and markdown. Shared by the staff chat and the
// client chat (client-bot.js).
async function extractAttachmentText(buf, mime, filename) {
  {
    const name = String(filename || '').toLowerCase();
    const mt = String(mime || '').toLowerCase();
    // Tabular data earns more room: a 200-version list is exactly the kind of
    // attachment where losing the tail loses the job.
    const LIMIT = 20000;
    const TABLE_LIMIT = 60000;
    let text = '';
    let kind = 'text';

    if (mt.includes('pdf') || name.endsWith('.pdf')) {
      kind = 'pdf';
      text = await extractPdfText(buf);
    } else if (name.endsWith('.docx') || name.endsWith('.doc') ||
               mt.includes('officedocument.wordprocessing') || mt.includes('msword')) {
      kind = 'word';
      try {
        const mammoth = require('mammoth');
        const r = await mammoth.extractRawText({ buffer: buf });
        text = r.value || '';
      } catch (e) { text = ''; }
    } else if (/\.(xlsx|xlsm|xlsb|xls|ods|fods|dif|slk)$/.test(name) ||
               mt.includes('spreadsheetml') || mt.includes('ms-excel') ||
               mt.includes('opendocument.spreadsheet')) {
      // Every Excel-family format, not just .xlsx. Version lists and multi-item
      // orders arrive as whatever the client's software saved, and .xlsm or .xlsb
      // used to fall through to the text branch and be rejected as binary.
      kind = 'spreadsheet';
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
        text = sheetsToText(XLSX, wb);
      } catch (e) {
        text = '(Spreadsheet attached — it could not be read on the server' +
               (/cannot find module/i.test(e.message) ? ' because the "xlsx" package is not installed' : '') +
               '. Ask for it as CSV, or paste the rows.)';
      }
    } else if (/\.(json|js|ts|py|sh|exe|dll|zip|rar|7z|dmg|app|bat|ps1)$/.test(name)) {
      // Not useful in a printing conversation, and code or archives pasted into
      // a chat are more likely a mistake than an intention.
      return { ok: false, error: 'That file type isn\'t supported here.' };
    } else {
      // csv, tsv, txt, md, xml — anything that is really just text.
      kind = /\.(csv|tsv|tab)$/.test(name) ? 'table' : 'text';
      text = decodeText(buf);

      // Excel writes CSV in several encodings and delimiters. Normalise so the
      // columns survive — a mangled delimiter turns a version list into one long
      // unreadable line.
      if (kind === 'table') {
        const head = text.split(/\r?\n/)[0] || '';
        const counts = { ',': (head.match(/,/g) || []).length,
                         ';': (head.match(/;/g) || []).length,
                         '\t': (head.match(/\t/g) || []).length,
                         '|': (head.match(/\|/g) || []).length };
        const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        if (delim && delim !== ',' && counts[delim] > 0) {
          text = text.split(/\r?\n/).map(l => l.split(delim).join(',')).join('\n');
        }
        const rows = text.split(/\r?\n/).filter(Boolean).length;
        text = '(' + rows + ' rows)\n' + text;
      }

      // Guard against binary files pretending to be text
      const printable = (text.slice(0, 400).match(/[\x09\x0a\x0d\x20-\x7e]/g) || []).length;
      if (text.length && printable / Math.min(400, text.length) < 0.85) {
        return { ok: false, error: 'That file type cannot be read as text.' };
      }
    }

    text = String(text || '').trim();
    const cap = (kind === 'spreadsheet' || kind === 'table') ? TABLE_LIMIT : LIMIT;
    let truncated = false;
    if (text.length > cap) {
      truncated = true;
      // Cut on a row boundary so the last line isn't half a record, and say how
      // many rows were dropped rather than trailing off mid-number.
      const all = text.split('\n');
      const kept = [];
      let used = 0;
      for (const line of all) {
        if (used + line.length + 1 > cap) break;
        kept.push(line);
        used += line.length + 1;
      }
      const lost = all.length - kept.length;
      text = kept.join('\n') +
        '\n…(' + lost + ' more row' + (lost === 1 ? '' : 's') + ' not shown — ask for them if needed)';
    }
    return {
      ok: true, kind: kind, filename: filename || 'file',
      truncated: truncated, text: text
    };
  }
}

// Extract text from an uploaded file (PDF text or image OCR)
app.post('/api/extract', auth, async (req, res) => {
  try {
    const { data, mime, filename } = req.body;
    if (!data) return res.json({ success: false, error: 'No file data' });
    const buf = Buffer.from(data, 'base64');
    let text = '';
    if (/pdf/.test(mime)) {
      text = await extractPdfText(buf);
    } else if (/^image\//.test(mime)) {
      try {
        const Tesseract = require('tesseract.js');
        const { data: od } = await Tesseract.recognize(buf, 'eng');
        text = (od.text || '').trim();
      } catch (oe) { text = ''; }
    } else {
      text = buf.toString('utf8').slice(0, 6000);
    }
    res.json({ success: true, text: text.slice(0, 8000), filename });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Serve a Drive file's bytes (token via query param so <img>/links work)
// Return the proof-image URL for an order, for a lazy thumbnail in the order history.
// Proof images are stored by filename in estimate_proofimage and served from S3.
const PROOF_IMAGE_BASE = 'https://axiomprint.s3.us-west-1.amazonaws.com/EstimateImages/';
app.get('/api/order-thumb', auth, async (req, res) => {
  const estId = parseInt(req.query.id);
  if (!estId) return res.json({ url: null });
  try {
    const rows = await runQuery('SELECT estimate_proofimage FROM estimate WHERE id = ' + estId + ' LIMIT 1');
    const name = rows.length ? rows[0].estimate_proofimage : null;
    if (!name) {
      console.log('ORDER_THUMB', estId, 'no proof image');
      return res.json({ url: null, reason: 'no-proof' });
    }
    const url = PROOF_IMAGE_BASE + String(name).replace(/^\/+/, '');
    console.log('ORDER_THUMB', estId, '->', url);
    return res.json({ url: url, filename: name });
  } catch (e) {
    console.error('ORDER_THUMB error', estId, e.message);
    return res.json({ url: null, error: e.message });
  }
});

app.get('/api/drivefile', async (req, res) => {
  try {
    jwt.verify(req.query.token || '', process.env.JWT_SECRET);
  } catch (e) { return res.status(401).send('Unauthorized'); }
  try {
    const { buffer, mime, name } = await driveFileBytes(req.query.id);
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + (name || 'file') + '"');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Serve an email attachment's bytes (token via query param so <img>/links work)
app.get('/api/attachment', async (req, res) => {
  try {
    jwt.verify(req.query.token || '', process.env.JWT_SECRET);
  } catch (e) { return res.status(401).send('Unauthorized'); }
  try {
    const messageId = req.query.msg;
    const index = parseInt(req.query.i) || 0;
    const resolved = await resolveAttachmentId(messageId, index);
    if (!resolved) return res.status(404).send('Not found');
    const buf = await fetchAttachment(messageId, resolved.id);
    res.setHeader('Content-Type', resolved.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + (req.query.name || 'attachment') + '"');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// Search products by name - returns matches so the user can pick
app.post('/api/products/search', auth, async (req, res) => {
  const { q } = req.body;
  try {
    const term = '%' + String(q || '').replace(/[%_\\]/g, '') + '%';
    const esc = mysql.escape(term);
    const rows = await runQuery(
      "SELECT id, title, type FROM product WHERE active=1 AND formula IS NOT NULL AND formula != '' " +
      "AND available_for_websites LIKE '%axiom_print%' " +
      "AND (title LIKE " + esc + " OR public_title LIKE " + esc + " OR meta_keywords LIKE " + esc + " OR added_keywords LIKE " + esc + ") " +
      "ORDER BY (title LIKE " + esc + ") DESC, title LIMIT 12"
    );
    res.json({ success: true, products: rows });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// Load a product's full calculator definition
app.post('/api/calculator', auth, async (req, res) => {
  const { product_id } = req.body;
  const pid = parseInt(product_id);
  if (!pid) return res.json({ success: false, error: 'Invalid product_id' });
  try {
    const prod = await runQuery('SELECT id, title, type, formula FROM product WHERE id = ' + pid);
    if (!prod.length) return res.json({ success: false, error: 'Product not found' });

    const variables = await runQuery(
      'SELECT id, title, type, `order` FROM product_variables WHERE product_id = ' + pid + ' ORDER BY `order`'
    );
    const varIds = variables.map(v => v.id);
    let items = [];
    if (varIds.length) {
      items = await runQuery(
        'SELECT id, variable_id, title, value, base, isHidden, `default`, `order`, custom FROM product_variable_item WHERE variable_id IN (' +
        varIds.join(',') + ') AND isHidden = 0 ORDER BY variable_id, `order`'
      );
    }
    const filters = await runQuery(
      'SELECT pvf.product_variable_item_id, pvf.relatedTo, pvf.relatedItems ' +
      'FROM product_variable_filters pvf ' +
      'JOIN product_variable_item pvi ON pvf.product_variable_item_id = pvi.id ' +
      'JOIN product_variables pv ON pvi.variable_id = pv.id WHERE pv.product_id = ' + pid
    );

    res.json({ success: true, product: prod[0], variables, items, filters });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const id = String(username || '').trim();
  // 1. Try local admin/user accounts first (e.g. novaai)
  db.get('SELECT * FROM users WHERE username = ?', [id], async (err, user) => {
    if (user) {
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      db.run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
      const token = jwt.sign({ key: 'user:' + user.username, username: user.username, is_admin: !!user.is_admin }, process.env.JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, username: user.username, is_admin: !!user.is_admin });
    }
    // 2. Otherwise treat as a member logging in with their Axiom USERNAME (or email) + password
    const idLower = id.toLowerCase();
    try {
      // Resolve the Axiom user by username or email first (authoritative identity)
      const arows = await runQuery('SELECT id, email, username, password_hash FROM user WHERE LOWER(username) = ' + mysql.escape(idLower) + ' OR LOWER(email) = ' + mysql.escape(idLower) + ' LIMIT 1');
      if (!arows.length) return res.status(401).json({ error: 'Invalid credentials' });
      const au = arows[0];
      // Is this Axiom user an enabled member? Match by axiom id, email, or username.
      db.get('SELECT * FROM members WHERE axiom_user_id = ? OR LOWER(email) = ? OR LOWER(username) = ?',
        [au.id, (au.email||'').toLowerCase(), (au.username||'').toLowerCase()], async (mErr, member) => {
        if (!member) return res.status(401).json({ error: 'No access. Ask an admin to enable your account.' });
        if (!member.enabled) return res.status(403).json({ error: 'Your account is disabled. Contact an admin.' });
        if (!au.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
        const hash = au.password_hash.replace(/^\$2y\$/, '$2a$');
        const valid = await bcrypt.compare(password, hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        db.run('UPDATE members SET last_login = datetime("now"), username = COALESCE(username, ?) WHERE id = ?', [(au.username||'').toLowerCase(), member.id]);
        const memberIsAdmin = !!member.is_admin;
        const token = jwt.sign({ key: 'member:' + member.email, username: member.display_name || member.email, is_admin: memberIsAdmin }, process.env.JWT_SECRET, { expiresIn: '30d' });
        return res.json({ token, username: member.display_name || member.email, is_admin: memberIsAdmin });
      });
    } catch (e) {
      return res.status(500).json({ error: 'Login error: ' + e.message });
    }
  });
});

// ====== STEPPED FLOW (debug/optimize mode) ======
// Each step is a discrete call. Steps 2,3,4 are pure data (no model) for speed.
// The frontend drives the sequence and gates each step behind a Next click.
// ---- Voice typing for the staff chats (ChatBot page and CRM widget) ----
// Same recording bar and speech service as the customer chat (public/axiom-voice.js,
// speech-to-text.js). Recordings are never stored.
const SttStaff = require('./speech-to-text')();
const sttStaffHits = new Map();
app.get('/api/voice', auth, (req, res) => res.json({ ok: true, server: !!SttStaff.provider() }));
app.post('/api/transcribe', auth, (req, res, next) => {
  if (!SttStaff.provider()) return res.status(503).json({ ok: false, error: 'Voice typing is not set up on the server.' });
  if (parseInt(req.headers['content-length']) > 4 * 1024 * 1024 + 1024) return res.status(413).json({ ok: false, error: 'That recording is too long — two minutes at most.' });
  const who = String(req.user && req.user.key || 'x'), now = Date.now();
  const arr = (sttStaffHits.get(who) || []).filter(t => now - t < 10 * 60 * 1000);
  if (arr.length >= 120) return res.status(429).json({ ok: false, error: 'Too many recordings — please wait a few minutes.' });
  arr.push(now); sttStaffHits.set(who, arr);
  next();
}, express.raw({ type: () => true, limit: 4 * 1024 * 1024 + 1024 }), async (req, res) => {
  try {
    // Staff: English unless ?lang= says otherwise.
    const lang = /^[a-z]{2,3}$/.test(String(req.query.lang || '')) ? String(req.query.lang) : 'en';
    res.json({ ok: true, text: await SttStaff.transcribe(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { lang: lang }) });
  } catch (e) {
    if (/recording|format/.test(e.message)) return res.status(400).json({ ok: false, error: 'That recording could not be read. Please try again.' });
    console.error('STAFF transcribe', e.message);
    res.status(502).json({ ok: false, error: 'Could not turn that into text. Please try again.' });
  }
});

app.post('/api/chatbot/chat', auth, async (req, res) => {
  const { messages } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Never emit a card with no content. A blank "? Client" placeholder and an
  // empty "WHICH CLIENT?" header both came from sending the event before there
  // was anything to put in it.
  const EMPTY_CARD = {
    client_card:   o => !(o.client && (o.client.id || o.client.name)),
    client_picks:  o => !(Array.isArray(o.clients) && o.clients.length),
    product_picks: o => !(Array.isArray(o.products) && o.products.length),
    product_cards: o => !(Array.isArray(o.products) && o.products.length),
    option_picks:  o => !(Array.isArray(o.options) && o.options.length),
    choice_picks:  o => !(Array.isArray(o.choices) && o.choices.length),
    turnaround:    o => !(o.data && (o.data.readyLabel || (o.data.timeline || []).length))
  };
  // Set when the person clicks something else and the browser drops this stream.
  // Declared before send() reads it.
  let aborted = false;

  const send = (obj) => {
    if (aborted) return;                        // nobody is listening any more
    if (obj && EMPTY_CARD[obj.type] && EMPTY_CARD[obj.type](obj)) return;
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);

  // The person clicked something else, so this answer is no longer wanted.
  // Closing the browser stream alone would leave the model generating and the
  // tools running at full cost, so the loop watches this and stops for real.
  // It is only ever checked BETWEEN tools — never mid-operation, so nothing is
  // left half-done.
  
  // Watch the RESPONSE, not the request. req 'close' fires as soon as the POST
  // body has been read — which is immediately, on every normal request — so
  // listening there aborted every answer the instant it began.
  // res 'close' before writableFinished is the real signal: the client hung up
  // while we were still writing. Wrapped so it can never throw, because an
  // exception here kills the response before headers are sent.
  res.on('close', () => {
    try {
      if (!res.writableFinished) {
        aborted = true;
        console.log('CHAT_ABORT client moved on — stopping this answer');
      }
    } catch (e) { /* never let this handler take the process with it */ }
  });

  const tools = [{
    name: 'query_database',
    description: 'Run a SELECT query against the AxiomPrint MySQL database to answer questions about products, options, pricing structure, clients, or orders. Use this whenever the answer depends on live data rather than written knowledge. Read-only: SELECT statements only.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SELECT SQL query to execute' },
        description: { type: 'string', description: 'Short friendly description of what this checks (shown to the user)' }
      },
      required: ['sql', 'description']
    }
  }, {
    name: 'get_product_options',
    description: 'Get a product\'s fields and every selectable option: paper stocks, sizes, turnarounds, finishing, quantities — with prices, which is the default, and which are hidden. USE THIS (not raw SQL) whenever someone asks what options / papers / sizes / turnarounds a product has. Optionally pass `field` to narrow to one field (e.g. "paper" or "size").',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'The product.id' },
        field: { type: 'string', description: 'Optional. Only return fields whose name contains this, e.g. "paper", "size", "turnaround".' }
      },
      required: ['product_id']
    }
  }, {
    name: 'get_product_image',
    description: 'Get the photo(s) for a product: the main catalog image plus any gallery images. Use whenever someone asks to see a product, or asks for its photo, thumbnail, picture or image. Returns image URLs which you MUST display using markdown image syntax so they render: ![name](url)',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'integer', description: 'The product.id' } },
      required: ['product_id']
    }
  }, {
    name: 'find_products',
    description: 'Search the product catalog and get matching products as NAME + id. ALWAYS use this when the user names a product type ("postcards", "business cards") instead of guessing or listing bare ids. CRITICAL: if the person also stated any specs — paper, size, finish, coating, colour — pass them in `specs`. Those are what tell one poster from another; searching the name alone returns every poster we sell and buries the right one. If several match, the user is shown clickable buttons, so do NOT list the products yourself: say one short line like "Which one?" and stop.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The product type only, e.g. "postcard", "poster", "business card". Do NOT put specs here.' },
        specs: { type: 'array', items: { type: 'string' },
          description: 'Every spec the person stated, as they said it: ["14pt c1s", "12x18", "soft touch", "spot uv"]. Shorthand is fine — it is translated. A product offering these ranks far above one that merely shares the name. Omitting them is the single most common reason the wrong product comes back first.' },
        quantity: { type: 'integer', description: 'How many they need, if stated. A product whose quantity range does not reach this number CANNOT do the job — Single Premium Posters stops at 100, so it is the wrong product for 1,000. Always pass this when a number is given.' },
        size: { type: 'string', description: 'The size they stated, e.g. "24x36", "4x6". Passed separately from specs so products that offer it can be ranked first.' },
        intent: { type: 'string', enum: ['info', 'price'],
          description: 'What happens when they pick one. "info" — they asked a QUESTION about the product ("what paper stocks do we offer for postcards", "what sizes", "does it come in matte") and picking should ANSWER it. "price" — they are working towards an order ("I need 500 postcards", "quote this") and picking should open the calculator. Default is info: a question about a product is not a request to price it.' }
      },
      required: ['query']
    }
  }, {
    name: 'find_client_products',
    description: 'Search what THIS CLIENT has ordered before. Use this the moment a request sounds like a repeat — "reorder", "same as last time", "another batch", "2 boxes of windowed envelopes" — instead of searching the whole catalogue. It is far more accurate: it returns the exact products they actually buy, with their last order number, date, quantity and specs, so a quote can be rebuilt from what they had rather than guessed from a name. Requires a client to be connected to the conversation.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What they are asking for, e.g. "envelopes", "windowed envelopes". Leave empty to list everything they order.' },
        client_id: { type: 'integer', description: 'Only if a different client from the one connected.' }
      }
    }
  }, {
    name: 'get_file_specs',
    description: 'The artwork setup for a product: required resolution (DPI), bleed and safe area. Use this for ANY question about DPI, resolution, bleed, safe zone, margins or how to set up a file — every product has these stored, so there is always a real answer. Never say we have no DPI spec and never quote an industry rule of thumb: look it up here.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'The product as they said it, e.g. "fabric banners", "business cards", "roll labels".' },
        product_id: { type: 'integer', description: 'Use instead of `product` when you already know the id.' }
      }
    }
  }, {
    name: 'get_dieline',
    description: 'Get the die line / template file (a Google Drive PDF) for a product. Die lines hang off individual OPTIONS — usually the Folding or Template field — and are gated by another field, most often Size. One product can therefore have several. Call with just product_id first: if more than one exists you get them all back with the size and fold each belongs to, and the user is shown clickable buttons to pick. Pass option_item_id once they have chosen.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'The product.id' },
        option_item_id: { type: 'integer', description: 'Optional. product_variable_item.id of the chosen fold/template option.' }
      },
      required: ['product_id']
    }
  }, {
    name: 'calculate_turnaround',
    description: 'Work out when a job will be ready, and draw a visual day-by-day timeline for the user. Use this for ANY question about turnaround, lead time, "when will it be done", "can we make [date]", or explaining how turnaround is counted. Weekends and AxiomPrint holidays are excluded automatically. If the question is about a specific product, get its real turnaround options first with get_product_options.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'BUSINESS days of production, taken from what the person actually said. "5 business days" is 5. NEVER guess and never default to 1 — a one-day timeline against a five-day job is the worst answer this tool can give.' },
        turnaround_text: { type: 'string', description: 'The turnaround EXACTLY as they wrote it — "5 business days", "next day", "2 weeks". Parsed server-side and preferred over `days`, so pass it whenever they said one in words.' },
        label: { type: 'string', description: 'What to call it, e.g. "3 Business Days" or "Next Day".' },
        approval_date: { type: 'string', description: 'Optional YYYY-MM-DD the artwork is approved. Defaults to today in Los Angeles.' },
        before_cutoff: { type: 'boolean', description: 'Ignored for today — the 5PM cutoff is read from the Los Angeles clock. Only used with a past approval_date.'
        },
        product: { type: 'string', description: 'Optional product name to show as the heading.' },
        need_by: { type: 'string', description: 'Optional YYYY-MM-DD the client needs it in hand, so the timeline shows whether it makes the date.' }
      },
      required: ['days']
    }
  }, {
    name: 'find_option',
    description: 'Search EVERY product for a named option, finish, coating or material, across ALL fields at once. Use this whenever someone asks which products offer something ("which product has linen lamination", "what has soft touch", "who does spot UV"), AND whenever an option you expected is missing from the field you looked in. Returns the products that offer it, which FIELD it sits under, and whether it is hidden. Always prefer this over guessing which field an option belongs to.',
    input_schema: {
      type: 'object',
      properties: {
        option: { type: 'string', description: 'The option to look for, e.g. "linen lamination", "soft touch", "spot uv"' },
        product_id: { type: 'integer', description: 'Optional. Restrict to one product to see which of its fields carries the option.' }
      },
      required: ['option']
    }
  }, {
    name: 'ask_option',
    description: 'Show the real, selectable options for ONE field as clickable cards WITH their images, so the person picks visually instead of reading a list. Use this ANY time you would otherwise ask "which size / material / finish / shape?" — it is clearer than listing them in text and the images come from the product data.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'The product.id' },
        field: { type: 'string', description: 'Field to show, e.g. "Size", "Material", "Finishing". Matched loosely.' },
        only: { type: 'array', items: { type: 'integer' },
          description: 'Optional product_variable_item ids to limit the list to — e.g. only the sizes that have die lines.' }
      },
      required: ['product_id', 'field']
    }
  }, {
    name: 'ask_choice',
    description: 'Ask ONE question and show the answers as clickable buttons. Use this whenever you need something that is NOT a product field (ask_option covers those) — e.g. "Is this a reorder or a new job?". Never ask a question in plain text when the answers are a short known set: make them clickable.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One short question.' },
        choices: { type: 'array', items: { type: 'string' }, description: '2-6 short answers to show as buttons.' }
      },
      required: ['question', 'choices']
    }
  }, {
    name: 'find_client',
    description: 'Identify a client. Pass email for an exact match (emails are unique, so this resolves immediately). Otherwise pass name and/or company for a STARTS-WITH search ranked by how active the client is. If several match, the user is shown clickable buttons — reply with one short line asking which and stop. Use this whenever a person, company or email is mentioned and you need their record.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Client email — exact match, resolves in one step.' },
        name: { type: 'string', description: 'First and/or last name. Matched as STARTS WITH.' },
        company: { type: 'string', description: 'Company name. Matched as STARTS WITH.' },
        client_id: { type: 'integer', description: 'customer.id once the user has picked from the list.' }
      }
    }
  }, {
    name: 'get_client_context',
    description: 'Once a client is identified, pull everything about them: their last 20 orders with products, specs, totals and dates; their usual choices per field; their discount and payment terms; and recent email threads. Use this before quoting or recommending anything for a known client, and to answer "what do they usually order".',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'integer', description: 'customer.id from find_client' }
      },
      required: ['client_id']
    }
  }, {
    name: 'calculate_price',
    description: 'Price a job using the REAL calculator engine — the same one the website and Order Assist use. ALWAYS use this for any price. NEVER work a price out yourself from a formula or by multiplying values: the formulas use square feet, tier scaling and base fees in ways that are easy to get wrong, and a wrong price quoted to a client costs real money. Pass the product id, quantity, and the options you want by name; anything you omit uses the product default.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'The product.id' },
        quantity: { type: 'integer', description: 'OMIT THIS unless the person stated a number — do not supply one yourself; leaving it out uses the product default and flags the row for confirmation. TOTAL pieces across all versions. On the website this is the Quantity field, and Versions splits it. 4 versions of 25 each = quantity 100.' },
        quantity_per_version: { type: 'integer', description: 'Use THIS when the person says "25 of each" or "25 per version" — pass 25 here and the version count in versions, and the total is worked out for you. Do not also pass quantity.' },
        version_list: { type: 'array', description: 'Use THIS whenever the person lists versions with their own quantities and names, e.g. "Version 1: 20 - Media, Version 2: 800 - General Admission". The total quantity and version count are worked out from the list — do NOT also pass quantity or versions, and never divide a total evenly when a real breakdown was given.',
          items: { type: 'object', properties: {
            name: { type: 'string', description: 'Version name, e.g. "Media" or "General Admission"' },
            quantity: { type: 'integer', description: 'Pieces for this version' }
          }, required: ['quantity'] } },
        features: { type: 'array', items: { type: 'string' }, description: 'Capabilities the person asked for in plain words — e.g. ["foil","spot uv","round corners"]. Use this when you know they want something but not which field or option title it maps to. They will be matched to the right field and a real option chosen, never "No".' },
        options: {
          type: 'object',
          description: 'Field name -> option title, e.g. {"Shape":"Shape","Material":"4mm White Coroplast"}. Use exact titles from get_product_options. Omitted fields use their default.',
          additionalProperties: { type: 'string' }
        },
        width: { type: 'number', description: 'Width in inches. Pass it whenever a size appears ANYWHERE in the conversation, even if you think it matches the product default — omitting it makes a size they stated look unstated, and the card then asks them to confirm something they already said. ALWAYS pass this with height when the client states a size — most products accept any W x H within their limits, even when that exact size is not in the options list. "5x7" on a product whose list shows only 8.5x11 is still orderable; leaving it out quotes the wrong size.' },
        height: { type: 'number', description: 'Height in inches. Pass with width.' },
        size: { type: 'string', description: 'The size exactly as the client wrote it — "5\" x 7\"", "5x7", "11 x 17". Parsed into width and height for you, so pass this whenever you see a size and are unsure how to split it.' },
        versions: { type: 'integer', description: 'Number of distinct designs, if the product supports versions.' },
        client_id: { type: 'integer', description: 'customer.id when pricing for a known client. IMPORTANT: pass this whenever you know who the job is for — accounts can have wholesale or trade discount tiers, and without it you will quote the undiscounted list price.' }
      },
      required: ['product_id', 'quantity']
    }
  }, {
    name: 'get_job',
    description: 'Look up one job / estimate by its E-number (e.g. E1175114) and show a card with its status, specs, product photo and a Reorder button. Use whenever a specific E-number is mentioned or the person asks about the status of a job.',
    input_schema: {
      type: 'object',
      properties: {
        e_number: { type: 'string', description: 'The E-number, with or without the leading E, e.g. "E1175114" or "1175114".' }
      },
      required: ['e_number']
    }
  }, {
    name: 'quote_installation',
    description: 'Price an ON-SITE INSTALLATION (putting up decals, window film, wall graphics, panels, letters, banners at the client\'s location) and show the team an editable installation calculator. ' +
      'CALL THIS EVERY TIME installation / install / mounting / applying graphics on site / an installer / an install crew comes up with any interest in price, cost, quote or what it takes — even with almost nothing known. Pass only what was actually said; ' +
      'the card shows every field and the team fills the gaps. NEVER work out installation prices yourself and never state a rate from memory — the rates are admin-edited and only this tool has them. ' +
      'Equipment ids are listed on the equipment field. Ground level = no equipment. Pick the SMALLEST that reaches the stated height; above ' + installPricing.install.max_height_ft + ' ft pass height_ft and do not choose equipment.',
    input_schema: {
      type: 'object',
      properties: {
        pieces: { type: 'array', description: 'Every graphic to install, one row per distinct size.',
          items: { type: 'object', properties: {
            name: { type: 'string', description: 'Short label, e.g. "Front window decal"' },
            w_in: { type: 'number', description: 'Width in inches (convert feet × 12)' },
            h_in: { type: 'number', description: 'Height in inches' },
            qty: { type: 'integer', description: 'How many of this size' },
            material: { type: 'string', enum: installPricing.install.materials.map(m => m.id),
              description: installPricing.install.materials.map(m => m.id + '=' + m.label).join(', ') + '. OMIT if not stated — do not guess.' }
          }, required: ['w_in', 'h_in'] } },
        address: { type: 'string', description: 'Install address or place ("Vons, Sun Valley, CA") whenever it is mentioned. Road miles and drive time from the Glendale shop are looked up from it automatically — do not ask for miles.' },
        distance_mi: { type: 'number', description: 'Only if the person states the miles themselves. Otherwise pass the address and it is measured. "At AxiomPrint" / in-shop = 0.' },
        equipment: { type: 'array', items: Object.assign({ type: 'string' },
            installPricing.install.equipment.length ? { enum: installPricing.install.equipment.map(e => e.id) } : {}),
          description: installPricing.install.equipment.map(e => e.id + '=' + e.label).join(', ') },
        height_ft: { type: 'number', description: 'Highest point of the install in feet, if stated.' },
        insurance: { type: 'string', enum: installPricing.install.insurance.map(i => i.id),
          description: installPricing.install.insurance.map(i => i.id + '=' + i.label).join(', ') + '. Omit unless stated; waived only if the client says no certificate is needed.' },
        date: { type: 'string', description: 'Install date YYYY-MM-DD, if given.' },
        arrival_start: { type: 'string', description: 'Arrival window start, e.g. "11:00 AM".' },
        arrival_end: { type: 'string', description: 'Arrival window end, e.g. "11:30 AM".' },
        schedule: { type: 'string', enum: ['weekday_business', 'weekday_after', 'saturday', 'sunday'], description: 'Only when stated without a date ("on a Saturday", "after hours").' }
      }
    }
  }, {
    name: 'quote_delivery',
    description: 'Price a LOCAL DELIVERY (our own driver or Uber, inside the LA area) and show an editable delivery calculator. Call this whenever someone asks what delivering / dropping off an order costs locally. Never work the price out yourself.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Drop-off address or place. Miles and drive time are measured from it automatically.' },
        distance_mi: { type: 'number', description: 'Only if the person states the miles themselves. Otherwise pass the address.' },
        drop_time: { type: 'string', description: 'Drop-off time if stated, e.g. "5 PM" — sets the traffic factor.' },
        traffic: { type: 'string', enum: installPricing.delivery.traffic.map(t => t.id), description: 'Only if stated in those terms.' }
      }
    }
  }, {
    name: 'run_report',
    description: 'Run one of Nova\'s ready-made reports and show it as an interactive table beside the chat (with a full-screen view, filters, sorting, Copy emails and CSV). ' +
      'USE THIS instead of query_database whenever the question matches one of these:\n' +
      Reports.list().map(r => '- ' + r.id + ': ' + r.description + ' Params: ' + r.params).join('\n') +
      '\nExamples: "who hasn\'t ordered in 3 months" -> client_followup {months:3, window:"1m"}; ' +
      '"clients to follow up this week" -> client_followup {months:3, window:"1w"}; "best clients this year" -> top_clients {period:"ytd"}; ' +
      '"who owes us money" -> unpaid_invoices; "what sold last month" -> product_sales {period:"last_month"}. ' +
      'The team can change every setting on the report itself, so pick sensible defaults rather than asking.',
    input_schema: {
      type: 'object',
      properties: {
        report: { type: 'string', enum: Reports.list().map(r => r.id) },
        params: { type: 'object', description: 'Report settings as listed above. Omit anything not stated.' }
      },
      required: ['report']
    }
  }];

  // What has actually been said, so only the relevant product guide is pulled in.
  const recentText = (messages || []).slice(-6).map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(c => c.text || '').join(' ');
    return '';
  }).join(' ');
  const brain = await loadCompanyBrain(recentText);

  // Products are visual — whenever a tool touches specific products, push their
  // thumbnails to the UI so the team sees what is being talked about.
  const shownProducts = new Set();
  // Once a client is identified in this conversation, remember them. The model
  // sometimes drops client_id on a follow-up price, which silently removes the
  // account discount — a 33% swing on the number someone is about to order at.
  let sessionClientId = null;
  let sessionClientName = null;
  // Only ONE product list per answer. A second search (usually a better one, run
  // after the client was identified) replaces the first rather than leaving two
  // conflicting lists on screen.
  let picksShown = 0;
  // One price card per answer. Pricing twice — once on defaults, then again with
  // a spec that was in the request all along — leaves two different totals on
  // screen and makes the AM guess which one is real.
  let quotesShown = 0;
  const pricedThisTurn = new Set();
  // The one product this answer is allowed to price. Several quantities of the
  // SAME product are a price ladder and welcome; a second PRODUCT is the next
  // item of the job, and that waits its turn.
  let pricedProduct = null;
  // One product search per answer. A request for two different things cannot be
  // answered with two pickers — there is nowhere to select two products, and the
  // second list just buries the first. Items get handled one at a time.
  let searchedThisTurn = null;
  // Set when the answer ends on something the person must click. The loop stops
  // rather than making another model call that has nothing to add.
  let awaitingClick = false;
  // Whether the model has written anything yet. If it dives straight into a
  // search with no word to the person, we say what is being looked for
  // ourselves — a spinner over a silent screen is the worst moment in the flow.
  let saidAnything = false;
  // ...and one client search. Two "which client?" lists in one answer means two
  // sets of buttons where only one can be acted on.
  let clientSearchThisTurn = 0;
  // Installation / delivery calculators drawn in this answer. A second one
  // (after the model learns more) replaces the first on screen.
  let installShown = 0;
  // Reports drawn in this answer; a second one replaces the first.
  let reportsShown = 0;

  // A client pinned to this conversation carries across turns — the agent should
  // never re-ask who a job is for once it has been told.
  const chatIdIn = parseInt(req.body.chat_id) || null;
  if (chatIdIn) {
    try {
      const pinned = await new Promise(r =>
        db.get('SELECT client_id, client_name FROM chats WHERE id = ?', [chatIdIn], (e, row) => r(e ? null : row)));
      if (pinned && pinned.client_id) {
        sessionClientId = pinned.client_id;
        sessionClientName = pinned.client_name;
      }
    } catch (e) {}
  }

  // Pin whoever we identify, so the next turn already knows.
  async function pinClient(id, name) {
    if (!id) return;
    sessionClientId = id;
    if (name) sessionClientName = name;
    if (!chatIdIn) return;
    db.run('UPDATE chats SET client_id = ?, client_name = COALESCE(?, client_name) WHERE id = ?',
      [id, name || null, chatIdIn], () => {});
    send({ type: 'client_pinned', client_id: id, client_name: name || sessionClientName || null });
  }
  // True once the model has asked for options — the chip that follows is on its
  // way to a price, so it renders as "Calculating…" instead of a live button.
  let pricingNext = false;
  async function sendProductCards(ids) {
    const fresh = (Array.isArray(ids) ? ids : [ids])
      .map(Number).filter(n => n && !shownProducts.has(n));
    if (!fresh.length) return;
    fresh.forEach(n => shownProducts.add(n));
    try {
      const rows = await runQueryRaw(
        'SELECT id, title, public_title, image, url FROM product WHERE id IN (' + fresh.join(',') + ')');
      const cards = rows.map(r => ({
        id: r.id,
        name: r.title || r.public_title,
        image: r.image || null,
        url: r.url ? ('https://axiomprint.com/product/' + r.url) : null
      }));
      if (cards.length) send({ type: 'product_cards', products: cards });
    } catch (e) { /* thumbnails are a nicety - never break the answer over them */ }
  }

  const systemPrompt =
    'You are ChatBot, the AxiomPrint company brain. AxiomPrint is a Los Angeles commercial printing and ' +
    'fulfillment company. You answer questions from AxiomPrint STAFF - account managers, production, sales, ' +
    'and admin. Treat every question as an internal one.\n\n' +

    'WHAT YOU KNOW, and the order to trust it in:\n' +
    '1. TEAM MEETING NOTES and DOMAIN KNOWLEDGE below - these are what the team actually decided. They beat ' +
    'your general printing knowledge every time. If a meeting note says AxiomPrint does something a certain ' +
    'way, that is the answer, even if the industry usually does it differently.\n' +
    '2. THE LIVE DATABASE - for anything about specific products, options, prices, clients, or orders, LOOK ' +
    'IT UP. Use get_product_options for a product\'s fields and choices; use query_database for everything ' +
    'else. Never answer product questions from memory: option lists and prices change.\n' +
    '3. APPROVED ANSWERS below - the team marked these correct. Reuse their facts and tone.\n' +
    '4. General print-industry knowledge - only when nothing above covers it, and say so when you rely on it.\n\n' +

    'ATTACHMENTS (pasted images, PDFs, spreadsheets, documents):\n' +
    '- People attach screenshots, client emails, spec sheets, proofs, price lists, order CSVs. Read them and ' +
    'treat everything in them as if it had been typed to you - names, emails, quantities, sizes, dates, ' +
    'E-numbers, product names.\n' +
    '- A spreadsheet or CSV arrives as text, one section per sheet. If it lists several jobs or line items, ' +
    'work through them rather than summarising - say what each one needs.\n' +
    '- Then just do the task. If it is a client request, identify the client and price it. If it is an ' +
    'E-number, look the job up. Do not describe the image back to them unless they ask what it shows.\n' +
    '- If something in the image is genuinely unreadable, say which part and ask - never guess at a number ' +
    'or a spec you cannot actually read.\n\n' +

    'JOBS / E-NUMBERS:\n' +
    '- An E-number (E1175114) identifies one job. Use get_job for it — never raw SQL. The card shows the ' +
    'status, specs, product photo and a Reorder button, so afterwards one short line is enough.\n' +
    '- When you list orders, always write the E-number in full (E1175114). They are turned into clickable ' +
    'links automatically, so the team can open any job from your answer.\n' +
    '- Status has two parts: prepress (files, proofs) and production. While files are still moving the ' +
    'prepress status is the real answer; once approved, production status is.\n\n' +

    'PRICING — never do this in your head:\n' +
    '- DISCOUNTS: many accounts have a wholesale or trade tier. ALWAYS pass client_id to calculate_price ' +
    'when you know who the job is for, or you will quote list price to a client who should get 20-50% off. ' +
    'The card shows list price struck through with the discounted price beside it - just state the ' +
    'discounted total and name the tier in one short line.\n' +
    '- If you priced something BEFORE the client was identified, and the client is then named, price it ' +
    'AGAIN with client_id. Do not leave an undiscounted card as the live quote - it is the number someone ' +
    'will send or order at.\n' +
    '- VERSIONS: several artwork designs in ONE job. Quantity is the TOTAL across all versions.\n' +
    '  * DIFFERENT sizes per version - "2 versions, 500 and 800" / "V1: 20 Media, V2: 800 General ' +
    'Admission" -> ONE call, version_list ONLY:\n' +
    '      version_list: [{"name":"V1","quantity":500},{"name":"V2","quantity":800}]\n' +
    '    That is ONE job of 1300. Do NOT price the versions separately, do NOT produce two price cards, ' +
    'and do NOT pass quantity or versions alongside version_list.\n' +
    '  * SAME size for every version - "25 of each, 4 versions" -> quantity_per_version 25, versions 4.\n' +
    '  * NEVER split a total evenly. If they said 500 and 800, it is NOT 650 and 650. If you genuinely do ' +
    'not know the split, ASK - never assume equal.\n' +
    '  * Keep the versions in the ORDER THEY WERE STATED. "500 and 800" means Version 1 = 500 and ' +
    'Version 2 = 800. Reversing them changes what production prints.\n' +
    '  * Never pass the per-version number as `quantity` - that underprices by the version count.\n' +
        '- Version NAMES are NOT needed to price. Never ask what the versions are called before quoting — only the quantities affect the price. Names are typed on the price card (or filled by Autofill) when the order is placed, and are required only then.\n' +
    '- REORDERS: use the `reorder` object get_job gives you verbatim (product_id, client_id, quantity, ' +
    'versions, options, width/height). If the new total is far from the original, say so plainly and ask ' +
    'what changed - do not present a different number as if it were the same job.\n' +
    '- RELATED-TO RULES: many options only exist with another selection (Scoring on Book Dust Jackets only ' +
    'with 100# Gloss Cover, a 4/4 print colour only with Both Sides, Foil Color only when Foil is on, some ' +
    'turnarounds only at larger quantities). get_product_options and find_option return these as only_when / ' +
    'related_to_rules. Whenever you answer about a field or option — what it costs, whether we offer it, how it ' +
    'works — check for a condition and STATE IT in the same answer, including which choices it does NOT work ' +
    'with. If a price card reports not_applied, the option was left out of that price: say why and offer to ' +
    'reprice with the selection that allows it.\n' +
    '- MATERIAL QUESTIONS ("what synthetic paper do we use for menus", "do we have waterproof posters"): the answer is ' +
    'often a different product of the same type (Plastic Menus, not Laminated Menus). Pass the material word in ' +
    'find_products specs, and before saying we do not offer a material, check with find_option across products — ' +
    'materials are named by what they are (15Mil White PVC, Yupo, polypropylene), not "synthetic".\n' +
    '- Call get_product_options FIRST so you have the EXACT option titles, then pass those to ' +
    'calculate_price. Guessing a value ("Yes" for round corners when the real options are 1/8" Round and ' +
    '1/4" Round) means the request is silently ignored.\n' +
    '- Map the request to real options before pricing: "2 sided" / "double sided" / "both sides" is the ' +
    'Printed Sides field, "rounded corners" is Round Corners, a finish is Finishing. If the person was ' +
    'vague and several options fit, ASK rather than defaulting.\n' +
    '- CHECK DOMAIN KNOWLEDGE FIRST. Anything the team has written down — policies, turnaround rules, ' +
    'product guides, what was decided in a meeting — outranks your own printing knowledge. If a question ' +
    'is answered there, answer FROM it, in its terms. Never give a general-industry answer when the team ' +
    'has written a specific one.\n' +
    '- THE CUTOFF IS 5PM LOS ANGELES. Not 4PM, not anything else. The rule, in full:\n' +
    '    Approved BY 5PM  -> today is the START DAY. Day 1 is tomorrow.\n' +
    '    Approved AFTER 5PM -> today does not count. Tomorrow is the START DAY, and Day 1 is the day\n' +
    '      after that.\n' +
    '    Weekends and holidays are never counted. The start day is never Day 1 — counting begins the\n' +
    '      following business day.\n' +
    '    AXIOMPRINT CLOSED DAYS (the shop calendar; no production or pick-up, never counted; "are you open on …?" is\n' +
    '      answered from this): ' + (closedDays.text(400) || 'see the calendar') + '.\n' +
    '    Worked example, because this is the one people get wrong: approved Wednesday at 10PM, 5 business\n' +
    '      days. After the cutoff, so Wednesday is out. Thursday is the start day. Friday is Day 1, Monday\n' +
    '      Day 2, Tuesday Day 3, Wednesday Day 4, Thursday Day 5 — READY THURSDAY.\n' +
    '- ALWAYS DRAW THE CALENDAR for any turnaround question. Call calculate_turnaround and let the visual ' +
    'answer it — never work the dates out in prose. Pass `turnaround_text` exactly as they said it ' +
    '("5 business days") and `days` to match. Passing 1 for a five-day job draws a one-day schedule and ' +
    'is worse than not answering.\n' +
    '- If they say your timeline is wrong, CHECK THEIR ARITHMETIC BEFORE DEFENDING IT. Re-read the rule ' +
    'above and count it out. They know this work; a confident wrong answer costs far more than a correction.\n' +
    '- DPI, BLEED AND SAFE AREA are stored on every product. Any question about resolution, DPI, bleed, ' +
    'safe zone or file setup goes to get_file_specs — there is always a real answer, so never say we have ' +
    'no spec and never fall back to an industry rule of thumb. Answer in one line: "For Fabric Banners the ' +
    'required file resolution is 150 DPI, with no bleed and a 0.25\" safe area."\n' +
    '- NEVER ASK BEFORE QUOTING. A missing spec is not a reason to stop. Price it on the product default ' +
    'and let them correct it on the card — a number they can adjust beats a question they have to answer.\n' +
    '- NEVER INVENT A QUANTITY OR SIZE. If they did not state one, OMIT the parameter entirely — do not ' +
    'pass a number you chose yourself. Leaving it out applies the product\'s own default and marks the row ' +
    '"Clarify" with a dropdown; passing your own guess marks it SPECIFIED, which tells the person they ' +
    'asked for something they never asked for. "Quantity defaulted to 10" is you inventing 10.\n' +
    '- The team marks which fields must be confirmed rather than assumed (Size and Quantity on everything, ' +
    'plus things like Pages on a booklet). Any of those left on a default come back in `clarify` and are ' +
    'ALREADY shown on the card as a "Clarify" dropdown that reprices in place. Do NOT ask about them in ' +
    'chat and do NOT use ask_option for them — say one short line that the quote assumes those defaults, ' +
    'and name them.\n' +
    '- Every other field takes the product default silently — do not ask about paper, finishing, print ' +
    'colour, foil, spot UV, corners or shape unless the person raised them.\n' +
    '- TURNAROUND: leave it on the default unless they mention a DEADLINE ("needs to arrive by the 21st", ' +
    '"how fast can you do this", "rush"). Then check it with calculate_turnaround and say whether it makes ' +
    'the date.\n' +
    '- NEVER add a paid option they did not ask for. Foil, spot UV, lamination, round corners and the like ' +
    'default to "No" on most products, and "No" is free. Adding one inflates the quote and misrepresents ' +
    'the job. Pass `features` ONLY for things they named in their own words.\n' +
    '- Do not describe an option as "specified" unless they actually specified it. The card marks values ' +
    'as specified / default / auto for you — do not contradict it in your text.\n' +
    '- Fields depend on each other. Choosing Printed Sides = Front and Back forces Print Color to 4/4, and ' +
    'calculate_price applies these rules for you. If it reports auto_adjusted, say so in one line.\n' +
    '- If it reports could_not_match, tell the person plainly which of their requests did not match, list ' +
    'the real options, and offer to reprice. NEVER let a request quietly fall back to a default.\n' +
    '- ALWAYS use calculate_price. NEVER multiply values from a formula yourself and NEVER show a ' +
    'breakdown you worked out. The formulas use square FEET (w*h/144), tier scaling and per-option base ' +
    'fees; hand arithmetic gets them wrong and a wrong price sent to a client costs real money.\n' +
    '- If calculate_price fails, say pricing is unavailable and to check the calculator. Do not estimate.\n' +
    '- State which options were DEFAULTED rather than requested, so the team can correct them. Shape, ' +
    'material and turnaround change the price a lot.\n' +
    '- DO NOT INVESTIGATE WHETHER A SIZE IS ALLOWED. Pass width and height to calculate_price and let it ' +
    'answer. Querying the database to see whether a "Custom Size" option exists, or whether it is hidden, ' +
    'is how a perfectly orderable size gets talked down into "not available". Hidden options are hidden ' +
    'from the WEBSITE — we can still order them. If a size really is outside the limits, the pricing tool ' +
    'says so and you report that; otherwise it prices and you quote it.\n' +
    '- SIZES: when a client states a size, ALWAYS pass width and height to calculate_price. Most products ' +
    'take any size within their own min/max — the listed sizes are common presets, not the only choices. ' +
    'Never say a size "is not available" just because it is missing from the list, and never fall back to a ' +
    'default size: that quotes the wrong job. If the size really is outside the product limits, the tool ' +
    'says so and you report that.\n\n' +

    'CLIENTS:\n' +
    '- When a person, company or email address is mentioned, identify them with find_client before ' +
    'answering anything specific to them. An EMAIL is unique — one lookup settles it. A name or company ' +
    'is a starts-with search and may return several; the user gets clickable buttons ranked by activity, ' +
    'so ask which one and stop rather than guessing.\n' +
    '- Once identified, call get_client_context. Their order history, usual specs and email threads are ' +
    'what make an answer useful: "they always order 16PT Coated 2 Sides" beats a generic list of options.\n' +
    '- Never invent a client. If find_client returns nothing, say they are not on file.\n\n' +

    'GENERAL QUESTION vs PLACING AN ORDER — judge which one this is:\n' +
    '- MOST questions are general: what products we have, what options exist, turnaround, die lines, ' +
    'policy, what a client usually orders. Just answer them. Do not start an order workflow, do not ask ' +
    'for specs the person did not offer, and do not try to build a quote.\n' +
    '- It becomes an ORDER when the person is clearly preparing one: they paste a client request or email, ' +
    'they ask for a price or quote for a specific job, or they say things like "quote this", "price this ' +
    '50 postcards for Caitlin", "she wants 500 business cards".\n' +
    '- WORK IN THIS ORDER. Finish one stage before starting the next:\n' +
    '    STAGE 1 - THE PRODUCT. Pin down the product and every spec that matters. Missing a choice? Ask for ' +
    'ONE thing at a time with ask_option so they can click a real option (with its image) instead of typing. ' +
    'Anything they did not mention takes the product default - do not interrogate them about every field.\n' +
    '    STAGE 2 - PRICE IT. calculate_price. The card carries Copy, Edit and Order.\n' +
    '    STAGE 3 - THE CLIENT. If an email or name identifies exactly ONE client, they are connected ' +
    'automatically. Do not show a client card, do not ask "which client?", do not stop to confirm — the ' +
    'bar at the top already shows who it is. Carry straight on to the product.\n' +
    '    Only when several could match do you show the list and WAIT for a click.\n' +
    '    A quote without a client is a list price and will be wrong for most accounts.\n' +
    '    STAGE 4 - THE ORDER. The Order button collects job name, needed-by date, delivery method, address ' +
    'and artwork status in a form. NEVER ask those in chat - they are already fields, and asking duplicates ' +
    'work and invites typos.\n' +
    '- ONE QUESTION AT A TIME, always with buttons (ask_option for product fields, ask_choice otherwise). A ' +
    'numbered list of five questions in prose is the wrong answer - it makes the person type what they could ' +
    'have clicked.\n' +
    '- YOU CAN PLACE THE ORDER YOURSELF. Do NOT tell anyone to go to Order Assist and do NOT say you are ' +
    'unable to place orders - that is wrong. Every price card you produce carries an "Order" button that ' +
    'submits a real order to the AxiomPrint order system.\n' +
    '- When someone says "place the order", "let\'s order it", "ready to order" or similar:\n' +
    '  1. Make sure the client is identified (find_client). An order cannot be placed without one.\n' +
    '  2. RE-RUN calculate_price with that client_id. A price quoted before the client was known has NO ' +
    'account discount applied, and ordering at that figure would overcharge them.\n' +
    '  3. Then say, in one line, that the Order button on the card below will place it and will ask for the ' +
    'job name, needed-by date, delivery method and artwork status.\n' +
    '- If you are unsure which mode you are in, answer the question asked. Turning a simple question into ' +
    'an order interrogation is worse than answering plainly.\n\n' +

    'WHERE OPTIONS LIVE (get this wrong and you will report "not available" for something we sell):\n' +
    '- COATINGS, LAMINATIONS and FINISHES live under FINISHING (or a Lamination / Cover_Finishing field) — ' +
    'NOT under Paper Stock. Linen Lamination, Soft Touch, Matte/Gloss Lamination, Spot UV, Raised Spot UV, ' +
    'Foil, Round Corners, Scoring and Perforation are all finishing options applied to the printed piece.\n' +
    '- PAPER STOCK is the substrate itself: 14PT Coated, 100# Gloss Cover, 100# Linen. A linen STOCK and a ' +
    'Linen LAMINATION are different products entirely — one is textured paper, the other is a textured film ' +
    'applied on top. Never answer about one when asked about the other.\n' +
    '- If an option is not in the field you expected, DO NOT conclude we do not offer it. Call find_option, ' +
    'which searches every field on every product, and report which field it actually sits under.\n' +
    '- Only call something unavailable after find_option returns nothing.\n\n' +

    'HOW TO ANSWER — this matters as much as being right:\n' +
    '- ANSWER FIRST. The first line of your reply is the answer, never a preamble. Do not write "I\'ll look ' +
    'that up", "Let me check", "Let me try a different approach", or narrate what you are about to do. Just ' +
    'do it silently and state the result.\n' +
    '- BE SHORT. A list of options is a list, not an essay. No intro paragraph, no closing paragraph, no ' +
    '"Is there anything else I can help with?". Stop when the answer is finished.\n' +
    '- For anything with multiple items (paper stocks, sizes, turnarounds, quantities) use a markdown table ' +
    'or a plain bullet list. Include the price columns when you have them.\n' +
    '- Mark the DEFAULT option explicitly, and flag options that are hidden (in the database but not ' +
    'selectable on the site).\n' +
    '- Only add context the person did not ask for if it changes a decision (e.g. "16PT is what this client ' +
    'usually orders"). One line, at the end.\n' +
    '- THREE KINDS OF REQUEST. Work out which before you do anything:\n' +
    '    A QUESTION about a product -> find_products with intent "info". Answer it.\n' +
    '    A NEW JOB with specs -> find_products with intent "price". Quote it.\n' +
    '    A REORDER -> "reorder", "same as last time", "another 2 boxes", or any request that assumes we ' +
    'know what they mean. IDENTIFY THE CLIENT FIRST, then use find_client_products, NOT find_products. ' +
    'Their history tells you the exact product and the exact specs they had; the catalogue only tells you ' +
    'what exists. "2 boxes of windowed envelopes and 2 boxes no window" is one product with two different ' +
    'window options, which their history shows and a catalogue search does not.\n' +
    '- YOUR FIRST WORDS ARE THE RECAP. Before any tool call, in the same reply, write what you understood. ' +
    'Not a greeting, not a preamble — the job itself. This is not optional and it is not skippable: ' +
    'searching in silence gives them a spinner and no chance to correct a misreading.\n' +
    '    One item:  "NCR forms - 250, 500, 1000"\n' +
    '    Several:   "1) NCR forms - 250, 500, 1000\n               2) vinyl banners - 4x8ft, 5, 10, 20\n' +
    '                Starting with the NCR forms."\n' +
    '    List EVERY item from their message, even though you only search for the first. That list is how ' +
    'they know nothing was missed, and how you keep the later items straight.\n' +
    '  When they have ALREADY PICKED a product and you are only pricing it, write NOTHING first. The card ' +
    'is the answer; explaining before it appears puts the explanation above the number it explains. Price ' +
    'it, then add your line UNDER the card.\n' +
    '      "1000 brochures - 100# Gloss cover"\n' +
    '    The "say nothing" rule applies only AFTER the cards appear. It never applies to this line.\n' +
    '- 5x7, 4x6, 5.5x8.5 and similar are POSTCARD sizes, not business cards. Match the size to the right ' +
    'family before assuming which product they mean.\n' +
    '- MANY DESIGNS: VERSIONS vs VARIABLE DATA. Versions are separate print runs of the same job — right ' +
    'for a handful of designs ("1000 cards, 500 each" is 2 versions). Our practical limit is 25. ' +
    'Beyond that the setup cost per version stops making sense and VARIABLE DATA is the right route: one ' +
    'run, the names or details changing per piece.\n' +
    '    28 designs at 1 each is a VDP job, not 28 versions. Price it as a single run at the smallest ' +
    'quantity tier that covers it (usually 50) with Variable Data set to Yes, and say plainly why: ' +
    '"28 separate versions would be 28 setups; variable data prints them in one pass, which is why it is ' +
    'far cheaper."\n' +
    '    IF THE PRODUCT HAS NO VARIABLE DATA option (the quote tells you: hasVariableData false), say so ' +
    'directly and give them the two real choices: pick a product that does offer VDP, or split the job ' +
    'across two orders of 14 versions each. Do not quietly quote 28 versions on a product that cannot ' +
    'sensibly run them.\n' +
    '- ONE ITEM AT A TIME. A hard rule, and it applies to PRICING as much as searching. The whole ' +
    'sequence for a multi-item job:\n' +
    '    1. Recap every item, then say which you are starting with.\n' +
    '    2. Search for item 1 ONLY. Stop. Wait for them to pick.\n' +
    '    3. Price item 1. Several quantities of that ONE product is fine — that is a price ladder. ' +
    'A DIFFERENT product is not: it is item 2, and it is not your turn yet.\n' +
    '    4. Stop again. Say one short line naming what is next: "Next up: the vinyl banners." ' +
    'Then WAIT. They will Save item 1, or ask you to carry on.\n' +
    '    5. Only then, search for item 2.\n' +
    '    Never compress these. Pricing NCR forms and vinyl banners in one answer looks efficient and is ' +
    'the single most common way a multi-item quote goes wrong — specs cross over between items and ' +
    'neither can be saved cleanly.\n' +
    '    WRITE THE LIST FIRST. Before touching item one, put the whole job in one compact list so no spec ' +
    'is lost between items:\n' +
    '      1) exhibition booklets - 5x7, 500\n' +
    '      2) hang tags - 5x5, 250\n' +
    '    Then say which you are starting with. Keep that list in mind: when you come back for item 2, its ' +
    'size and quantity come from THAT LINE, not from whatever the last card happened to use. Carrying the ' +
    'wrong size into the next item is the most common way a multi-item quote goes wrong.\n' +
    '    Say which you are starting with: "Let\'s start with the business cards — I\'ll do the banners ' +
    'next." Then search, let them pick, price it, and let them press Save.\n' +
    '    Only AFTER that item is saved do you search for the next one. Never call find_products or ' +
    'find_client_products twice in one answer. Never offer a mixed list of "pick the card and the banner".\n' +
    '    Remember the other items. The moment an item is saved you will be told — that is ' +
    'your cue to start the NEXT item immediately: search for it, show the matches, and keep going. Do not ' +
    'wait to be asked, and do not summarise what you have done so far.\n' +
    '    When every item in the request is saved, say so in one line with the number of items.\n' +
    '- SHOW A LIST **OR** PRICE — never both in one answer. A list of matches IS the question "which one?", ' +
    'so pricing one of them yourself makes the list decoration. If a product is the obvious match (their ' +
    'usual, or an exact name), skip the list and price it. If it is genuinely ambiguous, show the list, say ' +
    'one short line, and STOP until they click.\n' +
    '- ASKING vs ORDERING. Set `intent` on find_products:\n' +
    '    "What paper stocks do we offer for postcards?" / "what sizes" / "does it come in matte" ' +
    '-> intent "info". They asked a QUESTION. Picking a product must ANSWER it — showing a price ' +
    'calculator answers something nobody asked.\n' +
    '    "I need 500 postcards" / "quote this" / "order 4x6 postcards" -> intent "price". Picking opens ' +
    'the calculator.\n' +
    '    When unsure, use "info". Answering a question is harmless; pricing a job they did not ask for ' +
    'wastes their time and clutters the chat.\n' +
    '- WORK OUT WHAT IT IS BEFORE YOU SEARCH. Clients describe the job, not our catalogue. Say to ' +
    'yourself, in one line, what this physically is, then search for THAT:\n' +
    '    "promo cards", "handouts", "flyers on card", "mailers" -> postcards\n' +
    '    "hang tags", "swing tickets" -> hang tags\n' +
    '    "table talkers", "tent cards" -> table tent cards\n' +
    '    "shelf talkers", "danglers" -> in-store signage\n' +
    '  Use the size to settle it: 4x4 or 4x6 on card is a postcard, 3.5x2 is a business card, 12x18 is a ' +
    'poster. Attachments named "Promo Card Mock-Ups" plus a die-cutting request describe a die cut ' +
    'postcard, not a business card.\n' +
    '- SEARCH ONCE. Identify the client FIRST if you are going to, then run one search with everything ' +
    'you know. Searching, then looking up the client, then searching again leaves two different lists on ' +
    'screen and makes the answer look confused.\n' +
    '- If a phrase names a KIND of product ("die cut", "folded", "magnetic", "laminated"), put it in ' +
    '`specs` — products actually NAMED for it are ranked above products that merely offer it as an ' +
    'option, which is almost always what the person meant.\n' +
    '- SEARCHING WITH SPECS: when someone asks for a product AND states specs in the same breath — ' +
    '"specialty posters with 14pt c1s, 12x18" — put the product type in `query` and EVERY spec in ' +
    '`specs`: query "poster", specs ["14pt c1s","12x18"]. Searching the name alone returns every poster ' +
    'we sell and the right one gets buried. Shorthand like c1s, 4/4 or spot uv is translated for you.\n' +
    '- PRICE ONCE. Read the whole request, gather every spec in it, then call calculate_price a single ' +
    'time. Pricing on defaults and then re-pricing with a finish that was in the original message leaves ' +
    'two cards with two totals. If you realise something was missed, the second card REPLACES the first — ' +
    'so say the corrected total only, never both.\n' +
    '- SPECS BELONG TO THEIR OWN ITEM. In "booklets 5x7, 500 copies, and hang tags 5x5, 250", the 5x7 and ' +
    'the 500 belong to the booklets ONLY. When you price the hang tags, pass 5x5 and 250 — never let the ' +
    'previous item\'s size or quantity carry over, and never leave a stated size out because the last ' +
    'card already had one.\n' +
    '- CARRY THE WHOLE CONVERSATION into the price. Before calling calculate_price, re-read everything the ' +
    'person (or the client email they pasted) has said and pass ALL of it: width and height, quantity, the ' +
    'version list with names and quantities, paper, finish, foil, turnaround. Only fields never mentioned ' +
    'take defaults. Pricing on defaults when specs were given is a wrong quote, not a starting point.\n' +
    '- AS SOON AS the product is known, price it with calculate_price — do not describe its options in ' +
    'prose or a table first. The card IS the calculator: it shows every field, tags what they asked for as ' +
    '"specified" and everything else as "default", and can be edited. Pass everything they already said ' +
    '(size, quantity, material, features) so those come through as specified rather than defaults.\n' +
    '- When you need the person to CHOOSE an option (size, material, finish, shape), call ask_option ' +
    'instead of listing choices in text. It shows the real options as cards with their images, which is ' +
    'far easier to judge — especially for materials and sizes. Then say one short line and stop.\n' +
    '- When a tool has already drawn something on screen — product matches, option cards, a price card, a ' +
    'job card — do NOT restate its contents in text. That includes naming them inside a question: ' +
    '"Which poster is this? (Single Premium, Laminated, Bulk Large...)" is still listing them. Ask the ' +
    'question WITHOUT the names — the cards are right there. One short line, then stop.\n' +
    '- NEVER show a bare product id. Always write the product NAME with the id in brackets, like ' +
    '"Postcards (#299)". A list of raw numbers is useless to the team.\n' +
    '- When the user names a product type rather than a specific product, call find_products. If it returns ' +
    'several, the user gets clickable buttons automatically — reply with ONE short line ("Which one?") and ' +
    'nothing more. Never re-list what the buttons already show.\n' +
    '- DIE LINES / TEMPLATES: use get_dieline, never raw SQL. A product can have several, one per size/fold ' +
    'combination, so if more than one comes back ASK WHICH SIZE rather than guessing or listing all of them. ' +
    'Give the file as a markdown link. Never invent or guess a Drive link.\n' +
    '- TURNAROUND: any question about lead time, when a job will be ready, or whether a date is achievable ' +
    'goes through calculate_turnaround. It draws a visual timeline for the user, so afterwards give only the ' +
    'ready date and the deadline verdict — never re-list the days. Remember turnaround is PRODUCTION time and ' +
    'excludes shipping; if a delivery city is mentioned, say transit is on top.\n' +
    '- No headers unless the answer genuinely has two or more distinct sections.\n' +
    '- You CAN show images. Product photos come from get_product_image; output them as markdown ' +
    '![name](url) and they render inline in the chat. Never claim you cannot display images, and never ' +
    'invent an image URL — only use one a tool returned.\n\n' +

    'WHEN A TOOL FAILS:\n' +
    '- The database is ALWAYS connected. A failed query means YOUR SQL was wrong, not that the system is ' +
    'down. NEVER tell the user the database is offline, unavailable, or that tables are missing — that is ' +
    'false and it sends them chasing a problem that does not exist.\n' +
    '- Read the error, fix the query, and try again. For product options use get_product_options, which ' +
    'takes only a product id.\n' +
    '- If you still cannot get it after two attempts, say exactly what you tried and what error came back.\n\n' +

    'NEVER invent a price, policy, turnaround, or product option. If you do not know, say so in one line. ' +
    'A wrong number quoted to a client costs real money.\n' +
    'If team knowledge and the database disagree, show both and say which is which.\n\n' +

    'You are talking to AxiomPrint STAFF, not a customer. Do not draft client-facing emails unless asked. ' +
    'For a long inbound client email that needs a full worked-up quote and a drafted reply, Order Assist is ' +
    'the better tool and you may say so - but for pricing and placing an order you are fully capable, so ' +
    'never refuse or redirect those.\n\n' +

    // The team's own instructions come FIRST, before the reference material.
    // Buried under tens of KB of catalogue they read as background; up here they
    // read as instructions, which is what they are.
    (brain.training
      ? '=== HOW THIS TEAM WANTS YOU TO WORK ===\n' +
        'Written by the AxiomPrint team. This describes your role, their rules, how they want you to ' +
        'work through a job, and what they know that you do not. Follow it. Where it is more specific ' +
        'than a general instruction above, the specific one wins. The only things it cannot override are ' +
        'the tool mechanics — you still price with the calculator, never invent numbers, and never send ' +
        'anything on someone\'s behalf.\n' + brain.training + '\n\n'
      : '') +

    // Installation & local delivery. Rates are deliberately NOT written here —
    // they are admin-edited and live only in the quote tools, so the prompt can
    // never go stale against the calculator.
    '\n\n=== REPORTS ===\n' +
    'For client follow-up lists, top clients, unpaid invoices or product sales, call run_report — it draws a ' +
    'full interactive table beside the chat. Use query_database only for questions none of the reports answers.\n' +
    '\n=== INSTALLATION & LOCAL DELIVERY QUOTES ===\n' +
    'AxiomPrint installs graphics on site (decals, window film, wall graphics, panels, letters, banners) and ' +
    'delivers locally with its own driver. Whenever someone asks about installing, mounting or delivering — ' +
    'price, cost, quote, "how much", what it takes — call quote_installation (or quote_delivery) STRAIGHT AWAY ' +
    'with whatever is known, even if that is nothing but the word "install". The team always gets the ' +
    'calculator on screen and fills in the rest there. Never do installation arithmetic yourself and never quote ' +
    'a rate from memory.\n' +
    'Answer rules:\n' +
    '- Keep the words short. The calculator opens beside the chat and the chat already shows "Estimated price is $…", ' +
    'so never repeat the total, the breakdown or the route.\n' +
    '- Say every assumption the tool reports, on one line. A quote built on silent assumptions is worse than none.\n' +
    '- Ask at most ONE question, only when the answer moves the price by more than ~15%. In order of impact: ' +
    'address, piece sizes, height/access, day and time. Never ask for something already given or on the job record.\n' +
    '- Distance and drive time are measured from the Glendale shop (4544 San Fernando Rd) from the address, ' +
    'so pass the address and never ask for miles.\n' +
    '- Never invent a distance, a material level or a rate. Unknown material → the tool assumes Level 1; say so.\n' +
    '- Hand off to a person, do not guess, when: above ' + installPricing.install.max_height_ft + ' ft; installs past ~' +
    installPricing.install.handoff_miles + ' miles (mileage is billed but crew drive time is not — it needs a travel-day / ' +
    'per-diem rate); any crane work (the crane price is a placeholder); permits or union sites; a client disputing ' +
    'a quoted price; anything where a wrong number goes on a signed contract.\n' +
    '- There is no per-diem, lodging or permit line in the model — say so if the job needs one.\n' +
    '- Client ships on their own UPS/FedEx account: that is a flat handling fee instead of shipping, do not quote freight.\n' +
    '- Delivery zones by one-way miles: ' + installPricing.zones.map((z, i, a) =>
      z.label + ' ' + (i === 0 ? 'under ' + z.max_mi : (z.max_mi == null ? a[i - 1].max_mi + '+' : a[i - 1].max_mi + '-' + z.max_mi)) +
      ' (' + z.guidance + ')').join(' · ') + '.\n' +
    '- Write every price as $1,678.54 \u2014 a comma for thousands and two decimals (never $1678.54).\n' +

    // Knowledge the team wrote comes BEFORE the data dictionary. The dictionary
    // is reference material for building SQL; these are the answers themselves,
    // and burying them under 2,000 tokens of table definitions is why they read
    // as ignored.
    (brain.docs
      ? '\n\n=== DOMAIN KNOWLEDGE — WRITTEN BY THE AXIOMPRINT TEAM ===\n' +
        'This is how AxiomPrint actually works. It is more authoritative than anything you know from ' +
        'general printing knowledge, and more current than the catalogue. When it answers the question, ' +
        'USE IT — quote its numbers and its wording rather than reasoning from first principles. If it ' +
        'contradicts your own assumption, it is right and you are wrong.\n' + brain.docs
      : '') +
    (brain.guides
      ? '\n\n=== PRODUCT GUIDE (for what is being discussed) ===\n' +
        'Written by the team about this product family. Prefer it over the raw catalogue.\n' + brain.guides
      : '') +
    (brain.meetings ? '\n\n=== TEAM MEETING NOTES (what the team decided) ===\n' + brain.meetings : '') +

    (tableList ? '\n\nDATABASE TABLES: ' + tableList + '\n\n' : '') +
    'DATA DICTIONARY:\n' + DATA_DICTIONARY +
    (sessionClientId
      ? '\n\n=== THIS CONVERSATION IS FOR ===\n' +
        (sessionClientName || 'customer #' + sessionClientId) + ' (client id ' + sessionClientId + ').\n' +
        'Do NOT ask who the job is for — you already know. Pass client_id ' + sessionClientId +
        ' to calculate_price so their account discount applies, and use their history when it helps.'
      : '') +
    (brain.approved ? '\n\n=== APPROVED / REJECTED ANSWERS ===\n' + brain.approved : '');

  try {
    let currentMessages = [...messages];
    let queryCount = 0;

    while (queryCount < 8) {
      // Safe point: nothing is in flight here, so stopping leaves nothing
      // half-done.
      if (aborted) break;
      send({ type: 'phase', phase: 'thinking_start' });
      const stream = await anthropic.messages.stream({
        model: MODEL_MAIN,
        max_tokens: 3000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: tools,
        messages: currentMessages
      });

      let assistantBlocks = [];
      let textBuffer = '';
      stream.on('text', (t) => {
        if (String(t || '').trim()) saidAnything = true;
        textBuffer += t;
        send({ type: 'text', text: t });
      });

      const finalMsg = await stream.finalMessage();
      assistantBlocks = finalMsg.content;
      // The model can request SEVERAL tools in one message. Every tool_use block
      // needs its own tool_result in the next message or the API rejects the
      // whole conversation, so run them all.
      const toolUses = assistantBlocks.filter(b => b.type === 'tool_use');

      if (!toolUses.length) {
        send({ type: 'done', text: textBuffer });
        break;
      }

      const runOneTool = async (toolUse) => {
      // ---- run the tool ----
      let toolResult = '';
      if (toolUse.name === 'query_database') {
        send({ type: 'query', description: toolUse.input.description || 'Checking the database' });
        try {
          const sqlRaw = String(toolUse.input.sql || '').trim().replace(/;+\s*$/, '');
          if (!/^select\b/i.test(sqlRaw) && !/^show\b/i.test(sqlRaw)) {
            toolResult = 'Only SELECT queries are allowed. Rewrite as a SELECT and try again.';
          } else {
            const rows = await runQueryRaw(sqlRaw);
            toolResult = rows.length
              ? JSON.stringify(rows.slice(0, 80))
              : 'No rows. The connection is fine — the filter matched nothing. Loosen it and try again.';
          }
        } catch (e) {
          // Never let the model conclude the database is down: it is up, this query was wrong.
          toolResult = 'That query failed: ' + e.message +
            '\nThe database IS connected. Fix the SQL and retry (check table/column names, drop any trailing semicolon).';
        }
      } else if (toolUse.name === 'get_product_options') {
        send({ type: 'query', description: 'Loading product options' });
        try {
          const pid = parseInt(toolUse.input.product_id);
          const want = String(toolUse.input.field || '').trim().toLowerCase();
          const prod = await runQueryRaw('SELECT id, title, public_title, image, url, formula FROM product WHERE id = ' + pid);
          if (!prod.length) {
            toolResult = 'No product with id ' + pid + '. Search by name first: SELECT id, title FROM product WHERE title LIKE \'%keyword%\'';
          } else {
            const vars = await runQueryRaw(
              'SELECT id, title, type, hasVersions, configs FROM product_variables WHERE product_id = ' + pid + ' ORDER BY `order`');
            const ids = vars.map(v => v.id);
            let items = [];
            if (ids.length) {
              items = await runQueryRaw(
                'SELECT id, variable_id, title, value, base, isHidden, `default`, custom ' +
                'FROM product_variable_item WHERE variable_id IN (' + ids.join(',') + ') ORDER BY variable_id, `order`');
            }
            // "Related to" rules: which fields / options only show with another selection.
            let rel = { field: {}, item: {}, unlocks: {}, list: {} };
            try { rel = await relatedRules([pid]); } catch (e) {}
            const shownVars = vars
              .filter(v => !want || String(v.title).toLowerCase().replace(/_/g, ' ').includes(want.replace(/_/g, ' ')));
            const shaped = shownVars
              .map(v => {
                let cfg = {};
                try { if (v.configs) cfg = JSON.parse(v.configs); } catch (e) {}
                // Show what the website shows; hidden options stay available to
                // the AM but aren't offered as if they were normal choices.
                const own = items.filter(i => i.variable_id === v.id && Number(i.isHidden) !== 1);
                return {
                  field: String(v.title).replace(/_/g, ' '),
                  type: v.type,
                  only_when: rel.field[Number(v.id)] || undefined,
                  // A field the price formula never mentions costs nothing on the
                  // website, whatever values its options carry.
                  not_in_price_formula: (prod[0].formula && !new RegExp('(^|[^A-Za-z0-9_])' +
                    String(v.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_]|$)').test(String(prod[0].formula))) || undefined,
                  supports_versions: v.hasVersions == 1 || undefined,
                  size_config: (v.type === 'size_new' || v.type === 'size_3D') ? cfg : undefined,
                  options: own.map(i => ({
                    name: i.title,
                    is_default: i.default == 1 || undefined,
                    hidden: i.isHidden == 1 || undefined,
                    custom: i.custom == 1 || undefined,
                    value: i.value, base: i.base,
                    only_when: rel.item[Number(i.id)] || undefined,
                    unlocks: rel.unlocks[Number(i.id)] || undefined
                  }))
                };
              });
            await sendProductCards([prod[0].id]);
            toolResult = JSON.stringify({
              product: {
                id: prod[0].id, title: prod[0].title, public_title: prod[0].public_title,
                image_url: prod[0].image || null,
                page_url: prod[0].url ? ('https://axiomprint.com/product/' + prod[0].url) : null
              },
              note: 'hidden:true options exist in the database but are NOT selectable on the site - say so if you list them.',
              // Every condition that touches the fields shown, in plain words.
              related_to_rules: (function () {
                const names = shownVars.map(v => String(v.title).replace(/_/g, ' '));
                const all = rel.list[pid] || [];
                const mine = want ? all.filter(t => names.some(n => t.indexOf(n) > -1)) : all;
                return mine.length ? mine : undefined;
              })(),
              formula_note: shaped.some(f => f.not_in_price_formula)
                ? 'Fields marked not_in_price_formula are NOT used by this product\'s price formula, so choosing them adds ' +
                  'nothing to the website / calculator price even though their options show value/base numbers. If asked ' +
                  'what one costs, say that plainly (the team may want to fix the product setup) — do not quote the value/base as a charge.'
                : undefined,
              related_to_note: (rel.list[pid] || []).length
                ? 'RELATED-TO RULES apply (only_when / related_to_rules). Whenever you answer about a field or option ' +
                  'that has one, STATE THE CONDITION in the same answer — e.g. "Yes, we offer scoring on Book Dust Jackets, but ' +
                  'only on 100# Gloss Cover — not on 100# Gloss Text." Leaving the condition out is a wrong answer.'
                : undefined,
              next: 'DO NOT print these options as a table or a list — that is what the calculator is for. ' +
                'Call calculate_price NOW with whatever the person already specified (size, material, ' +
                'quantity, features). The card that appears shows every field with its value, marks what ' +
                'they chose as "specified" and the rest as "default", and is editable. Then say ONE short ' +
                'line. Only use ask_option if a choice genuinely changes the price and they have not said.',
              fields: shaped
            });
          }
        } catch (e) {
          toolResult = 'Lookup failed: ' + e.message + '. The database IS connected - retry or use query_database.';
        }
      } else if (toolUse.name === 'get_product_image') {
        send({ type: 'query', description: 'Loading product photo' });
        try {
          const pid = parseInt(toolUse.input.product_id);
          const prod = await runQueryRaw('SELECT id, title, image, url FROM product WHERE id = ' + pid);
          if (!prod.length) {
            toolResult = 'No product with id ' + pid + '.';
          } else {
            const p = prod[0];
            // Gallery rows often have no stored path, so only offer ones we can
            // actually build a working URL for - a broken image is worse than none.
            let gallery = [];
            try {
              const g = await runQueryRaw(
                'SELECT image_name, image_path, alt, `order` FROM productgallery ' +
                'WHERE product_id = ' + pid + ' ORDER BY `order` LIMIT 8');
              gallery = (g || [])
                .filter(r => r.image_path && /^https?:\/\//i.test(String(r.image_path)))
                .map(r => ({ name: r.alt || r.image_name, url: r.image_path }));
            } catch (ge) { gallery = []; }

            if (!p.image && !gallery.length) {
              toolResult = 'No image on file for "' + p.title + '" (product.image is empty and no gallery image has a usable URL). Say so plainly - do not guess a URL.';
            } else {
              toolResult = JSON.stringify({
                product: p.title,
                main_image: p.image || null,
                gallery: gallery,
                page_url: p.url ? ('https://axiomprint.com/product/' + p.url) : null,
                how_to_show: 'Display the main image with markdown: ![' + p.title + '](' + (p.image || '') + ') — one short line of text is enough alongside it.'
              });
            }
          }
        } catch (e) {
          toolResult = 'Image lookup failed: ' + e.message + '. The database IS connected - retry.';
        }
      } else if (toolUse.name === 'find_products') {
        const q = String(toolUse.input.query || '').trim();
        send({ type: 'query', description: 'Searching products for "' + q + '"' });
        try {
          // Match on each meaningful word, not the whole phrase - "business cards"
          // should still find "Classic Business Cards".
          // Name terms and SPEC terms are scored differently: a spec is a stated
          // requirement, a name word is just a category. Searching "specialty
          // posters" alone returns every poster we sell.
          const nameTerms = searchTerms(q);
          // One group per stated spec. "14pt c1s" and "scoring" are two separate
          // requirements, both of which must hold.
          // Size and quantity are reported on their own ("offers 18x24", "handles
          // 500"), so a spec that only restates one of them must not be counted
          // again — that is how a request became "0 of the 1 specs" while the
          // same card said it offered the size and handled the quantity.
          const qWant = parseInt(toolUse.input.quantity) || 0;
          // The question as the person typed it. Material words the model did not
          // pass ("synthetic paper ... menus" searched as just "menus") are added
          // as specs, so the product that actually has that material ranks first.
          const askedText = (function () {
            const m = [].concat(req.body.messages || []).reverse().find(x => x && x.role === 'user' &&
              !(Array.isArray(x.content) && x.content[0] && x.content[0].type === 'tool_result'));
            if (!m) return '';
            return typeof m.content === 'string' ? m.content
              : (Array.isArray(m.content) ? m.content.filter(c => c && c.type === 'text').map(c => c.text).join(' ') : '');
          })();
          const givenSpecs = [].concat(toolUse.input.specs || []).map(String);
          const givenWords = givenSpecs.join(' ').toLowerCase().split(/\s+/).concat(String(q).toLowerCase().split(/\s+/));
          specWordsFrom(askedText, givenWords).forEach(w => givenSpecs.push(w));
          toolUse.input.specs = givenSpecs;
          const specGroups = (toolUse.input.specs || [])
            .filter(sp => {
              const t = String(sp || '').trim();
              if (!t) return false;
              if (parseWH(t)) return false;                       // a size
              if (/^\d[\d,]*$/.test(t.replace(/\s/g, ''))) return false;  // a bare quantity
              if (qWant && Number(t.replace(/[^\d]/g, '')) === qWant) return false;
              return true;
            })
            .map(sp => {
              // A material asked for by what it does matches any of its forms.
              const words = String(sp).toLowerCase().split(/\s+/);
              const alt = words.map(w => MATERIAL_ALTS[w]).find(Boolean);
              if (alt) { const g = alt.slice(); g.alt = true; g.label = String(sp).trim(); return g; }
              return searchTerms(sp);
            })
            .filter(g => g.length);
          const specTerms = [];
          specGroups.forEach(g => g.forEach(t => { if (specTerms.indexOf(t) === -1) specTerms.push(t); }));
          const terms = nameTerms.concat(specTerms.filter(t => nameTerms.indexOf(t) === -1));

          // Already searched for something else this turn? Stop. Finish that item
          // before starting the next, or the person gets two lists and can only
          // act on one.
          if (searchedThisTurn && searchedThisTurn !== q) {
            toolResult = JSON.stringify({
              refused: 'You already searched for "' + searchedThisTurn + '" in this answer.',
              why: 'The chat handles ONE product at a time — there is no way to pick two.',
              do: 'Finish "' + searchedThisTurn + '" first: let them choose it, price it, and press ' +
                  'Save. Only then search for "' + q + '". Say something like "Let\'s start with the ' +
                  searchedThisTurn + ' — I\'ll do the ' + q + ' next." and stop.'
            });
          } else {
          searchedThisTurn = q;
          // TWO queries, not a correlated subquery per product per term. The item
          // table is ~30k rows; running EXISTS against it for every candidate was
          // what made search slow.
          //   1. products matching on name / SEO fields
          //   2. ONE grouped pass over option items, giving per-term feature hits
          // ANY term may match, not all of them. Requiring all is why "hemp paper
          // cards" found nothing: the product is "Hemp Business Cards" and the
          // stock is "Clean White Hemp" — no single field holds all three words.
          // Ranking below rewards products that match MORE terms.
          // Candidacy is decided by the PRODUCT TYPE alone. Specs refine the order
          // of the results; they must never drag in a different kind of product.
          // Business cards also offer 14PT C1S — that does not make them posters.
          const nameWhere = nameTerms.map(w => {
            const like = mysql.escape('%' + likeStem(w) + '%');
            return '(p.title LIKE ' + like +
              ' OR p.public_title LIKE ' + like +
              ' OR p.meta_title LIKE ' + like +
              ' OR p.meta_keywords LIKE ' + like +
              ' OR p.added_keywords LIKE ' + like + ')';
          }).join(' OR ');

          // Match the stem, and look at the FIELD name too — "Scoring" is a field
          // whose options are "Scored in the middle" / "Custom Single Score".
          // Per-term flags for general scoring...
          const featSelect = terms.map((w, i) => {
            const like = mysql.escape('%' + likeStem(w) + '%');
            return '(MAX(pvi.title LIKE ' + like + ') OR MAX(pv.title LIKE ' + like + ')) AS m' + i;
          }).join(', ');
          // ...plus one flag per stated SPEC GROUP, negation-guarded.
          const groupSelect = specGroups.map((g, gi) => {
            const parts = [];
            g.forEach(w => {
              parts.push('MAX(' + termCond('pvi.title', w) + ')');
              parts.push('MAX(' + termCond('pv.title', w) + ')');
            });
            return '(' + parts.join(' OR ') + ') AS g' + gi;
          }).join(', ');
          const selectAll = [featSelect, groupSelect].filter(Boolean).join(', ');
          const featWhere = terms.map(w => {
            const like = mysql.escape('%' + likeStem(w) + '%');
            return '(pvi.title LIKE ' + like + ' OR pv.title LIKE ' + like + ')';
          }).join(' OR ');

          const [nameRows, featRows] = await Promise.all([
            runQueryRaw(
              'SELECT p.id, p.title, p.public_title, p.image, p.url, p.type, p.meta_keywords, ' +
              'p.added_keywords, p.meta_title, p.available_for_websites, ' +
              '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_productid = p.id AND e.created >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)) AS order_count, ' +
              '(SELECT COUNT(*) FROM estimate e2 WHERE e2.estimate_productid = p.id) AS lifetime_orders ' +
              'FROM product p WHERE ' + nameWhere + ' LIMIT 100'),
            runQueryRaw(
              'SELECT pv.product_id, ' + selectAll + ' ' +
              'FROM product_variables pv JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
              'WHERE pvi.isHidden = 0 AND (' + featWhere + ') GROUP BY pv.product_id')
          ]);

          const featMap = {};      // total terms satisfied by an option
          const specMap = {};      // how many of the STATED SPECS an option satisfies
          (featRows || []).forEach(f => {
            let hits = 0;
            for (let i = 0; i < terms.length; i++) if (Number(f['m' + i])) hits++;
            featMap[Number(f.product_id)] = hits;
            // How many stated specs this product genuinely satisfies.
            let g = 0;
            for (let i = 0; i < specGroups.length; i++) if (Number(f['g' + i])) g++;
            specMap[Number(f.product_id)] = g;
          });

          // Products that matched only on their OPTIONS (e.g. a poster that offers
          // foil, where "foil" is nowhere in its text) — pull those in too, but
          // only when every term is satisfied somewhere.
          let rows = nameRows || [];
          const haveIds = new Set(rows.map(r => Number(r.id)));
          // Products matched only through their OPTIONS. Previously this required
          // every term; now a strong partial counts, which is what surfaces a
          // product whose hemp stock is the whole point.
          // Pull in option-only matches ONLY when the person named no product type
          // ("which products offer hemp paper"). With a type stated, a product
          // that merely shares an option is the wrong answer.
          const needed = Math.max(1, Math.ceil(terms.length / 2));
          const extraIds = nameTerms.length
            ? []
            : Object.keys(featMap).map(Number)
                .filter(id => !haveIds.has(id) && featMap[id] >= needed)
                .sort((a, b) => featMap[b] - featMap[a])
                .slice(0, 40);
          if (extraIds.length) {
            const more = await runQueryRaw(
              'SELECT p.id, p.title, p.public_title, p.image, p.url, p.type, p.meta_keywords, ' +
              'p.added_keywords, p.meta_title, p.available_for_websites, ' +
              '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_productid = p.id AND e.created >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)) AS order_count, ' +
              '(SELECT COUNT(*) FROM estimate e2 WHERE e2.estimate_productid = p.id) AS lifetime_orders ' +
              'FROM product p WHERE p.id IN (' + extraIds.join(',') + ')');
            rows = rows.concat(more || []);
          }
          rows.forEach(r => {
            r.feature_hits = featMap[Number(r.id)] || 0;
            r.spec_hits = specMap[Number(r.id)] || 0;
          });

          // A term can match NOTHING while the search still returns results from
          // its other words — that is how "scoring" and "5mil" went unnoticed.
          // Record any word that hit nothing anywhere, not just empty searches.
          try {
            const anyText = (rows || []).map(r =>
              [r.title, r.public_title, r.meta_title, r.meta_keywords, r.added_keywords]
                .filter(Boolean).join(' ').toLowerCase()).join(' ');
            terms.forEach((w, i) => {
              const stem = likeStem(w);
              const inText = anyText.indexOf(stem) > -1;
              const inOptions = (featRows || []).some(f => Number(f['m' + i]));
              if (!inText && !inOptions) noteJargonMiss(w, q);
            });
          } catch (me) {}

          // Drop products that aren't live on the site, and obvious scratch/test
          // records — otherwise "test formula2" outranks the real product.
          const JUNK = /\b(test|testing|dont use|don't use|do not use|deprecated|old|copy of|duplicate|backup)\b/i;
          const live = rows.filter(r => {
            let sites = r.available_for_websites;
            try { if (typeof sites === 'string') sites = JSON.parse(sites); } catch (e) {}
            if (Array.isArray(sites) && sites.length &&
                !sites.some(x => String(x).toLowerCase() === 'axiom_print')) return false;
            if (JUNK.test(String(r.title || ''))) return false;
            return true;
          });
          const usable = live.length ? live : rows;

          // How many times has THIS client ordered each candidate? A product they
          // already buy is nearly always the one they mean, so it should outrank a
          // product that merely matches on words.
          // Can this product even do the run they asked for? A quantity outside a
          // product's tiers is not a weak match, it is a wrong one.
          const wantQty = parseInt(toolUse.input.quantity) || 0;
          const qtyRange = {};

          // Does the product actually offer the SIZE they asked for? When two
          // products have near-identical names — Bulk Large vs Bulk Small Poster
          // Printing — the size is the only thing that separates them, and one
          // of them simply cannot do the job.
          // Sizes in FEET have to become inches before they mean anything — the
          // catalogue stores everything in inches, so "5x9ft" compared against a
          // 33x81 preset is nonsense. Banners and signage are the usual culprits.
          const rawSize = String(toolUse.input.size || '') ||
            String((toolUse.input.specs || []).find(x => parseWH(String(x))) || '');
          let wantSize = parseWH(rawSize);
          if (wantSize && sizeInFeet(rawSize)) {
            wantSize = { w: wantSize.w * 12, h: wantSize.h * 12, fromFeet: true };
          }
          const sizeFit = {};
          const sizeLimits = {};   // what a product can actually take, for the reason line
          if (wantSize && usable.length) {
            try {
              const ids3 = usable.map(r => Number(r.id)).filter(Boolean);
              if (ids3.length) {
                // pvi.custom is the authoritative flag: an option ticked "Custom"
                // is what lets a product take typed dimensions. The configs then
                // say between what limits.
                const sr = await runQueryRaw(
                  'SELECT pv.product_id AS pid, pv.type, pv.configs, ' +
                  'MAX(pvi.custom = 1) AS has_custom, ' +
                  'GROUP_CONCAT(pvi.title SEPARATOR \'|\') AS titles ' +
                  'FROM product_variables pv JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
                  'WHERE pv.product_id IN (' + ids3.join(',') + ') ' +
                  "AND (pv.type IN ('size_new','size_3D') OR pv.title LIKE '%Size%') " +
                  'GROUP BY pv.product_id, pv.type, pv.configs');
                (sr || []).forEach(row => {
                  const pid2 = Number(row.pid);
                  if (sizeFit[pid2] === 1) return;   // already an exact match
                  const list = String(row.titles || '').split('|');
                  // Exact preset, either orientation.
                  const exact = list.some(t => {
                    const p3 = parseWH(t);
                    return p3 && ((p3.w === wantSize.w && p3.h === wantSize.h) ||
                                  (p3.w === wantSize.h && p3.h === wantSize.w));
                  });
                  if (exact) { sizeFit[pid2] = 1; return; }
                  // Otherwise: does a free W x H field cover it?
                  let cfg = {};
                  try { cfg = typeof row.configs === 'string' ? JSON.parse(row.configs) : (row.configs || {}); }
                  catch (e) {}
                  const maxW = Number(cfg.maxWidth) || 0, maxH = Number(cfg.maxHeight) || 0;
                  const minW = Number(cfg.minWidth) || 0, minH = Number(cfg.minHeight) || 0;

                  // Custom sizing needs BOTH: an option ticked "Custom", and a
                  // configured range. Vinyl Banner has "Custom Size" with
                  // 12x12 to 120x480; Retractable Roll Up has neither and comes
                  // in six fixed sizes however the request is phrased.
                  const hasCustom = Number(row.has_custom) === 1 ||
                                    list.some(t => /custom/i.test(t));
                  const ranged = maxW > 0 && maxH > 0;
                  if (!hasCustom || !ranged) {
                    if (sizeFit[pid2] == null) sizeFit[pid2] = -1;   // fixed list, no exact match
                    return;
                  }
                  // wxh means the sheet can be turned, so try both orientations.
                  const flip = cfg.wxh !== false && cfg.wxh !== 0 && cfg.wxh !== '0';
                  const fits = (w, h) => w <= maxW && h <= maxH &&
                                         (!minW || w >= minW) && (!minH || h >= minH);
                  const within = fits(wantSize.w, wantSize.h) ||
                                 (flip && fits(wantSize.h, wantSize.w));
                  if (!within) {
                    // Outside the range is a real no — and worth saying why.
                    sizeLimits[pid2] = { minW: minW, minH: minH, maxW: maxW, maxH: maxH };
                    if (sizeFit[pid2] == null) sizeFit[pid2] = -1;
                    return;
                  }
                  sizeLimits[pid2] = { minW: minW, minH: minH, maxW: maxW, maxH: maxH };
                  sizeFit[pid2] = 0.8;
                });
              }
            } catch (se) {}
          }
          if (wantQty && usable.length) {
            try {
              const ids2 = usable.map(r => Number(r.id)).filter(Boolean);
              if (ids2.length) {
                const qr = await runQueryRaw(
                  'SELECT pv.product_id AS pid, MIN(CAST(pvi.value AS DECIMAL(12,2))) AS lo, ' +
                  'MAX(CAST(pvi.value AS DECIMAL(12,2))) AS hi ' +
                  'FROM product_variables pv JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
                  "WHERE pv.product_id IN (" + ids2.join(',') + ") AND pv.title LIKE '%Quantity%' " +
                  'AND pvi.isHidden = 0 GROUP BY pv.product_id');
                (qr || []).forEach(x => {
                  qtyRange[Number(x.pid)] = { lo: Number(x.lo) || 0, hi: Number(x.hi) || 0 };
                });
              }
            } catch (qe) {}
          }

          if (sessionClientId && usable.length) {
            try {
              const ids = usable.map(r => Number(r.id)).filter(Boolean);
              if (ids.length) {
                const hist = await runQueryRaw(
                  'SELECT estimate_productid AS pid, COUNT(*) AS n FROM estimate ' +
                  'WHERE estimate_clientid = ' + parseInt(sessionClientId) +
                  ' AND estimate_productid IN (' + ids.join(',') + ') GROUP BY estimate_productid');
                const byProd = {};
                (hist || []).forEach(h => { byProd[Number(h.pid)] = Number(h.n) || 0; });
                usable.forEach(r => { r.client_orders = byProd[Number(r.id)] || 0; });
              }
            } catch (ce) { /* history is a bonus, never a blocker */ }
          }

          // ---- second pass ----
          // Nothing usable from the name search. Rather than giving up, look the
          // request up by its SPECS across every product's options. Slower, so it
          // only runs when the fast path found nothing — and the person is told.
          let deepHandled = false;
          if (!usable.length && terms.length) {
            send({ type: 'query', description: 'No direct match — searching by specs' });
            try {
              // Groups: each stated spec, or each term when none were stated.
              const groups = specGroups.length ? specGroups : terms.map(t => [t]);
              const deepWhere = groups.map(g => specGroupCond(['pvi.title', 'pv.title'], g)).join(' OR ');
              const deepSelect = groups.map((g, gi) => {
                const parts = [];
                g.forEach(w => {
                  parts.push('MAX(' + termCond('pvi.title', w) + ')');
                  parts.push('MAX(' + termCond('pv.title', w) + ')');
                });
                return '(' + parts.join(' OR ') + ') AS g' + gi;
              }).join(', ');
              const deepRows = await runQueryRaw(
                'SELECT pv.product_id, ' + deepSelect + ' ' +
                'FROM product_variables pv JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
                'WHERE pvi.isHidden = 0 AND (' + deepWhere + ') GROUP BY pv.product_id');
              // EVERY requirement must hold. "14pt c1s AND scoring" means both —
              // a product with only one of them is not an answer, however close.
              const scoredDeep = (deepRows || []).map(f => {
                let hits = 0;
                for (let i = 0; i < groups.length; i++) if (Number(f['g' + i])) hits++;
                return { id: Number(f.product_id), hits: hits };
              }).filter(x => x.hits === groups.length)
                .slice(0, 25);

              if (scoredDeep.length) {
                const ids = scoredDeep.map(x => x.id);
                const deepProducts = await runQueryRaw(
                  'SELECT p.id, p.title, p.public_title, p.image, p.url, p.meta_keywords, ' +
                  'p.available_for_websites, ' +
                  '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_productid = p.id AND e.created >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)) AS order_count, ' +
              '(SELECT COUNT(*) FROM estimate e2 WHERE e2.estimate_productid = p.id) AS lifetime_orders ' +
                  'FROM product p WHERE p.id IN (' + ids.join(',') + ')');
                const hitById = {};
                scoredDeep.forEach(x => { hitById[x.id] = x.hits; });
                const JUNK2 = /\b(test|testing|dont use|don't use|do not use|deprecated|not used)\b/i;
                const deepUsable = (deepProducts || []).filter(r => {
                  let sites = r.available_for_websites;
                  try { if (typeof sites === 'string') sites = JSON.parse(sites); } catch (e) {}
                  if (Array.isArray(sites) && sites.length &&
                      !sites.some(x => String(x).toLowerCase() === 'axiom_print')) return false;
                  return !JUNK2.test(String(r.title || ''));
                });
                const maxD = Math.max(1, ...deepUsable.map(r => Number(r.order_count) || 0));
                const groupCount = specGroups.length || terms.length;
                const picks = deepUsable.map(r => {
                  const hits = hitById[Number(r.id)] || 0;
                  const cover = hits / groupCount;
                  const pop = (Number(r.order_count) || 0) > 0
                    ? Math.log10((Number(r.order_count) || 0) + 1) / Math.log10(maxD + 1) : 0;
                  // A product whose NAME also carries one of the words is the
                  // strongest signal — "Scored Header Cards" for "scoring".
                  const nameHit = terms.some(w =>
                    String(r.title || '').toLowerCase().indexOf(likeStem(w)) > -1) ? 1 : 0;
                  return {
                    id: r.id, name: r.title || r.public_title,
                    image: r.image || null,
                    url: r.url ? ('https://axiomprint.com/product/' + r.url) : null,
                    orders: Number(r.order_count) || 0,
                    why: (hits >= groupCount ? 'offers all ' + groupCount + ' specs'
                                             : 'offers ' + hits + ' of ' + groupCount + ' specs') +
                         (nameHit ? ' · name matches too' : ''),
                    match: Math.max(5, Math.round(Math.min(99, cover * 55 + nameHit * 25 + pop * 20)))
                  };
                }).sort((a, b) => b.match - a.match).slice(0, 8);

                if (picks.length) {
                  picks.forEach(p2 => shownProducts.add(Number(p2.id)));
                  picksShown++;
                  send({ type: 'product_picks', products: picks,
                         intent: (toolUse.input.intent === 'price') ? 'price' : 'info',
                         ask_about: q, replace: picksShown > 1 });
                  toolResult = JSON.stringify({
                    found_by: 'specs (deep search)',
                    matches: picks.slice(0, 5).map(p2 => ({ id: p2.id, name: p2.name, why: p2.why })),
                    ui: 'No product NAME matched, so these were found by the options they offer. They are ' +
                        'ALREADY on screen as clickable cards — do not list them. One short line, then stop.'
                  });
                  deepHandled = true;
                }
              }
            } catch (de) { /* fall through to the plain no-match reply */ }
          }

          if (deepHandled) {
            // The spec search already answered and drew the cards.
          } else if (!usable.length) {
            // Nothing matched — remember the words so the team can teach them.
            terms.forEach(t => noteJargonMiss(t, q));
            toolResult = 'No products matched "' + q + '". Try a shorter or more general keyword.';
          } else {
            // Rank by how well each name matches, NOT by title length - otherwise
            // short junk names outrank the product people actually want.
            // Name match alone can't separate a dozen "... Business Cards" products,
            // so blend in how much each is actually ordered. The one the team means
            // is almost always the one they sell most of.
            const maxOrders = Math.max(1, ...usable.map(r => Number(r.order_count) || 0));
            const scored = usable.map(r => {
              const cand = {
                title: r.title, public_title: r.public_title,
                _kw: [r.title, r.public_title, r.type, r.meta_title, r.meta_keywords, r.added_keywords]
                  .filter(Boolean).join(' ').toLowerCase(),
                ordered: 0
              };
              const m = scoreProductMatch(cand, q, q);
              const orders = Number(r.order_count) || 0;
              // Log scale: 6,639 orders shouldn't drown out 600, but should clearly win.
              // Recent volume leads. Lifetime still counts for a little, so a
              // solid product having a quiet year isn't buried — but it can no
              // longer carry a product last ordered in 2020.
              const lifetime = Number(r.lifetime_orders) || 0;
              const popularity = orders > 0
                ? Math.log10(orders + 1) / Math.log10(maxOrders + 1)
                : (lifetime > 0 ? Math.min(0.25, Math.log10(lifetime + 1) / 20) : 0);

              // A word satisfied by a real OPTION ("foil", "spot uv") is a genuine
              // capability, so it counts for more than the same word appearing in
              // marketing text. This is what lifts an embellished poster above a
              // plain one when someone asks for foil.
              // A term satisfied by a real OPTION is a stated requirement, not a
              // word that happens to appear. "14pt coated 1 side" narrows the
              // catalogue far more than "poster" does, so it must dominate.
              // Only SPEC terms count as feature hits. "banner" appearing in some
              // option title is not a capability match — it is the product type,
              // and crediting it let a niche product outscore the one people
              // actually buy on a request with no specs at all.
              const feats = specGroups.length ? (Number(r.feature_hits) || 0) : 0;
              const featBonus = specTerms.length ? Math.min(1, feats / specTerms.length) : 0;
              // Extra credit for satisfying MOST of the requested specs — a product
              // that offers every stated option is almost certainly the one.
              // Fraction of the STATED specs this product can actually do. When the
              // person named specs, this is the whole question — a poster that
              // cannot do 14PT C1S is the wrong poster however popular it is.
              const specHits = Number(r.spec_hits) || 0;
              const specCover = specGroups.length ? (specHits / specGroups.length) : 0;
              const specBonus = specGroups.length
                ? specCover
                : (feats / Math.max(1, terms.length) >= 0.6 ? 1 : 0);

              // This client's own history with the product. Strongest single
              // signal there is — repeat buyers order the same thing.
              const mine = Number(r.client_orders) || 0;
              const clientBonus = mine > 0 ? Math.min(1, Math.log10(mine + 1) / Math.log10(11)) : 0;

              // Words matched only in keywords/meta still count, just less.
              const kwText = String(cand._kw || '');
              const kwHits = terms.filter(w => kwText.indexOf(w) > -1).length;
              const kwBonus = terms.length ? (kwHits / terms.length) : 0;

              const allText = (cand._kw || '') + ' ' + String(r.meta_title || '').toLowerCase();

              // How much of the PRODUCT TYPE this product's own text matches. This
              // leads: "poster" must find posters. Specs then decide which poster.
              const nameCover = nameTerms.length
                ? nameTerms.filter(w => allText.indexOf(w) > -1).length / nameTerms.length
                : 1;

              // A spec that appears in the product's NAME is a different order of
              // signal from one that appears in its options. Every business card
              // can be magnetic; only "Die Cut Business Cards" IS a die cut card.
              // Without this, products named for the exact thing asked for were
              // being outranked by products that merely offer it.
              const titleText = String(r.title || '').toLowerCase() + ' ' +
                String(r.public_title || '').toLowerCase();
              let specInName = 0;
              specGroups.forEach(g => {
                const phrase = g.join(' ');
                const asPhrase = titleText.indexOf(phrase) > -1;
                const allWords = g.alt ? g.some(w => titleText.indexOf(likeStem(w)) > -1)
                  : g.every(w => titleText.indexOf(likeStem(w)) > -1);
                if (asPhrase || allWords) specInName++;
              });
              const nameSpecBonus = specGroups.length ? (specInName / specGroups.length) : 0;

              // SIZE and QUANTITY are the two things that decide whether a product
              // can do the job at all. Everything else is preference.
              //   in range      -> strong bonus
              //   above the max -> heavy penalty; it physically cannot do the run
              //   below the min -> mild penalty; usually a bulk-only product
              // Size fit, scored like quantity fit: offering it outright is a
              // strong yes, being unable to do it is a hard no.
              const sFit = wantSize ? (sizeFit[Number(r.id)] != null ? sizeFit[Number(r.id)] : 0) : 0;

              let qtyFit = 0;
              const rng = qtyRange[Number(r.id)];
              if (wantQty && rng && rng.hi > 0) {
                if (wantQty >= rng.lo && wantQty <= rng.hi) qtyFit = 1;
                else if (wantQty > rng.hi) qtyFit = -1;
                else qtyFit = -0.4;
              }

              // With no specs stated, "a banner" means the banner people order.
              // Popularity is then the only real signal, so it leads. Once specs
              // ARE given they take over and popularity steps back.
              const vague = specGroups.length === 0;
              const score = vague
                ? Math.round(Math.max(3, Math.min(99,
                    m.score * 0.26 +        // name similarity
                    nameCover * 16 +        // is it the right kind of product
                    popularity * 34 +       // what people actually buy
                    qtyFit * 14 +           // can it do this run size
                    sFit * 20 +             // ...and this size
                    kwBonus * 4 +
                    clientBonus * 14)))     // ...unless this client buys another
                : Math.round(Math.max(3, Math.min(99,
                    m.score * 0.30 +
                    nameCover * 18 +
                    nameSpecBonus * 24 +
                    qtyFit * 20 +
                    sFit * 18 +
                    popularity * 12 +
                    kwBonus * 4 +
                    clientBonus * 9 +
                    specBonus * 12 +
                    featBonus * 4)));
              const why = [];
              if (mine) why.push('Client ordered ' + mine.toLocaleString() + ' x');
              const sizeLabel = wantSize
                ? (wantSize.fromFeet
                    ? (wantSize.w / 12) + '\u00d7' + (wantSize.h / 12) + 'ft'
                    : wantSize.w + '\u00d7' + wantSize.h)
                : '';
              const lim = sizeLimits[Number(r.id)];
              const asFt = n => (n % 12 === 0) ? (n / 12) + 'ft' : n + '"';
              if (sFit === 1) why.push('offers ' + sizeLabel);
              else if (sFit === -1) {
                // Say what it CAN do, not just what it can't.
                why.push(lim
                  ? sizeLabel + ' is outside its ' + asFt(lim.minW) + '\u00d7' + asFt(lim.minH) +
                    ' to ' + asFt(lim.maxW) + '\u00d7' + asFt(lim.maxH) + ' range'
                  : 'doesn\u2019t do ' + sizeLabel + ' (fixed sizes only)');
              } else if (sFit > 0 && wantSize) {
                // Just the match. The range is only worth spelling out when the
                // answer is no — then it tells them what would work instead.
                why.push(sizeLabel + ' as a custom size');
              }
              if (qtyFit === 1) why.push('handles ' + wantQty.toLocaleString());
              else if (qtyFit === -1) why.push('maxes out at ' + rng.hi.toLocaleString());
              else if (qtyFit === -0.4) why.push('minimum is ' + rng.lo.toLocaleString());
              if (specInName) {
                why.push(specInName >= specGroups.length
                  ? 'this product IS what you asked for'
                  : 'named for ' + specInName + ' of what you asked for');
              }
              if (specGroups.length && specHits > 0) {
                why.push(specHits >= specGroups.length
                  ? 'offers every spec you asked for'
                  : 'offers ' + specHits + ' of ' + specGroups.length + ' specs');
              } else if (specGroups.length && specHits === 0) {
                // Say what is missing rather than reporting a bare zero.
                why.push('no ' + specGroups.map(g => g.label || g.join(' ')).join(' or '));
              } else if (feats) {
                why.push('offers ' + feats + ' of your specs');
              }
              // "Popular" is a share of the leader, not the log score used for
              // ranking. On a log curve 243 orders reads as 0.72 against a leader
              // of 2,095 — enough to label a product we barely sell. A third of
              // the leader's volume is a real signal; 12% is not.
              // "Popular" means people are buying it NOW: a real share of the
              // busiest product's last-12-months volume.
              const share = maxOrders > 0 ? (orders / maxOrders) : 0;
              // 20% of the busiest product's recent volume. Tuned so a family
              // typically shows two or three, not one and not half the list.
              if (vague && orders >= 15 && share >= 0.2) why.push('Popular');
              return {
                id: r.id,
                name: r.title || r.public_title,
                image: r.image || null,
                url: r.url ? ('https://axiomprint.com/product/' + r.url) : null,
                orders: orders,
                client_orders: mine,
                features: feats,
                why: why.join(' · ') || undefined,
                match: Math.max(5, score)
              };
            }).sort((a, b) => b.match - a.match || b.client_orders - a.client_orders || b.features - a.features)
              .slice(0, 15);

            if (scored.length > 1) {
              // Tell the UI what a click should DO. Asking "what paper do we offer"
              // and getting a price calculator answers a question nobody asked.
              const pickIntent = (toolUse.input.intent === 'price') ? 'price' : 'info';
              picksShown++;
              awaitingClick = true;
              // The model dived straight in without a word, so state the search
              // ourselves. A silent spinner gives no chance to correct a
              // misreading before the results land.
              if (!saidAnything) {
                const bits = [];
                if (wantQty) bits.push(wantQty.toLocaleString());
                bits.push(q);
                (toolUse.input.specs || []).slice(0, 4).forEach(x => bits.push(String(x)));
                send({ type: 'text', text: 'Looking for: ' + bits.join(' \u00b7 ') + '\n\n' });
                saidAnything = true;
              }
              // Picking a product answers the question as they asked it, not just
              // the product word ("what synthetic paper…", not "menus").
              send({ type: 'product_picks', products: scored, intent: pickIntent,
                     ask_about: (pickIntent === 'info' && askedText && askedText.length <= 300) ? askedText.trim() : q,
                     replace: picksShown > 1 });
              // The picker already shows these with images, so don't also emit
              // standalone cards for them later in the same answer.
              scored.forEach(p => shownProducts.add(Number(p.id)));
              // Tell the model what actually drove the ranking, so it can explain
              // the pick instead of just naming it.

              toolResult = JSON.stringify({
                matches: scored.slice(0, 5).map(p => ({
                  id: p.id, name: p.name, match: p.match + '%',
                  why: p.why || undefined
                })),
                ranking_note: 'Products are ranked on name, SEO keywords, how much they sell, AND whether ' +
                  'they actually offer the options asked for. "has all requested options" means the product ' +
                  'genuinely has that capability - prefer those and say so.',
                ui: 'STOP. This answer is OVER — the matches are on screen and the turn ends here, so ' +
                    'anything you write NOW is wasted. (The recap line you wrote BEFORE the search was ' +
                    'correct and should always be there.) They are obviously clickable, so "Which one?" ' +
                    'adds nothing.\n' +
                    'Produce NO TEXT unless you know something the cards do not show — e.g. "none of ' +
                    'these do 5x9ft". If you have nothing to add, say nothing.\n' +
                    'FORBIDDEN: "Which one?", "Pick one and I will price it", listing or naming any of ' +
                    'them, "I found", "here are the options".'
              });
            } else {
              toolResult = JSON.stringify({
                matches: scored.map(p => ({ id: p.id, name: p.name })),
                ui: 'Only one match — continue straight to answering the question for it.'
              });
            }
          }
          }
        } catch (e) {
          toolResult = 'Product search failed: ' + e.message + '. The database IS connected - retry.';
        }
      } else if (toolUse.name === 'get_dieline') {
        const pid = parseInt(toolUse.input.product_id);
        const chosenItem = toolUse.input.option_item_id ? parseInt(toolUse.input.option_item_id) : null;
        send({ type: 'query', description: 'Looking up die lines' });
        try {
          // Die lines live on product_variable_item.die_line_id, and which option
          // applies is decided by product_variable_filters (usually gated on Size).
          const rows = await runQueryRaw(
            'SELECT pvi.id AS item_id, pvi.title AS option_name, pv.title AS field, ' +
            'd.id AS die_id, d.width, d.height, d.description, d.status, ' +
            'd.die_line_file_id, d.die_line_file_name, d.template_file_id, d.template_file_name ' +
            'FROM product_variables pv ' +
            'JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
            'JOIN die_line d ON d.id = pvi.die_line_id ' +
            'WHERE pv.product_id = ' + pid + ' AND pvi.die_line_id IS NOT NULL AND pvi.die_line_id > 0 ' +
            (chosenItem ? 'AND pvi.id = ' + chosenItem + ' ' : '') +
            'ORDER BY pv.`order`, pvi.`order`');

          if (rows.length) await sendProductCards([pid]);
          if (!rows.length) {
            toolResult = chosenItem
              ? 'No die line on that option.'
              : 'No die lines are set up for product ' + pid + '. Say so plainly — do not guess a file.';
          } else {
            // What gates each option? Usually Size — that's the question to ask.
            const ids = rows.map(r => r.item_id);
            let gates = [];
            try {
              gates = await runQueryRaw(
                'SELECT pvf.product_variable_item_id AS item_id, pv2.title AS gate_field, pvf.relatedItems ' +
                'FROM product_variable_filters pvf LEFT JOIN product_variables pv2 ON pv2.id = pvf.relatedTo ' +
                'WHERE pvf.product_variable_item_id IN (' + ids.join(',') + ')');
            } catch (ge) { gates = []; }
            const gateIds = [];
            gates.forEach(g => {
              let rel = g.relatedItems;
              try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch (e) { rel = []; }
              g._items = Array.isArray(rel) ? rel.map(Number) : [];
              g._items.forEach(x => { if (gateIds.indexOf(x) === -1) gateIds.push(x); });
            });
            let gateNames = {};
            if (gateIds.length) {
              try {
                const gn = await runQueryRaw('SELECT id, title FROM product_variable_item WHERE id IN (' + gateIds.join(',') + ')');
                gn.forEach(x => { gateNames[x.id] = x.title; });
              } catch (e) {}
            }

            const DRIVE = id => id ? ('https://drive.google.com/file/d/' + id + '/view') : null;
            const list = rows.map(r => {
              const g = gates.filter(x => Number(x.item_id) === Number(r.item_id));
              const gateLabel = g.map(x => (x.gate_field || 'Option') + ': ' +
                (x._items || []).map(i => gateNames[i] || i).join(' / ')).join(', ');
              // die_line_file_* is often empty; the usable PDF is template_file_*
              const fileId = r.die_line_file_id || r.template_file_id || null;
              const fileName = r.die_line_file_name || r.template_file_name || null;
              return {
                item_id: r.item_id,
                option: r.option_name,
                field: r.field,
                size: (r.width && r.height) ? (Number(r.width) + '" x ' + Number(r.height) + '"') : null,
                applies_when: gateLabel || null,
                description: r.description,
                status: r.status,
                file_name: fileName,
                file_url: DRIVE(fileId)
              };
            }).filter(x => x.file_url);

            if (!list.length) {
              toolResult = 'Die line records exist for this product but none has a file attached. Tell the team the file is missing — do not invent a link.';
            } else if (list.length === 1 || chosenItem) {
              const d0 = list[0];
              toolResult = JSON.stringify({
                dieline: d0,
                how_to_show: 'Give the size, then the file as a markdown link: [' + (d0.file_name || 'Die line PDF') + '](' + d0.file_url + '). One or two lines total.'
              });
            } else {
              // Several — the differentiator is almost always size, so let them pick.
              send({
                type: 'product_picks',
                products: list.map(d => ({
                  id: d.item_id,
                  name: (d.size || d.option) + (d.applies_when ? ' — ' + d.applies_when : ''),
                  image: null
                }))
              });
              toolResult = JSON.stringify({
                dielines: list.map(d => ({ item_id: d.item_id, size: d.size, option: d.option, applies_when: d.applies_when })),
                ui: 'This product has ' + list.length + ' die lines that differ by SIZE. The user has ALREADY ' +
                    'been shown them as clickable buttons. Do NOT list them and do NOT pick one yourself. ' +
                    'Reply with ONE short line asking which size, and nothing else.'
              });
            }
          }
        } catch (e) {
          toolResult = 'Die line lookup failed: ' + e.message + '. The database IS connected - retry.';
        }
      } else if (toolUse.name === 'calculate_turnaround') {
        // dayCount from the catalogue is the authority. The wording cannot be
        // trusted — "Express" is 0 days on 483 products and 1 day on 10 others,
        // and "4-5 Business Days" is programmed as 5.
        let days = parseInt(toolUse.input.days);
        const lbl = String(toolUse.input.label || '').trim();

        // What they actually said outranks whatever the model decided. "5 business
        // days" arriving as days:1 drew a one-day schedule for a five-day job,
        // twice, and then argued the point. Read their own message rather than
        // relying on the model to pass it along.
        let spokenText = String(toolUse.input.turnaround_text || '').trim();
        if (!spokenText) {
          const lastUser = [].concat(messages || []).reverse()
            .find(m => m.role === 'user' && typeof m.content === 'string');
          const m2 = lastUser && String(lastUser.content).match(
            /(same\s*day|next\s*(?:business\s*)?day|\d+\s*(?:-\s*\d+\s*)?(?:business\s*)?(?:day|week)s?)/i);
          if (m2) spokenText = m2[1];
        }
        const spoken = turnaroundDaysOf(spokenText);
        if (spoken != null && spoken !== days) {
          console.log('TURNAROUND corrected from "' + spokenText + '" = ' + spoken +
                      ' days (model said ' + days + ')');
        }
        if (spoken != null) days = spoken;
        const tpid = parseInt(toolUse.input.product_id) || 0;

        let dbDays = null;
        if (tpid && lbl) {
          try {
            const dr = await runQueryRaw(
              'SELECT pvi.dayCount FROM product_variables pv ' +
              'JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
              'WHERE pv.product_id = ' + tpid + " AND pv.type = 'turnaround' " +
              'AND pvi.title = ' + mysql.escape(lbl) + ' LIMIT 1');
            if (dr.length && dr[0].dayCount != null) dbDays = parseInt(dr[0].dayCount);
          } catch (e) {}
        }
        if (dbDays != null && isFinite(dbDays)) {
          if (dbDays !== days) {
            console.log('TURNAROUND from catalogue: "' + lbl + '" on #' + tpid +
                        ' = ' + dbDays + ' days (model said ' + days + ')');
          }
          days = dbDays;
        } else {
          const fromLabel = turnaroundDaysOf(lbl);
          if (fromLabel != null && fromLabel !== days) days = fromLabel;
        }
        // `|| 1` used to turn a missing count into a one-day job silently.
        if (!isFinite(days)) days = 1;
        days = Math.max(0, Math.min(60, days));
        const label = String(toolUse.input.label || (days + ' Business Day' + (days === 1 ? '' : 's')));
        send({ type: 'query', description: 'Working out the timeline' });
        try {
          const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          const isBiz = d => {
            const dow = d.getDay();
            return dow !== 0 && dow !== 6 && !usHolidays(d.getFullYear()).has(iso(d));
          };
          // Approval day. A date can be supplied (quoting a job approved last
          // Friday), but "today" always means today IN LOS ANGELES.
          let approval, isToday;
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(toolUse.input.approval_date || ''))) {
            approval = new Date(toolUse.input.approval_date + 'T12:00:00');
            isToday = String(toolUse.input.approval_date) === shopToday();
          } else {
            approval = new Date(shopToday() + 'T12:00:00');
            isToday = true;
          }

          // The cutoff is a fact about the clock in Los Angeles, not something
          // the model or the person's own timezone gets to assert. Someone in
          // New York asking at 7PM their time is asking at 4PM ours — still
          // before cutoff. Only a past approval date takes the supplied flag.
          const beforeCutoff = isToday
            ? shopBeforeCutoff()
            : (toolUse.input.before_cutoff !== false);

          // The clock STARTS on the approval day (before 5PM on a business day),
          // otherwise on the next business day. The start day is day ZERO - it is
          // not one of the turnaround days. Counting begins the day after.
          let clockStart = new Date(approval);
          if (!beforeCutoff || !isBiz(approval)) {
            do { clockStart.setDate(clockStart.getDate() + 1); } while (!isBiz(clockStart));
          }

          const timeline = [];
          timeline.push({ date: iso(approval), type: 'approved', label: 'Approved' });
          if (iso(clockStart) !== iso(approval)) {
            timeline.push({ date: iso(clockStart), type: 'start', label: 'Starts' });
          }

          // Count N business days AFTER the start day.
          let cur = new Date(clockStart);
          let counted = 0;
          let guard = 0;
          let firstProdDay = null;
          while (counted < days && guard++ < 300) {
            cur.setDate(cur.getDate() + 1);
            if (isBiz(cur)) {
              counted++;
              if (counted === 1) firstProdDay = new Date(cur);
              timeline.push({
                date: iso(cur),
                type: counted === days ? 'ready' : 'production',
                label: counted === days ? 'Ready' : ('Day ' + counted)
              });
            } else {
              const dow = cur.getDay();
              timeline.push({
                date: iso(cur),
                type: 'skipped',
                label: (dow === 0 || dow === 6) ? 'Weekend' : 'Holiday', name: closedDays.name(iso(cur)) || undefined
              });
            }
          }
          const ready = new Date(cur);
          const fmt = d => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

          // Does it make the client's date?
          let needBy = null, makesIt = null;
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(toolUse.input.need_by || ''))) {
            needBy = new Date(toolUse.input.need_by + 'T12:00:00');
            makesIt = ready.getTime() <= needBy.getTime();
          }

          const payload = {
            product: toolUse.input.product || null,
            label: label,
            days: days,
            beforeCutoff: beforeCutoff,
            approvalDate: iso(approval),
            approvalLabel: fmt(approval),
            startDate: iso(clockStart),
            startLabel: fmt(clockStart),
            firstDayLabel: firstProdDay ? fmt(firstProdDay) : null,
            readyDate: iso(ready),
            readyLabel: fmt(ready),
            skipped: timeline.filter(t => t.type === 'skipped').length,
            needBy: needBy ? iso(needBy) : null,
            needByLabel: needBy ? fmt(needBy) : null,
            makesIt: makesIt,
            timeline: timeline
          };
          send({ type: 'turnaround', data: payload });

          toolResult = JSON.stringify({
            summary: label + ' approved ' + (beforeCutoff ? 'before' : 'after') + ' 5PM on ' + fmt(approval) +
              '. The approval day is day zero, so counting starts the next business day' +
              (firstProdDay ? ' (' + fmt(firstProdDay) + ')' : '') + ' and the job is ready ' + fmt(ready) +
              (payload.skipped ? ' (' + payload.skipped + ' non-working day(s) skipped)' : '') +
              (makesIt === null ? '' : (makesIt ? '. Makes the ' + fmt(needBy) + ' deadline.' : '. MISSES the ' + fmt(needBy) + ' deadline.')),
            ui: 'A visual timeline has ALREADY been drawn for the user. Do NOT list the days or repeat the ' +
                'dates. Reply with ONE or TWO short lines: the ready date, and the deadline verdict if there was one.'
          });
        } catch (e) {
          toolResult = 'Turnaround calculation failed: ' + e.message;
        }
      } else if (toolUse.name === 'get_file_specs') {
        send({ type: 'query', description: 'Checking the file setup' });
        try {
          const pid2 = parseInt(toolUse.input.product_id) || 0;
          let rows = [];
          if (pid2) {
            rows = await runQueryRaw(
              'SELECT id, title, dpi, bleed, safe FROM product WHERE id = ' + pid2 + ' LIMIT 1');
          } else {
            const terms2 = searchTerms(toolUse.input.product || '');
            if (terms2.length) {
              const w = terms2.map(t =>
                '(' + termCond('p.title', t) + ' OR ' + termCond('p.public_title', t) + ')').join(' AND ');
              rows = await runQueryRaw(
                'SELECT p.id, p.title, p.dpi, p.bleed, p.safe, ' +
                '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_productid = p.id ' +
                ' AND e.created >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)) AS recent ' +
                'FROM product p WHERE (' + w + ") AND p.title NOT LIKE '%test%' " +
                "AND p.title NOT LIKE '%Dont USE%' ORDER BY recent DESC LIMIT 6");
            }
          }

          if (!rows.length) {
            toolResult = 'No product matched "' + (toolUse.input.product || '') +
                         '". Ask which product they mean.';
          } else {
            // Where a family agrees, answer for the family rather than listing
            // near-identical rows — "fabric banners" is one answer, not six.
            const uniq = {};
            rows.forEach(r => {
              const k = r.dpi + '|' + r.bleed + '|' + r.safe;
              (uniq[k] = uniq[k] || []).push(r.title);
            });
            const keys = Object.keys(uniq);
            const top = rows[0];
            toolResult = JSON.stringify({
              product: top.title, product_id: top.id,
              dpi: top.dpi, bleed: top.bleed, safe_area: top.safe,
              all_same: keys.length === 1,
              others: keys.length > 1
                ? keys.map(k => ({ specs: k.split('|'), products: uniq[k] }))
                : undefined,
              answer: 'For ' + top.title + ' the required file resolution is ' + top.dpi + ' DPI' +
                (Number(top.bleed) > 0 ? ', with ' + top.bleed + '" bleed' : ', with no bleed needed') +
                ' and a ' + top.safe + '" safe area.',
              ui: 'Answer in ONE line using these numbers. Do not add industry rules of thumb, do not ' +
                  'caveat it, and do not suggest checking with prepress — this IS the spec.'
            });
          }
        } catch (e) {
          toolResult = 'Could not read the file specs: ' + e.message;
        }
      } else if (toolUse.name === 'find_client_products') {
        const cid = parseInt(toolUse.input.client_id) || sessionClientId;
        if (!cid) {
          toolResult = 'No client is connected. Identify the client first — a reorder is only ' +
                       'answerable from their own history.';
        } else if (searchedThisTurn) {
          toolResult = 'You already searched for "' + searchedThisTurn + '" in this answer. Finish that ' +
                       'item — price it and let them Save it — before looking up the next one.';
        } else {
          searchedThisTurn = String(toolUse.input.query || 'their history');
          send({ type: 'query', description: 'Checking what they order' });
          const q = String(toolUse.input.query || '').trim();
          const terms = searchTerms(q);
          const where = terms.length
            ? ' AND (' + terms.map(w =>
                '(' + termCond('p.title', w) + ' OR ' + termCond('p.public_title', w) + ')').join(' OR ') + ')'
            : '';
          try {
            const rows = await runQueryRaw(
              'SELECT p.id, p.title, p.public_title, p.image, ' +
              'COUNT(e.id) AS times, MAX(e.id) AS last_estimate, MAX(e.created) AS last_date ' +
              'FROM estimate e JOIN product p ON p.id = e.estimate_productid ' +
              'WHERE e.estimate_clientid = ' + parseInt(cid) + where + ' ' +
              'GROUP BY p.id, p.title, p.public_title, p.image ' +
              'ORDER BY times DESC, last_date DESC LIMIT 12');

            if (!rows.length) {
              toolResult = JSON.stringify({
                found: 0,
                note: 'This client has never ordered anything matching "' + q + '". Fall back to ' +
                      'find_products across the whole catalogue and say it would be a first for them.'
              });
            } else {
              // The specs of the LAST order of each — that is what a reorder means.
              const detail = [];
              for (const r of rows.slice(0, 6)) {
                let specs = [];
                try {
                  const eo = await runQueryRaw(
                    'SELECT estimate_option_name AS f, ' +
                    "COALESCE(NULLIF(selected,''), estimate_option_value) AS v " +
                    'FROM estimateoption WHERE estimate_id = ' + parseInt(r.last_estimate) +
                    ' AND hidden = 0 ORDER BY `order`');
                  specs = (eo || []).map(x => x.f.replace(/_/g, ' ') + ': ' + x.v);
                } catch (e) {}
                detail.push({
                  id: r.id, name: r.title || r.public_title,
                  ordered_times: Number(r.times),
                  last_order: 'E' + r.last_estimate,
                  last_date: r.last_date ? String(r.last_date).slice(0, 10) : null,
                  last_specs: specs
                });
              }
              const picks = rows.map(r => ({
                id: r.id, name: r.title || r.public_title, image: r.image || null,
                orders: Number(r.times),
                why: 'Client ordered ' + Number(r.times).toLocaleString() + ' x · last ' +
                     (r.last_date ? String(r.last_date).slice(0, 10) : 'unknown'),
                match: Math.min(99, 60 + Math.min(35, Number(r.times) * 3))
              }));
              picksShown++;
              picks.forEach(p2 => shownProducts.add(Number(p2.id)));
              send({ type: 'product_picks', products: picks, intent: 'price',
                     ask_about: q, replace: picksShown > 1 });
              toolResult = JSON.stringify({
                found: rows.length,
                products: detail,
                ui: 'These are ALREADY on screen as clickable cards. Do not list them. If the request names ' +
                    'more than one variant (e.g. "windowed and no window"), price EACH one — the last_specs ' +
                    'tell you what they had, so rebuild from those rather than defaults.'
              });
            }
          } catch (e) {
            toolResult = 'Could not read their order history: ' + e.message;
          }
        }
      } else if (toolUse.name === 'find_option') {
        const opt = String(toolUse.input.option || '').trim();
        const onlyProduct = toolUse.input.product_id ? parseInt(toolUse.input.product_id) : null;
        send({ type: 'query', description: 'Searching all products for "' + opt + '"' });
        try {
          // Match on every word so "linen lamination" finds "Linen Lamination, 2 Sides"
          // and "Linen Texture Lamination, Outside Only".
          // The words as typed count too: jargon turns "scoring" into "score",
          // which does not match a field called "Scoring".
          const terms = searchTerms(opt);
          String(opt).toLowerCase().replace(/[^a-z0-9. ]+/g, ' ').split(/\s+/)
            .filter(w => w.length > 3 && !SEARCH_STOPWORDS.has(w)).forEach(w => {
              if (terms.indexOf(w) === -1) terms.push(w);
              // "synthetic" is never an option title — "15Mil White PVC" is.
              (MATERIAL_ALTS[w] || []).forEach(a => { if (terms.indexOf(a) === -1) terms.push(a); });
            });
          // ANY term. "hemp paper" must find "Clean White Hemp (140# Cover)" —
          // requiring both words found nothing, because no option title says
          // "paper". Results are ranked by how many terms actually hit.
          const cond = terms.map(w => {
            const like = mysql.escape('%' + likeStem(w) + '%');
            return '(pvi.title LIKE ' + like + ' OR pv.title LIKE ' + like + ')';
          }).join(' OR ');
          const rows = await runQueryRaw(
            'SELECT p.id AS product_id, p.title AS product, pv.id AS var_id, pv.title AS field, pvi.id AS item_id, pvi.title AS option_name, ' +
            'pvi.isHidden, pvi.value, pvi.base, ' +
            '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_productid = p.id) AS orders ' +
            'FROM product p JOIN product_variables pv ON pv.product_id = p.id ' +
            'JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
            'WHERE ' + cond + (onlyProduct ? ' AND p.id = ' + onlyProduct : '') + ' ' +
            'ORDER BY orders DESC LIMIT 40');
          // Material alternatives ("synthetic" -> PVC, Yupo …) get their own pass, so
          // a rarely ordered PVC menu is not cut off by forty popular "paper" stocks.
          const altTerms = [];
          String(opt).toLowerCase().split(/\s+/).forEach(w => (MATERIAL_ALTS[w] || []).forEach(a => { if (altTerms.indexOf(a) === -1) altTerms.push(a); }));
          if (altTerms.length) {
            const altCond = altTerms.map(w => '(pvi.title LIKE ' + mysql.escape('%' + likeStem(w) + '%') + ')').join(' OR ');
            const extra = await runQueryRaw(
              'SELECT p.id AS product_id, p.title AS product, pv.id AS var_id, pv.title AS field, pvi.id AS item_id, pvi.title AS option_name, ' +
              'pvi.isHidden, pvi.value, pvi.base, ' +
              '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_productid = p.id) AS orders ' +
              'FROM product p JOIN product_variables pv ON pv.product_id = p.id ' +
              'JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
              'WHERE p.active = 1 AND (' + altCond + ')' + (onlyProduct ? ' AND p.id = ' + onlyProduct : '') + ' ' +
              'ORDER BY orders DESC LIMIT 40');
            const seen = new Set(rows.map(r => r.item_id));
            (extra || []).forEach(r => { if (!seen.has(r.item_id)) rows.push(r); });
          }

          if (!rows.length) {
            toolResult = 'Nothing called "' + opt + '" exists on any product. Say so plainly - do not substitute ' +
              'something similar without flagging that it is a different thing.';
          } else {
            const JUNK = /\b(test|testing|dont use|don't use|do not use|deprecated)\b/i;
            const clean = rows.filter(r => !JUNK.test(String(r.product || '')));
            const use = clean.length ? clean : rows;
            // Weight RARE words above common ones. "hemp paper" must lead with the
            // hemp stocks, not with every "60# Uncoated Paper" in the catalogue —
            // both match one term, but "hemp" is the word that means something.
            const termFreq = {};
            terms.forEach(w => { termFreq[w] = 0; });
            use.forEach(r => {
              const t = String(r.option_name || '').toLowerCase();
              terms.forEach(w => { if (t.indexOf(w) > -1) termFreq[w]++; });
            });
            const weightOf = w => 1 / Math.log10(10 + (termFreq[w] || 0));
            use.forEach(r => {
              const t = String(r.option_name || '').toLowerCase();
              r._hits = terms.filter(w => t.indexOf(w) > -1).length;
              r._score = terms.reduce((a, w) => a + (t.indexOf(w) > -1 ? weightOf(w) : 0), 0);
            });
            use.sort((a, b) => (b._score - a._score) || (Number(b.orders) - Number(a.orders)));

            const byField = {};
            use.forEach(r => { byField[r.field] = (byField[r.field] || 0) + 1; });
            // Distinct products, best-selling first, capped so the answer stays readable
            const seenP = [];
            use.forEach(r => { if (seenP.indexOf(r.product_id) === -1) seenP.push(r.product_id); });
            await sendProductCards(seenP.slice(0, 6));
            // When each hit is actually selectable ("Related to" rules).
            let rel = { field: {}, item: {} };
            try { rel = await relatedRules([...new Set(use.slice(0, 25).map(r => r.product_id))]); } catch (e) {}
            toolResult = JSON.stringify({
              found: use.length,
              fields_it_lives_under: Object.keys(byField).map(f => f.replace(/_/g, ' ') + ' (' + byField[f] + ')'),
              results: use.slice(0, 25).map(r => ({
                product: r.product,
                product_id: r.product_id,
                field: String(r.field).replace(/_/g, ' '),
                option: r.option_name,
                hidden: r.isHidden == 1 || undefined,
                only_when: (function () {
                  const c = (rel.field[Number(r.var_id)] || []).concat(rel.item[Number(r.item_id)] || []);
                  return c.length ? c : undefined;
                })(),
                orders: r.orders
              })),
              note: 'Sorted by how much each product is actually ordered. "field" is where the option lives on ' +
                    'that product - name it in your answer so the team knows where to look. When a result has ' +
                    'only_when, it is only selectable with that other selection — say the condition in your answer.'
            });
          }
        } catch (e) {
          toolResult = 'Option search failed: ' + e.message + '. The database IS connected - retry.';
        }
      } else if (toolUse.name === 'find_client') {
        const cEmail = String(toolUse.input.email || '').trim();
        const cName = String(toolUse.input.name || '').trim();
        const cCompany = String(toolUse.input.company || '').trim();
        const cId = toolUse.input.client_id ? parseInt(toolUse.input.client_id) : null;
        send({ type: 'query', description: 'Looking up the client' });
        try {
          const SEL = "SELECT c.id, CONCAT(c.name,' ',c.last_name) AS full_name, c.name, c.last_name, " +
            'c.email, c.phone, c.company_name, u.name AS manager, ' +
            '(SELECT COUNT(*) FROM estimate e WHERE e.estimate_clientid = c.id) AS orders, ' +
            '(SELECT MAX(e.created) FROM estimate e WHERE e.estimate_clientid = c.id) AS last_order, ' +
            'COALESCE((SELECT SUM(COALESCE(e.new_total, e.estimate_price)) FROM estimate e WHERE e.estimate_clientid = c.id), 0) AS lifetime ' +
            'FROM customer c LEFT JOIN user u ON u.id = c.manager_id WHERE ';

          let rows = [];
          let how = '';
          if (cId) {
            rows = await runQueryRaw(SEL + 'c.id = ' + cId + ' LIMIT 1');
            how = 'selected';
          } else if (cEmail) {
            // Email is unique - an exact match settles it, no list needed.
            rows = await runQueryRaw(SEL + 'c.email = ' + mysql.escape(cEmail) + ' LIMIT 1');
            how = 'email';
            // No exact match? The domain is the next best thing. Someone emailing
            // from a company address is almost certainly that company's account,
            // even when they personally aren't on file — which is how a search
            // for "Renata" returned two unrelated people instead of her firm.
            if (!rows.length) {
              const dom = domainOf(cEmail);
              if (dom) {
                rows = await runQueryRaw(
                  SEL + 'c.email LIKE ' + mysql.escape('%@' + dom) + ' ORDER BY orders DESC LIMIT 12');
                rows.forEach(r => { r.same_domain = dom; });
                how = 'domain';
              }
            }
          } else if (cName || cCompany) {
            // STARTS WITH, not contains: "complex" should not drag in every
            // company with the word buried in the middle.
            const parts = [];
            if (cCompany) parts.push('c.company_name LIKE ' + mysql.escape(cCompany + '%'));
            if (cName) {
              const bits = cName.split(/\s+/).filter(Boolean);
              const first = bits[0], last = bits.slice(1).join(' ');
              if (last) {
                parts.push('(c.name LIKE ' + mysql.escape(first + '%') + ' AND c.last_name LIKE ' + mysql.escape(last + '%') + ')');
              } else {
                parts.push('c.name LIKE ' + mysql.escape(first + '%'));
                parts.push('c.last_name LIKE ' + mysql.escape(first + '%'));
                parts.push('c.company_name LIKE ' + mysql.escape(first + '%'));
              }
            }
            rows = await runQueryRaw(SEL + '(' + parts.join(' OR ') + ') ORDER BY orders DESC LIMIT 12');
            how = 'search';
            // If an email came with the request, add their colleagues — they are
            // usually a better answer than a same-first-name stranger.
            const dom2 = domainOf(toolUse.input.email || cName || cCompany);
            if (dom2) {
              try {
                const mates = await runQueryRaw(
                  SEL + 'c.email LIKE ' + mysql.escape('%@' + dom2) + ' ORDER BY orders DESC LIMIT 8');
                const have = new Set(rows.map(r => Number(r.id)));
                mates.forEach(m => {
                  if (have.has(Number(m.id))) return;
                  m.same_domain = dom2;
                  rows.push(m);
                });
                // Colleagues first — the domain is the stronger signal.
                rows.sort((a, b) => (b.same_domain ? 1 : 0) - (a.same_domain ? 1 : 0) ||
                  Number(b.orders) - Number(a.orders));
              } catch (de) {}
            }
          } else {
            rows = [];
            how = 'none';
          }

          if (how === 'none') {
            toolResult = 'Give an email, a name, or a company to look up.';
          } else if (!rows.length) {
            toolResult = 'No client found for ' + (cEmail || cName || cCompany || cId) +
              '. They may be new — say so plainly and do not invent a record. ' +
              (cEmail ? 'If the domain is a company they might be a new contact at an existing account: try find_client with the company name.' : '');
          } else if (rows.length === 1 || how === 'email' || how === 'selected') {
            const c0 = rows[0];
            await pinClient(c0.id, c0.company_name ? (c0.full_name + ' (' + c0.company_name + ')') : c0.full_name);
            send({ type: 'client_card', client: {
              id: c0.id, name: c0.full_name, company: c0.company_name, email: c0.email,
              phone: c0.phone, orders: c0.orders, manager: c0.manager,
              lifetime: c0.lifetime, last_order: c0.last_order
            }});
            toolResult = JSON.stringify({
              client: c0,
              matched_by: how === 'email' ? 'exact email (unique - confident)' : how,
              next: 'Call get_client_context with client_id ' + c0.id + ' before quoting or recommending anything.'
            });
          } else {
            // Several — let them pick, ranked by activity.
            const top = rows.slice(0, 5);
            clientSearchThisTurn++;
            awaitingClick = true;
              send({ type: 'client_picks', replace: clientSearchThisTurn > 1, clients: top.map(r => ({
              id: r.id, name: r.full_name, company: r.company_name,
              email: r.email, orders: r.orders, last_order: r.last_order,
              // Same company as the person who wrote in.
              same_domain: r.same_domain || null
            }))});
            toolResult = JSON.stringify({
              matches: top.map(r => ({ id: r.id, name: r.full_name, company: r.company_name, orders: r.orders })),
              more: rows.length > 5 ? (rows.length - 5) + ' more matched but only the 5 most active are shown' : undefined,
              domain_note: rows.some(r => r.same_domain)
                ? 'Some of these share the sender\'s email domain — they are colleagues at the same ' +
                  'company and are almost certainly the right account, even if the sender is not on file.'
                : undefined,
              ui: 'The user has ALREADY been shown these as clickable cards, most active first. Do NOT list ' +
                  'them again, do NOT ask "which client?", and do NOT pick one yourself. ' +
                  'Clicking one CONNECTS that client to the ' +
                  'conversation and then tells you to carry on, so do not wait, do not ask them to ' +
                  'confirm, and do not search for clients again in this answer. Say ONE short line ' +
                  '("Which client?") and stop.'
            });
          }
        } catch (e) {
          toolResult = 'Client lookup failed: ' + e.message + '. The database IS connected - retry.';
        }
      } else if (toolUse.name === 'get_client_context') {
        const cid = parseInt(toolUse.input.client_id);
        send({ type: 'query', description: 'Reading order and email history' });
        try {
          const cRows = await runQueryRaw(
            "SELECT c.id, CONCAT(c.name,' ',c.last_name) AS full_name, c.email, c.phone, c.company_name, " +
            'c.calculator_fix_percent, c.calculator_simple_percent, c.payment_terms, u.name AS manager ' +
            'FROM customer c LEFT JOIN user u ON u.id = c.manager_id WHERE c.id = ' + cid + ' LIMIT 1');
          if (cRows.length) await pinClient(cid, cRows[0].company_name ? (cRows[0].full_name + ' (' + cRows[0].company_name + ')') : cRows[0].full_name);
          if (!cRows.length) {
            toolResult = 'No client with id ' + cid + '.';
          } else {
            const hist = await runQueryRaw(
              'SELECT e.id AS estimate_id, e.estimate_name, e.estimate_printordernumber AS job_number, ' +
              'DATE(e.created) AS ordered, e.express, COALESCE(e.new_total, e.estimate_price) AS total, ' +
              'e.estimate_productid AS product_id, COALESCE(NULLIF(p.public_title, \'\'), p.title) AS product ' +
              'FROM estimate e LEFT JOIN product p ON e.estimate_productid = p.id ' +
              'WHERE e.estimate_clientid = ' + cid + ' ORDER BY e.created DESC LIMIT 20');

            // Their usual choice per field, from the specs actually ordered
            let usual = [];
            try {
              const ids = hist.slice(0, 10).map(h => parseInt(h.estimate_id)).filter(Boolean);
              if (ids.length) {
                usual = await runQueryRaw(
                  'SELECT eo.estimate_option_name AS field, ' +
                  "COALESCE(NULLIF(eo.selected,''), eo.estimate_option_value) AS value, COUNT(*) AS times " +
                  'FROM estimateoption eo WHERE eo.estimate_id IN (' + ids.join(',') + ') AND eo.hidden = 0 ' +
                  'GROUP BY field, value HAVING value IS NOT NULL AND value <> \'\' ' +
                  'ORDER BY field, times DESC LIMIT 60');
              }
            } catch (ue) { usual = []; }

            // Recent email threads with them
            let mail = [];
            const dom = String(cRows[0].email || '').split('@').pop();
            const FREE = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com'];
            const mq = (dom && FREE.indexOf(dom.toLowerCase()) === -1)
              ? ('from:' + dom + ' OR to:' + dom)
              : ('from:' + cRows[0].email + ' OR to:' + cRows[0].email);
            try {
              mail = (await gmailSearch(mq, 6)).map(m => ({
                date: m.date, from: m.from, subject: m.subject,
                snippet: String(m.snippet || '').slice(0, 200)
              }));
            } catch (me) { mail = []; }

            // Deliberately NOT rendering product cards here. They look like a
            // chooser but they're just what this client has bought before, and
            // shown next to a real match picker they double the noise. The model
            // still gets the history below.
            const prodIds = [];
            hist.forEach(h => { if (h.product_id && prodIds.indexOf(h.product_id) === -1) prodIds.push(h.product_id); });
            prodIds.slice(0, 8).forEach(id => shownProducts.add(Number(id)));

            const rush = hist.filter(h => String(h.express) === '1').length;
            toolResult = JSON.stringify({
              client: cRows[0],
              order_history: hist,
              rush_rate: rush + ' of ' + hist.length + ' recent orders were express',
              usual_choices: usual,
              recent_emails: mail,
              guidance: 'Use their usual choices as the default for anything they have not specified this time. ' +
                        'Reference a real past order (product, date, price) when it is relevant. ' +
                        'Do NOT quote a final price from history - prices change; price it fresh.'
            });
          }
        } catch (e) {
          toolResult = 'Client context failed: ' + e.message + '. The database IS connected - retry.';
        }
      } else if (toolUse.name === 'calculate_price') {
        const pid = parseInt(toolUse.input.product_id);
        const qty = parseInt(toolUse.input.quantity) || 0;

        // Versions with no breakdown is not priceable as stated: the server would
        // have to invent a split, and an even one is almost never what was asked
        // for ("500 and 800" is not 650 and 650). Refuse and say exactly what to
        // send back, rather than quietly guessing.
        const vIn = parseInt(toolUse.input.versions) || 0;
        const vList = Array.isArray(toolUse.input.version_list) ? toolUse.input.version_list : null;
        const perV = parseInt(toolUse.input.quantity_per_version) || 0;
        if (vIn > 1 && !(vList && vList.length) && !perV) {
          toolResult = JSON.stringify({
            error: 'versions is ' + vIn + ' but no per-version QUANTITIES were given.',
            fix: 'Call calculate_price again with version_list — one entry per version with its quantity. ' +
                 'Example for "2 versions, 500 and 800": {"version_list":[{"quantity":500},{"quantity":800}]}. ' +
                 'Do NOT pass quantity with version_list — the total is the sum. ' +
                 'If every version is the same size, use quantity_per_version instead. ' +
                 'NAMES ARE NOT NEEDED to price — do not ask for them, just price it.',
            never: 'Never split a total evenly across versions. 1300 across 2 versions is NOT 650 and 650 ' +
                   'unless the person said so.'
          });
        } else {
        // Re-pricing the same product with the same inputs in one answer gains
        // nothing and is how a transient failure ends up contradicting a card
        // that already succeeded.
        const priceKey = pid + '|' + qty + '|' + JSON.stringify(toolUse.input.options || {}) +
          '|' + (toolUse.input.width || '') + 'x' + (toolUse.input.height || '') +
          '|' + JSON.stringify(toolUse.input.version_list || []);
        // A list on screen is a question. Pricing one of the options in the same
        // breath answers it for them and makes the list pointless — either be
        // confident enough to price without asking, or ask and wait for the click.
        // Different product from the one already priced in this answer? Stop.
        // Pricing NCR forms and then vinyl banners in one breath is exactly the
        // "one item at a time" rule being broken, just at the pricing step
        // rather than the search step.
        if (pricedProduct && Number(pid) !== pricedProduct) {
          toolResult = 'You have already priced a different product in this answer. ONE ITEM AT A TIME: ' +
                       'finish this one — let them Save it — and the next item comes after. ' +
                       'Say one short line naming what is next and STOP. Do not price it now.';
          awaitingClick = true;
        } else if (picksShown > 0 && !pricedThisTurn.size) {
          toolResult = 'You have just put a product list on screen, so you are ASKING which one. Stop and ' +
                       'wait for the click — do not price one of them yourself in the same answer. ' +
                       'If you were sure enough to price it, you should not have shown the list. ' +
                       'Reply with one short line and nothing else.';
        } else if (pricedThisTurn.has(priceKey)) {
          toolResult = 'Already priced in this answer — the card is on screen. Use that figure; do not ' +
                       'price it again.';
          send({ type: 'query', description: 'Already priced' });
        } else {
        pricedThisTurn.add(priceKey);
        if (!pricedProduct) pricedProduct = Number(pid);
        send({ type: 'query', description: 'Pricing it in the calculator' });
        try {
          const q = await quoteProduct(pid, {
            options: toolUse.input.options || {},
            quantity: qty,
            quantity_per_version: toolUse.input.quantity_per_version,
            features: toolUse.input.features,
            version_list: toolUse.input.version_list,
            width: toolUse.input.width,
            height: toolUse.input.height,
            versions: toolUse.input.versions,
            // Fall back to whoever was identified earlier in this conversation.
            client_id: toolUse.input.client_id || sessionClientId
          });
          if (!q.ok) {
            toolResult = (quotesShown > 0
              ? 'This attempt failed, but a price card from an earlier call in this same answer is ' +
                'ALREADY on screen and valid. Do NOT tell anyone pricing is unavailable — quote the ' +
                'figure from that card. Error was: ' + (q.error || 'unknown') + '. '
              : (q.error || 'Pricing failed') + '. ') + 'Check the available quantities with ' +
              'get_product_options. Do NOT calculate it yourself.';
          } else {
            await sendProductCards([pid]);
            quotesShown++;
            send({ type: 'price_quote', data: q, replace: quotesShown > 1 });
            const adjusted = q.specs.filter(u => u.source === 'auto' || u.source === 'linked')
              .map(u => u.field + ' -> ' + u.value + ' (required by another field)');
            toolResult = JSON.stringify({
              product: q.product, quantity: q.quantity,
              total: '$' + usd2(q.price), each: '$' + usd2(q.each),
              list_price: q.discount ? ('$' + usd2(q.list_price)) : undefined,
              discount: q.discount
                ? (q.discount.percent + '% ' + q.discount.name + ' (' + q.discount.basis + ') - saves $' + usd2(q.discount.saved))
                : undefined,
              // Say it outright when there is no discount: otherwise the model has been known to call a connected
              // client's regular price "trade pricing" or "client pricing applied".
              account_pricing: q.discount ? undefined : (q.client_id
                ? 'NO account discount: this client has no discount on this product, so this is the regular website price. Never say a discount, trade or client pricing was applied.'
                : 'Regular website price (no client connected).'),
              specs_used: q.specs.map(u => ({ field: u.field, value: u.value, source: u.source })),
              custom_size: q.size,
              auto_adjusted: adjusted.length ? adjusted : undefined,
              could_not_match: q.unmatched.length ? q.unmatched : undefined,
              not_applied: q.not_applied,
              // Too many designs for versions to make sense. Say which route to
              // take before quoting 28 separate setups.
              too_many_versions: (Number(q.versions) > 25 || Number(toolUse.input.versions) > 25)
                ? (q.hasVariableData
                    ? 'That is more than 25 designs, so versions are the wrong tool — each one is a ' +
                      'separate setup. This product DOES offer Variable Data: re-price it as ONE run at ' +
                      'the smallest quantity that covers the count, with Variable Data set to Yes, and ' +
                      'explain both options and why VDP is cheaper here.'
                    : 'That is more than 25 designs, and this product has NO Variable Data option. Do not ' +
                      'quote it as versions. Tell them plainly, and give the two real choices: a product ' +
                      'that offers VDP, or splitting the job into two orders of half the designs each.')
                : undefined,
              ui: 'A price card has ALREADY been shown with the full spec list and an Edit button. Do NOT ' +
                  'repeat the specs and do NOT show any calculation. State the total in one line. ' +
                  'Any row the card marks "Clarify" is a field the team flagged as needing confirmation ' +
                  'and it is already a dropdown that reprices in place — do NOT ask about those in chat ' +
                  'and do NOT use ask_option for them. Say one short line naming the defaults assumed. ' +
                  (q.unmatched.length
                    ? 'IMPORTANT: some requested options did not match a real option (see could_not_match). ' +
                      'Say which, list the real choices, and offer to reprice.'
                    : '') +
                  (adjusted.length ? ' Mention the auto-adjusted fields in one short line.' : '') +
                  (q.not_applied
                    ? ' IMPORTANT: some requested options are NOT in this price because of a "Related to" rule ' +
                      '(see not_applied: what was asked, and the selection it needs). Say so plainly — e.g. ' +
                      '"Scoring is only available on 100# Gloss Cover, so it is not included on Gloss Text" — ' +
                      'and offer to reprice with the selection that allows it.'
                    : '')
            });
          }
        } catch (e) {
          toolResult = quotesShown > 0
            ? 'This attempt failed, but a valid price card from an earlier call in this answer is ALREADY ' +
              'on screen. Quote that figure and say nothing about a failure — reporting one while a price ' +
              'is visible contradicts itself. Error was: ' + e.message
            : 'Pricing failed: ' + e.message + '. Do NOT calculate it yourself. Retry ONCE with the same ' +
              'inputs before telling anyone — most of these are transient. If the retry works, report only ' +
              'the price.';
        }
        }
        }
      } else if (toolUse.name === 'get_job') {
        const raw = String(toolUse.input.e_number || '').trim();
        const eid = parseInt(raw.replace(/[^0-9]/g, ''));
        send({ type: 'query', description: 'Looking up job E' + (eid || '') });
        try {
          if (!eid) {
            toolResult = 'That does not look like an E-number.';
          } else {
            // E-numbers are 'E' + estimate.id (estimate_printordernumber is usually blank).
            const rows = await runQueryRaw(
              'SELECT e.id, e.estimate_name, DATE(e.created) AS created, e.production_status, ' +
              'e.prepress_status, e.complete_by, e.express, ' +
              "(SELECT s.estimate_substage FROM estimate_stage s WHERE s.estimate_id = e.id ORDER BY s.id DESC LIMIT 1) AS substage, " +

              'COALESCE(e.new_total, e.estimate_price) AS total, ' +
              'e.estimate_productid AS product_id, COALESCE(NULLIF(p.public_title, \'\'), p.title) AS product, p.image, ' +
              "e.estimate_clientid AS client_id, CONCAT(c.name,' ',c.last_name) AS client, c.company_name, c.email " +
              'FROM estimate e LEFT JOIN product p ON p.id = e.estimate_productid ' +
              'LEFT JOIN customer c ON c.id = e.estimate_clientid WHERE e.id = ' + eid + ' LIMIT 1');
            if (!rows.length) {
              toolResult = 'No job found for E' + eid + '. Check the number.';
            } else {
              const j = rows[0];
              let specs = [];
              try {
                specs = await runQueryRaw(
                  'SELECT eo.estimate_option_name AS field, ' +
                  "COALESCE(NULLIF(eo.selected,''), eo.estimate_option_value) AS value " +
                  'FROM estimateoption eo WHERE eo.estimate_id = ' + eid + ' AND eo.hidden = 0 ' +
                  'ORDER BY eo.`order` LIMIT 40');
                specs = specs.filter(x => x.value != null && String(x.value).trim() !== '')
                  .map(x => ({ field: String(x.field || '').replace(/_/g, ' '), value: x.value, raw: x.field }));
                // Show them in the product's own field order, so the card reads the
                // same way as the calculator rather than in estimate-record order.
                if (j.product_id) {
                  const ord = await runQueryRaw(
                    'SELECT title, `order` FROM product_variables WHERE product_id = ' + parseInt(j.product_id));
                  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                  const pos = {};
                  ord.forEach(o => { pos[norm(o.title)] = Number(o.order) || 0; });
                  specs.sort((a, b) => {
                    const pa = pos[norm(a.raw)], pb = pos[norm(b.raw)];
                    return (pa == null ? 999 : pa) - (pb == null ? 999 : pb);
                  });
                }
                specs.forEach(x => { delete x.raw; });
              } catch (se) { specs = []; }

              // Version names and per-version quantities. The stored Quantity option
              // is PER VERSION — the CRM shows the total as qty x versions — so a
              // 2-version job at 50 each is a 100-piece order.
              let versionCount = 1;
              let versionList = [];
              try {
                const vr = await runQueryRaw(
                  'SELECT version_name, version_order FROM estimate_prepress_option ' +
                  'WHERE estimate_id = ' + eid + " AND version_name IS NOT NULL AND version_name <> '' " +
                  'GROUP BY version_name, version_order ORDER BY version_order');
                if (vr.length) {
                  versionCount = vr.length;
                  const qSpec = specs.find(x => /^quantity$/i.test(x.field));
                  const totalQty = qSpec ? parseInt(String(qSpec.value).replace(/[^0-9]/g, '')) : null;
                  // The stored Quantity is the TOTAL across versions (same as the
                  // website's Quantity field). Each version gets total / versions.
                  const perVersion = totalQty ? Math.round(totalQty / vr.length) : null;
                  versionList = vr.map((v, i) => ({
                    name: v.version_name || ('Version ' + (i + 1)),
                    quantity: perVersion
                  }));
                }
              } catch (ve) {}

              // Was the original on a custom size? If the stored size isn't one of
              // the product's presets, the reorder must carry width/height or it
              // will silently land on a different (cheaper) preset.
              let reorderWH = null, sizeIsCustom = false;
              try {
                const sizeSpec = specs.find(x => /^size$/i.test(x.field));
                const wh = sizeSpec ? parseWH(sizeSpec.value) : null;
                if (wh && j.product_id) {
                  const presets = await runQueryRaw(
                    'SELECT pvi.title, pvi.custom FROM product_variables pv ' +
                    'JOIN product_variable_item pvi ON pvi.variable_id = pv.id ' +
                    "WHERE pv.product_id = " + parseInt(j.product_id) +
                    " AND pv.type IN ('size_new','size_3D') AND pvi.isHidden = 0");
                  const match = presets.find(pr => {
                    const p2 = parseWH(pr.title);
                    return p2 && ((p2.w === wh.w && p2.h === wh.h) || (p2.w === wh.h && p2.h === wh.w));
                  });
                  if (!match) { reorderWH = wh; sizeIsCustom = true; }
                }
              } catch (we) {}

              // Readable status. Prepress comes first while files are still moving;
              // once approved, production status is what people actually want.
              const PREP = {
                approved: 'Files approved', upload_files: 'Waiting for files',
                proof_checking: 'Proof checking', rejected_reupload: 'Rejected — reupload needed',
                rejected_edits: 'Rejected — edits needed', waiting_files: 'Waiting for files',
                waiting_files_followup: 'Waiting for files (followed up)', proof_sent: 'Proof sent to client',
                hard_copy_approved: 'Hard copy approved', insta_proofed: 'Auto-proofed',
                insta_proof_manual: 'Proof under review'
              };
              const PROD = {
                not_started: 'Not started', in_production: 'In production',
                reprint: 'Reprint', complete: 'Complete', hard_copy: 'Hard copy'
              };
              const prep = PREP[j.prepress_status] || j.prepress_status || null;
              const prod = PROD[j.production_status] || j.production_status || null;
              let stage = 'prepress', headline = prep || prod || 'Unknown';
              if (j.production_status === 'complete') { stage = 'done'; headline = 'Complete'; }
              else if (j.production_status === 'in_production') { stage = 'production'; headline = 'In production'; }
              else if (j.production_status === 'reprint') { stage = 'production'; headline = 'Reprint in progress'; }
              else if (j.production_status === 'hard_copy') { stage = 'production'; headline = 'Hard copy'; }
              else if (j.prepress_status === 'approved' && j.production_status === 'not_started') {
                stage = 'ready'; headline = 'Approved — queued for production';
              }
              const bsj = boardStatus(j.substage);
              if (bsj) { stage = bsj.stage; headline = bsj.headline; }

              await sendProductCards(j.product_id ? [j.product_id] : []);
              if (j.client_id) await pinClient(j.client_id, j.company_name ? (j.client + ' (' + j.company_name + ')') : j.client);
              const jDisc = await discountFor(j.client_id, j.product_id);
              send({ type: 'job_card', data: {
                discount: jDisc ? { percent: jDisc.percent, name: jDisc.name, basis: jDisc.basis } : null,
                versions: versionCount,
                version_list: versionList,
                custom_size: sizeIsCustom && reorderWH ? (reorderWH.w + '" × ' + reorderWH.h + '"') : null,
                e_number: 'E' + j.id, id: j.id,
                name: j.estimate_name || null,
                product: j.product || null, product_id: j.product_id, image: j.image || null,
                client: j.client || null, company: j.company_name || null, client_id: j.client_id,
                created: j.created ? String(j.created).slice(0, 10) : null,
                due: j.complete_by ? String(j.complete_by).slice(0, 10) : null,
                total: j.total != null ? Number(j.total) : null,
                express: String(j.express) === '1',
                headline: headline, stage: stage, prepress: prep, production: prod,
                specs: specs
              }});
              toolResult = JSON.stringify({
                job: 'E' + j.id, name: j.estimate_name, product: j.product,
                client: j.client, client_id: j.client_id,
                discount_tier: jDisc ? (jDisc.percent + '% ' + jDisc.name) : 'none',
                versions: versionCount,
                version_breakdown: versionList.length ? versionList : undefined,
                quantity_note: versionCount > 1
                  ? 'Quantity is the TOTAL across all ' + versionCount + ' versions (' +
                    'each version is that divided by ' + versionCount + ').'
                  : undefined,
                reorder: {
                  product_id: j.product_id,
                  client_id: j.client_id,
                  versions: versionCount,
                  width: reorderWH ? reorderWH.w : undefined,
                  height: reorderWH ? reorderWH.h : undefined,
                  options: specs.reduce((acc, sp) => {
                    if (!/^quantity$/i.test(sp.field)) acc[sp.field] = sp.value;
                    return acc;
                  }, {}),
                  quantity: (function () {
                    const q = specs.find(x => /^quantity$/i.test(x.field));
                    // Already the total — pass it straight through. Verified against
                    // E1156659: stored 100 with 2 versions prices to $145.30 list.
                    return q ? parseInt(String(q.value).replace(/[^0-9]/g, '')) : undefined;
                  })()
                },
                reorder_hint: 'To reprice this job, call calculate_price with EXACTLY the values in `reorder` ' +
                  'above - product_id, client_id, quantity, versions, options, and width/height if present. ' +
                  (versionCount > 1
                    ? 'This job had ' + versionCount + ' artwork VERSIONS; omitting versions will underprice it badly. '
                    : '') +
                  (sizeIsCustom
                    ? 'The size is CUSTOM (not one of the product presets) - you MUST pass width and height, ' +
                      'or the price will silently fall back to a different preset size. '
                    : '') +
                  'If your repriced total differs a lot from the original, say so rather than presenting it as the same job.',
                status: headline,
                prepress: prep, production: prod,
                total: j.total != null ? ('$' + usd2(Number(j.total))) : null,
                ordered: j.created ? String(j.created).slice(0, 10) : null,
                specs: specs,
                ui: 'A job card with the status, specs and a Reorder button has ALREADY been shown. Do NOT ' +
                    'repeat the specs or the status. One short line is enough.'
              });
            }
          }
        } catch (e) {
          toolResult = 'Job lookup failed: ' + e.message + '. The database IS connected - retry.';
        }
      } else if (toolUse.name === 'ask_choice') {
        const question = String(toolUse.input.question || '').trim();
        const choices = (toolUse.input.choices || []).map(c => String(c)).filter(Boolean).slice(0, 6);
        if (!question || !choices.length) {
          toolResult = 'Give a question and at least two choices.';
        } else {
          awaitingClick = true;
              send({ type: 'choice_picks', question: question, choices: choices });
          toolResult = JSON.stringify({
            asked: question, choices: choices,
            ui: 'The question and its buttons have ALREADY been shown. Do NOT repeat them. Say nothing ' +
                'further — wait for the answer.'
          });
        }
      } else if (toolUse.name === 'ask_option') {
        const pid = parseInt(toolUse.input.product_id);
        const fieldQ = String(toolUse.input.field || '').trim();
        const only = Array.isArray(toolUse.input.only)
          ? toolUse.input.only.map(Number).filter(Boolean) : null;
        send({ type: 'query', description: 'Loading ' + (fieldQ || 'options') });
        try {
          const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const vars = await runQueryRaw(
            'SELECT id, title, type FROM product_variables WHERE product_id = ' + pid + ' ORDER BY `order`');
          const v = vars.find(x => norm(x.title) === norm(fieldQ)) ||
                    vars.find(x => norm(x.title).indexOf(norm(fieldQ)) > -1) ||
                    vars.find(x => norm(fieldQ).indexOf(norm(x.title)) > -1);
          if (!v) {
            toolResult = 'No field like "' + fieldQ + '" on this product. Fields: ' +
              vars.map(x => String(x.title).replace(/_/g, ' ')).join(', ');
          } else {
            // Option image first; fall back to the material's own picture, which is
            // what makes stock choices actually recognisable.
            const items = await runQueryRaw(
              'SELECT pvi.id, pvi.title, pvi.`default`, pvi.custom, pvi.image, pvi.material_id, ' +
              "COALESCE(NULLIF(m.website_image_url,''), NULLIF(m.photo_url,'')) AS material_image " +
              'FROM product_variable_item pvi LEFT JOIN materials m ON m.id = pvi.material_id ' +
              'WHERE pvi.variable_id = ' + v.id + ' AND pvi.isHidden = 0 ' +
              (only && only.length ? 'AND pvi.id IN (' + only.join(',') + ') ' : '') +
              'ORDER BY pvi.`order`');
            if (!items.length) {
              toolResult = 'No selectable options on ' + v.title + '.';
            } else {
              const opts = items.map(i => ({
                id: i.id,
                title: i.title,
                image: i.image || i.material_image || null,
                is_default: i.default == 1 || undefined,
                custom: i.custom == 1 || undefined
              }));
              awaitingClick = true;
              send({ type: 'option_picks', field: String(v.title).replace(/_/g, ' '),
                     product_id: pid, options: opts });
              toolResult = JSON.stringify({
                field: String(v.title).replace(/_/g, ' '),
                shown: opts.length,
                with_images: opts.filter(o => o.image).length,
                options: opts.map(o => o.title),
                ui: 'The options have ALREADY been shown as clickable cards with their images. Do NOT list ' +
                    'them again. Reply with ONE short line — e.g. "Which one?" — and stop.'
              });
            }
          }
        } catch (e) {
          toolResult = 'Could not load those options: ' + e.message;
        }
      } else if (toolUse.name === 'run_report') {
        const rid = String(toolUse.input.report || '');
        send({ type: 'query', description: 'Running the ' + ((Reports.REPORTS[rid] || {}).title || 'report') + ' report' });
        try {
          const rep = await Reports.run(rid, toolUse.input.params || {});
          reportsShown++;
          send({ type: 'report', report: rid, params: rep.params, result: rep, replace: reportsShown > 1 });
          toolResult = JSON.stringify(Object.assign(Reports.digest(rep, 8), {
            ui: 'The report is ALREADY open beside the chat as an interactive table with a full-screen view. Do NOT ' +
                'list its rows or repeat the summary numbers as a table. Reply in 1-3 short lines: the headline ' +
                '(how many / how much), anything that stands out in the first rows, and one useful next step ' +
                '(e.g. filter by manager, widen the window). Mention any note that limits the data.'
          }));
        } catch (e) {
          toolResult = 'The report could not run: ' + e.message + '. Say so plainly; do not guess the numbers.';
        }
      } else if (toolUse.name === 'quote_installation' || toolUse.name === 'quote_delivery') {
        const isInstall = toolUse.name === 'quote_installation';
        send({ type: 'query', description: isInstall ? 'Pricing the installation' : 'Pricing the delivery' });
        const input = Object.assign({}, toolUse.input || {});
        // Measure the trip from the shop whenever there is an address. A distance
        // someone actually stated still wins.
        let routeNote = null;
        if (input.address && (input.distance_mi == null || input.distance_mi === '')) {
          send({ type: 'query', description: 'Measuring the drive from the Glendale shop' });
          const rt = await routeLookup(input.address, {
            date: input.date, time: isInstall ? toTime24(input.arrival_start) : toTime24(input.drop_time) });
          if (rt.ok) { input.distance_mi = rt.miles; input.route = rt; }
          else routeNote = rt.error;
        }
        const q = isInstall ? InstallPricing.quoteInstall(input, installPricing)
                            : InstallPricing.quoteDelivery(input, installPricing);
        installShown++;
        send({ type: 'install_quote', kind: q.kind, input: input, quote: q, config: installPricing, replace: installShown > 1 });
        const missing = [];
        if (q.inputs.distance_mi == null) missing.push(input.address ? 'distance (address not found on the map)' : 'address');
        if (isInstall && !(q.inputs.pieces || []).length) missing.push('piece sizes');
        toolResult = JSON.stringify({
          total: q.total,
          total_includes_travel: q.inputs.distance_mi != null,
          route: input.route ? { miles: input.route.miles, drive_minutes: (q.drive && q.drive.minutes),
            traffic: input.route.traffic_label, live_traffic: !!input.route.live, approximate: input.route.approximate,
            matched: input.route.matched } : null,
          route_problem: routeNote,
          lines: q.lines,
          assumptions: q.assumptions,
          warnings: q.warnings,
          missing: missing,
          ui: 'The editable ' + (isInstall ? 'installation' : 'delivery') + ' calculator is ALREADY open beside ' +
              'the chat, and the chat already shows "Estimated price is $…" under your answer. So do NOT repeat the ' +
              'total, the line items or the route. Write at most TWO short lines: ' +
              '(1) the assumptions that matter, in one line; ' +
              (q.total == null ? 'say it must go to a person and why; ' : '') +
              (missing.length ? 'mention the total leaves out travel until the ' + missing[0] + ' is known; ' : '') +
              '(2) if warnings is not empty, say it is provisional and should be handed off, with the reason. ' +
              'Ask at most ONE question, only for the most price-moving missing fact (order: address, piece sizes, ' +
              'height/access, day and time), and never for anything already given.'
        });
      } else {
        toolResult = 'Unknown tool.';
      }

      return toolResult;
      };

      const results = [];
      for (const tu of toolUses) {
        let out;
        try { out = await runOneTool(tu); }
        catch (e) { out = 'Tool failed: ' + e.message + '. The database IS connected - retry.'; }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out == null ? '' : out) });
      }

      // If the answer now ENDS in a question the person has to click — product
      // matches, client matches, an option picker — there is nothing left to
      // say. Looping back to the model costs another full round trip to produce
      // no text, and the timer keeps spinning over a list that is already
      // usable. Stop here instead.
      // Another safe point — every tool in this batch has finished.
      if (aborted) break;

      if (awaitingClick) break;

      currentMessages.push({ role: 'assistant', content: assistantBlocks });
      currentMessages.push({ role: 'user', content: results });
      queryCount++;
    }

    // The team should get the calculator EVERY time they ask for an install or
    // delivery price. If the model answered without calling the tool, put an
    // empty calculator under the answer anyway.
    if (!aborted && !installShown) {
      const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
      const txt = !lastUser ? '' : (typeof lastUser.content === 'string' ? lastUser.content
        : (Array.isArray(lastUser.content) ? lastUser.content.map(c => c.text || '').join(' ') : ''));
      const priceAsk = /\b(price|pricing|cost|costs|quote|quoted|estimate|how much|charge|rate)\b|\$/i.test(txt);
      const isInstall = /\binstall(s|ing|ation|ations|er|ers)?\b|\bmount(ing)?\b|\bon[- ]site\b/i.test(txt);
      const isDelivery = /\b(local )?deliver(y|ies|ing)?\b|\bdrop[- ]?off\b/i.test(txt);
      if (priceAsk && (isInstall || isDelivery)) {
        const kind = isInstall ? 'installation' : 'delivery';
        const q = isInstall ? InstallPricing.quoteInstall({}, installPricing) : InstallPricing.quoteDelivery({}, installPricing);
        send({ type: 'install_quote', kind: kind, input: {}, quote: q, config: installPricing, replace: false });
      }
    }
  } catch (err) {
    console.error('CHATBOT_ERROR:', err.message);
    send({ type: 'error', error: err.message });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// SPA catch-all: any non-API GET that isn't a real static file serves the app shell.
// Prevents "Cannot GET /<path>" when a slug or deep link hits the server.
mountMcp(app, { runQuery, dataDictionary: DATA_DICTIONARY });

// The customer-facing bot — separate tables, rules, tools and tokens (client-bot.js).
const clientBot = require('./client-bot')(app, { db, runQuery, mysql, jwt, crypto, anthropic, model: MODEL_LIGHT, auth, adminOnly,
  quoteProduct, buildOrderLink, stripHtml, searchTerms, likeStem, serveVersionedHtml, allowFraming,
  InstallPricing, getInstallPricing: () => installPricing, routeLookup, toTime24, driveFileBytes,
  extractAttachmentText, relatedRules, sendMail, closedDays, dataDir: __dirname });
// TalkAi — NovaAI on the phone (Twilio + ElevenLabs), sharing the client bot's tools and rules (talk-ai.js).
require('./talk-ai')(app, { db, runQuery, mysql, crypto, anthropic, model: MODEL_LIGHT, auth, adminOnly, serveVersionedHtml,
  sendMail, dataDir: __dirname, loadTalkTraining, closedDays }, clientBot);

app.get(/^(?!\/api).*/, serveVersionedHtml('index.html'));

app.listen(process.env.PORT, () => console.log('Axiom AI running on port ' + process.env.PORT));
