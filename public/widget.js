/**
 * Nova ChatBot widget — runs inside the iframe injected by embed.js.
 *
 * This page is served from nova.axiomprint.com, so it shares the same origin
 * (and therefore the same localStorage session) as the rest of Nova. A user who
 * is signed into Nova is signed in here; a user who is not gets a login form.
 * Access is enforced server-side by the auth middleware on /api/chatbot/chat —
 * nothing in this file grants anything.
 */
let token = localStorage.getItem('axiom_token');
let username = localStorage.getItem('axiom_user') || '';
let history = [];
let busy = false;
// Server-side chat id, so CRM conversations are saved to Nova exactly like the
// ones started on the ChatBot page. Without this the history is lost on close
// and there is nothing to review or rate.
let currentChatId = null;

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
// Only ever true after the server has confirmed the token. Nothing may be sent
// until it is. The server enforces this too (auth middleware on every endpoint);
// this just stops the UI offering a control that cannot work.
let authed = false;

function signOutLocal() {
  authed = false;
  token = null;
  me = null;
  try { localStorage.removeItem('axiom_via_crm'); } catch (e) {}
  history = [];
  currentChatId = null;
  clearSession();
  localStorage.removeItem('axiom_token');
  const box = document.getElementById('wgMsgs');
  if (box) box.innerHTML = '';
  const sg = document.getElementById('wgSugg');
  if (sg) sg.innerHTML = '';
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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- boot ----
// A stored token can be expired, revoked, or from a deleted account, so it is
// verified against the server before any chat UI is shown.
// Confirm the stored token with /api/me and learn who it belongs to. Using the
// dedicated endpoint (rather than piggybacking on another call) means a disabled
// account or an expired token is caught here, before any chat is shown.
let me = null;
async function verifySession() {
  if (!token) { authed = false; return false; }
  try {
    const r = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (r.status === 401 || r.status === 403) throw new Error('unauthorized');
    if (!r.ok) throw new Error('unavailable');
    const j = await r.json();
    if (!j || !j.success) throw new Error('unauthorized');
    me = j;
    username = j.display_name || j.username || username;
    try { localStorage.setItem('axiom_user', username); } catch (e) {}
    authed = true;
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
          if (r.ok && j && j.token) {
            token = j.token;
            username = j.username || '';
            try {
              localStorage.setItem('axiom_token', token);
              localStorage.setItem('axiom_user', username);
              localStorage.setItem('axiom_admin', j.is_admin ? '1' : '0');
              // CRM-derived: this session should end when the CRM one does.
              localStorage.setItem('axiom_via_crm', '1');
            } catch (e) {}
            return done({ ok: true });
          }
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
        if (r.ok && j && j.token) {
          token = j.token;
          username = j.username || '';
          try {
            localStorage.setItem('axiom_token', token);
            localStorage.setItem('axiom_user', username);
            localStorage.setItem('axiom_admin', j.is_admin ? '1' : '0');
            localStorage.setItem('axiom_via_crm', '1');
          } catch (e) {}
          return done({ ok: true });
        }
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
    case 'no-token':     return 'Couldn\u2019t find your CRM sign-in on this page' +
      ((st.keys && st.keys.length) ? ' (checked ' + st.keys.length + ' stored keys)' : '') +
      ', so please sign in below.';
    case 'rejected':     return (st.detail || 'The CRM didn\u2019t accept that sign-in.') + ' Please sign in below.';
    case 'no-access':    return st.detail || 'You\u2019re signed into the CRM, but not set up in Nova yet.';
    case 'unreachable':  return 'Couldn\u2019t reach the CRM to check your sign-in. Please sign in below.';
    case 'timeout':      return 'The CRM didn\u2019t respond, so please sign in below.';
    default:             return 'Automatic sign-in didn\u2019t work. Please sign in below.';
  }
}

// Shown while the exchange is in flight, so the click clearly did something.
function showSsoWorking() {
  const box = document.getElementById('wgAuth');
  if (!box) return;
  box.style.display = 'block';
  const note = document.getElementById('wgSsoNote');
  if (note) {
    note.style.display = 'block';
    note.className = 'wg-sso working';
    note.textContent = 'Signing you in from the CRM\u2026';
  }
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

// One implementation of the cards, shared with the ChatBot page.
// ===== Pinned client (widget) =====
// Same behaviour as the ChatBot page: one client per conversation, stored on the
// chat, so the agent stops asking and quotes carry the right discount.
let wgClientId = null;
let wgClientName = null;
let wgClientInfo = null;

function wgRenderClientBar() {
  const bar = document.getElementById('wgCbar');
  const label = document.getElementById('wgCbarLabel');
  if (!bar || !label) return;
  bar.classList.toggle('on', !!wgClientId);
  label.textContent = wgClientId ? (wgClientName || 'Client #' + wgClientId) : 'Connect to client';
}

function wgToggleClient() {
  const pop = document.getElementById('wgCbarPop');
  if (!pop) return;
  const open = pop.style.display !== 'none';
  if (!open) wgClosePopovers('wgCbarPop');
  pop.style.display = open ? 'none' : 'block';
  if (!open) {
    const q = document.getElementById('wgCbarSearch');
    if (q) { q.value = ''; setTimeout(() => q.focus(), 60); }
    // The pill is too narrow for the full account summary, so show it here —
    // same information the ChatBot page puts in its bar.
    const res = document.getElementById('wgCbarResults');
    const i = wgClientInfo;
    res.innerHTML = i
      ? '<div class="wg-cbar-info">' +
          '<b>' + esc(i.name || '') + (i.company ? ' <i>' + esc(i.company) + '</i>' : '') + '</b>' +
          '<small>' + [i.email, i.phone].filter(Boolean).map(esc).join(' · ') + '</small>' +
          '<small>' + [
            i.orders ? Number(i.orders).toLocaleString() + ' orders' : null,
            i.lifetime ? '$' + Number(i.lifetime).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' lifetime' : null,
            i.last_order ? 'last ' + esc(i.last_order) : null
          ].filter(Boolean).join(' · ') + '</small>' +
        '</div>'
      : '';
  }
}

let wgCbarTimer = null;
function wgClientSearch() {
  clearTimeout(wgCbarTimer);
  const q = document.getElementById('wgCbarSearch').value.trim();
  const box = document.getElementById('wgCbarResults');
  if (q.length < 2) { box.innerHTML = ''; return; }
  wgCbarTimer = setTimeout(async () => {
    box.innerHTML = '<div class="wg-cbar-empty">Searching…</div>';
    try {
      const r = await fetch('/api/chatbot/find-client?q=' + encodeURIComponent(q),
        { headers: { 'Authorization': 'Bearer ' + token } });
      const j = await r.json();
      if (!j.ok || !j.clients.length) { box.innerHTML = '<div class="wg-cbar-empty">No match.</div>'; return; }
      box.innerHTML = '';
      j.clients.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wg-cbar-row';
        b.innerHTML = '<span style="flex:1;min-width:0"><b>' + esc(c.name) + '</b>' +
          (c.company ? ' <i>' + esc(c.company) + '</i>' : '') +
          '<small>' + esc(c.email || '') + '</small></span>' +
          '<em>' + (c.orders || 0) + '</em>';
        b.onclick = () => wgSetClient(c.id, c.company ? (c.name + ' (' + c.company + ')') : c.name);
        box.appendChild(b);
      });
    } catch (e) { box.innerHTML = '<div class="wg-cbar-empty">Search failed.</div>'; }
  }, 280);
}

async function wgSetClient(id, name) {
  const pop = document.getElementById('wgCbarPop');
  if (!currentChatId) {
    wgClientId = id; wgClientName = name || null;
    wgRenderClientBar();
    if (pop) pop.style.display = 'none';
    return;
  }
  try {
    const r = await fetch('/api/chats/set-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_id: currentChatId, client_id: id })
    });
    const j = await r.json();
    if (j.ok) {
      wgClientId = j.client_id;
      wgClientName = j.client_name || name || null;
      wgClientInfo = j.info || null;
      wgRenderClientBar();
      // Anything already quoted was priced at list — bring it up to date.
      if (j.client_id && window.AxiomCards && AxiomCards.repriceAllForClient) {
        AxiomCards.repriceAllForClient(j.client_id, wgClientName);
      }
    }
  } catch (e) {}
  if (pop) pop.style.display = 'none';
}

async function wgLoadClient() {
  if (!currentChatId) { wgClientId = null; wgClientName = null; wgRenderClientBar(); return; }
  try {
    const r = await fetch('/api/chats/' + currentChatId + '/client',
      { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    wgClientId = j.client_id || null;
    wgClientName = j.client_name || null;
    wgClientInfo = j.info || null;
  } catch (e) {}
  wgRenderClientBar();
}

document.addEventListener('click', (e) => {
  const bar = document.getElementById('wgCbar');
  if (bar && !bar.contains(e.target)) {
    const pop = document.getElementById('wgCbarPop');
    if (pop) pop.style.display = 'none';
  }
});

// ===== Cart (widget) =====
// Same store as the ChatBot page — an item carted here shows there and vice
// versa, because both write to the conversation's cart.
// Follow the answer only while the person is already at the bottom. Yanking the
// view down while they are reading further up is the most irritating thing a
// streaming chat can do — and in a small panel it is worse.
// Card events that belong to an answer. Saved with the message so reopening a
// conversation rebuilds what was on screen, not just the sentence above it.
const WG_CARD_TYPES = ['job_card', 'price_quote', 'client_card', 'client_picks', 'product_cards',
                       'turnaround', 'choice_picks', 'option_picks', 'product_picks', 'install_quote', 'report'];

// A card with nothing in it is worse than no card. An empty client placeholder,
// a "WHICH CLIENT?" header over no options, a turnaround sentence with no dates —
// all of these rendered because the builder was called with an empty payload.
function cardHasContent(j) {
  switch (j.type) {
    case 'client_card':   return !!(j.client && (j.client.id || j.client.name));
    case 'client_picks':  return Array.isArray(j.clients) && j.clients.length > 0;
    case 'product_picks': return Array.isArray(j.products) && j.products.length > 0;
    case 'product_cards': return Array.isArray(j.products) && j.products.length > 0;
    case 'option_picks':  return Array.isArray(j.options) && j.options.length > 0;
    case 'choice_picks':  return Array.isArray(j.choices) && j.choices.length > 0;
    case 'turnaround':    return !!(j.data && (j.data.readyLabel || (j.data.timeline || []).length));
    case 'price_quote':   return !!(j.data && j.data.product);
    case 'job_card':      return !!(j.data && j.data.e_number);
    default:              return true;
  }
}

function wgRenderCard(box, j) {
  if (!cardHasContent(j)) return;
  // Hold a steady width from the first card onward, so the bubble doesn't start
  // narrow around a line of text and snap wider when the price card lands.
  box.classList.add('has-cards');
  switch (j.type) {
    case 'job_card':      box.appendChild(AxiomCards.jobCard(j.data || {})); break;
    case 'price_quote':   box.appendChild(AxiomCards.priceCard(Object.assign({ __replace: j.replace }, j.data || {}))); break;
    case 'client_card':   box.appendChild(AxiomCards.clientCard(j.client || {})); break;
    case 'client_picks':  box.appendChild(AxiomCards.clientPicks(j.clients || [], { replace: j.replace })); break;
    case 'product_cards': box.appendChild(AxiomCards.productCards(j.products || [], { calculating: j.calculating })); break;
    case 'turnaround':    box.appendChild(AxiomCards.turnaround(j.data || {})); break;
    case 'choice_picks':  box.appendChild(AxiomCards.choicePicks(j)); break;
    case 'option_picks':  box.appendChild(AxiomCards.optionPicks(j)); break;
    case 'product_picks':
      box.appendChild(AxiomCards.picks(j.products || [],
        { intent: j.intent, ask_about: j.ask_about, replace: j.replace }));
      break;
    case 'report':
      // Nova report — compact card here; "Full view" fills the widget panel.
      if (window.NovaReport) NovaReport.render(box, j, { getToken: () => token });
      break;
    case 'install_quote':
      // Installation / local delivery calculator — see install-calc.js.
      if (window.InstallCalc) InstallCalc.render(box, j, { getToken: () => token });
      break;
  }
  wgScroll();
}

let wgStick = true;
function wgScroll(force) {
  const b = document.getElementById('wgMsgs');
  if (!b) return;
  if (force || wgStick) b.scrollTop = b.scrollHeight;
}
document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('wgMsgs');
  if (!b) return;
  b.addEventListener('scroll', () => {
    wgStick = (b.scrollHeight - b.scrollTop - b.clientHeight) < 100;
  }, { passive: true });
});

let wgCart = [];

async function wgAddToCart(item) {
  if (!currentChatId) return false;
  try {
    const r = await fetch('/api/chats/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ chat_id: currentChatId }, item))
    });
    const j = await r.json();
    if (j.ok) { await wgLoadCart(); return true; }
  } catch (e) {}
  return false;
}

async function wgLoadCart() {
  if (!currentChatId) { wgCart = []; wgRenderCart(); return; }
  try {
    const r = await fetch('/api/chats/' + currentChatId + '/cart',
      { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    wgCart = j.items || [];
  } catch (e) { wgCart = []; }
  wgRenderCart();
}

function wgRenderCart() {
  const pill = document.getElementById('wgCartPill');
  if (!pill) return;
  if (!wgCart.length) {
    pill.style.display = 'none';
    const pop = document.getElementById('wgCartPop');
    if (pop) pop.style.display = 'none';
    return;
  }
  pill.style.display = 'inline-flex';
  document.getElementById('wgCartCount').textContent = wgCart.length;
  const total = wgCart.reduce((a, b) => a + (Number(b.price) || 0), 0);
  document.getElementById('wgCartTotal').textContent = '$' + total.toFixed(2);
  const pop = document.getElementById('wgCartPop');
  if (pop && pop.style.display !== 'none') wgDrawCart();
}

function wgDrawCart() {
  const pop = document.getElementById('wgCartPop');
  const total = wgCart.reduce((a, b) => a + (Number(b.price) || 0), 0);
  pop.innerHTML = wgCart.map(it =>
    '<div class="wg-cart-row">' +
      (it.image ? '<img src="' + esc(it.image) + '" alt="" onerror="this.remove()">'
                : '<span class="wg-cart-ph"></span>') +
      '<span class="wg-cart-b"><b>' + esc(it.product || '') + '</b><small>Qty ' +
        Number(it.quantity || 0).toLocaleString() +
        (it.summary ? ' · ' + esc(it.summary) : '') + '</small></span>' +
      '<span class="wg-cart-p">$' + Number(it.price || 0).toFixed(2) + '</span>' +
      '<button type="button" class="wg-cart-x" data-id="' + it.id + '">✕</button>' +
    '</div>').join('') +
    '<div class="wg-cart-ft"><span>Total</span><span>$' + total.toFixed(2) + '</span></div>' +
    '<button type="button" class="wg-cart-order" onclick="wgOpenCartOrder()">Order all ' +
      wgCart.length + ' items</button>' +
    '<div class="wg-cart-form" id="wgCartForm" style="display:none"></div>';
  pop.querySelectorAll('.wg-cart-x').forEach(b => {
    b.onclick = async () => {
      await fetch('/api/chats/cart/' + b.getAttribute('data-id'),
        { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
      wgLoadCart();
    };
  });
}

// One order, several estimates — same endpoint the ChatBot page uses.
async function wgOpenCartOrder() {
  if (!wgClientId) { alert('Connect the client first.'); return; }
  const box = document.getElementById('wgCartForm');
  box.style.display = 'block';
  box.innerHTML = '<div style="color:var(--muted);font-size:11px">Loading…</div>';
  let cfg = { choices: [] }, dflt = {};
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/chatbot/order-fields?client_id=' + wgClientId,
        { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch('/api/chatbot/order-defaults?client_id=' + wgClientId,
        { headers: { 'Authorization': 'Bearer ' + token } })
    ]);
    cfg = await r1.json(); dflt = await r2.json();
  } catch (e) {}

  const sel = (key, val) => {
    const c = (cfg.choices || []).find(x => x.key === key);
    if (!c) return '';
    return '<select data-f="' + key + '">' + c.options.map(o =>
      '<option value="' + esc(o.value) + '"' +
      ((val || c.default) === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
      '</select>';
  };

  box.innerHTML =
    cwCartItemsHtml(sel, dflt) +
    '<div class="wg-cf-foot"><span id="wgCartMsg"></span>' +
      '<button type="button" class="wg-cart-order" onclick="wgSubmitCartOrder(this)">Place order</button></div>';
}

function cwCartItemsHtml(sel, dflt) {
  return wgCart.map((it, i) =>
    '<div class="wg-cf-item" data-cart="' + it.id + '">' +
      '<div class="wg-cf-t">' + (i + 1) + '. ' + esc(it.product) + '</div>' +
      '<label>Job name<input type="text" data-f="job_name" placeholder="What this job is called"></label>' +
      '<label>Needed by<input type="date" data-f="needed_by" value="' +
        esc(it.ready_date || (dflt.needed_by || '').slice(0, 10)) + '"></label>' +
      (it.turnaround ? '<div class="wg-cf-turn">' + esc(it.turnaround) + '</div>' : '') +
      '<label>Delivery' + sel('shipping_method', dflt.shipping_method) + '</label>' +
      '<label>Artwork' + sel('design_type') + '</label>' +
      '<label>Proof' + sel('proofing') + '</label>' +
    '</div>').join('');
}

async function wgSubmitCartOrder(btn) {
  const box = document.getElementById('wgCartForm');
  const msg = document.getElementById('wgCartMsg');
  const items = Array.from(box.querySelectorAll('.wg-cf-item')).map(el => {
    const o = { cart_id: Number(el.getAttribute('data-cart')) };
    el.querySelectorAll('[data-f]').forEach(i => { o[i.getAttribute('data-f')] = i.value; });
    return o;
  });
  if (items.some(i => !String(i.job_name || '').trim())) {
    msg.textContent = 'Give every item a job name.'; return;
  }
  btn.disabled = true; msg.textContent = 'Placing…';
  try {
    const r = await fetch('/api/chatbot/order-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_id: currentChatId, client_id: wgClientId, items: items })
    });
    const j = await r.json();
    if (!j.ok) {
      btn.disabled = false;
      msg.textContent = j.missing ? j.missing.join('; ') : (j.error || 'Could not place it');
      return;
    }
    box.innerHTML = '<div class="wg-cf-done">\u2713 Ordered ' + j.count + ' item' +
      (j.count === 1 ? '' : 's') +
      (j.e_numbers && j.e_numbers.length ? ' \u2014 ' + j.e_numbers.join(', ') : '') + '</div>';
    wgLoadCart();
  } catch (e) { btn.disabled = false; msg.textContent = 'Could not place it.'; }
}

// The cart and the client picker occupy the same corner. Opening one must close
// the other, or the second opens underneath and looks broken.
function wgClosePopovers(except) {
  ['wgCartPop', 'wgCbarPop'].forEach(id => {
    if (id === except) return;
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function wgToggleCart() {
  const pop = document.getElementById('wgCartPop');
  if (!pop) return;
  if (pop.style.display === 'none') {
    wgClosePopovers('wgCartPop');
    wgDrawCart();
    pop.style.display = 'block';
  } else pop.style.display = 'none';
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
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'nova:opened') checkCrmStillSignedIn();
});

AxiomCards.init({
  getToken: () => token,
  ask: (t) => ask(t),
  scroll: () => wgScroll(),
  pinClient: (id, name) => wgSetClient(id, name),
  addToCart: (item) => wgAddToCart(item)
});

(async function init() {
  if (await verifySession()) { showChat(); return; }
  await runSso(false);
})();

// Re-verify each time the bubble is opened — the session may have expired while
// the page sat open, or the user may have signed out in another tab.
window.addEventListener('message', async (ev) => {
  if (!ev.data || ev.data.type !== 'nova:opened') return;
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
  localStorage.removeItem('axiom_user');
  username = '';
  showAuth();
}

// ---- appearance preferences (saved against the signed-in user) ----
let prefs = null;
let accents = {};
let saveTimer = null;

async function loadPrefs() {
  try {
    const r = await fetch('/api/widget-prefs', { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    if (j.success) { prefs = j.prefs; accents = j.accents || {}; applyPrefs(); buildSettings(); }
  } catch (e) {}
}

function applyPrefs() {
  if (!prefs) return;
  const a = accents[prefs.accent];
  if (a) {
    const root = document.documentElement.style;
    root.setProperty('--indigo', a.main);
    root.setProperty('--indigo-dark', a.dark);
    root.setProperty('--indigo-light', a.light);
    document.querySelector('.wg-head').style.background =
      'linear-gradient(120deg,' + a.main + ',' + a.grad + ')';
  }
  document.documentElement.style.setProperty('--chat-fs', prefs.fontSize + 'px');
  // The panel and bubble live in the parent page, so pass the settings out.
  tellParent({ type: 'nova:prefs', prefs: prefs, accentColors: a || null });
}

function savePrefs() {
  const msg = document.getElementById('wgSetMsg');
  if (msg) msg.textContent = 'Saving…';
  clearTimeout(saveTimer);
  // Debounced: dragging a slider fires constantly.
  saveTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/widget-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ prefs: prefs })
      });
      const j = await r.json();
      if (msg) msg.textContent = j.success ? 'Saved' : 'Save failed';
      setTimeout(() => { if (msg && msg.textContent === 'Saved') msg.textContent = ''; }, 1600);
    } catch (e) { if (msg) msg.textContent = 'Save failed'; }
  }, 450);
}

// Recent chats for THIS user. The list endpoint already filters on user_key,
// so nobody sees anyone else's conversations.
async function toggleHistory() {
  const panel = document.getElementById('wgHistPanel');
  if (!panel) return;
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  const settings = document.getElementById('wgSet');
  if (settings) settings.style.display = 'none';
  panel.style.display = 'block';
  const list = document.getElementById('wgHistList');
  list.innerHTML = '<div class="wg-hist-empty">Loading…</div>';
  try {
    const r = await fetch('/api/chats?agent=chatbot', { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    const chats = (j.chats || []).slice(0, 5);
    if (!chats.length) { list.innerHTML = '<div class="wg-hist-empty">No earlier chats yet.</div>'; return; }
    list.innerHTML = '';
    chats.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wg-hist-item' + (Number(c.id) === Number(currentChatId) ? ' current' : '');
      b.innerHTML = '<div class="wg-hist-t">' + esc(c.title || 'Untitled chat') + '</div>' +
        '<div class="wg-hist-d">' + esc(whenLabel(c.updated_at || c.created_at)) +
        (Number(c.id) === Number(currentChatId) ? ' · open now' : '') + '</div>';
      b.onclick = () => {
        panel.style.display = 'none';
        if (Number(c.id) === Number(currentChatId)) return;
        continueChat(c.id);
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
  const hist = document.getElementById('wgHistPanel');
  if (opening && hist) hist.style.display = 'none';
  el.style.display = opening ? 'block' : 'none';
}

function buildSettings() {
  if (!prefs) return;
  const bind = (id, valId, key, fmt, scaleTo) => {
    const el = document.getElementById(id), out = document.getElementById(valId);
    if (!el) return;
    el.value = scaleTo ? Math.round(prefs[key] * 100) : prefs[key];
    out.textContent = fmt(prefs[key]);
    el.oninput = () => {
      prefs[key] = scaleTo ? (Number(el.value) / 100) : Number(el.value);
      out.textContent = fmt(prefs[key]);
      applyPrefs(); savePrefs();
    };
  };
  bind('setScale', 'setScaleV', 'scale', v => Math.round(v * 100) + '%', true);
  bind('setWidth', 'setWidthV', 'panelWidth', v => v + 'px');
  bind('setHeight', 'setHeightV', 'panelHeight', v => v + 'px');
  bind('setFont', 'setFontV', 'fontSize', v => v + 'px');

  const seg = document.getElementById('setSide');
  Array.from(seg.querySelectorAll('button')).forEach(b => {
    b.classList.toggle('on', b.dataset.v === prefs.side);
    b.onclick = () => {
      prefs.side = b.dataset.v;
      Array.from(seg.querySelectorAll('button')).forEach(x => x.classList.toggle('on', x === b));
      applyPrefs(); savePrefs();
    };
  });

  // Which build is this? Confirms at a glance whether the CRM picked up an upload.
  const foot = document.getElementById('wgSetMsg');
  if (foot && !foot.dataset.build) {
    fetch('/api/version').then(r => r.json()).then(v => {
      const b = document.getElementById('wgBuild');
      if (b) b.textContent = 'build ' + String(v.build).slice(-6) +
        ' · ' + new Date(v.build).toLocaleString();
    }).catch(() => {});
    foot.dataset.build = '1';
  }

  const sw = document.getElementById('setAccent');
  sw.innerHTML = '';
  Object.keys(accents).forEach(name => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wg-sw' + (name === prefs.accent ? ' on' : '');
    b.title = name;
    b.style.background = 'linear-gradient(135deg,' + accents[name].main + ',' + accents[name].grad + ')';
    b.onclick = () => {
      prefs.accent = name;
      Array.from(sw.children).forEach(x => x.classList.toggle('on', x === b));
      applyPrefs(); savePrefs();
    };
    sw.appendChild(b);
  });
}

function resetPrefs() {
  prefs = { scale: 1, side: 'right', accent: 'indigo', fontSize: 14, panelWidth: 480, panelHeight: 560 };
  applyPrefs(); buildSettings(); savePrefs();
}

// After a gap, ask whether to pick up where they left off or start clean.
// Both choices are useful: continuing keeps context, starting fresh keeps the
// saved history readable as separate conversations.
function showResumePrompt(s) {
  const box = document.getElementById('wgMsgs');
  if (!box || document.getElementById('wgResume')) return;
  const mins = Math.max(1, Math.round(sessionIdleMs(s) / 60000));
  const el = document.createElement('div');
  el.className = 'wg-resume';
  el.id = 'wgResume';
  el.innerHTML =
    '<div class="wg-resume-t">You were here ' + mins + ' minute' + (mins === 1 ? '' : 's') + ' ago</div>' +
    '<div class="wg-resume-s">Pick up that conversation, or start a new one?</div>' +
    '<div class="wg-resume-b">' +
      '<button type="button" class="wg-rs-go">Continue</button>' +
      '<button type="button" class="wg-rs-new">Start a new chat</button>' +
    '</div>';
  box.appendChild(el);
  el.querySelector('.wg-rs-go').onclick = () => { el.remove(); continueChat(s.chatId); };
  el.querySelector('.wg-rs-new').onclick = () => { el.remove(); startNewChat(); };
  wgScroll();
}

async function continueChat(chatId) {
  const box = document.getElementById('wgMsgs');
  try {
    const r = await fetch('/api/chats/' + chatId, { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    if (!j.success) { startNewChat(); return; }
    currentChatId = chatId;
    history = [];
    wgLoadClient();
    wgLoadCart();
    box.innerHTML = '';
    document.getElementById('wgSugg').innerHTML = '';
    (j.messages || []).forEach(m => {
      if (!m.content) return;
      history.push({ role: m.role, content: m.content });
      const el = addMsg(m.role === 'assistant' ? 'ai' : 'me', m.content);
      // Rebuild the cards shown with this answer — matches, price cards,
      // timelines. Without them an old chat reads as "Which one?" and nothing.
      (m.cards || []).forEach(c => { try { wgRenderCard(el, c); } catch (e) {} });
      // Restore rating buttons so an old answer can still be marked good or bad
      if (m.role === 'assistant' && m.id) el.appendChild(AxiomCards.rating(m.id, m.rating));
    });
    saveSession();
    wgScroll();
  } catch (e) { startNewChat(); }
}

function startNewChat() {
  currentChatId = null;
  history = [];
  wgClientId = null;
  wgClientName = null;
  wgClientInfo = null;
  wgCart = [];
  wgRenderClientBar();
  wgRenderCart();
  clearSession();
  const box = document.getElementById('wgMsgs');
  if (box) box.innerHTML = '';
  greet();
}

function showAuth() {
  document.getElementById('wgAuth').style.display = 'flex';
  document.getElementById('wgChat').style.display = 'none';
  document.getElementById('wgSub').textContent = 'Sign in required';
  const out = document.getElementById('wgOut');
  if (out) out.style.display = 'none';
  const cog = document.getElementById('wgCog');
  if (cog) cog.style.display = 'none';
  const nw = document.getElementById('wgNew');
  if (nw) nw.style.display = 'none';
  const hb = document.getElementById('wgHist');
  if (hb) hb.style.display = 'none';
  const hp = document.getElementById('wgHistPanel');
  if (hp) hp.style.display = 'none';
  const setp = document.getElementById('wgSet');
  if (setp) setp.style.display = 'none';
  tellParent({ type: 'nova:auth', signedIn: false });
  const note = document.getElementById('wgSsoNote');
  if (note && !ssoStatus) note.style.display = 'none';
  const u = document.getElementById('wgUser');
  if (u) setTimeout(() => u.focus(), 120);
  ['wgUser', 'wgPass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });
}

function showChat() {
  document.getElementById('wgAuth').style.display = 'none';
  document.getElementById('wgChat').style.display = 'flex';
  document.getElementById('wgSub').textContent = username ? ('Signed in as ' + username) : 'AxiomPrint knowledge';
  const out = document.getElementById('wgOut');
  if (out) out.style.display = 'block';
  const cog = document.getElementById('wgCog');
  if (cog) cog.style.display = 'flex';
  const nw = document.getElementById('wgNew');
  if (nw) nw.style.display = 'flex';
  const hb = document.getElementById('wgHist');
  if (hb) hb.style.display = 'flex';
  if (!prefs) loadPrefs();
  initSpeech();
  tellParent({ type: 'nova:auth', signedIn: true });
  if (!history.length && !currentChatId) {
    const s = readSession();
    if (s && sessionIdleMs(s) < IDLE_MS) {
      // Still warm - a page navigation reloads this iframe, so quietly pick the
      // conversation back up rather than making them choose every time.
      continueChat(s.chatId);
    } else if (s) {
      greet();
      showResumePrompt(s);
    } else {
      greet();
    }
  }
  setTimeout(() => { const i = document.getElementById('wgInput'); if (i) i.focus(); }, 120);
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
    authed = true;
    localStorage.setItem('axiom_token', token);
    localStorage.setItem('axiom_user', username);
    localStorage.setItem('axiom_admin', data.is_admin ? '1' : '0');
    document.getElementById('wgPass').value = '';
    showChat();
  } catch (e) {
    err.textContent = 'Connection error.';
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

function greet() {
  addMsg('ai', "Hi! Ask me anything about AxiomPrint \u2014 products and their options, pricing, or what the team agreed in training.");
  const sg = document.getElementById('wgSugg');
  // Short labels; a click asks the full question.
  const ex = [['Quote an install', 'I need an installation quote'],
              ['Postcard papers', 'Paper options for postcards?'],
              ['Card turnaround', 'Turnaround for business cards?']];
  sg.innerHTML = ex.map(([label, q]) =>
    '<button class="wg-chip" title="' + esc(q) + '" data-q="' + esc(q) + '" onclick="ask(this.dataset.q)">' + esc(label) + '</button>').join('');
}

// A click on a card must always go through. wgSend() bails while a turn is still
// streaming, so calling it directly swallowed the click and left the text
// stranded in the composer — the card looked dead.
function ask(t, tries) {
  const i = document.getElementById('wgInput');
  if (i) i.value = t;
  if (busy) {
    if ((tries || 0) > 100) return;          // ~20s, then give up rather than loop
    setTimeout(() => ask(t, (tries || 0) + 1), 200);
    return;
  }
  wgSend();
}

// ---- pasted / attached images ----
// A screenshot of a client email, a spec sheet or a proof is often faster than
// typing it out. Pasted images are sent to the model as image content blocks
// and treated exactly like typed information.
// Attachments live in the shared module, so the widget and the ChatBot page
// handle files identically.
if (window.AxiomFiles) AxiomFiles.init({ getToken: () => token, pendingEl: 'wgPending' });


function wgPaste(e) { AxiomFiles.paste(e); }

// Wire dictation once the composer exists. Chrome/Edge only — the module hides
// the button where the browser can't do it.
function initSpeech() {
  if (!global_speechDone && window.AxiomSpeech) {
    global_speechDone = true;
    window.AxiomSpeech.attach({
      button: document.getElementById('wgMic'),
      input: document.getElementById('wgInput'),
      onInput: () => wgResize(document.getElementById('wgInput')),
      onError: (m, info) => {
        const box = document.getElementById('wgMsgs');
        if (!box) return;
        const d = document.createElement('div');
        d.className = 'wg-msg ai';
        d.innerHTML = esc(m) +
          ((info && info.inFrame)
            ? '<div class="wg-mic-alt"><a href="/chatbot" target="_blank" rel="noopener">' +
              'Open the chat in its own tab</a> — dictation always works there.</div>'
            : '');
        box.appendChild(d);
        wgScroll();
      }
    });
  }
}
let global_speechDone = false;

function wgResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 110) + 'px';
}
function wgKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); wgSend(); }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest ? e.target.closest('.wg-enum') : null;
  if (!b) return;
  e.preventDefault();
  wgHidePeek();
  ask('Show me job E' + b.getAttribute('data-e'));
});

// Hover preview for E-numbers: product, photo, status. Cached per job.
const wgPeekCache = {};
let wgPeekBox = null, wgPeekTimer = null, wgPeekFor = null;

function wgHidePeek() {
  clearTimeout(wgPeekTimer);
  wgPeekFor = null;
  if (wgPeekBox) { wgPeekBox.remove(); wgPeekBox = null; }
}

async function wgShowPeek(el, eNum) {
  wgPeekFor = eNum;
  let data = wgPeekCache[eNum];
  if (!data) {
    try {
      const r = await fetch('/api/chatbot/job-peek?e=' + encodeURIComponent(eNum), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      data = await r.json();
      wgPeekCache[eNum] = data;
    } catch (e) { return; }
  }
  if (wgPeekFor !== eNum || !data || !data.ok) return;
  if (wgPeekBox) { wgPeekBox.remove(); wgPeekBox = null; }
  wgPeekBox = document.createElement('div');
  wgPeekBox.className = 'wg-jp wg-jp-' + (data.stage || 'prepress');
  wgPeekBox.innerHTML =
    (data.image ? '<img src="' + esc(data.image) + '" alt="" onerror="this.remove()">' : '') +
    '<div class="wg-jp-b"><div class="wg-jp-p">' + esc(data.product || data.name || 'Job') + '</div>' +
    '<div class="wg-jp-m">' + esc([data.client, data.created].filter(Boolean).join(' \u00b7 ')) + '</div>' +
    '<div class="wg-jp-s">' + esc(data.status || '') + '</div></div>';
  document.body.appendChild(wgPeekBox);
  const r = el.getBoundingClientRect();
  const w = 190, h = wgPeekBox.offsetHeight || 130;
  let left = Math.min(Math.max(6, r.left), window.innerWidth - w - 6);
  let top = r.top - h - 8;
  if (top < 6) top = Math.min(r.bottom + 8, window.innerHeight - h - 6);
  wgPeekBox.style.left = left + 'px';
  wgPeekBox.style.top = top + 'px';
}

document.addEventListener('mouseover', (e) => {
  const b = e.target.closest ? e.target.closest('.wg-enum') : null;
  if (!b) return;
  clearTimeout(wgPeekTimer);
  const eNum = b.getAttribute('data-e');
  wgPeekTimer = setTimeout(() => wgShowPeek(b, eNum), 220);
});
document.addEventListener('mouseout', (e) => {
  const b = e.target.closest ? e.target.closest('.wg-enum') : null;
  if (b) wgHidePeek();
});
window.addEventListener('scroll', wgHidePeek, true);


let wgLastClientId = null;

// Open a product straight into an editable price card on its own defaults.
// Kept for a context-free open; the "Price it" chip goes through the model so
// specs already given in the chat are applied.
async function wgOpenCalculator(productId, name) {
  const box = document.getElementById('wgMsgs');
  const holder = document.createElement('div');
  holder.className = 'wg-msg ai';
  holder.innerHTML = '<div class="calc-loading">Pricing ' + esc(name || 'it') + '\u2026</div>';
  box.appendChild(holder);
  wgScroll();
  try {
    const r = await fetch('/api/chatbot/reprice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ product_id: productId, chat_id: currentChatId, client_id: wgClientId || undefined })
    });
    const j = await r.json();
    if (!j.ok || !j.data) {
      holder.innerHTML = '<div class="calc-loading">Could not price that one.</div>';
      return;
    }
    holder.innerHTML = '';
    holder.appendChild(AxiomCards.priceCard(j.data));
    wgScroll();
  } catch (e) {
    holder.innerHTML = '<div class="calc-loading">Could not price that one.</div>';
  }
}


function addMsg(role, text) {
  const box = document.getElementById('wgMsgs');
  const d = document.createElement('div');
  d.className = 'wg-msg ' + (role === 'ai' ? 'ai' : 'me');
  if (role === 'ai') d.innerHTML = md(text); else d.textContent = text;
  box.appendChild(d);
  wgScroll();
  return d;
}

async function wgSend() {
  if (busy) return;
  // Hard gate: nothing leaves this widget without a verified session.
  if (!authed || !token) { showAuth(); return; }
  const input = document.getElementById('wgInput');
  const text = input.value.trim();
  wgStick = true;              // sending is an explicit "take me to the bottom"
  const hasFiles = (window.AxiomFiles && AxiomFiles.count()) || 0;
  if (!text && !hasFiles) return;
  const imgs = hasFiles ? AxiomFiles.take() : [];
  input.value = ''; wgResize(input);
  document.getElementById('wgSugg').innerHTML = '';

  // Show what was sent.
  const usable = imgs.filter(im => im.kind !== 'error' && im.kind !== 'pending');
  const shown = addMsg('me', text || '(attachment)');
  if (usable.length && shown) {
    const strip = document.createElement('div');
    strip.className = 'wg-sent-imgs';
    strip.innerHTML = usable.map(im => im.kind === 'image' || (!im.kind && im.data)
      ? '<img src="data:' + im.media_type + ';base64,' + im.data + '" alt="">'
      : '<span class="wg-sent-file">' + (im.kind === 'pdf' ? '📄' : '📎') + ' ' + esc(im.name || 'file') + '</span>'
    ).join('');
    shown.appendChild(strip);
  }

  // Images and PDFs go as native blocks; extracted file text goes as text so the
  // model can read spreadsheets and documents the same way.
  if (usable.length) {
    const parts = [];
    usable.forEach(im => {
      if (im.kind === 'pdf') {
        parts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: im.data } });
      } else if (im.kind === 'file') {
        parts.push({ type: 'text', text: 'Attached file "' + (im.name || 'file') + '":\n\n' + (im.text || '') });
      } else {
        parts.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
      }
    });
    parts.push({ type: 'text', text: text || 'Read the attached file(s) and use them for the task at hand.' });
    history.push({ role: 'user', content: parts });
  } else {
    history.push({ role: 'user', content: text });
  }
  const savedText = text || ('[attached: ' + usable.map(i => i.name || 'file').join(', ') + ']');

  // Save to Nova so the conversation is reviewable later. Marked with source
  // 'crm-widget' so widget chats can be told apart from ChatBot page chats.
  if (!currentChatId) {
    try {
      const r = await fetch('/api/chats/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ agent_slug: 'chatbot', title: savedText.slice(0, 120), source: 'crm-widget' })
      });
      const j = await r.json();
      if (j.success) {
        currentChatId = j.chat_id;
        if (wgClientId) wgSetClient(wgClientId, wgClientName);
        saveSession();
      }
    } catch (e) {}
  }
  if (currentChatId) {
    fetch('/api/chats/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_id: currentChatId, role: 'user', content: savedText })
    }).catch(() => {});
    saveSession();
  }

  busy = true;
  document.getElementById('wgSend').disabled = true;
  const box = document.getElementById('wgMsgs');
  const dots = document.createElement('div');
  dots.className = 'wg-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  box.appendChild(dots);
  wgScroll();

  let bubble = null, full = '';
  const turnCards = [];   // cards drawn in this answer, saved alongside it
  try {
    const res = await fetch('/api/chatbot/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messages: history, chat_id: currentChatId })
    });
    if (res.status === 401 || res.status === 403) {
      dots.remove();
      signOutLocal();
      showAuth();
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let j;
        try { j = JSON.parse(line.slice(6)); } catch (e) { continue; }

        if (j.type === 'query') {
          const s = document.createElement('div');
          s.className = 'wg-step';
          s.textContent = '\u25cf ' + (j.description || 'Looking that up');
          // The dots may already have been removed once text started streaming,
          // so never insertBefore them — just append and keep the dots last.
          box.appendChild(s);
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
        } else if (WG_CARD_TYPES.indexOf(j.type) > -1) {
          if (dots.parentNode) dots.remove();
          turnCards.push(j.type === 'report' && window.NovaReport ? NovaReport.toSaved(j) : j);
          wgRenderCard(box, j);
          if (dots.parentNode === box) box.appendChild(dots);
        } else if (j.type === 'client_pinned') {
          wgClientId = j.client_id;
          wgClientName = j.client_name || wgClientName;
          wgRenderClientBar();
          if (window.AxiomCards && AxiomCards.repriceAllForClient) {
            AxiomCards.repriceAllForClient(j.client_id, wgClientName);
          }
          if (dots.parentNode) dots.remove();
          if (j.client && j.client.id) wgLastClientId = j.client.id;
          box.appendChild(AxiomCards.clientCard(j.client || {}));
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
          if (dots.parentNode) dots.remove();
          box.appendChild(AxiomCards.clientPicks(j.clients || [], { replace: j.replace }));
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
          if (dots.parentNode) dots.remove();
          box.appendChild(AxiomCards.productCards(j.products || [], { calculating: j.calculating }));
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
          if (dots.parentNode) dots.remove();
          box.appendChild(AxiomCards.turnaround(j.data || {}));
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
          if (dots.parentNode) dots.remove();
          box.appendChild(AxiomCards.optionPicks(j));
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
          if (dots.parentNode) dots.remove();
          box.appendChild(AxiomCards.choicePicks(j));
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
          if (dots.parentNode) dots.remove();
          box.appendChild(AxiomCards.picks(j.products || [], { intent: j.intent, ask_about: j.ask_about, replace: j.replace }));
          if (dots.parentNode === box) box.appendChild(dots);
          wgScroll();
        } else if (j.type === 'text') {
          if (dots.parentNode) dots.remove();
          if (!bubble) bubble = addMsg('ai', '');
          full += j.text;
          bubble.innerHTML = md(full);
          wgScroll();
        } else if (j.type === 'done') {
          if (dots.parentNode) dots.remove();
          if (!bubble && j.text) { bubble = addMsg('ai', j.text); full = j.text; }
        } else if (j.type === 'error') {
          if (dots.parentNode) dots.remove();
          addMsg('ai', 'Something went wrong: ' + (j.error || 'unknown error'));
        }
      }
    }
    if (full) {
      history.push({ role: 'assistant', content: full });
      // Persist the answer and attach rating buttons, so quality can be reviewed
      // and good answers can feed back into training.
      if (currentChatId) {
        try {
          const r = await fetch('/api/chats/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ chat_id: currentChatId, role: 'assistant', content: full, cards: turnCards })
          });
          const j = await r.json();
          if (j.success && j.message_id && bubble) bubble.appendChild(AxiomCards.rating(j.message_id));
          saveSession();
        } catch (e) {}
      }
    }
  } catch (e) {
    if (dots.parentNode) dots.remove();
    addMsg('ai', 'Connection error. Try again.');
  } finally {
    if (dots.parentNode) dots.remove();
    busy = false;
    document.getElementById('wgSend').disabled = false;
    document.getElementById('wgInput').focus();
  }
}

// ---- minimal markdown: tables, lists, bold, code, links, images ----
function md(text) {
  const lines = String(text || '').split('\n');
  let out = '', tbl = [];
  const flushTable = () => {
    if (!tbl.length) return;
    const rows = tbl.filter(r => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
    if (rows.length) {
      out += '<table>';
      rows.forEach((r, i) => {
        const cells = r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        out += '<tr>' + cells.map(c => i === 0 ? '<th>' + inline(c) + '</th>' : '<td>' + inline(c) + '</td>').join('') + '</tr>';
      });
      out += '</table>';
    }
    tbl = [];
  };
  lines.forEach(raw => {
    const l = raw.trimEnd();
    if (l.trim().startsWith('|')) { tbl.push(l.trim()); return; }
    flushTable();
    if (/^\s*[-*]\s+/.test(l)) { out += '<div style="margin-left:12px">\u2022 ' + inline(esc(l.replace(/^\s*[-*]\s+/, ''))) + '</div>'; return; }
    if (/^\s*\d+\.\s+/.test(l)) { out += '<div style="margin-left:12px">' + inline(esc(l.trim())) + '</div>'; return; }
    if (!l.trim()) { out += '<div style="height:6px"></div>'; return; }
    out += '<div>' + inline(esc(l)) + '</div>';
  });
  flushTable();
  return out;
}

function inline(t) {
  return t
    .replace(/\bE(\d{6,9})\b/g, '<button type="button" class="wg-enum" data-e="$1">E$1</button>')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener"><img src="$2" alt="$1" loading="lazy"></a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}
