/**
 * Nova ChatBot embed loader.
 *
 * Drop this one line into the <head> of any AxiomPrint site:
 *   <script src="https://nova.axiomprint.com/embed.js" defer></script>
 *
 * It injects a floating bubble that opens an iframe served by Nova. The iframe
 * runs on nova.axiomprint.com, so it reads the same login the team already has
 * and every API call inside it is a normal authenticated Nova request. Nothing
 * about this file grants access - the server decides that.
 *
 * Options (optional, set BEFORE the script tag):
 *   window.NovaChat = {
 *     position: 'right'|'left',   // which side the bubble sits on
 *     offset: 20,                 // distance from the side edge, px
 *     bottom: 20,                 // starting distance from the bottom, px
 *     scale: 1,                   // 1 = default; 0.9 = 10% smaller again
 *     hideWhenLoggedOut: true     // false on staff sites so people can sign in
 *   };
 *
 * The bubble can be DRAGGED up and down when it lands over something on the
 * host page. The chosen position is remembered in localStorage.
 */
(function () {
  if (window.__novaChatLoaded) return;
  window.__novaChatLoaded = true;

  var CFG = window.NovaChat || {};
  var HOST = 'https://nova.axiomprint.com';
  var SIDE = CFG.position === 'left' ? 'left' : 'right';
  var OFFSET = typeof CFG.offset === 'number' ? CFG.offset : 20;
  var SCALE = typeof CFG.scale === 'number' ? CFG.scale : 1;
  var HIDE_LOGGED_OUT = CFG.hideWhenLoggedOut !== false;

  // Bubble is 20% smaller than the original 56. The panel opens wide: it holds
  // the ChatBot page's two columns — chat on the left, calculator and cart on
  // the right. On a small screen it is capped to the window.
  var BUBBLE = Math.round(45 * SCALE);
  var PANEL_W = Math.round(1080 * SCALE);
  var PANEL_H = Math.round(700 * SCALE);
  var GAP = 10;

  var STORE_KEY = 'novaChatBottom';
  var DEFAULT_BOTTOM = typeof CFG.bottom === 'number' ? CFG.bottom : 20;
  var bottomPos = DEFAULT_BOTTOM;
  try {
    var saved = parseInt(localStorage.getItem(STORE_KEY), 10);
    if (!isNaN(saved)) bottomPos = saved;
  } catch (e) {}

  function clampBottom(v) {
    var max = Math.max(8, window.innerHeight - BUBBLE - 8);
    return Math.min(Math.max(8, v), max);
  }

  function el(tag, css) {
    var n = document.createElement(tag);
    n.style.cssText = css;
    return n;
  }

  function boot() {
    bottomPos = clampBottom(bottomPos);

    // ---- launcher bubble ----
    var bubble = el('button',
      'position:fixed;' + SIDE + ':' + OFFSET + 'px;bottom:' + bottomPos + 'px;z-index:2147483000;' +
      'width:' + BUBBLE + 'px;height:' + BUBBLE + 'px;border-radius:50%;border:none;cursor:pointer;' +
      'background:linear-gradient(135deg,#7C6FE0,#5B6EF5);color:#fff;line-height:1;' +
      'box-shadow:0 5px 18px rgba(80,66,190,.34);display:none;align-items:center;justify-content:center;' +
      'padding:0;transition:transform .15s ease,box-shadow .15s ease;font-family:inherit;touch-action:none;');
    bubble.type = 'button';
    bubble.title = 'Nova ChatBot \u2014 drag to move up or down';
    bubble.setAttribute('aria-label', 'Open Nova ChatBot');
    var ic = Math.round(BUBBLE * 0.46);
    bubble.innerHTML = '<svg width="' + ic + '" height="' + ic + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';

    // ---- panel that holds the iframe ----
    var panel = el('div',
      'position:fixed;' + SIDE + ':' + OFFSET + 'px;z-index:2147483000;' +
      'width:' + PANEL_W + 'px;height:' + PANEL_H + 'px;' +
      'max-width:calc(100vw - ' + (OFFSET * 2) + 'px);' +
      'border-radius:14px;overflow:hidden;background:#fff;border:1px solid #e4e4ef;' +
      'box-shadow:0 14px 44px rgba(30,20,70,.24);display:none;' +
      'opacity:0;transform:translateY(10px) scale(.985);transition:opacity .16s ease,transform .16s ease;');

    var frame = document.createElement('iframe');
    // Version the iframe URL with the current build. Without this the browser can
    // reuse a cached /widget document — the exact thing that made the CRM run an
    // old widget while nova.axiomprint.com showed the new one.
    var build = (window.__NOVA_BUILD || String(Date.now()));
    frame.src = HOST + '/widget?parent=' + encodeURIComponent(location.hostname) + '&b=' + encodeURIComponent(build);
    frame.title = 'Nova ChatBot';
    // Microphone must be delegated explicitly: a cross-origin iframe cannot use it
    // otherwise, no matter what permission the person has granted. The origin is
    // named so the grant applies to Nova, not to whatever else the page embeds.
    frame.setAttribute('allow', "microphone " + HOST + "; clipboard-write");
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff;';
    panel.appendChild(frame);

    // Panel sits just above the bubble, but never runs off the top of the screen.
    function positionPanel() {
      var want = bottomPos + BUBBLE + GAP;
      var maxBottom = Math.max(8, window.innerHeight - PANEL_H - 8);
      var b = Math.min(want, maxBottom);
      panel.style.bottom = b + 'px';
      panel.style.maxHeight = 'calc(100vh - ' + (b + 8) + 'px)';
    }

    function applyBubblePos() {
      bubble.style.bottom = bottomPos + 'px';
      positionPanel();
    }

    var open = false;
    function setOpen(v) {
      open = v;
      if (v) {
        positionPanel();
        panel.style.display = 'block';
        requestAnimationFrame(function () {
          panel.style.opacity = '1';
          panel.style.transform = 'translateY(0) scale(1)';
        });
        bubble.style.display = 'none';
        try { frame.contentWindow.postMessage({ type: 'nova:opened' }, HOST); } catch (e) {}
      } else {
        panel.style.opacity = '0';
        panel.style.transform = 'translateY(10px) scale(.985)';
        setTimeout(function () { if (!open) panel.style.display = 'none'; }, 170);
        bubble.style.display = 'flex';
      }
    }

    // ---- drag the bubble vertically ----
    // Pointer events cover mouse and touch. A 4px threshold means a normal click
    // still opens the chat rather than being mistaken for a drag.
    var dragging = false, moved = false, startY = 0, startBottom = 0;
    bubble.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false;
      startY = e.clientY;
      startBottom = bottomPos;
      try { bubble.setPointerCapture(e.pointerId); } catch (err) {}
      bubble.style.transition = 'none';
    });
    bubble.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = startY - e.clientY;          // dragging up increases bottom
      if (Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      bottomPos = clampBottom(startBottom + dy);
      bubble.style.bottom = bottomPos + 'px';
      bubble.style.cursor = 'grabbing';
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      bubble.style.transition = 'transform .15s ease,box-shadow .15s ease';
      bubble.style.cursor = 'pointer';
      try { bubble.releasePointerCapture(e.pointerId); } catch (err) {}
      if (moved) {
        try { localStorage.setItem(STORE_KEY, String(bottomPos)); } catch (err) {}
        positionPanel();
      } else {
        setOpen(true);
      }
    }
    bubble.addEventListener('pointerup', endDrag);
    bubble.addEventListener('pointercancel', function () { dragging = false; });

    bubble.onmouseenter = function () { if (!dragging) bubble.style.transform = 'scale(1.06)'; };
    bubble.onmouseleave = function () { bubble.style.transform = 'scale(1)'; };

    document.body.appendChild(bubble);
    document.body.appendChild(panel);
    applyBubblePos();

    window.addEventListener('resize', function () {
      bottomPos = clampBottom(bottomPos);
      applyBubblePos();
    });

    // ---- single sign-on ----
    // The CRM page already holds the person's API token. We read it here (same
    // origin as the CRM, so this is allowed) and hand it to the widget only when
    // the widget asks. Nova verifies it against the AxiomPrint API before
    // trusting it, so passing it is not the same as granting access.
    function findCrmToken() {
      var explicit = CFG.crmToken;
      if (typeof explicit === 'function') { try { explicit = explicit(); } catch (e) { explicit = null; } }
      if (explicit) return String(explicit);

      var keys = [];
      if (CFG.tokenKey) keys.push(CFG.tokenKey);
      // access_token first — confirmed as the CRM's key by the dev team.
      keys = keys.concat(['access_token', 'token', 'api_token', 'auth_token',
                          'authToken', 'accessToken', 'crm_token', 'user_token']);
      for (var i = 0; i < keys.length; i++) {
        var v = null;
        try { v = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i]); } catch (e) {}
        if (!v) continue;
        v = String(v).trim().replace(/^"|"$/g, '');
        // Some apps store the whole auth object rather than a bare string.
        if (v.charAt(0) === '{') {
          try {
            var obj = JSON.parse(v);
            v = obj.token || obj.access_token || obj.api_token || obj.accessToken || '';
          } catch (e) { v = ''; }
        }
        if (v && v.length > 15) return v;
      }
      return null;
    }

    // The widget tells us whether someone is signed in, when to close, and what
    // appearance settings the signed-in user has saved.
    window.addEventListener('message', function (ev) {
      if (ev.origin !== HOST || !ev.data || typeof ev.data !== 'object') return;
      if (ev.data.type === 'nova:close') setOpen(false);
      if (ev.data.type === 'nova:need-sso') {
        // A signed handoff from the CRM beats scraping storage: it works even when
        // the CRM authenticates by session cookie and there is no token to find.
        if (CFG.sso && CFG.sso.payload && CFG.sso.sig) {
          try {
            frame.contentWindow.postMessage(
              { type: 'nova:sso-handoff', payload: CFG.sso.payload, sig: CFG.sso.sig }, HOST);
          } catch (e) {}
          return;
        }
        var t = findCrmToken();
        // Report which storage keys exist, so a failure can be diagnosed without
        // guessing what this page calls its token.
        var seen = [];
        try {
          for (var i = 0; i < localStorage.length; i++) seen.push(localStorage.key(i));
        } catch (e) {}
        // A missing token now means "signed out", not just "not found" — the
        // widget uses this to end its own session.
        if (!t) console.log('[Nova] No CRM token found. Keys on this page:', seen.join(', ') ||
          '(none readable)', '- set window.NovaChat={tokenKey:"..."} to point at the right one.');
        try {
          frame.contentWindow.postMessage(
            { type: 'nova:sso-token', token: t || null, keys: t ? undefined : seen.slice(0, 40) }, HOST);
        } catch (e) {}
      }
      if (ev.data.type === 'nova:prefs' && ev.data.prefs) {
        var p = ev.data.prefs;
        var sc = Number(p.scale) || 1;
        BUBBLE = Math.round(45 * sc);
        PANEL_W = Math.round((Number(p.panelWidth) || 1080) * sc);
        PANEL_H = Math.round((Number(p.panelHeight) || 700) * sc);
        SIDE = p.side === 'left' ? 'left' : 'right';

        // Reset both edges before setting the active one, or a side switch would
        // leave the old edge pinned and the element stretched across the screen.
        bubble.style.left = ''; bubble.style.right = '';
        panel.style.left = ''; panel.style.right = '';
        bubble.style[SIDE] = OFFSET + 'px';
        panel.style[SIDE] = OFFSET + 'px';

        bubble.style.width = BUBBLE + 'px';
        bubble.style.height = BUBBLE + 'px';
        var svg = bubble.querySelector('svg');
        if (svg) {
          var s2 = Math.round(BUBBLE * 0.46);
          svg.setAttribute('width', s2); svg.setAttribute('height', s2);
        }
        panel.style.width = PANEL_W + 'px';
        panel.style.height = PANEL_H + 'px';
        panel.style.maxWidth = 'calc(100vw - ' + (OFFSET * 2) + 'px)';
        if (ev.data.accentColors) {
          bubble.style.background = 'linear-gradient(135deg,' + ev.data.accentColors.main + ',' + ev.data.accentColors.grad + ')';
        }
        bottomPos = clampBottom(bottomPos);
        applyBubblePos();
      }
      if (ev.data.type === 'nova:auth') {
        if (HIDE_LOGGED_OUT && !ev.data.signedIn) {
          if (!open) bubble.style.display = 'none';
        } else if (!open) {
          bubble.style.display = 'flex';
        }
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) setOpen(false);
    });

    if (!HIDE_LOGGED_OUT) bubble.style.display = 'flex';

    // Small API for the host page, e.g. an "Ask Nova" link in the CRM menu.
    window.NovaChatAPI = {
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      resetPosition: function () {
        bottomPos = clampBottom(DEFAULT_BOTTOM);
        try { localStorage.removeItem(STORE_KEY); } catch (e) {}
        applyBubblePos();
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
