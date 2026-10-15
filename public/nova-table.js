/* nova-table.js — the one way Nova tables filter and scroll (1.20.92).
 *
 * The Bank feed's header filter, made shareable: every column header is a button with a funnel; a click opens a
 * popover (a list with a search box, a "Contains" text box, or a date / number range with presets); an active
 * filter shows the label with a red × that clears it on the spot, what is picked is in the tooltip and ticked in
 * the popover. And `pin(table)` keeps the header rows stuck to the top of whatever scrolls the table.
 *
 *   NovaTable.th(key, label, spec, cur)       → the <th> inner html (a .thf button)
 *   NovaTable.bind(root, specs, onChange)     → wires every .thf under root; onChange(key, value)
 *   NovaTable.active(spec, cur) / clearOf(spec)
 *   NovaTable.pin(table)                      → sticky thead rows (any number) inside the nearest scroll parent
 *
 * Specs — the same shapes as bookkeeping.js:
 *   list   : [{ v, l, t?, h?, sub? }]              value = v           (search box when more than 8 options)
 *   text   : { type: 'text', value }               value = the text
 *   range  : { type: 'range', kind: 'date'|'number', presets: [{ v, l }], period, defaultPeriod, from, to }
 *            value = { from, to, period }
 * Use this for every new table; the Bank feed keeps its own copy for now (bookkeeping.js thFilter).
 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FUNNEL = '<svg class="thf-f" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>';
  const CSS = `
.thf { font: inherit; font-weight: inherit; font-size: inherit; line-height: 1.2; color: inherit; letter-spacing: inherit; text-transform: inherit; border: 0; background: transparent; padding: 2px 4px; margin: -2px -4px; border-radius: 6px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; }
.thf:hover { background: #eef2ff; color: #3730a3; } .thf.on { color: #3730a3; }
.thf-f { width: 13px; height: 13px; margin-left: 6px; opacity: .55; flex: none; } .thf.on .thf-f { opacity: 1; color: #4f46e5; }
.thf-x { font-style: normal; display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; margin-left: 6px; font-size: 14px; line-height: 1; color: #fff; background: #dc2626; flex: none; } .thf-x:hover { background: #b91c1c; }
.thf-pop { position: fixed; z-index: 1000; background: #fff; border: 1px solid #e6e6f0; border-radius: 12px; box-shadow: 0 16px 48px rgba(20,20,40,.18); overflow: hidden; max-height: 380px; display: flex; flex-direction: column; font-family: inherit; font-size: 13px; color: #1a1a2e; text-transform: none; letter-spacing: 0; }
.thf-h { display: flex; align-items: center; padding: 10px 14px 6px; font-size: 13.5px; font-weight: 600; } .thf-hclear { margin-left: auto; font-size: 12px; font-weight: 500; }
.thf-search { padding: 4px 10px 6px; } .thf-search input { width: 100%; box-sizing: border-box; border: 1.5px solid #e6e6f0; border-radius: 9px; padding: 7px 10px; font: inherit; font-size: 13px; outline: none; } .thf-search input:focus { border-color: #a5b4fc; }
.thf-list { overflow: auto; padding: 4px 0; } .thf-i { display: flex; align-items: center; gap: 8px; padding: 7px 12px; cursor: pointer; } .thf-i:hover { background: #f3f3fa; } .thf-i.on { color: #3730a3; font-weight: 600; }
.thf-i small { color: #b0b0c3; font-weight: 500; } .thf-t { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thf-r { width: 14px; height: 14px; border: 1.5px solid #c7c7d6; border-radius: 50%; flex: none; position: relative; } .thf-i.on .thf-r { background: #4f46e5; border-color: #4f46e5; } .thf-i.on .thf-r::after { content: ''; position: absolute; left: 3px; top: 3px; width: 6px; height: 6px; border-radius: 50%; background: #fff; }
.thf-body { padding: 4px 14px 10px; } .thf-lab { display: block; font-size: 11.5px; color: #6b6b85; margin-bottom: 4px; }
.thf-in, .thf-range input { width: 100%; box-sizing: border-box; border: 1.5px solid #e6e6f0; border-radius: 9px; padding: 7px 10px; font: inherit; font-size: 13px; outline: none; } .thf-in:focus, .thf-range input:focus { border-color: #a5b4fc; }
.thf-range { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } .thf-presets { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 10px; }
.thf-chip { border: 1px solid #e6e6f0; background: #fff; border-radius: 20px; padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 600; color: #4b4b66; cursor: pointer; } .thf-chip.on { border-color: #4f46e5; background: #eef2ff; color: #3730a3; }
.thf-acts { display: flex; align-items: center; padding: 8px 14px 12px; border-top: 1px solid #e6e6f0; } .thf-acts button { border: 0; background: none; font: inherit; font-size: 13px; font-weight: 600; color: #3730a3; cursor: pointer; padding: 4px 2px; } .thf-acts .thf-clear { color: #6b6b85; } .thf-acts .sp { flex: 1; }
table.nt-pin { overflow: visible; } table.nt-pin thead th { position: sticky; z-index: 3; top: var(--nt-top, 0px); box-shadow: 0 1px 0 #e6e6f0; } table.nt-pin thead tr + tr th { top: var(--nt-top2, 41px); }
`;
  let cssDone = false;
  function css() { if (cssDone) return; cssDone = true; const st = document.createElement('style'); st.id = 'nova-table-css'; st.textContent = CSS; document.head.appendChild(st); }

  const isList = (s) => Array.isArray(s);
  function active(spec, cur) {
    if (isList(spec)) return !!cur;
    if (spec.type === 'text') return !!spec.value;
    return !!(spec.from || spec.to || (spec.period && spec.period !== (spec.defaultPeriod || '')));
  }
  const clearOf = (spec) => isList(spec) ? '' : spec.type === 'text' ? '' : { from: '', to: '', period: spec.defaultPeriod || '' };
  function picked(spec, cur) {
    if (isList(spec)) { const o = spec.find(x => x.v === cur); return o && cur ? (o.t != null ? o.t : String(o.l).replace(/<[^>]+>/g, ' ')) : ''; }
    if (spec.type === 'text') return spec.value || '';
    const pr = (spec.presets || []).find(x => x.v === spec.period);
    if (spec.period && spec.period !== 'custom' && spec.period !== (spec.defaultPeriod || '') && pr) return pr.l;
    if (spec.from || spec.to) return spec.from && spec.to ? spec.from + ' – ' + spec.to : spec.from ? (spec.kind === 'date' ? 'from ' : '≥ ') + spec.from : (spec.kind === 'date' ? 'to ' : '≤ ') + spec.to;
    return '';
  }
  function th(key, label, spec, cur) {
    css();
    const on = active(spec, cur), tip = picked(spec, cur).replace(/\s+/g, ' ').trim();
    return '<button type="button" class="thf' + (on ? ' on' : '') + '" data-thf="' + esc(key) + '" data-v="' + esc(isList(spec) ? (cur || '') : '') + '"' + (tip ? ' title="' + esc(label + ': ' + tip) + '"' : '') + '><span class="thf-l">' + esc(label) + '</span>' + (on ? '<i class="thf-x" title="Clear this filter">×</i>' : FUNNEL) + '</button>';
  }

  function bind(root, specs, onChange) {
    css();
    root.querySelectorAll('.thf').forEach(btn => btn.onclick = (e) => {
      e.stopPropagation(); document.querySelectorAll('.thf-pop').forEach(p => p.remove());
      const key = btn.dataset.thf, spec = specs[key] || [], cur = btn.dataset.v, label = btn.querySelector('.thf-l').textContent;
      if (e.target.closest('.thf-x')) { onChange(key, clearOf(spec)); return; }
      const pop = document.createElement('div'); pop.className = 'thf-pop';
      const r = btn.getBoundingClientRect(), W = isList(spec) ? 270 : 300;
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'; pop.style.top = (r.bottom + 6) + 'px'; pop.style.width = W + 'px';
      const place = () => { const h = pop.offsetHeight; if (r.bottom + 6 + h > window.innerHeight - 8 && r.top - h - 6 > 8) pop.style.top = (r.top - h - 6) + 'px'; };
      const close = () => { pop.remove(); document.removeEventListener('click', away); document.removeEventListener('keydown', esck); };
      const away = (ev) => { if (!pop.contains(ev.target) && !ev.target.closest('.nd-pop')) close(); };
      const esck = (ev) => { if (ev.key === 'Escape') close(); };
      setTimeout(() => { document.addEventListener('click', away); document.addEventListener('keydown', esck); }, 0);
      const head = '<div class="thf-h">' + esc(label) + (active(spec, cur) ? '<button type="button" class="thf-clear thf-hclear">× Clear</button>' : '') + '</div>';
      if (isList(spec)) {
        pop.innerHTML = head + (spec.length > 8 ? '<div class="thf-search"><input type="text" placeholder="Search…"></div>' : '') +
          '<div class="thf-list">' + spec.map(o => '<div class="thf-i' + (o.v === cur ? ' on' : '') + '" data-v="' + esc(o.v) + '"><span class="thf-r"></span><span class="thf-t">' + (o.h != null ? o.h : esc(o.l)) + (o.sub ? ' <small>' + esc(o.sub) + '</small>' : '') + '</span></div>').join('') + '</div>';
        document.body.appendChild(pop); place();
        const q = pop.querySelector('.thf-search input'); if (q) { q.focus(); q.oninput = () => { const f = q.value.toLowerCase(); pop.querySelectorAll('.thf-i').forEach(i => { i.style.display = !f || i.textContent.toLowerCase().indexOf(f) > -1 ? '' : 'none'; }); }; }
        pop.querySelectorAll('.thf-i').forEach(i => i.onclick = () => { close(); onChange(key, i.dataset.v); });
        const hc = pop.querySelector('.thf-hclear'); if (hc) hc.onclick = () => { close(); onChange(key, ''); };
        return;
      }
      if (spec.type === 'text') {
        pop.innerHTML = head + '<div class="thf-body"><label class="thf-lab">Contains</label><input type="text" class="thf-in" value="' + esc(spec.value || '') + '" placeholder="' + esc(label) + '…"></div><div class="thf-acts"><button type="button" class="thf-clear">Clear</button><span class="sp"></span><button type="button" class="thf-apply">Apply</button></div>';
        document.body.appendChild(pop); place();
        const inp = pop.querySelector('.thf-in'); inp.focus(); inp.select();
        const apply = () => { close(); onChange(key, inp.value.trim()); };
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') apply(); };
        pop.querySelector('.thf-apply').onclick = apply; pop.querySelectorAll('.thf-clear').forEach(b => b.onclick = () => { close(); onChange(key, ''); });
        return;
      }
      const dt = spec.kind === 'date', it = dt ? 'date' : 'number';
      pop.innerHTML = head + '<div class="thf-body">' +
        (spec.presets ? '<div class="thf-presets">' + spec.presets.map(p => '<button type="button" class="thf-chip' + (spec.period === p.v && !(spec.from || spec.to) ? ' on' : '') + '" data-p="' + esc(p.v) + '">' + esc(p.l) + '</button>').join('') + '</div>' : '') +
        '<div class="thf-range"><label><span class="thf-lab">From</span><input type="' + it + '" class="thf-from" ' + (dt ? '' : 'min="0" step="0.01" ') + 'value="' + esc(spec.from || '') + '"></label><label><span class="thf-lab">To</span><input type="' + it + '" class="thf-to" ' + (dt ? '' : 'min="0" step="0.01" ') + 'value="' + esc(spec.to || '') + '"></label></div></div>' +
        '<div class="thf-acts"><button type="button" class="thf-clear">Clear</button><span class="sp"></span><button type="button" class="thf-apply">Apply</button></div>';
      document.body.appendChild(pop); place();
      const from = pop.querySelector('.thf-from'), to = pop.querySelector('.thf-to'); from.focus();
      const apply = () => { close(); onChange(key, { from: from.value, to: to.value, period: (from.value || to.value) ? 'custom' : (spec.period || '') }); };
      [from, to].forEach(x => x.onkeydown = (ev) => { if (ev.key === 'Enter') apply(); });
      pop.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { close(); onChange(key, { from: '', to: '', period: b.dataset.p }); });
      const clearAll = () => { close(); onChange(key, clearOf(spec)); };
      pop.querySelector('.thf-apply').onclick = apply; pop.querySelectorAll('.thf-clear').forEach(b => b.onclick = clearAll);
    });
  }

  // Sticky header rows. The offset is the scroll parent's top padding (content scrolls under it), the second
  // header row sits under the first. Ancestors between the table and the scroll parent must not clip (overflow).
  function pin(table) {
    if (!table) return; css();
    table.classList.add('nt-pin');
    let el = table.parentElement, sp = null;
    while (el && el !== document.body) { const o = getComputedStyle(el).overflowY; if (o === 'auto' || o === 'scroll') { sp = el; break; } el = el.parentElement; }
    for (let a = table.parentElement; a && a !== sp && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') a.style.overflow = 'visible'; }
    const pad = sp ? parseFloat(getComputedStyle(sp).paddingTop) || 0 : 0;
    const row1 = table.tHead && table.tHead.rows[0]; const h1 = row1 ? row1.getBoundingClientRect().height : 41;
    table.style.setProperty('--nt-top', (-pad) + 'px'); table.style.setProperty('--nt-top2', (h1 - pad - 1) + 'px');
  }

  window.NovaTable = { th, bind, active, clearOf, pin, esc };
})();
