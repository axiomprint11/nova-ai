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
  var CHAT_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';
  // Below the site's own pop-ups (menus, cart drawers), above the page.
  var Z = parseInt(CFG.zIndex) || 999;

  function boot() {
    // Desktop: a pill in the corner.
    var bubble = el('button',
      'position:fixed;' + SIDE + ':20px;bottom:20px;z-index:' + Z + ';height:52px;padding:0 18px 0 14px;border:none;' +
      'border-radius:26px;cursor:pointer;display:none;align-items:center;gap:8px;color:#fff;font:600 15px/1 Inter,system-ui,sans-serif;' +
      'background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 8px 24px rgba(79,70,229,.35);');
    bubble.type = 'button';
    bubble.setAttribute('aria-label', 'Chat with Nova');
    bubble.innerHTML = CHAT_ICON + '<span>Ask Nova</span>';

    // Phone: a full-width bar fixed to the bottom of the screen — tap to chat.
    // The site's own sticky bars (Add to Cart, Order now) are moved up above it.
    var bar = el('button',
      'position:fixed;left:0;right:0;bottom:0;z-index:' + Z + ';display:none;width:100%;margin:0;border:none;border-radius:0;cursor:pointer;' +
      'box-sizing:border-box;min-height:56px;padding:8px 14px calc(8px + env(safe-area-inset-bottom, 0px));align-items:center;gap:11px;text-align:left;' +
      'color:#fff;font:500 13px/1.25 Inter,system-ui,-apple-system,sans-serif;-webkit-tap-highlight-color:transparent;' +
      'background:linear-gradient(110deg,#4f46e5,#7c3aed);box-shadow:0 -4px 18px rgba(30,20,70,.18);');
    bar.type = 'button';
    bar.setAttribute('aria-label', 'Chat with Nova');
    bar.innerHTML =
      '<span style="flex:none;width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center">' + CHAT_ICON + '</span>' +
      '<span style="flex:1;min-width:0"><b style="display:block;font-size:15px;font-weight:700">' + txt(CFG.barTitle || 'Ask Nova') + '</b>' +
      '<span style="display:block;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + txt(CFG.barText || 'Prices, options, files & your orders') + '</span></span>' +
      '<span style="flex:none;padding:8px 14px;border-radius:999px;background:#fff;color:#4f46e5;font-weight:700;font-size:13px">Chat ›</span>';

    var panel = el('div', 'position:fixed;z-index:2147483001;display:none;background:#fff;overflow:hidden;' +
      'box-shadow:0 18px 50px rgba(30,20,70,.28);border:1px solid #e4e4ef;');
    var isOpen = false;
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
        panel.style.width = Math.min(876, window.innerWidth - 40) + 'px';
        panel.style.height = Math.min(620, window.innerHeight - 40) + 'px';
        panel.style.borderRadius = '16px'; panel.style.border = '1px solid #e4e4ef';
      }
    }
    var frame = document.createElement('iframe');
    frame.title = 'Nova — AxiomPrint assistant';
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
    function close() { isOpen = false; panel.style.display = 'none'; lockPage(false); launcher(); }

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
      }
      if (d.type === 'nova-client:close') close();
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
