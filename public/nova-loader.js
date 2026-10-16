/* nova-loader.js — 1.20.124. Two things every NovaAI page gets by loading this script before its own:
 *
 *  1. A progress bar at the top of the window while any /api request is in flight (window.fetch is wrapped;
 *     the bar appears after 180 ms so quick calls never flash, trickles while waiting, and finishes when the
 *     last request answers). NovaLoader.start() / NovaLoader.done() for anything that is not a fetch.
 *
 *  2. Lazy rows: a table that is drawn with more than FIRST rows keeps only the first FIRST visible — the rest
 *     stay in the DOM (so every click handler the page bound still works) but display: none, with a "showing
 *     120 of 4,632 · more as you scroll" row at the bottom; scrolling to it reveals the next CHUNK. A MutationObserver
 *     finds new tables by itself, so no page has to change. Typing in any text box, or printing, reveals everything
 *     (client-side searches that hide rows by style must see every row). <table data-nolazy> opts out.
 */
(function () {
  if (window.NovaLoader) return;
  const FIRST = 120, CHUNK = 160, MIN_ROWS = 170;

  /* ---- 1. the progress bar ---- */
  const css = document.createElement('style');
  css.textContent = '#nlBar{position:fixed;left:0;top:0;height:3px;width:0;background:linear-gradient(90deg,#4f46e5,#8b5cf6);z-index:100000;pointer-events:none;opacity:0;transition:width .25s ease,opacity .3s ease;box-shadow:0 0 8px rgba(99,102,241,.6)}' +
    '#nlBar.on{opacity:1}' +
    'tr.nl-hide{display:none!important}' +
    'tr.nl-more td{padding:10px 12px!important;font-size:12px;color:#6b7280;text-align:center;background:#fafafe}' +
    'tr.nl-more td a{color:#4f46e5;font-weight:600;text-decoration:none;margin-left:8px}';
  (document.head || document.documentElement).appendChild(css);
  let bar = null, inflight = 0, showT = null, trickleT = null, pct = 0;
  const el = () => { if (!bar) { bar = document.createElement('div'); bar.id = 'nlBar'; document.body.appendChild(bar); } return bar; };
  function show() {
    if (!document.body) return;
    const b = el(); pct = 12; b.style.width = pct + '%'; b.classList.add('on');
    clearInterval(trickleT);
    trickleT = setInterval(() => { pct += Math.max(0.3, (88 - pct) * 0.06); if (pct > 88) pct = 88; b.style.width = pct + '%'; }, 220);
  }
  function finish() {
    clearTimeout(showT); showT = null; clearInterval(trickleT);
    if (!bar || !bar.classList.contains('on')) return;
    bar.style.width = '100%';
    setTimeout(() => { if (inflight) return; bar.classList.remove('on'); setTimeout(() => { if (!inflight && bar) bar.style.width = '0'; }, 320); }, 180);
  }
  function start() { inflight++; if (inflight === 1 && !showT) showT = setTimeout(() => { showT = null; if (inflight) show(); }, 180); }
  function done() { inflight = Math.max(0, inflight - 1); if (!inflight) finish(); }
  const isApi = (u) => { try { const s = typeof u === 'string' ? u : (u && u.url) || ''; const p = s.startsWith('/') ? s : new URL(s, location.href).pathname; return /^\/api\//.test(p) && !/\/api\/(talk\/audio|chat-files|client-bot\/files|version|me)\b/.test(p) && !/unread-count|\/unread$|\/mode$|\/voice$/.test(p);     /* background polls never show the bar */ } catch (e) { return false; } };
  const _fetch = window.fetch;
  window.fetch = function (u, o) {
    const track = isApi(u) && !(o && o.headers && (o.headers['X-Nova-Quiet'] || (o.headers.get && o.headers.get('X-Nova-Quiet'))));
    if (!track) return _fetch.apply(this, arguments);
    start();
    try { return _fetch.apply(this, arguments).then(r => { done(); return r; }, e => { done(); throw e; }); }
    catch (e) { done(); throw e; }
  };
  /* an EventSource / SSE answer never resolves until the stream ends — those fetches are long by design: let a page stop the bar after the first bytes */
  window.NovaLoader = { start, done, quiet: () => { inflight = 0; finish(); } };

  /* ---- 2. lazy rows ---- */
  const seen = new WeakSet();
  const nf = (n) => Number(n).toLocaleString('en-US');
  let io = null;
  function observer() {
    if (io) return io;
    io = new IntersectionObserver((ents) => ents.forEach(e => { if (e.isIntersecting) reveal(e.target, CHUNK); }), { rootMargin: '400px 0px' });
    return io;
  }
  function hiddenAfter(more) {
    const out = []; let r = more.nextElementSibling;
    while (r) { if (r.classList.contains('nl-hide')) out.push(r); r = r.nextElementSibling; }
    return out;
  }
  function reveal(more, n) {
    const rows = hiddenAfter(more);
    rows.slice(0, n).forEach(r => r.classList.remove('nl-hide'));
    const left = rows.length - Math.min(n, rows.length);
    if (left <= 0) { observer().unobserve(more); more.remove(); return; }
    const tb = more.parentNode; tb.appendChild(more);     /* the "more" row goes back under the last shown row */
    label(more, tb);
    /* a short viewport may still show the sentinel — keep going on the next frame */
    requestAnimationFrame(() => { const rc = more.getBoundingClientRect(); if (rc.top < innerHeight + 400 && rc.bottom > -400) reveal(more, n); });
  }
  function label(more, tb) {
    const total = tb.querySelectorAll(':scope > tr:not(.nl-more)').length, hid = tb.querySelectorAll(':scope > tr.nl-hide').length;
    more.firstChild.innerHTML = 'Showing ' + nf(total - hid) + ' of ' + nf(total) + ' · more as you scroll <a href="#" data-nl-all>Show all</a>';
  }
  function lazy(tb) {
    if (seen.has(tb)) return; seen.add(tb);
    if (tb.querySelector(':scope > tr.nl-more')) return;
    const rows = Array.from(tb.children).filter(r => r.tagName === 'TR' && !r.classList.contains('nl-more'));
    if (rows.length < MIN_ROWS) return;
    const table = tb.closest('table'); if (!table || table.hasAttribute('data-nolazy')) return;
    const cols = Math.max(1, (rows[0] && rows[0].cells.length) || 1);
    for (let i = FIRST; i < rows.length; i++) rows[i].classList.add('nl-hide');
    const more = document.createElement('tr'); more.className = 'nl-more';
    const td = document.createElement('td'); td.colSpan = cols; more.appendChild(td);
    rows[FIRST - 1].insertAdjacentElement('afterend', more);
    label(more, tb);
    td.addEventListener('click', (e) => { const a = e.target.closest('[data-nl-all]'); if (!a) return; e.preventDefault(); reveal(more, 1e9); });
    observer().observe(more);
  }
  function revealAll() { document.querySelectorAll('tr.nl-more').forEach(m => reveal(m, 1e9)); }
  function scan(nodes) {
    nodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'TBODY') lazy(n);
      else if (n.tagName === 'TR' && n.parentNode && n.parentNode.tagName === 'TBODY') { seen.delete && seen.delete(n.parentNode); pending.add(n.parentNode); }
      else if (n.querySelectorAll) n.querySelectorAll('tbody').forEach(lazy);
    });
  }
  /* rows appended one by one (createElement + appendChild) arrive as many mutations — the tbody is looked at once they settle */
  const pending = new Set(); let settleT = null;
  function boot() {
    const mo = new MutationObserver((muts) => {
      muts.forEach(m => scan(m.addedNodes));
      if (pending.size) { clearTimeout(settleT); settleT = setTimeout(() => { pending.forEach(tb => { seen.delete(tb); lazy(tb); }); pending.clear(); }, 60); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('tbody').forEach(lazy);
    document.addEventListener('input', (e) => { const t = e.target; if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'radio' && t.type !== 'range') revealAll(); }, true);
    window.addEventListener('beforeprint', revealAll);
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
  window.NovaLazy = { apply: lazy, revealAll };
})();
