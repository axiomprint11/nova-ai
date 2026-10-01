// ===== ChatBot — the AxiomPrint company brain =====
// Answers staff questions from domain knowledge, meeting notes, agent training,
// approved answers, and the live product database.
// Auth happens on the homepage (/). This page requires a token; if missing, bounce home.
// Embedded mode: the CRM widget (widget.html) loads this same file, so the
// bubble gets the ChatBot page's interface — chat on the left, calculator, cart
// and saved items on the right. The widget's own shell (widget.js) signs the
// person in and decides when to show the chat; this file only draws it.
const EMBED = !!window.NOVA_EMBED;
let token = localStorage.getItem('axiom_token');
let username = localStorage.getItem('axiom_user');
let isAdmin = localStorage.getItem('axiom_admin') === '1';
let currentChatId = null;
let chatHistory = [];
let isLoading = false;
let agents = [];
const currentAgent = 'chatbot';                // fixed for this page
function agentName() { return 'ChatBot'; }

// Slug -> page route. Keep in sync with the launcher (index.html).
const AGENT_ROUTES = { 'order-assist': '/order-assist', 'chatbot': '/chatbot', 'prepress-ai': '/prepress' };

// ---- stale-build guard ----
// The page is served with ?v=<mtime> on every asset, but a browser or CDN can
// still hand back an old chatbot.js, and a stale frontend silently misbehaves
// (old order form, missing buttons) in ways that look like server bugs. Compare
// the build this file was served as against what the server reports, and reload
// once if they differ.
(function stalenessGuard() {
  try {
    // Assets are served as /chatbot.<hash>.js, so the hash in our own src IS the
    // build we are running. Compare it with what the server would serve now.
    const me = document.querySelector('script[src*="chatbot"]');
    const src = me && me.getAttribute('src');
    const m = src && src.match(/chatbot\.([0-9a-f]{10})\.js/);
    if (!m) return;
    const mine = m[1];
    fetch('/api/asset-hash?file=/chatbot.js', { cache: 'no-store' })
      .then(r => r.json())
      .then(v => {
        if (!v || !v.hash || v.hash === mine) return;
        // Reload once only — a reload loop would be worse than a stale file.
        if (sessionStorage.getItem('novaReloadedFor') === v.hash) return;
        sessionStorage.setItem('novaReloadedFor', v.hash);
        console.log('[Nova] newer build ' + v.hash + ' (running ' + mine + ') — reloading');
        location.reload();
      })
      .catch(() => {});
  } catch (e) {}
})();

// Confirm the stored token really is valid before showing anything. Trusting
// localStorage alone means an expired or revoked token gets through and fails
// later, mid-task, with a confusing error instead of a clean sign-in.
let me = null;
if (EMBED) {
  // widget.js verifies the session and calls showApp() once it has one.
} else if (!token) {
  window.location.href = '/';
} else {
  showApp();
  (async function verifyMe() {
    try {
      const r = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
      if (r.status === 401 || r.status === 403) throw new Error('unauthorized');
      if (!r.ok) return;                       // server hiccup: keep working offline-ish
      const j = await r.json();
      if (!j || !j.success) throw new Error('unauthorized');
      me = j;
      username = j.display_name || j.username || username;
      isAdmin = !!j.is_admin;
      try {
        localStorage.setItem('axiom_user', username);
        localStorage.setItem('axiom_admin', isAdmin ? '1' : '0');
      } catch (e) {}
      const lbl = document.getElementById('userLabel');
      if (lbl) lbl.textContent = username || '';
      const av = document.getElementById('avatar');
      if (av) av.textContent = (username || 'U').charAt(0).toUpperCase();
    } catch (e) {
      try {
        localStorage.removeItem('axiom_token');
        localStorage.removeItem('axiom_admin');
      } catch (e2) {}
      window.location.href = '/';
    }
  })();
}

function autoResize(el) { el.style.height = '40px'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
function logout() {
  if (EMBED && typeof window.signOutClick === 'function') return window.signOutClick();
  localStorage.clear(); window.location.href = '/';
}
// Tell the widget shell something changed (it remembers the open chat so a page
// change in the CRM picks the conversation back up). A no-op on the page.
function embedNotify(ev) {
  if (!EMBED) return;
  try { if (window.NovaEmbedHooks && NovaEmbedHooks[ev]) NovaEmbedHooks[ev](); } catch (e) {}
}
// Follow the answer only while the person is already at the bottom. Yanking the
// view down while they are reading something further up is the single most
// irritating thing a streaming chat can do.
let stickToBottom = true;
function nearBottom(m) {
  return (m.scrollHeight - m.scrollTop - m.clientHeight) < 120;
}
function scrollDown(force) {
  const m = document.getElementById('messages');
  if (!m) return;
  if (force || stickToBottom) m.scrollTop = m.scrollHeight;
}
// Stamp the build in the footer. "Is the new code live?" has cost us hours more
// than once — this makes it a glance.
async function showVersion() {
  const el = document.getElementById('novaVer');
  if (!el) return;
  try {
    const r = await fetch('/api/version');
    const j = await r.json();
    if (j.version) el.textContent = 'Nova ' + j.version + (j.built ? ' (' + j.built + ')' : '') + ' · ';
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', () => {
  showVersion();
  renderCart();                       // show the empty cart from the start
  const m = document.getElementById('messages');
  if (!m) return;
  // Scrolling up detaches; returning to the bottom re-attaches.
  m.addEventListener('scroll', () => { stickToBottom = nearBottom(m); }, { passive: true });
});
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
// Voice typing: the mic turns the composer into a recording bar (waveform, timer,
// Cancel / Done); on Done the server turns the recording into text and it lands in
// the box to check and send. Same module as the customer chat (axiom-voice.js).
document.addEventListener('DOMContentLoaded', () => {
  const mic = document.getElementById('micBtn'), inp = document.getElementById('input');
  if (!mic || !inp) return;
  if (!window.AxiomVoice) { mic.style.display = 'none'; return; }
  const tok = () => (typeof token !== 'undefined' && token) || localStorage.getItem('axiom_token') || '';
  const hint = inp.placeholder;
  let hintTimer = null;
  window.AxiomVoice.attach({
    button: mic, input: inp, host: mic.closest('.input-shell'),
    useServer: () => fetch('/api/voice', { headers: { 'Authorization': 'Bearer ' + tok() } })
      .then(r => r.json()).then(j => !!(j && j.server)).catch(() => false),
    transcribe: async (blob) => {
      const r = await fetch('/api/transcribe', { method: 'POST', body: blob,
        headers: { 'Content-Type': 'audio/wav', 'Authorization': 'Bearer ' + tok() } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Could not turn that into text. Please try again.');
      return j.text;
    },
    onText: (t) => {
      inp.value = (inp.value.trim() ? inp.value.replace(/\s*$/, ' ') : '') + t;
      autoResize(inp); inp.focus(); inp.selectionStart = inp.selectionEnd = inp.value.length;
    },
    onError: (m) => { clearTimeout(hintTimer); inp.placeholder = m; hintTimer = setTimeout(() => { inp.placeholder = hint; }, 7000); }
  });
});

// A click on a card must always go through. sendMessage() bails while a turn is
// still streaming, so calling it directly swallowed the click and left the text
// stranded in the composer — the card looked dead.
// Clicking a card while an answer is still streaming means the person has moved
// on. Stop the old answer and start the new one — waiting for a turn they have
// already abandoned is time they spend watching a spinner.
let activeStream = null;

function ask(text) {
  document.getElementById('input').value = text;
  const sug = document.getElementById('suggestions');
  if (sug) sug.style.display = 'none';
  if (isLoading) stopCurrentAnswer('superseded');
  sendMessage();
}

function stopCurrentAnswer(reason) {
  if (activeStream) {
    try { activeStream.abort(); } catch (e) {}   // the server sees this and stops too
    activeStream = null;
  }
  isLoading = false;
  const btn = document.getElementById('sendBtn');
  if (btn) btn.disabled = false;
  // Mark the abandoned answer so the transcript doesn't look like it failed.
  if (reason === 'superseded') {
    document.querySelectorAll('.bubble.ai.streaming').forEach(b => {
      b.classList.remove('streaming');
      b.querySelectorAll('.typing-dots').forEach(n => n.remove());
      if (!b.textContent.trim() && !b.children.length) b.remove();
      else b.classList.add('superseded');
    });
  }
}

function showApp() {
  document.getElementById('app').style.display = 'flex';
  const lbl = document.getElementById('userLabel');
  if (lbl) lbl.textContent = username || '';
  const av = document.getElementById('avatar');
  if (av) av.textContent = (username || 'U').charAt(0).toUpperCase();
  const ab = document.getElementById('adminBtn');
  if (ab) ab.style.display = isAdmin ? 'inline-flex' : 'none';
  // In the widget the shell decides whether to greet or reopen the last chat.
  if (!EMBED) loadAgents();
}

async function loadAgents() {
  try {
    const res = await fetch('/api/agents', { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await res.json();
    agents = (j.agents || []);
  } catch (e) { agents = []; }
  const sel = document.getElementById('agentSelect');
  if (sel) {
    sel.innerHTML = agents.map(a => {
      const built = !!AGENT_ROUTES[a.slug];
      const selectable = a.status === 'active' && built;
      const note = (a.status !== 'active') ? ' (coming soon)' : (!built ? ' (unavailable)' : '');
      return '<option value="' + a.slug + '"' + (selectable ? '' : ' disabled') +
        (a.slug === currentAgent ? ' selected' : '') + '>' + esc(a.name) + note + '</option>';
    }).join('');
    sel.value = currentAgent;
  }
  loadChatList();
  if (!document.getElementById('messagesInner').children.length) greet();
}

function switchAgentPage(slug) {
  if (slug === currentAgent) return;
  const route = AGENT_ROUTES[slug];
  if (!route) { document.getElementById('agentSelect').value = currentAgent; return; }
  localStorage.setItem('axiom_agent', slug);
  window.location.href = route;
}

function greet() {
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = '<div class="msg-avatar ai">AI</div><div class="msg-col"><div class="msg-meta">ChatBot</div><div class="bubble ai">' +
    "Hi! Ask me anything about AxiomPrint \u2014 products and their options, how we price things, what we agreed in team training, or anything in our shared knowledge. I can look things up in the live database too." +
    '</div></div>';
  document.getElementById('messagesInner').appendChild(row);
  const sg = document.getElementById('suggestions');
  if (sg) {
    // Short labels on the chips; a click still asks the full question.
    const ICON = {
      paper: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
      rush:  '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
      copy:  '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      tool:  '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
      users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'
    };
    const examples = [
      ['tool',  'Quote an install',          'I need an installation quote'],
      ['paper', 'Postcard papers',           'What paper stocks do we offer for postcards?'],
      ['clock', 'Business card turnaround',  'What is our turnaround for business cards?'],
      ['rush',  'Rush order rules',          'What did we decide about rush orders?'],
      ['copy',  'Multi-version products',    'Which products have multiple versions enabled?']
    ];
    sg.innerHTML = examples.map(([ic, label, q]) =>
      '<button type="button" class="suggestion" title="' + esc(q) + '" onclick="ask(' + JSON.stringify(q).replace(/"/g,'&quot;') + ')">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[ic] + '</svg>' +
        esc(label) + '</button>').join('');
    sg.style.display = 'flex';
  }
}

function clearChat() {
  chatHistory = [];
  currentChatId = null;
  // A new conversation starts unattached — the next client is pinned fresh.
  chatClientId = null;
  chatClientName = null;
  chatClientInfo = null;
  cartItems = [];
  clearCalcPane();
  renderClientBar();
  renderCart();
  document.getElementById('messagesInner').innerHTML = '';
  const sg = document.getElementById('suggestions');
  if (sg) sg.innerHTML = '';
  greet();
  embedNotify('chat');
}

// ===== Chat history sidebar =====
async function loadChatList() {
  const box = document.getElementById('chatList');
  if (!box) return;
  try {
    const res = await fetch('/api/chats?agent=' + encodeURIComponent(currentAgent), { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await res.json();
    box.innerHTML = '';
    (j.chats || []).forEach(c => {
      const item = document.createElement('div');
      item.className = 'chat-item' + (c.id === currentChatId ? ' active' : '');
      item.innerHTML = '<div class="chat-item-title">' + esc(c.title || 'Chat') + '</div><div class="chat-item-date">' + fmtDate(c.updated_at) + '</div>';
      item.onclick = () => openChat(c.id);
      box.appendChild(item);
    });
  } catch (e) {}
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

async function openChat(id) {
  try {
    const res = await fetch('/api/chats/' + id, { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await res.json();
    if (!j.success) return false;
    currentChatId = id;
    chatHistory = [];
    loadChatClient();          // whoever this conversation belongs to
    loadCart();
    document.getElementById('suggestions').style.display = 'none';
    const inner = document.getElementById('messagesInner');
    inner.innerHTML = '';
    j.messages.forEach(m => {
      if (m.role === 'user') {
        addUserRow(m.content);
        chatHistory.push({ role: 'user', content: m.content });
      } else {
        const row = document.createElement('div');
        row.className = 'msg-row';
        const col = document.createElement('div');
        col.className = 'msg-col';
        col.innerHTML = '<div class="msg-meta">ChatBot</div>';
        const bubble = document.createElement('div');
        bubble.className = 'bubble ai';
        bubble.innerHTML = renderMarkdown(m.content);
        col.appendChild(bubble);
        // Rebuild the cards that were shown with this answer — the product
        // matches, the price card, the timeline. Without them a reopened chat
        // reads as "Which one?" with nothing underneath.
        (m.cards || []).forEach(c => {
          try { renderCard(bubble, c); } catch (e) {}
        });
        const isDraft = (m.cards || []).some(c => c && c.type === 'email_draft');
        if (!isDraft) bubble.appendChild(buildRating(m.id, m.rating));
        row.innerHTML = '<div class="msg-avatar ai">AI</div>';
        row.appendChild(col);
        inner.appendChild(row);
        // A drafted email is not part of the conversation with the model (and
        // would put two assistant turns side by side).
        if (!isDraft) chatHistory.push({ role: 'assistant', content: m.content });
      }
    });
    loadChatList();
    scrollDown();
    embedNotify('chat');
    return true;
  } catch (e) { return false; }
}



// ===== User message row =====
function addUserRow(text) {
  const row = document.createElement('div');
  row.className = 'msg-row user';
  const col = document.createElement('div');
  col.className = 'msg-col';
  const bubble = document.createElement('div');
  bubble.className = 'bubble user';
  bubble.textContent = text;
  col.appendChild(bubble);
  row.appendChild(col);
  row.innerHTML += '<div class="msg-avatar user">' + (username || 'U').charAt(0).toUpperCase() + '</div>';
  document.getElementById('messagesInner').appendChild(row);
  scrollDown();
}

// ===== Pinned client =====
// One client per conversation, stored on the chat. Set once and the agent stops
// asking, quotes carry the discount, and the order form is pre-filled.
let chatClientId = null;
let chatClientName = null;

let chatClientInfo = null;

function renderClientBar() {
  const bar = document.getElementById('clientBar');
  const label = document.getElementById('cbarLabel');
  if (!bar || !label) return;
  bar.classList.toggle('on', !!chatClientId);

  // Connected: show what the client card shows — who they are, how to reach
  // them, and what they're worth. Scrolling back to find the card was the only
  // way to see any of it.
  const i = chatClientInfo;
  if (chatClientId && i) {
    const money = n => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    // Dates arrive as full timestamps; only the day is useful here.
    const day = d => String(d || '').slice(0, 10);
    // Long company names push the whole bar wide, so trim on a word boundary.
    const trim = (t, n) => {
      t = String(t || '');
      if (t.length <= n) return t;
      const cut = t.slice(0, n);
      const sp = cut.lastIndexOf(' ');
      return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,\-]+$/, '') + '\u2026';
    };
    label.innerHTML =
      '<span class="cbar-l1">' + esc(i.name || chatClientName || '') +
        (i.company ? ' <em title="' + esc(i.company) + '">' + esc(trim(i.company, 28)) + '</em>' : '') +
      '</span>' +
      '<span class="cbar-l2">' + [i.email, i.phone].filter(Boolean).map(esc).join(' · ') + '</span>' +
      '<span class="cbar-l3">' + [
        i.orders ? i.orders.toLocaleString() + ' orders' : null,
        i.lifetime ? money(i.lifetime) + ' lifetime' : null,
        i.last_order ? 'last ' + esc(day(i.last_order)) : null
      ].filter(Boolean).join(' · ') + '</span>';
  } else {
    label.textContent = chatClientId ? (chatClientName || 'Client #' + chatClientId) : 'Connect to client';
  }
}

function toggleClientPicker() {
  const pop = document.getElementById('cbarPop');
  if (!pop) return;
  const open = pop.style.display !== 'none';
  if (!open) closePopovers('cbarPop');
  pop.style.display = open ? 'none' : 'block';
  if (!open) {
    const q = document.getElementById('cbarSearch');
    if (q) { q.value = ''; setTimeout(() => q.focus(), 60); }
    document.getElementById('cbarResults').innerHTML = '';
  }
}

let cbarTimer = null;
function clientBarSearch() {
  clearTimeout(cbarTimer);
  const q = document.getElementById('cbarSearch').value.trim();
  const box = document.getElementById('cbarResults');
  if (q.length < 2) { box.innerHTML = ''; return; }
  cbarTimer = setTimeout(async () => {
    box.innerHTML = '<div class="cbar-empty">Searching…</div>';
    try {
      const r = await fetch('/api/chatbot/find-client?q=' + encodeURIComponent(q),
        { headers: { 'Authorization': 'Bearer ' + token } });
      const j = await r.json();
      if (!j.ok || !j.clients.length) { box.innerHTML = '<div class="cbar-empty">No match.</div>'; return; }
      box.innerHTML = '';
      j.clients.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cbar-row';
        // Person in charcoal, company in the accent colour — the name is what
        // you scan for, the company is context.
        b.innerHTML = '<span class="cbar-who">' +
          '<span class="cbar-name">' + esc(c.name) + '</span>' +
          (c.company ? '<span class="cbar-co"> — ' + esc(c.company) + '</span>' : '') +
          '<span class="cbar-mail">' + esc(c.email || '') + '</span></span>' +
          '<span class="cbar-n">' + (c.orders || 0) + '</span>';
        b.onclick = () => setChatClient(c.id, c.company ? (c.name + ' (' + c.company + ')') : c.name);
        box.appendChild(b);
      });
    } catch (e) { box.innerHTML = '<div class="cbar-empty">Search failed.</div>'; }
  }, 280);
}

async function setChatClient(id, name) {
  if (!currentChatId) {
    // No chat yet — remember locally and persist on the first message.
    chatClientId = id; chatClientName = name || null;
    renderClientBar();
    document.getElementById('cbarPop').style.display = 'none';
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
      chatClientId = j.client_id;
      chatClientName = j.client_name || name || null;
      chatClientInfo = j.info || null;
      renderClientBar();
      // If they were stopped at checkout for this, clear the warning.
      const cf = document.getElementById('cartForm');
      if (cf && cf.querySelector('.cf-needclient')) {
        cf.style.display = 'none';
        cf.innerHTML = '';
        // They were stopped here for want of a client — now that there is one,
        // reprice and reopen so the form shows discounted figures.
        repriceCart(j.client_id).then(() => openCartOrder());
      }
      // Every quote so far was priced at list — on screen, saved, or behind a
      // marker in the chat. Update them all to this client's pricing rather
      // than leaving numbers that are now wrong.
      if (j.client_id) repriceForClient(j.client_id, chatClientName);
      // The cart holds its own copies of those prices, so it needs the same
      // treatment — a cart total that disagrees with the cards is worse than none.
      repriceCart(j.client_id);
    }
  } catch (e) {}
  document.getElementById('cbarPop').style.display = 'none';
}

async function loadChatClient() {
  if (!currentChatId) { chatClientId = null; chatClientName = null; renderClientBar(); return; }
  try {
    const r = await fetch('/api/chats/' + currentChatId + '/client',
      { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    chatClientId = j.client_id || null;
    chatClientName = j.client_name || null;
    chatClientInfo = j.info || null;
  } catch (e) {}
  renderClientBar();
}

// Close the picker when clicking elsewhere.
document.addEventListener('click', (e) => {
  const bar = document.getElementById('clientBar');
  if (bar && !bar.contains(e.target)) {
    const pop = document.getElementById('cbarPop');
    if (pop) pop.style.display = 'none';
  }
});

// ===== Cart =====
// Priced items parked at the top of the conversation. A multi-product request
// builds a visible list instead of a chat you have to scroll back through.
let cartItems = [];
// The cart is switched off for now: the team read "Add to cart" and "Save" as
// the same thing. Save (on the price card) files a quote under Saved, which is
// what goes in the reply. Flip this back on to bring the cart pill and
// "Add to cart" back — the code behind them is unchanged.
const CART_ON = false;

async function addToCart(item) {
  if (!currentChatId) return false;
  try {
    const r = await fetch('/api/chats/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ chat_id: currentChatId }, item))
    });
    const j = await r.json();
    if (j.ok) { await loadCart(); return true; }
  } catch (e) {}
  return false;
}

// Re-price the cart for a newly connected client, with a visible loader — this
// hits the pricing engine once per item, so it is not instant.
async function repriceCart(clientId) {
  if (!currentChatId || !cartItems.length) return;
  const pill = document.getElementById('cartPill');
  const pop = document.getElementById('cartPop');
  if (pill) pill.classList.add('recalc');
  if (pop && pop.style.display !== 'none') {
    pop.innerHTML = '<div class="cart-recalc">Recalculating for ' +
      esc(chatClientName || 'this client') + '\u2026</div>';
  }
  try {
    const r = await fetch('/api/chats/' + currentChatId + '/cart/reprice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ client_id: clientId || null })
    });
    const j = await r.json();
    if (j.ok) cartItems = j.items || [];
  } catch (e) {}
  if (pill) pill.classList.remove('recalc');
  renderCart();
  if (pop && pop.style.display !== 'none') drawCartPanel();
}

async function loadCart() {
  if (!currentChatId) { cartItems = []; renderCart(); return; }
  try {
    const r = await fetch('/api/chats/' + currentChatId + '/cart',
      { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    cartItems = j.items || [];
  } catch (e) { cartItems = []; }
  renderCart();
}

function renderCart() {
  const pill = document.getElementById('cartPill');
  if (!pill) return;
  if (!CART_ON) { pill.style.display = 'none'; hideCart(); return; }
  // Always on show. A cart that appears only once it has something in it gives
  // no hint that carting is possible at all.
  pill.style.display = 'inline-flex';
  pill.classList.toggle('empty', cartItems.length === 0);
  pill.title = cartItems.length ? 'Cart' : 'Nothing in the cart yet';
  document.getElementById('cartCount').textContent = cartItems.length;
  const total = cartItems.reduce((a, b) => a + (Number(b.price) || 0), 0);
  document.getElementById('cartTotal').textContent = '$' + total.toFixed(2);
  if (!cartItems.length) { hideCart(); return; }
  const pop = document.getElementById('cartPop');
  if (pop && pop.style.display !== 'none') drawCartPanel();
}

function drawCartPanel() {
  const pop = document.getElementById('cartPop');
  const total = cartItems.reduce((a, b) => a + (Number(b.price) || 0), 0);
  const list = cartItems.reduce((a, b) => a + (Number(b.list_price) || Number(b.price) || 0), 0);
  pop.innerHTML =
    '<div class="cart-hd">Cart <span>' + cartItems.length + ' item' +
      (cartItems.length === 1 ? '' : 's') + '</span></div>' +
    cartItems.map(it =>
      '<div class="cart-row">' +
        (it.image ? '<img src="' + esc(it.image) + '" alt="" onerror="this.remove()">'
                  : '<span class="cart-ph"></span>') +
        '<span class="cart-body"><b>' + esc(it.product || '') + '</b>' +
          '<small>Qty ' + Number(it.quantity || 0).toLocaleString() +
          (it.summary ? ' · ' + esc(it.summary) : '') +
          (it.turnaround ? ' · ' + esc(it.turnaround) : '') + '</small></span>' +
        '<span class="cart-price">$' + Number(it.price || 0).toFixed(2) + '</span>' +
        '<button type="button" class="cart-rm" data-id="' + it.id + '" title="Remove">✕</button>' +
      '</div>').join('') +
    '<div class="cart-ft">' +
      (list > total ? '<span class="cart-saved">Saves $' + (list - total).toFixed(2) + '</span>' : '<span></span>') +
      '<b>$' + total.toFixed(2) + '</b>' +
    '</div>' +
    '<div class="cart-actions">' +
      '<button type="button" class="cart-clear" onclick="clearCart()">Empty</button>' +
      '<button type="button" class="cart-order" onclick="startCheckout()">Proceed with order</button>' +
    '</div>' +
    '<button type="button" class="cart-draft" onclick="startDraft()">Help me draft an email</button>' +
    '<div class="cart-form" id="cartForm" style="display:none"></div>';
  pop.querySelectorAll('.cart-rm').forEach(b => {
    b.onclick = async () => {
      await fetch('/api/chats/cart/' + b.getAttribute('data-id'),
        { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
      loadCart();
    };
  });
}

// One order, several estimates. Each item keeps its own job name, date, delivery
// and artwork choice — they are separate jobs on one purchase order.
async function openCartOrder() {
  const box = document.getElementById('cartForm');
  if (!chatClientId) {
    // Point at the thing that needs doing instead of stopping everything with a
    // browser dialog: highlight the client bar, open its search, and say why.
    box.style.display = 'block';
    box.innerHTML = '<div class="cf-needclient">The order needs an account. ' +
      'Connect the client above, then come back to this.</div>';
    const bar = document.getElementById('clientBar');
    if (bar) {
      bar.classList.add('needs-client');
      setTimeout(() => bar.classList.remove('needs-client'), 2600);
    }
    const pop = document.getElementById('cbarPop');
    if (pop && pop.style.display === 'none') {
      pop.style.display = 'block';
      const q = document.getElementById('cbarSearch');
      if (q) { q.value = ''; setTimeout(() => q.focus(), 80); }
    }
    return;
  }
  box.style.display = 'block';
  box.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading…</div>';
  let cfg = { choices: [] }, dflt = {};
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/chatbot/order-fields?client_id=' + chatClientId,
        { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch('/api/chatbot/order-defaults?client_id=' + chatClientId,
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
    '<div class="cf-hd">Placing ' + cartItems.length + ' item' + (cartItems.length === 1 ? '' : 's') +
      ' as one order for <b>' + esc(chatClientName || '') + '</b></div>' +
    cartItems.map((it, i) =>
      '<div class="cf-item" data-cart="' + it.id + '">' +
        '<div class="cf-title">' + (i + 1) + '. ' + esc(it.product) + '</div>' +
        '<label>Job name<input type="text" data-f="job_name" placeholder="What this job is called"></label>' +
        // This item's own turnaround decides its date. Falling back to a shared
        // default would promise the same day for a 3-day job and a 10-day one.
        '<label>Needed by<input type="date" data-f="needed_by" value="' +
          esc(it.ready_date || (dflt.needed_by || '').slice(0, 10)) + '"></label>' +
        (it.turnaround
          ? '<div class="cf-turn">' + esc(it.turnaround) +
            (it.ready_date ? ' \u2014 ready ' + esc(it.ready_date) : '') + '</div>'
          : '') +
        '<label>Delivery' + sel('shipping_method', dflt.shipping_method) + '</label>' +
        '<label>Artwork' + sel('design_type') + '</label>' +
        '<label>Proof' + sel('proofing') + '</label>' +
      '</div>').join('') +
    '<div class="cf-foot">' +
      '<span id="cartOrderMsg"></span>' +
      '<button type="button" class="cart-order" onclick="submitCartOrder(this)">Place order</button>' +
    '</div>';
}

async function submitCartOrder(btn) {
  const box = document.getElementById('cartForm');
  const msg = document.getElementById('cartOrderMsg');
  const items = Array.from(box.querySelectorAll('.cf-item')).map(el => {
    const o = { cart_id: Number(el.getAttribute('data-cart')) };
    el.querySelectorAll('[data-f]').forEach(i => { o[i.getAttribute('data-f')] = i.value; });
    return o;
  });
  const blank = items.filter(i => !String(i.job_name || '').trim()).length;
  if (blank) { msg.textContent = 'Give every item a job name.'; return; }
  btn.disabled = true; msg.textContent = 'Placing…';
  try {
    const r = await fetch('/api/chatbot/order-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_id: currentChatId, client_id: chatClientId, items: items })
    });
    const j = await r.json();
    if (!j.ok) {
      btn.disabled = false;
      msg.textContent = j.missing ? j.missing.join('; ') : (j.error || 'Could not place it');
      return;
    }
    box.innerHTML = '<div class="cf-done">\u2713 Ordered ' + j.count + ' item' +
      (j.count === 1 ? '' : 's') +
      (j.e_numbers && j.e_numbers.length ? ' \u2014 ' + j.e_numbers.join(', ') : '') + '</div>';
    loadCart();
  } catch (e) {
    btn.disabled = false;
    msg.textContent = 'Could not place it.';
  }
}

// The cart and the client picker share the same corner — opening one closes the
// other, so the second never appears underneath.
function closePopovers(except) {
  ['cartPop', 'cbarPop'].forEach(id => {
    if (id === except) return;
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function toggleCart() {
  const pop = document.getElementById('cartPop');
  if (!pop) return;
  if (!cartItems.length) return;      // nothing to open
  if (pop.style.display === 'none') {
    closePopovers('cartPop');
    drawCartPanel();
    pop.style.display = 'block';
  } else pop.style.display = 'none';
}
function hideCart() {
  const pop = document.getElementById('cartPop');
  if (pop) pop.style.display = 'none';
}
async function clearCart() {
  if (!currentChatId || !confirm('Empty the cart?')) return;
  await fetch('/api/chats/' + currentChatId + '/cart',
    { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
  loadCart();
}

document.addEventListener('click', (e) => {
  const bar = document.getElementById('clientBar');
  if (bar && !bar.contains(e.target)) hideCart();
});

// ===== Send a message (streams from /api/chatbot/chat) =====
// Card events that belong to an answer. Stored with the message so reopening a
// chat rebuilds what was on screen, not just the sentence above it.
const CARD_TYPES = ['job_card', 'price_quote', 'client_card', 'client_picks', 'product_cards',
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

// The pane only earns its space when there is space. Below this the layout
// collapses to one column and cards go back into the conversation.
function usePane() {
  const pane = document.getElementById('calcPane');
  // The widget is a panel, not a page, so it gets the pane from a narrower width.
  return !!pane && window.innerWidth > (EMBED ? 700 : 1200) && getComputedStyle(pane).display !== 'none';
}

function showInPane(card, name) {
  const body = document.getElementById('calcPaneBody');
  if (!body) return;
  paneMode = 'calc';
  lastCalcCard = card;
  body.innerHTML = '';
  body.appendChild(card);
  renderPaneToggle();
  renderPaneActions();
  renderLiveTab(name);
  // The header used to carry the product name, which put the live item ABOVE
  // the saved tabs and made the second item look like the first. It stays
  // generic; the item names live in the tabs, in the order they were quoted.
  const hd = document.querySelector('.calc-pane-hd span');
  if (hd) hd.textContent = 'Calculator';
  body.scrollTop = 0;
}

// The installation / delivery calculator in the pane. It has no Save / Draft
// bar — those belong to product quotes — so it is placed directly rather than
// through showInPane.
function showInstallInPane(card, marker) {
  const body = document.getElementById('calcPaneBody');
  if (!body) return;
  const pane = document.getElementById('calcPane');
  if (pane && pane.classList.contains('folded')) togglePaneFold();
  paneMode = 'calc';
  body.innerHTML = '';
  body.appendChild(card);
  const hd = document.querySelector('.calc-pane-hd span');
  if (hd) hd.textContent = 'Calculator';
  body.scrollTop = 0;
  document.querySelectorAll('.ic-moved.on, .pq-moved.on').forEach(n => n.classList.remove('on'));
  if (marker) marker.classList.add('on');
}

// Order and draft, under the card where they are actually needed. They used to
// live inside the cart popover, which meant they were invisible until you had
// already carted something and opened it.
// Items quoted and set aside for the reply. Not the cart: a price ladder
// (250/500/1,000 of one product) is a QUOTE, not three orders, so it cannot go
// in a cart — but it is exactly what goes in the email.
const quoteShelf = [];

// How many items the job has, read from the recap the agent writes ("1) … 2) …").
// Used only to hide "save and go to the next" on the last one — if the recap
// can't be read, the button stays, which is the harmless way to be wrong.
let jobItemCount = 0;

function noteJobSize(text) {
  const m = String(text || '').match(/^\s*(\d+)\)/gm);
  if (m && m.length > 1) jobItemCount = m.length;
}

// ===== "Order now" links =====
// Every priced quantity can open the product page on axiomprint.com with its
// options already selected (server: /api/chatbot/order-links). Links are cached
// by the options they carry, so a re-priced or edited card gets a fresh one.
const orderLinkCache = {};

function orderLinkPayload(d) {
  d = d || {};
  return {
    product_id: d.product_id, quantity: d.quantity, width: d.width || null, height: d.height || null,
    specs: (d.specs || []).filter(sp => sp.variable_id).map(sp => ({
      variable_id: sp.variable_id, item_id: sp.item_id, value: sp.value,
      isQuantity: !!sp.isQuantity, isVersions: !!sp.isVersions, isVersionRow: !!sp.isVersionRow
    }))
  };
}

// states -> urls (null where no link could be made), in one request.
async function orderLinks(states) {
  const keys = states.map(d => JSON.stringify(orderLinkPayload(d)));
  const todo = [];
  keys.forEach((k, i) => { if (!(k in orderLinkCache) && !todo.some(t => t.k === k)) todo.push({ k: k, d: states[i] }); });
  if (todo.length) {
    const job = fetch('/api/chatbot/order-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ items: todo.map(t => orderLinkPayload(t.d)) })
    }).then(r => r.json()).then(j => (j && j.links) || []).catch(() => []);
    todo.forEach((t, i) => {
      orderLinkCache[t.k] = job.then(links => {
        const l = links[i];
        if (!l || !l.ok || !l.url) { delete orderLinkCache[t.k]; return null; }
        return l.url;
      });
    });
  }
  return Promise.all(keys.map(k => orderLinkCache[k] || null));
}

// "Order now": the tab opens straight away (a tab opened after a network wait
// is blocked as a pop-up), then goes to the link once it is ready.
async function openOrderLink(d, btn) {
  const tab = window.open('', '_blank');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Opening\u2026'; }
  const url = (await orderLinks([d]))[0];
  if (btn) { btn.disabled = false; btn.textContent = url ? label : 'No link'; }
  if (!url) { if (tab) tab.close(); return; }
  if (tab) { try { tab.opener = null; } catch (e) {} tab.location.href = url; }
  else window.open(url, '_blank', 'noopener');
}

// Put a url on every row of the given saved items (rows[i] belongs to cards[i]).
async function attachOrderLinks(entries) {
  const flat = [];
  entries.forEach(e => (e.cards || []).forEach((c, i) => flat.push({ row: e.rows[i], d: c.data })));
  const urls = await orderLinks(flat.map(f => f.d));
  flat.forEach((f, i) => { if (f.row) f.row.url = urls[i] || null; });
}

// What the draft and the email are built from: the saved items, or — before
// anything is saved — the product on screen with every quantity quoted for it.
function draftEntries() {
  if (quoteShelf.length) return quoteShelf;
  const latest = paneQuotes[paneQuotes.length - 1];
  if (!latest) return [];
  const d = liveOf(latest);
  const mine = {};
  paneQuotes.forEach(q => {
    const qd = liveOf(q);
    if (Number(qd.product_id) !== Number(d.product_id)) return;
    if (Number(qd.quantity) > 0) mine[Number(qd.quantity)] = { card: q.card, data: qd };
  });
  const entry = {
    product_id: d.product_id, product: d.product, image: d.product_image || null,
    specs: (d.specs || []).filter(sp => !sp.isVersionRow),
    cards: Object.keys(mine).map(n => ({ quantity: Number(n), card: mine[n].card, data: mine[n].data }))
  };
  if (!entry.cards.length) entry.cards = [{ quantity: d.quantity, card: latest.card, data: d }];
  sortRows(entry);
  return [entry];
}

// More items in the job still to price? Read from the recap ("1) … 2) …").
function moreItemsToCome() {
  return jobItemCount > 0 && quoteShelf.length < jobItemCount - 1;
}

// A card's live figures. paneQuotes keeps what the card first showed; the card
// itself knows what it says now (after an edit, a clarify or a client price).
function liveOf(q) {
  return (q.card && typeof q.card.__getState === 'function') ? q.card.__getState() : q.data;
}

function sortRows(entry) {
  entry.cards.sort((a, b) => Number(a.data.quantity) - Number(b.data.quantity));
  entry.rows = entry.cards.map(c => ({
    quantity: Number(c.data.quantity), price: c.data.price, each: c.data.each,
    list_price: c.data.list_price, discount: c.data.discount || null
  }));
}

// "Save" on a price card. Files that product under Saved, with every quantity
// quoted for it — a ladder (250/500/1,000) is one item with three prices.
function saveToShelf(card, st) {
  let d = st, own = card;
  if (!d) {
    const latest = paneQuotes[paneQuotes.length - 1];
    if (!latest) return;
    own = latest.card; d = liveOf(latest);
  }
  const moveOn = moreItemsToCome();          // decided before the shelf grows
  const at = quoteShelf.findIndex(x => Number(x.product_id) === Number(d.product_id));

  // Every quantity quoted for THIS product, at its current price.
  const mine = {};
  paneQuotes.forEach(q => {
    const qd = liveOf(q);
    if (Number(qd.product_id) !== Number(d.product_id)) return;
    const n = Number(qd.quantity);
    if (n > 0) mine[n] = { card: q.card, data: qd };
  });
  // The card that was clicked wins its own quantity (and counts even when it
  // is not in the pane, e.g. on a narrow screen).
  mine[Number(d.quantity) || 0] = { card: own, data: d };

  const entry = {
    product_id: d.product_id, product: d.product, image: d.product_image || null,
    specs: (d.specs || []).filter(sp => !sp.isVersionRow),
    cards: Object.keys(mine).map(n => ({ quantity: Number(n), card: mine[n].card, data: mine[n].data }))
  };
  sortRows(entry);
  if (at > -1) {
    (quoteShelf[at].cards || []).forEach(c => c.card && c.card.__setSaved && c.card.__setSaved(false));
    quoteShelf[at] = entry;
  } else quoteShelf.push(entry);
  entry.cards.forEach(c => c.card && c.card.__setSaved && c.card.__setSaved(true));

  shelfOpen = -1;
  renderShelf();
  renderPaneActions();
  // Only nudge the conversation on for a new item when there is genuinely a next one.
  if (at === -1 && moveOn) {
    ask('Saved the ' + (d.product || 'quote') + ' pricing. Move on to the next item from my original ' +
        'message — state its own specs, then search for it.');
  }
}

// A card re-priced itself (edit, clarify, client connected). Keep every copy of
// its figure in step: the chat marker, the draft, and Saved.
function onCardRepriced(card, st) {
  const pq = paneQuotes.find(q => q.card === card);
  if (pq) {
    pq.data = st;
    if (pq.marker) {
      const p = pq.marker.querySelector('.pq-moved-p');
      if (p && st.price != null) p.textContent = '$' + Number(st.price).toFixed(2);
      const q = pq.marker.querySelector('.pq-moved-q');
      if (q && st.quantity) q.textContent = 'Qty ' + Number(st.quantity).toLocaleString();
    }
  }
  let touched = false;
  quoteShelf.forEach(entry => {
    const c = (entry.cards || []).find(x => x.card === card);
    if (!c) return;
    c.data = st; c.quantity = Number(st.quantity);
    entry.specs = (st.specs || []).filter(sp => !sp.isVersionRow);
    sortRows(entry);
    touched = true;
  });
  if (touched) {
    renderShelf();
    if (paneMode === 'draft') drawDraft();
  }
}

// A client was connected: re-price every quote in this conversation for them —
// the cards on screen, the saved items, and the quantities behind chat markers.
// Each card keeps its own specs; only the client (and so the discount) changes.
let shelfBusy = null;
async function repriceForClient(clientId, clientName) {
  if (!clientId) return;
  const cards = new Set();
  document.querySelectorAll('.pq-card').forEach(c => cards.add(c));
  paneQuotes.forEach(q => q.card && cards.add(q.card));
  quoteShelf.forEach(e => (e.cards || []).forEach(c => c.card && cards.add(c.card)));
  const jobs = [];
  cards.forEach(c => {
    if (typeof c.__repriceForClient === 'function') jobs.push(c.__repriceForClient(clientId, clientName));
  });
  if (!jobs.length) return;
  if (quoteShelf.length) { shelfBusy = clientName || 'this client'; renderShelf(); }
  await Promise.allSettled(jobs);
  if (shelfBusy) { shelfBusy = null; renderShelf(); }
}

// Saved items stack above the live one as accordion tabs, so an earlier quote
// can be reopened and corrected without re-pricing it from the chat.
let shelfOpen = -1;
let shelfCollapsed = false;

function toggleShelfSection() {
  shelfCollapsed = !shelfCollapsed;
  renderShelf();
}

function renderShelf() {
  let bar = document.getElementById('shelfBar');
  if (!quoteShelf.length) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'shelfBar';
    bar.className = 'shelf-bar';
    // Top of the pane, straight under the client — what is saved is the first
    // thing you see, above the calculator.
    const hd = document.querySelector('.calc-pane-hd');
    if (hd && hd.parentNode) hd.parentNode.insertBefore(bar, hd);
  }

  const sent = quoteShelf.filter(q => q.quote_id).length;
  bar.innerHTML =
    '<div class="shelf-head" onclick="toggleShelfSection()">' +
      '<span>Saved</span><em>' + quoteShelf.length + '</em>' +
      (shelfBusy ? '<span class="shelf-busy">Updating prices for ' + esc(shelfBusy) + '\u2026</span>'
        : (chatClientId && quoteShelf.some(q => q.rows.some(r => r.discount))
            ? '<span class="shelf-client">' + esc(chatClientName || 'Client') + ' pricing</span>' : '')) +
      (sent ? '<span class="shelf-sent">' + sent + ' in CRM</span>' : '') +
      '<span class="shelf-fold">' + (shelfCollapsed ? '\u2304' : '\u2303') + '</span>' +
    '</div>' +
    (shelfCollapsed ? '' : '<div class="shelf-list">' + quoteShelf.map((q, i) => {
    const open = shelfOpen === i;
    const total = q.rows.length === 1
      ? '$' + Number(q.rows[0].price).toFixed(2)
      : q.rows.length + ' quantities';
    const disc = (q.rows.find(r => r.discount) || {}).discount;
    return '<div class="shelf-item' + (open ? ' open' : '') + '">' +
      '<button type="button" class="shelf-tab" data-i="' + i + '">' +
        (q.image ? '<img src="' + esc(q.image) + '" alt="" onerror="this.remove()">' : '<span class="shelf-ph"></span>') +
        '<span class="shelf-name">' + esc(q.product) + '</span>' +
        (disc ? '<span class="shelf-disc">\u2212' + Number(disc.percent) + '%</span>' : '') +
        '<span class="shelf-sum">' + total + '</span>' +
        '<span class="shelf-caret">' + (open ? '\u2303' : '\u2304') + '</span>' +
      '</button>' +
      (open
        ? '<div class="shelf-body">' +
            '<table class="shelf-rows">' + q.rows.map((r, ri) =>
              '<tr data-open="' + i + '-' + ri + '"><td>' +
              Number(r.quantity).toLocaleString() + '</td>' +
              '<td class="shelf-order"><button type="button" data-order="' + i + '-' + ri + '">Order now</button></td><td>' +
              (r.discount && r.list_price > r.price
                ? '<s>$' + Number(r.list_price).toFixed(2) + '</s> ' : '') + '$' +
              Number(r.price).toFixed(2) + '</td></tr>').join('') + '</table>' +
            '<div class="shelf-acts">' +
              '<button type="button" class="sa-view" data-view="' + i + '">View</button>' +
              '<button type="button" data-edit="' + i + '">Re-price</button>' +
              (q.quote_id
                ? '<span class="sa-sent">\u2713 E' + q.quote_id + '</span>'
                : '<button type="button" class="sa-crm" data-crm="' + i + '">Send to CRM</button>') +
              '<button type="button" data-rm="' + i + '">Remove</button>' +
            '</div>' +
          '</div>'
        : '') +
    '</div>';
  }).join('') +
    // Send the lot to the CRM (once there is more than one), and draft the
    // reply to the client — side by side.
    '<div class="shelf-acts-row">' +
      (quoteShelf.filter(q => !q.quote_id).length > 1
        ? '<button type="button" class="shelf-all" id="shelfSendAll">Send all ' +
          quoteShelf.filter(q => !q.quote_id).length + ' to CRM</button>'
        : '') +
      '<button type="button" class="shelf-mail" id="shelfDraftMail">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>' +
        'Help to draft email</button>' +
    '</div>' +
  '</div>');

  bar.querySelectorAll('.shelf-tab').forEach(b => {
    b.onclick = () => {
      const i = Number(b.getAttribute('data-i'));
      shelfOpen = (shelfOpen === i) ? -1 : i;
      renderShelf();
    };
  });
  bar.querySelectorAll('[data-rm]').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation();
      const gone = quoteShelf.splice(Number(x.getAttribute('data-rm')), 1)[0];
      if (gone) (gone.cards || []).forEach(c => c.card && c.card.__setSaved && c.card.__setSaved(false));
      shelfOpen = -1;
      renderShelf(); renderPaneActions();
    };
  });
  // View: put the saved card back in the calculator, exactly as it was. The
  // Clarify dropdowns and Edit still work, so this doubles as the way in to
  // change something on an earlier item.
  // Any quantity in an open item opens that exact card.
  bar.querySelectorAll('[data-open]').forEach(row => {
    row.onclick = (e) => {
      e.stopPropagation();
      const [si, ri] = row.getAttribute('data-open').split('-').map(Number);
      const q = quoteShelf[si];
      if (q && q.cards && q.cards[ri]) showInPane(q.cards[ri].card, q.product);
    };
  });

  bar.querySelectorAll('[data-order]').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation();
      const [si, ri] = x.getAttribute('data-order').split('-').map(Number);
      const c = quoteShelf[si] && quoteShelf[si].cards && quoteShelf[si].cards[ri];
      if (c) openOrderLink(c.card && c.card.__getState ? c.card.__getState() : c.data, x);
    };
  });

  bar.querySelectorAll('[data-view]').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation();
      const q = quoteShelf[Number(x.getAttribute('data-view'))];
      if (!q || !q.cards || !q.cards.length) return;
      const first = q.cards[0];
      showInPane(first.card, q.product);
      // Its other quantities go back in the chat as markers, so the whole
      // ladder is reachable again.
      document.querySelectorAll('.pq-moved.on').forEach(n => n.classList.remove('on'));
    };
  });

  // Send one saved item to the CRM as a quote.
  bar.querySelectorAll('[data-crm]').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation();
      sendShelfItem(Number(x.getAttribute('data-crm')), x);
    };
  });

  const dm = document.getElementById('shelfDraftMail');
  if (dm) dm.onclick = (e) => { e.stopPropagation(); draftReplyInChat(); };

  const all = document.getElementById('shelfSendAll');
  if (all) all.onclick = async () => {
    all.disabled = true;
    const pending = quoteShelf.map((q, i) => i).filter(i => !quoteShelf[i].quote_id);
    for (const i of pending) {
      all.textContent = 'Sending ' + quoteShelf[i].product + '…';
      await sendShelfItem(i, null);
    }
    renderShelf();
  };

  bar.querySelectorAll('[data-edit]').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation();
      const q = quoteShelf[Number(x.getAttribute('data-edit'))];
      if (q) ask('Re-price ' + q.product + ' (#' + q.product_id + ') — same specs as before, ' +
                 'and I may want to change something.');
    };
  });
}

// The item being priced, shown as the next tab in the sequence rather than as a
// title above everything — so a two-item job reads 1) saved, 2) live.
function renderLiveTab(name) {
  const body = document.getElementById('calcPaneBody');
  if (!body) return;
  const old = document.getElementById('liveTab');
  if (old) old.remove();
  if (!name) return;
  const tab = document.createElement('div');
  tab.id = 'liveTab';
  tab.className = 'live-tab';
  tab.innerHTML = '<span class="live-dot"></span>' + esc(name) +
    '<em>' + (quoteShelf.length + 1) + ' of ' +
    (jobItemCount || (quoteShelf.length + 1)) + '</em>';
  body.insertBefore(tab, body.firstChild);
}

// A saved item -> a CRM quote. Its whole ladder goes in the description, so a
// manager sees the alternatives rather than one figure without context.
async function sendShelfItem(i, btn) {
  const q = quoteShelf[i];
  if (!q || q.quote_id) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const first = q.rows[0] || {};
    const r = await fetch('/api/chatbot/quote-to-crm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        product_id: q.product_id,
        product: q.product,
        name: q.product,
        price: first.price,
        summary: 'Qty ' + Number(first.quantity || 0).toLocaleString(),
        specs: q.specs || [],
        ladder: q.rows,
        client_hint: chatClientName || ''
      })
    });
    const j = await r.json();
    if (j.ok) { q.quote_id = j.quote_id; }
    else if (btn) { btn.disabled = false; btn.textContent = 'Send to CRM'; btn.title = j.error || ''; }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Send to CRM'; }
  }
  renderShelf();
}

async function sendQuoteToCrm(btn) {
  const latest = paneQuotes[paneQuotes.length - 1];
  if (!latest) return;
  const d = latest.data;

  // Every quantity quoted for this product goes in the description, so the
  // manager sees the ladder rather than a single figure with no context.
  const mine = {};
  paneQuotes.forEach(x => {
    if (Number(x.data.product_id) !== Number(d.product_id)) return;
    const n = Number(x.data.quantity);
    if (n > 0) mine[n] = x.data;
  });
  const ladder = Object.keys(mine).map(Number).sort((a, b) => a - b)
    .map(n => ({ quantity: n, price: mine[n].price }));

  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await fetch('/api/chatbot/quote-to-crm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        product_id: d.product_id,
        product: d.product,
        price: d.price,
        name: d.product,
        summary: 'Qty ' + Number(d.quantity || 0).toLocaleString() +
                 (d.size ? ', ' + d.size : ''),
        specs: (d.specs || []).filter(sp => !sp.isVersionRow),
        ladder: ladder,
        client_hint: chatClientName || ''
      })
    });
    const j = await r.json();
    if (!j.ok) {
      btn.disabled = false;
      btn.textContent = 'Send to CRM as a quote';
      const m = document.createElement('div');
      m.className = 'co-msg';
      m.textContent = j.error || 'Could not send it';
      btn.parentNode.appendChild(m);
      return;
    }
    btn.className = 'pa-quote done';
    btn.textContent = j.e_number ? 'Quote ' + j.e_number + ' created' : 'Quote created';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Send to CRM as a quote';
  }
}

function renderPaneActions() {
  const body = document.getElementById('calcPaneBody');
  if (!body || paneMode !== 'calc') return;
  if (!lastCalcCard) return;                 // nothing quoted yet
  const old = document.getElementById('paneActions');
  if (old) old.remove();

  const bar = document.createElement('div');
  bar.id = 'paneActions';
  bar.className = 'pane-actions';
  const shelved = quoteShelf.length;
  // Save lives on the price card now, where Add to cart was — one button that
  // keeps the quote. The email draft stays here, under it.
  bar.innerHTML =
    '<div class="pa-row">' +
      '<button type="button" class="pa-draft">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>' +
        'Help to draft email' + (shelved > 1 ? ' \u2014 ' + shelved + ' items' : '') +
      '</button>' +
    '</div>';
  bar.querySelector('.pa-draft').onclick = () => startDraft();
  body.appendChild(bar);
}

// Draft mode: the same job written the way it goes to a client — specs once,
// then the quantity ladder. Calculator mode is for working it out; this is for
// sending it.
let paneMode = 'calc';

function renderPaneToggle() {
  const hd = document.querySelector('.calc-pane-hd');
  if (!hd) return;
  let wrap = document.getElementById('paneToggle');
  const ladder = quantityLadder();
  if (!ladder) { if (wrap) wrap.remove(); return; }
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'paneToggle';
    wrap.className = 'pane-toggle';
    hd.insertBefore(wrap, hd.querySelector('.calc-pane-x'));
  }
  wrap.innerHTML =
    '<button type="button" class="' + (paneMode === 'calc' ? 'on' : '') + '" data-m="calc">Calculator</button>' +
    '<button type="button" class="' + (paneMode === 'draft' ? 'on' : '') + '" data-m="draft">Draft</button>';
  wrap.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      paneMode = b.getAttribute('data-m');
      renderPaneToggle();
      if (paneMode === 'draft') drawDraft(); else restoreCalc();
    };
  });
}

let lastCalcCard = null;
function restoreCalc() {
  const body = document.getElementById('calcPaneBody');
  if (!body || !lastCalcCard) return;
  paneMode = 'calc';
  body.innerHTML = '';
  body.appendChild(lastCalcCard);
  // The action bar belongs to this view, so it comes back with the card.
  // Rebuilding only the card left the pane with no way to save or order until
  // something else forced a repaint.
  renderPaneActions();
}

// The client-facing quote: every item on the shelf, each with its thumbnail,
// specs and price ladder. Falls back to the item on screen when nothing is
// shelved yet.
async function drawDraft() {
  const body = document.getElementById('calcPaneBody');
  if (!body) return;
  const entries = draftEntries();
  if (!entries.length) return;
  const paint = (ready) => {
    if (paneMode !== 'draft') return;
    body.innerHTML =
      '<div class="draft" id="draftBlock">' +
        entries.map(q => draftItemHtml(q)).join('<div class="draft-gap"></div>') +
      '</div>' +
      '<button type="button" class="draft-copy" id="draftCopy"' + (ready ? '' : ' disabled') + '>' +
        (ready ? 'Copy for email' : 'Preparing order links…') + '</button>';
    document.getElementById('draftCopy').onclick = () => copyDraft();
  };
  paint(false);
  await attachOrderLinks(entries);
  paint(true);
}

// One shelved item, rendered for an email. The thumbnail earns its place —
// a client scanning a quote recognises the product before reading the specs.
function draftItemHtml(q) {
  const skip = /^(quantity|versions?|turnaround)$/i;
  const specRows = (q.specs || [])
    .filter(sp => !skip.test(String(sp.field).replace(/_/g, ' ')))
    .map(sp => '<tr><td>' + esc(String(sp.field).replace(/_/g, ' ')) + '</td><td>' +
               esc(sp.value) + '</td></tr>').join('');
  const qtyRows = q.rows.map(r =>
    '<tr><td>' + Number(r.quantity).toLocaleString() + '</td><td><b>$' +
    Number(r.price).toFixed(2) + '</b>' +
    (r.each ? ' <span class="dr-each">$' + Number(r.each).toFixed(2) + ' each</span>' : '') +
    '</td><td class="dr-order">' +
      (r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">Order now</a>' : '') +
    '</td></tr>').join('');
  const turn = (q.specs || []).find(sp => /turnaround/i.test(sp.field));

  return '<div class="draft-item">' +
    '<div class="draft-head">' +
      (q.image ? '<img src="' + esc(q.image) + '" alt="" onerror="this.remove()">' : '') +
      '<div class="draft-title">' + esc(q.product || '') + '</div>' +
    '</div>' +
    '<table class="draft-t">' + specRows + '</table>' +
    '<div class="draft-sub">Quantity</div>' +
    '<table class="draft-t draft-qty">' + qtyRows + '</table>' +
    (turn ? '<table class="draft-t"><tr><td>Turnaround</td><td>' + esc(turn.value) +
            '</td></tr></table>' : '') +
  '</div>';
}

// Rich HTML so it pastes into an email as a table with working "Order now"
// links, and plain text behind it (links spelled out) for anything that can't
// take HTML.
function emailHtml(block) {
  return '<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">' +
    block.innerHTML.replace(/ class="[^"]*"/g, '').replace(/ contenteditable="[^"]*"/g, '')
      .replace(/<table/g, '<table cellpadding="5" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px"')
      .replace(/<td/g, '<td style="border-bottom:1px solid #e5e5ef;padding:5px 10px"')
      .replace(/<a /g, '<a style="color:#4f46e5;font-weight:bold;text-decoration:underline" ')
      // Thumbnails survive the paste at a sensible size.
      .replace(/<img /g, '<img width="90" style="border-radius:6px;margin-right:12px;vertical-align:middle" ') +
    '</div>';
}
function emailText(block) {
  const copy = block.cloneNode(true);
  copy.querySelectorAll('a[href]').forEach(a => {
    a.replaceWith(document.createTextNode('Order now: ' + a.getAttribute('href')));
  });
  // innerText needs layout; a detached copy has none, so lay it out off-screen.
  copy.style.cssText = 'position:fixed;left:-9999px;top:0;width:600px';
  document.body.appendChild(copy);
  const text = copy.innerText;
  copy.remove();
  return text;
}
async function copyRich(block, btn, label) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([emailHtml(block)], { type: 'text/html' }),
      'text/plain': new Blob([emailText(block)], { type: 'text/plain' })
    })]);
    btn.textContent = 'Copied';
  } catch (e) {
    try { await navigator.clipboard.writeText(emailText(block)); btn.textContent = 'Copied'; }
    catch (e2) { btn.textContent = 'Could not copy'; }
  }
  setTimeout(() => { btn.textContent = label; }, 1800);
}
async function copyDraft() {
  const block = document.getElementById('draftBlock');
  const btn = document.getElementById('draftCopy');
  if (!block || !btn) return;
  copyRich(block, btn, 'Copy for email');
}

// ===== Draft a reply, in the side pane =====
// The client wrote in; this answers them. It uses the first message of the
// conversation as the thing being replied to, so the tone matches what they sent
// rather than reading as a form letter.
// Kept for the old entry points (cart popover, pane button).
function startDraft() { hideCart(); draftReplyInChat(); }

// ===== Help to draft email — the reply, drafted in the conversation =====
// Personal when the client is known ("Hi John, …"); in the tone of the last 30
// days of mail with them when their email is known (server: /api/chatbot/draft-reply).
// Under the words comes the quote itself — the saved items with an "Order now"
// link on every quantity — and one Copy puts the whole thing on the clipboard
// as an email-ready HTML (links and all), with a plain-text version behind it.
let drafting = false;
async function draftReplyInChat() {
  if (drafting) return;
  const entries = draftEntries();
  if (!entries.length) return;
  drafting = true;
  stickToBottom = true;

  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = '<div class="msg-avatar ai">AI</div>';
  const col = document.createElement('div');
  col.className = 'msg-col';
  col.innerHTML = '<div class="msg-meta">ChatBot</div>';
  const bubble = document.createElement('div');
  bubble.className = 'bubble ai has-cards';
  const who = (chatClientInfo && chatClientInfo.name) || chatClientName || '';
  bubble.innerHTML = '<div class="mail-wait"><span class="action-spin"></span>Drafting the reply' +
    (who ? ' to ' + esc(who) : '') + (chatClientInfo && chatClientInfo.email ? ' — reading your last 30 days of emails with them' : '') +
    '…</div>';
  col.appendChild(bubble);
  row.appendChild(col);
  document.getElementById('messagesInner').appendChild(row);
  scrollDown(true);

  // What they asked for: the first thing said in this chat, usually their email.
  const firstMsg = (chatHistory.find(m => m.role === 'user') || {}).content || '';
  const request = typeof firstMsg === 'string' ? firstMsg
    : ((firstMsg.find && firstMsg.find(x => x.type === 'text')) || {}).text || '';
  const summary = (e) => (e.specs || [])
    .filter(sp => !/^(quantity|versions?)$/i.test(String(sp.field)))
    .slice(0, 6).map(sp => sp.field + ': ' + sp.value).join('; ');

  let words = {};
  try {
    const [j] = await Promise.all([
      fetch('/api/chatbot/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          chat_id: currentChatId, client_id: chatClientId || null,
          client_name: who, client_email: (chatClientInfo && chatClientInfo.email) || '',
          company: (chatClientInfo && chatClientInfo.company) || '',
          request: request,
          items: entries.map(e => ({ product: e.product, summary: summary(e),
            rows: e.rows.map(r => ({ quantity: r.quantity, price: r.price })) }))
        })
      }).then(r => r.json()).catch(() => ({})),
      attachOrderLinks(entries)
    ]);
    words = j || {};
  } catch (e) {}

  // A snapshot, so the draft reads the same when the chat is reopened.
  const card = {
    type: 'email_draft',
    data: {
      to: words.to || null, client_name: words.client_name || who || null,
      subject: words.subject || ('Your quote: ' + entries[0].product),
      greeting: words.greeting || 'Hi there,', intro: words.intro || 'Here is the pricing based on your request:',
      outro: words.outro || 'Each quantity has an Order now link that opens the product with everything already selected. Let me know if you have any questions.',
      signoff: words.signoff || 'Best,',
      tone_emails: words.tone_emails || 0,
      entries: entries.map(e => ({
        product: e.product, image: e.image || null, specs: e.specs || [],
        rows: e.rows.map(r => ({ quantity: r.quantity, price: r.price, each: r.each, url: r.url || null }))
      }))
    }
  };
  bubble.innerHTML = '';
  bubble.appendChild(buildEmailDraft(card.data));
  scrollDown();
  drafting = false;

  if (currentChatId) {
    fetch('/api/chats/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ chat_id: currentChatId, role: 'assistant',
        content: 'Drafted a reply email' + (card.data.client_name ? ' to ' + card.data.client_name : '') + '.',
        cards: [card] })
    }).catch(() => {});
  }
}

function buildEmailDraft(d) {
  const el = document.createElement('div');
  el.className = 'mail-card';
  const para = (t) => t ? '<p>' + esc(t).replace(/\n/g, '<br>') + '</p>' : '';
  el.innerHTML =
    '<div class="mail-hd">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>' +
      '<b>Draft reply</b>' +
      (d.client_name || d.to ? '<span class="mail-to">to ' + esc(d.client_name || '') +
        (d.to ? ' &lt;' + esc(d.to) + '&gt;' : '') + '</span>' : '') +
    '</div>' +
    '<div class="mail-tone">' + (d.tone_emails
      ? 'Tone taken from ' + d.tone_emails + ' email' + (d.tone_emails === 1 ? '' : 's') + ' with them in the last 30 days.'
      : (d.to ? 'No emails with them in the last 30 days — standard tone.' : 'No client email connected — standard tone.')) +
      ' Click any text to edit it.</div>' +
    '<label class="mail-subj"><span>Subject</span><input type="text" value="' + esc(d.subject || '') + '"></label>' +
    '<div class="mail-body draft">' +
      '<div contenteditable="true">' + para(d.greeting) + para(d.intro) + '</div>' +
      (d.entries || []).map(q => draftItemHtml(q)).join('<div class="draft-gap"></div>') +
      '<div contenteditable="true">' + para(d.outro) + para(d.signoff) + '</div>' +
    '</div>' +
    '<div class="mail-acts">' +
      '<button type="button" class="mail-copy">Copy email</button>' +
      '<button type="button" class="mail-copysubj">Copy subject</button>' +
    '</div>';
  const cp = el.querySelector('.mail-copy');
  cp.onclick = () => copyRich(el.querySelector('.mail-body'), cp, 'Copy email');
  const cs = el.querySelector('.mail-copysubj');
  cs.onclick = async () => {
    try { await navigator.clipboard.writeText(el.querySelector('.mail-subj input').value); cs.textContent = 'Copied'; }
    catch (e) { cs.textContent = 'Could not copy'; }
    setTimeout(() => { cs.textContent = 'Copy subject'; }, 1600);
  };
  return el;
}

// ===== Checkout, in the side pane =====
// Client -> job name -> artwork -> delivery -> submit. Each step only asks what
// it needs, and the client step is skipped entirely when one is already on.
let checkoutCfg = null;

async function startCheckout() {
  hideCart();
  // Nothing carted, but a quote is on screen — order that rather than making
  // them cart it first just to satisfy the flow.
  if (!cartItems.length) {
    const btn = document.querySelector('.calc-pane .pq-cartbtn:not(:disabled)');
    if (btn) {
      btn.click();
      await new Promise(r => setTimeout(r, 900));
    }
    if (!cartItems.length) {
      const body = document.getElementById('calcPaneBody');
      if (body) {
        const m = document.createElement('div');
        m.className = 'co-msg';
        m.textContent = 'Add a quote to the cart first.';
        body.appendChild(m);
      }
      return;
    }
  }
  paneMode = 'checkout';
  const body = document.getElementById('calcPaneBody');
  const hd = document.querySelector('.calc-pane-hd span');
  if (hd) hd.textContent = 'Checkout';
  body.innerHTML = '<div class="co-loading">Loading…</div>';

  if (!chatClientId) { drawCheckoutClientStep(); return; }
  await loadCheckoutCfg();
  drawCheckoutForm();
}

async function loadCheckoutCfg() {
  try {
    const [r1, r2] = await Promise.all([
      fetch('/api/chatbot/order-fields?client_id=' + chatClientId,
        { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch('/api/chatbot/order-defaults?client_id=' + chatClientId,
        { headers: { 'Authorization': 'Bearer ' + token } })
    ]);
    checkoutCfg = { fields: await r1.json(), defaults: await r2.json() };
  } catch (e) { checkoutCfg = { fields: { choices: [] }, defaults: {} }; }
}

// Step 0 — no client yet, so find one before anything else.
function drawCheckoutClientStep() {
  const body = document.getElementById('calcPaneBody');
  body.innerHTML =
    '<div class="co-step"><div class="co-step-hd">Who is this order for?</div>' +
      '<input type="text" id="coClientQ" placeholder="Name, company or email" autocomplete="off">' +
      '<div id="coClientResults" class="co-results"></div>' +
    '</div>';
  const q = document.getElementById('coClientQ');
  let t = null;
  q.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = q.value.trim();
      if (term.length < 2) { document.getElementById('coClientResults').innerHTML = ''; return; }
      try {
        const r = await fetch('/api/chatbot/find-client?q=' + encodeURIComponent(term),
          { headers: { 'Authorization': 'Bearer ' + token } });
        const j = await r.json();
        const box = document.getElementById('coClientResults');
        box.innerHTML = (j.clients || []).slice(0, 8).map(c =>
          '<button type="button" class="co-client" data-id="' + c.id + '" data-name="' +
            esc((c.company ? c.name + ' (' + c.company + ')' : c.name) || '') + '">' +
            '<b>' + esc(c.name || '') + '</b>' +
            (c.company ? ' <span>' + esc(c.company) + '</span>' : '') +
            '<small>' + esc(c.email || '') + ' · ' + (c.orders || 0) + ' orders</small></button>').join('')
          || '<div class="co-none">No match</div>';
        box.querySelectorAll('.co-client').forEach(b => {
          b.onclick = async () => {
            await setChatClient(Number(b.getAttribute('data-id')), b.getAttribute('data-name'));
            await repriceCart(Number(b.getAttribute('data-id')));
            await loadCheckoutCfg();
            drawCheckoutForm();
          };
        });
      } catch (e) {}
    }, 250);
  };
  setTimeout(() => q.focus(), 80);
}

function drawCheckoutForm() {
  const body = document.getElementById('calcPaneBody');
  const cfg = (checkoutCfg && checkoutCfg.fields) || { choices: [] };
  const dflt = (checkoutCfg && checkoutCfg.defaults) || {};

  const sel = (key, id, val) => {
    const c = (cfg.choices || []).find(x => x.key === key);
    if (!c) return '';
    return '<select id="' + id + '">' + c.options.map(o =>
      '<option value="' + esc(o.value) + '"' +
      ((val || c.default) === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
      '</select>';
  };

  const addrs = dflt.addresses || [];
  body.innerHTML =
    '<div class="co-who">Ordering for <b>' + esc(chatClientName || '') + '</b>' +
      '<button type="button" onclick="drawCheckoutClientStep()">Change</button></div>' +

    '<div class="co-step"><div class="co-step-hd">Job name</div>' +
      '<input type="text" id="coName" placeholder="What this job is called">' +
      '<textarea id="coNotes" rows="2" placeholder="Notes for prepress (optional)"></textarea>' +
    '</div>' +

    '<div class="co-step"><div class="co-step-hd">Artwork</div>' +
      sel('design_type', 'coArtwork') +
      '<div class="co-hint">Choose "Send the Files Later" if artwork is not ready — the job still goes in.</div>' +
    '</div>' +

    '<div class="co-step"><div class="co-step-hd">Delivery</div>' +
      sel('shipping_method', 'coShip', dflt.shipping_method) +
      '<div id="coAddrWrap" style="display:none">' +
        (addrs.length
          ? '<select id="coAddr">' + addrs.map(a =>
              '<option value="' + a.id + '"' + (a.preferred ? ' selected' : '') + '>' +
              esc(a.label) + '</option>').join('') + '</select>'
          : '<div class="co-none">No addresses on file for this client — add one in the CRM first.</div>') +
        '<select id="coCarrier"><option value="">Shipping method — ask production</option></select>' +
      '</div>' +
    '</div>' +

    '<div class="co-step"><div class="co-step-hd">Needed by</div>' +
      '<input type="date" id="coDate" value="' + esc((dflt.needed_by || '').slice(0, 10)) + '">' +
    '</div>' +

    '<div class="co-items">' + cartItems.length + ' item' + (cartItems.length === 1 ? '' : 's') +
      ' · <b>$' + cartItems.reduce((a, b) => a + (Number(b.price) || 0), 0).toFixed(2) + '</b></div>' +
    '<div class="co-msg" id="coMsg"></div>' +
    '<button type="button" class="co-submit" id="coSubmit" onclick="submitCheckout(this)">Place order</button>';

  const ship = document.getElementById('coShip');
  const wrap = document.getElementById('coAddrWrap');
  const syncShip = () => {
    const v = ship ? ship.value : '';
    wrap.style.display = (v === 'shipping' || v === 'blind_drop_ship') ? 'block' : 'none';
  };
  if (ship) { ship.onchange = syncShip; syncShip(); }
}

async function submitCheckout(btn) {
  const msg = document.getElementById('coMsg');
  const name = (document.getElementById('coName') || {}).value || '';
  if (!name.trim()) { msg.textContent = 'Give the job a name.'; return; }

  const ship = (document.getElementById('coShip') || {}).value || 'pick_up';
  const addrEl = document.getElementById('coAddr');
  if ((ship === 'shipping' || ship === 'blind_drop_ship') && !addrEl) {
    msg.textContent = 'This client has no address on file — add one in the CRM, or choose pick up.';
    return;
  }

  const shared = {
    job_name: name.trim(),
    notes: (document.getElementById('coNotes') || {}).value || '',
    design_type: (document.getElementById('coArtwork') || {}).value || '',
    shipping_method: ship,
    address_id: addrEl ? Number(addrEl.value) : null,
    needed_by: (document.getElementById('coDate') || {}).value || ''
  };

  btn.disabled = true;
  msg.textContent = 'Placing…';
  try {
    const r = await fetch('/api/chatbot/order-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        chat_id: currentChatId, client_id: chatClientId,
        items: cartItems.map(it => Object.assign({ cart_id: it.id }, shared,
          { needed_by: shared.needed_by || it.ready_date || '' }))
      })
    });
    const j = await r.json();
    if (!j.ok) {
      btn.disabled = false;
      msg.textContent = j.missing ? j.missing.join('; ') : (j.error || 'Could not place it');
      return;
    }
    drawOrderDone(j);
    loadCart();
  } catch (e) {
    btn.disabled = false;
    msg.textContent = 'Could not place it.';
  }
}

function drawOrderDone(j) {
  const body = document.getElementById('calcPaneBody');
  const hd = document.querySelector('.calc-pane-hd span');
  if (hd) hd.textContent = 'Order placed';
  const nums = j.e_numbers || [];
  body.innerHTML =
    '<div class="co-done">' +
      '<div class="co-done-tick">\u2713</div>' +
      '<div class="co-done-hd">' + j.count + ' item' + (j.count === 1 ? '' : 's') + ' ordered</div>' +
      (nums.length
        ? '<div class="co-enums">' + nums.map(n =>
            '<a href="https://crm.axiomprint.com/estimates/' + esc(n.replace(/^E/, '')) +
            '" target="_blank" rel="noopener">' + esc(n) + '</a>').join('') + '</div>'
        : '<div class="co-hint">The order went through; estimate numbers were not returned.</div>') +
      '<div class="co-hint">Open each in the CRM to attach artwork and confirm shipping.</div>' +
    '</div>';
}

// Fold the card away rather than clearing it — the quote is still wanted, it is
// just taking up room while you read the chat.
function togglePaneFold() {
  const pane = document.getElementById('calcPane');
  const btn = document.getElementById('calcPaneFold');
  if (!pane) return;
  const folded = pane.classList.toggle('folded');
  if (btn) {
    btn.title = folded ? 'Expand' : 'Collapse';
    btn.setAttribute('aria-label', btn.title);
  }
}

function clearCalcPane() {
  const body = document.getElementById('calcPaneBody');
  if (body) {
    body.innerHTML = '<div class="calc-pane-empty">Pick a product in the chat and its price card ' +
      'opens here, where it stays while you keep talking.</div>';
  }
  const hd = document.querySelector('.calc-pane-hd span');
  if (hd) hd.textContent = 'Calculator';
}

// Every quote shown in the pane this session, so a marker can bring one back and
// a multi-quantity set can be drafted as one table.
const paneQuotes = [];

// A line in the conversation so the transcript still records what was quoted —
// with the quantity, which is the whole point when several are on screen.
function paneMarker(data, card) {
  const d = document.createElement('div');
  const idx = paneQuotes.length;
  paneQuotes.push({ data: data || {}, card: card, marker: d });

  const qty = Number(data && data.quantity);
  d.className = 'pq-moved';
  d.innerHTML = '<b>' + esc((data && data.product) || 'Quote') + '</b>' +
    (isFinite(qty) && qty ? ' <span class="pq-moved-q">Qty ' + qty.toLocaleString() + '</span>' : '') +
    ((data && data.price) != null ? ' <span class="pq-moved-p">$' +
      Number(data.price).toFixed(2) + '</span>' : '') +
    '<button type="button" class="pq-moved-order">Order now</button>' +
    '<button type="button" class="pq-moved-show">Show</button>';

  d.querySelector('.pq-moved-order').onclick = (e) => {
    const q = paneQuotes[idx];
    if (q) openOrderLink(liveOf(q), e.currentTarget);
  };
  d.querySelector('.pq-moved-show').onclick = () => {
    // Bring that exact quote back into the pane rather than just scrolling to
    // whatever happens to be there.
    const q = paneQuotes[idx];
    if (!q) return;
    showInPane(q.card, q.data.product);
    document.querySelectorAll('.pq-moved.on').forEach(n => n.classList.remove('on'));
    d.classList.add('on');
  };
  return d;
}

// Two or more quotes for the same product at different quantities are a price
// ladder — the thing an AM actually pastes into an email.
function quantityLadder() {
  const byProduct = {};
  paneQuotes.forEach(q => {
    const id = q.data.product_id;
    if (!id) return;
    (byProduct[id] = byProduct[id] || []).push(q);
  });
  let best = null;
  Object.keys(byProduct).forEach(id => {
    const set = byProduct[id];
    const qtys = {};
    set.forEach(q => { qtys[Number(q.data.quantity)] = q; });
    const rows = Object.keys(qtys).map(Number).filter(n => n > 0).sort((a, b) => a - b);
    if (rows.length > 1 && (!best || rows.length > best.rows.length)) {
      best = { rows: rows, quotes: qtys, sample: set[set.length - 1].data };
    }
  });
  return best;
}

function renderCard(box, j) {
  if (!cardHasContent(j)) return;
  // Hold a steady width from the first card onward, so the bubble doesn't start
  // narrow around a line of text and snap wider when the price card lands.
  box.classList.add('has-cards');
  box.querySelectorAll('.typing-dots').forEach(n => n.remove());
  switch (j.type) {
    case 'job_card':
      box.appendChild(buildJobCard(j.data || {}));
      break;
    case 'price_quote': {
      const card = buildPriceCard(Object.assign({ __replace: j.replace }, j.data || {}));
      // Wide screens: the quote lives in the side pane so it stays put while the
      // conversation carries on. Narrow screens have no room, so it stays inline.
      if (usePane()) {
        showInPane(card, (j.data || {}).product);
        box.appendChild(paneMarker(j.data || {}, card));
      } else {
        box.appendChild(card);
      }
      break;
    }
    case 'client_card':
      if (j.client && j.client.id) lastClientId = j.client.id;
      box.appendChild(buildClientCard(j.client || {}));
      break;
    case 'client_picks':
      box.appendChild(buildClientPicks(j.clients || [], { replace: j.replace }));
      break;
    case 'product_cards':
      box.appendChild(buildProductCards(j.products || [], { calculating: j.calculating }));
      break;
    case 'turnaround':
      box.appendChild(buildTurnaround(j.data || {}));
      break;
    case 'choice_picks':
      box.appendChild(buildChoicePicks(j));
      break;
    case 'option_picks':
      box.appendChild(buildOptionPicks(j));
      break;
    case 'product_picks':
      box.appendChild(buildPicks(j.products || [],
        { intent: j.intent, ask_about: j.ask_about, replace: j.replace }));
      break;
    case 'report': {
      // A Nova report — see nova-report.js. Compact card in the pane, one line in the chat.
      if (!window.NovaReport) break;
      if (!usePane()) { NovaReport.render(box, j, { getToken: () => token }); break; }
      if (j.replace) box.querySelectorAll('.nr-moved').forEach(n => n.remove());
      const marker = document.createElement('div');
      marker.className = 'nr-moved';
      const describe = (r) => {
        const head = r && r.summary && r.summary[0];
        const t = marker.querySelector('.nr-moved-t');
        if (t) t.innerHTML = '<b>' + esc((r && r.title) || 'Report') + '</b>' +
          (head ? ' · ' + esc(head.label) + ': <b>' + esc(head.fmt === 'money'
            ? '$' + Number(head.value).toLocaleString('en-US', { maximumFractionDigits: 0 })
            : Number(head.value).toLocaleString('en-US')) + '</b>' : '') + ' — open beside the chat.';
      };
      marker.innerHTML = '<span class="nr-moved-t">Running the report\u2026</span>' +
        '<button type="button" data-m="show">Show</button><button type="button" class="pri" data-m="full">Full view</button>';
      const card = NovaReport.build(j, { getToken: () => token, onChange: describe });
      if (j.result) describe(j.result);
      else { const t0 = setInterval(() => { const r = card.__novaReport.result(); if (r) { describe(r); clearInterval(t0); } }, 400);
             setTimeout(() => clearInterval(t0), 30000); }
      marker.querySelector('[data-m="show"]').onclick = () => showInstallInPane(card, marker);
      marker.querySelector('[data-m="full"]').onclick = () => { showInstallInPane(card, marker); card.__novaReport.open(); };
      box.appendChild(marker);
      showInstallInPane(card, marker);
      break;
    }
    case 'email_draft':
      if (j.data) { box.innerHTML = ''; box.appendChild(buildEmailDraft(j.data)); }
      break;
    case 'install_quote': {
      // Installation / local delivery calculator — see install-calc.js.
      if (!window.InstallCalc) break;
      if (!usePane()) { InstallCalc.render(box, j, { getToken: () => token }); break; }
      // Wide screens: the calculator opens in the right pane and the chat keeps
      // one line with the live estimate, so the conversation stays readable.
      if (j.replace) box.querySelectorAll('.ic-moved').forEach(n => n.remove());
      const marker = document.createElement('div');
      marker.className = 'ic-moved';
      marker.innerHTML = '<span class="ic-moved-t">Opening calculator…</span><button type="button">Show</button>';
      const card = InstallCalc.build(j, {
        getToken: () => token,
        onChange: (q) => {
          const t = marker.querySelector('.ic-moved-t');
          if (!t) return;
          t.innerHTML = (q.total == null
            ? 'This one needs a person — see the calculator for why.'
            : 'Estimated price is <b>' + esc(InstallPricing.money(q.total)) + '</b>' +
              (q.provisional ? ' (provisional)' : '') + '. See details on the calculator.');
        }
      });
      marker.querySelector('button').onclick = () => showInstallInPane(card, marker);
      box.appendChild(marker);
      showInstallInPane(card, marker);
      break;
    }
  }
}

async function sendMessage() {
  if (isLoading) return;
  const input = document.getElementById('input');
  const text = input.value.trim();
  // Attachments must never be able to block plain typing. If the module failed
  // to load, sending text still works.
  const hasFiles = (window.AxiomFiles && AxiomFiles.count()) || 0;
  if (!text && !hasFiles) return;
  const files = hasFiles ? AxiomFiles.take() : [];
  input.value = ''; input.style.height = '40px';
  document.getElementById('suggestions').style.display = 'none';
  isLoading = true;
  document.getElementById('sendBtn').disabled = true;

  stickToBottom = true;        // sending is an explicit "take me to the bottom"
  addUserRow(text || '(attachment)');

  // Images and PDFs travel as native blocks; extracted text is folded into the
  // message so the model reads a spreadsheet as content, not as a filename.
  const usable = files.filter(f => f.kind !== 'error' && f.kind !== 'pending');
  if (usable.length) {
    const blocks = [];
    usable.forEach(f => {
      if (f.kind === 'image') {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } });
      } else if (f.kind === 'pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
      } else if (f.text) {
        blocks.push({ type: 'text', text: '--- ' + (f.name || 'file') + ' ---\n' + f.text });
      }
    });
    blocks.push({ type: 'text', text: text || 'See the attached.' });
    chatHistory.push({ role: 'user', content: blocks });
  } else {
    chatHistory.push({ role: 'user', content: text });
  }

  // Ensure a chat exists; persist the user message
  if (!currentChatId) {
    try {
      const r = await fetch('/api/chats/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ agent_slug: currentAgent, title: text.slice(0, 120),
        source: EMBED ? 'crm-widget' : undefined }) });
      const j = await r.json();
      if (j.success) {
        currentChatId = j.chat_id;
        // A client picked before the first message still belongs to this chat.
        if (chatClientId) setChatClient(chatClientId, chatClientName);
        loadChatList();
        embedNotify('chat');
      }
    } catch (e) {}
  }
  if (currentChatId) {
    fetch('/api/chats/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, role: 'user', content: text }) });
  }

  const startTime = Date.now();

  // AI row
  const row = document.createElement('div');
  row.className = 'msg-row';
  const timer = document.createElement('span'); timer.className = 'msg-timer'; timer.textContent = '0.0s';
  const meta = document.createElement('div'); meta.className = 'msg-meta';
  meta.appendChild(document.createTextNode('ChatBot'));
  meta.appendChild(timer);
  const stepsBox = document.createElement('div'); stepsBox.className = 'steps';
  const bubble = document.createElement('div'); bubble.className = 'bubble ai';
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  const col = document.createElement('div'); col.className = 'msg-col';
  col.appendChild(meta); col.appendChild(stepsBox); col.appendChild(bubble);
  row.innerHTML = '<div class="msg-avatar ai">AI</div>';
  row.appendChild(col);
  document.getElementById('messagesInner').appendChild(row);
  scrollDown();
  const timerInt = setInterval(() => { timer.textContent = ((Date.now() - startTime) / 1000).toFixed(1) + 's'; }, 100);

  let fullText = '';
  const turnCards = [];        // cards drawn in this answer, saved alongside it
  bubble.classList.add('streaming');
  let answerStarted = false;

  function ensureTextEl() {
    let el = bubble.querySelector('.ai-text');
    if (!el) { el = document.createElement('div'); el.className = 'ai-text'; bubble.insertBefore(el, bubble.firstChild); }
    return el;
  }

  try {
    // Abortable, so a later click can stop this one — the server watches the
    // dropped connection and stops generating rather than finishing an answer
    // nobody will read.
    activeStream = new AbortController();
    const res = await fetch('/api/chatbot/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messages: chatHistory, chat_id: currentChatId }),
      signal: activeStream.signal
    });
    // Say what actually went wrong. "Connection error" for a 401 or a 500 sends
    // people looking at the network when the answer is in the response body.
    if (!res.ok || !res.body) {
      let detail = 'HTTP ' + res.status;
      try {
        const t = await res.text();
        if (t) detail += ' — ' + t.slice(0, 300);
      } catch (e) {}
      if (res.status === 401 || res.status === 403) {
        detail = 'Your session has expired. Sign out and back in.';
      }
      bubble.innerHTML = '<p style="color:#ef4444">' + esc(detail) + '</p>';
      console.error('[Nova] chat request failed:', res.status, detail);
      isLoading = false;
      document.getElementById('sendBtn').disabled = false;
      clearInterval(timerInt);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]' || d === '') continue;
        let j; try { j = JSON.parse(d); } catch (e) { continue; }

        if (j.type === 'error') {
          bubble.innerHTML = '<p style="color:#ef4444">Error: ' + esc(j.error) + '</p>';
        } else if (j.type === 'query') {
          // A tool is running, so a card is coming — take the width now rather
          // than reflowing when it arrives.
          bubble.classList.add('has-cards');
          bubble.querySelectorAll('.typing-dots').forEach(n => n.remove());
          if (!stepsBox.firstChild) {
            stepsBox.innerHTML = '<span class="action-spin"></span><span class="action-label"></span>';
            stepsBox.classList.add('active');
          }
          const lbl = stepsBox.querySelector('.action-label');
          if (lbl) { lbl.style.opacity = 0; setTimeout(() => { lbl.textContent = j.description; lbl.style.opacity = 1; }, 100); }
          scrollDown();
        } else if (CARD_TYPES.indexOf(j.type) > -1) {
          // Draw it, and keep it so reopening this chat shows the same thing.
          // A report is saved as its settings only — its rows are re-run on reopen.
          turnCards.push(j.type === 'report' && window.NovaReport ? NovaReport.toSaved(j) : j);
          renderCard(bubble, j);
          scrollDown();
        } else if (j.type === 'client_pinned') {
          chatClientId = j.client_id;
          chatClientName = j.client_name || chatClientName;
          renderClientBar();
          repriceForClient(j.client_id, chatClientName);
          repriceCart(j.client_id);
        } else if (j.type === 'query_done') {
          // keep spinner until next action / answer
        } else if (j.type === 'timing') {
          // (timing chips omitted for the conversational UI; total shown via the row timer)
        } else if (j.type === 'text') {
          fullText += j.text;
          noteJobSize(fullText);      // "1) … 2) …" tells us how many items the job has
          if (!answerStarted) {
            // Remove ONLY the typing indicator. Wiping the whole bubble here would
            // destroy anything already rendered into it (turnaround timeline,
            // product picks, client chip) the moment the answer starts streaming.
            bubble.querySelectorAll('.typing-dots').forEach(n => n.remove());
            answerStarted = true;
          }
          ensureTextEl().innerHTML = renderMarkdown(fullText);
          scrollDown();
        }
      }
    }

    // Cards are a complete answer, so "No response." must not appear under a list
    // of product matches. But the cards live INSIDE this bubble — removing it
    // takes them with it, which is exactly what wiped the answer. Only strip the
    // chrome when the bubble is genuinely empty.
    if (!answerStarted && !fullText) {
      bubble.querySelectorAll('.typing-dots').forEach(n => n.remove());
      const hasCards = bubble.children.length > 0;
      if (hasCards) {
        bubble.classList.add('bare');      // cards only: drop the bubble styling
      } else {
        bubble.innerHTML = '<p style="color:var(--muted)">No response.</p>';
      }
    }
    if (fullText) chatHistory.push({ role: 'assistant', content: fullText });

    // Persist assistant message + rating buttons
    if (currentChatId && fullText) {
      try {
        const r = await fetch('/api/chats/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, role: 'assistant', content: fullText, cards: turnCards }) });
        const j = await r.json();
        if (j.success && j.message_id) bubble.appendChild(buildRating(j.message_id, 0));
      } catch (e) {}
    }
  } catch (e) {
    // A deliberate cancellation is not a failure — say nothing.
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) {
      isLoading = false;
      return;
    }
    // Show the real exception — a silent "connection error" hid a null response
    // body and cost an afternoon of looking in the wrong place.
    console.error('[Nova] chat error:', e);
    bubble.innerHTML = '<p style="color:#ef4444">Something went wrong: ' +
      esc(e && e.message ? e.message : String(e)) + '</p>';
  }

  activeStream = null;
  bubble.classList.remove('streaming');
  clearInterval(timerInt);
  timer.textContent = 'Answered in ' + ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  if (stepsBox.classList.contains('active')) { stepsBox.classList.add('done'); setTimeout(() => { stepsBox.style.display = 'none'; }, 400); }
  isLoading = false;
  document.getElementById('sendBtn').disabled = false;
  input.focus();
  embedNotify('chat');
}





// Clickable product choices, ranked. Only the best few show up front.
// Visual production timeline — mirrors the turnaround calculator, in Axiom indigo.
// Price from the real calculator engine. Shows every spec used and flags the
// ones that were defaulted rather than asked for.
// Clicking an E-number anywhere in a reply opens that job.
document.addEventListener('click', (e) => {
  const b = e.target.closest ? e.target.closest('.enum-link') : null;
  if (!b) return;
  e.preventDefault();
  hideJobPeek();
  ask('Show me job E' + b.getAttribute('data-e'));
});

// Hovering an E-number shows a quick preview: product, photo, status.
// Results are cached, so hovering the same job repeatedly costs one request.
const jobPeekCache = {};
let peekBox = null, peekTimer = null, peekFor = null;

function hideJobPeek() {
  clearTimeout(peekTimer);
  peekFor = null;
  if (peekBox) { peekBox.remove(); peekBox = null; }
}

function placeJobPeek(el) {
  if (!peekBox) return;
  const r = el.getBoundingClientRect();
  const w = 250;
  const h = peekBox.offsetHeight || 150;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.top - h - 10;
  if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - h - 8);
  peekBox.style.left = left + 'px';
  peekBox.style.top = top + 'px';
}

async function showJobPeek(el, eNum) {
  peekFor = eNum;
  let data = jobPeekCache[eNum];
  if (!data) {
    try {
      const r = await fetch('/api/chatbot/job-peek?e=' + encodeURIComponent(eNum), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      data = await r.json();
      jobPeekCache[eNum] = data;
    } catch (e) { return; }
  }
  // The pointer may have moved on while the request was in flight.
  if (peekFor !== eNum || !data || !data.ok) return;
  hideJobPeekBoxOnly();
  peekBox = document.createElement('div');
  peekBox.className = 'jp-peek jp-' + (data.stage || 'prepress');
  peekBox.innerHTML =
    (data.image ? '<img src="' + esc(data.image) + '" alt="" onerror="this.remove()">' : '') +
    '<div class="jp-body">' +
      '<div class="jp-prod">' + esc(data.product || data.name || 'Job') + '</div>' +
      (data.name && data.product ? '<div class="jp-name">' + esc(data.name) + '</div>' : '') +
      '<div class="jp-meta">' + esc([data.client, data.created].filter(Boolean).join(' · ')) +
      (data.total != null ? ' · $' + Number(data.total).toFixed(2) : '') + '</div>' +
      '<div class="jp-status">' + esc(data.status || '') + '</div>' +
    '</div>';
  document.body.appendChild(peekBox);
  placeJobPeek(el);
}

function hideJobPeekBoxOnly() { if (peekBox) { peekBox.remove(); peekBox = null; } }

document.addEventListener('mouseover', (e) => {
  const b = e.target.closest ? e.target.closest('.enum-link') : null;
  if (!b) return;
  const eNum = b.getAttribute('data-e');
  clearTimeout(peekTimer);
  // Short delay so scanning past a number doesn't fire a request.
  peekTimer = setTimeout(() => showJobPeek(b, eNum), 220);
});
document.addEventListener('mouseout', (e) => {
  const b = e.target.closest ? e.target.closest('.enum-link') : null;
  if (b) hideJobPeek();
});
window.addEventListener('scroll', hideJobPeek, true);










// Open a product straight into an editable price card on the product's own
// defaults. Deliberately NOT used by the "Price it" chip — that goes through the
// model so specs already given in the chat are applied. Kept for a genuinely
// context-free open.
let lastClientId = null;
async function openCalculator(productId, name) {
  const inner = document.getElementById('messagesInner');
  const row = document.createElement('div');
  row.className = 'msg-row';
  row.innerHTML = '<div class="msg-avatar ai">AI</div><div class="msg-col">' +
    '<div class="msg-meta">ChatBot</div><div class="bubble ai"></div></div>';
  inner.appendChild(row);
  const bubble = row.querySelector('.bubble');
  bubble.innerHTML = '<div class="calc-loading">Opening the calculator for ' + esc(name) + '…</div>';
  scrollDown();
  try {
    const r = await fetch('/api/chatbot/reprice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ product_id: productId, client_id: lastClientId })
    });
    const j = await r.json();
    if (!j.ok) { bubble.innerHTML = '<div class="calc-loading">Could not price that product: ' + esc(j.error || '') + '</div>'; return; }
    bubble.innerHTML = '';
    bubble.appendChild(buildPriceCard(j));
    scrollDown();
  } catch (e) {
    bubble.innerHTML = '<div class="calc-loading">Connection error.</div>';
  }
}




function renderMarkdown(text) {
  // Extract tables first
  const lines = text.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Table detection: a line with | and next line is separator
    if (line.includes('|') && i+1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1]) && lines[i+1].includes('-')) {
      const header = line.split('|').map(c=>c.trim()).filter(c=>c.length);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) {
        const cells = lines[i].split('|').map(c=>c.trim()).filter((c,idx,arr)=> !(idx===0&&c==='') && !(idx===arr.length-1&&c===''));
        if (cells.length) rows.push(cells);
        i++;
      }
      let t = '<div class="tbl-wrap"><table><thead><tr>';
      header.forEach(h => t += '<th>' + inline(h) + '</th>');
      t += '</tr></thead><tbody>';
      rows.forEach(r => { t += '<tr>'; r.forEach(c => t += '<td>' + inline(c) + '</td>'); t += '</tr>'; });
      t += '</tbody></table></div>';
      html += t;
      continue;
    }
    if (/^##\s+/.test(line)) { html += '<h2>' + inline(line.replace(/^##\s+/,'')) + '</h2>'; i++; continue; }
    if (/^---+\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^[-*]\s+/.test(line)) {
      let items = '';
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items += '<li>' + inline(lines[i].replace(/^[-*]\s+/,'')) + '</li>'; i++; }
      html += '<ul>' + items + '</ul>';
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    html += '<p>' + inline(line) + '</p>';
    i++;
  }
  return html;
}


function inline(t) {
  return t
    // E-numbers identify jobs — make them openable straight from any answer.
    .replace(/\bE(\d{6,9})\b/g, '<button type="button" class="enum-link" data-e="$1">E$1</button>')
    // Images first — otherwise the link rule below would swallow ![alt](url)
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener" class="cb-img-link">' +
      '<img class="cb-img" src="$2" alt="$1" loading="lazy"></a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="prod-link">$1</a>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}

// Cards are shared with the CRM widget — one implementation, in axiom-cards.js.
if (window.AxiomFiles) AxiomFiles.init({ getToken: () => token, pendingEl: 'pendingBar' });

AxiomCards.init({
  getToken: () => token,
  ask: (t) => ask(t),
  scroll: () => scrollDown(),
  pinClient: (id, name) => setChatClient(id, name),
  addToCart: (item) => addToCart(item),
  // With the cart off, the card's third button is Save.
  onSave: CART_ON ? null : (card, st) => saveToShelf(card, st),
  saveLabel: () => moreItemsToCome() ? 'Save & next item' : 'Save',
  onChange: (card, st) => onCardRepriced(card, st),
  orderLink: (st) => orderLinks([st]).then(u => u[0]),
  openOrder: (st, btn) => openOrderLink(st, btn),
  onCartAdd: () => {
    renderPaneActions();
    // Carting item 1 is the cue to start item 2 — the person has finished with
    // this one and said so.
    ask('Added that to the cart. Move on to the next item from my original message — state its own ' +
        'specs, then search for it. If that was the last item, just say the cart is ready.');
  }
});
const buildPriceCard    = (d) => AxiomCards.priceCard(d);
const buildJobCard      = (d) => AxiomCards.jobCard(d);
const buildClientCard   = (d) => AxiomCards.clientCard(d);
const buildClientPicks  = (d, o) => AxiomCards.clientPicks(d, o);
const buildOptionPicks  = (d) => AxiomCards.optionPicks(d);
const buildChoicePicks  = (d) => AxiomCards.choicePicks(d);
const buildTurnaround   = (d) => AxiomCards.turnaround(d);
const buildProductCards = (d) => AxiomCards.productCards(d);
const buildPicks        = (d, o) => AxiomCards.picks(d, o);
const buildRating       = (id, r) => AxiomCards.rating(id, r);
