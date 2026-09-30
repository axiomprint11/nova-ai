/**
 * Nova for clients — website loader. Paste into the <head> of axiomprint.com:
 *
 *   <script>
 *     window.NovaClientChat = {
 *       testKey: 'the CLIENT_BOT_TEST_KEY value',  // test mode only — remove when going live
 *       // Optional — who is signed in (see docs/CLIENT_BOT.md):
 *       // signin: { payload: '…', sig: '…' },    // signed by the website server
 *       // customerToken: () => localStorage.getItem('token'),
 *       // Optional — let Add to Cart put the item in the real cart:
 *       // addToCart: (item) => Promise that resolves when it is in the cart
 *     };
 *   </script>
 *   <script src="https://nova.axiomprint.com/client-embed.js" defer></script>
 *
 * Test mode (testKey set): the bubble only appears after opening any page with
 * ?nova=test once (remembered in this browser; ?nova=off hides it again).
 * Without testKey the bubble shows for everyone — only do that once
 * CLIENT_BOT_PUBLIC=1 is set on the Nova server.
 */
(function () {
  if (window.__novaClientLoaded) return;
  window.__novaClientLoaded = true;

  var CFG = window.NovaClientChat || {};
  var me = document.currentScript || document.querySelector('script[src*="client-embed.js"]');
  var HOST = (function () { try { return new URL(me.src).origin; } catch (e) { return 'https://nova.axiomprint.com'; } })();
  var SIDE = CFG.position === 'left' ? 'left' : 'right';
  var TEST_FLAG = 'novaClientTest';

  // ---- test mode: show only for people who opened ?nova=test ----
  if (CFG.testKey) {
    try {
      var q = new URLSearchParams(location.search).get('nova');
      if (q === 'test') localStorage.setItem(TEST_FLAG, '1');
      if (q === 'off') localStorage.removeItem(TEST_FLAG);
      if (localStorage.getItem(TEST_FLAG) !== '1') return;
    } catch (e) { return; }
  }

  function el(tag, css) { var n = document.createElement(tag); n.style.cssText = css; return n; }
  function small() { return window.innerWidth < 700; }

  function boot() {
    var bubble = el('button',
      'position:fixed;' + SIDE + ':20px;bottom:20px;z-index:2147483000;height:52px;padding:0 18px 0 14px;border:none;' +
      'border-radius:26px;cursor:pointer;display:flex;align-items:center;gap:8px;color:#fff;font:600 15px/1 Inter,system-ui,sans-serif;' +
      'background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 8px 24px rgba(79,70,229,.35);');
    bubble.type = 'button';
    bubble.setAttribute('aria-label', 'Chat with Nova');
    bubble.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>' +
      '<span>Ask Nova</span>';

    var panel = el('div', 'position:fixed;z-index:2147483001;display:none;background:#fff;overflow:hidden;' +
      'box-shadow:0 18px 50px rgba(30,20,70,.28);border:1px solid #e4e4ef;');
    function place() {
      if (small()) {
        panel.style.cssText += ';top:0;left:0;right:0;bottom:0;width:auto;height:auto;border-radius:0;';
      } else {
        panel.style.top = 'auto'; panel.style.left = SIDE === 'left' ? '20px' : 'auto';
        panel.style.right = SIDE === 'right' ? '20px' : 'auto'; panel.style.bottom = '20px';
        panel.style.width = Math.min(1040, window.innerWidth - 40) + 'px';
        panel.style.height = Math.min(720, window.innerHeight - 40) + 'px';
        panel.style.borderRadius = '16px';
      }
    }
    var frame = document.createElement('iframe');
    frame.title = 'Nova — AxiomPrint assistant';
    frame.setAttribute('allow', 'clipboard-write');
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    var loaded = false;
    function open() {
      if (!loaded) {
        frame.src = HOST + '/client-chat' + (CFG.testKey ? '?k=' + encodeURIComponent(CFG.testKey) : '');
        loaded = true;
      }
      place(); panel.style.display = 'block'; bubble.style.display = 'none';
    }
    function close() { panel.style.display = 'none'; bubble.style.display = 'flex'; }
    panel.appendChild(frame);
    bubble.onclick = open;
    document.body.appendChild(bubble);
    document.body.appendChild(panel);
    window.addEventListener('resize', function () { if (panel.style.display === 'block') place(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.style.display === 'block') close(); });

    function say(msg) { try { frame.contentWindow.postMessage(msg, HOST); } catch (e) {} }
    function val(v) { try { return typeof v === 'function' ? v() : v; } catch (e) { return null; } }
    function findToken() {
      var t = val(CFG.customerToken);
      if (t) return String(t);
      if (CFG.customerToken === false) return null;
      var keys = [CFG.tokenKey, 'customer_token', 'access_token', 'token', 'auth_token'].filter(Boolean);
      for (var i = 0; i < keys.length; i++) {
        try {
          var v = localStorage.getItem(keys[i]);
          if (v && v.length > 15) return v.replace(/^"|"$/g, '');
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
        if (typeof CFG.addToCart === 'function') say({ type: 'nova-client:cart-ready' });
      }
      if (d.type === 'nova-client:close') close();
      if (d.type === 'nova-client:add-to-cart' && typeof CFG.addToCart === 'function') {
        Promise.resolve().then(function () { return CFG.addToCart(d.item); })
          .then(function (r) { say({ type: 'nova-client:cart-result', id: d.id, ok: r !== false }); },
                function () { say({ type: 'nova-client:cart-result', id: d.id, ok: false }); });
      }
    });

    // For the site: NovaClientChatAPI.open() from a "Chat with us" link.
    window.NovaClientChatAPI = { open: open, close: close };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
