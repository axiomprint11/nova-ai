// NovaDate (1.19.136): one date picker for Nova's pages. Every <input type="date"> under the page is turned into a
// text field that reads "10/01/2026" (typed as MM/DD/YYYY, M/D/YY or 2026-10-01) with a calendar popover — month
// grid, ‹ › month arrows, month + year dropdowns, Today, Clear. The element's `.value` keeps giving and taking the
// ISO date (yyyy-mm-dd) so the code around it does not change; picking a day fires `input` and `change`.
(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const isoOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const show = (iso) => { const d = parseIso(iso); return d ? pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear() : ''; };
  // what a person types → ISO, or null when it is not a date
  const parseTyped = (s) => {
    s = String(s || '').trim(); if (!s) return '';
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s); if (m) return check(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(s);
    if (m) { let y = m[3] == null ? new Date().getFullYear() : +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900; return check(y, +m[1], +m[2]); }
    const d = new Date(s); return isNaN(d) ? null : isoOf(d);
  };
  const check = (y, mo, d) => { const x = new Date(y, mo - 1, d); return x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d ? isoOf(x) : null; };
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let pop = null, popFor = null;
  const close = () => { if (pop) { pop.remove(); pop = null; popFor = null; } };
  const fire = (el) => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const setIso = (el, iso, quiet) => { el.dataset.iso = iso || ''; proto.set.call(el, show(iso)); el.classList.toggle('nd-empty', !iso); if (!quiet) fire(el); };
  function open(el) {
    close(); popFor = el;
    const today = new Date(); let cur = parseIso(el.dataset.iso) || today; let y = cur.getFullYear(), mo = cur.getMonth();
    pop = document.createElement('div'); pop.className = 'nd-pop';
    const paint = () => {
      const sel = el.dataset.iso, first = new Date(y, mo, 1), start = first.getDay(), days = new Date(y, mo + 1, 0).getDate(), prevDays = new Date(y, mo, 0).getDate();
      let cells = '';
      for (let i = 0; i < 42; i++) {
        let d, m = mo, yy = y, out = false;
        if (i < start) { d = prevDays - start + i + 1; m = mo - 1; out = true; } else if (i - start < days) d = i - start + 1; else { d = i - start - days + 1; m = mo + 1; out = true; }
        const dt = new Date(yy, m, d), iso = isoOf(dt);
        cells += '<button type="button" class="nd-d' + (out ? ' out' : '') + (iso === sel ? ' sel' : '') + (iso === isoOf(today) ? ' today' : '') + (dt.getDay() === 0 || dt.getDay() === 6 ? ' we' : '') + '" data-iso="' + iso + '">' + d + '</button>';
        if (i >= start + days - 1 && (i + 1) % 7 === 0) break;   // stop after the row holding the last day
      }
      const years = []; for (let k = y - 60; k <= y + 15; k++) years.push(k);
      pop.innerHTML = '<div class="nd-head"><button type="button" class="nd-nav" data-nav="-1" aria-label="Previous month">‹</button>' +
        '<select class="nd-sel nd-mo">' + MONTHS.map((n, i) => '<option value="' + i + '"' + (i === mo ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>' +
        '<select class="nd-sel nd-yr">' + years.map(k => '<option value="' + k + '"' + (k === y ? ' selected' : '') + '>' + k + '</option>').join('') + '</select>' +
        '<button type="button" class="nd-nav" data-nav="1" aria-label="Next month">›</button></div>' +
        '<div class="nd-dow">' + DOW.map(d => '<span>' + d + '</span>').join('') + '</div><div class="nd-grid">' + cells + '</div>' +
        '<div class="nd-foot"><button type="button" class="nd-lnk" data-clear>Clear</button><span class="nd-sp"></span><button type="button" class="nd-lnk" data-today>Today</button></div>';
      pop.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { mo += +b.dataset.nav; if (mo < 0) { mo = 11; y--; } if (mo > 11) { mo = 0; y++; } paint(); });
      pop.querySelector('.nd-mo').onchange = (e) => { mo = +e.target.value; paint(); };
      pop.querySelector('.nd-yr').onchange = (e) => { y = +e.target.value; paint(); };
      pop.querySelectorAll('.nd-d').forEach(b => b.onclick = () => { setIso(el, b.dataset.iso); close(); });
      pop.querySelector('[data-clear]').onclick = () => { setIso(el, ''); close(); };
      pop.querySelector('[data-today]').onclick = () => { setIso(el, isoOf(today)); close(); };
    };
    paint();
    pop.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'SELECT') e.preventDefault(); });   // keep the focus in the field while clicking days
    document.body.appendChild(pop);
    const r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let left = r.left, top = r.bottom + 6;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function upgrade(el) {
    if (el.dataset.nd) return; el.dataset.nd = '1';
    const iso = el.value || el.getAttribute('value') || '';
    el.type = 'text'; el.classList.add('nd-in'); el.setAttribute('inputmode', 'numeric'); el.setAttribute('autocomplete', 'off');
    if (!el.placeholder) el.placeholder = 'mm/dd/yyyy';
    Object.defineProperty(el, 'value', { configurable: true, get() { return this.dataset.iso || ''; }, set(v) { setIso(this, parseIso(v) ? String(v).slice(0, 10) : '', true); } });
    setIso(el, iso, true);
    el.addEventListener('focus', () => open(el));
    el.addEventListener('click', () => { if (popFor !== el) open(el); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); } if (e.key === 'Enter') { commit(); e.preventDefault(); close(); } if (e.key === 'Tab') close(); });
    const commit = () => { const t = proto.get.call(el), iso = parseTyped(t); if (iso === null) { proto.set.call(el, show(el.dataset.iso)); return; } if (iso !== (el.dataset.iso || '')) setIso(el, iso); else proto.set.call(el, show(iso)); };
    el.addEventListener('blur', () => setTimeout(() => { if (popFor !== el || !pop || !pop.contains(document.activeElement)) commit(); }, 0));
    el.addEventListener('input', (e) => { if (!e.isTrusted) return; /* typing: nothing until blur / Enter */ });
  }
  const scan = (root) => (root.querySelectorAll ? root.querySelectorAll('input[type="date"]') : []).forEach(upgrade);
  document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target) && e.target !== popFor) close(); }, true);
  window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
  const ready = () => { scan(document); new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) { if (n.matches && n.matches('input[type="date"]')) upgrade(n); else scan(n); } }))).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) ready(); else document.addEventListener('DOMContentLoaded', ready);
  window.NovaDate = { upgrade, scan, close, parse: parseTyped, show };
})();
