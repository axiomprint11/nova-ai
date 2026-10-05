/**
 * Nova for clients — website loader. Paste into the <head> of axiomprint.com:
 *
 *   <script>
 *     window.NovaClientChat = {
 *       testKey: 'the CLIENT_BOT_TEST_KEY value',  // lets ?nova=test sessions in while Nova is in Test
 *       tokenKey: 'axiom-print-app',               // where the site keeps the customer's login
 *       // Optional: onCartChanged: () => {}       // after Nova added something to the cart
 *       // Optional — phones: the chat bar sits at the very bottom and moves the
 *       // site's own sticky bars (Add to Cart) up above it. lift: false turns that
 *       // off; liftSelector: '.sticky-cart' adds elements it misses.
 *     };
 *   </script>
 *   <script src="https://nova.axiomprint.com/client-embed.js" defer></script>
 *
 * Desktop: an "Ask Nova" button in the corner. Phone (under 700px): a full-width
 * bar fixed to the bottom — tap to chat, and the chat opens full screen.
 *
 * Test / Live is switched in Nova (Client ChatBot -> Setup), not here:
 *   Live — everyone sees the chat.
 *   Test — only browsers that opened any page with ?nova=test once (remembered;
 *          ?nova=off forgets it). Keep testKey in the snippet; it is what lets
 *          those test sessions in, and it does no harm when live.
 */
(function () {
  if (window.__novaClientLoaded) return;
  window.__novaClientLoaded = true;

  var CFG = window.NovaClientChat || {};
  var me = document.currentScript || document.querySelector('script[src*="client-embed.js"]');
  var HOST = (function () { try { return new URL(me.src).origin; } catch (e) { return 'https://nova.axiomprint.com'; } })();
  var SIDE = CFG.position === 'left' ? 'left' : 'right';
  var TEST_FLAG = 'novaClientTest';

  // ---- Test / Live (set in Nova: Client ChatBot -> Setup) ----
  // Live: everyone sees the chat. Test: only browsers that opened a page with
  // ?nova=test once (remembered; ?nova=off forgets it).
  var tester = false;
  try {
    var q = new URLSearchParams(location.search).get('nova');
    if (q === 'test') localStorage.setItem(TEST_FLAG, '1');
    if (q === 'off') localStorage.removeItem(TEST_FLAG);
    tester = localStorage.getItem(TEST_FLAG) === '1';
  } catch (e) {}

  function txt(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function el(tag, css) { var n = document.createElement(tag); n.style.cssText = css; return n; }
  function small() { return window.innerWidth < 700; }
  // The AI sparkle: NovaAI is an AI assistant, and the button says so.
  var CHAT_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 2Q10.9 8.1 17 9Q10.9 9.9 10 16Q9.1 9.9 3 9Q9.1 8.1 10 2Z"/><path d="M18 13Q18.4 15.6 21 16Q18.4 16.4 18 19Q17.6 16.4 15 16Q17.6 15.6 18 13Z"/><circle cx="5" cy="19" r="1.4"/></svg>';
  // Below the site's own pop-ups (menus, cart drawers), above the page.
  var Z = parseInt(CFG.zIndex) || 999;

  function boot() {
    // Desktop: a pill in the corner.
    var bubble = el('button',
      'position:fixed;' + SIDE + ':20px;bottom:20px;z-index:' + Z + ';height:52px;padding:0 18px 0 14px;border:none;' +
      'border-radius:26px;cursor:pointer;display:none;align-items:center;gap:8px;color:#fff;font:600 15px/1 Inter,system-ui,sans-serif;' +
      'background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 8px 24px rgba(79,70,229,.35);');
    bubble.type = 'button';
    bubble.setAttribute('aria-label', 'Chat with NovaAI');
    bubble.innerHTML = CHAT_ICON + '<span>Ask NovaAI</span>';
    // After minimizing a conversation, the launchers say so: the chat is still there.
    var waiting = false;
    function label() {
      bubble.innerHTML = CHAT_ICON + '<span>' + (waiting ? 'Back to chat' : 'Ask NovaAI') + '</span>' +
        (waiting ? '<span style="width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 2px rgba(255,255,255,.6)"></span>' : '');
      bubble.setAttribute('aria-label', waiting ? 'Back to your NovaAI chat' : 'Chat with NovaAI');
      var t = bar.querySelector('b'); if (t) t.textContent = waiting ? 'Back to your chat' : (CFG.barTitle || 'Ask NovaAI');
    }

    // Phone: a full-width bar fixed to the bottom of the screen — tap to chat.
    // The site's own sticky bars (Add to Cart, Order now) are moved up above it.
    var bar = el('button',
      'position:fixed;left:0;right:0;bottom:0;z-index:' + Z + ';display:none;width:100%;margin:0;border:none;border-radius:0;cursor:pointer;' +
      'box-sizing:border-box;min-height:56px;padding:8px 14px calc(8px + env(safe-area-inset-bottom, 0px));align-items:center;gap:11px;text-align:left;' +
      'color:#fff;font:500 13px/1.25 Inter,system-ui,-apple-system,sans-serif;-webkit-tap-highlight-color:transparent;' +
      'background:linear-gradient(110deg,#4f46e5,#7c3aed);box-shadow:0 -4px 18px rgba(30,20,70,.18);');
    bar.type = 'button';
    bar.setAttribute('aria-label', 'Chat with NovaAI');
    bar.innerHTML =
      '<span style="flex:none;width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center">' + CHAT_ICON + '</span>' +
      '<span style="flex:1;min-width:0"><b style="display:block;font-size:15px;font-weight:700">' + txt(CFG.barTitle || 'Ask NovaAI') + '</b>' +
      '<span style="display:block;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + txt(CFG.barText || 'Prices, options, files & your orders') + '</span></span>' +
      '<span style="flex:none;padding:8px 14px;border-radius:999px;background:#fff;color:#4f46e5;font-weight:700;font-size:13px">Chat ›</span>';

    var panel = el('div', 'position:fixed;z-index:2147483001;display:none;background:#fff;overflow:hidden;' +
      'box-shadow:0 18px 50px rgba(30,20,70,.28);border:1px solid #e4e4ef;');
    var isOpen = false;
    // Desktop: the window can be dragged by its title bar and stays where it was
    // left (remembered in this browser). Double-click the title bar to put it back.
    // Like a desktop window: it can be moved partly off the screen, but a strip of the
    // title bar always stays reachable so it can be pulled back. It can also be resized
    // from any edge or corner. Position and size are remembered in this browser.
    var POS_KEY = 'novaClientChatPos', pos = null;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { pos = null; }
    var MIN_W = 380, MIN_H = 420, KEEP = 100, TITLE = 56;
    function defW() { return Math.min(876, window.innerWidth - 40); }
    function defH() { return Math.min(620, window.innerHeight - 40); }
    function sizeW() { return Math.max(MIN_W, Math.min((pos && pos.w) || defW(), window.innerWidth)); }
    function sizeH() { return Math.max(MIN_H, Math.min((pos && pos.h) || defH(), window.innerHeight)); }
    function clampPos(l, t) {
      // At least KEEP px of the draggable title area (left part of the top bar) stays on screen.
      var hw = (handle && handle.offsetWidth) || 300;
      return { left: Math.max(Math.min(0, KEEP - hw), Math.min(l, window.innerWidth - KEEP)),
               top: Math.max(0, Math.min(t, window.innerHeight - TITLE)) };
    }
    function save() { try { if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (x) {} }
    function place() {
      if (small()) {
        // Fit the visible area, so the phone keyboard never covers the message box.
        var vv = window.visualViewport;
        panel.style.left = '0'; panel.style.right = '0'; panel.style.width = '100%'; panel.style.bottom = 'auto';
        panel.style.top = (vv ? vv.offsetTop : 0) + 'px';
        panel.style.height = (vv ? vv.height : window.innerHeight) + 'px';
        panel.style.borderRadius = '0'; panel.style.border = '0';
      } else {
        panel.style.top = 'auto'; panel.style.left = SIDE === 'left' ? '20px' : 'auto';
        panel.style.right = SIDE === 'right' ? '20px' : 'auto'; panel.style.bottom = '20px';
        panel.style.width = sizeW() + 'px';
        panel.style.height = sizeH() + 'px';
        panel.style.borderRadius = '16px'; panel.style.border = '1px solid #e4e4ef';
        if (pos && pos.left != null) {
          var p = clampPos(pos.left, pos.top);
          panel.style.left = p.left + 'px'; panel.style.top = p.top + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
        }
      }
      if (handle) handle.style.display = small() ? 'none' : 'block';
      grips.forEach(function (g) { g.style.display = small() ? 'none' : 'block'; });
    }
    // The drag handle covers the title area of the chat's top bar (the chat tells us
    // how wide that is, so its buttons stay clickable).
    var handle = el('div', 'position:absolute;left:0;top:0;width:0;height:0;z-index:2;cursor:move;background:transparent;touch-action:none;');
    handle.title = 'Drag to move \u00b7 double-click to put it back';
    var drag = null;
    handle.addEventListener('pointerdown', function (e) {
      if (small() || e.button !== 0) return;
      e.preventDefault();
      var r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { handle.setPointerCapture(e.pointerId); } catch (x) {}
      document.documentElement.style.userSelect = 'none';
    });
    handle.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var p = clampPos(e.clientX - drag.dx, e.clientY - drag.dy);
      panel.style.left = p.left + 'px'; panel.style.top = p.top + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
      pos = { left: p.left, top: p.top, w: panel.offsetWidth, h: panel.offsetHeight };
    });
    function endDrag() {
      if (!drag) return;
      drag = null; document.documentElement.style.userSelect = '';
      save();
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('dblclick', function () {
      pos = null; try { localStorage.removeItem(POS_KEY); } catch (x) {}
      place();
    });
    // Resize grips on every edge and corner (thin strips over the frame's border).
    var EDGES = { n: 'top:-3px;left:12px;right:12px;height:8px;cursor:ns-resize;', s: 'bottom:-3px;left:12px;right:12px;height:8px;cursor:ns-resize;',
      e: 'right:-3px;top:12px;bottom:12px;width:8px;cursor:ew-resize;', w: 'left:-3px;top:12px;bottom:12px;width:8px;cursor:ew-resize;',
      ne: 'top:-3px;right:-3px;width:16px;height:16px;cursor:nesw-resize;', nw: 'top:-3px;left:-3px;width:16px;height:16px;cursor:nwse-resize;',
      se: 'bottom:-3px;right:-3px;width:16px;height:16px;cursor:nwse-resize;', sw: 'bottom:-3px;left:-3px;width:16px;height:16px;cursor:nesw-resize;' };
    var grips = [], rs = null;
    Object.keys(EDGES).forEach(function (k) {
      var g = el('div', 'position:absolute;z-index:3;background:transparent;touch-action:none;' + EDGES[k]);
      g.setAttribute('data-edge', k);
      g.addEventListener('pointerdown', function (e) {
        if (small() || e.button !== 0) return;
        e.preventDefault();
        var r = panel.getBoundingClientRect();
        rs = { k: k, x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
        try { g.setPointerCapture(e.pointerId); } catch (x) {}
        document.documentElement.style.userSelect = 'none';
        frame.style.pointerEvents = 'none';
      });
      g.addEventListener('pointermove', function (e) {
        if (!rs || rs.k !== k) return;
        var dx = e.clientX - rs.x, dy = e.clientY - rs.y, l = rs.l, t = rs.t, w = rs.w, h = rs.h;
        if (k.indexOf('e') > -1) w = rs.w + dx;
        if (k.indexOf('s') > -1) h = rs.h + dy;
        if (k.indexOf('w') > -1) { w = rs.w - dx; }
        if (k.indexOf('n') > -1) { h = rs.h - dy; }
        w = Math.max(MIN_W, Math.min(w, window.innerWidth)); h = Math.max(MIN_H, Math.min(h, window.innerHeight));
        if (k.indexOf('w') > -1) l = rs.l + rs.w - w;
        if (k.indexOf('n') > -1) { t = Math.max(0, rs.t + rs.h - h); h = rs.t + rs.h - t; }
        panel.style.width = w + 'px'; panel.style.height = h + 'px';
        panel.style.left = l + 'px'; panel.style.top = t + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
        pos = { left: l, top: t, w: w, h: h };
      });
      function endResize() {
        if (!rs) return;
        rs = null; document.documentElement.style.userSelect = ''; frame.style.pointerEvents = '';
        save();
      }
      g.addEventListener('pointerup', endResize);
      g.addEventListener('pointercancel', endResize);
      grips.push(g);
    });
    var frame = document.createElement('iframe');
    frame.title = 'NovaAI — AxiomPrint AI assistant';
    frame.setAttribute('allow', 'clipboard-write; microphone');   // microphone: speech to text
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    var loaded = false;

    // ---- the page behind the chat on a phone: no scrolling while it is open ----
    var saved = null;
    function lockPage(on) {
      var h = document.documentElement, b = document.body;
      if (on && !saved) { saved = [h.style.overflow, b.style.overflow]; h.style.overflow = 'hidden'; b.style.overflow = 'hidden'; }
      if (!on && saved) { h.style.overflow = saved[0]; b.style.overflow = saved[1]; saved = null; }
    }

    function open() {
      if (!loaded) {
        frame.src = HOST + '/client-chat' + (CFG.testKey ? '?k=' + encodeURIComponent(CFG.testKey) : '');
        loaded = true;
      }
      isOpen = true;
      place(); panel.style.display = 'block';
      launcher();
      lockPage(small());
    }
    function close() { isOpen = false; panel.style.display = 'none'; lockPage(false); label(); launcher(); }

    // ---- which launcher shows ----
    function launcher() {
      var phone = small();
      bubble.style.display = !isOpen && !phone ? 'flex' : 'none';
      bar.style.display = !isOpen && phone ? 'flex' : 'none';
      if (phone && !isOpen) lift(); else unlift();
    }

    // ---- making room for the bar ----
    // Anything the site pins to the bottom of the screen (a sticky "Add to Cart"
    // bar, a cookie notice) is moved up by the bar's height, and the page gets
    // that much extra space at the end. Big overlays (menus, drawers) are left
    // alone — they open above the bar. Turn off with lift: false; add elements the
    // check misses with liftSelector: '.my-sticky-bar'.
    var lifted = [];                     // [element, original inline bottom, original priority]
    var bodyPad = null;
    function isPinned(n) {
      var cs = getComputedStyle(n);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      var r = n.getBoundingClientRect();
      return r.height > 0 && r.height < window.innerHeight * 0.5 && r.bottom >= window.innerHeight - 3 && r.top > window.innerHeight * 0.4;
    }
    function raise(n, by) {
      if (n === bar || n === panel || n === bubble || lifted.some(function (x) { return x[0] === n; })) return;
      var cs = getComputedStyle(n);
      var cur = parseFloat(cs.bottom); if (!isFinite(cur)) cur = 0;
      var want = (cur + by) + 'px';
      lifted.push([n, n.style.getPropertyValue('bottom'), n.style.getPropertyPriority('bottom'), want]);
      n.style.setProperty('bottom', want, 'important');
      n.setAttribute('data-nova-lifted', '1');
    }
    function lift() {
      if (CFG.lift === false || bar.style.display === 'none') return;
      var H = bar.getBoundingClientRect().height || 56;
      // The site may redraw a bar we moved (resetting its style) or remove it.
      lifted = lifted.filter(function (x) { return document.documentElement.contains(x[0]); });
      lifted.forEach(function (x) { if (x[0].style.getPropertyValue('bottom') !== x[3]) x[0].style.setProperty('bottom', x[3], 'important'); });
      var y = window.innerHeight - Math.max(4, Math.min(20, H / 3));
      [0.08, 0.3, 0.5, 0.7, 0.92].forEach(function (f) {
        var list = document.elementsFromPoint ? document.elementsFromPoint(window.innerWidth * f, y) : [];
        list.forEach(function (n) {
          for (var p = n; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
            if (p === bar) return;
            if (isPinned(p)) { raise(p, H); return; }
          }
        });
      });
      if (CFG.liftSelector) {
        try { document.querySelectorAll(CFG.liftSelector).forEach(function (n) { raise(n, H); }); } catch (e) {}
      }
      if (bodyPad === null) {
        bodyPad = document.body.style.paddingBottom || '';
        var base = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
        document.body.style.paddingBottom = (base + H) + 'px';
      }
    }
    function unlift() {
      lifted.forEach(function (x) {
        if (x[1]) x[0].style.setProperty('bottom', x[1], x[2]); else x[0].style.removeProperty('bottom');
        x[0].removeAttribute('data-nova-lifted');
      });
      lifted = [];
      if (bodyPad !== null) { document.body.style.paddingBottom = bodyPad; bodyPad = null; }
    }
    // Sticky bars often appear only after scrolling or once the page app has drawn.
    var lt = null;
    function later() { clearTimeout(lt); lt = setTimeout(function () { if (small() && !isOpen) lift(); }, 250); }
    window.addEventListener('scroll', later, { passive: true });
    if (window.MutationObserver) new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
    [600, 1500, 3500].forEach(function (t) { setTimeout(later, t); });

    panel.appendChild(frame);
    panel.appendChild(handle);
    grips.forEach(function (g) { panel.appendChild(g); });
    bubble.onclick = open;
    bar.onclick = open;
    document.body.appendChild(bubble);
    document.body.appendChild(bar);
    document.body.appendChild(panel);
    launcher();
    // Lifting is measured for one layout: redo it when the width changes (rotation,
    // desktop resize). A phone's address bar showing / hiding changes only the
    // height — then the bars just get re-checked, so nothing jumps.
    var lastW = window.innerWidth;
    window.addEventListener('resize', function () {
      if (window.innerWidth !== lastW) { lastW = window.innerWidth; unlift(); launcher(); }
      else later();
      if (isOpen) { place(); lockPage(small()); }
    });
    if (window.visualViewport) {
      var fit = function () { if (isOpen && small()) place(); };
      window.visualViewport.addEventListener('resize', fit);
      window.visualViewport.addEventListener('scroll', fit);
    }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) close(); });

    function say(msg) { try { frame.contentWindow.postMessage(msg, HOST); } catch (e) {} }
    // The page the customer is on, for the team's transcript (sent again when it
    // changes, including single-page navigation). Query values that could be
    // secrets are dropped here, and again on Nova's server.
    var lastPage = null;
    function pageNow() {
      try {
        var u = new URL(location.href);
        Array.from(u.searchParams.keys()).forEach(function (k) { if (/token|pass|secret|auth|key|sig|session|code|^k$/i.test(k)) u.searchParams.delete(k); });
        return u.toString().slice(0, 500);
      } catch (e) { return null; }
    }
    // How the visitor reached the site: the first page of this visit (tab session) with the site
    // that sent them (referrer) and any campaign tags (UTM, ad click ids) — and their very first
    // visit in this browser. Sent to the chat so the team sees "came from Google / ChatGPT / Yelp".
    var VISIT_TAGS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'gbraid', 'wbraid',
      'gad_source', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid', 'srsltid', 'yclid', 'ref', 'source'];
    function sameSite(u) { try { return /(^|\.)axiomprint\.com$/i.test(new URL(u).hostname); } catch (e) { return false; } }
    function readVisit() {
      var tags = {};
      try { var q = new URL(location.href).searchParams; VISIT_TAGS.forEach(function (k) { var v = q.get(k); if (v) tags[k] = String(v).slice(0, 120); }); } catch (e) {}
      var ref = document.referrer && !sameSite(document.referrer) ? String(document.referrer).slice(0, 300) : '';
      return { landing: pageNow(), referrer: ref, tags: tags, at: new Date().toISOString() };
    }
    var visit = null, firstVisit = null;
    try { visit = JSON.parse(sessionStorage.getItem('novaClientVisit') || 'null'); } catch (e) { visit = null; }
    if (!visit) { visit = readVisit(); try { sessionStorage.setItem('novaClientVisit', JSON.stringify(visit)); } catch (e) {} }
    try { firstVisit = JSON.parse(localStorage.getItem('novaClientFirstVisit') || 'null'); } catch (e) { firstVisit = null; }
    if (!firstVisit || !(Date.now() - new Date(firstVisit.at).getTime() < 180 * 864e5)) {
      firstVisit = visit; try { localStorage.setItem('novaClientFirstVisit', JSON.stringify(firstVisit)); } catch (e) {}
    }
    function sayPage(force) {
      if (!loaded) return;
      var url = pageNow();
      if (!url || (!force && url === lastPage)) return;
      lastPage = url;
      say({ type: 'nova-client:page', url: url, title: String(document.title || '').slice(0, 150), visit: visit, first: firstVisit });
    }
    setInterval(function () { sayPage(false); }, 1500);
    window.addEventListener('popstate', function () { setTimeout(function () { sayPage(false); }, 50); });
    window.addEventListener('hashchange', function () { sayPage(false); });
    function val(v) { try { return typeof v === 'function' ? v() : v; } catch (e) { return null; } }
    // The customer's login token. The website keeps it under tokenKey
    // ('axiom-print-app'), usually as saved app state (JSON) with the token inside.
    function dig(o, depth) {
      if (!o || typeof o !== 'object' || depth > 5) return null;
      var names = ['access_token', 'accessToken', 'token', 'authToken', 'auth_token', 'bearer', 'jwt'];
      for (var i = 0; i < names.length; i++) {
        var x = o[names[i]];
        if (typeof x === 'string' && x.length > 15) return x;
      }
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) { var r = dig(o[k], depth + 1); if (r) return r; }
      }
      return null;
    }
    function tokenFrom(v) {
      if (!v) return null;
      v = String(v).trim();
      if (/^[\[{"]/.test(v)) {
        try {
          var j = JSON.parse(v);
          if (typeof j === 'string') return j.length > 15 ? j : null;
          return dig(j, 0);
        } catch (e) { return null; }
      }
      return v.length > 15 ? v : null;
    }
    function findToken() {
      var t = val(CFG.customerToken);
      if (t) return tokenFrom(t);
      if (CFG.customerToken === false) return null;
      var keys = [CFG.tokenKey, 'axiom-print-app', 'customer_token', 'access_token', 'token', 'auth_token'].filter(Boolean);
      for (var i = 0; i < keys.length; i++) {
        try {
          var found = tokenFrom(localStorage.getItem(keys[i])) || tokenFrom(sessionStorage.getItem(keys[i]));
          if (found) return found;
        } catch (e) {}
      }
      return null;
    }

    window.addEventListener('message', function (ev) {
      if (ev.origin !== HOST || !ev.data || typeof ev.data !== 'object') return;
      var d = ev.data;
      if (d.type === 'nova-client:ready') {
        // Who is signed in: a signed handoff from the website server, else the
        // customer's API token, else nobody (products and prices only).
        var s = val(CFG.signin);
        var tok = s && s.payload ? null : findToken();
        if (s && s.payload && s.sig) say({ type: 'nova-client:signin', payload: s.payload, sig: s.sig });
        else if (tok) say({ type: 'nova-client:signin', customer_token: tok });
        else say({ type: 'nova-client:signout' });
        lastTok = tok || null;
        // The website can sign a customer in from the chat's own form.
        if (CFG.loginUrl) say({ type: 'nova-client:login-url', url: String(CFG.loginUrl) });
        if (typeof CFG.login === 'function') say({ type: 'nova-client:login-ready' });
        if (typeof CFG.addToCart === 'function') say({ type: 'nova-client:cart-ready' });
        sayPage(true);
      }
      if (d.type === 'nova-client:close') { waiting = !!d.active; close(); }
      if (d.type === 'nova-client:drag-area') {
        handle.style.width = Math.max(0, Math.min(Number(d.w) || 0, 2000)) + 'px';
        handle.style.height = Math.max(0, Math.min(Number(d.h) || 0, 200)) + 'px';
        return;
      }
      // Sign in from the chat, form version: the site's own login function does it
      // (and signs the website in too). The password goes from the chat to this
      // page only, then to the site's login — never to Nova.
      if (d.type === 'nova-client:login' && typeof CFG.login === 'function') {
        Promise.resolve().then(function () { return CFG.login(String(d.email || ''), String(d.password || '')); })
          .then(function (r) {
            var t = (r && typeof r === 'object' ? (r.token || r.access_token || r.customer_token) : (typeof r === 'string' ? r : null)) || findToken();
            if (!t) throw new Error('Sign-in did not complete.');
            lastTok = t;
            say({ type: 'nova-client:signin', customer_token: t });
            say({ type: 'nova-client:login-result', id: d.id, ok: true });
          }, function (e) { throw e; })
          .catch(function (e) {
            say({ type: 'nova-client:login-result', id: d.id, ok: false,
                  error: (e && e.message && e.message.length < 160) ? e.message : 'That email and password did not match.' });
          });
        return;
      }
      // Sign in from the chat, website version: open the site's login; once the
      // site has a login token, the chat is signed in by itself.
      if (d.type === 'nova-client:open-login') {
        // The chat opens the login window itself, inside the click. Only if the
        // browser refused that do we try here — and failing that, go to the login page.
        var url = CFG.loginUrl || 'https://axiomprint.com/login';
        if (!d.opened) {
          try { loginWin = window.open(url, 'novaLogin', 'width=480,height=720'); } catch (e) { loginWin = null; }
          if (!loginWin) { location.href = url; return; }
        }
        watchUntil = Date.now() + 10 * 60 * 1000;
        return;
      }
      // Nova already put it in the cart: the site refreshes its cart count
      // (its own listener does that; onCartChanged is an optional extra hook).
      if (d.type === 'nova-client:add-to-cart' && d.item && d.item.alreadyAdded) {
        if (typeof CFG.onCartChanged === 'function') { try { CFG.onCartChanged(); } catch (e) {} }
        return;
      }
      if (d.type === 'nova-client:add-to-cart' && typeof CFG.addToCart === 'function') {
        Promise.resolve().then(function () { return CFG.addToCart(d.item); })
          .then(function (r) { say({ type: 'nova-client:cart-result', id: d.id, ok: r !== false }); },
                function () { say({ type: 'nova-client:cart-result', id: d.id, ok: false }); });
      }
    });

    // ---- following the website's login ----
    // A sign-in (or sign-out) in another tab, the login window, or the page itself
    // reaches the chat without a page refresh.
    var lastTok = null, loginWin = null, watchUntil = 0;
    function followLogin() {
      if (!loaded) return;
      var t = findToken();
      if (t && t !== lastTok) {
        lastTok = t;
        say({ type: 'nova-client:signin', customer_token: t });
        try { if (loginWin && !loginWin.closed) loginWin.close(); } catch (e) {}
        if (typeof CFG.onSignedIn === 'function') { try { CFG.onSignedIn(); } catch (e) {} }
      } else if (!t && lastTok) {
        lastTok = null;
        say({ type: 'nova-client:signout' });
      }
    }
    window.addEventListener('storage', followLogin);
    setInterval(function () { if (isOpen || Date.now() < watchUntil) followLogin(); }, 2500);

    // For the site: NovaClientChatAPI.open() from a "Chat with us" link;
    // refresh() after the page moves its own sticky bar around.
    window.NovaClientChatAPI = { open: open, close: close, refresh: function () { unlift(); launcher(); },
      // After the website signs a customer in or out, so the chat follows at once.
      loginChanged: followLogin };
  }

  function start() {
    fetch(HOST + '/api/client-bot/mode', { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.mode === 'live' || (j.mode === 'test' && tester)) boot(); })
      .catch(function () { if (tester) boot(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
