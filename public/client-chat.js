/**
 * Nova for clients — the chat itself. Used by the admin console (client-bot.html,
 * as a preview) and by the public page the website will embed (client-chat.html).
 *
 *   ClientChat.mount(el, {
 *     getToken:  () => bearer token (a staff token in preview, a visitor token live),
 *     extraBody: () => ({ as_customer_id }),     // preview only
 *     onAnswer:  (json) => {},                    // preview: show which tools ran
 *     suggestions: [[label, question], …]
 *   })  ->  { reset(), setGreeting(text) }
 *
 * The server keeps the conversation; this only shows it. Nothing here decides
 * what a visitor may see.
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Small, safe markdown: escape first, then bold, links (http/https only), lists, breaks.
  function md(text) {
    const lines = esc(text).split('\n');
    let html = '', inList = false;
    lines.forEach(l => {
      const item = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (item) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(item[1]) + '</li>'; return; }
      if (inList) { html += '</ul>'; inList = false; }
      html += l.trim() ? '<p>' + inline(l) + '</p>' : '';
    });
    if (inList) html += '</ul>';
    return html;
  }
  function inline(t) {
    return t
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => pre + '<a href="' + url +
        '" target="_blank" rel="noopener">' + (/[?&](shareId|config)=/.test(url) ? 'Order now' : 'View product') + '</a>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
  const money = (n) => '$' + Number(n || 0).toFixed(2);

  function card(c) {
    if (c.type === 'products') {
      return '<div class="cc-prods">' + (c.products || []).map(p =>
        '<a class="cc-prod" href="' + esc(p.url || '#') + '" target="_blank" rel="noopener">' +
          (p.image ? '<img src="' + esc(p.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '<span class="cc-ph"></span>') +
          '<span>' + esc(p.name) + '</span></a>').join('') + '</div>';
    }
    if (c.type === 'price') {
      return '<div class="cc-price">' +
        '<div class="cc-price-hd">' +
          (c.image ? '<img src="' + esc(c.image) + '" alt="" onerror="this.remove()">' : '') +
          '<div><b>' + esc(c.product) + '</b><small>Qty ' + Number(c.quantity || 0).toLocaleString() +
            (c.ready ? ' · ' + esc(c.ready) : '') + '</small></div>' +
          '<div class="cc-price-n">' + (c.discount && c.list_price > c.price ? '<s>' + money(c.list_price) + '</s>' : '') +
            money(c.price) + '<small>' + money(c.each) + ' each</small></div>' +
        '</div>' +
        '<table>' + (c.specs || []).slice(0, 12).map(s => '<tr><td>' + esc(s.field) + '</td><td>' + esc(s.value) + '</td></tr>').join('') + '</table>' +
        (c.order_url ? '<a class="cc-order" href="' + esc(c.order_url) + '" target="_blank" rel="noopener">Order now</a>' : '') +
        '<div class="cc-note">Excludes shipping and tax.</div>' +
      '</div>';
    }
    if (c.type === 'orders') {
      return '<div class="cc-orders">' + (c.orders || []).map(o =>
        '<div class="cc-ord"><div><b>' + esc(o.order) + '</b> ' + esc(o.name || o.product || '') +
          '<small>' + [o.product && o.product !== o.name ? o.product : null, o.quantity ? 'Qty ' + o.quantity : null,
                       o.placed ? 'placed ' + o.placed : null].filter(Boolean).map(esc).join(' · ') + '</small></div>' +
          '<span class="cc-st">' + esc(o.status || '') + '</span></div>').join('') + '</div>';
    }
    return '';
  }

  function mount(root, opts) {
    opts = opts || {};
    let chatId = null, busy = false;
    root.classList.add('cc');
    root.innerHTML =
      '<div class="cc-msgs"><div class="cc-inner"></div></div>' +
      '<div class="cc-composer">' +
        '<div class="cc-sugg"></div>' +
        '<div class="cc-shell"><textarea rows="1" placeholder="Ask about products, prices or your order…"></textarea>' +
          '<button type="button" class="cc-send" title="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
          'stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button></div>' +
        '<div class="cc-hint">' + esc(opts.hint || 'Nova can make mistakes. Prices are confirmed at checkout.') + '</div>' +
      '</div>';
    const inner = root.querySelector('.cc-inner');
    const box = root.querySelector('.cc-msgs');
    const ta = root.querySelector('textarea');
    const send = root.querySelector('.cc-send');
    const sugg = root.querySelector('.cc-sugg');

    function add(role, html) {
      const row = document.createElement('div');
      row.className = 'msg-row' + (role === 'user' ? ' user' : '');
      row.innerHTML = role === 'user'
        ? '<div class="msg-col"><div class="bubble user"></div></div>'
        : '<div class="msg-avatar ai">N</div><div class="msg-col"><div class="msg-meta">Nova</div><div class="bubble ai"></div></div>';
      const b = row.querySelector('.bubble');
      if (role === 'user') b.textContent = html; else b.innerHTML = html;
      inner.appendChild(row);
      box.scrollTop = box.scrollHeight;
      return b;
    }
    function greet(text) {
      inner.innerHTML = '';
      add('ai', md(text || 'Hi! Ask me about our products, prices and options.'));
      sugg.innerHTML = (opts.suggestions || []).map(s =>
        '<button type="button" class="suggestion" data-q="' + esc(s[1]) + '">' + esc(s[0]) + '</button>').join('');
      sugg.querySelectorAll('button').forEach(b => { b.onclick = () => ask(b.getAttribute('data-q')); });
      sugg.style.display = '';
    }
    async function ask(text) {
      text = String(text || '').trim();
      if (!text || busy) return;
      busy = true; send.disabled = true; sugg.style.display = 'none';
      ta.value = ''; ta.style.height = '';
      add('user', text);
      const b = add('ai', '<div class="typing-dots"><span></span><span></span><span></span></div>');
      try {
        const r = await fetch('/api/client-bot/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (opts.getToken ? opts.getToken() : '') },
          body: JSON.stringify(Object.assign({ chat_id: chatId, message: text }, opts.extraBody ? opts.extraBody() : {}))
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) { b.innerHTML = '<p class="cc-err">' + esc(j.error || 'Something went wrong. Please try again.') + '</p>'; }
        else {
          chatId = j.chat_id;
          b.innerHTML = md(j.reply) + (j.cards || []).map(card).join('');
          if (opts.onAnswer) opts.onAnswer(j, b);
        }
      } catch (e) { b.innerHTML = '<p class="cc-err">Could not reach Nova. Please try again.</p>'; }
      busy = false; send.disabled = false;
      box.scrollTop = box.scrollHeight;
      ta.focus();
    }
    send.onclick = () => ask(ta.value);
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(ta.value); } };
    ta.oninput = () => { ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
    greet(opts.greeting);
    return {
      reset: (g) => { chatId = null; greet(g || opts.greeting); },
      setGreeting: (g) => { opts.greeting = g; if (!chatId) greet(g); },
      ask: ask
    };
  }

  global.ClientChat = { mount: mount, md: md, card: card };
})(window);
