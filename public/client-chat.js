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
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function card(c) {
    if (c.type === 'products') {
      // Clicking a product picks it: the chat is told to price that one. The small
      // arrow still opens its page on the website.
      return '<div class="cc-prods">' + (c.products || []).map(p =>
        '<div class="cc-prod" role="button" tabindex="0" data-pick="' + esc(p.id) + '" data-name="' + esc(p.name) + '" title="Price this product">' +
          (p.image ? '<img src="' + esc(p.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '<span class="cc-ph"></span>') +
          '<span>' + esc(p.name) + '</span>' +
          (p.url ? '<a class="cc-prod-link" href="' + esc(p.url) + '" target="_blank" rel="noopener" title="Open the product page">\u2197</a>' : '') +
        '</div>').join('') + '</div>';
    }
    if (c.type === 'price') return quote(c);
    if (c.type === 'templates') {
      return '<div class="cc-tpl">' +
        '<div class="cc-tpl-hd">' + (c.image ? '<img src="' + esc(c.image) + '" alt="" onerror="this.remove()">' : '') +
          '<b>' + esc(c.product) + ' \u2014 template' + ((c.templates || []).length === 1 ? '' : 's') + '</b></div>' +
        (c.templates || []).map(t =>
          '<div class="cc-tpl-row"><div><b>' + esc(t.size || t.option || 'Template') + '</b>' +
            '<small>' + esc([t.size && t.option ? t.option : null, t.applies_when].filter(Boolean).join(' · ')) + '</small>' +
            '<small class="cc-tpl-file">' + esc(t.file_name) + '</small></div>' +
          '<a class="cc-cart" href="' + esc(t.url) + '" target="_blank" rel="noopener">Download PDF</a></div>').join('') +
      '</div>';
    }
    if (c.type === 'estimate') {
      const title = c.kind === 'delivery' ? 'Local delivery estimate' : 'Installation estimate';
      return '<div class="cc-est">' +
        '<div class="cc-est-hd"><div><b>' + title + '</b>' + (c.place ? '<small>' + esc(c.place) + '</small>' : '') + '</div>' +
          '<div class="cc-est-n">' + (c.total == null ? '<span>Needs our team</span>' : money(c.total)) + '</div></div>' +
        (c.lines && c.lines.length ? '<table>' + c.lines.map(l => '<tr><td>' + esc(l.label) + '</td><td>' + money(l.amount) + '</td></tr>').join('') + '</table>' : '') +
        (c.missing && c.missing.length ? '<div class="cc-est-miss">Still needed for a full estimate: ' + esc(c.missing.join(', ')) + '</div>' : '') +
        '<div class="cc-note">' + (c.total == null ? 'This one needs a site review — our team will quote it.'
          : 'Estimate only' + (c.confirm ? ' — our team will confirm it with you.' : ' — final price confirmed by our team.')) + '</div>' +
      '</div>';
    }
    if (c.type === 'orders') {
      return '<div class="cc-orders">' + (c.orders || []).map(o =>
        '<div class="cc-ord">' +
          // Their artwork preview when we have one, otherwise the product photo. Click for full size.
          (o.image && /^https:\/\//.test(o.image)
            ? '<a class="cc-ord-img" href="' + esc(o.image) + '" target="_blank" rel="noopener" title="' +
              (o.image_kind === 'proof' ? 'Your artwork preview' : 'Product photo') + ' — open full size">' +
              '<img src="' + esc(o.image) + '" alt="" loading="lazy" onerror="this.parentNode.remove()">' +
              (o.image_kind === 'proof' ? '' : '<span>Product</span>') + '</a>'
            : '') +
          '<div><b>' + esc(o.order) + '</b> ' + esc(o.name || o.product || '') +
          '<small>' + [o.product && o.product !== o.name ? o.product : null, o.quantity ? 'Qty ' + o.quantity : null,
                       o.placed ? 'placed ' + o.placed : null].filter(Boolean).map(esc).join(' · ') + '</small></div>' +
          '<span class="cc-st">' + esc(o.status || '') + '</span></div>').join('') + '</div>';
    }
    return '';
  }

  // One quote: the options once, then Qty · Price · Add to Cart for each quantity.
  // Older saved cards (one quantity, no rows) are drawn the same way.
  function rowsOf(c) {
    if (Array.isArray(c.rows)) return c.rows;
    return [{ quantity: c.quantity, price: c.price, each: c.each, list_price: c.list_price, discount: c.discount,
              ready: c.ready, cart: c.order_url ? { url: c.order_url } : null }];
  }
  function quote(c) {
    const rows = rowsOf(c);
    const ready = rows.map(r => r.ready).filter(Boolean);
    const sameReady = ready.length && ready.every(x => x === ready[0]) ? ready[0] : null;
    return '<div class="cc-price" data-key="' + esc(c.key || '') + '">' +
      '<div class="cc-price-hd">' +
        (c.image ? '<img src="' + esc(c.image) + '" alt="" onerror="this.remove()">' : '') +
        '<div><b>' + esc(c.product) + '</b>' + (sameReady ? '<small>Ready ' + esc(sameReady) + '</small>' : '') + '</div>' +
      '</div>' +
      '<table class="cc-specs">' + (c.specs || []).filter(s => !/^quantity$/i.test(s.field)).slice(0, 14).map(s =>
        '<tr><td>' + esc(s.field) + '</td><td>' + esc(s.value) + '</td></tr>').join('') + '</table>' +
      '<table class="cc-ladder"><thead><tr><th>Qty</th><th>Price</th><th></th></tr></thead><tbody>' +
      rows.map(r => {
        const item = { product_id: c.product_id || null, product: c.product, quantity: r.quantity, price: r.price,
          url: r.cart && r.cart.url, share_id: r.cart && r.cart.share_id, config: r.cart && r.cart.config };
        return '<tr><td>' + Number(r.quantity || 0).toLocaleString() + '</td>' +
          '<td>' + (r.discount && r.list_price > r.price ? '<s>' + money(r.list_price) + '</s> ' : '') + '<b>' + money(r.price) + '</b>' +
            '<small>' + money(r.each) + ' each' + (!sameReady && r.ready ? ' · ready ' + esc(r.ready) : '') + '</small></td>' +
          '<td>' + (item.url ? '<a class="cc-cart" href="' + esc(item.url) + '" target="_blank" rel="noopener" data-item="' +
            esc(JSON.stringify(item)) + '">Add to Cart</a>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="cc-note">Excludes shipping and tax.</div>' +
    '</div>';
  }

  function mount(root, opts) {
    opts = opts || {};
    let chatId = null, busy = false;
    root.classList.add('cc');
    // Chat on the left, quotes on the right when there is room (the pane shows
    // from 860px wide); narrower, quotes stay in the conversation.
    root.innerHTML =
      '<div class="cc-main">' +
      '<div class="cc-msgs"><div class="cc-inner"></div></div>' +
      '<div class="cc-composer">' +
        '<div class="cc-sugg"></div>' +
        '<div class="cc-shell"><textarea rows="1" placeholder="Ask about products, prices or your order…"></textarea>' +
          '<button type="button" class="cc-send" title="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
          'stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button></div>' +
        '<div class="cc-hint">' + esc(opts.hint || 'Nova can make mistakes. Prices are confirmed at checkout.') + '</div>' +
      '</div>' +
      '</div>' +
      '<aside class="cc-pane"><div class="cc-pane-hd">Your quote</div>' +
        '<div class="cc-pane-body"><div class="cc-pane-empty">Prices you ask about appear here, with Add to Cart for each quantity.</div></div></aside>';
    const paneBody = root.querySelector('.cc-pane-body');
    const wide = () => root.classList.contains('cc-wide');
    const fit = () => root.classList.toggle('cc-wide', root.clientWidth >= 860);
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(root); else window.addEventListener('resize', fit);

    // Quotes for the same product and options join into one card; a quantity
    // asked for again replaces its row.
    let groups = [];
    function remember(c) {
      const key = c.key || (c.product_id + '|' + JSON.stringify(c.specs || []));
      let g = groups.find(x => x.key === key);
      if (!g) { g = Object.assign({}, c, { key: key, rows: [] }); groups.unshift(g); }
      else { groups = [g].concat(groups.filter(x => x !== g)); g.specs = c.specs; }
      rowsOf(c).forEach(r => {
        const i = g.rows.findIndex(x => Number(x.quantity) === Number(r.quantity));
        if (i > -1) g.rows[i] = r; else g.rows.push(r);
      });
      g.rows.sort((a, b) => Number(a.quantity) - Number(b.quantity));
      return g;
    }
    function paintPane() {
      paneBody.innerHTML = groups.length ? groups.map(quote).join('')
        : '<div class="cc-pane-empty">Prices you ask about appear here, with Add to Cart for each quantity.</div>';
    }

    // Add to Cart: the page that hosts the chat decides (on the website it puts
    // the item in the real cart). Without a host that can, the link opens the
    // product with everything already selected.
    // Picking a product from a list = "price this one".
    function pick(el) {
      if (!el || busy) return;
      const list = el.closest('.cc-prods');
      if (list) list.querySelectorAll('.cc-prod').forEach(x => {
        x.classList.toggle('chosen', x === el); x.classList.toggle('dim', x !== el);
      });
      ask('I\u2019d like to price ' + el.getAttribute('data-name') + ' (product #' + el.getAttribute('data-pick') + ').');
    }
    root.addEventListener('keydown', (e) => {
      const el = e.target.closest && e.target.closest('.cc-prod[data-pick]');
      if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(el); }
    });
    root.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.cc-prod-link')) return;     // the arrow opens the page
      const el = e.target.closest && e.target.closest('.cc-prod[data-pick]');
      if (el) pick(el);
    });

    root.addEventListener('click', async (e) => {
      const a = e.target.closest && e.target.closest('a.cc-cart');
      if (!a || !opts.addToCart) return;
      e.preventDefault();
      let item = {};
      try { item = JSON.parse(a.getAttribute('data-item') || '{}'); } catch (x) {}
      const label = a.textContent;
      a.classList.add('busy'); a.textContent = 'Adding…';
      let ok = false;
      try { ok = await opts.addToCart(item); } catch (x) { ok = false; }
      a.classList.remove('busy');
      if (ok) { a.classList.add('done'); a.textContent = '✓ In cart'; }
      else { a.textContent = label; window.open(item.url || a.href, '_blank', 'noopener'); }
    });
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
          const cardsNow = j.cards || [];
          const prices = cardsNow.filter(c => c.type === 'price');
          const merged = prices.map(remember);
          if (wide() && merged.length) {
            paintPane();
            b.innerHTML = md(j.reply) + cardsNow.filter(c => c.type !== 'price').map(card).join('') +
              merged.filter((g, i, a) => a.indexOf(g) === i).map(g => '<div class="cc-moved"><b>' + esc(g.product) + '</b> — ' +
                g.rows.length + ' quantit' + (g.rows.length === 1 ? 'y' : 'ies') + ' on the quote at the right.</div>').join('');
          } else {
            b.innerHTML = md(j.reply) + cardsNow.map(c => c.type === 'price' ? quote(c) : card(c)).join('');
            if (merged.length) paintPane();
          }
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
      reset: (g) => { chatId = null; groups = []; paintPane(); greet(g || opts.greeting); },
      setGreeting: (g) => { opts.greeting = g; if (!chatId) greet(g); },
      ask: ask
    };
  }

  global.ClientChat = { mount: mount, md: md, card: card, quote: quote };
})(window);
