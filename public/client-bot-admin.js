// Admin console for the customer-facing bot: Try it · Conversations · Training · Setup.
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const H = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
  // "Today, 3 hours ago" · "Yesterday at 4:55 PM" · "Monday at 9:10 AM" · "Sep 12 at 2:05 PM".
  const toDate = (ts) => new Date(String(ts).replace(' ', 'T') + (/Z$|[+-]\d\d:?\d\d$/.test(String(ts)) ? '' : 'Z'));
  const rel = (ts) => {
    if (!ts) return '';
    const d = toDate(ts);
    if (isNaN(d)) return String(ts);
    const now = new Date();
    const mins = Math.round((now - d) / 60000);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day0(now) - day0(d)) / 86400000);
    if (days === 0) {
      if (mins < 1) return 'Today, just now';
      if (mins < 60) return 'Today, ' + mins + ' min ago';
      const h = Math.floor(mins / 60);
      return 'Today, ' + h + ' hour' + (h === 1 ? '' : 's') + ' ago';
    }
    if (days === 1) return 'Yesterday at ' + time;
    if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'long' }) + ' at ' + time;
    return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + time;
  };
  const full = (ts) => { const d = toDate(ts); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }); };
  const when = (ts) => {
    if (!ts) return '';
    const d = new Date(String(ts).replace(' ', 'T') + (/Z$/.test(ts) ? '' : 'Z'));
    return isNaN(d) ? ts : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  // Admins only — the server enforces it; this just sends others home.
  fetch('/api/admin/client-bot/overview', { headers: H() }).then(r => {
    if (r.status === 401 || r.status === 403) { location.href = '/'; return null; }
    return r.json();
  }).then(j => { if (j) { overview = j; paintOverview(); } }).catch(() => {});
  let overview = null;

  // ---- tabs ----
  const views = { try: 'vTry', convos: 'vConvos', train: 'vTrain', setup: 'vSetup' };
  document.querySelectorAll('.cb-tabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.cb-tabs button').forEach(x => x.classList.toggle('on', x === b));
      Object.keys(views).forEach(k => $(views[k]).classList.toggle('on', k === b.dataset.v));
      if (b.dataset.v === 'convos') loadConvos();
      if (b.dataset.v === 'train') loadTraining();
      if (b.dataset.v === 'setup') paintSetup();
    };
  });
  // Conversations is the main tab: it opens first (after the rest of the page is set up).
  setTimeout(() => { const c = document.querySelector('.cb-tabs button[data-v="convos"]'); if (c) c.click(); }, 0);

  // ---- Try it ----
  let asCustomer = null;
  let greeting = null;
  const chat = ClientChat.mount($('chatHost'), {
    getToken: () => token,
    extraBody: () => ({ as_customer_id: asCustomer ? asCustomer.id : null }),
    hint: 'Admin preview — saved under Conversations as "Admin preview". Add to Cart never touches a real cart here: it shows what would be sent.',
    signedIn: () => !!asCustomer,        // as a customer: Add to Cart shows the would-be cart item; as a visitor: the sign-in prompt
    suggestions: [['Business card prices', 'How much are 500 business cards?'], ['Banner options', 'What banner materials do you have?'],
                  ['Status update of my last order', 'Status update of my last order']],
    onAnswer: (j) => {
      const t = j.tools || [];
      $('toolsBox').innerHTML = '<div class="cb-h">What the last answer looked up</div>' + (t.length
        ? t.map(x => '<div><code>' + esc(x.tool) + '</code> ' + esc(JSON.stringify(x.input || {})) + '<br>→ ' + esc(x.found) + '</div>').join('')
        : '<div>Nothing — answered from its rules and knowledge.</div>');
    }
  });
  fetch('/api/client-bot/hello', { headers: H() }).then(r => r.json()).then(j => {
    if (j && j.greeting) { greeting = j.greeting; chat.setGreeting(j.greeting); }
  }).catch(() => {});

  function paintWho() {
    $('asWho').innerHTML = asCustomer
      ? '<b>' + esc(asCustomer.name || 'Customer') + (asCustomer.company ? ' · ' + esc(asCustomer.company) : '') + '</b>' +
        esc(asCustomer.email || '') + ' · #' + asCustomer.id + '<br>Nova sees only this customer’s orders.'
      : 'Not signed in — products and prices only.';
    $('toolsBox').innerHTML = '';
    chat.reset(greeting);
  }
  document.querySelectorAll('input[name=as]').forEach(r => {
    r.onchange = () => {
      const cust = r.value === 'cust' && r.checked;
      $('custSearch').style.display = cust ? '' : 'none';
      if (!cust) { asCustomer = null; $('custRes').innerHTML = ''; paintWho(); }
      else setTimeout(() => $('custSearch').focus(), 50);
    };
  });
  let st = null;
  $('custSearch').oninput = () => {
    clearTimeout(st);
    const q = $('custSearch').value.trim();
    if (q.length < 2) { $('custRes').innerHTML = ''; return; }
    st = setTimeout(async () => {
      const j = await fetch('/api/admin/client-bot/customers?q=' + encodeURIComponent(q), { headers: H() }).then(r => r.json()).catch(() => ({}));
      const list = (j && j.customers) || [];
      $('custRes').innerHTML = list.length ? '' : '<small style="color:var(--muted)">No match.</small>';
      list.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<b>' + esc(c.name || '(no name)') + '</b>' + (c.company ? ' · ' + esc(c.company) : '') + '<small>' + esc(c.email) + ' · #' + c.id + '</small>';
        b.onclick = () => { asCustomer = c; $('custRes').innerHTML = ''; $('custSearch').value = ''; paintWho(); };
        $('custRes').appendChild(b);
      });
    }, 280);
  };
  $('newChat').onclick = () => { $('toolsBox').innerHTML = ''; chat.reset(greeting); };

  // ---- Conversations ----
  let src = '', openId = null;
  document.querySelectorAll('#convSrc button').forEach(b => {
    b.onclick = () => {
      src = b.dataset.s;
      document.querySelectorAll('#convSrc button').forEach(x => x.classList.toggle('on', x === b));
      loadConvos();
    };
  });
  let qt = null;
  $('convQ').oninput = () => { clearTimeout(qt); qt = setTimeout(loadConvos, 300); };

  let loadedAt = 0;
  async function loadConvos() {
    const p = new URLSearchParams();
    if (src === 'website' || src === 'preview') p.set('source', src);
    if (src === 'signed') p.set('signed', '1');
    if (src === 'unread') p.set('unread', '1');
    if ($('convQ').value.trim()) p.set('q', $('convQ').value.trim());
    const j = await fetch('/api/admin/client-bot/chats?' + p, { headers: H() }).then(r => r.json()).catch(() => ({}));
    const rows = (j && j.chats) || [];
    const box = $('convRows');
    $('convUnread').textContent = j && j.unread ? j.unread : '';
    loadedAt = Date.now(); stamp();
    const keep = box.scrollTop;                       // a refresh keeps your place in the list
    if (!rows.length) { box.innerHTML = '<div class="cb-empty">' + (src === 'unread' ? 'All caught up \u2014 nothing unread.' : 'No conversations yet.') + '</div>'; return; }
    box.innerHTML = '';
    rows.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cb-row' + (c.id === openId ? ' on' : '') + (c.unread && c.id !== openId ? ' unread' : '');
      b.title = c.unread ? 'Unread' : '';
      b.innerHTML = '<div class="cb-when" title="' + esc(full(c.updated_at)) + '" data-ts="' + esc(c.updated_at || '') + '">' + esc(rel(c.updated_at)) +
          '<span>' + (c.message_count || 0) + ' messages</span></div>' +
        '<div class="t">' + esc(c.customer_name || (c.customer_id ? 'Customer #' + c.customer_id : 'Visitor (not signed in)')) +
        '<span class="cb-tag ' + (c.source === 'website' ? 'web' : 'pre') + '">' + (c.source === 'website' ? 'Website' : 'Preview') + '</span>' +
        (c.rating ? '<span class="cb-rt ' + c.rating + '" title="Rated ' + (c.rating === 'up' ? 'good' : 'not good') + '">' + (c.rating === 'up' ? '\ud83d\udc4d' : '\ud83d\udc4e') + '</span>' : '') + '</div>' +
        '<small>' + esc([c.company, c.customer_email].filter(Boolean).join(' · ')) + '</small>' +
        '<small>' + esc(c.last_message || c.title || '') + '</small>' +
        (c.src || c.dev_type ? '<small class="cb-row-src">' + (c.dev_type ? (c.dev_type === 'Desktop' ? '\ud83d\udcbb ' : '\ud83d\udcf1 ') : '') +
          (c.src ? 'via ' + esc(c.src) : '') + '</small>' : '') +
        (c.last_page ? '<small class="cb-row-page" title="' + esc(c.last_page) + '">\ud83d\udd17 ' + esc(String(c.last_page).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</small>' : '');
      b.onclick = () => openConvo(c.id);
      box.appendChild(b);
    });
    box.scrollTop = keep;
  }
  function stamp() {
    if (!loadedAt) return;
    const s = Math.round((Date.now() - loadedAt) / 1000);
    $('convStamp').textContent = 'Updated ' + (s < 10 ? 'just now' : s < 60 ? s + ' sec ago' : Math.round(s / 60) + ' min ago');
  }
  setInterval(stamp, 15000);
  // Refresh: the newest chats, and the open conversation's newest messages.
  async function refreshConvos() {
    const btn = $('convRefresh');
    btn.classList.add('spin'); btn.disabled = true;
    try { if (openId) await openConvo(openId, true); else await loadConvos(); }
    finally { btn.classList.remove('spin'); btn.disabled = false; }
  }
  $('convRefresh').onclick = refreshConvos;
  // Also by itself every minute while the Conversations tab is on screen.
  setInterval(() => { if (!document.hidden && $('vConvos') && $('vConvos').offsetParent) loadConvos(); }, 60000);
  // A link like /client-bot?chat=123 (the escalation email) opens that conversation.
  const deepChat = parseInt(new URLSearchParams(location.search).get('chat'));
  if (deepChat) setTimeout(() => { openConvo(deepChat); }, 500);
  $('convReadAll').onclick = async () => {
    await fetch('/api/admin/client-bot/chats/read-all', { method: 'POST', headers: H() }).catch(() => {});
    loadConvos();
  };
  $('convView').addEventListener('click', async (e) => {
    const b = e.target.closest('.cb-tr-unread');
    if (!b || !openId) return;
    await fetch('/api/admin/client-bot/chats/' + openId + '/unread', { method: 'POST', headers: H() }).catch(() => {});
    openId = null;
    $('convView').innerHTML = '<div class="cb-empty">Marked as unread.</div>';
    loadConvos();
  });

  // ---- Thumbs up / down on a conversation: NovaAI learns from it ----
  function rateBar(r) {
    r = r || {};
    return '<div class="cb-rate" data-rating="' + esc(r.rating || '') + '">' +
      '<span>Rate this conversation</span>' +
      '<button type="button" class="cb-up' + (r.rating === 'up' ? ' on' : '') + '" title="Good \u2014 NovaAI will use it as an example">\ud83d\udc4d</button>' +
      '<button type="button" class="cb-down' + (r.rating === 'down' ? ' on' : '') + '" title="Not good \u2014 say what was wrong and NovaAI will avoid it">\ud83d\udc4e</button>' +
      (r.rating && r.active === 0 ? '<em>not used in answers</em>' : '') +
      (r.note ? '<div class="cb-rate-saved"><b>' + (r.rating === 'up' ? 'What was good' : 'What wasn\u2019t right') + ':</b> ' + esc(r.note) + ' <button type="button" class="cb-rate-edit">Edit</button></div>' : '') +
      '<div class="cb-rate-note" hidden><textarea rows="3" maxlength="1000"></textarea>' +
      '<div><button type="button" class="cb-rate-save">Save</button><button type="button" class="cb-rate-x">Cancel</button>' +
      '<small>NovaAI reads this in every new conversation (Training \u2192 Lessons).</small></div></div></div>';
  }
  function openNote(bar, kind, text) {
    const box = bar.querySelector('.cb-rate-note'), ta = box.querySelector('textarea');
    box.hidden = false; box.dataset.kind = kind;
    ta.placeholder = kind === 'down' ? 'What wasn\u2019t right? e.g. \u201cAsked for the quantity instead of pricing the default\u201d, \u201cToo long\u201d, \u201cWrong product suggested\u201d'
      : 'What was good? (optional) e.g. \u201cShort answer, priced straight away, offered the coupon\u201d';
    ta.value = text || ''; ta.focus();
  }
  async function saveRating(rating, note) {
    await fetch('/api/admin/client-bot/chats/' + openId + '/rating', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H()),
      body: JSON.stringify({ rating: rating, note: note || '' }) }).catch(() => {});
    await openConvo(openId, true);
  }
  $('convView').addEventListener('click', async (e) => {
    const bar = e.target.closest('.cb-rate');
    if (!bar || !openId) return;
    const cur = bar.dataset.rating;
    const saved = bar.querySelector('.cb-rate-saved');
    const curNote = saved ? saved.textContent.replace(/^[^:]*:\s*/, '').replace(/\s*Edit$/, '') : '';
    if (e.target.closest('.cb-up')) {
      if (cur === 'up') { await saveRating(null); return; }          // click again: take it back
      await saveRating('up', '');
      const nb = $('convView').querySelector('.cb-rate');
      if (nb) openNote(nb, 'up', ''); return;
    }
    if (e.target.closest('.cb-down')) {
      if (cur === 'down' && !bar.querySelector('.cb-rate-note').hidden) return;
      openNote(bar, 'down', cur === 'down' ? curNote : ''); return;
    }
    if (e.target.closest('.cb-rate-edit')) { openNote(bar, cur || 'down', curNote); return; }
    if (e.target.closest('.cb-rate-x')) { bar.querySelector('.cb-rate-note').hidden = true; return; }
    if (e.target.closest('.cb-rate-save')) {
      const box = bar.querySelector('.cb-rate-note');
      await saveRating(box.dataset.kind || 'down', box.querySelector('textarea').value.trim());
    }
  });

  // Header line: the page the conversation started on, and the latest one if it moved.
  // An address to read: no https://www., and without long tracking values (the full address is in the link).
  function shortUrl(u) {
    try {
      const x = new URL(String(u));
      const keep = Array.from(x.searchParams.keys()).filter(k => /^utm_/.test(k));
      const dropped = Array.from(x.searchParams.keys()).length - keep.length;
      const q = keep.map(k => k + '=' + x.searchParams.get(k)).join('&');
      return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '') + (q ? '?' + q : '') + (dropped ? ' \u2026' : '');
    } catch (e) { return String(u || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 120); }
  }
  const urlLink = (u, title) => '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" title="' + esc(title ? title + ' \u2014 ' + u : u) + '">' + esc(shortUrl(u)) + '</a>';
  // Visitor details at the top of a conversation. One line of icon chips (source, device, browser,
  // screen, language, time zone, IP) — the full wording is in each chip's tooltip — then the pages.
  const VI = (d) => '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const ICON = {
    laptop: VI('<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'),
    phone: VI('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>'),
    tablet: VI('<rect x="4.5" y="2.5" width="15" height="19" rx="2"/><path d="M11 18.5h2"/>'),
    browser: VI('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    app: VI('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 12h6M12 9v6"/>'),
    screen: VI('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>'),
    lang: VI('<path d="M4 6h9M8.5 4v2M6 6c.8 3 2.8 5.3 5.5 6.5M11 6c-.8 3.5-3 6-6.5 7.5"/><path d="M13 20l3.5-8 3.5 8M14.2 17.5h4.6"/>'),
    clock: VI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    pin: VI('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
    search: VI('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    ai: VI('<path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>'),
    star: VI('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
    people: VI('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 4.9"/>'),
    ad: VI('<path d="M3 10v4h3l6 4V6L6 10H3z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
    mail: VI('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>'),
    link: VI('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
    direct: VI('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    map: VI('<path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z"/><path d="M9 4v13M15 6.5v13"/>')
  };
  function sourceIcon(s) {
    const k = String((s && s.kind) || '').toLowerCase();
    return /paid/.test(k) ? ICON.ad : /ai assistant/.test(k) ? ICON.ai : /maps/.test(k) ? ICON.map : /search|shopping/.test(k) ? ICON.search
      : /directory|review/.test(k) ? ICON.star : /social|app/.test(k) ? ICON.people : /email|text/.test(k) ? ICON.mail
      : /referral|campaign/.test(k) ? ICON.link : ICON.direct;
  }
  const chip = (icon, text, tip, cls) => '<span class="cb-chip' + (cls ? ' ' + cls : '') + '" title="' + esc(tip || text) + '">' + icon + '<span>' + esc(text) + '</span></span>';
  function visitorBox(v, list, c) {
    v = v || {};
    const rows = [];
    const row = (label, html) => rows.push('<div class="cb-vis-row"><span>' + esc(label) + '</span><div>' + html + '</div></div>');
    const d = v.device || {};
    const chips = [];
    if (v.source) chips.push(chip(sourceIcon(v.source), v.source.label, 'Came from ' + v.source.label + ' — ' + (v.source.kind || '') +
      (v.source.detail ? ' (' + v.source.detail + ')' : ''), 'src'));
    else if (c.source === 'website') chips.push(chip(ICON.direct, 'Source not recorded', 'This conversation is from before visit tracking', 'muted'));
    if (d.label) {
      const devIcon = d.type === 'Phone' ? ICON.phone : d.type === 'Tablet' ? ICON.tablet : ICON.laptop;
      chips.push(chip(devIcon, d.os || d.type || 'Device', (d.type || 'Device') + (d.os ? ' — ' + d.os : '')));
      if (d.app) chips.push(chip(ICON.app, d.app, 'Opened inside the ' + d.app + (d.browser ? ' (' + d.browser + ')' : '')));
      else if (d.browser) chips.push(chip(ICON.browser, d.browser, 'Browser: ' + d.browser));
    }
    if (d.screen) chips.push(chip(ICON.screen, d.screen.replace('x', '×'), 'Screen ' + d.screen.replace('x', ' × ') + ' px'));
    if (d.lang) chips.push(chip(ICON.lang, d.lang, 'Browser language: ' + d.lang));
    if (d.tz) chips.push(chip(ICON.clock, d.tz.split('/').pop().replace(/_/g, ' '), 'Time zone: ' + d.tz));
    if (v.ip) chips.push(chip(ICON.pin, v.ip, 'IP address ' + v.ip));
    else if (v.ip_note) chips.push(chip(ICON.pin, 'IP not recorded', v.ip_note, 'muted'));
    if (chips.length) rows.push('<div class="cb-chips">' + chips.join('') + '</div>');
    const tags = Object.keys(v.tags || {});
    if (v.landing) row('Landed on', urlLink(v.landing) + (v.referrer ? ' <small>from ' + urlLink(v.referrer) + '</small>' : '') +
      (v.arrived ? ' <small>· ' + esc(rel(v.arrived)) + '</small>' : '') +
      (tags.length ? ' ' + tags.map(k => '<code>' + esc(k) + '=' + esc(String(v.tags[k]).slice(0, 60)) + '</code>').join(' ') : ''));
    if (v.first && v.first.source) row('First visit', esc(rel(v.first.at)) + ' · ' +
      chip(sourceIcon(v.first.source), v.first.source.label, (v.first.source.kind || '') + (v.first.landing ? ' — ' + v.first.landing : ''), 'src sm'));
    const pages = list.filter(m => m.page_url).map(m => ({ url: m.page_url, title: m.page_title }));
    if (pages.length) {
      const first = pages[0], last = pages[pages.length - 1];
      row('Chatting from', urlLink(first.url, first.title) + (last.url !== first.url ? ' <small>→ now on</small> ' + urlLink(last.url, last.title) : ''));
    }
    return rows.length ? '<div class="cb-vis">' + rows.join('') + '</div>' : '';
  }

  async function openConvo(id, keepScroll) {
    openId = id;
    const view = $('convView'), was = view.scrollTop, atEnd = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
    document.querySelectorAll('#convRows .cb-row').forEach(x => x.classList.remove('on'));
    const j = await fetch('/api/admin/client-bot/chats/' + id, { headers: H() }).then(r => r.json()).catch(() => ({}));
    if (!j || !j.ok) return;
    const c = j.chat;
    $('convView').innerHTML =
      '<div class="cb-tr-hd"><button type="button" class="cb-tr-unread" title="Show it as unread in the list">Mark as unread</button><b>' + esc(c.customer_name || (c.customer_id ? 'Customer #' + c.customer_id : 'Visitor (not signed in)')) + '</b>' +
        (c.company ? ' · ' + esc(c.company) : '') +
        '<small>' + [c.customer_email, c.customer_id ? 'customer #' + c.customer_id : null,
          c.source === 'website' ? 'on the website' : 'admin preview' + (c.preview_by ? ' by ' + String(c.preview_by).replace(/^(member|user):/, '') : ''),
          'started ' + rel(c.created_at)].filter(Boolean).map(esc).join(' · ') + '</small>' + visitorBox(j.visitor, j.messages || [], c) + rateBar(j.rating) + '</div>' +
      transcript(j.messages);
    function transcript(list) {
      const short = shortUrl;
      // Page lines: where the chat started, and each move to another page.
      // Add to Cart clicks: their own line (the older "added to their cart" note is
      // left out when the click is already shown).
      const hasCartEvents = list.some(m => m.role === 'event' && (m.cards || []).some(x => x && x.kind === 'cart'));
      let lastPage = null;
      const pageLine = (url, title, at, moved) => '<div class="cb-evt cb-evt-page"><span>' + (moved ? 'Moved to' : 'On page') + '</span>' +
        (title ? '<b>' + esc(title) + '</b>' : '') +
        '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + esc(url) + '">' + esc(short(url)) + '</a>' +
        '<em title="' + esc(full(at)) + '" data-ts="' + esc(at || '') + '">' + esc(rel(at)) + '</em></div>';
      return list.map(m => {
        if (m.role === 'event') {
          const ev = (m.cards || [])[0] || {};
          if (ev.kind === 'page' && m.page_url) {
            if (m.page_url === lastPage) return '';
            const first = lastPage == null; lastPage = m.page_url;
            return pageLine(m.page_url, m.page_title, m.created_at, !first);
          }
          if (ev.kind === 'escalation') {
            const st = ev.preview ? 'admin preview \u2014 no email sent' : ev.already ? 'already escalated in the last 24 hours'
              : ev.sent ? 'email sent to ' + (ev.to || '') : 'email NOT sent' + (ev.error ? ' (' + ev.error + ')' : '');
            return '<div class="cb-evt cb-evt-esc' + (ev.sent || ev.already ? '' : ' bad') + '"><span>\u26a0 Past due \u2014 escalated</span><b>' +
              esc((ev.orders || []).join(', ')) + '</b><i>' + esc(st) + '</i>' +
              '<em title="' + esc(full(m.created_at)) + '" data-ts="' + esc(m.created_at || '') + '">' + esc(rel(m.created_at)) + '</em></div>';
          }
          if (ev.kind === 'cart') {
            const label = { added: 'Added to cart', signin: 'Clicked Add to Cart \u2014 asked to sign in', failed: 'Add to Cart failed', preview: 'Add to Cart (admin preview)' }[ev.outcome] || 'Clicked Add to Cart';
            return '<div class="cb-evt cb-evt-cart cb-evt-' + esc(ev.outcome || 'clicked') + '"><span>\ud83d\uded2 ' + esc(label) + '</span><b>' +
              esc((ev.quantity ? Number(ev.quantity).toLocaleString() + ' \u00d7 ' : '') + (ev.product || '')) + '</b>' +
              (ev.price != null ? '<i>$' + Number(ev.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</i>' : '') +
              (ev.job_name ? '<i>job \u201c' + esc(ev.job_name) + '\u201d</i>' : '') + (ev.error ? '<i>' + esc(ev.error) + '</i>' : '') +
              '<em title="' + esc(full(m.created_at)) + '" data-ts="' + esc(m.created_at || '') + '">' + esc(rel(m.created_at)) + '</em></div>';
          }
          return '';
        }
        if (m.role === 'user' && String(m.content || '').indexOf('[after Add to Cart]') === 0)
          return '<div class="cb-evt"><span>\u21aa Automatic</span>NovaAI moved on to the next item after Add to Cart' +
            '<em title="' + esc(full(m.created_at)) + '" data-ts="' + esc(m.created_at || '') + '">' + esc(rel(m.created_at)) + '</em></div>';
        if (m.role === 'note' && hasCartEvents && /^(\[Admin preview[^\]]*\] )?The customer added to their cart/.test(m.content || '')) return '';
        let pre = '';
        if (m.role === 'user' && m.page_url && m.page_url !== lastPage) { pre = pageLine(m.page_url, m.page_title, m.created_at, lastPage != null); lastPage = m.page_url; }
        return pre + (m.role === 'note'
        ? '<div class="cb-msg note"><div class="cb-note">\u270e ' + esc(m.content) + '</div>' + (m.cards || []).map(ClientChat.card).join('') +
            '<div class="when" title="' + esc(full(m.created_at)) + '" data-ts="' + esc(m.created_at || '') + '">' + esc(rel(m.created_at)) + '</div></div>'
        : '<div class="cb-msg ' + (m.role === 'user' ? 'user' : 'ai') + '">' +
          '<div class="bubble ' + (m.role === 'user' ? 'user' : 'ai') + '">' +
            (m.role === 'user' ? '<div dir="auto">' + esc(m.content) + '</div>' : ClientChat.md(String(m.content || '').split('[[products]]').join('')) + (m.cards || []).map(ClientChat.card).join('')) + '</div>' +
          // What they attached: the preview Nova saw, and the original to download.
          (m.files && m.files.length ? '<div class="cb-files">' + m.files.map(f =>
            '<div class="cb-file">' + (f.preview ? '<img data-prev="' + esc(f.id) + '" alt="">' : '<i>' + ClientChat.fileIcon(f.kind) + '</i>') +
              '<div><b>' + esc(f.name) + '</b><small>' + esc(f.info || '') + '</small></div>' +
              '<button type="button" data-dl="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Download</button></div>').join('') + '</div>' : '') +
          (m.tools && m.tools.length ? '<div class="cb-used">' + m.tools.map(t => '<span>' + esc(t.tool) + ' → ' + esc(t.found) + '</span>').join('') + '</div>' : '') +
          '<div class="when" title="' + esc(full(m.created_at)) + '" data-ts="' + esc(m.created_at || '') + '">' + esc(rel(m.created_at)) + '</div>' +
          (m.role === 'user' && m.page_url ? '<a class="cb-asked-on" href="' + esc(m.page_url) + '" target="_blank" rel="noopener noreferrer" title="' +
            esc((m.page_title ? m.page_title + ' \u2014 ' : '') + m.page_url) + '">\ud83d\udd17 ' + esc(short(m.page_url)) + '</a>' : '') +
        '</div>');
      }).join('');
    }
    $('convView').querySelectorAll('img[data-prev]').forEach(async (img) => {
      try {
        const r = await fetch('/api/admin/client-bot/files/' + img.getAttribute('data-prev') + '/preview', { headers: H() });
        if (r.ok) img.src = URL.createObjectURL(await r.blob());
      } catch (e) {}
    });
    if (keepScroll) view.scrollTop = atEnd ? view.scrollHeight : was;
    await loadConvos();
  }
  // Attachments are behind admin sign-in, so they are fetched with the token.
  $('convView').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dl]');
    const img = e.target.closest('img[data-prev]');
    if (img && img.src) { window.open(img.src, '_blank'); return; }
    if (!b) return;
    b.disabled = true;
    try {
      const r = await fetch('/api/admin/client-bot/files/' + b.getAttribute('data-dl'), { headers: H() });
      if (!r.ok) throw new Error('gone');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob()); a.download = b.getAttribute('data-name') || 'file';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (x) { b.textContent = 'Not available'; }
    b.disabled = false;
  });

  // Relative times move on by themselves ("5 min ago" -> "6 min ago").
  setInterval(() => {
    document.querySelectorAll('.cb-when[data-ts]').forEach(el => {
      const span = el.querySelector('span');
      el.firstChild.nodeValue = rel(el.getAttribute('data-ts'));
      if (span) el.appendChild(span);
    });
    document.querySelectorAll('.cb-msg .when[data-ts]').forEach(el => { el.textContent = rel(el.getAttribute('data-ts')); });
  }, 60000);

  // ---- Training ----
  // Lessons from rated conversations: what NovaAI reads from the thumbs.
  async function loadLessons() {
    const box = $('tLessons'); if (!box) return;
    const j = await fetch('/api/admin/client-bot/ratings', { headers: H() }).then(r => r.json()).catch(() => ({}));
    const list = (j && j.ratings) || [];
    if (!list.length) { box.innerHTML = '<div class="cb-empty" style="padding:14px">No rated conversations yet. Rate one under Conversations with \ud83d\udc4d or \ud83d\udc4e.</div>'; return; }
    box.innerHTML = list.map(r => '<div class="cb-lesson' + (r.active ? '' : ' off') + '">' +
      '<div class="cb-lesson-hd"><span>' + (r.rating === 'up' ? '\ud83d\udc4d Good example' : '\ud83d\udc4e Avoid') + '</span>' +
        '<small>' + esc(rel(r.rated_at)) + ' \u00b7 ' + esc(r.customer_name || (r.customer_id ? 'Customer #' + r.customer_id : 'Visitor')) + '</small></div>' +
      '<div class="cb-lesson-tx">' + (r.note ? esc(r.note) : '<i>' + (r.rating === 'down' ? 'No note \u2014 add one so NovaAI knows what to avoid.' : 'No note \u2014 used as an example of a good answer.') + '</i>') + '</div>' +
      '<div class="cb-lesson-ft"><label><input type="checkbox" data-act="' + r.chat_id + '"' + (r.active ? ' checked' : '') + '> Use in answers</label>' +
        '<button type="button" data-open="' + r.chat_id + '">Open conversation</button>' +
        '<button type="button" data-del="' + r.chat_id + '">Remove</button></div></div>').join('');
  }
  document.addEventListener('change', async (e) => {
    const c = e.target.closest && e.target.closest('#tLessons input[data-act]');
    if (!c) return;
    await fetch('/api/admin/client-bot/ratings/' + c.dataset.act + '/active', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H()),
      body: JSON.stringify({ active: c.checked }) }).catch(() => {});
    loadLessons();
  });
  document.addEventListener('click', async (e) => {
    const o = e.target.closest && e.target.closest('#tLessons [data-open]');
    const d = e.target.closest && e.target.closest('#tLessons [data-del]');
    if (o) { document.querySelector('.cb-tabs button[data-v="convos"]').click(); openConvo(parseInt(o.dataset.open)); }
    if (d && confirm('Remove this rating? NovaAI will stop using it.')) {
      await fetch('/api/admin/client-bot/chats/' + d.dataset.del + '/rating', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H()),
        body: JSON.stringify({ rating: null }) }).catch(() => {});
      loadLessons();
    }
  });
  async function loadTraining() {
    loadLessons();
    const j = await fetch('/api/admin/client-bot/rules', { headers: H() }).then(r => r.json()).catch(() => ({}));
    if (!j || !j.ok) return;
    $('tRules').value = j.rules.rules || '';
    $('tKnowledge').value = j.rules.knowledge || '';
    $('tGreeting').value = j.rules.greeting || '';
    $('tContact').value = j.rules.contact || '';
    $('tDesign').value = j.rules.design || '';
    $('tDesignMin').value = j.rules.design_min != null ? j.rules.design_min : '';
    $('tDesignMax').value = j.rules.design_max != null ? j.rules.design_max : '';
    $('tFixed').textContent = j.fixed_rules || '';
    $('tMsg').textContent = j.rules.updated_at ? 'Last saved ' + when(j.rules.updated_at) +
      (j.rules.updated_by && j.rules.updated_by !== 'seed' ? ' by ' + String(j.rules.updated_by).replace(/^(member|user):/, '') : '') : '';
    $('tHist').innerHTML = (j.history || []).length ? '' : '<small style="color:var(--muted)">No earlier versions yet.</small>';
    (j.history || []).forEach(h => {
      const d = document.createElement('div');
      d.innerHTML = '<span>' + esc(when(h.changed_at)) + '<small>' + esc(h.note || '') + '</small></span><button type="button">Load</button>';
      d.querySelector('button').onclick = async () => {
        const v = await fetch('/api/admin/client-bot/rules/history/' + h.id, { headers: H() }).then(r => r.json()).catch(() => ({}));
        if (!v || !v.ok) return;
        $('tRules').value = v.version.rules || ''; $('tKnowledge').value = v.version.knowledge || '';
        $('tGreeting').value = v.version.greeting || ''; $('tContact').value = v.version.contact || '';
        if (v.version.design) $('tDesign').value = v.version.design;
        if (v.version.design_min) $('tDesignMin').value = v.version.design_min;
        if (v.version.design_max) $('tDesignMax').value = v.version.design_max;
        $('tMsg').textContent = 'Loaded the version from ' + when(h.changed_at) + ' — Save to use it.';
      };
      $('tHist').appendChild(d);
    });
  }
  $('tSave').onclick = async () => {
    $('tMsg').textContent = 'Saving…';
    const j = await fetch('/api/admin/client-bot/rules', { method: 'POST', headers: H(), body: JSON.stringify({
      rules: $('tRules').value, knowledge: $('tKnowledge').value, greeting: $('tGreeting').value, contact: $('tContact').value,
      design: $('tDesign').value, design_min: Number($('tDesignMin').value) || null, design_max: Number($('tDesignMax').value) || null
    }) }).then(r => r.json()).catch(() => ({}));
    $('tMsg').textContent = j && j.ok ? 'Saved — the next message uses it.' : ((j && j.error) || 'Could not save.');
    if (j && j.ok) { greeting = j.rules.greeting; loadTraining(); }
  };

  // ---- Setup ----
  function paintOverview() {
    const p = $('cbPublic');
    if (overview && overview.public_on) { p.className = 'cb-pill on'; p.textContent = 'Live on the website'; }
    else if (overview && overview.mode === 'test') { p.className = 'cb-pill off'; p.textContent = 'Testing on the website'; }
    else { p.className = 'cb-pill off'; p.textContent = 'Admins only'; }
  }
  function paintSetup() {
    const o = overview || {};
    const chk = (ok, t) => '<div class="cb-check"><i class="' + (ok ? 'y' : 'n') + '">' + (ok ? '✓' : '•') + '</i>' + t + '</div>';
    const sw = o.switch || 'test';
    $('setupBox').innerHTML =
      '<h2 style="margin-top:0">Chat mode</h2>' +
      '<div class="cb-mode">' +
        '<button type="button" data-mode="test" class="' + (sw === 'test' ? 'on' : '') + '"><b>Test</b><small>Only browsers that opened axiomprint.com with <code>?nova=test</code></small></button>' +
        '<button type="button" data-mode="live" class="' + (sw === 'live' ? 'on live' : '') + '"><b>Live</b><small>Every visitor on axiomprint.com sees Nova</small></button>' +
      '</div>' +
      '<p class="cb-mode-now">' + (o.mode === 'open' ? '● Live — customers can use Nova now.' : o.mode === 'test' ? '● Test — hidden from customers.' :
        '● Off — ' + (o.test_key ? '' : 'test mode needs <code>CLIENT_BOT_TEST_KEY</code> in .env. ') + 'Admins only.') +
        ' Changes apply within a minute; the website snippet stays the same.</p>' +
      '<div class="cb-mode-err" id="modeErr"></div>' +
      '<h2>Status</h2>' +
      chk(true, 'Separate bot, rules, conversations and sign-in from the staff ChatBot.') +
      chk(true, 'Website sign-in: the customer\'s axiomprint.com login (<code>tokenKey: \'axiom-print-app\'</code>), checked with <code>customers/me</code>.') +
      chk(true, 'Add to Cart puts the item in the customer\'s real website cart (signed-in customers).') +
      '<p style="color:var(--muted)">Model: ' + esc(o.model || '') + ' · Conversations so far: ' + ((o.counts && o.counts.chats) || 0) + '</p>' +
      '<h2>Past-due escalations</h2>' +
      '<p>When a customer asks about an order that is past its due date, NovaAI tells them it is being escalated and emails the job to <b>' +
        esc(o.escalate_to || '') + '</b> (once a day per job). Emails are sent as order@axiomprint.com through Google — this needs the ' +
        '<code>gmail.send</code> permission (docs/CLIENT_BOT.md).</p>' +
      '<p><button type="button" class="cb-btn" id="escTest">Send test email</button> <span id="escMsg" style="font-size:12.5px"></span></p>' +
      '<h2>Website snippet</h2>' +
      '<pre>&lt;script&gt;\n  window.NovaClientChat = Object.assign(window.NovaClientChat || {}, {\n    testKey: \'…your CLIENT_BOT_TEST_KEY…\',\n    tokenKey: \'axiom-print-app\'\n  });\n&lt;/script&gt;\n&lt;script src="https://nova.axiomprint.com/client-embed.js" defer&gt;&lt;/script&gt;</pre>' +
      '<p>The full write-up is in <code>docs/CLIENT_BOT.md</code>.</p>';
    const et = $('escTest');
    if (et) et.onclick = async () => {
      et.disabled = true; $('escMsg').textContent = 'Sending…'; $('escMsg').style.color = '';
      const j = await fetch('/api/admin/client-bot/escalation-test', { method: 'POST', headers: H() }).then(r => r.json()).catch(() => ({}));
      et.disabled = false;
      $('escMsg').textContent = j && j.ok ? 'Sent to ' + j.to + ' — check the inbox.' : 'Not sent: ' + ((j && j.error) || 'no answer');
      $('escMsg').style.color = j && j.ok ? '#15803d' : '#b91c1c';
    };
    $('setupBox').querySelectorAll('[data-mode]').forEach(btn => {
      btn.onclick = async () => {
        const m = btn.getAttribute('data-mode');
        if (m === sw) return;
        if (m === 'live' && !confirm('Go live? Every visitor on axiomprint.com will see Nova.')) return;
        const j = await fetch('/api/admin/client-bot/mode', { method: 'POST', headers: H(), body: JSON.stringify({ mode: m }) })
          .then(r => r.json()).catch(() => ({}));
        if (!j.ok) { $('modeErr').textContent = j.error || 'Could not change the mode.'; return; }
        overview = await fetch('/api/admin/client-bot/overview', { headers: H() }).then(r => r.json()).catch(() => overview);
        paintOverview(); paintSetup();
      };
    });
  }
})();
