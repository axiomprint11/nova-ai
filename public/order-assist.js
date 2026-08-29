// ===== Order Assist — standalone agent page =====
// Auth happens on the homepage (/). This page requires a token; if missing, bounce home.
let token = localStorage.getItem('axiom_token');
let username = localStorage.getItem('axiom_user');
let isAdmin = localStorage.getItem('axiom_admin') === '1';
let currentChatId = null;
let chatHistory = [];
let isLoading = false;
let agents = [];
const currentAgent = 'order-assist';            // fixed for this page
function agentName() { return 'Order Assist'; }
let lastFlowCtx = null;  // holds client + emails of the most recent flow, for Draft Email

// DEBUG: step-through mode. When true, the flow pauses after each step and waits
// for a "Next" button click. Toggle from the browser console: DEBUG_STEPS = true
let DEBUG_STEPS = false;

// Render a Next button into `host` and return a promise that resolves when clicked.
function waitForNext(host, label) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:10px 0;display:flex;align-items:center;gap:10px;';
    const btn = document.createElement('button');
    btn.textContent = label || 'Next →';
    btn.style.cssText = 'background:#6366f1;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;';
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:12px;color:#999;';
    hint.textContent = 'debug pause';
    btn.onclick = () => { wrap.remove(); resolve(); };
    wrap.appendChild(btn); wrap.appendChild(hint);
    host.appendChild(wrap);
    scrollDown();
  });
}

// Global 401 handling: an expired/invalid token bounces back to the sign-in page (home).
(function () {
  const _fetch = window.fetch;
  window.fetch = async function (url, opts) {
    const res = await _fetch(url, opts);
    try {
      if (res.status === 401 && typeof url === 'string' && url.indexOf('/api/') === 0 && url.indexOf('/api/login') !== 0) {
        try { localStorage.removeItem('axiom_token'); } catch (e) {}
        window.location.href = '/';
      }
    } catch (e) {}
    return res;
  };
})();

if (!token) { window.location.href = '/'; }
else {
  // Validate the token before showing the app; if expired, go to sign-in.
  fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => { if (r.status === 401 || !r.ok) { try { localStorage.removeItem('axiom_token'); } catch (e) {} window.location.href = '/'; return; } showApp(); })
    .catch(() => { showApp(); });
}

function autoResize(el) {
  el.style.height = '40px';
  const h = Math.min(el.scrollHeight, 120);
  el.style.height = h + 'px';
  // Only show a scrollbar when content genuinely exceeds the max height; otherwise hide it.
  el.style.overflowY = (el.scrollHeight > 120) ? 'auto' : 'hidden';
}
function logout() { localStorage.clear(); window.location.href = '/'; }

function showApp() {
  // Inject CRM label + new-client styles once
  if (!document.getElementById('crm-inline-styles')) {
    const st = document.createElement('style');
    st.id = 'crm-inline-styles';
    st.textContent =
      '.crm-label{display:block;font-weight:600;font-size:13px;border-radius:8px;padding:8px 12px;margin-bottom:8px;}' +
      '.crm-existing{background:#e8f5ee;color:#1a7f4b;border:1px solid #b7e0c8;}' +
      '.crm-new{background:#fff4e5;color:#b86e00;border:1px solid #ffd699;}' +
      '.crm-email{font-weight:500;opacity:0.85;margin-left:6px;}' +
      '.crm-sub{display:block;font-weight:400;font-size:12px;color:#9a6a1a;margin-top:3px;}' +
      '.newclient-note{background:#fff4e5;color:#8a5a00;border:1px solid #ffd699;border-radius:8px;padding:10px 12px;font-size:13px;margin:8px 0;}' +
      '.calc-turn-panel{margin-top:16px;}' +
      '.turn-title{display:block;margin-bottom:7px;}' +
      '.turn-cards{display:flex;gap:8px;flex-wrap:wrap;}' +
      '.turn-card{flex:1 1 132px;min-width:118px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:10px 8px;border:1.5px solid #e5e5ef;border-radius:10px;background:#fff;cursor:pointer;font-family:inherit;text-align:center;transition:border-color .12s,box-shadow .12s;}' +
      '.turn-card:hover:not(.disabled){border-color:#7C6FE0;}' +
      '.turn-card.selected{border-color:#4f46e5;box-shadow:inset 0 0 0 1px #4f46e5;}' +
      '.turn-card.disabled{opacity:.45;cursor:not-allowed;}' +
      '.turn-note{font-size:10px;font-weight:500;color:#8b8fa3;text-transform:none;letter-spacing:0;margin-left:8px;font-style:italic;}' +
      '.turn-label{font-size:12.5px;font-weight:600;color:#1e1b2e;line-height:1.25;}' +
      '.turn-price{font-size:15px;font-weight:700;color:#111;}' +
      '.turn-each{font-size:11px;color:#8a8a9a;}';
    document.head.appendChild(st);
  }
  document.getElementById('app').style.display = 'flex';
  document.getElementById('userLabel').textContent = username || '';
  document.getElementById('avatar').textContent = (username || 'U').charAt(0).toUpperCase();
  const ab = document.getElementById('adminBtn');
  if (ab) {
    // Show the link for admins, or members who have any Domain Knowledge access.
    if (isAdmin) { ab.style.display = 'inline-flex'; ab.textContent = 'Admin'; }
    else {
      ab.style.display = 'none';
      fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(r => r.json())
        .then(me => {
          if (me && (me.is_admin || (me.knowledge_access && me.knowledge_access !== 'none'))) {
            ab.style.display = 'inline-flex';
            ab.textContent = me.is_admin ? 'Admin' : 'My area';
          }
        }).catch(() => {});
    }
  }
  loadAgents();
}

// Slug -> page route. Keep in sync with the launcher (index.html).
const AGENT_ROUTES = {
  'order-assist': '/order-assist',
  'chatbot': '/chatbot',
  'prepress-ai': '/prepress'
};

async function loadAgents() {
  try {
    const res = await fetch('/api/agents', { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await res.json();
    agents = (j.agents || []);
  } catch (e) { agents = []; }
  // Populate the topbar dropdown. Active+built agents are selectable; others disabled.
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

// Switching agents = navigating to that agent's page (each agent is its own page now).
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
  row.innerHTML = '<div class="msg-avatar ai">AI</div><div class="msg-col"><div class="msg-meta">Order Assist</div><div class="bubble ai">' +
    "Hi! I'm here to help with pricing and estimates — share a client request or email and I'll identify the client, find the right product, and prepare a quote." +
    '</div></div>';
  document.getElementById('messagesInner').appendChild(row);
}

function clearChat() {
  chatHistory = [];
  currentChatId = null;
  document.getElementById('messagesInner').innerHTML = '';
  greet();
}

// Rating buttons on an AI answer
function buildRating(messageId, current) {
  const wrap = document.createElement('div');
  wrap.className = 'rating';
  wrap.innerHTML =
    '<button class="rate-btn up' + (current === 1 ? ' active' : '') + '" title="Good answer">' +
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg></button>' +
    '<button class="rate-btn down' + (current === -1 ? ' active' : '') + '" title="Bad answer">' +
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg></button>';
  const [upBtn, downBtn] = wrap.querySelectorAll('.rate-btn');
  function rate(val) {
    const newVal = (val === 1 && upBtn.classList.contains('active')) || (val === -1 && downBtn.classList.contains('active')) ? 0 : val;
    upBtn.classList.toggle('active', newVal === 1);
    downBtn.classList.toggle('active', newVal === -1);
    fetch('/api/messages/rate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ message_id: messageId, rating: newVal }) });
  }
  upBtn.onclick = () => rate(1);
  downBtn.onclick = () => rate(-1);
  return wrap;
}

// Save a stage's content to history and append a "Was this helpful?" rating strip to `host`.
// Used at each advancement (context ready, quote built, draft email) so users can rate each step.
async function attachRatingStrip(host, label, content) {
  if (!currentChatId) return;
  try {
    const r = await fetch('/api/chats/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, role: 'assistant', content: content || label }) });
    const j = await r.json();
    if (j.success && j.message_id) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:14px;padding-top:10px;border-top:1px solid #eee;display:flex;align-items:center;gap:10px;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:12px;color:#888;';
      lbl.textContent = label || 'Was this helpful?';
      wrap.appendChild(lbl);
      wrap.appendChild(buildRating(j.message_id, 0));
      host.appendChild(wrap);
      scrollDown();
    }
  } catch (e) {}
}

// History sidebar list
async function loadChatList() {
  const box = document.getElementById('chatList');
  if (!box) return;
  try {
    const res = await fetch('/api/chats?agent=' + encodeURIComponent(currentAgent), { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await res.json();
    if (!j.success) return;
    box.innerHTML = '';
    j.chats.forEach(c => {
      const item = document.createElement('div');
      item.className = 'chat-item' + (c.id === currentChatId ? ' active' : '');
      item.innerHTML = '<div class="chat-item-title">' + esc(c.title || 'Chat') + '</div>' +
        '<div class="chat-item-date">' + fmtDate(c.updated_at) + '</div>';
      item.onclick = () => openChat(c.id);
      box.appendChild(item);
    });
  } catch (e) {}
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function openChat(id) {
  try {
    const res = await fetch('/api/chats/' + id, { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await res.json();
    if (!j.success) return;
    currentChatId = id;
    chatHistory = [];
    document.getElementById('suggestions').style.display = 'none';
    const inner = document.getElementById('messagesInner');
    inner.innerHTML = '';
    j.messages.forEach(m => {
      if (m.role === 'user') {
        addUserRow(m.content, []);
        chatHistory.push({ role: 'user', content: m.content });
      } else {
        const row = document.createElement('div');
        row.className = 'msg-row';
        const col = document.createElement('div');
        col.className = 'msg-col';
        col.innerHTML = '<div class="msg-meta">' + esc(agentName(currentAgent)) + '</div>';
        const bubble = document.createElement('div');
        bubble.className = 'bubble ai';
        bubble.innerHTML = renderMarkdown(m.content);
        col.appendChild(bubble);
        bubble.appendChild(buildRating(m.id, m.rating));
        row.innerHTML = '<div class="msg-avatar ai">AI</div>';
        row.appendChild(col);
        inner.appendChild(row);
        chatHistory.push({ role: 'assistant', content: m.content });
      }
    });
    loadChatList();
    scrollDown();
  } catch (e) {}
}

function ask(text, forceClassic) {
  document.getElementById('input').value = text;
  document.getElementById('suggestions').style.display = 'none';
  sendMessage(forceClassic);
}

function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

function scrollDown() { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; }

function addUserRow(text, files) {
  const row = document.createElement('div');
  row.className = 'msg-row user';
  const safe = (text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let filesHtml = '';
  if (files && files.length) {
    filesHtml = '<div class="attach-grid" style="justify-content:flex-end;margin-bottom:6px">';
    files.forEach(f => {
      const isImg = /^image\//.test(f.mime);
      if (isImg) {
        filesHtml += '<div class="attach-card" onclick="enlargeImg(\'' + f.dataUrl.replace(/'/g, "\\'") + '\')" style="cursor:zoom-in">' +
          '<img class="attach-thumb" src="' + f.dataUrl + '">' +
          '<div class="attach-name">' + esc(f.name) + '</div></div>';
      } else {
        filesHtml += '<div class="attach-card" style="cursor:default"><div class="attach-pdf">PDF</div>' +
          '<div class="attach-name">' + esc(f.name) + '</div></div>';
      }
    });
    filesHtml += '</div>';
  }
  const bubbleHtml = safe ? '<div class="bubble user">' + safe + '</div>' : '';
  row.innerHTML = '<div class="msg-avatar user">' + (username||'U').charAt(0).toUpperCase() + '</div><div class="msg-col"><div class="msg-meta">You</div>' + filesHtml + bubbleHtml + '</div>';
  document.getElementById('messagesInner').appendChild(row);
  scrollDown();
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
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="prod-link">$1</a>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}

/* ============ INTERACTIVE CALCULATOR ============ */
let calcCounter = 0;

function buildCalculator(data, sizeHint) {
  const id = 'calc' + (++calcCounter);
  // Organize items by variable
  const varsById = {};
  data.variables.forEach(v => { varsById[v.id] = { ...v, items: [] }; });
  data.items.forEach(it => { if (varsById[it.variable_id]) varsById[it.variable_id].items.push(it); });
  const vars = data.variables.map(v => varsById[v.id]).filter(v => v.items.length || /custom/i.test(v.title));

  // Parse filter rules: item_id -> [{relatedTo(variable_id), relatedItems:[ids]}]
  const filtersByItem = {};
  (data.filters || []).forEach(f => {
    let rel = f.relatedItems;
    try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch(e) { rel = []; }
    if (!Array.isArray(rel)) rel = [];
    if (!filtersByItem[f.product_variable_item_id]) filtersByItem[f.product_variable_item_id] = [];
    filtersByItem[f.product_variable_item_id].push({ relatedTo: f.relatedTo, relatedItems: rel.map(Number) });
  });

  // Initial selection: defaults (or first item), honoring preselect
  const sel = {}; // variable_id -> item_id
  const preselect = data.preselect || {};
  vars.forEach(v => {
    let chosen = null;
    const want = preselect[v.title];
    if (want != null) {
      const m = v.items.find(it => String(it.title).toLowerCase() === String(want).toLowerCase()
        || String(it.title).replace(/\s/g,'').toLowerCase().includes(String(want).replace(/\s/g,'').toLowerCase()));
      if (m) chosen = m.id;
    }
    if (!chosen) { const d = v.items.find(it => it.default == 1); chosen = d ? d.id : (v.items[0] ? v.items[0].id : null); }
    sel[v.id] = chosen;
  });

  const state = { id, data, vars, varsById, filtersByItem, sel, custom: {}, customSize: (data.customSize && data.customSize.w && data.customSize.h) ? { w: Number(data.customSize.w), h: Number(data.customSize.h) } : null, inactiveFields: (data.inactiveFields || []).map(Number), hasVersions: !!data.hasVersions, versions: (data.versionCount && data.versionCount > 1 ? data.versionCount : 1), versionQtys: [] };
  // Prefill version names/quantities from the client's own email lines when supplied.
  if (state.hasVersions && state.versions > 1) {
    const names = Array.isArray(data.versionNames) ? data.versionNames : [];
    const qtys = Array.isArray(data.versionQtys) ? data.versionQtys : [];
    if (names.length) {
      state.versionNames = new Array(state.versions).fill('').map((_, i) => names[i] || '');
    }
    if (qtys.length && qtys.some(q => q != null)) {
      state.versionQtys = new Array(state.versions).fill(0).map((_, i) => (qtys[i] != null ? Number(qtys[i]) : 0));
    }
  }
  // AUTOFILL CUSTOM SIZE — never leave W/H blank.
  // The Custom Size option carries no dimensions, so without W x H the formula has
  // no area and the price is wrong. Fill in priority order, same as the live site:
  //   1. what the server resolved   2. the size the client asked for
  //   3. the product's own defaultWidth/defaultHeight from configs
  if (customSizeActive(state)) {
    if (!state.customSize) {
      const fromReq = parseWH(sizeHint || data.requestedSize || '');
      if (fromReq && fromReq.w > 0 && fromReq.h > 0) {
        state.customSize = { w: fromReq.w, h: fromReq.h };
        state.customSizeSource = 'client';
      }
    } else {
      state.customSizeSource = state.customSizeSource || 'client';
    }
    if (!state.customSize) {
      const L = sizeLimits(state);
      if (L.defW && L.defH) {
        state.customSize = { w: L.defW, h: L.defH };
        state.customSizeSource = 'default';
      }
    }
  }
  // Field-level dependency rules (parent gating), for live active/inactive computation.
  state.depByVar = {};
  (data.fieldDeps || []).forEach(f => {
    let rel = f.relatedItems; try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch (e) { rel = []; }
    if (!Array.isArray(rel)) rel = [];
    (state.depByVar[f.product_variable_id] = state.depByVar[f.product_variable_id] || []).push({ relatedTo: Number(f.relatedTo), items: rel.map(Number) });
  });
  CALC_STATE[id] = state;

  const wrap = document.createElement('div');
  wrap.className = 'calc';
  wrap.id = id;
  wrap.innerHTML = renderCalcHTML(state);
  // Attach after insert via event delegation (set up once globally)
  setTimeout(() => bindCalc(state), 0);
  return wrap;
}

// ---- Custom size support ---------------------------------------------------
// Size fields are typed `size_new` (W x H) or `size_3D` (W x H x D) and always
// carry their dimensions in configs: defaultWidth/defaultHeight (+ min/max).
// The "Custom Size" option (product_variable_item.custom = 1) has no dimensions
// in its title, so W/H must be entered - exactly like the live site calculator.
function isSizeVar(v) { return !!v && (v.type === 'size_new' || v.type === 'size_3D' || /size/i.test(v.title || '')); }
function isCustomItem(it) { return !!it && (it.custom == 1 || it.custom === '1' || it.custom === true || /custom/i.test(it.title || '')); }
function sizeVarOf(state) { return (state.vars || []).find(isSizeVar) || null; }
function selectedSizeItem(state) {
  const v = sizeVarOf(state);
  if (!v) return null;
  return v.items.find(it => it.id == state.sel[v.id]) || null;
}
function customSizeActive(state) { return isCustomItem(selectedSizeItem(state)); }
function sizeLimits(state) {
  const v = sizeVarOf(state);
  const cfg = (v && v.cfg) ? v.cfg : {};
  const n = (x) => { const y = Number(x); return isFinite(y) && y > 0 ? y : null; };
  return {
    minW: n(cfg.minWidth), maxW: n(cfg.maxWidth),
    minH: n(cfg.minHeight), maxH: n(cfg.maxHeight),
    defW: n(cfg.defaultWidth), defH: n(cfg.defaultHeight),
    unit: cfg.metric || 'inch'
  };
}
// Mirrors the server: price it anyway, but warn when it's outside the limits.
function customSizeWarning(state) {
  const cs = state.customSize;
  if (!cs || !cs.w || !cs.h) return '';
  const L = sizeLimits(state);
  if ((L.maxW && cs.w > L.maxW) || (L.maxH && cs.h > L.maxH)) {
    return 'Over the product limit (max ' + (L.maxW || '?') + '" W × ' + (L.maxH || '?') + '" H). Still priced — confirm before production.';
  }
  if ((L.minW && cs.w < L.minW) || (L.minH && cs.h < L.minH)) {
    return 'Under the product minimum (min ' + (L.minW || '?') + '" W × ' + (L.minH || '?') + '" H). Still priced — confirm before production.';
  }
  return '';
}
// If typed dimensions match a preset size, say so — presets are cheaper.
function matchingPresetSize(state) {
  const cs = state.customSize;
  const v = sizeVarOf(state);
  if (!cs || !cs.w || !cs.h || !v) return null;
  const cfg = v.cfg || {};
  const flippable = !(cfg.wxh === false || cfg.wxh === 0 || cfg.wxh === '0' || cfg.wxh === 'false');
  return v.items.find(it => {
    if (isCustomItem(it)) return false;
    const wh = parseWH(it.title);
    if (!wh) return false;
    if (wh.w === cs.w && wh.h === cs.h) return true;
    if (flippable && wh.w === cs.h && wh.h === cs.w) return true;
    return false;
  }) || null;
}

function itemAvailable(state, item) {  const rules = state.filtersByItem[item.id];
  if (!rules || !rules.length) return true;
  // Item available only if, for each rule, the selected item in relatedTo variable is in relatedItems
  return rules.every(r => {
    const selectedItemId = state.sel[r.relatedTo];
    if (selectedItemId == null) return true;
    return r.relatedItems.includes(Number(selectedItemId));
  });
}

// Current total quantity selected in the calc (custom qty or selected tier value)
function currentQtyValue(state) {
  if (state.customQty != null && state.customQty !== '') return Number(state.customQty);
  const qtyVar = state.vars.find(v => /quantity|qty/i.test(v.title));
  if (!qtyVar) return 0;
  const it = (qtyVar.items || []).find(i => i.id == state.sel[qtyVar.id]);
  return it ? Number(it.value) : 0;
}
// Split a total evenly across n versions, remainder distributed to the first ones
function splitEven(total, n) {
  total = Number(total) || 0; n = Math.max(1, n);
  const base = Math.floor(total / n); let rem = total - base * n;
  const out = [];
  for (let i = 0; i < n; i++) { out.push(base + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
  return out;
}
// Render the per-version Quantity + Name panel (matches the site's layout)
function renderVersionsPanel(state, total) {
  if (!state.versionQtys || state.versionQtys.length !== state.versions) {
    state.versionQtys = splitEven(total, state.versions);
  }
  // Names are tracked separately - a prefilled quantity list must not wipe them.
  if (!state.versionNames || state.versionNames.length !== state.versions) {
    const prev = state.versionNames || [];
    state.versionNames = new Array(state.versions).fill('').map((_, i) => prev[i] || '');
  }
  let rows = '';
  for (let i = 0; i < state.versions; i++) {
    rows += '<div class="ver-row">' +
      '<div class="ver-rowlabel">Version ' + (i + 1) + '</div>' +
      '<div class="ver-input"><label>Quantity</label><input type="number" class="ver-qty" data-calc="' + state.id + '" data-vi="' + i + '" value="' + (state.versionQtys[i] || 0) + '" /></div>' +
      '<div class="ver-input"><label>Name</label><input type="text" class="ver-name" data-calc="' + state.id + '" data-vi="' + i + '" placeholder="Design name" value="' + esc((state.versionNames && state.versionNames[i]) || '') + '" /></div>' +
      '</div>';
  }
  const sum = (state.versionQtys || []).reduce((a, b) => a + (Number(b) || 0), 0);
  const mismatch = sum !== Number(total) ? '<div class="ver-warn">Per-version total (' + sum + ') doesn\'t match the order quantity (' + total + ').</div>' : '';
  return '<div class="calc-versions-panel"><div class="ver-panel-title">Versions</div>' + rows + mismatch + '</div>';
}

function renderCalcHTML(state) {
  const price = computePrice(state);
  let body = '';
  state.vars.forEach(v => {
    if (/turnaround/i.test(v.title)) return;   // rendered as cards below
    const isQty = /quantity|qty/i.test(v.title);
    const niceLabel = esc((v.title || '').replace(/_/g, ' '));
    const isHiddenField = (v.hidden == 1 || v.hidden === true || v.hidden === '1' || v.internal == 1 || v.internal === true || v.internal === '1');
    const isInactive = (state.inactiveFields || []).includes(Number(v.id));
    const hiddenCls = (isHiddenField ? ' calc-field-hidden' : '') + (isInactive ? ' calc-field-inactive' : '');
    const inactiveTag = isInactive ? ' <span class="inactive-tag" title="Not applicable with the current selection">n/a</span>' : '';
    const eyeIcon = isHiddenField ? ' <span class="hidden-eye" title="Hidden field — not shown to customers"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></span>' : '';
    let opts = '';
    v.items.forEach(it => {
      const avail = itemAvailable(state, it);
      const selected = state.sel[v.id] == it.id ? ' selected' : '';
      const dis = avail ? '' : ' disabled';
      opts += '<option value="' + it.id + '"' + selected + dis + '>' + esc(it.title) + '</option>';
    });
    if (isQty) {
      const curQty = currentQtyValue(state); // total quantity currently selected
      const verStepper = state.hasVersions
        ? '<div class="calc-versions-ctrl"><span class="calc-label">Versions</span>' +
          '<div class="ver-stepper"><button type="button" class="ver-minus" data-calc="' + state.id + '">–</button>' +
          '<span class="ver-count" id="' + state.id + '_vercount">' + state.versions + '</span>' +
          '<button type="button" class="ver-plus" data-calc="' + state.id + '">+</button></div></div>'
        : '';
      body += '<div class="calc-qty-row">' +
        '<div class="calc-field' + hiddenCls + '" style="flex:1"><span class="calc-label">' + niceLabel + eyeIcon + inactiveTag + '</span>' +
        '<select class="calc-select" data-var="' + v.id + '">' + opts + '</select></div>' +
        verStepper + '</div>' +
        '<div class="calc-field"><span class="calc-label">Custom Qty</span>' +
        '<input type="number" class="calc-custom-qty" data-calc="' + state.id + '" placeholder="e.g. 25000" value="' + (state.customQty != null ? state.customQty : '') + '" /></div>' +
        (state.hasVersions && state.versions > 1 ? renderVersionsPanel(state, curQty) : '');
    } else {
      body += '<div class="calc-field' + hiddenCls + '"><span class="calc-label">' + niceLabel + eyeIcon + inactiveTag + '</span>' +
        '<select class="calc-select" data-var="' + v.id + '">' + opts + '</select>' +
        (isSizeVar(v) ? renderCustomSizeRow(state) : '') +
        '</div>';
    }
  });

  const customNote = (state.customQty != null && state.customQty !== '' && price == null)
    ? '<div class="calc-note" style="color:#ef4444">That quantity is below the minimum available.</div>' : '';
  const sizeTag = (state.customSize && state.customSize.w && state.customSize.h)
    ? ' · ' + state.customSize.w + '" × ' + state.customSize.h + '"' : '';
  return '<div class="calc-head"><div class="calc-title">' + esc(state.data.product.title) + '</div>' +
    '<div class="calc-price" id="' + state.id + '_price">' + (price == null ? '—' : '$' + price.toFixed(2)) +
    ' <small>list price' + sizeTag + (state.customQty ? ' · ' + Number(state.customQty).toLocaleString() + ' qty' : '') + '</small></div></div>' +
    '<div class="calc-body">' + body + renderTurnaroundPanel(state) + customNote + '</div>';
}

function renderCustomSizeRow(state) {
  if (!customSizeActive(state)) return '';
  const cs = state.customSize || {};
  const L = sizeLimits(state);
  const wVal = (cs.w != null && cs.w !== '') ? cs.w : '';
  const hVal = (cs.h != null && cs.h !== '') ? cs.h : '';
  const unit = L.unit === 'cm' ? 'cm' : 'in';
  const src = state.customSizeSource;
  const srcBadge = src === 'client' ? '<span class="cs-src cs-src-client">from client</span>'
    : src === 'default' ? '<span class="cs-src cs-src-default">product default</span>'
    : '';
  const rangeBits = [];
  if (L.minW || L.maxW) rangeBits.push('W ' + (L.minW || 0) + '–' + (L.maxW || '?'));
  if (L.minH || L.maxH) rangeBits.push('H ' + (L.minH || 0) + '–' + (L.maxH || '?'));
  const rangeHint = rangeBits.length ? rangeBits.join(' · ') + ' ' + unit : '';
  const warn = customSizeWarning(state);
  const preset = matchingPresetSize(state);
  let note = '';
  if (!wVal || !hVal) {
    note = '<div class="cs-note cs-need">Enter width and height — the price needs both.</div>';
  } else if (preset) {
    note = '<div class="cs-note cs-preset">Matches the preset <strong>' + esc(preset.title) + '</strong> — usually cheaper.' +
      ' <button type="button" class="cs-use-preset" data-calc="' + state.id + '" data-item="' + preset.id + '">Use preset</button></div>';
  } else if (warn) {
    note = '<div class="cs-note cs-warn">' + esc(warn) + '</div>';
  }
  return '<div class="calc-custom-size" id="' + state.id + '_cs">' +
    '<div class="cs-head"><span class="cs-title">Size (W × H)</span>' + srcBadge +
      (rangeHint ? '<span class="cs-range">' + esc(rangeHint) + '</span>' : '') + '</div>' +
    '<div class="cs-inputs">' +
      '<label class="cs-field"><span>W</span>' +
        '<input type="number" step="0.01" min="0" class="cs-w" data-calc="' + state.id + '" value="' + esc(wVal) + '" placeholder="0.00" />' +
        '<em>' + unit + '</em>' +
      '</label>' +
      '<span class="cs-x">×</span>' +
      '<label class="cs-field"><span>H</span>' +
        '<input type="number" step="0.01" min="0" class="cs-h" data-calc="' + state.id + '" value="' + esc(hVal) + '" placeholder="0.00" />' +
        '<em>' + unit + '</em>' +
      '</label>' +
    '</div>' + note +
  '</div>';
}

function redrawCustomSize(state) {
  const el = document.getElementById(state.id + '_cs');
  if (!el) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = renderCustomSizeRow(state);
  const fresh = wrap.firstElementChild;
  if (fresh) el.replaceWith(fresh);
  else el.remove();
}

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function enlargeImg(src) {
  let lb = document.getElementById('imgLightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'imgLightbox';
    lb.className = 'lightbox';
    lb.onclick = () => { lb.style.display = 'none'; };
    lb.innerHTML = '<img>';
    document.body.appendChild(lb);
  }
  lb.querySelector('img').src = src;
  lb.style.display = 'flex';
}

function updateCalcPrice(state) {
  const price = computePrice(state);
  const pEl = document.getElementById(state.id + '_price');
  if (pEl) {
    const qtyNote = state.customQty ? ' · ' + Number(state.customQty).toLocaleString() + ' qty' : '';
    const sizeNote = (state.customSize && state.customSize.w && state.customSize.h)
      ? ' · ' + state.customSize.w + '" × ' + state.customSize.h + '"' : '';
    pEl.innerHTML = (price == null ? '—' : '$' + price.toFixed(2)) + ' <small>list price' + sizeNote + qtyNote + '</small>';
  }
  redrawTurnaround(state);
  return price;
}

function bindCalc(state) {
  const root = document.getElementById(state.id);
  if (!root) return;
  root.querySelectorAll('.calc-select').forEach(seln => {
    seln.addEventListener('change', (e) => {
      const vid = e.target.getAttribute('data-var');
      state.sel[vid] = parseInt(e.target.value);
      // Choosing a quantity tier from the dropdown clears any custom qty
      const vObj0 = state.varsById[vid];
      if (vObj0 && /quantity|qty/i.test(vObj0.title)) {
        state.customQty = null;
        const ci = root.querySelector('.calc-custom-qty');
        if (ci) ci.value = '';
      }
      // Re-evaluate availability; if any selected item is now invalid, switch to first available
      state.vars.forEach(v => {
        const cur = v.items.find(it => it.id == state.sel[v.id]);
        if (cur && !itemAvailable(state, cur)) {
          const firstOk = v.items.find(it => itemAvailable(state, it));
          if (firstOk) state.sel[v.id] = firstOk.id;
        }
      });
      root.querySelectorAll('.calc-select').forEach(s2 => {
        const v2 = s2.getAttribute('data-var');
        const vObj = state.varsById[v2];
        Array.from(s2.options).forEach(opt => {
          const it = vObj.items.find(i => i.id == opt.value);
          if (it) opt.disabled = !itemAvailable(state, it);
        });
        s2.value = state.sel[v2];
      });
      // Switching the Size option shows/hides the width x height inputs
      const vObjSize = state.varsById[vid];
      if (vObjSize && isSizeVar(vObjSize)) {
        if (!customSizeActive(state)) {
          state.customSize = null;
          state.customSizeSource = null;
        } else if (!state.customSize) {
          // Switched back to Custom — reseed with the product's default dimensions
          const L = sizeLimits(state);
          if (L.defW && L.defH) { state.customSize = { w: L.defW, h: L.defH }; state.customSizeSource = 'default'; }
        }
        redrawCustomSize(state);
      }
      updateCalcPrice(state);
    });
  });
  // Custom quantity input
  const ci = root.querySelector('.calc-custom-qty');
  if (ci) {
    ci.addEventListener('input', (e) => {
      const v = e.target.value.trim();
      state.customQty = v === '' ? null : Number(v);
      // re-split versions across the new total
      if (state.hasVersions && state.versions > 1) { state.versionQtys = splitEven(currentQtyValue(state), state.versions); redrawVersions(state); }
      updateCalcPrice(state);
    });
  }
  // Custom size (width x height) — delegated so it survives redraws of the row
  root.addEventListener('input', (e) => {
    if (!e.target.classList) return;
    if (!e.target.classList.contains('cs-w') && !e.target.classList.contains('cs-h')) return;
    const wEl = root.querySelector('.cs-w');
    const hEl = root.querySelector('.cs-h');
    const w = wEl && wEl.value.trim() !== '' ? Number(wEl.value) : null;
    const h = hEl && hEl.value.trim() !== '' ? Number(hEl.value) : null;
    state.customSize = (w && h && w > 0 && h > 0) ? { w: w, h: h } : null;
    state.customSizeSource = 'manual';
    updateCalcPrice(state);
  });
  // Re-render the hint line only after typing settles, so focus isn't stolen mid-entry
  root.addEventListener('change', (e) => {
    if (!e.target.classList) return;
    if (e.target.classList.contains('cs-w') || e.target.classList.contains('cs-h')) redrawCustomSize(state);
  });
  // "Use preset" — typed dimensions matched a standard size, which prices lower
  root.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.cs-use-preset') : null;
    if (!btn) return;
    const itemId = parseInt(btn.getAttribute('data-item'));
    const sv = sizeVarOf(state);
    if (!sv || !itemId) return;
    state.sel[sv.id] = itemId;
    state.customSize = null;
    const seln = root.querySelector('.calc-select[data-var="' + sv.id + '"]');
    if (seln) seln.value = itemId;
    redrawCustomSize(state);
    updateCalcPrice(state);
  });
  // Versions stepper
  const vminus = root.querySelector('.ver-minus');
  const vplus = root.querySelector('.ver-plus');
  if (vminus) vminus.addEventListener('click', () => { if (state.versions > 1) { state.versions--; state.versionQtys = splitEven(currentQtyValue(state), state.versions); redrawVersions(state); updateCalcPrice(state); } });
  if (vplus) vplus.addEventListener('click', () => { if (state.versions < 50) { state.versions++; state.versionQtys = splitEven(currentQtyValue(state), state.versions); redrawVersions(state); updateCalcPrice(state); } });
  bindTurnaround(state);
  bindVersionInputs(state);
}

// (Re)draw just the versions panel + count, then rebind its inputs
function redrawVersions(state) {
  const root = document.getElementById(state.id);
  if (!root) return;
  const cnt = root.querySelector('#' + state.id + '_vercount'); if (cnt) cnt.textContent = state.versions;
  const panel = root.querySelector('.calc-versions-panel');
  const html = (state.hasVersions && state.versions > 1) ? renderVersionsPanel(state, currentQtyValue(state)) : '';
  if (panel) { panel.outerHTML = html; }
  else if (html) {
    // insert after the custom-qty field
    const cq = root.querySelector('.calc-custom-qty');
    if (cq) { const wrap = document.createElement('div'); wrap.innerHTML = html; cq.closest('.calc-field').insertAdjacentElement('afterend', wrap.firstChild); }
  }
  bindVersionInputs(state);
}
function bindVersionInputs(state) {
  const root = document.getElementById(state.id);
  if (!root) return;
  root.querySelectorAll('.ver-qty').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.vi);
      state.versionQtys[i] = Number(e.target.value) || 0;
      const warn = root.querySelector('.ver-warn');
      const sum = state.versionQtys.reduce((a,b)=>a+(Number(b)||0),0);
      // live mismatch note
      const panel = root.querySelector('.calc-versions-panel');
      if (panel) {
        let w = panel.querySelector('.ver-warn');
        if (sum !== currentQtyValue(state)) {
          if (!w) { w = document.createElement('div'); w.className='ver-warn'; panel.appendChild(w); }
          w.textContent = "Per-version total (" + sum + ") doesn't match the order quantity (" + currentQtyValue(state) + ").";
        } else if (w) { w.remove(); }
      }
    });
  });
  root.querySelectorAll('.ver-name').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.vi);
      if (!state.versionNames) state.versionNames = [];
      state.versionNames[i] = e.target.value;
    });
  });
}

// Parse "W x H" from a size title
function parseWH(title) {
  // Tolerate inch marks and unit words between the number and the separator:
  // 24x36, 24 x 36, 24" x 36", 24in x 36in, 24 × 36
  const m = String(title).match(/([0-9]*\.?[0-9]+)\s*(?:"|''|”|in\b|inch(?:es)?\b)?\s*[xX×]\s*([0-9]*\.?[0-9]+)/);
  if (m) return { w: parseFloat(m[1]), h: parseFloat(m[2]) };
  return null;
}

// Build the token environment and evaluate product.formula
function calcKeysFor(v) {
  const t = (v.title || '').trim();
  const ks = new Set([t.replace(/\s+/g, '_'), t, t.replace(/\s+/g, '')]);
  if (v.name) ks.add(v.name);
  return Array.from(ks).filter(Boolean);
}

// Build env for all selected options EXCEPT quantity, then apply a specific qty item
function calcEnvBase(state) {
  const env = {};
  const qtyVar = state.vars.find(v => /quantity|qty/i.test(v.title));
  const vCount = (state.hasVersions && state.versions > 1) ? state.versions : 1;
  // A field is active unless a parent dependency isn't satisfied by the current selection.
  const isActive = (v) => {
    const deps = (state.depByVar || {})[v.id];
    if (!deps || !deps.length) return true;
    return deps.every(dep => {
      const parentSelId = state.sel[dep.relatedTo];
      return parentSelId != null && dep.items.includes(Number(parentSelId));
    });
  };
  state.vars.forEach(v => {
    if (qtyVar && v.id === qtyVar.id) return;
    // Skip parent-gated inactive fields so they contribute 0 (e.g. Foil Color when Foil = No).
    if (!isActive(v)) return;
    const it = v.items.find(i => i.id == state.sel[v.id]);
    if (!it) return;
    const val = (it.value == null || it.value === '') ? 0 : Number(it.value);
    const baseVal = (it.base == null) ? 0 : Number(it.base);
    let wh = parseWH(it.title);
    // For a custom size, the dimensions aren't in the option title — use state.customSize.
    if (!wh && /size/i.test(v.title) && /custom/i.test(it.title) && state.customSize) {
      wh = { w: state.customSize.w, h: state.customSize.h };
    }
    calcKeysFor(v).forEach(key => {
      env[key] = val; env[key + '$base'] = baseVal; env[key + '$versionsCount'] = vCount;
      if (wh) { env[key + '$w'] = wh.w; env[key + '$h'] = wh.h; }
    });
  });
  return { env, qtyVar };
}

function priceAtQtyItem(state, baseEnv, qi) {
  const env = Object.assign({}, baseEnv);
  const qval = Number(qi.value) || 0;
  const vCount = (state.hasVersions && state.versions > 1) ? state.versions : 1;
  env['Qty'] = qval; env['Quantity'] = qval;
  env['Qty$base'] = Number(qi.base) || 0; env['Quantity$base'] = Number(qi.base) || 0;
  env['Qty$versionsCount'] = vCount; env['Quantity$versionsCount'] = vCount;
  return evalFormula(state.data.product.formula, env);
}

// Custom-qty interpolation mirroring the live customCountCalculation
function priceAtCustomQty(state, baseEnv, qtyVar, q) {
  const items = (qtyVar.items || []).map(it => ({ value: Number(it.value), item: it }))
    .filter(x => isFinite(x.value)).sort((a, b) => a.value - b.value);
  if (!items.length) return null;
  const exact = items.find(x => x.value === q);
  if (exact) return priceAtQtyItem(state, baseEnv, exact.item);
  const combined = items.concat([{ value: q, item: null }]).sort((a, b) => a.value - b.value);
  const index = combined.findIndex(x => x.value === q && x.item === null);
  if (index === 0) return null; // below smallest
  const prev = combined[index - 1];
  const prevPrice = priceAtQtyItem(state, baseEnv, prev.item);
  if (prevPrice == null) return null;
  let total;
  if (index === combined.length - 1) {
    total = (prevPrice / prev.value) * q;
  } else {
    const next = combined[index + 1];
    const nextPrice = priceAtQtyItem(state, baseEnv, next.item);
    if (nextPrice == null) return null;
    total = (nextPrice * q - prev.value * nextPrice + next.value * prevPrice - q * prevPrice) / (next.value - prev.value);
  }
  return Math.floor(total * 100) / 100;
}

function computePrice(state) {
  try {
    // Custom size selected but no dimensions typed yet -> the area is unknown, so
    // any number here would be wrong. Show "—" until width and height are entered.
    if (customSizeActive(state) && !(state.customSize && state.customSize.w && state.customSize.h)) return null;
    const { env, qtyVar } = calcEnvBase(state);
    if (!qtyVar) return evalFormula(state.data.product.formula, env);
    // custom qty entered?
    if (state.customQty != null && state.customQty !== '' && isFinite(Number(state.customQty))) {
      return priceAtCustomQty(state, env, qtyVar, Number(state.customQty));
    }
    const qi = qtyVar.items.find(i => i.id == state.sel[qtyVar.id]);
    if (qi) return priceAtQtyItem(state, env, qi);
    return evalFormula(state.data.product.formula, env);
  } catch(e) { console.error('calc error', e); return null; }
}

// Safe-ish formula evaluator: supports + - * / ( ), floor(), and $-suffixed tokens
function evalFormula(formula, env) {
  if (!formula) return null;
  const tokens = Object.keys(env).sort((a,b) => b.length - a.length);
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
  } catch(e) { console.error('eval fail', expr, e); return null; }
}


// ===== Turnaround price cards =====
// Turnaround renders as a row of cards showing the price of each option,
// instead of a dropdown in the field grid.

function turnaroundVar(state) {
  return state.vars.find(v => /turnaround/i.test(v.title));
}

// Price the job as if `itemId` were the chosen turnaround.
// computePrice() reads state.sel, so swap it, measure, swap back.
function priceForTurnaroundItem(state, itemId) {
  const tv = turnaroundVar(state);
  if (!tv) return null;
  const prev = state.sel[tv.id];
  state.sel[tv.id] = itemId;
  let p = null;
  try { p = computePrice(state); } catch (e) { p = null; }
  state.sel[tv.id] = prev;
  return p;
}

// Slowest first (matches the website); Express has no digits so it lands last.
function turnaroundItemsSorted(tv) {
  return (tv.items || []).slice().sort((a, b) => {
    const da = parseInt((String(a.title).match(/(\d+)/) || [])[1] || '0');
    const db = parseInt((String(b.title).match(/(\d+)/) || [])[1] || '0');
    return db - da;
  });
}

function renderTurnaroundPanel(state) {
  const tv = turnaroundVar(state);
  if (!tv || !tv.items || !tv.items.length) return '';
  const qty = currentQtyValue(state);

  // Turnarounds are gated by quantity via product_variable_filters (relatedTo /
  // relatedItems). Options that don't apply at the current quantity are not
  // orderable, so don't show them at all — an empty "—" card just invites a
  // click on something the client can't actually have.
  const available = turnaroundItemsSorted(tv).filter(it => itemAvailable(state, it));
  if (!available.length) return '';

  // If the selected turnaround is no longer valid (e.g. the default 6 Business Days
  // at qty 50), move the selection to the first one that is.
  if (!available.some(it => state.sel[tv.id] == it.id)) {
    state.sel[tv.id] = available[0].id;
  }

  const hiddenCount = turnaroundItemsSorted(tv).length - available.length;

  const cards = available.map(it => {
    const isSel = state.sel[tv.id] == it.id;
    const price = priceForTurnaroundItem(state, it.id);
    const each = (price != null && qty > 0)
      ? '<span class="turn-each">$' + (price / qty).toFixed(2) + ' each</span>'
      : '';
    return '<button type="button" class="turn-card' + (isSel ? ' selected' : '') + '"' +
      ' data-calc="' + state.id + '" data-item="' + it.id + '">' +
      '<span class="turn-label">' + esc(it.title) + '</span>' +
      '<span class="turn-price">' + (price == null ? '\u2014' : '$' + price.toFixed(2)) + '</span>' +
      each +
      '</button>';
  }).join('');

  const note = hiddenCount > 0
    ? '<span class="turn-note">' + hiddenCount + ' option' + (hiddenCount === 1 ? '' : 's') +
      ' not available at this quantity</span>'
    : '';

  return '<div class="calc-turn-panel">' +
    '<span class="calc-label turn-title">' + esc((tv.title || 'Turnaround').replace(/_/g, ' ')) + note + '</span>' +
    '<div class="turn-cards">' + cards + '</div></div>';
}

function bindTurnaround(state) {
  const root = document.getElementById(state.id);
  if (!root) return;
  const tv = turnaroundVar(state);
  if (!tv) return;

  root.querySelectorAll('.turn-card').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('disabled')) return;
      state.sel[tv.id] = parseInt(btn.dataset.item);

      // A turnaround change can invalidate filtered options elsewhere.
      state.vars.forEach(v => {
        const cur = v.items.find(it => it.id == state.sel[v.id]);
        if (cur && !itemAvailable(state, cur)) {
          const firstOk = v.items.find(it => itemAvailable(state, it));
          if (firstOk) state.sel[v.id] = firstOk.id;
        }
      });
      root.querySelectorAll('.calc-select').forEach(s2 => {
        const v2 = s2.getAttribute('data-var');
        const vObj = state.varsById[v2];
        if (!vObj) return;
        Array.from(s2.options).forEach(opt => {
          const it = vObj.items.find(i => i.id == opt.value);
          if (it) opt.disabled = !itemAvailable(state, it);
        });
        s2.value = state.sel[v2];
      });

      updateCalcPrice(state);
    });
  });
}

function redrawTurnaround(state) {
  const root = document.getElementById(state.id);
  if (!root) return;
  const panel = root.querySelector('.calc-turn-panel');
  if (!panel) return;
  const html = renderTurnaroundPanel(state);
  if (!html) { panel.remove(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  panel.replaceWith(tmp.firstChild);
  bindTurnaround(state);
}

const CALC_STATE = {};

function buildJobFiles(items) {
  const grid = document.createElement('div');
  grid.className = 'attach-grid';
  items.forEach(f => {
    const url = '/api/drivefile?token=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(f.id);
    const card = document.createElement('a');
    card.className = 'attach-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener';
    const isImg = /^image\//.test(f.mime);
    if (isImg) {
      card.innerHTML = '<img class="attach-thumb" src="' + url + '" loading="lazy" alt="">' +
        '<div class="attach-name">' + esc(f.filename || '') + '</div>';
    } else {
      card.innerHTML = '<div class="attach-pdf">PDF</div>' +
        '<div class="attach-name">' + esc(f.filename || '') + '</div>';
    }
    grid.appendChild(card);
  });
  return grid;
}

function buildAttachments(items) {
  const grid = document.createElement('div');
  grid.className = 'attach-grid';
  items.forEach(a => {
    const url = '/api/attachment?token=' + encodeURIComponent(token) +
      '&msg=' + encodeURIComponent(a.msg) + '&i=' + a.index +
      '&name=' + encodeURIComponent(a.filename || 'file');
    const card = document.createElement('a');
    card.className = 'attach-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener';
    const isImg = /^image\//.test(a.mime);
    if (isImg) {
      card.innerHTML = '<img class="attach-thumb" src="' + url + '" loading="lazy" alt="">' +
        '<div class="attach-name">' + esc(a.filename || '') + '</div>';
    } else {
      card.innerHTML = '<div class="attach-pdf">PDF</div>' +
        '<div class="attach-name">' + esc(a.filename || '') + '</div>';
    }
    grid.appendChild(card);
  });
  return grid;
}

function buildProductOptions(intro, products) {
  const wrap = document.createElement('div');
  wrap.className = 'prod-options';
  // Only show an intro line if one was explicitly passed — the caller usually
  // prints its own heading ("6 products match — pick one to price:").
  if (intro) {
    const introEl = document.createElement('div');
    introEl.className = 'prod-options-intro';
    introEl.textContent = intro;
    wrap.appendChild(introEl);
  }
  const SHOW_FIRST = 4;
  (products || []).forEach((p, pIdx) => {
    const card = document.createElement('div');
    card.className = 'prod-option-btn';
    // Everything past the first few is hidden behind "Show more"
    if (pIdx >= SHOW_FIRST) card.classList.add('prod-hidden-extra');
    // Main selectable area
    const main = document.createElement('button');
    main.className = 'prod-option-main';
    // Thumbnail from product.image (some products have none - fall back to a glyph)
    const thumb = p.image
      ? '<span class="prod-thumb"><img src="' + esc(p.image) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'no-img\');this.remove()"></span>'
      : '<span class="prod-thumb no-img"></span>';
    // Match strength, so the team can see how confident the match is
    const mv = (p.match != null) ? Number(p.match) : null;
    const mCls = mv == null ? '' : (mv >= 80 ? 'mm-high' : mv >= 55 ? 'mm-mid' : 'mm-low');
    const matchBadge = mv == null ? ''
      : '<span class="prod-match ' + mCls + '"' + (p.matchWhy ? ' title="' + esc(p.matchWhy) + '"' : '') + '>' + mv + '% match</span>';
    // Order history is the strongest signal there is — give it its own chip
    const ordChip = (p.ordered > 0)
      ? '<span class="prod-ord-chip" title="This client has ordered this exact product before">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"></path><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path><path d="M12 7v5l3 2"></path></svg>' +
        'Ordered ' + p.ordered + '\u00d7 before</span>'
      : '';
    main.innerHTML = thumb +
      '<span class="prod-option-body">' +
      '<span class="prod-option-title">' + esc(p.title) +
      (p.private ? ' <span class="client-star" title="Client-specific product">★ Client</span>' : '') +
      (p.product_id ? ' <span class="prod-option-id">#' + p.product_id + '</span>' : '') + '</span>' +
      (p.note ? '<span class="prod-option-note">' + esc(p.note) + '</span>' : '') +
      '<span class="prod-option-meta">' + ordChip +
      (p.matchWhy ? '<span class="prod-option-why">' + esc(p.matchWhy) + '</span>' : '') +
      '</span>' +
      '</span>' + matchBadge;
    main.onclick = () => {
      if (isLoading) return;
      wrap.querySelectorAll('.prod-option-btn').forEach(b => { b.classList.remove('chosen'); b.querySelector('.prod-option-main').disabled = true; });
      card.classList.add('chosen');
      ask('Use product "' + p.title + '" (product_id ' + p.product_id + ') for the request. Continue with pricing. If the client gave custom dimensions, generate a SEPARATE quote for each size and pass custom_size {w,h} on every quote so each size prices correctly.');
    };
    card.appendChild(main);
    // Separate "See product" link
    if (p.url) {
      const link = document.createElement('a');
      link.className = 'prod-option-see';
      link.href = p.url; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'See product ↗';
      link.onclick = (e) => { e.stopPropagation(); };
      card.appendChild(link);
    }
    wrap.appendChild(card);
  });
  // "Show more" for anything beyond the first few
  const hiddenCount = Math.max(0, (products || []).length - SHOW_FIRST);
  if (hiddenCount > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'prod-show-more';
    more.textContent = 'Show ' + hiddenCount + ' more match' + (hiddenCount === 1 ? '' : 'es');
    more.onclick = () => {
      wrap.querySelectorAll('.prod-hidden-extra').forEach(el => el.classList.remove('prod-hidden-extra'));
      more.remove();
    };
    wrap.appendChild(more);
  }
  return wrap;
}

function buildQuoteBox(text, url, product, structured) {
  const wrap = document.createElement('div');
  wrap.className = 'quote-box';
  const pre = document.createElement('pre');
  pre.className = 'quote-text';
  // If we have a product name + url, turn the product name (first line) into a link
  if (url && product && text.indexOf(product) === 0) {
    const rest = text.slice(product.length);
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener';
    link.className = 'quote-product-link';
    link.textContent = product;
    pre.appendChild(link);
    pre.appendChild(document.createTextNode(rest));
  } else {
    pre.textContent = text;
  }
  const btn = document.createElement('button');
  btn.className = 'quote-copy';
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy';
  btn.onclick = () => {
    navigator.clipboard.writeText(text).then(() => {
      btn.innerHTML = '✓ Copied';
      setTimeout(() => { btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy'; }, 1800);
    });
  };
  const emailBtn = document.createElement('button');
  emailBtn.className = 'quote-email';
  emailBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg> Draft Email';
  emailBtn.onclick = async () => {
    if (emailBtn.disabled) return;
    emailBtn.disabled = true;
    const orig = emailBtn.innerHTML;
    emailBtn.innerHTML = '<span class="spin"></span> Drafting…';
    const cl = (lastFlowCtx && lastFlowCtx.client) || {};
    let resp;
    try {
      const r = await fetch('/api/draft-email', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ quote: text, product: product, client_name: (cl.full_name || '').split(' ')[0] || '', client_emails: (lastFlowCtx && lastFlowCtx.emails) || [], has_versions: !!(lastFlowCtx && lastFlowCtx._hasVersions), version_count: (lastFlowCtx && lastFlowCtx._versionCount) || 1 }) });
      resp = await r.json();
    } catch (e) { resp = { success: false }; }
    emailBtn.disabled = false; emailBtn.innerHTML = orig;
    if (!resp || !resp.success) { emailBtn.innerHTML = 'Draft failed — retry'; return; }

    const specs = (structured && structured.specs) || [];
    const lines = (structured && structured.lines) || [];
    const timeline = (structured && structured.timeline) || null;
    // Build the styled HTML email body (inline styles so it survives copy→Gmail)
    const rowsHtml = lines.map(l => {
      const q = Number(l.qty).toLocaleString();
      const price = l.price == null ? 'n/a' : '$' + l.price.toFixed(2);
      return '<tr><td style="padding:7px 16px;border-bottom:1px solid #eee;font-size:14px;color:#333;">' + q + ' units</td>' +
        '<td style="padding:7px 16px;border-bottom:1px solid #eee;font-size:14px;color:#111;font-weight:600;text-align:right;">' + price + '</td></tr>';
    }).join('');
    // Specs as clean line items, skipping fields flagged hidden in the product setup.
    const visibleSpecs = specs.filter(s => !s.hidden);
    const specsHtml = visibleSpecs.length ? ('<table style="width:100%;border-collapse:collapse;margin:0 0 4px;">' +
      visibleSpecs.map(s => '<tr><td style="padding:3px 0;font-size:13px;color:#777;width:45%;">' + esc(s.label) + '</td>' +
        '<td style="padding:3px 0;font-size:13px;color:#222;font-weight:600;">' + esc(s.value) + '</td></tr>').join('') +
      '</table>') : '';
    const prodLine = url ? ('<a href="' + esc(url) + '" style="color:#4f46e5;text-decoration:none;font-weight:600;">' + esc(product) + '</a>') : ('<strong>' + esc(product) + '</strong>');

    // Timeline block
    let timelineHtml = '';
    if (timeline && timeline.readyDate) {
      const cutoffPhrase = timeline.cutoffToday
        ? 'Orders placed and files approved by 5pm today'
        : ('Orders placed and files approved by 5pm ' + esc(timeline.cutoffDate));
      timelineHtml = '<div style="margin:0 0 14px;padding:12px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">' +
        '<div style="font-size:13px;color:#166534;font-weight:600;margin-bottom:3px;">⏱ Turnaround: ' + esc(timeline.label) + '</div>' +
        '<div style="font-size:13px;color:#333;line-height:1.5;">' + cutoffPhrase + ' will be ready for pickup or shipping by <strong>' + esc(timeline.readyDate) + '</strong>.' +
        (timeline.fasterAvailable ? ' Need it sooner? Faster turnaround (' + esc(timeline.fasterLabel) + ') is available.' : '') +
        '</div></div>';
    }

    const emailHtml =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6;">' +
      '<p style="margin:0 0 12px;">' + esc(resp.greeting) + '</p>' +
      '<p style="margin:0 0 14px;">' + esc(resp.intro) + '</p>' +
      '<div style="border:1px solid #e5e5ef;border-radius:10px;overflow:hidden;margin:0 0 14px;max-width:440px;">' +
      '<div style="background:#f5f3ff;padding:10px 16px;font-size:15px;font-weight:700;color:#1e1b2e;">' + prodLine + '</div>' +
      (specsHtml ? '<div style="padding:10px 16px 6px;">' + specsHtml + '</div>' : '') +
      '<table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;">' + rowsHtml + '</table>' +
      '</div>' +
      timelineHtml +
      '<p style="margin:0 0 14px;">' + esc(resp.outro) + '</p>' +
      '<p style="margin:0;">' + esc(resp.signoff) + '<br>The AxiomPrint Team</p>' +
      '</div>';

    // Render a preview + a Copy-for-Gmail button (copies rich HTML) — no outer wrapper div
    const head = document.createElement('div'); head.className = 'email-draft-head'; head.textContent = 'Draft reply — preview (copies with formatting):';
    const preview = document.createElement('div'); preview.className = 'email-preview'; preview.innerHTML = emailHtml;
    const copyBtn = document.createElement('button'); copyBtn.className = 'quote-btn'; copyBtn.style.marginTop = '8px'; copyBtn.textContent = 'Copy for Gmail';
    copyBtn.onclick = async () => {
      try {
        const blobHtml = new Blob([emailHtml], { type: 'text/html' });
        const blobText = new Blob([preview.innerText], { type: 'text/plain' });
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobText })]);
        copyBtn.textContent = '✓ Copied — paste into Gmail';
      } catch (e) {
        // fallback: select the preview for manual copy
        const range = document.createRange(); range.selectNodeContents(preview);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        copyBtn.textContent = 'Selected — press Ctrl/Cmd+C';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy for Gmail'; }, 2500);
    };
    wrap.appendChild(head); wrap.appendChild(preview); wrap.appendChild(copyBtn);
    // Rating strip for the drafted reply
    const draftPlain = preview.innerText || '';
    attachRatingStrip(wrap, 'Rate this draft:', 'DRAFT EMAIL:\n' + draftPlain.slice(0, 1500));
    scrollDown();
  };
  const btnRow = document.createElement('div');
  btnRow.className = 'quote-btn-row';
  btnRow.appendChild(btn);
  btnRow.appendChild(emailBtn);
  wrap.appendChild(btnRow);
  wrap.appendChild(pre);
  return wrap;
}

// ===== File uploads (attach + paste), text-only extraction =====
let pendingFiles = []; // { id, name, mime, dataUrl, text, extracting }

function handleFileSelect(e) {
  const files = Array.from(e.target.files || []);
  files.forEach(addPendingFile);
  e.target.value = '';
}

function handlePaste(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f && (/^image\//.test(f.type) || /pdf/.test(f.type))) {
        e.preventDefault();
        addPendingFile(f);
      }
    }
  }
}

function addPendingFile(file) {
  if (!/^image\//.test(file.type) && !/pdf/.test(file.type)) return;
  if (file.size > 20 * 1024 * 1024) { alert('File too large (max 20MB): ' + file.name); return; }
  const id = 'pf' + Date.now() + Math.random().toString(36).slice(2, 6);
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const entry = { id, name: file.name || 'pasted', mime: file.type, dataUrl, text: '', extracting: true };
    pendingFiles.push(entry);
    renderPending();
    // kick off extraction immediately
    extractFile(entry);
  };
  reader.readAsDataURL(file);
}

async function extractFile(entry) {
  // Images: no extraction needed - they go to the model as vision (image blocks).
  if (/^image\//.test(entry.mime)) { entry.extracting = false; renderPending(); return; }
  // PDFs and other docs: extract text on the server.
  try {
    const base64 = entry.dataUrl.split(',')[1];
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ data: base64, mime: entry.mime, filename: entry.name })
    });
    const j = await res.json();
    entry.text = j.success ? (j.text || '') : '';
  } catch (e) { entry.text = ''; }
  entry.extracting = false;
  renderPending();
}

function removePending(id) {
  pendingFiles = pendingFiles.filter(f => f.id !== id);
  renderPending();
}

function renderPending() {
  const box = document.getElementById('pendingFiles');
  box.innerHTML = '';
  pendingFiles.forEach(f => {
    const div = document.createElement('div');
    div.className = 'pending-file';
    const isImg = /^image\//.test(f.mime);
    div.innerHTML =
      (isImg ? '<img class="pf-thumb" src="' + f.dataUrl + '">' : '<div class="pf-pdf">PDF</div>') +
      (f.extracting ? '<div class="pf-spin"><div></div></div>' : '') +
      '<button class="pf-x" onclick="removePending(\'' + f.id + '\')">&times;</button>' +
      '<div class="pf-name">' + esc(f.name) + '</div>';
    box.appendChild(div);
  });
}

async function sendMessage(forceClassic) {
  if (isLoading) return;
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text && !pendingFiles.length) return;
  // wait briefly if files are still extracting
  if (pendingFiles.some(f => f.extracting)) {
    const ok = pendingFiles.every(f => !f.extracting);
    if (!ok) { await new Promise(r => setTimeout(r, 800)); }
  }
  // capture & clear pending files for this message
  const files = pendingFiles.slice();
  pendingFiles = [];
  renderPending();

  input.value = ''; input.style.height = '40px';
  document.getElementById('suggestions').style.display = 'none';
  isLoading = true;
  document.getElementById('sendBtn').disabled = true;

  // Don't show the internal pricing instruction as a user bubble
  if (!forceClassic) addUserRow(text, files);

  // New default flow: gather context in fast steps, then pause for pricing.
  // The toggle (when checked) falls back to the old single-chain flow for debugging.
  const useOldFlow = forceClassic || (document.getElementById('steppedToggle') && document.getElementById('steppedToggle').checked);
  if (!useOldFlow) {
    const imgs = files.filter(f => /^image\//.test(f.mime)).map(f => {
      let mt = f.mime; if (mt === 'image/jpg') mt = 'image/jpeg';
      return { media_type: mt, data: f.dataUrl.split(',')[1] };
    });
    runSteppedFlow(text, imgs);
    return;
  }

  // Build the message content. PDFs contribute extracted text; images go as vision blocks.
  let messageForModel = text;
  const imageFiles = files.filter(f => /^image\//.test(f.mime));
  const pdfFiles = files.filter(f => !/^image\//.test(f.mime));
  if (pdfFiles.length) {
    const parts = pdfFiles.map(f => {
      if (f.text && f.text.trim()) return 'Attached PDF "' + f.name + '" contents:\n' + f.text.trim();
      return 'Attached file "' + f.name + '" (no readable text could be extracted).';
    });
    messageForModel = (messageForModel ? messageForModel + '\n\n' : '') + parts.join('\n\n---\n\n');
  }

  // If there are images, send a multimodal content array; otherwise plain text.
  let contentForModel;
  if (imageFiles.length) {
    contentForModel = [];
    const txt = messageForModel || 'Please read the attached image(s) (these are usually screenshots of client emails) and help with them.';
    contentForModel.push({ type: 'text', text: txt });
    imageFiles.forEach(f => {
      const b64 = f.dataUrl.split(',')[1];
      let mt = f.mime;
      if (mt === 'image/jpg') mt = 'image/jpeg';
      contentForModel.push({ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } });
    });
  } else {
    contentForModel = messageForModel;
  }
  chatHistory.push({ role: 'user', content: contentForModel });

  // Persist: ensure a chat exists, save the user message (store a text note for images)
  let needTitleFromAnswer = false;
  if (!currentChatId) {
    const hadText = !!text;
    if (!hadText && imageFiles.length) needTitleFromAnswer = true;
    try {
      const r = await fetch('/api/chats/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ agent_slug: currentAgent, title: (text || (needTitleFromAnswer ? 'Image…' : (files[0] && files[0].name)) || 'New chat').slice(0, 120) }) });
      const j = await r.json();
      if (j.success) { currentChatId = j.chat_id; loadChatList(); }
    } catch (e) {}
  }
  if (currentChatId) {
    const saveText = messageForModel + (imageFiles.length ? (messageForModel ? '\n\n' : '') + '[' + imageFiles.length + ' image(s) attached]' : '');
    fetch('/api/chats/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, role: 'user', content: saveText }) });
  }

  const startTime = Date.now();

  // Build AI row
  const row = document.createElement('div');
  row.className = 'msg-row';
  const timer = document.createElement('span');
  timer.className = 'msg-timer';
  timer.textContent = '0.0s';
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.appendChild(document.createTextNode(agentName(currentAgent)));
  meta.appendChild(timer);
  const stepsBox = document.createElement('div');
  stepsBox.className = 'steps';
  const bubble = document.createElement('div');
  bubble.className = 'bubble ai';
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  const timingBar = document.createElement('div');
  timingBar.className = 'timing-bar';
  const col = document.createElement('div');
  col.className = 'msg-col';
  col.appendChild(meta);
  col.appendChild(stepsBox);
  col.appendChild(bubble);
  col.appendChild(timingBar);
  row.innerHTML = '<div class="msg-avatar ai">AI</div>';
  row.appendChild(col);
  document.getElementById('messagesInner').appendChild(row);
  scrollDown();

  const timerInt = setInterval(() => { timer.textContent = ((Date.now()-startTime)/1000).toFixed(1)+'s'; }, 100);

  let fullText = '';
  let answerStarted = false;
  let activeStep = null;
  // Context emitted by get_client (match confidence, order + email counts).
  // Arrives before show_client, so we stash it and merge it into the client chip.
  let clientCtx = null;

  function addTiming(label, ms, cls, extra) {
    const chip = document.createElement('div');
    chip.className = 'timing-chip ' + (cls || '');
    chip.textContent = label + ' ' + (ms/1000).toFixed(2) + 's' + (extra || '');
    timingBar.appendChild(chip);
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messages: chatHistory })
    });

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
        let j; try { j = JSON.parse(d); } catch(e) { continue; }

        if (j.type === 'error') { bubble.innerHTML = '<p style="color:#ef4444">Error: ' + j.error + '</p>'; }
        else if (j.type === 'client_context') {
          // From get_client - stash until show_client renders the chip
          clientCtx = j;
        }
        else if (j.type === 'client') {
          // Render the client chip at the top of the bubble
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          if (!bubble.querySelector('.client-chip')) {
            const cData = Object.assign({}, j.client);
            // Server-measured context wins over whatever the model chose to pass
            if (clientCtx) {
              if (clientCtx.match) cData.match_confidence = clientCtx.match;
              cData.email_count = clientCtx.emails;
              if (!cData.last_order && clientCtx.last_order) {
                const lo = clientCtx.last_order;
                cData.last_order = [lo.product, lo.ordered, (lo.total != null ? '$' + lo.total : null)]
                  .filter(Boolean).join(' · ');
              }
            }
            bubble.insertBefore(buildClientChip(cData), bubble.firstChild);
          }
          scrollDown();
        }
        else if (j.type === 'query') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          // One rotating action strip - update text in place, don't stack
          if (!stepsBox.firstChild) {
            stepsBox.innerHTML = '<span class="action-spin"></span><svg class="action-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span class="action-label"></span>';
            stepsBox.classList.add('active');
          }
          stepsBox.classList.remove('done');
          const lbl = stepsBox.querySelector('.action-label');
          if (lbl) { lbl.style.opacity = 0; setTimeout(() => { lbl.textContent = j.description; lbl.style.opacity = 1; }, 120); }
          scrollDown();
        }
        else if (j.type === 'query_done') {
          // keep the strip spinning until the next action or final completion
        }
        else if (j.type === 'calculator') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          try {
            const widget = buildCalculator(j.data);
            bubble.appendChild(widget);
          } catch(e) { console.error('widget build failed', e); }
          scrollDown();
        }
        else if (j.type === 'quote') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          bubble.appendChild(buildQuoteBox(j.text, j.url, j.product));
          scrollDown();
        }
        else if (j.type === 'product_options') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          bubble.appendChild(buildProductOptions(j.intro, j.products));
          scrollDown();
        }
        else if (j.type === 'attachments') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          // Only show one row of attachments total per response
          if (!bubble.querySelector('.attach-grid')) {
            bubble.appendChild(buildAttachments(j.items.slice(0, 4)));
            scrollDown();
          }
        }
        else if (j.type === 'job_files') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          bubble.appendChild(buildJobFiles(j.items));
          scrollDown();
        }
        else if (j.type === 'calc_error') {
          console.error('calc_error', j.error);
        }
        else if (j.type === 'timing') {
          let cls = '';
          if (j.label === 'DB query') cls = 'db';
          else if (j.label === 'Thinking' || j.label === 'Writing answer') cls = 'claude';
          else if (j.label === 'total') cls = 'total';
          else if (j.label === 'Gmail' || j.label === 'Drive') cls = 'db';
          let extra = '';
          if (j.label === 'Writing answer' && j.words) extra = ' · ' + j.words + ' words (' + (j.wps || 0) + '/s)';
          if (j.label !== 'first token') addTiming(j.label, j.ms, cls, extra);
        }
        else if (j.type === 'text') {
          fullText += j.text;
          if (!answerStarted) { bubble.innerHTML = ''; answerStarted = true; }
          // Render text into a dedicated container so any calculator widget in the bubble survives
          let textEl = bubble.querySelector('.ai-text');
          if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'ai-text';
            bubble.insertBefore(textEl, bubble.firstChild);
          }
          textEl.innerHTML = renderMarkdown(fullText);
          scrollDown();
        }
      }
    }
    if (!answerStarted && !fullText) bubble.innerHTML = '<p style="color:var(--muted)">No response.</p>';
    chatHistory.push({ role: 'assistant', content: fullText });

    // SAFETY NET: if the agent listed multiple product links in text instead of using
    // the product buttons, convert them into selectable buttons automatically.
    if (!bubble.querySelector('.prod-options')) {
      const prodMatches = [];
      const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]*\/product\/([a-z0-9-]+?)-(\d+))\)/gi;
      let m;
      while ((m = re.exec(fullText)) !== null) {
        prodMatches.push({ title: m[1].trim(), url: m[2], product_id: parseInt(m[4]) });
      }
      // Only intervene when it's clearly a product CHOICE (2+ products) and no quote/calculator shown
      if (prodMatches.length >= 2 && !bubble.querySelector('.quote-box') && !bubble.querySelector('.calc-card')) {
        const textEl = bubble.querySelector('.ai-text');
        if (textEl) {
          // Strip the list lines that were just product links, keep any intro sentence
          let cleaned = fullText
            .replace(/^\s*[-*\d.]*\s*\[([^\]]+)\]\([^)]*\/product\/[^)]*\)[^\n]*$/gim, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          textEl.innerHTML = renderMarkdown(cleaned || 'Which product should I quote?');
        }
        bubble.appendChild(buildProductOptions('Pick the product to quote:', prodMatches));
        scrollDown();
      }
    }
    // Persist assistant message and attach rating buttons
    if (currentChatId && fullText) {
      try {
        const r = await fetch('/api/chats/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, role: 'assistant', content: fullText }) });
        const j = await r.json();
        if (j.success && j.message_id) bubble.appendChild(buildRating(j.message_id, 0));
      } catch (e) {}
      // For image-only first messages, set the chat title from a concise summary
      if (needTitleFromAnswer) {
        try {
          const tr = await fetch('/api/summarize-title', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ text: fullText.slice(0, 1500) })
          });
          const tj = await tr.json();
          let title = (tj.success && tj.title) ? tj.title : '';
          if (!title) {
            const firstLine = fullText.replace(/[#*`>_-]/g, '').split('\n').find(l => l.trim().length > 0) || 'Image';
            title = firstLine.trim().slice(0, 80);
          }
          fetch('/api/chats/title', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, title }) }).then(() => loadChatList());
        } catch (e) {}
      }
    }
  } catch(e) {
    bubble.innerHTML = '<p style="color:#ef4444">Connection error. Please try again.</p>';
  }

  clearInterval(timerInt);
  timer.textContent = 'Answered in ' + ((Date.now()-startTime)/1000).toFixed(1) + 's';
  // Finish the action strip: hide it once the answer is shown (work is done)
  if (stepsBox.classList.contains('active')) {
    stepsBox.classList.add('done');
    setTimeout(() => { stepsBox.style.display = 'none'; }, 400);
  }
  // Collapse the timing bar into "total + ?" with expandable detail
  collapseTimingBar(timingBar);
  isLoading = false;
  document.getElementById('sendBtn').disabled = false;
  input.focus();
}

// ===== Stepped (debug) flow =====
const STEP_DEFS = [
  { n: 1, title: 'Understand the request' },
  { n: 2, title: 'Identify the client' },
  { n: 3, title: 'Recent client emails' },
  { n: 4, title: 'Job history' },
  { n: 5, title: 'Product & pricing' }
];
const STEP_RUNNING = [
  'Understanding the request…',
  'Identifying the client…',
  'Reading recent emails…',
  'Loading order history…',
  'Matching products…'
];
async function runSteppedFlow(userText, images) {
  const row = document.createElement('div');
  row.className = 'msg-row';
  const col = document.createElement('div'); col.className = 'msg-col';
  const meta = document.createElement('div'); meta.className = 'msg-meta';
  meta.textContent = agentName(currentAgent);
  const bubble = document.createElement('div'); bubble.className = 'bubble ai';
  const stepInd = document.createElement('div'); stepInd.className = 'step-ind';
  stepInd.innerHTML = '<span class="action-spin"></span><span class="step-ind-label">Starting…</span><span class="step-ind-count"></span>';
  bubble.appendChild(stepInd);
  const result = document.createElement('div'); result.className = 'flow-result';
  bubble.appendChild(result);
  col.appendChild(meta); col.appendChild(bubble);
  row.innerHTML = '<div class="msg-avatar ai">AI</div>'; row.appendChild(col);
  document.getElementById('messagesInner').appendChild(row);
  scrollDown();

  const ctx = { userText: userText, images: images || [] };
  let totalMs = 0;
  const stepTimes = [];
  const indLabel = stepInd.querySelector('.step-ind-label');
  const indCount = stepInd.querySelector('.step-ind-count');

  // ---- Persist this conversation so it shows in Recent chats ----
  // The stepped flow produces panels rather than one text answer, so we log the
  // user's request now and an assistant summary when the context is ready.
  const hasUserText = !!(userText && userText.trim());
  if (!currentChatId) {
    const title = (hasUserText ? userText : 'Image request').slice(0, 120);
    try {
      const r = await fetch('/api/chats/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ agent_slug: currentAgent, title }) });
      const j = await r.json();
      if (j.success) { currentChatId = j.chat_id; loadChatList(); }
    } catch (e) {}
  }
  if (currentChatId) {
    const saveText = (hasUserText ? userText : '') + ((images && images.length) ? ((hasUserText ? '\n\n' : '') + '[' + images.length + ' image(s) attached]') : '');
    fetch('/api/chats/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, role: 'user', content: saveText || '(no text)' }) });
  }

  for (let stepN = 1; stepN <= STEP_DEFS.length; stepN++) {
    indLabel.style.opacity = 0;
    await new Promise(r => setTimeout(r, 90));
    indLabel.textContent = STEP_RUNNING[stepN - 1];
    indCount.textContent = 'Step ' + stepN + ' of ' + STEP_DEFS.length;
    indLabel.style.opacity = 1;
    let resp;
    try {
      const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: stepN, context: ctx }) });
      resp = await r.json();
    } catch (e) { resp = { ok: false, error: e.message, ms: 0 }; }
    totalMs += (resp.ms || 0);
    stepTimes.push({ label: STEP_DEFS[stepN-1].title, ms: resp.ms || 0 });
    applyStepResult(stepN, resp, ctx, result);
    scrollDown();

    // DEBUG: pause after each step with a Next button (skip the pause for job lookups,
    // which branch immediately below).
    if (DEBUG_STEPS && !(stepN === 1 && ctx.jobLookup)) {
      // Show a compact dump of what this step produced
      const dbg = document.createElement('div');
      dbg.style.cssText = 'margin:6px 0;padding:8px 10px;background:#f4f4fb;border:1px solid #ddd;border-radius:6px;font-size:11px;font-family:monospace;color:#444;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;';
      let dump = 'Step ' + stepN + ' (' + STEP_DEFS[stepN-1].title + ')\n';
      if (stepN === 2) dump += 'crmStatus: ' + (resp.crmStatus || '?') + '\nclientNotFound: ' + ctx.clientNotFound + '\nclient: ' + (ctx.client ? (ctx.client.full_name + ' / ' + ctx.client.email) : 'null');
      else if (stepN === 3) dump += 'emails found: ' + ((ctx.emails || []).length);
      else if (stepN === 4) dump += 'orders found: ' + ((ctx.orders || []).length);
      else if (stepN === 5) dump += 'products matched: ' + ((ctx.products || []).length);
      else if (stepN === 1) dump += 'email: ' + (ctx.email || '(none)') + '\nproduct_hint: ' + (ctx.product_hint || '(none)') + '\nqty: ' + (ctx.quantity || '(none)');
      dbg.textContent = dump;
      result.appendChild(dbg);
      indLabel.textContent = 'Paused after step ' + stepN;
      await waitForNext(result, 'Next → (step ' + (stepN + 1 <= STEP_DEFS.length ? (stepN + 1) : 'finish') + ')');
    }

    // After step 1: if this is a job lookup, skip pricing steps and do a direct DB lookup.
    if (stepN === 1 && ctx.jobLookup) {
      indLabel.style.opacity = 0;
      await new Promise(r => setTimeout(r, 90));
      indLabel.textContent = 'Loading job details…';
      indCount.textContent = '';
      indLabel.style.opacity = 1;
      let jResp;
      try {
        const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: 'job_lookup', context: ctx }) });
        jResp = await r.json();
      } catch (e) { jResp = { ok: false, error: e.message, ms: 0 }; }
      totalMs += (jResp.ms || 0);
      stepTimes.push({ label: 'Job details', ms: jResp.ms || 0 });
      renderJobLookup(jResp, ctx, result);
      scrollDown();
      break; // skip remaining steps
    }
  }

  // Job lookup path: skip pricing gate and multi-product resolution entirely.
  if (ctx.jobLookup) {
    stepInd.style.display = 'none';
    const timeWrap = document.createElement('div'); timeWrap.style.marginTop = '14px';
    const collapsed = document.createElement('div'); collapsed.className = 'timing-collapsed';
    collapsed.innerHTML = '<span class="timing-chip total">job loaded · ' + (totalMs / 1000).toFixed(2) + 's</span>';
    const toggle = document.createElement('button'); toggle.className = 'timing-toggle'; toggle.textContent = '?'; toggle.title = 'Show step timing';
    collapsed.appendChild(toggle);
    const detail = document.createElement('div'); detail.className = 'timing-detail'; detail.style.display = 'none';
    detail.innerHTML = stepTimes.map(s => '<span class="timing-chip claude">' + esc(s.label) + ' · ' + (s.ms/1000).toFixed(2) + 's</span>').join('');
    toggle.onclick = () => { const open = detail.style.display !== 'none'; detail.style.display = open ? 'none' : 'flex'; toggle.classList.toggle('open', !open); };
    timeWrap.appendChild(collapsed); timeWrap.appendChild(detail);
    result.appendChild(timeWrap);
    isLoading = false; document.getElementById('sendBtn').disabled = false;
    scrollDown();
    return;
  }

  // Multi-product: resolve a product match for EACH requested product.
  // (Step 5 already matched the primary hint; do the rest here.)
  const reqProds = ctx.requestProducts || [];
  if (reqProds.length > 1) {
    ctx.resolvedProducts = [];
    for (let i = 0; i < reqProds.length; i++) {
      const rp = reqProds[i];
      const subCtx = Object.assign({}, ctx, { product_hint: rp.product_hint });
      let matches = [];
      try {
        const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: 5, context: subCtx }) });
        const j = await r.json();
        matches = (j.ok && j.data && j.data.products) || [];
      } catch (e) {}
      ctx.resolvedProducts.push({ request: rp, matches: matches });
    }
  }

  stepInd.style.display = 'none';

  // ---- New-client detection ----
  // clientNotFound = no DB record for this email.
  // Also treat as new if we have a record but zero orders AND zero email history.
  const emailCount = (ctx.emails || []).length;
  const orderCount = (ctx.orders || []).length;
  ctx.isNewClient = (ctx.clientNotFound === true) || (orderCount === 0 && emailCount === 0);
  console.log('NEWCLIENT_DECISION:', JSON.stringify({ clientNotFound: ctx.clientNotFound, orderCount, emailCount, isNewClient: ctx.isNewClient }));

  if (ctx.isNewClient) {
    const note = document.createElement('div');
    note.className = 'newclient-note';
    const emailLine = ctx.email ? ' · ' + esc(ctx.email) : '';
    const emailsFound = (ctx.emails || []).length;
    const emailsLine = emailsFound > 0 ? ' · ' + emailsFound + ' past email(s) found' : ' · No past emails found';
    note.innerHTML = '<strong>✦ New client — not in AxiomPrint system</strong>' + emailLine + emailsLine + '.<br><small>No order history. Preparing a welcome reply.</small>';
    result.appendChild(note);
  }

  // Reorder suggestions: if the request looks like a reorder and we have matching past
  // orders, surface them as one-click reorder buttons at the top.
  if (!ctx.isNewClient && (ctx.orders || []).length) {
    const reorderIntent = /\b(same|exact|before|again|reorder|re-?order|last time|previous|usual|another round|more of|repeat)\b/i.test((ctx.userText || '') + ' ' + (ctx.summary || ''));
    if (reorderIntent) {
      // Match past orders against the request keywords (product hint + summary words)
      const hint = ((ctx.product_hint || '') + ' ' + (ctx.summary || '')).toLowerCase();
      const hintWords = hint.split(/\W+/).filter(w => w.length > 3);
      const isMatch = (o) => {
        const text = ((o.label || '') + ' ' + (o.product || '')).toLowerCase();
        return hintWords.some(w => text.includes(w)) || (ctx.product_hint && text.includes(ctx.product_hint.toLowerCase()));
      };
      const matchCount = (ctx.orders || []).filter(isMatch).length;
      const matches = (ctx.orders || []).filter(isMatch);
      const nonMatches = (ctx.orders || []).filter(o => !isMatch(o));
      if (matches.length || nonMatches.length) {
        const rsWrap = document.createElement('div');
        rsWrap.style.cssText = 'margin-top:12px;padding:12px;border:1px solid #c7c7f5;border-radius:10px;background:#f7f7ff;';
        const rsLbl = document.createElement('div');
        rsLbl.style.cssText = 'font-size:13px;font-weight:600;color:#4f46e5;margin-bottom:8px;';
        rsLbl.textContent = '↺ Looks like a reorder — ' + matchCount + ' likely match' + (matchCount === 1 ? '' : 'es') + ' highlighted:';
        rsWrap.appendChild(rsLbl);

        // Highlighted likely matches first
        matches.forEach(o => {
          const row = buildOrderRow(o, (order) => startReorderFromHistory(ctx, order, result));
          row.style.border = '2px solid #6366f1';
          row.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.12)';
          row.style.marginTop = '14px';
          row.style.position = 'relative';
          row.style.overflow = 'visible';
          const badge = document.createElement('span');
          badge.textContent = '★ likely';
          badge.style.cssText = 'position:absolute;top:-9px;left:10px;background:#6366f1;color:#fff;font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.15);z-index:1;';
          row.appendChild(badge);
          rsWrap.appendChild(row);
        });

        // Non-matches: show only the first 5, with a "show more" expander for the rest.
        const NONMATCH_LIMIT = 5;
        const visibleNon = nonMatches.slice(0, NONMATCH_LIMIT);
        const hiddenNon = nonMatches.slice(NONMATCH_LIMIT);
        if (matches.length && nonMatches.length) {
          const div = document.createElement('div');
          div.style.cssText = 'font-size:11px;color:#aaa;margin:10px 0 4px;text-transform:uppercase;letter-spacing:.5px;';
          div.textContent = 'Other recent orders';
          rsWrap.appendChild(div);
        }
        visibleNon.forEach(o => {
          const row = buildOrderRow(o, (order) => startReorderFromHistory(ctx, order, result));
          row.style.opacity = '0.78';
          rsWrap.appendChild(row);
        });
        if (hiddenNon.length) {
          const moreBtn = document.createElement('button');
          moreBtn.style.cssText = 'margin-top:6px;background:none;border:none;color:#6366f1;font-size:12px;font-weight:600;cursor:pointer;padding:4px 0;';
          moreBtn.textContent = '+ Show ' + hiddenNon.length + ' more order' + (hiddenNon.length === 1 ? '' : 's');
          moreBtn.onclick = () => {
            const frag = document.createDocumentFragment();
            hiddenNon.forEach(o => {
              const row = buildOrderRow(o, (order) => startReorderFromHistory(ctx, order, result));
              row.style.opacity = '0.78';
              frag.appendChild(row);
            });
            rsWrap.insertBefore(frag, moreBtn);
            moreBtn.remove();
          };
          rsWrap.appendChild(moreBtn);
        }

        const orHint = document.createElement('div');
        orHint.style.cssText = 'font-size:11.5px;color:#999;margin-top:8px;';
        orHint.textContent = 'Highlighted rows are likely matches. Click any row to see specs + thumbnail, or pick a product below for a fresh quote.';
        rsWrap.appendChild(orHint);
        result.appendChild(rsWrap);
      }
    }
  }

  // Pricing gate (products) comes first
  const gate = document.createElement('div'); gate.style.marginTop = '12px';
  result.appendChild(gate);
  if (ctx.isNewClient) {
    presentNewClientGate(gate, ctx, bubble);
  } else {
    presentPricingGate(gate, ctx, bubble);
  }

  // Persist a short assistant summary so the conversation is complete in history,
  // and attach the thumbs up/down rating buttons (users rate; admins review).
  if (currentChatId) {
    const who = ctx.client ? (ctx.client.full_name || ctx.client.company_name || ctx.email || 'client') : (ctx.email || 'unknown client');
    const prodNames = (ctx.products || []).map(p => p.title).slice(0, 4).join(', ');
    const summaryParts = [];
    summaryParts.push(ctx.isNewClient ? 'New client' : 'Returning client');
    summaryParts.push('Client: ' + who);
    if (ctx.summary) summaryParts.push('Request: ' + ctx.summary);
    if (prodNames) summaryParts.push('Matched products: ' + prodNames);
    summaryParts.push('Orders on file: ' + ((ctx.orders || []).length) + ', recent emails: ' + ((ctx.emails || []).length) + '.');
    const summaryText = summaryParts.join('\n');
    await attachRatingStrip(result, 'Was this helpful?', summaryText);
  }

  // Timing goes all the way at the bottom: "context ready" + ? to reveal the 5 steps
  const timeWrap = document.createElement('div'); timeWrap.style.marginTop = '14px';
  const collapsed = document.createElement('div'); collapsed.className = 'timing-collapsed';
  collapsed.innerHTML = '<span class="timing-chip total">context ready · ' + (totalMs / 1000).toFixed(2) + 's</span>';
  const toggle = document.createElement('button'); toggle.className = 'timing-toggle'; toggle.textContent = '?'; toggle.title = 'Show step timing';
  collapsed.appendChild(toggle);
  const detail = document.createElement('div'); detail.className = 'timing-detail'; detail.style.display = 'none';
  detail.innerHTML = stepTimes.map(s => '<span class="timing-chip claude">' + esc(s.label) + ' · ' + (s.ms/1000).toFixed(2) + 's</span>').join('');
  toggle.onclick = () => {
    const open = detail.style.display !== 'none';
    detail.style.display = open ? 'none' : 'flex';
    toggle.classList.toggle('open', !open);
  };
  timeWrap.appendChild(collapsed); timeWrap.appendChild(detail);
  result.appendChild(timeWrap);

  isLoading = false; document.getElementById('sendBtn').disabled = false;
  scrollDown();
}

function applyStepResult(stepN, resp, ctx, result) {
  const d = resp.ok ? resp.data : null;
  if (stepN === 1) {
    if (d && d.intent === 'job_lookup') {
      ctx.jobLookup = true;
      ctx.job_id = d.job_id;
      ctx.summary = d.summary || ('Job lookup: E' + d.job_id);
      // Render a "looking up job" note; the runSteppedFlow will detect ctx.jobLookup and branch.
      const note = document.createElement('div');
      note.className = 'fr-summary';
      note.textContent = 'Looking up E' + d.job_id + '…';
      result.appendChild(note);
      return;
    }
    if (d) {
      ctx.email = d.email || ''; ctx.summary = d.summary || ''; ctx.deadline = d.deadline || '';
      // Multi-product: normalize to an array
      let prods = Array.isArray(d.products) ? d.products : [];
      if (!prods.length && d.product_hint) prods = [{ product_hint: d.product_hint, size: d.size, quantity: d.quantity, versions: d.versions, options: d.options }];
      ctx.requestProducts = prods.map(p => ({
        product_hint: p.product_hint || '', size: p.size || '', quantity: p.quantity || '',
        versions: p.versions || '', options: p.options || [],
        // Carry the multi-version merge through - step 8 needs these for version
        // names/quantities and for the "product can't do versions" check.
        consolidated: !!p.consolidated,
        version_lines: Array.isArray(p.version_lines) ? p.version_lines : [],
        versions_unresolved: !!p.versions_unresolved,
        consolidation_note: p.consolidation_note || ''
      }));
      // Primary product drives the single-product context fields (back-compat)
      const first = ctx.requestProducts[0] || {};
      ctx.product_hint = first.product_hint || ''; ctx.size = first.size || '';
      ctx.quantity = first.quantity || ''; ctx.versions = first.versions || ''; ctx.options = first.options || [];
      ctx.consolidated = !!first.consolidated;
      ctx.version_lines = first.version_lines || [];
      ctx.versions_unresolved = !!first.versions_unresolved;
      ctx.consolidation_note = first.consolidation_note || '';
      ctx.specials = [first.size, first.quantity ? ('qty ' + first.quantity) : '', ...(first.options||[])].filter(Boolean).join(', ');
    }
  } else if (stepN === 2) {
    console.log('STEP2_RESULT:', JSON.stringify({ found: !!d, crmStatus: resp.crmStatus, data: d }));
    let chipWrap = result.querySelector('.fr-chip');
    if (!chipWrap) { chipWrap = document.createElement('div'); chipWrap.className = 'fr-chip'; result.appendChild(chipWrap); }
    chipWrap.innerHTML = '';
    if (d) {
      // Existing CRM client
      ctx.client_id = d.id; ctx.client = d;
      ctx.clientNotFound = false;
      ctx.clientOrderCount = Number(d.order_count) || 0;
      ctx.clientInvoiceCount = Number(d.invoice_count) || 0;
      const chip = buildClientChip({ name: d.full_name, company: d.company_name, email: d.email, phone: d.phone, orders: d.order_count, invoices: d.invoice_count });
      // Prepend an "Existing CRM Client" label
      const label = document.createElement('div');
      label.className = 'crm-label crm-existing';
      label.textContent = '✓ Existing CRM Client';
      chipWrap.appendChild(label);
      chipWrap.appendChild(chip);
    } else {
      // Not in CRM — but may still have email history (handled in step 3)
      ctx.client = null; ctx.client_id = null;
      ctx.clientNotFound = true;
      const badge = document.createElement('div');
      badge.className = 'crm-label crm-new';
      badge.innerHTML = '✦ New CRM Client' + (ctx.email ? ' <span class="crm-email">' + esc(ctx.email) + '</span>' : '') + '<span class="crm-sub">Not in customer database — checking inbox for any email history…</span>';
      chipWrap.appendChild(badge);
    }
    if (ctx.summary && !result.querySelector('.fr-summary')) {
      const sum = document.createElement('div'); sum.className = 'fr-summary'; sum.textContent = ctx.summary;
      result.appendChild(sum);
    }
    if (!result.querySelector('.fr-tabs')) {
      const tabs = document.createElement('div'); tabs.className = 'fr-tabs'; result.appendChild(tabs);
    }
  } else if (stepN === 3) {
    ctx.emails = d || [];
    addFlowTab(result, 'Recent Emails', ctx.emails.length, (ctx.emails || []).map(m =>
      '<div class="tab-line"><span class="tab-main">' + esc(m.subject) + '</span><span class="tab-sub">' + esc((m.date||'').slice(0,16)) + '</span></div>'
    ).join('') || '<div class="tab-line tab-sub">No recent emails.</div>');
  } else if (stepN === 4) {
    ctx.orders = d || [];
    if (!(ctx.orders || []).length) {
      addFlowTab(result, 'Recent Orders', 0, '<div class="tab-line tab-sub">No past orders.</div>');
    } else {
      const container = document.createElement('div');
      ctx.orders.forEach(o => {
        container.appendChild(buildOrderRow(o, (order) => startReorderFromHistory(ctx, order, result)));
      });
      addFlowTab(result, 'Recent Orders', ctx.orders.length, container);
    }
  } else if (stepN === 5) {
    ctx.products = (d && d.products) || [];
  }
}

function renderJobLookup(resp, ctx, result) {
  // Remove the "Looking up…" note
  const note = result.querySelector('.fr-summary');
  if (note) note.remove();

  if (!resp.ok || !resp.data) {
    const err = document.createElement('div');
    err.className = 'newclient-badge';
    err.textContent = resp.error || ('Job E' + ctx.job_id + ' not found.');
    result.appendChild(err);
    return;
  }

  const { est, specs, productionStep } = resp.data;

  // Client chip
  const chipWrap = document.createElement('div'); chipWrap.className = 'fr-chip';
  chipWrap.appendChild(buildClientChip({
    name: est.client_name, company: est.company_name,
    email: est.client_email, phone: est.phone, orders: null, invoices: null
  }));
  result.appendChild(chipWrap);

  // Job header card
  const card = document.createElement('div');
  card.style.cssText = 'border:1px solid #e5e5ef;border-radius:10px;padding:14px 16px;margin:10px 0;background:#fafafa;max-width:480px;';
  const price = est.new_total || est.estimate_price;
  const priceStr = price != null ? ' · $' + Number(price).toFixed(2) : '';
  card.innerHTML =
    '<div style="font-weight:600;font-size:15px;margin-bottom:6px">' + esc(est.e_number) + ' — ' + esc(est.label || est.product_title || 'Unknown product') + '</div>' +
    '<div style="font-size:13px;color:#666;margin-bottom:8px">' +
      esc((est.created || '').slice(0, 10)) + priceStr +
      (est.estimate_type ? ' · <em>' + esc(est.estimate_type) + '</em>' : '') +
    '</div>' +
    (productionStep ? '<div style="font-size:13px;color:#444;margin-bottom:8px">📍 Production: <strong>' + esc(productionStep) + '</strong></div>' : '') +
    (specs.length ? '<div style="font-size:13px;margin-top:6px">' +
      specs.map(s => '<span style="display:inline-block;background:#efefff;border-radius:5px;padding:2px 8px;margin:2px 3px 2px 0;font-size:12px"><strong>' + esc(s.field) + ':</strong> ' + esc(String(s.value)) + '</span>').join('') +
    '</div>' : '<div style="font-size:12px;color:#999;margin-top:4px">No specs decoded.</div>') +
    (est.estimate_drive_link ? '<div style="margin-top:10px"><a href="#" onclick="viewJobFiles(\'' + esc(est.e_number) + '\');return false;" style="font-size:13px;color:#6366f1;text-decoration:none">📂 View Drive files</a></div>' : '');
  result.appendChild(card);

  // Quick-action buttons
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;';
  const reorderBtn = document.createElement('button');
  reorderBtn.className = 'gate-btn secondary';
  reorderBtn.textContent = '↺ Reorder this job';
  reorderBtn.onclick = () => {
    document.getElementById('input').value = 'Reorder ' + est.e_number;
    sendMessage();
  };
  actions.appendChild(reorderBtn);
  result.appendChild(actions);
}

// Build an expandable order row: thumbnail (lazy) + label/date/price + reorder button,
// and an accordion that reveals the full decoded specs. `onReorder` fires when clicked.
function buildOrderRow(o, onReorder) {
  const eNum = o.e_number || ('E' + o.id);
  const price = (o.price != null && o.price !== '') ? ' · $' + Number(o.price).toFixed(2) : '';
  const qty = o.qty ? ' · ' + Number(o.qty).toLocaleString() + ' qty' : '';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'border:1px solid #e6e6f0;border-radius:8px;margin-bottom:6px;overflow:hidden;background:#fff;';

  // Header row: thumb + info + chevron + reorder
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;';

  // Thumbnail placeholder (lazy-loaded on first expand)
  const thumb = document.createElement('div');
  thumb.style.cssText = 'flex-shrink:0;width:40px;height:40px;border-radius:6px;background:#f0f0f7;display:flex;align-items:center;justify-content:center;font-size:9px;color:#aaa;overflow:hidden;';
  thumb.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#bbb" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>';

  const info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';
  info.innerHTML = '<div style="font-size:13px;color:#222;"><span style="color:#6366f1;font-weight:600;">' + esc(eNum) + '</span> ' + esc(o.label || o.product || '') + '</div>' +
    '<div style="font-size:11.5px;color:#888;">' + esc((o.created||'').slice(0,10)) + price + qty + '</div>';

  const chev = document.createElement('span');
  chev.style.cssText = 'flex-shrink:0;color:#aaa;font-size:12px;transition:transform .15s;';
  chev.textContent = '▸';

  const reBtn = document.createElement('button');
  reBtn.style.cssText = 'flex-shrink:0;background:#eef;border:1px solid #c7c7f5;color:#4f46e5;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;';
  reBtn.textContent = '↺ Reorder';
  reBtn.onclick = (e) => { e.stopPropagation(); onReorder(o); };

  head.appendChild(thumb); head.appendChild(info); head.appendChild(chev); head.appendChild(reBtn);
  wrap.appendChild(head);

  // Expandable body: full specs
  const body = document.createElement('div');
  body.style.cssText = 'display:none;padding:8px 12px;border-top:1px solid #eee;background:#fafafc;';
  const specs = o.specs || [];
  body.innerHTML = specs.length
    ? specs.map(s => '<span style="display:inline-block;background:#eef;border-radius:5px;padding:2px 8px;margin:2px 3px 2px 0;font-size:11.5px;"><strong>' + esc(s.field) + ':</strong> ' + esc(String(s.value)) + '</span>').join('')
    : '<span style="font-size:12px;color:#999;">No decoded specs.</span>';
  wrap.appendChild(body);

  // Load the proof-image thumbnail right away (not just on expand) so every row shows it.
  let thumbLoaded = false;
  function loadThumb() {
    if (thumbLoaded) return;
    thumbLoaded = true;
    thumb.innerHTML = '<span style="font-size:8px;color:#aaa;">…</span>';
    fetch('/api/order-thumb?id=' + encodeURIComponent(o.id), { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => r.json())
      .then(j => {
        if (j && j.url) {
          const img = document.createElement('img');
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
          img.onload = () => { thumb.style.cursor = 'zoom-in'; };
          img.onerror = () => {
            thumb.innerHTML = '<span style="font-size:8px;color:#c66;text-align:center;line-height:1.1;">no<br>preview</span>';
          };
          img.onclick = (e) => { e.stopPropagation(); enlargeImg(img.src); };
          img.src = j.url;
          thumb.innerHTML = ''; thumb.appendChild(img);
        } else {
          thumb.innerHTML = '<span style="font-size:8px;color:#bbb;text-align:center;line-height:1.1;">no<br>image</span>';
        }
      }).catch(() => {
        thumb.innerHTML = '<span style="font-size:8px;color:#c66;text-align:center;line-height:1.1;">err</span>';
      });
  }
  // Fire immediately
  loadThumb();

  head.onclick = () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    chev.textContent = open ? '▸' : '▾';
    loadThumb(); // safety: ensure loaded even if the initial call was missed
  };

  return wrap;
}

function addFlowTab(result, title, count, innerHtml) {
  const tabs = result.querySelector('.fr-tabs');
  if (!tabs) return null;
  const tab = document.createElement('div'); tab.className = 'fr-tab';
  const head = document.createElement('button'); head.className = 'fr-tab-head';
  head.innerHTML = '<span class="fr-tab-title">' + esc(title) + ': <strong>' + count + '</strong></span><span class="fr-tab-chev">\u25B8</span>';
  const body = document.createElement('div'); body.className = 'fr-tab-body'; body.style.display = 'none';
  // innerHtml may be an HTML string or a DOM node
  if (innerHtml instanceof Node) body.appendChild(innerHtml);
  else body.innerHTML = innerHtml;
  head.onclick = () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    head.querySelector('.fr-tab-chev').textContent = open ? '\u25B8' : '\u25BE';
    head.classList.toggle('open', !open);
  };
  tab.appendChild(head); tab.appendChild(body);
  tabs.appendChild(tab);
  return body;
}

// After context is gathered, pause and let the team start pricing (1 product) or pick (multi)
// Multi-product: checklist, resolve one at a time, compose combined email at the end
function presentMultiProduct(gate, ctx, bubble) {
  const items = ctx.resolvedProducts; // [{request, matches}]
  const results = new Array(items.length).fill(null);
  const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:10px';
  const mergedCount = items.filter(function (it) { return it.request && it.request.consolidated; }).length;
  lbl.textContent = items.length === 1
    ? (mergedCount ? '1 job in this request (same product, multiple versions) — resolve it, then compose the email:'
                   : '1 product in this request — resolve it, then compose the email:')
    : items.length + ' products in this request — resolve each, then compose one email:';
  gate.appendChild(lbl);

  const listEl = document.createElement('div'); listEl.className = 'mp-list';
  gate.appendChild(listEl);
  const composeWrap = document.createElement('div'); composeWrap.style.marginTop = '14px';
  gate.appendChild(composeWrap);

  function refreshCompose() {
    const doneCount = results.filter(r => r && !r.skipped).length;
    const decided = results.filter(Boolean).length;
    composeWrap.innerHTML = '';
    const status = document.createElement('div'); status.style.cssText = 'font-size:12.5px;color:var(--muted);margin-bottom:8px';
    status.textContent = doneCount + ' of ' + items.length + ' products priced.';
    composeWrap.appendChild(status);
    if (decided === items.length && doneCount > 0) {
      const btn = document.createElement('button'); btn.className = 'next-btn'; btn.textContent = '✉ Compose combined email →';
      btn.onclick = () => composeCombinedEmail(ctx, results.filter(r => r && !r.skipped), bubble, composeWrap);
      composeWrap.appendChild(btn);
    }
  }

  items.forEach((it, i) => {
    const row = document.createElement('div'); row.className = 'mp-row';
    const hint = it.request.product_hint || ('Product ' + (i+1));
    const vLines = it.request.version_lines || [];
    const isMerged = !!it.request.consolidated && vLines.length > 1;
    const specBits = [it.request.size, it.request.quantity ? ('qty ' + it.request.quantity) : '', it.request.versions ? (it.request.versions + ' designs') : '', ...(it.request.options||[])].filter(Boolean).join(', ');
    // When several of the client's line items were merged into one multi-version job,
    // show what was merged so the team can verify it before pricing.
    let mergedBlock = '';
    if (isMerged) {
      mergedBlock = '<div class="mp-merged">' +
        '<div class="mp-merged-head">Merged into 1 job with ' + vLines.length + ' versions' +
        (it.request.versions_unresolved ? ' <span class="mp-merged-warn">count unconfirmed</span>' : '') + '</div>' +
        '<ul class="mp-merged-list">' +
        vLines.map(function (l) {
          return '<li' + (l.ambiguous ? ' class="amb"' : '') + '>' + esc(l.label || '') +
            (l.ambiguous ? '<span class="mp-merged-flag">file count unclear</span>' : '') + '</li>';
        }).join('') +
        '</ul>' +
        (it.request.consolidation_note ? '<div class="mp-merged-note">' + esc(it.request.consolidation_note) + '</div>' : '') +
        '</div>';
    }
    row.innerHTML = '<div class="mp-row-head">' +
      '<span class="mp-status mp-pending">●</span>' +
      '<span class="mp-name">' + esc(hint) + '</span>' +
      '<span class="mp-specs">' + esc(specBits) + '</span>' +
      '<button class="mp-resolve">Resolve →</button></div>' +
      mergedBlock +
      '<div class="mp-work"></div>';
    listEl.appendChild(row);

    const resolveBtn = row.querySelector('.mp-resolve');
    const work = row.querySelector('.mp-work');
    const statusEl = row.querySelector('.mp-status');
    const subCtx = Object.assign({}, ctx, {
      product_hint: it.request.product_hint, size: it.request.size,
      quantity: it.request.quantity, versions: it.request.versions, options: it.request.options,
      // Carry the merge through so the server can verify the product actually
      // supports versions before pricing it as one job.
      consolidated: !!it.request.consolidated,
      version_lines: vLines,
      versions_unresolved: !!it.request.versions_unresolved,
      consolidation_note: it.request.consolidation_note || '',
      specials: [it.request.size, it.request.quantity ? ('qty ' + it.request.quantity) : '', ...(it.request.options||[])].filter(Boolean).join(', ')
    });
    const onDone = (quote) => {
      results[i] = quote;
      statusEl.className = 'mp-status mp-done'; statusEl.textContent = '✓';
      resolveBtn.textContent = 'Resolved'; resolveBtn.disabled = true;
      refreshCompose();
    };
    resolveBtn.onclick = () => {
      resolveBtn.disabled = true;
      const matches = it.matches || [];
      if (matches.length === 1) {
        statusEl.className = 'mp-status mp-active'; statusEl.textContent = '◐';
        startPricing(subCtx, matches[0], work, { onDone: onDone });
      } else if (matches.length > 1) {
        const pick = document.createElement('div');
        pick.innerHTML = '<div style="font-size:12.5px;color:var(--muted);margin:6px 0">' + matches.length + ' matches — pick one:</div>';
        matches.forEach(m => {
          const b = document.createElement('button'); b.className = 'mp-pick'; b.textContent = m.title + ' #' + m.id;
          b.onclick = () => { pick.querySelectorAll('button').forEach(x=>x.disabled=true); statusEl.className='mp-status mp-active'; statusEl.textContent='◐'; startPricing(subCtx, m, work, { onDone: onDone }); };
          pick.appendChild(b);
        });
        work.appendChild(pick);
      } else {
        work.innerHTML = '<div style="font-size:12.5px;color:#ef4444;margin-top:6px">No match for "' + esc(it.request.product_hint) + '". Handle manually.</div>';
        statusEl.className = 'mp-status mp-skip'; statusEl.textContent = '—';
        results[i] = { skipped: true, product: it.request.product_hint };
        refreshCompose();
      }
    };
  });
  refreshCompose();
}

// Compose ONE email covering all resolved products, with a combined timeline
async function composeCombinedEmail(ctx, quotes, bubble, host) {
  const btn = host.querySelector('button');
  if (btn) { btn.disabled = true; btn.textContent = 'Drafting…'; }
  const cl = (ctx.client) || {};
  const summary = quotes.map(q => q.product).join(', ');
  let resp;
  try {
    const r = await fetch('/api/draft-email', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ quote: 'Multiple products: ' + summary, product: summary, client_name: (cl.full_name||'').split(' ')[0] || '', client_emails: ctx.emails || [], multi: true }) });
    resp = await r.json();
  } catch (e) { resp = { success: false }; }
  if (!resp || !resp.success) { if (btn) btn.textContent = 'Draft failed — retry'; return; }

  // Combined timeline = the LONGEST turnaround across products (whole order ships together)
  let longest = null;
  quotes.forEach(q => { if (q.timeline && (!longest || q.timeline.days > longest.days)) longest = q.timeline; });

  const blocks = quotes.map(q => {
    const specsHtml = (q.specs||[]).length ? ('<table style="width:100%;border-collapse:collapse;margin:0 0 4px;">' +
      (q.specs||[]).map(s => '<tr><td style="padding:3px 0;font-size:13px;color:#555;width:42%;">' + esc(s.label) + '</td><td style="padding:3px 0;font-size:13px;color:#111;font-weight:600;">' + esc(s.value) + '</td></tr>').join('') + '</table>') : '';
    const rowsHtml = (q.lines||[]).map(l => '<tr><td style="padding:6px 16px;border-bottom:1px solid #eee;font-size:14px;color:#333;">' + Number(l.qty).toLocaleString() + ' units</td><td style="padding:6px 16px;border-bottom:1px solid #eee;font-size:14px;color:#111;font-weight:600;text-align:right;">' + (l.price==null?'n/a':'$'+l.price.toFixed(2)) + '</td></tr>').join('');
    const prodLine = q.url ? ('<a href="' + esc(q.url) + '" style="color:#4f46e5;text-decoration:none;font-weight:700;">' + esc(q.product) + '</a>') : ('<strong>' + esc(q.product) + '</strong>');
    return '<div style="border:1px solid #e5e5ef;border-radius:10px;overflow:hidden;margin:0 0 14px;">' +
      '<div style="background:#f5f3ff;padding:9px 16px;font-size:15px;font-weight:700;color:#1e1b2e;">' + prodLine + '</div>' +
      (specsHtml ? '<div style="padding:10px 16px 4px;">' + specsHtml + '</div>' : '') +
      '<table style="width:100%;border-collapse:collapse;">' + rowsHtml + '</table></div>';
  }).join('');

  const timelineHtml = longest ? ('<div style="margin:0 0 14px;padding:12px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">' +
    '<div style="font-size:13px;color:#166534;font-weight:600;margin-bottom:3px;">⏱ Turnaround: ' + esc(longest.label) + ' (whole order together)</div>' +
    '<div style="font-size:13px;color:#333;line-height:1.5;">' +
    (longest.cutoffToday ? 'Orders placed and files approved by 5pm today' : ('Orders placed and files approved by 5pm ' + esc(longest.cutoffDate))) +
    ' will be ready for pickup or shipping by <strong>' + esc(longest.readyDate) + '</strong>.' +
    (longest.fasterAvailable ? ' Need it sooner? Faster turnaround is available.' : '') + '</div></div>') : '';

  const emailHtml = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6;">' +
    '<p style="margin:0 0 12px;">' + esc(resp.greeting) + '</p>' +
    '<p style="margin:0 0 14px;">' + esc(resp.intro) + '</p>' +
    blocks + timelineHtml +
    '<p style="margin:0 0 14px;">' + esc(resp.outro) + '</p>' +
    '<p style="margin:0;">' + esc(resp.signoff) + '<br>The AxiomPrint Team</p></div>';

  const head = document.createElement('div'); head.className = 'email-draft-head'; head.textContent = 'Combined draft — ' + quotes.length + ' products (copies with formatting):';
  const preview = document.createElement('div'); preview.className = 'email-preview'; preview.innerHTML = emailHtml;
  const copyBtn = document.createElement('button'); copyBtn.className = 'quote-btn'; copyBtn.style.marginTop = '8px'; copyBtn.textContent = 'Copy for Gmail';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([emailHtml], {type:'text/html'}), 'text/plain': new Blob([preview.innerText], {type:'text/plain'}) })]);
      copyBtn.textContent = '✓ Copied — paste into Gmail';
    } catch (e) {
      const range = document.createRange(); range.selectNodeContents(preview); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      copyBtn.textContent = 'Selected — Ctrl/Cmd+C';
    }
    setTimeout(() => copyBtn.textContent = 'Copy for Gmail', 2500);
  };
  host.appendChild(head); host.appendChild(preview); host.appendChild(copyBtn);
  if (btn) { btn.style.display = 'none'; }
  scrollDown();
}

// ===== NEW CLIENT FLOW: welcome reply that answers the question + asks discovery questions =====
function presentNewClientGate(gate, ctx, bubble) {
  // We still need the product to answer accurately. Reuse product matches from step 5.
  const prods = ctx.products || [];
  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px';

  if (!prods.length) {
    // No product matched at all — go straight to product-identification questions.
    lbl.textContent = 'Product unclear — preparing clarifying questions to identify what they need:';
    gate.appendChild(lbl);
    startProductUnknownReply(ctx, gate, bubble);
    return;
  }

  if (prods.length === 1) {
    lbl.textContent = 'New client — product identified. Generating a welcome reply:';
    gate.appendChild(lbl);
    startNewClientReply(ctx, prods[0], gate, bubble);
    // Still offer an "unknown" escape hatch in case the single match is wrong
    appendUnknownOption(gate, ctx, bubble);
    return;
  }

  // Multiple products — let the AM pick which one the client means, then generate
  lbl.textContent = prods.length + ' products match — pick the one the client means:';
  gate.appendChild(lbl);
  const opts = buildProductOptions('', prods.map(p => ({ product_id: p.id, title: p.title, private: p.private, image: p.image, match: p.match, matchWhy: p.matchWhy, ordered: p.ordered, url: p.url ? ('https://axiomprint.com/product/' + p.url) : null })));
  opts.querySelectorAll('.prod-option-btn').forEach((cardEl, i) => {
    const main = cardEl.querySelector('.prod-option-main');
    if (main) main.onclick = () => {
      opts.querySelectorAll('.prod-option-main').forEach(b => b.disabled = true);
      opts.querySelectorAll('.prod-option-btn').forEach(c => c.classList.remove('chosen'));
      cardEl.classList.add('chosen');
      startNewClientReply(ctx, prods[i], gate, bubble);
    };
  });
  gate.appendChild(opts);
  // Add the "Unknown / none of these" option below the product buttons
  appendUnknownOption(gate, ctx, bubble);
}

// Renders an "❓ Unknown — none of these" button that triggers the product-identification flow.
function appendUnknownOption(gate, ctx, bubble) {
  const unknownBtn = document.createElement('button');
  unknownBtn.className = 'prod-option-main';
  unknownBtn.style.cssText = 'margin-top:10px;display:block;width:100%;text-align:left;border:1px dashed #c9a86a;background:#fffaf0;border-radius:8px;padding:10px 12px;cursor:pointer;';
  unknownBtn.innerHTML = '<span class="prod-option-title">❓ Unknown — none of these / can\'t tell</span>' +
    '<span class="prod-option-note">Skip product search and ask the client clarifying questions to identify the product</span>';
  unknownBtn.onclick = () => {
    // Disable all product buttons + this one
    gate.querySelectorAll('button').forEach(b => b.disabled = true);
    unknownBtn.style.borderStyle = 'solid';
    startProductUnknownReply(ctx, gate, bubble);
  };
  gate.appendChild(unknownBtn);
}

// Product is unknown: skip product pricing/specs, ask product-IDENTIFICATION questions.
async function startProductUnknownReply(ctx, gate, bubble) {
  ctx.productUnknown = true;
  ctx.product_id = null;
  lastFlowCtx = ctx;
  const note = document.createElement('div');
  note.style.cssText = 'margin-top:12px;font-size:13px;color:var(--indigo-dark);display:flex;align-items:center;gap:8px';
  note.innerHTML = '<span class="spin"></span><span>Preparing clarifying questions to identify the product…</span>';
  gate.appendChild(note);
  scrollDown();

  let rr;
  try {
    const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: 7, context: ctx }) });
    rr = await r.json();
  } catch (e) { rr = { ok: false, error: e.message }; }
  note.remove();
  if (!rr.ok || !rr.data) {
    const err = document.createElement('div'); err.style.cssText = 'margin-top:10px;font-size:13px;color:#ef4444';
    err.textContent = 'Could not prepare clarifying questions: ' + (rr.error || 'unknown');
    gate.appendChild(err); scrollDown(); return;
  }
  ctx.welcome = rr.data;
  renderNewClientReply(ctx, gate, bubble);
}

async function startNewClientReply(ctx, product, gate, bubble) {
  ctx.productUnknown = false;
  ctx.product_id = product.id;
  lastFlowCtx = ctx;
  const note = document.createElement('div');
  note.style.cssText = 'margin-top:12px;font-size:13px;color:var(--indigo-dark);display:flex;align-items:center;gap:8px';
  note.innerHTML = '<span class="spin"></span><span>Drafting a welcome reply for ' + esc(product.title) + '…</span>';
  gate.appendChild(note);
  scrollDown();

  let rr;
  try {
    const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: 7, context: ctx }) });
    rr = await r.json();
  } catch (e) { rr = { ok: false, error: e.message }; }
  note.remove();
  if (!rr.ok || !rr.data) {
    const err = document.createElement('div'); err.style.cssText = 'margin-top:10px;font-size:13px;color:#ef4444';
    err.textContent = 'Could not draft a welcome reply: ' + (rr.error || 'unknown');
    gate.appendChild(err); scrollDown(); return;
  }
  ctx.welcome = rr.data;
  renderNewClientReply(ctx, gate, bubble);
}

function renderNewClientReply(ctx, gate, bubble) {
  const w = ctx.welcome;
  const unknown = !!ctx.productUnknown;
  const panel = document.createElement('div');
  panel.className = 'welcome-panel';

  // The proposed answer (editable preview of what we'll say)
  const ansHead = document.createElement('div'); ansHead.className = 'welcome-sub';
  ansHead.textContent = unknown ? 'Proposed reply (identifying the product)' : 'Proposed answer to the client';
  panel.appendChild(ansHead);
  const ans = document.createElement('div'); ans.className = 'welcome-answer';
  ans.innerHTML = renderMarkdown((w.intro ? w.intro + '\n\n' : '') + (w.answer || ''));
  panel.appendChild(ans);

  // Suggested questions (each toggleable — AM can drop any before drafting)
  if (w.questions && w.questions.length) {
    const qHead = document.createElement('div'); qHead.className = 'welcome-sub'; qHead.style.marginTop = '12px'; qHead.textContent = unknown ? 'Product-identifying questions (click to include/exclude)' : 'Questions to ask (click to include/exclude)';
    panel.appendChild(qHead);
    const qList = document.createElement('div'); qList.className = 'welcome-qs';
    ctx._includedQuestions = w.questions.slice();
    w.questions.forEach((q, i) => {
      const chip = document.createElement('button');
      chip.className = 'welcome-q included';
      chip.textContent = q;
      chip.onclick = () => {
        const on = chip.classList.toggle('included');
        if (on) { if (!ctx._includedQuestions.includes(q)) ctx._includedQuestions.push(q); }
        else { ctx._includedQuestions = ctx._includedQuestions.filter(x => x !== q); }
      };
      qList.appendChild(chip);
    });
    panel.appendChild(qList);
  }

  // Draft Email button
  const actions = document.createElement('div'); actions.className = 'reason-actions'; actions.style.marginTop = '14px';
  const draftBtn = document.createElement('button'); draftBtn.className = 'next-btn'; draftBtn.textContent = '✉ Draft welcome email →';
  draftBtn.onclick = () => { draftBtn.disabled = true; buildWelcomeEmail(ctx, panel); };
  actions.appendChild(draftBtn);
  panel.appendChild(actions);

  gate.appendChild(panel);
  scrollDown();
}

function buildWelcomeEmail(ctx, host) {
  const w = ctx.welcome;
  const cl = ctx.client || {};
  const questions = (ctx._includedQuestions && ctx._includedQuestions.length) ? ctx._includedQuestions : (w.questions || []);

  const qsHtml = questions.length
    ? ('<ul style="margin:0 0 14px;padding-left:20px;">' + questions.map(q => '<li style="margin:4px 0;font-size:14px;color:#222;">' + esc(q) + '</li>').join('') + '</ul>')
    : '';
  const answerHtml = (w.answer || '').split(/\n{2,}/).map(p => '<p style="margin:0 0 12px;">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');

  const emailHtml =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6;">' +
    '<p style="margin:0 0 12px;">' + esc(w.greeting || 'Hi there,') + '</p>' +
    (w.intro ? '<p style="margin:0 0 12px;">' + esc(w.intro) + '</p>' : '') +
    answerHtml +
    (questions.length ? '<p style="margin:0 0 6px;">To put together the most accurate quote and make sure we get everything right, a few quick questions:</p>' + qsHtml : '') +
    (w.outro ? '<p style="margin:0 0 14px;">' + esc(w.outro) + '</p>' : '') +
    '<p style="margin:0;">' + esc(w.signoff || 'Best,') + '<br>The AxiomPrint Team</p>' +
    '</div>';

  const head = document.createElement('div'); head.className = 'email-draft-head'; head.textContent = 'Welcome reply — preview (copies with formatting):';
  const preview = document.createElement('div'); preview.className = 'email-preview'; preview.innerHTML = emailHtml;
  const copyBtn = document.createElement('button'); copyBtn.className = 'quote-btn'; copyBtn.style.marginTop = '8px'; copyBtn.textContent = 'Copy for Gmail';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([emailHtml], { type: 'text/html' }), 'text/plain': new Blob([preview.innerText], { type: 'text/plain' }) })]);
      copyBtn.textContent = '✓ Copied — paste into Gmail';
    } catch (e) {
      const range = document.createRange(); range.selectNodeContents(preview); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      copyBtn.textContent = 'Selected — press Ctrl/Cmd+C';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy for Gmail'; }, 2500);
  };
  host.appendChild(head); host.appendChild(preview); host.appendChild(copyBtn);
  attachRatingStrip(host, 'Rate this draft:', 'WELCOME EMAIL:\n' + (preview.innerText || '').slice(0, 1500));
  scrollDown();
}

function presentPricingGate(gate, ctx, bubble) {
  // MULTI-PRODUCT: show a checklist, resolve each one, compose email at the end
  if (ctx.resolvedProducts && ctx.resolvedProducts.length > 1) {
    return presentMultiProduct(gate, ctx, bubble);
  }
  const prods = ctx.products || [];
  if (!prods.length) {
    const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px';
    lbl.textContent = 'Product unclear — ask clarifying questions to identify what they need:';
    gate.appendChild(lbl);
    startProductUnknownReply(ctx, gate, bubble);
    return;
  }
  if (prods.length === 1) {
    const p = prods[0];
    const card = document.createElement('div');
    card.className = 'prod-option-btn';
    const thumb1 = p.image
      ? '<span class="prod-thumb"><img src="' + esc(p.image) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'no-img\');this.remove()"></span>'
      : '<span class="prod-thumb no-img"></span>';
    const mv1 = (p.match != null) ? Number(p.match) : null;
    const mCls1 = mv1 == null ? '' : (mv1 >= 80 ? 'mm-high' : mv1 >= 55 ? 'mm-mid' : 'mm-low');
    const badge1 = mv1 == null ? '' : '<span class="prod-match ' + mCls1 + '"' + (p.matchWhy ? ' title="' + esc(p.matchWhy) + '"' : '') + '>' + mv1 + '% match</span>';
    const ordChip1 = (p.ordered > 0)
      ? '<span class="prod-ord-chip" title="This client has ordered this exact product before">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"></path><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path><path d="M12 7v5l3 2"></path></svg>' +
        'Ordered ' + p.ordered + '\u00d7 before</span>'
      : '';
    card.innerHTML = '<button class="prod-option-main">' + thumb1 +
      '<span class="prod-option-body">' +
      '<span class="prod-option-title">' + esc(p.title) +
      (p.private ? ' <span class="client-star" title="Client-specific product">★ Client</span>' : '') +
      ' <span class="prod-option-id">#' + p.id + '</span></span>' +
      '<span class="prod-option-note">Ready to price' + (ctx.specials ? ' · ' + esc(ctx.specials) : '') + '</span>' +
      '<span class="prod-option-meta">' + ordChip1 +
      (p.matchWhy ? '<span class="prod-option-why">' + esc(p.matchWhy) + '</span>' : '') +
      '</span>' +
      '</span>' + badge1 + '</button>' +
      (p.url ? '<a class="prod-option-see" href="https://axiomprint.com/product/' + esc(p.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">See product ↗</a>' : '');
    card.querySelector('.prod-option-main').onclick = () => {
      gate.querySelectorAll('button,a').forEach(b => { if (b.tagName === 'BUTTON') b.disabled = true; });
      card.classList.add('chosen');
      startPricing(ctx, p, bubble);
    };
    const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px';
    lbl.textContent = 'Product identified — click to price:';
    gate.appendChild(lbl); gate.appendChild(card);
    appendUnknownOption(gate, ctx, bubble);
  } else {
    const lbl = document.createElement('div'); lbl.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px';
    lbl.textContent = prods.length + ' products match — pick one to price:';
    gate.appendChild(lbl);
    const opts = buildProductOptions('', prods.map(p => ({ product_id: p.id, title: p.title, private: p.private, image: p.image, match: p.match, matchWhy: p.matchWhy, ordered: p.ordered, url: p.url ? ('https://axiomprint.com/product/' + p.url) : null })));
    // Override the click so it starts pricing inline instead of sending a chat message
    opts.querySelectorAll('.prod-option-btn').forEach((cardEl, i) => {
      const main = cardEl.querySelector('.prod-option-main');
      if (main) main.onclick = () => {
        opts.querySelectorAll('.prod-option-main').forEach(b => b.disabled = true);
        opts.querySelectorAll('.prod-option-btn').forEach(c => c.classList.remove('chosen'));
        cardEl.classList.add('chosen');
        startPricing(ctx, prods[i], bubble);
      };
    });
    gate.appendChild(opts);
    appendUnknownOption(gate, ctx, bubble);
  }
}

// Reorder a specific past order: decode its options from the estimate, then price it.
async function startReorderFromHistory(ctx, order, bubble) {
  const estId = order.id;
  const note = document.createElement('div');
  note.style.cssText = 'margin-top:12px;font-size:13px;color:var(--indigo-dark);display:flex;align-items:center;gap:8px';
  note.innerHTML = '<span class="spin"></span><span>Decoding ' + esc(order.e_number || ('E' + estId)) + ' for reorder…</span>';
  bubble.appendChild(note);
  scrollDown();

  // Call the reorder step to decode the past estimate into calculator decisions
  let rr;
  try {
    const subCtx = Object.assign({}, ctx, { estimate_id: estId });
    const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: 'reorder', context: subCtx }) });
    rr = await r.json();
  } catch (e) { rr = { ok: false, error: e.message }; }
  note.remove();

  if (!rr.ok || !rr.data) {
    const err = document.createElement('div'); err.style.cssText = 'margin-top:10px;font-size:13px;color:#ef4444';
    err.textContent = 'Could not decode ' + (order.e_number || ('E' + estId)) + ' for reorder: ' + (rr.error || 'unknown');
    bubble.appendChild(err); scrollDown(); return;
  }

  const d = rr.data;
  // Pass the past quantity through so the quote uses it
  if (d.reorderQty) ctx.quantity = String(d.reorderQty);
  // Carry the custom dimensions through so the calculator + quote price the real size
  if (d.customSize && d.customSize.w && d.customSize.h) ctx.customSize = d.customSize;
  else ctx.customSize = null;
  // A small banner noting this is a reorder
  const banner = document.createElement('div');
  banner.style.cssText = 'margin-top:12px;padding:8px 12px;background:#eef;border:1px solid #c7c7f5;border-radius:8px;font-size:13px;color:#4f46e5;';
  banner.innerHTML = '↺ <strong>Reorder</strong> of ' + esc(order.e_number || ('E' + estId)) + ' — ' + esc(d.product || order.product || '') +
    (ctx.customSize ? '<br><span style="font-size:12px;color:#7a6ad6;">Custom size: <strong>' + esc(ctx.customSize.w + '" × ' + ctx.customSize.h + '"') + '</strong></span>' : '') +
    (d.pastTurnaround ? '<br><span style="font-size:12px;color:#7a6ad6;">Last order used <strong>' + esc(d.pastTurnaround) + '</strong>; priced at standard turnaround, express offered in the email.</span>' : '');
  bubble.appendChild(banner);

  // Reuse the pricing/reasoning panel with the decoded decisions (skips the AI step 6)
  startPricing(ctx, { id: d.product_id, title: d.product }, bubble, { prefetchedData: d });
}

// Second part: trigger pricing for the chosen product (this is the part we'll optimize next)
async function startPricing(ctx, product, bubble, opts) {
  opts = opts || {};
  ctx.product_id = product.id;
  lastFlowCtx = ctx;

  // --- Reasoning phase timer: inline at the bottom, starts at 0, stops when the panel appears ---
  const note = document.createElement('div');
  note.style.cssText = 'margin-top:12px;font-size:13px;color:var(--indigo-dark);display:flex;align-items:center;gap:8px';
  note.innerHTML = '<span class="spin"></span><span>' + (opts.prefetchedData ? 'Loading the past order setup…' : 'Reasoning about the job (request + history)…') + '</span><span class="phase-timer">0.0s</span>';
  bubble.appendChild(note);
  const reasonStart = Date.now();
  const reasonTimerEl = note.querySelector('.phase-timer');
  const reasonInt = setInterval(() => { reasonTimerEl.textContent = ((Date.now() - reasonStart) / 1000).toFixed(1) + 's'; }, 100);
  scrollDown();

  // STEP 6 - reason about every field. For a reorder we already have the decoded
  // decisions, so skip the AI call and use them directly.
  let rr;
  if (opts.prefetchedData) {
    rr = { ok: true, data: opts.prefetchedData };
  } else {
    try {
      const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: 6, context: ctx }) });
      rr = await r.json();
    } catch (e) { rr = { ok: false, error: e.message }; }
  }
  // Reasoning done — stop this phase's timer
  clearInterval(reasonInt);
  note.remove();
  if (!rr.ok || !rr.data) {
    const err = document.createElement('div'); err.style.cssText = 'margin-top:10px;font-size:13px;color:#ef4444';
    err.textContent = 'Could not analyze this product: ' + (rr.error || rr.note || 'unknown');
    bubble.appendChild(err); scrollDown(); return;
  }
  const reasonMs = Date.now() - reasonStart;
  const data = rr.data;
  ctx.decisions = data.decisions || [];

  // STEP C - show the reasoning breakdown + AM note, pause for OK
  const panel = document.createElement('div'); panel.className = 'reason-panel';
  const titleHtml = '<div class="reason-title">Proposed setup for ' + esc(data.product) + '</div>' +
    (data.job_summary ? '<div class="reason-summary">' + esc(data.job_summary) + '</div>' : '');
  panel.innerHTML = titleHtml;

  // Build filter map: item_id -> [{relatedTo(variable_id), relatedItems:[ids]}]
  const filtersByItem = {};
  (data.filters || []).forEach(f => {
    let rel = f.relatedItems; try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch(e) { rel = []; }
    if (!Array.isArray(rel)) rel = [];
    (filtersByItem[f.product_variable_item_id] = filtersByItem[f.product_variable_item_id] || []).push({ relatedTo: Number(f.relatedTo), relatedItems: rel.map(Number) });
  });
  // current selection: variable_id -> item_id
  const sel = {};
  (data.decisions || []).forEach(d => { if (d.item_id) sel[d.variable_id] = d.item_id; });

  // Field-level parent dependencies: var -> [{relatedTo, items:[ids]}]
  const depByVar = {};
  (data.fieldDeps || []).forEach(f => {
    let rel = f.relatedItems; try { if (typeof rel === 'string') rel = JSON.parse(rel); } catch(e) { rel = []; }
    if (!Array.isArray(rel)) rel = [];
    (depByVar[f.product_variable_id] = depByVar[f.product_variable_id] || []).push({ relatedTo: Number(f.relatedTo), items: rel.map(Number) });
  });
  function fieldActive(varId) {
    const deps = depByVar[varId];
    if (!deps || !deps.length) return true;
    return deps.every(dep => { const p = sel[dep.relatedTo]; return p != null && dep.items.includes(Number(p)); });
  }

  function itemOK(itemId) {
    const rules = filtersByItem[itemId];
    if (!rules || !rules.length) return true;
    // grouped by relatedTo variable; within a variable any listed item satisfies
    const byVar = {};
    rules.forEach(r => { (byVar[r.relatedTo] = byVar[r.relatedTo] || []).push(...r.relatedItems); });
    return Object.keys(byVar).every(varId => {
      const chosen = sel[varId];
      return chosen == null || byVar[varId].includes(Number(chosen));
    });
  }

  const list = document.createElement('div'); list.className = 'reason-list';
  // Custom size state for this panel, seeded from the server (client size, else product default)
  const sizeMeta = data.sizeMeta || null;
  ctx._sizeMeta = sizeMeta;
  if (sizeMeta && sizeMeta.w && sizeMeta.h) {
    ctx.customSize = { w: sizeMeta.w, h: sizeMeta.h };
    ctx.customSizeSource = sizeMeta.source;
  }
  // Is the currently-selected option in the size field a custom one?
  function sizeIsCustom() {
    if (!sizeMeta) return false;
    const cur = sel[sizeMeta.variable_id];
    if (cur == null) return false;
    return (sizeMeta.customItemIds || []).map(Number).includes(Number(cur));
  }
  function renderSizeInputs() {
    if (!sizeMeta || !sizeIsCustom()) return '';
    const w = (ctx.customSize && ctx.customSize.w) || '';
    const h = (ctx.customSize && ctx.customSize.h) || '';
    const unit = sizeMeta.unit === 'cm' ? 'cm' : 'in';
    // GREEN = the client told us the size. YELLOW = we filled it in, so double-check.
    const fromClient = ctx.customSizeSource === 'client';
    const cls = fromClient ? 'rs-ok' : 'rs-check';
    const badge = fromClient
      ? '<span class="rs-badge rs-badge-ok">✓ Client provided</span>'
      : '<span class="rs-badge rs-badge-check">⚑ Verify — product default</span>';
    const rangeBits = [];
    if (sizeMeta.maxW) rangeBits.push('max W ' + sizeMeta.maxW);
    if (sizeMeta.maxH) rangeBits.push('max H ' + sizeMeta.maxH);
    const over = (sizeMeta.maxW && Number(w) > sizeMeta.maxW) || (sizeMeta.maxH && Number(h) > sizeMeta.maxH);
    const under = (sizeMeta.minW && Number(w) < sizeMeta.minW) || (sizeMeta.minH && Number(h) < sizeMeta.minH);
    const warn = (!w || !h) ? 'Width and height are required to price this size.'
      : over ? 'Larger than this product allows (' + rangeBits.join(', ') + ' ' + unit + ').'
      : under ? 'Smaller than this product allows.' : '';
    return '<div class="reason-size ' + cls + '" id="reasonSize">' +
      '<div class="rs-head"><span class="rs-title">Size (W × H)</span>' + badge +
        (rangeBits.length ? '<span class="rs-range">' + esc(rangeBits.join(' · ') + ' ' + unit) + '</span>' : '') + '</div>' +
      '<div class="rs-inputs">' +
        '<label class="rs-field"><span>W</span><input type="number" step="0.01" min="0" id="reasonW" value="' + esc(w) + '" placeholder="0.00"><em>' + unit + '</em></label>' +
        '<span class="rs-x">×</span>' +
        '<label class="rs-field"><span>H</span><input type="number" step="0.01" min="0" id="reasonH" value="' + esc(h) + '" placeholder="0.00"><em>' + unit + '</em></label>' +
      '</div>' +
      (warn ? '<div class="rs-warn">' + esc(warn) + '</div>' : '') +
    '</div>';
  }
  (data.decisions || []).forEach((d, idx) => {
    const srcCls = d.source === 'client' ? 'src-client' : (d.source === 'history' ? 'src-history' : (d.source === 'default' ? 'src-default' : 'src-inferred'));
    const row = document.createElement('div'); row.className = 'reason-row'; row.dataset.var = d.variable_id;
    const optList = (d.options && d.options.length) ? d.options : [{ id: d.item_id, title: d.value }];
    const opts = optList.map(o => '<option value="' + o.id + '"' + (Number(o.id) === Number(d.item_id) ? ' selected' : '') + '>' + esc(o.title) + '</option>').join('');
    row.innerHTML = '<span class="reason-field">' + esc(d.field) + '</span>' +
      '<select class="reason-select" data-idx="' + idx + '" data-var="' + d.variable_id + '">' + opts + '</select>' +
      '<span class="reason-src ' + srcCls + '">' + esc(d.source) + '</span>';
    list.appendChild(row);
    if (d.reason) { const w = document.createElement('div'); w.className = 'reason-why'; w.textContent = d.reason; list.appendChild(w); }
    // Right after the Size row: the W x H inputs, so the dimensions are visible
    // and editable before anything is priced.
    if (sizeMeta && Number(d.variable_id) === Number(sizeMeta.variable_id)) {
      const holder = document.createElement('div');
      holder.id = 'reasonSizeHolder';
      holder.innerHTML = renderSizeInputs();
      list.appendChild(holder);
    }
  });
  panel.appendChild(list);
  if (data.requestedQty) {
    const qr = document.createElement('div'); qr.className = 'reason-row';
    const qtyDisplay = data.qtyRange
      ? (Number(data.qtyRange.low).toLocaleString() + '–' + Number(data.qtyRange.high).toLocaleString() + ' (quoting ' + Number(data.requestedQty).toLocaleString() + ')')
      : Number(data.requestedQty).toLocaleString();
    qr.innerHTML = '<span class="reason-field">Quantity</span><span class="reason-val" style="flex:1">' + esc(qtyDisplay) + '</span><span class="reason-src src-client">client</span>';
    panel.appendChild(qr);
  }
  if (data.am_note) { const am = document.createElement('div'); am.className = 'am-note'; am.style.marginTop = '10px'; am.innerHTML = '<strong>⚑ For the AM:</strong> ' + esc(data.am_note); panel.appendChild(am); }
  const actions = document.createElement('div'); actions.className = 'reason-actions'; actions.style.cssText = 'display:flex;align-items:center;gap:10px';
  const fillBtn = document.createElement('button'); fillBtn.className = 'next-btn'; fillBtn.textContent = 'Approve & fill calculator →';
  actions.appendChild(fillBtn);
  const reasonChip = document.createElement('span'); reasonChip.className = 'phase-timer done'; reasonChip.textContent = 'reasoned in ' + (reasonMs/1000).toFixed(1) + 's';
  actions.appendChild(reasonChip);
  panel.appendChild(actions);
  bubble.appendChild(panel);
  scrollDown();

  // Disable options that violate filter rules; grey out parent-gated inactive fields
  function regate() {
    // First, mark inactive field rows (parent dependency not satisfied)
    panel.querySelectorAll('.reason-row[data-var]').forEach(row => {
      const varId = Number(row.dataset.var);
      const active = fieldActive(varId);
      row.classList.toggle('field-inactive', !active);
      const s = row.querySelector('.reason-select');
      if (s) s.disabled = !active;
      const srcEl = row.querySelector('.reason-src');
      if (!active && srcEl) { srcEl.textContent = 'n/a'; srcEl.className = 'reason-src src-default'; }
    });
    // Then, option-level gating within active fields
    panel.querySelectorAll('.reason-select').forEach(s => {
      Array.from(s.options).forEach(opt => { opt.disabled = !itemOK(Number(opt.value)); });
      if (s.selectedOptions[0] && s.selectedOptions[0].disabled) {
        const firstOk = Array.from(s.options).find(o => !o.disabled);
        if (firstOk) { s.value = firstOk.value; applyChange(s); }
      }
    });
  }
  function applyChange(s) {
    const i = parseInt(s.dataset.idx);
    const varId = Number(s.dataset.var);
    const itemId = Number(s.value);
    sel[varId] = itemId;
    const title = s.selectedOptions[0] ? s.selectedOptions[0].textContent : '';
    ctx.decisions[i].value = title;
    ctx.decisions[i].item_id = itemId;
    const srcEl = s.parentNode.querySelector('.reason-src');
    if (srcEl) { srcEl.textContent = 'edited'; srcEl.className = 'reason-src src-edited'; }
  }
  function refreshSizeInputs() {
    const holder = document.getElementById('reasonSizeHolder');
    if (!holder) return;
    holder.innerHTML = renderSizeInputs();
    bindSizeInputs();
  }
  function bindSizeInputs() {
    const wEl = document.getElementById('reasonW');
    const hEl = document.getElementById('reasonH');
    if (!wEl || !hEl) return;
    const onEdit = () => {
      const w = wEl.value.trim() !== '' ? Number(wEl.value) : null;
      const h = hEl.value.trim() !== '' ? Number(hEl.value) : null;
      ctx.customSize = (w && h && w > 0 && h > 0) ? { w: w, h: h } : null;
      ctx.customSizeSource = 'manual';
    };
    wEl.addEventListener('input', onEdit);
    hEl.addEventListener('input', onEdit);
    // Re-render (badge + warning) only once typing settles, so focus isn't lost
    wEl.addEventListener('change', refreshSizeInputs);
    hEl.addEventListener('change', refreshSizeInputs);
  }
  bindSizeInputs();

  panel.querySelectorAll('.reason-select').forEach(s => {
    s.onchange = () => {
      applyChange(s);
      // Switching the size option shows/hides the W x H inputs
      if (sizeMeta && Number(s.dataset.var) === Number(sizeMeta.variable_id)) {
        if (sizeIsCustom() && !ctx.customSize && sizeMeta.w && sizeMeta.h) {
          ctx.customSize = { w: sizeMeta.w, h: sizeMeta.h };
          ctx.customSizeSource = sizeMeta.source;
        } else if (!sizeIsCustom()) {
          ctx.customSize = null; ctx.customSizeSource = null;
        }
        refreshSizeInputs();
      }
      regate();
    };
  });
  regate(); // initial pass

  fillBtn.onclick = async () => {
    fillBtn.disabled = true; fillBtn.textContent = 'Filling…';
    if (reasonChip) reasonChip.remove();
    // --- Fill phase timer: fresh, starts at 0 on this click, inline next to the button ---
    const fillTimerEl = document.createElement('span'); fillTimerEl.className = 'phase-timer'; fillTimerEl.textContent = '0.0s';
    actions.appendChild(fillTimerEl);
    const fillStart = Date.now();
    const fillInt = setInterval(() => { fillTimerEl.textContent = ((Date.now() - fillStart) / 1000).toFixed(1) + 's'; }, 100);
    const stopFill = () => { clearInterval(fillInt); };
    // STEP 8 - build calculator + quote from approved decisions
    let br;
    try {
      const r = await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ step: 8, context: ctx }) });
      br = await r.json();
    } catch (e) { br = { ok: false, error: e.message }; }
    if (!br.ok || !br.data) { stopFill(); fillBtn.textContent = 'Build failed'; return; }
    const d = br.data;
    stopFill();
    const fillMs = Date.now() - fillStart;
    actions.remove();
    // Calculator (dropdowns reflect decisions via preselect)
    try { bubble.appendChild(buildCalculator(d.widget, ctx.size)); } catch (e) { console.error('calc build failed', e); }
    // Quote box matching the calculator (skip hidden/internal fields)
    if (d.qtyLines && d.qtyLines.length) {
      let txt = d.product + '\n\n';
      // Show real dimensions rather than the bare "Custom Size" label. Prefer the
      // server's resolved value, else the size stated in the request.
      const quoteWH = (d.customSize && d.customSize.w && d.customSize.h)
        ? { w: Number(d.customSize.w), h: Number(d.customSize.h) }
        : parseWH(ctx.size || '');
      (d.specs||[]).filter(s => !s.hidden).forEach(s => {
        let val = s.value;
        if (quoteWH && /size/i.test(s.label) && /custom/i.test(String(val))) {
          val = quoteWH.w + '" × ' + quoteWH.h + '" (custom)';
        }
        txt += s.label + ': ' + val + '\n';
      });
      // The client named each design in their email - list them so the quote is checkable
      const vNames = (d.widget && Array.isArray(d.widget.versionNames)) ? d.widget.versionNames : [];
      const vQtys = (d.widget && Array.isArray(d.widget.versionQtys)) ? d.widget.versionQtys : [];
      if (d.hasVersions && d.versionCount > 1 && vNames.some(n => n)) {
        txt += '\nVersions (' + d.versionCount + ' designs):\n';
        vNames.forEach((n, i) => {
          const q = vQtys[i];
          txt += '  ' + (i + 1) + '. ' + (n || 'Design ' + (i + 1)) + (q != null ? ' — ' + q + (q === 1 ? ' copy' : ' copies') : ' — qty TBC') + '\n';
        });
        if (d.versionsUnresolved) txt += '  (file count for "set" items to be confirmed)\n';
      }
      txt += '\n';
      d.qtyLines.forEach((l, i) => {
        let tag = l.requested ? '  (requested)' : ((!d.qtySpecified && i===0) ? '  (default)' : '');
        txt += 'Qty ' + Number(l.qty).toLocaleString() + ': ' + (l.price==null?'n/a':'$'+l.price.toFixed(2)) + tag + '\n';
      });
      const quoteSpecs = (d.specs || []).filter(s => !s.hidden).map(s => {
        if (quoteWH && /size/i.test(s.label) && /custom/i.test(String(s.value))) {
          return { label: s.label, value: quoteWH.w + '" × ' + quoteWH.h + '" (custom)', hidden: s.hidden };
        }
        return s;
      });
      bubble.appendChild(buildQuoteBox(txt.trim(), d.url, d.product, { specs: quoteSpecs, lines: d.qtyLines || [], timeline: d.timeline || null }));
    }
    if (!d.qtySpecified) {
      const q = document.createElement('div'); q.style.cssText = 'margin-top:10px;font-size:13px;color:var(--ink)';
      q.innerHTML = 'No quantity specified — showing default + next tiers. <strong>Confirm the quantity with the client.</strong>';
      bubble.appendChild(q);
    }
    // Merged multiple files into one job, but this product can't do versions -> must split
    if (d.versionsUnsupported) {
      const vu = document.createElement('div'); vu.className = 'version-warn';
      vu.innerHTML = '<strong>Can\'t combine these.</strong> ' + esc(d.consolidationNote || '') +
        ' Price one design here, then repeat for each file — or pick a product that has versions enabled.';
      bubble.appendChild(vu);
    }
    // Versions (multiple designs) note
    if (d.hasVersions) {
      const vn = document.createElement('div'); vn.style.cssText = 'margin-top:10px;font-size:13px;';
      if (d.versionCount && d.versionCount > 1) {
        vn.style.color = 'var(--ink)';
        vn.innerHTML = '<strong>Versions:</strong> priced for <strong>' + d.versionCount + ' designs</strong> (version fee included). The total quantity is split across the designs.';
        if (d.consolidated) {
          vn.innerHTML += '<br><span style="color:var(--muted)">Combined from ' + (d.versionLines || []).length + ' line items in the client\'s email.</span>';
        }
      } else {
        vn.style.color = 'var(--ink-soft)';
        vn.innerHTML = 'This product supports <strong>multiple versions</strong> (different designs in one run). Priced as a single design — confirm with the client if they need more than one design.';
      }
      bubble.appendChild(vn);
      // Some lines said "set" / "of each" without a file count - the version count is a floor.
      if (d.versionsUnresolved) {
        const vq = document.createElement('div'); vq.className = 'version-warn';
        vq.innerHTML = '<strong>Confirm the file count.</strong> Some lines say "set" or "of each" without saying how many files are in them, so <strong>' +
          (d.versionCount || 1) + ' versions is a minimum</strong>. Ask the client for the exact number of files before this quote goes out.';
        bubble.appendChild(vq);
      }
      ctx._hasVersions = true; ctx._versionCount = d.versionCount || 1;
    }
    // Final fill-phase time, shown as a small chip at the bottom
    const fillDone = document.createElement('div'); fillDone.style.cssText = 'margin-top:10px';
    fillDone.innerHTML = '<span class="phase-timer done">filled in ' + (fillMs/1000).toFixed(1) + 's</span>';
    bubble.appendChild(fillDone);
    // Rating strip for the built quote
    const quoteSummary = 'QUOTE: ' + d.product + ' — ' + (d.qtyLines||[]).map(l => Number(l.qty).toLocaleString() + ': ' + (l.price==null?'n/a':'$'+l.price.toFixed(2))).join(', ');
    attachRatingStrip(bubble, 'Rate this quote:', quoteSummary);
    // Notify a multi-product manager that this product's quote is ready
    if (opts.onDone) {
      opts.onDone({
        product: d.product, url: d.url,
        specs: (d.specs || []).filter(s => !s.hidden),
        lines: d.qtyLines || [], timeline: d.timeline || null,
        hasVersions: d.hasVersions, versionCount: d.versionCount || 1
      });
    }
    scrollDown();
  };
}

function renderStep(stepN, resp, content, ctx) {
  if (!resp.ok) { content.innerHTML = '<span style="color:#ef4444">Error: ' + esc(resp.error || 'failed') + '</span>'; return; }
  const d = resp.data;
  if (stepN === 1) {
    ctx.email = d.email || ''; ctx.product_hint = d.product_hint || ''; ctx.specials = d.specials || '';
    content.innerHTML = '<strong>Request:</strong> ' + esc(d.summary || '') +
      (d.email ? '<br><span style="color:var(--muted)">Email: ' + esc(d.email) + '</span>' : '') +
      (d.specials ? '<br><span style="color:var(--muted)">Specified: ' + esc(d.specials) + '</span>' : '');
  } else if (stepN === 2) {
    if (!d) { content.innerHTML = '<span style="color:var(--muted)">No client found.</span>'; return; }
    ctx.client_id = d.id;
    content.innerHTML = '';
    content.appendChild(buildClientChip({ name: d.full_name, company: d.company_name, email: d.email, phone: d.phone, orders: d.order_count, invoices: d.invoice_count }));
  } else if (stepN === 3) {
    if (!d || !d.length) { content.innerHTML = '<span style="color:var(--muted)">No recent emails.</span>'; return; }
    content.innerHTML = '<strong>Last ' + d.length + ' emails:</strong>' + d.map(m => '<div style="margin-top:5px;font-size:12px"><span style="color:var(--ink)">' + esc(m.subject) + '</span> <span style="color:var(--muted)">· ' + esc((m.date||'').slice(0,16)) + '</span></div>').join('');
  } else if (stepN === 4) {
    if (!d || !d.length) { content.innerHTML = '<span style="color:var(--muted)">No past orders.</span>'; return; }
    content.innerHTML = '<strong>Past orders (' + d.length + '):</strong>' + d.slice(0,8).map(o => {
      const price = (o.price != null && o.price !== '') ? ' · $' + Number(o.price).toFixed(2) : '';
      return '<div style="margin-top:4px;font-size:12px"><span style="color:var(--indigo-dark);font-weight:600">' + esc(o.e_number || ('E'+o.id)) + '</span> ' +
        esc(o.label || o.product || '') + ' <span style="color:var(--muted)">· ' + esc((o.created||'').slice(0,10)) + price + '</span></div>';
    }).join('') + (d.length > 8 ? '<div style="margin-top:4px;font-size:11px;color:var(--muted)">+ ' + (d.length-8) + ' more</div>' : '');
  } else if (stepN === 5) {
    const prods = (d && d.products) || [];
    ctx.products = prods;
    if (!prods.length) { content.innerHTML = '<span style="color:var(--muted)">No matching product — will need manual pick.</span>'; return; }
    if (prods.length === 1) {
      content.innerHTML = '<strong>1 product matched:</strong> ' + esc(prods[0].title);
    } else {
      content.innerHTML = '<strong>' + prods.length + ' products matched.</strong> Pick below to price.';
    }
  }
}

// Build the client chip card
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return d.slice(0,3) + '-' + d.slice(3,6) + '-' + d.slice(6);
  if (d.length === 11 && d[0] === '1') return '1-' + d.slice(1,4) + '-' + d.slice(4,7) + '-' + d.slice(7);
  return p || '';
}
function buildClientChip(c) {
  const initials = (c.name || '?').split(/\s+/).map(w => w[0]).slice(0,2).join('').toUpperCase();
  const wrap = document.createElement('div');
  wrap.className = 'client-chip';
  let contact = '';
  if (c.email) contact += '<a href="mailto:' + esc(c.email) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>' + esc(c.email) + '</a>';
  if (c.phone) contact += '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>' + esc(fmtPhone(c.phone)) + '</span>';
  if (c.location) contact += '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>' + esc(c.location) + '</span>';
  const ordersBlock = (c.orders != null || c.invoices != null || c.email_count != null)
    ? '<div class="client-stats">' +
        (c.orders != null ? '<div class="stat"><div class="num">' + c.orders + '</div><div class="lbl">Orders</div></div>' : '') +
        (c.invoices != null ? '<div class="stat"><div class="num">' + c.invoices + '</div><div class="lbl">Invoices</div></div>' : '') +
        (c.email_count != null ? '<div class="stat"><div class="num">' + c.email_count + '</div><div class="lbl">Emails</div></div>' : '') +
      '</div>'
    : '';

  // How confident is the identity match? Anything but an exact email match gets
  // an amber badge so the team knows to confirm before quoting.
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const QUERY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="8" x2="12" y2="13"></line><line x1="12" y1="16.5" x2="12.01" y2="16.5"></line></svg>';
  const mc = c.match_confidence || (c.orders != null ? 'exact' : '');
  let verifyCls = 'verify', verifyIcon = CHECK, verifyTitle = 'Matched by email', matchNote = '';
  if (mc === 'domain') {
    verifyCls = 'verify unverified'; verifyIcon = QUERY; verifyTitle = 'Matched by company domain';
    matchNote = 'Matched on the company domain — this sender is not on file. Confirm it is the same account before quoting.';
  } else if (mc === 'name') {
    verifyCls = 'verify unverified'; verifyIcon = QUERY; verifyTitle = 'Fuzzy name match';
    matchNote = 'Fuzzy name/company match. Confirm this is the right account before quoting.';
  } else if (mc === 'none') {
    verifyCls = 'verify newclient'; verifyIcon = QUERY; verifyTitle = 'New client';
    matchNote = 'No customer record — treat as a new client. No discount on file; verify billing details.';
  }

  const badge = mc === 'none' ? '<span class="client-badge new">New client</span>'
    : (mc === 'domain' || mc === 'name') ? '<span class="client-badge warn">Unconfirmed</span>' : '';

  if (mc) wrap.classList.add('mc-' + mc);

  const lastOrderRow = c.last_order
    ? '<div class="client-last-order"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7h-9M14 17H5M17 3l3 4-3 4M7 13l-3 4 3 4"></path></svg>Last order: ' + esc(c.last_order) + '</div>'
    : '';

  wrap.innerHTML =
    '<div class="client-avatar">' + esc(initials) + '<span class="' + verifyCls + '" title="' + esc(verifyTitle) + '">' + verifyIcon + '</span></div>' +
    '<div class="client-main"><div class="client-name-row"><span class="client-name">' + esc(c.name) + '</span>' +
    (c.company ? '<span class="client-company">— ' + esc(c.company) + '</span>' : '') + badge + '</div>' +
    '<div class="client-contact">' + contact + '</div>' +
    lastOrderRow +
    (matchNote ? '<div class="client-match-note">' + esc(matchNote) + '</div>' : '') +
    '</div>' +
    ordersBlock;
  return wrap;
}

// Collapse a timing bar into a total chip + ? toggle revealing the detail
function collapseTimingBar(bar) {
  const chips = Array.from(bar.querySelectorAll('.timing-chip'));
  if (!chips.length) return;
  const totalChip = chips.find(c => c.classList.contains('total'));
  const detailChips = chips.filter(c => c !== totalChip);
  bar.innerHTML = '';
  const collapsed = document.createElement('div');
  collapsed.className = 'timing-collapsed';
  if (totalChip) collapsed.appendChild(totalChip);
  const detail = document.createElement('div');
  detail.className = 'timing-detail';
  detail.style.display = 'none';
  detailChips.forEach(c => detail.appendChild(c));
  if (detailChips.length) {
    const toggle = document.createElement('button');
    toggle.className = 'timing-toggle';
    toggle.textContent = '?';
    toggle.title = 'Show timing details';
    toggle.onclick = () => {
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : 'flex';
      toggle.classList.toggle('open', !open);
    };
    collapsed.appendChild(toggle);
  }
  bar.appendChild(collapsed);
  bar.appendChild(detail);
}
