/**
 * Nova ChatBot widget shell — runs inside the iframe injected by embed.js.
 *
 * The chat itself is the ChatBot page: widget.html carries the same markup and
 * loads chatbot.js (in embed mode, window.NOVA_EMBED), so the bubble has the
 * same two panels, cart, calculator and saved items. This file is only what a
 * widget needs around it:
 *   - sign-in (the CRM's own session first, then a login form)
 *   - signing out when the CRM does
 *   - reopening the conversation after a CRM page change
 *   - recent chats and appearance settings in the header
 *   - talking to the host page (close, size, signed-in state)
 *
 * It shares globals with chatbot.js (token, username, me, currentChatId, esc,
 * clearChat, openChat, showApp). Classic scripts share one global scope, so a
 * name declared in both files is a SyntaxError — keep this file's own names
 * prefixed or clearly widget-only.
 *
 * Access is enforced server-side by the auth middleware; nothing here grants it.
 */

// A conversation is considered finished after this much silence. On returning the
// person is asked whether to continue it or start a fresh one, which keeps the
// saved history split into meaningful conversations rather than one endless thread.
const IDLE_MS = 5 * 60 * 1000;
const SESSION_KEY = 'novaChatSession';

function saveSession() {
  try {
    if (!currentChatId) { localStorage.removeItem(SESSION_KEY); return; }
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      chatId: currentChatId, lastAt: Date.now(), user: username || ''
    }));
  } catch (e) {}
}
function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.chatId) return null;
    // Don't hand one person's conversation to another on a shared machine.
    if (s.user && username && s.user !== username) return null;
    return s;
  } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function sessionIdleMs(s) {
  return s && s.lastAt ? (Date.now() - Number(s.lastAt)) : Infinity;
}

// chatbot.js calls this whenever the open chat changes or an answer lands.
window.NovaEmbedHooks = { chat: saveSession };

// Only ever true after the server has confirmed the token.
let wgAuthed = false;

function signOutLocal() {
  wgAuthed = false;
  token = null;
  me = null;
  try {
    localStorage.removeItem('axiom_via_crm');
    localStorage.removeItem('axiom_token');
  } catch (e) {}
  clearSession();
  document.getElementById('app').style.display = 'none';
  // Wipe what was on screen so the next person does not see it.
  try { clearChat(); } catch (e) {}
  currentChatId = null;
}

const PARENT_ORIGINS = [
  'https://axiomprint.com',
  'https://www.axiomprint.com',
  'https://crm.axiomprint.com'
];

function tellParent(msg) {
  PARENT_ORIGINS.forEach(o => { try { parent.postMessage(msg, o); } catch (e) {} });
}
function closeWidget() { tellParent({ type: 'nova:close' }); }

// ---- boot ----
// A stored token can be expired, revoked, or from a deleted account, so it is
// verified with /api/me before any chat is shown.
async function verifySession() {
  if (!token) { wgAuthed = false; return false; }
  try {
    const r = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (r.status === 401 || r.status === 403) throw new Error('unauthorized');
    if (!r.ok) throw new Error('unavailable');
    const j = await r.json();
    if (!j || !j.success) throw new Error('unauthorized');
    me = j;
    username = j.display_name || j.username || username;
    isAdmin = !!j.is_admin;
    try { localStorage.setItem('axiom_user', username); } catch (e) {}
    wgAuthed = true;
    return true;
  } catch (e) {
    signOutLocal();
    return false;
  }
}

// Sign in using the CRM's own session. Runs when the chat is opened, and always
// reports what happened — a silent failure just looks like a broken widget.
//   returns { ok, reason }
//   reasons: no-frame | no-token | rejected | no-access | unreachable | timeout
let ssoStatus = null;

function keepCrmLogin(j) {
  token = j.token;
  username = j.username || '';
  try {
    localStorage.setItem('axiom_token', token);
    localStorage.setItem('axiom_user', username);
    localStorage.setItem('axiom_admin', j.is_admin ? '1' : '0');
    // CRM-derived: this session should end when the CRM one does.
    localStorage.setItem('axiom_via_crm', '1');
  } catch (e) {}
}

function trySsoLogin() {
  return new Promise((resolve) => {
    if (window.self === window.top) return resolve({ ok: false, reason: 'no-frame' });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      resolve(v);
    };
    async function onMsg(ev) {
      // Signed handoff — no CRM API call needed.
      if (ev.data && ev.data.type === 'nova:sso-handoff') {
        try {
          const r = await fetch('/api/auth/handoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: ev.data.payload, sig: ev.data.sig })
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j && j.token) { keepCrmLogin(j); return done({ ok: true }); }
          return done({ ok: false, reason: r.status === 403 ? 'no-access' : 'rejected', detail: j.error });
        } catch (e) { return done({ ok: false, reason: 'unreachable', detail: e.message }); }
      }
      if (!ev.data || ev.data.type !== 'nova:sso-token') return;
      if (!ev.data.token) return done({ ok: false, reason: 'no-token', keys: ev.data.keys || [] });
      try {
        const r = await fetch('/api/auth/crm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crm_token: ev.data.token })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j && j.token) { keepCrmLogin(j); return done({ ok: true }); }
        // Carry the upstream detail through so the widget can say WHAT failed,
        // rather than sending someone to read server logs.
        const detail = (j.error || '') + (j.tried && j.tried.length ? ' — tried: ' + j.tried.join(', ') : '');
        if (r.status === 403) return done({ ok: false, reason: 'no-access', detail: j.error });
        if (r.status === 401) return done({ ok: false, reason: 'rejected', detail: detail });
        return done({ ok: false, reason: 'unreachable', detail: detail });
      } catch (e) {
        done({ ok: false, reason: 'unreachable', detail: e.message });
      }
    }
    window.addEventListener('message', onMsg);
    PARENT_ORIGINS.forEach(o => { try { parent.postMessage({ type: 'nova:need-sso' }, o); } catch (e) {} });
    setTimeout(() => done({ ok: false, reason: 'timeout' }), 4000);
  });
}

// Plain-English explanation, so a failure is actionable rather than mysterious.
function ssoMessage(st) {
  if (!st) return null;
  switch (st.reason) {
    case 'no-frame':     return null;   // opened directly, nothing to sign in from
    case 'no-token':     return 'Couldn’t find your CRM sign-in on this page' +
      ((st.keys && st.keys.length) ? ' (checked ' + st.keys.length + ' stored keys)' : '') +
      ', so please sign in below.';
    case 'rejected':     return (st.detail || 'The CRM didn’t accept that sign-in.') + ' Please sign in below.';
    case 'no-access':    return st.detail || 'You’re signed into the CRM, but not set up in Nova yet.';
    case 'unreachable':  return 'Couldn’t reach the CRM to check your sign-in. Please sign in below.';
    case 'timeout':      return 'The CRM didn’t respond, so please sign in below.';
    default:             return 'Automatic sign-in didn’t work. Please sign in below.';
  }
}

// Shown while the exchange is in flight, so the click clearly did something.
function showSsoWorking() {
  const note = document.getElementById('wgSsoNote');
  if (!note) return;
  note.style.display = 'block';
  note.className = 'wg-sso working';
  note.textContent = 'Signing you in from the CRM…';
}

function showSsoResult(st) {
  const note = document.getElementById('wgSsoNote');
  if (!note) return;
  const msg = ssoMessage(st);
  if (!msg) { note.style.display = 'none'; return; }
  note.style.display = 'block';
  note.className = 'wg-sso failed';
  note.innerHTML = esc(msg) + ' <button type="button" class="wg-sso-retry">Try again</button>';
  const rb = note.querySelector('.wg-sso-retry');
  if (rb) rb.onclick = () => runSso(true);
}

// The whole attempt: show it trying, then either open the chat or explain.
async function runSso(force) {
  if (!force && token && await verifySession()) { showChat(); return true; }
  showAuth();
  showSsoWorking();
  const st = await trySsoLogin();
  ssoStatus = st;
  if (st.ok && await verifySession()) { showChat(); return true; }
  showSsoResult(st);
  return false;
}

// ===== CRM sign-out follows through =====
// A Nova token lasts 30 days. If it came from the CRM and the person signs out
// there, leaving this chat signed in means an authenticated session sitting on
// an unattended machine. Ask the host page whether its token is still present.
let crmGoneChecks = 0;
function checkCrmStillSignedIn() {
  if (window.self === window.top) return;                 // not embedded
  if (!token) return;                                     // already signed out
  try { if (localStorage.getItem('axiom_via_crm') !== '1') return; }
  catch (e) { return; }                                   // not a CRM session

  let answered = false;
  function onMsg(ev) {
    if (!ev.data || ev.data.type !== 'nova:sso-token') return;
    answered = true;
    window.removeEventListener('message', onMsg);
    if (ev.data.token) { crmGoneChecks = 0; return; }      // still signed in
    // Two consecutive empty answers before acting — one blank reply during a
    // page transition should not throw someone out mid-sentence.
    if (++crmGoneChecks < 2) return;
    try {
      localStorage.removeItem('axiom_token');
      localStorage.removeItem('axiom_admin');
      localStorage.removeItem('axiom_via_crm');
    } catch (e) {}
    signOutLocal();
    showAuth();
    const note = document.getElementById('wgSsoNote');
    if (note) {
      note.style.display = 'block';
      note.className = 'wg-sso failed';
      note.textContent = 'You signed out of the CRM, so this chat signed out too.';
    }
  }
  window.addEventListener('message', onMsg);
  PARENT_ORIGINS.forEach(o => { try { parent.postMessage({ type: 'nova:need-sso' }, o); } catch (e) {} });
  setTimeout(() => { if (!answered) window.removeEventListener('message', onMsg); }, 3000);
}

// On open, and periodically while it sits there.
setInterval(checkCrmStillSignedIn, 60000);

// Re-verify each time the bubble is opened — the session may have expired while
// the page sat open, or the user may have signed out in another tab.
window.addEventListener('message', async (ev) => {
  if (!ev.data || ev.data.type !== 'nova:opened') return;
  checkCrmStillSignedIn();
  // Clicking the bubble is the moment to try the CRM again — the person may have
  // signed into the CRM since the page loaded.
  if (!(await verifySession())) { await runSso(true); return; }
  // Opened again after a long gap while the same page stayed loaded.
  const s = readSession();
  if (currentChatId && s && sessionIdleMs(s) >= IDLE_MS && !document.getElementById('wgResume')) {
    showResumePrompt(s);
  }
});

function signOutClick() {
  signOutLocal();
  try { localStorage.removeItem('axiom_user'); } catch (e) {}
  username = '';
  showAuth();
}

// ---- appearance preferences (saved against the signed-in user) ----
let wgPrefs = null;
let wgAccents = {};
let wgSaveTimer = null;
const WG_DEFAULT_PREFS = { scale: 1, side: 'right', accent: 'indigo', fontSize: 14, panelWidth: 1080, panelHeight: 700 };

async function loadPrefs() {
  try {
    const r = await fetch('/api/widget-prefs', { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    if (j.success) {
      wgPrefs = j.prefs; wgAccents = j.accents || {};
      if (j.defaults) Object.assign(WG_DEFAULT_PREFS, j.defaults);
      applyPrefs(); buildSettings();
    }
  } catch (e) {}
}

function applyPrefs() {
  if (!wgPrefs) return;
  const a = wgAccents[wgPrefs.accent];
  const root = document.documentElement.style;
  // The default theme is the ChatBot page's own colours, so the two look the
  // same; any other choice recolours the widget.
  if (a && wgPrefs.accent !== 'indigo') {
    root.setProperty('--indigo', a.main);
    root.setProperty('--indigo-dark', a.dark);
    root.setProperty('--indigo-light', a.light);
    root.setProperty('--violet', a.grad);
  } else {
    ['--indigo', '--indigo-dark', '--indigo-light', '--violet'].forEach(k => root.removeProperty(k));
  }
  root.setProperty('--chat-fs', wgPrefs.fontSize + 'px');
  // The panel and bubble live in the parent page, so pass the settings out.
  tellParent({ type: 'nova:prefs', prefs: wgPrefs, accentColors: a || null });
}

function savePrefs() {
  const msg = document.getElementById('wgSetMsg');
  if (msg) msg.textContent = 'Saving…';
  clearTimeout(wgSaveTimer);
  // Debounced: dragging a slider fires constantly.
  wgSaveTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/widget-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ prefs: wgPrefs })
      });
      const j = await r.json();
      if (msg) msg.textContent = j.success ? 'Saved' : 'Save failed';
      setTimeout(() => { if (msg && msg.textContent === 'Saved') msg.textContent = ''; }, 1600);
    } catch (e) { if (msg) msg.textContent = 'Save failed'; }
  }, 450);
}

function closeDrops(except) {
  ['wgHistPanel', 'wgSet'].forEach(id => {
    if (id === except) return;
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// Recent chats for THIS user. The list endpoint already filters on user_key,
// so nobody sees anyone else's conversations.
async function toggleHistory() {
  const panel = document.getElementById('wgHistPanel');
  if (!panel) return;
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  closeDrops('wgHistPanel');
  panel.style.display = 'block';
  const list = document.getElementById('wgHistList');
  list.innerHTML = '<div class="wg-hist-empty">Loading…</div>';
  try {
    const r = await fetch('/api/chats?agent=chatbot', { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    const chats = (j.chats || []).slice(0, 8);
    if (!chats.length) { list.innerHTML = '<div class="wg-hist-empty">No earlier chats yet.</div>'; return; }
    list.innerHTML = '';
    chats.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      const isOpen = Number(c.id) === Number(currentChatId);
      b.className = 'wg-hist-item' + (isOpen ? ' current' : '');
      b.innerHTML = '<div class="wg-hist-t">' + esc(c.title || 'Untitled chat') + '</div>' +
        '<div class="wg-hist-d">' + esc(whenLabel(c.updated_at || c.created_at)) +
        (isOpen ? ' · open now' : '') + '</div>';
      b.onclick = () => {
        panel.style.display = 'none';
        if (!isOpen) continueChat(c.id);
      };
      list.appendChild(b);
    });
  } catch (e) {
    list.innerHTML = '<div class="wg-hist-empty">Could not load your chats.</div>';
  }
}

// "12 minutes ago" reads better than a raw timestamp in a small panel.
function whenLabel(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return String(ts);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hrs / 24);
  if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function toggleSettings() {
  const el = document.getElementById('wgSet');
  const opening = el.style.display === 'none';
  if (opening) closeDrops('wgSet');
  el.style.display = opening ? 'block' : 'none';
}

// Clicking anywhere else closes the header drop-downs.
document.addEventListener('click', (e) => {
  if (e.target.closest && (e.target.closest('.wg-drop') || e.target.closest('.wg-head'))) return;
  closeDrops();
});

function buildSettings() {
  if (!wgPrefs) return;
  const bind = (id, valId, key, fmt, scaleTo) => {
    const el = document.getElementById(id), out = document.getElementById(valId);
    if (!el) return;
    el.value = scaleTo ? Math.round(wgPrefs[key] * 100) : wgPrefs[key];
    out.textContent = fmt(wgPrefs[key]);
    el.oninput = () => {
      wgPrefs[key] = scaleTo ? (Number(el.value) / 100) : Number(el.value);
      out.textContent = fmt(wgPrefs[key]);
      applyPrefs(); savePrefs();
    };
  };
  bind('setScale', 'setScaleV', 'scale', v => Math.round(v * 100) + '%', true);
  bind('setWidth', 'setWidthV', 'panelWidth', v => v + 'px');
  bind('setHeight', 'setHeightV', 'panelHeight', v => v + 'px');
  bind('setFont', 'setFontV', 'fontSize', v => v + 'px');

  const seg = document.getElementById('setSide');
  Array.from(seg.querySelectorAll('button')).forEach(b => {
    b.classList.toggle('on', b.dataset.v === wgPrefs.side);
    b.onclick = () => {
      wgPrefs.side = b.dataset.v;
      Array.from(seg.querySelectorAll('button')).forEach(x => x.classList.toggle('on', x === b));
      applyPrefs(); savePrefs();
    };
  });

  // Which build is this? Confirms at a glance whether the CRM picked up an upload.
  const foot = document.getElementById('wgSetMsg');
  if (foot && !foot.dataset.build) {
    fetch('/api/version').then(r => r.json()).then(v => {
      const b = document.getElementById('wgBuild');
      if (b) b.textContent = 'Nova ' + (v.version || '') + ' · build ' + String(v.build).slice(-6);
    }).catch(() => {});
    foot.dataset.build = '1';
  }

  const sw = document.getElementById('setAccent');
  sw.innerHTML = '';
  Object.keys(wgAccents).forEach(name => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wg-sw' + (name === wgPrefs.accent ? ' on' : '');
    b.title = name;
    b.style.background = 'linear-gradient(135deg,' + wgAccents[name].main + ',' + wgAccents[name].grad + ')';
    b.onclick = () => {
      wgPrefs.accent = name;
      Array.from(sw.children).forEach(x => x.classList.toggle('on', x === b));
      applyPrefs(); savePrefs();
    };
    sw.appendChild(b);
  });
}

function resetPrefs() {
  wgPrefs = Object.assign({}, WG_DEFAULT_PREFS);
  applyPrefs(); buildSettings(); savePrefs();
}

// After a gap, ask whether to pick up where they left off or start clean.
// Both choices are useful: continuing keeps context, starting fresh keeps the
// saved history readable as separate conversations.
function showResumePrompt(s) {
  const box = document.getElementById('messagesInner');
  if (!box || document.getElementById('wgResume')) return;
  const mins = Math.max(1, Math.round(sessionIdleMs(s) / 60000));
  const when = mins < 120 ? mins + ' minute' + (mins === 1 ? '' : 's')
             : Math.round(mins / 60) + ' hours';
  const el = document.createElement('div');
  el.className = 'wg-resume';
  el.id = 'wgResume';
  el.innerHTML =
    '<div class="wg-resume-t">You were here ' + when + ' ago</div>' +
    '<div class="wg-resume-s">Pick up that conversation, or start a new one?</div>' +
    '<div class="wg-resume-b">' +
      '<button type="button" class="wg-rs-go">Continue</button>' +
      '<button type="button" class="wg-rs-new">Start a new chat</button>' +
    '</div>';
  box.appendChild(el);
  el.querySelector('.wg-rs-go').onclick = () => { el.remove(); continueChat(s.chatId); };
  el.querySelector('.wg-rs-new').onclick = () => { el.remove(); startNewChat(); };
  scrollDown(true);
}

async function continueChat(chatId) {
  // A chat that no longer exists (or is someone else's) starts a fresh one.
  if (!(await openChat(chatId))) startNewChat();
}

function startNewChat() {
  closeDrops();
  clearSession();
  clearChat();
}

function setHeaderSignedIn(on) {
  ['wgOut', 'wgCog', 'wgNew', 'wgHist'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? (id === 'wgOut' ? 'inline-flex' : 'flex') : 'none';
  });
  document.getElementById('wgSub').textContent = on
    ? (username ? 'Signed in as ' + username : 'AxiomPrint knowledge')
    : 'Sign in required';
}

function showAuth() {
  document.getElementById('wgAuth').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  closeDrops();
  setHeaderSignedIn(false);
  tellParent({ type: 'nova:auth', signedIn: false });
  const note = document.getElementById('wgSsoNote');
  if (note && !ssoStatus) note.style.display = 'none';
  const u = document.getElementById('wgUser');
  if (u) setTimeout(() => u.focus(), 120);
}

['wgUser', 'wgPass'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
});

let wgShown = false;
function showChat() {
  document.getElementById('wgAuth').style.display = 'none';
  showApp();                                   // chatbot.js: reveals #app
  setHeaderSignedIn(true);
  if (!wgPrefs) loadPrefs();
  tellParent({ type: 'nova:auth', signedIn: true });
  const inner = document.getElementById('messagesInner');
  if (!currentChatId && !(inner && inner.children.length)) {
    const s = readSession();
    if (s && sessionIdleMs(s) < IDLE_MS) {
      // Still warm - a CRM page change reloads this iframe, so quietly pick the
      // conversation back up rather than making them choose every time.
      continueChat(s.chatId);
    } else {
      clearChat();                             // greeting and suggestion chips
      if (s) showResumePrompt(s);
    }
  }
  wgShown = true;
  setTimeout(() => { const i = document.getElementById('input'); if (i) i.focus(); }, 120);
}

async function doLogin() {
  const btn = document.getElementById('wgLoginBtn');
  const err = document.getElementById('wgErr');
  const u = document.getElementById('wgUser').value.trim();
  const p = document.getElementById('wgPass').value;
  if (!u || !p) { err.textContent = 'Enter your username and password.'; return; }
  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (!data.token) { err.textContent = data.error || 'Sign in failed.'; return; }
    token = data.token;
    username = data.username || u;
    isAdmin = !!data.is_admin;
    wgAuthed = true;
    try {
      localStorage.setItem('axiom_token', token);
      localStorage.setItem('axiom_user', username);
      localStorage.setItem('axiom_admin', data.is_admin ? '1' : '0');
    } catch (e) {}
    document.getElementById('wgPass').value = '';
    showChat();
  } catch (e) {
    err.textContent = 'Connection error.';
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

(async function init() {
  if (await verifySession()) { showChat(); return; }
  await runSso(false);
})();
