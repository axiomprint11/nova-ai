// ===== Prepress — standalone conversational agent page =====
// Auth happens on the homepage (/). This page requires a token; if missing, bounce home.
let token = localStorage.getItem('axiom_token');
let username = localStorage.getItem('axiom_user');
let isAdmin = localStorage.getItem('axiom_admin') === '1';
let currentChatId = null;
let chatHistory = [];
let isLoading = false;
let agents = [];
const currentAgent = 'prepress-ai';            // fixed for this page
function agentName() { return 'Prepress'; }

// Slug -> page route. Keep in sync with the launcher (index.html).
const AGENT_ROUTES = { 'order-assist': '/order-assist', 'prepress-ai': '/prepress' };

if (!token) { window.location.href = '/'; }
else { showApp(); }

function autoResize(el) { el.style.height = '40px'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
function logout() { localStorage.clear(); window.location.href = '/'; }
function scrollDown() { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function ask(text) { document.getElementById('input').value = text; document.getElementById('suggestions').style.display = 'none'; sendMessage(); }

function showApp() {
  document.getElementById('app').style.display = 'flex';
  document.getElementById('userLabel').textContent = username || '';
  document.getElementById('avatar').textContent = (username || 'U').charAt(0).toUpperCase();
  const ab = document.getElementById('adminBtn');
  if (ab) ab.style.display = isAdmin ? 'inline-flex' : 'none';
  loadAgents();
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
  row.innerHTML = '<div class="msg-avatar ai">AI</div><div class="msg-col"><div class="msg-meta">Prepress</div><div class="bubble ai">' +
    "Hi! I help with graphic design and file-prep questions — bleed, DPI, color, file formats — and I can find the die-line template for a product. What do you need?" +
    '</div></div>';
  document.getElementById('messagesInner').appendChild(row);
  // A few starter suggestions
  const sg = document.getElementById('suggestions');
  if (sg) {
    const examples = [
      'What bleed and DPI does Peel & Reveal Labels need?',
      'Find the die-line template for business cards',
      'What file structure does product 1307 require?',
      'What file format should clients send for print?'
    ];
    sg.innerHTML = examples.map(t => '<button class="suggestion" onclick="ask(' + JSON.stringify(t).replace(/"/g,'&quot;') + ')">' + esc(t) + '</button>').join('');
    sg.style.display = 'flex';
  }
}

function clearChat() {
  chatHistory = [];
  currentChatId = null;
  document.getElementById('messagesInner').innerHTML = '';
  greet();
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
    if (!j.success) return;
    currentChatId = id;
    chatHistory = [];
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
        col.innerHTML = '<div class="msg-meta">Prepress</div>';
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

// ===== Rating buttons =====
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

// ===== Send a message (conversational, hits /api/prepress/chat) =====
async function sendMessage() {
  if (isLoading) return;
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; input.style.height = '40px';
  document.getElementById('suggestions').style.display = 'none';
  isLoading = true;
  document.getElementById('sendBtn').disabled = true;

  addUserRow(text);
  chatHistory.push({ role: 'user', content: text });

  // Ensure a chat exists; persist the user message
  if (!currentChatId) {
    try {
      const r = await fetch('/api/chats/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ agent_slug: currentAgent, title: text.slice(0, 120) }) });
      const j = await r.json();
      if (j.success) { currentChatId = j.chat_id; loadChatList(); }
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
  meta.appendChild(document.createTextNode('Prepress'));
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
  let answerStarted = false;

  function ensureTextEl() {
    let el = bubble.querySelector('.ai-text');
    if (!el) { el = document.createElement('div'); el.className = 'ai-text'; bubble.insertBefore(el, bubble.firstChild); }
    return el;
  }

  try {
    const res = await fetch('/api/prepress/chat', {
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
        let j; try { j = JSON.parse(d); } catch (e) { continue; }

        if (j.type === 'error') {
          bubble.innerHTML = '<p style="color:#ef4444">Error: ' + esc(j.error) + '</p>';
        } else if (j.type === 'query') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          if (!stepsBox.firstChild) {
            stepsBox.innerHTML = '<span class="action-spin"></span><span class="action-label"></span>';
            stepsBox.classList.add('active');
          }
          const lbl = stepsBox.querySelector('.action-label');
          if (lbl) { lbl.style.opacity = 0; setTimeout(() => { lbl.textContent = j.description; lbl.style.opacity = 1; }, 100); }
          scrollDown();
        } else if (j.type === 'query_done') {
          // keep spinner until next action / answer
        } else if (j.type === 'product_options') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          bubble.appendChild(buildProductPicker(j.intro, j.products));
          scrollDown();
        } else if (j.type === 'templates') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          bubble.appendChild(buildTemplates(j.items, j.product));
          scrollDown();
        } else if (j.type === 'prepress_spec') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          bubble.appendChild(buildPrepressSpec(j.spec));
          scrollDown();
        } else if (j.type === 'job_files') {
          if (!answerStarted && bubble.querySelector('.typing-dots')) bubble.innerHTML = '';
          answerStarted = true;
          bubble.appendChild(buildJobFiles(j.items));
          scrollDown();
        } else if (j.type === 'timing') {
          // (timing chips omitted for the conversational UI; total shown via the row timer)
        } else if (j.type === 'text') {
          fullText += j.text;
          if (!answerStarted) { bubble.innerHTML = ''; answerStarted = true; }
          ensureTextEl().innerHTML = renderMarkdown(fullText);
          scrollDown();
        }
      }
    }

    if (!answerStarted && !fullText) bubble.innerHTML = '<p style="color:var(--muted)">No response.</p>';
    if (fullText) chatHistory.push({ role: 'assistant', content: fullText });

    // Persist assistant message + rating buttons
    if (currentChatId && fullText) {
      try {
        const r = await fetch('/api/chats/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ chat_id: currentChatId, role: 'assistant', content: fullText }) });
        const j = await r.json();
        if (j.success && j.message_id) bubble.appendChild(buildRating(j.message_id, 0));
      } catch (e) {}
    }
  } catch (e) {
    bubble.innerHTML = '<p style="color:#ef4444">Connection error. Please try again.</p>';
  }

  clearInterval(timerInt);
  timer.textContent = 'Answered in ' + ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  if (stepsBox.classList.contains('active')) { stepsBox.classList.add('done'); setTimeout(() => { stepsBox.style.display = 'none'; }, 400); }
  isLoading = false;
  document.getElementById('sendBtn').disabled = false;
  input.focus();
}

// ===== Product picker (clickable options, top 5 + Load more) =====
function buildProductPicker(intro, products) {
  const wrap = document.createElement('div');
  wrap.className = 'prod-options';
  const introEl = document.createElement('div');
  introEl.className = 'prod-options-intro';
  introEl.textContent = intro || 'Which product?';
  wrap.appendChild(introEl);

  const list = products || [];
  const PAGE = 5;
  let shown = 0;

  function pick(p, card) {
    if (isLoading) return;
    wrap.querySelectorAll('.prod-option-main').forEach(b => b.disabled = true);
    wrap.querySelectorAll('.prod-option-btn').forEach(c => c.classList.remove('chosen'));
    card.classList.add('chosen');
    const more = wrap.querySelector('.prod-load-more');
    if (more) more.remove();
    // Tell the agent which product was chosen; it continues (specs / template).
    ask('Use product "' + p.title + '" (product_id ' + p.product_id + ') for my request.');
  }

  function renderMore() {
    const slice = list.slice(shown, shown + PAGE);
    slice.forEach(p => {
      const card = document.createElement('div');
      card.className = 'prod-option-btn';
      const main = document.createElement('button');
      main.className = 'prod-option-main';
      main.innerHTML = '<span class="prod-option-title">' + esc(p.title) +
        (p.product_id ? ' <span class="prod-option-id">#' + p.product_id + '</span>' : '') + '</span>' +
        (p.note ? '<span class="prod-option-note">' + esc(p.note) + '</span>' : '');
      main.onclick = () => pick(p, card);
      card.appendChild(main);
      // Insert before the Load-more button if present
      const moreBtn = wrap.querySelector('.prod-load-more');
      if (moreBtn) wrap.insertBefore(card, moreBtn); else wrap.appendChild(card);
    });
    shown += slice.length;
    // Manage the Load-more button
    let moreBtn = wrap.querySelector('.prod-load-more');
    const remaining = list.length - shown;
    if (remaining > 0) {
      if (!moreBtn) {
        moreBtn = document.createElement('button');
        moreBtn.className = 'prod-load-more';
        moreBtn.onclick = () => { renderMore(); };
        wrap.appendChild(moreBtn);
      }
      moreBtn.textContent = 'Load more (' + remaining + ' more)';
    } else if (moreBtn) {
      moreBtn.remove();
    }
  }

  renderMore();
  return wrap;
}

// ===== Prepress spec card (real product bleed/DPI/etc. from the DB) =====
function buildPrepressSpec(spec) {
  const wrap = document.createElement('div');
  wrap.className = 'spec-card';
  const head = document.createElement('div');
  head.className = 'spec-head';
  head.textContent = '📋 Prepress spec — ' + (spec.product || '') + (spec.product_id ? ' (#' + spec.product_id + ')' : '');
  wrap.appendChild(head);

  const rows = [];
  const val = (v) => (v === null || v === undefined || v === '') ? '<span class="spec-empty">not specified</span>' : esc(String(v));
  rows.push(['Bleed', spec.bleed != null && spec.bleed !== '' ? esc(String(spec.bleed)) + '"' : '<span class="spec-empty">not specified</span>']);
  rows.push(['DPI', val(spec.dpi)]);
  if (spec.file_structure) rows.push(['File structure', esc(spec.file_structure)]);
  rows.push(['Prepress ready', (spec.prepress_ready == 1 || spec.prepress_ready === '1') ? '✓ Yes' : 'No']);
  if (spec.sample && (spec.sample.fee == 1 || spec.sample.fee === '1')) {
    let s = 'Yes';
    if (spec.sample.base) s += ' — base $' + spec.sample.base + (spec.sample.per_price ? ' + $' + spec.sample.per_price + '/unit' : '');
    rows.push(['Sample fee', esc(s)]);
  }

  const grid = document.createElement('div');
  grid.className = 'spec-grid';
  grid.innerHTML = rows.map(r => '<div class="spec-row"><span class="spec-k">' + r[0] + '</span><span class="spec-v">' + r[1] + '</span></div>').join('');
  wrap.appendChild(grid);

  if (spec.drive_folder) {
    const df = document.createElement('div');
    df.className = 'spec-folder';
    df.innerHTML = '<span class="spec-k">Drive folder</span> <code>' + esc(spec.drive_folder) + '</code>';
    wrap.appendChild(df);
  }
  return wrap;
}

// ===== Template results card (S3 preview thumbnail + die-lines library link) =====
function buildTemplates(items, product) {
  const wrap = document.createElement('div');
  wrap.className = 'tmpl-card';
  const head = document.createElement('div');
  head.className = 'tmpl-head';
  head.textContent = '📐 Templates' + (product ? ' — ' + product : '');
  wrap.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'attach-grid';
  (items || []).forEach(f => {
    const card = document.createElement('a');
    card.className = 'attach-card';
    // Link to the die-lines library (the full template lives there)
    card.href = f.libraryUrl || 'https://crm.axiomprint.com/products/die-lines';
    card.target = '_blank'; card.rel = 'noopener';
    const mineTag = f.mine ? '<span class="tmpl-mine">★ Client</span>' : '';
    if (f.thumb) {
      // S3 preview image; if it fails to load, swap to the no-preview placeholder
      card.innerHTML =
        '<img class="attach-thumb" src="' + esc(f.thumb) + '" loading="lazy" alt="" ' +
        'onerror="this.outerHTML=\'<div class=&quot;tmpl-noprev&quot;>No preview</div>\'">' +
        '<div class="attach-name">' + esc(f.name || '') + ' ' + mineTag + '</div>';
    } else {
      // No thumbnail in the DB — show name + placeholder + link to the library
      card.innerHTML =
        '<div class="tmpl-noprev">No preview</div>' +
        '<div class="attach-name">' + esc(f.name || '') + ' ' + mineTag + '</div>';
    }
    grid.appendChild(card);
  });
  wrap.appendChild(grid);
  const foot = document.createElement('div');
  foot.className = 'tmpl-foot';
  foot.innerHTML = 'Open the full template in the <a href="https://crm.axiomprint.com/products/die-lines" target="_blank" rel="noopener">die-lines library ↗</a>';
  wrap.appendChild(foot);
  return wrap;
}

// ===== Reused helpers (identical to Order Assist for consistent rendering) =====
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
