/**
 * NovaStats — the usage overview on top of CRM Chat, TalkAi and Client ChatBot.
 *
 *   NovaStats.mount(el, { url: '/api/admin/talk/stats', token: token, key: 'talk' })
 *
 * The endpoint returns { title, unit, unit1, tiles: [{ label, value, sub }],
 *   series: { day: [{ key, label, n }] (30), week: [...] (12), month: [...] (12) } } (usage-stats.js).
 * Draws the tiles and one bar chart with a Daily / Weekly / Monthly switch: one series, one colour, a hairline
 * grid, 4px rounded bar ends, a tooltip on every bar, and a table of the same numbers for screen readers.
 */
(function () {
  const CSS = `
.nvs { display: flex; flex-direction: column; gap: 12px; margin: 0 0 16px; font-family: inherit; min-width: 0; }
.nvs-card, .nvs-tile { min-width: 0; }
.nvs-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
.nvs-tile { background: #fff; border: 1px solid #e7e7ef; border-radius: 12px; padding: 11px 13px; min-width: 0; }
.nvs-tile span { display: block; font-size: 11.5px; font-weight: 600; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nvs-tile b { display: block; font-size: 24px; line-height: 1.15; font-weight: 700; color: #111827; margin-top: 3px; font-variant-numeric: tabular-nums; }
.nvs-tile small { display: block; font-size: 11.5px; color: #9ca3af; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nvs-card { background: #fff; border: 1px solid #e7e7ef; border-radius: 12px; padding: 12px 14px 8px; position: relative; }
.nvs-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.nvs-head b { font-size: 13.5px; color: #111827; }
.nvs-head small { display: block; font-size: 11.5px; color: #6b7280; font-weight: 400; margin-top: 1px; }
.nvs-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 9px; background: #f1f2f8; }
.nvs-seg button { border: 0; background: none; font: 600 12px/1 inherit; color: #4b5563; padding: 6px 11px; border-radius: 7px; cursor: pointer; }
.nvs-seg button.on { background: #fff; color: #3730a3; box-shadow: 0 1px 2px rgba(17,24,39,.08); }
.nvs-plot { position: relative; height: 170px; }
.nvs-plot svg { display: block; width: 100%; height: 100%; overflow: visible; }
.nvs-plot .bar { fill: #4f46e5; transition: opacity .12s; }
.nvs-plot.hovering .bar { opacity: .45; }
.nvs-plot.hovering .bar.on { opacity: 1; }
.nvs-plot .grid { stroke: #ececf3; stroke-width: 1; shape-rendering: crispEdges; }
.nvs-plot .tick { fill: #9ca3af; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.nvs-plot .hit { fill: transparent; cursor: default; }
.nvs-tip { position: absolute; pointer-events: none; background: #111827; color: #fff; font-size: 12px; line-height: 1.35; padding: 6px 9px;
  border-radius: 8px; white-space: nowrap; transform: translate(-50%, calc(-100% - 8px)); z-index: 2; box-shadow: 0 6px 16px rgba(0,0,0,.18); }
.nvs-tip b { font-variant-numeric: tabular-nums; }
.nvs-empty, .nvs-err { font-size: 12.5px; color: #6b7280; padding: 10px 2px; }
.nvs-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }`;
  function css() {
    if (document.getElementById('nvs-css')) return;
    const s = document.createElement('style'); s.id = 'nvs-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const GRAINS = [['day', 'Daily', 'Last 30 days'], ['week', 'Weekly', 'Last 12 weeks'], ['month', 'Monthly', 'Last 12 months']];
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // A round top for the y axis and two gridlines under it.
  function niceMax(m) {
    if (m <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function when(grain, b) {
    if (grain === 'week') return 'Week of ' + b.label;
    if (grain === 'month') return b.label.indexOf(' ') > -1 ? b.label : b.label + ' ' + b.key.slice(0, 4);
    const d = new Date(b.key + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ', ' + b.label;
  }

  function draw(box, data, grain) {
    const plot = box.querySelector('.nvs-plot'), tip = box.querySelector('.nvs-tip');
    const bars = (data.series && data.series[grain]) || [];
    const W = Math.max(plot.clientWidth, 240), H = plot.clientHeight || 170;
    const L = 34, R = 4, T = 10, B = 22, iw = W - L - R, ih = H - T - B;
    const max = niceMax(Math.max(0, ...bars.map(b => b.n)));
    const band = iw / Math.max(bars.length, 1), bw = Math.max(3, Math.min(24, band - Math.max(2, band * 0.28)));
    const y = (v) => T + ih - (v / max) * ih;
    const every = grain === 'day' ? (iw < 420 ? 7 : 5) : grain === 'week' ? (iw < 360 ? 3 : 2) : (iw < 360 ? 2 : 1);
    let s = '';
    [0, max / 2, max].forEach(v => {
      const yy = Math.round(y(v)) + 0.5;
      s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/>' +
        '<text class="tick" x="' + (L - 6) + '" y="' + (yy + 3.5) + '" text-anchor="end">' + num(Math.round(v)) + '</text>';
    });
    bars.forEach((b, i) => {
      const cx = L + band * i + band / 2, x = cx - bw / 2, top = y(b.n), h = T + ih - top;
      if (b.n > 0) {
        const r = Math.min(4, bw / 2, h);
        s += '<path class="bar" data-i="' + i + '" d="M' + x + ',' + (T + ih) + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top +
          'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + (T + ih) + 'Z"/>';
      }
      if ((bars.length - 1 - i) % every === 0) s += '<text class="tick" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(b.label.replace(/ \d{4}$/, '')) + '</text>';
      s += '<rect class="hit" data-i="' + i + '" x="' + (L + band * i) + '" y="' + T + '" width="' + band + '" height="' + ih + '"/>';
    });
    plot.querySelector('svg').setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    plot.querySelector('svg').innerHTML = s;
    plot.querySelectorAll('.hit').forEach(r => {
      r.onmouseenter = () => {
        const i = +r.dataset.i, b = bars[i];
        plot.classList.add('hovering');
        plot.querySelectorAll('.bar').forEach(p => p.classList.toggle('on', +p.dataset.i === i));
        tip.innerHTML = esc(when(grain, b)) + ' · <b>' + num(b.n) + '</b> ' + esc(b.n === 1 ? data.unit1 : data.unit);
        tip.style.left = Math.min(Math.max(L + band * i + band / 2, 70), W - 70) + 'px';
        tip.style.top = y(b.n) + 'px'; tip.hidden = false;
      };
      r.onmouseleave = () => { plot.classList.remove('hovering'); tip.hidden = true; };
    });
    box.querySelector('.nvs-sr').innerHTML = '<caption>' + esc(data.title) + '</caption><tr><th>Period</th><th>' + esc(data.unit) + '</th></tr>' +
      bars.map(b => '<tr><td>' + esc(when(grain, b)) + '</td><td>' + b.n + '</td></tr>').join('');
  }

  async function mount(el, opts) {
    if (!el) return;
    css();
    const key = 'nvs-grain-' + (opts.key || 'x');
    let grain = store.get(key) || 'day';
    if (!GRAINS.some(g => g[0] === grain)) grain = 'day';
    el.innerHTML = '<div class="nvs"><div class="nvs-empty">Loading the overview…</div></div>';
    let data;
    try {
      const r = await fetch(opts.url, { headers: { 'Authorization': 'Bearer ' + opts.token } });
      data = await r.json();
      if (!data || !data.ok) throw new Error((data && data.error) || 'no data');
    } catch (e) { el.innerHTML = '<div class="nvs"><div class="nvs-err">The overview could not be loaded.</div></div>'; return; }
    el.innerHTML = '<div class="nvs">' +
      '<div class="nvs-tiles">' + (data.tiles || []).map(t => '<div class="nvs-tile"><span title="' + esc(t.label) + '">' + esc(t.label) + '</span><b>' + num(t.value) + '</b>' +
        (t.sub ? '<small title="' + esc(t.sub) + '">' + esc(t.sub) + '</small>' : '') + '</div>').join('') + '</div>' +
      '<div class="nvs-card"><div class="nvs-head"><div><b>' + esc(data.title) + '</b><small class="nvs-range"></small></div>' +
        '<div class="nvs-seg" role="group" aria-label="Period">' + GRAINS.map(g => '<button type="button" data-g="' + g[0] + '">' + g[1] + '</button>').join('') + '</div></div>' +
        '<div class="nvs-plot"><svg role="img" aria-label="' + esc(data.title) + '"></svg><div class="nvs-tip" hidden></div></div>' +
        '<table class="nvs-sr"></table></div></div>';
    const box = el.querySelector('.nvs');
    const set = (g) => {
      grain = g; store.set(key, g);
      box.querySelectorAll('.nvs-seg button').forEach(b => { b.classList.toggle('on', b.dataset.g === g); b.setAttribute('aria-pressed', b.dataset.g === g ? 'true' : 'false'); });
      box.querySelector('.nvs-range').textContent = GRAINS.find(x => x[0] === g)[2];
      draw(box, data, g);
    };
    box.querySelectorAll('.nvs-seg button').forEach(b => { b.onclick = () => set(b.dataset.g); });
    set(grain);
    if (window.ResizeObserver) {
      let last = 0;
      new ResizeObserver(() => { const w = box.querySelector('.nvs-plot').clientWidth; if (w && Math.abs(w - last) > 4) { last = w; draw(box, data, grain); } })
        .observe(box.querySelector('.nvs-plot'));
    }
  }
  window.NovaStats = { mount: mount };
})();
