// Admin console for the customer-facing bot: Try it · Conversations · Training · Setup.
(function () {
  'use strict';
  const token = localStorage.getItem('axiom_token');
  if (!token) { location.href = '/'; return; }
  const H = () => ({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);
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

  // ---- Try it ----
  let asCustomer = null;
  let greeting = null;
  const chat = ClientChat.mount($('chatHost'), {
    getToken: () => token,
    extraBody: () => ({ as_customer_id: asCustomer ? asCustomer.id : null }),
    hint: 'Admin preview — saved under Conversations as "Admin preview". Add to Cart opens the product page here; on the website it adds to the cart.',
    addToCart: async () => false,        // no website cart in the preview: open the product with its options
    suggestions: [['Business card prices', 'How much are 500 business cards?'], ['Banner options', 'What banner materials do you have?'],
                  ['Where is my order?', 'Where is my latest order?']],
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

  async function loadConvos() {
    const p = new URLSearchParams();
    if (src === 'website' || src === 'preview') p.set('source', src);
    if (src === 'signed') p.set('signed', '1');
    if ($('convQ').value.trim()) p.set('q', $('convQ').value.trim());
    const j = await fetch('/api/admin/client-bot/chats?' + p, { headers: H() }).then(r => r.json()).catch(() => ({}));
    const rows = (j && j.chats) || [];
    const box = $('convRows');
    if (!rows.length) { box.innerHTML = '<div class="cb-empty">No conversations yet.</div>'; return; }
    box.innerHTML = '';
    rows.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cb-row' + (c.id === openId ? ' on' : '');
      b.innerHTML = '<div class="t">' + esc(c.customer_name || (c.customer_id ? 'Customer #' + c.customer_id : 'Visitor (not signed in)')) +
        '<span class="cb-tag ' + (c.source === 'website' ? 'web' : 'pre') + '">' + (c.source === 'website' ? 'Website' : 'Preview') + '</span></div>' +
        '<small>' + esc([c.company, c.customer_email].filter(Boolean).join(' · ')) + '</small>' +
        '<small>' + esc(c.last_message || c.title || '') + '</small>' +
        '<small>' + esc(when(c.updated_at)) + ' · ' + (c.message_count || 0) + ' messages</small>';
      b.onclick = () => openConvo(c.id);
      box.appendChild(b);
    });
  }

  async function openConvo(id) {
    openId = id;
    document.querySelectorAll('#convRows .cb-row').forEach(x => x.classList.remove('on'));
    const j = await fetch('/api/admin/client-bot/chats/' + id, { headers: H() }).then(r => r.json()).catch(() => ({}));
    if (!j || !j.ok) return;
    const c = j.chat;
    $('convView').innerHTML =
      '<div class="cb-tr-hd"><b>' + esc(c.customer_name || (c.customer_id ? 'Customer #' + c.customer_id : 'Visitor (not signed in)')) + '</b>' +
        (c.company ? ' · ' + esc(c.company) : '') +
        '<small>' + [c.customer_email, c.customer_id ? 'customer #' + c.customer_id : null,
          c.source === 'website' ? 'on the website' : 'admin preview' + (c.preview_by ? ' by ' + String(c.preview_by).replace(/^(member|user):/, '') : ''),
          'started ' + when(c.created_at), c.ip ? 'IP ' + c.ip : null].filter(Boolean).map(esc).join(' · ') + '</small></div>' +
      j.messages.map(m =>
        '<div class="cb-msg ' + (m.role === 'user' ? 'user' : 'ai') + '">' +
          '<div class="bubble ' + (m.role === 'user' ? 'user' : 'ai') + '">' +
            (m.role === 'user' ? esc(m.content) : ClientChat.md(m.content || '') + (m.cards || []).map(ClientChat.card).join('')) + '</div>' +
          (m.tools && m.tools.length ? '<div class="cb-used">' + m.tools.map(t => '<span>' + esc(t.tool) + ' → ' + esc(t.found) + '</span>').join('') + '</div>' : '') +
          '<div class="when">' + esc(when(m.created_at)) + '</div>' +
        '</div>').join('');
    loadConvos();
  }

  // ---- Training ----
  async function loadTraining() {
    const j = await fetch('/api/admin/client-bot/rules', { headers: H() }).then(r => r.json()).catch(() => ({}));
    if (!j || !j.ok) return;
    $('tRules').value = j.rules.rules || '';
    $('tKnowledge').value = j.rules.knowledge || '';
    $('tGreeting').value = j.rules.greeting || '';
    $('tContact').value = j.rules.contact || '';
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
        $('tMsg').textContent = 'Loaded the version from ' + when(h.changed_at) + ' — Save to use it.';
      };
      $('tHist').appendChild(d);
    });
  }
  $('tSave').onclick = async () => {
    $('tMsg').textContent = 'Saving…';
    const j = await fetch('/api/admin/client-bot/rules', { method: 'POST', headers: H(), body: JSON.stringify({
      rules: $('tRules').value, knowledge: $('tKnowledge').value, greeting: $('tGreeting').value, contact: $('tContact').value
    }) }).then(r => r.json()).catch(() => ({}));
    $('tMsg').textContent = j && j.ok ? 'Saved — the next message uses it.' : 'Could not save.';
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
    $('setupBox').innerHTML =
      '<h2 style="margin-top:0">Status</h2>' +
      chk(true, 'Separate bot, rules, conversations and sign-in from the staff ChatBot.') +
      chk(o.public_on, o.public_on ? 'Open to website visitors (<code>CLIENT_BOT_PUBLIC=1</code>).' : 'Admins only. Visitors cannot use it until <code>CLIENT_BOT_PUBLIC=1</code> is set.') +
      chk(o.sso_secret, 'Website sign-in, signed handoff: ' + (o.sso_secret ? 'configured' : 'needs <code>CLIENT_SSO_SECRET</code>') + '.') +
      chk(o.verify_url, 'Website sign-in, customer token: ' + (o.verify_url ? 'configured' : 'needs <code>CUSTOMER_VERIFY_URL</code>') + ' (only one of the two is needed).') +
      '<p style="color:var(--muted)">Model: ' + esc(o.model || '') + ' · Conversations so far: ' + ((o.counts && o.counts.chats) || 0) + '</p>' +
      '<h2>How a customer is recognised</h2>' +
      '<p>The website tells Nova who is signed in; Nova checks it and looks the customer up in our database. The chat never takes a name, email or order number typed by the visitor as proof of who they are.</p>' +
      '<p><b>Option A — signed handoff (recommended).</b> The website’s server signs who is logged in with a shared secret, and the page passes it to the chat:</p>' +
      '<pre>// Laravel (website layout, when a customer is logged in)\n$p = base64_encode(json_encode([\n  \'customer_id\' => $customer->id,   // customer.id in axiomprint_new\n  \'email\'       => $customer->email,\n  \'name\'        => $customer->name,\n  \'ts\'          => time(),\n  \'nonce\'       => bin2hex(random_bytes(16)),   // single use\n]));\n$sig = hash_hmac(\'sha256\', $p, env(\'NOVA_CLIENT_SSO_SECRET\'));\n\n// page script, after the chat iframe loads\niframe.contentWindow.postMessage(\n  { type: \'nova-client:signin\', payload: \'{{ $p }}\', sig: \'{{ $sig }}\' },\n  \'https://nova.axiomprint.com\');</pre>' +
      '<p><b>Option B — customer token.</b> If the website keeps a customer API token in the browser, the page posts <code>{ type: \'nova-client:signin\', customer_token }</code> instead, and Nova asks <code>CUSTOMER_VERIFY_URL</code> (the website API’s "who am I" endpoint for customers) who it belongs to.</p>' +
      '<p>The chat page to embed is <code>https://nova.axiomprint.com/client-chat</code>. The full write-up is in <code>docs/CLIENT_BOT.md</code>.</p>';
  }
})();
