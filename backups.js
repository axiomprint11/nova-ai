'use strict';
// Nightly backups of users.db (1.20.68).
//
// SQLite is the only copy of every chat, rule, AR match, loan and designer decision Nova has — the production business
// data stays in MySQL, but nothing here is anywhere else. So: every night at BACKUP_AT (LA, default 03:15) a consistent
// snapshot is written with `VACUUM INTO` (safe while the app runs — it reads through the connection, WAL included, no file
// copy of a live database), gzipped, kept for BACKUP_KEEP_DAYS (30) in BACKUP_DIR (/opt/axiom-ai/backups, gitignored),
// and — when BACKUP_DRIVE_FOLDER is set — uploaded to that Google Drive folder with the same service account as order@'s
// mail (needs the `drive.file` scope added to the domain-wide delegation; until then the upload is skipped with a note).
// A failed night emails BACKUP_ALERT_TO (gary@). `POST /api/admin/backups/run` takes one by hand; `GET /api/admin/backups`
// lists what is on disk and the last result. Admin → Connectors shows the same.
//
// Restore: stop Nova, `gunzip -c backups/users-2026-10-15.db.gz > users.db`, remove users.db-wal / -shm, start Nova.
//
// 1.20.173 — a copy off the server, in DigitalOcean Spaces (spaces.js). With SPACES_KEY / SPACES_SECRET / SPACES_BUCKET /
// SPACES_REGION in .env, every run also (1) uploads the snapshot to <prefix>/db/ (kept SPACES_KEEP_DAYS, 90) and (2) copies
// every uploaded FILE Nova keeps on this disk — HR documents, bookkeeping receipts and loan papers, TalkAi recordings,
// client and staff chat attachments, knowledge files — to <prefix>/files/<folder>/<same path>. Only new or changed files
// go up (SQLite `backup_files` remembers path + size + mtime), so after the first night it is minutes. Nothing is ever
// deleted from the Space by the file copy: a file removed in Nova stays in the backup. The file copy runs in the
// background after the snapshot (the first one can take a while); its progress is in GET /api/admin/backups → spaces.
// Restore a file: download it from the Space (DigitalOcean panel → Spaces → the bucket) and put it back at the same path.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), os = require('os');

module.exports = function mountBackups(app, deps) {
  const { db, auth, adminOnly, sendMail, google, keyPath, gmailUser, dbPath, Notify } = deps;
  const env = (k, d) => { const v = String(process.env[k] || '').trim(); return v || d; };
  const DIR = env('BACKUP_DIR', path.join(path.dirname(dbPath), 'backups'));
  const KEEP = Math.max(3, parseInt(env('BACKUP_KEEP_DAYS', '30')) || 30);
  const AT = env('BACKUP_AT', '03:15');
  const DRIVE_FOLDER = env('BACKUP_DRIVE_FOLDER', '');
  const ALERT_TO = env('BACKUP_ALERT_TO', 'gary@axiomprint.com');
  // 1.20.173: the off-server copy in DigitalOcean Spaces
  const SP = { key: env('SPACES_KEY', ''), secret: env('SPACES_SECRET', ''), bucket: env('SPACES_BUCKET', ''), region: env('SPACES_REGION', ''),
               endpoint: env('SPACES_ENDPOINT', '') || undefined, signRegion: env('SPACES_SIGN_REGION', '') || undefined };
  const SP_PREFIX = env('SPACES_PREFIX', 'nova').replace(/^\/+|\/+$/g, '');
  const SP_KEEP = Math.max(7, parseInt(env('SPACES_KEEP_DAYS', '90')) || 90);
  let space = null, spaceErr = null;
  const ROOT = path.dirname(dbPath);
  // The keys come from .env, or — so nobody has to type a 40-character secret into a server console — from the form on
  // Admin → Connectors, which tests them and saves them in .spaces.json beside .env (mode 600, gitignored, never backed up).
  const CRED_FILE = path.join(ROOT, '.spaces.json');
  function initSpace() {
    space = null; spaceErr = null;
    if (!(SP.key && SP.secret && SP.bucket && SP.region) && fs.existsSync(CRED_FILE)) {
      try { const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); for (const k of ['key', 'secret', 'bucket', 'region']) if (c[k]) SP[k] = c[k]; SP.from = 'admin'; } catch (e) { spaceErr = 'could not read .spaces.json: ' + e.message; }
    }
    if (SP.key && SP.secret && SP.bucket && SP.region) { try { space = require('./spaces')(SP); } catch (e) { spaceErr = e.message; } }
  }
  initSpace();
  // every folder of uploaded files, named as each module names it (same env overrides, same defaults)
  const FOLDERS = [
    ['hr-files', env('HR_FILES_DIR', path.join(ROOT, 'hr-files'))],
    ['bookkeeping-files', env('BOOKKEEPER_FILES_DIR', path.join(ROOT, 'bookkeeping-files'))],
    ['talk-recordings', env('TALKAI_AUDIO_DIR', path.join(ROOT, 'talk-recordings'))],
    ['client-uploads', env('CLIENT_BOT_UPLOAD_DIR', path.join(ROOT, 'client-uploads'))],
    ['chat-uploads', env('CHAT_UPLOAD_DIR', path.join(ROOT, 'chat-uploads'))],
    ['knowledge_files', path.join(ROOT, 'knowledge_files')]
  ];
  db.run('CREATE TABLE IF NOT EXISTS backup_files (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, at TEXT)', () => {});
  let sync = { running: false, started: null, finished: null, scanned: 0, todo: 0, done: 0, bytes: 0, failed: 0, errors: [], by: null, folders: {} };
  if (Notify) Notify.register('backup', () => ALERT_TO);
  const mailOn = () => !Notify || Notify.on('backup'); const mailTo = () => Notify ? Notify.to('backup', ALERT_TO) : ALERT_TO;
  const TZ = 'America/Los_Angeles';
  const log = (m) => console.log('BACKUP ' + m), errlog = (m) => console.error('BACKUP ' + m);
  let last = { at: null, ok: null, file: null, size: 0, ms: 0, drive: null, error: null }, running = false;

  const laDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
  const laHM = (d) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(d || new Date()); const g = (t) => p.find(x => x.type === t).value; return g('hour') + ':' + g('minute'); };
  const dbRun = (sql) => new Promise((res, rej) => db.run(sql, (e) => e ? rej(e) : res()));

  async function snapshot(tag) {
    fs.mkdirSync(DIR, { recursive: true });
    const name = 'users-' + laDate() + (tag ? '-' + tag : '') + '.db';
    const tmp = path.join(DIR, name + '.tmp'), out = path.join(DIR, name + '.gz');
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    // VACUUM INTO writes a complete, consistent copy without blocking other connections for long (SQLite ≥ 3.27)
    await dbRun("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
    await new Promise((res, rej) => fs.createReadStream(tmp).pipe(zlib.createGzip({ level: 6 })).pipe(fs.createWriteStream(out)).on('finish', res).on('error', rej));
    fs.unlinkSync(tmp);
    return out;
  }
  function prune() {
    const cut = Date.now() - KEEP * 86400000; let n = 0;
    for (const f of fs.readdirSync(DIR)) { if (!/^users-.*\.db\.gz$/.test(f)) continue; const p = path.join(DIR, f); try { if (fs.statSync(p).mtimeMs < cut) { fs.unlinkSync(p); n++; } } catch (e) {} }
    return n;
  }
  function list() {
    if (!fs.existsSync(DIR)) return [];
    return fs.readdirSync(DIR).filter(f => /^users-.*\.db\.gz$/.test(f)).map(f => { const s = fs.statSync(path.join(DIR, f)); return { name: f, size: s.size, at: s.mtime.toISOString() }; }).sort((a, b) => b.at < a.at ? -1 : 1);
  }
  // Off the box: the same service account that reads order@'s mail, with the drive.file scope (write only to files it made)
  async function toDrive(file) {
    if (!DRIVE_FOLDER) return { skipped: 'BACKUP_DRIVE_FOLDER not set' };
    if (!google || !keyPath || !fs.existsSync(keyPath)) return { skipped: 'no service account key' };
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const jwt = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/drive.file'], subject: gmailUser });
    const drive = google.drive({ version: 'v3', auth: jwt });
    const r = await drive.files.create({ requestBody: { name: path.basename(file), parents: [DRIVE_FOLDER] }, media: { mimeType: 'application/gzip', body: fs.createReadStream(file) }, fields: 'id,name', supportsAllDrives: true });
    // keep the Drive folder to KEEP days as well
    try {
      const old = await drive.files.list({ q: "'" + DRIVE_FOLDER + "' in parents and name contains 'users-' and trashed=false", fields: 'files(id,name,createdTime)', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true });
      const cut = Date.now() - KEEP * 86400000;
      for (const f of old.data.files || []) if (new Date(f.createdTime).getTime() < cut) await drive.files.delete({ fileId: f.id, supportsAllDrives: true }).catch(() => {});
    } catch (e) {}
    return { id: r.data.id, name: r.data.name };
  }
  // ---- Spaces (1.20.173) ----
  const dbAll = (sql, p) => new Promise((res, rej) => db.all(sql, p || [], (e, r) => e ? rej(e) : res(r)));
  const dbRunP = (sql, p) => new Promise((res, rej) => db.run(sql, p || [], (e) => e ? rej(e) : res()));
  const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain', gz: 'application/gzip' };
  const mimeOf = (f) => MIME[(path.extname(f).slice(1) || '').toLowerCase()] || 'application/octet-stream';
  async function dbToSpace(file) {
    if (!space) return { skipped: spaceErr || 'Spaces not set up (SPACES_KEY / SPACES_SECRET / SPACES_BUCKET / SPACES_REGION)' };
    const k = SP_PREFIX + '/db/' + path.basename(file);
    await space.putFile(k, file, 'application/gzip');
    let pruned = 0;
    try {
      const cut = Date.now() - SP_KEEP * 86400000;
      for (const o of await space.list(SP_PREFIX + '/db/')) if (/users-.*\.db\.gz$/.test(o.key) && o.modified && Date.parse(o.modified) < cut) { await space.del(o.key); pruned++; }
    } catch (e) { errlog('Spaces prune: ' + e.message); }
    return { key: k, pruned };
  }
  // walk a folder: regular files only (no links), skipping half-written ones
  function walk(dir, out) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, out);
      else if (d.isFile() && !/\.(tmp|part)$/i.test(d.name)) out.push(p);
    }
    return out;
  }
  async function filesToSpace(who) {
    if (!space || sync.running) return;
    sync = { running: true, started: new Date().toISOString(), finished: null, scanned: 0, todo: 0, done: 0, bytes: 0, failed: 0, errors: [], by: who || 'clock', folders: {} };
    try {
      const seen = new Map((await dbAll('SELECT path, size, mtime FROM backup_files')).map(r => [r.path, r]));
      const queue = [];
      for (const [name, dir] of FOLDERS) {
        const files = walk(dir, []); let n = 0, b = 0;
        for (const f of files) {
          let st; try { st = fs.statSync(f); } catch (e) { continue; }
          n++; b += st.size;
          const rel = name + '/' + path.relative(dir, f).split(path.sep).join('/');
          const was = seen.get(rel);
          if (was && was.size === st.size && was.mtime === Math.floor(st.mtimeMs)) continue;
          queue.push({ f, rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
        }
        sync.folders[name] = { files: n, bytes: b, exists: fs.existsSync(dir) };
        sync.scanned += n;
      }
      sync.todo = queue.length;
      // three at a time: quick enough, and gentle on a 1-vCPU box serving the team
      const worker = async () => {
        while (queue.length) {
          const it = queue.shift();
          try {
            await space.putFile(SP_PREFIX + '/files/' + it.rel, it.f, mimeOf(it.f));
            await dbRunP('INSERT OR REPLACE INTO backup_files (path, size, mtime, at) VALUES (?, ?, ?, ?)', [it.rel, it.size, it.mtime, new Date().toISOString()]);
            sync.done++; sync.bytes += it.size;
          } catch (e) {
            if (!fs.existsSync(it.f)) { sync.todo--; continue; }   /* deleted while we worked: nothing to copy */
            sync.failed++; if (sync.errors.length < 10) sync.errors.push(it.rel + ': ' + e.message);
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } catch (e) { sync.failed++; sync.errors.push(e.message); }
    sync.running = false; sync.finished = new Date().toISOString();
    log('files → Spaces: ' + sync.done + ' of ' + sync.todo + ' copied (' + Math.round(sync.bytes / 1048576) + ' MB), ' + sync.scanned + ' files in all' + (sync.failed ? ', ' + sync.failed + ' FAILED' : ''));
    if (sync.failed && sendMail && mailOn()) sendMail({ to: mailTo(), subject: 'Nova backup: ' + sync.failed + ' file(s) not copied to DigitalOcean Spaces',
      text: 'The nightly copy of Nova\'s uploaded files to the Space "' + SP.bucket + '" could not copy ' + sync.failed + ' of ' + sync.todo + ' file(s). They will be tried again on the next run.\n\n' + sync.errors.join('\n') + '\n\nAdmin → Connectors shows the backup row with Back up now.' }).catch(() => {});
    return sync;
  }

  async function run(who, tag) {
    if (running) return Object.assign({}, last, { error: 'already running' });
    running = true; const t0 = Date.now();
    try {
      const file = await snapshot(tag);
      const size = fs.statSync(file).size;
      let drive = null; try { drive = await toDrive(file); } catch (e) { drive = { error: e.message }; errlog('drive upload failed: ' + e.message); }
      let spaces = null; try { spaces = await dbToSpace(file); } catch (e) { spaces = { error: e.message }; errlog('Spaces upload failed: ' + e.message); }
      const pruned = prune();
      last = { at: new Date().toISOString(), ok: true, file: path.basename(file), size, ms: Date.now() - t0, drive, spaces, pruned, by: who || 'clock', error: null };
      if (spaces && spaces.error && sendMail && mailOn()) sendMail({ to: mailTo(), subject: 'Nova backup: written on the server, DigitalOcean Spaces upload failed', text: 'The nightly users.db backup ' + path.basename(file) + ' was written to ' + DIR + ' but could not be copied to the Space "' + SP.bucket + '":\n\n' + spaces.error + '\n\nCheck SPACES_KEY / SPACES_SECRET / SPACES_BUCKET / SPACES_REGION in .env, and that the key is allowed to write to that bucket.' }).catch(() => {});
      if (space) filesToSpace(who || 'clock').catch(e => errlog('files → Spaces: ' + e.message));   /* background: the first copy can take a while */
      log('wrote ' + path.basename(file) + ' (' + Math.round(size / 1024) + ' KB, ' + last.ms + ' ms)' + (drive && drive.id ? ' · Drive ok' : drive && drive.skipped ? ' · Drive skipped: ' + drive.skipped : drive && drive.error ? ' · Drive FAILED' : '') + (spaces && spaces.key ? ' · Spaces ok' : spaces && spaces.error ? ' · Spaces FAILED' : '') + (pruned ? ' · pruned ' + pruned : ''));
      if (drive && drive.error && sendMail && mailOn()) sendMail({ to: mailTo(), subject: 'Nova backup: written on the server, Drive upload failed', text: 'The nightly users.db backup ' + path.basename(file) + ' was written to ' + DIR + ' but could not be uploaded to Google Drive:\n\n' + drive.error + '\n\nIf the message is about scope or permission, add https://www.googleapis.com/auth/drive.file to the service account\'s domain-wide delegation in Google Admin, and share the folder ' + DRIVE_FOLDER + ' with ' + gmailUser + '.' }).catch(() => {});
    } catch (e) {
      last = { at: new Date().toISOString(), ok: false, error: e.message, ms: Date.now() - t0, by: who || 'clock' };
      errlog('FAILED: ' + e.message);
      if (sendMail && mailOn()) sendMail({ to: mailTo(), subject: 'Nova backup FAILED on ' + os.hostname(), text: 'The nightly users.db backup did not run:\n\n' + e.message + '\n\nDirectory: ' + DIR }).catch(() => {});
    } finally { running = false; }
    return last;
  }
  // the clock: once a minute, fire at BACKUP_AT (LA) — once per LA day
  let firedOn = null;
  if (env('BACKUP_CLOCK', '1') !== '0') {
    const tick = () => { try { const d = laDate(); if (firedOn !== d && laHM() === AT) { firedOn = d; run('clock').catch(() => {}); } } catch (e) {} };
    setInterval(tick, 60000).unref();
    // a box that was off at BACKUP_AT: take one at boot when today's is missing and it is past the hour
    setTimeout(() => { try { if (laHM() > AT && !list().some(f => f.name.startsWith('users-' + laDate()))) { firedOn = laDate(); run('boot').catch(() => {}); } } catch (e) {} }, 90000).unref();
  }
  const status = () => ({ ok: true, dir: DIR, at: AT + ' (LA)', keep_days: KEEP, drive_folder: DRIVE_FOLDER || null, last, files: list().slice(0, 40),
    spaces: space ? { bucket: SP.bucket, region: SP.region, prefix: SP_PREFIX, keep_days: SP_KEEP, from: SP.from || 'env', sync } : { off: spaceErr || 'not set up', from_env: !!process.env.SPACES_KEY } });
  app.get('/api/admin/backups', auth, adminOnly, (req, res) => res.json(status()));
  // Connect / change the Space from the admin page: test a real write first, save only when it works
  app.post('/api/admin/backups/spaces', auth, adminOnly, async (req, res) => {
    const b = req.body || {}; const c = {};
    for (const k of ['key', 'secret', 'bucket', 'region']) c[k] = String(b[k] || '').trim();
    c.region = c.region.toLowerCase().replace(/\.digitaloceanspaces\.com.*$/, '').replace(/^https?:\/\//, '').split('.').pop();
    c.bucket = c.bucket.toLowerCase().replace(/^https?:\/\//, '').split('.')[0];
    if (!c.key || !c.secret || !c.bucket || !c.region) return res.json({ ok: false, error: 'All four are needed: access key, secret, Space name and region.' });
    if (process.env.SPACES_KEY) return res.json({ ok: false, error: 'The Space is set in .env on the server — change it there.' });
    try {
      const test = require('./spaces')(Object.assign({}, c, { endpoint: SP.endpoint }));
      await test.putText(SP_PREFIX + '/.nova-check', 'Nova can write here · ' + new Date().toISOString());
    } catch (e) { return res.json({ ok: false, error: 'DigitalOcean refused: ' + e.message + '. Check the key, the secret, the Space name and its region, and that the key may write to this Space.' }); }
    try { fs.writeFileSync(CRED_FILE, JSON.stringify(c), { mode: 0o600 }); fs.chmodSync(CRED_FILE, 0o600); } catch (e) { return res.json({ ok: false, error: 'Worked, but could not save: ' + e.message }); }
    for (const k of ['key', 'secret', 'bucket', 'region']) SP[k] = c[k];
    SP.from = 'admin'; initSpace();
    log('Spaces connected from the admin page: ' + c.bucket + ' (' + c.region + ')');
    res.json(Object.assign({ ok: true }, status()));
  });
  app.post('/api/admin/backups/run', auth, adminOnly, async (req, res) => { const who = req.user ? (req.user.email || req.user.username || req.user.key) : 'admin'; res.json(Object.assign({ ok: true }, { last: await run(who, 'manual') })); });
  return { run, status, list };
};
