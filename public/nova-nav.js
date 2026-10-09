/**
 * NovaNav — the one left menu shared by Admin (/admin), TalkAi (/talk-ai) and Client ChatBot (/client-bot).
 *
 *   NovaNav.mount({ current: 'talk' })                                  // its own column on a full page
 *   NovaNav.mount({ current: 'history', into: asideEl, onTab: tab })    // admin.html: its tabs switch in place
 *   NovaNav.setActive('users');  NovaNav.set('talk', 3);  NovaNav.refresh();
 *
 * Three groups: the conversations (CRM Chat, Client ChatBot, TalkAi — each with its unread count), the setup
 * (Users, Domain Knowledge, Connectors), and pricing & files (Installation Pricing, Delivery Pricing and Templates,
 * the last two coming soon). Members see CRM Chat (their own chats) and Domain Knowledge when they have access.
 * Wide: a 224px column. 761–1100px: icons only. Phones: a strip across the top.
 */
(function () {
  const ICON = {
    history: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    client: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
    talk: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    knowledge: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    connections: '<path d="M9 7V2"/><path d="M15 7V2"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
    pricing: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>',
    delivery: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    templates: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
    chatbot: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>'
  };
  // [key, label, href, who] — who: 'all' (everyone), 'admin', 'knowledge' (members with Domain Knowledge access).
  const GROUPS = [
    [['history', 'CRM Chat', '/admin?tab=history', 'all'],
     ['client', 'Client ChatBot', '/client-bot', 'admin'],
     ['talk', 'TalkAi', '/talk-ai', 'admin']],
    [['users', 'Users', '/admin?tab=users', 'admin'],
     ['knowledge', 'Domain Knowledge', '/admin?tab=knowledge', 'knowledge'],
     ['connections', 'Connectors', '/admin?tab=connections', 'admin']],
    [['pricing', 'Installation Pricing', '/admin?tab=pricing', 'admin'],
     ['delivery', 'Delivery Pricing', null, 'admin'],
     ['templates', 'Templates', null, 'admin']]
  ];
  const UNREAD = {
    history: ['/api/crm/unread-count', 'conversations you have not opened'],
    client: ['/api/admin/client-bot/unread-count', 'unread client conversations'],
    talk: ['/api/admin/talk/unread-count', 'unread calls']
  };
  // Pages that are their own tab of admin.html (switch in place there, instead of reloading).
  const ADMIN_TABS = ['history', 'users', 'knowledge', 'connections', 'pricing'];

  const CSS = `
.nn { width: 224px; flex: none; display: flex; flex-direction: column; min-height: 0; background: #fcfcfe; border-right: 1px solid #ececf3;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; overflow-y: auto; }
.nn-logo { display: flex; align-items: center; gap: 2px; height: 56px; flex: none; padding: 0 20px; font-size: 16px; font-weight: 700; letter-spacing: -0.02em;
  color: #1e1b2e; text-decoration: none; }
.nn-logo span { background: linear-gradient(135deg, #6366f1, #8b5cf6); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; margin-left: 4px; }
.nn-groups { display: flex; flex-direction: column; padding: 4px 10px 12px; flex: 1; }
.nn-group { display: flex; flex-direction: column; gap: 2px; }
.nn-group + .nn-group { margin-top: 10px; padding-top: 10px; border-top: 1px solid #ececf3; }
.nn-group:empty { display: none; }
.nn-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; border: 0; background: none; text-decoration: none;
  font: 500 13.5px/1.25 inherit; color: #4b4869; cursor: pointer; text-align: left; width: 100%; position: relative; white-space: nowrap; }
.nn-item svg { width: 17px; height: 17px; flex: none; color: #8b88a3; }
.nn-item:hover { background: #f1f1f8; color: #1e1b2e; }
.nn-item:hover svg { color: #4b4869; }
.nn-item.on { background: #eef2ff; color: #4338ca; font-weight: 600; }
.nn-item.on svg { color: #4f46e5; }
.nn-item:focus-visible { outline: 2px solid #6366f1; outline-offset: 1px; }
.nn-item .nn-l { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.nn-item.soon { cursor: default; color: #a3a1b8; }
.nn-item.soon:hover { background: none; color: #a3a1b8; }
.nn-item.soon svg, .nn-item.soon:hover svg { color: #c4c2d4; }
.nn-soon { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #8b88a3; background: #f1f1f8; border-radius: 5px; padding: 2px 5px; }
.nn-n { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #2563eb; color: #fff; font-size: 11px; font-weight: 700;
  line-height: 20px; text-align: center; box-sizing: border-box; font-variant-numeric: tabular-nums; }
.nn-n[hidden] { display: none; }
.nn-foot { padding: 10px; border-top: 1px solid #ececf3; flex: none; }
.nn-foot .nn-item { color: #4f46e5; font-weight: 600; }
.nn-foot .nn-item svg { color: #6366f1; }
/* A full page (TalkAi, Client ChatBot): the menu, then the page as it was. */
body.nn-shell { flex-direction: row !important; }
.nn-page { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
/* Narrower screens: icons only, the label as a tooltip. */
@media (max-width: 1100px) and (min-width: 761px) {
  .nn { width: 60px; }
  .nn-logo { padding: 0; justify-content: center; font-size: 0; }
  .nn-logo span { font-size: 15px; margin: 0; }
  .nn-groups, .nn-foot { padding-left: 8px; padding-right: 8px; }
  .nn-item { justify-content: center; padding: 10px 0; }
  .nn-item .nn-l, .nn-soon { display: none; }
  .nn-n { position: absolute; top: 2px; right: 2px; min-width: 16px; height: 16px; line-height: 16px; font-size: 9.5px; padding: 0 4px; }
}
/* Phones: one strip across the top that scrolls sideways. */
@media (max-width: 760px) {
  body.nn-shell { flex-direction: column !important; }
  .nn { width: auto; flex-direction: row; align-items: center; border-right: 0; border-bottom: 1px solid #ececf3; overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .nn::-webkit-scrollbar { display: none; }
  .nn-logo { display: none; }
  .nn-groups { flex-direction: row; align-items: center; padding: 7px 8px; flex: none; }
  .nn-group { flex-direction: row; }
  .nn-group + .nn-group { margin: 0 0 0 6px; padding: 0 0 0 6px; border-top: 0; border-left: 1px solid #ececf3; }
  .nn-item { width: auto; padding: 7px 10px; font-size: 13px; gap: 7px; }
  .nn-item svg { width: 15px; height: 15px; }
  .nn-item.soon { display: none; }
  .nn-foot { border-top: 0; padding: 0 8px 0 0; }
}`;

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (k) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[k] + '</svg>';
  const token = () => { try { return localStorage.getItem('axiom_token') || ''; } catch (e) { return ''; } };
  let root = null, opts = {}, me = null, timer = null;

  function css() {
    if (document.getElementById('nn-css')) return;
    const s = document.createElement('style'); s.id = 'nn-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function allowed(who) {
    if (!me) return who === 'all';
    if (me.is_admin) return true;
    if (who === 'knowledge') return (me.knowledge_access || 'none') !== 'none';
    return who === 'all';
  }
  function render() {
    const groups = GROUPS.map(g => '<div class="nn-group">' + g.filter(it => allowed(it[3])).map(it => {
      const [key, label, href] = it;
      const inner = svg(key) + '<span class="nn-l">' + esc(label) + '</span>' +
        (href ? (UNREAD[key] ? '<b class="nn-n" data-n="' + key + '" hidden></b>' : '') : '<span class="nn-soon">Soon</span>');
      if (!href) return '<span class="nn-item soon" title="' + esc(label) + ' — coming soon" aria-disabled="true">' + inner + '</span>';
      return '<a class="nn-item" data-k="' + key + '" href="' + href + '" title="' + esc(label) + '">' + inner + '</a>';
    }).join('') + '</div>').join('');
    root.innerHTML = '<a class="nn-logo" href="/admin?tab=history&amp;mine=1" title="Axiom AI">Axiom<span>AI</span></a>' +
      '<nav class="nn-groups" aria-label="Nova">' + groups + '</nav>' +
      '<div class="nn-foot"><a class="nn-item" href="/chatbot" title="New chat in ChatBot">' + svg('chatbot') + '<span class="nn-l">New chat</span></a></div>';
    root.querySelectorAll('a.nn-item[data-k]').forEach(a => {
      a.onclick = (e) => {
        const k = a.dataset.k;
        if (!opts.onTab || ADMIN_TABS.indexOf(k) < 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        opts.onTab(k);
        try { history.replaceState(null, '', '/admin?tab=' + k); } catch (er) {}
      };
    });
    setActive(opts.current);
    Object.keys(counts).forEach(k => set(k, counts[k]));
  }
  function setActive(k) {
    opts.current = k;
    if (!root) return;
    root.querySelectorAll('a.nn-item[data-k]').forEach(a => {
      const on = a.dataset.k === k;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  const counts = {};
  function set(k, n) {
    n = Number(n) || 0; counts[k] = n;
    if (!root) return;
    const b = root.querySelector('[data-n="' + k + '"]');
    if (!b) return;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = n === 0;
    b.title = n + ' ' + UNREAD[k][1];
  }
  async function refresh() {
    const t = token();
    if (!t || !me) return;
    const keys = Object.keys(UNREAD).filter(k => k === 'history' ? me.is_admin : allowed('admin'));
    await Promise.all(keys.map(async k => {
      try {
        const r = await fetch(UNREAD[k][0], { headers: { 'Authorization': 'Bearer ' + t } });
        if (!r.ok) return;
        const j = await r.json();
        if (j && j.ok) set(k, j.unread);
      } catch (e) {}
    }));
  }
  async function loadMe() {
    const t = token();
    if (!t) return;
    try {
      const r = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + t } });
      const j = await r.json();
      if (j && j.success) { me = j; render(); refresh(); }
    } catch (e) {}
  }

  function mount(o) {
    opts = o || {};
    css();
    if (opts.into) {
      root = opts.into;
      root.classList.add('nn');
    } else {
      // A full page: move what the page drew into its own column, beside the menu.
      const page = document.createElement('div'); page.className = 'nn-page';
      Array.from(document.body.children).forEach(el => { if (el.tagName !== 'SCRIPT' && !/^(nn|panel|modal)/.test(el.id || '') && getComputedStyle(el).position !== 'fixed') page.appendChild(el); });
      root = document.createElement('aside');
      root.className = 'nn';
      document.body.insertBefore(page, document.body.firstChild);
      document.body.insertBefore(root, page);
      document.body.classList.add('nn-shell');
    }
    render();
    loadMe();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
  window.NovaNav = { mount: mount, setActive: setActive, set: set, refresh: refresh, me: () => me };
})();
