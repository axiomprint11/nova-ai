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
  // What the attach button offers (the server checks every file again).
  const ACCEPT = 'image/*,.jpg,.jpeg,.png,.gif,.webp,.tif,.tiff,.pdf,.ai,.eps,.psd,.psb,.xlsx,.xlsm,.xls,.csv,.tsv,.txt,.md,.markdown,' +
    'application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/markdown,text/plain';
  const MAX_FILES = 5, MAX_BYTES = 25 * 1024 * 1024;
  const fileIcon = (k) => ({ pdf: 'PDF', ai: 'AI', eps: 'EPS', psd: 'PSD', sheet: 'XLS', text: 'TXT', image: 'IMG' })[k] || 'FILE';
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
  // How each option was chosen — so the customer can see what they asked for,
  // what is the website default, and what they should look at before ordering.
  const TAGS = {
    specified:    ['Specified', 'cc-t-spec', 'You chose this'],
    'default':    ['Default', 'cc-t-def', 'The website default \u2014 change it with Edit'],
    questionable: ['Questionable', 'cc-t-q', 'Left on the default, but it changes the price \u2014 please check it']
  };
  function tag(t) {
    const d = TAGS[t];
    return d ? '<span class="cc-tag ' + d[1] + '" title="' + esc(d[2]) + '">' + d[0] + '</span>' : '';
  }
  // `ref` (inside the chat) adds the Edit button; the admin transcript has none.
  function quote(c, ref) {
    const rows = rowsOf(c);
    const ready = rows.map(r => r.ready).filter(Boolean);
    const sameReady = ready.length && ready.every(x => x === ready[0]) ? ready[0] : null;
    const canEdit = ref != null && c.edit && c.product_id;
    const unsure = (c.specs || []).some(s => s.tag === 'questionable') || c.qty_unsure;
    return '<div class="cc-price' + (unsure ? ' cc-unsure' : '') + '" data-key="' + esc(c.key || '') + '"' + (ref != null ? ' data-ref="' + ref + '"' : '') + '>' +
      '<div class="cc-price-hd">' +
        (c.image ? '<img src="' + esc(c.image) + '" alt="" onerror="this.remove()">' : '') +
        '<div><b>' + esc(c.product) + '</b>' + (sameReady ? '<small>Ready ' + esc(sameReady) + '</small>' : '') + '</div>' +
        (canEdit ? '<button type="button" class="cc-edit-btn" title="Change options or quantities">\u270e Edit</button>' : '') +
      '</div>' +
      '<table class="cc-specs">' + (c.specs || []).filter(s => !/^quantity$/i.test(s.field)).slice(0, 16).map(s =>
        '<tr class="' + (s.tag === 'questionable' ? 'cc-q' : '') + '"><td>' + esc(s.field) + '</td><td>' + esc(s.value) + tag(s.tag) + '</td></tr>').join('') + '</table>' +
      (unsure ? '<div class="cc-unsure-note">Please check the options marked <b>Questionable</b> \u2014 they change the price.' +
        (canEdit ? ' Tap <b>Edit</b> to change them.' : '') + '</div>' : '') +
      '<table class="cc-ladder"><thead><tr><th>Qty' + (c.qty_unsure ? tag('questionable') : '') + '</th><th>Price</th><th></th></tr></thead><tbody>' +
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
    // from 800px wide); narrower, quotes stay in the conversation.
    root.innerHTML =
      '<div class="cc-main">' +
      '<div class="cc-msgs"><div class="cc-inner"></div></div>' +
      '<div class="cc-composer">' +
        '<div class="cc-sugg"></div>' +
        '<div class="cc-files" style="display:none"></div>' +
        '<div class="cc-shell">' +
          '<button type="button" class="cc-attach" title="Attach files \u2014 images, screenshots, PDF, AI, PSD, Excel, CSV, MD" aria-label="Attach files">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg></button>' +
          '<input type="file" class="cc-file-in" multiple hidden accept="' + ACCEPT + '">' +
          '<textarea rows="1" placeholder="Ask about products, prices or your order…"></textarea>' +
          '<button type="button" class="cc-send" title="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
          'stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button></div>' +
        '<div class="cc-hint">' + esc(opts.hint || 'Nova can make mistakes. Prices are confirmed at checkout.') + '</div>' +
      '</div>' +
      '<div class="cc-drop">Drop files to attach</div>' +
      '</div>' +
      '<aside class="cc-pane"><div class="cc-pane-hd">Your quote</div>' +
        '<div class="cc-pane-body"><div class="cc-pane-empty">Prices you ask about appear here, with Add to Cart for each quantity.</div></div></aside>';
    const paneBody = root.querySelector('.cc-pane-body');
    const wide = () => root.classList.contains('cc-wide');
    const fit = () => root.classList.toggle('cc-wide', root.clientWidth >= 800);
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(root); else window.addEventListener('resize', fit);

    // Quotes for the same product and options join into one card; a quantity
    // asked for again replaces its row.
    let groups = [];
    function remember(c) {
      const key = c.key || (c.product_id + '|' + JSON.stringify(c.specs || []));
      let g = groups.find(x => x.key === key);
      if (!g) { g = Object.assign({}, c, { key: key, rows: [] }); groups.unshift(g); }
      else { groups = [g].concat(groups.filter(x => x !== g)); g.specs = c.specs; g.edit = c.edit; g.qty_unsure = c.qty_unsure; }
      rowsOf(c).forEach(r => {
        const i = g.rows.findIndex(x => Number(x.quantity) === Number(r.quantity));
        if (i > -1) g.rows[i] = r; else g.rows.push(r);
      });
      g.rows.sort((a, b) => Number(a.quantity) - Number(b.quantity));
      return g;
    }
    // Cards on screen, by number, so Edit knows which quote it is changing.
    const reg = new Map();
    let regN = 0, paneRefs = [];
    const R = (c) => { reg.set(++regN, c); return regN; };
    function paintPane() {
      paneRefs.forEach(n => reg.delete(n));            // the pane is redrawn whole each time
      paneRefs = [];
      paneBody.innerHTML = groups.length ? groups.map(g => { const n = R(g); paneRefs.push(n); return quote(g, n); }).join('')
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
      if (role === 'user') { if (html) { const t = document.createElement('div'); t.textContent = html; b.appendChild(t); } }
      else b.innerHTML = html;
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
      if ((!text && !pending.length) || busy) return;
      busy = true; send.disabled = true; sugg.style.display = 'none';
      // Files still uploading finish first; ones that failed stay behind with their error.
      if (pending.some(f => f.state === 'up')) {
        send.classList.add('wait');
        await Promise.all(pending.map(f => f.job).filter(Boolean));
        send.classList.remove('wait');
      }
      const sending = pending.filter(f => f.state === 'ok');
      if (!text && !sending.length) { busy = false; send.disabled = false; return; }
      pending = pending.filter(f => f.state === 'err');
      paintFiles();
      ta.value = ''; ta.style.height = '';
      const ub = add('user', text);
      if (sending.length) {
        ub.insertAdjacentHTML(text ? 'afterbegin' : 'beforeend', '<div class="cc-sent-files">' + sending.map(f =>
          f.thumb ? '<img src="' + f.thumb + '" alt="' + esc(f.name) + '" title="' + esc(f.name) + '">'
                  : '<span class="cc-sent-file"><i>' + fileIcon(f.kind) + '</i>' + esc(f.name) + '</span>').join('') + '</div>');
      }
      const b = add('ai', '<div class="typing-dots"><span></span><span></span><span></span></div>');
      try {
        const r = await fetch('/api/client-bot/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (opts.getToken ? opts.getToken() : '') },
          body: JSON.stringify(Object.assign({ chat_id: chatId, message: text, files: sending.map(f => f.id) }, opts.extraBody ? opts.extraBody() : {}))
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
            b.innerHTML = md(j.reply) + cardsNow.map(c => c.type === 'price' ? quote(c, R(c)) : card(c)).join('');
            if (merged.length) paintPane();
          }
          if (opts.onAnswer) opts.onAnswer(j, b);
        }
      } catch (e) { b.innerHTML = '<p class="cc-err">Could not reach Nova. Please try again.</p>'; }
      busy = false; send.disabled = false;
      box.scrollTop = box.scrollHeight;
      ta.focus();
    }
    // ---- attachments: the clip button, paste (screenshots) and drag & drop ----
    // Each file uploads as soon as it is added; Send waits for any still going.
    let pending = [];
    const filesBar = root.querySelector('.cc-files');
    const fileIn = root.querySelector('.cc-file-in');
    function paintFiles() {
      filesBar.style.display = pending.length ? '' : 'none';
      filesBar.innerHTML = pending.map((f, i) =>
        '<span class="cc-file' + (f.state === 'err' ? ' err' : f.state === 'up' ? ' up' : '') + '" title="' + esc(f.info || f.error || f.name) + '">' +
          (f.thumb ? '<img src="' + f.thumb + '" alt="">' : '<i>' + fileIcon(f.kind) + '</i>') +
          '<span class="cc-file-n">' + esc(f.name) + '<small>' + esc(f.state === 'up' ? 'Uploading…' : f.state === 'err' ? f.error : (f.info || '').replace(/^[^—]*—\s*/, '')) + '</small></span>' +
          '<button type="button" data-rm="' + i + '" title="Remove" aria-label="Remove">✕</button></span>').join('');
    }
    filesBar.addEventListener('click', (e) => {
      const x = e.target.closest('[data-rm]');
      if (!x) return;
      pending.splice(Number(x.getAttribute('data-rm')), 1);
      paintFiles();
    });
    function addFiles(list) {
      Array.from(list || []).forEach(file => {
        if (pending.length >= MAX_FILES) return;
        let name = file.name || 'file';
        // A pasted screenshot arrives as "image.png".
        if (/^image\.(png|jpe?g|gif|webp)$/i.test(name) || !file.name) {
          const d = new Date();
          name = 'screenshot-' + d.toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.' + ((file.type.split('/')[1] || 'png').replace('jpeg', 'jpg'));
        }
        // Only pictures the browser can draw get a thumbnail (not PSD / TIFF).
        const drawable = /^image\/(png|jpe?g|gif|webp)$/.test(file.type);
        const f = { name: name, kind: drawable ? 'image' : (name.split('.').pop() || '').toLowerCase(), state: 'up' };
        if (/^(xlsx|xlsm|xls)$/.test(f.kind)) f.kind = 'sheet';
        if (/^(csv|tsv|txt|md|markdown)$/.test(f.kind)) f.kind = 'text';
        if (drawable && window.URL && file.size < MAX_BYTES) { try { f.thumb = URL.createObjectURL(file); } catch (e) {} }
        if (file.size > MAX_BYTES) { f.state = 'err'; f.error = 'Over 25 MB'; }
        pending.push(f);
        if (f.state === 'up') f.job = upload(file, f);
      });
      paintFiles();                                    // more than five: the rest are left out
    }
    async function upload(file, f) {
      try {
        const r = await fetch('/api/client-bot/upload?name=' + encodeURIComponent(f.name) +
          (opts.extraBody && opts.extraBody().as_customer_id ? '&as_customer_id=' + encodeURIComponent(opts.extraBody().as_customer_id) : ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Authorization': 'Bearer ' + (opts.getToken ? opts.getToken() : '') },
          body: file
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok) { f.state = 'ok'; f.id = j.file.id; f.kind = j.file.kind; f.info = j.file.info; }
        else { f.state = 'err'; f.error = j.error || 'Could not upload'; }
      } catch (e) { f.state = 'err'; f.error = 'Could not upload'; }
      f.job = null;
      paintFiles();
    }
    root.querySelector('.cc-attach').onclick = () => fileIn.click();
    fileIn.onchange = () => { addFiles(fileIn.files); fileIn.value = ''; };
    ta.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const got = [];
      for (let i = 0; i < items.length; i++) if (items[i].kind === 'file') { const f = items[i].getAsFile(); if (f) got.push(f); }
      if (got.length) { e.preventDefault(); addFiles(got); }
    });
    let dragDepth = 0;
    const main = root.querySelector('.cc-main');
    main.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') > -1) { e.preventDefault(); dragDepth++; main.classList.add('cc-dragging'); } });
    main.addEventListener('dragover', (e) => { if (main.classList.contains('cc-dragging')) e.preventDefault(); });
    main.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; main.classList.remove('cc-dragging'); } });
    main.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault(); dragDepth = 0; main.classList.remove('cc-dragging');
      addFiles(e.dataTransfer.files);
    });

    // ---- Edit on a quote card ----
    // The options turn into dropdowns and the quantities into a field; Update
    // prices it on the server (public options only) and the card is replaced.
    function editForm(c) {
      const e = c.edit || {};
      const byField = {};
      (c.specs || []).forEach(s => { byField[s.field] = s; });
      const sizeF = (e.fields || []).find(f => f.size);
      const showWH = e.custom_size && (e.width || (sizeF && /custom/i.test(sizeF.value || '')));
      return '<div class="cc-edit">' +
        (e.fields || []).map(f => {
          const sp = byField[f.field] || {};
          return '<label class="' + (sp.tag === 'questionable' ? 'cc-q' : '') + '"><span>' + esc(f.field) + tag(sp.tag) + '</span>' +
            '<select data-f="' + esc(f.field) + '" data-was="' + esc(f.value || '') + '" data-tag="' + esc(sp.tag || '') + '"' + (f.size ? ' data-size="1"' : '') + '>' +
            f.choices.map(ch => '<option' + (ch === f.value ? ' selected' : '') + '>' + esc(ch) + '</option>').join('') + '</select></label>';
        }).join('') +
        (e.custom_size ? '<div class="cc-wh"' + (showWH ? '' : ' style="display:none"') + '><span>Size (inches)</span>' +
          '<input type="number" inputmode="decimal" step="any" min="0" class="cc-w" placeholder="W" value="' + esc(e.width || '') + '"> × ' +
          '<input type="number" inputmode="decimal" step="any" min="0" class="cc-h" placeholder="H" value="' + esc(e.height || '') + '"></div>' : '') +
        '<label class="' + (c.qty_unsure ? 'cc-q' : '') + '"><span>Quantities' + (c.qty_unsure ? tag('questionable') : '') + '</span>' +
          '<input type="text" inputmode="numeric" class="cc-eq" value="' + esc(rowsOf(c).map(r => r.quantity).join(', ')) + '" placeholder="e.g. 250, 500, 1000"></label>' +
        '<div class="cc-edit-err"></div>' +
        '<div class="cc-edit-btns"><button type="button" class="cc-upd">Update price</button><button type="button" class="cc-cancel">Cancel</button></div>' +
      '</div>';
    }
    root.addEventListener('change', (e) => {
      const sel = e.target.closest && e.target.closest('.cc-edit select[data-size]');
      if (!sel) return;
      const wh = sel.closest('.cc-edit').querySelector('.cc-wh');
      if (wh) wh.style.display = /custom/i.test(sel.value) ? '' : 'none';
    });
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('.cc-edit-btn, .cc-cancel, .cc-upd');
      if (!btn) return;
      const el = btn.closest('.cc-price');
      const c = reg.get(Number(el && el.getAttribute('data-ref')));
      if (!c) return;
      if (btn.classList.contains('cc-edit-btn')) {
        if (el.querySelector('.cc-edit')) return;
        el.classList.add('editing');
        el.querySelector('.cc-specs').insertAdjacentHTML('afterend', editForm(c));
        return;
      }
      if (btn.classList.contains('cc-cancel')) { el.classList.remove('editing'); const f = el.querySelector('.cc-edit'); if (f) f.remove(); return; }
      // Update: send what the customer chose — anything they changed, anything they
      // had specified, and anything that was questionable (they have now looked at it).
      const form = el.querySelector('.cc-edit');
      const options = {};
      form.querySelectorAll('select[data-f]').forEach(s => {
        if (s.value !== s.getAttribute('data-was') || /^(specified|questionable)$/.test(s.getAttribute('data-tag'))) options[s.getAttribute('data-f')] = s.value;
      });
      const qtys = form.querySelector('.cc-eq').value.split(/[\s,;]+/).map(x => parseInt(x.replace(/[^0-9]/g, ''))).filter(n => n > 0)
        .filter((n, i, a) => a.indexOf(n) === i).slice(0, 6);
      const err = form.querySelector('.cc-edit-err');
      if (!qtys.length) { err.textContent = 'Enter at least one quantity.'; return; }
      const wh = form.querySelector('.cc-wh');
      const body = { chat_id: chatId, product_id: c.product_id, options: options, quantities: qtys };
      if (wh && wh.style.display !== 'none') {
        body.width = parseFloat(form.querySelector('.cc-w').value) || undefined;
        body.height = parseFloat(form.querySelector('.cc-h').value) || undefined;
      }
      btn.disabled = true; btn.textContent = 'Pricing…'; err.textContent = '';
      let j = {};
      try {
        const r = await fetch('/api/client-bot/reprice', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (opts.getToken ? opts.getToken() : '') },
          body: JSON.stringify(Object.assign(body, opts.extraBody ? opts.extraBody() : {})) });
        j = await r.json().catch(() => ({}));
      } catch (x) { j = { error: 'Could not reach Nova.' }; }
      if (!j.ok) { btn.disabled = false; btn.textContent = 'Update price'; err.textContent = j.error || 'That could not be priced.'; return; }
      // The new quote replaces the old one (rows included: removed quantities go).
      groups = groups.filter(g => g.key !== c.key);
      remember(j.card);
      if (el.closest('.cc-pane')) paintPane();
      else {
        el.outerHTML = quote(j.card, R(j.card));
        if (wide()) paintPane();
      }
    });

    send.onclick = () => ask(ta.value);
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(ta.value); } };
    ta.oninput = () => { ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
    greet(opts.greeting);
    return {
      reset: (g) => { chatId = null; groups = []; pending = []; paintFiles(); paintPane(); greet(g || opts.greeting); },
      setGreeting: (g) => { opts.greeting = g; if (!chatId) greet(g); },
      ask: ask
    };
  }

  global.ClientChat = { mount: mount, md: md, card: card, quote: quote, tag: tag, fileIcon: fileIcon };
})(window);
