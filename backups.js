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
const fs = require('fs'), path = require('path'), zlib = require('zlib'), os = require('os');

module.exports = function mountBackups(app, deps) {
  const { db, auth, adminOnly, sendMail, google, keyPath, gmailUser, dbPath } = deps;
  const env = (k, d) => { const v = String(process.env[k] || '').trim(); return v || d; };
  const DIR = env('BACKUP_DIR', path.join(path.dirname(dbPath), 'backups'));
  const KEEP = Math.max(3, parseInt(env('BACKUP_KEEP_DAYS', '30')) || 30);
  const AT = env('BACKUP_AT', '03:15');
  const DRIVE_FOLDER = env('BACKUP_DRIVE_FOLDER', '');
  const ALERT_TO = env('BACKUP_ALERT_TO', 'gary@axiomprint.com');
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
  async function run(who, tag) {
    if (running) return Object.assign({}, last, { error: 'already running' });
    running = true; const t0 = Date.now();
    try {
      const file = await snapshot(tag);
      const size = fs.statSync(file).size;
      let drive = null; try { drive = await toDrive(file); } catch (e) { drive = { error: e.message }; errlog('drive upload failed: ' + e.message); }
      const pruned = prune();
      last = { at: new Date().toISOString(), ok: true, file: path.basename(file), size, ms: Date.now() - t0, drive, pruned, by: who || 'clock', error: null };
      log('wrote ' + path.basename(file) + ' (' + Math.round(size / 1024) + ' KB, ' + last.ms + ' ms)' + (drive && drive.id ? ' · Drive ok' : drive && drive.skipped ? ' · Drive skipped: ' + drive.skipped : drive && drive.error ? ' · Drive FAILED' : '') + (pruned ? ' · pruned ' + pruned : ''));
      if (drive && drive.error && sendMail) sendMail({ to: ALERT_TO, subject: 'Nova backup: written on the server, Drive upload failed', text: 'The nightly users.db backup ' + path.basename(file) + ' was written to ' + DIR + ' but could not be uploaded to Google Drive:\n\n' + drive.error + '\n\nIf the message is about scope or permission, add https://www.googleapis.com/auth/drive.file to the service account\'s domain-wide delegation in Google Admin, and share the folder ' + DRIVE_FOLDER + ' with ' + gmailUser + '.' }).catch(() => {});
    } catch (e) {
      last = { at: new Date().toISOString(), ok: false, error: e.message, ms: Date.now() - t0, by: who || 'clock' };
      errlog('FAILED: ' + e.message);
      if (sendMail) sendMail({ to: ALERT_TO, subject: 'Nova backup FAILED on ' + os.hostname(), text: 'The nightly users.db backup did not run:\n\n' + e.message + '\n\nDirectory: ' + DIR }).catch(() => {});
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
  const status = () => ({ ok: true, dir: DIR, at: AT + ' (LA)', keep_days: KEEP, drive_folder: DRIVE_FOLDER || null, last, files: list().slice(0, 40) });
  app.get('/api/admin/backups', auth, adminOnly, (req, res) => res.json(status()));
  app.post('/api/admin/backups/run', auth, adminOnly, async (req, res) => { const who = req.user ? (req.user.email || req.user.username || req.user.key) : 'admin'; res.json(Object.assign({ ok: true }, { last: await run(who, 'manual') })); });
  return { run, status, list };
};
