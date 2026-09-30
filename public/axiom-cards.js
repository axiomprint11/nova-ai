/**
 * axiom-cards.js — the rich cards shown in Nova chat answers.
 *
 * ONE implementation, loaded by both the ChatBot page and the embedded CRM
 * widget. They used to carry separate copies, which is why the widget kept
 * falling behind: every new feature had to be written twice and only ever was
 * once. Anything visual that appears in a chat answer belongs here.
 *
 * Setup (each page does this once):
 *   AxiomCards.init({
 *     getToken: () => token,     // current auth token
 *     ask:      (text) => ask(text),   // send a message as the user
 *     scroll:   () => scrollDown()     // optional
 *   });
 *
 * Then: AxiomCards.priceCard(data), AxiomCards.jobCard(data), etc.
 * Styling comes from axiom-shared.css, so both surfaces look identical.
 */
(function (global) {
  'use strict';

  var CTX = {
    getToken: function () { return null; },
    ask: function () {},
    scroll: function () {},
    // Set the conversation's client without sending a message.
    pinClient: function () {},
    // Park a priced item in the conversation's cart. Returns true on success.
    addToCart: function () { return Promise.resolve(false); },
    // Called after a successful add, so the page can refresh its own UI.
    onCartAdd: null,
    // When set, the card offers "Save" (keep this quote for the reply) in place
    // of "Add to cart": onSave(cardEl, state). saveLabel(cardEl) may relabel it.
    onSave: null,
    saveLabel: null,
    // Called after the card re-prices (edit, clarify, client connected), so the
    // page can keep its copies of the figure in step: onChange(cardEl, state).
    onChange: null
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var token;                      // kept in sync below for the extracted code
  function ask(t) { CTX.ask(t); }
  function scrollDown() { CTX.scroll(); }

// Larger preview on hover. Rendered at body level and positioned with fixed
// coordinates, because the chat scroller would otherwise clip an absolute popup.
function attachPreview(el, src, name) {
  let box = null;
  const show = () => {
    if (box) return;
    box = document.createElement('div');
    box.className = 'pc-preview';
    box.innerHTML = '<img src="' + esc(src) + '" alt=""><span>' + esc(name || '') + '</span>';
    document.body.appendChild(box);
    place();
  };
  const place = () => {
    if (!box) return;
    const r = el.getBoundingClientRect();
    const w = 240, h = 265;
    let left = r.right + 12;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 12);
    let top = r.top + r.height / 2 - h / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  };
  const hide = () => { if (box) { box.remove(); box = null; } };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', place);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('click', hide);
  window.addEventListener('scroll', hide, true);
}

  function showVTip(btn, detail) {
    hideVTip();
    vTip = document.createElement('div');
    vTip.className = 'pq-vtip';
    const total = detail.reduce((a, b) => a + (Number(b.quantity) || 0), 0);
    vTip.innerHTML = '<div class="pq-vtip-hd">' + detail.length + ' versions</div>' +
      detail.map(v =>
        '<div class="pq-vtip-r"><span>Version ' + v.n + '</span>' +
        '<strong>' + Number(v.quantity || 0).toLocaleString() + '</strong>' +
        '<em>' + esc(v.name || '—') + '</em></div>').join('') +
      '<div class="pq-vtip-ft">' + total.toLocaleString() + ' total</div>';
    document.body.appendChild(vTip);
    const r = btn.getBoundingClientRect();
    const w = 240, h = vTip.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 10);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    vTip.style.left = Math.max(8, left) + 'px';
    vTip.style.top = top + 'px';
  }

  function hideVTip() { if (vTip) { vTip.remove(); vTip = null; } }

// Compact product chips with a 60x60 thumbnail. Products are visual — seeing the
// item beats reading its name.
function buildProductCards(products, opts) {
  // A chip shown on the way to a price is a status line, not a button.
  const calculating = !!(opts && opts.calculating);
  const wrap = document.createElement('div');
  wrap.className = 'pc-row';
  products.forEach(p => {
    // Clicking a product opens the CALCULATOR here, not the public website —
    // staff want to price it, not read the marketing page. The website is still
    // one click away via the small link.
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'pc-card';
    a.title = 'Open the calculator for ' + p.name;
    a.innerHTML =
      (p.image
        ? '<img class="pc-thumb" src="' + esc(p.image) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'pc-noimg\');this.remove()">'
        : '<span class="pc-thumb pc-ph"></span>') +
      '<span class="pc-meta"><span class="pc-name">' + esc(p.name) + '</span>' +
      '<span class="pc-id">#' + p.id + '</span></span>' +
      '<span class="pc-open' + (calculating ? ' working' : '') + '">' +
        (calculating ? 'Calculating\u2026' : 'Price it') + '</span>';
    if (calculating) {
      // Already on its way to a price — this is a status line, not a button.
      a.disabled = true;
      a.classList.add('pc-chosen');
    } else {
      // Route through the conversation, not straight to the pricing endpoint: the
      // model is the only thing that knows the size, quantity, versions and options
      // already stated in this chat. Calling the endpoint directly loses all of it
      // and prices the product on bare defaults.
      a.onclick = () => {
        a.classList.add('pc-busy');
        ask('Price ' + p.name + ' (#' + p.id + ') using every spec I have already given you in this ' +
            'conversation — size, quantity, versions, material, finishes. Only fall back to defaults for ' +
            'things I never mentioned.');
      };
    }
    if (p.image) attachPreview(a, p.image, p.name);

    // Card and its website link share a row. They used to be siblings of the
    // column container, so the arrow dropped onto its own line.
    const line = document.createElement('div');
    line.className = 'pc-line';
    line.appendChild(a);
    if (p.url) {
      const link = document.createElement('a');
      link.className = 'pc-web';
      link.href = p.url; link.target = '_blank'; link.rel = 'noopener';
      link.title = 'Open the product page on axiomprint.com';
      link.textContent = '↗';
      line.appendChild(link);
    }
    wrap.appendChild(line);
  });
  return wrap;
}

function buildPicks(products, opts) {
  opts = opts || {};
  // A refined second search supersedes the first — drop the earlier list so the
  // answer shows one set of matches, not two that disagree.
  if (opts.replace) {
    document.querySelectorAll('.cb-picks').forEach(n => n.remove());
  }
  // "info" -> picking answers the question they asked.
  // "price" -> picking opens the calculator.
  const forPricing = opts.intent === 'price';
  const askedAbout = String(opts.ask_about || '').trim();
  const SHOW = 5;
  const wrap = document.createElement('div');
  wrap.className = 'cb-picks';
  if (products.length > 1) {
    const hd = document.createElement('div');
    hd.className = 'cb-picks-hd';
    hd.textContent = 'Best match';
    wrap.appendChild(hd);
  }
  products.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cb-pick' + (i >= SHOW ? ' cb-pick-extra' : '');
    const pct = (p.match != null)
      ? '<span class="cb-pick-pct ' + (p.match >= 75 ? 'hi' : p.match >= 60 ? 'mid' : 'lo') + '">' + p.match + '%</span>'
      : '';
    b.innerHTML = (p.image
      ? '<img class="cb-pick-img" src="' + esc(p.image) + '" alt="" loading="lazy" onerror="this.remove()">'
      : '<span class="cb-pick-img cb-pick-noimg"></span>') +
      '<span class="cb-pick-body">' + esc(p.name) + ' <span class="cb-pick-id">#' + p.id + '</span>' +
      // "Popular" is a badge, not a sentence — give it its own colour so it
      // reads as a label alongside the factual reasons.
      (p.why
        ? '<span class="cb-pick-why">' +
          esc(p.why).split(' \u00b7 ').map(part =>
            part === 'Popular' ? '<b class="cb-pop">Popular</b>'
              // A missing spec is context, not a headline — keep it quiet.
              : /^no /.test(part) ? '<span class="cb-why-no">' + part + '</span>'
              : part).join(' \u00b7 ') +
          '</span>'
        : '') + '</span>' +
      pct + '<span class="cb-pick-go' + (forPricing ? '' : ' info') + '">' +
      (forPricing ? 'Price it' : 'See details') + '</span>';
    b.onclick = () => {
      wrap.querySelectorAll('.cb-pick').forEach(x => { x.disabled = true; x.classList.remove('chosen'); });
      const more = wrap.querySelector('.cb-more');
      if (more) more.remove();
      b.classList.add('chosen');
      if (forPricing) {
        ask('Price ' + p.name + ' (#' + p.id + ') using every spec I have already given you in this ' +
            'conversation — size, quantity, versions, material, finishes. Only fall back to defaults for ' +
            'things I never mentioned.');
      } else {
        // They asked a question. Answer it for this product — do not price it.
        ask('For ' + p.name + ' (#' + p.id + '): ' +
            (askedAbout ? 'answer my question — ' + askedAbout : 'tell me about this product') +
            '. Just answer, do not price it.');
      }
    };
    wrap.appendChild(b);
  });
  const hidden = products.length - SHOW;
  if (hidden > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'cb-more';
    more.textContent = 'Show ' + hidden + ' more';
    more.onclick = () => {
      wrap.querySelectorAll('.cb-pick-extra').forEach(x => x.classList.remove('cb-pick-extra'));
      more.remove();
    };
    wrap.appendChild(more);
  }
  return wrap;
}

// Identified client — the header for anything client-specific that follows.
function buildClientCard(c) {
  const el = document.createElement('div');
  el.className = 'cl-card';
  const initials = String(c.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const money = (v) => (v == null || isNaN(Number(v))) ? null : '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const bits = [];
  if (c.orders != null) bits.push(c.orders + ' order' + (c.orders === 1 ? '' : 's'));
  if (money(c.lifetime)) bits.push(money(c.lifetime) + ' lifetime');
  if (c.last_order) bits.push('last ' + String(c.last_order).slice(0, 10));
  if (c.manager) bits.push('AM: ' + c.manager);
  el.innerHTML =
    '<div class="cl-av">' + esc(initials) + '</div>' +
    '<div class="cl-body">' +
      '<div class="cl-name">' + esc(c.name || 'Client') +
      (c.company ? ' <span class="cl-co">' + esc(c.company) + '</span>' : '') + '</div>' +
      '<div class="cl-contact">' + esc(c.email || '') + (c.phone ? ' · ' + esc(c.phone) : '') + '</div>' +
      (bits.length ? '<div class="cl-stats">' + esc(bits.join(' · ')) + '</div>' : '') +
    '</div>';
  return el;
}

// Several clients matched — most active first, clickable.
function buildClientPicks(clients, opts) {
  // Colleagues of the sender come first and say so — a same-domain match is a
  // far stronger signal than a shared first name.
  clients = (clients || []).slice().sort((a, b) =>
    (b.same_domain ? 1 : 0) - (a.same_domain ? 1 : 0) || (Number(b.orders) || 0) - (Number(a.orders) || 0));
  // A second client search supersedes the first — one list, not two.
  if (opts && opts.replace) {
    document.querySelectorAll('.cl-picks').forEach(n => n.remove());
  }
  const wrap = document.createElement('div');
  wrap.className = 'cl-picks';
  const hd = document.createElement('div');
  hd.className = 'cl-picks-hd';
  hd.textContent = 'Which client?';
  wrap.appendChild(hd);
  clients.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cl-pick';
    const initials = String(c.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    b.innerHTML =
      '<span class="cl-pick-av">' + esc(initials) + '</span>' +
      '<span class="cl-pick-body"><span class="cl-pick-name">' + esc(c.name || '') +
      (c.company ? ' <span class="cl-co">' + esc(c.company) + '</span>' : '') + '</span>' +
      '<span class="cl-pick-mail">' + esc(c.email || '') +
        (c.same_domain ? ' <span class="cl-same">same company</span>' : '') + '</span></span>' +
      '<span class="cl-pick-orders">' + (c.orders || 0) + '<em>orders</em></span>';
    b.onclick = () => {
      wrap.querySelectorAll('.cl-pick').forEach(x => { x.disabled = true; x.classList.remove('chosen'); });
      b.classList.add('chosen');
      // Pin them to the conversation — do NOT send a message. Choosing who a job
      // is for is not a question that needs answering; it just sets the context
      // so the next thing typed (or clicked) is already attributed.
      const label = c.company ? (c.name + ' (' + c.company + ')') : c.name;
      CTX.pinClient(c.id, label);
      const note = document.createElement('div');
      note.className = 'cl-picked';
      note.textContent = 'Connected to ' + label;
      wrap.appendChild(note);
      // Pinning is silent, but the request that was waiting on the client still
      // has to move. Tell the agent to carry on rather than leaving it parked.
      ask('Connected to ' + label + '. Carry on with what I asked — do not ask who ' +
          'it is for again, and do not repeat the client details.');
    };
    wrap.appendChild(b);
  });
  return wrap;
}

// Real, selectable options for one field — shown as cards with their images so
// a material or size can be judged by eye rather than read from a list.
function buildOptionPicks(d) {
  const wrap = document.createElement('div');
  wrap.className = 'op-wrap';
  const withImg = (d.options || []).some(o => o.image);
  const hd = document.createElement('div');
  hd.className = 'op-hd';
  hd.textContent = d.field || 'Options';
  wrap.appendChild(hd);

  const grid = document.createElement('div');
  grid.className = 'op-grid' + (withImg ? '' : ' op-plain');
  (d.options || []).forEach(o => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-card';
    b.innerHTML =
      (withImg
        ? (o.image
            ? '<span class="op-img"><img src="' + esc(o.image) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'op-noimg\');this.remove()"></span>'
            : '<span class="op-img op-noimg"></span>')
        : '') +
      '<span class="op-name">' + esc(o.title) +
      (o.is_default ? ' <em>default</em>' : '') + '</span>';
    b.onclick = () => {
      grid.querySelectorAll('.op-card').forEach(x => { x.disabled = true; x.classList.remove('chosen'); });
      b.classList.add('chosen');
      ask((d.field || 'Option') + ': ' + o.title);
    };
    grid.appendChild(b);
  });
  wrap.appendChild(grid);
  return wrap;
}

// ===== Product picker (clickable options, top 5 + Load more) =====
// A plain question with clickable answers — so nothing has to be typed.
function buildChoicePicks(d) {
  const wrap = document.createElement('div');
  wrap.className = 'op-wrap';
  const q = document.createElement('div');
  q.className = 'op-q';
  q.textContent = d.question || '';
  wrap.appendChild(q);
  const row = document.createElement('div');
  row.className = 'op-choices';
  (d.choices || []).forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-choice';
    b.textContent = c;
    b.onclick = () => {
      row.querySelectorAll('.op-choice').forEach(x => { x.disabled = true; x.classList.remove('chosen'); });
      b.classList.add('chosen');
      ask(c);
    };
    row.appendChild(b);
  });
  wrap.appendChild(row);
  return wrap;
}

function buildTurnaround(d) {
  const wrap = document.createElement('div');
  wrap.className = 'ta-card';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cell = (t) => {
    const dt = new Date(t.date + 'T12:00:00');
    return '<div class="ta-day ta-' + t.type + '">' +
      '<div class="ta-dow">' + dow[dt.getDay()] + '</div>' +
      '<div class="ta-num">' + dt.getDate() + '</div>' +
      '<div class="ta-lbl">' + esc(t.label) + '</div>' +
    '</div>';
  };
  const verdict = (d.makesIt === true)
    ? '<div class="ta-verdict ok">Makes the ' + esc(d.needByLabel || '') + ' deadline</div>'
    : (d.makesIt === false)
    ? '<div class="ta-verdict bad">Misses the ' + esc(d.needByLabel || '') + ' deadline</div>'
    : '';

  // Deliberately lean: the product name, the ready date and the "production only"
  // caveat are all already on the price card above this. Repeating them turned a
  // schedule into a wall of text.
  wrap.innerHTML =
    '<div class="ta-cut">' +
      'If approved <strong>' + esc(d.approvalLabel || '') + '</strong> ' +
      (d.beforeCutoff ? 'before' : 'after') + ' the 5PM cutoff' +
      (d.beforeCutoff ? '' : ', the clock starts <strong>' + esc(d.startLabel || '') + '</strong>') +
      '.' +
    '</div>' +
    '<div class="ta-strip">' + (d.timeline || []).map(cell).join('') + '</div>' +
    (d.skipped ? '<div class="ta-note">' + d.skipped + ' non-working day' + (d.skipped === 1 ? '' : 's') +
      ' skipped (weekends / holidays)</div>' : '') +
    verdict;
  return wrap;
}

// One job, with its live status and a Reorder shortcut.
function buildJobCard(d) {
  const el = document.createElement('div');
  el.className = 'jb-card jb-' + (d.stage || 'prepress');
  const rows = (d.specs || []).slice(0, 8).map(s =>
    '<tr><td>' + esc(s.field) + '</td><td>' + esc(s.value) + '</td></tr>').join('');
  const meta = [];
  if (d.created) meta.push('Ordered ' + d.created);
  if (d.due) meta.push('Due ' + d.due);
  if (d.express) meta.push('RUSH');
  el.innerHTML =
    '<div class="jb-head">' +
      (d.image ? '<img class="jb-thumb" src="' + esc(d.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
      '<div class="jb-main">' +
        '<div class="jb-top"><span class="jb-e">' + esc(d.e_number || '') + '</span>' +
        '<span class="jb-status">' + esc(d.headline || '') + '</span></div>' +
        '<div class="jb-name">' + esc(d.name || d.product || '') + '</div>' +
        '<div class="jb-meta">' + esc([d.product, d.client, meta.join(' · ')].filter(Boolean).join(' · ')) + '</div>' +
      '</div>' +
      (d.total != null ? '<div class="jb-total">$' + Number(d.total).toFixed(2) + '</div>' : '') +
    '</div>' +
    (rows ? '<table class="jb-tbl">' + rows + '</table>' : '') +
    (d.versions > 1 || d.custom_size
      ? '<div class="jb-flags">' +
        (d.versions > 1 ? '<span class="jb-flag">' + d.versions + ' versions</span>' : '') +
        (d.custom_size ? '<span class="jb-flag">Custom size ' + esc(d.custom_size) + '</span>' : '') +
        '</div>'
      : '') +
    (d.version_list && d.version_list.length > 1
      ? '<div class="jb-versions">' + d.version_list.map((v, i) =>
          '<div class="jb-ver"><span>Version ' + (i + 1) + '</span>' + esc(v.name) +
          (v.quantity ? ' <em>' + Number(v.quantity).toLocaleString() + '</em>' : '') + '</div>').join('') +
        '</div>'
      : '') +
    (d.discount ? '<div class="jb-disc">' + Number(d.discount.percent) + '% ' + esc(d.discount.name) +
      ' applies to this account</div>' : '') +
    '<div class="jb-foot">' +
      '<span class="jb-sub">' +
        (d.prepress ? 'Prepress: ' + esc(d.prepress) : '') +
        (d.production ? ' · Production: ' + esc(d.production) : '') + '</span>' +
      '<button type="button" class="jb-reorder">Reorder</button>' +
    '</div>';
  const btn = el.querySelector('.jb-reorder');
  if (btn) btn.onclick = () => ask('Reorder ' + (d.e_number || '') + ' — same specs. Price it and tell me what to confirm with the client.');
  return el;
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

function buildPriceCard(d) {
  // The product chip above is now answered — the price is right here. Leaving it
  // live invites a second click that re-prices the same thing.
  try {
    document.querySelectorAll('.pc-card').forEach(c => {
      c.classList.add('pc-chosen');
      c.disabled = true;
      const tag = c.querySelector('.pc-open');
      if (tag) tag.textContent = 'Priced';
    });
  } catch (e) {}
  // A corrected quote supersedes the first — drop the earlier card so one total
  // is on screen, not two that disagree.
  if (d && d.__replace) {
    document.querySelectorAll('.pq-card').forEach(n => n.remove());
  }
  const el = document.createElement('div');
  el.className = 'pq-card';
  let editing = false;
  let state = JSON.parse(JSON.stringify(d));

  function specRows() {
    return (state.specs || []).map((s, idx) => {
      // "Versions 12" alone says nothing — a (?) reveals the per-version
      // quantities and names, like the CRM does.
      const help = (s.isVersions && s.detail && s.detail.length)
        ? ' <button type="button" class="pq-vhelp" data-vhelp="' + idx + '" title="Show the version breakdown">?</button>'
        : '';
      // Price-critical and still defaulted? Show the row as a live dropdown with
      // a "Clarify" flag. Settling it here reprices in place — asking in chat
      // costs a round trip and buries the answer below the card.
      const clar = (state.clarify || []).find(c =>
        String(c.field).toLowerCase().replace(/[^a-z0-9]/g, '') ===
        String(s.field).toLowerCase().replace(/[^a-z0-9]/g, ''));
      // Specified always wins over clarify, wherever the flag came from.
      if (clar && !editing && s.source !== 'requested' && s.source !== 'specified') {
        // Quantity is a tier list rather than a normal option field, so it has
        // its own source. Without this the Clarify row would render as plain
        // text and there would be nothing to click.
        if (s.isQuantity && (state.quantities || []).length > 1) {
          const opts = state.quantities.map(q =>
            '<option value="' + q + '"' + (Number(q) === Number(state.quantity) ? ' selected' : '') +
            '>' + Number(q).toLocaleString() + '</option>').join('');
          return '<tr class="pq-clarify"><td>' + esc(s.field) +
            '<span class="pq-clarify-tag">Clarify</span></td>' +
            '<td><select class="pq-clarify-qty">' + opts + '</select>' +
            (clar.note ? '<span class="pq-clarify-why">' + esc(clar.note) + '</span>' : '') +
            '</td></tr>';
        }
        const fld = (state.fields || []).find(f =>
          String(f.title).toLowerCase().replace(/[^a-z0-9]/g, '') ===
          String(s.field).toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (fld && (fld.items || []).length > 1) {
          const opts = fld.items.map(i =>
            '<option value="' + i.id + '"' + (Number(i.id) === Number(fld.selected) ? ' selected' : '') +
            (i.allowed === false ? ' disabled' : '') + '>' + esc(i.title) + '</option>').join('');
          return '<tr class="pq-clarify"><td>' + esc(s.field) +
            '<span class="pq-clarify-tag">Clarify</span></td>' +
            '<td><select class="pq-clarify-sel" data-var="' + fld.id + '">' + opts + '</select>' +
            (clar.note ? '<span class="pq-clarify-why">' + esc(clar.note) + '</span>' : '') +
            '</td></tr>';
        }
      }

      // Where each value came from, at a glance: green = the person said so,
      // yellow = product default, blue = forced by another field.
      const tag = s.source === 'requested' ? ' <span class="pq-spec-tag">specified</span>'
        : s.source === 'default' ? ' <span class="pq-def">default</span>'
        : (s.source === 'linked' || s.source === 'auto') ? ' <span class="pq-link">auto</span>'
        : '';
      // Version rows are indented so they read as belonging to the Versions field.
      return '<tr' + (s.isVersionRow ? ' class="pq-vrow"' : '') + '><td>' + esc(s.field) + '</td><td>' +
        esc(s.value) + help + tag + '</td></tr>';
    }).join('');
  }

  // Body-level tooltip: the spec table sits inside a scrolling chat pane, which
  // would clip anything positioned inside it.
  let vTip = null;
  function hideVTip() { if (vTip) { vTip.remove(); vTip = null; } }
  function showVTip(btn, detail) {
    hideVTip();
    vTip = document.createElement('div');
    vTip.className = 'pq-vtip';
    const total = detail.reduce((a, b) => a + (Number(b.quantity) || 0), 0);
    vTip.innerHTML = '<div class="pq-vtip-hd">' + detail.length + ' versions</div>' +
      detail.map(v =>
        '<div class="pq-vtip-r"><span>Version ' + v.n + '</span>' +
        '<strong>' + Number(v.quantity || 0).toLocaleString() + '</strong>' +
        '<em>' + esc(v.name || '—') + '</em></div>').join('') +
      '<div class="pq-vtip-ft">' + total.toLocaleString() + ' total</div>';
    document.body.appendChild(vTip);
    const r = btn.getBoundingClientRect();
    const w = 240, h = vTip.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 10);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    vTip.style.left = Math.max(8, left) + 'px';
    vTip.style.top = top + 'px';
  }

  // Editable form: every product field, plus quantity and custom W/H. Repricing
  // happens on the server so the related-to rules stay in one place.
  // Editable form. Fields render in the PRODUCT's own order, with Quantity and
  // Versions sitting exactly where the calculator puts them — not bolted on top.
  function editRows() {
    const qtyOpts = (state.quantities || []).map(q =>
      '<option value="' + q.value + '"' + (Number(q.value) === Number(state.quantity) ? ' selected' : '') + '>' +
      esc(q.title) + '</option>').join('');

    const qtyBlock = () => {
      let h = '<label class="pq-f"><span>Quantity</span>' +
        (qtyOpts ? '<select data-qty>' + qtyOpts + '</select>' : '') +
        '<input type="number" min="1" data-qtynum value="' + (state.quantity || '') + '" placeholder="custom"></label>';
      if (state.hasVersions) {
        h += '<label class="pq-f"><span>Versions</span>' +
          '<input type="number" min="1" max="99" data-versions value="' + (state.versions || 1) + '">' +
          '<span class="pq-hint">' +
          (state.versions > 1 ? Math.round(state.quantity / state.versions).toLocaleString() + ' each' : 'designs in this run') +
          '</span></label>';
        h += versionRows();
      }
      return h;
    };

    const versionRows = () => versionsPanel();

    const fieldBlock = (f) => {
      const opts = (f.items || []).map(i =>
        '<option value="' + i.id + '"' + (Number(i.id) === Number(f.selected) ? ' selected' : '') +
        (i.allowed ? '' : ' disabled') + '>' + esc(i.title) + (i.allowed ? '' : ' — n/a') + '</option>').join('');
      let h = '<label class="pq-f"><span>' + esc(f.title) + '</span>' +
        '<select data-var="' + f.id + '">' + opts + '</select></label>';
      if (f.isSize) {
        const sel = (f.items || []).find(i => Number(i.id) === Number(f.selected));
        if (sel && sel.custom) {
          h += '<label class="pq-f pq-f-sub"><span>W × H (in)</span>' +
            '<input type="number" step="0.01" min="0" data-w value="' + (state.width || '') + '" placeholder="Width">' +
            '<span class="pq-x">×</span>' +
            '<input type="number" step="0.01" min="0" data-h value="' + (state.height || '') + '" placeholder="Height"></label>';
        }
      }
      return h;
    };

    // Merge the option fields and the quantity block, then sort by the product's order.
    const rows = (state.fields || []).map(f => ({ order: f.order == null ? 999 : f.order, html: fieldBlock(f) }));
    rows.push({ order: state.qtyOrder == null ? 999 : state.qtyOrder, html: qtyBlock() });
    rows.sort((a, b) => a.order - b.order);

    return '<div class="pq-edit">' + rows.map(r => r.html).join('') +
      '<div class="pq-edit-foot"><span class="pq-status"></span>' +
      '<button type="button" class="pq-done">Done</button></div></div>';
  }

  // One row per version: quantity and name, exactly like the website's panel.
  // Names are required on the order, so they get inputs plus an Autofill shortcut
  // rather than being an afterthought.
  // One quiet line with the completion date, and the full day-by-day breakdown
  // behind a hover. Shown on EVERY quote, including defaulted turnarounds — the
  // date is always worth knowing, the arithmetic usually isn't.
  function scheduleStrip() {
    const sc = state.schedule;
    if (!sc) return '';
    // Same-day work isn't a calculation — it depends on the floor's load, so
    // promising a date here would be worse than saying nothing.
    if (sc.sameDay || sc.days === 0) {
      return '<div class="pq-eta">Estimated Due: <b>Check with production</b>' +
        '<span class="pq-eta-note">same-day turnaround</span></div>';
    }
    if (!sc.readyDate) return '';
    const d = new Date(sc.readyDate + 'T12:00:00');
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    // Day name matters as much as the date — "Fri" tells an AM whether it lands
    // before the weekend at a glance. 5PM is the daily cutoff.
    const label = DAY[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate() + ' \u00b7 5:00 PM';
    return '<div class="pq-eta">Estimated Due: <b>' + label + '</b>' +
      '<button type="button" class="pq-eta-q" aria-label="How this date is worked out">?</button></div>';
  }

  // The breakdown, built only when someone actually hovers the question mark.
  function scheduleTip() {
    const sc = state.schedule;
    if (!sc || !sc.timeline) return '';
    const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    // Keep the start cell — it is the whole point of the explanation.
    const cells = sc.timeline.map(t => {
      const d = new Date(t.date + 'T12:00:00');
      const cls = t.type === 'ready' ? ' ready'
        : t.type === 'start' ? ' start'
        : t.type === 'approved' ? ' approved'
        : t.type === 'skipped' ? ' off' : '';
      return '<span class="sch-day' + cls + '">' +
        '<em>' + DAY[d.getDay()].toUpperCase() + '</em><b>' + d.getDate() + '</b>' +
        '<i>' + esc(t.label) + '</i></span>';
    }).join('');
    return '<div class="sch-tip-in">' +
      '<div class="sch-tip-hd">' + esc(state.specs && (state.specs.find(x => /turnaround/i.test(x.field)) || {}).value || '') +
        ' \u00b7 production time only</div>' +
      '<div class="sch-row">' + cells + '</div>' +
      '<div class="sch-tip-ft">If approved today ' + (sc.beforeCutoff ? 'before' : 'after') +
        ' the 5PM cutoff. Counting starts the day after the start day; weekends ' +
        'and holidays don\u2019t count.</div>' +
    '</div>';
  }

  function versionsPanel() {
    const n = Number(state.versions) || 1;
    if (!state.hasVersions || n < 2) return '';
    const names = state.version_names || [];
    const qtys = state.version_quantities || [];
    // Each version starts at the chosen Quantity, and the TOTAL is the sum —
    // the calculator works the same way. Splitting the quantity instead would
    // give 0 for a run of 1 across 2 versions.
    const base = Math.max(1, Number(state.per_version) || Number(state.quantity) || 1);
    // Write the shown values back into state. Rendering a default without storing
    // it is what made the form look complete while the order was rejected for a
    // missing quantity.
    state.version_quantities = state.version_quantities || [];
    state.version_names = state.version_names || [];
    let h = '<div class="pq-vers"><div class="pq-vers-hd">Versions' +
      '<button type="button" class="pq-vers-auto">Autofill names</button></div>';
    for (let i = 0; i < n; i++) {
      const q = qtys[i] != null ? qtys[i] : base;
      if (state.version_quantities[i] == null) state.version_quantities[i] = q;
      h += '<div class="pq-ver"><span>Version ' + (i + 1) + '</span>' +
        '<label class="pq-vf"><em>Quantity</em>' +
        '<input type="number" min="0" class="pq-vq" data-vi="' + i + '" value="' + q + '"></label>' +
        '<label class="pq-vf pq-vf-name"><em>Name</em>' +
        '<input type="text" class="pq-vn" data-vi="' + i + '" value="' + esc(names[i] || '') +
        '" placeholder="Required"></label>' +
        '<button type="button" class="pq-vdel" data-vi="' + i + '" title="Remove this version">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline>' +
        '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2">' +
        '</path></svg></button></div>';
    }
    h += '<div class="pq-vers-note" data-vsum></div></div>';
    return h;
  }

  function paint() {
    el.innerHTML =
      '<div class="pq-head"><div><div class="pq-prod">' + esc(state.product || '') + '</div>' +
        '<div class="pq-qty">Qty ' + (state.quantity || 0) + (state.size ? ' · ' + esc(state.size) : '') + '</div></div>' +
        '<div class="pq-total">' +
          (state.discount
            ? '<span class="pq-was">$' + Number(state.list_price || 0).toFixed(2) + '</span>'
            : '') +
          '$' + Number(state.price || 0).toFixed(2) +
        '<span>$' + Number(state.each || 0).toFixed(2) + ' each</span></div></div>' +
      (state.redirected
        ? '<div class="pq-redirect">Switched to <b>' + esc(state.product) + '</b> \u2014 ' +
          esc(state.redirected.from) + ' doesn\u2019t do ' + esc(state.redirected.reason) + '.</div>'
        : '') +
      (Number(state.versions) > 25
        ? '<div class="pq-sizewarn">' + Number(state.versions) + ' versions is past our practical limit ' +
          'of 25 \u2014 ' + (state.hasVariableData
            ? 'variable data prints these in one run and costs far less.'
            : 'this product has no variable data option, so this needs splitting or a different product.') +
          '</div>'
        : '') +
      (state.size_warning
        ? '<div class="pq-sizewarn">' + esc(state.size_warning) + '</div>'
        : '') +
      (state.discount
        ? '<div class="pq-disc">' + Number(state.discount.percent) + '% ' + esc(state.discount.name) +
          ' <em>' + esc(state.discount.basis) + ' rate</em>' +
          '<span>saves $' + Number(state.discount.saved || 0).toFixed(2) + '</span></div>'
        : '') +
      (editing ? editRows() : '<table class="pq-tbl">' + specRows() + '</table>' + versionsPanel()) +
      (editing ? '' :
        '<div class="pq-note">' + (state.discount
          ? esc((state.client_name ? state.client_name + '\u2019s' : 'Client') + ' price \u2014 ' +
                Number(state.discount.percent) + '% ' + (state.discount.name || 'discount') + ' applied.')
          : 'List price from the calculator.') + '</div>' +
        '<div class="pq-actions">' +
          '<button type="button" class="pq-copybtn">Copy</button>' +
          '<button type="button" class="pq-editbtn">Edit</button>' +

          (CTX.onSave
            ? '<button type="button" class="pq-savebtn' + (el.__saved ? ' on' : '') + '" ' +
                'title="Keep this quote for the reply — it goes to Saved at the top">' +
                (el.__saved ? '\u2713 Saved' : esc((CTX.saveLabel && CTX.saveLabel(el)) || 'Save')) + '</button>'
            : '<button type="button" class="pq-cartbtn" title="Keep this quote and price the next item">' +
                'Add to cart</button>') +
        '</div>' + scheduleStrip()) +
      '<div class="pq-order" style="display:none"></div>';
    wire();
  }

  async function reprice() {
    const status = el.querySelector('.pq-status');
    if (status) status.textContent = 'Pricing…';
    const itemIds = {};
    // Outside edit mode there are no dropdowns, so start from what this card was
    // priced with — otherwise a re-price (e.g. for a newly connected client)
    // silently falls back to every default and loses the specs asked for.
    // Only the requested ones: defaults and auto-linked fields resolve the same
    // way again, and keep their tags.
    (state.specs || []).forEach(sp => {
      if (sp.variable_id && sp.item_id && !sp.isQuantity && !sp.isVersions && !sp.isVersionRow &&
          (sp.source === 'requested' || sp.source === 'specified')) itemIds[sp.variable_id] = Number(sp.item_id);
    });
    el.querySelectorAll('select[data-var]').forEach(sel => {
      itemIds[sel.getAttribute('data-var')] = Number(sel.value);
    });
    const qn = el.querySelector('[data-qtynum]');
    const qs = el.querySelector('[data-qty]');
    const qty = (qn && qn.value) ? Number(qn.value) : (qs ? Number(qs.value) : state.quantity);
    const wEl = el.querySelector('[data-w]'), hEl = el.querySelector('[data-h]');
    try {
      const r = await fetch('/api/chatbot/reprice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          product_id: state.product_id, item_ids: itemIds, quantity: qty,
          client_id: state.client_id,
          chat_id: (typeof currentChatId !== 'undefined') ? currentChatId : undefined,
          client_name_hint: state.client_name || undefined,
          // state.versions wins: a delete has already reduced it, and the input
          // still shows the old number until the card repaints.
          versions: Number(state.versions) ||
            (function () { const v = el.querySelector('[data-versions]'); return v && v.value ? Number(v.value) : 1; })(),
          version_names: state.version_names || undefined,
          version_quantities: state.version_quantities || undefined,
          // With per-version quantities present the TOTAL is their sum, so the
          // server prices the real run size rather than the base quantity.
          version_list: (state.version_quantities && state.version_quantities.length > 1)
            ? state.version_quantities.map((q, i) => ({
                name: (state.version_names || [])[i] || ('V' + (i + 1)),
                quantity: Number(q) || 0
              }))
            : undefined,
          width: wEl && wEl.value ? Number(wEl.value) : (state.width || null),
          height: hEl && hEl.value ? Number(hEl.value) : (state.height || null)
        })
      });
      const j = await r.json();
      if (!j.ok) { if (status) status.textContent = j.error || 'Could not price that'; return; }
      const keptNames = state.version_names, keptQtys = state.version_quantities;
      state = j;
      if (keptNames && Number(j.versions) === keptNames.length) state.version_names = keptNames;
      if (keptQtys && Number(j.versions) === keptQtys.length) state.version_quantities = keptQtys;
      paint();
      const s2 = el.querySelector('.pq-status');
      if (s2) s2.textContent = 'Updated';
      if (CTX.onChange) { try { CTX.onChange(el, JSON.parse(JSON.stringify(state))); } catch (e) {} }
    } catch (e) { if (status) status.textContent = 'Connection error'; }
  }

  // "Order estimate" — asks for the few things a priced estimate doesn't carry,
  // then files a complete order request.
  async function openOrderForm() {
    const box = el.querySelector('.pq-order');
    if (!box) return;
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = '<div class="pq-order-hd">Loading…</div>';

    // Ask the server for the fields AND the sensible defaults: due date from the
    // chosen turnaround, delivery from the previous order or the client's
    // preference, and their address book.
    // Skip the Version rows so a version named e.g. "Turnaround Signs" can't be
    // mistaken for the turnaround field.
    const turn = (state.specs || []).find(sp => !sp.isVersionRow && /turnaround/i.test(sp.field));
    let cfg, dflt = {};
    try {
      const q = '?client_id=' + (state.client_id || '') +
        '&turnaround=' + encodeURIComponent(turn ? turn.value : '') +
        '&from_estimate=' + encodeURIComponent(state.source_estimate || '');
      const [r1, r2] = await Promise.all([
        fetch('/api/chatbot/order-fields?client_id=' + (state.client_id || ''),
          { headers: { 'Authorization': 'Bearer ' + token } }),
        fetch('/api/chatbot/order-defaults' + q, { headers: { 'Authorization': 'Bearer ' + token } })
      ]);
      cfg = await r1.json();
      dflt = await r2.json();
    } catch (e) { box.innerHTML = '<div class="pq-order-hd">Could not load the order form.</div>'; return; }

    const pad = n => String(n).padStart(2, '0');
    const nowLocal = (() => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' +
      pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); })();

    const field = (f) => {
      let input, note = '';
      if (f.key === 'needed_by') {
        if (dflt.same_day) {
          // Same-day work needs an exact time, and it can't be in the past.
          input = '<input type="datetime-local" data-of="needed_by" min="' + nowLocal + '" value="' + nowLocal + '">';
          note = 'Same-day turnaround — pick a time today.';
        } else {
          input = '<input type="date" data-of="needed_by" min="' + nowLocal.slice(0, 10) + '"' +
            (dflt.needed_by ? ' value="' + dflt.needed_by + '"' : '') + '>';
          note = dflt.needed_by
            ? ('From ' + esc(turn ? turn.value : 'the turnaround') + ', due 5PM' +
               (dflt.cutoff_passed ? ' — after today\'s 5PM cutoff, so the clock starts tomorrow' : '') +
               (dflt.turnaround_ambiguous ? '. "Express" has no set day count — confirm this date.' : ''))
            : 'Set the date the client needs it.';
        }
      } else if (f.key === 'shipping_method') {
        const sel = dflt.shipping_method || '';
        input = '<select data-of="shipping_method">' +
          (dflt.shipping_method ? '' : '<option value="">— choose —</option>') +
          (f.options || []).map(o => '<option value="' + esc(o.value) + '"' +
            (o.value === sel ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select>';
        if (dflt.method_source) note = 'From ' + esc(dflt.method_source) + '.';
      } else if (f.type === 'date') input = '<input type="date" data-of="' + f.key + '">';
      else if (f.type === 'select') input = '<select data-of="' + f.key + '">' + (f.options || []).map(o =>
        '<option value="' + esc(o.value) + '"' + (o.value === f.default ? ' selected' : '') + '>' +
        esc(o.label) + '</option>').join('') + '</select>';
      else if (f.type === 'textarea') input = '<textarea rows="2" data-of="' + f.key + '" placeholder="' + esc(f.hint || '') + '"></textarea>';
      else input = '<input type="text" data-of="' + f.key + '" placeholder="' + esc(f.hint || '') + '">';
      return '<label class="pq-f"><span>' + esc(f.label) + '</span>' + input + '</label>' +
        (note ? '<div class="pq-fnote">' + note + '</div>' : '');
    };

    const addressBlock = () => {
      if (!(dflt.addresses || []).length) {
        return '<div class="pq-fnote pq-warn-note">No addresses on file for this client — add one in the CRM ' +
          'or choose Pick up.</div>';
      }
      return '<label class="pq-f pq-f-sub" data-addr-row><span>Ship to</span>' +
        '<select data-of="address_id">' + dflt.addresses.map(a =>
          '<option value="' + a.id + '"' + (Number(a.id) === Number(dflt.address_id) ? ' selected' : '') + '>' +
          esc(a.label) + (a.preferred ? ' ★' : '') + '</option>').join('') + '</select></label>';
    };

    // WHO is this for, always, before anything else. An order placed against the
    // wrong account gets the wrong discount and the wrong invoice, so the client
    // is confirmed on screen every time rather than assumed from the chat.
    const initials = String(state.client_name || '?').replace(/\(.*\)/, '')
      .trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    // Two independent gates: our own state, and the server's answer. Either one
    // saying "no client" keeps the order fields hidden.
    const clientKnown = !!state.client_id && !(cfg && cfg.needs_client);
    const clientBar = clientKnown
      ? '<div class="pq-client-bar"><span class="pq-client-av">' + esc(initials) + '</span>' +
        '<span class="pq-client-info"><strong>' + esc(state.client_name || 'Client #' + state.client_id) + '</strong>' +
        '<small>Ordering on this account</small></span>' +
        '<button type="button" class="pq-client-change">Change</button></div>'
      : '';
    const searchBlock =
      '<div class="pq-client"><div class="pq-client-hd">Who is this order for?</div>' +
      '<input type="text" class="pq-client-q" placeholder="Client name, company or email">' +
      '<div class="pq-client-res"></div></div>';

    // With no client we show ONLY the search — the rest of the form would be
    // filled in against nobody.
    box.innerHTML =
      '<div class="pq-order-hd">Place this order</div>' +
      (clientKnown ? clientBar : searchBlock) +
      (clientKnown
        ? (cfg.required || []).map(field).join('') +
          (cfg.choices || []).map(f => field(f) + (f.key === 'shipping_method' ? '<div data-addr-holder>' +
            (['shipping', 'blind_drop_ship'].indexOf(dflt.shipping_method) > -1 ? addressBlock() : '') + '</div>' : '')).join('') +
          (cfg.optional || []).map(field).join('') +
          '<div class="pq-order-foot"><span class="pq-order-msg"></span>' +
          '<button type="button" class="pq-order-cancel">Cancel</button>' +
          '<button type="button" class="pq-order-send">Place order</button></div>'
        : '<div class="pq-order-foot"><span class="pq-order-msg"></span>' +
          '<button type="button" class="pq-order-cancel">Cancel</button></div>');

    // Show the address list only when shipping is selected.
    const methodSel = box.querySelector('[data-of="shipping_method"]');
    if (methodSel) {
      methodSel.onchange = () => {
        const holder = box.querySelector('[data-addr-holder]');
        // An address is only needed when it is actually going somewhere.
        if (holder) holder.innerHTML =
          (['shipping', 'blind_drop_ship'].indexOf(methodSel.value) > -1) ? addressBlock() : '';
      };
    }
    box.querySelector('.pq-order-cancel').onclick = () => { box.style.display = 'none'; };
    const sendBtn = box.querySelector('.pq-order-send');
    if (sendBtn) sendBtn.onclick = () => submitOrder(box);

    // "Change" swaps the confirmed client back to the search.
    const chg = box.querySelector('.pq-client-change');
    if (chg) chg.onclick = () => {
      state.client_id = null;
      state.client_name = null;
      box.style.display = 'none';
      openOrderForm();
    };

    // Live client search
    const cq = box.querySelector('.pq-client-q');
    if (cq) {
      let t = null;
      const res = box.querySelector('.pq-client-res');
      cq.oninput = () => {
        clearTimeout(t);
        const term = cq.value.trim();
        if (term.length < 2) { res.innerHTML = ''; return; }
        t = setTimeout(async () => {
          res.innerHTML = '<div class="pq-client-empty">Searching…</div>';
          try {
            const r = await fetch('/api/chatbot/find-client?q=' + encodeURIComponent(term),
              { headers: { 'Authorization': 'Bearer ' + token } });
            const j = await r.json();
            if (!j.ok || !j.clients.length) { res.innerHTML = '<div class="pq-client-empty">No match.</div>'; return; }
            res.innerHTML = '';
            j.clients.forEach(c => {
              const b = document.createElement('button');
              b.type = 'button';
              b.className = 'pq-client-pick';
              b.innerHTML = '<span>' + esc(c.name) + (c.company ? ' <em>' + esc(c.company) + '</em>' : '') +
                '<br><small>' + esc(c.email || '') + '</small></span>' +
                '<span class="pq-client-n">' + (c.orders || 0) + '</span>';
              b.onclick = async () => {
                // Reprice for this client so their account discount applies before
                // anything is ordered — the list price is wrong for most accounts.
                const before = Number(state.price) || 0;
                state.client_id = c.id;
                state.client_name = c.company ? (c.name + ' (' + c.company + ')') : c.name;
                res.innerHTML = '<div class="pq-client-empty">Checking ' + esc(c.name) +
                  '\u2019s pricing\u2026</div>';
                await reprice();
                const after = Number(state.price) || 0;
                if (state.discount && after < before) {
                  // Say so plainly: the number on the card just changed.
                  res.innerHTML = '<div class="pq-client-empty">' + Number(state.discount.percent) +
                    '% ' + esc(state.discount.name) + ' applied \u2014 now $' + after.toFixed(2) + '</div>';
                  await new Promise(r => setTimeout(r, 900));
                }
                box.style.display = 'none';
                openOrderForm();
              };
              res.appendChild(b);
            });
          } catch (e) { res.innerHTML = '<div class="pq-client-empty">Search failed.</div>'; }
        }, 300);
      };
      setTimeout(() => cq.focus(), 80);
    }
  }

  async function submitOrder(box) {
    const msg = box.querySelector('.pq-order-msg');
    const btn = box.querySelector('.pq-order-send');
    const itemIds = {};
    (state.specs || []).forEach(sp => {
      // Quantity and the per-version rows are sent separately, not as option ids.
      if (sp.variable_id && !sp.isQuantity && !sp.isVersionRow && sp.item_id) itemIds[sp.variable_id] = sp.item_id;
    });
    const payload = {
      client_id: state.client_id, client_name: state.client_name || null,
      product_id: state.product_id, product: state.product,
      quantity: state.quantity,
      item_ids: itemIds,
      width: state.width, height: state.height,
      // Sent so the server can refuse an order that drops the version detail.
      versions: state.versions || 1,
      source_estimate: state.source_estimate || null
    };
    box.querySelectorAll('[data-of]').forEach(i => { payload[i.getAttribute('data-of')] = i.value.trim(); });

    if (!payload.client_id) {
      // Should be unreachable — the form is gated — but never submit without one.
      box.style.display = 'none';
      openOrderForm();
      return;
    }
    // Version names are required on the order.
    if (Number(state.versions) > 1) {
      // Same for names: trust the inputs on screen over stored state.
      const nameInputs = Array.from(el.querySelectorAll('.pq-vn'));
      const names = nameInputs.length === Number(state.versions)
        ? nameInputs.map(i2 => i2.value.trim())
        : (state.version_names || []);
      const blanks = [];
      for (let i = 0; i < Number(state.versions); i++) {
        if (!String(names[i] || '').trim()) blanks.push(i + 1);
      }
      if (blanks.length) {
        msg.textContent = 'Name every version first (missing ' + blanks.join(', ') + ') — Edit, then Autofill names.';
        return;
      }
      // Read the quantities from the inputs themselves — whatever the person can
      // see is what gets ordered, regardless of how state got there.
      const inputs = Array.from(el.querySelectorAll('.pq-vq'));
      const qs = inputs.length === names.length
        ? inputs.map(i2 => Number(i2.value))
        : (state.version_quantities || []).map(Number);
      if (qs.length !== names.length || qs.some(x => !isFinite(x) || x <= 0)) {
        msg.textContent = 'Give every version a quantity before ordering.';
        return;
      }
      state.version_quantities = qs;
      payload.version_names = names;
      payload.version_quantities = qs;
    }
    btn.disabled = true; msg.textContent = 'Submitting…';
    try {
      const r = await fetch('/api/chatbot/order-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (!j.ok) {
        msg.textContent = j.missing ? ('Still needed: ' + j.missing.join(', ')) : (j.error || 'Submit failed');
        btn.disabled = false;
        return;
      }
      if (j.submitted && j.e_number) {
        const num = String(j.e_number).replace(/^E/, '');
        // The order API does not yet accept per-version data — it lands in the
        // prepress notes instead. Say so, rather than letting someone assume
        // production can see the split.
        const vWarn = (Number(state.versions) > 1)
          ? '<div class="pq-order-warnbox">This job has ' + Number(state.versions) +
            ' versions. They are written into the prepress notes, but the CRM version ' +
            'fields still need setting by hand on this job.</div>'
          : '';
        box.innerHTML = '<div class="pq-order-ok">' +
          '\u2713 Order placed — <button type="button" class="enum-link" data-e="' + esc(num) + '">' +
          esc(j.e_number) + '</button>' +
          '<div class="pq-order-sub">Click it to open the job.</div></div>' + vWarn;
      } else if (j.submitted) {
        // Placed, but the API reply had no id we could recognise. Show the raw
        // reply rather than pretending we have a reference.
        box.innerHTML = '<div class="pq-order-ok warn">\u2713 Order placed, but no E-number came back.' +
          '<div class="pq-order-sub">Check the CRM for the newest job.' +
          (j.raw_response ? '<br><code class="pq-raw">' + esc(j.raw_response) + '</code>' : '') +
          '</div></div>';
      } else {
        box.innerHTML = '<div class="pq-order-ok warn">Not sent. Saved as request #' + j.id + '.' +
          (j.error ? '<br><span class="pq-order-warn">' + esc(j.error) + '</span>' : '') + '</div>';
      }
    } catch (e) {
      msg.textContent = 'Connection error'; btn.disabled = false;
    }
  }

  // Plain-text quote for pasting into a reply to the client. Deliberately leaves
  // out anything internal — no discount tier name, no "default"/"auto" tags.
  function quoteText() {
    const lines = [state.product || ''];
    lines.push('');
    (state.specs || []).forEach(sp => {
      if (sp.isVersions && (!state.versions || state.versions < 2)) return;
      lines.push((sp.isVersionRow ? '  ' : '') + sp.field + ': ' + sp.value);
    });
    lines.push('');
    if (state.discount && state.list_price) {
      lines.push('List price: $' + Number(state.list_price).toFixed(2));
      lines.push('Your price: $' + Number(state.price).toFixed(2) +
        '  ($' + Number(state.each).toFixed(2) + ' each)');
    } else {
      lines.push('Total: $' + Number(state.price || 0).toFixed(2) +
        '  ($' + Number(state.each || 0).toFixed(2) + ' each)');
    }
    return lines.join('\n');
  }

  // Build the quote as EMAIL-SAFE HTML: inline styles only (mail clients strip
  // <style> blocks), a real table rather than CSS grid, and the product photo so
  // the AM has something to send that doesn't read like a database dump.
  function quoteHtml() {
    const esc2 = (x) => esc(x);
    const rows = (state.specs || []).map(sp => {
      if (sp.isVersions && (!state.versions || state.versions < 2)) return '';
      const indent = sp.isVersionRow ? 'padding-left:26px;color:#555;' : '';
      return '<tr>' +
        '<td style="padding:7px 14px 7px 0;border-bottom:1px solid #ecebf3;color:#6b6f80;' +
          'font-size:13px;white-space:nowrap;' + indent + '">' + esc2(sp.field) + '</td>' +
        '<td style="padding:7px 0;border-bottom:1px solid #ecebf3;color:#22243a;' +
          'font-size:13px;font-weight:500;">' + esc2(sp.value) + '</td>' +
      '</tr>';
    }).join('');

    const priceBlock = (state.discount && state.list_price)
      ? '<div style="font-size:13px;color:#6b6f80;">List price ' +
        '<span style="text-decoration:line-through;">$' + Number(state.list_price).toFixed(2) + '</span></div>' +
        '<div style="font-size:26px;font-weight:700;color:#5f51c7;line-height:1.2;">$' +
        Number(state.price).toFixed(2) + '</div>' +
        '<div style="font-size:13px;color:#166534;font-weight:600;">Your price · $' +
        Number(state.each).toFixed(2) + ' each</div>'
      : '<div style="font-size:26px;font-weight:700;color:#5f51c7;line-height:1.2;">$' +
        Number(state.price || 0).toFixed(2) + '</div>' +
        '<div style="font-size:13px;color:#6b6f80;">$' + Number(state.each || 0).toFixed(2) + ' each</div>';

    return '' +
    '<div style="font-family:Helvetica,Arial,sans-serif;color:#22243a;max-width:560px;">' +
      '<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">' +
        '<tr>' +
          (state.product_image
            ? '<td style="width:96px;vertical-align:top;padding-right:16px;">' +
              '<img src="' + esc2(state.product_image) + '" width="96" ' +
              'style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid #e6e6f0;display:block;" ' +
              'alt="' + esc2(state.product) + '"></td>'
            : '') +
          '<td style="vertical-align:top;">' +
            '<div style="font-size:18px;font-weight:700;">' + esc2(state.product || '') + '</div>' +
            '<div style="font-size:13px;color:#6b6f80;margin-top:2px;">' +
              'Quantity ' + Number(state.quantity || 0).toLocaleString() +
              (state.size ? ' &middot; ' + esc2(state.size) : '') +
              (state.versions > 1 ? ' &middot; ' + state.versions + ' versions' : '') +
            '</div>' +
            '<div style="margin-top:10px;">' + priceBlock + '</div>' +
          '</td>' +
        '</tr>' +
      '</table>' +
      '<table cellpadding="0" cellspacing="0" border="0" ' +
        'style="width:100%;border-collapse:collapse;margin-top:16px;">' + rows + '</table>' +
      '<div style="font-size:11px;color:#8b8fa3;margin-top:14px;">' +
        'Price excludes shipping and tax.' +
      '</div>' +
    '</div>';
  }

  async function copyQuote(btn) {
    const text = quoteText();
    const html = quoteHtml();
    const done = () => {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('ok');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('ok'); }, 1600);
    };
    // Write BOTH flavours: mail clients take the HTML, plain editors the text.
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })]);
        return done();
      }
      throw new Error('no ClipboardItem');
    } catch (e) {
      // Fallback: copy a rendered selection, which also carries formatting.
      try {
        const holder = document.createElement('div');
        holder.setAttribute('contenteditable', 'true');
        holder.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;';
        holder.innerHTML = html;
        document.body.appendChild(holder);
        const range = document.createRange();
        range.selectNodeContents(holder);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        sel.removeAllRanges();
        holder.remove();
        done();
      } catch (e2) {
        try { await navigator.clipboard.writeText(text); done(); }
        catch (e3) { btn.textContent = 'Copy failed'; }
      }
    }
  }

  function wire() {
    // "Save" — the page files this quote (and its other quantities) under Saved.
    const sv = el.querySelector('.pq-savebtn');
    if (sv) sv.onclick = () => {
      if (CTX.onSave) CTX.onSave(el, JSON.parse(JSON.stringify(state)));
    };
    // A Clarify dropdown reprices the card in place, so the answer lands where
    // the question was asked.
    const qsel = el.querySelector('.pq-clarify-qty');
    if (qsel) qsel.onchange = () => {
      state.quantity = Number(qsel.value);
      qsel.disabled = true;
      reprice();
    };

    el.querySelectorAll('.pq-clarify-sel').forEach(sel => {
      sel.onchange = () => {
        const vid = Number(sel.getAttribute('data-var'));
        const fld = (state.fields || []).find(f => Number(f.id) === vid);
        if (fld) fld.selected = Number(sel.value);
        sel.disabled = true;
        reprice();
      };
    });

    // "Add to cart" — park this priced item at the top and move on. A multi-item
    // request then builds a visible list instead of a chat you have to scroll.
    const cb = el.querySelector('.pq-cartbtn');
    if (cb) cb.onclick = async () => {
      cb.disabled = true;
      cb.textContent = 'Adding…';
      const summary = (state.specs || [])
        .filter(sp => !sp.isVersionRow && sp.source === 'requested')
        .slice(0, 4).map(sp => sp.value).join(' · ');
      const ok = await CTX.addToCart({
        product_id: state.product_id,
        product: state.product,
        image: state.product_image || null,
        quantity: state.quantity,
        price: state.price,
        list_price: state.list_price,
        summary: summary,
        // Each item has its own turnaround, so it has its own ready date. The
        // checkout must not put one shared date against everything.
        turnaround: (state.specs || []).reduce((v, sp) =>
          (/turnaround/i.test(sp.field) && !sp.isVersionRow) ? sp.value : v, null),
        ready_date: (state.schedule && state.schedule.readyDate) || null,
        payload: {
          item_ids: (state.specs || []).reduce((m, sp) => {
            if (sp.variable_id && !sp.isQuantity && !sp.isVersionRow && sp.item_id) m[sp.variable_id] = sp.item_id;
            return m;
          }, {}),
          quantity: state.quantity, versions: state.versions,
          version_names: state.version_names, version_quantities: state.version_quantities,
          width: state.width, height: state.height, client_id: state.client_id
        }
      });
      if (ok) {
        el.classList.add('pq-incart');
        cb.textContent = 'In cart';
        // Adding to the cart is a filing action, not a question. Sending a chat
        // message here burned a turn and pushed the conversation on when the
        // person just wanted the item saved.
        if (CTX.onCartAdd) CTX.onCartAdd();
      } else {
        cb.disabled = false;
        cb.textContent = 'Add to cart';
      }
    };

    // Hover the "?" to see how the completion date was worked out.
    const etaQ = el.querySelector('.pq-eta-q');
    if (etaQ) {
      let tip = null, hideTimer = null;
      const place = () => {
        if (!tip) return;
        const r = etaQ.getBoundingClientRect();
        const w = tip.offsetWidth, h = tip.offsetHeight;
        // Centre on the marker, kept inside the viewport.
        let left = r.left + r.width / 2 - w / 2;
        left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
        // Below by default; above when there isn't room, so it never opens off
        // the bottom of a card near the end of the conversation.
        const below = r.bottom + 10;
        const top = (below + h > window.innerHeight - 8 && r.top - h - 10 > 8)
          ? r.top - h - 10
          : below;
        tip.style.left = (left + window.scrollX) + 'px';
        tip.style.top = (top + window.scrollY) + 'px';
      };
      const show = () => {
        clearTimeout(hideTimer);
        if (tip) return;
        tip = document.createElement('div');
        tip.className = 'sch-tip';
        tip.innerHTML = scheduleTip();
        // Measure off-screen first — reading offsetWidth before the element has
        // been laid out returned 0, which is why it appeared in the wrong place.
        tip.style.left = '-9999px';
        tip.style.top = '0px';
        document.body.appendChild(tip);
        requestAnimationFrame(place);
        // Keep it open while the pointer is on the popover itself.
        tip.onmouseenter = () => clearTimeout(hideTimer);
        tip.onmouseleave = () => hide();
      };
      const hide = () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (tip) { tip.remove(); tip = null; } }, 160);
      };
      etaQ.onmouseenter = show;
      etaQ.onmouseleave = hide;
      etaQ.onclick = (e) => {
        e.preventDefault();
        if (tip) { clearTimeout(hideTimer); tip.remove(); tip = null; } else show();
      };
    }

    el.querySelectorAll('.pq-vhelp').forEach(b => {
      const sp = (state.specs || [])[Number(b.getAttribute('data-vhelp'))];
      if (!sp || !sp.detail) return;
      b.onmouseenter = () => showVTip(b, sp.detail);
      b.onmouseleave = hideVTip;
      b.onclick = (e) => { e.preventDefault(); if (vTip) hideVTip(); else showVTip(b, sp.detail); };
    });
    const cp = el.querySelector('.pq-copybtn');
    if (cp) cp.onclick = () => copyQuote(cp);
    const edit = el.querySelector('.pq-editbtn');
    if (edit) edit.onclick = () => { editing = true; paint(); };
    const done = el.querySelector('.pq-done');
    if (done) done.onclick = () => { editing = false; paint(); };
    el.querySelectorAll('select[data-var]').forEach(sel => { sel.onchange = reprice; });
    const qs = el.querySelector('[data-qty]');
    if (qs) qs.onchange = () => { const n = el.querySelector('[data-qtynum]'); if (n) n.value = ''; reprice(); };
    const qn = el.querySelector('[data-qtynum]');
    if (qn) qn.onchange = reprice;
    const w = el.querySelector('[data-w]'), h = el.querySelector('[data-h]');
    if (w) w.onchange = reprice;
    if (h) h.onchange = reprice;
    const vs = el.querySelector('[data-versions]');
    if (vs) vs.onchange = () => {
      const n = Math.max(1, Number(vs.value) || 1);
      const base = Math.max(1, Number(state.per_version) || Number(state.quantity) || 1);
      const oldQ = state.version_quantities || [];
      const oldN = state.version_names || [];
      // Keep what was already entered; new rows start at the base quantity.
      state.version_quantities = Array.from({ length: n }, (_, i) => (oldQ[i] != null ? oldQ[i] : base));
      state.version_names = Array.from({ length: n }, (_, i) => oldN[i] || '');
      state.versions = n;
      reprice();
    };

    // Version rows: names and per-version quantities live in state so they
    // survive a reprice and can be sent with the order.
    const auto = el.querySelector('.pq-vers-auto');
    if (auto) auto.onclick = () => {
      const n = Number(state.versions) || 1;
      state.version_names = Array.from({ length: n }, (_, i) => 'V' + (i + 1));
      paint();
    };
    el.querySelectorAll('.pq-vn').forEach(inp => {
      inp.oninput = () => {
        const i = Number(inp.getAttribute('data-vi'));
        state.version_names = state.version_names || [];
        state.version_names[i] = inp.value;
      };
    });
    // Deleting a version drops it from the list, renumbers the rest and reprices
    // on the new total — so 12 versions becomes 11 and the quantity follows.
    el.querySelectorAll('.pq-vdel').forEach(btn => {
      btn.onclick = () => {
        const i = Number(btn.getAttribute('data-vi'));
        const names = (state.version_names || []).slice();
        const qtys = (state.version_quantities || []).slice();
        const n = Number(state.versions) || 1;
        if (n <= 1) return;                       // never delete the last one
        names.splice(i, 1);
        qtys.splice(i, 1);
        state.version_names = names;
        state.version_quantities = qtys;
        state.versions = n - 1;
        reprice();
      };
    });
    el.querySelectorAll('.pq-vq').forEach(inp => {
      inp.oninput = () => {
        const i = Number(inp.getAttribute('data-vi'));
        state.version_quantities = state.version_quantities || [];
        state.version_quantities[i] = Number(inp.value) || 0;
        checkVersionSum();
      };
      // Reprice once the field settles — the total is the sum of the versions.
      inp.onchange = () => reprice();
    });
    checkVersionSum();
  }

  // The per-version quantities must add up to the ordered total, or production
  // gets a job that doesn't match what was priced.
  function checkVersionSum() {
    const note = el.querySelector('[data-vsum]');
    if (!note) return;
    const qs = Array.from(el.querySelectorAll('.pq-vq')).map(x => Number(x.value) || 0);
    if (!qs.length) { note.textContent = ''; return; }
    const sum = qs.reduce((a, b) => a + b, 0);
    const total = Number(state.quantity) || 0;
    note.className = 'pq-vers-note ' + (sum === total ? 'ok' : 'bad');
    note.textContent = sum === total
      ? (sum.toLocaleString() + ' pieces in total.')
      : (sum.toLocaleString() + ' in total — repricing…');
  }

  // Re-price this card for a newly pinned client, without touching what was
  // configured on it. Called when the conversation gets connected to a client.
  // The live figures, for the page's own copies (Saved, markers, the draft).
  el.__getState = function () { return JSON.parse(JSON.stringify(state)); };
  el.__setSaved = function (on) {
    el.__saved = !!on;
    const b = el.querySelector('.pq-savebtn');
    if (b) {
      b.classList.toggle('on', el.__saved);
      b.textContent = el.__saved ? '\u2713 Saved' : ((CTX.saveLabel && CTX.saveLabel(el)) || 'Save');
    }
  };

  el.__repriceForClient = async function (clientId, clientName) {
    if (!clientId || Number(state.client_id) === Number(clientId)) return;
    state.client_id = clientId;
    if (clientName) state.client_name = clientName;
    const card = el.querySelector('.pq-total');
    if (card) card.innerHTML = '<span class="pq-recalc">Recalculating…</span>';
    await reprice();
  };

  paint();
  return el;
}

  global.AxiomCards = {
    init: function (opts) {
      opts = opts || {};
      if (opts.getToken) CTX.getToken = opts.getToken;
      if (opts.ask) CTX.ask = opts.ask;
      if (opts.scroll) CTX.scroll = opts.scroll;
      if (opts.pinClient) CTX.pinClient = opts.pinClient;
      if (opts.addToCart) CTX.addToCart = opts.addToCart;
      if (opts.onCartAdd) CTX.onCartAdd = opts.onCartAdd;
      if (opts.onSave) CTX.onSave = opts.onSave;
      if (opts.saveLabel) CTX.saveLabel = opts.saveLabel;
      if (opts.onChange) CTX.onChange = opts.onChange;
    },
    priceCard:   function (d) { token = CTX.getToken(); return buildPriceCard(d); },
    jobCard:     function (d) { token = CTX.getToken(); return buildJobCard(d); },
    clientCard:  function (d) { token = CTX.getToken(); return buildClientCard(d); },
    clientPicks: function (d, o) { token = CTX.getToken(); return buildClientPicks(d, o); },
    optionPicks: function (d) { token = CTX.getToken(); return buildOptionPicks(d); },
    choicePicks: function (d) { token = CTX.getToken(); return buildChoicePicks(d); },
    turnaround:  function (d) { token = CTX.getToken(); return buildTurnaround(d); },
    productCards:function (d, o) { token = CTX.getToken(); return buildProductCards(d, o); },
    picks:       function (d, o) { token = CTX.getToken(); return buildPicks(d, o); },
    rating:      function (id, r) { token = CTX.getToken(); return buildRating(id, r); },
    esc: esc,
    // Reprice every card on screen for a client that has just been pinned.
    repriceAllForClient: function (clientId, clientName) {
      document.querySelectorAll('.pq-card').forEach(c => {
        if (typeof c.__repriceForClient === 'function') c.__repriceForClient(clientId, clientName);
      });
    }
  };
})(window);
